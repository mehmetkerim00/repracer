-- 0058_role_separation.sql
-- Шаг 16, Р-90: роли подключения к БД разделены. Находки 2, 3, 5 ревью шага 15 закрываются ОТСУТСТВИЕМ ПРАВ, а не проверками:
--   роль пути решения (repracer_app: svc_app, svc_dispatcher) не может вставить событие аудита, создать или изменить членство,
--   создать тенанта или пользователя, поставить или снять остановку человеком, пригласить участника, прочитать членства по
--   внешнему пользователю; признак второго фактора и пользователь сессии, выставленные этой ролью, база не принимает.
-- Роли:
--   repracer_admin          — административный сервис (консоль): права приложения + остановки человеком, смена роли и отзыв
--                             членства, приглашения, профиль пользователя; только у его сессий база принимает app.user_id и
--                             app.auth_mfa;
--   repracer_provisioning   — создание тенанта с владельцем и участниками (онбординг, посев стенда): только функция
--                             security.provision_tenant;
--   repracer_authenticator  — вход: сопоставление (издатель, subject) с членствами, приём приглашения;
--   repracer_audit_writer   — владелец функций триггеров аудита; прямой вставки в audit.audit_event нет ни у одной роли сервиса.
-- Что база НЕ обещает (ADR-0016): скомпрометированный административный сервис сам ставит app.user_id и app.auth_mfa в своей
-- сессии — база не видит токен поставщика и второй фактор проверить не может; она ограничивает, КТО может это заявить.
-- Находки ревью шага 15 здесь же: 9 (ADMIN повышал до OWNER), 10 (привязанный пользователь не принимал приглашение во второй
-- тенант, Р-9), 11 (email_verified), 12 (ручное снятие системной остановки без второго фактора), 13 (resolve_external_identity у
-- приложения). Поведение — packages/pricing-store-pg/test/role-separation.pg.test.ts, packages/identity/test/identity.pg.test.ts,
-- tests/db/smoke_*.sql.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'repracer_admin') THEN
    CREATE ROLE repracer_admin NOLOGIN NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'repracer_provisioning') THEN
    CREATE ROLE repracer_provisioning NOLOGIN NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'repracer_authenticator') THEN
    CREATE ROLE repracer_authenticator NOLOGIN NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'repracer_audit_writer') THEN
    CREATE ROLE repracer_audit_writer NOLOGIN NOBYPASSRLS;
  END IF;
END $$;

-- Административный сервис читает и пишет данные тенанта как приложение (консоль показывает решения и границы)
GRANT repracer_app TO repracer_admin;
GRANT USAGE ON SCHEMA security TO repracer_provisioning, repracer_authenticator;
GRANT USAGE ON SCHEMA security, audit, tenant_data, channel_data TO repracer_audit_writer;

SET ROLE repracer_owner;

-- ---------------------------------------------------------------------------
-- 1. Пользователь сессии и второй фактор — только у сессии административного сервиса
-- ---------------------------------------------------------------------------
-- session_user — роль входа соединения: SET ROLE его не меняет, SET SESSION AUTHORIZATION доступен только суперпользователю
CREATE OR REPLACE FUNCTION security.current_user_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN pg_has_role(session_user, 'repracer_admin', 'MEMBER') THEN nullif(current_setting('app.user_id', true), '')::uuid END
$$;
CREATE OR REPLACE FUNCTION security.session_mfa() RETURNS boolean
  LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT pg_has_role(session_user, 'repracer_admin', 'MEMBER') AND coalesce(current_setting('app.auth_mfa', true), '') = 'on'
$$;
GRANT EXECUTE ON FUNCTION security.current_user_id(), security.session_mfa(), security.current_tenant_id() TO repracer_audit_writer;

