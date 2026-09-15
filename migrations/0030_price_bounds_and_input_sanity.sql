-- 0030_price_bounds_and_input_sanity.sql
-- Р-43: max_price обязателен наравне с min_price; уровни — товар и единица записи (расширяет Р-18).
-- Р-44: Gate проверяет обе границы; отклонённое по верхней границе хранится как по нижней (REJECTED_BY_GATE),
--       с причиной; выход за абсолютную границу не округляется до границы; тройная проверка: Gate, вставка решения,
--       создание и отправка записи. Границу нельзя вычислить — решение REJECTED/BOUND_UNRESOLVABLE, запись невозможна.
-- Р-42: забракованные снимки с причиной; остановка цен канала; история конкурентов за 30 дней и окно движений
--       в PostgreSQL — решение читает только PostgreSQL [Р-22].

BEGIN;
SET ROLE repracer_owner;

-- ---------------------------------------------------------------------------
-- 1. max_price — абсолютный потолок. Зеркало min_price: только уровни PRODUCT и WRITE_SCOPE
-- ---------------------------------------------------------------------------
CREATE TABLE tenant_data.max_price (
  tenant_id                uuid NOT NULL,
  max_price_id             uuid NOT NULL DEFAULT gen_random_uuid(),
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
  PRIMARY KEY (tenant_id, max_price_id),
  CHECK ((scope_type = 'PRODUCT') = (product_id IS NOT NULL)),
  CHECK ((scope_type = 'WRITE_SCOPE') = (write_scope_id IS NOT NULL)),
  CONSTRAINT max_price_release_1_0_currency CHECK (currency = 'EUR'),
  FOREIGN KEY (tenant_id, product_id) REFERENCES tenant_data.product (tenant_id, product_id),
  FOREIGN KEY (tenant_id, write_scope_id, write_scope_field, currency, price_basis)
    REFERENCES tenant_data.write_scope (tenant_id, write_scope_id, field, currency, price_basis),
  FOREIGN KEY (tenant_id, created_by_membership_id) REFERENCES tenant_data.membership (tenant_id, membership_id)
);

-- Последняя версия потолка товара в валюте/базе единицы (effective_max_price)
CREATE UNIQUE INDEX max_price_product_version_uq
  ON tenant_data.max_price (tenant_id, product_id, currency, price_basis, version) WHERE scope_type = 'PRODUCT';
-- Последняя версия потолка единицы записи (effective_max_price)
CREATE UNIQUE INDEX max_price_scope_version_uq
  ON tenant_data.max_price (tenant_id, write_scope_id, version) WHERE scope_type = 'WRITE_SCOPE';

CREATE TRIGGER a_max_price_version BEFORE INSERT ON tenant_data.max_price
  FOR EACH ROW EXECUTE FUNCTION security.enforce_next_version('scope_type', 'product_id', 'write_scope_id', 'currency', 'price_basis');

SELECT security.register_table('tenant_data.max_price', 'TENANT', 'append_only');
SELECT security.grant_retention('tenant_data.max_price');
INSERT INTO maintenance.retention_policy (table_name, method) VALUES ('tenant_data.max_price', 'TENANT_CLOSURE_ONLY');

-- Действующий потолок единицы цены = минимум активных последних версий уровней товара и единицы (самый строгий).
-- NULL — потолок не разрешим.
CREATE FUNCTION tenant_data.effective_max_price(p_tenant_id uuid, p_write_scope_id uuid) RETURNS bigint
  LANGUAGE sql STABLE AS $$
  WITH s AS (
    SELECT product_id, currency, price_basis
      FROM tenant_data.write_scope
     WHERE tenant_id = p_tenant_id AND write_scope_id = p_write_scope_id AND field = 'PRICE'
  ), scope_level AS (
    SELECT m.is_active, m.amount_minor
      FROM tenant_data.max_price m
     WHERE m.tenant_id = p_tenant_id AND m.scope_type = 'WRITE_SCOPE' AND m.write_scope_id = p_write_scope_id
     ORDER BY m.version DESC LIMIT 1
  ), product_level AS (
    SELECT m.is_active, m.amount_minor
      FROM tenant_data.max_price m JOIN s
        ON m.product_id = s.product_id AND m.currency = s.currency AND m.price_basis = s.price_basis
     WHERE m.tenant_id = p_tenant_id AND m.scope_type = 'PRODUCT'
     ORDER BY m.version DESC LIMIT 1
  )
  SELECT min(amount_minor) FROM (
    SELECT amount_minor FROM scope_level WHERE is_active
    UNION ALL
    SELECT amount_minor FROM product_level WHERE is_active
  ) ceilings
