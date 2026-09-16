-- Р-96, Р-94: роль пути решения (svc_app, член repracer_app) после smoke_app.sql и smoke_admin.sql. Путь решения может только то, что нужно
-- для вычисления и записи цены (security.decision_path_allowed_privileges()); каждое прочее действие отклоняется ИМЕННО отсутствием права
-- на названную таблицу или функцию. Шаг 18 (Р-94, находка 6 ревью шага 17): SQLSTATE 42501 недостаточно — его дают и защитные
-- триггеры (insufficient_privilege) и чтение чужой таблицы внутри стража; причина — текст «permission denied for table <имя>». Всё откатывается.
-- Данные синтетические.
\set ON_ERROR_STOP 1
\set QUIET 1

CREATE FUNCTION pg_temp.expect_fail(label text, q text, reason text DEFAULT NULL) RETURNS void LANGUAGE plpgsql AS $$
-- Р-94: reason — ожидаемая причина отказа (SQLSTATE или шаблон сообщения); отказ по другой причине — провал проверки.
-- Р-95: при repracer.smoke_collect = on (мутационная проверка) провал не останавливает прогон, а пишется предупреждением CHECK FAILED.
DECLARE
  failure text;
BEGIN
  BEGIN
    EXECUTE q;
    RAISE EXCEPTION 'did not happen' USING ERRCODE = 'RS001';
  EXCEPTION
    WHEN SQLSTATE 'RS001' THEN
      failure := 'EXPECTED FAILURE DID NOT HAPPEN';
    WHEN others THEN
      -- Р-94 (шаг 18): причина обязательна и сверяется с текстом отказа — SQLSTATE недостаточно (42501 дают и защитные триггеры)
      IF reason IS NOT NULL AND SQLERRM ~* reason THEN
        RAISE NOTICE 'PASS reject | % | %', label, left(SQLERRM, 110);
        RETURN;
      END IF;
      failure := CASE WHEN reason IS NULL THEN format('EXPECTED FAILURE HAS NO DECLARED REASON (got %s %s)', SQLSTATE, left(SQLERRM, 160))
                      ELSE format('EXPECTED FAILURE HAD ANOTHER REASON (expected %s, got %s %s)', reason, SQLSTATE, left(SQLERRM, 160)) END;
  END;
  IF current_setting('repracer.smoke_collect', true) = 'on' THEN
    RAISE WARNING 'CHECK FAILED: % | %', label, failure;
  ELSE
    RAISE EXCEPTION '%: %', failure, label;
  END IF;
END $$;

BEGIN;
-- Пользователь сессии и второй фактор заявлены — у роли пути решения база их не принимает (Р-90)
SELECT set_config('app.tenant_id', 'a0000000-0000-0000-0000-00000000000a', true), set_config('app.user_id', 'a1000000-0000-0000-0000-00000000000a', true),
       set_config('app.auth_mfa', 'on', true) \gset
DO $$ BEGIN
  IF security.current_user_id() IS NOT NULL OR security.session_mfa() THEN
    RAISE EXCEPTION 'the decision path role is trusted with a session user or a second factor'; END IF;
  RAISE NOTICE 'PASS reject | session user and second factor set by the decision path are ignored (Р-90)';
END $$;

-- ---------------------------------------------------------------- Р-96: административные действия — отсутствие права
SELECT pg_temp.expect_fail('path creates an eBay migration consent (Р-96, Р-2)', $q$
  INSERT INTO tenant_data.migration_consent (tenant_id, channel_account_id, membership_id, user_id, mfa_verified_at, disclosure_version, disclosure_text_sha256, other_tools_declaration, typed_confirmation, expires_at)
  VALUES ('a0000000-0000-0000-0000-00000000000a', 'a4000000-0000-0000-0000-000000000003', 'a2000000-0000-0000-0000-00000000000a', 'a1000000-0000-0000-0000-00000000000a', now(), 'd1', sha256('text'), 'NONE', 'I understand', now() + interval '3 days') $q$, '^permission denied for table migration_consent$');
