-- 0005_offers_write_scopes.sql
-- Единицы записи (ADR-0002), состояние синхронизации, сопоставления офферов.

BEGIN;
SET ROLE repracer_owner;

-- Таблицы, которые ведут только триггеры других таблиц: прямой INSERT/UPDATE приложением запрещён.
CREATE FUNCTION security.only_from_trigger() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION '%.% is maintained by triggers only', TG_TABLE_SCHEMA, TG_TABLE_NAME
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------
-- write_scope — единица записи одного поля в канал.
-- product_id хранится на единице: все офферы единицы ссылаются на тот же товар через составной FK.
-- ---------------------------------------------------------------------------
CREATE TABLE tenant_data.write_scope (
  tenant_id                      uuid NOT NULL,
  write_scope_id                 uuid NOT NULL DEFAULT gen_random_uuid(),
  channel_account_id             uuid NOT NULL,
  channel                        text NOT NULL,
  field                          text NOT NULL CHECK (field IN ('PRICE', 'QUANTITY')),
  product_id                     uuid NOT NULL,
  capability_id                  uuid NOT NULL,
  capability_version             int  NOT NULL,
  scope_kind                     text NOT NULL,
  scope_key                      text NOT NULL CHECK (length(scope_key) BETWEEN 1 AND 500),
  budget_scope_key               text,
  processing_mode                text CHECK (processing_mode IN ('SYNC', 'ASYNC')),
  requires_side_effects_ack      boolean NOT NULL DEFAULT false,
  currency                       text CHECK (currency ~ '^[A-Z]{3}$'),
  price_basis                    text CHECK (price_basis IN ('GROSS', 'NET')),
  -- Р-12: единственный столбец режима — смешение режимов невозможно по построению
  pricing_mode                   text CHECK (pricing_mode IN ('OFF', 'ENGINE', 'KAUFLAND_SMART_PRICING')),
  pricing_strategy_id            uuid,
  pricing_strategy_version       int,
  quantity_sync_enabled          boolean,
  status                         text NOT NULL DEFAULT 'ACTIVE'
                                 CHECK (status IN ('ACTIVE', 'HELD', 'CONTESTED', 'BLOCKED', 'RETIRED')),
  side_effects_ack_membership_id uuid,
  side_effects_ack_at            timestamptz,
  supersedes_write_scope_id      uuid,
  created_at                     timestamptz NOT NULL DEFAULT now(),
  retired_at                     timestamptz,
  PRIMARY KEY (tenant_id, write_scope_id),
  -- Цель FK, требующих конкретное поле единицы (guardrail, stock_allocation, divergence_policy)
  UNIQUE (tenant_id, write_scope_id, field),
  -- Цель FK из offer_mapping: оффер привязан к единице своего поля, своего товара и своего аккаунта
  UNIQUE (tenant_id, write_scope_id, field, product_id, channel_account_id),
  -- Цель FK из min_price уровня единицы: валюта и база пола совпадают с единицей
  UNIQUE (tenant_id, write_scope_id, field, currency, price_basis),
  FOREIGN KEY (tenant_id, channel_account_id, channel)
    REFERENCES tenant_data.channel_account (tenant_id, channel_account_id, channel),
  FOREIGN KEY (tenant_id, product_id) REFERENCES tenant_data.product (tenant_id, product_id),
  FOREIGN KEY (capability_id, capability_version, channel, field)
    REFERENCES platform.channel_capability (capability_id, version, channel, field),
  FOREIGN KEY (tenant_id, supersedes_write_scope_id) REFERENCES tenant_data.write_scope (tenant_id, write_scope_id),
  FOREIGN KEY (tenant_id, side_effects_ack_membership_id) REFERENCES tenant_data.membership (tenant_id, membership_id),
  CHECK ((field = 'PRICE') = (currency IS NOT NULL AND price_basis IS NOT NULL AND pricing_mode IS NOT NULL)),
  CHECK ((field = 'QUANTITY') = (quantity_sync_enabled IS NOT NULL)),
  -- Р-12: Smart Pricing существует только у Kaufland
  CHECK (pricing_mode IS DISTINCT FROM 'KAUFLAND_SMART_PRICING' OR channel = 'KAUFLAND'),
  -- Р-12: вне режима ENGINE наш движок для единицы полностью выключен
  CHECK (pricing_strategy_id IS NULL OR pricing_mode = 'ENGINE'),
  CHECK ((pricing_strategy_id IS NULL) = (pricing_strategy_version IS NULL)),
  CHECK ((side_effects_ack_at IS NULL) = (side_effects_ack_membership_id IS NULL)),
  -- INV-11: синхронизация остатка с побочными эффектами (Amazon EU) — только после подтверждения
  CHECK (NOT coalesce(quantity_sync_enabled, false) OR NOT requires_side_effects_ack OR side_effects_ack_at IS NOT NULL),
  CHECK ((status = 'RETIRED') = (retired_at IS NOT NULL)),
  CHECK (status <> 'RETIRED' OR (coalesce(pricing_mode, 'OFF') = 'OFF' AND NOT coalesce(quantity_sync_enabled, false)))
);

