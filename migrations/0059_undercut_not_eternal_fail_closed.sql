-- 0059_undercut_not_eternal_fail_closed.sql
-- Шаг 16.
-- Часть 1, Р-91 (OQ-142): величина подреза стратегии в вечном ядре НЕ хранится. Опубликованная цена CHANGED — наша цена и хранится
--   вечно [Р-21]; вместе с подрезом из вечной версии стратегии она давала цену конкурента, если цена не упёрлась в границу. Теперь:
--   - tenant_data.pricing_strategy (архивируется вместе с ядром, Р-79) хранит тип стратегии и её версию без подреза;
--   - подрез — channel_data.pricing_strategy_undercut: живёт, пока версия действует, и удаляется через 18 месяцев после её замены;
--   - в слепке объяснения подрез — производная величина (класс CHANNEL_DERIVED, часть 2).
--   Юридическая оценка для Amazon — до подключения канала (Р-91). Архивы, выгруженные до этой миграции, подрез содержат (OQ-150).
-- Часть 2, находка 15 ревью шага 15: проверка слепка — fail-closed. Разрешены только объявленные ключи: коды причин и ключи их
--   параметров из реестра (packages/pricing-model/src/reasons.ts, классы кроме CHANNEL и CHANNEL_DERIVED) и поля формата r80.1.
--   Неизвестный код, незаявленный ключ (например "target") или незнакомое поле — отказ. Совпадение реестров БД и кода проверяет
--   packages/pricing-store-pg/test/channel-derived.pg.test.ts.

BEGIN;
SET ROLE repracer_owner;

-- ---------------------------------------------------------------------------
-- 1. Подрез стратегии — 18 месяцев после замены версии
-- ---------------------------------------------------------------------------
CREATE TABLE channel_data.pricing_strategy_undercut (
  tenant_id            uuid NOT NULL,
  pricing_strategy_id  uuid NOT NULL,
  version              int  NOT NULL,
  undercut_minor       bigint NOT NULL CHECK (undercut_minor >= 0),
  created_at           timestamptz NOT NULL DEFAULT now(),
  -- Момент замены версии следующей: отсюда отсчитывается срок хранения; пока версия действует — NULL
  superseded_at        timestamptz,
  PRIMARY KEY (tenant_id, pricing_strategy_id, version),
  FOREIGN KEY (tenant_id, pricing_strategy_id, version) REFERENCES tenant_data.pricing_strategy (tenant_id, pricing_strategy_id, version),
  CHECK (superseded_at IS NULL OR superseded_at >= created_at)
);

-- Удаление по сроку хранения: maintenance DELETE_ROWS по superseded_at
CREATE INDEX pricing_strategy_undercut_expiry_idx ON channel_data.pricing_strategy_undercut (superseded_at) WHERE superseded_at IS NOT NULL;

SELECT security.register_table('channel_data.pricing_strategy_undercut', 'CHANNEL', 'mutable');
SELECT security.grant_retention('channel_data.pricing_strategy_undercut');
INSERT INTO maintenance.retention_policy (table_name, method, anchor_column, retention, safety_margin, drop_order)
VALUES ('channel_data.pricing_strategy_undercut', 'DELETE_ROWS', 'superseded_at', '18 months', '0 days', 62);
GRANT SELECT, INSERT ON channel_data.pricing_strategy_undercut TO repracer_app;
GRANT UPDATE (superseded_at) ON channel_data.pricing_strategy_undercut TO repracer_app;

-- Подрез неизменяем; момент замены ставится один раз
CREATE FUNCTION channel_data.pricing_strategy_undercut_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.tenant_id, NEW.pricing_strategy_id, NEW.version, NEW.undercut_minor, NEW.created_at)
       IS DISTINCT FROM (OLD.tenant_id, OLD.pricing_strategy_id, OLD.version, OLD.undercut_minor, OLD.created_at)
     OR OLD.superseded_at IS NOT NULL OR NEW.superseded_at IS NULL THEN
    RAISE EXCEPTION 'the undercut of a strategy version is immutable; only its supersession is recorded once (Р-91)' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER a_pricing_strategy_undercut_guard BEFORE UPDATE ON channel_data.pricing_strategy_undercut
  FOR EACH ROW EXECUTE FUNCTION channel_data.pricing_strategy_undercut_guard();

