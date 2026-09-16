-- 0066: административные операции — только от человека и в аудите (Р-97); создание тенанта не присоединяет существующих
-- пользователей мимо приглашения (находка 5); перепривязка входа — только приглашением владельца (Р-98); подрез закреплённой
-- версии не начинает срок хранения (OQ-151); слепок объяснения проверяется по видам и значениям параметров (находка 6).
--
-- 1. Р-97. Таблица, запись в которую есть у административной роли и не входит в список разрешённого пути решения (Р-96), получает
--    два триггера: BEFORE — запись в сессии административного сервиса только при пользователе сессии, действующем участнике тенанта
--    строки; AFTER — событие audit.audit_event «admin_change.<операция>» с автором, списком изменённых столбцов и признаком второго
--    фактора (значения столбцов в событие не пишутся: среди них ссылки на секреты и хеши ключей). Таблицы, у которых свой аудит
--    (price_stop, pricing_halt, pricing_halt_review, membership), получают только страж. Суперпользователь, роль сроков хранения,
--    создания тенанта и входа — не административный сервис, их страж не касается. Фонового администрирования нет: у
--    административного сервиса без пользователя сессии нет ни одной записи.
--    UPDATE platform.app_user у административной роли отозван (находка 7: смена mfa_enabled любому пользователю).
-- 2. Находка 5. Существующий пользователь входит в создаваемый тенант только владельцем, с тем же email и уже входившим через
--    поставщика (есть действующая привязка); участником другого тенанта он становится только приглашением.
-- 3. Р-98. Автоматической перепривязки нет. Владелец тенанта со вторым фактором выпускает приглашение перепривязки участнику;
--    приём приглашения новым входом того же поставщика отзывает прежнюю привязку (platform.external_identity_revocation,
--    неизменяемая) и создаёт новую. Отозванный вход не сопоставляется и приглашений не принимает. Оба шага — в журнале аудита.
-- 4. OQ-151. Срок хранения подреза версии стратегии начинается, когда версия заменена И ни одна неснятая единица записи за ней не
--    закреплена; закрепить единицу за версией, чей подрез уже истекает, нельзя.
-- 5. Находка 6. Параметр причины в слепке проверяется по виду из реестра кода (сумма — целое, валюта — код ISO, перечисление — из
--    значений, момент — ISO 8601, null — только у объявленных nullable); формат слепка — r80.1; имена в withheld — идентификаторы.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Р-97: запись административного сервиса — только от человека, всё в аудите
-- ---------------------------------------------------------------------------
REVOKE UPDATE ON platform.app_user FROM repracer_admin;

SET ROLE repracer_owner;

CREATE FUNCTION security.admin_session() RETURNS boolean
  LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT pg_has_role(session_user, 'repracer_admin', 'MEMBER') AND NOT coalesce((SELECT r.rolsuper FROM pg_roles r WHERE r.rolname = session_user), false)
$$;

CREATE FUNCTION security.require_person_for_admin_write() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  row_tenant uuid;
  u          uuid;
BEGIN
  IF security.admin_session() THEN
    u := security.current_user_id();
    IF u IS NULL THEN
      RAISE EXCEPTION 'administrative change of %.% without a person: the administrative service writes only on an explicit action of a user (Р-97)',
        TG_TABLE_SCHEMA, TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF TG_OP = 'DELETE' THEN
      row_tenant := OLD.tenant_id;
    ELSE
      row_tenant := NEW.tenant_id;
    END IF;
    IF row_tenant IS DISTINCT FROM security.platform_tenant_id() AND NOT EXISTS (
         SELECT 1 FROM tenant_data.membership m WHERE m.tenant_id = row_tenant AND m.user_id = u AND m.status = 'ACTIVE') THEN
      RAISE EXCEPTION 'administrative change of %.% by user % who is not an active member of tenant % (Р-97)', TG_TABLE_SCHEMA, TG_TABLE_NAME, u, row_tenant
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION security.audit_admin_write() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  r          jsonb;
  o          jsonb;
  u          uuid := security.current_user_id();
  row_tenant uuid;
  member     uuid;
  entity     text;
  cols       text[];
BEGIN
  IF NOT security.admin_session() THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'DELETE' THEN
    r := to_jsonb(OLD);
  ELSE
    r := to_jsonb(NEW);
  END IF;
  row_tenant := (r ->> 'tenant_id')::uuid;
  IF row_tenant = security.platform_tenant_id() THEN
    RETURN NULL;
  END IF;
  SELECT m.membership_id INTO member FROM tenant_data.membership m WHERE m.tenant_id = row_tenant AND m.user_id = u AND m.status = 'ACTIVE';
  SELECT r ->> a.attname INTO entity
    FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
   WHERE i.indrelid = TG_RELID AND i.indisprimary AND a.attname <> 'tenant_id' AND a.atttypid = 'uuid'::regtype
   ORDER BY a.attnum LIMIT 1;
  IF TG_OP = 'UPDATE' THEN
    o := to_jsonb(OLD);
    SELECT array_agg(k ORDER BY k) INTO cols FROM jsonb_object_keys(r) AS k WHERE r -> k IS DISTINCT FROM o -> k;
  END IF;
  INSERT INTO audit.audit_event (tenant_id, occurred_at, actor_type, actor_user_id, actor_membership_id, action, entity_type, entity_id, changes)
  VALUES (row_tenant, now(), 'USER', u, member, 'admin_change.' || lower(TG_OP), TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME, entity::uuid,
          jsonb_build_object('columns', to_jsonb(cols), 'secondFactor', security.session_mfa(), 'at', now()));
  RETURN NULL;
END $$;

RESET ROLE;

DO $$
DECLARE
  f regprocedure;
BEGIN
  FOREACH f IN ARRAY ARRAY['security.require_person_for_admin_write()', 'security.audit_admin_write()']::regprocedure[] LOOP
    EXECUTE format('ALTER FUNCTION %s SECURITY DEFINER SET search_path = pg_catalog, pg_temp', f);
    EXECUTE format('ALTER FUNCTION %s OWNER TO repracer_audit_writer', f);
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION security.admin_session() TO repracer_audit_writer, repracer_app;

-- Таблицы по правам, а не по перечню имён: запись есть у административной роли и не разрешена пути решения
CREATE FUNCTION security.admin_only_writes() RETURNS TABLE (table_name regclass, privilege text)
  LANGUAGE sql STABLE AS $$
  SELECT tr.table_name, p.privilege
    FROM security.table_registry tr CROSS JOIN unnest(ARRAY['INSERT', 'UPDATE', 'DELETE']) AS p(privilege)
   WHERE (has_table_privilege('repracer_admin', tr.table_name, p.privilege)
          OR CASE WHEN p.privilege = 'DELETE' THEN false
                  ELSE EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = tr.table_name AND a.attnum > 0 AND NOT a.attisdropped
                                 AND has_column_privilege('repracer_admin', tr.table_name, a.attnum, p.privilege)) END)
     AND NOT EXISTS (SELECT 1 FROM security.decision_path_allowed_privileges() al
                      WHERE al.table_name::regclass = tr.table_name AND al.privilege = p.privilege)