-- Входящее наблюдение/нотификация -> единица записи по ключу; уникальность ключа среди действующих единиц
CREATE UNIQUE INDEX write_scope_key_uq
  ON tenant_data.write_scope (tenant_id, channel_account_id, field, scope_key)
  WHERE status <> 'RETIRED';

-- Пересчёт остатка (товар -> единицы QUANTITY) и проверка min_price уровня товара (товар -> единицы PRICE)
CREATE INDEX write_scope_product_idx
  ON tenant_data.write_scope (tenant_id, product_id, field)
  WHERE status <> 'RETIRED';

-- Проверка при отключении режима Smart Pricing у тенанта
CREATE INDEX write_scope_smart_pricing_idx
  ON tenant_data.write_scope (tenant_id)
  WHERE pricing_mode = 'KAUFLAND_SMART_PRICING' AND status <> 'RETIRED';

CREATE TRIGGER write_scope_restrict_update BEFORE UPDATE ON tenant_data.write_scope
  FOR EACH ROW EXECUTE FUNCTION security.restrict_update(
    'pricing_mode', 'pricing_strategy_id', 'pricing_strategy_version', 'quantity_sync_enabled', 'status',
    'side_effects_ack_membership_id', 'side_effects_ack_at', 'retired_at');

-- Свойства единицы берутся из действующего правила, а не от приложения;
-- RETIRED — терминальный статус; Smart Pricing — только при явном режиме тенанта [Р-12].
CREATE FUNCTION tenant_data.write_scope_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  c record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT status, write_scope_kind, processing_mode, requires_side_effects_ack, budget_scope_attribute INTO c
      FROM platform.channel_capability
     WHERE capability_id = NEW.capability_id AND version = NEW.capability_version;
    IF c.status IS DISTINCT FROM 'ACTIVE' THEN
      RAISE EXCEPTION 'write_scope must be derived from an ACTIVE capability' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF (c.budget_scope_attribute IS NULL) <> (NEW.budget_scope_key IS NULL) THEN
      RAISE EXCEPTION 'budget_scope_key presence must follow capability budget_scope_attribute'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    NEW.scope_kind                := c.write_scope_kind;
    NEW.processing_mode           := c.processing_mode;
    NEW.requires_side_effects_ack := c.requires_side_effects_ack;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'RETIRED' THEN
    RAISE EXCEPTION 'write_scope % is RETIRED', OLD.write_scope_id USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.pricing_mode = 'KAUFLAND_SMART_PRICING'
     AND NOT EXISTS (SELECT 1 FROM tenant_data.tenant
                      WHERE tenant_id = NEW.tenant_id AND kaufland_smart_pricing_opt_in_at IS NOT NULL) THEN
    RAISE EXCEPTION 'tenant has not opted in to Kaufland Smart Pricing' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER write_scope_guard BEFORE INSERT OR UPDATE ON tenant_data.write_scope
  FOR EACH ROW EXECUTE FUNCTION tenant_data.write_scope_guard();

-- Тенант не может выйти из режима Smart Pricing, пока есть единицы в этом режиме.
CREATE FUNCTION tenant_data.tenant_smart_pricing_opt_out_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.kaufland_smart_pricing_opt_in_at IS NOT NULL AND NEW.kaufland_smart_pricing_opt_in_at IS NULL
     AND EXISTS (SELECT 1 FROM tenant_data.write_scope
                  WHERE tenant_id = NEW.tenant_id AND pricing_mode = 'KAUFLAND_SMART_PRICING' AND status <> 'RETIRED') THEN
    RAISE EXCEPTION 'switch all write scopes out of KAUFLAND_SMART_PRICING before opting out'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER tenant_smart_pricing_opt_out_guard BEFORE UPDATE OF kaufland_smart_pricing_opt_in_at ON tenant_data.tenant
  FOR EACH ROW EXECUTE FUNCTION tenant_data.tenant_smart_pricing_opt_out_guard();

