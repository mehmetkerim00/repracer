-- 0096_omnibus_applied_time.sql
-- Шаг 26, F [OQ-180]: окно Omnibus и суточная свёртка цен строятся по времени, когда канал ПРИМЕНИЛ цену, а не когда принял запись.
-- Принятая запись применяется позже (Kaufland K-15, Amazon — асинхронно, AMZ_C05); у покупателя цена меняется в момент применения, и
-- доказательство Omnibus должно говорить о нём. Время применения — applied_at записи (tenant_data.channel_write_history); строки истории
-- цен подтверждённых записей отмечаются в tenant_data.price_history_applied триггером завершения записи. Не применённая запись
-- по-прежнему исключается целиком (риск 28, 0091).
-- Для строк без подтверждения (применение не наблюдалось) остаётся время принятия — известное приближение.

BEGIN;

SET ROLE repracer_owner;

-- Путь решения читает журнал закрытых суток: отметка времени применения не ставится цене уже закрытых суток (ревью шага 26, находка 4)
GRANT USAGE ON SCHEMA maintenance TO repracer_app;
GRANT SELECT ON maintenance.price_day_close TO repracer_app;

CREATE TABLE tenant_data.price_history_applied (
  tenant_id         uuid NOT NULL,
  price_history_id  uuid NOT NULL,
  channel_write_id  uuid NOT NULL,
  write_scope_id    uuid NOT NULL,
  accepted_at       timestamptz NOT NULL,
  applied_at        timestamptz NOT NULL,
  recorded_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, price_history_id)
  -- Проверки «применено не раньше принятия» тут нет: это же условие проверяет страж отметки (price_history_applied_guard) — дубль [Р-104]
);
COMMENT ON TABLE tenant_data.price_history_applied IS 'Шаг 26 [OQ-180]: момент, когда канал применил цену, — время цены в окне Omnibus и в суточной свёртке';
SELECT security.register_table('tenant_data.price_history_applied', 'TENANT', 'append_only');
SELECT security.grant_retention('tenant_data.price_history_applied');
SELECT security.grant_export('tenant_data.price_history_applied');
GRANT INSERT ON tenant_data.price_history_applied TO repracer_app;
GRANT SELECT ON tenant_data.price_history_applied TO repracer_admin;
REVOKE INSERT, UPDATE, DELETE ON tenant_data.price_history_applied FROM repracer_admin;
-- Доказательство, как суточная свёртка: до закрытия тенанта
INSERT INTO maintenance.retention_policy (table_name, method, bound) VALUES ('tenant_data.price_history_applied', 'TENANT_CLOSURE_ONLY', 'MAX_AGE');

RESET ROLE;

/**
 * OQ-180: запись цены завершена APPLIED с наблюдённым временем применения — строки её истории получают это время.
 * Ревью шага 26, находка 4: если сутки принятия цены уже закрыты в вечную свёртку [Р-21, Р-29], время применения не ставится — иначе та же
 * цена попала бы в свёртку второй раз, уже в сутках применения. Такая цена остаётся в сутках, где её уже учли (риск 34).
 * Журнал закрытых суток читает и путь решения: право SELECT на maintenance.price_day_close — в списке разрешённого [Р-96].
 */
CREATE FUNCTION tenant_data.price_history_mark_applied() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  IF NEW.field = 'PRICE' AND NEW.final_status = 'APPLIED' AND NEW.applied_at IS NOT NULL THEN
    INSERT INTO tenant_data.price_history_applied (tenant_id, price_history_id, channel_write_id, write_scope_id, accepted_at, applied_at)
    SELECT h.tenant_id, h.price_history_id, h.channel_write_id, h.write_scope_id, h.accepted_at, greatest(NEW.applied_at, h.accepted_at)
      FROM tenant_data.price_history h
      JOIN LATERAL (SELECT tenant_data.write_scope_time_zone(h.tenant_id, h.write_scope_id) AS tz) z ON true
     WHERE h.tenant_id = NEW.tenant_id AND h.channel_write_id = NEW.channel_write_id
       AND NOT EXISTS (SELECT 1 FROM maintenance.price_day_close c
                        WHERE z.tz IS NOT NULL AND c.day_tz = z.tz AND c.price_day = (h.accepted_at AT TIME ZONE z.tz)::date)
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NULL;
END $fn$;

