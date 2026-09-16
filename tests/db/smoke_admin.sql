-- Р-90, Р-88, находки 2, 3, 5, 9, 12 ревью шага 15: административный сервис (svc_admin, член repracer_admin) после smoke_app.sql.
-- Только у его сессии база принимает пользователя сессии и второй фактор; но и у него нет прямой вставки членства и событий аудита,
-- активации членства мимо приглашения и назначения владельца администратором. Всё откатывается. Данные синтетические.
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
    SET CONSTRAINTS ALL IMMEDIATE;
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

CREATE FUNCTION pg_temp.ok(label text, q text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE q;
  SET CONSTRAINTS ALL IMMEDIATE;
  RAISE NOTICE 'PASS accept | %', label;
END $$;

BEGIN;
SELECT set_config('app.tenant_id', 'a0000000-0000-0000-0000-00000000000a', true), set_config('app.user_id', 'a1000000-0000-0000-0000-00000000000a', true) \gset

-- ---------------------------------------------------------------- находка 12: ручное снятие системной остановки
INSERT INTO channel_data.pricing_halt (tenant_id, pricing_halt_id, channel_account_id, channel, marketplace, reason_code, details)
VALUES ('a0000000-0000-0000-0000-00000000000a', 'ab000000-0000-0000-0000-000000000090', 'a4000000-0000-0000-0000-000000000001', 'KAUFLAND', 'de', 'CHANNEL_MASS_SHIFT', '{"sameDirection": 20}');
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM audit.audit_event WHERE entity_id = 'ab000000-0000-0000-0000-000000000090' AND action = 'pricing.halt_created' AND actor_type = 'SYSTEM') THEN
    RAISE EXCEPTION 'the system halt is not in the audit log'; END IF;
  RAISE NOTICE 'PASS accept | the system halt is written to the audit log by the trigger (Р-76)';
END $$;
SELECT pg_temp.expect_fail('manual halt release without a second factor (finding 12, Р-88)', $q$
  DO $x$ BEGIN
    INSERT INTO channel_data.pricing_halt_review (tenant_id, pricing_halt_id, kind, outcome, sample_size, failed_count, membership_id, note)
    VALUES ('a0000000-0000-0000-0000-00000000000a', 'ab000000-0000-0000-0000-000000000090', 'MANUAL_RELEASE', 'RELEASED', 0, 0, 'a2000000-0000-0000-0000-00000000000a', 'data verified with the channel');
    UPDATE channel_data.pricing_halt SET released_at = now(), released_kind = 'MANUAL', released_by_membership_id = 'a2000000-0000-0000-0000-00000000000a', release_note = 'data verified with the channel'
     WHERE pricing_halt_id = 'ab000000-0000-0000-0000-000000000090';
  END $x$ $q$, 'requires a second factor');
SELECT set_config('app.auth_mfa', 'on', true) \gset
SET CONSTRAINTS ALL DEFERRED;
INSERT INTO channel_data.pricing_halt_review (tenant_id, pricing_halt_id, kind, outcome, sample_size, failed_count, membership_id, note)
VALUES ('a0000000-0000-0000-0000-00000000000a', 'ab000000-0000-0000-0000-000000000090', 'MANUAL_RELEASE', 'RELEASED', 0, 0, 'a2000000-0000-0000-0000-00000000000a', 'data verified with the channel');
SELECT pg_temp.ok('manual halt release by a member with a second factor, a note and a journal record (Р-52, Р-88)', $q$
  UPDATE channel_data.pricing_halt SET released_at = now(), released_kind = 'MANUAL', released_by_membership_id = 'a2000000-0000-0000-0000-00000000000a', release_note = 'data verified with the channel'
   WHERE pricing_halt_id = 'ab000000-0000-0000-0000-000000000090' $q$);
