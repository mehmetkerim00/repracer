-- 0034_multicurrency_tax_projections.sql
-- Шаг 9: Release 1.0 — Kaufland (DE, AT), Amazon и eBay (ЕС и США) [Р-56]; валюта — свойство единицы записи, EUR и USD наравне [Р-57];
-- налоговый режим цены витрины: НДС в цене (ЕС) или налог с продаж сверх цены (США) [Р-58]; проекции для пути решения
-- в три транзакции [Р-59, OQ-93, OQ-94]; параметры причины решения [OQ-98].
-- Миграция предполагает отсутствие production-данных: новые NOT NULL столбцы добавляются без значений по умолчанию.

BEGIN;
SET ROLE repracer_owner;

-- ---------------------------------------------------------------------------
-- 1. Витрины: страна, валюта, база цены и налоговый режим [Р-56, Р-57, Р-58]
-- ---------------------------------------------------------------------------
CREATE TABLE platform.marketplace (
  tenant_id   uuid NOT NULL DEFAULT security.platform_tenant_id() CHECK (tenant_id = security.platform_tenant_id()),
  channel     text NOT NULL CHECK (channel IN ('AMAZON', 'EBAY', 'KAUFLAND', 'OTTO')),
  marketplace text NOT NULL CHECK (length(marketplace) BETWEEN 1 AND 40),
  country     text NOT NULL CHECK (country ~ '^[A-Z]{2}$'),
  currency    text NOT NULL CHECK (currency IN ('EUR', 'USD')),
  price_basis text NOT NULL CHECK (price_basis IN ('GROSS', 'NET')),
  tax_regime  text NOT NULL CHECK (tax_regime IN ('VAT_INCLUDED', 'SALES_TAX_EXCLUDED')),
  source      text NOT NULL,
  PRIMARY KEY (tenant_id, channel, marketplace),
  -- Р-58: в ЕС цена витрины брутто и включает НДС; в США — нетто, налог с продаж добавляется при покупке
  CHECK ((tax_regime = 'VAT_INCLUDED') = (price_basis = 'GROSS'))
);

SELECT security.register_table('platform.marketplace', 'PLATFORM', 'reference', 'none');
CREATE POLICY marketplace_read ON platform.marketplace FOR SELECT TO repracer_app
  USING (tenant_id = security.platform_tenant_id());
CREATE POLICY marketplace_owner_load ON platform.marketplace TO repracer_owner
  USING (tenant_id = security.platform_tenant_id()) WITH CHECK (tenant_id = security.platform_tenant_id());

INSERT INTO platform.marketplace (channel, marketplace, country, currency, price_basis, tax_regime, source) VALUES
  ('KAUFLAND', 'de', 'DE', 'EUR', 'GROSS', 'VAT_INCLUDED', 'Р-35: витрина Kaufland; брутто — до ответа на K-12'),
  ('KAUFLAND', 'at', 'AT', 'EUR', 'GROSS', 'VAT_INCLUDED', 'Р-35: витрина Kaufland; брутто — до ответа на K-12'),
  ('AMAZON', 'A1PA6795UKMFR9', 'DE', 'EUR', 'GROSS', 'VAT_INCLUDED', 'Р-56: amazon.de; идентификатор витрины SP-API (проверить)'),
  ('AMAZON', 'ATVPDKIKX0DER', 'US', 'USD', 'NET', 'SALES_TAX_EXCLUDED', 'Р-56: amazon.com; идентификатор витрины SP-API (проверить)'),
  ('EBAY', 'EBAY_DE', 'DE', 'EUR', 'GROSS', 'VAT_INCLUDED', 'Р-56: eBay Germany (проверить)'),
  ('EBAY', 'EBAY_US', 'US', 'USD', 'NET', 'SALES_TAX_EXCLUDED', 'Р-56: eBay US (проверить)');

