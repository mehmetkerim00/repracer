-- 0048_external_identity_audit_author.sql
-- Шаг 14:
--  Р-78: собственная аутентификация отменена — пароли, сессии, блокировка и их функции удаляются (0046); вход, MFA, сброс пароля
--        и приглашения — у внешнего поставщика identity (ADR-0013). У нас остаётся сопоставление внешнего пользователя
--        (издатель, subject) с platform.app_user и членствами.
--  Находка ревьюера 4: автор остановки, возобновления и ручного снятия — пользователь сессии (app.user_id); чужое членство
--        БД не примет, и в audit_event не попадёт не тот автор [Р-76].
--  Находка ревьюера 10: ссылка на снимок у решения NO_OP запрещена в БД [Р-74].

BEGIN;
SET ROLE repracer_owner;

-- ---------------------------------------------------------------------------
-- 1. Удаление паролей и сессий шага 13 [Р-78]
-- ---------------------------------------------------------------------------
-- Строки реестров ссылаются на таблицы (regclass) — удаляются до таблиц
DELETE FROM maintenance.retention_policy WHERE table_name = 'platform.user_session'::regclass;
RESET ROLE;
DELETE FROM security.table_registry WHERE table_name IN ('platform.user_session'::regclass, 'platform.user_credential'::regclass);
DROP FUNCTION security.login_credential(text), security.record_failed_login(uuid, int, interval), security.open_session(uuid, bytea, interval),
              security.find_session(bytea), security.close_session(bytea), security.session_memberships(bytea);
REVOKE UPDATE (last_login_at), SELECT (display_name, mfa_enabled) ON platform.app_user FROM repracer_resolver;
DROP POLICY resolver_login_update ON platform.app_user;
DROP TABLE platform.user_session;
DROP TABLE platform.user_credential;
SET ROLE repracer_owner;

-- ---------------------------------------------------------------------------
-- 2. Сопоставление внешнего пользователя [Р-78]
-- ---------------------------------------------------------------------------
CREATE TABLE platform.external_identity (
  tenant_id  uuid NOT NULL DEFAULT security.platform_tenant_id() CHECK (tenant_id = security.platform_tenant_id()),
  -- Издатель токена поставщика (OIDC iss) и неизменяемый идентификатор пользователя у него (sub)
  issuer     text NOT NULL CHECK (issuer ~ '^https://[^\s]+$' AND length(issuer) <= 500),
  subject    text NOT NULL CHECK (length(subject) BETWEEN 1 AND 255),
  user_id    uuid NOT NULL REFERENCES platform.app_user (user_id),
  linked_at  timestamptz NOT NULL DEFAULT now(),
  -- Поиск пользователя по токену (security.resolve_external_identity)
  PRIMARY KEY (issuer, subject),
  -- У пользователя не больше одной привязки на поставщика
  UNIQUE (user_id, issuer)
);

SELECT security.register_table('platform.external_identity', 'PLATFORM', 'append_only', 'none');
-- Привязку создаёт и видит только сам пользователь в своей сессии (приём приглашения поставщика)
CREATE POLICY external_identity_own ON platform.external_identity TO repracer_app
  USING (user_id = security.current_user_id()) WITH CHECK (user_id = security.current_user_id());
CREATE POLICY resolver_read ON platform.external_identity FOR SELECT TO repracer_resolver USING (true);
GRANT SELECT (issuer, subject, user_id) ON platform.external_identity TO repracer_resolver;