$$;
GRANT EXECUTE ON FUNCTION security.admin_only_writes() TO repracer_admin;

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT table_name, string_agg(privilege, ' OR ' ORDER BY privilege) AS events FROM security.admin_only_writes() GROUP BY table_name LOOP
    EXECUTE format('CREATE TRIGGER a0_admin_write_person BEFORE %s ON %s FOR EACH ROW EXECUTE FUNCTION security.require_person_for_admin_write()', r.events, r.table_name);
    IF r.table_name NOT IN ('tenant_data.price_stop'::regclass, 'channel_data.pricing_halt'::regclass, 'channel_data.pricing_halt_review'::regclass,
                            'tenant_data.membership'::regclass) THEN
      EXECUTE format('CREATE TRIGGER zz_admin_write_audit AFTER %s ON %s FOR EACH ROW EXECUTE FUNCTION security.audit_admin_write()', r.events, r.table_name);
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 3 (таблица и привязки нужны созданию тенанта). Р-98: отзыв привязки входа
-- ---------------------------------------------------------------------------
SET ROLE repracer_owner;
CREATE TABLE platform.external_identity_revocation (
  tenant_id     uuid NOT NULL DEFAULT security.platform_tenant_id() CHECK (tenant_id = security.platform_tenant_id()),
  issuer        text NOT NULL,
  subject       text NOT NULL,
  revoked_at    timestamptz NOT NULL DEFAULT now(),
  -- Приглашение перепривязки, приём которого отозвал вход
  invitation_id uuid NOT NULL,
  PRIMARY KEY (issuer, subject),
  FOREIGN KEY (issuer, subject) REFERENCES platform.external_identity (issuer, subject)
);
ALTER TABLE platform.identity_invitation ADD COLUMN relink boolean NOT NULL DEFAULT false;
ALTER TABLE platform.identity_invitation ADD CONSTRAINT identity_invitation_relink_in_tenant CHECK (NOT relink OR invited_to_tenant_id IS NOT NULL);
RESET ROLE;

-- Срок хранения — как у самой привязки (platform.external_identity, срока нет): удалённый отзыв вернул бы вход к жизни
SELECT security.register_table('platform.external_identity_revocation', 'PLATFORM', 'append_only', 'none');
REVOKE ALL ON platform.external_identity_revocation FROM repracer_admin;
CREATE POLICY external_identity_revocation_app_none ON platform.external_identity_revocation FOR SELECT TO repracer_app USING (false);
CREATE POLICY resolver_revocation ON platform.external_identity_revocation TO repracer_resolver USING (true) WITH CHECK (true);
GRANT SELECT, INSERT ON platform.external_identity_revocation TO repracer_resolver;
GRANT SELECT ON platform.external_identity TO repracer_resolver;
GRANT INSERT (relink) ON platform.identity_invitation TO repracer_resolver;

-- У пользователя не больше одной ДЕЙСТВУЮЩЕЙ привязки на поставщика: уникальность (user_id, issuer) заменяется проверкой без отозванных
DO $$
DECLARE
  c text;
BEGIN
  SELECT con.conname INTO c FROM pg_constraint con
   WHERE con.conrelid = 'platform.external_identity'::regclass AND con.contype = 'u'
     AND (SELECT array_agg(a.attname::text ORDER BY a.attname) FROM pg_attribute a WHERE a.attrelid = con.conrelid AND a.attnum = ANY (con.conkey)) = ARRAY['issuer', 'user_id'];
  EXECUTE format('ALTER TABLE platform.external_identity DROP CONSTRAINT %I', c);
END $$;
SET ROLE repracer_owner;
-- Проверка единственной действующей привязки: поиск привязок пользователя у поставщика
CREATE INDEX external_identity_user_issuer_idx ON platform.external_identity (user_id, issuer);
CREATE FUNCTION platform.external_identity_one_active() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM platform.external_identity e
              WHERE e.user_id = NEW.user_id AND e.issuer = NEW.issuer AND e.subject <> NEW.subject
                AND NOT EXISTS (SELECT 1 FROM platform.external_identity_revocation rv WHERE rv.issuer = e.issuer AND rv.subject = e.subject)) THEN
    RAISE EXCEPTION 'user % already has an active sign-in of issuer % (Р-98)', NEW.user_id, NEW.issuer USING ERRCODE = 'unique_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER a_external_identity_one_active BEFORE INSERT ON platform.external_identity
  FOR EACH ROW EXECUTE FUNCTION platform.external_identity_one_active();
RESET ROLE;
ALTER FUNCTION platform.external_identity_one_active() SECURITY DEFINER SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION platform.external_identity_one_active() OWNER TO repracer_resolver;
REVOKE EXECUTE ON FUNCTION platform.external_identity_one_active() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- 2. Находка 5: создание тенанта
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION security.provision_tenant(p_tenant_id uuid, p_name text, p_data_region text, p_members jsonb) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  m        jsonb;
  existing record;