-- ---------------------------------------------------------------------------
-- 2. EUR и USD наравне [Р-57]: вместо «только EUR в Release 1.0»
-- ---------------------------------------------------------------------------
ALTER TABLE tenant_data.tenant DROP CONSTRAINT tenant_release_1_0_currency,
  ADD CONSTRAINT tenant_supported_currency CHECK (default_currency IN ('EUR', 'USD'));
ALTER TABLE tenant_data.write_scope DROP CONSTRAINT write_scope_release_1_0_currency,
  ADD CONSTRAINT write_scope_supported_currency CHECK (currency IS NULL OR currency IN ('EUR', 'USD'));
ALTER TABLE tenant_data.min_price DROP CONSTRAINT min_price_release_1_0_currency,
  ADD CONSTRAINT min_price_supported_currency CHECK (currency IN ('EUR', 'USD'));
ALTER TABLE tenant_data.max_price DROP CONSTRAINT max_price_release_1_0_currency,
  ADD CONSTRAINT max_price_supported_currency CHECK (currency IN ('EUR', 'USD'));
ALTER TABLE tenant_data.cost_profile DROP CONSTRAINT cost_profile_release_1_0_currency,
  ADD CONSTRAINT cost_profile_supported_currency CHECK (currency IN ('EUR', 'USD'));
ALTER TABLE tenant_data.guardrail DROP CONSTRAINT guardrail_release_1_0_currency,
  ADD CONSTRAINT guardrail_supported_currency CHECK (currency IS NULL OR currency IN ('EUR', 'USD'));
ALTER TABLE channel_data.observed_price_daily DROP CONSTRAINT observed_price_daily_currency_check,
  ADD CONSTRAINT observed_price_daily_supported_currency CHECK (currency IN ('EUR', 'USD'));

-- ---------------------------------------------------------------------------
-- 3. Налоговый режим единицы записи цены [Р-58]; единица и витрина предложения согласованы
-- ---------------------------------------------------------------------------
ALTER TABLE tenant_data.write_scope ADD COLUMN tax_regime text CHECK (tax_regime IN ('VAT_INCLUDED', 'SALES_TAX_EXCLUDED'));
ALTER TABLE tenant_data.write_scope
  ADD CONSTRAINT write_scope_tax_regime_for_price CHECK ((field = 'PRICE') = (tax_regime IS NOT NULL)),
  ADD CONSTRAINT write_scope_tax_regime_basis CHECK (tax_regime IS NULL OR (tax_regime = 'VAT_INCLUDED') = (price_basis = 'GROSS'));

CREATE OR REPLACE FUNCTION tenant_data.offer_mapping_scope_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  offer  jsonb := to_jsonb(NEW);
  sid    uuid;
  s      record;
BEGIN
  FOREACH sid IN ARRAY ARRAY[NEW.price_write_scope_id, NEW.quantity_write_scope_id] LOOP
    CONTINUE WHEN sid IS NULL;
    CONTINUE WHEN TG_OP = 'UPDATE' AND sid IN (OLD.price_write_scope_id, OLD.quantity_write_scope_id);

    SELECT ws.scope_key, ws.budget_scope_key, ws.status, ws.field, ws.currency, ws.price_basis, ws.tax_regime,
           c.write_scope_key_template, c.budget_scope_attribute
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
    -- Р-57, Р-58: валюта, база цены и налоговый режим единицы записи — те же, что у витрины предложения; неизвестная витрина — отказ
    IF s.field = 'PRICE' AND NOT EXISTS (
         SELECT 1 FROM platform.marketplace mk
          WHERE mk.channel = NEW.channel AND mk.marketplace = NEW.marketplace
            AND mk.currency = s.currency AND mk.price_basis = s.price_basis AND mk.tax_regime = s.tax_regime) THEN
      RAISE EXCEPTION 'write_scope % (% % %) does not match storefront % % in platform.marketplace',
        sid, s.currency, s.price_basis, s.tax_regime, NEW.channel, NEW.marketplace USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;

-- Ставка НДС объявляется только для страны с режимом НДС [Р-53, Р-58]
ALTER TABLE tenant_data.product_vat_rate DROP CONSTRAINT product_vat_rate_country_check,
  ADD CONSTRAINT product_vat_rate_country_format CHECK (country ~ '^[A-Z]{2}$');