SELECT pg_temp.expect_fail('release twice', $q$
  UPDATE channel_data.pricing_halt SET release_note = 'released again later' WHERE pricing_halt_id = 'ab000000-0000-0000-0000-000000000090' $q$, 'is already released');
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM audit.audit_event WHERE entity_id = 'ab000000-0000-0000-0000-000000000090' AND action = 'pricing.halt_released'
                  AND actor_type = 'USER' AND actor_user_id = 'a1000000-0000-0000-0000-00000000000a') THEN
    RAISE EXCEPTION 'the manual release is not in the audit log with its author'; END IF;
  RAISE NOTICE 'PASS accept | the audit event of the release is written by the trigger with the session user as author (Р-76)';
END $$;

-- ---------------------------------------------------------------- Р-69, Р-94: остановка тенанта человеком — решение и отправка отклоняются ею
SAVEPOINT stop_check;
-- Единица цены тенанта A после smoke_app.sql — в режиме Smart Pricing; для проверки она возвращается в движок со стратегией (откатывается)
UPDATE tenant_data.channel_write SET status = 'DISCARDED_STALE', end_reason = 'WRITE_PRICING_MODE_CHANGED', end_params = '{"mode": "OFF"}'
 WHERE write_scope_id = 'a6000000-0000-0000-0000-000000000001' AND status IN ('PENDING', 'FAILED', 'BLOCKED');
UPDATE tenant_data.write_scope SET pricing_mode = 'OFF' WHERE write_scope_id = 'a6000000-0000-0000-0000-000000000001';
UPDATE tenant_data.write_scope SET pricing_strategy_id = 'a9000000-0000-0000-0000-000000000001', pricing_strategy_version = 1, pricing_mode = 'ENGINE'
 WHERE write_scope_id = 'a6000000-0000-0000-0000-000000000001';
INSERT INTO channel_data.price_intent (tenant_id, price_intent_id, created_at, write_scope_id, created_by_membership_id, trigger_type, proposed_amount_minor, currency, price_basis, expires_at, rule_code)
VALUES ('a0000000-0000-0000-0000-00000000000a', 'a7000000-0000-0000-0000-000000000090', now(), 'a6000000-0000-0000-0000-000000000001', 'a2000000-0000-0000-0000-00000000000a', 'MANUAL', 1300, 'EUR', 'GROSS', now() + interval '10 minutes', 'MANUAL'),
       ('a0000000-0000-0000-0000-00000000000a', 'a7000000-0000-0000-0000-000000000091', now(), 'a6000000-0000-0000-0000-000000000001', 'a2000000-0000-0000-0000-00000000000a', 'MANUAL', 1310, 'EUR', 'GROSS', now() + interval '10 minutes', 'MANUAL');
INSERT INTO channel_data.price_decision (tenant_id, price_decision_id, intent_created_at, price_intent_id, write_scope_id, outcome, final_amount_minor, currency, price_basis, effective_floor_minor, min_price_ids, effective_ceiling_minor, max_price_ids, explanation, sanity_ruleset, gate_profile)
SELECT tenant_id, 'a8000000-0000-0000-0000-000000000090', created_at, price_intent_id, write_scope_id, 'APPROVED', 1300, 'EUR', 'GROSS', 1000, ARRAY[gen_random_uuid()], 5000, ARRAY[gen_random_uuid()],
       '{"format":"r80.1","snapshot":{"source":"KAUFLAND_BUYBOX"},"sanity":{"anchorsUsed":[],"checks":[]},"strategy":{"reason":{"code":"FIXED_PRICE"}}}', 'r49.1', 'g74.1'
  FROM channel_data.price_intent WHERE price_intent_id = 'a7000000-0000-0000-0000-000000000090';