BEGIN
  IF jsonb_typeof(p_members) IS DISTINCT FROM 'array'
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_members) e WHERE e.value ->> 'role' = 'OWNER') THEN
    RAISE EXCEPTION 'a tenant is provisioned together with its owner' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  INSERT INTO tenant_data.tenant (tenant_id, name, data_region) VALUES (p_tenant_id, p_name, p_data_region);
  FOR m IN SELECT value FROM jsonb_array_elements(p_members) LOOP
    SELECT u.user_id, u.email INTO existing FROM platform.app_user u WHERE u.user_id = (m ->> 'userId')::uuid;
    IF existing.user_id IS NULL THEN
      INSERT INTO platform.app_user (user_id, email, mfa_enabled)
      VALUES ((m ->> 'userId')::uuid, lower(trim(m ->> 'email')), coalesce((m ->> 'mfaEnabled')::boolean, false));
    ELSE
      -- Находка 5 ревью шага 16: существующий пользователь — только владелец нового тенанта, тем же адресом и уже входивший
      IF m ->> 'role' IS DISTINCT FROM 'OWNER' THEN
        RAISE EXCEPTION 'existing user % joins a tenant as % only by an invitation of its owner (step 16 finding 5)', existing.user_id, m ->> 'role'
          USING ERRCODE = 'insufficient_privilege';
      END IF;
      IF lower(trim(m ->> 'email')) IS DISTINCT FROM existing.email THEN
        RAISE EXCEPTION 'the provisioned email of existing user % does not match the user (step 16 finding 5)', existing.user_id USING ERRCODE = 'insufficient_privilege';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM platform.external_identity e WHERE e.user_id = existing.user_id
                        AND NOT EXISTS (SELECT 1 FROM platform.external_identity_revocation rv WHERE rv.issuer = e.issuer AND rv.subject = e.subject)) THEN
        RAISE EXCEPTION 'existing user % has never signed in: an owner is provisioned after accepting the signup invitation (step 16 finding 5)', existing.user_id
          USING ERRCODE = 'insufficient_privilege';
      END IF;
    END IF;
    INSERT INTO tenant_data.membership (tenant_id, membership_id, user_id, role, status)
    VALUES (p_tenant_id, coalesce((m ->> 'membershipId')::uuid, gen_random_uuid()), (m ->> 'userId')::uuid, m ->> 'role', 'ACTIVE');
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Р-98: приглашение перепривязки, приём, сопоставление без отозванных
-- ---------------------------------------------------------------------------
SET ROLE repracer_owner;
CREATE FUNCTION security.invite_relink(p_tenant_id uuid, p_user_id uuid, p_token_sha256 bytea, p_ttl interval) RETURNS uuid
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  iid uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM tenant_data.membership m
                  WHERE m.tenant_id = p_tenant_id AND m.user_id = security.current_user_id() AND m.status = 'ACTIVE' AND m.role = 'OWNER') THEN
    RAISE EXCEPTION 'only an active owner of the tenant relinks a sign-in (Р-98)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT security.session_mfa() THEN
    RAISE EXCEPTION 'relinking a sign-in requires a second factor (Р-98)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM tenant_data.membership m WHERE m.tenant_id = p_tenant_id AND m.user_id = p_user_id AND m.status = 'ACTIVE') THEN
    RAISE EXCEPTION 'user % is not an active member of tenant %: a relink is issued to a member (Р-98)', p_user_id, p_tenant_id USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_ttl <= interval '0' OR p_ttl > interval '14 days' THEN
    RAISE EXCEPTION 'invitation lifetime must be within 14 days' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  INSERT INTO platform.identity_invitation (user_id, invited_to_tenant_id, token_sha256, created_by_user_id, expires_at, relink)
  VALUES (p_user_id, p_tenant_id, p_token_sha256, security.current_user_id(), now() + p_ttl, true)
  RETURNING invitation_id INTO iid;
  RETURN iid;
END $$;
RESET ROLE;
ALTER FUNCTION security.invite_relink(uuid, uuid, bytea, interval) OWNER TO repracer_resolver;
REVOKE ALL ON FUNCTION security.invite_relink(uuid, uuid, bytea, interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION security.invite_relink(uuid, uuid, bytea, interval) TO repracer_admin;

CREATE OR REPLACE FUNCTION security.accept_identity_invitation(p_token_sha256 bytea, p_issuer text, p_subject text, p_email text, p_email_verified boolean) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  inv    record;
  linked uuid;
  prior  text;
BEGIN
  SELECT i.invitation_id, i.user_id, i.invited_to_tenant_id, i.expires_at, i.accepted_at, i.relink, u.email, u.status INTO inv
    FROM platform.identity_invitation i JOIN platform.app_user u ON u.user_id = i.user_id
   WHERE i.token_sha256 = p_token_sha256
   FOR UPDATE OF i;
  IF inv IS NULL OR inv.accepted_at IS NOT NULL OR inv.expires_at <= now() OR inv.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'invitation is unknown, used or expired' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_email_verified IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'the provider has not verified the email of this sign-in (finding 11)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_email IS NULL OR lower(trim(p_email)) <> inv.email THEN
    RAISE EXCEPTION 'invitation was issued for another email' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF EXISTS (SELECT 1 FROM platform.external_identity_revocation rv WHERE rv.issuer = p_issuer AND rv.subject = p_subject) THEN
    RAISE EXCEPTION 'this sign-in was unlinked by a relink and accepts no invitation (Р-98)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT e.user_id INTO linked FROM platform.external_identity e WHERE e.issuer = p_issuer AND e.subject = p_subject;
  IF linked IS NULL THEN
    SELECT e.subject INTO prior FROM platform.external_identity e
     WHERE e.user_id = inv.user_id AND e.issuer = p_issuer
       AND NOT EXISTS (SELECT 1 FROM platform.external_identity_revocation rv WHERE rv.issuer = e.issuer AND rv.subject = e.subject);
    IF prior IS NOT NULL THEN
      IF NOT inv.relink THEN
        RAISE EXCEPTION 'the user is already linked to another sign-in of this provider; a relink needs a relink invitation of the tenant owner (Р-98)'
          USING ERRCODE = 'insufficient_privilege';
      END IF;
      INSERT INTO platform.external_identity_revocation (issuer, subject, invitation_id) VALUES (p_issuer, prior, inv.invitation_id);
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

CREATE OR REPLACE FUNCTION security.resolve_external_identity(p_issuer text, p_subject text)
  RETURNS TABLE (user_id uuid, tenant_id uuid, membership_id uuid, role text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT e.user_id, m.tenant_id, m.membership_id, m.role
    FROM platform.external_identity e
    JOIN platform.app_user u ON u.user_id = e.user_id AND u.status = 'ACTIVE'
    LEFT JOIN (tenant_data.membership m JOIN tenant_data.tenant t
                 ON t.tenant_id = m.tenant_id AND t.kind = 'CUSTOMER' AND t.status IN ('TRIAL', 'ACTIVE', 'SUSPENDED'))
      ON m.user_id = e.user_id AND m.status = 'ACTIVE'
   WHERE e.issuer = p_issuer AND e.subject = p_subject
     -- Р-98: отозванный перепривязкой вход никого не сопоставляет
     AND NOT EXISTS (SELECT 1 FROM platform.external_identity_revocation rv WHERE rv.issuer = e.issuer AND rv.subject = e.subject)
$$;

-- Аудит перепривязки: выпуск приглашения (автор — владелец) и приём (автор — сам участник)
SET ROLE repracer_owner;
CREATE FUNCTION platform.identity_relink_audit() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  actor  uuid;
  member uuid;
BEGIN
  actor := CASE TG_OP WHEN 'INSERT' THEN NEW.created_by_user_id ELSE NEW.user_id END;
  SELECT m.membership_id INTO member FROM tenant_data.membership m
   WHERE m.tenant_id = NEW.invited_to_tenant_id AND m.user_id = actor AND m.status = 'ACTIVE';
  INSERT INTO audit.audit_event (tenant_id, occurred_at, actor_type, actor_user_id, actor_membership_id, action, entity_type, entity_id, changes)
  VALUES (NEW.invited_to_tenant_id, now(), 'USER', actor, member,
          CASE TG_OP WHEN 'INSERT' THEN 'identity.relink_invited' ELSE 'identity.relinked' END, 'identity_invitation', NEW.invitation_id,
          jsonb_build_object('userId', NEW.user_id, 'issuer', coalesce(NEW.accepted_issuer, NULL), 'secondFactor', security.session_mfa(), 'at', now()));
  RETURN NULL;
END $$;
CREATE TRIGGER zz_identity_relink_invited_audit AFTER INSERT ON platform.identity_invitation
  FOR EACH ROW WHEN (NEW.relink) EXECUTE FUNCTION platform.identity_relink_audit();
CREATE TRIGGER zz_identity_relinked_audit AFTER UPDATE OF accepted_at ON platform.identity_invitation
  FOR EACH ROW WHEN (NEW.relink AND OLD.accepted_at IS NULL AND NEW.accepted_at IS NOT NULL) EXECUTE FUNCTION platform.identity_relink_audit();
RESET ROLE;
ALTER FUNCTION platform.identity_relink_audit() SECURITY DEFINER SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION platform.identity_relink_audit() OWNER TO repracer_audit_writer;
REVOKE EXECUTE ON FUNCTION platform.identity_relink_audit() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- 4. OQ-151: подрез закреплённой версии не истекает
-- ---------------------------------------------------------------------------
SET ROLE repracer_owner;
CREATE OR REPLACE FUNCTION channel_data.pricing_strategy_undercut_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.tenant_id, NEW.pricing_strategy_id, NEW.version, NEW.undercut_minor, NEW.created_at)
       IS DISTINCT FROM (OLD.tenant_id, OLD.pricing_strategy_id, OLD.version, OLD.undercut_minor, OLD.created_at)
     OR OLD.superseded_at IS NOT NULL OR NEW.superseded_at IS NULL THEN
    RAISE EXCEPTION 'the undercut of a strategy version is immutable; only its supersession is recorded once (Р-91)' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM tenant_data.pricing_strategy n
                  WHERE n.tenant_id = NEW.tenant_id AND n.pricing_strategy_id = NEW.pricing_strategy_id AND n.version > NEW.version) THEN
    RAISE EXCEPTION 'strategy % version % is not replaced: its undercut does not start expiring (OQ-151)', NEW.pricing_strategy_id, NEW.version
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM tenant_data.write_scope s
              WHERE s.tenant_id = NEW.tenant_id AND s.pricing_strategy_id = NEW.pricing_strategy_id AND s.pricing_strategy_version = NEW.version
                AND s.status <> 'RETIRED') THEN
    RAISE EXCEPTION 'strategy % version % is still pinned by a write scope: its undercut does not start expiring (OQ-151)', NEW.pricing_strategy_id, NEW.version
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION tenant_data.pricing_strategy_supersede_undercut() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  UPDATE channel_data.pricing_strategy_undercut u SET superseded_at = greatest(NEW.created_at, u.created_at)
   WHERE u.tenant_id = NEW.tenant_id AND u.pricing_strategy_id = NEW.pricing_strategy_id AND u.version < NEW.version AND u.superseded_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM tenant_data.write_scope s
                      WHERE s.tenant_id = u.tenant_id AND s.pricing_strategy_id = u.pricing_strategy_id AND s.pricing_strategy_version = u.version
                        AND s.status <> 'RETIRED');
  RETURN NULL;
