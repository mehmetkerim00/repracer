-- 0186_walmart_channel_and_role_rows.sql
-- Шаг 89: две строки матрицы прав по ADR-0054 и канал Walmart на симуляторе.
--
-- Матрица (решение владельца по ADR-0054):
--  - снятие недоверия каналу [Р-118] — снова только владельцу (и прежнему администратору): менеджеру шаг 88 его отдал вместе со
--    стоп-краном, владелец вернул — это решение о том, верить ли каналу снова, а не повседневная остановка;
--  - перевод аккаунта канала обратно в тень [Р-170] — безопасная сторона, теперь и менеджеру: новое право матрицы RETURN_TO_SHADOW.
--    Страж журнала режимов (0128, 0130, 0142) спрашивает его у матрицы, а не держит свой список ролей — консоль и база отвечают из
--    одного места. В бой по-прежнему переводит только владелец со вторым фактором — свой страж, матрица его не касается. Общий страж
--    административной записи требовал на любую правку аккаунта канала права управления тенантом, и менеджер упирался в него, а не в
--    страж журнала: смену режима (её делает только журнал) он теперь оставляет стражу журнала, остальные столбцы — как прежде.
--
-- Walmart (шаг 89, docs/channels/walmart.md): канал на симуляторе по правилам настоящего Walmart Marketplace API, со слов владельца —
-- снимка спецификации нет, поэтому всё неподтверждённое — консервативно и с вопросом W-nn. Живой адаптер — отдельным шагом после ключей.
--  - канал WALMART в списках каналов (аккаунт, возможности, витрины); витрина WALMART_US — walmart.com, USD, нетто, sales tax при покупке
--    [Р-58]; граница суток не установлена (W-02) — бой закрыт до её подтверждения [Р-172], тень работает;
--  - возможности по полям: цена и количество — аккаунт + витрина + SKU, консервативно (W-03, W-04: склады ship node — склад по умолчанию);
--  - источник конкурентов WALMART_BUY_BOX — опрос (W-05: какой API отдаёт цены конкурентов, проверить у живого адаптера);
--  - снятие системной остановки — только человеком (MANUAL_ONLY), строже, пока опрос не проверен на бою;
--  - обнаружение предложений пишет каталог Walmart общей веткой (SKU продавца).

BEGIN;
SET ROLE repracer_owner;

