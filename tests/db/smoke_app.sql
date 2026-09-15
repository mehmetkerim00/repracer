-- Run as svc_app (member of repracer_app). Synthetic data only.
\set ON_ERROR_STOP 1
\set QUIET 1

CREATE FUNCTION pg_temp.expect_fail(label text, q text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE q;
    SET CONSTRAINTS ALL IMMEDIATE;
    RAISE EXCEPTION 'EXPECTED FAILURE DID NOT HAPPEN: %', label;
  EXCEPTION WHEN others THEN
    IF SQLERRM LIKE 'EXPECTED FAILURE DID NOT HAPPEN%' THEN RAISE; END IF;
    RAISE NOTICE 'PASS reject | % | %', label, left(SQLERRM, 110);
  END;
END $$;

CREATE FUNCTION pg_temp.ok(label text, q text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE q;
  SET CONSTRAINTS ALL IMMEDIATE;
  RAISE NOTICE 'PASS accept | %', label;
END $$;

-- ids
\set tA '''a0000000-0000-0000-0000-00000000000a'''
\set tB '''b0000000-0000-0000-0000-00000000000b'''
\set uA '''a1000000-0000-0000-0000-00000000000a'''
\set uB '''b1000000-0000-0000-0000-00000000000b'''
\set mA '''a2000000-0000-0000-0000-00000000000a'''
\set mB '''b2000000-0000-0000-0000-00000000000b'''

-- ---------------------------------------------------------------- tenants
BEGIN;
SELECT set_config('app.tenant_id', :tA, true), set_config('app.user_id', :uA, true) \gset
INSERT INTO platform.app_user (user_id, email, mfa_enabled) VALUES (:uA, 'owner-a@example.test', true);
INSERT INTO tenant_data.tenant (tenant_id, name, data_region) VALUES (:tA, 'Tenant A', 'EU');
INSERT INTO tenant_data.membership (tenant_id, membership_id, user_id, role, status) VALUES (:tA, :mA, :uA, 'OWNER', 'ACTIVE');
COMMIT;

BEGIN;
SELECT set_config('app.tenant_id', :tB, true), set_config('app.user_id', :uB, true) \gset
INSERT INTO platform.app_user (user_id, email, mfa_enabled) VALUES (:uB, 'owner-b@example.test', true);
INSERT INTO tenant_data.tenant (tenant_id, name, data_region) VALUES (:tB, 'Tenant B', 'EU');
INSERT INTO tenant_data.membership (tenant_id, membership_id, user_id, role, status) VALUES (:tB, :mB, :uB, 'OWNER', 'ACTIVE');
INSERT INTO tenant_data.product (tenant_id, product_id, sku, kind) VALUES (:tB, 'b3000000-0000-0000-0000-000000000001', 'B-SKU', 'SIMPLE');
COMMIT;

BEGIN;
SELECT set_config('app.tenant_id', :tA, true) \gset
SELECT pg_temp.expect_fail('tenant without OWNER', $q$
  SELECT set_config('app.tenant_id', 'c0000000-0000-0000-0000-0000000000cc', true);
  INSERT INTO tenant_data.tenant (tenant_id, name, data_region) VALUES ('c0000000-0000-0000-0000-0000000000cc', 'x', 'EU') $q$);
SELECT pg_temp.expect_fail('tenant in wrong region DB', $q$
  INSERT INTO tenant_data.tenant (name, data_region) VALUES ('x', 'US') $q$);
COMMIT;

-- ---------------------------------------------------------------- isolation
BEGIN;
SELECT set_config('app.tenant_id', :tA, true) \gset
DO $$ BEGIN
  IF (SELECT count(*) FROM tenant_data.product) <> 0 THEN RAISE EXCEPTION 'tenant A sees foreign products'; END IF;
  RAISE NOTICE 'PASS isolation | tenant A sees 0 products of tenant B';
END $$;
SELECT pg_temp.expect_fail('insert row for another tenant', $q$
  INSERT INTO tenant_data.product (tenant_id, sku, kind) VALUES ('b0000000-0000-0000-0000-00000000000b', 'X', 'SIMPLE') $q$);
SELECT pg_temp.expect_fail('direct partition access', $q$
  DO $x$ DECLARE p text; BEGIN
    SELECT inhrelid::regclass::text INTO p FROM pg_inherits WHERE inhparent = 'channel_data.price_intent'::regclass LIMIT 1;
    EXECUTE 'SELECT 1 FROM ' || p;
  END $x$ $q$);
COMMIT;

BEGIN;
DO $$ BEGIN
  IF (SELECT count(*) FROM tenant_data.tenant) <> 0 THEN RAISE EXCEPTION 'rows visible without tenant context'; END IF;
  RAISE NOTICE 'PASS isolation | no context -> 0 rows';
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM security.list_user_tenants('a1000000-0000-0000-0000-00000000000a')) THEN
    RAISE EXCEPTION 'resolver failed'; END IF;
  RAISE NOTICE 'PASS resolver | list_user_tenants works without context';
END $$;
COMMIT;

-- ---------------------------------------------------------------- Kaufland: scopes, min_price, Smart Pricing
BEGIN;
SELECT set_config('app.tenant_id', :tA, true), set_config('app.user_id', :uA, true) \gset
INSERT INTO tenant_data.channel_account (tenant_id, channel_account_id, channel, external_account_id, marketplaces, credentials_ref, connected_by_membership_id)
VALUES (:tA, 'a4000000-0000-0000-0000-000000000001', 'KAUFLAND', 'seller-A', ARRAY['de','cz'], 'vault://a/kaufland', :mA);
INSERT INTO tenant_data.product (tenant_id, product_id, sku, kind) VALUES (:tA, 'a5000000-0000-0000-0000-000000000001', 'A-1', 'SIMPLE');
INSERT INTO tenant_data.write_scope (tenant_id, write_scope_id, channel_account_id, channel, field, product_id, capability_id, capability_version,
  scope_kind, scope_key, currency, price_basis, tax_regime, pricing_mode)
VALUES (:tA, 'a6000000-0000-0000-0000-000000000001', 'a4000000-0000-0000-0000-000000000001', 'KAUFLAND', 'PRICE',
  'a5000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001', 1, 'ACCOUNT_STOREFRONT_UNIT',
  tenant_data.derive_scope_key('{"marketplace":"de","external_unit_id":"U1"}', ARRAY['channel_account','marketplace','external_unit_id']),
  'EUR', 'GROSS', 'VAT_INCLUDED', 'OFF');
COMMIT;

BEGIN;
SELECT set_config('app.tenant_id', :tA, true), set_config('app.user_id', :uA, true) \gset
SELECT pg_temp.expect_fail('offer identity does not match scope key', $q$
  INSERT INTO tenant_data.offer_mapping (tenant_id, product_id, channel_account_id, channel, marketplace, channel_offer_key, external_unit_id, status, price_write_scope_id)
  VALUES ('a0000000-0000-0000-0000-00000000000a', 'a5000000-0000-0000-0000-000000000001', 'a4000000-0000-0000-0000-000000000001', 'KAUFLAND', 'cz', 'U1@cz', 'U1', 'ACTIVE', 'a6000000-0000-0000-0000-000000000001') $q$);
SELECT pg_temp.ok('offer attached to derived scope', $q$
  INSERT INTO tenant_data.offer_mapping (tenant_id, product_id, channel_account_id, channel, marketplace, channel_offer_key, external_unit_id, status, price_write_scope_id)
  VALUES ('a0000000-0000-0000-0000-00000000000a', 'a5000000-0000-0000-0000-000000000001', 'a4000000-0000-0000-0000-000000000001', 'KAUFLAND', 'de', 'U1@de', 'U1', 'ACTIVE', 'a6000000-0000-0000-0000-000000000001') $q$);
SELECT pg_temp.expect_fail('ENGINE without min_price (Р-5)', $q$
  UPDATE tenant_data.write_scope SET pricing_mode = 'ENGINE' WHERE write_scope_id = 'a6000000-0000-0000-0000-000000000001' $q$);
SELECT pg_temp.expect_fail('tenant-level min_price (Р-18)', $q$
  INSERT INTO tenant_data.min_price (tenant_id, scope_type, currency, price_basis, amount_minor, version, created_by_membership_id)
  VALUES ('a0000000-0000-0000-0000-00000000000a', 'TENANT', 'EUR', 'GROSS', 100, 1, 'a2000000-0000-0000-0000-00000000000a') $q$);
SELECT pg_temp.expect_fail('min_price version gap', $q$
  INSERT INTO tenant_data.min_price (tenant_id, scope_type, product_id, currency, price_basis, amount_minor, version, created_by_membership_id)
  VALUES ('a0000000-0000-0000-0000-00000000000a', 'PRODUCT', 'a5000000-0000-0000-0000-000000000001', 'EUR', 'GROSS', 1000, 2, 'a2000000-0000-0000-0000-00000000000a') $q$);
INSERT INTO tenant_data.min_price (tenant_id, scope_type, product_id, currency, price_basis, amount_minor, version, created_by_membership_id)
VALUES (:tA, 'PRODUCT', 'a5000000-0000-0000-0000-000000000001', 'EUR', 'GROSS', 1000, 1, :mA);
SELECT pg_temp.expect_fail('ENGINE with min_price but without max_price (Р-43)', $q$
  UPDATE tenant_data.write_scope SET pricing_mode = 'ENGINE' WHERE write_scope_id = 'a6000000-0000-0000-0000-000000000001' $q$);
INSERT INTO tenant_data.max_price (tenant_id, scope_type, product_id, currency, price_basis, amount_minor, version, created_by_membership_id)
VALUES (:tA, 'PRODUCT', 'a5000000-0000-0000-0000-000000000001', 'EUR', 'GROSS', 900, 1, :mA);
SELECT pg_temp.expect_fail('ENGINE with min_price above max_price (Р-43)', $q$
  UPDATE tenant_data.write_scope SET pricing_mode = 'ENGINE' WHERE write_scope_id = 'a6000000-0000-0000-0000-000000000001' $q$);
INSERT INTO tenant_data.max_price (tenant_id, scope_type, product_id, currency, price_basis, amount_minor, version, created_by_membership_id)
VALUES (:tA, 'PRODUCT', 'a5000000-0000-0000-0000-000000000001', 'EUR', 'GROSS', 5000, 2, :mA);
SELECT pg_temp.expect_fail('guardrail carrying a ceiling (moved to max_price, Р-43)', $q$
  INSERT INTO tenant_data.guardrail (tenant_id, scope_type, product_id, max_price_minor, currency, price_basis, version, created_by_membership_id)
  VALUES ('a0000000-0000-0000-0000-00000000000a', 'PRODUCT', 'a5000000-0000-0000-0000-000000000001', 5000, 'EUR', 'GROSS', 1, 'a2000000-0000-0000-0000-00000000000a') $q$);
SELECT pg_temp.expect_fail('ENGINE without a strategy (Р-77)', $q$
  UPDATE tenant_data.write_scope SET pricing_mode = 'ENGINE' WHERE write_scope_id = 'a6000000-0000-0000-0000-000000000001' $q$);
INSERT INTO tenant_data.pricing_strategy (tenant_id, pricing_strategy_id, version, name, type, params, triggers, status, created_by_membership_id)
VALUES (:tA, 'a9000000-0000-0000-0000-000000000001', 1, 'smoke fixed', 'FIXED', '{"type":"FIXED","priceMinor":1000,"deadbandMinor":0}', ARRAY['SCHEDULE'], 'ACTIVE', :mA);
SELECT pg_temp.ok('strategy kept while OFF (Р-77)', $q$
  UPDATE tenant_data.write_scope SET pricing_strategy_id = 'a9000000-0000-0000-0000-000000000001', pricing_strategy_version = 1 WHERE write_scope_id = 'a6000000-0000-0000-0000-000000000001' $q$);
SELECT pg_temp.ok('ENGINE with product min_price, max_price and a strategy', $q$
  UPDATE tenant_data.write_scope SET pricing_mode = 'ENGINE' WHERE write_scope_id = 'a6000000-0000-0000-0000-000000000001' $q$);
COMMIT;

BEGIN;
SELECT set_config('app.tenant_id', :tA, true) \gset
SELECT pg_temp.expect_fail('deactivate the only min_price while ENGINE', $q$
  INSERT INTO tenant_data.min_price (tenant_id, scope_type, product_id, currency, price_basis, amount_minor, is_active, version, created_by_membership_id)
  VALUES ('a0000000-0000-0000-0000-00000000000a', 'PRODUCT', 'a5000000-0000-0000-0000-000000000001', 'EUR', 'GROSS', 1000, false, 2, 'a2000000-0000-0000-0000-00000000000a') $q$);
SELECT pg_temp.expect_fail('UPDATE append-only min_price', $q$ UPDATE tenant_data.min_price SET amount_minor = 1 $q$);
SELECT pg_temp.expect_fail('Smart Pricing without tenant opt-in (Р-12)', $q$
  UPDATE tenant_data.write_scope SET pricing_mode = 'KAUFLAND_SMART_PRICING' WHERE write_scope_id = 'a6000000-0000-0000-0000-000000000001' $q$);
SELECT pg_temp.expect_fail('CHANNEL_MIN_PRICE write in ENGINE mode (Р-12)', $q$
  INSERT INTO tenant_data.channel_write (tenant_id, write_scope_id, field, amount_minor, currency, price_basis, version, origin)
  VALUES ('a0000000-0000-0000-0000-00000000000a', 'a6000000-0000-0000-0000-000000000001', 'CHANNEL_MIN_PRICE', 1000, 'EUR', 'GROSS', 1, 'SMART_PRICING_FLOOR') $q$);
COMMIT;

-- ---------------------------------------------------------------- Price Gate, versions, dispatch, history
BEGIN;
SELECT set_config('app.tenant_id', :tA, true) \gset
INSERT INTO channel_data.price_intent (tenant_id, price_intent_id, created_at, write_scope_id, created_by_membership_id, trigger_type, proposed_amount_minor, currency, price_basis, expires_at)
VALUES (:tA, 'a7000000-0000-0000-0000-000000000001', '2026-09-14 10:00+00', 'a6000000-0000-0000-0000-000000000001', :mA, 'MANUAL', 1200, 'EUR', 'GROSS', '2026-09-14 11:00+00'),
       (:tA, 'a7000000-0000-0000-0000-000000000002', '2026-09-14 10:05+00', 'a6000000-0000-0000-0000-000000000001', :mA, 'MANUAL', 1250, 'EUR', 'GROSS', '2026-09-14 11:00+00');
SELECT pg_temp.expect_fail('decision floor below min_price', $q$
  INSERT INTO channel_data.price_decision (tenant_id, intent_created_at, price_intent_id, write_scope_id, outcome, final_amount_minor, currency, price_basis, effective_floor_minor, min_price_ids, effective_ceiling_minor, max_price_ids, explanation, sanity_ruleset, gate_profile)
  VALUES ('a0000000-0000-0000-0000-00000000000a', '2026-09-14 10:00+00', 'a7000000-0000-0000-0000-000000000001', 'a6000000-0000-0000-0000-000000000001', 'APPROVED', 950, 'EUR', 'GROSS', 900, ARRAY[gen_random_uuid()], 5000, ARRAY[gen_random_uuid()], '{"format":"r80.1","snapshot":{"source":"KAUFLAND_BUYBOX"},"sanity":{"anchorsUsed":[],"checks":[]},"strategy":{"reason":{"code":"FIXED_PRICE"}}}', 'r49.1', 'g74.1') $q$);
SELECT pg_temp.expect_fail('approved price below floor', $q$
  INSERT INTO channel_data.price_decision (tenant_id, intent_created_at, price_intent_id, write_scope_id, outcome, final_amount_minor, currency, price_basis, effective_floor_minor, min_price_ids, effective_ceiling_minor, max_price_ids, explanation, sanity_ruleset, gate_profile)
  VALUES ('a0000000-0000-0000-0000-00000000000a', '2026-09-14 10:00+00', 'a7000000-0000-0000-0000-000000000001', 'a6000000-0000-0000-0000-000000000001', 'APPROVED', 990, 'EUR', 'GROSS', 1000, ARRAY[gen_random_uuid()], 5000, ARRAY[gen_random_uuid()], '{"format":"r80.1","snapshot":{"source":"KAUFLAND_BUYBOX"},"sanity":{"anchorsUsed":[],"checks":[]},"strategy":{"reason":{"code":"FIXED_PRICE"}}}', 'r49.1', 'g74.1') $q$);
INSERT INTO channel_data.price_decision (tenant_id, price_decision_id, intent_created_at, price_intent_id, write_scope_id, outcome, final_amount_minor, currency, price_basis, effective_floor_minor, min_price_ids, effective_ceiling_minor, max_price_ids, explanation, sanity_ruleset, gate_profile)
VALUES (:tA, 'a8000000-0000-0000-0000-000000000001', '2026-09-14 10:00+00', 'a7000000-0000-0000-0000-000000000001', 'a6000000-0000-0000-0000-000000000001', 'APPROVED', 1200, 'EUR', 'GROSS', 1000, ARRAY[gen_random_uuid()], 5000, ARRAY[gen_random_uuid()], '{"format":"r80.1","strategy":{"reason":{"code":"FIXED_PRICE"}}}', NULL, 'g74.1'),
       (:tA, 'a8000000-0000-0000-0000-000000000002', '2026-09-14 10:05+00', 'a7000000-0000-0000-0000-000000000002', 'a6000000-0000-0000-0000-000000000001', 'APPROVED', 1250, 'EUR', 'GROSS', 1000, ARRAY[gen_random_uuid()], 5000, ARRAY[gen_random_uuid()], '{"format":"r80.1","strategy":{"reason":{"code":"FIXED_PRICE"}}}', NULL, 'g74.1');
INSERT INTO channel_data.price_intent (tenant_id, price_intent_id, created_at, write_scope_id, created_by_membership_id, trigger_type, proposed_amount_minor, currency, price_basis, expires_at, rule_code, reference_amount_minor)
VALUES (:tA, 'a7000000-0000-0000-0000-000000000003', '2026-09-14 10:10+00', 'a6000000-0000-0000-0000-000000000001', :mA, 'MANUAL', 1250, 'EUR', 'GROSS', '2026-09-14 11:00+00', 'MATCH_BUYBOX', 1240);
INSERT INTO channel_data.price_decision (tenant_id, intent_created_at, price_intent_id, write_scope_id, outcome, currency, price_basis, effective_floor_minor, min_price_ids, effective_ceiling_minor, max_price_ids, explanation, no_change_reason)
VALUES (:tA, '2026-09-14 10:10+00', 'a7000000-0000-0000-0000-000000000003', 'a6000000-0000-0000-0000-000000000001', 'NO_CHANGE', 'EUR', 'GROSS', 1000, ARRAY[gen_random_uuid()], 5000, ARRAY[gen_random_uuid()], NULL, 'ALREADY_AT_TARGET');
DO $$ BEGIN
  IF (SELECT count(*) FROM tenant_data.price_intent_core WHERE intent_class = 'CHANGED') <> 2
     OR EXISTS (SELECT 1 FROM tenant_data.price_intent_core WHERE price_intent_id = 'a7000000-0000-0000-0000-000000000003')
     OR (SELECT intent_class FROM channel_data.price_decision WHERE price_intent_id = 'a7000000-0000-0000-0000-000000000003') <> 'NO_OP' THEN
    RAISE EXCEPTION 'intent classes/core not as expected'; END IF;
  RAISE NOTICE 'PASS accept | CHANGED -> price_intent_core, NO_OP not kept in core (Р-27, Р-38)';
END $$;
SELECT pg_temp.expect_fail('decision for an intent of another write_scope', $q$
  INSERT INTO channel_data.price_decision (tenant_id, intent_created_at, price_intent_id, write_scope_id, outcome, currency, price_basis, effective_floor_minor, min_price_ids, effective_ceiling_minor, max_price_ids, explanation, sanity_ruleset, gate_profile)
  VALUES ('a0000000-0000-0000-0000-00000000000a', '2026-09-14 10:10+00', 'a7000000-0000-0000-0000-000000000003', gen_random_uuid(), 'HELD', 'EUR', 'GROSS', 1000, ARRAY[gen_random_uuid()], 5000, ARRAY[gen_random_uuid()], '{"format":"r80.1","snapshot":{"source":"KAUFLAND_BUYBOX"},"sanity":{"anchorsUsed":[],"checks":[]},"strategy":{"reason":{"code":"FIXED_PRICE"}}}', 'r49.1', 'g74.1') $q$);
SELECT pg_temp.expect_fail('second decision for the same intent', $q$
  INSERT INTO channel_data.price_decision (tenant_id, intent_created_at, price_intent_id, write_scope_id, outcome, currency, price_basis, effective_floor_minor, min_price_ids, effective_ceiling_minor, max_price_ids, explanation, sanity_ruleset, gate_profile)
  VALUES ('a0000000-0000-0000-0000-00000000000a', '2026-09-14 10:00+00', 'a7000000-0000-0000-0000-000000000001', 'a6000000-0000-0000-0000-000000000001', 'HELD', 'EUR', 'GROSS', 1000, ARRAY[gen_random_uuid()], 5000, ARRAY[gen_random_uuid()], '{"format":"r80.1","snapshot":{"source":"KAUFLAND_BUYBOX"},"sanity":{"anchorsUsed":[],"checks":[]},"strategy":{"reason":{"code":"FIXED_PRICE"}}}', 'r49.1', 'g74.1') $q$);
SELECT pg_temp.expect_fail('PRICE write not equal to decision', $q$
  INSERT INTO tenant_data.channel_write (tenant_id, write_scope_id, field, amount_minor, currency, price_basis, version, origin, price_decision_id)
  VALUES ('a0000000-0000-0000-0000-00000000000a', 'a6000000-0000-0000-0000-000000000001', 'PRICE', 1300, 'EUR', 'GROSS', 1, 'PRICE_DECISION', 'a8000000-0000-0000-0000-000000000001') $q$);
INSERT INTO tenant_data.channel_write (tenant_id, channel_write_id, write_scope_id, field, amount_minor, currency, price_basis, version, origin, price_decision_id)
VALUES (:tA, 'a9000000-0000-0000-0000-000000000001', 'a6000000-0000-0000-0000-000000000001', 'PRICE', 1200, 'EUR', 'GROSS', 1, 'PRICE_DECISION', 'a8000000-0000-0000-0000-000000000001');
SELECT pg_temp.expect_fail('same version again (INV-03)', $q$
  INSERT INTO tenant_data.channel_write (tenant_id, write_scope_id, field, amount_minor, currency, price_basis, version, origin, price_decision_id)
  VALUES ('a0000000-0000-0000-0000-00000000000a', 'a6000000-0000-0000-0000-000000000001', 'PRICE', 1200, 'EUR', 'GROSS', 1, 'PRICE_DECISION', 'a8000000-0000-0000-0000-000000000001') $q$);
INSERT INTO tenant_data.channel_write (tenant_id, channel_write_id, write_scope_id, field, amount_minor, currency, price_basis, version, origin, price_decision_id)
VALUES (:tA, 'a9000000-0000-0000-0000-000000000002', 'a6000000-0000-0000-0000-000000000001', 'PRICE', 1250, 'EUR', 'GROSS', 2, 'PRICE_DECISION', 'a8000000-0000-0000-0000-000000000002');
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM tenant_data.channel_write WHERE channel_write_id = 'a9000000-0000-0000-0000-000000000001')
     OR NOT EXISTS (SELECT 1 FROM tenant_data.channel_write_history
                     WHERE channel_write_id = 'a9000000-0000-0000-0000-000000000001' AND final_status = 'SUPERSEDED') THEN
    RAISE EXCEPTION 'v1 not moved to history as SUPERSEDED'; END IF;
  RAISE NOTICE 'PASS accept | v2 supersedes v1; v1 moved to channel_write_history (Р-20)';