-- Существующие версии: подрез — в новую таблицу, из параметров стратегии — прочь
RESET ROLE;
INSERT INTO channel_data.pricing_strategy_undercut (tenant_id, pricing_strategy_id, version, undercut_minor, created_at, superseded_at)
SELECT s.tenant_id, s.pricing_strategy_id, s.version, (s.params ->> 'undercutMinor')::bigint, s.created_at,
       (SELECT min(n.created_at) FROM tenant_data.pricing_strategy n
         WHERE n.tenant_id = s.tenant_id AND n.pricing_strategy_id = s.pricing_strategy_id AND n.version > s.version)
  FROM tenant_data.pricing_strategy s
 WHERE s.params ? 'undercutMinor';
ALTER TABLE tenant_data.pricing_strategy DISABLE TRIGGER zz_append_only;
UPDATE tenant_data.pricing_strategy SET params = params - 'undercutMinor' WHERE params ? 'undercutMinor';
ALTER TABLE tenant_data.pricing_strategy ENABLE TRIGGER zz_append_only;
SET ROLE repracer_owner;

ALTER TABLE tenant_data.pricing_strategy
  ADD CONSTRAINT pricing_strategy_undercut_not_eternal CHECK (NOT params ? 'undercutMinor');

-- Новая версия заменяет прежние: у их подреза начинается срок хранения
CREATE FUNCTION tenant_data.pricing_strategy_supersede_undercut() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  UPDATE channel_data.pricing_strategy_undercut SET superseded_at = greatest(NEW.created_at, created_at)
   WHERE tenant_id = NEW.tenant_id AND pricing_strategy_id = NEW.pricing_strategy_id AND version < NEW.version AND superseded_at IS NULL;
  RETURN NULL;
END $$;
CREATE TRIGGER zb_pricing_strategy_supersede_undercut AFTER INSERT ON tenant_data.pricing_strategy
  FOR EACH ROW EXECUTE FUNCTION tenant_data.pricing_strategy_supersede_undercut();

-- Стратегия по рынку без подреза не создаётся: проверка — при фиксации (подрез вставляется после версии, FK)
CREATE FUNCTION tenant_data.pricing_strategy_requires_undercut() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.type IN ('MATCH_BUYBOX', 'BEAT_LOWEST') AND NOT EXISTS (
       SELECT 1 FROM channel_data.pricing_strategy_undercut u
        WHERE u.tenant_id = NEW.tenant_id AND u.pricing_strategy_id = NEW.pricing_strategy_id AND u.version = NEW.version) THEN
    RAISE EXCEPTION 'strategy % version % (%) needs its undercut in channel_data.pricing_strategy_undercut (Р-91)', NEW.pricing_strategy_id, NEW.version, NEW.type
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER zc_pricing_strategy_requires_undercut AFTER INSERT ON tenant_data.pricing_strategy
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION tenant_data.pricing_strategy_requires_undercut();

RESET ROLE;
COMMIT;

-- ===========================================================================
-- Часть 2. Слепок объяснения: подрез — производная величина [Р-91]; проверка ключей — fail-closed (находка 15)
-- ===========================================================================
BEGIN;
SET ROLE repracer_owner;

-- Р-91: подрез в причинах BUYBOX_UNDERCUT и LOWEST_UNDERCUT — класс CHANNEL_DERIVED (reasons.ts): с опубликованной ценой он даёт цену конкурента
CREATE OR REPLACE FUNCTION security.channel_derived_param_keys() RETURNS jsonb
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT '{"ALREADY_AT_TARGET":["targetMinor"],"BUYBOX_MATCH":["targetMinor"],"BUYBOX_UNDERCUT":["targetMinor","undercutMinor"],"CAPPED_AT_MAX_PRICE":["targetMinor"],"CAPPED_AT_MIN_PRICE":["targetMinor"],"LOWEST_MATCH":["targetMinor"],"LOWEST_UNDERCUT":["targetMinor","undercutMinor"],"TARGET_OUTSIDE_BOUNDS_HOLD":["targetMinor"],"WITHIN_DEADBAND":["deltaMinor"]}'::jsonb
$$;

