-- 0038_outbox_relay.sql
-- Р-34: ретранслятор outbox → брокер — собственный поллер с advisory lock. Р-24: события уходят в брокер с ключом партиции
-- (write_scope_id для scope.*). Ретранслятор — системный сервис всех тенантов: читает только outbox и своё состояние;
-- бизнес-таблицы ему недоступны, события он не меняет (outbox append-only). Изоляция тенанта — в потребителе (ADR-0005, п. 7).

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'repracer_relay') THEN
    CREATE ROLE repracer_relay NOLOGIN NOBYPASSRLS;
  END IF;
END $$;
GRANT USAGE ON SCHEMA tenant_data, maintenance, security TO repracer_relay;
GRANT EXECUTE ON FUNCTION security.platform_tenant_id() TO repracer_relay;

SET ROLE repracer_owner;

CREATE POLICY relay_read ON tenant_data.outbox_event FOR SELECT TO repracer_relay USING (true);
GRANT SELECT ON tenant_data.outbox_event TO repracer_relay;

-- Водяной знак ретранслятора: до какого created_at события опубликованы (с окном повторного чтения назад)
CREATE TABLE maintenance.outbox_relay_state (
  tenant_id  uuid NOT NULL DEFAULT security.platform_tenant_id() CHECK (tenant_id = security.platform_tenant_id()),
  relay_name text PRIMARY KEY CHECK (relay_name ~ '^[a-z][a-z0-9_-]{0,62}$'),
  watermark  timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

SELECT security.register_table('maintenance.outbox_relay_state', 'SYSTEM', 'mutable', 'none');
REVOKE ALL ON maintenance.outbox_relay_state FROM repracer_app;
CREATE POLICY outbox_relay_state_owner ON maintenance.outbox_relay_state TO repracer_owner USING (true) WITH CHECK (true);
CREATE POLICY outbox_relay_state_relay ON maintenance.outbox_relay_state TO repracer_relay USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE ON maintenance.outbox_relay_state TO repracer_relay;

RESET ROLE;
COMMIT;