SELECT pg_temp.expect_fail('path records a listing migration check (Р-96, Р-2)', $q$
  INSERT INTO channel_data.listing_migration_check (tenant_id, channel_account_id, listing_id, checked_at, listing_snapshot_sha256, verdict, ruleset_version)
  VALUES ('a0000000-0000-0000-0000-00000000000a', 'a4000000-0000-0000-0000-000000000003', 'L9', now(), sha256('s'), 'READY', 'v1') $q$, '^permission denied for table listing_migration_check$');
SELECT pg_temp.expect_fail('path starts a listing migration (Р-96, Р-2)', $q$
  UPDATE tenant_data.offer_mapping SET ebay_migration_status = 'MIGRATION_STARTED' WHERE offer_mapping_id = 'ad000000-0000-0000-0000-000000000001' $q$, '^permission denied for table offer_mapping$');
SELECT pg_temp.expect_fail('path opts the tenant into Kaufland Smart Pricing (Р-96, Р-12, Р-41)', $q$
  UPDATE tenant_data.tenant SET kaufland_smart_pricing_opt_in_at = now(), kaufland_smart_pricing_opt_in_by = 'a1000000-0000-0000-0000-00000000000a' $q$, '^permission denied for table tenant$');
SELECT pg_temp.expect_fail('path lowers min_price (Р-96, Р-5)', $q$
  INSERT INTO tenant_data.min_price (tenant_id, scope_type, product_id, currency, price_basis, amount_minor, version, created_by_membership_id)
  VALUES ('a0000000-0000-0000-0000-00000000000a', 'PRODUCT', 'a5000000-0000-0000-0000-000000000001', 'EUR', 'GROSS', 1, 99, 'a2000000-0000-0000-0000-00000000000a') $q$, '^permission denied for table min_price$');
SELECT pg_temp.expect_fail('path raises max_price (Р-96, Р-43)', $q$
  INSERT INTO tenant_data.max_price (tenant_id, scope_type, product_id, currency, price_basis, amount_minor, version, created_by_membership_id)
  VALUES ('a0000000-0000-0000-0000-00000000000a', 'PRODUCT', 'a5000000-0000-0000-0000-000000000001', 'EUR', 'GROSS', 999999, 99, 'a2000000-0000-0000-0000-00000000000a') $q$, '^permission denied for table max_price$');
SELECT pg_temp.expect_fail('path changes the unit cost (Р-96, Р-83)', $q$
  INSERT INTO tenant_data.cost_profile (tenant_id, product_id, version, valid_from, currency, purchase_cost_minor, source, created_by_membership_id)
  VALUES ('a0000000-0000-0000-0000-00000000000a', 'a5000000-0000-0000-0000-000000000001', 99, now(), 'EUR', 1, 'MANUAL', 'a2000000-0000-0000-0000-00000000000a') $q$, '^permission denied for table cost_profile$');
SELECT pg_temp.expect_fail('path changes the minimum margin (Р-96)', $q$
  INSERT INTO tenant_data.guardrail (tenant_id, scope_type, product_id, min_margin_bp, on_violation, version, created_by_membership_id)
  VALUES ('a0000000-0000-0000-0000-00000000000a', 'PRODUCT', 'a5000000-0000-0000-0000-000000000001', 0, 'HOLD', 99, 'a2000000-0000-0000-0000-00000000000a') $q$, '^permission denied for table guardrail$');
SELECT pg_temp.expect_fail('path changes the fee estimate (Р-96, Р-83)', $q$
  UPDATE channel_data.fee_estimate SET fee_model = '{"feeRateBp": 0, "fixedFeeMinor": 0}' $q$, '^permission denied for table fee_estimate$');
SELECT pg_temp.expect_fail('path creates a strategy version (Р-96)', $q$
  INSERT INTO tenant_data.pricing_strategy (tenant_id, pricing_strategy_id, version, name, type, params, triggers, status, created_by_membership_id)
  VALUES ('a0000000-0000-0000-0000-00000000000a', 'a9000000-0000-0000-0000-000000000001', 2, 'forged', 'FIXED', '{"type":"FIXED","priceMinor":1,"deadbandMinor":0}', ARRAY['SCHEDULE'], 'ACTIVE', 'a2000000-0000-0000-0000-00000000000a') $q$, '^permission denied for table pricing_strategy$');
