-- 0062_decision_path_allow_list.sql
-- Шаг 17, Р-96: роль пути решения (repracer_app: svc_app, svc_dispatcher) получает ТОЛЬКО то, что нужно для вычисления и записи цены.
-- Не перечисление запретов, а перечисление разрешённого; всё остальное — административной роли. Причина (ревью шага 16): при списке
-- запретов путь решения мог создать согласие на НЕОБРАТИМУЮ миграцию eBay, включить Smart Pricing, менять границы и себестоимость.
--
-- Разрешено (security.decision_path_allowed_privileges() — точный список; проверка схемы сверяет его с фактическими правами):
--   чтение контекста решения: тенант, единица записи и её состояние, предложение, аккаунт, товар и ставка НДС, стратегия и подрез,
--   границы, ограничители, себестоимость и оценка комиссии, остановки и системные остановки, справочники платформы;
--   запись результата: проекции снимков конкурентов, отклонённый снимок, расхождение, наблюдение, intent, решение и ссылка на снимок,
--   ядро intent (триггер), запись в канал и её история, состояние единицы, бюджет правок, outbox, история цен, системная остановка;
--   изменение единицы записи — только статус (блокировка диспетчером).
-- Всё прочее (согласия и проверки миграции eBay, режим тенанта, границы, себестоимость, комиссии, стратегии, аккаунты, товары,
-- предложения, остатки и резервации, ключи входящего API, политики расхождений, поправки дневных цен, снятие остановок и журнал
-- проверок, чтение аудита, членств и пользователей) — административной роли repracer_admin.
-- Автоматическое снятие системной остановки — функцией базы по выборке (0063), а не записью журнала путём решения (находка 2).

BEGIN;

SET ROLE repracer_owner;

