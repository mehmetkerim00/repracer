-- 0026_reservation_stale_alert_and_purge.sql
-- Р-30: подтверждённая резервация старше 14 дней не освобождается, а поднимает алерт (один раз).
-- Закрытие тенанта учитывает таблицы шага 6: price_intent_core, price_daily_correction.

BEGIN;
SET ROLE repracer_owner;

ALTER TABLE channel_data.reservation
  ADD COLUMN stale_alerted_at timestamptz,
  ADD CONSTRAINT reservation_stale_alert_after_confirmation CHECK (stale_alerted_at IS NULL OR confirmed_at IS NOT NULL);

DROP TRIGGER a_reservation_restrict_update ON channel_data.reservation;
CREATE TRIGGER a_reservation_restrict_update BEFORE UPDATE ON channel_data.reservation
  FOR EACH ROW EXECUTE FUNCTION security.restrict_update(
    'status', 'confirmed_at', 'confirmed_by_stock_source_id', 'confirmed_external_order_ref',
    'consumed_at', 'released_at', 'release_reason', 'closed_at', 'stale_alerted_at');

-- Поиск подтверждённых резерваций без алерта старше 14 дней (все тенанты)
CREATE INDEX reservation_confirmed_stale_idx ON channel_data.reservation (confirmed_at)
  WHERE status = 'CONFIRMED_BY_SOURCE' AND stale_alerted_at IS NULL;

RESET ROLE;
GRANT CREATE ON SCHEMA maintenance TO repracer_retention;
SET ROLE repracer_retention;

CREATE FUNCTION maintenance.alert_stale_confirmed_reservations(p_now timestamptz DEFAULT now(), p_batch int DEFAULT 1000)
  RETURNS int
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  n int;
BEGIN
  WITH stale AS (
    SELECT ctid
      FROM channel_data.reservation
     WHERE status = 'CONFIRMED_BY_SOURCE' AND stale_alerted_at IS NULL
       AND confirmed_at <= p_now - interval '14 days'
     LIMIT p_batch
     FOR UPDATE SKIP LOCKED
  ), marked AS (
    UPDATE channel_data.reservation r
       SET stale_alerted_at = p_now
      FROM stale
     WHERE r.ctid = stale.ctid
    RETURNING r.tenant_id, r.reservation_id, r.product_id, r.stock_pool_id, r.confirmed_at
  )
  INSERT INTO tenant_data.outbox_event (tenant_id, topic, partition_key, event_type, payload)
  SELECT tenant_id, 'alert.reservation-confirmed-stale.v1', tenant_id, 'ReservationConfirmedStale',
         jsonb_build_object('reservation_id', reservation_id, 'product_id', product_id,
                            'stock_pool_id', stock_pool_id, 'confirmed_at', confirmed_at)
    FROM marked;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

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
          OR EXISTS (SELECT 1 FROM tenant_data.price_history WHERE tenant_id = p_tenant_id)
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
    'tenant_data.outbox_event', 'tenant_data.price_history', 'tenant_data.price_daily_correction',
    'tenant_data.price_daily', 'tenant_data.price_intent_core',
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
REVOKE ALL ON FUNCTION maintenance.alert_stale_confirmed_reservations(timestamptz, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION maintenance.alert_stale_confirmed_reservations(timestamptz, int) TO repracer_retention;

COMMIT;