$$;

-- Р-5, Р-12, Р-18, Р-43: ENGINE требует разрешимых min_price и max_price и min_price <= max_price;
-- Smart Pricing требует только min_price (наш движок выключен, max_price не применяется).
CREATE OR REPLACE FUNCTION tenant_data.assert_price_scope_has_min_price(p_tenant_id uuid, p_write_scope_id uuid) RETURNS void
  LANGUAGE plpgsql AS $$
DECLARE
  s            record;
  floor_minor  bigint;
  ceiling_minor bigint;
BEGIN
  SELECT pricing_mode, status, product_id INTO s
    FROM tenant_data.write_scope
   WHERE tenant_id = p_tenant_id AND write_scope_id = p_write_scope_id AND field = 'PRICE';

  IF s.pricing_mode IN ('ENGINE', 'KAUFLAND_SMART_PRICING') AND s.status <> 'RETIRED' THEN
    -- Сериализует включение репрайсинга и изменения границ по одному товару
    PERFORM 1 FROM tenant_data.product WHERE tenant_id = p_tenant_id AND product_id = s.product_id FOR UPDATE;
    floor_minor := tenant_data.effective_min_price(p_tenant_id, p_write_scope_id);
    IF floor_minor IS NULL THEN
      RAISE EXCEPTION 'write_scope % has pricing_mode % but no active min_price at PRODUCT or WRITE_SCOPE level',
        p_write_scope_id, s.pricing_mode USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF s.pricing_mode = 'ENGINE' THEN
      ceiling_minor := tenant_data.effective_max_price(p_tenant_id, p_write_scope_id);
      IF ceiling_minor IS NULL THEN
        RAISE EXCEPTION 'write_scope % has pricing_mode ENGINE but no active max_price at PRODUCT or WRITE_SCOPE level (Р-43)',
          p_write_scope_id USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF floor_minor > ceiling_minor THEN
        RAISE EXCEPTION 'write_scope %: min_price % is above max_price % (Р-43)', p_write_scope_id, floor_minor, ceiling_minor
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
    END IF;
  END IF;
END $$;

-- Новая версия потолка не может выключить или перевернуть границы у включённой единицы (функция общая с min_price)
CREATE CONSTRAINT TRIGGER max_price_keeps_enabled_scopes_valid AFTER INSERT ON tenant_data.max_price
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION tenant_data.min_price_change_check();

-- Потолок цены — только max_price; guardrail — относительные ограничения
ALTER TABLE tenant_data.guardrail ADD CONSTRAINT guardrail_ceiling_moved_to_max_price CHECK (max_price_minor IS NULL);

-- ---------------------------------------------------------------------------
-- 2. Остановка цен канала [Р-42] — нужна до ограничений решения и записи
-- ---------------------------------------------------------------------------
CREATE TABLE channel_data.pricing_halt (
  tenant_id                 uuid NOT NULL,
  pricing_halt_id           uuid NOT NULL DEFAULT gen_random_uuid(),
  channel_account_id        uuid NOT NULL,
  channel                   text NOT NULL,
  -- NULL — все витрины аккаунта
  marketplace               text,
  reason_code               text NOT NULL CHECK (reason_code IN ('CHANNEL_MASS_SHIFT', 'MANUAL')),
  -- Снимок, на котором сработала остановка (без FK: снимки хранятся меньше, чем остановки)
  rejected_snapshot_id      uuid,
  details                   jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  halted_at                 timestamptz NOT NULL DEFAULT now(),
  released_at               timestamptz,
  released_by_membership_id uuid,
  release_note              text CHECK (length(release_note) BETWEEN 10 AND 2000),
  PRIMARY KEY (tenant_id, pricing_halt_id),
  FOREIGN KEY (tenant_id, channel_account_id, channel)
    REFERENCES tenant_data.channel_account (tenant_id, channel_account_id, channel),
  FOREIGN KEY (tenant_id, released_by_membership_id) REFERENCES tenant_data.membership (tenant_id, membership_id),
  -- Снять остановку может только человек: автоматического снятия нет
  CHECK ((released_at IS NULL) = (released_by_membership_id IS NULL)),
  CHECK ((released_at IS NULL) = (release_note IS NULL)),
  CHECK (released_at IS NULL OR released_at >= halted_at)
);

-- Одна действующая остановка на аккаунт и витрину; поиск действующих остановок при решении и записи цены
CREATE UNIQUE INDEX pricing_halt_active_uq
  ON channel_data.pricing_halt (tenant_id, channel_account_id, coalesce(marketplace, '*')) WHERE released_at IS NULL;

