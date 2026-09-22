-- 0118_stock_path.sql: путь «только остатки» (шаг 35) [Р-152, Р-153].
--
-- База под остатки была готова с шага 2 (0007, 0020): источники, пулы, движения, буферы, резервации, роль остатков [Р-102,
-- Р-105]. Не было ПУТИ: онбординг знал только ценовые шаги, вида задания для импорта остатков не было. Здесь — то, чего
-- не хватало схеме, и один найденный дефект (шестая запись остатка в сессии); расчёт публикуемого количества и запись в
-- канал — в коде (`packages/stock-sync`).

BEGIN;

SET ROLE repracer_owner;

-- ---------------------------------------------------------------- Р-152: два пути онбординга
/**
 * Выбор пути — намерение продавца, его нельзя вывести из данных: тот, кто пришёл за остатками, не обязан вводить
 * себестоимость [Р-131 относится только к репрайсингу]. NULL — путь ещё не выбран, экран предлагает выбор.
 */
ALTER TABLE tenant_data.onboarding_progress ADD COLUMN path text
  CONSTRAINT onboarding_path_known CHECK (path IS NULL OR path IN ('STOCK', 'STOCK_AND_PRICING'));
COMMENT ON COLUMN tenant_data.onboarding_progress.path IS 'Шаг 35 [Р-152]: «остатки» или «остатки + репрайсинг»; NULL — не выбран';

CREATE OR REPLACE FUNCTION tenant_data.onboarding_status(p_tenant_id uuid)
  RETURNS TABLE (step text, done_count int, total_count int, done boolean, awaiting boolean)
  LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog AS $fn$
  WITH chosen AS (
    SELECT p.scope_write_scope_ids AS ids FROM tenant_data.onboarding_progress p WHERE p.tenant_id = p_tenant_id
  ),
  scopes AS (
    SELECT s.write_scope_id, s.pricing_mode, s.pricing_strategy_id
      FROM tenant_data.write_scope s
     WHERE s.tenant_id = p_tenant_id AND s.field = 'PRICE' AND s.status <> 'RETIRED'
       AND (NOT EXISTS (SELECT 1 FROM chosen WHERE ids IS NOT NULL) OR s.write_scope_id = ANY (ARRAY(SELECT unnest(c.ids) FROM chosen c)))
  ),
  accounts AS (
    SELECT count(*) FILTER (WHERE a.auth_status = 'ACTIVE') AS active,
           count(*) FILTER (WHERE a.auth_status = 'AWAITING_ACCESS') AS awaiting
      FROM tenant_data.channel_account a WHERE a.tenant_id = p_tenant_id AND a.disconnected_at IS NULL
  ),
  per_step AS (
    SELECT 'TENANT'::text AS step, 1 AS done_count, 1 AS total_count, false AS awaiting
    UNION ALL
    -- Канал «сделан», если есть хотя бы один рабочий аккаунт; «ожидает» — если хотя бы один ждёт доступа. Это независимые
    -- вещи: один канал может работать, пока другой ждёт партнёрства [Р-150]
    SELECT 'CHANNEL', (SELECT active FROM accounts)::int, (SELECT active + awaiting FROM accounts)::int, (SELECT awaiting > 0 FROM accounts)
    UNION ALL
    SELECT 'COSTS', count(*) FILTER (WHERE tenant_data.write_scope_cost_ready(p_tenant_id, s.write_scope_id, now()))::int, count(*)::int, false FROM scopes s
    UNION ALL
    SELECT 'BOUNDS', count(*) FILTER (WHERE tenant_data.effective_min_price(p_tenant_id, s.write_scope_id) IS NOT NULL
                                        AND tenant_data.effective_max_price(p_tenant_id, s.write_scope_id) IS NOT NULL)::int, count(*)::int, false FROM scopes s
    UNION ALL
    SELECT 'STRATEGY', count(*) FILTER (WHERE s.pricing_strategy_id IS NOT NULL)::int, count(*)::int, false FROM scopes s
    UNION ALL
    SELECT 'ENABLE', count(*) FILTER (WHERE s.pricing_mode = 'ENGINE')::int, count(*)::int, false FROM scopes s
    UNION ALL
    -- Шаг 35 [Р-152]: путь остатков. Источник «есть», когда он заведён И отдал хотя бы один остаток: пустой источник — не источник
    SELECT 'STOCK_SOURCE',
           (SELECT count(*) FROM tenant_data.stock_source src
             WHERE src.tenant_id = p_tenant_id AND src.status = 'ACTIVE'
               AND EXISTS (SELECT 1 FROM tenant_data.stock_pool pl WHERE pl.tenant_id = p_tenant_id AND pl.stock_source_id = src.stock_source_id
                             AND (pl.on_hand > 0 OR pl.source_as_of IS NOT NULL)))::int,
           greatest(1, (SELECT count(*) FROM tenant_data.stock_source src WHERE src.tenant_id = p_tenant_id AND src.status = 'ACTIVE'))::int,
           false
    UNION ALL
    -- Синхронизация «включена» у предложения, когда у него есть единица записи QUANTITY с включённой синхронизацией [Р-6];
    -- знаменатель — предложения, остаток которых ведём мы (MERCHANT): остатком FBA управляет канал
    SELECT 'STOCK_SYNC',
           count(*) FILTER (WHERE q.quantity_sync_enabled)::int, count(*)::int, false
      FROM tenant_data.offer_mapping om
      LEFT JOIN tenant_data.write_scope q ON q.tenant_id = om.tenant_id AND q.write_scope_id = om.quantity_write_scope_id AND q.status <> 'RETIRED'
     WHERE om.tenant_id = p_tenant_id AND om.status = 'ACTIVE' AND om.fulfillment = 'MERCHANT'
       -- Сужение набора [Р-131] чтут ВСЕ шаги: предложение вне набора не считается и здесь (по единице записи ЦЕНЫ того же предложения)
       AND (NOT EXISTS (SELECT 1 FROM chosen WHERE ids IS NOT NULL)
            OR om.price_write_scope_id = ANY (ARRAY(SELECT unnest(c.ids) FROM chosen c)))
  )
  SELECT step, done_count, total_count,
         CASE WHEN step IN ('CHANNEL', 'STOCK_SOURCE') THEN done_count > 0 ELSE total_count > 0 AND done_count = total_count END AS done,
         awaiting
    FROM per_step
