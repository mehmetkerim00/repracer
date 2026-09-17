-- 0090_scheduler.sql
-- Шаг 25, A [Р-126]: периодические работы запускает отдельный процесс-планировщик (services/scheduler). Без него Р-122 не выполняется:
-- журнал снимков удаляется принудительно через 14 дней без выгрузки.
-- 1. maintenance.scheduled_job — состояние работы (работа × аккаунт или глобально): срок следующего запуска, аренда. Один экземпляр на работу —
--    аренда: занять работу, аренда которой не истекла, другой владелец не может (триггер scheduled_job_lease_guard).
--    Пропущенный запуск не теряется: срок следующего запуска сдвигается только после успешного запуска; для суточных работ (EVERY_SLOT)
--    каждый пропущенный слот выполняется по очереди, для остальных (LATEST) — один запуск за все пропущенные, число схлопнутых слотов
--    записывается.
-- 2. maintenance.scheduled_job_run — журнал запусков: слот, начало, конец, итог, отставание, число обработанных объектов (метрики).
-- 3. channel_data.competitor_poll_state — время последнего опроса товара: ярусный опрос [Р-47, Р-121] планирует по нему, а не по времени
--    последнего принятого состояния (его обновляют и уведомления — тогда опрос переставал бы дублировать уведомления).
-- Состояние планировщика — служебное (SYSTEM), без данных тенанта; журнал запусков хранится 90 дней. Пишет роль планировщика
-- (repracer_retention: планировщик и так выполняет удаление по сроку).

BEGIN;

SET ROLE repracer_owner;

CREATE TABLE maintenance.scheduled_job (
  tenant_id             uuid NOT NULL DEFAULT security.platform_tenant_id(),
  -- Имя работы и, для работы аккаунта, тенант и аккаунт: ключ читается человеком в алерте
  job_key               text PRIMARY KEY CONSTRAINT scheduled_job_key_format CHECK (job_key ~ '^[a-z][a-z0-9-]{0,62}(:[0-9a-f-]{36}){0,2}$'),
  job_name              text NOT NULL,
  -- Аккаунт канала, для которого работа (опрос, сверка, обход); глобальная работа — без аккаунта
  scope_tenant_id       uuid,
  scope_account_id      uuid,
  catch_up              text NOT NULL CONSTRAINT scheduled_job_catch_up_known CHECK (catch_up IN ('EVERY_SLOT', 'LATEST')),
  interval_seconds      integer NOT NULL CONSTRAINT scheduled_job_interval_positive CHECK (interval_seconds > 0),
  next_due_at           timestamptz NOT NULL,
  runs_completed        bigint NOT NULL DEFAULT 0,
  coalesced_slots       bigint NOT NULL DEFAULT 0,
  consecutive_failures  integer NOT NULL DEFAULT 0,
  lease_owner           text,
  lease_until           timestamptz,
  last_started_at       timestamptz,
  last_finished_at      timestamptz,
  last_outcome          text CONSTRAINT scheduled_job_outcome_known CHECK (last_outcome IN ('SUCCEEDED', 'FAILED')),
  last_error            text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scheduled_job_scope_pair CHECK ((scope_tenant_id IS NULL) = (scope_account_id IS NULL)),
  CONSTRAINT scheduled_job_lease_pair CHECK ((lease_owner IS NULL) = (lease_until IS NULL))
);
COMMENT ON TABLE maintenance.scheduled_job IS 'Шаг 25 [Р-126]: состояние периодической работы планировщика — срок, аренда, счётчики';
SELECT security.register_table('maintenance.scheduled_job', 'SYSTEM', 'mutable', 'none');
REVOKE ALL ON maintenance.scheduled_job FROM repracer_app;
CREATE POLICY scheduled_job_owner ON maintenance.scheduled_job TO repracer_owner USING (true) WITH CHECK (true);
CREATE POLICY scheduled_job_scheduler ON maintenance.scheduled_job TO repracer_retention USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE ON maintenance.scheduled_job TO repracer_retention;
-- Административный сервис работами не управляет: состояние пишет только планировщик
REVOKE INSERT, UPDATE, DELETE ON maintenance.scheduled_job FROM repracer_admin;