INSERT INTO tenant_data.channel_write (tenant_id, channel_write_id, write_scope_id, field, amount_minor, currency, price_basis, version, origin, price_decision_id)
SELECT 'a0000000-0000-0000-0000-00000000000a', 'a9000000-0000-0000-0000-000000000090', 'a6000000-0000-0000-0000-000000000001', 'PRICE', 1300, 'EUR', 'GROSS', ss.latest_version_created + 1, 'PRICE_DECISION', 'a8000000-0000-0000-0000-000000000090'
  FROM tenant_data.write_scope_sync_state ss WHERE ss.write_scope_id = 'a6000000-0000-0000-0000-000000000001';
INSERT INTO tenant_data.price_stop (tenant_id, scope_type, stopped_by_membership_id, stop_note)
VALUES ('a0000000-0000-0000-0000-00000000000a', 'TENANT', 'a2000000-0000-0000-0000-00000000000a', 'smoke stop of the whole tenant');
SELECT pg_temp.expect_fail('approval while the tenant is stopped by a person (Р-69)', $q$
  INSERT INTO channel_data.price_decision (tenant_id, intent_created_at, price_intent_id, write_scope_id, outcome, final_amount_minor, currency, price_basis, effective_floor_minor, min_price_ids, effective_ceiling_minor, max_price_ids, explanation, sanity_ruleset, gate_profile)
  SELECT tenant_id, created_at, price_intent_id, write_scope_id, 'APPROVED', 1310, 'EUR', 'GROSS', 1000, ARRAY[gen_random_uuid()], 5000, ARRAY[gen_random_uuid()],
         '{"format":"r80.1","snapshot":{"source":"KAUFLAND_BUYBOX"},"sanity":{"anchorsUsed":[],"checks":[]},"strategy":{"reason":{"code":"FIXED_PRICE"}}}', 'r49.1', 'g74.1'
    FROM channel_data.price_intent WHERE price_intent_id = 'a7000000-0000-0000-0000-000000000091' $q$,
  'pricing is stopped by price_stop');
SELECT pg_temp.expect_fail('dispatch while the tenant is stopped by a person (Р-69)', $q$
  UPDATE tenant_data.channel_write SET status = 'DISPATCHED', attempt_count = attempt_count + 1 WHERE channel_write_id = 'a9000000-0000-0000-0000-000000000090' $q$,
  'pricing is stopped by price_stop');
ROLLBACK TO SAVEPOINT stop_check;

-- ---------------------------------------------------------------- находки 2, 3, 5: прямых прав нет и у административного сервиса
SELECT pg_temp.expect_fail('insert an OWNER membership directly (finding 2, Р-90)', $q$
  INSERT INTO tenant_data.membership (tenant_id, user_id, role, status) VALUES ('a0000000-0000-0000-0000-00000000000a', 'b1000000-0000-0000-0000-00000000000b', 'OWNER', 'ACTIVE') $q$, '^permission denied for table membership$');
SELECT pg_temp.expect_fail('forge an audit event (finding 5, Р-90)', $q$
  INSERT INTO audit.audit_event (tenant_id, occurred_at, actor_type, actor_user_id, actor_membership_id, action, entity_type)
  VALUES ('a0000000-0000-0000-0000-00000000000a', now(), 'USER', 'a1000000-0000-0000-0000-0000000000a0', 'a2000000-0000-0000-0000-0000000000a0', 'pricing.stop_released', 'price_stop') $q$, '^permission denied for table audit_event$');
SELECT set_config('app.user_id', 'a1000000-0000-0000-0000-00000000000a', true) \gset
CREATE TEMP TABLE invited AS SELECT * FROM security.invite_member('a0000000-0000-0000-0000-00000000000a', 'invited-a@example.test', 'PRICING_MANAGER', sha256('smoke-invite'), interval '1 day');
DO $$ BEGIN RAISE NOTICE 'PASS accept | owner with a second factor invites a member (Р-88)'; END $$;
SELECT pg_temp.expect_fail('activate an invited membership without accepting the invitation (finding 3)', $q$
  UPDATE tenant_data.membership SET status = 'ACTIVE' WHERE membership_id = (SELECT membership_id FROM invited) $q$, 'becomes active only by accepting its invitation');

