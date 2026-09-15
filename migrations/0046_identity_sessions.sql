-- 0046_identity_sessions.sql
-- Шаг 13, OQ-128: рабочий вход вместо синтетического пользователя. Пароль (scrypt, хеш считает приложение), сессия с токеном,
-- роли — из tenant_data.membership при каждом запросе. MFA не реализована, место оставлено: уровень сессии PASSWORD_MFA
-- и время подтверждения второго фактора; пользователю с app_user.mfa_enabled сессия по одному паролю не выдаётся.
-- Чтение хеша, счётчик неудачных входов и сессии — только функциями SECURITY DEFINER роли repracer_resolver (как 0013).

BEGIN;
SET ROLE repracer_owner;

-- ---------------------------------------------------------------------------
-- 1. Пароль пользователя
-- ---------------------------------------------------------------------------
CREATE TABLE platform.user_credential (
  tenant_id       uuid NOT NULL DEFAULT security.platform_tenant_id() CHECK (tenant_id = security.platform_tenant_id()),
  user_id         uuid PRIMARY KEY REFERENCES platform.app_user (user_id),
  -- Только хеш scrypt с солью и параметрами; пароль в базу не передаётся
  password_hash   text NOT NULL CHECK (password_hash ~ '^scrypt\$[0-9]+\$[0-9]+\$[0-9]+\$[A-Za-z0-9+/]+={0,2}\$[A-Za-z0-9+/]+={0,2}$'),
  password_set_at timestamptz NOT NULL DEFAULT now(),
  failed_attempts int NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until    timestamptz
);

SELECT security.register_table('platform.user_credential', 'PLATFORM', 'mutable', 'none');
-- Пароль задаёт и меняет сам пользователь в своей сессии (app.user_id); хеш для входа читает только security.login_credential
CREATE POLICY user_credential_own ON platform.user_credential TO repracer_app
  USING (user_id = security.current_user_id()) WITH CHECK (user_id = security.current_user_id());

-- ---------------------------------------------------------------------------
-- 2. Сессия
-- ---------------------------------------------------------------------------
CREATE TABLE platform.user_session (
  tenant_id       uuid NOT NULL DEFAULT security.platform_tenant_id() CHECK (tenant_id = security.platform_tenant_id()),
  session_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES platform.app_user (user_id),
  -- Хранится только SHA-256 токена: копия таблицы не даёт войти
  token_sha256    bytea NOT NULL UNIQUE CHECK (length(token_sha256) = 32),
  auth_level      text NOT NULL CHECK (auth_level IN ('PASSWORD', 'PASSWORD_MFA')),
  -- Место под MFA: уровень PASSWORD_MFA — только с временем подтверждения второго фактора (сейчас не выдаётся)
  mfa_verified_at timestamptz,
  created_at      timestamptz NOT NULL,
  expires_at      timestamptz NOT NULL,
  revoked_at      timestamptz,
  CHECK ((auth_level = 'PASSWORD_MFA') = (mfa_verified_at IS NOT NULL)),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '24 hours'),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

-- Удаление истёкших сессий (maintenance.purge_expired_rows по expires_at)
CREATE INDEX user_session_expiry_idx ON platform.user_session (expires_at);

SELECT security.register_table('platform.user_session', 'PLATFORM', 'mutable', 'none');
-- Приложению видны только сессии пользователя текущего контекста (список «мои входы»); вход и проверка токена — функциями
CREATE POLICY user_session_own ON platform.user_session FOR SELECT TO repracer_app
  USING (user_id = security.current_user_id());
REVOKE INSERT, UPDATE ON platform.user_session FROM repracer_app;

SELECT security.grant_retention('platform.user_session');
INSERT INTO maintenance.retention_policy (table_name, method, anchor_column, retention, safety_margin, drop_order)
VALUES ('platform.user_session', 'DELETE_ROWS', 'expires_at', '30 days', '1 day', 63);

-- ---------------------------------------------------------------------------
-- 3. Доступ роли входа
-- ---------------------------------------------------------------------------
CREATE POLICY resolver_login ON platform.user_credential TO repracer_resolver USING (true) WITH CHECK (true);
GRANT SELECT (user_id, password_hash, failed_attempts, locked_until), UPDATE (failed_attempts, locked_until) ON platform.user_credential TO repracer_resolver;

CREATE POLICY resolver_login ON platform.user_session TO repracer_resolver USING (true) WITH CHECK (true);
GRANT SELECT, INSERT (user_id, token_sha256, auth_level, created_at, expires_at), UPDATE (revoked_at) ON platform.user_session TO repracer_resolver;

CREATE POLICY resolver_login_update ON platform.app_user FOR UPDATE TO repracer_resolver USING (true) WITH CHECK (true);
GRANT SELECT (display_name, mfa_enabled), UPDATE (last_login_at) ON platform.app_user TO repracer_resolver;

-- Хеш и счётчик неудачных входов действующего пользователя по email
CREATE FUNCTION security.login_credential(p_email text)
  RETURNS TABLE (user_id uuid, email text, display_name text, password_hash text, failed_attempts int, locked_until timestamptz, mfa_enabled boolean)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT u.user_id, u.email, u.display_name, c.password_hash, c.failed_attempts, c.locked_until, u.mfa_enabled
    FROM platform.app_user u
    JOIN platform.user_credential c ON c.user_id = u.user_id
   WHERE u.email = lower(p_email) AND u.status = 'ACTIVE'
$$;

