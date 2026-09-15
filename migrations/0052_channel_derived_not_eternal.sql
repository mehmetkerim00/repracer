-- 0052_channel_derived_not_eternal.sql
-- Шаг 15, Р-85: вечное ядро не должно позволять ВОССТАНОВИТЬ данные канала. До этой миграции ядро intent хранило величины,
-- из которых цена конкурента выводится точно (перебор — packages/pricing-model/src/r85.test.ts, доказательство до исправления —
-- docs/evidence/step15-r85-before.log):
--   - цели стратегий по рынку (targetMinor = Buy Box − подрез; неограниченная цель при упоре в границу);
--   - разницу с целью в мёртвой зоне (deltaMinor);
--   - у отклонённой цены из данных конкурентов — предложенную цену, отклонение от границы, шаг (столбцы и параметры причины).
-- Что остаётся: опубликованная цена CHANGED — наша цена [Р-3], хранится вечно для Omnibus [Р-21]. Из неё и подреза стратегии
-- цена конкурента выводится, если цена не упёрлась в границу, — это свойство самой цены, вопрос владельцу (OQ-142).
--
-- Реестр производных ключей — security.channel_derived_param_keys() (по кодам причин) и security.channel_rule_derived_param_keys()
-- (для цены из данных конкурентов при любом коде); совпадение с кодом (CHANNEL_DERIVED_PARAM_KEYS, COMPETITOR_RULE_DERIVED_KEYS)
-- проверяет packages/pricing-store-pg/test/channel-derived.pg.test.ts. Строки, записанные до миграции, очищаются той же функцией.

BEGIN;
SET ROLE repracer_owner;

-- ---------------------------------------------------------------------------
-- 1. Реестр и очистка
-- ---------------------------------------------------------------------------
CREATE FUNCTION security.channel_derived_param_keys() RETURNS jsonb
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT '{"ALREADY_AT_TARGET":["targetMinor"],"BUYBOX_MATCH":["targetMinor"],"BUYBOX_UNDERCUT":["targetMinor"],"CAPPED_AT_MAX_PRICE":["targetMinor"],"CAPPED_AT_MIN_PRICE":["targetMinor"],"LOWEST_MATCH":["targetMinor"],"LOWEST_UNDERCUT":["targetMinor"],"TARGET_OUTSIDE_BOUNDS_HOLD":["targetMinor"],"WITHIN_DEADBAND":["deltaMinor"]}'::jsonb
$$;

CREATE FUNCTION security.channel_rule_derived_param_keys() RETURNS text[]
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['amountMinor', 'deviationBp', 'proposedMinor', 'stepBp']::text[]
$$;

-- Ключи, запрещённые в параметрах причины: по коду; у цены из данных конкурентов — ещё и производные от предложенной цены
CREATE FUNCTION security.derived_keys_for(p_code text, p_competitor_derived boolean) RETURNS text[]
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY(SELECT jsonb_array_elements_text(coalesce(security.channel_derived_param_keys() -> p_code, '[]')))
         || CASE WHEN p_competitor_derived THEN security.channel_rule_derived_param_keys() ELSE '{}'::text[] END
$$;

-- Нет ли в слепке причины с производным ключом (обход всех вложенных объектов с code и params)
CREATE FUNCTION security.explanation_derives_no_channel(j jsonb, p_competitor_derived boolean) RETURNS boolean
  LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  v jsonb;
BEGIN
  IF j IS NULL OR jsonb_typeof(j) NOT IN ('object', 'array') THEN
    RETURN true;
  END IF;
  IF jsonb_typeof(j) = 'object' AND jsonb_typeof(j -> 'code') = 'string' AND jsonb_typeof(j -> 'params') = 'object'
     AND (j -> 'params') ?| security.derived_keys_for(j ->> 'code', p_competitor_derived) THEN
    RETURN false;
  END IF;
  FOR v IN SELECT value FROM jsonb_each(CASE WHEN jsonb_typeof(j) = 'object' THEN j ELSE '{}'::jsonb END)
           UNION ALL SELECT value FROM jsonb_array_elements(CASE WHEN jsonb_typeof(j) = 'array' THEN j ELSE '[]'::jsonb END) LOOP
    IF NOT security.explanation_derives_no_channel(v, p_competitor_derived) THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
END $$;

-- Очистка слепка для строк до миграции — как explainedReason: производные ключи по коду не перечисляются (их даёт реестр),
-- производные от предложенной цены — в withheld
CREATE FUNCTION security.strip_channel_derived(j jsonb, p_competitor_derived boolean) RETURNS jsonb
  LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  k        text;
  v        jsonb;
  result   jsonb;
  params   jsonb;
  by_rule  text[];
  removed  text[];
