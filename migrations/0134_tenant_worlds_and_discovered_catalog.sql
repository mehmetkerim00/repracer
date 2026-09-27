-- 0134_tenant_worlds_and_discovered_catalog.sql
-- Шаг 44 [Р-178, Р-179]: мир тенанта в работе и каталог из обнаружения офферов.
--
-- A. Р-178: консоль в работе строит мир КАЖДОГО тенанта, в котором у пользователя есть действующее членство. Какие это
--    тенанты — решает база, а не консоль: функция отдаёт только клиентские тенанты, не демо, и только членства, не
--    гостевые. Демо остаётся отдельным гостевым путём (Р-160); смешать их консоль не может, потому что списка «все
--    тенанты пользователя» у неё нет.
--
-- B. Р-179: путь пилота «Connect Amazon → тень нашла офферы → себестоимость → границы → стратегия». До шага 44 товары,
--    предложения и единицы записи цены создавал ТОЛЬКО посев стенда: обнаружение офферов писало наблюдения, и у
--    настоящего тенанта после подключения канала каталога не появлялось вовсе. Теперь обнаружение ЗАПИСЫВАЕТ каталог:
--    товар по SKU, предложение и единицу записи цены в режиме OFF — функцией базы с узкой ролью [Р-90]. Цены она не
--    трогает, движок не включает: включение — по-прежнему путь онбординга [Р-131, Р-149].
BEGIN;

-- ================================================================ A. миры тенантов [Р-178]
/**
 * Тенанты, чьи миры консоль строит пользователю. Граница «миры тенантов и демо не смешиваются» — фильтр `NOT t.demo`:
 * демо-тенант показывается только гостевым путём, со своей меткой [Р-151, Р-160]. Отдельного фильтра гостевых членств
 * нет намеренно [Р-104]: гостевое членство существует только в демо-тенанте (0124), и снять такой фильтр было бы нечем
 * провалить.
 */
CREATE FUNCTION security.console_tenant_worlds(p_user_id uuid)
  RETURNS TABLE (tenant_id uuid, tenant_name text, membership_id uuid, role text, locale text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $fn$
  SELECT m.tenant_id, t.name, m.membership_id, m.role, t.locale
    FROM tenant_data.membership m
    JOIN tenant_data.tenant t ON t.tenant_id = m.tenant_id
   WHERE m.user_id = p_user_id AND m.status = 'ACTIVE'
     AND NOT t.demo AND t.status NOT IN ('OFFBOARDING', 'CLOSED')
   ORDER BY t.name, m.tenant_id
$fn$;
ALTER FUNCTION security.console_tenant_worlds(uuid) OWNER TO repracer_resolver;
REVOKE EXECUTE ON FUNCTION security.console_tenant_worlds(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION security.console_tenant_worlds(uuid) TO repracer_authenticator;
GRANT SELECT (tenant_id, name, status, demo, locale) ON tenant_data.tenant TO repracer_resolver;
GRANT SELECT (tenant_id, membership_id, user_id, role, status) ON tenant_data.membership TO repracer_resolver;
CREATE POLICY resolver_worlds_tenant ON tenant_data.tenant FOR SELECT TO repracer_resolver USING (true);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'membership' AND 'repracer_resolver' = ANY (roles) AND cmd IN ('SELECT', 'ALL')) THEN
    EXECUTE 'CREATE POLICY resolver_worlds_membership ON tenant_data.membership FOR SELECT TO repracer_resolver USING (true)';
  END IF;
END $$;

-- ================================================================ B. каталог из обнаружения [Р-179]
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'repracer_catalog') THEN CREATE ROLE repracer_catalog NOLOGIN; END IF;
END $$;
GRANT USAGE ON SCHEMA tenant_data, platform, security TO repracer_catalog;
GRANT EXECUTE ON FUNCTION security.current_tenant_id() TO repracer_catalog;
GRANT SELECT (tenant_id, channel_account_id, channel, region, marketplaces, disconnected_at) ON tenant_data.channel_account TO repracer_catalog;
GRANT SELECT ON platform.channel_capability, platform.marketplace TO repracer_catalog;
CREATE POLICY catalog_capability_read ON platform.channel_capability FOR SELECT TO repracer_catalog USING (tenant_id = security.platform_tenant_id());
CREATE POLICY catalog_marketplace_read ON platform.marketplace FOR SELECT TO repracer_catalog USING (tenant_id = security.platform_tenant_id());
GRANT EXECUTE ON FUNCTION security.platform_tenant_id() TO repracer_catalog;
GRANT SELECT (tenant_id, product_id, sku, kind, status), INSERT (tenant_id, product_id, sku, kind, gtin) ON tenant_data.product TO repracer_catalog;
GRANT INSERT (tenant_id, write_scope_id, channel_account_id, channel, field, product_id, capability_id, capability_version, scope_kind,
              scope_key, currency, price_basis, tax_regime, pricing_mode, status, budget_scope_key) ON tenant_data.write_scope TO repracer_catalog;
