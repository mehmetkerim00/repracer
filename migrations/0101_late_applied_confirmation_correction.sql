-- 0101: подтверждение применения, пришедшее после закрытия суток, — строка-поправка [Р-29, шаг 27, задача D; риск 34, OQ-192]
--
-- Шаг 26 закрыл OQ-180: сутки цены считаются по времени ПРИМЕНЕНИЯ. Но подтверждение канала приходит позже принятия и может опоздать
-- к закрытию суток. Тогда отметка времени применения не ставилась вовсе (0096), и цена навсегда оставалась в сутках принятия — риск 34.
-- Теперь отметка ставится всегда, а закрытые сутки исправляются так, как требует Р-29: сама свёртка неизменяема, исправление — добавочная
-- строка-поправка, итог — представление `price_daily_effective`.
--
-- Почему отдельная таблица, а не `price_daily_correction`: поправка человека — административное действие, которое база принимает только
-- от пользователя сессии и пишет в аудит [Р-97]. Пересчёт по опоздавшему подтверждению делает планировщик, человека за ним нет, и
-- ослаблять стража административной записи ради него нельзя. Поэтому у системного пересчёта своя таблица и своя роль.
-- Итог суток: поправка человека — последнее слово (он знал, что правил); если её нет, действует системный пересчёт.
--
-- Сутки могут остаться без цен вовсе: у системной поправки change_count = 0 и суммы NULL — «в эти сутки мы цену не применяли».
-- Агрегаты Omnibus такие сутки пропускают (min игнорирует NULL), глубина истории их не считает ценой.

BEGIN;

SET ROLE repracer_owner;

CREATE TABLE tenant_data.price_daily_system_correction (
  tenant_id                 uuid NOT NULL,
  correction_id             uuid NOT NULL DEFAULT gen_random_uuid(),
  write_scope_id            uuid NOT NULL,
  price_type                text NOT NULL,
  price_day                 date NOT NULL,
  min_amount_minor          bigint,
  max_amount_minor          bigint,
  first_amount_minor        bigint,
  first_accepted_at         timestamptz,
  last_amount_minor         bigint,
  last_accepted_at          timestamptz,
  -- Отдельной проверки «не меньше нуля» нет: её целиком покрывает price_daily_system_correction_shape ниже [Р-104]
  change_count              integer NOT NULL,
  min_floor_minor           bigint,
  reason                    text NOT NULL CHECK (reason IN ('LATE_APPLIED_CONFIRMATION')),
  supersedes_correction_id  uuid,
  recorded_at               timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, correction_id),
  FOREIGN KEY (tenant_id, write_scope_id, price_type, price_day)
    REFERENCES tenant_data.price_daily (tenant_id, write_scope_id, price_type, price_day),
  -- Сутки либо посчитаны целиком, либо пусты: половины свёртки не бывает
  CONSTRAINT price_daily_system_correction_shape CHECK (
    (change_count >= 1 AND min_amount_minor IS NOT NULL AND max_amount_minor IS NOT NULL AND first_amount_minor IS NOT NULL
      AND first_accepted_at IS NOT NULL AND last_amount_minor IS NOT NULL AND last_accepted_at IS NOT NULL AND min_floor_minor IS NOT NULL)
    OR (change_count = 0 AND min_amount_minor IS NULL AND max_amount_minor IS NULL AND first_amount_minor IS NULL
      AND first_accepted_at IS NULL AND last_amount_minor IS NULL AND last_accepted_at IS NULL AND min_floor_minor IS NULL)),
  CONSTRAINT price_daily_system_correction_bounds CHECK (
    change_count = 0 OR (min_amount_minor <= first_amount_minor AND first_amount_minor <= max_amount_minor
      AND min_amount_minor <= last_amount_minor AND last_amount_minor <= max_amount_minor
      AND first_accepted_at <= last_accepted_at AND min_amount_minor >= min_floor_minor))
);
COMMENT ON TABLE tenant_data.price_daily_system_correction IS
  'Шаг 27 [Р-29, риск 34, OQ-192]: пересчёт закрытых суток после опоздавшего подтверждения применения цены; свёртка не меняется';
