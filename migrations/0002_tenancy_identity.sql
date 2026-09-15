-- 0002_tenancy_identity.sql
-- Тенанты, глобальные пользователи [Р-9], членство.

BEGIN;
SET ROLE repracer_owner;

-- ---------------------------------------------------------------------------
-- tenant — корень изоляции. В каждой региональной базе свой набор тенантов [Р-16].
-- ---------------------------------------------------------------------------
CREATE TABLE tenant_data.tenant (
  tenant_id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                             text NOT NULL DEFAULT 'CUSTOMER' CHECK (kind IN ('PLATFORM', 'CUSTOMER')),
  name                             text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  status                           text NOT NULL DEFAULT 'TRIAL'
                                   CHECK (status IN ('TRIAL', 'ACTIVE', 'SUSPENDED', 'OFFBOARDING', 'CLOSED')),
  data_region                      text NOT NULL CHECK (data_region IN ('EU', 'US')),
  default_currency                 text NOT NULL DEFAULT 'EUR' CHECK (default_currency ~ '^[A-Z]{3}$'),
  timezone                         text NOT NULL DEFAULT 'Europe/Berlin',
  -- Явный режим тенанта «использовать Smart Pricing Kaufland» [Р-12]
  kaufland_smart_pricing_opt_in_at timestamptz,
  kaufland_smart_pricing_opt_in_by uuid,
  created_at                       timestamptz NOT NULL DEFAULT now(),
  offboarding_requested_at         timestamptz,
  closed_at                        timestamptz,
  CHECK ((kind = 'PLATFORM') = (tenant_id = security.platform_tenant_id())),
  CHECK ((kaufland_smart_pricing_opt_in_at IS NULL) = (kaufland_smart_pricing_opt_in_by IS NULL)),
  CHECK ((status = 'CLOSED') = (closed_at IS NOT NULL))
);

-- Тенант создаётся только в базе своего региона; регион неизменяем.
CREATE FUNCTION tenant_data.tenant_region_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  db_region text := current_setting('repracer.region', true);
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.data_region IS DISTINCT FROM OLD.data_region THEN
    RAISE EXCEPTION 'tenant.data_region is immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.kind = 'CUSTOMER' AND (db_region IS NULL OR NEW.data_region <> db_region) THEN
    RAISE EXCEPTION 'tenant region % does not match database region %', NEW.data_region, db_region
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER tenant_region_guard BEFORE INSERT OR UPDATE OF data_region ON tenant_data.tenant
  FOR EACH ROW EXECUTE FUNCTION tenant_data.tenant_region_guard();

INSERT INTO tenant_data.tenant (tenant_id, kind, name, status, data_region)
VALUES (security.platform_tenant_id(), 'PLATFORM', 'platform', 'ACTIVE',
        coalesce(current_setting('repracer.region', true), 'EU'));

SELECT security.register_table('tenant_data.tenant', 'TENANT', 'mutable');

-- ---------------------------------------------------------------------------
-- app_user — глобальная учётная запись; строки принадлежат платформенному тенанту.
-- ---------------------------------------------------------------------------
CREATE TABLE platform.app_user (
  tenant_id     uuid NOT NULL DEFAULT security.platform_tenant_id()
                CHECK (tenant_id = security.platform_tenant_id())
                REFERENCES tenant_data.tenant (tenant_id),
  user_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Вход по email: уникальность на платформе (в пределах региональной базы)
  email         text NOT NULL UNIQUE CHECK (email = lower(email) AND position('@' IN email) > 1),
  display_name  text,
  status        text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISABLED')),
  mfa_enabled   boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);

CREATE TRIGGER app_user_restrict_update BEFORE UPDATE ON platform.app_user
  FOR EACH ROW EXECUTE FUNCTION security.restrict_update('display_name', 'mfa_enabled', 'last_login_at', 'status');

SELECT security.register_table('platform.app_user', 'PLATFORM', 'mutable', 'none');

-- ---------------------------------------------------------------------------
-- membership — пользователь в тенанте [Р-9]
-- ---------------------------------------------------------------------------
CREATE TABLE tenant_data.membership (
  tenant_id                uuid NOT NULL REFERENCES tenant_data.tenant (tenant_id),
  membership_id            uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id                  uuid NOT NULL REFERENCES platform.app_user (user_id),
  role                     text NOT NULL
                           CHECK (role IN ('OWNER', 'ADMIN', 'PRICING_MANAGER', 'INVENTORY_MANAGER', 'VIEWER')),
  status                   text NOT NULL DEFAULT 'INVITED' CHECK (status IN ('INVITED', 'ACTIVE', 'REVOKED')),
  invited_by_membership_id uuid,
  created_at               timestamptz NOT NULL DEFAULT now(),
  revoked_at               timestamptz,
  PRIMARY KEY (tenant_id, membership_id),
  -- Один пользователь — одно членство в тенанте; также поиск членства текущего пользователя при входе в контекст
  UNIQUE (tenant_id, user_id),
  FOREIGN KEY (tenant_id, invited_by_membership_id) REFERENCES tenant_data.membership (tenant_id, membership_id),
  CHECK ((status = 'REVOKED') = (revoked_at IS NOT NULL))
);

-- Поиск тенантов пользователя при входе (функция резолва 0013)
CREATE INDEX membership_user_idx ON tenant_data.membership (user_id) WHERE status = 'ACTIVE';

CREATE TRIGGER membership_restrict_update BEFORE UPDATE ON tenant_data.membership
  FOR EACH ROW EXECUTE FUNCTION security.restrict_update('role', 'status', 'revoked_at');

SELECT security.register_table('tenant_data.membership', 'TENANT', 'mutable');

-- У действующего клиентского тенанта всегда есть активный OWNER (проверка при коммите).
CREATE FUNCTION tenant_data.assert_tenant_has_owner() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  t uuid := NEW.tenant_id;
BEGIN
  IF EXISTS (SELECT 1 FROM tenant_data.tenant
              WHERE tenant_id = t AND kind = 'CUSTOMER' AND status IN ('TRIAL', 'ACTIVE', 'SUSPENDED'))
     AND NOT EXISTS (SELECT 1 FROM tenant_data.membership
                      WHERE tenant_id = t AND role = 'OWNER' AND status = 'ACTIVE') THEN
    RAISE EXCEPTION 'tenant % must have an ACTIVE OWNER', t USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER tenant_requires_owner AFTER INSERT ON tenant_data.tenant
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION tenant_data.assert_tenant_has_owner();
CREATE CONSTRAINT TRIGGER membership_keeps_owner AFTER UPDATE ON tenant_data.membership
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION tenant_data.assert_tenant_has_owner();

-- Политики app_user (после membership: политика ссылается на неё).
-- Видны: сам пользователь и участники текущего тенанта (подзапрос к membership ограничен RLS текущего тенанта).
CREATE POLICY app_user_read ON platform.app_user FOR SELECT TO repracer_app
  USING (user_id = security.current_user_id()
         OR EXISTS (SELECT 1 FROM tenant_data.membership m WHERE m.user_id = app_user.user_id));
CREATE POLICY app_user_signup ON platform.app_user FOR INSERT TO repracer_app
  WITH CHECK (user_id = security.current_user_id());
CREATE POLICY app_user_self_update ON platform.app_user FOR UPDATE TO repracer_app
  USING (user_id = security.current_user_id()) WITH CHECK (user_id = security.current_user_id());

RESET ROLE;
COMMIT;