-- ---------------------------------------------------------------- находка 9: владельца назначает только владелец
SELECT set_config('app.user_id', 'a1000000-0000-0000-0000-0000000000ad', true) \gset
SELECT pg_temp.expect_fail('an admin promotes an operator to owner (finding 9)', $q$
  UPDATE tenant_data.membership SET role = 'OWNER' WHERE membership_id = 'a2000000-0000-0000-0000-0000000000a0' $q$, 'only an owner grants, removes or revokes the owner role');
SELECT pg_temp.expect_fail('an admin grants the admin role (finding 9)', $q$
  UPDATE tenant_data.membership SET role = 'ADMIN' WHERE membership_id = 'a2000000-0000-0000-0000-0000000000a0' $q$, 'an admin does not grant, remove or revoke the admin role');
SELECT pg_temp.expect_fail('an admin demotes the owner (finding 9)', $q$
  UPDATE tenant_data.membership SET role = 'VIEWER' WHERE membership_id = 'a2000000-0000-0000-0000-00000000000a' $q$, 'only an owner grants, removes or revokes the owner role');
SELECT pg_temp.ok('an admin changes an operator to pricing manager with a second factor (Р-88)', $q$
  UPDATE tenant_data.membership SET role = 'PRICING_MANAGER' WHERE membership_id = 'a2000000-0000-0000-0000-0000000000a0' $q$);
SELECT set_config('app.auth_mfa', '', true) \gset
SELECT pg_temp.expect_fail('role change without a second factor (Р-88)', $q$
  UPDATE tenant_data.membership SET role = 'OPERATOR' WHERE membership_id = 'a2000000-0000-0000-0000-0000000000a0' $q$, 'changing a role or revoking access requires a second factor');
SELECT set_config('app.auth_mfa', 'on', true), set_config('app.user_id', 'a1000000-0000-0000-0000-00000000000a', true) \gset
SELECT pg_temp.ok('the owner revokes the admin with a second factor', $q$
  UPDATE tenant_data.membership SET status = 'REVOKED', revoked_at = now() WHERE membership_id = 'a2000000-0000-0000-0000-0000000000ad' $q$);
SELECT pg_temp.expect_fail('a revoked membership is restored', $q$
  UPDATE tenant_data.membership SET status = 'ACTIVE', revoked_at = NULL WHERE membership_id = 'a2000000-0000-0000-0000-0000000000ad' $q$, 'is not restored; invite the user again');
DO $$ BEGIN
  IF (SELECT count(*) FROM audit.audit_event WHERE entity_type = 'membership' AND action IN ('membership.role_changed', 'membership.status_changed')) < 2 THEN
    RAISE EXCEPTION 'role and access changes are not in the audit log'; END IF;
  RAISE NOTICE 'PASS accept | role change and revocation are written to the audit log by the trigger (Р-90)';
END $$;
ROLLBACK;

-- ---------------------------------------------------------------- Р-97 (0066): административная запись — только от человека, в аудите
BEGIN;
SELECT set_config('app.tenant_id', 'a0000000-0000-0000-0000-00000000000a', true), set_config('app.user_id', '', true) \gset
SELECT pg_temp.expect_fail('administrative change without a person (Р-97)', $q$
  INSERT INTO tenant_data.product (tenant_id, product_id, sku, kind) VALUES ('a0000000-0000-0000-0000-00000000000a', 'a3970000-0000-0000-0000-000000000001', 'R97-SKU', 'SIMPLE') $q$,
  'without a person');
SELECT set_config('app.user_id', 'b1000000-0000-0000-0000-00000000000b', true) \gset
SELECT pg_temp.expect_fail('administrative change by a user outside the tenant (Р-97)', $q$
  INSERT INTO tenant_data.product (tenant_id, product_id, sku, kind) VALUES ('a0000000-0000-0000-0000-00000000000a', 'a3970000-0000-0000-0000-000000000001', 'R97-SKU', 'SIMPLE') $q$,
  'not an active member of tenant');
