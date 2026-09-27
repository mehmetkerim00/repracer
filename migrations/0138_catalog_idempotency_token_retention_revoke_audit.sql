-- 0138_catalog_idempotency_token_retention_revoke_audit.sql
-- Шаг 45, задача E — хвосты ревью шагов 43 и 44. 0134 и 0136 уже в main и не правятся задним числом [Р-146]:
-- исправления идут этой миграцией.
--
--   A. Каталог из обнаружения (находка 15 ревью шага 44):
--      - идемпотентность по КЛЮЧУ единицы записи, а не по SKU: единица с тем же ключом (посевом, прошлым обнаружением с
--        другим написанием SKU) раньше давала нарушение `write_scope_key_uq` и роняла ВЕСЬ такт обнаружения аккаунта;
--        теперь предложение привязывается к уже существующей единице, а второй единицы не рождается;
--      - предложение, завершённое каналом (ENDED) и выставленное снова, каталогизируется заново: прежняя проверка
--        «сопоставление уже есть» не смотрела на статус и держала его вне каталога навсегда;
--      - отложенные стражи срабатывают внутри функции ПОИМЁННО и возвращаются в отложенный режим: `SET CONSTRAINTS ALL
--        IMMEDIATE` действовал до конца транзакции вызывающего и менял поведение всего, что тот делал после.
--   B. Вытесненные токены канала (хвост шага 43): шифротекст версии, вытесненной повторной авторизацией, больше не
--      нужен ни адаптеру, ни проверке — он хранится 30 суток (разбор «почему отказал канал») и удаляется функцией
--      хранителя; роль удаления по сроку прав на шифротекст по-прежнему не имеет [находка 1 ревью шага 43].
--   C. Перевод аккаунта в REVOKED (хвост шага 43) — событие аудита от имени СИСТЕМЫ. Пишет его функция роли аудита
--      триггером на смене статуса: хранитель токенов прав на журнал не получает, и переписать журнал ему нечем [Р-90].

-- ================================================================ A. каталог из обнаружения
GRANT SELECT (status, price_write_scope_id) ON tenant_data.offer_mapping TO repracer_catalog;

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
  -- Стражи вставки, отложенные до фиксации, срабатывают ЗДЕСЬ и правами этой функции (шаг 44), но поимённо и с возвратом
  SET CONSTRAINTS tenant_data.product_bundle_has_components, tenant_data.zw_write_scope_cost_required_guard,
                  tenant_data.write_scope_requires_min_price, tenant_data.write_scope_requires_allocation IMMEDIATE;
  FOR o IN SELECT * FROM jsonb_to_recordset(p_offers)
             AS x(marketplace text, external_sku text, external_unit_id text, external_offer_id text, channel_product_ref text, gtin text, condition text, fulfillment text) LOOP
    -- Витрина вне аккаунта или вне справочника в каталог не попадает: у неё нет ни валюты, ни базы цены
    SELECT m.currency, m.price_basis, m.tax_regime INTO mk FROM platform.marketplace m
     WHERE m.channel = acc.channel AND m.marketplace = o.marketplace AND o.marketplace = ANY (acc.marketplaces);
    CONTINUE WHEN NOT FOUND OR coalesce(o.external_sku, o.external_unit_id) IS NULL;
    -- Действующее сопоставление есть — предложение уже в каталоге; завершённое (ENDED) каталогизируется заново
    CONTINUE WHEN EXISTS (SELECT 1 FROM tenant_data.offer_mapping om
                           WHERE om.tenant_id = p_tenant_id AND om.channel_account_id = p_channel_account_id AND om.marketplace = o.marketplace
                             AND om.status <> 'ENDED'
                             AND coalesce(om.external_sku, om.external_unit_id) = coalesce(o.external_sku, o.external_unit_id));
    identity := jsonb_build_object('region', acc.region, 'marketplace', o.marketplace, 'external_unit_id', o.external_unit_id,
                                   'external_sku', o.external_sku, 'external_listing_id', NULL);
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
                                           scope_kind, scope_key, currency, price_basis, tax_regime, pricing_mode, status)
      VALUES (p_tenant_id, scope, p_channel_account_id, acc.channel, 'PRICE', product, cap.capability_id, cap.version, cap.write_scope_kind,
              v_scope_key, mk.currency, mk.price_basis, mk.tax_regime, 'OFF', 'ACTIVE');
    END IF;
    -- Находка 2 ревью шага 44: способ исполнения — от канала. FBA/FBK (CHANNEL) не получает единицы записи остатка
    INSERT INTO tenant_data.offer_mapping (tenant_id, product_id, channel_account_id, channel, region, marketplace, channel_offer_key,
                                           external_unit_id, external_sku, external_offer_id, channel_product_ref, condition, fulfillment, status, price_write_scope_id)
    VALUES (p_tenant_id, product, p_channel_account_id, acc.channel, acc.region, o.marketplace,
            'discovered:' || o.marketplace || ':' || coalesce(o.external_sku, o.external_unit_id), o.external_unit_id, o.external_sku, o.external_offer_id,
            o.channel_product_ref, upper(coalesce(nullif(o.condition, ''), 'new')),
            CASE WHEN o.fulfillment = 'CHANNEL' THEN 'CHANNEL' ELSE 'MERCHANT' END, 'ACTIVE', scope);
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