$fn$;
ALTER FUNCTION tenant_data.onboarding_status(uuid) OWNER TO repracer_owner;

-- ---------------------------------------------------------------- импорт остатков и включение синхронизации — задания [Р-139] со своим правом [Р-143]
-- Включение на каталог целевого клиента — 10 000 единиц записи и 10 000 записей в канал: 33 с одним запросом, поэтому задание
ALTER TABLE tenant_data.bulk_job DROP CONSTRAINT bulk_job_kind_known;
ALTER TABLE tenant_data.bulk_job ADD CONSTRAINT bulk_job_kind_known
  CHECK (kind IN ('COST_IMPORT', 'BOUNDS_EDIT', 'BOUNDS_PLAN', 'STRATEGY_ASSIGN', 'STRATEGY_PREVIEW',
                  'PRICE_EVIDENCE', 'PRICE_FEED_EXPORT', 'REPRICING_ENABLE', 'STOCK_IMPORT', 'STOCK_SYNC_ENABLE'));

CREATE OR REPLACE FUNCTION security.bulk_job_cancel_action(p_kind text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
  -- Без ветки «иначе» (шаг 34): новый вид без решения о праве получает NULL, и его не пропускают ни страж создания, ни правило 14е
  SELECT CASE WHEN p_kind IN ('PRICE_EVIDENCE', 'PRICE_FEED_EXPORT') THEN 'VIEW_PRICING'
              WHEN p_kind = 'REPRICING_ENABLE' THEN 'ENABLE_REPRICING'
              WHEN p_kind IN ('COST_IMPORT', 'BOUNDS_EDIT', 'BOUNDS_PLAN', 'STRATEGY_ASSIGN', 'STRATEGY_PREVIEW') THEN 'MANAGE_PRICING'
              -- Шаг 35 [Р-152]: остатки ведёт тот, кто ведёт каталог, — менеджеру остатков цены не нужны
              WHEN p_kind IN ('STOCK_IMPORT', 'STOCK_SYNC_ENABLE') THEN 'MANAGE_CATALOG'
         END
$fn$;

-- ---------------------------------------------------------------- Р-105: шестая запись остатка в сессии
CREATE OR REPLACE FUNCTION tenant_data.channel_write_before_insert()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  s           record;
  st          record;
BEGIN
  -- Блокировка единицы: смена режима цены не может пройти одновременно с созданием записи
  SELECT * INTO s FROM tenant_data.write_scope
   WHERE tenant_id = NEW.tenant_id AND write_scope_id = NEW.write_scope_id FOR SHARE;

  IF s.status = 'RETIRED' THEN
    RAISE EXCEPTION 'write_scope % is RETIRED', NEW.write_scope_id USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  -- Р-12: minimum_price Kaufland — только в режиме Smart Pricing; наша цена — только в режиме ENGINE
  IF NEW.field = 'CHANNEL_MIN_PRICE' THEN
    IF s.field <> 'PRICE' OR s.pricing_mode <> 'KAUFLAND_SMART_PRICING' THEN
      RAISE EXCEPTION 'CHANNEL_MIN_PRICE may be written only in KAUFLAND_SMART_PRICING mode'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  ELSIF NEW.field <> s.field THEN
    RAISE EXCEPTION 'write field % does not match write_scope field %', NEW.field, s.field
      USING ERRCODE = 'integrity_constraint_violation';
  ELSIF NEW.field = 'PRICE' AND s.pricing_mode <> 'ENGINE' THEN
    RAISE EXCEPTION 'PRICE writes require pricing_mode ENGINE (scope is %)', s.pricing_mode
      USING ERRCODE = 'integrity_constraint_violation';
  ELSIF NEW.field = 'QUANTITY' AND NOT s.quantity_sync_enabled THEN
    RAISE EXCEPTION 'quantity sync is disabled for write_scope %', NEW.write_scope_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF NEW.field <> 'QUANTITY' THEN
    IF NEW.currency <> s.currency OR NEW.price_basis <> s.price_basis THEN
      RAISE EXCEPTION 'write currency/basis must match write_scope' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    -- INV-02, Р-83: значение не ниже пола, вычисленного заново: min_price и пол маржи по текущим себестоимости, комиссии,
    -- курсу ЕЦБ и ставке НДС
    PERFORM tenant_data.assert_price_floor(NEW.tenant_id, NEW.write_scope_id, NEW.amount_minor, 'at creation');
  END IF;

  /**
   * Шаг 35 (найдено хранилищем остатков): проверка решения — ОТДЕЛЬНЫМ оператором внутри ветки PRICE, а не одним
   * выражением `field = 'PRICE' AND NOT EXISTS (… price_decision …)`. В одном выражении первые пять исполнений в сессии
   * идут по частному плану, где подзапрос свёрнут, а с шестого PL/pgSQL переходит на общий план — подзапрос остаётся,
   * и роль остатков [Р-105], у которой нет права читать price_decision, получала отказ на ШЕСТОЙ записи остатка в
   * сессии. Смоук вставлял не больше пяти и этого не видел.
   */
  IF NEW.field = 'PRICE' THEN
    IF NOT EXISTS (
         SELECT 1 FROM channel_data.price_decision d
          WHERE d.tenant_id = NEW.tenant_id AND d.price_decision_id = NEW.price_decision_id
            AND d.write_scope_id = NEW.write_scope_id
            AND d.outcome IN ('APPROVED', 'CLAMPED_FLOOR', 'CLAMPED_CEILING')
            AND d.final_amount_minor = NEW.amount_minor
            AND d.currency = NEW.currency AND d.price_basis = NEW.price_basis) THEN
      RAISE EXCEPTION 'PRICE write must equal an approved price_decision of the same write_scope'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;

  SELECT * INTO st FROM tenant_data.write_scope_sync_state
   WHERE tenant_id = NEW.tenant_id AND write_scope_id = NEW.write_scope_id;

  IF NEW.field = 'QUANTITY' THEN
    NEW.direction := CASE
      WHEN st.last_sent_quantity IS NULL        THEN 'INCREASE'
      WHEN NEW.quantity < st.last_sent_quantity THEN 'DECREASE'
      WHEN NEW.quantity > st.last_sent_quantity THEN 'INCREASE'
      ELSE 'SAME' END;
  ELSE
    NEW.direction := NULL;
  END IF;

  IF NEW.status <> 'PENDING' THEN
    RAISE EXCEPTION 'new channel_write must be PENDING' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  -- INV-14: в удержанной единице запись создаётся заблокированной, кроме уменьшения остатка
  IF s.status IN ('HELD', 'CONTESTED', 'BLOCKED') AND NOT (NEW.field = 'QUANTITY' AND NEW.direction = 'DECREASE') THEN
    NEW.status := 'BLOCKED';
  END IF;

  IF NEW.budget_scope_key IS DISTINCT FROM s.budget_scope_key THEN
    RAISE EXCEPTION 'budget_scope_key must match write_scope (%)', s.budget_scope_key
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  -- INV-03: версия строго больше последней созданной в единице записи
  UPDATE tenant_data.write_scope_sync_state
     SET latest_version_created = NEW.version
   WHERE tenant_id = NEW.tenant_id AND write_scope_id = NEW.write_scope_id
     AND latest_version_created < NEW.version;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'version % is not greater than latest created version % of write_scope %',
      NEW.version, st.latest_version_created, NEW.write_scope_id USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  NEW.idempotency_key := encode(sha256(convert_to(
    concat_ws('|', NEW.tenant_id, s.channel_account_id, NEW.field, s.scope_key, NEW.version), 'UTF8')), 'hex');
  NEW.created_at := now();
  RETURN NEW;
END $function$;

RESET ROLE;

-- Стражи административной записи (человек + аудит) на таблицах остатков стоят с шага 18 (`a0_admin_write_person_insert`,
-- `zz_admin_write_audit_insert`, …); здесь меняется только ДЕЙСТВИЕ, которое они требуют: MANAGE_CATALOG вместо MANAGE_TENANT
-- у ключей Inbound API — остатки ведёт менеджер остатков, а не администратор тенанта

-- Функция принадлежит мигратору — переопределяется вне SET ROLE (как в 0115)
CREATE OR REPLACE FUNCTION security.admin_write_action(p_table text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $function$
  SELECT a FROM (VALUES
    ('tenant_data.tenant', 'MANAGE_TENANT'), ('tenant_data.channel_account', 'MANAGE_TENANT'), ('tenant_data.inbound_api_key', 'MANAGE_CATALOG'),
    ('tenant_data.channel_capability_override', 'MANAGE_TENANT'), ('tenant_data.price_daily_correction', 'MANAGE_TENANT'),
    ('tenant_data.write_scope', 'ENABLE_REPRICING'),
    ('tenant_data.cost_profile', 'MANAGE_PRICING'), ('tenant_data.min_price', 'MANAGE_PRICING'), ('tenant_data.max_price', 'MANAGE_PRICING'),
    ('tenant_data.cost_import', 'MANAGE_PRICING'),
    ('tenant_data.guardrail', 'MANAGE_PRICING'), ('tenant_data.pricing_strategy', 'MANAGE_PRICING'), ('channel_data.pricing_strategy_undercut', 'MANAGE_PRICING'),
    ('tenant_data.divergence_policy', 'MANAGE_PRICING'), ('channel_data.fee_estimate', 'MANAGE_PRICING'), ('tenant_data.product_vat_rate', 'MANAGE_PRICING'),
    ('channel_data.divergence_case', 'MANAGE_PRICING'),
    ('tenant_data.product', 'MANAGE_CATALOG'), ('tenant_data.bundle_component', 'MANAGE_CATALOG'), ('tenant_data.offer_mapping', 'MANAGE_CATALOG'),
    ('tenant_data.stock_source', 'MANAGE_CATALOG'), ('tenant_data.stock_pool', 'MANAGE_CATALOG'), ('tenant_data.stock_movement', 'MANAGE_CATALOG'),
    ('tenant_data.stock_allocation', 'MANAGE_CATALOG'), ('channel_data.reservation', 'MANAGE_CATALOG'), ('channel_data.sync_job', 'MANAGE_CATALOG'),
    ('channel_data.listing_migration_check', 'MANAGE_CATALOG'),
    ('tenant_data.migration_consent', 'GIVE_MIGRATION_CONSENT'), ('tenant_data.migration_consent_item', 'GIVE_MIGRATION_CONSENT'),
    ('tenant_data.migration_consent_revocation', 'GIVE_MIGRATION_CONSENT'),
    ('channel_data.pricing_halt', 'RELEASE_CHANNEL_HALT'),
    ('channel_data.channel_distrust', 'RELEASE_CHANNEL_DISTRUST'), ('channel_data.offer_channel_pricing', 'MANAGE_CATALOG'),
    ('tenant_data.discount_announcement', 'MANAGE_PRICING'),
    ('tenant_data.bulk_job', 'VIEW_PRICING'),
    -- Шаг 34 [Р-149]: путь ведёт тот, кто вправе править цены
    ('tenant_data.onboarding_progress', 'MANAGE_PRICING'),
    ('tenant_data.price_stop', 'OWN_GUARD'), ('channel_data.pricing_halt_review', 'OWN_GUARD'), ('tenant_data.membership', 'OWN_GUARD'),
    ('channel_data.pricing_halt_sample', 'OWN_GUARD')
  ) AS t(tbl, a) WHERE tbl = p_table
$function$;

-- Окно чтения заказов канала [Р-25] берётся от последнего УСПЕШНОГО запуска работы, а не от последнего любого: такт,
-- провалившийся на бюджете канала, уносил с собой своё окно, и заказы этих минут не становились резервациями вовсе
-- (найдено прогоном суток шага 35: 358 резерваций на 360 заказов). Столбец ведёт планировщик, как остальные отметки.
ALTER TABLE maintenance.scheduled_job ADD COLUMN last_succeeded_at timestamptz;

COMMIT;