SELECT set_config('app.user_id', 'a1000000-0000-0000-0000-00000000000a', true) \gset
INSERT INTO tenant_data.product (tenant_id, product_id, sku, kind) VALUES ('a0000000-0000-0000-0000-00000000000a', 'a3970000-0000-0000-0000-000000000001', 'R97-SKU', 'SIMPLE');
DO $$ BEGIN
  RAISE NOTICE 'REACHED | administrative change audited (Р-97)';
  IF NOT EXISTS (SELECT 1 FROM audit.audit_event WHERE entity_type = 'tenant_data.product' AND action = 'admin_change.insert'
                    AND entity_id = 'a3970000-0000-0000-0000-000000000001' AND actor_user_id = 'a1000000-0000-0000-0000-00000000000a') THEN
    RAISE EXCEPTION 'an administrative change is not in the audit log (Р-97)'; END IF;
  RAISE NOTICE 'PASS accept | administrative change by a person is written to the audit log (Р-97)';
END $$;
ROLLBACK;

-- ---------------------------------------------------------------- Шаг 18 (0068): Р-101, Р-100, находки 1, 5, 9 ревью шага 17
BEGIN;
-- Р-101: согласие на миграцию eBay — только владелец, от своего имени, со вторым фактором сессии
SELECT set_config('app.tenant_id', 'a0000000-0000-0000-0000-00000000000a', true), set_config('app.user_id', 'a1000000-0000-0000-0000-0000000000a0', true),
       set_config('app.auth_mfa', 'on', true) \gset
SELECT pg_temp.expect_fail('eBay consent in the name of the owner by another member (Р-101)', $q$
  INSERT INTO tenant_data.migration_consent (tenant_id, channel_account_id, membership_id, user_id, mfa_verified_at, disclosure_version, disclosure_text_sha256, other_tools_declaration, typed_confirmation, expires_at)
  VALUES ('a0000000-0000-0000-0000-00000000000a', 'a4000000-0000-0000-0000-000000000003', 'a2000000-0000-0000-0000-00000000000a', 'a1000000-0000-0000-0000-00000000000a', now(), 'd1', sha256('text'), 'NONE', 'I understand', now() + interval '3 days') $q$,
  'only by the session user in their own name');
SELECT set_config('app.user_id', 'a1000000-0000-0000-0000-0000000000ad', true) \gset
SELECT pg_temp.expect_fail('eBay consent by an admin in their own name (Р-101)', $q$
  INSERT INTO tenant_data.migration_consent (tenant_id, channel_account_id, membership_id, user_id, mfa_verified_at, disclosure_version, disclosure_text_sha256, other_tools_declaration, typed_confirmation, expires_at)
  VALUES ('a0000000-0000-0000-0000-00000000000a', 'a4000000-0000-0000-0000-000000000003', 'a2000000-0000-0000-0000-0000000000ad', 'a1000000-0000-0000-0000-0000000000ad', now(), 'd1', sha256('text'), 'NONE', 'I understand', now() + interval '3 days') $q$,
  'requires an ACTIVE OWNER');
SELECT set_config('app.user_id', 'a1000000-0000-0000-0000-00000000000a', true), set_config('app.auth_mfa', '', true) \gset
SELECT pg_temp.expect_fail('eBay consent by the owner without a second factor (Р-101)', $q$
  INSERT INTO tenant_data.migration_consent (tenant_id, channel_account_id, membership_id, user_id, mfa_verified_at, disclosure_version, disclosure_text_sha256, other_tools_declaration, typed_confirmation, expires_at)
  VALUES ('a0000000-0000-0000-0000-00000000000a', 'a4000000-0000-0000-0000-000000000003', 'a2000000-0000-0000-0000-00000000000a', 'a1000000-0000-0000-0000-00000000000a', now(), 'd1', sha256('text'), 'NONE', 'I understand', now() + interval '3 days') $q$,
  'requires a second factor of the session');