BEGIN
  IF j IS NULL THEN
    RETURN NULL;
  END IF;
  IF jsonb_typeof(j) = 'array' THEN
    SELECT coalesce(jsonb_agg(security.strip_channel_derived(e, p_competitor_derived) ORDER BY o), '[]'::jsonb) INTO result
      FROM jsonb_array_elements(j) WITH ORDINALITY AS a(e, o);
    RETURN result;
  END IF;
  IF jsonb_typeof(j) <> 'object' THEN
    RETURN j;
  END IF;
  result := '{}'::jsonb;
  FOR k, v IN SELECT key, value FROM jsonb_each(j) LOOP
    result := result || jsonb_build_object(k, security.strip_channel_derived(v, p_competitor_derived));
  END LOOP;
  IF jsonb_typeof(result -> 'code') = 'string' AND jsonb_typeof(result -> 'params') = 'object' THEN
    params := result -> 'params';
    removed := ARRAY(SELECT key FROM jsonb_object_keys(params) AS key WHERE key = ANY (security.derived_keys_for(result ->> 'code', p_competitor_derived)));
    IF cardinality(removed) > 0 THEN
      params := params - removed;
      by_rule := ARRAY(SELECT x FROM unnest(removed) AS x WHERE p_competitor_derived AND x = ANY (security.channel_rule_derived_param_keys()));
      result := (result - 'params') || CASE WHEN params = '{}'::jsonb THEN '{}'::jsonb ELSE jsonb_build_object('params', params) END;
      IF cardinality(by_rule) > 0 THEN
        result := result || jsonb_build_object('withheld', (
          SELECT jsonb_agg(DISTINCT w ORDER BY w) FROM (
            SELECT jsonb_array_elements_text(coalesce(result -> 'withheld', '[]'::jsonb)) AS w UNION SELECT unnest(by_rule)) x));
      END IF;
    END IF;
  END IF;
  RETURN result;
END $$;

GRANT EXECUTE ON FUNCTION security.channel_derived_param_keys(), security.channel_rule_derived_param_keys(), security.derived_keys_for(text, boolean),
  security.explanation_derives_no_channel(jsonb, boolean), security.strip_channel_derived(jsonb, boolean) TO repracer_app;

-- ---------------------------------------------------------------------------
-- 2. Ядро: признак цены из данных конкурентов; предложенная цена и отклонение отклонённой цены не хранятся
-- ---------------------------------------------------------------------------
ALTER TABLE tenant_data.price_intent_core
  ADD COLUMN competitor_derived boolean GENERATED ALWAYS AS (coalesce(rule_code = ANY (ARRAY['MATCH_BUYBOX', 'BEAT_LOWEST', 'POSITION']), false)) STORED,
  ALTER COLUMN proposed_amount_minor DROP NOT NULL,
  -- «Опасное» [Р-73] остаётся флагом; отклонение, по которому оно вычислено, у цены из данных конкурентов вечно не хранится.
  -- Генерируемый столбец заменяется обычным (DROP EXPRESSION на секционированной таблице PostgreSQL 16 не выполняет)
  ADD COLUMN dangerous_kept boolean NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------
-- 3. Строки до миграции: та же очистка (в выпуске данных нет; на стенде — есть). Append-only снимается только на время миграции
-- ---------------------------------------------------------------------------
RESET ROLE;
ALTER TABLE channel_data.price_decision DISABLE TRIGGER zz_append_only;
ALTER TABLE tenant_data.price_intent_core DISABLE TRIGGER zz_append_only;

-- Флаг «опасное» — из отклонения, пока оно ещё есть
UPDATE tenant_data.price_intent_core SET dangerous_kept = dangerous WHERE dangerous;
ALTER TABLE tenant_data.price_intent_core DROP COLUMN dangerous;
ALTER TABLE tenant_data.price_intent_core RENAME COLUMN dangerous_kept TO dangerous;

UPDATE channel_data.price_decision
   SET explanation = security.strip_channel_derived(explanation, competitor_derived)
 WHERE explanation IS NOT NULL AND NOT security.explanation_derives_no_channel(explanation, competitor_derived);

