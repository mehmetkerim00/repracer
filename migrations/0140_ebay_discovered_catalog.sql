-- 0140_ebay_discovered_catalog.sql
-- Шаг 47, задача B [Р-164]: каталог из обнаружения eBay (как Amazon в шаге 44). Листинги eBay попадают в каталог
-- продавца ВСЕ, с честным статусом, а не исчезают:
--   * под Inventory API (`writable`) — предложение ACTIVE, единица записи цены в режиме OFF, `ebay_migration_status =
--     NOT_REQUIRED`;
--   * фиксированная цена не под Inventory API — `MIGRATION_REQUIRED`, `ebay_migration_status = REQUIRED`, единицы записи нет:
--     миграция — только владельцем по согласию [Р-164, Р-101, Р-109];
--   * аукцион — `INELIGIBLE` (ограничение 0010 держит это в базе);
--   * листинг без SKU (частый случай у старых листингов Trading API) — тоже в каталоге, ключ — номер листинга; писать в
--     него нельзя, пока продавец не задаст SKU и не мигрирует листинг;
--   * листинг, ставший доступным для записи, закрывает прежнее «недоступное» сопоставление и получает обычное.
-- Заодно — свойство канала «снятие остановки только человеком» для eBay: конкурентов у eBay не читаем, выборку взять
-- неоткуда [Р-119] (строки не было, и MANUAL_ONLY получался только потому, что её нет).

INSERT INTO platform.channel_behaviour (channel, halt_release, basis) VALUES
  ('EBAY', 'MANUAL_ONLY', 'Р-119: no competitor data on eBay, a fresh independent sample cannot be taken')
ON CONFLICT DO NOTHING;

GRANT SELECT (external_listing_id, ebay_migration_status, status),
      INSERT (external_listing_id, ebay_listing_format, ebay_migration_status),
      -- Находка 2 ревью шага 47: листинг, ставший доступным для записи, закрывает прежнее «недоступное» сопоставление
      UPDATE (status, ended_at) ON tenant_data.offer_mapping TO repracer_catalog;

/**
 * Находка 3 ревью шага 47: у старых листингов Trading API SKU часто нет, и ограничение 0005 требовало SKU у ЛЮБОГО
 * сопоставления eBay — такие листинги пропадали молча. Сопоставлению хватает номера листинга и формата; SKU нужен только
 * тому, во что мы пишем, и это уже держит страж единицы записи (ключ единицы eBay выводится из SKU, без него единицу к
 * сопоставлению не привязать) — второй проверкой SKU здесь не дублируется [Р-104].
 */
ALTER TABLE tenant_data.offer_mapping DROP CONSTRAINT offer_mapping_check1;
ALTER TABLE tenant_data.offer_mapping ADD CONSTRAINT offer_mapping_ebay_identity CHECK (
  channel <> 'EBAY' OR (external_listing_id IS NOT NULL AND ebay_listing_format IS NOT NULL));

/**
 * Находка 4 ревью шага 47 [Р-186]: цена покупателя в сверку Р-116 не идёт, и расхождение «НДС сверху» у EBAY_DE решит бой
 * (E-17). Свойство налоговой базы остаётся CONSERVATIVE (бой не держит — так решил владелец), но называет свой вопрос.
 */
UPDATE platform.marketplace SET tax_question = 'E-17' WHERE channel = 'EBAY' AND marketplace = 'EBAY_DE';

CREATE OR REPLACE FUNCTION tenant_data.record_discovered_offers(p_tenant_id uuid, p_channel_account_id uuid, p_offers jsonb)
  RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
DECLARE
  acc record;
  cap record;
  mk record;
  o record;
  product uuid;
  scope uuid;
  v_scope_key text;
  identity jsonb;
  created integer := 0;
  v_ebay text;