END $$;
SELECT pg_temp.expect_fail('direct DELETE of an open write', $q$
  DELETE FROM tenant_data.channel_write WHERE channel_write_id = 'a9000000-0000-0000-0000-000000000002' $q$);
SELECT pg_temp.expect_fail('older version insert after newer (INV-03)', $q$
  INSERT INTO tenant_data.channel_write (tenant_id, write_scope_id, field, amount_minor, currency, price_basis, version, origin, price_decision_id)
  VALUES ('a0000000-0000-0000-0000-00000000000a', 'a6000000-0000-0000-0000-000000000001', 'PRICE', 1200, 'EUR', 'GROSS', 1, 'PRICE_DECISION', 'a8000000-0000-0000-0000-000000000001') $q$);
COMMIT;

-- ---------------------------------------------------------------- Р-42, Р-43, Р-44 (0030)
BEGIN;
SELECT set_config('app.tenant_id', :tA, true), set_config('app.user_id', :uA, true) \gset
INSERT INTO channel_data.price_intent (tenant_id, price_intent_id, created_at, write_scope_id, created_by_membership_id, trigger_type, proposed_amount_minor, currency, price_basis, expires_at, rule_code)
VALUES (:tA, 'a7000000-0000-0000-0000-000000000010', '2026-09-14 10:20+00', 'a6000000-0000-0000-0000-000000000001', :mA, 'MANUAL', 6000, 'EUR', 'GROSS', '2026-09-14 11:00+00', 'MANUAL'),
       (:tA, 'a7000000-0000-0000-0000-000000000011', '2026-09-14 10:21+00', 'a6000000-0000-0000-0000-000000000001', :mA, 'MANUAL', 4000, 'EUR', 'GROSS', '2026-09-14 11:00+00', 'MANUAL'),
       (:tA, 'a7000000-0000-0000-0000-000000000012', '2026-09-14 10:22+00', 'a6000000-0000-0000-0000-000000000001', :mA, 'MANUAL', 1400, 'EUR', 'GROSS', '2026-09-14 11:00+00', 'MANUAL'),
       (:tA, 'a7000000-0000-0000-0000-000000000013', '2026-09-14 10:23+00', 'a6000000-0000-0000-0000-000000000001', :mA, 'MANUAL', 1400, 'EUR', 'GROSS', '2026-09-14 11:00+00', 'MANUAL');