-- ---------------------------------------------------------------------------
-- 2. Журнал аудита: пишут только функции триггеров (SECURITY DEFINER роли repracer_audit_writer)
-- ---------------------------------------------------------------------------
RESET ROLE;
REVOKE INSERT ON audit.audit_event FROM repracer_app;
GRANT INSERT ON audit.audit_event TO repracer_audit_writer;
GRANT SELECT ON tenant_data.membership, channel_data.pricing_halt TO repracer_audit_writer;
SET ROLE repracer_owner;
-- Функции триггеров не вызываются напрямую; тенант строки уже проверен политикой таблицы, в которую пишет сессия
CREATE POLICY audit_writer_insert ON audit.audit_event FOR INSERT TO repracer_audit_writer WITH CHECK (true);
CREATE POLICY audit_writer_read ON tenant_data.membership FOR SELECT TO repracer_audit_writer USING (true);
CREATE POLICY audit_writer_read ON channel_data.pricing_halt FOR SELECT TO repracer_audit_writer USING (true);

-- Изменение роли и статуса членства — тоже в журнал (ревью шага 15, находка 28: смена ролей не аудировалась)
CREATE FUNCTION tenant_data.membership_audit() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  actor_user   uuid := security.current_user_id();
  actor_member uuid;
BEGIN
  IF actor_user IS NOT NULL THEN
    SELECT m.membership_id INTO actor_member FROM tenant_data.membership m
     WHERE m.tenant_id = NEW.tenant_id AND m.user_id = actor_user AND m.status = 'ACTIVE';
  END IF;
  INSERT INTO audit.audit_event (tenant_id, occurred_at, actor_type, actor_user_id, actor_membership_id, action, entity_type, entity_id, changes)
  VALUES (NEW.tenant_id, now(), CASE WHEN actor_member IS NOT NULL THEN 'USER' ELSE 'SYSTEM' END,
          CASE WHEN actor_member IS NOT NULL THEN actor_user END, actor_member,
          CASE WHEN NEW.role IS DISTINCT FROM OLD.role THEN 'membership.role_changed' ELSE 'membership.status_changed' END,
          'membership', NEW.membership_id,
          jsonb_build_object('roleFrom', OLD.role, 'roleTo', NEW.role, 'statusFrom', OLD.status, 'statusTo', NEW.status,
                             'secondFactor', security.session_mfa(), 'at', now()));
  RETURN NULL;
END $$;
CREATE TRIGGER zb_membership_audit AFTER UPDATE OF role, status ON tenant_data.membership
  FOR EACH ROW WHEN (NEW.role IS DISTINCT FROM OLD.role OR NEW.status IS DISTINCT FROM OLD.status)
  EXECUTE FUNCTION tenant_data.membership_audit();

RESET ROLE;
DO $$
DECLARE
  f regprocedure;
BEGIN
  FOREACH f IN ARRAY ARRAY['tenant_data.price_stop_audit()', 'channel_data.pricing_halt_audit()', 'channel_data.pricing_halt_review_audit()',
                           'tenant_data.membership_audit()']::regprocedure[] LOOP
    EXECUTE format('ALTER FUNCTION %s SECURITY DEFINER SET search_path = pg_catalog, pg_temp', f);
    EXECUTE format('ALTER FUNCTION %s OWNER TO repracer_audit_writer', f);
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Членства, тенанты, пользователи: у пути решения прав нет
-- ---------------------------------------------------------------------------
REVOKE INSERT, UPDATE ON tenant_data.membership FROM repracer_app;
GRANT UPDATE (role, status, revoked_at) ON tenant_data.membership TO repracer_admin;
REVOKE INSERT ON tenant_data.tenant FROM repracer_app;
REVOKE INSERT, UPDATE ON platform.app_user FROM repracer_app;
GRANT UPDATE ON platform.app_user TO repracer_admin;
REVOKE INSERT, UPDATE ON tenant_data.price_stop FROM repracer_app;
GRANT INSERT, UPDATE ON tenant_data.price_stop TO repracer_admin;
GRANT INSERT ON tenant_data.tenant TO repracer_resolver;
-- Создание тенанта задаёт идентификаторы членств и пользователей (посев стенда ссылается на них) — столбцы сверх приглашения (0053)
GRANT INSERT (user_id, email, mfa_enabled) ON platform.app_user TO repracer_resolver;
GRANT INSERT (tenant_id, membership_id, user_id, role, status) ON tenant_data.membership TO repracer_resolver;
SET ROLE repracer_owner;
CREATE POLICY resolver_provision ON tenant_data.tenant FOR INSERT TO repracer_resolver WITH CHECK (true);