-- Пользователь по (издатель, subject) и его действующие членства; пользователь без членств — одна строка без тенанта
CREATE FUNCTION security.resolve_external_identity(p_issuer text, p_subject text)
  RETURNS TABLE (user_id uuid, tenant_id uuid, membership_id uuid, role text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT e.user_id, m.tenant_id, m.membership_id, m.role
    FROM platform.external_identity e
    JOIN platform.app_user u ON u.user_id = e.user_id AND u.status = 'ACTIVE'
    LEFT JOIN (tenant_data.membership m JOIN tenant_data.tenant t
                 ON t.tenant_id = m.tenant_id AND t.kind = 'CUSTOMER' AND t.status IN ('TRIAL', 'ACTIVE', 'SUSPENDED'))
      ON m.user_id = e.user_id AND m.status = 'ACTIVE'
   WHERE e.issuer = p_issuer AND e.subject = p_subject
$$;
REVOKE ALL ON FUNCTION security.resolve_external_identity(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION security.resolve_external_identity(text, text) TO repracer_app;

-- ---------------------------------------------------------------------------
-- 3. Автор действия — пользователь сессии (находка 4) [Р-76]
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
  -- Действие человека — только в сессии пользователя и только от его членства: иначе журнал аудита записал бы не того автора
  IF security.current_user_id() IS NULL OR u IS DISTINCT FROM security.current_user_id() THEN
    RAISE EXCEPTION 'membership % is not the membership of the session user', member_id USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION channel_data.pricing_halt_release_role_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  r text;
  u uuid;
BEGIN
  IF OLD.released_at IS NULL AND NEW.released_kind = 'MANUAL' THEN
    SELECT m.role, m.user_id INTO r, u FROM tenant_data.membership m
     WHERE m.tenant_id = NEW.tenant_id AND m.membership_id = NEW.released_by_membership_id AND m.status = 'ACTIVE';
    IF r IS NULL OR NOT security.pricing_permission(r, 'RELEASE_CHANNEL_HALT') THEN
      RAISE EXCEPTION 'membership % (role %) may not release a channel halt', NEW.released_by_membership_id, coalesce(r, 'none')
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF security.current_user_id() IS NULL OR u IS DISTINCT FROM security.current_user_id() THEN
      RAISE EXCEPTION 'membership % is not the membership of the session user', NEW.released_by_membership_id USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- Журнал проверок: ручное снятие — от членства пользователя сессии; автор события аудита — пользователь сессии
CREATE OR REPLACE FUNCTION channel_data.pricing_halt_review_audit() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  h          record;
  actor_user uuid;
  actor_role text;
  manual     boolean := NEW.kind = 'MANUAL_RELEASE';
BEGIN
  SELECT ph.channel_account_id, ph.marketplace INTO h FROM channel_data.pricing_halt ph
   WHERE ph.tenant_id = NEW.tenant_id AND ph.pricing_halt_id = NEW.pricing_halt_id;
  IF manual THEN
    SELECT mm.user_id, mm.role INTO actor_user, actor_role FROM tenant_data.membership mm
     WHERE mm.tenant_id = NEW.tenant_id AND mm.membership_id = NEW.membership_id;
    IF actor_user IS NULL OR security.current_user_id() IS NULL OR actor_user IS DISTINCT FROM security.current_user_id() THEN
      RAISE EXCEPTION 'halt release %: author % is not the membership of the session user (Р-76)', NEW.pricing_halt_review_id, NEW.membership_id
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  INSERT INTO audit.audit_event (tenant_id, occurred_at, actor_type, actor_user_id, actor_membership_id, action, entity_type, entity_id, changes)
  VALUES (NEW.tenant_id, now(), CASE WHEN manual THEN 'USER' ELSE 'SYSTEM' END, actor_user, CASE WHEN manual THEN NEW.membership_id END,
          'pricing.halt_released', 'pricing_halt', NEW.pricing_halt_id,
          jsonb_build_object('kind', NEW.kind, 'role', actor_role, 'note', NEW.note,
                             'scope', CASE WHEN h.marketplace IS NULL THEN 'CHANNEL_ACCOUNT' ELSE 'STOREFRONT' END,
                             'channelAccountId', h.channel_account_id, 'marketplace', h.marketplace, 'at', NEW.reviewed_at));
  RETURN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- 4. У решения NO_OP нет ссылки на снимок (находка 10) [Р-74]
-- ---------------------------------------------------------------------------
CREATE FUNCTION channel_data.price_decision_snapshot_ref_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  c text;
BEGIN
  -- Поиск решения по (tenant_id, price_decision_id) — индекс price_decision_id_idx
  SELECT d.intent_class INTO c FROM channel_data.price_decision d
   WHERE d.tenant_id = NEW.tenant_id AND d.price_decision_id = NEW.price_decision_id;
  IF c IS NULL THEN
    RAISE EXCEPTION 'snapshot reference % refers to no decision', NEW.price_decision_id USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF c = 'NO_OP' THEN
    RAISE EXCEPTION 'a NO_OP decision % keeps no snapshot reference (Р-74)', NEW.price_decision_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER a_price_decision_snapshot_ref_guard BEFORE INSERT ON channel_data.price_decision_snapshot_ref
  FOR EACH ROW EXECUTE FUNCTION channel_data.price_decision_snapshot_ref_guard();

RESET ROLE;

GRANT CREATE ON SCHEMA security TO repracer_resolver;
ALTER FUNCTION security.resolve_external_identity(text, text) OWNER TO repracer_resolver;
REVOKE CREATE ON SCHEMA security FROM repracer_resolver;

COMMIT;
