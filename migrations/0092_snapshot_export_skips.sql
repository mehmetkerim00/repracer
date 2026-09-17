-- 0092_snapshot_export_skips.sql
-- Шаг 25, D [OQ-181]: снимок, который выгрузка в ClickHouse пропустила (валюта вне EUR/USD, неизвестный источник, неверная полнота), —
-- не молчаливая потеря. Выгрузка записывает каждый пропуск; человек разбирает его с заметкой: потеря принята или снимок выгружен после
-- исправления. Секция журнала снимков с неразобранными пропусками не отмечается проверенной — база отклоняет verified_at, — и потому не
-- удаляется по сроку, пока пропуск не разобран (принудительно — через 14 суток, с CRITICAL-отставанием выгрузки раньше).
-- Снимок без цен (конкурентов нет) больше не пропускается: валюта и база цены — из справочника витрины (выгрузка читает platform.marketplace).
-- Человек — оператор платформы: учётной записи оператора в модели нет, имя и заметка — обязательные поля (OQ-182). Разбор пишет отдельная
-- роль repracer_export_triage, а не роль выгрузки, которая пишет пропуски (ревью шага 25, находка 9).

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'repracer_export_triage') THEN
    CREATE ROLE repracer_export_triage NOLOGIN NOBYPASSRLS;
  END IF;
END $$;
GRANT USAGE ON SCHEMA maintenance TO repracer_export_triage;

SET ROLE repracer_owner;

