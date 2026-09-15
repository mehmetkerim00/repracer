-- 0044_explanation_dictionary.sql
-- Шаг 13: размер слепка объяснения.
--  Р-74: слепок — у решений CHANGED и REJECTED_BY_GATE; у NO_OP слепка нет, только код причины.
--  Р-75: повторяющиеся части слепка — в справочниках: порядок проверок Gate и порядок правил с порогами проверки входов —
--        platform.explanation_ruleset (неизменяем), параметры стратегии — tenant_data.pricing_strategy по версии.
-- Миграция предполагает отсутствие production-данных (как шаг 4): слепки формата r68.1 не переводятся.

BEGIN;

-- Проверка до SET ROLE: от суперпользователя RLS не скрывает строки
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM channel_data.price_decision) OR EXISTS (SELECT 1 FROM tenant_data.price_intent_core) THEN
    RAISE EXCEPTION '0044: price decisions exist; explanations of format r68.1 are not converted (pre-production migration)';
  END IF;
END $$;

SET ROLE repracer_owner;

-- ---------------------------------------------------------------------------
-- 1. Справочник слепка [Р-75]
-- ---------------------------------------------------------------------------
CREATE TABLE platform.explanation_ruleset (
  tenant_id  uuid NOT NULL DEFAULT security.platform_tenant_id() CHECK (tenant_id = security.platform_tenant_id()),
  ruleset_id text PRIMARY KEY CHECK (ruleset_id ~ '^[a-z][0-9]+\.[0-9]+$'),
  kind       text NOT NULL CHECK (kind IN ('SANITY', 'GATE')),
  definition jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Вид различим по идентификатору: профиль Gate — «g…», набор правил проверки входов — «r…»; ссылка решения не перепутает вид
  CHECK ((kind = 'GATE') = (ruleset_id LIKE 'g%')),
  CHECK (kind <> 'SANITY' OR (jsonb_typeof(definition -> 'rules') = 'array' AND jsonb_typeof(definition -> 'config') = 'object')),
  CHECK (kind <> 'GATE' OR (jsonb_typeof(definition -> 'CHANGED') = 'array' AND jsonb_typeof(definition -> 'NO_OP') = 'array'))
);

SELECT security.register_table('platform.explanation_ruleset', 'PLATFORM', 'reference', 'none');
CREATE POLICY explanation_ruleset_read ON platform.explanation_ruleset FOR SELECT TO repracer_app
  USING (tenant_id = security.platform_tenant_id());
CREATE POLICY explanation_ruleset_owner_load ON platform.explanation_ruleset TO repracer_owner
  USING (tenant_id = security.platform_tenant_id()) WITH CHECK (tenant_id = security.platform_tenant_id());
-- Версия справочника неизменяема: старые слепки объясняются теми же порогами и тем же порядком; изменение — новая версия
CREATE TRIGGER explanation_ruleset_immutable BEFORE UPDATE OR DELETE ON platform.explanation_ruleset
  FOR EACH ROW EXECUTE FUNCTION security.forbid_mutation();

-- Строки совпадают с SANITY_RULESET (@repracer/input-sanity) и GATE_PROFILE (@repracer/price-gate) — проверяет тест step13.pg.test.ts
INSERT INTO platform.explanation_ruleset (ruleset_id, kind, definition) VALUES
  ('r49.1', 'SANITY', '{"rules":["CHANNEL_HALTED","STRUCTURE","FRESHNESS","CHANNEL_MASS_SHIFT","UNIT_SCALE","COST_ANCHOR","INTERNAL_ANCHOR","CROSS_CHANNEL_ANCHOR","HISTORY_ANCHOR"],"config":{"SNAPSHOT_FROM_FUTURE":{"maxSkewSeconds":300},"SNAPSHOT_TOO_OLD":{"maxAgeSeconds":3600},"CHANNEL_MASS_SHIFT":{"windowMinutes":15,"maxSpread":0.005},"MARKET_SHIFT_DISPERSED":{"windowMinutes":15,"maxSpread":0.005},"MARKET_SHIFT_SINGLE_SELLER":{"windowMinutes":15,"maxSpread":0.005},"DISPERSED_MARKET_EVENT":{"maxSpread":0.005},"SHIFT_BELOW_SHARE":{"minProducts":10,"share":0.8},"SMALL_MOVE":{"minFactor":1.15},"PRICE_BELOW_COST_ANCHOR":{"limit":0.3333333333333333},"PRICE_ABOVE_COST_ANCHOR":{"limit":20},"TOO_FEW_COMPETITOR_OFFERS":{"minOffers":3},"SNAPSHOT_INTERNAL_OUTLIER":{"outlierFactor":5},"NO_FRESH_CROSS_CHANNEL_REFERENCE":{"maxAgeSeconds":604800},"CROSS_CHANNEL_MISMATCH":{"limit":4},"HISTORY_TOO_SHORT":{"minHistoryDays":7},"OUTSIDE_HISTORY_BAND":{"bandFactor":3},"NO_PLAUSIBILITY_ANCHOR":{"minOffers":3,"minHistoryDays":7},"OWN_PRICE_DEVIATION":{"limit":5},"SELF_OFFER_DIVERGENCE":{"limit":1.5}}}'),
  ('g74.1', 'GATE', '{"CHANGED":["PRICE_STOP","SCOPE","CHANNEL_HALT","INTENT","BOUNDS_RESOLVED","MARGIN_FLOOR","LOWER_BOUND","UPPER_BOUND","STEP","RATE","FINAL_RECHECK"],"NO_OP":["PRICE_STOP","SCOPE","CHANNEL_HALT","INTENT","BOUNDS_RESOLVED","MARGIN_FLOOR","CURRENT_WITHIN_BOUNDS"]}');

