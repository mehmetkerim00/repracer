-- 0021_legal_hold_and_purge.sql
-- Р-26: согласия на миграцию eBay при закрытии тенанта не удаляются — 3 года в схеме legal с минимумом PII
-- (идентификатор пользователя без email и имени). Процедуры закрытия тенанта — под три слоя (Р-20):
-- PostgreSQL очищается здесь, ClickHouse и архив — внешними заданиями, факт фиксируется в tenant_purge_status.

BEGIN;
SET ROLE repracer_owner;

CREATE TABLE legal.migration_consent_record (
  tenant_id                   uuid NOT NULL REFERENCES tenant_data.tenant (tenant_id),
  migration_consent_id        uuid NOT NULL,
  channel_account_id          uuid NOT NULL,
  channel_external_account_id text NOT NULL,
  consenting_user_id          uuid NOT NULL,
  consenting_role             text NOT NULL,
  mfa_verified_at             timestamptz NOT NULL,
  disclosure_version          text NOT NULL,
  disclosure_text_sha256      bytea NOT NULL,
  other_tools_declaration     text NOT NULL,
  other_tools_list            text,
  typed_confirmation          text NOT NULL,
  given_at                    timestamptz NOT NULL,
  expires_at                  timestamptz NOT NULL,
  revoked_at                  timestamptz,
  items                       jsonb NOT NULL CHECK (jsonb_typeof(items) = 'array'),
  tenant_closed_at            timestamptz NOT NULL,
  recorded_at                 timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, migration_consent_id)
);

SELECT security.register_table('legal.migration_consent_record', 'LEGAL', 'append_only', 'none');
REVOKE ALL ON legal.migration_consent_record FROM repracer_app;
CREATE POLICY legal_retention ON legal.migration_consent_record TO repracer_retention USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, DELETE ON legal.migration_consent_record TO repracer_retention;

INSERT INTO maintenance.retention_policy (table_name, method, anchor_column, retention, safety_margin, drop_order)
VALUES ('legal.migration_consent_record', 'DELETE_ROWS', 'tenant_closed_at', '3 years', '0 days', 99);

RESET ROLE;
GRANT CREATE ON SCHEMA maintenance TO repracer_retention;
SET ROLE repracer_retention;

-- Этап 1: данные каналов в PostgreSQL
CREATE OR REPLACE FUNCTION maintenance.purge_tenant_channel_data(p_tenant_id uuid) RETURNS bigint
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
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
    'channel_data.listing_migration_check', 'channel_data.write_submission']
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
END $$;

-- Этап 2: данные тенанта в PostgreSQL. Согласия eBay копируются в legal до удаления [Р-26].
-- Доказательство цен (price_history, вечная price_daily) удаляется только с явным подтверждением (OQ-22).
CREATE OR REPLACE FUNCTION maintenance.purge_tenant_data(p_tenant_id uuid, p_delete_price_history boolean DEFAULT false) RETURNS bigint
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
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
          OR EXISTS (SELECT 1 FROM tenant_data.price_history WHERE tenant_id = p_tenant_id)) THEN
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
    'tenant_data.outbox_event', 'tenant_data.price_history', 'tenant_data.price_daily',
    'tenant_data.channel_write_history', 'tenant_data.channel_write', 'tenant_data.edit_budget',
    'tenant_data.migration_consent_revocation', 'tenant_data.migration_consent_item', 'tenant_data.migration_consent',
    'tenant_data.stock_movement', 'tenant_data.stock_allocation', 'tenant_data.stock_pool',
    'tenant_data.inbound_api_key', 'tenant_data.stock_source',
    'tenant_data.min_price', 'tenant_data.guardrail', 'tenant_data.divergence_policy', 'tenant_data.cost_profile',
    'tenant_data.offer_mapping', 'tenant_data.write_scope_sync_state', 'tenant_data.write_scope',
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
END $$;

RESET ROLE;
REVOKE CREATE ON SCHEMA maintenance FROM repracer_retention;

COMMIT;