CREATE FUNCTION channel_data.pricing_halt_release_once() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.released_at IS NOT NULL THEN
    RAISE EXCEPTION 'pricing halt % is already released', OLD.pricing_halt_id USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER a_pricing_halt_restrict_update BEFORE UPDATE ON channel_data.pricing_halt
  FOR EACH ROW EXECUTE FUNCTION security.restrict_update('released_at', 'released_by_membership_id', 'release_note');
CREATE TRIGGER b_pricing_halt_release_once BEFORE UPDATE ON channel_data.pricing_halt
  FOR EACH ROW EXECUTE FUNCTION channel_data.pricing_halt_release_once();

SELECT security.register_table('channel_data.pricing_halt', 'CHANNEL', 'mutable');
SELECT security.grant_retention('channel_data.pricing_halt');
-- Действующие остановки (released_at IS NULL) не удаляются по сроку
INSERT INTO maintenance.retention_policy (table_name, method, anchor_column, retention, safety_margin, drop_order)
VALUES ('channel_data.pricing_halt', 'DELETE_ROWS', 'released_at', '18 months', '14 days', 60);

-- Остановлены ли цены для единицы записи: на весь аккаунт или на витрину одного из её офферов
CREATE FUNCTION channel_data.pricing_halted(p_tenant_id uuid, p_write_scope_id uuid) RETURNS boolean
  LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1
      FROM tenant_data.write_scope s
      JOIN channel_data.pricing_halt h
        ON h.tenant_id = s.tenant_id AND h.channel_account_id = s.channel_account_id AND h.released_at IS NULL
     WHERE s.tenant_id = p_tenant_id AND s.write_scope_id = p_write_scope_id
       AND (h.marketplace IS NULL OR EXISTS (
             SELECT 1 FROM tenant_data.offer_mapping m
              WHERE m.tenant_id = s.tenant_id AND m.price_write_scope_id = s.write_scope_id AND m.marketplace = h.marketplace))
  )
$$;

-- ---------------------------------------------------------------------------
-- 3. price_decision: причина отклонения, обе границы обязательны, без округления до границы [Р-44]
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  con text;
BEGIN
  FOR con IN SELECT conname FROM pg_constraint
              WHERE conrelid = 'channel_data.price_decision'::regclass AND contype = 'c'
                AND pg_get_constraintdef(oid) LIKE '%cardinality(min_price_ids)%'
  LOOP
    EXECUTE format('ALTER TABLE channel_data.price_decision DROP CONSTRAINT %I', con);
  END LOOP;
END $$;

ALTER TABLE channel_data.price_decision
  ADD COLUMN rejection_reason text CONSTRAINT price_decision_rejection_reason_known CHECK (rejection_reason IN (
    'BELOW_MIN_PRICE', 'BELOW_MARGIN_FLOOR', 'ABOVE_MAX_PRICE', 'BOUND_UNRESOLVABLE', 'STEP_LIMIT', 'CHANGE_RATE_LIMIT',
    'INTENT_EXPIRED', 'INTENT_INVALID', 'SCOPE_NOT_ACTIVE', 'CHANNEL_HALTED', 'INTERNAL_BOUND_VIOLATION')),
  ADD COLUMN max_price_ids uuid[] NOT NULL DEFAULT '{}',
  ALTER COLUMN effective_floor_minor DROP NOT NULL;

ALTER TABLE channel_data.price_decision
  ADD CONSTRAINT price_decision_rejection_reason_iff CHECK ((outcome IN ('REJECTED', 'HELD')) = (rejection_reason IS NOT NULL)),
  ADD CONSTRAINT price_decision_held_reasons CHECK (outcome <> 'HELD' OR rejection_reason IN ('STEP_LIMIT', 'CHANGE_RATE_LIMIT', 'SCOPE_NOT_ACTIVE')),
  -- Р-43: обе границы и их источники есть у каждого решения, кроме «границу нельзя вычислить»
  ADD CONSTRAINT price_decision_bounds_present CHECK (rejection_reason IS NOT DISTINCT FROM 'BOUND_UNRESOLVABLE' OR (
    effective_floor_minor IS NOT NULL AND effective_ceiling_minor IS NOT NULL
    AND cardinality(min_price_ids) >= 1 AND cardinality(max_price_ids) >= 1)),
  ADD CONSTRAINT price_decision_unresolvable_is_rejected CHECK (rejection_reason IS DISTINCT FROM 'BOUND_UNRESOLVABLE' OR outcome = 'REJECTED'),
  ADD CONSTRAINT price_decision_floor_not_above_ceiling CHECK (
    effective_floor_minor IS NULL OR effective_ceiling_minor IS NULL OR effective_floor_minor <= effective_ceiling_minor),
  -- Р-44: выход за абсолютную границу отклоняется, а не округляется до неё
  ADD CONSTRAINT price_decision_no_bound_clamp CHECK (outcome NOT IN ('CLAMPED_FLOOR', 'CLAMPED_CEILING'));