-- Разрешённые ключи параметров по коду причины: все объявленные в реестре кода, кроме классов CHANNEL и CHANNEL_DERIVED.
-- Сгенерировано из REASON_PARAMS и SANITY_NOTE_PARAMS; совпадение с кодом проверяет channel-derived.pg.test.ts
CREATE FUNCTION security.eternal_param_keys() RETURNS jsonb
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT '{"ABOVE_MAX_PRICE":["currency","deviationBp","maxMinor","proposedMinor","source"],"ALREADY_AT_TARGET":["currency"],"ALREADY_WINNING_BUYBOX":[],"APPROVED":["ceilingMinor","currency","finalMinor","floorMinor"],"BELOW_MARGIN_FLOOR":["currency","deviationBp","floorMinor","minMarginBp","minMinor","proposedMinor"],"BELOW_MIN_PRICE":["currency","deviationBp","minMinor","proposedMinor","source"],"BOUNDS_INVALID":["currency","maxMinor","minMinor"],"BOUNDS_INVERTED":["currency","maxMinor","minMinor"],"BOUNDS_VERSION_CHANGED":["attempt","changed","currency","newMaxMinor","newMinMinor","oldMaxMinor","oldMinMinor"],"BOUND_CURRENCY_MISMATCH":["bound","boundBasis","boundCurrency","cause","scopeBasis","scopeCurrency"],"BOUND_UNRESOLVABLE":["bound","boundBasis","boundCurrency","cause","minMarginBp","scopeBasis","scopeCurrency"],"BUYBOX_MATCH":["currency"],"BUYBOX_UNDERCUT":["currency"],"CAPPED_AT_MAX_PRICE":["currency","maxMinor"],"CAPPED_AT_MIN_PRICE":["currency","minMinor"],"CHANGE_RATE_LIMIT":["changes","limit"],"CHANNEL_HALTED":["haltId","haltReason","haltedAt","marketplace","ruleCode","stage"],"CHANNEL_MASS_SHIFT":["maxSpread","windowMinutes"],"COMPETITOR_REQUIREMENT_NOT_MET":["maxStalenessSeconds","requiredCompleteness","requiredN"],"COST_INPUTS_MISSING":["missing"],"COST_NOT_DECLARED":[],"CROSS_CHANNEL_FX_UNAVAILABLE":["cause","channel","currency","expected","marketplace"],"CROSS_CHANNEL_MISMATCH":["currency","field","fxFrom","fxRateDate","fxRateMicros","limit","referenceStorefronts"],"CURRENCY_MISMATCH":["expected","field"],"DISPERSED_MARKET_EVENT":["maxSpread"],"DIVERGENCE_CASE_OPENED":["currency","expectedMinor"],"ENGINE_CURRENCY_MISMATCH":["expected","source"],"FIXED_PRICE":["currency","targetMinor"],"HALT_AUTO_RELEASED":["haltId","sampleSize"],"HALT_MANUALLY_RELEASED":["haltId","membershipId","note"],"HALT_REVIEW_FAILED":["failed","haltId","nextReviewAt","sampleSize"],"HISTORY_AVAILABLE":[],"HISTORY_TOO_SHORT":["minHistoryDays"],"INCONSISTENT_SNAPSHOT":["currency","inconsistency"],"INTENT_EXPIRED":["createdAt","decidedAt","expiresAt","waitedSeconds"],"INTENT_INVALID":["problem"],"INTERNAL_BOUND_VIOLATION":["amountMinor","ceilingMinor","check","currency","floorMinor"],"INTERNAL_OUTLIER_IGNORED":["currency"],"INVALID_AMOUNT":["currency","field"],"INVALID_STRATEGY_PARAMS":["allowed","currency","param","settingBp","settingMinor"],"LOWEST_MATCH":["currency","scope"],"LOWEST_UNDERCUT":["currency","scope"],"MARGIN_TARGET":["currency","marginBp","targetMinor"],"MARGIN_UNATTAINABLE":["currency","feeRateBp","fixedFeeMinor","marginBp","unitCostMinor","vatRateBp"],"MARGIN_WITHOUT_COST":["cause","minMarginBp","requiredBy","strategyType"],"MARKET_SHIFT_DISPERSED":["maxSpread","windowMinutes"],"MARKET_SHIFT_SINGLE_SELLER":["maxSpread","windowMinutes"],"MAX_PRICE_MISSING":[],"MIN_PRICE_MISSING":[],"NO_CHANGE":[],"NO_COMPETITOR_OFFERS":[],"NO_FRESH_CROSS_CHANNEL_REFERENCE":["maxAgeSeconds"],"NO_PLAUSIBILITY_ANCHOR":["costDeclared","minHistoryDays","minOffers"],"NO_PREVIOUS_SNAPSHOT":[],"NO_SCALE_REFERENCE":[],"NO_SCOPE_FOR_PRODUCT":["writeScopeId"],"OUTSIDE_HISTORY_BAND":["bandFactor","currency","field"],"OUT_OF_ORDER":[],"OWN_PRICE_DEVIATION":["currency","field","limit","ourPriceMinor"],"PRICE_ABOVE_COST_ANCHOR":["costMinor","currency","field","limit"],"PRICE_BASIS_MISMATCH":["expected","field"],"PRICE_BELOW_COST_ANCHOR":["costMinor","currency","field","limit"],"PRICING_STOPPED":["channelAccountId","marketplace","scope","stage","stopId","stoppedAt","stoppedBy"],"REFERENCES_CONVERTED_AT_ECB":["currency","fxFrom","fxRateDate","fxRateMicros"],"REFERENCES_WITHOUT_ECB_RATE":[],"SCOPE_NOT_ACTIVE":["action","blockedByErrorCode","blockedSince","mode","status"],"SCOPE_NOT_ENGINE":["mode"],"SELF_OFFER_DIVERGENCE":["currency","limit","ourPriceMinor"],"SHIFT_BELOW_SHARE":["minProducts","share"],"SINGLE_SELLER_MARKET_EVENT":[],"SMALL_MOVE":["minFactor"],"SNAPSHOT_FROM_FUTURE":["maxSkewSeconds"],"SNAPSHOT_INTERNAL_OUTLIER":["currency","outlierFactor"],"SNAPSHOT_TOO_OLD":["maxAgeSeconds"],"STEP_LIMIT":["currency","currentMinor","limitBp","proposedMinor","stepBp"],"STRATEGY_MISSING":[],"TARGET_OUTSIDE_BOUNDS_HOLD":["currency","maxMinor","minMinor"],"TOO_FEW_COMPETITOR_OFFERS":["minOffers"],"UNIT_SCALE_X0_01":["anchor","currency","field"],"UNIT_SCALE_X100":["anchor","currency","field"],"WITHIN_DEADBAND":["currency","deadbandMinor"],"WRITE_BLOCKED_BY_BOUND_RECHECK":["amountMinor","cause","ceilingMinor","currency","floorMinor","marginFloorMinor","minMarginBp","minMinor","violated"],"WRITE_BUDGET_DAY_UNCONFIRMED":["marketplace"],"WRITE_EDIT_BUDGET_EXHAUSTED":["budgetDay","limit","resetsAt","source","timeZone","used"],"WRITE_NOT_ACCEPTED_BY_CHANNEL":["errorClass","status"],"WRITE_OUTCOME_RECONCILED":["result"],"WRITE_PRICING_MODE_CHANGED":["mode"],"WRITE_QUEUED_BEHIND_IN_FLIGHT":["inFlightWriteId"],"WRITE_RETRIES_EXHAUSTED":["attempts","code"],"WRITE_RETRY_SCHEDULED":["at","attempt","code"],"WRITE_SCOPE_BLOCKED":["action","code"],"WRITE_SUPERSEDED_BY_NEWER_VERSION":["newerVersion","newerWriteId"]}'::jsonb
$$;

