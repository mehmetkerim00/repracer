-- 0006_pricing_rules.sql
-- Правила цены: себестоимость, min_price [Р-5, Р-18], ограничения, стратегии, политики расхождений.
-- Все правила — версионированные append-only таблицы: изменение = новая версия, отключение = версия с is_active = false.
--
-- Параллельность: проверки «репрайсинг включён => min_price есть» выполняются при коммите и берут блокировку
-- строки товара. Транзакции, меняющие pricing_mode или min_price, должны работать в READ COMMITTED или
-- SERIALIZABLE; в REPEATABLE READ проверка видит устаревший снимок.

BEGIN;
SET ROLE repracer_owner;

-- ---------------------------------------------------------------------------
-- cost_profile
-- ---------------------------------------------------------------------------
CREATE TABLE tenant_data.cost_profile (
  tenant_id                uuid NOT NULL,
  cost_profile_id          uuid NOT NULL DEFAULT gen_random_uuid(),
  product_id               uuid NOT NULL,
  channel_account_id       uuid,
  marketplace              text,
  version                  int  NOT NULL CHECK (version >= 1),
  valid_from               timestamptz NOT NULL,
  currency                 text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  purchase_cost_minor      bigint NOT NULL DEFAULT 0 CHECK (purchase_cost_minor >= 0),
  inbound_logistics_minor  bigint NOT NULL DEFAULT 0 CHECK (inbound_logistics_minor >= 0),
  packaging_minor          bigint NOT NULL DEFAULT 0 CHECK (packaging_minor >= 0),
  handling_minor           bigint NOT NULL DEFAULT 0 CHECK (handling_minor >= 0),
  outbound_shipping_minor  bigint NOT NULL DEFAULT 0 CHECK (outbound_shipping_minor >= 0),
  other_fixed_minor        bigint NOT NULL DEFAULT 0 CHECK (other_fixed_minor >= 0),
  source                   text NOT NULL CHECK (source IN ('MANUAL', 'IMPORT', 'INBOUND_API')),
  created_by_membership_id uuid,
  created_at               timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, cost_profile_id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES tenant_data.product (tenant_id, product_id),
  FOREIGN KEY (tenant_id, channel_account_id) REFERENCES tenant_data.channel_account (tenant_id, channel_account_id),
  FOREIGN KEY (tenant_id, created_by_membership_id) REFERENCES tenant_data.membership (tenant_id, membership_id),
  CHECK ((channel_account_id IS NULL) = (marketplace IS NULL))
);

-- Действующая себестоимость для товара и области (последняя версия с valid_from <= t); уникальность версии
CREATE UNIQUE INDEX cost_profile_version_uq
  ON tenant_data.cost_profile (tenant_id, product_id, channel_account_id, marketplace, version) NULLS NOT DISTINCT;

CREATE FUNCTION tenant_data.cost_profile_valid_from_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM tenant_data.cost_profile
              WHERE tenant_id = NEW.tenant_id AND product_id = NEW.product_id
                AND channel_account_id IS NOT DISTINCT FROM NEW.channel_account_id
                AND marketplace IS NOT DISTINCT FROM NEW.marketplace
                AND valid_from > NEW.valid_from) THEN
    RAISE EXCEPTION 'cost_profile.valid_from must not precede earlier versions' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER a_cost_profile_version BEFORE INSERT ON tenant_data.cost_profile
  FOR EACH ROW EXECUTE FUNCTION security.enforce_next_version('product_id', 'channel_account_id', 'marketplace');
CREATE TRIGGER b_cost_profile_valid_from BEFORE INSERT ON tenant_data.cost_profile
  FOR EACH ROW EXECUTE FUNCTION tenant_data.cost_profile_valid_from_guard();

SELECT security.register_table('tenant_data.cost_profile', 'TENANT', 'append_only');