-- Неудачный вход: счётчик растёт; на p_max_attempts — блокировка на p_lock; после истёкшей блокировки счёт начинается заново
CREATE FUNCTION security.record_failed_login(p_user_id uuid, p_max_attempts int, p_lock interval)
  RETURNS timestamptz
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  locked timestamptz;
BEGIN
  IF p_max_attempts < 1 OR p_lock <= interval '0' THEN
    RAISE EXCEPTION 'invalid lockout policy' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  UPDATE platform.user_credential c
     SET failed_attempts = CASE WHEN c.locked_until IS NOT NULL AND c.locked_until <= now() THEN 1 ELSE c.failed_attempts + 1 END,
         locked_until = CASE
           WHEN (CASE WHEN c.locked_until IS NOT NULL AND c.locked_until <= now() THEN 1 ELSE c.failed_attempts + 1 END) >= p_max_attempts THEN now() + p_lock
           WHEN c.locked_until IS NOT NULL AND c.locked_until <= now() THEN NULL
           ELSE c.locked_until END
   WHERE c.user_id = p_user_id
  RETURNING c.locked_until INTO locked;
  RETURN locked;
END $$;

-- Успешный вход (пароль проверило приложение): только действующий, незаблокированный пользователь без MFA; счётчик сбрасывается
CREATE FUNCTION security.open_session(p_user_id uuid, p_token_sha256 bytea, p_ttl interval)
  RETURNS TABLE (session_id uuid, created_at timestamptz, expires_at timestamptz)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  u record;
BEGIN
  SELECT a.status, a.mfa_enabled, c.locked_until INTO u
    FROM platform.app_user a JOIN platform.user_credential c ON c.user_id = a.user_id
   WHERE a.user_id = p_user_id;
  IF u IS NULL OR u.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'user % cannot sign in', p_user_id USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF u.locked_until IS NOT NULL AND u.locked_until > now() THEN
    RAISE EXCEPTION 'user % is locked until %', p_user_id, u.locked_until USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Второй фактор не реализован: сессия уровня PASSWORD пользователю с MFA не выдаётся
  IF u.mfa_enabled THEN
    RAISE EXCEPTION 'user % requires a second factor', p_user_id USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE platform.user_credential SET failed_attempts = 0, locked_until = NULL WHERE user_credential.user_id = p_user_id;
  UPDATE platform.app_user SET last_login_at = now() WHERE app_user.user_id = p_user_id;
  RETURN QUERY
    INSERT INTO platform.user_session AS s (user_id, token_sha256, auth_level, created_at, expires_at)
    VALUES (p_user_id, p_token_sha256, 'PASSWORD', now(), now() + p_ttl)
    RETURNING s.session_id, s.created_at, s.expires_at;
END $$;

-- Действующая сессия по SHA-256 токена
CREATE FUNCTION security.find_session(p_token_sha256 bytea)
  RETURNS TABLE (session_id uuid, user_id uuid, email text, display_name text, auth_level text, created_at timestamptz, expires_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT s.session_id, s.user_id, u.email, u.display_name, s.auth_level, s.created_at, s.expires_at
    FROM platform.user_session s
    JOIN platform.app_user u ON u.user_id = s.user_id
   WHERE s.token_sha256 = p_token_sha256 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.status = 'ACTIVE'
$$;

CREATE FUNCTION security.close_session(p_token_sha256 bytea) RETURNS boolean
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH closed AS (
    UPDATE platform.user_session s SET revoked_at = now()
     WHERE s.token_sha256 = p_token_sha256 AND s.revoked_at IS NULL
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM closed)
$$;

-- Членства пользователя действующей сессии: тенант, членство и роль — из базы при каждом запросе
CREATE FUNCTION security.session_memberships(p_token_sha256 bytea)
  RETURNS TABLE (tenant_id uuid, membership_id uuid, role text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT m.tenant_id, m.membership_id, m.role
    FROM platform.user_session s
    JOIN platform.app_user u ON u.user_id = s.user_id AND u.status = 'ACTIVE'
    JOIN tenant_data.membership m ON m.user_id = s.user_id AND m.status = 'ACTIVE'
    JOIN tenant_data.tenant t ON t.tenant_id = m.tenant_id
   WHERE s.token_sha256 = p_token_sha256 AND s.revoked_at IS NULL AND s.expires_at > now()
     AND t.kind = 'CUSTOMER' AND t.status IN ('TRIAL', 'ACTIVE', 'SUSPENDED')
$$;

REVOKE ALL ON FUNCTION security.login_credential(text), security.record_failed_login(uuid, int, interval), security.open_session(uuid, bytea, interval),
                       security.find_session(bytea), security.close_session(bytea), security.session_memberships(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION security.login_credential(text), security.record_failed_login(uuid, int, interval), security.open_session(uuid, bytea, interval),
                          security.find_session(bytea), security.close_session(bytea), security.session_memberships(bytea) TO repracer_app;

RESET ROLE;

GRANT CREATE ON SCHEMA security TO repracer_resolver;
ALTER FUNCTION security.login_credential(text) OWNER TO repracer_resolver;
ALTER FUNCTION security.record_failed_login(uuid, int, interval) OWNER TO repracer_resolver;
ALTER FUNCTION security.open_session(uuid, bytea, interval) OWNER TO repracer_resolver;
ALTER FUNCTION security.find_session(bytea) OWNER TO repracer_resolver;
ALTER FUNCTION security.close_session(bytea) OWNER TO repracer_resolver;
ALTER FUNCTION security.session_memberships(bytea) OWNER TO repracer_resolver;
REVOKE CREATE ON SCHEMA security FROM repracer_resolver;

COMMIT;