CREATE TRIGGER b_price_history_mark_applied AFTER INSERT ON tenant_data.channel_write_history
  FOR EACH ROW EXECUTE FUNCTION tenant_data.price_history_mark_applied();

/**
 * OQ-180: отметку времени применения нельзя поставить цене записи, которую канал не подтвердил применением: иначе цена уезжает в другие
 * сутки окна Omnibus. Как страж отметки «не применена» (0091, ревью шага 25, находка 3).
 */
CREATE FUNCTION tenant_data.price_history_applied_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  IF NOT EXISTS (
       SELECT 1 FROM tenant_data.channel_write_history w
         JOIN tenant_data.price_history h ON h.tenant_id = w.tenant_id AND h.channel_write_id = w.channel_write_id
        WHERE w.tenant_id = NEW.tenant_id AND w.channel_write_id = NEW.channel_write_id AND w.field = 'PRICE' AND w.final_status = 'APPLIED'
          AND w.applied_at IS NOT NULL AND NEW.applied_at = greatest(w.applied_at, h.accepted_at)
          AND h.price_history_id = NEW.price_history_id AND h.write_scope_id = NEW.write_scope_id AND h.accepted_at = NEW.accepted_at) THEN
    RAISE EXCEPTION 'price history % is not a price of a write the channel applied at this time (OQ-180)', NEW.price_history_id USING ERRCODE = 'check_violation';
  END IF;
  -- Правило «сутки принятия уже закрыты — время применения не ставится» живёт в триггере отметки (price_history_mark_applied): здесь оно
  -- было бы дублем, который некому поймать [Р-104], и ломало бы законную запись журнала (страж падает внутри AFTER-триггера)
  RETURN NEW;
END $fn$;
CREATE TRIGGER a_price_history_applied_guard BEFORE INSERT ON tenant_data.price_history_applied
  FOR EACH ROW EXECUTE FUNCTION tenant_data.price_history_applied_guard();

/** OQ-180: сырьё цен окна Omnibus — по времени применения */
CREATE OR REPLACE FUNCTION tenant_data.omnibus_raw_prices(p_tenant_id uuid, p_write_scope_id uuid, p_tz text, p_before timestamp with time zone)
 RETURNS TABLE(accepted_at timestamp with time zone, amount_minor bigint)
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog'
AS $function$
  SELECT coalesce(ap.applied_at, h.accepted_at), h.amount_minor FROM tenant_data.price_history h
   LEFT JOIN tenant_data.price_history_applied ap ON ap.tenant_id = h.tenant_id AND ap.price_history_id = h.price_history_id
   WHERE h.tenant_id = p_tenant_id AND h.write_scope_id = p_write_scope_id AND h.price_type IN ('REGULAR', 'SALE')
     AND coalesce(ap.applied_at, h.accepted_at) < p_before
     -- Отсечение секций price_history (партиции по accepted_at): применение не раньше принятия, поэтому условие безопасно (ревью шага 26, находка 10)
     AND h.accepted_at < p_before
     AND NOT EXISTS (SELECT 1 FROM tenant_data.price_history c WHERE c.tenant_id = h.tenant_id AND c.corrects_price_history_id = h.price_history_id)
     AND NOT EXISTS (SELECT 1 FROM tenant_data.price_history_not_applied na WHERE na.tenant_id = h.tenant_id AND na.price_history_id = h.price_history_id)
     AND NOT EXISTS (SELECT 1 FROM tenant_data.price_daily d
                      WHERE d.tenant_id = h.tenant_id AND d.write_scope_id = h.write_scope_id AND d.price_type = h.price_type
                        AND d.price_day = (coalesce(ap.applied_at, h.accepted_at) AT TIME ZONE p_tz)::date)
$function$;

CREATE OR REPLACE FUNCTION maintenance.close_price_days(p_now timestamp with time zone DEFAULT now(), p_max_days integer DEFAULT 7)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  tz          text;
  local_today date;
  first_raw   timestamptz;
  next_day    date;
  day_start   timestamptz;
  day_end     timestamptz;
  inserted    bigint;
  tz_closed   int;
  closed      int := 0;