-- Уникального индекса на supersedes_correction_id здесь нет: цепочку держит страж a_price_daily_system_correction_chain, который
-- берёт advisory-блокировку на сутки. Второй защиты того же правила не заводим [Р-104]
SELECT security.register_table('tenant_data.price_daily_system_correction', 'TENANT', 'append_only');
SELECT security.grant_retention('tenant_data.price_daily_system_correction');
-- Доказательство Omnibus, как свёртка: до закрытия тенанта
INSERT INTO maintenance.retention_policy (table_name, method, bound)
VALUES ('tenant_data.price_daily_system_correction', 'TENANT_CLOSURE_ONLY', 'MAX_AGE');
-- Пересчёт закрытых суток делает та же роль, что закрывает сутки (maintenance.close_price_days, 0025): как и закрытие, он идёт по всем
-- тенантам сразу, поэтому у роли своя политика строк — как retention_close_day у свёртки
GRANT SELECT, INSERT ON tenant_data.price_daily_system_correction TO repracer_retention;
CREATE POLICY retention_correct_day ON tenant_data.price_daily_system_correction FOR INSERT TO repracer_retention WITH CHECK (true);
CREATE POLICY retention_correct_read ON tenant_data.price_daily_system_correction FOR SELECT TO repracer_retention USING (true);
-- Путь решения свёртку и поправки не читает напрямую [Р-96]: окно Omnibus ему считают функции базы (SECURITY DEFINER)
GRANT SELECT ON tenant_data.price_daily_system_correction TO repracer_admin;

-- Журнал пересчёта: действие у строки retention_run (как остальные действия обслуживания)
ALTER TABLE maintenance.retention_run DROP CONSTRAINT retention_run_action_check;
ALTER TABLE maintenance.retention_run ADD CONSTRAINT retention_run_action_check
  CHECK (action IN ('PARTITION_CREATED', 'PARTITION_DROPPED', 'PARTITION_FORCE_DROPPED', 'ROWS_DELETED', 'TENANT_PURGED', 'LATE_APPLIED_CORRECTED'));

RESET ROLE;

/** Цепочка системных поправок суток: новая продолжает действующую, иначе два пересчёта разошлись бы молча (как у поправки человека) */
CREATE FUNCTION tenant_data.price_daily_system_correction_chain_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
DECLARE
  head uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(
    concat_ws('|', NEW.tenant_id, NEW.write_scope_id, NEW.price_type, NEW.price_day), 0));
  SELECT c.correction_id INTO head
    FROM tenant_data.price_daily_system_correction c
   WHERE c.tenant_id = NEW.tenant_id AND c.write_scope_id = NEW.write_scope_id
     AND c.price_type = NEW.price_type AND c.price_day = NEW.price_day
     AND NOT EXISTS (SELECT 1 FROM tenant_data.price_daily_system_correction s
                      WHERE s.tenant_id = c.tenant_id AND s.supersedes_correction_id = c.correction_id);
  IF NEW.supersedes_correction_id IS DISTINCT FROM head THEN
    RAISE EXCEPTION 'system correction must supersede the current correction % of this day', head
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  NEW.recorded_at := now();
  RETURN NEW;
END $fn$;
CREATE TRIGGER a_price_daily_system_correction_chain BEFORE INSERT ON tenant_data.price_daily_system_correction
  FOR EACH ROW EXECUTE FUNCTION tenant_data.price_daily_system_correction_chain_guard();

/**
 * Итог суток [Р-29]: свёртка, поверх неё поправка человека, а если её нет — системный пересчёт.
 * Читают представление административный сервис и удаление по сроку: у пути решения прав на саму свёртку нет [Р-96], и окно Omnibus ему
 * считают функции базы (SECURITY DEFINER). `security_invoker` здесь именно поэтому: RLS применяется от имени читающего (0025).
 * `corrected_by` называет, чья поправка действует, — экран и выгрузка не выдумывают источник.
 */