-- ---------------------------------------------------------------------------
-- min_price — абсолютный пол. Только уровни PRODUCT и WRITE_SCOPE [Р-18]; уровня тенанта нет по построению.
-- ---------------------------------------------------------------------------
CREATE TABLE tenant_data.min_price (
  tenant_id                uuid NOT NULL,
  min_price_id             uuid NOT NULL DEFAULT gen_random_uuid(),
  scope_type               text NOT NULL CHECK (scope_type IN ('PRODUCT', 'WRITE_SCOPE')),
  product_id               uuid,
  write_scope_id           uuid,
  write_scope_field        text NOT NULL DEFAULT 'PRICE' CHECK (write_scope_field = 'PRICE'),
  currency                 text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  price_basis              text NOT NULL CHECK (price_basis IN ('GROSS', 'NET')),
  amount_minor             bigint NOT NULL CHECK (amount_minor > 0),
  is_active                boolean NOT NULL DEFAULT true,
  version                  int NOT NULL CHECK (version >= 1),
  reason                   text,
  created_by_membership_id uuid NOT NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, min_price_id),
  CHECK ((scope_type = 'PRODUCT') = (product_id IS NOT NULL)),
  CHECK ((scope_type = 'WRITE_SCOPE') = (write_scope_id IS NOT NULL)),
  FOREIGN KEY (tenant_id, product_id) REFERENCES tenant_data.product (tenant_id, product_id),
  -- Пол уровня единицы — в валюте и базе этой единицы и только для единицы цены
  FOREIGN KEY (tenant_id, write_scope_id, write_scope_field, currency, price_basis)
    REFERENCES tenant_data.write_scope (tenant_id, write_scope_id, field, currency, price_basis),
  FOREIGN KEY (tenant_id, created_by_membership_id) REFERENCES tenant_data.membership (tenant_id, membership_id)
);

-- Последняя версия пола товара в валюте/базе единицы (effective_min_price)
CREATE UNIQUE INDEX min_price_product_version_uq
  ON tenant_data.min_price (tenant_id, product_id, currency, price_basis, version) WHERE scope_type = 'PRODUCT';
-- Последняя версия пола единицы записи (effective_min_price)
CREATE UNIQUE INDEX min_price_scope_version_uq
  ON tenant_data.min_price (tenant_id, write_scope_id, version) WHERE scope_type = 'WRITE_SCOPE';

CREATE TRIGGER a_min_price_version BEFORE INSERT ON tenant_data.min_price
  FOR EACH ROW EXECUTE FUNCTION security.enforce_next_version('scope_type', 'product_id', 'write_scope_id', 'currency', 'price_basis');

SELECT security.register_table('tenant_data.min_price', 'TENANT', 'append_only');

-- Действующий абсолютный пол единицы цены = максимум активных последних версий уровней товара и единицы [Р-5].
-- NULL — пол не разрешим.
CREATE FUNCTION tenant_data.effective_min_price(p_tenant_id uuid, p_write_scope_id uuid) RETURNS bigint
  LANGUAGE sql STABLE AS $$
  WITH s AS (
    SELECT product_id, currency, price_basis
      FROM tenant_data.write_scope
     WHERE tenant_id = p_tenant_id AND write_scope_id = p_write_scope_id AND field = 'PRICE'
  ), scope_level AS (
    SELECT m.is_active, m.amount_minor
      FROM tenant_data.min_price m
     WHERE m.tenant_id = p_tenant_id AND m.scope_type = 'WRITE_SCOPE' AND m.write_scope_id = p_write_scope_id
     ORDER BY m.version DESC LIMIT 1
  ), product_level AS (
    SELECT m.is_active, m.amount_minor
      FROM tenant_data.min_price m JOIN s
        ON m.product_id = s.product_id AND m.currency = s.currency AND m.price_basis = s.price_basis
     WHERE m.tenant_id = p_tenant_id AND m.scope_type = 'PRODUCT'
     ORDER BY m.version DESC LIMIT 1
  )
  SELECT max(amount_minor) FROM (
    SELECT amount_minor FROM scope_level WHERE is_active
    UNION ALL
    SELECT amount_minor FROM product_level WHERE is_active
  ) floors
$$;

-- Р-5, Р-12, Р-18: единица в режиме ENGINE или KAUFLAND_SMART_PRICING обязана иметь разрешимый min_price.
CREATE FUNCTION tenant_data.assert_price_scope_has_min_price(p_tenant_id uuid, p_write_scope_id uuid) RETURNS void
  LANGUAGE plpgsql AS $$
DECLARE
  s record;
BEGIN
  SELECT pricing_mode, status, product_id INTO s
    FROM tenant_data.write_scope
   WHERE tenant_id = p_tenant_id AND write_scope_id = p_write_scope_id AND field = 'PRICE';

  IF s.pricing_mode IN ('ENGINE', 'KAUFLAND_SMART_PRICING') AND s.status <> 'RETIRED' THEN
    -- Сериализует включение репрайсинга и изменения min_price по одному товару
    PERFORM 1 FROM tenant_data.product WHERE tenant_id = p_tenant_id AND product_id = s.product_id FOR UPDATE;
    IF tenant_data.effective_min_price(p_tenant_id, p_write_scope_id) IS NULL THEN
      RAISE EXCEPTION 'write_scope % has pricing_mode % but no active min_price at PRODUCT or WRITE_SCOPE level',
        p_write_scope_id, s.pricing_mode USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
END $$;

