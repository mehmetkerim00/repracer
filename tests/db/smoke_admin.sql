-- Р-90, Р-88, находки 2, 3, 5, 9, 12 ревью шага 15: административный сервис (svc_admin, член repracer_admin) после smoke_app.sql.
-- Только у его сессии база принимает пользователя сессии и второй фактор; но и у него нет прямой вставки членства и событий аудита,
-- активации членства мимо приглашения и назначения владельца администратором. Всё откатывается. Данные синтетические.
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

BEGIN;
SELECT set_config('app.tenant_id', 'a0000000-0000-0000-0000-00000000000a', true), set_config('app.user_id', 'a1000000-0000-0000-0000-00000000000a', true) \gset

-- ---------------------------------------------------------------- находка 12: ручное снятие системной остановки
INSERT INTO channel_data.pricing_halt (tenant_id, pricing_halt_id, channel_account_id, channel, marketplace, reason_code, details)
VALUES ('a0000000-0000-0000-0000-00000000000a', 'ab000000-0000-0000-0000-000000000090', 'a4000000-0000-0000-0000-000000000001', 'KAUFLAND', 'de', 'CHANNEL_MASS_SHIFT', '{"sameDirection": 20}');
SELECT pg_temp.expect_fail('manual halt release without a second factor (finding 12, Р-88)', $q$
  DO $x$ BEGIN
    INSERT INTO channel_data.pricing_halt_review (tenant_id, pricing_halt_id, kind, outcome, sample_size, failed_count, membership_id, note)
    VALUES ('a0000000-0000-0000-0000-00000000000a', 'ab000000-0000-0000-0000-000000000090', 'MANUAL_RELEASE', 'RELEASED', 0, 0, 'a2000000-0000-0000-0000-00000000000a', 'data verified with the channel');
    UPDATE channel_data.pricing_halt SET released_at = now(), released_kind = 'MANUAL', released_by_membership_id = 'a2000000-0000-0000-0000-00000000000a', release_note = 'data verified with the channel'
     WHERE pricing_halt_id = 'ab000000-0000-0000-0000-000000000090';
  END $x$ $q$);
SELECT set_config('app.auth_mfa', 'on', true) \gset
SET CONSTRAINTS ALL DEFERRED;
INSERT INTO channel_data.pricing_halt_review (tenant_id, pricing_halt_id, kind, outcome, sample_size, failed_count, membership_id, note)
VALUES ('a0000000-0000-0000-0000-00000000000a', 'ab000000-0000-0000-0000-000000000090', 'MANUAL_RELEASE', 'RELEASED', 0, 0, 'a2000000-0000-0000-0000-00000000000a', 'data verified with the channel');
SELECT pg_temp.ok('manual halt release by a member with a second factor, a note and a journal record (Р-52, Р-88)', $q$
  UPDATE channel_data.pricing_halt SET released_at = now(), released_kind = 'MANUAL', released_by_membership_id = 'a2000000-0000-0000-0000-00000000000a', release_note = 'data verified with the channel'
   WHERE pricing_halt_id = 'ab000000-0000-0000-0000-000000000090' $q$);
SELECT pg_temp.expect_fail('release twice', $q$
  UPDATE channel_data.pricing_halt SET release_note = 'released again later' WHERE pricing_halt_id = 'ab000000-0000-0000-0000-000000000090' $q$);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM audit.audit_event WHERE entity_id = 'ab000000-0000-0000-0000-000000000090' AND action = 'pricing.halt_released'
                  AND actor_type = 'USER' AND actor_user_id = 'a1000000-0000-0000-0000-00000000000a') THEN
    RAISE EXCEPTION 'the manual release is not in the audit log with its author'; END IF;
  RAISE NOTICE 'PASS accept | the audit event of the release is written by the trigger with the session user as author (Р-76)';
END $$;

-- ---------------------------------------------------------------- находки 2, 3, 5: прямых прав нет и у административного сервиса
SELECT pg_temp.expect_fail('insert an OWNER membership directly (finding 2, Р-90)', $q$
  INSERT INTO tenant_data.membership (tenant_id, user_id, role, status) VALUES ('a0000000-0000-0000-0000-00000000000a', 'b1000000-0000-0000-0000-00000000000b', 'OWNER', 'ACTIVE') $q$);
