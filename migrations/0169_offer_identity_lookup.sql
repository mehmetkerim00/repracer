-- 0169_offer_identity_lookup.sql
-- Шаг 65, часть 3 (масштаб): поиск предложения по ключу канала. `channel_data.record_channel_observations` (обнаружение офферов, внешние
-- правки, шаги 60–62) на КАЖДЫЙ наблюдённый оффер ищет его строку `offer_mapping` по любому из трёх ключей канала — номеру предложения,
-- номеру единицы или SKU. Индекса по этим ключам не было, и каждый оффер просматривал все предложения аккаунта: круг обнаружения стоил
-- O(n²) — на 10 000 предложений один вызов шёл больше двух минут, на 50 000 круг шёл бы часами. Индексы — ровно под этот поиск:
-- (тенант, аккаунт, витрина, ключ); условие `ключ = значение` в каждой ветке поиска делает частичный индекс применимым, а ветки ИЛИ
-- складываются в BitmapOr.
--
-- Тем же замером: `tenant_data.record_discovered_offers` (каталог из обнаружения) спрашивал «предложение уже в каталоге?» поиском с ИЛИ
-- и выражением над столбцами — тоже без индекса, тоже O(n²) на круг. Ветка eBay вынесена в свою проверку, а «coalesce(SKU, unit) = ключ»
-- записан как «SKU = ключ ИЛИ (SKU пуст И unit = ключ)»: так поиск идёт по индексам SKU и unit. Индекс выражения не годится —
-- под политикой строк роли каталога планировщик его не берёт (проверено EXPLAIN под ролью).

BEGIN;

-- record_channel_observations: ветка «номер единицы» (Kaufland — id_unit)
CREATE INDEX offer_mapping_unit_lookup_idx ON tenant_data.offer_mapping (tenant_id, channel_account_id, marketplace, external_unit_id)
  WHERE external_unit_id IS NOT NULL;
-- record_channel_observations: ветка «номер предложения» (Kaufland — id_offer, eBay — offerId)
CREATE INDEX offer_mapping_offer_lookup_idx ON tenant_data.offer_mapping (tenant_id, channel_account_id, marketplace, external_offer_id)
  WHERE external_offer_id IS NOT NULL;
-- record_channel_observations: ветка «SKU продавца» (Amazon, eBay)
CREATE INDEX offer_mapping_sku_lookup_idx ON tenant_data.offer_mapping (tenant_id, channel_account_id, marketplace, external_sku)
  WHERE external_sku IS NOT NULL;

-- ---------------------------------------------------------------- каталог из обнаружения: «предложение уже в каталоге»
/**
 * `record_discovered_offers` на каждый оффер страницы спрашивает, есть ли он уже в каталоге, по ключу продавца `coalesce(SKU, unit)`
 * ИЛИ (eBay без SKU) по номеру листинга — одним поиском с ИЛИ и выражением над столбцами. Такой поиск не берёт индекс: каждый оффер
 * просматривал все предложения аккаунта, и круг обнаружения стоил O(n²) — на 10 000 предложений 3,3 мс на оффер. Ветка eBay вынесена
 * в свою проверку (смысл тот же: «есть по ключу ИЛИ (eBay без SKU и есть по листингу)»), основной поиск идёт по индексам SKU и unit.
 * Канал предложения в проверке не называется: предложения — этого аккаунта, его канал уже назван `acc.channel`, а столбца `channel` у роли
 * каталога нет (права по столбцам, Р-100) — на общем плане PL/pgSQL ветка не срезается, и упоминание стоило бы отказа права (смоук шага 61)
 */
DO $m$
DECLARE
  def text := pg_get_functiondef('tenant_data.record_discovered_offers(uuid, uuid, jsonb)'::regprocedure);
  fixed text;
BEGIN
  fixed := replace(def, $x$                             AND (coalesce(om.external_sku, om.external_unit_id) = coalesce(o.external_sku, o.external_unit_id)
                                  -- Шаг 47: листинг eBay без SKU узнаётся по номеру листинга
                                  OR (acc.channel = 'EBAY' AND o.external_sku IS NULL AND om.external_listing_id = o.external_listing_id)));$x$, $x$                             -- Шаг 65: «coalesce(SKU, unit) = ключ» без выражения над столбцами — так поиск берёт индексы SKU и unit (BitmapOr) и
                             -- под политикой строк: индекс выражения политика не пропускает (замер шага 65)
                             AND (om.external_sku = coalesce(o.external_sku, o.external_unit_id)
                                  OR (om.external_sku IS NULL AND om.external_unit_id = coalesce(o.external_sku, o.external_unit_id))))
      -- Шаг 47: листинг eBay без SKU узнаётся по номеру листинга. Шаг 65: своей проверкой — ИЛИ внутри одного поиска лишало его индекса
      OR (acc.channel = 'EBAY' AND o.external_sku IS NULL AND EXISTS (SELECT 1 FROM tenant_data.offer_mapping om
                           WHERE om.tenant_id = p_tenant_id AND om.channel_account_id = p_channel_account_id AND om.marketplace = o.marketplace
                             AND om.status <> 'ENDED' AND om.external_listing_id = o.external_listing_id));$x$);
  IF fixed = def THEN
    RAISE EXCEPTION 'record_discovered_offers: the catalogue check was not found — the function changed, update this migration';
  END IF;
  EXECUTE fixed;
END $m$;

COMMIT;
