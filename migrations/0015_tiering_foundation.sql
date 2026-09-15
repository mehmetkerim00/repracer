-- 0015_tiering_foundation.sql
-- Основа трёхслойного хранения [Р-20]: роль экспорта, схема legal [Р-26], политики хранения с учётом экспорта,
-- журнал экспорта партиций, статус закрытия тенанта по слоям, outbox для брокера [Р-24], валюта Release 1.0 [Р-26].
-- Миграции шага 4 предполагают отсутствие production-данных: переносимые таблицы проверяются на пустоту.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'repracer_exporter') THEN
    CREATE ROLE repracer_exporter NOLOGIN NOBYPASSRLS;
  END IF;
END $$;
GRANT repracer_exporter TO CURRENT_USER;
GRANT USAGE ON SCHEMA security, tenant_data, channel_data, maintenance TO repracer_exporter;

CREATE SCHEMA legal AUTHORIZATION repracer_owner;
REVOKE ALL ON SCHEMA legal FROM PUBLIC;
GRANT USAGE ON SCHEMA legal TO repracer_retention, repracer_app;

SET ROLE repracer_owner;

-- ---------------------------------------------------------------------------
-- Классы хранения: + LEGAL (юридическое удержание после закрытия тенанта)
-- ---------------------------------------------------------------------------
ALTER TABLE security.table_registry DROP CONSTRAINT table_registry_storage_class_check;
ALTER TABLE security.table_registry ADD CONSTRAINT table_registry_storage_class_check
  CHECK (storage_class IN ('PLATFORM', 'TENANT', 'CHANNEL', 'AUDIT', 'SYSTEM', 'LEGAL'));

-- ---------------------------------------------------------------------------
-- Политики хранения v2
--   bound = MAX_AGE — строка не старше срока (данные каналов): удаление по нижней границе партиции;
--   bound = MIN_AGE — строка не младше срока (горячие данные тенанта): удаление по верхней границе партиции.
--   requires_export — партиция удаляется только после подтверждённого экспорта в перечисленные слои.
--   force_drop_after — для данных без юридической ценности: удаление без экспорта после этого возраста (с алертом).
-- ---------------------------------------------------------------------------
ALTER TABLE maintenance.retention_policy
  ADD COLUMN bound              text NOT NULL DEFAULT 'MAX_AGE' CHECK (bound IN ('MAX_AGE', 'MIN_AGE')),
  ADD COLUMN partition_interval text NOT NULL DEFAULT 'month' CHECK (partition_interval IN ('month', 'day')),
  ADD COLUMN requires_export    text[] NOT NULL DEFAULT '{}'
                                CHECK (requires_export <@ ARRAY['CLICKHOUSE', 'ARCHIVE', 'KAFKA']),
  ADD COLUMN force_drop_after   interval,
  ADD COLUMN days_ahead         int NOT NULL DEFAULT 3 CHECK (days_ahead >= 1),
  ADD CONSTRAINT retention_policy_force_needs_export CHECK (force_drop_after IS NULL OR cardinality(requires_export) > 0);

-- ---------------------------------------------------------------------------
-- partition_export — подтверждение, что партиция выгружена в слой. Без него партиция с requires_export не удаляется.
-- ---------------------------------------------------------------------------
CREATE TABLE maintenance.partition_export (
  tenant_id      uuid NOT NULL DEFAULT security.platform_tenant_id() CHECK (tenant_id = security.platform_tenant_id()),
  parent_table   text NOT NULL,
  partition_name text NOT NULL,
  target         text NOT NULL CHECK (target IN ('CLICKHOUSE', 'ARCHIVE', 'KAFKA')),
  exported_rows  bigint NOT NULL CHECK (exported_rows >= 0),
  checksum       text,
  exported_at    timestamptz NOT NULL DEFAULT now(),
  verified_at    timestamptz,
  PRIMARY KEY (partition_name, target)
);

SELECT security.register_table('maintenance.partition_export', 'SYSTEM', 'mutable', 'none');
CREATE POLICY partition_export_owner ON maintenance.partition_export TO repracer_owner USING (true) WITH CHECK (true);
CREATE POLICY partition_export_exporter ON maintenance.partition_export TO repracer_exporter USING (true) WITH CHECK (true);
CREATE POLICY partition_export_retention ON maintenance.partition_export FOR SELECT TO repracer_retention USING (true);
REVOKE ALL ON maintenance.partition_export FROM repracer_app;
GRANT SELECT, INSERT, UPDATE ON maintenance.partition_export TO repracer_exporter;
GRANT SELECT ON maintenance.partition_export TO repracer_retention;

-- Экспортёр читает транзитные таблицы всех тенантов (роль NOLOGIN, данные уходят только в слои с изоляцией, Р-23).
CREATE FUNCTION security.grant_export(p_table regclass) RETURNS void
  LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('CREATE POLICY export_read ON %s FOR SELECT TO repracer_exporter USING (true)', p_table);
  EXECUTE format('GRANT SELECT ON %s TO repracer_exporter', p_table);
END $$;

-- ---------------------------------------------------------------------------
-- tenant_purge_status — закрытие тенанта завершено, только когда очищены все слои
-- ---------------------------------------------------------------------------
CREATE TABLE maintenance.tenant_purge_status (
  tenant_id                 uuid NOT NULL DEFAULT security.platform_tenant_id() CHECK (tenant_id = security.platform_tenant_id()),
  subject_tenant_id         uuid PRIMARY KEY REFERENCES tenant_data.tenant (tenant_id),
  postgres_channel_purged_at timestamptz,
  postgres_tenant_purged_at timestamptz,
  clickhouse_purged_at      timestamptz,
  archive_prefix_deleted_at timestamptz,
  archive_key_destroyed_at  timestamptz,
  legal_hold_until          date,
  CHECK (postgres_tenant_purged_at IS NULL OR postgres_channel_purged_at IS NOT NULL)
);