-- ---------------------------------------------------------------------------
-- 1. Регистрация новой таблицы больше не выдаёт права пути решения: права по режиму — административной роли
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION security.register_table(p_table regclass, p_storage_class text, p_mutation_mode text, p_policy text DEFAULT 'tenant')
  RETURNS void
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

  -- Политика — для repracer_app и его членов (административная роль — член repracer_app)
  IF p_policy = 'tenant' THEN
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %s TO repracer_app
         USING (tenant_id = security.current_tenant_id())
         WITH CHECK (tenant_id = security.current_tenant_id())', p_table);
  ELSIF p_policy <> 'none' THEN
    RAISE EXCEPTION 'unknown policy mode %', p_policy;
  END IF;

  -- Р-96: права по режиму — административной роли; пути решения — только явным GRANT и строкой в decision_path_allowed_privileges()
  IF p_mutation_mode = 'reference' THEN
    EXECUTE format('GRANT SELECT ON %s TO repracer_admin', p_table);
  ELSE
    EXECUTE format('GRANT SELECT, INSERT ON %s TO repracer_admin', p_table);
  END IF;
  IF p_mutation_mode IN ('mutable', 'mutable_delete') THEN
    EXECUTE format('GRANT UPDATE ON %s TO repracer_admin', p_table);
  END IF;
  IF p_mutation_mode = 'mutable_delete' THEN
    EXECUTE format('GRANT DELETE ON %s TO repracer_admin', p_table);
  END IF;

  IF p_mutation_mode = 'append_only' THEN
    EXECUTE format('CREATE TRIGGER zz_append_only BEFORE UPDATE OR DELETE ON %s
                      FOR EACH ROW EXECUTE FUNCTION security.forbid_mutation()', p_table);
    EXECUTE format('CREATE TRIGGER zz_no_truncate BEFORE TRUNCATE ON %s
                      FOR EACH STATEMENT EXECUTE FUNCTION security.forbid_truncate()', p_table);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Точный список разрешённого пути решения: (таблица, право) и (таблица, право на столбец)
-- ---------------------------------------------------------------------------
CREATE FUNCTION security.decision_path_allowed_privileges()
  RETURNS TABLE (table_name text, privilege text, column_name text)
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT t, p, c FROM (VALUES
    -- справочники платформы
    ('platform.marketplace', 'SELECT', NULL), ('platform.fx_rate', 'SELECT', NULL), ('platform.explanation_ruleset', 'SELECT', NULL),
    ('platform.channel_capability', 'SELECT', NULL), ('platform.vat_rate_default', 'SELECT', NULL),
    -- контекст решения: только чтение
    ('tenant_data.tenant', 'SELECT', NULL), ('tenant_data.channel_account', 'SELECT', NULL), ('tenant_data.product', 'SELECT', NULL),
    ('tenant_data.product_vat_rate', 'SELECT', NULL), ('tenant_data.offer_mapping', 'SELECT', NULL), ('tenant_data.pricing_strategy', 'SELECT', NULL),
    ('channel_data.pricing_strategy_undercut', 'SELECT', NULL), ('tenant_data.min_price', 'SELECT', NULL), ('tenant_data.max_price', 'SELECT', NULL),
    ('tenant_data.guardrail', 'SELECT', NULL), ('tenant_data.cost_profile', 'SELECT', NULL), ('channel_data.fee_estimate', 'SELECT', NULL),
    ('tenant_data.price_stop', 'SELECT', NULL), ('channel_data.pricing_halt_review', 'SELECT', NULL),
    -- единица записи: чтение и блокировка диспетчером
    ('tenant_data.write_scope', 'SELECT', NULL), ('tenant_data.write_scope', 'UPDATE', 'status'),
    ('tenant_data.write_scope_sync_state', 'SELECT', NULL), ('tenant_data.write_scope_sync_state', 'INSERT', NULL), ('tenant_data.write_scope_sync_state', 'UPDATE', NULL),
    -- снимки конкурентов и наблюдения
    ('channel_data.competitor_state', 'SELECT', NULL), ('channel_data.competitor_state', 'INSERT', NULL), ('channel_data.competitor_state', 'UPDATE', NULL),
    ('channel_data.competitor_move', 'SELECT', NULL), ('channel_data.competitor_move', 'INSERT', NULL),
    ('channel_data.competitor_move_latest', 'SELECT', NULL), ('channel_data.competitor_move_latest', 'INSERT', NULL), ('channel_data.competitor_move_latest', 'UPDATE', NULL),
    ('channel_data.competitor_price_daily', 'SELECT', NULL), ('channel_data.competitor_price_daily', 'INSERT', NULL), ('channel_data.competitor_price_daily', 'UPDATE', NULL),
    ('channel_data.rejected_competitor_snapshot', 'SELECT', NULL), ('channel_data.rejected_competitor_snapshot', 'INSERT', NULL),
    ('channel_data.divergence_case', 'SELECT', NULL), ('channel_data.divergence_case', 'INSERT', NULL), ('channel_data.divergence_case', 'UPDATE', NULL),
    ('channel_data.observed_channel_state', 'SELECT', NULL), ('channel_data.observed_channel_state', 'INSERT', NULL), ('channel_data.observed_channel_state', 'UPDATE', NULL),
    ('channel_data.observed_price_daily', 'SELECT', NULL), ('channel_data.observed_price_daily', 'INSERT', NULL), ('channel_data.observed_price_daily', 'UPDATE', NULL),
    -- решение
    ('channel_data.price_intent', 'SELECT', NULL), ('channel_data.price_intent', 'INSERT', NULL),
    ('channel_data.price_decision', 'SELECT', NULL), ('channel_data.price_decision', 'INSERT', NULL),
    ('channel_data.price_decision_snapshot_ref', 'SELECT', NULL), ('channel_data.price_decision_snapshot_ref', 'INSERT', NULL),
    ('tenant_data.price_intent_core', 'INSERT', NULL),
    -- запись в канал
    ('tenant_data.channel_write', 'SELECT', NULL), ('tenant_data.channel_write', 'INSERT', NULL), ('tenant_data.channel_write', 'UPDATE', NULL), ('tenant_data.channel_write', 'DELETE', NULL),
    ('tenant_data.channel_write_history', 'SELECT', NULL), ('tenant_data.channel_write_history', 'INSERT', NULL),
    ('channel_data.write_submission', 'SELECT', NULL), ('channel_data.write_submission', 'INSERT', NULL), ('channel_data.write_submission', 'UPDATE', NULL), ('channel_data.write_submission', 'DELETE', NULL),
    ('tenant_data.edit_budget', 'SELECT', NULL), ('tenant_data.edit_budget', 'INSERT', NULL), ('tenant_data.edit_budget', 'UPDATE', NULL),
    ('tenant_data.outbox_event', 'INSERT', NULL), ('tenant_data.price_history', 'SELECT', NULL), ('tenant_data.price_history', 'INSERT', NULL),
    -- системная остановка по массовому сдвигу [Р-42, Р-51]: только создание; снятие — функцией базы по выборке (0063)
    ('channel_data.pricing_halt', 'SELECT', NULL), ('channel_data.pricing_halt', 'INSERT', NULL)
  ) AS a(t, p, c)
$$;

RESET ROLE;

-- ---------------------------------------------------------------------------
-- 3. Прежние права пути решения — административной роли; затем у пути решения — всё прочь
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT table_schema, table_name, privilege_type FROM information_schema.role_table_grants
            WHERE grantee = 'repracer_app' AND table_schema IN ('tenant_data', 'channel_data', 'platform', 'audit', 'maintenance') LOOP
    EXECUTE format('GRANT %s ON %I.%I TO repracer_admin', r.privilege_type, r.table_schema, r.table_name);
  END LOOP;
  FOR r IN SELECT table_schema, table_name, column_name, privilege_type FROM information_schema.column_privileges
            WHERE grantee = 'repracer_app' AND table_schema IN ('tenant_data', 'channel_data', 'platform', 'audit', 'maintenance')
              AND NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants g
                               WHERE g.grantee = 'repracer_app' AND g.table_schema = column_privileges.table_schema
                                 AND g.table_name = column_privileges.table_name AND g.privilege_type = column_privileges.privilege_type) LOOP
    EXECUTE format('GRANT %s (%I) ON %I.%I TO repracer_admin', r.privilege_type, r.column_name, r.table_schema, r.table_name);
    EXECUTE format('REVOKE %s (%I) ON %I.%I FROM repracer_app', r.privilege_type, r.column_name, r.table_schema, r.table_name);
  END LOOP;
END $$;
REVOKE ALL ON ALL TABLES IN SCHEMA tenant_data, channel_data, platform, audit, maintenance FROM repracer_app;
REVOKE EXECUTE ON FUNCTION security.resolve_inbound_api_key(text, bytea) FROM repracer_app;
GRANT EXECUTE ON FUNCTION security.resolve_inbound_api_key(text, bytea) TO repracer_admin;

-- ---------------------------------------------------------------------------
-- 4. Разрешённое — по списку
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT * FROM security.decision_path_allowed_privileges() LOOP
    IF r.column_name IS NULL THEN
      EXECUTE format('GRANT %s ON %s TO repracer_app', r.privilege, r.table_name);
    ELSE
      EXECUTE format('GRANT %s (%I) ON %s TO repracer_app', r.privilege, r.column_name, r.table_name);
    END IF;
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION security.decision_path_allowed_privileges() TO repracer_app, repracer_admin;

COMMIT;