SELECT pg_temp.expect_fail('path switches a write scope to another pricing mode (Р-96)', $q$
  UPDATE tenant_data.write_scope SET pricing_mode = 'OFF' WHERE write_scope_id = 'a6000000-0000-0000-0000-000000000001' $q$, '^permission denied for table write_scope$');
SELECT pg_temp.expect_fail('path connects a channel account (Р-96)', $q$
  INSERT INTO tenant_data.channel_account (tenant_id, channel, external_account_id, credentials_ref, connected_by_membership_id)
  VALUES ('a0000000-0000-0000-0000-00000000000a', 'KAUFLAND', 'forged', 'vault://forged', 'a2000000-0000-0000-0000-00000000000a') $q$, '^permission denied for table channel_account$');
SELECT pg_temp.expect_fail('path creates a product (Р-96)', $q$
  INSERT INTO tenant_data.product (tenant_id, sku, kind) VALUES ('a0000000-0000-0000-0000-00000000000a', 'forged', 'SIMPLE') $q$, '^permission denied for table product$');
SELECT pg_temp.expect_fail('path moves stock (Р-96)', $q$
  INSERT INTO tenant_data.stock_movement (tenant_id, stock_pool_id, delta, reason, occurred_at) SELECT tenant_id, stock_pool_id, 1, 'ADJUSTMENT', now() FROM tenant_data.stock_pool LIMIT 1 $q$, '^permission denied for table stock_movement$');
SELECT pg_temp.expect_fail('path schedules the review of a halt (finding 2 ревью шага 16)', $q$
  UPDATE channel_data.pricing_halt SET next_review_at = now() - interval '1 second' $q$, '^permission denied for table pricing_halt$');
SELECT pg_temp.expect_fail('path writes an automatic halt review (finding 2 ревью шага 16)', $q$
  INSERT INTO channel_data.pricing_halt_review (tenant_id, pricing_halt_id, kind, outcome, sample_size, failed_count)
  SELECT tenant_id, pricing_halt_id, 'AUTO_SAMPLE', 'RELEASED', 1, 0 FROM channel_data.pricing_halt LIMIT 1 $q$, '^permission denied for table pricing_halt_review$');

-- ---------------------------------------------------------------- Находка 4 ревью шага 17 (0068): действия человека в таблицах пути решения
SELECT pg_temp.expect_fail('path unblocks a write scope (step 17 finding 4)', $q$
  UPDATE tenant_data.write_scope SET status = 'BLOCKED' WHERE write_scope_id = 'a6000000-0000-0000-0000-000000000001';
  UPDATE tenant_data.write_scope SET status = 'ACTIVE' WHERE write_scope_id = 'a6000000-0000-0000-0000-000000000001' $q$, 'only blocks an active write scope');
SELECT pg_temp.expect_fail('path holds a write scope (step 17 finding 4)', $q$
  UPDATE tenant_data.write_scope SET status = 'HELD' WHERE write_scope_id = 'a6000000-0000-0000-0000-000000000001' $q$, 'only blocks an active write scope');
SELECT pg_temp.expect_fail('path inserts a halt released by a person (step 17 finding 4)', $q$
  INSERT INTO channel_data.pricing_halt (tenant_id, channel_account_id, channel, marketplace, reason_code, halted_at, released_at, released_kind, released_by_membership_id, release_note)
  VALUES ('a0000000-0000-0000-0000-00000000000a', 'a4000000-0000-0000-0000-000000000001', 'KAUFLAND', 'at', 'CHANNEL_MASS_SHIFT', now(), now(), 'MANUAL', 'a2000000-0000-0000-0000-00000000000a', 'owner verified the data') $q$,
  '^permission denied for table pricing_halt$');
SELECT pg_temp.expect_fail('path resolves a divergence case for a person (step 17 finding 4)', $q$
  UPDATE channel_data.divergence_case SET status = 'RESOLVED', resolution = 'KEEP_OURS', resolved_by_membership_id = 'a2000000-0000-0000-0000-00000000000a' $q$,
  '^permission denied for table divergence_case$');