SELECT security.register_table('maintenance.tenant_purge_status', 'SYSTEM', 'mutable', 'none');
CREATE POLICY tenant_purge_status_owner ON maintenance.tenant_purge_status TO repracer_owner USING (true) WITH CHECK (true);
CREATE POLICY tenant_purge_status_retention ON maintenance.tenant_purge_status TO repracer_retention USING (true) WITH CHECK (true);
CREATE POLICY tenant_purge_status_exporter ON maintenance.tenant_purge_status TO repracer_exporter USING (true) WITH CHECK (true);
REVOKE ALL ON maintenance.tenant_purge_status FROM repracer_app;
GRANT SELECT, INSERT, UPDATE ON maintenance.tenant_purge_status TO repracer_retention, repracer_exporter;

-- ---------------------------------------------------------------------------
-- outbox_event — события из PostgreSQL в брокер (ADR-0001 п.8, ADR-0005).
-- События единицы записи: ключ = write_scope_id [Р-24], scope_seq монотонен в порядке коммитов
-- (выдаётся под блокировкой строки write_scope_sync_state).
-- ---------------------------------------------------------------------------
ALTER TABLE tenant_data.write_scope_sync_state
  ADD COLUMN latest_event_seq bigint NOT NULL DEFAULT 0 CHECK (latest_event_seq >= 0);

CREATE OR REPLACE FUNCTION tenant_data.sync_state_monotonic() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.latest_version_created    < OLD.latest_version_created
  OR NEW.latest_version_dispatched < OLD.latest_version_dispatched
  OR NEW.latest_version_accepted   < OLD.latest_version_accepted
  OR NEW.latest_version_applied    < OLD.latest_version_applied
  OR NEW.latest_event_seq          < OLD.latest_event_seq THEN
    RAISE EXCEPTION 'write_scope_sync_state watermarks must not decrease (scope %)', OLD.write_scope_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

CREATE TABLE tenant_data.outbox_event (
  tenant_id       uuid NOT NULL,
  outbox_event_id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  topic           text NOT NULL CHECK (topic ~ '^[a-z][a-z0-9_-]*(\.[a-z0-9_-]+)*\.v[0-9]+$'),
  partition_key   uuid NOT NULL,
  write_scope_id  uuid,
  scope_seq       bigint,
  event_type      text NOT NULL,
  schema_version  int  NOT NULL DEFAULT 1 CHECK (schema_version >= 1),
  payload         jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  PRIMARY KEY (tenant_id, created_at, outbox_event_id),
  -- Р-24: топики единицы записи имеют префикс scope. и ключ write_scope_id
  CHECK ((topic LIKE 'scope.%') = (write_scope_id IS NOT NULL)),
  CHECK (write_scope_id IS NULL OR partition_key = write_scope_id),
  CHECK ((write_scope_id IS NULL) = (scope_seq IS NULL))
) PARTITION BY RANGE (created_at);

-- Ретранслятор читает события всех тенантов в порядке создания внутри окна задержки
CREATE INDEX outbox_event_relay_idx ON tenant_data.outbox_event (created_at, outbox_event_id);

CREATE FUNCTION tenant_data.outbox_event_scope_seq() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.write_scope_id IS NOT NULL THEN
    UPDATE tenant_data.write_scope_sync_state
       SET latest_event_seq = latest_event_seq + 1
     WHERE tenant_id = NEW.tenant_id AND write_scope_id = NEW.write_scope_id
    RETURNING latest_event_seq INTO NEW.scope_seq;
    IF NEW.scope_seq IS NULL THEN
      RAISE EXCEPTION 'unknown write_scope % for outbox event', NEW.write_scope_id
        USING ERRCODE = 'foreign_key_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER outbox_event_scope_seq BEFORE INSERT ON tenant_data.outbox_event
  FOR EACH ROW EXECUTE FUNCTION tenant_data.outbox_event_scope_seq();

SELECT security.register_table('tenant_data.outbox_event', 'TENANT', 'append_only');
SELECT security.grant_retention('tenant_data.outbox_event');
SELECT security.grant_export('tenant_data.outbox_event');

-- ---------------------------------------------------------------------------
-- Р-26: мультивалютность в схеме, но не активирована. Снимается отдельной миграцией.
-- ---------------------------------------------------------------------------
ALTER TABLE tenant_data.tenant       ADD CONSTRAINT tenant_release_1_0_currency       CHECK (default_currency = 'EUR');
ALTER TABLE tenant_data.write_scope  ADD CONSTRAINT write_scope_release_1_0_currency  CHECK (currency IS NULL OR currency = 'EUR');
ALTER TABLE tenant_data.min_price    ADD CONSTRAINT min_price_release_1_0_currency    CHECK (currency = 'EUR');
ALTER TABLE tenant_data.cost_profile ADD CONSTRAINT cost_profile_release_1_0_currency CHECK (currency = 'EUR');
ALTER TABLE tenant_data.guardrail    ADD CONSTRAINT guardrail_release_1_0_currency    CHECK (currency IS NULL OR currency = 'EUR');

RESET ROLE;
COMMIT;