SELECT pg_temp.ok('decision above max_price stored as REJECTED (Р-44)', $q$
  INSERT INTO channel_data.price_decision (tenant_id, intent_created_at, price_intent_id, write_scope_id, outcome, rejection_reason, currency, price_basis, effective_floor_minor, min_price_ids, effective_ceiling_minor, max_price_ids, reason_params, explanation, sanity_ruleset, gate_profile, bound_deviation_bp)
  VALUES ('a0000000-0000-0000-0000-00000000000a', '2026-09-14 10:20+00', 'a7000000-0000-0000-0000-000000000010', 'a6000000-0000-0000-0000-000000000001', 'REJECTED', 'ABOVE_MAX_PRICE', 'EUR', 'GROSS', 1000, ARRAY[gen_random_uuid()], 5000, ARRAY[gen_random_uuid()], '{"smoke": true}', '{"format":"r80.1","snapshot":{"source":"KAUFLAND_BUYBOX"},"sanity":{"anchorsUsed":[],"checks":[]},"strategy":{"reason":{"code":"FIXED_PRICE"}}}', 'r49.1', 'g74.1', 2000) $q$);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM tenant_data.price_intent_core WHERE price_intent_id = 'a7000000-0000-0000-0000-000000000010'
                   AND intent_class = 'REJECTED_BY_GATE' AND rejection_reason = 'ABOVE_MAX_PRICE') THEN
    RAISE EXCEPTION 'ceiling rejection not kept as REJECTED_BY_GATE in core'; END IF;
  RAISE NOTICE 'PASS accept | rejection by max_price kept in price_intent_core as REJECTED_BY_GATE (Р-44)';
END $$;
SELECT pg_temp.expect_fail('rejection reason ABOVE_MAX_PRICE for a price below the ceiling', $q$
  INSERT INTO channel_data.price_decision (tenant_id, intent_created_at, price_intent_id, write_scope_id, outcome, rejection_reason, currency, price_basis, effective_floor_minor, min_price_ids, effective_ceiling_minor, max_price_ids, reason_params, explanation, sanity_ruleset, gate_profile)
  VALUES ('a0000000-0000-0000-0000-00000000000a', '2026-09-14 10:21+00', 'a7000000-0000-0000-0000-000000000011', 'a6000000-0000-0000-0000-000000000001', 'REJECTED', 'ABOVE_MAX_PRICE', 'EUR', 'GROSS', 1000, ARRAY[gen_random_uuid()], 5000, ARRAY[gen_random_uuid()], '{"smoke": true}', '{"format":"r80.1","snapshot":{"source":"KAUFLAND_BUYBOX"},"sanity":{"anchorsUsed":[],"checks":[]},"strategy":{"reason":{"code":"FIXED_PRICE"}}}', 'r49.1', 'g74.1') $q$);
SELECT pg_temp.expect_fail('decision ceiling above effective max_price', $q$
  INSERT INTO channel_data.price_decision (tenant_id, intent_created_at, price_intent_id, write_scope_id, outcome, final_amount_minor, currency, price_basis, effective_floor_minor, min_price_ids, effective_ceiling_minor, max_price_ids, explanation, sanity_ruleset, gate_profile)
  VALUES ('a0000000-0000-0000-0000-00000000000a', '2026-09-14 10:21+00', 'a7000000-0000-0000-0000-000000000011', 'a6000000-0000-0000-0000-000000000001', 'APPROVED', 4000, 'EUR', 'GROSS', 1000, ARRAY[gen_random_uuid()], 6000, ARRAY[gen_random_uuid()], '{"format":"r80.1","snapshot":{"source":"KAUFLAND_BUYBOX"},"sanity":{"anchorsUsed":[],"checks":[]},"strategy":{"reason":{"code":"FIXED_PRICE"}}}', 'r49.1', 'g74.1') $q$);
SELECT pg_temp.expect_fail('decision without ceiling (Р-43)', $q$
  INSERT INTO channel_data.price_decision (tenant_id, intent_created_at, price_intent_id, write_scope_id, outcome, final_amount_minor, currency, price_basis, effective_floor_minor, min_price_ids, explanation, sanity_ruleset, gate_profile)
  VALUES ('a0000000-0000-0000-0000-00000000000a', '2026-09-14 10:21+00', 'a7000000-0000-0000-0000-000000000011', 'a6000000-0000-0000-0000-000000000001', 'APPROVED', 4000, 'EUR', 'GROSS', 1000, ARRAY[gen_random_uuid()], '{"format":"r80.1","snapshot":{"source":"KAUFLAND_BUYBOX"},"sanity":{"anchorsUsed":[],"checks":[]},"strategy":{"reason":{"code":"FIXED_PRICE"}}}', 'r49.1', 'g74.1') $q$);
