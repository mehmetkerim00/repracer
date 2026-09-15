-- 0013_resolver.sql
-- Резолв тенанта до установки контекста: входящие события каналов, ключи Inbound API, вход пользователя.
-- Функции SECURITY DEFINER принадлежат repracer_resolver: читают только перечисленные столбцы, возвращают идентификаторы.

BEGIN;
SET ROLE repracer_owner;

CREATE POLICY resolver_read ON tenant_data.channel_account FOR SELECT TO repracer_resolver USING (true);
GRANT SELECT (tenant_id, channel_account_id, channel, region, external_account_id, auth_status, disconnected_at)
  ON tenant_data.channel_account TO repracer_resolver;

CREATE POLICY resolver_read ON tenant_data.inbound_api_key FOR SELECT TO repracer_resolver USING (true);
GRANT SELECT (tenant_id, inbound_api_key_id, stock_source_id, key_prefix, key_sha256, revoked_at)
  ON tenant_data.inbound_api_key TO repracer_resolver;

CREATE POLICY resolver_read ON tenant_data.stock_source FOR SELECT TO repracer_resolver USING (true);
GRANT SELECT (tenant_id, stock_source_id, mode, status) ON tenant_data.stock_source TO repracer_resolver;

CREATE POLICY resolver_read ON tenant_data.membership FOR SELECT TO repracer_resolver USING (true);
GRANT SELECT (tenant_id, membership_id, user_id, role, status) ON tenant_data.membership TO repracer_resolver;

CREATE POLICY resolver_read ON tenant_data.tenant FOR SELECT TO repracer_resolver USING (true);
GRANT SELECT (tenant_id, kind, status) ON tenant_data.tenant TO repracer_resolver;

CREATE POLICY resolver_read ON platform.app_user FOR SELECT TO repracer_resolver USING (true);
GRANT SELECT (user_id, email, status) ON platform.app_user TO repracer_resolver;

-- Входящее событие канала -> тенант. Нет совпадения — пустой результат (событие отбрасывается).
CREATE FUNCTION security.resolve_channel_account(p_channel text, p_region text, p_external_account_id text)
  RETURNS TABLE (tenant_id uuid, channel_account_id uuid, auth_status text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT ca.tenant_id, ca.channel_account_id, ca.auth_status
    FROM tenant_data.channel_account ca
   WHERE ca.channel = p_channel
     AND coalesce(ca.region, '') = coalesce(p_region, '')
     AND ca.external_account_id = p_external_account_id
     AND ca.disconnected_at IS NULL
$$;

-- Ключ Inbound API -> тенант и источник. Приложение передаёт префикс и SHA-256 ключа, не сам ключ.
CREATE FUNCTION security.resolve_inbound_api_key(p_key_prefix text, p_key_sha256 bytea)
  RETURNS TABLE (tenant_id uuid, stock_source_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT k.tenant_id, k.stock_source_id
    FROM tenant_data.inbound_api_key k
    JOIN tenant_data.stock_source s ON s.tenant_id = k.tenant_id AND s.stock_source_id = k.stock_source_id
   WHERE k.key_prefix = p_key_prefix
     AND k.key_sha256 = p_key_sha256
     AND k.revoked_at IS NULL
     AND s.status = 'ACTIVE' AND s.mode = 'INBOUND_API'
$$;

-- Вход: пользователь по email
CREATE FUNCTION security.find_user_by_email(p_email text) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT u.user_id FROM platform.app_user u WHERE u.email = lower(p_email) AND u.status = 'ACTIVE'
$$;

-- Выбор тенанта после входа: действующие членства пользователя
CREATE FUNCTION security.list_user_tenants(p_user_id uuid)
  RETURNS TABLE (tenant_id uuid, membership_id uuid, role text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT m.tenant_id, m.membership_id, m.role
    FROM tenant_data.membership m
    JOIN tenant_data.tenant t ON t.tenant_id = m.tenant_id
   WHERE m.user_id = p_user_id AND m.status = 'ACTIVE'
     AND t.kind = 'CUSTOMER' AND t.status IN ('TRIAL', 'ACTIVE', 'SUSPENDED')
$$;

REVOKE ALL ON FUNCTION security.resolve_channel_account(text, text, text),
                       security.resolve_inbound_api_key(text, bytea),
                       security.find_user_by_email(text),
                       security.list_user_tenants(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION security.resolve_channel_account(text, text, text),
                          security.resolve_inbound_api_key(text, bytea),
                          security.find_user_by_email(text),
                          security.list_user_tenants(uuid) TO repracer_app;

RESET ROLE;

GRANT CREATE ON SCHEMA security TO repracer_resolver;
ALTER FUNCTION security.resolve_channel_account(text, text, text) OWNER TO repracer_resolver;
ALTER FUNCTION security.resolve_inbound_api_key(text, bytea) OWNER TO repracer_resolver;
ALTER FUNCTION security.find_user_by_email(text) OWNER TO repracer_resolver;
ALTER FUNCTION security.list_user_tenants(uuid) OWNER TO repracer_resolver;
REVOKE CREATE ON SCHEMA security FROM repracer_resolver;

COMMIT;
