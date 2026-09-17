-- 0083_amazon_notification_receiver.sql
-- Шаг 23, A: приёмник уведомлений SP-API из очереди Amazon SQS (packages/amazon-notifications).
-- 1. Маршрут уведомления к аккаунту тенанта. Очередь одна на приложение и регион, в ней уведомления всех продавцов: приёмник узнаёт аккаунт
--    по SellerId и региону функцией security.resolve_amazon_seller. Межтенантный поиск только по этим двум значениям; функция принадлежит
--    роли repracer_inbound_router без входа, у которой есть только чтение ключевых столбцов подключённых аккаунтов Amazon; вызывает её роль
--    приёмника repracer_inbound. Данные тенанта функция не отдаёт — только идентификаторы тенанта и аккаунта [Р-31].
-- 2. Журнал обработанных уведомлений тенанта (дедупликация по NotificationId): 30 дней — дольше предельного срока хранения сообщения в
--    очереди (14 дней, SetQueueAttributes MessageRetentionPeriod).
-- 3. Последнее состояние PRICING_HEALTH оффера — данные канала, 18 месяцев [Р-3].

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'repracer_inbound_router') THEN
    CREATE ROLE repracer_inbound_router NOLOGIN NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'repracer_inbound') THEN
    CREATE ROLE repracer_inbound NOLOGIN NOBYPASSRLS;
  END IF;
END $$;

GRANT USAGE ON SCHEMA tenant_data, security TO repracer_inbound_router;
GRANT SELECT (tenant_id, channel_account_id, channel, region, external_account_id, disconnected_at) ON tenant_data.channel_account TO repracer_inbound_router;
CREATE POLICY inbound_router_resolve ON tenant_data.channel_account FOR SELECT TO repracer_inbound_router
  USING (channel = 'AMAZON' AND disconnected_at IS NULL);

/** Аккаунты Amazon, подключившие продавца в регионе (активное подключение — одно на канал, регион и продавца, channel_account_external_uq) */
CREATE FUNCTION security.resolve_amazon_seller(p_region text, p_seller_id text) RETURNS TABLE (tenant_id uuid, channel_account_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT a.tenant_id, a.channel_account_id
    FROM tenant_data.channel_account a
   WHERE a.channel = 'AMAZON' AND a.region = p_region AND a.external_account_id = p_seller_id AND a.disconnected_at IS NULL
$fn$;
ALTER FUNCTION security.resolve_amazon_seller(text, text) OWNER TO repracer_inbound_router;
REVOKE EXECUTE ON FUNCTION security.resolve_amazon_seller(text, text) FROM PUBLIC;
GRANT USAGE ON SCHEMA security TO repracer_inbound;
GRANT EXECUTE ON FUNCTION security.resolve_amazon_seller(text, text) TO repracer_inbound;

SET ROLE repracer_owner;

CREATE TABLE channel_data.inbound_notification (
  tenant_id                uuid NOT NULL,
  inbound_notification_id  uuid NOT NULL DEFAULT gen_random_uuid(),
  channel_account_id       uuid NOT NULL,
  channel                  text NOT NULL,
  notification_id          text NOT NULL,
  notification_type        text NOT NULL,
  event_time               timestamptz,
  received_at              timestamptz NOT NULL,
  processed_at             timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, inbound_notification_id),
  -- Одна запись на уведомление тенанта: повтор доставки из очереди — ON CONFLICT DO NOTHING в журнале
  UNIQUE (tenant_id, channel, notification_id),
  FOREIGN KEY (tenant_id, channel_account_id, channel) REFERENCES tenant_data.channel_account (tenant_id, channel_account_id, channel)
);
COMMENT ON TABLE channel_data.inbound_notification IS
  'Шаг 23: журнал обработанных уведомлений канала — дедупликация по NotificationId (стандартная очередь SQS доставляет повторно); 30 дней';
SELECT security.register_table('channel_data.inbound_notification', 'CHANNEL', 'append_only');
SELECT security.grant_retention('channel_data.inbound_notification');
GRANT SELECT, INSERT ON channel_data.inbound_notification TO repracer_app;
INSERT INTO maintenance.retention_policy (table_name, method, anchor_column, retention, safety_margin, drop_order)
VALUES ('channel_data.inbound_notification', 'DELETE_ROWS', 'processed_at', interval '30 days', interval '0', 65);

CREATE TABLE channel_data.offer_pricing_health (
  tenant_id                          uuid NOT NULL,
  offer_pricing_health_id            uuid NOT NULL DEFAULT gen_random_uuid(),
  channel_account_id                 uuid NOT NULL,
  channel                            text NOT NULL,
  marketplace                        text NOT NULL,
  channel_product_ref                text NOT NULL,
  condition                          text NOT NULL,
  -- issueType уведомления PRICING_HEALTH (пример страницы: BuyBoxDisqualification); перечень значений документация не даёт
  issue_type                         text NOT NULL,
  event_time                         timestamptz NOT NULL,
  -- summary.referencePrice.competitivePriceThreshold — цена канала; валюта — вместе с суммой
  competitive_price_threshold_minor  bigint,
  currency                           text,
  notification_id                    text NOT NULL,
  recorded_at                        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, offer_pricing_health_id),
  FOREIGN KEY (tenant_id, channel_account_id, channel) REFERENCES tenant_data.channel_account (tenant_id, channel_account_id, channel)
);
COMMENT ON TABLE channel_data.offer_pricing_health IS
  'Шаг 23: уведомления PRICING_HEALTH — оффер не может быть Featured Offer из-за неконкурентной цены; данные канала, 18 месяцев [Р-3]';
SELECT security.register_table('channel_data.offer_pricing_health', 'CHANNEL', 'append_only');
SELECT security.grant_retention('channel_data.offer_pricing_health');
GRANT SELECT, INSERT ON channel_data.offer_pricing_health TO repracer_app;
INSERT INTO maintenance.retention_policy (table_name, method, anchor_column, retention, safety_margin, drop_order)
VALUES ('channel_data.offer_pricing_health', 'DELETE_ROWS', 'recorded_at', interval '18 months', interval '0', 66);
-- Последнее состояние оффера для консоли: DISTINCT ON (аккаунт, витрина, ASIN, состояние) по моменту события
CREATE INDEX offer_pricing_health_latest_idx ON channel_data.offer_pricing_health (tenant_id, channel_account_id, marketplace, channel_product_ref, condition, event_time DESC);

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
    'channel_data.pricing_halt_review', 'channel_data.pricing_halt', 'channel_data.channel_distrust', 'channel_data.offer_channel_pricing', 'channel_data.inbound_notification', 'channel_data.offer_pricing_health', 'channel_data.competitor_move_latest', 'channel_data.competitor_move', 'channel_data.competitor_price_daily',
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