SELECT pg_temp.expect_fail('clamp to floor instead of rejection (Р-44)', $q$
  INSERT INTO channel_data.price_decision (tenant_id, intent_created_at, price_intent_id, write_scope_id, outcome, final_amount_minor, currency, price_basis, effective_floor_minor, min_price_ids, effective_ceiling_minor, max_price_ids, explanation, sanity_ruleset, gate_profile)
  VALUES ('a0000000-0000-0000-0000-00000000000a', '2026-09-14 10:22+00', 'a7000000-0000-0000-0000-000000000012', 'a6000000-0000-0000-0000-000000000001', 'CLAMPED_FLOOR', 1000, 'EUR', 'GROSS', 1000, ARRAY[gen_random_uuid()], 5000, ARRAY[gen_random_uuid()], '{"format":"r80.1","snapshot":{"source":"KAUFLAND_BUYBOX"},"sanity":{"anchorsUsed":[],"checks":[]},"strategy":{"reason":{"code":"FIXED_PRICE"}}}', 'r49.1', 'g74.1') $q$);
SELECT pg_temp.expect_fail('REJECTED without a reason', $q$
  INSERT INTO channel_data.price_decision (tenant_id, intent_created_at, price_intent_id, write_scope_id, outcome, currency, price_basis, effective_floor_minor, min_price_ids, effective_ceiling_minor, max_price_ids, explanation, sanity_ruleset, gate_profile)
  VALUES ('a0000000-0000-0000-0000-00000000000a', '2026-09-14 10:22+00', 'a7000000-0000-0000-0000-000000000012', 'a6000000-0000-0000-0000-000000000001', 'REJECTED', 'EUR', 'GROSS', 1000, ARRAY[gen_random_uuid()], 5000, ARRAY[gen_random_uuid()], '{"format":"r80.1","snapshot":{"source":"KAUFLAND_BUYBOX"},"sanity":{"anchorsUsed":[],"checks":[]},"strategy":{"reason":{"code":"FIXED_PRICE"}}}', 'r49.1', 'g74.1') $q$);
SELECT pg_temp.ok('bound cannot be computed: REJECTED with empty bounds is stored', $q$
  INSERT INTO channel_data.price_decision (tenant_id, intent_created_at, price_intent_id, write_scope_id, outcome, rejection_reason, currency, price_basis, min_price_ids, reason_params, explanation, sanity_ruleset, gate_profile)
  VALUES ('a0000000-0000-0000-0000-00000000000a', '2026-09-14 10:22+00', 'a7000000-0000-0000-0000-000000000012', 'a6000000-0000-0000-0000-000000000001', 'REJECTED', 'BOUND_UNRESOLVABLE', 'EUR', 'GROSS', '{}', '{"smoke": true}', '{"format":"r80.1","snapshot":{"source":"KAUFLAND_BUYBOX"},"sanity":{"anchorsUsed":[],"checks":[]},"strategy":{"reason":{"code":"FIXED_PRICE"}}}', 'r49.1', 'g74.1') $q$);
SELECT pg_temp.expect_fail('BOUND_UNRESOLVABLE with an approval', $q$
  INSERT INTO channel_data.price_decision (tenant_id, intent_created_at, price_intent_id, write_scope_id, outcome, final_amount_minor, rejection_reason, currency, price_basis, min_price_ids, reason_params, explanation, sanity_ruleset, gate_profile)
  VALUES ('a0000000-0000-0000-0000-00000000000a', '2026-09-14 10:23+00', 'a7000000-0000-0000-0000-000000000013', 'a6000000-0000-0000-0000-000000000001', 'APPROVED', 1400, 'BOUND_UNRESOLVABLE', 'EUR', 'GROSS', '{}', '{"smoke": true}', '{"format":"r80.1","snapshot":{"source":"KAUFLAND_BUYBOX"},"sanity":{"anchorsUsed":[],"checks":[]},"strategy":{"reason":{"code":"FIXED_PRICE"}}}', 'r49.1', 'g74.1') $q$);
-- Проверка 3 из 3: потолок снижен после создания записи — отправка отклонена
INSERT INTO tenant_data.max_price (tenant_id, scope_type, write_scope_id, currency, price_basis, amount_minor, version, created_by_membership_id)
VALUES (:tA, 'WRITE_SCOPE', 'a6000000-0000-0000-0000-000000000001', 'EUR', 'GROSS', 1200, 1, :mA);
SELECT pg_temp.expect_fail('dispatch above lowered max_price (Р-44, check 3)', $q$
  UPDATE tenant_data.channel_write SET status = 'DISPATCHED', attempt_count = 1 WHERE channel_write_id = 'a9000000-0000-0000-0000-000000000002' $q$);
ROLLBACK;

BEGIN;
SELECT set_config('app.tenant_id', :tA, true), set_config('app.user_id', :uA, true) \gset
-- ---------------------------------------------------------------- Р-51, Р-52 (0032)
INSERT INTO channel_data.price_intent (tenant_id, price_intent_id, created_at, write_scope_id, created_by_membership_id, trigger_type, proposed_amount_minor, currency, price_basis, expires_at, rule_code)
VALUES (:tA, 'a7000000-0000-0000-0000-000000000020', '2026-09-14 10:30+00', 'a6000000-0000-0000-0000-000000000001', :mA, 'MANUAL', 1300, 'EUR', 'GROSS', '2026-09-14 11:00+00', 'MATCH_BUYBOX'),
       (:tA, 'a7000000-0000-0000-0000-000000000021', '2026-09-14 10:31+00', 'a6000000-0000-0000-0000-000000000001', :mA, 'MANUAL', 1300, 'EUR', 'GROSS', '2026-09-14 11:00+00', 'MANUAL'),
       (:tA, 'a7000000-0000-0000-0000-000000000022', '2026-09-14 10:32+00', 'a6000000-0000-0000-0000-000000000001', :mA, 'MANUAL', 1310, 'EUR', 'GROSS', '2026-09-14 11:00+00', 'MATCH_BUYBOX');
INSERT INTO channel_data.price_decision (tenant_id, price_decision_id, intent_created_at, price_intent_id, write_scope_id, outcome, final_amount_minor, rejection_reason, currency, price_basis, effective_floor_minor, min_price_ids, effective_ceiling_minor, max_price_ids, reason_params, explanation, sanity_ruleset, gate_profile)
VALUES (:tA, 'a8000000-0000-0000-0000-000000000020', '2026-09-14 10:30+00', 'a7000000-0000-0000-0000-000000000020', 'a6000000-0000-0000-0000-000000000001', 'APPROVED', 1300, NULL, 'EUR', 'GROSS', 1000, ARRAY[gen_random_uuid()], 5000, ARRAY[gen_random_uuid()], '{"smoke": true}', '{"format":"r80.1","snapshot":{"source":"KAUFLAND_BUYBOX"},"sanity":{"anchorsUsed":[],"checks":[]},"strategy":{"reason":{"code":"FIXED_PRICE"}}}', 'r49.1', 'g74.1');
DO $$ BEGIN
  IF NOT (SELECT competitor_derived FROM channel_data.price_decision WHERE price_decision_id = 'a8000000-0000-0000-0000-000000000020')
     OR (SELECT competitor_derived FROM channel_data.price_intent WHERE price_intent_id = 'a7000000-0000-0000-0000-000000000021') THEN
    RAISE EXCEPTION 'competitor_derived is not derived from rule_code'; END IF;
  RAISE NOTICE 'PASS accept | competitor_derived: from intent rule_code, copied into the decision (Р-51)';
END $$;
INSERT INTO tenant_data.channel_write (tenant_id, channel_write_id, write_scope_id, field, amount_minor, currency, price_basis, version, origin, price_decision_id)
VALUES (:tA, 'a9000000-0000-0000-0000-000000000003', 'a6000000-0000-0000-0000-000000000001', 'PRICE', 1300, 'EUR', 'GROSS', 3, 'PRICE_DECISION', 'a8000000-0000-0000-0000-000000000020');
INSERT INTO channel_data.pricing_halt (tenant_id, pricing_halt_id, channel_account_id, channel, marketplace, reason_code, details)
VALUES (:tA, 'ab000000-0000-0000-0000-000000000001', 'a4000000-0000-0000-0000-000000000001', 'KAUFLAND', 'de', 'CHANNEL_MASS_SHIFT', '{"sameDirection": 20}');
DO $$ BEGIN
  IF (SELECT next_review_at - halted_at FROM channel_data.pricing_halt WHERE pricing_halt_id = 'ab000000-0000-0000-0000-000000000001') <> interval '30 minutes' THEN
    RAISE EXCEPTION 'next_review_at is not halted_at + review_window'; END IF;
  RAISE NOTICE 'PASS accept | a halt schedules its review after the window (Р-52)';
END $$;
SELECT pg_temp.expect_fail('competitor-derived approval while halted (Р-51)', $q$
  INSERT INTO channel_data.price_decision (tenant_id, price_decision_id, intent_created_at, price_intent_id, write_scope_id, outcome, final_amount_minor, rejection_reason, currency, price_basis, effective_floor_minor, min_price_ids, effective_ceiling_minor, max_price_ids, reason_params, explanation, sanity_ruleset, gate_profile)
  VALUES ('a0000000-0000-0000-0000-00000000000a', gen_random_uuid(), '2026-09-14 10:32+00', 'a7000000-0000-0000-0000-000000000022', 'a6000000-0000-0000-0000-000000000001', 'APPROVED', 1310, NULL, 'EUR', 'GROSS', 1000, ARRAY[gen_random_uuid()], 5000, ARRAY[gen_random_uuid()], '{"smoke": true}', '{"format":"r80.1","snapshot":{"source":"KAUFLAND_BUYBOX"},"sanity":{"anchorsUsed":[],"checks":[]},"strategy":{"reason":{"code":"FIXED_PRICE"}}}', 'r49.1', 'g74.1') $q$);
SELECT pg_temp.ok('halted rejection of a competitor-derived price is stored', $q$
  INSERT INTO channel_data.price_decision (tenant_id, price_decision_id, intent_created_at, price_intent_id, write_scope_id, outcome, final_amount_minor, rejection_reason, currency, price_basis, effective_floor_minor, min_price_ids, effective_ceiling_minor, max_price_ids, reason_params, explanation, sanity_ruleset, gate_profile)
  VALUES ('a0000000-0000-0000-0000-00000000000a', gen_random_uuid(), '2026-09-14 10:32+00', 'a7000000-0000-0000-0000-000000000022', 'a6000000-0000-0000-0000-000000000001', 'REJECTED', NULL, 'CHANNEL_HALTED', 'EUR', 'GROSS', 1000, ARRAY[gen_random_uuid()], 5000, ARRAY[gen_random_uuid()], '{"smoke": true}', '{"format":"r80.1","snapshot":{"source":"KAUFLAND_BUYBOX"},"sanity":{"anchorsUsed":[],"checks":[]},"strategy":{"reason":{"code":"FIXED_PRICE"}}}', 'r49.1', 'g74.1') $q$);
