-- 0053_audit_guards_invitations_mfa.sql
-- Шаг 15, находки 1–4 ревью шага 14 и Р-88:
--  1. Журнал проверок остановки: запись о снятии — только о настоящем снятии в той же транзакции; ручное снятие — от действующего
--     участника с правом, из его сессии; о снятой остановке журнал больше не пишется.
--  2. Остановка человеком создаётся действующей: снятие — отдельное действие со своим автором и событием аудита.
--  3. Автоматическое снятие — действие системы: без пользователя сессии, по чистой выборке журнала с моментом снятия и после окна
--     проверки. Подлинность самой выборки (что снимки действительно запрошены у канала) база проверить не может — OQ-143.
--  4, Р-88. Привязка внешнего пользователя создаётся ТОЛЬКО приёмом приглашения: у приложения нет вставки в
--     platform.external_identity; приглашает владелец или администратор тенанта со вторым фактором; владельца нового тенанта
--     регистрирует роль онбординга платформы. Второй фактор сессии (app.auth_mfa из amr токена) обязателен для снятия
--     остановки тенанта и смены роли участника. Массовый импорт себестоимости и границ в продукте ещё не реализован — требование
--     записано в OQ-144 и будет проверяться, когда импорт появится.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'repracer_onboarding') THEN
    CREATE ROLE repracer_onboarding NOLOGIN NOBYPASSRLS;
  END IF;
END $$;
GRANT USAGE ON SCHEMA security, platform TO repracer_onboarding;

SET ROLE repracer_owner;

-- ---------------------------------------------------------------------------
-- 0. Второй фактор сессии
-- ---------------------------------------------------------------------------
CREATE FUNCTION security.session_mfa() RETURNS boolean
  LANGUAGE sql STABLE PARALLEL SAFE AS $$ SELECT coalesce(current_setting('app.auth_mfa', true), '') = 'on' $$;
GRANT EXECUTE ON FUNCTION security.session_mfa() TO repracer_app, repracer_resolver;

-- ---------------------------------------------------------------------------
-- 1–2. Остановка человеком: создаётся действующей; снятие тенанта — со вторым фактором
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION tenant_data.price_stop_role_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  member_id uuid;
  r         text;
  u         uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.released_at IS NOT NULL THEN
    RAISE EXCEPTION 'price stop % is already released', OLD.price_stop_id USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  -- Находка 2: снятие — отдельное действие с автором и событием аудита, не часть вставки
  IF TG_OP = 'INSERT' AND (NEW.released_at IS NOT NULL OR NEW.released_by_membership_id IS NOT NULL OR NEW.release_note IS NOT NULL) THEN
    RAISE EXCEPTION 'a price stop is created active; its release is a separate action' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  member_id := CASE TG_OP WHEN 'INSERT' THEN NEW.stopped_by_membership_id ELSE NEW.released_by_membership_id END;
  IF TG_OP = 'UPDATE' AND NEW.released_at IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT m.role, m.user_id INTO r, u FROM tenant_data.membership m
   WHERE m.tenant_id = NEW.tenant_id AND m.membership_id = member_id AND m.status = 'ACTIVE';
  IF r IS NULL
     OR (TG_OP = 'INSERT' AND NOT security.pricing_permission(r, 'STOP_PRICING'))
     OR (TG_OP = 'UPDATE' AND NOT security.pricing_permission(r, CASE WHEN NEW.scope_type = 'TENANT' THEN 'RESUME_TENANT_STOP' ELSE 'RESUME_CHANNEL_STOP' END)) THEN
    RAISE EXCEPTION 'membership % (role %) may not % a % price stop', member_id, coalesce(r, 'none'),
      CASE TG_OP WHEN 'INSERT' THEN 'create' ELSE 'release' END, NEW.scope_type USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF security.current_user_id() IS NULL OR u IS DISTINCT FROM security.current_user_id() THEN
    RAISE EXCEPTION 'membership % is not the membership of the session user', member_id USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Р-88: снятие остановки всего тенанта — только со вторым фактором
  IF TG_OP = 'UPDATE' AND NEW.scope_type = 'TENANT' AND NOT security.session_mfa() THEN
    RAISE EXCEPTION 'releasing the tenant stop % requires a second factor (Р-88)', NEW.price_stop_id USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------
-- 1. Журнал проверок системной остановки
-- ---------------------------------------------------------------------------
CREATE FUNCTION channel_data.pricing_halt_review_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  h record;
  r text;
  u uuid;