-- ---------------------------------------------------------------- 1. Матрица прав (совпадает с PRICING_PERMISSIONS в коде)
CREATE OR REPLACE FUNCTION security.pricing_permission(p_role text, p_action text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
AS $function$
  SELECT coalesce(p_role = ANY (CASE p_action
    WHEN 'VIEW_PRICING'           THEN ARRAY['OWNER', 'MANAGER', 'VIEWER', 'ADMIN', 'OPERATOR', 'PRICING_MANAGER', 'INVENTORY_MANAGER']
    WHEN 'STOP_PRICING'           THEN ARRAY['OWNER', 'MANAGER', 'ADMIN', 'OPERATOR', 'PRICING_MANAGER']
    WHEN 'RESUME_TENANT_STOP'     THEN ARRAY['OWNER', 'MANAGER', 'ADMIN']
    WHEN 'RESUME_CHANNEL_STOP'    THEN ARRAY['OWNER', 'MANAGER', 'ADMIN', 'OPERATOR', 'PRICING_MANAGER']
    WHEN 'RELEASE_CHANNEL_HALT'   THEN ARRAY['OWNER', 'MANAGER', 'ADMIN', 'OPERATOR', 'PRICING_MANAGER']
    WHEN 'RELEASE_CHANNEL_DISTRUST' THEN ARRAY['OWNER', 'ADMIN']
    WHEN 'ENABLE_REPRICING'       THEN ARRAY['OWNER', 'MANAGER', 'ADMIN', 'OPERATOR', 'PRICING_MANAGER']
    WHEN 'RETURN_TO_SHADOW'       THEN ARRAY['OWNER', 'MANAGER', 'ADMIN']
    WHEN 'MANAGE_PRICING'         THEN ARRAY['OWNER', 'MANAGER', 'ADMIN', 'PRICING_MANAGER']
    WHEN 'MANAGE_CATALOG'         THEN ARRAY['OWNER', 'MANAGER', 'ADMIN', 'INVENTORY_MANAGER']
    WHEN 'MANAGE_TENANT'          THEN ARRAY['OWNER', 'ADMIN']
    WHEN 'GIVE_MIGRATION_CONSENT' THEN ARRAY['OWNER']
    ELSE ARRAY[]::text[] END), false)
$function$;

-- ---------------------------------------------------------------- 2. Обратно в тень — по праву матрицы
CREATE OR REPLACE FUNCTION tenant_data.channel_write_mode_change_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  m record;
  a record;
  unknown_detail text;
BEGIN
  SELECT mb.user_id, mb.role INTO m FROM tenant_data.membership mb
   WHERE mb.tenant_id = NEW.tenant_id AND mb.membership_id = NEW.changed_by_membership_id AND mb.status = 'ACTIVE';
  /**
   * «Человек в сессии есть» проверяет СТАНДАРТНЫЙ страж административной записи (`a0_admin_write_person_insert`), и его
   * случай сюда не попадает специально: иначе он отказывал бы дважды, и снятие стандартного стража ловилось бы этой
   * проверкой — соседней [Р-99, Р-104]. Здесь — только то, чего стандартный не знает: членство принадлежит ТОМУ человеку.
   */
  IF security.current_user_id() IS NOT NULL AND (m.user_id IS NULL OR m.user_id IS DISTINCT FROM security.current_user_id()) THEN
    RAISE EXCEPTION 'membership % is not the membership of the session user', NEW.changed_by_membership_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT ca.write_mode, ca.external_account_id, ca.channel, ca.marketplaces INTO a FROM tenant_data.channel_account ca
   WHERE ca.tenant_id = NEW.tenant_id AND ca.channel_account_id = NEW.channel_account_id;
  -- Переход объявляется от ТЕКУЩЕГО режима: строка «из тени в бой», записанная у боевого аккаунта, — не история, а ложь
  IF NEW.from_mode IS DISTINCT FROM a.write_mode THEN
    RAISE EXCEPTION 'channel account % is in % mode, not in %', NEW.channel_account_id, a.write_mode, NEW.from_mode
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF NEW.to_mode = 'LIVE' THEN
    IF m.role <> 'OWNER' THEN
      RAISE EXCEPTION 'only the owner switches a channel account to LIVE writes (Р-170)' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NOT security.session_mfa() THEN
      RAISE EXCEPTION 'switching to LIVE writes requires a second factor (Р-170, Р-88)' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF btrim(NEW.typed_confirmation) IS DISTINCT FROM a.external_account_id THEN
      RAISE EXCEPTION 'the typed confirmation does not name the channel account (Р-170)' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    -- Р-172: то же правило, что у стража аккаунта, — одной функцией (неизвестное свойство держит БОЙ, а не тень)
    unknown_detail := security.marketplace_properties_unknown(a.channel, a.marketplaces);
    IF unknown_detail IS NOT NULL THEN
      RAISE EXCEPTION 'marketplace property is unknown: % — LIVE writes stay closed while the shadow keeps working (Р-172)',
        unknown_detail USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    NEW.mfa := true;
    -- Находка 2 ревью шага 49: сверено — хранится отметка, а не набранный идентификатор (у eBay это userId пользователя)
    NEW.typed_confirmation := 'matched';
  -- Шаг 89 (ADR-0054, решение владельца): обратно в тень — безопасная сторона, её право в матрице (RETURN_TO_SHADOW: владелец,
  -- менеджер и прежний администратор), а не список ролей здесь: консоль и база отвечают из одной матрицы
  ELSIF NOT security.pricing_permission(m.role, 'RETURN_TO_SHADOW') THEN
    RAISE EXCEPTION 'only the owner or a manager switches a channel account back to SHADOW (Р-170, Р-213)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.changed_at := now();
  RETURN NEW;
END $function$;

-- ---------------------------------------------------------------- 3. Канал WALMART в списках каналов
ALTER TABLE tenant_data.channel_account DROP CONSTRAINT channel_account_channel_check;
ALTER TABLE tenant_data.channel_account ADD CONSTRAINT channel_account_channel_check
  CHECK (channel IN ('AMAZON', 'EBAY', 'KAUFLAND', 'OTTO', 'WALMART'));
ALTER TABLE platform.channel_capability DROP CONSTRAINT channel_capability_channel_check;
ALTER TABLE platform.channel_capability ADD CONSTRAINT channel_capability_channel_check
  CHECK (channel IN ('AMAZON', 'EBAY', 'KAUFLAND', 'OTTO', 'WALMART'));
ALTER TABLE platform.marketplace DROP CONSTRAINT marketplace_channel_check;
ALTER TABLE platform.marketplace ADD CONSTRAINT marketplace_channel_check
  CHECK (channel IN ('AMAZON', 'EBAY', 'KAUFLAND', 'OTTO', 'WALMART'));
-- Источник конкурентов Walmart — в тех же двух списках, что источники остальных каналов (снимок принятый и отвергнутый проверкой входов)
ALTER TABLE channel_data.competitor_state DROP CONSTRAINT competitor_state_source_known;
ALTER TABLE channel_data.competitor_state ADD CONSTRAINT competitor_state_source_known
  CHECK (source IN ('AMAZON_ANY_OFFER_CHANGED', 'AMAZON_COMPETITIVE_SUMMARY', 'KAUFLAND_BUY_BOX_CHANGED', 'KAUFLAND_BUYBOX',
                    'KAUFLAND_COMPETITORS_COMPARER', 'WALMART_BUY_BOX'));
ALTER TABLE channel_data.rejected_competitor_snapshot DROP CONSTRAINT rejected_competitor_snapshot_source_check;
ALTER TABLE channel_data.rejected_competitor_snapshot ADD CONSTRAINT rejected_competitor_snapshot_source_check
  CHECK (source IN ('AMAZON_ANY_OFFER_CHANGED', 'AMAZON_COMPETITIVE_SUMMARY', 'KAUFLAND_BUY_BOX_CHANGED', 'KAUFLAND_BUYBOX',
                    'KAUFLAND_COMPETITORS_COMPARER', 'WALMART_BUY_BOX'));

-- ---------------------------------------------------------------- 4. Справочники платформы: витрина, поведение, источник, возможности
INSERT INTO platform.marketplace (channel, marketplace, country, currency, price_basis, tax_regime, source,
                                  time_zone, time_zone_status, time_zone_source, time_zone_question, time_zone_closes_by,
                                  tax_status, tax_question, tax_source, tax_closes_by) VALUES
  ('WALMART', 'WALMART_US', 'US', 'USD', 'NET', 'SALES_TAX_EXCLUDED',
   'Шаг 89: walmart.com (Walmart Marketplace US); код витрины — наш, снимка спецификации нет (W-01)',
   NULL, 'TO_VERIFY', 'walmart.com: граница суток не установлена — проверить у Walmart; общее значение для США не подставляется [Р-65]', 'W-02', 'CHANNEL_SUPPORT',
   'CONSERVATIVE', 'W-06', 'Р-58: цены walmart.com — нетто, sales tax добавляется при покупке; налоговая база API не подтверждена (W-06)', 'CHANNEL_SUPPORT');

INSERT INTO platform.channel_behaviour (channel, halt_release, basis) VALUES
  ('WALMART', 'MANUAL_ONLY', 'Шаг 89: опрос Buy Box Walmart не проверен на бою (W-05) — снятие системной остановки только человеком');

INSERT INTO platform.competitor_source (channel, source, kind, completeness_kind, completeness_n, conditions, has_buybox_winner, has_own_rank,
                                        has_shipping, typical_staleness_seconds, availability, role) VALUES
  ('WALMART', 'WALMART_BUY_BOX', 'PULL', 'TOP_N', 10, '{new}', true, false, true, NULL, 'AVAILABLE', 'PRIMARY');

INSERT INTO platform.channel_capability (capability_id, version, status, valid_from, channel, region, marketplace_pattern, api_mode, field,
                                         write_scope_kind, write_scope_key_template, write_semantics, processing_mode, side_effects,
                                         requires_side_effects_ack, observation_data_class, write_scope_status, write_scope_question, write_scope_closes_by) VALUES
  ('c0000000-0000-0000-0000-000000000891', 1, 'ACTIVE', now(), 'WALMART', NULL, '*', 'WALMART_MARKETPLACE_API', 'PRICE',
   'ACCOUNT_MARKETPLACE_SKU', ARRAY['channel_account', 'marketplace', 'external_sku'], 'LAST_WRITE_WINS', 'ASYNC', NULL,
   false, 'CHANNEL_INFO', 'CONSERVATIVE', 'W-03', 'FIRST_LIVE_WRITE'),
  ('c0000000-0000-0000-0000-000000000892', 1, 'ACTIVE', now(), 'WALMART', NULL, '*', 'WALMART_MARKETPLACE_API', 'QUANTITY',
   'ACCOUNT_MARKETPLACE_SKU', ARRAY['channel_account', 'marketplace', 'external_sku'], 'LAST_WRITE_WINS', 'ASYNC',
   'количество пишется на склад продавца по умолчанию (ship node); склады с отдельным количеством — W-04',
   false, 'CHANNEL_INFO', 'CONSERVATIVE', 'W-04', 'FIRST_LIVE_WRITE');

RESET ROLE;

-- ---------------------------------------------------------------- 5. Смена режима записи — по праву журнала, а не управления тенантом
CREATE OR REPLACE FUNCTION security.require_person_for_admin_write()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  row_tenant uuid;
  u          uuid;
  r          text;
  action     text := security.admin_write_action(TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME);
  n          jsonb;
  o          jsonb;
BEGIN
  IF NOT security.admin_session() THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  -- Находка 1 ревью шага 18: в сессии административного сервиса любое изменение строки — административная операция, включая
  -- столбцы, которые путь решения тоже меняет (статус единицы записи); аргументы триггера — только перечень административных столбцов
  u := security.current_user_id();
  IF u IS NULL THEN
    RAISE EXCEPTION 'administrative change of %.% without a person: the administrative service writes only on an explicit action of a user (Р-97)',
      TG_TABLE_SCHEMA, TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'DELETE' THEN
    row_tenant := OLD.tenant_id;
  ELSE
    row_tenant := NEW.tenant_id;
  END IF;
  IF action IS NULL THEN
    RAISE EXCEPTION 'administrative change of %.%: no administrative action is declared for the table (Р-100)', TG_TABLE_SCHEMA, TG_TABLE_NAME
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Шаг 19 [Р-104]: проверка «пользователь — действующий участник тенанта строки» удалена как дубль. Мутационная проверка показала:
  -- без неё изменение постороннего (и строки платформенного тенанта, где участников нет) отклоняет журнал аудита — событие USER
  -- без членства не записывается (audit_event_check1), а административная запись без события не фиксируется (Р-97). Таблицы без
  -- общего аудита (остановки человеком, проверки остановок, членства) проверяют участника своими стражами.
  /**
   * Шаг 89 (ADR-0054): смена режима записи аккаунта канала. Столбец меняет только строка журнала режимов (прямую правку отклоняет страж
   * 0128), а кому можно — решает страж журнала: обратно в тень — право RETURN_TO_SHADOW (и у менеджера), в бой — только владелец. Здесь
   * она не требует права управления тенантом: иначе обратно в тень переводил бы только тот, кто управляет тенантом. Прочие столбцы
   * аккаунта вместе с режимом не меняются — журнал меняет только режим
   */
  IF TG_OP = 'UPDATE' AND TG_TABLE_SCHEMA = 'tenant_data' AND TG_TABLE_NAME = 'channel_account' THEN
    -- Поле читается через jsonb: функция общая для многих таблиц, а у них столбца режима нет
    IF to_jsonb(NEW) ->> 'write_mode' IS DISTINCT FROM to_jsonb(OLD) ->> 'write_mode' THEN
      action := 'OWN_GUARD';
    END IF;
  END IF;
  SELECT m.role INTO r FROM tenant_data.membership m WHERE m.tenant_id = row_tenant AND m.user_id = u AND m.status = 'ACTIVE';
  IF action <> 'OWN_GUARD' AND r IS NOT NULL AND NOT security.pricing_permission(r, action) THEN
    RAISE EXCEPTION 'administrative change of %.%: role % may not %, membership is not enough (Р-100, step 17 finding 1)', TG_TABLE_SCHEMA, TG_TABLE_NAME, r, action
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $function$;

-- ---------------------------------------------------------------- 6. Обнаружение предложений Walmart — общей веткой
CREATE OR REPLACE FUNCTION tenant_data.record_discovered_offers(p_tenant_id uuid, p_channel_account_id uuid, p_offers jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
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
  -- Шаг 89: Walmart — общей веткой (SKU продавца, единица записи по шаблону channel_capability), как Amazon
  IF FOUND AND acc.channel NOT IN ('AMAZON', 'KAUFLAND', 'EBAY', 'WALMART') THEN
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
                  external_listing_id text, listing_format text, writable boolean, title text) LOOP
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
    /**
     * Шаг 69 (OQ-249, Р-3): у предложения, которое уже в каталоге, название из канала обновляется и отметка чтения продлевается (не
     * чаще раза в 30 суток, если название то же) — до того, как известное предложение будет пропущено. Товар — тот же, что у
     * действующего сопоставления (тот же поиск, что ниже); название продавца (без отметки чтения) не трогается
     */
    IF nullif(btrim(left(o.title, 200)), '') IS NOT NULL THEN
      UPDATE tenant_data.product p SET title = nullif(btrim(left(o.title, 200)), ''), title_channel_read_at = now()
       WHERE p.tenant_id = p_tenant_id
         AND p.product_id IN (SELECT om.product_id FROM tenant_data.offer_mapping om
                               WHERE om.tenant_id = p_tenant_id AND om.channel_account_id = p_channel_account_id AND om.marketplace = o.marketplace
                                 AND om.status <> 'ENDED'
                                 AND (om.external_sku = coalesce(o.external_sku, o.external_unit_id)
                                      OR (om.external_sku IS NULL AND om.external_unit_id = coalesce(o.external_sku, o.external_unit_id))))
         AND (p.title IS NULL OR p.title_channel_read_at IS NOT NULL)
         AND (p.title IS DISTINCT FROM nullif(btrim(left(o.title, 200)), '') OR p.title_channel_read_at IS NULL
              OR p.title_channel_read_at < now() - interval '30 days');
    END IF;
    -- Действующее сопоставление есть — предложение уже в каталоге; завершённое (ENDED) каталогизируется заново
    CONTINUE WHEN EXISTS (SELECT 1 FROM tenant_data.offer_mapping om
                           WHERE om.tenant_id = p_tenant_id AND om.channel_account_id = p_channel_account_id AND om.marketplace = o.marketplace
                             AND om.status <> 'ENDED'
                             -- Шаг 65: «coalesce(SKU, unit) = ключ» без выражения над столбцами — так поиск берёт индексы SKU и unit (BitmapOr) и
                             -- под политикой строк: индекс выражения политика не пропускает (замер шага 65)
                             AND (om.external_sku = coalesce(o.external_sku, o.external_unit_id)
                                  OR (om.external_sku IS NULL AND om.external_unit_id = coalesce(o.external_sku, o.external_unit_id))))
      -- Шаг 47: листинг eBay без SKU узнаётся по номеру листинга. Шаг 65: своей проверкой — ИЛИ внутри одного поиска лишало его индекса
      OR (acc.channel = 'EBAY' AND o.external_sku IS NULL AND EXISTS (SELECT 1 FROM tenant_data.offer_mapping om
                           WHERE om.tenant_id = p_tenant_id AND om.channel_account_id = p_channel_account_id AND om.marketplace = o.marketplace
                             AND om.status <> 'ENDED' AND om.external_listing_id = o.external_listing_id));
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
        INSERT INTO tenant_data.product (tenant_id, product_id, sku, kind, gtin, title, title_channel_read_at)
        VALUES (p_tenant_id, product, coalesce(o.external_sku, 'ebay-listing:' || o.external_listing_id), 'SIMPLE', nullif(o.gtin, ''), nullif(btrim(left(o.title, 200)), ''),
                CASE WHEN nullif(btrim(left(o.title, 200)), '') IS NOT NULL THEN now() END);
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
        INSERT INTO tenant_data.product (tenant_id, product_id, sku, kind, gtin, title, title_channel_read_at)
        VALUES (p_tenant_id, product, coalesce(o.external_sku, o.external_offer_id, o.external_unit_id), 'SIMPLE', nullif(o.gtin, ''), nullif(btrim(left(o.title, 200)), ''),
                CASE WHEN nullif(btrim(left(o.title, 200)), '') IS NOT NULL THEN now() END);
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
END $function$;
ALTER FUNCTION tenant_data.record_discovered_offers(uuid, uuid, jsonb) OWNER TO repracer_catalog;
REVOKE EXECUTE ON FUNCTION tenant_data.record_discovered_offers(uuid, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenant_data.record_discovered_offers(uuid, uuid, jsonb) TO repracer_app;

COMMIT;