SELECT pg_temp.expect_fail('dispatch of a competitor-derived write while halted (Р-51)', $q$
  UPDATE tenant_data.channel_write SET status = 'DISPATCHED', attempt_count = 1 WHERE channel_write_id = 'a9000000-0000-0000-0000-000000000003' $q$);
SELECT pg_temp.ok('manual price approved while halted (Р-51)', $q$
  INSERT INTO channel_data.price_decision (tenant_id, price_decision_id, intent_created_at, price_intent_id, write_scope_id, outcome, final_amount_minor, rejection_reason, currency, price_basis, effective_floor_minor, min_price_ids, effective_ceiling_minor, max_price_ids, reason_params, explanation, sanity_ruleset, gate_profile)
  VALUES ('a0000000-0000-0000-0000-00000000000a', 'a8000000-0000-0000-0000-000000000021', '2026-09-14 10:31+00', 'a7000000-0000-0000-0000-000000000021', 'a6000000-0000-0000-0000-000000000001', 'APPROVED', 1300, NULL, 'EUR', 'GROSS', 1000, ARRAY[gen_random_uuid()], 5000, ARRAY[gen_random_uuid()], '{"smoke": true}', '{"format":"r80.1","snapshot":{"source":"KAUFLAND_BUYBOX"},"sanity":{"anchorsUsed":[],"checks":[]},"strategy":{"reason":{"code":"FIXED_PRICE"}}}', 'r49.1', 'g74.1') $q$);
SELECT pg_temp.ok('manual price write created while halted (Р-51)', $q$
  INSERT INTO tenant_data.channel_write (tenant_id, channel_write_id, write_scope_id, field, amount_minor, currency, price_basis, version, origin, price_decision_id)
  VALUES ('a0000000-0000-0000-0000-00000000000a', 'a9000000-0000-0000-0000-000000000004', 'a6000000-0000-0000-0000-000000000001', 'PRICE', 1300, 'EUR', 'GROSS', 4, 'PRICE_DECISION', 'a8000000-0000-0000-0000-000000000021') $q$);
SELECT pg_temp.ok('manual price write dispatched while halted (Р-51)', $q$
  UPDATE tenant_data.channel_write SET status = 'DISPATCHED', attempt_count = 1 WHERE channel_write_id = 'a9000000-0000-0000-0000-000000000004' $q$);
SELECT pg_temp.expect_fail('second active halt for the same storefront', $q$
  INSERT INTO channel_data.pricing_halt (tenant_id, channel_account_id, channel, marketplace, reason_code)
  VALUES ('a0000000-0000-0000-0000-00000000000a', 'a4000000-0000-0000-0000-000000000001', 'KAUFLAND', 'de', 'MANUAL') $q$);
SELECT pg_temp.expect_fail('release without kind and person', $q$
  UPDATE channel_data.pricing_halt SET released_at = now() WHERE pricing_halt_id = 'ab000000-0000-0000-0000-000000000001' $q$);
SELECT pg_temp.expect_fail('change halt reason', $q$
  UPDATE channel_data.pricing_halt SET reason_code = 'MANUAL' WHERE pricing_halt_id = 'ab000000-0000-0000-0000-000000000001' $q$);
SELECT pg_temp.expect_fail('manual release without a journal record (Р-52)', $q$
  UPDATE channel_data.pricing_halt SET released_at = now(), released_kind = 'MANUAL', released_by_membership_id = 'a2000000-0000-0000-0000-00000000000a', release_note = 'data verified with the channel' WHERE pricing_halt_id = 'ab000000-0000-0000-0000-000000000001' $q$);
SELECT pg_temp.expect_fail('manual release record without a note', $q$
  INSERT INTO channel_data.pricing_halt_review (tenant_id, pricing_halt_id, kind, outcome, sample_size, failed_count, membership_id, note) VALUES ('a0000000-0000-0000-0000-00000000000a', 'ab000000-0000-0000-0000-000000000001', 'MANUAL_RELEASE', 'RELEASED', 0, 0, 'a2000000-0000-0000-0000-00000000000a', NULL) $q$);
-- Находка 3 (0053): автоматическая проверка — действие системы, без пользователя сессии
SELECT set_config('app.user_id', '', true) \gset
SELECT pg_temp.expect_fail('automatic review without a sample', $q$
  INSERT INTO channel_data.pricing_halt_review (tenant_id, pricing_halt_id, kind, outcome, sample_size, failed_count, membership_id, note) VALUES ('a0000000-0000-0000-0000-00000000000a', 'ab000000-0000-0000-0000-000000000001', 'AUTO_SAMPLE', 'RELEASED', 0, 0, NULL, NULL) $q$);
SELECT pg_temp.expect_fail('automatic release despite failed samples', $q$
  INSERT INTO channel_data.pricing_halt_review (tenant_id, pricing_halt_id, kind, outcome, sample_size, failed_count, membership_id, note) VALUES ('a0000000-0000-0000-0000-00000000000a', 'ab000000-0000-0000-0000-000000000001', 'AUTO_SAMPLE', 'RELEASED', 5, 1, NULL, NULL) $q$);
SELECT pg_temp.ok('failed sample recorded', $q$
  INSERT INTO channel_data.pricing_halt_review (tenant_id, pricing_halt_id, kind, outcome, sample_size, failed_count, membership_id, note) VALUES ('a0000000-0000-0000-0000-00000000000a', 'ab000000-0000-0000-0000-000000000001', 'AUTO_SAMPLE', 'SAMPLE_FAILED', 5, 1, NULL, NULL) $q$);
SELECT pg_temp.ok('next review moved after a failed sample', $q$
  UPDATE channel_data.pricing_halt SET next_review_at = now() + interval '30 minutes' WHERE pricing_halt_id = 'ab000000-0000-0000-0000-000000000001' $q$);
SELECT pg_temp.expect_fail('AUTO release backed only by a failed sample (Р-52)', $q$
  UPDATE channel_data.pricing_halt SET released_at = now(), released_kind = 'AUTO' WHERE pricing_halt_id = 'ab000000-0000-0000-0000-000000000001' $q$);
-- Ручное снятие — в сессии участника; запись журнала без немедленной проверки: снятие в той же транзакции проверяется при фиксации (0053)
SELECT set_config('app.user_id', :uA, true) \gset
-- pg_temp.ok ставит SET CONSTRAINTS ALL IMMEDIATE до конца транзакции: проверку снятия снова откладываем до UPDATE
SET CONSTRAINTS ALL DEFERRED;
INSERT INTO channel_data.pricing_halt_review (tenant_id, pricing_halt_id, kind, outcome, sample_size, failed_count, membership_id, note) VALUES ('a0000000-0000-0000-0000-00000000000a', 'ab000000-0000-0000-0000-000000000001', 'MANUAL_RELEASE', 'RELEASED', 0, 0, 'a2000000-0000-0000-0000-00000000000a', 'data verified with the channel');
SELECT pg_temp.ok('manual release by a member with a note and a journal record (Р-52)', $q$
  UPDATE channel_data.pricing_halt SET released_at = now(), released_kind = 'MANUAL', released_by_membership_id = 'a2000000-0000-0000-0000-00000000000a', release_note = 'data verified with the channel' WHERE pricing_halt_id = 'ab000000-0000-0000-0000-000000000001' $q$);
SELECT pg_temp.expect_fail('release twice', $q$
  UPDATE channel_data.pricing_halt SET release_note = 'released again later' WHERE pricing_halt_id = 'ab000000-0000-0000-0000-000000000001' $q$);
SELECT pg_temp.expect_fail('UPDATE append-only halt review', $q$ UPDATE channel_data.pricing_halt_review SET note = 'rewritten afterwards' $q$);
-- ---------------------------------------------------------------- Р-49 (0032)
SELECT pg_temp.ok('rejected snapshot with reason', $q$
  INSERT INTO channel_data.rejected_competitor_snapshot (tenant_id, channel_account_id, channel, marketplace, channel_product_ref, condition, source, observed_at, received_at, verdict, reason_code, alarm_class, ruleset_version) VALUES ('a0000000-0000-0000-0000-00000000000a', 'a4000000-0000-0000-0000-000000000001', 'KAUFLAND', 'de', '362000001', 'new', 'KAUFLAND_BUYBOX', now(), now(), 'REJECT', 'UNIT_SCALE_X100', 'UNIT_SCALE', 'r49.1') $q$);
SELECT pg_temp.expect_fail('HALT_CHANNEL with a per-product reason', $q$
  INSERT INTO channel_data.rejected_competitor_snapshot (tenant_id, channel_account_id, channel, marketplace, channel_product_ref, condition, source, observed_at, received_at, verdict, reason_code, alarm_class, ruleset_version) VALUES ('a0000000-0000-0000-0000-00000000000a', 'a4000000-0000-0000-0000-000000000001', 'KAUFLAND', 'de', '362000001', 'new', 'KAUFLAND_BUYBOX', now(), now(), 'HALT_CHANNEL', 'UNIT_SCALE_X100', 'UNIT_SCALE', 'r49.1') $q$);
SELECT pg_temp.ok('snapshot without a plausibility anchor (Р-49)', $q$
  INSERT INTO channel_data.rejected_competitor_snapshot (tenant_id, channel_account_id, channel, marketplace, channel_product_ref, condition, source, observed_at, received_at, verdict, reason_code, alarm_class, ruleset_version) VALUES ('a0000000-0000-0000-0000-00000000000a', 'a4000000-0000-0000-0000-000000000001', 'KAUFLAND', 'de', '362000002', 'new', 'KAUFLAND_BUYBOX', now(), now(), 'REJECT', 'NO_PLAUSIBILITY_ANCHOR', 'ANCHOR_MISSING', 'r49.1') $q$);
SELECT pg_temp.expect_fail('missing anchor filed under another alarm class', $q$
  INSERT INTO channel_data.rejected_competitor_snapshot (tenant_id, channel_account_id, channel, marketplace, channel_product_ref, condition, source, observed_at, received_at, verdict, reason_code, alarm_class, ruleset_version) VALUES ('a0000000-0000-0000-0000-00000000000a', 'a4000000-0000-0000-0000-000000000001', 'KAUFLAND', 'de', '362000002', 'new', 'KAUFLAND_BUYBOX', now(), now(), 'REJECT', 'NO_PLAUSIBILITY_ANCHOR', 'OUTLIER', 'r49.1') $q$);
