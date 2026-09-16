-- 0069: шаг 18 — одна действующая привязка на поставщика и при одновременном приёме приглашений (Р-98, находка 3 ревью шага 17);
-- роль синхронизации остатка repracer_stock — только остатки и резервации, без цен и без аудита (Р-102, OQ-152);
-- срок хранения привязок входа и их отзывов — время жизни пользователя (OQ-153).

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Находка 3: проверка «одна действующая привязка» сериализуется по (пользователь, поставщик)
-- ---------------------------------------------------------------------------
-- Без блокировки два приёма в параллельных транзакциях не видят незафиксированную строку друг друга и обе вставляют привязку.
-- Транзакционная рекомендательная блокировка держится до конца транзакции: второй приём ждёт первого и видит его строку.
-- Функция принадлежит repracer_resolver (0066): заменяется от суперпользователя
CREATE OR REPLACE FUNCTION platform.external_identity_one_active() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('platform.external_identity:' || NEW.user_id::text || ':' || NEW.issuer, 0));
  IF EXISTS (SELECT 1 FROM platform.external_identity e
              WHERE e.user_id = NEW.user_id AND e.issuer = NEW.issuer AND e.subject <> NEW.subject
                AND NOT EXISTS (SELECT 1 FROM platform.external_identity_revocation rv WHERE rv.issuer = e.issuer AND rv.subject = e.subject)) THEN
    RAISE EXCEPTION 'user % already has an active sign-in of issuer % (Р-98)', NEW.user_id, NEW.issuer USING ERRCODE = 'unique_violation';
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Р-102: роль синхронизации остатка
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'repracer_stock') THEN
    CREATE ROLE repracer_stock NOLOGIN NOBYPASSRLS;
  END IF;
END $$;
GRANT USAGE ON SCHEMA security, tenant_data, channel_data TO repracer_stock;
GRANT EXECUTE ON FUNCTION security.current_tenant_id() TO repracer_stock;

-- Список разрешённого роли остатков — как у пути решения (Р-96): право есть тогда и только тогда, когда оно здесь
CREATE FUNCTION security.stock_path_allowed_privileges()
  RETURNS TABLE (table_name text, privilege text, column_name text)
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT t, p, c FROM (VALUES
    ('tenant_data.product', 'SELECT', NULL), ('tenant_data.stock_source', 'SELECT', NULL), ('tenant_data.stock_allocation', 'SELECT', NULL),
    ('tenant_data.stock_pool', 'SELECT', NULL), ('tenant_data.stock_pool', 'INSERT', NULL), ('tenant_data.stock_pool', 'UPDATE', NULL),
    ('tenant_data.stock_movement', 'SELECT', NULL), ('tenant_data.stock_movement', 'INSERT', NULL),
    ('channel_data.reservation', 'SELECT', NULL), ('channel_data.reservation', 'INSERT', NULL), ('channel_data.reservation', 'UPDATE', NULL)
  ) AS a(t, p, c)
$$;
GRANT EXECUTE ON FUNCTION security.stock_path_allowed_privileges() TO repracer_stock, repracer_admin;

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT * FROM security.stock_path_allowed_privileges() LOOP
    EXECUTE format('GRANT %s ON %s TO repracer_stock', r.privilege, r.table_name);
  END LOOP;
  FOR r IN SELECT DISTINCT table_name FROM security.stock_path_allowed_privileges() LOOP
    EXECUTE format('CREATE POLICY stock_tenant ON %s TO repracer_stock USING (tenant_id = security.current_tenant_id()) WITH CHECK (tenant_id = security.current_tenant_id())',
                   r.table_name);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 3. OQ-153: привязки входа и отзывы живут, пока жив пользователь; удаляются вместе — отзыв без привязки не остаётся,
--    привязка без отзыва не возвращается к жизни
-- ---------------------------------------------------------------------------
ALTER TABLE maintenance.retention_policy DROP CONSTRAINT retention_policy_method_check;
ALTER TABLE maintenance.retention_policy ADD CONSTRAINT retention_policy_method_check
  CHECK (method IN ('DROP_PARTITION', 'DELETE_ROWS', 'TENANT_CLOSURE_ONLY', 'USER_LIFETIME'));
-- Как у TENANT_CLOSURE_ONLY: срока и столбца-якоря нет — удаление по событию (отключение пользователя), а не по времени
ALTER TABLE maintenance.retention_policy DROP CONSTRAINT retention_policy_check;
ALTER TABLE maintenance.retention_policy ADD CONSTRAINT retention_policy_check
  CHECK ((method IN ('TENANT_CLOSURE_ONLY', 'USER_LIFETIME')) = ((retention IS NULL) AND (anchor_column IS NULL)));
INSERT INTO maintenance.retention_policy (table_name, method, drop_order)
VALUES ('platform.external_identity', 'USER_LIFETIME', 66),
       ('platform.external_identity_revocation', 'USER_LIFETIME', 65);

CREATE POLICY retention_user_identity ON platform.external_identity FOR ALL TO repracer_retention USING (true);
CREATE POLICY retention_user_identity ON platform.external_identity_revocation FOR ALL TO repracer_retention USING (true);
GRANT SELECT, DELETE ON platform.external_identity, platform.external_identity_revocation TO repracer_retention;
GRANT SELECT (user_id, status) ON platform.app_user TO repracer_retention;

SET ROLE repracer_owner;
-- Удаление — только у отключённого пользователя: у действующего вход — его единственный способ войти
CREATE FUNCTION maintenance.purge_user_identities(p_user_id uuid) RETURNS int
  LANGUAGE plpgsql AS $$
DECLARE
  n int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM platform.app_user u WHERE u.user_id = p_user_id AND u.status = 'DISABLED') THEN
    RAISE EXCEPTION 'sign-ins of user % are kept while the user is not disabled (OQ-153)', p_user_id USING ERRCODE = 'insufficient_privilege';
  END IF;
  DELETE FROM platform.external_identity_revocation rv
   USING platform.external_identity e WHERE e.issuer = rv.issuer AND e.subject = rv.subject AND e.user_id = p_user_id;
  DELETE FROM platform.external_identity e WHERE e.user_id = p_user_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
RESET ROLE;
ALTER FUNCTION maintenance.purge_user_identities(uuid) SECURITY DEFINER SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION maintenance.purge_user_identities(uuid) OWNER TO repracer_retention;
REVOKE ALL ON FUNCTION maintenance.purge_user_identities(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION maintenance.purge_user_identities(uuid) TO repracer_retention;

COMMIT;
