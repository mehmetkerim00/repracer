-- 0070: шаг 18, находка 8 ревью шага 17 — виды значений проверяются у КАЖДОГО скалярного поля слепка r80.1, а не только у
-- параметров причин. Поле без объявленного вида отклоняется (fail-closed). Виды ужесточены: валюта — EUR или USD (Р-57),
-- идентификатор — без пробелов и не длиннее 128 знаков, счётчики и длительности — неотрицательны, момент — действительная дата
-- ISO 8601, коэффициент — от 0 до 1000. В вечное ядро больше нельзя записать произвольный текст или число (Р-85).

BEGIN;
SET ROLE repracer_owner;

-- Сгенерировано из EXPLANATION_FIELD_KINDS (explanation.ts); совпадение с кодом проверяет undercut-eternal.pg.test.ts
CREATE FUNCTION security.explanation_field_kinds() RETURNS jsonb
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT '{"$.context.channelHalt.haltedAt":{"k":"instant"},"$.context.channelHalt.haltId":{"k":"uuid"},"$.context.channelHalt.marketplace":{"k":"id","n":true},"$.context.channelHalt.reasonCode":{"k":"enum","v":["CHANNEL_MASS_SHIFT"]},"$.context.priceStop.channelAccountId":{"k":"uuid","n":true},"$.context.priceStop.marketplace":{"k":"id","n":true},"$.context.priceStop.scope":{"k":"enum","v":["TENANT","CHANNEL_ACCOUNT","STOREFRONT"]},"$.context.priceStop.stopId":{"k":"uuid"},"$.context.priceStop.stoppedAt":{"k":"instant"},"$.context.priceStop.stoppedByMembershipId":{"k":"uuid"},"$.format":{"k":"enum","v":["r80.1"]},"$.gate.failed.check":{"k":"code"},"$.gate.fx.base":{"k":"enum","v":["EUR"]},"$.gate.fx.convertedAmountMinor":{"k":"money"},"$.gate.fx.from":{"k":"currency"},"$.gate.fx.quote":{"k":"currency"},"$.gate.fx.rateDate":{"k":"date"},"$.gate.fx.rateMicros":{"k":"rateMicros"},"$.gate.fx.rounding":{"k":"enum","v":["UP","NEAREST"]},"$.gate.fx.source":{"k":"enum","v":["ECB"]},"$.gate.fx.sourceAmountMinor":{"k":"money"},"$.gate.fx.to":{"k":"currency"},"$.gate.minMarginBp":{"k":"bp"},"$.sanity.anchorsUsed":{"k":"codeList"},"$.sanity.checks[].outcome":{"k":"enum","v":["PASS","FAIL","SKIPPED"]},"$.sanity.checks[].rule":{"k":"enum","v":["CHANNEL_HALTED","STRUCTURE","FRESHNESS","CHANNEL_MASS_SHIFT","UNIT_SCALE","COST_ANCHOR","INTERNAL_ANCHOR","CROSS_CHANNEL_ANCHOR","HISTORY_ANCHOR"]},"$.snapshot.source":{"k":"code"},"$.strategy.boundsAtStrategy.currency":{"k":"currency"},"$.strategy.boundsAtStrategy.maxMinor":{"k":"money"},"$.strategy.boundsAtStrategy.minMinor":{"k":"money"},"$.strategy.currency":{"k":"currency"},"$.strategy.currentMinor":{"k":"money","n":true},"$.strategy.intentClass":{"k":"enum","v":["NO_OP"]}}'::jsonb
$$;

CREATE OR REPLACE FUNCTION security.param_value_valid(v jsonb, spec jsonb) RETURNS boolean
  LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  t text := jsonb_typeof(v);
  s text := v #>> '{}';