GRANT SELECT (tenant_id, product_id, channel_account_id, marketplace, external_sku, external_unit_id, external_offer_id),
      INSERT (tenant_id, product_id, channel_account_id, channel, region, marketplace, channel_offer_key, external_unit_id, external_sku,
              external_offer_id, channel_product_ref, condition, fulfillment, status, price_write_scope_id) ON tenant_data.offer_mapping TO repracer_catalog;
/**
 * Стражи вставки товара, предложения и единицы записи работают правами вызывающего и читают соседние таблицы (Р-120,
 * миграция eBay, стратегия, состояние синхронизации). Роль каталога получает ЧТЕНИЕ ровно этих таблиц в пределах тенанта
 * сессии и вставку состояния синхронизации, которую делает страж единицы записи; писать цены и включать движок ей нечем.
 */
GRANT USAGE ON SCHEMA channel_data TO repracer_catalog;
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['channel_data.offer_channel_pricing', 'channel_data.listing_migration_check', 'tenant_data.migration_consent',
                           'tenant_data.migration_consent_item', 'tenant_data.migration_consent_revocation', 'tenant_data.bundle_component',
                           'tenant_data.write_scope_sync_state', 'tenant_data.channel_write', 'tenant_data.pricing_strategy',
                           'channel_data.pricing_strategy_undercut', 'tenant_data.tenant', 'tenant_data.write_scope'] LOOP
    EXECUTE format('GRANT SELECT ON %s TO repracer_catalog', t);
    EXECUTE format('CREATE POLICY catalog_guard_read ON %s FOR SELECT TO repracer_catalog USING (tenant_id = security.current_tenant_id())', t);
  END LOOP;
END $$;
GRANT INSERT ON tenant_data.write_scope_sync_state TO repracer_catalog;
CREATE POLICY catalog_sync_state_insert ON tenant_data.write_scope_sync_state FOR INSERT TO repracer_catalog WITH CHECK (tenant_id = security.current_tenant_id());
CREATE POLICY catalog_account_read ON tenant_data.channel_account FOR SELECT TO repracer_catalog USING (tenant_id = security.current_tenant_id());
CREATE POLICY catalog_product ON tenant_data.product FOR ALL TO repracer_catalog
  USING (tenant_id = security.current_tenant_id()) WITH CHECK (tenant_id = security.current_tenant_id());
CREATE POLICY catalog_write_scope ON tenant_data.write_scope FOR INSERT TO repracer_catalog WITH CHECK (tenant_id = security.current_tenant_id());
CREATE POLICY catalog_offer ON tenant_data.offer_mapping FOR ALL TO repracer_catalog
  USING (tenant_id = security.current_tenant_id()) WITH CHECK (tenant_id = security.current_tenant_id());

/**
 * Обнаруженные офферы аккаунта → каталог тенанта. Идемпотентно: предложение, уже известное по аккаунту, витрине и
 * идентификатору канала, не создаётся второй раз. Витрина — только из витрин аккаунта и справочника: валюту, базу цены и
 * налоговый режим единица записи берёт у витрины [Р-57, Р-58], а не у оффера. Тенант — из сессии пути решения: чужого
 * аккаунта функция не находит [Р-31]. Возвращает число СОЗДАННЫХ предложений.
 */
CREATE FUNCTION tenant_data.record_discovered_offers(p_tenant_id uuid, p_channel_account_id uuid, p_offers jsonb)
  RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
DECLARE
  acc record;
  cap record;
  mk record;
  o record;
  product uuid;
  scope uuid;
  identity jsonb;
  created integer := 0;