BEGIN
  -- Витрины без известного пояса пропускаются: их сутки нельзя закрыть (Р-65)
  FOR tz IN SELECT DISTINCT time_zone FROM platform.marketplace WHERE time_zone IS NOT NULL ORDER BY 1 LOOP
    local_today := (p_now AT TIME ZONE tz)::date;
    SELECT max(price_day) + 1 INTO next_day FROM maintenance.price_day_close WHERE day_tz = tz;
    IF next_day IS NULL THEN
      -- Первые сутки витрины: обход всей истории — только когда закрытых суток ещё нет (ревью шага 26, находка 10)
      IF first_raw IS NULL THEN
        SELECT min(coalesce(a.applied_at, h.accepted_at)) INTO first_raw FROM tenant_data.price_history h
          LEFT JOIN tenant_data.price_history_applied a ON a.tenant_id = h.tenant_id AND a.price_history_id = h.price_history_id;
      END IF;
      next_day := (first_raw AT TIME ZONE tz)::date;
    END IF;
    CONTINUE WHEN next_day IS NULL;

    tz_closed := 0;
    WHILE tz_closed < p_max_days LOOP
      day_start := next_day::timestamp AT TIME ZONE tz;
      day_end   := (next_day + 1)::timestamp AT TIME ZONE tz;
      EXIT WHEN next_day >= local_today OR p_now < day_end + interval '1 hour';

      INSERT INTO tenant_data.price_daily
        (tenant_id, write_scope_id, price_type, price_day, day_tz, currency, price_basis, min_amount_minor, max_amount_minor,
         first_amount_minor, first_accepted_at, last_amount_minor, last_accepted_at, change_count, min_floor_minor)
      -- OQ-180 (шаг 26): сутки цены — по времени ПРИМЕНЕНИЯ канала (applied_at записи), а не принятия: в свёртке — цена, которую видел
      -- покупатель. Пока запись не подтверждена применением, время принятия — лучшее известное приближение
      SELECT h.tenant_id, h.write_scope_id, h.price_type, next_day, tz, h.currency, h.price_basis,
             min(h.amount_minor), max(h.amount_minor),
             (array_agg(h.amount_minor ORDER BY coalesce(ap.applied_at, h.accepted_at), h.price_history_id))[1], min(coalesce(ap.applied_at, h.accepted_at)),
             (array_agg(h.amount_minor ORDER BY coalesce(ap.applied_at, h.accepted_at) DESC, h.price_history_id DESC))[1], max(coalesce(ap.applied_at, h.accepted_at)),
             count(*), min(h.effective_min_price_minor)
        FROM tenant_data.price_history h
        LEFT JOIN tenant_data.price_history_applied ap ON ap.tenant_id = h.tenant_id AND ap.price_history_id = h.price_history_id
       WHERE coalesce(ap.applied_at, h.accepted_at) >= day_start AND coalesce(ap.applied_at, h.accepted_at) < day_end
         -- Отсечение секций: применение не раньше принятия (ревью шага 26, находка 10)
         AND h.accepted_at < day_end
         AND tenant_data.write_scope_time_zone(h.tenant_id, h.write_scope_id) = tz
         AND NOT EXISTS (SELECT 1 FROM tenant_data.price_history c
                          WHERE c.tenant_id = h.tenant_id AND c.corrects_price_history_id = h.price_history_id)
         -- Шаг 25 (риск 28): цена, которую канал не применил, в вечную свёртку не попадает
         AND NOT EXISTS (SELECT 1 FROM tenant_data.price_history_not_applied na
                          WHERE na.tenant_id = h.tenant_id AND na.price_history_id = h.price_history_id)
       GROUP BY h.tenant_id, h.write_scope_id, h.price_type, h.currency, h.price_basis
      ON CONFLICT DO NOTHING;
      GET DIAGNOSTICS inserted = ROW_COUNT;

      INSERT INTO maintenance.price_day_close (price_day, day_tz, rows_inserted) VALUES (next_day, tz, inserted);
      tz_closed := tz_closed + 1;
      closed := closed + 1;
      next_day := next_day + 1;
    END LOOP;
  END LOOP;
  RETURN closed;
END $function$;


/** OQ-180: глубина истории и цены суток начала скидки — тоже по времени применения */
CREATE OR REPLACE FUNCTION tenant_data.omnibus_lowest_prior_price(p_tenant_id uuid, p_write_scope_id uuid, p_starts_at timestamptz)
  RETURNS TABLE (status text, lowest_minor bigint, window_from date, window_to date, day_tz text, history_since timestamptz, history_days integer, external_changes integer)
  LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS $fn$
DECLARE
  tz         text;
  start_day  date;
  wfrom      date;
  wto        date;
  from_ts    timestamptz;
  to_ts      timestamptz;
  since      timestamptz;
  before_m   bigint;
  inside_m   bigint;
  external_m bigint;
  external_n integer;