-- Столбцов стало больше, а порядок изменился: представление пересоздаётся (CREATE OR REPLACE переименование не разрешает)
DROP VIEW tenant_data.price_daily_effective;
-- security_invoker: RLS применяется от имени читающего, иначе представление не видит строк тенанта (0025)
CREATE VIEW tenant_data.price_daily_effective WITH (security_invoker = true) AS
  SELECT d.tenant_id, d.write_scope_id, d.price_type, d.price_day, d.day_tz, d.currency, d.price_basis,
         CASE WHEN c.price_daily_correction_id IS NOT NULL THEN c.min_amount_minor WHEN s.correction_id IS NOT NULL THEN s.min_amount_minor ELSE d.min_amount_minor END AS min_amount_minor,
         CASE WHEN c.price_daily_correction_id IS NOT NULL THEN c.max_amount_minor WHEN s.correction_id IS NOT NULL THEN s.max_amount_minor ELSE d.max_amount_minor END AS max_amount_minor,
         CASE WHEN c.price_daily_correction_id IS NOT NULL THEN c.first_amount_minor WHEN s.correction_id IS NOT NULL THEN s.first_amount_minor ELSE d.first_amount_minor END AS first_amount_minor,
         CASE WHEN c.price_daily_correction_id IS NOT NULL THEN c.first_accepted_at WHEN s.correction_id IS NOT NULL THEN s.first_accepted_at ELSE d.first_accepted_at END AS first_accepted_at,
         CASE WHEN c.price_daily_correction_id IS NOT NULL THEN c.last_amount_minor WHEN s.correction_id IS NOT NULL THEN s.last_amount_minor ELSE d.last_amount_minor END AS last_amount_minor,
         CASE WHEN c.price_daily_correction_id IS NOT NULL THEN c.last_accepted_at WHEN s.correction_id IS NOT NULL THEN s.last_accepted_at ELSE d.last_accepted_at END AS last_accepted_at,
         CASE WHEN c.price_daily_correction_id IS NOT NULL THEN c.change_count WHEN s.correction_id IS NOT NULL THEN s.change_count ELSE d.change_count END AS change_count,
         CASE WHEN c.price_daily_correction_id IS NOT NULL THEN c.min_floor_minor WHEN s.correction_id IS NOT NULL THEN s.min_floor_minor ELSE d.min_floor_minor END AS min_floor_minor,
         COALESCE(c.price_daily_correction_id, s.correction_id) AS correction_id,
         COALESCE(c.reason, s.reason) AS correction_reason,
         CASE WHEN c.price_daily_correction_id IS NOT NULL THEN 'HUMAN'
              WHEN s.correction_id IS NOT NULL THEN 'SYSTEM' END AS corrected_by,
         (c.price_daily_correction_id IS NOT NULL OR s.correction_id IS NOT NULL) AS corrected
    FROM tenant_data.price_daily d
    LEFT JOIN LATERAL (
      SELECT x.* FROM tenant_data.price_daily_correction x
       WHERE x.tenant_id = d.tenant_id AND x.write_scope_id = d.write_scope_id AND x.price_type = d.price_type AND x.price_day = d.price_day
         AND NOT EXISTS (SELECT 1 FROM tenant_data.price_daily_correction n
                          WHERE n.tenant_id = x.tenant_id AND n.supersedes_correction_id = x.price_daily_correction_id)) c ON true
    LEFT JOIN LATERAL (
      SELECT y.* FROM tenant_data.price_daily_system_correction y
       WHERE y.tenant_id = d.tenant_id AND y.write_scope_id = d.write_scope_id AND y.price_type = d.price_type AND y.price_day = d.price_day
         AND NOT EXISTS (SELECT 1 FROM tenant_data.price_daily_system_correction n
                          WHERE n.tenant_id = y.tenant_id AND n.supersedes_correction_id = y.correction_id)) s ON true;
ALTER VIEW tenant_data.price_daily_effective OWNER TO repracer_owner;
GRANT SELECT ON tenant_data.price_daily_effective TO repracer_app, repracer_retention;

/**
 * OQ-192 (шаг 27): отметка времени применения ставится ВСЕГДА, даже если сутки принятия уже закрыты. Расхождение закрытых суток
 * исправляет `maintenance.correct_closed_price_days` строкой-поправкой [Р-29]; раньше отметка просто не ставилась и цена навсегда
 * оставалась в сутках принятия (риск 34).
 */
SET ROLE repracer_owner;
-- Пересчёт закрытых суток (maintenance.correct_closed_price_days) берёт отметки, записанные за последний месяц: без индекса это обход
-- всего журнала отметок при каждом запуске работы
CREATE INDEX price_history_applied_recorded_at_idx ON tenant_data.price_history_applied (recorded_at);

