-- 0088_notification_loss_reconciliation.sql
-- Шаг 24, D [Р-121]: ярусный опрос — обязательный дублирующий контур уведомлений, а не только экономия квоты. Пропуск уведомления канал
-- не выдаёт: номеров последовательности нет ни у Kaufland buy_box_changed, ни у Amazon ANY_OFFER_CHANGED (риск 21). Единственная защита
-- от молчаливой потери — независимая сверка опросом.
--
-- Правило: опрос показал состояние товара, отличное от последнего принятого (сравнивается то, о чём канал обязан уведомить: у Kaufland —
-- Buy Box, у Amazon — наименьшая цена конкурента), — путь решения записывает проверку потери со сроком. Проверку решает база
-- (review_notification_loss): если до срока в журнал снимков (0086) пришёл снимок уведомления этого товара новее прежнего состояния —
-- уведомление задержалось (DELAYED); если нет — подозрение на потерю (LOSS_SUSPECTED), путь решения поднимает CRITICAL-алерт.
-- Путь решения проверку только записывает; вердикт ставит функция базы от роли проверки выборкой (как Р-52, 0063): независимая сверка
-- опросом — та же природа, что выборка проверки остановки.
-- Обе таблицы — данные канала (цены конкурентов): 18 месяцев.

BEGIN;

SET ROLE repracer_owner;

CREATE TABLE channel_data.notification_loss_check (
  tenant_id                   uuid NOT NULL,
  notification_loss_check_id  uuid NOT NULL DEFAULT gen_random_uuid(),
  channel_account_id          uuid NOT NULL,
  channel                     text NOT NULL,
  marketplace                 text NOT NULL,
  channel_product_ref         text NOT NULL,
  -- Состояние в форме порта (new, used, …), как в журнале снимков
  condition                   text NOT NULL,
  compared                    text NOT NULL CONSTRAINT notification_loss_check_compared_known CHECK (compared IN ('BUYBOX', 'LOWEST_COMPETITOR')),
  held_observed_at            timestamptz NOT NULL,
  held_minor                  bigint,
  poll_snapshot_id            uuid NOT NULL,
  poll_observed_at            timestamptz NOT NULL,
  poll_minor                  bigint,
  currency                    text NOT NULL,
  due_at                      timestamptz NOT NULL,
  recorded_at                 timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, notification_loss_check_id),
  FOREIGN KEY (tenant_id, channel_account_id, channel) REFERENCES tenant_data.channel_account (tenant_id, channel_account_id, channel),
  -- Проверка — только при расхождении: совпадение потерей не бывает
  CONSTRAINT notification_loss_check_diverged CHECK (held_minor IS DISTINCT FROM poll_minor),
  -- Опрос новее прежнего состояния, срок — после опроса: иначе уведомлению не было времени прийти
  CONSTRAINT notification_loss_check_order CHECK (poll_observed_at > held_observed_at AND due_at > poll_observed_at)
);
COMMENT ON TABLE channel_data.notification_loss_check IS
  'Шаг 24 [Р-121]: опрос разошёлся с последним принятым состоянием товара — проверка, дошло ли уведомление до срока';

-- Проверка потерь аккаунта по сроку (review_notification_loss)
CREATE INDEX notification_loss_check_due_idx ON channel_data.notification_loss_check (tenant_id, channel_account_id, due_at);
-- Удаление по сроку
CREATE INDEX notification_loss_check_expiry_idx ON channel_data.notification_loss_check (recorded_at);

SELECT security.register_table('channel_data.notification_loss_check', 'CHANNEL', 'append_only');
SELECT security.grant_retention('channel_data.notification_loss_check');
GRANT SELECT, INSERT ON channel_data.notification_loss_check TO repracer_app;

CREATE TABLE channel_data.notification_loss_verdict (
  tenant_id                   uuid NOT NULL,
  notification_loss_check_id  uuid NOT NULL,
  verdict                     text NOT NULL CONSTRAINT notification_loss_verdict_known CHECK (verdict IN ('DELAYED', 'LOSS_SUSPECTED')),
  push_snapshot_id            uuid,
  push_received_at            timestamptz,
  decided_at                  timestamptz NOT NULL,
  recorded_at                 timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, notification_loss_check_id),
  FOREIGN KEY (tenant_id, notification_loss_check_id) REFERENCES channel_data.notification_loss_check (tenant_id, notification_loss_check_id),
  -- «Задержалось» — только со снимком уведомления, «потеря» — только без него
  CONSTRAINT notification_loss_verdict_evidence CHECK ((verdict = 'DELAYED') = (push_snapshot_id IS NOT NULL) AND (push_snapshot_id IS NULL) = (push_received_at IS NULL))
);
COMMENT ON TABLE channel_data.notification_loss_verdict IS
  'Шаг 24 [Р-121]: вердикт проверки потери уведомления — ставит только функция базы review_notification_loss';

