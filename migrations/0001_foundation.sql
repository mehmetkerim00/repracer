-- 0001_foundation.sql
-- Роли, схемы, функции контекста тенанта, общие триггерные функции, реестр таблиц.
-- Выполняется мигратором: роль с CREATEROLE, член создаваемых ролей (или суперпользователь при первой установке).

BEGIN;

-- ---------------------------------------------------------------------------
-- Роли (NOLOGIN; логин-роли сервисов создаёт ops и включает в repracer_app)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['repracer_owner', 'repracer_app', 'repracer_resolver', 'repracer_retention'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN NOBYPASSRLS', r);
    END IF;
  END LOOP;
END $$;

GRANT repracer_owner, repracer_resolver, repracer_retention TO CURRENT_USER;

-- ---------------------------------------------------------------------------
-- Схемы
-- ---------------------------------------------------------------------------
CREATE SCHEMA security     AUTHORIZATION repracer_owner;
CREATE SCHEMA platform     AUTHORIZATION repracer_owner;
CREATE SCHEMA tenant_data  AUTHORIZATION repracer_owner;
CREATE SCHEMA channel_data AUTHORIZATION repracer_owner;
CREATE SCHEMA audit        AUTHORIZATION repracer_owner;
CREATE SCHEMA maintenance  AUTHORIZATION repracer_owner;

REVOKE ALL ON SCHEMA security, platform, tenant_data, channel_data, audit, maintenance FROM PUBLIC;
GRANT USAGE ON SCHEMA security, platform, tenant_data, channel_data, audit
  TO repracer_app, repracer_resolver, repracer_retention;
GRANT USAGE ON SCHEMA maintenance TO repracer_retention;

SET ROLE repracer_owner;

-- ---------------------------------------------------------------------------
-- Контекст тенанта. Нет значения => NULL => ни одна политика не пропускает строки.
-- Некорректный uuid => ошибка запроса (fail-closed).
-- ---------------------------------------------------------------------------
CREATE FUNCTION security.current_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;

CREATE FUNCTION security.current_user_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;

-- Платформенный тенант: владелец глобальных строк (пользователи, справочник возможностей каналов).
CREATE FUNCTION security.platform_tenant_id() RETURNS uuid
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ SELECT '00000000-0000-0000-0000-000000000000'::uuid $$;

GRANT EXECUTE ON FUNCTION security.current_tenant_id(), security.current_user_id(), security.platform_tenant_id()
  TO repracer_app, repracer_resolver, repracer_retention;

-- ---------------------------------------------------------------------------
-- Append-only: UPDATE запрещён всегда; DELETE — только внутри функций repracer_retention.
-- ---------------------------------------------------------------------------
CREATE FUNCTION security.forbid_mutation() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_user = 'repracer_retention' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'append-only table %.%: % is forbidden', TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END $$;

CREATE FUNCTION security.forbid_truncate() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'TRUNCATE of %.% is forbidden', TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END $$;

-- Разрешает UPDATE только перечисленных в аргументах столбцов.
CREATE FUNCTION security.restrict_update() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(OLD) - TG_ARGV) IS DISTINCT FROM (to_jsonb(NEW) - TG_ARGV) THEN
    RAISE EXCEPTION '%.%: only columns % may be updated', TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_ARGV
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;

-- Версии правил: NEW.version = max(version) + 1 в пределах (tenant_id, <столбцы цели из аргументов>).
-- Гонку двух вставок одной версии ловит уникальный индекс (цель, version) на самой таблице.
CREATE FUNCTION security.enforce_next_version() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  n        jsonb := to_jsonb(NEW);
  cond     text  := 'tenant_id = $1';
  col      text;
  col_type text;
  expected bigint;
