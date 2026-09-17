-- 0086_competitor_snapshot_log.sql
-- Шаг 24, A [Р-122, OQ-156]: снимки конкурентов пишутся в ClickHouse с первого дня работы с живым каналом — история задним числом не
-- добирается. Путь решения записывает полный снимок (любой вердикт проверки входов) в транзитный журнал PostgreSQL в той же транзакции,
-- что проекцию снимка [Р-59: число транзакций не растёт]; экспорт суток переносит его в repracer_analytics.competitor_snapshot с
-- проверкой числа строк (packages/analytics-export, exportCompetitorSnapshotsDay). Секция удаляется по сроку только после подтверждённой
-- выгрузки (requires_export CLICKHOUSE), принудительно — через 14 дней (как price_intent, 0017). Данные канала [Р-3]: в ClickHouse —
-- 18 месяцев (TTL таблицы), в PostgreSQL — транзит.
-- Путь решения журнал только пишет: чтения у него нет (решение о цене не читает историю снимков, Р-22).

BEGIN;

SET ROLE repracer_owner;

CREATE TABLE channel_data.competitor_snapshot_log (
  tenant_id               uuid NOT NULL,
  competitor_snapshot_id  uuid NOT NULL,
  received_at             timestamptz NOT NULL,
  observed_at             timestamptz NOT NULL,
  channel_account_id      uuid NOT NULL,
  channel                 text NOT NULL,
  marketplace             text NOT NULL,
  channel_product_ref     text NOT NULL,
  -- Состояние в форме порта (new, used, …), как в снимке
  condition               text NOT NULL,
  source                  text NOT NULL,
  source_event_id         text,
  -- Вердикт проверки входов: история для бэктеста — все наблюдённые снимки, испорченные тоже [Р-38, Р-42]
  -- RECONCILIATION — снимок источника только для сверки (роль RECONCILIATION, Р-36, Р-121): проверку входов и решение не проходит
  sanity_verdict          text NOT NULL CONSTRAINT competitor_snapshot_log_verdict_known CHECK (sanity_verdict IN ('ACCEPT', 'REJECT', 'HALT_CHANNEL', 'RECONCILIATION')),
  -- Р-121: как снимок пришёл — уведомление с данными (PUSH), чтение по уведомлению без данных (PUSH_FETCH), опрос по ярусу или сверка (POLL),
  -- выборка проверки остановки (SAMPLE). Сверка опросом ищет здесь доставленное уведомление (0088)
  delivery                text NOT NULL CONSTRAINT competitor_snapshot_log_delivery_known CHECK (delivery IN ('PUSH', 'PUSH_FETCH', 'POLL', 'SAMPLE')),
  -- Снимок порта целиком (CompetitorSnapshot): предложения, Buy Box, полнота, цена-подсказка канала
  snapshot                jsonb NOT NULL CONSTRAINT competitor_snapshot_log_snapshot_object CHECK (jsonb_typeof(snapshot) = 'object'),
  PRIMARY KEY (tenant_id, received_at, competitor_snapshot_id),
  FOREIGN KEY (tenant_id, channel_account_id, channel) REFERENCES tenant_data.channel_account (tenant_id, channel_account_id, channel)
) PARTITION BY RANGE (received_at);
COMMENT ON TABLE channel_data.competitor_snapshot_log IS
  'Шаг 24 [Р-122]: транзитный журнал полных снимков конкурентов для выгрузки в ClickHouse; суточные секции, удаление после подтверждённой выгрузки';

SELECT security.register_table('channel_data.competitor_snapshot_log', 'CHANNEL', 'append_only');
SELECT security.grant_retention('channel_data.competitor_snapshot_log');
SELECT security.grant_export('channel_data.competitor_snapshot_log');
GRANT INSERT ON channel_data.competitor_snapshot_log TO repracer_app;

INSERT INTO maintenance.retention_policy
  (table_name, method, anchor_column, retention, safety_margin, bound, partition_interval, requires_export, force_drop_after, days_ahead, drop_order)
VALUES
  ('channel_data.competitor_snapshot_log', 'DROP_PARTITION', 'received_at', '3 days', '0 days', 'MIN_AGE', 'day', ARRAY['CLICKHOUSE'], '14 days', 3, 25);

RESET ROLE;

SELECT maintenance.ensure_partitions(now());

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
    'channel_data.pricing_halt_review', 'channel_data.pricing_halt', 'channel_data.channel_distrust', 'channel_data.offer_channel_pricing', 'channel_data.inbound_notification', 'channel_data.offer_pricing_health', 'channel_data.competitor_snapshot_log', 'channel_data.competitor_move_latest', 'channel_data.competitor_move', 'channel_data.competitor_price_daily',
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