CREATE FUNCTION tenant_data.product_vat_rate_country_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM platform.vat_rate_default WHERE country = NEW.country) THEN
    RAISE EXCEPTION 'country % has no VAT regime: product VAT rate is not applicable (Р-58)', NEW.country
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER aa_product_vat_rate_country BEFORE INSERT ON tenant_data.product_vat_rate
  FOR EACH ROW EXECUTE FUNCTION tenant_data.product_vat_rate_country_guard();

-- ---------------------------------------------------------------------------
-- 4. Проекция снимка хранит валюту, базу цены и подсказку канала [OQ-94]
-- ---------------------------------------------------------------------------
ALTER TABLE channel_data.competitor_state
  ADD COLUMN currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  ADD COLUMN price_basis text NOT NULL CHECK (price_basis IN ('GROSS', 'NET')),
  ADD COLUMN suggested_price_minor bigint CHECK (suggested_price_minor > 0);

DROP TRIGGER a_competitor_state_restrict_update ON channel_data.competitor_state;
CREATE TRIGGER a_competitor_state_restrict_update BEFORE UPDATE ON channel_data.competitor_state
  FOR EACH ROW EXECUTE FUNCTION security.restrict_update(
    'source', 'source_event_id', 'competitor_snapshot_id', 'observed_at', 'received_at', 'buybox_amount_minor',
    'buybox_is_self', 'lowest_landed_minor', 'offer_count', 'offers', 'completeness', 'completeness_n', 'gtin',
    'currency', 'price_basis', 'suggested_price_minor');

-- ---------------------------------------------------------------------------
-- 5. Проекция окна массового сдвига: последнее движение каждого товара [Р-50, OQ-93]
-- ---------------------------------------------------------------------------
CREATE TABLE channel_data.competitor_move_latest (
  tenant_id           uuid NOT NULL,
  channel_account_id  uuid NOT NULL,
  marketplace         text NOT NULL,
  channel_product_ref text NOT NULL,
  condition           text NOT NULL,
  observed_at         timestamptz NOT NULL,
  evaluated_at        timestamptz NOT NULL,
  move_bp             int  NOT NULL CHECK (move_bp > 0),
  verdict             text NOT NULL CHECK (verdict IN ('ACCEPT', 'REJECT', 'HALT_CHANNEL')),
  seller_ref          text CHECK (length(seller_ref) BETWEEN 1 AND 200),
  PRIMARY KEY (tenant_id, channel_account_id, marketplace, channel_product_ref, condition),
  FOREIGN KEY (tenant_id, channel_account_id) REFERENCES tenant_data.channel_account (tenant_id, channel_account_id)
);

-- Окно сдвига на каждый снимок: товары витрины, чьё последнее движение попало в окно (число и большие движения)
CREATE INDEX competitor_move_latest_window_idx ON channel_data.competitor_move_latest
  (tenant_id, channel_account_id, marketplace, evaluated_at) INCLUDE (move_bp);
-- Удаление по сроку
CREATE INDEX competitor_move_latest_retention_idx ON channel_data.competitor_move_latest (evaluated_at);

SELECT security.register_table('channel_data.competitor_move_latest', 'CHANNEL', 'mutable');
SELECT security.grant_retention('channel_data.competitor_move_latest');
CREATE TRIGGER a_competitor_move_latest_restrict_update BEFORE UPDATE ON channel_data.competitor_move_latest
  FOR EACH ROW EXECUTE FUNCTION security.restrict_update('observed_at', 'evaluated_at', 'move_bp', 'verdict', 'seller_ref');
INSERT INTO maintenance.retention_policy (table_name, method, anchor_column, retention, safety_margin, drop_order)
VALUES ('channel_data.competitor_move_latest', 'DELETE_ROWS', 'evaluated_at', '2 days', '0 days', 60);