BEGIN
  FOREACH col IN ARRAY TG_ARGV LOOP
    IF n ->> col IS NULL THEN
      cond := cond || format(' AND %I IS NULL', col);
    ELSE
      SELECT format_type(a.atttypid, a.atttypmod) INTO col_type
        FROM pg_attribute a WHERE a.attrelid = TG_RELID AND a.attname = col;
      cond := cond || format(' AND %I = ($2 ->> %L)::%s', col, col, col_type);
    END IF;
  END LOOP;

  EXECUTE format('SELECT coalesce(max(version), 0) + 1 FROM %I.%I WHERE %s', TG_TABLE_SCHEMA, TG_TABLE_NAME, cond)
    INTO expected USING NEW.tenant_id, n;

  IF NEW.version IS DISTINCT FROM expected THEN
    RAISE EXCEPTION '%.%: version must be % (got %)', TG_TABLE_SCHEMA, TG_TABLE_NAME, expected, NEW.version
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------
-- Реестр таблиц: класс хранения и режим изменения. Источник для проверки 0014 и docs/data-retention.md.
-- ---------------------------------------------------------------------------
CREATE TABLE security.table_registry (
  tenant_id      uuid NOT NULL DEFAULT security.platform_tenant_id()
                 CHECK (tenant_id = security.platform_tenant_id()),
  table_name     regclass PRIMARY KEY,
  storage_class  text NOT NULL CHECK (storage_class IN ('PLATFORM', 'TENANT', 'CHANNEL', 'AUDIT', 'SYSTEM')),
  mutation_mode  text NOT NULL CHECK (mutation_mode IN ('append_only', 'mutable', 'mutable_delete', 'reference')),
  registered_at  timestamptz NOT NULL DEFAULT now()
);

-- Регистрирует таблицу: RLS (ENABLE + FORCE), политика изоляции, гранты, защита append-only.
-- p_policy: 'tenant' — строки текущего тенанта; 'none' — политика задаётся в миграции таблицы вручную.
CREATE FUNCTION security.register_table(
  p_table regclass, p_storage_class text, p_mutation_mode text, p_policy text DEFAULT 'tenant'
) RETURNS void
  LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
     WHERE attrelid = p_table AND attname = 'tenant_id' AND NOT attisdropped AND attnotnull
  ) THEN
    RAISE EXCEPTION '% has no NOT NULL tenant_id column', p_table;
  END IF;

  INSERT INTO security.table_registry (table_name, storage_class, mutation_mode)
  VALUES (p_table, p_storage_class, p_mutation_mode);

  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', p_table);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', p_table);

  IF p_policy = 'tenant' THEN
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %s TO repracer_app
         USING (tenant_id = security.current_tenant_id())
         WITH CHECK (tenant_id = security.current_tenant_id())', p_table);
  ELSIF p_policy <> 'none' THEN
    RAISE EXCEPTION 'unknown policy mode %', p_policy;
  END IF;

  IF p_mutation_mode = 'reference' THEN
    EXECUTE format('GRANT SELECT ON %s TO repracer_app', p_table);
  ELSE
    EXECUTE format('GRANT SELECT, INSERT ON %s TO repracer_app', p_table);
  END IF;
  IF p_mutation_mode IN ('mutable', 'mutable_delete') THEN
    EXECUTE format('GRANT UPDATE ON %s TO repracer_app', p_table);
  END IF;
  IF p_mutation_mode = 'mutable_delete' THEN
    EXECUTE format('GRANT DELETE ON %s TO repracer_app', p_table);
  END IF;

  IF p_mutation_mode = 'append_only' THEN
    EXECUTE format('CREATE TRIGGER zz_append_only BEFORE UPDATE OR DELETE ON %s
                      FOR EACH ROW EXECUTE FUNCTION security.forbid_mutation()', p_table);
    EXECUTE format('CREATE TRIGGER zz_no_truncate BEFORE TRUNCATE ON %s
                      FOR EACH STATEMENT EXECUTE FUNCTION security.forbid_truncate()', p_table);
  END IF;
END $$;

-- Реестр читает только владелец и роль хранения.
ALTER TABLE security.table_registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE security.table_registry FORCE ROW LEVEL SECURITY;
CREATE POLICY registry_read ON security.table_registry FOR SELECT TO repracer_retention USING (true);
CREATE POLICY registry_owner ON security.table_registry TO repracer_owner USING (true) WITH CHECK (true);
GRANT SELECT ON security.table_registry TO repracer_retention;
INSERT INTO security.table_registry (table_name, storage_class, mutation_mode)
VALUES ('security.table_registry', 'SYSTEM', 'mutable');

RESET ROLE;
COMMIT;