BEGIN
  SELECT ph.released_at INTO h FROM channel_data.pricing_halt ph
   WHERE ph.tenant_id = NEW.tenant_id AND ph.pricing_halt_id = NEW.pricing_halt_id;
  IF NOT FOUND OR h.released_at IS NOT NULL THEN
    RAISE EXCEPTION 'pricing halt % is not active: no review can be recorded for it', NEW.pricing_halt_id USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.kind = 'MANUAL_RELEASE' THEN
    SELECT m.role, m.user_id INTO r, u FROM tenant_data.membership m
     WHERE m.tenant_id = NEW.tenant_id AND m.membership_id = NEW.membership_id AND m.status = 'ACTIVE';
    IF r IS NULL OR NOT security.pricing_permission(r, 'RELEASE_CHANNEL_HALT') THEN
      RAISE EXCEPTION 'membership % (role %) may not release a channel halt', NEW.membership_id, coalesce(r, 'none') USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF security.current_user_id() IS NULL OR u IS DISTINCT FROM security.current_user_id() THEN
      RAISE EXCEPTION 'membership % is not the membership of the session user', NEW.membership_id USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSIF security.current_user_id() IS NOT NULL THEN
    -- Находка 3: автоматическая проверка — действие системы, не пользователя
    RAISE EXCEPTION 'an automatic halt review is a system action and is not recorded in a user session' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER a_pricing_halt_review_guard BEFORE INSERT ON channel_data.pricing_halt_review
  FOR EACH ROW EXECUTE FUNCTION channel_data.pricing_halt_review_guard();

-- Запись о снятии — только о снятии, совершённом в той же транзакции (проверка при фиксации)
CREATE FUNCTION channel_data.pricing_halt_review_released_in_tx() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.outcome = 'RELEASED' AND NOT EXISTS (
       SELECT 1 FROM channel_data.pricing_halt ph
        WHERE ph.tenant_id = NEW.tenant_id AND ph.pricing_halt_id = NEW.pricing_halt_id
          AND ph.released_at = NEW.reviewed_at
          AND ph.released_kind = CASE NEW.kind WHEN 'AUTO_SAMPLE' THEN 'AUTO' ELSE 'MANUAL' END
          AND (NEW.kind <> 'MANUAL_RELEASE' OR ph.released_by_membership_id = NEW.membership_id)) THEN
    RAISE EXCEPTION 'halt review % records a release of pricing halt % that did not happen', NEW.pricing_halt_review_id, NEW.pricing_halt_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER zc_pricing_halt_review_released_in_tx AFTER INSERT ON channel_data.pricing_halt_review
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION channel_data.pricing_halt_review_released_in_tx();

-- ---------------------------------------------------------------------------
-- 3. Снятие остановки: ручное — участник сессии; автоматическое — система по чистой выборке после окна
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- 4. Приглашения: единственный путь привязки внешнего пользователя [Р-88]
-- ---------------------------------------------------------------------------
CREATE TABLE platform.identity_invitation (
  tenant_id            uuid NOT NULL DEFAULT security.platform_tenant_id() CHECK (tenant_id = security.platform_tenant_id()),
  invitation_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid NOT NULL REFERENCES platform.app_user (user_id),
  -- NULL — регистрация владельца нового тенанта (роль онбординга); иначе — участник этого тенанта
  invited_to_tenant_id uuid REFERENCES tenant_data.tenant (tenant_id),
  -- Хранится только SHA-256 одноразового токена из письма; копия таблицы привязку не даёт
  token_sha256         bytea NOT NULL UNIQUE CHECK (length(token_sha256) = 32),
  created_by_user_id   uuid REFERENCES platform.app_user (user_id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  expires_at           timestamptz NOT NULL,
  accepted_at          timestamptz,
  accepted_issuer      text,
  accepted_subject     text,
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '14 days'),
  CHECK ((accepted_at IS NULL) = (accepted_subject IS NULL) AND (accepted_at IS NULL) = (accepted_issuer IS NULL))
);

-- Удаление истёкших приглашений (maintenance.purge_expired_rows по expires_at)
CREATE INDEX identity_invitation_expiry_idx ON platform.identity_invitation (expires_at);

