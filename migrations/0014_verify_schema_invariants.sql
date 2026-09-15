-- 0014_verify_schema_invariants.sql
-- Проверка схемы. Падает, если нарушено хотя бы одно правило. Копируется в конец набора при добавлении таблиц.

BEGIN;

DO $$
DECLARE
  r   record;
  bad text[] := '{}';
BEGIN
  -- 1. Каждая таблица и партиция: tenant_id NOT NULL, RLS включён и принудителен
  FOR r IN
    SELECT c.oid::regclass AS t, c.relrowsecurity, c.relforcerowsecurity, c.relispartition
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname IN ('security', 'platform', 'tenant_data', 'channel_data', 'audit', 'maintenance')
       AND c.relkind IN ('r', 'p')
  LOOP
    IF NOT (r.relrowsecurity AND r.relforcerowsecurity) THEN
      bad := bad || format('%s: RLS is not enabled and forced', r.t);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_attribute
                    WHERE attrelid = r.t AND attname = 'tenant_id' AND attnotnull AND NOT attisdropped) THEN
      bad := bad || format('%s: no NOT NULL tenant_id', r.t);
    END IF;
    IF NOT r.relispartition AND NOT EXISTS (SELECT 1 FROM security.table_registry WHERE table_name = r.t) THEN
      bad := bad || format('%s: not registered in security.table_registry', r.t);
    END IF;
    IF r.relispartition AND (has_table_privilege('repracer_app', r.t, 'SELECT')
                             OR has_table_privilege('repracer_app', r.t, 'INSERT')) THEN
      bad := bad || format('%s: partition is directly accessible to repracer_app', r.t);
    END IF;
  END LOOP;

  -- 2. У каждой зарегистрированной таблицы есть политика для repracer_app (кроме служебных)
  FOR r IN SELECT table_name, storage_class FROM security.table_registry WHERE storage_class <> 'SYSTEM' LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = r.table_name
                     AND 'repracer_app'::regrole::oid = ANY (polroles)) THEN
      bad := bad || format('%s: no policy for repracer_app', r.table_name);
    END IF;
  END LOOP;

  -- 3. Append-only: триггер-защита есть; у приложения нет UPDATE/DELETE/TRUNCATE
  FOR r IN SELECT table_name FROM security.table_registry WHERE mutation_mode = 'append_only' LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = r.table_name AND tgname = 'zz_append_only') THEN
      bad := bad || format('%s: append-only guard trigger missing', r.table_name);
    END IF;
    IF has_table_privilege('repracer_app', r.table_name, 'UPDATE')
       OR has_table_privilege('repracer_app', r.table_name, 'DELETE')
       OR has_table_privilege('repracer_app', r.table_name, 'TRUNCATE') THEN
      bad := bad || format('%s: repracer_app may mutate an append-only table', r.table_name);
    END IF;
  END LOOP;

  -- 4. Класс хранения CHANNEL/AUDIT — только со сроком; TENANT — бессрочно (кроме операционных счётчиков)
  FOR r IN
    SELECT tr.table_name, tr.storage_class, rp.method
      FROM security.table_registry tr
      LEFT JOIN maintenance.retention_policy rp ON rp.table_name = tr.table_name
     WHERE tr.storage_class IN ('TENANT', 'CHANNEL', 'AUDIT')
  LOOP
    IF r.method IS NULL THEN
      bad := bad || format('%s: no retention policy', r.table_name);
    ELSIF r.storage_class IN ('CHANNEL', 'AUDIT') AND r.method = 'TENANT_CLOSURE_ONLY' THEN
      bad := bad || format('%s: channel/audit data without time-based retention', r.table_name);
    END IF;
  END LOOP;
  FOR r IN SELECT table_name, retention FROM maintenance.retention_policy
            WHERE retention IS NOT NULL AND table_name::text LIKE 'channel_data.%' AND retention > interval '18 months' LOOP
    bad := bad || format('%s: channel data retention exceeds 18 months', r.table_name);
  END LOOP;

  -- 5. Ссылок из tenant_data в channel_data/audit нет
  FOR r IN
    SELECT con.conname, con.conrelid::regclass AS src, con.confrelid::regclass AS dst
      FROM pg_constraint con
      JOIN pg_class s ON s.oid = con.conrelid JOIN pg_namespace sn ON sn.oid = s.relnamespace
      JOIN pg_class d ON d.oid = con.confrelid JOIN pg_namespace dn ON dn.oid = d.relnamespace
     WHERE con.contype = 'f' AND sn.nspname = 'tenant_data' AND dn.nspname IN ('channel_data', 'audit')
       AND NOT s.relispartition
  LOOP
    bad := bad || format('%s -> %s (%s): tenant data must not reference channel/audit data', r.src, r.dst, r.conname);
  END LOOP;

  -- 6. Ни одна роль проекта не обходит RLS
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname LIKE 'repracer\_%' AND rolbypassrls LOOP
    bad := bad || format('role %s has BYPASSRLS', r.rolname);
  END LOOP;

  -- 7. SECURITY DEFINER-функции: фиксированный search_path, нет EXECUTE у PUBLIC
  FOR r IN
    SELECT p.oid::regprocedure AS f, p.proconfig
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname IN ('security', 'platform', 'tenant_data', 'channel_data', 'audit', 'maintenance')
       AND p.prosecdef
  LOOP
    IF r.proconfig IS NULL OR NOT EXISTS (SELECT 1 FROM unnest(r.proconfig) cfg WHERE cfg LIKE 'search_path=%') THEN
      bad := bad || format('%s: SECURITY DEFINER without fixed search_path', r.f);
    END IF;
    IF has_function_privilege('public', r.f, 'EXECUTE') THEN
      bad := bad || format('%s: SECURITY DEFINER executable by PUBLIC', r.f);
    END IF;
  END LOOP;

  IF cardinality(bad) > 0 THEN
    RAISE EXCEPTION E'schema invariant violations:\n%', array_to_string(bad, E'\n');
  END IF;
END $$;

COMMIT;