CREATE TABLE maintenance.scheduled_job_run (
  tenant_id     uuid NOT NULL DEFAULT security.platform_tenant_id(),
  run_id        uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  job_key       text NOT NULL REFERENCES maintenance.scheduled_job (job_key),
  job_name      text NOT NULL,
  slot_at       timestamptz NOT NULL,
  owner         text NOT NULL,
  started_at    timestamptz NOT NULL,
  finished_at   timestamptz NOT NULL,
  outcome       text NOT NULL CONSTRAINT scheduled_job_run_outcome_known CHECK (outcome IN ('SUCCEEDED', 'FAILED')),
  -- Отставание запуска от слота, секунды
  lag_seconds   numeric NOT NULL,
  items         integer,
  error_code    text,
  CONSTRAINT scheduled_job_run_order CHECK (finished_at >= started_at AND started_at >= slot_at - interval '1 minute')
);
COMMENT ON TABLE maintenance.scheduled_job_run IS 'Шаг 25 [Р-126]: журнал запусков планировщика — метрики выполнения и отставания';
-- Метрики и отставание работы за период
CREATE INDEX scheduled_job_run_job_idx ON maintenance.scheduled_job_run (job_key, started_at);
-- Удаление по сроку
CREATE INDEX scheduled_job_run_expiry_idx ON maintenance.scheduled_job_run (started_at);
SELECT security.register_table('maintenance.scheduled_job_run', 'SYSTEM', 'append_only', 'none');
REVOKE ALL ON maintenance.scheduled_job_run FROM repracer_app;
CREATE POLICY scheduled_job_run_owner ON maintenance.scheduled_job_run TO repracer_owner USING (true) WITH CHECK (true);
CREATE POLICY scheduled_job_run_scheduler ON maintenance.scheduled_job_run TO repracer_retention USING (true) WITH CHECK (true);
GRANT SELECT, INSERT ON maintenance.scheduled_job_run TO repracer_retention;
REVOKE INSERT, UPDATE, DELETE ON maintenance.scheduled_job_run FROM repracer_admin;
SELECT security.grant_retention('maintenance.scheduled_job_run');
INSERT INTO maintenance.retention_policy (table_name, method, anchor_column, retention, safety_margin, drop_order)
VALUES ('maintenance.scheduled_job_run', 'DELETE_ROWS', 'started_at', '90 days', '0 days', 90);

CREATE TABLE channel_data.competitor_poll_state (
  tenant_id            uuid NOT NULL,
  channel_account_id   uuid NOT NULL,
  channel              text NOT NULL,
  marketplace          text NOT NULL,
  channel_product_ref  text NOT NULL,
  -- Состояние в форме порта (new, used, …), как в запросе опроса
  condition            text NOT NULL,
  last_polled_at       timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, channel_account_id, marketplace, channel_product_ref, condition),
  FOREIGN KEY (tenant_id, channel_account_id, channel) REFERENCES tenant_data.channel_account (tenant_id, channel_account_id, channel)
);
COMMENT ON TABLE channel_data.competitor_poll_state IS 'Шаг 25 [Р-121, Р-126]: время последнего опроса товара для ярусного опроса планировщика';
-- Удаление по сроку
CREATE INDEX competitor_poll_state_expiry_idx ON channel_data.competitor_poll_state (last_polled_at);
SELECT security.register_table('channel_data.competitor_poll_state', 'CHANNEL', 'mutable');
SELECT security.grant_retention('channel_data.competitor_poll_state');
GRANT SELECT, INSERT, UPDATE ON channel_data.competitor_poll_state TO repracer_app;
INSERT INTO maintenance.retention_policy (table_name, method, anchor_column, retention, safety_margin, drop_order)
VALUES ('channel_data.competitor_poll_state', 'DELETE_ROWS', 'last_polled_at', '18 months', '0 days', 69);

RESET ROLE;

/** Р-126: одна аренда работы — занять работу, аренда которой не истекла, другой владелец не может */
CREATE FUNCTION maintenance.scheduled_job_lease_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  IF OLD.lease_owner IS NOT NULL AND OLD.lease_until > now() AND NEW.lease_owner IS NOT NULL AND NEW.lease_owner IS DISTINCT FROM OLD.lease_owner THEN
    RAISE EXCEPTION 'scheduled job % is leased by % until % (Р-126)', OLD.job_key, OLD.lease_owner, OLD.lease_until USING ERRCODE = 'lock_not_available';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $fn$;
CREATE TRIGGER a_scheduled_job_lease_guard BEFORE UPDATE ON maintenance.scheduled_job
  FOR EACH ROW EXECUTE FUNCTION maintenance.scheduled_job_lease_guard();

-- Р-96: список разрешённого пути решения; закрытие тенанта удаляет и время опроса
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
    ('channel_data.competitor_poll_state', 'SELECT', NULL), ('channel_data.competitor_poll_state', 'INSERT', NULL), ('channel_data.competitor_poll_state', 'UPDATE', NULL),
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
    'channel_data.pricing_halt_review', 'channel_data.pricing_halt', 'channel_data.channel_distrust', 'channel_data.offer_channel_pricing', 'channel_data.inbound_notification', 'channel_data.offer_pricing_health', 'channel_data.notification_loss_verdict', 'channel_data.notification_loss_check', 'channel_data.competitor_poll_state', 'channel_data.competitor_snapshot_log', 'channel_data.competitor_move_latest', 'channel_data.competitor_move', 'channel_data.competitor_price_daily',
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
