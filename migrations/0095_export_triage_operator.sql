-- 0095_export_triage_operator.sql
-- Шаг 26, E [OQ-182]: разбор пропущенных выгрузкой снимков — от учётной записи оператора платформы, а не именем текстом, и
-- «выгружен после исправления» — только после сверки с ClickHouse.
--  1. platform.platform_operator — учётная запись оператора платформы: поставщик входа и субъект [Р-78], как у участников тенанта
--     (platform.external_identity). Заводит владелец (миграция или ручная операция суперпользователя): административного интерфейса
--     операторов платформы нет (OQ-182 сужен).
--  2. Разбор пропуска ссылается на действующую учётную запись и требует второго фактора — оба поля проверяет база.
--  3. maintenance.snapshot_export_skip_verification — подтверждение выгрузки: снимок найден в ClickHouse (пишет роль выгрузки, у которой
--     есть доступ к ClickHouse). Разбор EXPORTED_AFTER_FIX без подтверждения секцию проверенной не делает: слово оператора не заменяет
--     проверку (ревью шага 25, находка 9).

BEGIN;

SET ROLE repracer_owner;

CREATE TABLE platform.platform_operator (
  tenant_id     uuid NOT NULL DEFAULT security.platform_tenant_id()
                  CONSTRAINT platform_operator_platform_tenant CHECK (tenant_id = security.platform_tenant_id()),
  operator_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  issuer        text NOT NULL CONSTRAINT platform_operator_issuer_url CHECK (issuer ~ '^https://[a-z0-9.-]+(/[A-Za-z0-9._~/-]*)?$'),
  subject       text NOT NULL CONSTRAINT platform_operator_subject_present CHECK (length(btrim(subject)) >= 3),
  display_name  text NOT NULL CONSTRAINT platform_operator_name_present CHECK (length(btrim(display_name)) >= 3),
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (issuer, subject)
);
COMMENT ON TABLE platform.platform_operator IS 'Шаг 26 [OQ-182]: учётная запись оператора платформы — разбор пропусков выгрузки от проверенной личности';
SELECT security.register_table('platform.platform_operator', 'SYSTEM', 'mutable', 'none');
REVOKE ALL ON platform.platform_operator FROM repracer_app;
REVOKE INSERT, UPDATE, DELETE ON platform.platform_operator FROM repracer_admin;
CREATE POLICY platform_operator_owner ON platform.platform_operator TO repracer_owner USING (true) WITH CHECK (true);
CREATE POLICY platform_operator_triage ON platform.platform_operator FOR SELECT TO repracer_export_triage USING (true);
-- Страж разбора читает учётные записи в схеме platform от имени роли разбора: нужна и видимость схемы
GRANT USAGE ON SCHEMA platform TO repracer_export_triage;
GRANT SELECT ON platform.platform_operator TO repracer_export_triage;