END $$;

-- Единица отпустила версию (перешла на другую или снята) — у заменённой и больше не закреплённой версии начинается срок подреза
CREATE FUNCTION tenant_data.write_scope_release_strategy_version() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.pricing_strategy_id IS NOT NULL
     AND ((NEW.pricing_strategy_id, NEW.pricing_strategy_version) IS DISTINCT FROM (OLD.pricing_strategy_id, OLD.pricing_strategy_version)
          OR (NEW.status = 'RETIRED' AND OLD.status <> 'RETIRED')) THEN
    UPDATE channel_data.pricing_strategy_undercut u SET superseded_at = now()
     WHERE u.tenant_id = OLD.tenant_id AND u.pricing_strategy_id = OLD.pricing_strategy_id AND u.version = OLD.pricing_strategy_version AND u.superseded_at IS NULL
       AND EXISTS (SELECT 1 FROM tenant_data.pricing_strategy n WHERE n.tenant_id = u.tenant_id AND n.pricing_strategy_id = u.pricing_strategy_id AND n.version > u.version)
       AND NOT EXISTS (SELECT 1 FROM tenant_data.write_scope s
                        WHERE s.tenant_id = u.tenant_id AND s.pricing_strategy_id = u.pricing_strategy_id AND s.pricing_strategy_version = u.version
                          AND s.status <> 'RETIRED');
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER zb_write_scope_release_strategy_version AFTER UPDATE OF pricing_strategy_id, pricing_strategy_version, status ON tenant_data.write_scope
  FOR EACH ROW EXECUTE FUNCTION tenant_data.write_scope_release_strategy_version();

-- Закрепить единицу за версией, чей подрез уже истекает, нельзя: через 18 месяцев оценка отказала бы
CREATE FUNCTION tenant_data.write_scope_pins_live_strategy_version() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.pricing_strategy_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR (NEW.pricing_strategy_id, NEW.pricing_strategy_version) IS DISTINCT FROM (OLD.pricing_strategy_id, OLD.pricing_strategy_version))
     AND EXISTS (SELECT 1 FROM channel_data.pricing_strategy_undercut u
                  WHERE u.tenant_id = NEW.tenant_id AND u.pricing_strategy_id = NEW.pricing_strategy_id AND u.version = NEW.pricing_strategy_version
                    AND u.superseded_at IS NOT NULL) THEN
    RAISE EXCEPTION 'strategy % version % was replaced and its undercut expires: pin the current version (OQ-151)', NEW.pricing_strategy_id, NEW.pricing_strategy_version
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER b_write_scope_pins_live_strategy_version BEFORE INSERT OR UPDATE OF pricing_strategy_id, pricing_strategy_version ON tenant_data.write_scope
  FOR EACH ROW EXECUTE FUNCTION tenant_data.write_scope_pins_live_strategy_version();