-- Членство создают только функции роли входа (приглашение, создание тенанта); статус и роль — по правилам ниже
CREATE FUNCTION tenant_data.membership_insert_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF current_user <> 'repracer_resolver' THEN
    RAISE EXCEPTION 'a membership is created only by an invitation or by provisioning its tenant (Р-90, finding 2)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER a_membership_insert_guard BEFORE INSERT ON tenant_data.membership
  FOR EACH ROW EXECUTE FUNCTION tenant_data.membership_insert_guard();

CREATE OR REPLACE FUNCTION tenant_data.membership_role_change_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  actor record;
BEGIN
  -- Находка 3: действующим членство становится только приёмом приглашения; отозванное не возвращается
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF OLD.status = 'REVOKED' THEN
      RAISE EXCEPTION 'revoked membership % is not restored; invite the user again', NEW.membership_id USING ERRCODE = 'insufficient_privilege';
    ELSIF NEW.status = 'ACTIVE' THEN
      IF NOT (current_user = 'repracer_resolver' AND OLD.status = 'INVITED') THEN
        RAISE EXCEPTION 'membership % becomes active only by accepting its invitation (finding 3)', NEW.membership_id USING ERRCODE = 'insufficient_privilege';
      END IF;
    ELSIF NEW.status <> 'REVOKED' THEN
      RAISE EXCEPTION 'membership status % -> % is not allowed', OLD.status, NEW.status USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  IF NEW.role IS DISTINCT FROM OLD.role OR NEW.status = 'REVOKED' AND OLD.status IS DISTINCT FROM 'REVOKED' THEN
    SELECT m.membership_id, m.role INTO actor FROM tenant_data.membership m
     WHERE m.tenant_id = NEW.tenant_id AND m.user_id = security.current_user_id() AND m.status = 'ACTIVE'
       AND m.role IN ('OWNER', 'ADMIN') AND m.membership_id <> NEW.membership_id;
    IF actor IS NULL THEN
      RAISE EXCEPTION 'the role or access of membership % is changed only by another active owner or admin in their session', NEW.membership_id
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NOT security.session_mfa() THEN
      RAISE EXCEPTION 'changing a role or revoking access requires a second factor (Р-88)' USING ERRCODE = 'insufficient_privilege';
    END IF;
    -- Находка 9: роль владельца даёт и забирает только владелец; администратор не назначает и не снимает администраторов
    IF (NEW.role = 'OWNER' OR OLD.role = 'OWNER') AND actor.role <> 'OWNER' THEN
      RAISE EXCEPTION 'only an owner grants, removes or revokes the owner role (finding 9)' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF actor.role = 'ADMIN' AND (NEW.role = 'ADMIN' OR OLD.role = 'ADMIN') THEN
      RAISE EXCEPTION 'an admin does not grant, remove or revoke the admin role (finding 9)' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------