BEGIN
  -- Тенант держат политики строк роли каталога: аккаунт чужого тенанта в сессии этого не находится вовсе [Р-31, Р-104]
  SELECT a.channel, a.region, a.marketplaces INTO acc FROM tenant_data.channel_account a
   WHERE a.tenant_id = p_tenant_id AND a.channel_account_id = p_channel_account_id AND a.disconnected_at IS NULL;
  IF FOUND AND acc.channel NOT IN ('AMAZON', 'KAUFLAND', 'EBAY') THEN
    RETURN 0;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'channel account % of tenant % is unknown or disconnected', p_channel_account_id, p_tenant_id USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  SELECT c.capability_id, c.version, c.write_scope_kind, c.write_scope_key_template, c.budget_scope_attribute INTO cap FROM platform.channel_capability c
   WHERE c.channel = acc.channel AND c.field = 'PRICE' AND c.status = 'ACTIVE' ORDER BY c.valid_from DESC LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no active PRICE capability for channel %', acc.channel USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  -- Стражи вставки, отложенные до фиксации, срабатывают ЗДЕСЬ и правами этой функции (шаг 44), но поимённо и с возвратом
  SET CONSTRAINTS tenant_data.product_bundle_has_components, tenant_data.zw_write_scope_cost_required_guard,
                  tenant_data.write_scope_requires_min_price, tenant_data.write_scope_requires_allocation IMMEDIATE;
  FOR o IN SELECT * FROM jsonb_to_recordset(p_offers)
             AS x(marketplace text, external_sku text, external_unit_id text, external_offer_id text, channel_product_ref text, gtin text, condition text, fulfillment text,
                  external_listing_id text, listing_format text, writable boolean) LOOP
    -- Витрина вне аккаунта или вне справочника в каталог не попадает: у неё нет ни валюты, ни базы цены
    SELECT m.currency, m.price_basis, m.tax_regime INTO mk FROM platform.marketplace m
     WHERE m.channel = acc.channel AND m.marketplace = o.marketplace AND o.marketplace = ANY (acc.marketplaces);
    CONTINUE WHEN NOT FOUND OR (acc.channel <> 'EBAY' AND coalesce(o.external_sku, o.external_unit_id) IS NULL);
    /**
     * Шаг 47 [Р-164]: листинг eBay попадает в каталог ВСЕГДА, но пишем мы только в листинги под Inventory API. Немигрированный
     * листинг — `MIGRATION_REQUIRED`, аукцион — `INELIGIBLE`, и у обоих нет единицы записи (её и не даст ограничение 0010).
     * Без номера листинга или формата листинг eBay не сопоставить — такой в каталог не попадает; без SKU — попадает, но только как недоступный для записи.
     */
    v_ebay := NULL;
    IF acc.channel = 'EBAY' THEN
      CONTINUE WHEN o.external_listing_id IS NULL OR o.listing_format NOT IN ('FIXED_PRICE', 'AUCTION') OR o.writable IS NULL
                 -- писать можно только по SKU: доступный для записи листинг без SKU — ошибка обнаружения, а не каталог
                 OR (o.writable AND o.external_sku IS NULL);
      v_ebay := CASE WHEN o.listing_format = 'AUCTION' THEN 'INELIGIBLE' WHEN o.writable THEN 'NOT_REQUIRED' ELSE 'REQUIRED' END;
      /**
       * Находка 2 ревью шага 47: листинг мигрировали (или выставили фиксированной ценой вместо аукциона) — прежнее
       * «недоступное» сопоставление закрывается, и ниже заводится обычное, с единицей записи. Иначе оно держало бы листинг
       * вне записи навсегда: перевода MIGRATION_REQUIRED → ACTIVE в ядре нет.
       */
      IF o.writable THEN
        UPDATE tenant_data.offer_mapping om SET status = 'ENDED', ended_at = now()
         WHERE om.tenant_id = p_tenant_id AND om.channel_account_id = p_channel_account_id AND om.marketplace = o.marketplace
           AND om.status IN ('MIGRATION_REQUIRED', 'INELIGIBLE') AND om.external_sku = o.external_sku;
      END IF;
    END IF;
    -- Действующее сопоставление есть — предложение уже в каталоге; завершённое (ENDED) каталогизируется заново
    CONTINUE WHEN EXISTS (SELECT 1 FROM tenant_data.offer_mapping om
                           WHERE om.tenant_id = p_tenant_id AND om.channel_account_id = p_channel_account_id AND om.marketplace = o.marketplace
                             AND om.status <> 'ENDED'
                             AND (coalesce(om.external_sku, om.external_unit_id) = coalesce(o.external_sku, o.external_unit_id)
                                  -- Шаг 47: листинг eBay без SKU узнаётся по номеру листинга
                                  OR (acc.channel = 'EBAY' AND o.external_sku IS NULL AND om.external_listing_id = o.external_listing_id)));
    identity := jsonb_build_object('region', acc.region, 'marketplace', o.marketplace, 'external_unit_id', o.external_unit_id,
                                   'external_sku', o.external_sku, 'external_listing_id', o.external_listing_id);
    v_scope_key := tenant_data.derive_scope_key(identity, cap.write_scope_key_template);
    -- Идемпотентность по ключу единицы записи — тому же, что держит `write_scope_key_uq`: существующая единица не дублируется
    scope := NULL;
    product := NULL;
    SELECT s.write_scope_id, s.product_id INTO scope, product FROM tenant_data.write_scope s
     WHERE s.tenant_id = p_tenant_id AND s.channel_account_id = p_channel_account_id AND s.field = 'PRICE'
       AND s.scope_key = v_scope_key AND s.status <> 'RETIRED';
    -- Единица уже несёт действующее предложение (записанное иначе — SKU против unit): второго сопоставления не будет
    CONTINUE WHEN scope IS NOT NULL AND EXISTS (SELECT 1 FROM tenant_data.offer_mapping om
                                                 WHERE om.tenant_id = p_tenant_id AND om.price_write_scope_id = scope AND om.status <> 'ENDED');
    -- Шаг 47: листинг eBay, в который писать нельзя, — товар и сопоставление без единицы записи
    IF v_ebay IN ('REQUIRED', 'INELIGIBLE') THEN
      -- Без SKU товар называется номером листинга: сопоставить его с товаром продавца может только человек
      SELECT p.product_id INTO product FROM tenant_data.product p
       WHERE p.tenant_id = p_tenant_id AND p.sku = coalesce(o.external_sku, 'ebay-listing:' || o.external_listing_id);
      IF product IS NULL THEN
        product := gen_random_uuid();
        INSERT INTO tenant_data.product (tenant_id, product_id, sku, kind, gtin)
        VALUES (p_tenant_id, product, coalesce(o.external_sku, 'ebay-listing:' || o.external_listing_id), 'SIMPLE', nullif(o.gtin, ''));
      END IF;
      INSERT INTO tenant_data.offer_mapping (tenant_id, product_id, channel_account_id, channel, region, marketplace, channel_offer_key,
                                             external_sku, external_listing_id, channel_product_ref, condition, fulfillment, status,
                                             ebay_listing_format, ebay_migration_status)
      VALUES (p_tenant_id, product, p_channel_account_id, acc.channel, acc.region, o.marketplace,
              'discovered:' || o.marketplace || ':' || coalesce(o.external_sku, 'listing:' || o.external_listing_id),
              o.external_sku, o.external_listing_id, o.channel_product_ref, upper(coalesce(nullif(o.condition, ''), 'new')), 'MERCHANT',
              CASE v_ebay WHEN 'INELIGIBLE' THEN 'INELIGIBLE' ELSE 'MIGRATION_REQUIRED' END, o.listing_format, v_ebay);
      created := created + 1;
      CONTINUE;
    END IF;
    IF scope IS NULL THEN
      /**
       * Находка 3 ревью шага 44: у Kaufland один `id_offer` на обе витрины [Р-35] — это ОДИН товар с общим остатком. Ключ
       * товара — SKU продавца, иначе `id_offer`, иначе unit: две витрины одного `id_offer` находят один товар.
       */
      SELECT p.product_id INTO product FROM tenant_data.product p
       WHERE p.tenant_id = p_tenant_id AND p.sku = coalesce(o.external_sku, o.external_offer_id, o.external_unit_id);
      IF product IS NULL THEN
        product := gen_random_uuid();
        INSERT INTO tenant_data.product (tenant_id, product_id, sku, kind, gtin)
        VALUES (p_tenant_id, product, coalesce(o.external_sku, o.external_offer_id, o.external_unit_id), 'SIMPLE', nullif(o.gtin, ''));
      END IF;
      scope := gen_random_uuid();
      INSERT INTO tenant_data.write_scope (tenant_id, write_scope_id, channel_account_id, channel, field, product_id, capability_id, capability_version,
                                           scope_kind, scope_key, currency, price_basis, tax_regime, pricing_mode, status, budget_scope_key)
      VALUES (p_tenant_id, scope, p_channel_account_id, acc.channel, 'PRICE', product, cap.capability_id, cap.version, cap.write_scope_kind,
              v_scope_key, mk.currency, mk.price_basis, mk.tax_regime, 'OFF', 'ACTIVE',
              -- Шаг 47: ключ бюджета правок — из атрибута идентичности, который называет справочник (у eBay — листинг) [Р-19]
              CASE WHEN cap.budget_scope_attribute IS NOT NULL THEN identity ->> cap.budget_scope_attribute END);
    END IF;
    -- Находка 2 ревью шага 44: способ исполнения — от канала. FBA/FBK (CHANNEL) не получает единицы записи остатка
    INSERT INTO tenant_data.offer_mapping (tenant_id, product_id, channel_account_id, channel, region, marketplace, channel_offer_key,
                                           external_unit_id, external_sku, external_offer_id, channel_product_ref, condition, fulfillment, status, price_write_scope_id,
                                           external_listing_id, ebay_listing_format, ebay_migration_status)
    VALUES (p_tenant_id, product, p_channel_account_id, acc.channel, acc.region, o.marketplace,
            'discovered:' || o.marketplace || ':' || coalesce(o.external_sku, o.external_unit_id), o.external_unit_id, o.external_sku, o.external_offer_id,
            o.channel_product_ref, upper(coalesce(nullif(o.condition, ''), 'new')),
            CASE WHEN o.fulfillment = 'CHANNEL' THEN 'CHANNEL' ELSE 'MERCHANT' END, 'ACTIVE', scope,
            o.external_listing_id, CASE WHEN acc.channel = 'EBAY' THEN o.listing_format END, v_ebay);
    created := created + 1;
  END LOOP;
  -- Проверенные сейчас стражи возвращаются в отложенный режим: остаток транзакции вызывающего идёт по умолчанию схемы
  SET CONSTRAINTS tenant_data.product_bundle_has_components, tenant_data.zw_write_scope_cost_required_guard,
                  tenant_data.write_scope_requires_min_price, tenant_data.write_scope_requires_allocation DEFERRED;
  RETURN created;
END $fn$;
ALTER FUNCTION tenant_data.record_discovered_offers(uuid, uuid, jsonb) OWNER TO repracer_catalog;
REVOKE EXECUTE ON FUNCTION tenant_data.record_discovered_offers(uuid, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenant_data.record_discovered_offers(uuid, uuid, jsonb) TO repracer_app;