-- ================================================================ B. срок вытесненных токенов
/**
 * Общее удаление по сроку (`maintenance.delete_expired_rows`) выбирает строки по `ctid`, а системный столбец требует права
 * SELECT на ВСЮ таблицу — то самое право на шифротекст, которое находка 1 ревью шага 43 у роли удаления отняла. Поэтому
 * срок держит функция ХРАНИТЕЛЯ: без параметров (время — часы базы, «удалить задним числом из будущего» нечем), удаляет
 * только вытесненные версии старше 30 суток, и политика строк не даёт удалить действующую ОДНИМ удалением. Это не
 * граница против самого хранителя: у него есть право отметить версию вытесненной (0136), и две его команды подряд удалят
 * и действующую — хранитель доверенная роль, как и владелец функций проверки (находка 5 ревью шага 45). Зовёт её проверка авторизаций планировщика (роль адаптеров) каждым проходом.
 */
GRANT DELETE ON tenant_data.channel_credential TO repracer_credential_keeper;
CREATE POLICY keeper_purge_superseded ON tenant_data.channel_credential FOR DELETE TO repracer_credential_keeper
  USING (superseded_at IS NOT NULL);
CREATE FUNCTION security.purge_superseded_channel_credentials() RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
DECLARE
  n integer;
BEGIN
  DELETE FROM tenant_data.channel_credential WHERE superseded_at < now() - interval '30 days';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $fn$;
ALTER FUNCTION security.purge_superseded_channel_credentials() OWNER TO repracer_credential_keeper;
REVOKE EXECUTE ON FUNCTION security.purge_superseded_channel_credentials() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION security.purge_superseded_channel_credentials() TO repracer_credentials;

-- ================================================================ C. REVOKED — в аудит
CREATE FUNCTION tenant_data.channel_account_revoked_audit() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
BEGIN
  -- Условие — в теле, а не в WHEN триггера: список допустимых условий WHEN держит проверка схемы (шаг 19)
  IF NEW.auth_status IS DISTINCT FROM 'REVOKED' OR OLD.auth_status IS NOT DISTINCT FROM 'REVOKED' THEN
    RETURN NULL;
  END IF;
  INSERT INTO audit.audit_event (tenant_id, occurred_at, actor_type, action, entity_type, entity_id, changes)
  VALUES (NEW.tenant_id, now(), 'SYSTEM', 'channel.authorization_revoked', 'channel_account', NEW.channel_account_id,
          jsonb_build_object('from', OLD.auth_status, 'to', NEW.auth_status, 'channel', NEW.channel, 'at', now()));
  RETURN NULL;
END $fn$;
ALTER FUNCTION tenant_data.channel_account_revoked_audit() OWNER TO repracer_audit_writer;
REVOKE EXECUTE ON FUNCTION tenant_data.channel_account_revoked_audit() FROM PUBLIC;
CREATE TRIGGER zb_channel_account_revoked_audit AFTER UPDATE OF auth_status ON tenant_data.channel_account
  FOR EACH ROW EXECUTE FUNCTION tenant_data.channel_account_revoked_audit();