UPDATE tenant_data.price_intent_core
   SET explanation = security.strip_channel_derived(explanation, competitor_derived),
       proposed_amount_minor = CASE WHEN competitor_derived AND intent_class = 'REJECTED_BY_GATE' THEN NULL ELSE proposed_amount_minor END,
       bound_deviation_bp = CASE WHEN competitor_derived AND intent_class = 'REJECTED_BY_GATE' THEN NULL ELSE bound_deviation_bp END,
       reason_params = CASE WHEN competitor_derived AND intent_class = 'REJECTED_BY_GATE' THEN reason_params - security.channel_rule_derived_param_keys() ELSE reason_params END
 WHERE NOT security.explanation_derives_no_channel(explanation, competitor_derived)
    OR (competitor_derived AND intent_class = 'REJECTED_BY_GATE'
        AND (proposed_amount_minor IS NOT NULL OR bound_deviation_bp IS NOT NULL OR reason_params ?| security.channel_rule_derived_param_keys()));

ALTER TABLE channel_data.price_decision ENABLE TRIGGER zz_append_only;
ALTER TABLE tenant_data.price_intent_core ENABLE TRIGGER zz_append_only;
SET ROLE repracer_owner;

CREATE OR REPLACE FUNCTION channel_data.price_decision_record_core() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  hidden boolean;
BEGIN
  IF NEW.intent_class <> 'NO_OP' THEN
    hidden := NEW.competitor_derived AND NEW.intent_class = 'REJECTED_BY_GATE';
    INSERT INTO tenant_data.price_intent_core
      (tenant_id, price_intent_id, intent_created_at, write_scope_id, pricing_strategy_id, pricing_strategy_version,
       trigger_type, rule_code, proposed_amount_minor, currency, price_basis, intent_class, price_decision_id,
       decision_outcome, final_amount_minor, effective_floor_minor, effective_ceiling_minor, violations, decided_at,
       rejection_reason, reason_params, explanation, bound_deviation_bp, dangerous, sanity_ruleset, gate_profile)
    SELECT i.tenant_id, i.price_intent_id, i.created_at, i.write_scope_id, i.pricing_strategy_id, i.pricing_strategy_version,
           i.trigger_type, i.rule_code, CASE WHEN hidden THEN NULL ELSE i.proposed_amount_minor END, i.currency, i.price_basis, NEW.intent_class,
           NEW.price_decision_id, NEW.outcome, NEW.final_amount_minor, NEW.effective_floor_minor,
           NEW.effective_ceiling_minor, NEW.violations, NEW.decided_at, NEW.rejection_reason,
           CASE WHEN hidden THEN NEW.reason_params - security.channel_rule_derived_param_keys() ELSE NEW.reason_params END,
           NEW.explanation, CASE WHEN hidden THEN NULL ELSE NEW.bound_deviation_bp END, coalesce(NEW.bound_deviation_bp > 1000, false),
           NEW.sanity_ruleset, NEW.gate_profile
      FROM channel_data.price_intent i
     WHERE i.tenant_id = NEW.tenant_id AND i.created_at = NEW.intent_created_at
       AND i.price_intent_id = NEW.price_intent_id;
  END IF;
  RETURN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- 4. Инвариант в БД
-- ---------------------------------------------------------------------------
ALTER TABLE channel_data.price_decision
  ADD CONSTRAINT price_decision_explanation_derives_no_channel CHECK (explanation IS NULL OR security.explanation_derives_no_channel(explanation, competitor_derived)),
  -- Слепок без итоговой причины стратегии не объясним ни из решения, ни из архива (развёртывание падало на таких строках)
  ADD CONSTRAINT price_decision_explanation_reason_present CHECK (
    explanation IS NULL OR coalesce(jsonb_typeof(explanation #> '{strategy,reason}') = 'object' AND jsonb_typeof(explanation #> '{strategy,reason,code}') = 'string', false));

ALTER TABLE tenant_data.price_intent_core
  ADD CONSTRAINT price_intent_core_explanation_derives_no_channel CHECK (security.explanation_derives_no_channel(explanation, competitor_derived)),
  ADD CONSTRAINT price_intent_core_competitor_rejection_not_kept CHECK (CASE
    WHEN competitor_derived AND intent_class = 'REJECTED_BY_GATE'
      THEN proposed_amount_minor IS NULL AND bound_deviation_bp IS NULL AND NOT reason_params ?| security.channel_rule_derived_param_keys()
    ELSE proposed_amount_minor IS NOT NULL
  END),
  ADD CONSTRAINT price_intent_core_dangerous_consistent CHECK (bound_deviation_bp IS NULL OR dangerous = (bound_deviation_bp > 1000)),
  ADD CONSTRAINT price_intent_core_explanation_reason_present CHECK (
    coalesce(jsonb_typeof(explanation #> '{strategy,reason}') = 'object' AND jsonb_typeof(explanation #> '{strategy,reason,code}') = 'string', false));

RESET ROLE;
COMMIT;