BEGIN
  tz := tenant_data.write_scope_time_zone(p_tenant_id, p_write_scope_id);
  -- Р-124: история видна с подключения оффера (единица записи цены) или с первой известной цены, если она раньше; истории цен от канала
  -- нет ни у Kaufland, ни у Amazon (снимки спецификаций) — отсчёт от подключения
  SELECT least(
           (SELECT s.created_at FROM tenant_data.write_scope s WHERE s.tenant_id = p_tenant_id AND s.write_scope_id = p_write_scope_id),
           -- OQ-180 (шаг 26): момент цены — время применения каналом
           (SELECT min(coalesce(ap.applied_at, h.accepted_at)) FROM tenant_data.price_history h
             LEFT JOIN tenant_data.price_history_applied ap ON ap.tenant_id = h.tenant_id AND ap.price_history_id = h.price_history_id
             WHERE h.tenant_id = p_tenant_id AND h.write_scope_id = p_write_scope_id AND h.price_type IN ('REGULAR', 'SALE')
               AND NOT EXISTS (SELECT 1 FROM tenant_data.price_history_not_applied na WHERE na.tenant_id = h.tenant_id AND na.price_history_id = h.price_history_id)),
           (SELECT min(d.first_accepted_at) FROM tenant_data.price_daily_effective d
             WHERE d.tenant_id = p_tenant_id AND d.write_scope_id = p_write_scope_id AND d.price_type IN ('REGULAR', 'SALE')))
    INTO since;
  IF tz IS NULL THEN
    RETURN QUERY SELECT 'TIME_ZONE_UNKNOWN'::text, NULL::bigint, NULL::date, NULL::date, NULL::text, since,
                        greatest(0, floor(extract(epoch FROM (p_starts_at - since)) / 86400))::int, 0;
    RETURN;
  END IF;
  -- Ревью шага 24, находка 14: цены суток начала скидки до её начала тоже в окне
  start_day := (p_starts_at AT TIME ZONE tz)::date;
  wfrom := start_day - 30;
  wto := start_day - 1;
  from_ts := wfrom::timestamp AT TIME ZONE tz;
  to_ts := start_day::timestamp AT TIME ZONE tz;

  -- Цена, действовавшая к началу окна: последнее изменение до него
  SELECT x.amount INTO before_m FROM (
    SELECT r.accepted_at AS at, r.amount_minor AS amount FROM tenant_data.omnibus_raw_prices(p_tenant_id, p_write_scope_id, tz, to_ts) r WHERE r.accepted_at < from_ts
    UNION ALL
    SELECT d.last_accepted_at, d.last_amount_minor FROM tenant_data.price_daily_effective d
     WHERE d.tenant_id = p_tenant_id AND d.write_scope_id = p_write_scope_id AND d.price_type IN ('REGULAR', 'SALE') AND d.price_day < wfrom
  ) x ORDER BY x.at DESC LIMIT 1;

  -- Цены внутри окна: закрытые сутки — наименьшая цена суток, незакрытые — сырьё; сутки начала — сырьё до начала скидки; цена, которую
  -- канал не применил, — не цена покупателя (риск 28)
  SELECT min(y.v) INTO inside_m FROM (
    SELECT d.min_amount_minor AS v FROM tenant_data.price_daily_effective d
     WHERE d.tenant_id = p_tenant_id AND d.write_scope_id = p_write_scope_id AND d.price_type IN ('REGULAR', 'SALE') AND d.price_day BETWEEN wfrom AND wto
    UNION ALL
    SELECT r.amount_minor FROM tenant_data.omnibus_raw_prices(p_tenant_id, p_write_scope_id, tz, to_ts) r WHERE r.accepted_at >= from_ts AND r.accepted_at < to_ts
    UNION ALL
    SELECT h.amount_minor FROM tenant_data.price_history h
     LEFT JOIN tenant_data.price_history_applied ap ON ap.tenant_id = h.tenant_id AND ap.price_history_id = h.price_history_id
     WHERE h.tenant_id = p_tenant_id AND h.write_scope_id = p_write_scope_id AND h.price_type IN ('REGULAR', 'SALE')
       AND coalesce(ap.applied_at, h.accepted_at) >= to_ts AND coalesce(ap.applied_at, h.accepted_at) < p_starts_at
       AND NOT EXISTS (SELECT 1 FROM tenant_data.price_history c WHERE c.tenant_id = h.tenant_id AND c.corrects_price_history_id = h.price_history_id)
       AND NOT EXISTS (SELECT 1 FROM tenant_data.price_history_not_applied na WHERE na.tenant_id = h.tenant_id AND na.price_history_id = h.price_history_id)
  ) y;

  -- Р-124: цена, выставленная мимо нас и замеченная сверкой (кейс расхождения Р-55), — тоже цена окна; проверка с ней не достоверна
  SELECT min(c.observed_amount_minor), count(*)::int INTO external_m, external_n FROM channel_data.divergence_case c
   WHERE c.tenant_id = p_tenant_id AND c.write_scope_id = p_write_scope_id AND c.field = 'PRICE' AND c.cause = 'EXTERNAL_CHANGE' AND c.observed_amount_minor IS NOT NULL
     AND c.opened_at >= from_ts AND c.opened_at < p_starts_at;

  RETURN QUERY SELECT
    CASE WHEN p_starts_at > now() THEN 'WINDOW_OPEN' WHEN before_m IS NULL AND inside_m IS NULL AND external_m IS NULL THEN 'NO_PRICE_HISTORY'
         WHEN before_m IS NULL THEN 'INCOMPLETE_HISTORY' WHEN external_n > 0 THEN 'EXTERNAL_CHANGES' ELSE 'OK' END,
    (SELECT min(v) FROM unnest(ARRAY[before_m, inside_m, external_m]) AS v),
    wfrom, wto, tz, since,
    greatest(0, floor(extract(epoch FROM (p_starts_at - since)) / 86400))::int,
    external_n;