RESET ROLE;

CREATE OR REPLACE FUNCTION tenant_data.price_history_mark_applied() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  IF NEW.field = 'PRICE' AND NEW.final_status = 'APPLIED' AND NEW.applied_at IS NOT NULL THEN
    INSERT INTO tenant_data.price_history_applied (tenant_id, price_history_id, channel_write_id, write_scope_id, accepted_at, applied_at)
    SELECT h.tenant_id, h.price_history_id, h.channel_write_id, h.write_scope_id, h.accepted_at, greatest(NEW.applied_at, h.accepted_at)
      FROM tenant_data.price_history h
     WHERE h.tenant_id = NEW.tenant_id AND h.channel_write_id = NEW.channel_write_id
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NULL;
END $fn$;

/** Свёртка одних суток единицы записи по нынешним фактам — общий счёт для закрытия суток и для поправки */
CREATE FUNCTION maintenance.price_day_rollup(
  p_tenant_id uuid, p_write_scope_id uuid, p_price_type text, p_day date, p_tz text)
  RETURNS TABLE (currency text, price_basis text, min_amount_minor bigint, max_amount_minor bigint,
                 first_amount_minor bigint, first_accepted_at timestamptz, last_amount_minor bigint, last_accepted_at timestamptz,
                 change_count integer, min_floor_minor bigint)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT h.currency, h.price_basis, min(h.amount_minor), max(h.amount_minor),
         (array_agg(h.amount_minor ORDER BY coalesce(ap.applied_at, h.accepted_at), h.price_history_id))[1], min(coalesce(ap.applied_at, h.accepted_at)),
         (array_agg(h.amount_minor ORDER BY coalesce(ap.applied_at, h.accepted_at) DESC, h.price_history_id DESC))[1], max(coalesce(ap.applied_at, h.accepted_at)),
         count(*)::int, min(h.effective_min_price_minor)
    FROM tenant_data.price_history h
    LEFT JOIN tenant_data.price_history_applied ap ON ap.tenant_id = h.tenant_id AND ap.price_history_id = h.price_history_id
   WHERE h.tenant_id = p_tenant_id AND h.write_scope_id = p_write_scope_id AND h.price_type = p_price_type
     AND coalesce(ap.applied_at, h.accepted_at) >= (p_day::timestamp AT TIME ZONE p_tz)
     AND coalesce(ap.applied_at, h.accepted_at) < ((p_day + 1)::timestamp AT TIME ZONE p_tz)
     -- Отсечение секций price_history (партиции по accepted_at): применение не раньше принятия
     AND h.accepted_at < ((p_day + 1)::timestamp AT TIME ZONE p_tz)
     AND NOT EXISTS (SELECT 1 FROM tenant_data.price_history c
                      WHERE c.tenant_id = h.tenant_id AND c.corrects_price_history_id = h.price_history_id)
     AND NOT EXISTS (SELECT 1 FROM tenant_data.price_history_not_applied na
                      WHERE na.tenant_id = h.tenant_id AND na.price_history_id = h.price_history_id)
   GROUP BY h.currency, h.price_basis
$$;

/**
 * Р-29, риск 34: сутки, закрытые до того, как канал подтвердил применение цены, пересчитываются по нынешним фактам.
 * Расхождение записывается строкой-поправкой (или первой строкой суток, если строки суток не было вовсе), сама свёртка не меняется.
 * Идемпотентна: пишет, только если итог отличается от действующего.
 */
CREATE FUNCTION maintenance.correct_closed_price_days(p_now timestamptz DEFAULT now())
  RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  d         record;
  roll      record;
  eff       record;
  prev      uuid;
  written   int;
  inserted  int := 0;
  corrected int := 0;