SELECT pg_temp.expect_fail('own-price deviation is no longer a rejection reason (Р-49)', $q$
  INSERT INTO channel_data.rejected_competitor_snapshot (tenant_id, channel_account_id, channel, marketplace, channel_product_ref, condition, source, observed_at, received_at, verdict, reason_code, alarm_class, ruleset_version) VALUES ('a0000000-0000-0000-0000-00000000000a', 'a4000000-0000-0000-0000-000000000001', 'KAUFLAND', 'de', '362000003', 'new', 'KAUFLAND_BUYBOX', now(), now(), 'REJECT', 'DEVIATION_FROM_OWN_PRICE', 'OUTLIER', 'r49.1') $q$);
SELECT pg_temp.expect_fail('UPDATE append-only rejected snapshot', $q$ UPDATE channel_data.rejected_competitor_snapshot SET details = '{}' $q$);
-- ---------------------------------------------------------------- Р-53 (0032)
DO $$ BEGIN
  IF tenant_data.effective_vat_rate_bp('a0000000-0000-0000-0000-00000000000a', (SELECT product_id FROM tenant_data.write_scope WHERE write_scope_id = 'a6000000-0000-0000-0000-000000000001'), 'DE') <> 1900
     OR tenant_data.effective_vat_rate_bp('a0000000-0000-0000-0000-00000000000a', (SELECT product_id FROM tenant_data.write_scope WHERE write_scope_id = 'a6000000-0000-0000-0000-000000000001'), 'AT') <> 2000 THEN
    RAISE EXCEPTION 'country VAT defaults are not applied'; END IF;
  RAISE NOTICE 'PASS accept | VAT defaults DE 1900 bp / AT 2000 bp without a declaration (Р-53)';
END $$;
SELECT pg_temp.ok('product declares a reduced VAT rate', $q$
  INSERT INTO tenant_data.product_vat_rate (tenant_id, product_id, country, rate_bp, version, created_by_membership_id) SELECT 'a0000000-0000-0000-0000-00000000000a', product_id, 'DE', 700, 1, 'a2000000-0000-0000-0000-00000000000a' FROM tenant_data.write_scope WHERE write_scope_id = 'a6000000-0000-0000-0000-000000000001' $q$);
DO $$ BEGIN
  IF tenant_data.effective_vat_rate_bp('a0000000-0000-0000-0000-00000000000a', (SELECT product_id FROM tenant_data.write_scope WHERE write_scope_id = 'a6000000-0000-0000-0000-000000000001'), 'DE') <> 700 THEN
    RAISE EXCEPTION 'declared VAT rate does not override the default'; END IF;
  RAISE NOTICE 'PASS accept | declared product VAT rate overrides the country default (Р-53)';
END $$;
SELECT pg_temp.expect_fail('VAT rate above 30%', $q$
  INSERT INTO tenant_data.product_vat_rate (tenant_id, product_id, country, rate_bp, version, created_by_membership_id) SELECT 'a0000000-0000-0000-0000-00000000000a', product_id, 'DE', 3500, 2, 'a2000000-0000-0000-0000-00000000000a' FROM tenant_data.write_scope WHERE write_scope_id = 'a6000000-0000-0000-0000-000000000001' $q$);
SELECT pg_temp.expect_fail('VAT rate for a country outside Release 1.0', $q$
  INSERT INTO tenant_data.product_vat_rate (tenant_id, product_id, country, rate_bp, version, created_by_membership_id) SELECT 'a0000000-0000-0000-0000-00000000000a', product_id, 'PL', 2300, 1, 'a2000000-0000-0000-0000-00000000000a' FROM tenant_data.write_scope WHERE write_scope_id = 'a6000000-0000-0000-0000-000000000001' $q$);
SELECT pg_temp.expect_fail('VAT rate version skipped', $q$
  INSERT INTO tenant_data.product_vat_rate (tenant_id, product_id, country, rate_bp, version, created_by_membership_id) SELECT 'a0000000-0000-0000-0000-00000000000a', product_id, 'DE', 1900, 3, 'a2000000-0000-0000-0000-00000000000a' FROM tenant_data.write_scope WHERE write_scope_id = 'a6000000-0000-0000-0000-000000000001' $q$);
SELECT pg_temp.expect_fail('UPDATE append-only VAT rate', $q$ UPDATE tenant_data.product_vat_rate SET rate_bp = 1900 $q$);
ROLLBACK;

BEGIN;
SELECT set_config('app.tenant_id', :tA, true) \gset
-- Raise min_price above pending v2 value -> dispatch must fail (double check before sending)
INSERT INTO tenant_data.min_price (tenant_id, scope_type, write_scope_id, currency, price_basis, amount_minor, version, created_by_membership_id)
VALUES (:tA, 'WRITE_SCOPE', 'a6000000-0000-0000-0000-000000000001', 'EUR', 'GROSS', 1300, 1, :mA);
SELECT pg_temp.expect_fail('dispatch below raised min_price (INV-02 at dispatch)', $q$
  UPDATE tenant_data.channel_write SET status = 'DISPATCHED', attempt_count = 1 WHERE channel_write_id = 'a9000000-0000-0000-0000-000000000002' $q$);
ROLLBACK;

BEGIN;
SELECT set_config('app.tenant_id', :tA, true) \gset
SELECT pg_temp.ok('dispatch v2', $q$
  UPDATE tenant_data.channel_write SET status = 'DISPATCHED', attempt_count = 1 WHERE channel_write_id = 'a9000000-0000-0000-0000-000000000002' $q$);
SELECT pg_temp.expect_fail('pricing_mode switch with in-flight write (Р-12)', $q$
  UPDATE tenant_data.write_scope SET pricing_mode = 'OFF' WHERE write_scope_id = 'a6000000-0000-0000-0000-000000000001' $q$);
SELECT pg_temp.ok('accept v2', $q$
  UPDATE tenant_data.channel_write SET status = 'ACCEPTED' WHERE channel_write_id = 'a9000000-0000-0000-0000-000000000002' $q$);
DO $$ BEGIN
  IF (SELECT count(*) FROM tenant_data.price_history WHERE amount_minor = 1250) <> 1 THEN RAISE EXCEPTION 'no price_history'; END IF;
  RAISE NOTICE 'PASS accept | ACCEPTED price write recorded in price_history';
END $$;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM tenant_data.price_daily) THEN RAISE EXCEPTION 'price_daily built before the day is closed'; END IF;
  RAISE NOTICE 'PASS accept | price_daily is not built before the day is closed (Р-29)';
END $$;
SELECT pg_temp.expect_fail('direct INSERT into price_daily', $q$
  INSERT INTO tenant_data.price_daily (tenant_id, write_scope_id, price_type, price_day, currency, price_basis, min_amount_minor,
    max_amount_minor, first_amount_minor, first_accepted_at, last_amount_minor, last_accepted_at, change_count, min_floor_minor)
  VALUES ('a0000000-0000-0000-0000-00000000000a', 'a6000000-0000-0000-0000-000000000001', 'REGULAR', current_date - 5, 'EUR', 'GROSS',
    1, 1, 1, now(), 1, now(), 1, 1) $q$);
SELECT pg_temp.expect_fail('direct UPDATE of price_daily', $q$ UPDATE tenant_data.price_daily SET change_count = 99 $q$);
SELECT pg_temp.expect_fail('DELETE price_daily', $q$ DELETE FROM tenant_data.price_daily $q$);
SELECT pg_temp.expect_fail('UPDATE price_history', $q$ UPDATE tenant_data.price_history SET amount_minor = 1 $q$);
SELECT pg_temp.expect_fail('DELETE price_history', $q$ DELETE FROM tenant_data.price_history $q$);
SELECT pg_temp.expect_fail('decrease watermark directly', $q$
  UPDATE tenant_data.write_scope_sync_state SET latest_version_created = 0 $q$);
COMMIT;

BEGIN;
SELECT set_config('app.tenant_id', :tA, true) \gset
SELECT pg_temp.ok('v2 APPLIED -> moved to history', $q$
  UPDATE tenant_data.channel_write SET status = 'APPLIED' WHERE channel_write_id = 'a9000000-0000-0000-0000-000000000002' $q$);
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM tenant_data.channel_write) THEN RAISE EXCEPTION 'completed write left in hot table'; END IF;
  RAISE NOTICE 'PASS accept | hot channel_write holds only unfinished writes';
END $$;
COMMIT;

-- Smart Pricing mode: opt-in, switch, floor write only; engine artefacts rejected
BEGIN;
SELECT set_config('app.tenant_id', :tA, true), set_config('app.user_id', :uA, true) \gset
UPDATE tenant_data.tenant SET kaufland_smart_pricing_opt_in_at = now(), kaufland_smart_pricing_opt_in_by = :uA WHERE tenant_id = :tA;
SELECT pg_temp.ok('switch to KAUFLAND_SMART_PRICING', $q$
  UPDATE tenant_data.write_scope SET pricing_mode = 'KAUFLAND_SMART_PRICING', pricing_strategy_id = NULL, pricing_strategy_version = NULL WHERE write_scope_id = 'a6000000-0000-0000-0000-000000000001' $q$);
SELECT pg_temp.expect_fail('price_intent in Smart Pricing mode', $q$
  INSERT INTO channel_data.price_intent (tenant_id, write_scope_id, created_by_membership_id, trigger_type, proposed_amount_minor, currency, price_basis, expires_at)
  VALUES ('a0000000-0000-0000-0000-00000000000a', 'a6000000-0000-0000-0000-000000000001', 'a2000000-0000-0000-0000-00000000000a', 'MANUAL', 1200, 'EUR', 'GROSS', now() + interval '1 hour') $q$);
SELECT pg_temp.expect_fail('channel floor below our min_price', $q$
  INSERT INTO tenant_data.channel_write (tenant_id, write_scope_id, field, amount_minor, currency, price_basis, version, origin)
  VALUES ('a0000000-0000-0000-0000-00000000000a', 'a6000000-0000-0000-0000-000000000001', 'CHANNEL_MIN_PRICE', 900, 'EUR', 'GROSS', 3, 'SMART_PRICING_FLOOR') $q$);