-- Проверка 2 из 3 [Р-44]: решение не утверждает цену вне действующих границ; причина отклонения по границе правдива;
-- при остановке канала одобрение невозможно.
CREATE OR REPLACE FUNCTION channel_data.price_decision_floor_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  floor_minor   bigint;
  ceiling_minor bigint;
  proposed      bigint;
BEGIN
  IF NEW.rejection_reason = 'BOUND_UNRESOLVABLE' THEN
    RETURN NEW;
  END IF;
  floor_minor := tenant_data.effective_min_price(NEW.tenant_id, NEW.write_scope_id);
  ceiling_minor := tenant_data.effective_max_price(NEW.tenant_id, NEW.write_scope_id);
  IF floor_minor IS NULL OR NEW.effective_floor_minor < floor_minor THEN
    RAISE EXCEPTION 'decision floor % is below effective min_price %', NEW.effective_floor_minor, floor_minor
      USING ERRCODE = 'check_violation';
  END IF;
  IF ceiling_minor IS NULL OR NEW.effective_ceiling_minor > ceiling_minor THEN
    RAISE EXCEPTION 'decision ceiling % is above effective max_price % (Р-43)', NEW.effective_ceiling_minor, ceiling_minor
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.rejection_reason IN ('BELOW_MIN_PRICE', 'BELOW_MARGIN_FLOOR', 'ABOVE_MAX_PRICE') THEN
    SELECT proposed_amount_minor INTO proposed FROM channel_data.price_intent
     WHERE tenant_id = NEW.tenant_id AND created_at = NEW.intent_created_at AND price_intent_id = NEW.price_intent_id;
    IF (NEW.rejection_reason = 'BELOW_MIN_PRICE' AND proposed >= floor_minor)
       OR (NEW.rejection_reason = 'BELOW_MARGIN_FLOOR' AND proposed >= NEW.effective_floor_minor)
       OR (NEW.rejection_reason = 'ABOVE_MAX_PRICE' AND proposed <= NEW.effective_ceiling_minor) THEN
      RAISE EXCEPTION 'rejection reason % contradicts proposed price %', NEW.rejection_reason, proposed
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW.outcome = 'APPROVED' AND channel_data.pricing_halted(NEW.tenant_id, NEW.write_scope_id) THEN
    RAISE EXCEPTION 'pricing is halted for the channel of write_scope % (Р-42)', NEW.write_scope_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

-- Ядро intent хранит причину отклонения: отклонённые по любой границе — одинаково REJECTED_BY_GATE [Р-44]
ALTER TABLE tenant_data.price_intent_core
  ADD COLUMN rejection_reason text,
  ALTER COLUMN effective_floor_minor DROP NOT NULL;
ALTER TABLE tenant_data.price_intent_core
  ADD CONSTRAINT price_intent_core_bounds_present CHECK (
    rejection_reason IS NOT DISTINCT FROM 'BOUND_UNRESOLVABLE' OR effective_floor_minor IS NOT NULL);

CREATE OR REPLACE FUNCTION channel_data.price_decision_record_core() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.intent_class <> 'NO_OP' THEN
    INSERT INTO tenant_data.price_intent_core
      (tenant_id, price_intent_id, intent_created_at, write_scope_id, pricing_strategy_id, pricing_strategy_version,
       trigger_type, rule_code, proposed_amount_minor, currency, price_basis, intent_class, price_decision_id,
       decision_outcome, final_amount_minor, effective_floor_minor, effective_ceiling_minor, violations, decided_at,
       rejection_reason)
    SELECT i.tenant_id, i.price_intent_id, i.created_at, i.write_scope_id, i.pricing_strategy_id, i.pricing_strategy_version,
           i.trigger_type, i.rule_code, i.proposed_amount_minor, i.currency, i.price_basis, NEW.intent_class,
           NEW.price_decision_id, NEW.outcome, NEW.final_amount_minor, NEW.effective_floor_minor,
           NEW.effective_ceiling_minor, NEW.violations, NEW.decided_at, NEW.rejection_reason
      FROM channel_data.price_intent i
     WHERE i.tenant_id = NEW.tenant_id AND i.created_at = NEW.intent_created_at
       AND i.price_intent_id = NEW.price_intent_id;
  END IF;
  RETURN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- 4. Проверка 3 из 3 [Р-44]: запись цены в пределах max_price при создании и при отправке; не при остановке канала.