BEGIN
  -- Тенант держат политики строк роли каталога: аккаунт чужого тенанта в сессии этого не находится вовсе [Р-31, Р-104]
  SELECT a.channel, a.region, a.marketplaces INTO acc FROM tenant_data.channel_account a
   WHERE a.tenant_id = p_tenant_id AND a.channel_account_id = p_channel_account_id AND a.disconnected_at IS NULL;
  IF FOUND AND acc.channel NOT IN ('AMAZON', 'KAUFLAND') THEN
    -- eBay без листинга и статуса миграции предложение не заводит (Р-2): обнаружение eBay каталога не пишет, а не падает
    RETURN 0;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'channel account % of tenant % is unknown or disconnected', p_channel_account_id, p_tenant_id USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  SELECT c.capability_id, c.version, c.write_scope_kind, c.write_scope_key_template INTO cap FROM platform.channel_capability c
   WHERE c.channel = acc.channel AND c.field = 'PRICE' AND c.status = 'ACTIVE' ORDER BY c.valid_from DESC LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no active PRICE capability for channel %', acc.channel USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  FOR o IN SELECT * FROM jsonb_to_recordset(p_offers)
             AS x(marketplace text, external_sku text, external_unit_id text, external_offer_id text, channel_product_ref text, gtin text, condition text, fulfillment text) LOOP
    -- Витрина вне аккаунта или вне справочника в каталог не попадает: у неё нет ни валюты, ни базы цены
    SELECT m.currency, m.price_basis, m.tax_regime INTO mk FROM platform.marketplace m
     WHERE m.channel = acc.channel AND m.marketplace = o.marketplace AND o.marketplace = ANY (acc.marketplaces);
    CONTINUE WHEN NOT FOUND OR coalesce(o.external_sku, o.external_unit_id) IS NULL;
    CONTINUE WHEN EXISTS (SELECT 1 FROM tenant_data.offer_mapping om
                           WHERE om.tenant_id = p_tenant_id AND om.channel_account_id = p_channel_account_id AND om.marketplace = o.marketplace
                             AND coalesce(om.external_sku, om.external_unit_id) = coalesce(o.external_sku, o.external_unit_id));
    /**
     * Находка 3 ревью шага 44: у Kaufland один `id_offer` на обе витрины [Р-35] — это ОДИН товар с общим остатком. Ключ
     * товара — SKU продавца, иначе `id_offer`, иначе unit: две витрины одного `id_offer` находят один товар.
     */
    product := NULL;
    SELECT p.product_id INTO product FROM tenant_data.product p
     WHERE p.tenant_id = p_tenant_id AND p.sku = coalesce(o.external_sku, o.external_offer_id, o.external_unit_id);
    IF product IS NULL THEN
      product := gen_random_uuid();
      INSERT INTO tenant_data.product (tenant_id, product_id, sku, kind, gtin)
      VALUES (p_tenant_id, product, coalesce(o.external_sku, o.external_offer_id, o.external_unit_id), 'SIMPLE', nullif(o.gtin, ''));
    END IF;
    identity := jsonb_build_object('region', acc.region, 'marketplace', o.marketplace, 'external_unit_id', o.external_unit_id,
                                   'external_sku', o.external_sku, 'external_listing_id', NULL);
    scope := gen_random_uuid();
    INSERT INTO tenant_data.write_scope (tenant_id, write_scope_id, channel_account_id, channel, field, product_id, capability_id, capability_version,
                                         scope_kind, scope_key, currency, price_basis, tax_regime, pricing_mode, status)
    VALUES (p_tenant_id, scope, p_channel_account_id, acc.channel, 'PRICE', product, cap.capability_id, cap.version, cap.write_scope_kind,
            tenant_data.derive_scope_key(identity, cap.write_scope_key_template), mk.currency, mk.price_basis, mk.tax_regime, 'OFF', 'ACTIVE');
    -- Находка 2 ревью шага 44: способ исполнения — от канала. FBA/FBK (CHANNEL) не получает единицы записи остатка
    INSERT INTO tenant_data.offer_mapping (tenant_id, product_id, channel_account_id, channel, region, marketplace, channel_offer_key,
                                           external_unit_id, external_sku, external_offer_id, channel_product_ref, condition, fulfillment, status, price_write_scope_id)
    VALUES (p_tenant_id, product, p_channel_account_id, acc.channel, acc.region, o.marketplace,
            'discovered:' || o.marketplace || ':' || coalesce(o.external_sku, o.external_unit_id), o.external_unit_id, o.external_sku, o.external_offer_id,
            o.channel_product_ref, upper(coalesce(nullif(o.condition, ''), 'new')),
            CASE WHEN o.fulfillment = 'CHANNEL' THEN 'CHANNEL' ELSE 'MERCHANT' END, 'ACTIVE', scope);
    created := created + 1;
  END LOOP;
  /**
   * Отложенные стражи (набор товара, пол цены, распределение остатка, себестоимость) сработали бы при фиксации — уже
   * правами вызывающего пути решения, у которого нет чтения каталога. Здесь они срабатывают сейчас и правами этой функции.
   */
  SET CONSTRAINTS ALL IMMEDIATE;
  RETURN created;
END $fn$;
ALTER FUNCTION tenant_data.record_discovered_offers(uuid, uuid, jsonb) OWNER TO repracer_catalog;
REVOKE EXECUTE ON FUNCTION tenant_data.record_discovered_offers(uuid, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenant_data.record_discovered_offers(uuid, uuid, jsonb) TO repracer_app;

-- ================================================================ C. исполнитель заданий для всех тенантов [Р-178]
/**
 * Исполнитель массовых заданий знал миры из своей конфигурации, и задание тенанта, заведённого после запуска процесса,
 * не брал никто. Теперь он спрашивает у базы, у КАКИХ тенантов есть ждущее задание: только идентификаторы, без
 * параметров и итогов — дальше он работает в контексте тенанта, как раньше (политика `bulk_worker_tenant`).
 */
CREATE FUNCTION security.bulk_job_waiting_tenants() RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $fn$
  -- Демо-тенант ведёт свой исполнитель мира демо: миры тенантов и демо не смешиваются и здесь [Р-178]
  SELECT DISTINCT j.tenant_id FROM tenant_data.bulk_job j JOIN tenant_data.tenant t ON t.tenant_id = j.tenant_id
   WHERE NOT t.demo AND (j.status IN ('PENDING', 'INTERRUPTED') OR (j.status = 'RUNNING' AND j.lease_until <= now()))
$fn$;
ALTER FUNCTION security.bulk_job_waiting_tenants() OWNER TO repracer_retention;
REVOKE EXECUTE ON FUNCTION security.bulk_job_waiting_tenants() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION security.bulk_job_waiting_tenants() TO repracer_bulk_worker;

COMMIT;