CREATE FUNCTION tenant_data.write_scope_min_price_check() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.field = 'PRICE' THEN
    PERFORM tenant_data.assert_price_scope_has_min_price(NEW.tenant_id, NEW.write_scope_id);
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER write_scope_requires_min_price
  AFTER INSERT OR UPDATE OF pricing_mode, status ON tenant_data.write_scope
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION tenant_data.write_scope_min_price_check();

CREATE FUNCTION tenant_data.min_price_change_check() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  sid uuid;
BEGIN
  IF NEW.scope_type = 'WRITE_SCOPE' THEN
    PERFORM tenant_data.assert_price_scope_has_min_price(NEW.tenant_id, NEW.write_scope_id);
  ELSE
    FOR sid IN
      SELECT write_scope_id FROM tenant_data.write_scope
       WHERE tenant_id = NEW.tenant_id AND product_id = NEW.product_id AND field = 'PRICE' AND status <> 'RETIRED'
         AND currency = NEW.currency AND price_basis = NEW.price_basis
    LOOP
      PERFORM tenant_data.assert_price_scope_has_min_price(NEW.tenant_id, sid);
    END LOOP;
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER min_price_keeps_enabled_scopes_valid AFTER INSERT ON tenant_data.min_price
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION tenant_data.min_price_change_check();

-- ---------------------------------------------------------------------------
-- guardrail — относительные ограничения (маржа, потолок, шаг, частота). Абсолютного пола здесь нет [Р-18].
-- ---------------------------------------------------------------------------
CREATE TABLE tenant_data.guardrail (
  tenant_id                uuid NOT NULL,
  guardrail_id             uuid NOT NULL DEFAULT gen_random_uuid(),
  scope_type               text NOT NULL CHECK (scope_type IN ('TENANT', 'CHANNEL_ACCOUNT', 'PRODUCT', 'WRITE_SCOPE')),
  channel_account_id       uuid,
  product_id               uuid,
  write_scope_id           uuid,
  write_scope_field        text NOT NULL DEFAULT 'PRICE' CHECK (write_scope_field = 'PRICE'),
  min_margin_bp            int CHECK (min_margin_bp >= 0),
  max_price_minor          bigint CHECK (max_price_minor > 0),
  currency                 text CHECK (currency ~ '^[A-Z]{3}$'),
  price_basis              text CHECK (price_basis IN ('GROSS', 'NET')),
  max_step_change_bp       int CHECK (max_step_change_bp > 0),
  max_changes_per_hour     int CHECK (max_changes_per_hour > 0),
  on_violation             text NOT NULL DEFAULT 'HOLD' CHECK (on_violation IN ('CLAMP', 'REJECT', 'HOLD')),
  is_active                boolean NOT NULL DEFAULT true,
  version                  int NOT NULL CHECK (version >= 1),
  created_by_membership_id uuid NOT NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, guardrail_id),
  FOREIGN KEY (tenant_id, channel_account_id) REFERENCES tenant_data.channel_account (tenant_id, channel_account_id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES tenant_data.product (tenant_id, product_id),
  FOREIGN KEY (tenant_id, write_scope_id, write_scope_field) REFERENCES tenant_data.write_scope (tenant_id, write_scope_id, field),
  FOREIGN KEY (tenant_id, created_by_membership_id) REFERENCES tenant_data.membership (tenant_id, membership_id),
  CHECK ((scope_type = 'CHANNEL_ACCOUNT') = (channel_account_id IS NOT NULL)),
  CHECK ((scope_type = 'PRODUCT') = (product_id IS NOT NULL)),
  CHECK ((scope_type = 'WRITE_SCOPE') = (write_scope_id IS NOT NULL)),
  CHECK ((max_price_minor IS NULL) = (currency IS NULL AND price_basis IS NULL)),
  CHECK (NOT is_active OR num_nonnulls(min_margin_bp, max_price_minor, max_step_change_bp, max_changes_per_hour) >= 1)
);

-- Price Gate: последние версии ограничений по всем уровням, применимым к единице
CREATE UNIQUE INDEX guardrail_version_uq
  ON tenant_data.guardrail (tenant_id, scope_type, channel_account_id, product_id, write_scope_id, version) NULLS NOT DISTINCT;

CREATE TRIGGER a_guardrail_version BEFORE INSERT ON tenant_data.guardrail
  FOR EACH ROW EXECUTE FUNCTION security.enforce_next_version('scope_type', 'channel_account_id', 'product_id', 'write_scope_id');

SELECT security.register_table('tenant_data.guardrail', 'TENANT', 'append_only');