-- ---------------------------------------------------------------- Р-90 (шаг 16): аудит, членства, тенанты, пользователи, вход
SELECT pg_temp.expect_fail('path reads the audit log (Р-96)', $q$ SELECT count(*) FROM audit.audit_event $q$, '^permission denied for table audit_event$');
SELECT pg_temp.expect_fail('path forges an audit event (finding 5, Р-90)', $q$
  INSERT INTO audit.audit_event (tenant_id, occurred_at, actor_type, actor_user_id, actor_membership_id, action, entity_type)
  VALUES ('a0000000-0000-0000-0000-00000000000a', now(), 'USER', 'a1000000-0000-0000-0000-00000000000a', 'a2000000-0000-0000-0000-00000000000a', 'pricing.stop_released', 'price_stop') $q$, '^permission denied for table audit_event$');
SELECT pg_temp.expect_fail('path reads memberships (Р-96)', $q$ SELECT count(*) FROM tenant_data.membership $q$, '^permission denied for table membership$');
SELECT pg_temp.expect_fail('path inserts an OWNER membership (finding 2, Р-90)', $q$
  INSERT INTO tenant_data.membership (tenant_id, user_id, role, status) VALUES ('a0000000-0000-0000-0000-00000000000a', 'b1000000-0000-0000-0000-00000000000b', 'OWNER', 'ACTIVE') $q$, '^permission denied for table membership$');
SELECT pg_temp.expect_fail('path activates a membership (finding 3, Р-90)', $q$
  UPDATE tenant_data.membership SET status = 'ACTIVE' WHERE membership_id = 'a2000000-0000-0000-0000-0000000000a0' $q$, '^permission denied for table membership$');
SELECT pg_temp.expect_fail('path creates a tenant (Р-90)', $q$ INSERT INTO tenant_data.tenant (name, data_region) VALUES ('forged', 'EU') $q$, '^permission denied for table tenant$');
SELECT pg_temp.expect_fail('path creates a user (Р-90)', $q$ INSERT INTO platform.app_user (user_id, email) VALUES (gen_random_uuid(), 'forged@example.test') $q$, '^permission denied for table app_user$');
SELECT pg_temp.expect_fail('path stops pricing as a person (Р-90)', $q$
  INSERT INTO tenant_data.price_stop (tenant_id, scope_type, stopped_by_membership_id, stop_note) VALUES ('a0000000-0000-0000-0000-00000000000a', 'TENANT', 'a2000000-0000-0000-0000-00000000000a', 'forged stop by the decision path') $q$, '^permission denied for table price_stop$');
SELECT pg_temp.expect_fail('path invites a member (Р-90)', $q$
  SELECT security.invite_member('a0000000-0000-0000-0000-00000000000a', 'x@example.test', 'VIEWER', sha256('x'), interval '1 day') $q$, '^permission denied for function invite_member$');
SELECT pg_temp.expect_fail('path provisions a tenant (Р-90)', $q$ SELECT security.provision_tenant(gen_random_uuid(), 'x', 'EU', '[]') $q$, '^permission denied for function provision_tenant$');
SELECT pg_temp.expect_fail('path lists the tenants of a user (finding 13, Р-90)', $q$
  SELECT * FROM security.list_user_tenants('a1000000-0000-0000-0000-00000000000a') $q$, '^permission denied for function list_user_tenants$');
SELECT pg_temp.expect_fail('path resolves an external identity (finding 13, Р-90)', $q$
  SELECT * FROM security.resolve_external_identity('https://idp.example.test', 'subject') $q$, '^permission denied for function resolve_external_identity$');
SELECT pg_temp.expect_fail('path assumes the administrative role (Р-90)', $q$ SET ROLE repracer_admin $q$, '^permission denied to set role "repracer_admin"');

-- ---------------------------------------------------------------- Р-96: разрешённое остаётся доступным (контроль)
DO $$
DECLARE
  n int;
BEGIN
  SELECT count(*) INTO n FROM tenant_data.write_scope;
  SELECT count(*) INTO n FROM tenant_data.min_price;
  SELECT count(*) INTO n FROM channel_data.competitor_state;
  RAISE NOTICE 'PASS accept | the decision path reads the decision context (Р-96)';
END $$;
ROLLBACK;