SELECT pg_temp.expect_fail('forge an audit event (finding 5, Р-90)', $q$
  INSERT INTO audit.audit_event (tenant_id, occurred_at, actor_type, actor_user_id, actor_membership_id, action, entity_type)
  VALUES ('a0000000-0000-0000-0000-00000000000a', now(), 'USER', 'a1000000-0000-0000-0000-0000000000a0', 'a2000000-0000-0000-0000-0000000000a0', 'pricing.stop_released', 'price_stop') $q$);
SELECT set_config('app.user_id', 'a1000000-0000-0000-0000-00000000000a', true) \gset
CREATE TEMP TABLE invited AS SELECT * FROM security.invite_member('a0000000-0000-0000-0000-00000000000a', 'invited-a@example.test', 'PRICING_MANAGER', sha256('smoke-invite'), interval '1 day');
DO $$ BEGIN RAISE NOTICE 'PASS accept | owner with a second factor invites a member (Р-88)'; END $$;
SELECT pg_temp.expect_fail('activate an invited membership without accepting the invitation (finding 3)', $q$
  UPDATE tenant_data.membership SET status = 'ACTIVE' WHERE membership_id = (SELECT membership_id FROM invited) $q$);

-- ---------------------------------------------------------------- находка 9: владельца назначает только владелец
SELECT set_config('app.user_id', 'a1000000-0000-0000-0000-0000000000ad', true) \gset
SELECT pg_temp.expect_fail('an admin promotes an operator to owner (finding 9)', $q$
  UPDATE tenant_data.membership SET role = 'OWNER' WHERE membership_id = 'a2000000-0000-0000-0000-0000000000a0' $q$);
SELECT pg_temp.expect_fail('an admin grants the admin role (finding 9)', $q$
  UPDATE tenant_data.membership SET role = 'ADMIN' WHERE membership_id = 'a2000000-0000-0000-0000-0000000000a0' $q$);
SELECT pg_temp.expect_fail('an admin demotes the owner (finding 9)', $q$
  UPDATE tenant_data.membership SET role = 'VIEWER' WHERE membership_id = 'a2000000-0000-0000-0000-00000000000a' $q$);
SELECT pg_temp.ok('an admin changes an operator to pricing manager with a second factor (Р-88)', $q$
  UPDATE tenant_data.membership SET role = 'PRICING_MANAGER' WHERE membership_id = 'a2000000-0000-0000-0000-0000000000a0' $q$);
SELECT set_config('app.auth_mfa', '', true) \gset
SELECT pg_temp.expect_fail('role change without a second factor (Р-88)', $q$
  UPDATE tenant_data.membership SET role = 'OPERATOR' WHERE membership_id = 'a2000000-0000-0000-0000-0000000000a0' $q$);
SELECT set_config('app.auth_mfa', 'on', true), set_config('app.user_id', 'a1000000-0000-0000-0000-00000000000a', true) \gset
SELECT pg_temp.ok('the owner revokes the admin with a second factor', $q$
  UPDATE tenant_data.membership SET status = 'REVOKED', revoked_at = now() WHERE membership_id = 'a2000000-0000-0000-0000-0000000000ad' $q$);
SELECT pg_temp.expect_fail('a revoked membership is restored', $q$
  UPDATE tenant_data.membership SET status = 'ACTIVE', revoked_at = NULL WHERE membership_id = 'a2000000-0000-0000-0000-0000000000ad' $q$);
DO $$ BEGIN
  IF (SELECT count(*) FROM audit.audit_event WHERE entity_type = 'membership' AND action IN ('membership.role_changed', 'membership.status_changed')) < 2 THEN
    RAISE EXCEPTION 'role and access changes are not in the audit log'; END IF;
  RAISE NOTICE 'PASS accept | role change and revocation are written to the audit log by the trigger (Р-90)';
END $$;
ROLLBACK;