-- ---------------------------------------------------------------------------
-- 5. Находка 6: виды и значения параметров слепка
-- ---------------------------------------------------------------------------
-- Вид параметра по коду причины (k — вид ParamKind, n — допускает null, v — значения перечисления); классы CHANNEL и CHANNEL_DERIVED не входят.
-- Сгенерировано из REASON_PARAMS и SANITY_NOTE_PARAMS; совпадение с кодом проверяет undercut-eternal.pg.test.ts
CREATE FUNCTION security.eternal_param_kinds() RETURNS jsonb
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT '{"ABOVE_MAX_PRICE":{"currency":{"k":"currency"},"deviationBp":{"k":"bp"},"maxMinor":{"k":"money","n":true},"proposedMinor":{"k":"money","n":true},"source":{"k":"enum","v":["GATE","DATABASE"]}},"ALREADY_AT_TARGET":{"currency":{"k":"currency"}},"ALREADY_WINNING_BUYBOX":{},"APPROVED":{"ceilingMinor":{"k":"money"},"currency":{"k":"currency"},"finalMinor":{"k":"money"},"floorMinor":{"k":"money"}},"BELOW_MARGIN_FLOOR":{"currency":{"k":"currency"},"deviationBp":{"k":"bp"},"floorMinor":{"k":"money"},"minMarginBp":{"k":"bp"},"minMinor":{"k":"money"},"proposedMinor":{"k":"money"}},"BELOW_MIN_PRICE":{"currency":{"k":"currency"},"deviationBp":{"k":"bp"},"minMinor":{"k":"money","n":true},"proposedMinor":{"k":"money","n":true},"source":{"k":"enum","v":["GATE","DATABASE"]}},"BOUND_CURRENCY_MISMATCH":{"bound":{"k":"enum","v":["min","max","margin_floor","both"]},"boundBasis":{"k":"enum","n":true,"v":["GROSS","NET"]},"boundCurrency":{"k":"currency","n":true},"cause":{"k":"enum","v":["MISSING","CURRENCY_MISMATCH","BASIS_MISMATCH","INVALID_AMOUNT","MIN_ABOVE_MAX","COST_PROFILE_MISSING","COST_CURRENCY_MISMATCH","VAT_UNKNOWN","UNATTAINABLE","INVALID_INPUT","MARGIN_FLOOR_ABOVE_MAX_PRICE","FX_RATE_UNAVAILABLE","FX_RATE_STALE","UNSUPPORTED_CURRENCY","FEE_ESTIMATE_MISSING"]},"scopeBasis":{"k":"enum","v":["GROSS","NET"]},"scopeCurrency":{"k":"currency"}},"BOUND_UNRESOLVABLE":{"bound":{"k":"enum","v":["min","max","margin_floor","both"]},"boundBasis":{"k":"enum","v":["GROSS","NET"]},"boundCurrency":{"k":"currency"},"cause":{"k":"enum","v":["MISSING","CURRENCY_MISMATCH","BASIS_MISMATCH","INVALID_AMOUNT","MIN_ABOVE_MAX","COST_PROFILE_MISSING","COST_CURRENCY_MISMATCH","VAT_UNKNOWN","UNATTAINABLE","INVALID_INPUT","MARGIN_FLOOR_ABOVE_MAX_PRICE","FX_RATE_UNAVAILABLE","FX_RATE_STALE","UNSUPPORTED_CURRENCY","FEE_ESTIMATE_MISSING"]},"minMarginBp":{"k":"bp"},"scopeBasis":{"k":"enum","v":["GROSS","NET"]},"scopeCurrency":{"k":"currency"}},"BOUNDS_INVALID":{"currency":{"k":"currency"},"maxMinor":{"k":"money","n":true},"minMinor":{"k":"money","n":true}},"BOUNDS_INVERTED":{"currency":{"k":"currency"},"maxMinor":{"k":"money"},"minMinor":{"k":"money"}},"BOUNDS_VERSION_CHANGED":{"attempt":{"k":"count"},"changed":{"k":"enumList","v":["MIN_PRICE","MAX_PRICE","CHANNEL_HALT","PRICING_STOP"]},"currency":{"k":"currency"},"newMaxMinor":{"k":"money","n":true},"newMinMinor":{"k":"money","n":true},"oldMaxMinor":{"k":"money","n":true},"oldMinMinor":{"k":"money","n":true}},"BUYBOX_MATCH":{"currency":{"k":"currency"}},"BUYBOX_UNDERCUT":{"currency":{"k":"currency"}},"CAPPED_AT_MAX_PRICE":{"currency":{"k":"currency"},"maxMinor":{"k":"money"}},"CAPPED_AT_MIN_PRICE":{"currency":{"k":"currency"},"minMinor":{"k":"money"}},"CHANGE_RATE_LIMIT":{"changes":{"k":"count"},"limit":{"k":"count"}},"CHANNEL_HALTED":{"haltedAt":{"k":"instant"},"haltId":{"k":"id"},"haltReason":{"k":"enum","v":["CHANNEL_MASS_SHIFT"]},"marketplace":{"k":"id","n":true},"ruleCode":{"k":"enum","v":["FIXED","TARGET_MARGIN","MATCH_BUYBOX","BEAT_LOWEST","POSITION"]},"stage":{"k":"enum","v":["INPUT","GATE","DISPATCH","DATABASE"]}},"CHANNEL_MASS_SHIFT":{"maxSpread":{"k":"ratio"},"windowMinutes":{"k":"minutes"}},"COMPETITOR_REQUIREMENT_NOT_MET":{"maxStalenessSeconds":{"k":"seconds","n":true},"requiredCompleteness":{"k":"enum","n":true,"v":["TOP_N","CHEAPEST_ONLY","FULL"]},"requiredN":{"k":"count","n":true}},"COST_INPUTS_MISSING":{"missing":{"k":"enum","v":["COST_PROFILE","VAT_RATE"]}},"COST_NOT_DECLARED":{},"CROSS_CHANNEL_FX_UNAVAILABLE":{"cause":{"k":"enum","v":["FX_RATE_UNAVAILABLE","FX_RATE_STALE","UNSUPPORTED_CURRENCY","INVALID_INPUT"]},"channel":{"k":"enum","v":["KAUFLAND","AMAZON","EBAY","OTTO"]},"currency":{"k":"currency"},"expected":{"k":"currency"},"marketplace":{"k":"id"}},"CROSS_CHANNEL_MISMATCH":{"currency":{"k":"currency"},"field":{"k":"enum","v":["buybox","lowest","suggested"]},"fxFrom":{"k":"currency"},"fxRateDate":{"k":"date"},"fxRateMicros":{"k":"rateMicros"},"limit":{"k":"ratio"},"referenceStorefronts":{"k":"storefrontList"}},"CURRENCY_MISMATCH":{"expected":{"k":"currency"},"field":{"k":"enum","v":["BUYBOX_PRICE","SUGGESTED_PRICE","OFFER_PRICE","OFFER_SHIPPING","OFFER_TOTAL","OBSERVED_AT"]}},"DISPERSED_MARKET_EVENT":{"maxSpread":{"k":"ratio"}},"DIVERGENCE_CASE_OPENED":{"currency":{"k":"currency"},"expectedMinor":{"k":"money"}},"ENGINE_CURRENCY_MISMATCH":{"expected":{"k":"currency"},"source":{"k":"enum","v":["SNAPSHOT","COST"]}},"FIXED_PRICE":{"currency":{"k":"currency"},"targetMinor":{"k":"money"}},"HALT_AUTO_RELEASED":{"haltId":{"k":"id"},"sampleSize":{"k":"count"}},"HALT_MANUALLY_RELEASED":{"haltId":{"k":"id"},"membershipId":{"k":"id"},"note":{"k":"userText"}},"HALT_REVIEW_FAILED":{"failed":{"k":"count"},"haltId":{"k":"id"},"nextReviewAt":{"k":"instant"},"sampleSize":{"k":"count"}},"HISTORY_AVAILABLE":{},"HISTORY_TOO_SHORT":{"minHistoryDays":{"k":"count"}},"INCONSISTENT_SNAPSHOT":{"currency":{"k":"currency"},"inconsistency":{"k":"enum","v":["OFFER_TOTAL_NOT_PRICE_PLUS_SHIPPING","MORE_OFFERS_THAN_TOP_N","BUYBOX_NOT_RANK_ONE_PRICE"]}},"INTENT_EXPIRED":{"createdAt":{"k":"instant"},"decidedAt":{"k":"instant"},"expiresAt":{"k":"instant"},"waitedSeconds":{"k":"seconds"}},"INTENT_INVALID":{"problem":{"k":"enum","v":["WRITE_SCOPE_MISMATCH","CURRENCY_OR_BASIS_MISMATCH","NON_POSITIVE_AMOUNT"]}},"INTERNAL_BOUND_VIOLATION":{"amountMinor":{"k":"money","n":true},"ceilingMinor":{"k":"money"},"check":{"k":"enum","v":["CURRENT_WITHIN_BOUNDS","FINAL_RECHECK"]},"currency":{"k":"currency"},"floorMinor":{"k":"money"}},"INTERNAL_OUTLIER_IGNORED":{"currency":{"k":"currency"}},"INVALID_AMOUNT":{"currency":{"k":"currency"},"field":{"k":"enum","v":["BUYBOX_PRICE","SUGGESTED_PRICE","OFFER_PRICE","OFFER_SHIPPING","OFFER_TOTAL","OBSERVED_AT"]}},"INVALID_STRATEGY_PARAMS":{"allowed":{"k":"enum","v":["POSITIVE","NON_NEGATIVE","MARGIN_BELOW_100_PERCENT"]},"currency":{"k":"currency"},"param":{"k":"enum","v":["deadbandMinor","priceMinor","targetMarginBp","undercutMinor"]},"settingBp":{"k":"bp","n":true},"settingMinor":{"k":"money","n":true}},"LOWEST_MATCH":{"currency":{"k":"currency"},"scope":{"k":"enum","v":["VISIBLE_TOP_N","MARKET"]}},"LOWEST_UNDERCUT":{"currency":{"k":"currency"},"scope":{"k":"enum","v":["VISIBLE_TOP_N","MARKET"]}},"MARGIN_TARGET":{"currency":{"k":"currency"},"marginBp":{"k":"bp"},"targetMinor":{"k":"money"}},"MARGIN_UNATTAINABLE":{"currency":{"k":"currency"},"feeRateBp":{"k":"bp"},"fixedFeeMinor":{"k":"money"},"marginBp":{"k":"bp"},"unitCostMinor":{"k":"money"},"vatRateBp":{"k":"bp","n":true}},"MARGIN_WITHOUT_COST":{"cause":{"k":"enum","v":["COST_PROFILE_MISSING","FEE_ESTIMATE_MISSING","VAT_RATE_MISSING","FX_RATE_UNAVAILABLE","FX_RATE_STALE","UNSUPPORTED_CURRENCY","INVALID_INPUT"]},"minMarginBp":{"k":"bp","n":true},"requiredBy":{"k":"enumList","v":["STRATEGY","MIN_MARGIN"]},"strategyType":{"k":"enum","v":["FIXED","TARGET_MARGIN","MATCH_BUYBOX","BEAT_LOWEST"]}},"MARKET_SHIFT_DISPERSED":{"maxSpread":{"k":"ratio"},"windowMinutes":{"k":"minutes"}},"MARKET_SHIFT_SINGLE_SELLER":{"maxSpread":{"k":"ratio"},"windowMinutes":{"k":"minutes"}},"MAX_PRICE_MISSING":{},"MIN_PRICE_MISSING":{},"NO_CHANGE":{},"NO_COMPETITOR_OFFERS":{},"NO_FRESH_CROSS_CHANNEL_REFERENCE":{"maxAgeSeconds":{"k":"seconds"}},"NO_PLAUSIBILITY_ANCHOR":{"costDeclared":{"k":"bool"},"minHistoryDays":{"k":"count"},"minOffers":{"k":"count"}},"NO_PREVIOUS_SNAPSHOT":{},"NO_SCALE_REFERENCE":{},"NO_SCOPE_FOR_PRODUCT":{"writeScopeId":{"k":"id"}},"OUT_OF_ORDER":{},"OUTSIDE_HISTORY_BAND":{"bandFactor":{"k":"ratio"},"currency":{"k":"currency"},"field":{"k":"enum","v":["buybox","lowest","suggested"]}},"OWN_PRICE_DEVIATION":{"currency":{"k":"currency"},"field":{"k":"enum","v":["buybox","lowest","suggested"]},"limit":{"k":"ratio"},"ourPriceMinor":{"k":"money"}},"PRICE_ABOVE_COST_ANCHOR":{"costMinor":{"k":"money"},"currency":{"k":"currency"},"field":{"k":"enum","v":["buybox","lowest","suggested"]},"limit":{"k":"ratio"}},"PRICE_BASIS_MISMATCH":{"expected":{"k":"enum","v":["GROSS","NET"]},"field":{"k":"enum","v":["BUYBOX_PRICE","SUGGESTED_PRICE","OFFER_PRICE","OFFER_SHIPPING","OFFER_TOTAL","OBSERVED_AT"]}},"PRICE_BELOW_COST_ANCHOR":{"costMinor":{"k":"money"},"currency":{"k":"currency"},"field":{"k":"enum","v":["buybox","lowest","suggested"]},"limit":{"k":"ratio"}},"PRICING_STOPPED":{"channelAccountId":{"k":"id","n":true},"marketplace":{"k":"id","n":true},"scope":{"k":"enum","v":["TENANT","CHANNEL_ACCOUNT","STOREFRONT"]},"stage":{"k":"enum","v":["GATE","DISPATCH","DATABASE"]},"stopId":{"k":"id"},"stoppedAt":{"k":"instant"},"stoppedBy":{"k":"id"}},"REFERENCES_CONVERTED_AT_ECB":{"currency":{"k":"currency"},"fxFrom":{"k":"currency"},"fxRateDate":{"k":"date"},"fxRateMicros":{"k":"rateMicros"}},"REFERENCES_WITHOUT_ECB_RATE":{},"SCOPE_NOT_ACTIVE":{"action":{"k":"enum","n":true,"v":["RECONNECT_ACCOUNT","CHECK_ACCOUNT_STATUS","CHECK_LISTING","REVIEW_CHANNEL_POLICY","CONTACT_CHANNEL_SUPPORT","REVIEW_OFFER_STATUS"]},"blockedByErrorCode":{"k":"enum","n":true,"v":["RATE_LIMITED","CHANNEL_UNAVAILABLE","TIMEOUT","NETWORK","AUTH_INVALID","AUTH_EXPIRED","ACCOUNT_INACTIVE","FORBIDDEN","VALIDATION","NOT_FOUND","DUPLICATE_ACTION","STALE_VERSION","ACTION_NOT_ALLOWED","PRECONDITION_FAILED","EDIT_BUDGET_EXHAUSTED","OFFER_NOT_LIVE","POLICY_VIOLATION","TENANT_MISMATCH","SIGNATURE_INVALID","UNSUPPORTED","UNKNOWN","MAX_ATTEMPTS","NOT_APPLIED","SCOPE_HELD","SCOPE_CONTESTED","SCOPE_BLOCKED","SCOPE_RETIRED","OUTCOME_UNRESOLVED"]},"blockedSince":{"k":"instant","n":true},"mode":{"k":"enum","v":["OFF","ENGINE","KAUFLAND_SMART_PRICING"]},"status":{"k":"enum","v":["ACTIVE","HELD","CONTESTED","BLOCKED","RETIRED"]}},"SCOPE_NOT_ENGINE":{"mode":{"k":"enum","n":true,"v":["OFF","ENGINE","KAUFLAND_SMART_PRICING"]}},"SELF_OFFER_DIVERGENCE":{"currency":{"k":"currency"},"limit":{"k":"ratio"},"ourPriceMinor":{"k":"money"}},"SHIFT_BELOW_SHARE":{"minProducts":{"k":"count"},"share":{"k":"ratio"}},"SINGLE_SELLER_MARKET_EVENT":{},"SMALL_MOVE":{"minFactor":{"k":"ratio"}},"SNAPSHOT_FROM_FUTURE":{"maxSkewSeconds":{"k":"seconds"}},"SNAPSHOT_INTERNAL_OUTLIER":{"currency":{"k":"currency"},"outlierFactor":{"k":"ratio"}},"SNAPSHOT_TOO_OLD":{"maxAgeSeconds":{"k":"seconds"}},"STEP_LIMIT":{"currency":{"k":"currency"},"currentMinor":{"k":"money"},"limitBp":{"k":"bp"},"proposedMinor":{"k":"money"},"stepBp":{"k":"bp"}},"STRATEGY_MISSING":{},"TARGET_OUTSIDE_BOUNDS_HOLD":{"currency":{"k":"currency"},"maxMinor":{"k":"money"},"minMinor":{"k":"money"}},"TOO_FEW_COMPETITOR_OFFERS":{"minOffers":{"k":"count"}},"UNIT_SCALE_X0_01":{"anchor":{"k":"enum","v":["COST","CROSS_CHANNEL","HISTORY","LAST_ACCEPTED"]},"currency":{"k":"currency"},"field":{"k":"enum","v":["buybox","lowest","suggested"]}},"UNIT_SCALE_X100":{"anchor":{"k":"enum","v":["COST","CROSS_CHANNEL","HISTORY","LAST_ACCEPTED"]},"currency":{"k":"currency"},"field":{"k":"enum","v":["buybox","lowest","suggested"]}},"WITHIN_DEADBAND":{"currency":{"k":"currency"},"deadbandMinor":{"k":"money"}},"WRITE_BLOCKED_BY_BOUND_RECHECK":{"amountMinor":{"k":"money"},"cause":{"k":"enum","v":["MISSING","CURRENCY_MISMATCH","BASIS_MISMATCH","INVALID_AMOUNT","MIN_ABOVE_MAX","COST_PROFILE_MISSING","COST_CURRENCY_MISMATCH","VAT_UNKNOWN","UNATTAINABLE","INVALID_INPUT","MARGIN_FLOOR_ABOVE_MAX_PRICE","FX_RATE_UNAVAILABLE","FX_RATE_STALE","UNSUPPORTED_CURRENCY","FEE_ESTIMATE_MISSING"]},"ceilingMinor":{"k":"money","n":true},"currency":{"k":"currency"},"floorMinor":{"k":"money","n":true},"marginFloorMinor":{"k":"money"},"minMarginBp":{"k":"bp"},"minMinor":{"k":"money"},"violated":{"k":"enum","v":["FLOOR","CEILING","FLOOR_UNRESOLVABLE"]}},"WRITE_BUDGET_DAY_UNCONFIRMED":{"marketplace":{"k":"id"}},"WRITE_EDIT_BUDGET_EXHAUSTED":{"budgetDay":{"k":"date"},"limit":{"k":"count"},"resetsAt":{"k":"instant","n":true},"source":{"k":"enum","v":["CHANNEL","DATABASE"]},"timeZone":{"k":"id","n":true},"used":{"k":"count"}},"WRITE_NOT_ACCEPTED_BY_CHANNEL":{"errorClass":{"k":"enum","v":["TRANSIENT","PERMANENT","REQUIRES_HUMAN"]},"status":{"k":"enum","v":["RATE_LIMITED","CHANNEL_UNAVAILABLE","TIMEOUT","NETWORK","AUTH_INVALID","AUTH_EXPIRED","ACCOUNT_INACTIVE","FORBIDDEN","VALIDATION","NOT_FOUND","DUPLICATE_ACTION","STALE_VERSION","ACTION_NOT_ALLOWED","PRECONDITION_FAILED","EDIT_BUDGET_EXHAUSTED","OFFER_NOT_LIVE","POLICY_VIOLATION","TENANT_MISMATCH","SIGNATURE_INVALID","UNSUPPORTED","UNKNOWN","MAX_ATTEMPTS","NOT_APPLIED","SCOPE_HELD","SCOPE_CONTESTED","SCOPE_BLOCKED","SCOPE_RETIRED","OUTCOME_UNRESOLVED"]}},"WRITE_OUTCOME_RECONCILED":{"result":{"k":"enum","v":["APPLIED","NOT_APPLIED"]}},"WRITE_PRICING_MODE_CHANGED":{"mode":{"k":"enum","v":["OFF","ENGINE","KAUFLAND_SMART_PRICING"]}},"WRITE_QUEUED_BEHIND_IN_FLIGHT":{"inFlightWriteId":{"k":"id"}},"WRITE_RETRIES_EXHAUSTED":{"attempts":{"k":"count"},"code":{"k":"enum","v":["RATE_LIMITED","CHANNEL_UNAVAILABLE","TIMEOUT","NETWORK","AUTH_INVALID","AUTH_EXPIRED","ACCOUNT_INACTIVE","FORBIDDEN","VALIDATION","NOT_FOUND","DUPLICATE_ACTION","STALE_VERSION","ACTION_NOT_ALLOWED","PRECONDITION_FAILED","EDIT_BUDGET_EXHAUSTED","OFFER_NOT_LIVE","POLICY_VIOLATION","TENANT_MISMATCH","SIGNATURE_INVALID","UNSUPPORTED","UNKNOWN","MAX_ATTEMPTS","NOT_APPLIED","SCOPE_HELD","SCOPE_CONTESTED","SCOPE_BLOCKED","SCOPE_RETIRED","OUTCOME_UNRESOLVED"]}},"WRITE_RETRY_SCHEDULED":{"at":{"k":"instant"},"attempt":{"k":"count"},"code":{"k":"enum","v":["RATE_LIMITED","CHANNEL_UNAVAILABLE","TIMEOUT","NETWORK","AUTH_INVALID","AUTH_EXPIRED","ACCOUNT_INACTIVE","FORBIDDEN","VALIDATION","NOT_FOUND","DUPLICATE_ACTION","STALE_VERSION","ACTION_NOT_ALLOWED","PRECONDITION_FAILED","EDIT_BUDGET_EXHAUSTED","OFFER_NOT_LIVE","POLICY_VIOLATION","TENANT_MISMATCH","SIGNATURE_INVALID","UNSUPPORTED","UNKNOWN","MAX_ATTEMPTS","NOT_APPLIED","SCOPE_HELD","SCOPE_CONTESTED","SCOPE_BLOCKED","SCOPE_RETIRED","OUTCOME_UNRESOLVED"]}},"WRITE_SCOPE_BLOCKED":{"action":{"k":"enum","v":["RECONNECT_ACCOUNT","CHECK_ACCOUNT_STATUS","CHECK_LISTING","REVIEW_CHANNEL_POLICY","CONTACT_CHANNEL_SUPPORT","REVIEW_OFFER_STATUS"]},"code":{"k":"enum","v":["RATE_LIMITED","CHANNEL_UNAVAILABLE","TIMEOUT","NETWORK","AUTH_INVALID","AUTH_EXPIRED","ACCOUNT_INACTIVE","FORBIDDEN","VALIDATION","NOT_FOUND","DUPLICATE_ACTION","STALE_VERSION","ACTION_NOT_ALLOWED","PRECONDITION_FAILED","EDIT_BUDGET_EXHAUSTED","OFFER_NOT_LIVE","POLICY_VIOLATION","TENANT_MISMATCH","SIGNATURE_INVALID","UNSUPPORTED","UNKNOWN","MAX_ATTEMPTS","NOT_APPLIED","SCOPE_HELD","SCOPE_CONTESTED","SCOPE_BLOCKED","SCOPE_RETIRED","OUTCOME_UNRESOLVED"]}},"WRITE_SUPERSEDED_BY_NEWER_VERSION":{"newerVersion":{"k":"count"},"newerWriteId":{"k":"id"}}}'::jsonb
$$;