SELECT security.register_table('tenant_data.write_scope', 'TENANT', 'mutable');

-- ---------------------------------------------------------------------------
-- write_scope_sync_state — водяные знаки версий. Ведётся только триггерами channel_write (0008).
-- ---------------------------------------------------------------------------
CREATE TABLE tenant_data.write_scope_sync_state (
  tenant_id                 uuid NOT NULL,
  write_scope_id            uuid NOT NULL,
  latest_version_created    bigint NOT NULL DEFAULT 0,
  latest_version_dispatched bigint NOT NULL DEFAULT 0,
  latest_version_accepted   bigint NOT NULL DEFAULT 0,
  latest_version_applied    bigint NOT NULL DEFAULT 0,
  in_flight_write_id        uuid,
  last_sent_amount_minor    bigint,
  last_sent_quantity        int,
  updated_at                timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, write_scope_id),
  FOREIGN KEY (tenant_id, write_scope_id) REFERENCES tenant_data.write_scope (tenant_id, write_scope_id),
  CHECK (latest_version_dispatched <= latest_version_created),
  CHECK (latest_version_accepted   <= latest_version_dispatched),
  CHECK (latest_version_applied    <= latest_version_dispatched)
);

-- Водяные знаки только растут.
CREATE FUNCTION tenant_data.sync_state_monotonic() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.latest_version_created    < OLD.latest_version_created
  OR NEW.latest_version_dispatched < OLD.latest_version_dispatched
  OR NEW.latest_version_accepted   < OLD.latest_version_accepted
  OR NEW.latest_version_applied    < OLD.latest_version_applied THEN
    RAISE EXCEPTION 'write_scope_sync_state watermarks must not decrease (scope %)', OLD.write_scope_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

CREATE TRIGGER a_sync_state_only_from_trigger BEFORE INSERT OR UPDATE ON tenant_data.write_scope_sync_state
  FOR EACH ROW EXECUTE FUNCTION security.only_from_trigger();
CREATE TRIGGER b_sync_state_monotonic BEFORE UPDATE ON tenant_data.write_scope_sync_state
  FOR EACH ROW EXECUTE FUNCTION tenant_data.sync_state_monotonic();

SELECT security.register_table('tenant_data.write_scope_sync_state', 'TENANT', 'mutable');

CREATE FUNCTION tenant_data.write_scope_create_sync_state() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO tenant_data.write_scope_sync_state (tenant_id, write_scope_id)
  VALUES (NEW.tenant_id, NEW.write_scope_id);
  RETURN NULL;
END $$;

CREATE TRIGGER write_scope_create_sync_state AFTER INSERT ON tenant_data.write_scope
  FOR EACH ROW EXECUTE FUNCTION tenant_data.write_scope_create_sync_state();