-- Удаление по сроку
CREATE INDEX notification_loss_verdict_expiry_idx ON channel_data.notification_loss_verdict (recorded_at);

SELECT security.register_table('channel_data.notification_loss_verdict', 'CHANNEL', 'append_only');
SELECT security.grant_retention('channel_data.notification_loss_verdict');
-- Путь решения вердикт читает (алерт, отчёт), но не ставит: вставка — только функцией проверки
GRANT SELECT ON channel_data.notification_loss_verdict TO repracer_app;
-- Административный сервис вердикт тоже не ставит: он решение базы, а не действие человека (Р-97)
REVOKE INSERT ON channel_data.notification_loss_verdict FROM repracer_admin;

INSERT INTO maintenance.retention_policy (table_name, method, anchor_column, retention, safety_margin, drop_order)
VALUES ('channel_data.notification_loss_verdict', 'DELETE_ROWS', 'recorded_at', '18 months', '0 days', 67),
       ('channel_data.notification_loss_check', 'DELETE_ROWS', 'recorded_at', '18 months', '0 days', 68);

RESET ROLE;

-- Р-121: сверка Amazon по кругу — getCompetitiveSummary, только сверка (AMZ_C11). Сгенерировано из ChannelDescriptor.competitorSources;
-- совпадение проверяет channel-reference.pg.test.ts
SET ROLE repracer_owner;
INSERT INTO platform.competitor_source (channel, source, kind, completeness_kind, completeness_n, conditions, has_buybox_winner, has_own_rank,
                                        has_shipping, typical_staleness_seconds, availability, role) VALUES
  ('AMAZON', 'AMAZON_COMPETITIVE_SUMMARY', 'PULL', 'TOP_N', 20, ARRAY['new']::text[], false, false, true, NULL, 'AVAILABLE', 'RECONCILIATION');
RESET ROLE;

-- Роль проверки выборкой читает проверки и журнал снимков тенанта и ставит вердикт
GRANT SELECT ON channel_data.notification_loss_check, channel_data.competitor_snapshot_log TO repracer_halt_reviewer;
GRANT SELECT, INSERT ON channel_data.notification_loss_verdict TO repracer_halt_reviewer;
CREATE POLICY halt_reviewer_tenant ON channel_data.notification_loss_check FOR SELECT TO repracer_halt_reviewer USING (tenant_id = security.current_tenant_id());
CREATE POLICY halt_reviewer_tenant ON channel_data.competitor_snapshot_log FOR SELECT TO repracer_halt_reviewer USING (tenant_id = security.current_tenant_id());
CREATE POLICY halt_reviewer_tenant ON channel_data.notification_loss_verdict TO repracer_halt_reviewer
  USING (tenant_id = security.current_tenant_id()) WITH CHECK (tenant_id = security.current_tenant_id());

/**
 * Р-121: вердикты проверок аккаунта, срок которых наступил к моменту шага. Момент не ограничен часами базы: ранний вызов может только
 * поднять ложную тревогу, скрыть потерю он не может — «задержка» ставится лишь по снимку уведомления в журнале. Снимок уведомления засчитывается, если он того же товара, пришёл уведомлением (PUSH или PUSH_FETCH),
 * новее прежнего состояния и получен не позже срока. Возвращает вердикты этого вызова.
 * Журнал снимков хранится 3 суток после выгрузки (0086): проверка, решаемая позже, не увидит пришедшего уведомления — риск в
 * accepted-risks, путь решения проверяет потери каждый цикл опроса.
 */
CREATE FUNCTION channel_data.review_notification_loss(p_tenant_id uuid, p_channel_account_id uuid, p_at timestamptz)
 RETURNS TABLE (notification_loss_check_id uuid, verdict text, marketplace text, channel_product_ref text, condition text, poll_observed_at timestamptz)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  v_at timestamptz := p_at;