-- Р-100: административная запись проверяет роль, не только членство (оператор не меняет границы)
SELECT set_config('app.user_id', 'a1000000-0000-0000-0000-0000000000a0', true), set_config('app.auth_mfa', 'on', true) \gset
SELECT pg_temp.expect_fail('an operator lowers min_price (Р-100)', $q$
  INSERT INTO tenant_data.min_price (tenant_id, scope_type, product_id, currency, price_basis, amount_minor, version, created_by_membership_id)
  VALUES ('a0000000-0000-0000-0000-00000000000a', 'PRODUCT', 'a5000000-0000-0000-0000-000000000001', 'EUR', 'GROSS', 1, 99, 'a2000000-0000-0000-0000-0000000000a0') $q$,
  'role OPERATOR may not MANAGE_PRICING');

-- Находка 1: смена режима единицы записи административным сервисом — от человека и в аудите
SELECT set_config('app.user_id', '', true) \gset
SELECT pg_temp.expect_fail('pricing mode changed without a person (step 17 finding 1)', $q$
  UPDATE tenant_data.write_scope SET pricing_mode = 'OFF' WHERE write_scope_id = 'a6000000-0000-0000-0000-000000000001' $q$, 'without a person');

-- Находка 9: строки платформенного тенанта не пишутся административным сервисом
SELECT set_config('app.user_id', 'a1000000-0000-0000-0000-00000000000a', true), set_config('app.tenant_id', '00000000-0000-0000-0000-000000000000', true) \gset
SELECT pg_temp.expect_fail('administrative change in the platform tenant (step 17 finding 9)', $q$
  INSERT INTO tenant_data.product (tenant_id, sku, kind) VALUES ('00000000-0000-0000-0000-000000000000', 'ghost', 'SIMPLE') $q$, 'in the platform tenant');

-- Находка 5: перенос срока проверки остановки — со вторым фактором и в аудите
SELECT set_config('app.tenant_id', 'a0000000-0000-0000-0000-00000000000a', true), set_config('app.auth_mfa', 'on', true) \gset
INSERT INTO channel_data.pricing_halt (tenant_id, pricing_halt_id, channel_account_id, channel, marketplace, reason_code, halted_at)
VALUES ('a0000000-0000-0000-0000-00000000000a', 'ab180000-0000-4000-8000-000000000001', 'a4000000-0000-0000-0000-000000000001', 'KAUFLAND', 'at', 'CHANNEL_MASS_SHIFT', now());
SELECT set_config('app.auth_mfa', '', true) \gset
SELECT pg_temp.expect_fail('the review of a halt moved without a second factor (step 17 finding 5)', $q$
  UPDATE channel_data.pricing_halt SET next_review_at = now() + interval '10 years' WHERE pricing_halt_id = 'ab180000-0000-4000-8000-000000000001' $q$,
  'moving the review of pricing halt .* requires a second factor');
SELECT set_config('app.auth_mfa', 'on', true) \gset
UPDATE channel_data.pricing_halt SET next_review_at = now() + interval '1 hour' WHERE pricing_halt_id = 'ab180000-0000-4000-8000-000000000001';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM audit.audit_event WHERE entity_type = 'channel_data.pricing_halt' AND action = 'admin_change.update'
                    AND entity_id = 'ab180000-0000-4000-8000-000000000001' AND changes -> 'columns' ? 'next_review_at') THEN
    RAISE EXCEPTION 'the moved review of a halt is not in the audit log (step 17 finding 5)'; END IF;
  RAISE NOTICE 'PASS accept | a moved review of a halt is written to the audit log (step 17 finding 5)';
END $$;
ROLLBACK;