-- ---------------------------------------------------------------------------
-- 6. Объяснимость: параметры причины и проверки Gate хранятся в решении и в вечном ядре intent [OQ-98]
-- ---------------------------------------------------------------------------
ALTER TABLE channel_data.price_decision
  ADD COLUMN reason_params jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN checks jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE channel_data.price_decision
  ADD CONSTRAINT price_decision_reason_params_object CHECK (jsonb_typeof(reason_params) = 'object'),
  ADD CONSTRAINT price_decision_checks_array CHECK (jsonb_typeof(checks) = 'array'),
  -- Отказ без параметров необъясним: причина без значений («выше потолка», но какого) не принимается
  ADD CONSTRAINT price_decision_rejection_explained CHECK (rejection_reason IS NULL OR reason_params <> '{}'::jsonb);

ALTER TABLE tenant_data.price_intent_core
  ADD COLUMN reason_params jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE tenant_data.price_intent_core
  ADD CONSTRAINT price_intent_core_reason_params_object CHECK (jsonb_typeof(reason_params) = 'object');

CREATE OR REPLACE FUNCTION channel_data.price_decision_record_core() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.intent_class <> 'NO_OP' THEN
    INSERT INTO tenant_data.price_intent_core
      (tenant_id, price_intent_id, intent_created_at, write_scope_id, pricing_strategy_id, pricing_strategy_version,
       trigger_type, rule_code, proposed_amount_minor, currency, price_basis, intent_class, price_decision_id,
       decision_outcome, final_amount_minor, effective_floor_minor, effective_ceiling_minor, violations, decided_at,
       rejection_reason, reason_params)
    SELECT i.tenant_id, i.price_intent_id, i.created_at, i.write_scope_id, i.pricing_strategy_id, i.pricing_strategy_version,
           i.trigger_type, i.rule_code, i.proposed_amount_minor, i.currency, i.price_basis, NEW.intent_class,
           NEW.price_decision_id, NEW.outcome, NEW.final_amount_minor, NEW.effective_floor_minor,
           NEW.effective_ceiling_minor, NEW.violations, NEW.decided_at, NEW.rejection_reason, NEW.reason_params
      FROM channel_data.price_intent i
     WHERE i.tenant_id = NEW.tenant_id AND i.created_at = NEW.intent_created_at
       AND i.price_intent_id = NEW.price_intent_id;
  END IF;
  RETURN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- 7. Новая причина отказа снимка: база цены не совпадает с витриной [Р-58]
-- ---------------------------------------------------------------------------
ALTER TABLE channel_data.rejected_competitor_snapshot DROP CONSTRAINT rejected_competitor_snapshot_reason_code_known,
  ADD CONSTRAINT rejected_competitor_snapshot_reason_code_known CHECK (reason_code IN (
    'INVALID_AMOUNT', 'CURRENCY_MISMATCH', 'PRICE_BASIS_MISMATCH', 'INCONSISTENT_SNAPSHOT', 'SNAPSHOT_FROM_FUTURE', 'SNAPSHOT_TOO_OLD',
    'OUT_OF_ORDER', 'CHANNEL_HALTED', 'CHANNEL_MASS_SHIFT', 'UNIT_SCALE_X100', 'UNIT_SCALE_X0_01', 'PRICE_BELOW_COST_ANCHOR',
    'PRICE_ABOVE_COST_ANCHOR', 'SNAPSHOT_INTERNAL_OUTLIER', 'CROSS_CHANNEL_MISMATCH', 'OUTSIDE_HISTORY_BAND', 'NO_PLAUSIBILITY_ANCHOR'));

RESET ROLE;

-- ---------------------------------------------------------------------------
-- 8. Закрытие тенанта учитывает проекцию окна сдвига (функции принадлежат repracer_retention)
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
    'channel_data.pricing_halt_review', 'channel_data.pricing_halt', 'channel_data.competitor_move_latest', 'channel_data.competitor_move', 'channel_data.competitor_price_daily',
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

RESET ROLE;
REVOKE CREATE ON SCHEMA maintenance FROM repracer_retention;

COMMIT;