-- ---------------------------------------------------------------------------
-- 2. Решение: слепок по классу [Р-74], ссылки на справочник [Р-75]
-- ---------------------------------------------------------------------------
ALTER TABLE channel_data.price_decision
  DROP CONSTRAINT price_decision_explanation_present,
  DROP CONSTRAINT price_decision_explanation_competitor_inputs,
  ADD COLUMN no_change_reason text,
  ADD COLUMN sanity_ruleset text REFERENCES platform.explanation_ruleset (ruleset_id),
  ADD COLUMN gate_profile text REFERENCES platform.explanation_ruleset (ruleset_id);

ALTER TABLE channel_data.price_decision
  -- coalesce: CHECK с NULL-результатом строку пропускает
  ADD CONSTRAINT price_decision_explanation_by_class CHECK (coalesce(CASE
    WHEN intent_class = 'NO_OP' THEN explanation IS NULL AND no_change_reason IS NOT NULL AND sanity_ruleset IS NULL AND gate_profile IS NULL
    ELSE no_change_reason IS NULL AND jsonb_typeof(explanation) = 'object' AND explanation ->> 'format' = 'r74.1' AND explanation ?& ARRAY['strategy', 'gate']
         AND gate_profile LIKE 'g%' AND gate_profile = explanation -> 'gate' ->> 'profile'
         AND (sanity_ruleset IS NULL OR sanity_ruleset LIKE 'r%') AND sanity_ruleset IS NOT DISTINCT FROM explanation -> 'sanity' ->> 'ruleset'
  END, false)),
  -- Код причины NO_OP — из реестра причин движка
  ADD CONSTRAINT price_decision_no_change_reason_code CHECK (
    no_change_reason IN ('ALREADY_AT_TARGET', 'WITHIN_DEADBAND', 'ALREADY_WINNING_BUYBOX', 'NO_COMPETITOR_OFFERS', 'TARGET_OUTSIDE_BOUNDS_HOLD')),
  -- Цена из данных конкурентов объясняется снимком и проверкой входов (у NO_OP слепка нет)
  ADD CONSTRAINT price_decision_explanation_competitor_inputs CHECK (
    intent_class = 'NO_OP' OR NOT competitor_derived
    OR coalesce(jsonb_typeof(explanation -> 'snapshot') = 'object' AND jsonb_typeof(explanation -> 'sanity') = 'object', false));

-- ---------------------------------------------------------------------------
-- 3. Вечное ядро: те же ссылки; версия стратегии слепка — существующая версия справочника стратегий
-- ---------------------------------------------------------------------------
ALTER TABLE tenant_data.price_intent_core
  DROP CONSTRAINT price_intent_core_explanation_present,
  ADD COLUMN sanity_ruleset text REFERENCES platform.explanation_ruleset (ruleset_id),
  ADD COLUMN gate_profile text REFERENCES platform.explanation_ruleset (ruleset_id);

ALTER TABLE tenant_data.price_intent_core
  ADD CONSTRAINT price_intent_core_explanation_present CHECK (coalesce(
    jsonb_typeof(explanation) = 'object' AND explanation ->> 'format' = 'r74.1' AND gate_profile LIKE 'g%' AND gate_profile = explanation -> 'gate' ->> 'profile'
    AND (sanity_ruleset IS NULL OR sanity_ruleset LIKE 'r%') AND sanity_ruleset IS NOT DISTINCT FROM explanation -> 'sanity' ->> 'ruleset', false)),
  ADD CONSTRAINT price_intent_core_explanation_strategy CHECK (coalesce(
    (explanation -> 'strategy' ->> 'strategyId') IS NOT DISTINCT FROM pricing_strategy_id::text
    AND (explanation -> 'strategy' ->> 'version')::int IS NOT DISTINCT FROM pricing_strategy_version, false)),
  -- Параметры стратегии слепок не хранит: версия обязана остаться в справочнике, пока живёт ядро
  ADD CONSTRAINT price_intent_core_strategy_version_fk FOREIGN KEY (tenant_id, pricing_strategy_id, pricing_strategy_version)
    REFERENCES tenant_data.pricing_strategy (tenant_id, pricing_strategy_id, version);

CREATE OR REPLACE FUNCTION channel_data.price_decision_record_core() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.intent_class <> 'NO_OP' THEN
    INSERT INTO tenant_data.price_intent_core
      (tenant_id, price_intent_id, intent_created_at, write_scope_id, pricing_strategy_id, pricing_strategy_version,
       trigger_type, rule_code, proposed_amount_minor, currency, price_basis, intent_class, price_decision_id,
       decision_outcome, final_amount_minor, effective_floor_minor, effective_ceiling_minor, violations, decided_at,
       rejection_reason, reason_params, explanation, bound_deviation_bp, sanity_ruleset, gate_profile)
    SELECT i.tenant_id, i.price_intent_id, i.created_at, i.write_scope_id, i.pricing_strategy_id, i.pricing_strategy_version,
           i.trigger_type, i.rule_code, i.proposed_amount_minor, i.currency, i.price_basis, NEW.intent_class,
           NEW.price_decision_id, NEW.outcome, NEW.final_amount_minor, NEW.effective_floor_minor,
           NEW.effective_ceiling_minor, NEW.violations, NEW.decided_at, NEW.rejection_reason, NEW.reason_params,
           NEW.explanation, NEW.bound_deviation_bp, NEW.sanity_ruleset, NEW.gate_profile
      FROM channel_data.price_intent i
     WHERE i.tenant_id = NEW.tenant_id AND i.created_at = NEW.intent_created_at
       AND i.price_intent_id = NEW.price_intent_id;
  END IF;
  RETURN NULL;
END $$;

RESET ROLE;
COMMIT;