-- Поля формата r80.1 (DecisionExplanation, explanation.ts) по пути; "reasons" — пути, где лежит причина {code, params, withheld}
CREATE FUNCTION security.explanation_shape() RETURNS jsonb
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT '{"$":["format","snapshot","sanity","strategy","gate","context"],"$.snapshot":["source"],"$.sanity":["checks","anchorsUsed","warnings"],"$.sanity.checks[]":["rule","outcome","detail"],"$.strategy":["intentClass","currentMinor","boundsAtStrategy","currency","reason","steps","chain"],"$.strategy.boundsAtStrategy":["minMinor","maxMinor","currency"],"$.gate":["failed","minMarginBp","fx"],"$.gate.failed":["check","detail"],"$.gate.fx":["source","rateDate","base","quote","rateMicros","from","to","sourceAmountMinor","convertedAmountMinor","rounding"],"$.context":["channelHalt","priceStop"],"$.context.channelHalt":["haltId","reasonCode","marketplace","haltedAt"],"$.context.priceStop":["stopId","scope","channelAccountId","marketplace","stoppedAt","stoppedByMembershipId"],"reasons":["$.sanity.checks[].detail","$.sanity.warnings[]","$.strategy.reason","$.strategy.steps[]","$.strategy.chain[]","$.gate.failed.detail"]}'::jsonb
$$;