SELECT security.register_table('platform.identity_invitation', 'PLATFORM', 'mutable', 'none');
SELECT security.grant_retention('platform.identity_invitation');
INSERT INTO maintenance.retention_policy (table_name, method, anchor_column, retention, safety_margin, drop_order)
VALUES ('platform.identity_invitation', 'DELETE_ROWS', 'expires_at', '30 days', '1 day', 64);
REVOKE ALL ON platform.identity_invitation FROM repracer_app;
-- Правило 2 проверки схемы: у приложения есть политика — и она не открывает ни одной строки (прав на таблицу тоже нет)
CREATE POLICY identity_invitation_app_none ON platform.identity_invitation FOR SELECT TO repracer_app USING (false);

-- Роль входа: создаёт пользователей, приглашения, членства и привязки — только своими функциями ниже
CREATE POLICY resolver_invitation ON platform.identity_invitation TO repracer_resolver USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE (accepted_at, accepted_issuer, accepted_subject) ON platform.identity_invitation TO repracer_resolver;
CREATE POLICY resolver_signup ON platform.app_user FOR INSERT TO repracer_resolver WITH CHECK (true);
GRANT INSERT (user_id, email, display_name) ON platform.app_user TO repracer_resolver;
CREATE POLICY resolver_invite ON tenant_data.membership FOR INSERT TO repracer_resolver WITH CHECK (true);
CREATE POLICY resolver_accept ON tenant_data.membership FOR UPDATE TO repracer_resolver USING (true) WITH CHECK (true);
GRANT INSERT (tenant_id, user_id, role, status, invited_by_membership_id), UPDATE (status) ON tenant_data.membership TO repracer_resolver;
CREATE POLICY resolver_link ON platform.external_identity FOR INSERT TO repracer_resolver WITH CHECK (true);
GRANT INSERT (issuer, subject, user_id) ON platform.external_identity TO repracer_resolver;
GRANT SELECT (user_id, email, status) ON platform.app_user TO repracer_resolver;

-- Приложение привязку не создаёт: видит только свою
DROP POLICY external_identity_own ON platform.external_identity;
CREATE POLICY external_identity_own_read ON platform.external_identity FOR SELECT TO repracer_app USING (user_id = security.current_user_id());
REVOKE INSERT, UPDATE, DELETE ON platform.external_identity FROM repracer_app;

CREATE FUNCTION security.issue_signup_invitation(p_email text, p_token_sha256 bytea, p_ttl interval) RETURNS uuid
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  uid uuid;
  iid uuid;
BEGIN
  IF p_ttl <= interval '0' OR p_ttl > interval '14 days' THEN
    RAISE EXCEPTION 'invitation lifetime must be within 14 days' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT u.user_id INTO uid FROM platform.app_user u WHERE u.email = lower(trim(p_email));
  IF uid IS NULL THEN
    INSERT INTO platform.app_user (email) VALUES (lower(trim(p_email))) RETURNING user_id INTO uid;
  END IF;
  INSERT INTO platform.identity_invitation (user_id, token_sha256, expires_at)
  VALUES (uid, p_token_sha256, now() + p_ttl) RETURNING invitation_id INTO iid;
  RETURN iid;
END $$;

-- Приглашение участника: действующий владелец или администратор тенанта в своей сессии, со вторым фактором [Р-88]
CREATE FUNCTION security.invite_member(p_tenant_id uuid, p_email text, p_role text, p_token_sha256 bytea, p_ttl interval)
  RETURNS TABLE (invitation_id uuid, user_id uuid, membership_id uuid)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  inviter record;
  uid     uuid;
  mid     uuid;
  iid     uuid;
BEGIN
  SELECT m.membership_id, m.role INTO inviter FROM tenant_data.membership m
   WHERE m.tenant_id = p_tenant_id AND m.user_id = security.current_user_id() AND m.status = 'ACTIVE';
  IF inviter IS NULL OR inviter.role NOT IN ('OWNER', 'ADMIN') THEN
    RAISE EXCEPTION 'only an active owner or admin of the tenant invites members' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT security.session_mfa() THEN
    RAISE EXCEPTION 'inviting a member assigns a role and requires a second factor (Р-88)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_role = 'OWNER' OR (inviter.role = 'ADMIN' AND p_role = 'ADMIN') THEN
    RAISE EXCEPTION 'role % cannot be granted by an invitation of %', p_role, inviter.role USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_ttl <= interval '0' OR p_ttl > interval '14 days' THEN
    RAISE EXCEPTION 'invitation lifetime must be within 14 days' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT u.user_id INTO uid FROM platform.app_user u WHERE u.email = lower(trim(p_email));
  IF uid IS NULL THEN
    INSERT INTO platform.app_user (email) VALUES (lower(trim(p_email))) RETURNING app_user.user_id INTO uid;
  END IF;
  INSERT INTO tenant_data.membership (tenant_id, user_id, role, status, invited_by_membership_id)
  VALUES (p_tenant_id, uid, p_role, 'INVITED', inviter.membership_id)
  RETURNING membership.membership_id INTO mid;
  INSERT INTO platform.identity_invitation (user_id, invited_to_tenant_id, token_sha256, created_by_user_id, expires_at)
  VALUES (uid, p_tenant_id, p_token_sha256, security.current_user_id(), now() + p_ttl)
  RETURNING identity_invitation.invitation_id INTO iid;
  RETURN QUERY SELECT iid, uid, mid;