BEGIN
  FOR d IN
    WITH moved AS (
      SELECT ap.tenant_id, ap.write_scope_id, h.price_type, z.tz,
             (ap.accepted_at AT TIME ZONE z.tz)::date AS accepted_day,
             (ap.applied_at  AT TIME ZONE z.tz)::date AS applied_day,
             ap.recorded_at
        FROM tenant_data.price_history_applied ap
        JOIN tenant_data.price_history h ON h.tenant_id = ap.tenant_id AND h.price_history_id = ap.price_history_id
        JOIN LATERAL (SELECT tenant_data.write_scope_time_zone(ap.tenant_id, ap.write_scope_id) AS tz) z ON z.tz IS NOT NULL
       WHERE (ap.accepted_at AT TIME ZONE z.tz)::date <> (ap.applied_at AT TIME ZONE z.tz)::date
         AND ap.applied_at < p_now
         -- Отметки старше месяца пересчёт уже видел (работа идёт каждые несколько минут и идемпотентна): без этой границы каждый запуск
         -- обходил бы весь журнал отметок за всё время
         AND ap.recorded_at > p_now - interval '30 days'
    ), late AS (
      SELECT m.* FROM moved m
       WHERE EXISTS (SELECT 1 FROM maintenance.price_day_close c
                      WHERE c.day_tz = m.tz AND c.price_day = m.accepted_day AND c.closed_at < m.recorded_at)
    ), days AS (
      SELECT tenant_id, write_scope_id, price_type, tz, accepted_day AS day FROM late
      UNION
      SELECT tenant_id, write_scope_id, price_type, tz, applied_day FROM late
    )
    SELECT x.* FROM days x
     WHERE EXISTS (SELECT 1 FROM maintenance.price_day_close c WHERE c.day_tz = x.tz AND c.price_day = x.day)
  LOOP
    SELECT * INTO roll FROM maintenance.price_day_rollup(d.tenant_id, d.write_scope_id, d.price_type, d.day, d.tz);
    SELECT * INTO eff FROM tenant_data.price_daily_effective e
     WHERE e.tenant_id = d.tenant_id AND e.write_scope_id = d.write_scope_id AND e.price_type = d.price_type AND e.price_day = d.day;

    IF eff IS NULL THEN
      -- Строки суток не было: опоздавшее подтверждение перенесло цену в сутки, где цены не считали. Это не правка свёртки, а её первая
      -- строка за эти сутки
      CONTINUE WHEN roll IS NULL;
      INSERT INTO tenant_data.price_daily
        (tenant_id, write_scope_id, price_type, price_day, day_tz, currency, price_basis, min_amount_minor, max_amount_minor,
         first_amount_minor, first_accepted_at, last_amount_minor, last_accepted_at, change_count, min_floor_minor)
      VALUES (d.tenant_id, d.write_scope_id, d.price_type, d.day, d.tz, roll.currency, roll.price_basis, roll.min_amount_minor,
              roll.max_amount_minor, roll.first_amount_minor, roll.first_accepted_at, roll.last_amount_minor, roll.last_accepted_at,
              roll.change_count, roll.min_floor_minor)
      ON CONFLICT DO NOTHING;
      -- Счёт — по записанным строкам, а не по рассмотренным суткам: работа сообщает, сколько поправок она сделала
      GET DIAGNOSTICS written = ROW_COUNT;
      inserted := inserted + written;
      CONTINUE;
    END IF;

    -- Поправка человека — последнее слово: его число система не пересчитывает
    CONTINUE WHEN eff.corrected_by = 'HUMAN';
    CONTINUE WHEN coalesce(roll.change_count, 0) IS NOT DISTINCT FROM eff.change_count
                  AND roll.min_amount_minor IS NOT DISTINCT FROM eff.min_amount_minor
                  AND roll.max_amount_minor IS NOT DISTINCT FROM eff.max_amount_minor
                  AND roll.first_amount_minor IS NOT DISTINCT FROM eff.first_amount_minor
                  AND roll.last_amount_minor IS NOT DISTINCT FROM eff.last_amount_minor
                  AND roll.first_accepted_at IS NOT DISTINCT FROM eff.first_accepted_at
                  AND roll.last_accepted_at IS NOT DISTINCT FROM eff.last_accepted_at
                  -- Пол суток — часть свёртки (отчёт «пол удержал цену», Р-117): расхождение только по нему тоже поправка
                  AND roll.min_floor_minor IS NOT DISTINCT FROM eff.min_floor_minor;

    prev := CASE WHEN eff.corrected_by = 'SYSTEM' THEN eff.correction_id END;
    INSERT INTO tenant_data.price_daily_system_correction
      (tenant_id, write_scope_id, price_type, price_day, min_amount_minor, max_amount_minor, first_amount_minor, first_accepted_at,
       last_amount_minor, last_accepted_at, change_count, min_floor_minor, reason, supersedes_correction_id)
    VALUES (d.tenant_id, d.write_scope_id, d.price_type, d.day,
            roll.min_amount_minor, roll.max_amount_minor, roll.first_amount_minor, roll.first_accepted_at,
            roll.last_amount_minor, roll.last_accepted_at, coalesce(roll.change_count, 0), roll.min_floor_minor,
            'LATE_APPLIED_CONFIRMATION', prev);
    corrected := corrected + 1;
  END LOOP;

  -- Журнал называет ту таблицу, в которую писали: поправки — в таблицу поправок, первые строки суток — в саму свёртку
  IF corrected > 0 THEN
    INSERT INTO maintenance.retention_run (table_name, action, rows_affected)
    VALUES ('tenant_data.price_daily_system_correction', 'LATE_APPLIED_CORRECTED', corrected);
  END IF;
  IF inserted > 0 THEN
    INSERT INTO maintenance.retention_run (table_name, action, rows_affected)
    VALUES ('tenant_data.price_daily', 'LATE_APPLIED_CORRECTED', inserted);
  END IF;
  RETURN corrected + inserted;
