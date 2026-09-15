-- 0061_verify_schema_invariants_v13.sql
-- Проверка схемы после шага 16 — последняя в наборе. Р-93: правило проверяет ПОВЕДЕНИЕ либо не существует.
-- Остались:
--   - свойства каталога, которые и есть поведение: RLS ENABLE+FORCE, регистрация и сроки хранения, политики, append-only без прав
--     на изменение, привилегии ролей, отсутствие BYPASSRLS, SECURITY DEFINER с фиксированным search_path, security_invoker;
--   - данные справочников, от которых зависит поведение (НДС по умолчанию, витрины и их пояса, срок ссылки на снимок);
--   - матрица прав ролей подключения [Р-90];
--   - поведенческие проверки в откатываемой подтранзакции: синтетический тенант строится и полностью откатывается, в базе не
--     остаётся ничего — Р-83 (отправка ниже пересчитанного пола маржи), находка 15 и Р-91 (слепок и стратегия).
-- Удалены правила 0056, сверявшие имена триггеров и ограничений и текст функций (position(... IN pg_get_functiondef(...))): такое
-- правило проходит при недостижимом вызове. Какой поведенческий тест заменяет каждое — migrations/README.md, раздел «Р-93».

BEGIN;

DO $$
DECLARE
  r   record;
  bad text[] := '{}';
  -- поведенческие проверки
  verdict text;
  cap     record;
  t   constant uuid := 'f0930000-0000-4000-8000-000000000001';
  u   constant uuid := 'f0930000-0000-4000-8000-000000000002';
  m   constant uuid := 'f0930000-0000-4000-8000-000000000003';
  acc constant uuid := 'f0930000-0000-4000-8000-000000000004';
  prod constant uuid := 'f0930000-0000-4000-8000-000000000005';
  ws  constant uuid := 'f0930000-0000-4000-8000-000000000006';
  st  constant uuid := 'f0930000-0000-4000-8000-000000000007';
  intent_at timestamptz;
  min_id uuid;
  max_id uuid;
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

  -- 12. Данные, от которых зависит поведение: НДС по умолчанию для витрин Release 1.0 [Р-53]; витрина ЕС с НДС и витрина США с налогом
  --     с продаж [Р-58]; витрине США пояс не подставлен без подтверждения [Р-65]; ссылка на снимок не дольше 18 месяцев [Р-38, Р-68]
  IF (SELECT count(DISTINCT country) FROM platform.vat_rate_default WHERE country IN ('DE', 'AT')) <> 2 THEN
    bad := bad || 'platform.vat_rate_default lacks DE or AT (Р-53)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM platform.marketplace WHERE channel = 'KAUFLAND' AND marketplace = 'de' AND tax_regime = 'VAT_INCLUDED')
     OR NOT EXISTS (SELECT 1 FROM platform.marketplace WHERE tax_regime = 'SALES_TAX_EXCLUDED' AND currency = 'USD' AND price_basis = 'NET') THEN
    bad := bad || 'platform.marketplace lacks an EU VAT or a US sales tax storefront (Р-58)';
  END IF;
  FOR r IN SELECT channel, marketplace FROM platform.marketplace WHERE country = 'US' AND time_zone IS NOT NULL AND time_zone_status <> 'CONFIRMED' LOOP
    bad := bad || format('%s %s: unconfirmed time zone substituted for a US storefront (Р-65)', r.channel, r.marketplace);
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM maintenance.retention_policy
                  WHERE table_name = 'channel_data.price_decision_snapshot_ref'::regclass AND retention + coalesce(safety_margin, interval '0') <= interval '18 months') THEN
    bad := bad || 'snapshot reference of a decision may outlive 18 months (Р-38, Р-68)';
  END IF;

  -- 13. Привилегии служебных ролей: обход диспетчера [Р-64], ретранслятор [Р-34], загрузчик курсов [Р-61], экспортёр [Р-79]
  IF NOT has_function_privilege('repracer_dispatcher', 'maintenance.due_write_scopes(timestamptz, interval, interval, int)', 'EXECUTE')
     OR has_function_privilege('repracer_app', 'maintenance.due_write_scopes(timestamptz, interval, interval, int)', 'EXECUTE')
     OR has_column_privilege('repracer_dispatcher', 'tenant_data.channel_write', 'amount_minor', 'SELECT')
     OR has_table_privilege('repracer_dispatcher', 'tenant_data.channel_write', 'UPDATE')
     OR has_column_privilege('repracer_dispatcher', 'tenant_data.write_scope', 'scope_key', 'SELECT') THEN
    bad := bad || 'the dispatcher sweep is executable beyond repracer_dispatcher or sees write amounts and scope keys (Р-64)';
  END IF;
  IF NOT has_table_privilege('repracer_relay', 'tenant_data.outbox_event', 'SELECT')
     OR has_table_privilege('repracer_relay', 'tenant_data.outbox_event', 'INSERT')
     OR has_table_privilege('repracer_relay', 'tenant_data.channel_write', 'SELECT')
     OR has_table_privilege('repracer_relay', 'channel_data.price_decision', 'SELECT') THEN
    bad := bad || 'outbox relay role is broader than the outbox (Р-34)';
  END IF;
  IF has_table_privilege('repracer_app', 'platform.fx_rate', 'INSERT') OR NOT has_table_privilege('repracer_fx_loader', 'platform.fx_rate', 'INSERT') THEN
    bad := bad || 'ECB rates are writable by repracer_app or not by the loader (Р-61)';
  END IF;
  IF NOT has_table_privilege('repracer_exporter', 'tenant_data.pricing_strategy', 'SELECT')
     OR NOT has_table_privilege('repracer_exporter', 'platform.explanation_ruleset', 'SELECT') THEN
    bad := bad || 'the core archive exporter cannot read the strategy versions and rulesets its explanations refer to (Р-79)';
  END IF;
  -- Р-86: у листовых секций ядра и решения нет порога сжатия
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'maintenance.retention_policy'::regclass AND attname = 'leaf_toast_tuple_target' AND NOT attisdropped)
     OR EXISTS (SELECT 1 FROM (VALUES ('channel_data.price_decision'::regclass), ('tenant_data.price_intent_core'::regclass)) AS tt(tbl)
                  CROSS JOIN LATERAL pg_partition_tree(tt.tbl) pt JOIN pg_class c ON c.oid = pt.relid
                 WHERE pt.isleaf AND c.reloptions::text LIKE '%toast_tuple_target%') THEN
    bad := bad || 'partition compression settings of step 14 are still present (Р-86)';
  END IF;

  -- 14. Р-90: роли подключения. Путь решения не пишет аудит, членства, тенантов, пользователей и остановки человеком, не приглашает,
  --     не создаёт тенанта, не сопоставляет вход и не становится административной ролью; журнал аудита пишет только роль триггеров
  FOR r IN SELECT * FROM (VALUES
      ('audit.audit_event', 'INSERT'), ('tenant_data.membership', 'INSERT'), ('tenant_data.membership', 'UPDATE'), ('tenant_data.tenant', 'INSERT'),
      ('platform.app_user', 'INSERT'), ('platform.app_user', 'UPDATE'), ('tenant_data.price_stop', 'INSERT'), ('tenant_data.price_stop', 'UPDATE'),
      ('platform.external_identity', 'INSERT')) AS p(tbl, priv) LOOP
    IF has_table_privilege('repracer_app', r.tbl, r.priv) THEN
      bad := bad || format('repracer_app has %s on %s (Р-90)', r.priv, r.tbl);
    END IF;
  END LOOP;
  FOR r IN SELECT p.oid::regprocedure AS f FROM pg_proc p
            WHERE p.pronamespace = 'security'::regnamespace
              AND p.proname IN ('invite_member', 'provision_tenant', 'resolve_external_identity', 'accept_identity_invitation', 'list_user_tenants',
                                'find_user_by_email', 'issue_signup_invitation') LOOP
    IF has_function_privilege('repracer_app', r.f, 'EXECUTE') THEN
      bad := bad || format('repracer_app may execute %s (Р-90)', r.f);
    END IF;
  END LOOP;
  IF pg_has_role('repracer_app', 'repracer_admin', 'MEMBER') OR pg_has_role('repracer_app', 'repracer_provisioning', 'MEMBER')
     OR pg_has_role('repracer_app', 'repracer_authenticator', 'MEMBER') THEN
    bad := bad || 'the decision path role is a member of the administrative, provisioning or authenticator role (Р-90)';
  END IF;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname LIKE 'repracer\_%' AND rolname NOT IN ('repracer_owner', 'repracer_audit_writer')
                                          AND has_table_privilege(rolname, 'audit.audit_event', 'INSERT') LOOP
    bad := bad || format('role %s may insert audit events directly; only the audit trigger role may (Р-90)', r.rolname);
  END LOOP;
  IF has_table_privilege('repracer_admin', 'tenant_data.membership', 'INSERT') THEN
    bad := bad || 'the administrative role may insert memberships directly; only invitations and provisioning create them (Р-90)';
  END IF;

  -- 15. Р-83 — поведение: запись цены, созданная при полу маржи 15,24 €, после роста себестоимости (пол 16,76 €) не отправляется;
  --     запись не ниже нового пола — отправляется. Синтетический мир строится в подтранзакции и откатывается целиком.
  verdict := NULL;
  BEGIN
    PERFORM set_config('app.tenant_id', t::text, true);
    SELECT capability_id, version, write_scope_kind, write_scope_key_template INTO cap FROM platform.channel_capability
     WHERE channel = 'KAUFLAND' AND field = 'PRICE' AND status = 'ACTIVE' ORDER BY valid_from DESC LIMIT 1;
    IF cap IS NULL THEN
      INSERT INTO platform.channel_capability (capability_id, version, status, valid_from, channel, region, api_mode, field, write_scope_kind,
          write_scope_key_template, budget_scope_attribute, object_edit_limit, processing_mode, requires_side_effects_ack, observation_data_class)
      VALUES ('f0930000-0000-4000-8000-0000000000c0', 1, 'ACTIVE', now() - interval '1 day', 'KAUFLAND', NULL, 'KAUFLAND_SELLER_API_V2', 'PRICE',
              'ACCOUNT_STOREFRONT_UNIT', ARRAY['channel_account', 'marketplace', 'external_unit_id'], NULL, NULL, 'SYNC', false, 'CHANNEL_INFO')
      RETURNING capability_id, version, write_scope_kind, write_scope_key_template INTO cap;
    END IF;
    PERFORM security.provision_tenant(t, 'schema verification (rolled back)', coalesce(nullif(current_setting('repracer.region', true), ''), 'EU'),
      jsonb_build_array(jsonb_build_object('membershipId', m, 'userId', u, 'email', 'verify-0061@example.invalid', 'role', 'OWNER')));
    INSERT INTO tenant_data.channel_account (tenant_id, channel_account_id, channel, external_account_id, marketplaces, credentials_ref, connected_by_membership_id)
    VALUES (t, acc, 'KAUFLAND', 'verify-0061', ARRAY['de'], 'secret-ref:verify', m);
    INSERT INTO tenant_data.product (tenant_id, product_id, sku, kind) VALUES (t, prod, 'verify-0061', 'SIMPLE');
    INSERT INTO tenant_data.write_scope (tenant_id, write_scope_id, channel_account_id, channel, field, product_id, capability_id, capability_version,
        scope_kind, scope_key, currency, price_basis, tax_regime, pricing_mode)
    VALUES (t, ws, acc, 'KAUFLAND', 'PRICE', prod, cap.capability_id, cap.version, cap.write_scope_kind,
            tenant_data.derive_scope_key('{"marketplace":"de","external_unit_id":"V0061"}', cap.write_scope_key_template), 'EUR', 'GROSS', 'VAT_INCLUDED', 'OFF');
    INSERT INTO tenant_data.offer_mapping (tenant_id, product_id, channel_account_id, channel, marketplace, channel_offer_key, external_unit_id, status, price_write_scope_id)
    VALUES (t, prod, acc, 'KAUFLAND', 'de', 'V0061@de', 'V0061', 'ACTIVE', ws);
    INSERT INTO tenant_data.min_price (tenant_id, scope_type, write_scope_id, currency, price_basis, amount_minor, version, created_by_membership_id)
    VALUES (t, 'WRITE_SCOPE', ws, 'EUR', 'GROSS', 1000, 1, m) RETURNING min_price_id INTO min_id;
    INSERT INTO tenant_data.max_price (tenant_id, scope_type, write_scope_id, currency, price_basis, amount_minor, version, created_by_membership_id)
    VALUES (t, 'WRITE_SCOPE', ws, 'EUR', 'GROSS', 5000, 1, m) RETURNING max_price_id INTO max_id;
    INSERT INTO tenant_data.pricing_strategy (tenant_id, pricing_strategy_id, version, name, type, params, triggers, status, created_by_membership_id)
    VALUES (t, st, 1, 'verify fixed', 'FIXED', '{"type":"FIXED","priceMinor":1600,"deadbandMinor":0}', ARRAY['SCHEDULE'], 'ACTIVE', m);
    UPDATE tenant_data.write_scope SET pricing_strategy_id = st, pricing_strategy_version = 1, pricing_mode = 'ENGINE' WHERE tenant_id = t AND write_scope_id = ws;
    -- Пол маржи 10 % при комиссии 10 % и НДС 19 %: себестоимость 10,00 € → 15,24 €; 11,00 € → 16,76 €
    INSERT INTO tenant_data.guardrail (tenant_id, scope_type, write_scope_id, min_margin_bp, on_violation, version, created_by_membership_id)
    VALUES (t, 'WRITE_SCOPE', ws, 1000, 'HOLD', 1, m);
    INSERT INTO tenant_data.cost_profile (tenant_id, product_id, channel_account_id, marketplace, version, valid_from, currency, purchase_cost_minor, source, created_by_membership_id)
    VALUES (t, prod, acc, 'de', 1, now() - interval '1 hour', 'EUR', 1000, 'MANUAL', m);
    INSERT INTO channel_data.fee_estimate (tenant_id, write_scope_id, source, fee_model, fee_schedule_version, computed_at, valid_until)
    VALUES (t, ws, 'FEE_SCHEDULE', '{"feeRateBp": 1000, "fixedFeeMinor": 0}', 'verify', now() - interval '1 hour', now() + interval '1 day');
    INSERT INTO channel_data.price_intent (tenant_id, price_intent_id, created_at, write_scope_id, created_by_membership_id, trigger_type, proposed_amount_minor,
        currency, price_basis, expires_at, rule_code)
    VALUES (t, 'f0930000-0000-4000-8000-000000000011', now(), ws, m, 'MANUAL', 1600, 'EUR', 'GROSS', now() + interval '10 minutes', 'FIXED')
    RETURNING created_at INTO intent_at;
    INSERT INTO channel_data.price_decision (tenant_id, price_decision_id, intent_created_at, price_intent_id, write_scope_id, outcome, final_amount_minor,
        rejection_reason, currency, price_basis, effective_floor_minor, min_price_ids, effective_ceiling_minor, max_price_ids, reason_params, explanation,
        sanity_ruleset, gate_profile)
    VALUES (t, 'f0930000-0000-4000-8000-000000000012', intent_at, 'f0930000-0000-4000-8000-000000000011', ws, 'APPROVED', 1600, NULL, 'EUR', 'GROSS', 1524,
            ARRAY[min_id], 5000, ARRAY[max_id], '{}', '{"format":"r80.1","snapshot":{"source":"KAUFLAND_BUYBOX"},"sanity":{"anchorsUsed":[],"checks":[]},"strategy":{"reason":{"code":"FIXED_PRICE"}}}',
            'r49.1', 'g74.1');
    INSERT INTO tenant_data.channel_write (tenant_id, channel_write_id, write_scope_id, field, amount_minor, currency, price_basis, version, origin, price_decision_id)
    VALUES (t, 'f0930000-0000-4000-8000-000000000013', ws, 'PRICE', 1600, 'EUR', 'GROSS', 1, 'PRICE_DECISION', 'f0930000-0000-4000-8000-000000000012');
    -- Себестоимость выросла между созданием записи и отправкой
    INSERT INTO tenant_data.cost_profile (tenant_id, product_id, channel_account_id, marketplace, version, valid_from, currency, purchase_cost_minor, source, created_by_membership_id)
    VALUES (t, prod, acc, 'de', 2, now() - interval '1 minute', 'EUR', 1100, 'MANUAL', m);
    BEGIN
      UPDATE tenant_data.channel_write SET status = 'DISPATCHED', attempt_count = 1, dispatched_at = now()
       WHERE tenant_id = t AND channel_write_id = 'f0930000-0000-4000-8000-000000000013';
      verdict := 'a price write below the recomputed margin floor was dispatched';
    EXCEPTION WHEN check_violation OR integrity_constraint_violation THEN
      NULL;
    END;
    -- Контроль: та же единица, цена не ниже нового пола — отправка проходит (правило не отказывает всем)
    IF verdict IS NULL THEN
      INSERT INTO channel_data.price_intent (tenant_id, price_intent_id, created_at, write_scope_id, created_by_membership_id, trigger_type, proposed_amount_minor,
          currency, price_basis, expires_at, rule_code)
      VALUES (t, 'f0930000-0000-4000-8000-000000000021', now(), ws, m, 'MANUAL', 1700, 'EUR', 'GROSS', now() + interval '10 minutes', 'FIXED')
      RETURNING created_at INTO intent_at;
      INSERT INTO channel_data.price_decision (tenant_id, price_decision_id, intent_created_at, price_intent_id, write_scope_id, outcome, final_amount_minor,
          rejection_reason, currency, price_basis, effective_floor_minor, min_price_ids, effective_ceiling_minor, max_price_ids, reason_params, explanation,
          sanity_ruleset, gate_profile)
      VALUES (t, 'f0930000-0000-4000-8000-000000000022', intent_at, 'f0930000-0000-4000-8000-000000000021', ws, 'APPROVED', 1700, NULL, 'EUR', 'GROSS', 1676,
              ARRAY[min_id], 5000, ARRAY[max_id], '{}', '{"format":"r80.1","snapshot":{"source":"KAUFLAND_BUYBOX"},"sanity":{"anchorsUsed":[],"checks":[]},"strategy":{"reason":{"code":"FIXED_PRICE"}}}',
              'r49.1', 'g74.1');
      INSERT INTO tenant_data.channel_write (tenant_id, channel_write_id, write_scope_id, field, amount_minor, currency, price_basis, version, origin, price_decision_id)
      VALUES (t, 'f0930000-0000-4000-8000-000000000023', ws, 'PRICE', 1700, 'EUR', 'GROSS', 2, 'PRICE_DECISION', 'f0930000-0000-4000-8000-000000000022');
      UPDATE tenant_data.channel_write SET status = 'DISPATCHED', attempt_count = 1, dispatched_at = now()
       WHERE tenant_id = t AND channel_write_id = 'f0930000-0000-4000-8000-000000000023';
      IF NOT FOUND THEN
        verdict := 'a price write not below the recomputed floor was not dispatched';
      END IF;
    END IF;

    -- Находка 15 — поведение: то же решение с незаявленным ключом в параметрах причины база не принимает
    IF verdict IS NULL THEN
      BEGIN
        INSERT INTO channel_data.price_intent (tenant_id, price_intent_id, created_at, write_scope_id, created_by_membership_id, trigger_type, proposed_amount_minor,
            currency, price_basis, expires_at, rule_code)
        VALUES (t, 'f0930000-0000-4000-8000-000000000031', now(), ws, m, 'MANUAL', 1700, 'EUR', 'GROSS', now() + interval '10 minutes', 'FIXED')
        RETURNING created_at INTO intent_at;
        INSERT INTO channel_data.price_decision (tenant_id, price_decision_id, intent_created_at, price_intent_id, write_scope_id, outcome, final_amount_minor,
            rejection_reason, currency, price_basis, effective_floor_minor, min_price_ids, effective_ceiling_minor, max_price_ids, reason_params, explanation,
            sanity_ruleset, gate_profile)
        VALUES (t, 'f0930000-0000-4000-8000-000000000032', intent_at, 'f0930000-0000-4000-8000-000000000031', ws, 'APPROVED', 1700, NULL, 'EUR', 'GROSS', 1676,
                ARRAY[min_id], 5000, ARRAY[max_id], '{}',
                '{"format":"r80.1","snapshot":{"source":"KAUFLAND_BUYBOX"},"sanity":{"anchorsUsed":[],"checks":[]},"strategy":{"reason":{"code":"FIXED_PRICE","params":{"target":1780}}}}', 'r49.1', 'g74.1');
        verdict := 'an explanation with an undeclared reason parameter was stored (finding 15)';
      EXCEPTION WHEN check_violation THEN
        NULL;
      END;
    END IF;

    -- Р-91 — поведение: версия стратегии с подрезом в параметрах не сохраняется
    IF verdict IS NULL THEN
      BEGIN
        INSERT INTO tenant_data.pricing_strategy (tenant_id, pricing_strategy_id, version, name, type, params, triggers, status, created_by_membership_id)
        VALUES (t, st, 2, 'verify fixed', 'FIXED', '{"type":"FIXED","priceMinor":1600,"deadbandMinor":0,"undercutMinor":5}', ARRAY['SCHEDULE'], 'ACTIVE', m);
        verdict := 'a strategy version kept the undercut (Р-91)';
      EXCEPTION WHEN check_violation THEN
        NULL;
      END;
    END IF;

    RAISE EXCEPTION 'rollback of the verification world' USING ERRCODE = 'RR093';
  EXCEPTION
    WHEN SQLSTATE 'RR093' THEN
      NULL;
    WHEN OTHERS THEN
      verdict := coalesce(verdict, 'the verification world could not be built: ' || SQLERRM);
  END;
  IF verdict IS NOT NULL THEN
    bad := bad || ('behaviour check (Р-83, finding 15, Р-91): ' || verdict);
  END IF;
  IF EXISTS (SELECT 1 FROM tenant_data.tenant WHERE tenant_id = t) THEN
    bad := bad || 'the verification world was not rolled back';
  END IF;

  IF cardinality(bad) > 0 THEN
    RAISE EXCEPTION E'schema invariant violations:\n%', array_to_string(bad, E'\n');
  END IF;
END $$;

COMMIT;