SELECT pg_temp.ok('CHANNEL_MIN_PRICE write in Smart Pricing mode', $q$
  INSERT INTO tenant_data.channel_write (tenant_id, write_scope_id, field, amount_minor, currency, price_basis, version, origin)
  VALUES ('a0000000-0000-0000-0000-00000000000a', 'a6000000-0000-0000-0000-000000000001', 'CHANNEL_MIN_PRICE', 1000, 'EUR', 'GROSS', 3, 'SMART_PRICING_FLOOR') $q$);
SELECT pg_temp.expect_fail('tenant opt-out while scopes in Smart Pricing', $q$
  UPDATE tenant_data.tenant SET kaufland_smart_pricing_opt_in_at = NULL, kaufland_smart_pricing_opt_in_by = NULL $q$);
COMMIT;

-- ---------------------------------------------------------------- Amazon side effects, stock
BEGIN;
SELECT set_config('app.tenant_id', :tA, true) \gset
INSERT INTO tenant_data.channel_account (tenant_id, channel_account_id, channel, region, external_account_id, credentials_ref, connected_by_membership_id)
VALUES (:tA, 'a4000000-0000-0000-0000-000000000002', 'AMAZON', 'EU', 'A2SPID', 'vault://a/amazon', :mA);
INSERT INTO tenant_data.stock_allocation (tenant_id, scope_type, channel_account_id, buffer_units, version, created_by_membership_id)
VALUES (:tA, 'CHANNEL_ACCOUNT', 'a4000000-0000-0000-0000-000000000002', 2, 1, :mA);
SELECT pg_temp.expect_fail('Amazon EU quantity sync without side-effects ack (INV-11)', $q$
  INSERT INTO tenant_data.write_scope (tenant_id, channel_account_id, channel, field, product_id, capability_id, capability_version, scope_kind, scope_key, requires_side_effects_ack, quantity_sync_enabled)
  VALUES ('a0000000-0000-0000-0000-00000000000a', 'a4000000-0000-0000-0000-000000000002', 'AMAZON', 'QUANTITY', 'a5000000-0000-0000-0000-000000000001',
          'c0000000-0000-0000-0000-000000000003', 1, 'ACCOUNT_REGION_SKU', '["EU", "A-1"]', true, true) $q$);
COMMIT;

BEGIN;
SELECT set_config('app.tenant_id', :tA, true) \gset
INSERT INTO tenant_data.stock_source (tenant_id, stock_source_id, mode, name) VALUES (:tA, 'aa000000-0000-0000-0000-000000000001', 'INTERNAL_POOL', 'Warehouse');
SELECT pg_temp.expect_fail('ERP_MIRROR source in Release 1.0 (Р-15)', $q$
  INSERT INTO tenant_data.stock_source (tenant_id, mode, name) VALUES ('a0000000-0000-0000-0000-00000000000a', 'ERP_MIRROR', 'ERP') $q$);
INSERT INTO tenant_data.stock_pool (tenant_id, stock_pool_id, stock_source_id, source_mode, product_id)
VALUES (:tA, 'ab000000-0000-0000-0000-000000000001', 'aa000000-0000-0000-0000-000000000001', 'INTERNAL_POOL', 'a5000000-0000-0000-0000-000000000001');
SELECT pg_temp.expect_fail('direct on_hand update in INTERNAL_POOL', $q$
  UPDATE tenant_data.stock_pool SET on_hand = 50 WHERE stock_pool_id = 'ab000000-0000-0000-0000-000000000001' $q$);
INSERT INTO tenant_data.stock_movement (tenant_id, stock_pool_id, delta, reason, created_by_membership_id)
VALUES (:tA, 'ab000000-0000-0000-0000-000000000001', 10, 'RECEIPT', :mA);
INSERT INTO channel_data.reservation (tenant_id, reservation_id, stock_pool_id, source_mode, product_id, quantity, channel_account_id, channel, channel_order_ref, channel_order_line_ref, order_created_at, expires_at)
VALUES (:tA, 'ac000000-0000-0000-0000-000000000001', 'ab000000-0000-0000-0000-000000000001', 'INTERNAL_POOL', 'a5000000-0000-0000-0000-000000000001', 2,
        'a4000000-0000-0000-0000-000000000002', 'AMAZON', 'ORDER-1', 'ORDER-1-L1', now(), now());
DO $$ BEGIN
  IF (SELECT expires_at - created_at FROM channel_data.reservation WHERE reservation_id = 'ac000000-0000-0000-0000-000000000001') <> interval '24 hours' THEN
    RAISE EXCEPTION 'TTL is not 24h'; END IF;
  RAISE NOTICE 'PASS accept | reservation CREATED with TTL exactly 24h (Р-25)';
END $$;
SELECT pg_temp.expect_fail('duplicate reservation for order line', $q$
  INSERT INTO channel_data.reservation (tenant_id, stock_pool_id, source_mode, product_id, quantity, channel_account_id, channel, channel_order_ref, channel_order_line_ref, order_created_at, expires_at)
  VALUES ('a0000000-0000-0000-0000-00000000000a', 'ab000000-0000-0000-0000-000000000001', 'INTERNAL_POOL', 'a5000000-0000-0000-0000-000000000001', 2,
          'a4000000-0000-0000-0000-000000000002', 'AMAZON', 'ORDER-1', 'ORDER-1-L1', now(), now()) $q$);
SELECT pg_temp.expect_fail('CONSUMED without source confirmation (Р-25)', $q$
  UPDATE channel_data.reservation SET status = 'CONSUMED', consumed_at = now() WHERE reservation_id = 'ac000000-0000-0000-0000-000000000001' $q$);
SELECT pg_temp.expect_fail('confirmation with a different external order id (Р-25)', $q$
  UPDATE channel_data.reservation SET status = 'CONFIRMED_BY_SOURCE', confirmed_at = now(),
         confirmed_by_stock_source_id = 'aa000000-0000-0000-0000-000000000001', confirmed_external_order_ref = 'ORDER-X'
   WHERE reservation_id = 'ac000000-0000-0000-0000-000000000001' $q$);
SELECT pg_temp.expect_fail('TTL release before expiry', $q$
  UPDATE channel_data.reservation SET status = 'RELEASED', released_at = now() + interval '25 hours', release_reason = 'TTL_EXPIRED'
   WHERE reservation_id = 'ac000000-0000-0000-0000-000000000001' $q$);
DO $$ BEGIN
  IF channel_data.confirm_reservations_by_source('aa000000-0000-0000-0000-000000000001', 'ORDER-1') <> 1 THEN
    RAISE EXCEPTION 'confirmation by source failed'; END IF;
  RAISE NOTICE 'PASS accept | source confirmed reservation by external order id';
END $$;
UPDATE channel_data.reservation SET status = 'CONSUMED', consumed_at = now() WHERE reservation_id = 'ac000000-0000-0000-0000-000000000001';
DO $$ BEGIN
  IF (SELECT on_hand FROM tenant_data.stock_pool WHERE stock_pool_id = 'ab000000-0000-0000-0000-000000000001') <> 8 THEN
    RAISE EXCEPTION 'on_hand not decremented'; END IF;
  RAISE NOTICE 'PASS accept | CONSUMED after confirmation decrements INTERNAL_POOL once (10 -> 8)';
END $$;
SELECT pg_temp.expect_fail('reopen consumed reservation', $q$
  UPDATE channel_data.reservation SET status = 'CREATED', closed_at = NULL, consumed_at = NULL WHERE reservation_id = 'ac000000-0000-0000-0000-000000000001' $q$);
INSERT INTO channel_data.reservation (tenant_id, reservation_id, stock_pool_id, source_mode, product_id, quantity, channel_account_id, channel, channel_order_ref, channel_order_line_ref, order_created_at, expires_at)
VALUES (:tA, 'ac000000-0000-0000-0000-000000000002', 'ab000000-0000-0000-0000-000000000001', 'INTERNAL_POOL', 'a5000000-0000-0000-0000-000000000001', 1,
        'a4000000-0000-0000-0000-000000000002', 'AMAZON', 'ORDER-2', 'ORDER-2-L1', now(), now());
SELECT channel_data.confirm_reservations_by_source('aa000000-0000-0000-0000-000000000001', 'ORDER-2') AS confirmed_order_2 \gset
COMMIT;

-- ---------------------------------------------------------------- eBay: migration consent, irreversibility, budget
BEGIN;
SELECT set_config('app.tenant_id', :tA, true), set_config('app.user_id', :uA, true) \gset
INSERT INTO tenant_data.channel_account (tenant_id, channel_account_id, channel, external_account_id, credentials_ref, connected_by_membership_id)
VALUES (:tA, 'a4000000-0000-0000-0000-000000000003', 'EBAY', 'ebay-user-a', 'vault://a/ebay', :mA);
INSERT INTO tenant_data.offer_mapping (tenant_id, offer_mapping_id, product_id, channel_account_id, channel, marketplace, channel_offer_key, external_sku, external_listing_id, ebay_listing_format, ebay_migration_status, status)
VALUES (:tA, 'ad000000-0000-0000-0000-000000000001', 'a5000000-0000-0000-0000-000000000001', 'a4000000-0000-0000-0000-000000000003', 'EBAY', 'EBAY_DE', 'L1/A-1', 'A-1', 'L1', 'FIXED_PRICE', 'REQUIRED', 'MIGRATION_REQUIRED');
SELECT pg_temp.expect_fail('auction marked migratable', $q$
  INSERT INTO tenant_data.offer_mapping (tenant_id, product_id, channel_account_id, channel, marketplace, channel_offer_key, external_sku, external_listing_id, ebay_listing_format, ebay_migration_status)
  VALUES ('a0000000-0000-0000-0000-00000000000a', 'a5000000-0000-0000-0000-000000000001', 'a4000000-0000-0000-0000-000000000003', 'EBAY', 'EBAY_DE', 'L2/A-1', 'A-1', 'L2', 'AUCTION', 'REQUIRED') $q$);
SELECT pg_temp.expect_fail('migration without consent (INV-12)', $q$
  UPDATE tenant_data.offer_mapping SET ebay_migration_status = 'MIGRATION_STARTED' WHERE offer_mapping_id = 'ad000000-0000-0000-0000-000000000001' $q$);