-- ---------------------------------------------------------------------------
-- offer_mapping — оффер канала <-> товар. Не единица синхронизации.
-- Имена атрибутов идентичности совпадают с элементами write_scope_key_template.
-- ---------------------------------------------------------------------------
CREATE TABLE tenant_data.offer_mapping (
  tenant_id               uuid NOT NULL,
  offer_mapping_id        uuid NOT NULL DEFAULT gen_random_uuid(),
  product_id              uuid NOT NULL,
  channel_account_id      uuid NOT NULL,
  channel                 text NOT NULL,
  marketplace             text NOT NULL,
  channel_offer_key       text NOT NULL,
  region                  text,
  external_sku            text,
  external_offer_id       text,
  external_listing_id     text,
  external_unit_id        text,
  channel_product_ref     text,
  ebay_listing_format     text CHECK (ebay_listing_format IN ('FIXED_PRICE', 'AUCTION')),
  ebay_migration_status   text CHECK (ebay_migration_status IN ('NOT_REQUIRED', 'REQUIRED', 'INELIGIBLE',
                                      'MIGRATION_STARTED', 'MIGRATED', 'FAILED', 'OUTCOME_UNKNOWN')),
  condition               text NOT NULL DEFAULT 'NEW',
  fulfillment             text NOT NULL DEFAULT 'MERCHANT' CHECK (fulfillment IN ('MERCHANT', 'CHANNEL')),
  status                  text NOT NULL DEFAULT 'DISCOVERED'
                          CHECK (status IN ('DISCOVERED', 'ACTIVE', 'PAUSED', 'CONFLICT',
                                            'MIGRATION_REQUIRED', 'INELIGIBLE', 'ENDED')),
  price_write_scope_id    uuid,
  price_scope_field       text NOT NULL DEFAULT 'PRICE' CHECK (price_scope_field = 'PRICE'),
  quantity_write_scope_id uuid,
  quantity_scope_field    text NOT NULL DEFAULT 'QUANTITY' CHECK (quantity_scope_field = 'QUANTITY'),
  created_at              timestamptz NOT NULL DEFAULT now(),
  ended_at                timestamptz,
  PRIMARY KEY (tenant_id, offer_mapping_id),
  FOREIGN KEY (tenant_id, channel_account_id, channel)
    REFERENCES tenant_data.channel_account (tenant_id, channel_account_id, channel),
  FOREIGN KEY (tenant_id, product_id) REFERENCES tenant_data.product (tenant_id, product_id),
  -- INV-11: все офферы единицы записи ссылаются на тот же товар и аккаунт, поле совпадает
  FOREIGN KEY (tenant_id, price_write_scope_id, price_scope_field, product_id, channel_account_id)
    REFERENCES tenant_data.write_scope (tenant_id, write_scope_id, field, product_id, channel_account_id),
  FOREIGN KEY (tenant_id, quantity_write_scope_id, quantity_scope_field, product_id, channel_account_id)
    REFERENCES tenant_data.write_scope (tenant_id, write_scope_id, field, product_id, channel_account_id),
  -- Обязательные атрибуты идентичности по каналам
  CHECK (channel <> 'AMAZON'   OR (region IS NOT NULL AND external_sku IS NOT NULL)),
  CHECK (channel <> 'EBAY'     OR (external_sku IS NOT NULL AND external_listing_id IS NOT NULL
                                   AND ebay_listing_format IS NOT NULL)),
  CHECK (channel <> 'KAUFLAND' OR external_unit_id IS NOT NULL),
  CHECK (channel <> 'OTTO'     OR external_sku IS NOT NULL),
  CHECK ((channel = 'EBAY') = (ebay_migration_status IS NOT NULL)),
  -- Р-2: запись только в листинги под Inventory API
  CHECK (channel <> 'EBAY' OR ebay_migration_status IN ('NOT_REQUIRED', 'MIGRATED')
         OR (price_write_scope_id IS NULL AND quantity_write_scope_id IS NULL)),
  -- Р-2: аукционы не мигрируются и не управляются
  CHECK (ebay_listing_format IS DISTINCT FROM 'AUCTION' OR ebay_migration_status = 'INELIGIBLE'),
  -- Остатком FBA и аналогов управляет канал
  CHECK (fulfillment = 'MERCHANT' OR quantity_write_scope_id IS NULL),
  CHECK ((status = 'ENDED') = (ended_at IS NOT NULL))
);

-- Идентичность оффера в канале уникальна среди неокончённых сопоставлений; поиск при обнаружении офферов
CREATE UNIQUE INDEX offer_mapping_identity_uq
  ON tenant_data.offer_mapping (tenant_id, channel_account_id, marketplace, channel_offer_key)
  WHERE status <> 'ENDED';
-- Товар -> офферы (карточка товара, отметка CONFLICT)
CREATE INDEX offer_mapping_product_idx ON tenant_data.offer_mapping (tenant_id, product_id);
-- Единица записи -> офферы-члены (показ побочных эффектов, пересчёт)
CREATE INDEX offer_mapping_price_scope_idx
  ON tenant_data.offer_mapping (tenant_id, price_write_scope_id) WHERE price_write_scope_id IS NOT NULL;
CREATE INDEX offer_mapping_quantity_scope_idx
  ON tenant_data.offer_mapping (tenant_id, quantity_write_scope_id) WHERE quantity_write_scope_id IS NOT NULL;