--    Пол проверяется существующими триггерами 0008.
-- ---------------------------------------------------------------------------
CREATE FUNCTION tenant_data.channel_write_ceiling_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  ceiling_minor bigint;
BEGIN
  IF NEW.field <> 'PRICE' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NOT (NEW.status = 'DISPATCHED' AND OLD.status IS DISTINCT FROM 'DISPATCHED') THEN
    RETURN NEW;
  END IF;
  ceiling_minor := tenant_data.effective_max_price(NEW.tenant_id, NEW.write_scope_id);
  IF ceiling_minor IS NULL OR NEW.amount_minor > ceiling_minor THEN
    RAISE EXCEPTION 'value % is above effective max_price % (%)', NEW.amount_minor, ceiling_minor,
      CASE TG_OP WHEN 'INSERT' THEN 'at creation' ELSE 'at dispatch' END USING ERRCODE = 'check_violation';
  END IF;
  IF channel_data.pricing_halted(NEW.tenant_id, NEW.write_scope_id) THEN
    RAISE EXCEPTION 'pricing is halted for the channel of write_scope % (Р-42)', NEW.write_scope_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER ba_channel_write_ceiling_insert BEFORE INSERT ON tenant_data.channel_write
  FOR EACH ROW EXECUTE FUNCTION tenant_data.channel_write_ceiling_guard();
CREATE TRIGGER ba_channel_write_ceiling_dispatch BEFORE UPDATE OF status ON tenant_data.channel_write
  FOR EACH ROW EXECUTE FUNCTION tenant_data.channel_write_ceiling_guard();

-- ---------------------------------------------------------------------------
-- 5. Забракованные снимки [Р-42]: причина, класс тревоги, значения для разбора
-- ---------------------------------------------------------------------------
CREATE TABLE channel_data.rejected_competitor_snapshot (
  tenant_id              uuid NOT NULL,
  rejected_snapshot_id   uuid NOT NULL DEFAULT gen_random_uuid(),
  channel_account_id     uuid NOT NULL,
  channel                text NOT NULL,
  marketplace            text NOT NULL,
  channel_product_ref    text NOT NULL,
  condition              text NOT NULL,
  source                 text NOT NULL CHECK (source IN ('AMAZON_ANY_OFFER_CHANGED', 'AMAZON_COMPETITIVE_SUMMARY',
                                                         'KAUFLAND_BUY_BOX_CHANGED', 'KAUFLAND_BUYBOX', 'KAUFLAND_COMPETITORS_COMPARER')),
  source_event_id        text,
  -- Сырой снимок в ClickHouse
  competitor_snapshot_id uuid,
  observed_at            timestamptz NOT NULL,
  received_at            timestamptz NOT NULL,
  verdict                text NOT NULL CHECK (verdict IN ('REJECT', 'HALT_CHANNEL')),
  reason_code            text NOT NULL CHECK (reason_code IN (
    'INVALID_AMOUNT', 'CURRENCY_MISMATCH', 'INCONSISTENT_SNAPSHOT', 'SNAPSHOT_FROM_FUTURE', 'SNAPSHOT_TOO_OLD', 'OUT_OF_ORDER',
    'CHANNEL_HALTED', 'CHANNEL_MASS_SHIFT', 'UNIT_SCALE_X100', 'UNIT_SCALE_X0_01', 'SELF_OFFER_MISMATCH',
    'DEVIATION_FROM_OWN_PRICE', 'OUTSIDE_HISTORY_BAND')),
  alarm_class            text NOT NULL CHECK (alarm_class IN ('STRUCTURE', 'FRESHNESS', 'UNIT_SCALE', 'OUTLIER', 'CHANNEL_SHIFT', 'CHANNEL_HALTED')),
  details                jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  ruleset_version        text NOT NULL CHECK (ruleset_version ~ '^[a-z0-9.-]{1,32}$'),
  created_at             timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, rejected_snapshot_id),
  FOREIGN KEY (tenant_id, channel_account_id, channel)
    REFERENCES tenant_data.channel_account (tenant_id, channel_account_id, channel),
  CHECK ((verdict = 'HALT_CHANNEL') = (reason_code = 'CHANNEL_MASS_SHIFT')),
  CHECK ((reason_code IN ('UNIT_SCALE_X100', 'UNIT_SCALE_X0_01')) = (alarm_class = 'UNIT_SCALE')),
  CHECK ((reason_code = 'CHANNEL_MASS_SHIFT') = (alarm_class = 'CHANNEL_SHIFT')),
  CHECK ((source LIKE 'AMAZON\_%') = (channel = 'AMAZON')),
  CHECK ((source LIKE 'KAUFLAND\_%') = (channel = 'KAUFLAND'))
);