-- ---------------------------------------------------------------------------
-- pricing_strategy — только правиловые типы; ML-типов нет [Р-10]
-- ---------------------------------------------------------------------------
CREATE TABLE tenant_data.pricing_strategy (
  tenant_id                uuid NOT NULL REFERENCES tenant_data.tenant (tenant_id),
  pricing_strategy_id      uuid NOT NULL,
  version                  int  NOT NULL CHECK (version >= 1),
  name                     text NOT NULL,
  type                     text NOT NULL CHECK (type IN ('FIXED', 'MATCH_BUYBOX', 'BEAT_LOWEST', 'TARGET_MARGIN', 'POSITION')),
  params                   jsonb NOT NULL CHECK (jsonb_typeof(params) = 'object'),
  triggers                 text[] NOT NULL
                           CHECK (triggers <@ ARRAY['COMPETITOR_CHANGE', 'COST_CHANGE', 'STOCK_CHANGE', 'SCHEDULE']),
  status                   text NOT NULL CHECK (status IN ('DRAFT', 'ACTIVE', 'ARCHIVED')),
  created_by_membership_id uuid NOT NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, pricing_strategy_id, version),
  FOREIGN KEY (tenant_id, created_by_membership_id) REFERENCES tenant_data.membership (tenant_id, membership_id)
);

CREATE TRIGGER a_pricing_strategy_version BEFORE INSERT ON tenant_data.pricing_strategy
  FOR EACH ROW EXECUTE FUNCTION security.enforce_next_version('pricing_strategy_id');

SELECT security.register_table('tenant_data.pricing_strategy', 'TENANT', 'append_only');

ALTER TABLE tenant_data.write_scope
  ADD CONSTRAINT write_scope_strategy_fk
  FOREIGN KEY (tenant_id, pricing_strategy_id, pricing_strategy_version)
  REFERENCES tenant_data.pricing_strategy (tenant_id, pricing_strategy_id, version);

-- ---------------------------------------------------------------------------
-- divergence_policy
-- ---------------------------------------------------------------------------
CREATE TABLE tenant_data.divergence_policy (
  tenant_id                uuid NOT NULL,
  divergence_policy_id     uuid NOT NULL DEFAULT gen_random_uuid(),
  scope_type               text NOT NULL CHECK (scope_type IN ('TENANT', 'CHANNEL_ACCOUNT', 'PRODUCT', 'WRITE_SCOPE')),
  channel_account_id       uuid,
  product_id               uuid,
  write_scope_id           uuid,
  field                    text NOT NULL CHECK (field IN ('PRICE', 'QUANTITY')),
  on_external_change       text NOT NULL CHECK (on_external_change IN ('REASSERT', 'YIELD', 'ASK_HUMAN')),
  yield_pause              interval CHECK (yield_pause > interval '0'),
  on_not_applied           text NOT NULL DEFAULT 'RETRY' CHECK (on_not_applied IN ('RETRY', 'ASK_HUMAN')),
  max_reasserts_per_period int CHECK (max_reasserts_per_period > 0),
  reassert_period          interval CHECK (reassert_period > interval '0'),
  grace_override           interval CHECK (grace_override > interval '0'),
  is_active                boolean NOT NULL DEFAULT true,
  version                  int NOT NULL CHECK (version >= 1),
  created_by_membership_id uuid NOT NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, divergence_policy_id),
  FOREIGN KEY (tenant_id, channel_account_id) REFERENCES tenant_data.channel_account (tenant_id, channel_account_id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES tenant_data.product (tenant_id, product_id),
  FOREIGN KEY (tenant_id, write_scope_id, field) REFERENCES tenant_data.write_scope (tenant_id, write_scope_id, field),
  FOREIGN KEY (tenant_id, created_by_membership_id) REFERENCES tenant_data.membership (tenant_id, membership_id),
  CHECK ((scope_type = 'CHANNEL_ACCOUNT') = (channel_account_id IS NOT NULL)),
  CHECK ((scope_type = 'PRODUCT') = (product_id IS NOT NULL)),
  CHECK ((scope_type = 'WRITE_SCOPE') = (write_scope_id IS NOT NULL)),
  CHECK (yield_pause IS NULL OR on_external_change = 'YIELD'),
  CHECK ((max_reasserts_per_period IS NULL) = (reassert_period IS NULL))
);

-- Выбор самой конкретной действующей политики для единицы и поля
CREATE UNIQUE INDEX divergence_policy_version_uq
  ON tenant_data.divergence_policy (tenant_id, field, scope_type, channel_account_id, product_id, write_scope_id, version)
  NULLS NOT DISTINCT;

CREATE TRIGGER a_divergence_policy_version BEFORE INSERT ON tenant_data.divergence_policy
  FOR EACH ROW EXECUTE FUNCTION security.enforce_next_version('field', 'scope_type', 'channel_account_id', 'product_id', 'write_scope_id');

SELECT security.register_table('tenant_data.divergence_policy', 'TENANT', 'append_only');

RESET ROLE;
COMMIT;