BEGIN
  -- Тенант ограничивает политика строк роли проверки (halt_reviewer_tenant): отдельная проверка тенанта была бы дублем [Р-104]
  RETURN QUERY
  WITH due AS (
    SELECT c.* FROM channel_data.notification_loss_check c
     WHERE c.tenant_id = p_tenant_id AND c.channel_account_id = p_channel_account_id AND c.due_at <= v_at
       AND NOT EXISTS (SELECT 1 FROM channel_data.notification_loss_verdict v
                        WHERE v.tenant_id = c.tenant_id AND v.notification_loss_check_id = c.notification_loss_check_id)
  ), decided AS (
    INSERT INTO channel_data.notification_loss_verdict AS v (tenant_id, notification_loss_check_id, verdict, push_snapshot_id, push_received_at, decided_at)
    SELECT d.tenant_id, d.notification_loss_check_id, CASE WHEN p.competitor_snapshot_id IS NULL THEN 'LOSS_SUSPECTED' ELSE 'DELAYED' END,
           p.competitor_snapshot_id, p.received_at, v_at
      FROM due d
      LEFT JOIN LATERAL (
        SELECT l.competitor_snapshot_id, l.received_at FROM channel_data.competitor_snapshot_log l
         WHERE l.tenant_id = d.tenant_id
           -- Отбор секций и индекса: снимок, полученный до прежнего состояния, не новее его (условие по observed_at ниже)
           AND l.received_at > d.held_observed_at AND l.received_at <= d.due_at
           AND (l.channel_account_id, l.marketplace, l.channel_product_ref, l.condition) = (d.channel_account_id, d.marketplace, d.channel_product_ref, d.condition)
           AND l.delivery IN ('PUSH', 'PUSH_FETCH') AND l.observed_at > d.held_observed_at
         ORDER BY l.received_at LIMIT 1) p ON true
    ON CONFLICT ON CONSTRAINT notification_loss_verdict_pkey DO NOTHING
    RETURNING v.notification_loss_check_id, v.verdict
  )
  SELECT x.notification_loss_check_id, x.verdict, d.marketplace, d.channel_product_ref, d.condition, d.poll_observed_at
    FROM decided x JOIN due d ON d.notification_loss_check_id = x.notification_loss_check_id
   ORDER BY d.poll_observed_at, d.channel_product_ref;
END $function$;
ALTER FUNCTION channel_data.review_notification_loss(uuid, uuid, timestamptz) OWNER TO repracer_halt_reviewer;
REVOKE ALL ON FUNCTION channel_data.review_notification_loss(uuid, uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION channel_data.review_notification_loss(uuid, uuid, timestamptz) TO repracer_app;

-- Р-96: список разрешённого пути решения; закрытие тенанта удаляет и проверки потерь (вердикты — раньше проверок)
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
    ('channel_data.pricing_halt_sample', 'SELECT', NULL),
    ('channel_data.pricing_halt_sample', 'INSERT', 'tenant_id'), ('channel_data.pricing_halt_sample', 'INSERT', 'pricing_halt_id'), ('channel_data.pricing_halt_sample', 'INSERT', 'channel_product_ref'), ('channel_data.pricing_halt_sample', 'INSERT', 'observed_at'), ('channel_data.pricing_halt_sample', 'INSERT', 'verdict'), ('channel_data.pricing_halt_sample', 'INSERT', 'reason_code')
  ) AS a(t, p, c)
$function$;

CREATE OR REPLACE FUNCTION maintenance.purge_tenant_channel_data(p_tenant_id uuid)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  t     text;
  n     bigint;
  total bigint := 0;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM tenant_data.tenant
                  WHERE tenant_id = p_tenant_id AND kind = 'CUSTOMER' AND status IN ('OFFBOARDING', 'CLOSED')) THEN
    RAISE EXCEPTION 'tenant % must be a CUSTOMER in OFFBOARDING or CLOSED', p_tenant_id;
  END IF;
  FOREACH t IN ARRAY ARRAY[
    'channel_data.price_decision', 'channel_data.price_intent', 'channel_data.observed_channel_state',
    'channel_data.observed_price_daily', 'channel_data.divergence_case', 'channel_data.competitor_state',
    'channel_data.fee_estimate', 'channel_data.reservation', 'channel_data.sync_job',
    'channel_data.listing_migration_check', 'channel_data.write_submission',
    'channel_data.pricing_halt_review', 'channel_data.pricing_halt', 'channel_data.channel_distrust', 'channel_data.offer_channel_pricing', 'channel_data.inbound_notification', 'channel_data.offer_pricing_health', 'channel_data.notification_loss_verdict', 'channel_data.notification_loss_check', 'channel_data.competitor_snapshot_log', 'channel_data.competitor_move_latest', 'channel_data.competitor_move', 'channel_data.competitor_price_daily',
    'channel_data.rejected_competitor_snapshot']
  LOOP
    EXECUTE format('DELETE FROM %s WHERE tenant_id = $1', t) USING p_tenant_id;
    GET DIAGNOSTICS n = ROW_COUNT;
    total := total + n;
  END LOOP;

  INSERT INTO maintenance.tenant_purge_status (subject_tenant_id, postgres_channel_purged_at)
  VALUES (p_tenant_id, now())
  ON CONFLICT (subject_tenant_id) DO UPDATE SET postgres_channel_purged_at = now();
  INSERT INTO maintenance.retention_run (table_name, action, rows_affected, subject_tenant_id)
  VALUES ('channel_data.*', 'TENANT_PURGED', total, p_tenant_id);
  RETURN total;
END $function$;

COMMIT;