-- Разбор инцидента: забракованные снимки аккаунта за последние часы
CREATE INDEX rejected_competitor_snapshot_account_idx
  ON channel_data.rejected_competitor_snapshot (tenant_id, channel_account_id, created_at DESC);
-- Удаление по сроку
CREATE INDEX rejected_competitor_snapshot_retention_idx ON channel_data.rejected_competitor_snapshot (created_at);

SELECT security.register_table('channel_data.rejected_competitor_snapshot', 'CHANNEL', 'append_only');
SELECT security.grant_retention('channel_data.rejected_competitor_snapshot');
INSERT INTO maintenance.retention_policy (table_name, method, anchor_column, retention, safety_margin, drop_order)
VALUES ('channel_data.rejected_competitor_snapshot', 'DELETE_ROWS', 'created_at', '45 days', '0 days', 60);

-- ---------------------------------------------------------------------------
-- 6. История принятых цен конкурентов по дням (правило исторического распределения, 30 дней)
-- ---------------------------------------------------------------------------
CREATE TABLE channel_data.competitor_price_daily (
  tenant_id           uuid NOT NULL,
  channel_account_id  uuid NOT NULL,
  channel             text NOT NULL,
  marketplace         text NOT NULL,
  channel_product_ref text NOT NULL,
  condition           text NOT NULL,
  price_day           date NOT NULL,
  buybox_min_minor    bigint CHECK (buybox_min_minor > 0),
  buybox_max_minor    bigint,
  buybox_last_minor   bigint,
  lowest_min_minor    bigint CHECK (lowest_min_minor > 0),
  lowest_max_minor    bigint,
  lowest_last_minor   bigint,
  samples             int NOT NULL CHECK (samples >= 1),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  -- Контекст проверки входов: история товара за окно — ведущие столбцы ключа
  PRIMARY KEY (tenant_id, channel_account_id, marketplace, channel_product_ref, condition, price_day),
  FOREIGN KEY (tenant_id, channel_account_id, channel)
    REFERENCES tenant_data.channel_account (tenant_id, channel_account_id, channel),
  CHECK ((buybox_min_minor IS NULL) = (buybox_max_minor IS NULL) AND (buybox_min_minor IS NULL) = (buybox_last_minor IS NULL)),
  CHECK (buybox_min_minor IS NULL OR (buybox_min_minor <= buybox_last_minor AND buybox_last_minor <= buybox_max_minor)),
  CHECK ((lowest_min_minor IS NULL) = (lowest_max_minor IS NULL) AND (lowest_min_minor IS NULL) = (lowest_last_minor IS NULL)),
  CHECK (lowest_min_minor IS NULL OR (lowest_min_minor <= lowest_last_minor AND lowest_last_minor <= lowest_max_minor))
);

CREATE INDEX competitor_price_daily_retention_idx ON channel_data.competitor_price_daily (price_day);

CREATE TRIGGER a_competitor_price_daily_restrict_update BEFORE UPDATE ON channel_data.competitor_price_daily
  FOR EACH ROW EXECUTE FUNCTION security.restrict_update(
    'buybox_min_minor', 'buybox_max_minor', 'buybox_last_minor', 'lowest_min_minor', 'lowest_max_minor', 'lowest_last_minor',
    'samples', 'updated_at');

SELECT security.register_table('channel_data.competitor_price_daily', 'CHANNEL', 'mutable');
SELECT security.grant_retention('channel_data.competitor_price_daily');
INSERT INTO maintenance.retention_policy (table_name, method, anchor_column, retention, safety_margin, drop_order)
VALUES ('channel_data.competitor_price_daily', 'DELETE_ROWS', 'price_day', '45 days', '0 days', 60);