END $fn$;

-- Пересчёт суток принадлежит роли удаления по сроку — как закрытие суток (close_price_days, 0025): её политики строк видят данные всех
-- тенантов, а владелец схемы — нет (RLS FORCE)
ALTER FUNCTION maintenance.correct_closed_price_days(timestamptz) OWNER TO repracer_retention;
ALTER FUNCTION maintenance.price_day_rollup(uuid, uuid, text, date, text) OWNER TO repracer_retention;
ALTER FUNCTION tenant_data.price_daily_system_correction_chain_guard() OWNER TO repracer_owner;
REVOKE EXECUTE ON FUNCTION maintenance.correct_closed_price_days(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION maintenance.correct_closed_price_days(timestamptz) TO repracer_retention;
REVOKE EXECUTE ON FUNCTION maintenance.price_day_rollup(uuid, uuid, text, date, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION maintenance.price_day_rollup(uuid, uuid, text, date, text) TO repracer_retention;
SET ROLE repracer_owner;
-- Право пути решения на журнал закрытых суток больше не нужно: закрытые сутки исправляет планировщик, а не путь решения.
-- Вместе с правом уходит и строка списка разрешённого [Р-96]: список и права сверяются в обе стороны (проверка схемы)
REVOKE SELECT ON maintenance.price_day_close FROM repracer_app;
-- Административной роли новая таблица только для чтения: строки в неё пишет пересчёт суток, а не человек [Р-97]
REVOKE INSERT, UPDATE, DELETE ON tenant_data.price_daily_system_correction FROM repracer_admin;
RESET ROLE;

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
    ('tenant_data.price_history_applied', 'INSERT', NULL), 
    ('channel_data.competitor_poll_state', 'SELECT', NULL), ('channel_data.competitor_poll_state', 'INSERT', NULL), ('channel_data.competitor_poll_state', 'UPDATE', NULL),
    ('channel_data.pricing_halt_sample', 'SELECT', NULL),
    ('channel_data.pricing_halt_sample', 'INSERT', 'tenant_id'), ('channel_data.pricing_halt_sample', 'INSERT', 'pricing_halt_id'), ('channel_data.pricing_halt_sample', 'INSERT', 'channel_product_ref'), ('channel_data.pricing_halt_sample', 'INSERT', 'observed_at'), ('channel_data.pricing_halt_sample', 'INSERT', 'verdict'), ('channel_data.pricing_halt_sample', 'INSERT', 'reason_code')
  ) AS a(t, p, c)
$function$;

-- Закрытие тенанта удаляет и системные поправки: таблица данных тенанта названа в очистке [шаг 27, задача F]
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
    'tenant_data.outbox_event', 'tenant_data.price_history_not_applied', 'tenant_data.price_history_applied', 'tenant_data.price_history', 'tenant_data.price_daily_correction', 'tenant_data.price_daily_system_correction',
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