CREATE FUNCTION security.explanation_node_declared(node jsonb, path text, p_competitor_derived boolean) RETURNS boolean
  LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  shape   jsonb := security.explanation_shape();
  allowed jsonb;
  k       text;
  v       jsonb;
BEGIN
  IF node IS NULL OR jsonb_typeof(node) NOT IN ('object', 'array') THEN
    RETURN true;
  END IF;
  IF jsonb_typeof(node) = 'array' THEN
    FOR v IN SELECT value FROM jsonb_array_elements(node) LOOP
      IF NOT security.explanation_node_declared(v, path || '[]', p_competitor_derived) THEN
        RETURN false;
      END IF;
    END LOOP;
    RETURN true;
  END IF;
  IF (shape -> 'reasons') ? path THEN
    -- Причина: код из реестра; ключи параметров объявлены для кода; у цены из данных конкурентов — без производных от предложенной цены
    IF jsonb_typeof(node -> 'code') IS DISTINCT FROM 'string' OR NOT security.eternal_param_keys() ? (node ->> 'code') THEN
      RETURN false;
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_object_keys(node) AS key WHERE key NOT IN ('code', 'params', 'withheld')) THEN
      RETURN false;
    END IF;
    IF node ? 'params' THEN
      IF jsonb_typeof(node -> 'params') <> 'object' THEN
        RETURN false;
      END IF;
      allowed := security.eternal_param_keys() -> (node ->> 'code');
      FOR k, v IN SELECT key, value FROM jsonb_each(node -> 'params') LOOP
        IF NOT allowed ? k OR (p_competitor_derived AND k = ANY (security.channel_rule_derived_param_keys()))
           OR jsonb_typeof(v) = 'object'
           OR (jsonb_typeof(v) = 'array' AND EXISTS (SELECT 1 FROM jsonb_array_elements(v) e WHERE jsonb_typeof(e.value) IN ('object', 'array'))) THEN
          RETURN false;
        END IF;
      END LOOP;
    END IF;
    IF node ? 'withheld' AND (jsonb_typeof(node -> 'withheld') <> 'array'
                              OR EXISTS (SELECT 1 FROM jsonb_array_elements(node -> 'withheld') w WHERE jsonb_typeof(w.value) <> 'string')) THEN
      RETURN false;
    END IF;
    RETURN true;
  END IF;
  -- Объект вне объявленных путей или с незнакомым полем — отказ
  IF NOT shape ? path OR path = 'reasons' THEN
    RETURN false;
  END IF;
  FOR k, v IN SELECT key, value FROM jsonb_each(node) LOOP
    IF NOT (shape -> path) ? k OR NOT security.explanation_node_declared(v, path || '.' || k, p_competitor_derived) THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
END $$;

CREATE FUNCTION security.explanation_keys_declared(j jsonb, p_competitor_derived boolean) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT security.explanation_node_declared(j, '$', p_competitor_derived) $$;

GRANT EXECUTE ON FUNCTION security.eternal_param_keys(), security.explanation_shape(), security.explanation_node_declared(jsonb, text, boolean),
  security.explanation_keys_declared(jsonb, boolean) TO repracer_app;

-- Строки до миграции: подрез из слепков — прочь той же очисткой, что и производные ключи (0052)
RESET ROLE;
ALTER TABLE channel_data.price_decision DISABLE TRIGGER zz_append_only;
ALTER TABLE tenant_data.price_intent_core DISABLE TRIGGER zz_append_only;
UPDATE channel_data.price_decision
   SET explanation = security.strip_channel_derived(explanation, competitor_derived)
 WHERE explanation IS NOT NULL AND NOT security.explanation_derives_no_channel(explanation, competitor_derived);
UPDATE tenant_data.price_intent_core
   SET explanation = security.strip_channel_derived(explanation, competitor_derived)
 WHERE NOT security.explanation_derives_no_channel(explanation, competitor_derived);
ALTER TABLE channel_data.price_decision ENABLE TRIGGER zz_append_only;
ALTER TABLE tenant_data.price_intent_core ENABLE TRIGGER zz_append_only;
SET ROLE repracer_owner;

ALTER TABLE channel_data.price_decision
  ADD CONSTRAINT price_decision_explanation_keys_declared CHECK (explanation IS NULL OR security.explanation_keys_declared(explanation, competitor_derived));
ALTER TABLE tenant_data.price_intent_core
  ADD CONSTRAINT price_intent_core_explanation_keys_declared CHECK (security.explanation_keys_declared(explanation, competitor_derived));

RESET ROLE;
COMMIT;