-- ---------------------------------------------------------------------------
-- 7. Окно движений для правила массового сдвига (внутри тенанта, аккаунта и витрины)
-- ---------------------------------------------------------------------------
CREATE TABLE channel_data.competitor_move (
  tenant_id           uuid NOT NULL,
  competitor_move_id  uuid NOT NULL DEFAULT gen_random_uuid(),
  channel_account_id  uuid NOT NULL,
  marketplace         text NOT NULL,
  channel_product_ref text NOT NULL,
  condition           text NOT NULL,
  observed_at         timestamptz NOT NULL,
  evaluated_at        timestamptz NOT NULL DEFAULT now(),
  -- Новая цена / прежняя принятая × 10 000
  move_bp             int NOT NULL CHECK (move_bp > 0),
  verdict             text NOT NULL CHECK (verdict IN ('ACCEPT', 'REJECT', 'HALT_CHANNEL')),
  PRIMARY KEY (tenant_id, competitor_move_id),
  FOREIGN KEY (tenant_id, channel_account_id) REFERENCES tenant_data.channel_account (tenant_id, channel_account_id)
);

-- Контекст массового сдвига: движения аккаунта и витрины за последние минуты
CREATE INDEX competitor_move_window_idx
  ON channel_data.competitor_move (tenant_id, channel_account_id, marketplace, evaluated_at DESC);
-- Удаление по сроку
CREATE INDEX competitor_move_retention_idx ON channel_data.competitor_move (evaluated_at);

SELECT security.register_table('channel_data.competitor_move', 'CHANNEL', 'append_only');
SELECT security.grant_retention('channel_data.competitor_move');
INSERT INTO maintenance.retention_policy (table_name, method, anchor_column, retention, safety_margin, drop_order)
VALUES ('channel_data.competitor_move', 'DELETE_ROWS', 'evaluated_at', '2 days', '0 days', 60);

RESET ROLE;

-- ---------------------------------------------------------------------------
-- 8. Закрытие тенанта учитывает новые таблицы (функции принадлежат repracer_retention)
-- ---------------------------------------------------------------------------
GRANT CREATE ON SCHEMA maintenance TO repracer_retention;
SET ROLE repracer_retention;

CREATE OR REPLACE FUNCTION maintenance.purge_tenant_channel_data(p_tenant_id uuid) RETURNS bigint
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  t     text;
  n     bigint;
  total bigint := 0;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM tenant_data.tenant
                  WHERE tenant_id = p_tenant_id AND kind = 'CUSTOMER' AND status IN ('OFFBOARDING', 'CLOSED')) THEN
    RAISE EXCEPTION 'tenant % must be a CUSTOMER in OFFBOARDING or CLOSED', p_tenant_id;
  END IF;
  FOREACH t IN ARRAY ARRAY[
    'channel_data.price_decision', 'channel_data.price_intent', 'channel_data.observed_channel_state',
    'channel_data.observed_price_daily', 'channel_data.divergence_case', 'channel_data.competitor_state',
    'channel_data.fee_estimate', 'channel_data.reservation', 'channel_data.sync_job',
    'channel_data.listing_migration_check', 'channel_data.write_submission',
    'channel_data.pricing_halt', 'channel_data.competitor_move', 'channel_data.competitor_price_daily',
    'channel_data.rejected_competitor_snapshot']
  LOOP
    EXECUTE format('DELETE FROM %s WHERE tenant_id = $1', t) USING p_tenant_id;
    GET DIAGNOSTICS n = ROW_COUNT;
    total := total + n;
  END LOOP;

  INSERT INTO maintenance.tenant_purge_status (subject_tenant_id, postgres_channel_purged_at)
  VALUES (p_tenant_id, now())
  ON CONFLICT (subject_tenant_id) DO UPDATE SET postgres_channel_purged_at = now();
  INSERT INTO maintenance.retention_run (table_name, action, rows_affected, subject_tenant_id)
  VALUES ('channel_data.*', 'TENANT_PURGED', total, p_tenant_id);
  RETURN total;
END $$;

CREATE OR REPLACE FUNCTION maintenance.purge_tenant_data(p_tenant_id uuid, p_delete_price_history boolean DEFAULT false) RETURNS bigint
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  t         text;
  n         bigint;
  total     bigint := 0;
  closed_ts timestamptz;