CREATE TABLE maintenance.snapshot_export_skip_verification (
  tenant_id               uuid NOT NULL DEFAULT security.platform_tenant_id()
                            CONSTRAINT snapshot_export_skip_verification_platform_tenant CHECK (tenant_id = security.platform_tenant_id()),
  -- Закрытие тенанта удаляет пропуски его снимков (0092) — подтверждения уходят вместе с ними
  competitor_snapshot_id  uuid NOT NULL PRIMARY KEY REFERENCES maintenance.snapshot_export_skip (competitor_snapshot_id) ON DELETE CASCADE,
  rows_in_clickhouse      integer NOT NULL CONSTRAINT snapshot_export_skip_verification_rows CHECK (rows_in_clickhouse > 0),
  verified_at             timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE maintenance.snapshot_export_skip_verification IS 'Шаг 26 [OQ-182]: снимок, пропущенный выгрузкой, найден в ClickHouse — подтверждение разбора EXPORTED_AFTER_FIX';
-- Удаление по сроку
CREATE INDEX snapshot_export_skip_verification_expiry_idx ON maintenance.snapshot_export_skip_verification (verified_at);
SELECT security.register_table('maintenance.snapshot_export_skip_verification', 'SYSTEM', 'append_only', 'none');
REVOKE ALL ON maintenance.snapshot_export_skip_verification FROM repracer_app;
REVOKE INSERT, UPDATE, DELETE ON maintenance.snapshot_export_skip_verification FROM repracer_admin;
CREATE POLICY snapshot_export_skip_verification_owner ON maintenance.snapshot_export_skip_verification TO repracer_owner USING (true) WITH CHECK (true);
CREATE POLICY snapshot_export_skip_verification_exporter ON maintenance.snapshot_export_skip_verification TO repracer_exporter USING (true) WITH CHECK (true);
CREATE POLICY snapshot_export_skip_verification_triage ON maintenance.snapshot_export_skip_verification FOR SELECT TO repracer_export_triage USING (true);
GRANT SELECT, INSERT ON maintenance.snapshot_export_skip_verification TO repracer_exporter;
GRANT SELECT ON maintenance.snapshot_export_skip_verification TO repracer_export_triage;
SELECT security.grant_retention('maintenance.snapshot_export_skip_verification');
INSERT INTO maintenance.retention_policy (table_name, method, anchor_column, retention, safety_margin, drop_order)
VALUES ('maintenance.snapshot_export_skip_verification', 'DELETE_ROWS', 'verified_at', '18 months', '0 days', 68);

ALTER TABLE maintenance.snapshot_export_skip_resolution
  -- Внешнего ключа на учётную запись нет: то же самое и строже проверяет страж (действующая запись), а дубль защиты некому поймать [Р-104]
  ADD COLUMN operator_id uuid,
  ADD COLUMN mfa boolean NOT NULL DEFAULT false;

RESET ROLE;

/**
 * OQ-182: разбор пишет действующая учётная запись оператора со вторым фактором. Это согласование процесса разбора, а не защита от роли
 * разбора: заявить чужой operator_id роль может (как административный сервис, Р-97).
 */
CREATE FUNCTION maintenance.snapshot_export_skip_resolution_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  IF NEW.operator_id IS NULL OR NOT EXISTS (SELECT 1 FROM platform.platform_operator o WHERE o.operator_id = NEW.operator_id AND o.active) THEN
    RAISE EXCEPTION 'snapshot export skip resolution needs an active platform operator account (OQ-182)' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT NEW.mfa THEN
    RAISE EXCEPTION 'snapshot export skip resolution needs the second factor of the operator (OQ-182)' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER a_snapshot_export_skip_resolution_guard BEFORE INSERT ON maintenance.snapshot_export_skip_resolution
  FOR EACH ROW EXECUTE FUNCTION maintenance.snapshot_export_skip_resolution_guard();

/** OQ-182: «выгружен после исправления» засчитывается только со сверкой ClickHouse; «потеря принята» — слово оператора */
CREATE OR REPLACE FUNCTION maintenance.partition_export_skip_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  open_skips bigint;
BEGIN
  IF NEW.verified_at IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT count(*) INTO open_skips FROM maintenance.snapshot_export_skip s
   WHERE s.partition_name = NEW.partition_name
     AND NOT EXISTS (
       SELECT 1 FROM maintenance.snapshot_export_skip_resolution r
        WHERE r.competitor_snapshot_id = s.competitor_snapshot_id
          AND (r.resolution = 'LOSS_ACCEPTED'
               OR EXISTS (SELECT 1 FROM maintenance.snapshot_export_skip_verification v WHERE v.competitor_snapshot_id = s.competitor_snapshot_id)));
  IF open_skips > 0 THEN
    RAISE EXCEPTION 'partition % has % snapshots skipped by the export without a resolution (OQ-181)', NEW.partition_name, open_skips
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $fn$;
ALTER FUNCTION maintenance.partition_export_skip_guard() OWNER TO repracer_owner;
REVOKE ALL ON FUNCTION maintenance.partition_export_skip_guard() FROM PUBLIC;

COMMIT;