CREATE TABLE maintenance.snapshot_export_skip (
  tenant_id               uuid NOT NULL DEFAULT security.platform_tenant_id(),
  -- Снимок тенанта: только идентификаторы и причина, без содержимого снимка
  subject_tenant_id       uuid NOT NULL,
  competitor_snapshot_id  uuid NOT NULL PRIMARY KEY,
  partition_name          text NOT NULL,
  received_at             timestamptz NOT NULL,
  reason                  text NOT NULL CONSTRAINT snapshot_export_skip_reason_known
                            CHECK (reason IN ('NO_PRICES', 'CURRENCY_UNSUPPORTED', 'SOURCE_UNKNOWN', 'CHANNEL_UNSUPPORTED', 'COMPLETENESS_INVALID')),
  recorded_at             timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE maintenance.snapshot_export_skip IS 'Шаг 25 [OQ-181]: снимок, пропущенный выгрузкой в ClickHouse, — до разбора человеком';
-- Неразобранные пропуски секции: проверка выгрузки и отметка verified_at
CREATE INDEX snapshot_export_skip_partition_idx ON maintenance.snapshot_export_skip (partition_name);
-- Удаление по сроку
CREATE INDEX snapshot_export_skip_expiry_idx ON maintenance.snapshot_export_skip (recorded_at);
SELECT security.register_table('maintenance.snapshot_export_skip', 'SYSTEM', 'append_only', 'none');
REVOKE ALL ON maintenance.snapshot_export_skip FROM repracer_app;
REVOKE INSERT, UPDATE, DELETE ON maintenance.snapshot_export_skip FROM repracer_admin;
CREATE POLICY snapshot_export_skip_owner ON maintenance.snapshot_export_skip TO repracer_owner USING (true) WITH CHECK (true);
CREATE POLICY snapshot_export_skip_exporter ON maintenance.snapshot_export_skip TO repracer_exporter USING (true) WITH CHECK (true);
CREATE POLICY snapshot_export_skip_triage ON maintenance.snapshot_export_skip FOR SELECT TO repracer_export_triage USING (true);
GRANT SELECT, INSERT ON maintenance.snapshot_export_skip TO repracer_exporter;
GRANT SELECT ON maintenance.snapshot_export_skip TO repracer_export_triage;
SELECT security.grant_retention('maintenance.snapshot_export_skip');

CREATE TABLE maintenance.snapshot_export_skip_resolution (
  tenant_id               uuid NOT NULL DEFAULT security.platform_tenant_id(),
  competitor_snapshot_id  uuid NOT NULL PRIMARY KEY REFERENCES maintenance.snapshot_export_skip (competitor_snapshot_id),
  resolution              text NOT NULL CONSTRAINT snapshot_export_skip_resolution_known CHECK (resolution IN ('LOSS_ACCEPTED', 'EXPORTED_AFTER_FIX')),
  resolved_by             text NOT NULL CONSTRAINT snapshot_export_skip_resolution_operator CHECK (length(btrim(resolved_by)) >= 3),
  note                    text NOT NULL CONSTRAINT snapshot_export_skip_resolution_note CHECK (length(btrim(note)) >= 10),
  resolved_at             timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE maintenance.snapshot_export_skip_resolution IS 'Шаг 25 [OQ-181]: разбор пропущенного снимка человеком — с именем и заметкой';
-- Удаление по сроку
CREATE INDEX snapshot_export_skip_resolution_expiry_idx ON maintenance.snapshot_export_skip_resolution (resolved_at);
SELECT security.register_table('maintenance.snapshot_export_skip_resolution', 'SYSTEM', 'append_only', 'none');
REVOKE ALL ON maintenance.snapshot_export_skip_resolution FROM repracer_app;
REVOKE INSERT, UPDATE, DELETE ON maintenance.snapshot_export_skip_resolution FROM repracer_admin;
CREATE POLICY snapshot_export_skip_resolution_owner ON maintenance.snapshot_export_skip_resolution TO repracer_owner USING (true) WITH CHECK (true);
-- Выгрузка разбор только читает (отметка секции проверенной); пишет разбор роль оператора
CREATE POLICY snapshot_export_skip_resolution_exporter ON maintenance.snapshot_export_skip_resolution FOR SELECT TO repracer_exporter USING (true);
CREATE POLICY snapshot_export_skip_resolution_triage ON maintenance.snapshot_export_skip_resolution TO repracer_export_triage USING (true) WITH CHECK (true);
GRANT SELECT ON maintenance.snapshot_export_skip_resolution TO repracer_exporter;
GRANT SELECT, INSERT ON maintenance.snapshot_export_skip_resolution TO repracer_export_triage;
SELECT security.grant_retention('maintenance.snapshot_export_skip_resolution');

-- Пропуск и его разбор — служебная запись о снимке, который хранится 18 месяцев в ClickHouse: столько же
INSERT INTO maintenance.retention_policy (table_name, method, anchor_column, retention, safety_margin, drop_order)
VALUES ('maintenance.snapshot_export_skip_resolution', 'DELETE_ROWS', 'resolved_at', '18 months', '0 days', 91),
       ('maintenance.snapshot_export_skip', 'DELETE_ROWS', 'recorded_at', '18 months', '0 days', 92);

-- Снимок без цен: валюта и база цены витрины
CREATE POLICY marketplace_exporter_read ON platform.marketplace FOR SELECT TO repracer_exporter USING (tenant_id = security.platform_tenant_id());
GRANT SELECT ON platform.marketplace TO repracer_exporter;

RESET ROLE;

/** OQ-181: секция с неразобранными пропусками не отмечается проверенной */
CREATE FUNCTION maintenance.partition_export_skip_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  open_skips bigint;
BEGIN
  IF NEW.verified_at IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT count(*) INTO open_skips FROM maintenance.snapshot_export_skip s
   WHERE s.partition_name = NEW.partition_name
     AND NOT EXISTS (SELECT 1 FROM maintenance.snapshot_export_skip_resolution r WHERE r.competitor_snapshot_id = s.competitor_snapshot_id);
  IF open_skips > 0 THEN
    RAISE EXCEPTION 'partition % has % snapshots skipped by the export without a resolution (OQ-181)', NEW.partition_name, open_skips
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $fn$;
ALTER FUNCTION maintenance.partition_export_skip_guard() OWNER TO repracer_owner;
REVOKE ALL ON FUNCTION maintenance.partition_export_skip_guard() FROM PUBLIC;
CREATE TRIGGER a_partition_export_skip_guard BEFORE INSERT OR UPDATE ON maintenance.partition_export
  FOR EACH ROW EXECUTE FUNCTION maintenance.partition_export_skip_guard();

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

  -- Шаг 25 (ревью, находка 10): пропуски выгрузки и их разбор хранят идентификаторы снимков тенанта
  DELETE FROM maintenance.snapshot_export_skip_resolution r
   USING maintenance.snapshot_export_skip s WHERE s.competitor_snapshot_id = r.competitor_snapshot_id AND s.subject_tenant_id = p_tenant_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  total := total + n;
  DELETE FROM maintenance.snapshot_export_skip WHERE subject_tenant_id = p_tenant_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  total := total + n;

  INSERT INTO maintenance.tenant_purge_status (subject_tenant_id, postgres_channel_purged_at)
  VALUES (p_tenant_id, now())
  ON CONFLICT (subject_tenant_id) DO UPDATE SET postgres_channel_purged_at = now();
  INSERT INTO maintenance.retention_run (table_name, action, rows_affected, subject_tenant_id)
  VALUES ('channel_data.*', 'TENANT_PURGED', total, p_tenant_id);
  RETURN total;
END $function$;

COMMIT;