BEGIN
  SELECT closed_at INTO closed_ts FROM tenant_data.tenant
   WHERE tenant_id = p_tenant_id AND kind = 'CUSTOMER' AND status = 'CLOSED';
  IF closed_ts IS NULL THEN
    RAISE EXCEPTION 'tenant % must be a CLOSED CUSTOMER', p_tenant_id;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM maintenance.tenant_purge_status
                  WHERE subject_tenant_id = p_tenant_id AND postgres_channel_purged_at IS NOT NULL) THEN
    RAISE EXCEPTION 'purge channel data first (maintenance.purge_tenant_channel_data)';
  END IF;
  IF NOT p_delete_price_history
     AND (EXISTS (SELECT 1 FROM tenant_data.price_daily WHERE tenant_id = p_tenant_id)
          OR EXISTS (SELECT 1 FROM tenant_data.price_history WHERE tenant_id = p_tenant_id)
          OR EXISTS (SELECT 1 FROM tenant_data.price_intent_core WHERE tenant_id = p_tenant_id)) THEN
    RAISE EXCEPTION 'tenant % has price evidence; deletion requires explicit confirmation (OQ-22)', p_tenant_id;
  END IF;

  INSERT INTO legal.migration_consent_record
    (tenant_id, migration_consent_id, channel_account_id, channel_external_account_id, consenting_user_id,
     consenting_role, mfa_verified_at, disclosure_version, disclosure_text_sha256, other_tools_declaration,
     other_tools_list, typed_confirmation, given_at, expires_at, revoked_at, items, tenant_closed_at)
  SELECT c.tenant_id, c.migration_consent_id, c.channel_account_id, ca.external_account_id, c.user_id,
         m.role, c.mfa_verified_at, c.disclosure_version, c.disclosure_text_sha256, c.other_tools_declaration,
         c.other_tools_list, c.typed_confirmation, c.given_at, c.expires_at, r.revoked_at,
         coalesce((SELECT jsonb_agg(jsonb_build_object(
                     'listing_id', i.listing_id,
                     'listing_snapshot_sha256', encode(i.listing_snapshot_sha256, 'hex'),
                     'verdict_at_consent', i.verdict_at_consent,
                     'acknowledged_losses', to_jsonb(i.acknowledged_losses)))
                     FROM tenant_data.migration_consent_item i
                    WHERE i.tenant_id = c.tenant_id AND i.migration_consent_id = c.migration_consent_id), '[]'::jsonb),
         closed_ts
    FROM tenant_data.migration_consent c
    JOIN tenant_data.channel_account ca ON ca.tenant_id = c.tenant_id AND ca.channel_account_id = c.channel_account_id
    JOIN tenant_data.membership m ON m.tenant_id = c.tenant_id AND m.membership_id = c.membership_id
    LEFT JOIN tenant_data.migration_consent_revocation r
      ON r.tenant_id = c.tenant_id AND r.migration_consent_id = c.migration_consent_id
   WHERE c.tenant_id = p_tenant_id
  ON CONFLICT (tenant_id, migration_consent_id) DO NOTHING;

  FOREACH t IN ARRAY ARRAY[
    'tenant_data.outbox_event', 'tenant_data.price_history', 'tenant_data.price_daily_correction',
    'tenant_data.price_daily', 'tenant_data.price_intent_core',
    'tenant_data.channel_write_history', 'tenant_data.channel_write', 'tenant_data.edit_budget',
    'tenant_data.migration_consent_revocation', 'tenant_data.migration_consent_item', 'tenant_data.migration_consent',
    'tenant_data.stock_movement', 'tenant_data.stock_allocation', 'tenant_data.stock_pool',
    'tenant_data.inbound_api_key', 'tenant_data.stock_source',
    'tenant_data.min_price', 'tenant_data.max_price', 'tenant_data.guardrail', 'tenant_data.divergence_policy',
    'tenant_data.cost_profile',
    'tenant_data.offer_mapping', 'tenant_data.write_scope_sync_state', 'tenant_data.write_scope',
    'tenant_data.pricing_strategy', 'tenant_data.channel_capability_override', 'tenant_data.channel_account',
    'tenant_data.bundle_component', 'tenant_data.product', 'tenant_data.membership']
  LOOP
    EXECUTE format('DELETE FROM %s WHERE tenant_id = $1', t) USING p_tenant_id;
    GET DIAGNOSTICS n = ROW_COUNT;
    total := total + n;
  END LOOP;

  UPDATE tenant_data.tenant SET name = 'closed tenant' WHERE tenant_id = p_tenant_id;
  UPDATE maintenance.tenant_purge_status
     SET postgres_tenant_purged_at = now(),
         legal_hold_until = CASE WHEN EXISTS (SELECT 1 FROM legal.migration_consent_record WHERE tenant_id = p_tenant_id)
                                 THEN (closed_ts + interval '3 years')::date END
   WHERE subject_tenant_id = p_tenant_id;
  INSERT INTO maintenance.retention_run (table_name, action, rows_affected, subject_tenant_id)
  VALUES ('tenant_data.*', 'TENANT_PURGED', total, p_tenant_id);
  RETURN total;
END $$;

RESET ROLE;
REVOKE CREATE ON SCHEMA maintenance FROM repracer_retention;
COMMIT;