INSERT INTO channel_data.listing_migration_check (tenant_id, channel_account_id, listing_id, checked_at, listing_snapshot_sha256, verdict, ruleset_version)
VALUES (:tA, 'a4000000-0000-0000-0000-000000000003', 'L1', now() - interval '1 hour', sha256('snapshot-1'), 'READY_WITH_LOSSES', 'v1');
INSERT INTO tenant_data.migration_consent (tenant_id, migration_consent_id, channel_account_id, membership_id, user_id, mfa_verified_at, disclosure_version, disclosure_text_sha256, other_tools_declaration, typed_confirmation, expires_at)
VALUES (:tA, 'ae000000-0000-0000-0000-000000000001', 'a4000000-0000-0000-0000-000000000003', :mA, :uA, now(), 'd1', sha256('text'), 'NONE', 'I understand', now() + interval '3 days');
INSERT INTO tenant_data.migration_consent_item (tenant_id, migration_consent_id, listing_id, listing_migration_check_id, listing_snapshot_sha256, verdict_at_consent, acknowledged_losses)
VALUES (:tA, 'ae000000-0000-0000-0000-000000000001', 'L1', gen_random_uuid(), sha256('snapshot-1'), 'READY_WITH_LOSSES', ARRAY['BEST_OFFER']);
SELECT pg_temp.expect_fail('migration with consent but no fresh re-check', $q$
  UPDATE tenant_data.offer_mapping SET ebay_migration_status = 'MIGRATION_STARTED' WHERE offer_mapping_id = 'ad000000-0000-0000-0000-000000000001' $q$);
INSERT INTO channel_data.listing_migration_check (tenant_id, channel_account_id, listing_id, checked_at, listing_snapshot_sha256, verdict, ruleset_version)
VALUES (:tA, 'a4000000-0000-0000-0000-000000000003', 'L1', now() + interval '1 second', sha256('snapshot-1'), 'READY_WITH_LOSSES', 'v1');
SELECT pg_temp.ok('migration with consent and fresh identical check', $q$
  UPDATE tenant_data.offer_mapping SET ebay_migration_status = 'MIGRATION_STARTED' WHERE offer_mapping_id = 'ad000000-0000-0000-0000-000000000001' $q$);
UPDATE tenant_data.offer_mapping SET ebay_migration_status = 'MIGRATED', status = 'ACTIVE' WHERE offer_mapping_id = 'ad000000-0000-0000-0000-000000000001';
SELECT pg_temp.expect_fail('un-migrate (irreversible)', $q$
  UPDATE tenant_data.offer_mapping SET ebay_migration_status = 'REQUIRED' WHERE offer_mapping_id = 'ad000000-0000-0000-0000-000000000001' $q$);
COMMIT;

BEGIN;
SELECT set_config('app.tenant_id', :tA, true) \gset
INSERT INTO tenant_data.stock_allocation (tenant_id, scope_type, channel_account_id, buffer_units, version, created_by_membership_id)
VALUES (:tA, 'CHANNEL_ACCOUNT', 'a4000000-0000-0000-0000-000000000003', 1, 1, :mA);
INSERT INTO tenant_data.write_scope (tenant_id, write_scope_id, channel_account_id, channel, field, product_id, capability_id, capability_version, scope_kind, scope_key, budget_scope_key, quantity_sync_enabled)
VALUES (:tA, 'a6000000-0000-0000-0000-000000000003', 'a4000000-0000-0000-0000-000000000003', 'EBAY', 'QUANTITY', 'a5000000-0000-0000-0000-000000000001',
        'c0000000-0000-0000-0000-000000000004', 1, 'ACCOUNT_INVENTORY_SKU', '["A-1"]', 'L1', true);
UPDATE tenant_data.offer_mapping SET quantity_write_scope_id = 'a6000000-0000-0000-0000-000000000003' WHERE offer_mapping_id = 'ad000000-0000-0000-0000-000000000001';
INSERT INTO tenant_data.channel_write (tenant_id, channel_write_id, write_scope_id, field, quantity, version, origin, budget_scope_key, budget_day)
VALUES (:tA, 'a9000000-0000-0000-0000-000000000011', 'a6000000-0000-0000-0000-000000000003', 'QUANTITY', 5, 1, 'STOCK_RECALC', 'L1', (now() AT TIME ZONE 'Europe/Berlin')::date);
SELECT pg_temp.expect_fail('increase uses reserved margin (241 > 240) (Р-19)', $q$
  UPDATE tenant_data.channel_write SET status = 'DISPATCHED', attempt_count = 241 WHERE channel_write_id = 'a9000000-0000-0000-0000-000000000011' $q$);
UPDATE tenant_data.channel_write SET status = 'DISPATCHED', attempt_count = 200 WHERE channel_write_id = 'a9000000-0000-0000-0000-000000000011';
UPDATE tenant_data.channel_write SET status = 'ACCEPTED' WHERE channel_write_id = 'a9000000-0000-0000-0000-000000000011';
INSERT INTO tenant_data.channel_write (tenant_id, channel_write_id, write_scope_id, field, quantity, version, origin, budget_scope_key, budget_day)
VALUES (:tA, 'a9000000-0000-0000-0000-000000000012', 'a6000000-0000-0000-0000-000000000003', 'QUANTITY', 3, 2, 'STOCK_RECALC', 'L1', (now() AT TIME ZONE 'Europe/Berlin')::date);
SELECT pg_temp.ok('decrease may use margin: 200 + 50 = 250', $q$
  UPDATE tenant_data.channel_write SET status = 'DISPATCHED', attempt_count = 50 WHERE channel_write_id = 'a9000000-0000-0000-0000-000000000012' $q$);
SELECT pg_temp.expect_fail('failed retry beyond 250 (all attempts count)', $q$
  UPDATE tenant_data.channel_write SET attempt_count = 51 WHERE channel_write_id = 'a9000000-0000-0000-0000-000000000012' $q$);
COMMIT;

-- ---------------------------------------------------------------- Р-57, Р-58, OQ-98 (0034)
BEGIN;
SELECT set_config('app.tenant_id', :tA, true), set_config('app.user_id', :uA, true) \gset
SELECT pg_temp.ok('USD price write scope with sales tax regime (Р-57)', $q$
  INSERT INTO tenant_data.write_scope (tenant_id, write_scope_id, channel_account_id, channel, field, product_id, capability_id, capability_version,
    scope_kind, scope_key, currency, price_basis, tax_regime, pricing_mode)
  VALUES ('a0000000-0000-0000-0000-00000000000a', 'a6000000-0000-0000-0000-0000000000e1', 'a4000000-0000-0000-0000-000000000001', 'KAUFLAND', 'PRICE', 'a5000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001', 1, 'ACCOUNT_STOREFRONT_UNIT',
    tenant_data.derive_scope_key('{"marketplace":"de","external_unit_id":"U-USD"}', ARRAY['channel_account','marketplace','external_unit_id']),
    'USD', 'NET', 'SALES_TAX_EXCLUDED', 'OFF') $q$);
SELECT pg_temp.expect_fail('USD write scope attached to a EUR gross storefront (Р-57, Р-58)', $q$
  INSERT INTO tenant_data.offer_mapping (tenant_id, product_id, channel_account_id, channel, marketplace, channel_offer_key, external_unit_id, status, price_write_scope_id)
  VALUES ('a0000000-0000-0000-0000-00000000000a', 'a5000000-0000-0000-0000-000000000001', 'a4000000-0000-0000-0000-000000000001', 'KAUFLAND', 'de', 'U-USD', 'U-USD', 'ACTIVE', 'a6000000-0000-0000-0000-0000000000e1') $q$);
SELECT pg_temp.expect_fail('net price basis with VAT regime (Р-58)', $q$
  INSERT INTO tenant_data.write_scope (tenant_id, channel_account_id, channel, field, product_id, capability_id, capability_version,
    scope_kind, scope_key, currency, price_basis, tax_regime, pricing_mode)
  VALUES ('a0000000-0000-0000-0000-00000000000a', 'a4000000-0000-0000-0000-000000000001', 'KAUFLAND', 'PRICE', 'a5000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001', 1, 'ACCOUNT_STOREFRONT_UNIT',
    tenant_data.derive_scope_key('{"marketplace":"de","external_unit_id":"U-BAD"}', ARRAY['channel_account','marketplace','external_unit_id']),
    'EUR', 'NET', 'VAT_INCLUDED', 'OFF') $q$);
SELECT pg_temp.expect_fail('price write scope without tax regime (Р-58)', $q$
  INSERT INTO tenant_data.write_scope (tenant_id, channel_account_id, channel, field, product_id, capability_id, capability_version,
    scope_kind, scope_key, currency, price_basis, pricing_mode)
  VALUES ('a0000000-0000-0000-0000-00000000000a', 'a4000000-0000-0000-0000-000000000001', 'KAUFLAND', 'PRICE', 'a5000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001', 1, 'ACCOUNT_STOREFRONT_UNIT',
    tenant_data.derive_scope_key('{"marketplace":"de","external_unit_id":"U-NOTAX"}', ARRAY['channel_account','marketplace','external_unit_id']),
    'EUR', 'GROSS', 'OFF') $q$);
SELECT pg_temp.expect_fail('currency outside EUR and USD', $q$
  INSERT INTO tenant_data.write_scope (tenant_id, channel_account_id, channel, field, product_id, capability_id, capability_version,
    scope_kind, scope_key, currency, price_basis, tax_regime, pricing_mode)
  VALUES ('a0000000-0000-0000-0000-00000000000a', 'a4000000-0000-0000-0000-000000000001', 'KAUFLAND', 'PRICE', 'a5000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001', 1, 'ACCOUNT_STOREFRONT_UNIT',
    tenant_data.derive_scope_key('{"marketplace":"de","external_unit_id":"U-PLN"}', ARRAY['channel_account','marketplace','external_unit_id']),
    'PLN', 'GROSS', 'VAT_INCLUDED', 'OFF') $q$);
SELECT pg_temp.expect_fail('VAT rate for a sales tax country (Р-58)', $q$
  INSERT INTO tenant_data.product_vat_rate (tenant_id, product_id, country, rate_bp, version, created_by_membership_id)
  VALUES ('a0000000-0000-0000-0000-00000000000a', 'a5000000-0000-0000-0000-000000000001', 'US', 800, 1, 'a2000000-0000-0000-0000-00000000000a') $q$);
DO $$ BEGIN
  IF (SELECT count(*) FROM platform.marketplace WHERE tax_regime = 'SALES_TAX_EXCLUDED') < 2 THEN RAISE EXCEPTION 'US storefronts missing'; END IF;
  RAISE NOTICE 'PASS accept | storefront reference: EU gross with VAT, US net with sales tax (Р-58)';
END $$;
ROLLBACK;