CREATE FUNCTION security.param_value_valid(v jsonb, spec jsonb) RETURNS boolean
  LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  t text := jsonb_typeof(v);
BEGIN
  IF spec IS NULL THEN
    RETURN false;
  END IF;
  IF t = 'null' THEN
    RETURN coalesce((spec ->> 'n')::boolean, false);
  END IF;
  CASE spec ->> 'k'
    WHEN 'money', 'bp', 'count', 'seconds', 'minutes', 'rateMicros' THEN
      RETURN t = 'number' AND v::text ~ '^-?[0-9]+$';
    WHEN 'ratio' THEN
      RETURN t = 'number';
    WHEN 'currency' THEN
      RETURN t = 'string' AND (v #>> '{}') ~ '^[A-Z]{3}$';
    WHEN 'instant' THEN
      RETURN t = 'string' AND (v #>> '{}') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$';
    WHEN 'date' THEN
      RETURN t = 'string' AND (v #>> '{}') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$';
    WHEN 'id' THEN
      RETURN t = 'string' AND length(v #>> '{}') BETWEEN 1 AND 200;
    WHEN 'enum' THEN
      RETURN t = 'string' AND (NOT spec ? 'v' OR (spec -> 'v') ? (v #>> '{}'));
    WHEN 'enumList' THEN
      RETURN t = 'array' AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v) e
                                          WHERE jsonb_typeof(e.value) <> 'string' OR (spec ? 'v' AND NOT (spec -> 'v') ? (e.value #>> '{}')));
    WHEN 'storefrontList' THEN
      RETURN t = 'array' AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v) e WHERE jsonb_typeof(e.value) <> 'string');
    WHEN 'bool' THEN
      RETURN t = 'boolean';
    WHEN 'userText' THEN
      RETURN t = 'string' AND length(v #>> '{}') <= 2000;
    ELSE
      RETURN false;
  END CASE;
END $$;

CREATE OR REPLACE FUNCTION security.explanation_node_declared(node jsonb, path text, p_competitor_derived boolean) RETURNS boolean
  LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  shape   jsonb := security.explanation_shape();
  kinds   jsonb;
  k       text;
  v       jsonb;
BEGIN
  IF node IS NULL OR jsonb_typeof(node) NOT IN ('object', 'array') THEN
    RETURN true;
  END IF;
  IF jsonb_typeof(node) = 'array' THEN
    FOR v IN SELECT value FROM jsonb_array_elements(node) LOOP
      IF NOT security.explanation_node_declared(v, path || '[]', p_competitor_derived) THEN
        RETURN false;
      END IF;
    END LOOP;
    RETURN true;
  END IF;
  IF (shape -> 'reasons') ? path THEN
    IF jsonb_typeof(node -> 'code') IS DISTINCT FROM 'string' OR NOT security.eternal_param_keys() ? (node ->> 'code') THEN
      RETURN false;
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_object_keys(node) AS key WHERE key NOT IN ('code', 'params', 'withheld')) THEN
      RETURN false;
    END IF;
    IF node ? 'params' THEN
      IF jsonb_typeof(node -> 'params') <> 'object' THEN
        RETURN false;
      END IF;
      kinds := security.eternal_param_kinds() -> (node ->> 'code');
      FOR k, v IN SELECT key, value FROM jsonb_each(node -> 'params') LOOP
        -- Находка 6: ключ объявлен для кода И значение — объявленного вида
        IF NOT (security.eternal_param_keys() -> (node ->> 'code')) ? k OR (p_competitor_derived AND k = ANY (security.channel_rule_derived_param_keys()))
           OR NOT security.param_value_valid(v, kinds -> k) THEN
          RETURN false;
        END IF;
      END LOOP;
    END IF;
    IF node ? 'withheld' AND (jsonb_typeof(node -> 'withheld') <> 'array'
                              OR EXISTS (SELECT 1 FROM jsonb_array_elements(node -> 'withheld') w
                                          WHERE jsonb_typeof(w.value) <> 'string' OR (w.value #>> '{}') !~ '^[A-Za-z][A-Za-z0-9_]{0,63}$')) THEN
      RETURN false;
    END IF;
    RETURN true;
  END IF;
  IF NOT shape ? path OR path = 'reasons' THEN
    RETURN false;
  END IF;
  -- Находка 6: формат слепка — r80.1 и только он
  IF path = '$' AND (node -> 'format') IS DISTINCT FROM '"r80.1"'::jsonb THEN
    RETURN false;
  END IF;
  FOR k, v IN SELECT key, value FROM jsonb_each(node) LOOP
    IF NOT (shape -> path) ? k OR NOT security.explanation_node_declared(v, path || '.' || k, p_competitor_derived) THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
END $$;
RESET ROLE;

GRANT EXECUTE ON FUNCTION security.eternal_param_kinds(), security.param_value_valid(jsonb, jsonb) TO repracer_app;

COMMIT;