-- Снимок конкурентов (ASIN / EAN на маркетплейсе) -> наши офферы
CREATE INDEX offer_mapping_product_ref_idx
  ON tenant_data.offer_mapping (tenant_id, channel_account_id, marketplace, channel_product_ref)
  WHERE channel_product_ref IS NOT NULL AND status <> 'ENDED';
-- Листинг eBay -> офферы (миграция, бюджет правок)
CREATE INDEX offer_mapping_ebay_listing_idx
  ON tenant_data.offer_mapping (tenant_id, channel_account_id, external_listing_id)
  WHERE channel = 'EBAY';

-- Товар и идентичность неизменяемы: пересопоставление = ENDED + новая строка
CREATE TRIGGER offer_mapping_restrict_update BEFORE UPDATE ON tenant_data.offer_mapping
  FOR EACH ROW EXECUTE FUNCTION security.restrict_update(
    'status', 'ended_at', 'price_write_scope_id', 'quantity_write_scope_id',
    'ebay_migration_status', 'external_offer_id', 'channel_product_ref');

-- Ключ единицы записи = JSON-массив атрибутов оффера в порядке шаблона правила (без channel_account).
CREATE FUNCTION tenant_data.derive_scope_key(p_offer jsonb, p_template text[]) RETURNS text
  LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN bool_and(p_offer ->> a IS NOT NULL)
              THEN to_jsonb(array_agg(p_offer ->> a ORDER BY ord))::text END
    FROM unnest(p_template) WITH ORDINALITY AS t(a, ord)
   WHERE a <> 'channel_account'
$$;

-- ADR-0002: оффер привязывается только к единице, ключ которой выведен из его атрибутов по правилу.
CREATE FUNCTION tenant_data.offer_mapping_scope_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  offer  jsonb := to_jsonb(NEW);
  sid    uuid;
  s      record;
BEGIN
  FOREACH sid IN ARRAY ARRAY[NEW.price_write_scope_id, NEW.quantity_write_scope_id] LOOP
    CONTINUE WHEN sid IS NULL;
    CONTINUE WHEN TG_OP = 'UPDATE' AND sid IN (OLD.price_write_scope_id, OLD.quantity_write_scope_id);

    SELECT ws.scope_key, ws.budget_scope_key, ws.status, c.write_scope_key_template, c.budget_scope_attribute
      INTO s
      FROM tenant_data.write_scope ws
      JOIN platform.channel_capability c
        ON c.capability_id = ws.capability_id AND c.version = ws.capability_version
     WHERE ws.tenant_id = NEW.tenant_id AND ws.write_scope_id = sid;

    IF s.status = 'RETIRED' THEN
      RAISE EXCEPTION 'cannot attach offer to RETIRED write_scope %', sid USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF tenant_data.derive_scope_key(offer, s.write_scope_key_template) IS DISTINCT FROM s.scope_key THEN
      RAISE EXCEPTION 'offer identity does not produce scope_key % (template %)', s.scope_key, s.write_scope_key_template
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF s.budget_scope_attribute IS NOT NULL AND (offer ->> s.budget_scope_attribute) IS DISTINCT FROM s.budget_scope_key THEN
      RAISE EXCEPTION 'offer % does not match budget_scope_key %', s.budget_scope_attribute, s.budget_scope_key
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;

CREATE TRIGGER offer_mapping_scope_guard BEFORE INSERT OR UPDATE OF price_write_scope_id, quantity_write_scope_id
  ON tenant_data.offer_mapping
  FOR EACH ROW EXECUTE FUNCTION tenant_data.offer_mapping_scope_guard();

SELECT security.register_table('tenant_data.offer_mapping', 'TENANT', 'mutable');

-- Товар нельзя архивировать при действующих офферах.
CREATE FUNCTION tenant_data.product_archive_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'ARCHIVED' AND OLD.status <> 'ARCHIVED'
     AND EXISTS (SELECT 1 FROM tenant_data.offer_mapping
                  WHERE tenant_id = NEW.tenant_id AND product_id = NEW.product_id AND status = 'ACTIVE') THEN
    RAISE EXCEPTION 'product % has ACTIVE offers', NEW.product_id USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER product_archive_guard BEFORE UPDATE OF status ON tenant_data.product
  FOR EACH ROW EXECUTE FUNCTION tenant_data.product_archive_guard();

RESET ROLE;
COMMIT;