END $$;

-- Приём приглашения: единственное место, где создаётся привязка (издатель, subject) → пользователь
CREATE FUNCTION security.accept_identity_invitation(p_token_sha256 bytea, p_issuer text, p_subject text, p_email text) RETURNS uuid
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  inv record;
BEGIN
  SELECT i.invitation_id, i.user_id, i.invited_to_tenant_id, i.expires_at, i.accepted_at, u.email, u.status INTO inv
    FROM platform.identity_invitation i JOIN platform.app_user u ON u.user_id = i.user_id
   WHERE i.token_sha256 = p_token_sha256
   FOR UPDATE OF i;
  IF inv IS NULL OR inv.accepted_at IS NOT NULL OR inv.expires_at <= now() OR inv.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'invitation is unknown, used or expired' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Email поставщика — тот, на который отправлено приглашение: чужой токен из письма не привязывает другой вход
  IF p_email IS NULL OR lower(trim(p_email)) <> inv.email THEN
    RAISE EXCEPTION 'invitation was issued for another email' USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO platform.external_identity (issuer, subject, user_id) VALUES (p_issuer, p_subject, inv.user_id);
  UPDATE platform.identity_invitation SET accepted_at = now(), accepted_issuer = p_issuer, accepted_subject = p_subject
   WHERE invitation_id = inv.invitation_id;
  IF inv.invited_to_tenant_id IS NOT NULL THEN
    UPDATE tenant_data.membership SET status = 'ACTIVE'
     WHERE tenant_id = inv.invited_to_tenant_id AND user_id = inv.user_id AND status = 'INVITED';
  END IF;
  RETURN inv.user_id;
END $$;

REVOKE ALL ON FUNCTION security.issue_signup_invitation(text, bytea, interval), security.invite_member(uuid, text, text, bytea, interval),
  security.accept_identity_invitation(bytea, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION security.issue_signup_invitation(text, bytea, interval) TO repracer_onboarding;
GRANT EXECUTE ON FUNCTION security.invite_member(uuid, text, text, bytea, interval), security.accept_identity_invitation(bytea, text, text, text) TO repracer_app;

-- ---------------------------------------------------------------------------
-- 5. Смена роли участника — владелец или администратор в своей сессии, со вторым фактором [Р-88]
-- ---------------------------------------------------------------------------
CREATE FUNCTION tenant_data.membership_role_change_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.role IS DISTINCT FROM OLD.role THEN
    IF NOT EXISTS (SELECT 1 FROM tenant_data.membership m
                    WHERE m.tenant_id = NEW.tenant_id AND m.user_id = security.current_user_id() AND m.status = 'ACTIVE'
                      AND m.role IN ('OWNER', 'ADMIN') AND m.membership_id <> NEW.membership_id) THEN
      RAISE EXCEPTION 'the role of membership % is changed only by another active owner or admin in their session', NEW.membership_id
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NOT security.session_mfa() THEN
      RAISE EXCEPTION 'changing a role requires a second factor (Р-88)' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER membership_role_change_guard BEFORE UPDATE ON tenant_data.membership
  FOR EACH ROW EXECUTE FUNCTION tenant_data.membership_role_change_guard();

RESET ROLE;

GRANT CREATE ON SCHEMA security TO repracer_resolver;
ALTER FUNCTION security.issue_signup_invitation(text, bytea, interval) OWNER TO repracer_resolver;
ALTER FUNCTION security.invite_member(uuid, text, text, bytea, interval) OWNER TO repracer_resolver;
ALTER FUNCTION security.accept_identity_invitation(bytea, text, text, text) OWNER TO repracer_resolver;
REVOKE CREATE ON SCHEMA security FROM repracer_resolver;

COMMIT;