BEGIN
  IF spec IS NULL THEN
    RETURN false;
  END IF;
  IF t = 'null' THEN
    RETURN coalesce((spec ->> 'n')::boolean, false);
  END IF;
  CASE spec ->> 'k'
    WHEN 'money', 'bp', 'rateMicros' THEN
      RETURN t = 'number' AND v::text ~ '^-?[0-9]+$';
    WHEN 'count', 'seconds', 'minutes' THEN
      RETURN t = 'number' AND v::text ~ '^[0-9]+$';
    WHEN 'ratio' THEN
      RETURN t = 'number' AND (v::text)::numeric BETWEEN 0 AND 1000;
    WHEN 'currency' THEN
      RETURN t = 'string' AND s IN ('EUR', 'USD');
    WHEN 'instant' THEN
      IF t <> 'string' OR s !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$' THEN
        RETURN false;
      END IF;
      BEGIN
        PERFORM s::timestamptz;
        RETURN true;
      EXCEPTION WHEN others THEN
        RETURN false;
      END;
    WHEN 'date' THEN
      IF t <> 'string' OR s !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
        RETURN false;
      END IF;
      BEGIN
        PERFORM s::date;
        RETURN true;
      EXCEPTION WHEN others THEN
        RETURN false;
      END;
    WHEN 'id' THEN
      RETURN t = 'string' AND s ~ '^[A-Za-z0-9_.:@-]{1,128}$';
    WHEN 'uuid' THEN
      RETURN t = 'string' AND s ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
    WHEN 'code' THEN
      RETURN t = 'string' AND s ~ '^[A-Z][A-Z0-9_]{0,63}$';
    WHEN 'codeList' THEN
      RETURN t = 'array' AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v) e
                                          WHERE jsonb_typeof(e.value) <> 'string' OR (e.value #>> '{}') !~ '^[A-Z][A-Z0-9_]{0,63}$');
    WHEN 'enum' THEN
      RETURN t = 'string' AND (NOT spec ? 'v' OR (spec -> 'v') ? s);
    WHEN 'enumList' THEN
      RETURN t = 'array' AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v) e
                                          WHERE jsonb_typeof(e.value) <> 'string' OR (spec ? 'v' AND NOT (spec -> 'v') ? (e.value #>> '{}')));
    WHEN 'storefrontList' THEN
      RETURN t = 'array' AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v) e
                                          WHERE jsonb_typeof(e.value) <> 'string' OR (e.value #>> '{}') !~ '^[A-Za-z0-9_.:@-]{1,128}$');
    WHEN 'bool' THEN
      RETURN t = 'boolean';
    WHEN 'userText' THEN
      RETURN t = 'string' AND length(s) <= 2000;
    ELSE
      RETURN false;
  END CASE;
END $$;

CREATE OR REPLACE FUNCTION security.explanation_node_declared(node jsonb, path text, p_competitor_derived boolean) RETURNS boolean
  LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  shape   jsonb := security.explanation_shape();
  fields  jsonb := security.explanation_field_kinds();
  kinds   jsonb;
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
      kinds := security.eternal_param_kinds() -> (node ->> 'code');
      FOR k, v IN SELECT key, value FROM jsonb_each(node -> 'params') LOOP
        IF NOT (security.eternal_param_keys() -> (node ->> 'code')) ? k OR (p_competitor_derived AND k = ANY (security.channel_rule_derived_param_keys()))
           OR NOT security.param_value_valid(v, kinds -> k) THEN
          RETURN false;
        END IF;
      END LOOP;
    END IF;
    IF node ? 'withheld' AND (jsonb_typeof(node -> 'withheld') <> 'array'
                              OR EXISTS (SELECT 1 FROM jsonb_array_elements(node -> 'withheld') w
                                          WHERE jsonb_typeof(w.value) <> 'string' OR (w.value #>> '{}') !~ '^[A-Za-z][A-Za-z0-9_]{0,63}$')) THEN
      RETURN false;
    END IF;
    RETURN true;
  END IF;
  IF NOT shape ? path OR path = 'reasons' THEN
    RETURN false;
  END IF;
  -- Формат — поле с видом enum ['r80.1'] (реестр полей); отдельной проверки нет: мутационная проверка показала, что она дублировала вид поля
  IF path = '$' AND NOT node ? 'format' THEN
    RETURN false;
  END IF;
  FOR k, v IN SELECT key, value FROM jsonb_each(node) LOOP
    IF NOT (shape -> path) ? k THEN
      RETURN false;
    END IF;
    -- Находка 8: скалярное поле и массив скаляров проверяются по виду; объекты и массивы объектов — по форме, рекурсивно
    -- (массив — по форме, если форма объявляет его элементы, даже пустой; иначе это массив скаляров с видом, как anchorsUsed)
    IF jsonb_typeof(v) = 'object'
       OR (jsonb_typeof(v) = 'array' AND (shape ? (path || '.' || k || '[]') OR (shape -> 'reasons') ? (path || '.' || k || '[]'))) THEN
      IF NOT security.explanation_node_declared(v, path || '.' || k, p_competitor_derived) THEN
        RETURN false;
      END IF;
    ELSIF NOT security.param_value_valid(v, fields -> (path || '.' || k)) THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
END $$;
RESET ROLE;

GRANT EXECUTE ON FUNCTION security.explanation_field_kinds() TO repracer_app;

COMMIT;