END $fn$;

/** Р-96: список разрешённого пути решения — добавлено время применения цены */
CREATE OR REPLACE FUNCTION security.decision_path_allowed_privileges()
 RETURNS TABLE(table_name text, privilege text, column_name text)
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
AS $function$
  SELECT t, p, c FROM (VALUES
    ('platform.marketplace', 'SELECT', NULL), ('platform.fx_rate', 'SELECT', NULL), ('platform.explanation_ruleset', 'SELECT', NULL),
    ('platform.channel_capability', 'SELECT', NULL), ('platform.vat_rate_default', 'SELECT', NULL),
    -- лимит правок аккаунта для бюджета записи (0008, channel_write_budget)
    ('tenant_data.channel_capability_override', 'SELECT', NULL),
    ('tenant_data.tenant', 'SELECT', NULL), ('tenant_data.channel_account', 'SELECT', NULL), ('tenant_data.product', 'SELECT', NULL),
    ('tenant_data.product_vat_rate', 'SELECT', NULL), ('tenant_data.offer_mapping', 'SELECT', NULL), ('tenant_data.pricing_strategy', 'SELECT', NULL),
    ('channel_data.pricing_strategy_undercut', 'SELECT', NULL), ('tenant_data.min_price', 'SELECT', NULL), ('tenant_data.max_price', 'SELECT', NULL),
    ('tenant_data.guardrail', 'SELECT', NULL), ('tenant_data.cost_profile', 'SELECT', NULL), ('channel_data.fee_estimate', 'SELECT', NULL),
    ('tenant_data.price_stop', 'SELECT', NULL), ('channel_data.pricing_halt_review', 'SELECT', NULL),
    ('tenant_data.write_scope', 'SELECT', NULL), ('tenant_data.write_scope', 'UPDATE', 'status'),
    ('tenant_data.write_scope_sync_state', 'SELECT', NULL), ('tenant_data.write_scope_sync_state', 'INSERT', NULL), ('tenant_data.write_scope_sync_state', 'UPDATE', NULL),
    ('channel_data.competitor_state', 'SELECT', NULL), ('channel_data.competitor_state', 'INSERT', NULL), ('channel_data.competitor_state', 'UPDATE', NULL),
    ('channel_data.competitor_move', 'SELECT', NULL), ('channel_data.competitor_move', 'INSERT', NULL),
    ('channel_data.competitor_move_latest', 'SELECT', NULL), ('channel_data.competitor_move_latest', 'INSERT', NULL), ('channel_data.competitor_move_latest', 'UPDATE', NULL),
    ('channel_data.competitor_price_daily', 'SELECT', NULL), ('channel_data.competitor_price_daily', 'INSERT', NULL), ('channel_data.competitor_price_daily', 'UPDATE', NULL),
    ('channel_data.rejected_competitor_snapshot', 'SELECT', NULL), ('channel_data.rejected_competitor_snapshot', 'INSERT', NULL),
    ('channel_data.divergence_case', 'SELECT', NULL),
    -- Р-100: путь решения открывает случай расхождения; разрешение (resolution, resolved_*, status) — действие человека
    ('channel_data.divergence_case', 'INSERT', 'tenant_id'), ('channel_data.divergence_case', 'INSERT', 'write_scope_id'), ('channel_data.divergence_case', 'INSERT', 'field'), ('channel_data.divergence_case', 'INSERT', 'expected_amount_minor'), ('channel_data.divergence_case', 'INSERT', 'observed_amount_minor'), ('channel_data.divergence_case', 'INSERT', 'cause'), ('channel_data.divergence_case', 'INSERT', 'opened_at'),
    ('channel_data.observed_channel_state', 'SELECT', NULL), ('channel_data.observed_channel_state', 'INSERT', NULL), ('channel_data.observed_channel_state', 'UPDATE', NULL),
    ('channel_data.observed_price_daily', 'SELECT', NULL), ('channel_data.observed_price_daily', 'INSERT', NULL), ('channel_data.observed_price_daily', 'UPDATE', NULL),
    ('channel_data.price_intent', 'SELECT', NULL), ('channel_data.price_intent', 'INSERT', NULL),
    ('channel_data.price_decision', 'SELECT', NULL), ('channel_data.price_decision', 'INSERT', NULL),
    ('channel_data.price_decision_snapshot_ref', 'SELECT', NULL), ('channel_data.price_decision_snapshot_ref', 'INSERT', NULL),
    ('tenant_data.price_intent_core', 'INSERT', NULL),
    ('tenant_data.channel_write', 'SELECT', NULL), ('tenant_data.channel_write', 'INSERT', NULL), ('tenant_data.channel_write', 'UPDATE', NULL), ('tenant_data.channel_write', 'DELETE', NULL),
    ('tenant_data.channel_write_history', 'SELECT', NULL), ('tenant_data.channel_write_history', 'INSERT', NULL),
    ('channel_data.write_submission', 'SELECT', NULL), ('channel_data.write_submission', 'INSERT', NULL), ('channel_data.write_submission', 'UPDATE', NULL), ('channel_data.write_submission', 'DELETE', NULL),
    ('tenant_data.edit_budget', 'SELECT', NULL), ('tenant_data.edit_budget', 'INSERT', NULL), ('tenant_data.edit_budget', 'UPDATE', NULL),
    ('tenant_data.outbox_event', 'INSERT', NULL), ('tenant_data.price_history', 'SELECT', NULL), ('tenant_data.price_history', 'INSERT', NULL),
    ('channel_data.pricing_halt', 'SELECT', NULL),
    -- Р-100: путь решения ставит системную остановку; снятие, срок проверки и окно — не его столбцы (находка 4 ревью шага 17)
    ('channel_data.pricing_halt', 'INSERT', 'tenant_id'), ('channel_data.pricing_halt', 'INSERT', 'channel_account_id'), ('channel_data.pricing_halt', 'INSERT', 'channel'), ('channel_data.pricing_halt', 'INSERT', 'marketplace'), ('channel_data.pricing_halt', 'INSERT', 'reason_code'), ('channel_data.pricing_halt', 'INSERT', 'rejected_snapshot_id'), ('channel_data.pricing_halt', 'INSERT', 'details'), ('channel_data.pricing_halt', 'INSERT', 'halted_at'), ('channel_data.pricing_halt', 'INSERT', 'review_window'),
    -- Шаг 23 [Р-118, Р-119, Р-39, Р-120]: недоверие каналу ставит путь решения и диспетчер; справочники каналов; наблюдения чужого ценообразования
    ('channel_data.channel_distrust', 'SELECT', NULL),
    ('channel_data.channel_distrust', 'INSERT', 'tenant_id'), ('channel_data.channel_distrust', 'INSERT', 'channel_account_id'), ('channel_data.channel_distrust', 'INSERT', 'channel'),
    ('channel_data.channel_distrust', 'INSERT', 'marketplace'), ('channel_data.channel_distrust', 'INSERT', 'reason_code'), ('channel_data.channel_distrust', 'INSERT', 'details'),
    ('channel_data.channel_distrust', 'INSERT', 'detected_at'),
    ('platform.channel_behaviour', 'SELECT', NULL), ('platform.competitor_source', 'SELECT', NULL),
    ('channel_data.offer_channel_pricing', 'SELECT', NULL), ('channel_data.offer_channel_pricing', 'INSERT', NULL),
    -- Шаг 23 (0083): журнал обработанных уведомлений и состояние PRICING_HEALTH — пишет приёмник уведомлений в транзакции тенанта
    ('channel_data.inbound_notification', 'SELECT', NULL), ('channel_data.inbound_notification', 'INSERT', NULL),
    ('channel_data.offer_pricing_health', 'SELECT', NULL), ('channel_data.offer_pricing_health', 'INSERT', NULL),
    -- Шаг 24 (0086) [Р-122]: полный снимок конкурентов — в транзитный журнал в транзакции снимка; выгрузка в ClickHouse — роль экспорта
    ('channel_data.competitor_snapshot_log', 'INSERT', NULL),
    -- Шаг 24 (0088) [Р-121]: проверку потери уведомления путь решения записывает, вердикт — только читает
    ('channel_data.notification_loss_check', 'SELECT', NULL), ('channel_data.notification_loss_check', 'INSERT', NULL),
    ('channel_data.notification_loss_verdict', 'SELECT', NULL),
    -- Шаг 25 (0090) [Р-121, Р-126]: время последнего опроса товара — ярусный опрос планировщика не зависит от времени уведомлений
    -- Шаг 25 (0091, риск 28): отметка неприменённой цены — триггер завершения записи в транзакции пути решения и диспетчера
    ('tenant_data.price_history_not_applied', 'INSERT', NULL),
    -- OQ-180 (шаг 26): время применения цены каналом пишет путь решения при завершении записи; закрытые сутки он читает
    ('tenant_data.price_history_applied', 'INSERT', NULL), ('maintenance.price_day_close', 'SELECT', NULL),
    ('channel_data.competitor_poll_state', 'SELECT', NULL), ('channel_data.competitor_poll_state', 'INSERT', NULL), ('channel_data.competitor_poll_state', 'UPDATE', NULL),
    ('channel_data.pricing_halt_sample', 'SELECT', NULL),
    ('channel_data.pricing_halt_sample', 'INSERT', 'tenant_id'), ('channel_data.pricing_halt_sample', 'INSERT', 'pricing_halt_id'), ('channel_data.pricing_halt_sample', 'INSERT', 'channel_product_ref'), ('channel_data.pricing_halt_sample', 'INSERT', 'observed_at'), ('channel_data.pricing_halt_sample', 'INSERT', 'verdict'), ('channel_data.pricing_halt_sample', 'INSERT', 'reason_code')
  ) AS a(t, p, c)