-- 4. Создание тенанта с владельцем и участниками — роль repracer_provisioning
-- ---------------------------------------------------------------------------
-- p_members: [{"membershipId": uuid?, "userId": uuid, "email": text (для нового пользователя), "role": text}], владелец обязателен
CREATE FUNCTION security.provision_tenant(p_tenant_id uuid, p_name text, p_data_region text, p_members jsonb) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  m jsonb;
BEGIN
  IF jsonb_typeof(p_members) IS DISTINCT FROM 'array'
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_members) e WHERE e.value ->> 'role' = 'OWNER') THEN
    RAISE EXCEPTION 'a tenant is provisioned together with its owner' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  INSERT INTO tenant_data.tenant (tenant_id, name, data_region) VALUES (p_tenant_id, p_name, p_data_region);
  FOR m IN SELECT value FROM jsonb_array_elements(p_members) LOOP
    IF NOT EXISTS (SELECT 1 FROM platform.app_user u WHERE u.user_id = (m ->> 'userId')::uuid) THEN
      INSERT INTO platform.app_user (user_id, email, mfa_enabled)
      VALUES ((m ->> 'userId')::uuid, lower(trim(m ->> 'email')), coalesce((m ->> 'mfaEnabled')::boolean, false));
    END IF;
    INSERT INTO tenant_data.membership (tenant_id, membership_id, user_id, role, status)
    VALUES (p_tenant_id, coalesce((m ->> 'membershipId')::uuid, gen_random_uuid()), (m ->> 'userId')::uuid, m ->> 'role', 'ACTIVE');
  END LOOP;
END $$;
RESET ROLE;
ALTER FUNCTION security.provision_tenant(uuid, text, text, jsonb) OWNER TO repracer_resolver;
-- Проверка «у тенанта есть владелец» отложена до фиксации и выполняется уже вне функции — от роли входа. У ролей создания тенанта и
-- административного сервиса нет чтения всех членств; проверка читает их правами роли входа (только чтение, только отказ)
ALTER FUNCTION tenant_data.assert_tenant_has_owner() SECURITY DEFINER SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION tenant_data.assert_tenant_has_owner() OWNER TO repracer_resolver;
REVOKE EXECUTE ON FUNCTION tenant_data.assert_tenant_has_owner() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION security.provision_tenant(uuid, text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION security.provision_tenant(uuid, text, text, jsonb) TO repracer_provisioning;

-- ---------------------------------------------------------------------------
-- 5. Вход и приглашения: сопоставление и приём — роль repracer_authenticator; приглашение участника — административный сервис
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  f regprocedure;
BEGIN
  -- Находка 13: по паре (издатель, subject) и по пользователю функции отдают членства — у пути решения их нет
  FOR f IN SELECT p.oid::regprocedure FROM pg_proc p
            WHERE p.pronamespace = 'security'::regnamespace AND p.proname IN ('resolve_external_identity', 'list_user_tenants', 'find_user_by_email') LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM repracer_app', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO repracer_authenticator', f);
  END LOOP;
END $$;
REVOKE EXECUTE ON FUNCTION security.invite_member(uuid, text, text, bytea, interval) FROM repracer_app;
GRANT EXECUTE ON FUNCTION security.invite_member(uuid, text, text, bytea, interval) TO repracer_admin;
DROP FUNCTION security.accept_identity_invitation(bytea, text, text, text);

SET ROLE repracer_owner;
-- Находки 10, 11: email подтверждён поставщиком; вход, уже привязанный к этому пользователю, принимает приглашение в следующий
-- тенант (пользователь в нескольких тенантах, Р-9); чужая привязка и вторая привязка того же поставщика — отказ (OQ-148)
CREATE FUNCTION security.accept_identity_invitation(p_token_sha256 bytea, p_issuer text, p_subject text, p_email text, p_email_verified boolean) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  inv    record;
  linked uuid;
