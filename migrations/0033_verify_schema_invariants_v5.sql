-- 0033_verify_schema_invariants_v5.sql
-- Проверка схемы после шага 8 (последняя проверка набора): правила 0031 + НДС, журнал остановок, признак цены по конкурентам.

BEGIN;

DO $$
DECLARE
  r   record;
  bad text[] := '{}';
BEGIN
  -- 1. Таблицы и партиции: tenant_id NOT NULL, RLS ENABLE + FORCE, регистрация, нет прямого доступа к партициям
  FOR r IN
    SELECT c.oid::regclass AS t, c.relrowsecurity, c.relforcerowsecurity, c.relispartition
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname IN ('security', 'platform', 'tenant_data', 'channel_data', 'audit', 'maintenance', 'legal')
       AND c.relkind IN ('r', 'p')
  LOOP
    IF NOT (r.relrowsecurity AND r.relforcerowsecurity) THEN
      bad := bad || format('%s: RLS is not enabled and forced', r.t);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = r.t AND attname = 'tenant_id' AND attnotnull AND NOT attisdropped) THEN
      bad := bad || format('%s: no NOT NULL tenant_id', r.t);
    END IF;
    IF NOT r.relispartition AND NOT EXISTS (SELECT 1 FROM security.table_registry WHERE table_name = r.t) THEN
      bad := bad || format('%s: not registered', r.t);
    END IF;
    IF r.relispartition AND (has_table_privilege('repracer_app', r.t, 'SELECT') OR has_table_privilege('repracer_app', r.t, 'INSERT')
                             OR has_table_privilege('repracer_exporter', r.t, 'SELECT')) THEN
      bad := bad || format('%s: partition is directly accessible', r.t);
    END IF;
  END LOOP;

  -- 2. Политика для приложения у тенантных, канальных, аудиторских и платформенных таблиц; у LEGAL приложения нет вовсе
  FOR r IN SELECT table_name, storage_class FROM security.table_registry LOOP
    IF r.storage_class IN ('TENANT', 'CHANNEL', 'AUDIT', 'PLATFORM')
       AND NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = r.table_name AND 'repracer_app'::regrole::oid = ANY (polroles)) THEN
      bad := bad || format('%s: no policy for repracer_app', r.table_name);
    END IF;
    IF r.storage_class = 'LEGAL' AND has_table_privilege('repracer_app', r.table_name, 'SELECT') THEN
      bad := bad || format('%s: legal hold data readable by repracer_app', r.table_name);
    END IF;
  END LOOP;

  -- 3. Append-only
  FOR r IN SELECT table_name FROM security.table_registry WHERE mutation_mode = 'append_only' LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = r.table_name AND tgname = 'zz_append_only') THEN
      bad := bad || format('%s: append-only guard trigger missing', r.table_name);
    END IF;
    IF has_table_privilege('repracer_app', r.table_name, 'UPDATE') OR has_table_privilege('repracer_app', r.table_name, 'DELETE')
       OR has_table_privilege('repracer_app', r.table_name, 'TRUNCATE') THEN
      bad := bad || format('%s: repracer_app may mutate an append-only table', r.table_name);
    END IF;
  END LOOP;

  -- 4. Сроки: у каждой таблицы есть политика; CHANNEL/AUDIT/LEGAL — удаление по времени;
  --    данные каналов не старше 18 месяцев; данные тенанта удаляются по времени только после экспорта
  --    (исключение — операционные счётчики edit_budget).
  FOR r IN
    SELECT tr.table_name, tr.storage_class, rp.method, rp.retention, rp.requires_export
      FROM security.table_registry tr
      LEFT JOIN maintenance.retention_policy rp ON rp.table_name = tr.table_name
     WHERE tr.storage_class IN ('TENANT', 'CHANNEL', 'AUDIT', 'LEGAL')
  LOOP
    IF r.method IS NULL THEN
      bad := bad || format('%s: no retention policy', r.table_name);
    ELSIF r.storage_class IN ('CHANNEL', 'AUDIT', 'LEGAL') AND r.method = 'TENANT_CLOSURE_ONLY' THEN
      bad := bad || format('%s: no time-based retention', r.table_name);
    ELSIF r.storage_class IN ('CHANNEL', 'AUDIT') AND r.retention > interval '18 months' THEN
      bad := bad || format('%s: retention exceeds 18 months', r.table_name);
    ELSIF r.storage_class = 'TENANT' AND r.method <> 'TENANT_CLOSURE_ONLY' AND cardinality(r.requires_export) = 0
          AND r.table_name <> 'tenant_data.edit_budget'::regclass THEN
      bad := bad || format('%s: tenant data deleted by time without export', r.table_name);
    END IF;
  END LOOP;

  -- 5. Партиционированные таблицы управляются политикой DROP_PARTITION, и наоборот
  FOR r IN
    SELECT tr.table_name, c.relkind, rp.method
      FROM security.table_registry tr JOIN pg_class c ON c.oid = tr.table_name
      LEFT JOIN maintenance.retention_policy rp ON rp.table_name = tr.table_name
  LOOP
    IF (r.relkind = 'p') <> (r.method IS NOT DISTINCT FROM 'DROP_PARTITION') THEN
      bad := bad || format('%s: partitioned table and DROP_PARTITION policy must go together', r.table_name);
    END IF;
  END LOOP;

  -- 6. Р-20: аналитические таблицы не возвращаются в PostgreSQL
  FOR r IN SELECT unnest(ARRAY['channel_data.channel_observation', 'channel_data.competitor_snapshot',
                               'channel_data.channel_write_response', 'channel_data.fee_actual']) AS t LOOP
    IF to_regclass(r.t) IS NOT NULL THEN
      bad := bad || format('%s: belongs to the ClickHouse layer (Р-20)', r.t);
    END IF;
  END LOOP;

  -- 7. Нет FK из данных тенанта в данные каналов, аудит и legal
  FOR r IN
    SELECT con.conname, con.conrelid::regclass AS src, con.confrelid::regclass AS dst
      FROM pg_constraint con
      JOIN pg_class s ON s.oid = con.conrelid JOIN pg_namespace sn ON sn.oid = s.relnamespace
      JOIN pg_class d ON d.oid = con.confrelid JOIN pg_namespace dn ON dn.oid = d.relnamespace
     WHERE con.contype = 'f' AND sn.nspname = 'tenant_data' AND dn.nspname IN ('channel_data', 'audit', 'legal')
       AND NOT s.relispartition
  LOOP
    bad := bad || format('%s -> %s (%s): tenant data must not reference channel/audit/legal data', r.src, r.dst, r.conname);
  END LOOP;

  -- 8. Ни одна роль проекта не обходит RLS
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname LIKE 'repracer\_%' AND rolbypassrls LOOP
    bad := bad || format('role %s has BYPASSRLS', r.rolname);
  END LOOP;

  -- 9. SECURITY DEFINER: фиксированный search_path, нет EXECUTE у PUBLIC
  FOR r IN
    SELECT p.oid::regprocedure AS f, p.proconfig
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname IN ('security', 'platform', 'tenant_data', 'channel_data', 'audit', 'maintenance', 'legal')
       AND p.prosecdef
  LOOP
    IF r.proconfig IS NULL OR NOT EXISTS (SELECT 1 FROM unnest(r.proconfig) cfg WHERE cfg LIKE 'search_path=%') THEN
      bad := bad || format('%s: SECURITY DEFINER without fixed search_path', r.f);
    END IF;
    IF has_function_privilege('public', r.f, 'EXECUTE') THEN
      bad := bad || format('%s: SECURITY DEFINER executable by PUBLIC', r.f);
    END IF;
  END LOOP;

  -- 10. Представления в прикладных схемах читают данные от имени читающего (RLS не обходится через представление)
  FOR r IN
    SELECT c.oid::regclass AS v, c.reloptions
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname IN ('security', 'platform', 'tenant_data', 'channel_data', 'audit', 'maintenance', 'legal')
       AND c.relkind = 'v'
  LOOP
    IF r.reloptions IS NULL OR NOT ('security_invoker=true' = ANY (r.reloptions)) THEN
      bad := bad || format('%s: view without security_invoker = true', r.v);
    END IF;
  END LOOP;

  -- 11. Р-35: шаблон остатка Kaufland не содержит витрину
  IF EXISTS (SELECT 1 FROM platform.channel_capability
              WHERE channel = 'KAUFLAND' AND field = 'QUANTITY' AND 'marketplace' = ANY (write_scope_key_template)) THEN
    bad := bad || 'Kaufland QUANTITY capability keyed by storefront (Р-35)';
  END IF;

  -- 12. Р-43: потолок цены — таблица max_price (append-only), проверяется при создании и отправке записи цены
  IF to_regclass('tenant_data.max_price') IS NULL
     OR NOT EXISTS (SELECT 1 FROM security.table_registry WHERE table_name = 'tenant_data.max_price'::regclass AND mutation_mode = 'append_only') THEN
    bad := bad || 'tenant_data.max_price missing or not append-only (Р-43)';
  END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'tenant_data.channel_write'::regclass
        AND tgname IN ('ba_channel_write_ceiling_insert', 'ba_channel_write_ceiling_dispatch')) <> 2 THEN
    bad := bad || 'channel_write ceiling guards missing (Р-44)';
  END IF;

  -- 13. Р-44: решение не округляется до абсолютной границы; причина отклонения обязательна
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'channel_data.price_decision'::regclass AND conname = 'price_decision_no_bound_clamp')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'channel_data.price_decision'::regclass AND conname = 'price_decision_rejection_reason_iff') THEN
    bad := bad || 'price_decision bound constraints missing (Р-44)';
  END IF;

  -- 14. Потолок не задаётся через guardrail
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'tenant_data.guardrail'::regclass AND conname = 'guardrail_ceiling_moved_to_max_price') THEN
    bad := bad || 'guardrail may still carry max_price_minor (Р-43)';
  END IF;

  -- 15. Р-53: ставки НДС по умолчанию для витрин Release 1.0
  IF (SELECT count(DISTINCT country) FROM platform.vat_rate_default WHERE country IN ('DE', 'AT')) <> 2 THEN
    bad := bad || 'platform.vat_rate_default lacks DE or AT (Р-53)';
  END IF;

  -- 16. Р-52: снятие остановки требует записи в журнале; журнал append-only
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'channel_data.pricing_halt'::regclass AND tgname = 'c_pricing_halt_release_journal')
     OR NOT EXISTS (SELECT 1 FROM security.table_registry WHERE table_name = 'channel_data.pricing_halt_review'::regclass AND mutation_mode = 'append_only') THEN
    bad := bad || 'pricing halt review journal is not enforced (Р-52)';
  END IF;

  -- 17. Р-51: признак цены по конкурентам копируется в решение до проверки остановки
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'channel_data.price_decision'::regclass AND tgname = 'aa_price_decision_copy_derivation') THEN
    bad := bad || 'price_decision.competitor_derived is not derived from the intent (Р-51)';
  END IF;

  IF cardinality(bad) > 0 THEN
    RAISE EXCEPTION E'schema invariant violations:\n%', array_to_string(bad, E'\n');
  END IF;
END $$;

COMMIT;