$function$;

/**
 * Закрытие тенанта удаляет и отметки времени применения: ревью шага 26, находка 3 — таблица данных тенанта, объявленная
 * TENANT_CLOSURE_ONLY, но не перечисленная в purge_tenant_data, остаётся в базе навсегда
 */
CREATE OR REPLACE FUNCTION maintenance.purge_tenant_data(p_tenant_id uuid, p_delete_price_history boolean DEFAULT false)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  t         text;
  n         bigint;
  total     bigint := 0;
  closed_ts timestamptz;
BEGIN
  SELECT closed_at INTO closed_ts FROM tenant_data.tenant
   WHERE tenant_id = p_tenant_id AND kind = 'CUSTOMER' AND status = 'CLOSED';
  IF closed_ts IS NULL THEN
    RAISE EXCEPTION 'tenant % must be a CLOSED CUSTOMER', p_tenant_id;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM maintenance.tenant_purge_status
                  WHERE subject_tenant_id = p_tenant_id AND postgres_channel_purged_at IS NOT NULL) THEN
    RAISE EXCEPTION 'purge channel data first (maintenance.purge_tenant_channel_data)';
  END IF;
  IF NOT p_delete_price_history
     AND (EXISTS (SELECT 1 FROM tenant_data.price_daily WHERE tenant_id = p_tenant_id)
          OR EXISTS (SELECT 1 FROM tenant_data.price_history WHERE tenant_id = p_tenant_id)
          OR EXISTS (SELECT 1 FROM tenant_data.discount_announcement WHERE tenant_id = p_tenant_id)
          OR EXISTS (SELECT 1 FROM tenant_data.price_intent_core WHERE tenant_id = p_tenant_id)) THEN
    RAISE EXCEPTION 'tenant % has price evidence; deletion requires explicit confirmation (OQ-22)', p_tenant_id;
  END IF;

  INSERT INTO legal.migration_consent_record
    (tenant_id, migration_consent_id, channel_account_id, channel_external_account_id, consenting_user_id,
     consenting_role, mfa_verified_at, disclosure_version, disclosure_text_sha256, other_tools_declaration,
     other_tools_list, typed_confirmation, given_at, expires_at, revoked_at, items, tenant_closed_at)
  SELECT c.tenant_id, c.migration_consent_id, c.channel_account_id, ca.external_account_id, c.user_id,
         m.role, c.mfa_verified_at, c.disclosure_version, c.disclosure_text_sha256, c.other_tools_declaration,
         c.other_tools_list, c.typed_confirmation, c.given_at, c.expires_at, r.revoked_at,
         coalesce((SELECT jsonb_agg(jsonb_build_object(
                     'listing_id', i.listing_id,
                     'listing_snapshot_sha256', encode(i.listing_snapshot_sha256, 'hex'),
                     'verdict_at_consent', i.verdict_at_consent,
                     'acknowledged_losses', to_jsonb(i.acknowledged_losses)))
                     FROM tenant_data.migration_consent_item i
                    WHERE i.tenant_id = c.tenant_id AND i.migration_consent_id = c.migration_consent_id), '[]'::jsonb),
         closed_ts
    FROM tenant_data.migration_consent c
    JOIN tenant_data.channel_account ca ON ca.tenant_id = c.tenant_id AND ca.channel_account_id = c.channel_account_id
    JOIN tenant_data.membership m ON m.tenant_id = c.tenant_id AND m.membership_id = c.membership_id
    LEFT JOIN tenant_data.migration_consent_revocation r
      ON r.tenant_id = c.tenant_id AND r.migration_consent_id = c.migration_consent_id
   WHERE c.tenant_id = p_tenant_id
  ON CONFLICT (tenant_id, migration_consent_id) DO NOTHING;

  FOREACH t IN ARRAY ARRAY[
    'tenant_data.outbox_event', 'tenant_data.price_history_not_applied', 'tenant_data.price_history_applied', 'tenant_data.price_history', 'tenant_data.price_daily_correction',
    'tenant_data.price_daily', 'tenant_data.price_intent_core',
    'tenant_data.channel_write_history', 'tenant_data.channel_write', 'tenant_data.edit_budget',
    'tenant_data.migration_consent_revocation', 'tenant_data.migration_consent_item', 'tenant_data.migration_consent',
    'tenant_data.stock_movement', 'tenant_data.stock_allocation', 'tenant_data.stock_pool',
    'tenant_data.inbound_api_key', 'tenant_data.stock_source',
    -- Остановки цен человеком: тоже данные тенанта, удалялись только вместе с базой (найдено правилом проверки схемы шага 26)
    'tenant_data.price_stop',
    'tenant_data.min_price', 'tenant_data.max_price', 'tenant_data.product_vat_rate', 'tenant_data.guardrail', 'tenant_data.divergence_policy',
    'tenant_data.cost_profile',
    'tenant_data.discount_announcement', 'tenant_data.offer_mapping', 'tenant_data.write_scope_sync_state', 'tenant_data.write_scope',
    'tenant_data.pricing_strategy', 'tenant_data.channel_capability_override', 'tenant_data.channel_account',
    'tenant_data.bundle_component', 'tenant_data.product', 'tenant_data.membership']
  LOOP
    EXECUTE format('DELETE FROM %s WHERE tenant_id = $1', t) USING p_tenant_id;
    GET DIAGNOSTICS n = ROW_COUNT;
    total := total + n;
  END LOOP;

  UPDATE tenant_data.tenant SET name = 'closed tenant' WHERE tenant_id = p_tenant_id;
  UPDATE maintenance.tenant_purge_status
     SET postgres_tenant_purged_at = now(),
         legal_hold_until = CASE WHEN EXISTS (SELECT 1 FROM legal.migration_consent_record WHERE tenant_id = p_tenant_id)
                                 THEN (closed_ts + interval '3 years')::date END
   WHERE subject_tenant_id = p_tenant_id;
  INSERT INTO maintenance.retention_run (table_name, action, rows_affected, subject_tenant_id)
  VALUES ('tenant_data.*', 'TENANT_PURGED', total, p_tenant_id);
  RETURN total;
END $function$;

COMMIT;