BEGIN
  SELECT i.invitation_id, i.user_id, i.invited_to_tenant_id, i.expires_at, i.accepted_at, u.email, u.status INTO inv
    FROM platform.identity_invitation i JOIN platform.app_user u ON u.user_id = i.user_id
   WHERE i.token_sha256 = p_token_sha256
   FOR UPDATE OF i;
  IF inv IS NULL OR inv.accepted_at IS NOT NULL OR inv.expires_at <= now() OR inv.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'invitation is unknown, used or expired' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_email_verified IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'the provider has not verified the email of this sign-in (finding 11)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Email поставщика — тот, на который отправлено приглашение: чужой токен из письма не привязывает другой вход
  IF p_email IS NULL OR lower(trim(p_email)) <> inv.email THEN
    RAISE EXCEPTION 'invitation was issued for another email' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT e.user_id INTO linked FROM platform.external_identity e WHERE e.issuer = p_issuer AND e.subject = p_subject;
  IF linked IS NULL THEN
    IF EXISTS (SELECT 1 FROM platform.external_identity e WHERE e.user_id = inv.user_id AND e.issuer = p_issuer) THEN
      RAISE EXCEPTION 'the user is already linked to another sign-in of this provider; relinking is not supported (OQ-148)'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    INSERT INTO platform.external_identity (issuer, subject, user_id) VALUES (p_issuer, p_subject, inv.user_id);
  ELSIF linked <> inv.user_id THEN
    RAISE EXCEPTION 'this sign-in is linked to another user' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE platform.identity_invitation SET accepted_at = now(), accepted_issuer = p_issuer, accepted_subject = p_subject
   WHERE invitation_id = inv.invitation_id;
  IF inv.invited_to_tenant_id IS NOT NULL THEN
    UPDATE tenant_data.membership SET status = 'ACTIVE'
     WHERE tenant_id = inv.invited_to_tenant_id AND user_id = inv.user_id AND status = 'INVITED';
  END IF;
  RETURN inv.user_id;
END $$;
RESET ROLE;
ALTER FUNCTION security.accept_identity_invitation(bytea, text, text, text, boolean) OWNER TO repracer_resolver;
REVOKE EXECUTE ON FUNCTION security.accept_identity_invitation(bytea, text, text, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION security.accept_identity_invitation(bytea, text, text, text, boolean) TO repracer_authenticator;

-- ---------------------------------------------------------------------------
-- 6. Находка 12: ручное снятие системной остановки — со вторым фактором
-- ---------------------------------------------------------------------------
SET ROLE repracer_owner;
CREATE OR REPLACE FUNCTION channel_data.pricing_halt_release_role_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  r text;
  u uuid;
BEGIN
  IF OLD.released_at IS NOT NULL OR NEW.released_at IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.released_kind = 'MANUAL' THEN
    SELECT m.role, m.user_id INTO r, u FROM tenant_data.membership m
     WHERE m.tenant_id = NEW.tenant_id AND m.membership_id = NEW.released_by_membership_id AND m.status = 'ACTIVE';
    IF r IS NULL OR NOT security.pricing_permission(r, 'RELEASE_CHANNEL_HALT') THEN
      RAISE EXCEPTION 'membership % (role %) may not release a channel halt', NEW.released_by_membership_id, coalesce(r, 'none')
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF security.current_user_id() IS NULL OR u IS DISTINCT FROM security.current_user_id() THEN
      RAISE EXCEPTION 'membership % is not the membership of the session user', NEW.released_by_membership_id USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NOT security.session_mfa() THEN
      RAISE EXCEPTION 'releasing channel halt % manually requires a second factor (finding 12, Р-88)', NEW.pricing_halt_id USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSE
    IF security.current_user_id() IS NOT NULL OR NEW.released_by_membership_id IS NOT NULL THEN
      RAISE EXCEPTION 'an automatic release of pricing halt % is a system action' , NEW.pricing_halt_id USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NOT EXISTS (
         SELECT 1 FROM channel_data.pricing_halt_review rv
          WHERE rv.tenant_id = NEW.tenant_id AND rv.pricing_halt_id = NEW.pricing_halt_id AND rv.kind = 'AUTO_SAMPLE' AND rv.outcome = 'RELEASED'
            AND rv.sample_size >= 1 AND rv.failed_count = 0 AND rv.reviewed_at = NEW.released_at AND rv.reviewed_at >= OLD.next_review_at) THEN
      RAISE EXCEPTION 'automatic release of pricing halt % needs a clean sample reviewed at the release after the review window (Р-52)', NEW.pricing_halt_id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;

RESET ROLE;
COMMIT;
