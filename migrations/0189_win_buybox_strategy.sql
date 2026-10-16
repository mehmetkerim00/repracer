-- 0189_win_buybox_strategy.sql
-- Шаг 97 [Р-219, Р-221]: стратегия «Win the Buy Box» и честный держатель Buy Box.
--
-- 1. Тип стратегии WIN_BUYBOX. Подрез и гандикап за исполнение (на сколько ниже, когда победителя исполняет канал, а нас — нет) — в таблице
--    подреза: вместе с ценой решения они раскрывали бы цену конкурента, и вечная версия стратегии их не хранит [Р-91]. Подъём (creepUp,
--    creepStepBp) — настройка продавца, в версии стратегии.
-- 2. Цена WIN_BUYBOX — из данных конкурентов: генерируемые столбцы `competitor_derived` намерения и вечного ядра пересобраны с новым
--    списком. PostgreSQL 16 не меняет выражение генерируемого столбца (SET EXPRESSION — с 17-й версии), поэтому DROP + ADD; два CHECK ядра,
--    зависящие от столбца, возвращаются под прежними именами (строки каталога мутаций держат их же). У решения признак — обычный
--    столбец, который копирует триггер (0032), — его пересборка не касается. Перезаписываются секции намерений (3 суток) и ядра в
--    PostgreSQL (окно ~2 месяца, Р-86); у прежних строк значение не меняется — правила WIN_BUYBOX до этой миграции не было.
--    Остановка витрины [Р-51], требование снимка и скрытие производных от цены конкурента [Р-85] теперь видят WIN_BUYBOX; равенство
--    списка кода и базы держит правило-страж (packages/pricing-store-pg/test/competitor-derived-rules.pg.test.ts).
-- 3. Доступность стратегии [Р-39]: «Match the Buy Box» нужна цена Buy Box, «Win the Buy Box» — держатель. Свойства источника раздельны:
--    у Amazon ANY_OFFER_CHANGED цена есть (Summary.BuyBoxPrices), держателя нет — признака IsBuyBoxWinner в схеме уведомления нет (A-29).
-- 4. Новые коды «без изменения» и реестры параметров слепка (дополняются значением прежних, а не переписываются руками).

BEGIN;
SET ROLE repracer_owner;

-- ---------------------------------------------------------------- 1. Тип стратегии и её подрез с гандикапом
ALTER TABLE tenant_data.pricing_strategy DROP CONSTRAINT pricing_strategy_type_check;
ALTER TABLE tenant_data.pricing_strategy ADD CONSTRAINT pricing_strategy_type_check
  CHECK (type IN ('FIXED', 'MATCH_BUYBOX', 'BEAT_LOWEST', 'TARGET_MARGIN', 'POSITION', 'WIN_BUYBOX'));
-- Р-91: гандикап вместе с ценой решения раскрывает цену конкурента — как подрез, в вечной версии стратегии его нет
ALTER TABLE tenant_data.pricing_strategy
  ADD CONSTRAINT pricing_strategy_handicap_not_eternal CHECK (NOT params ? 'fulfillmentHandicapMinor');

ALTER TABLE channel_data.pricing_strategy_undercut ADD COLUMN fulfillment_handicap_minor bigint;
COMMENT ON COLUMN channel_data.pricing_strategy_undercut.fulfillment_handicap_minor IS
  'Р-219 (шаг 97): гандикап «Win the Buy Box» — на сколько ниже, когда победителя исполняет канал, а нас нет; у прочих типов NULL';
ALTER TABLE channel_data.pricing_strategy_undercut
  ADD CONSTRAINT pricing_strategy_undercut_handicap_non_negative CHECK (fulfillment_handicap_minor IS NULL OR fulfillment_handicap_minor >= 0);

-- Подрез неизменяем; гандикап — тоже (тот же страж, на один столбец больше)
DO $do$
DECLARE
  d text := pg_get_functiondef('channel_data.pricing_strategy_undercut_guard()'::regprocedure);
  a text := 'NEW.undercut_minor, NEW.created_at)';
  b text := 'OLD.undercut_minor, OLD.created_at)';
BEGIN
  IF (length(d) - length(replace(d, a, ''))) / length(a) <> 1 OR (length(d) - length(replace(d, b, ''))) / length(b) <> 1 THEN
    RAISE EXCEPTION '0189: channel_data.pricing_strategy_undercut_guard() is not the definition the migration expects';
  END IF;
  EXECUTE replace(replace(d, a, 'NEW.undercut_minor, NEW.fulfillment_handicap_minor, NEW.created_at)'),
                  b, 'OLD.undercut_minor, OLD.fulfillment_handicap_minor, OLD.created_at)');
END $do$;

-- Стратегия по рынку без подреза не создаётся; «Win the Buy Box» — и без гандикапа (0 — тоже значение, NULL — нет)
CREATE OR REPLACE FUNCTION tenant_data.pricing_strategy_requires_undercut() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.type IN ('MATCH_BUYBOX', 'BEAT_LOWEST', 'WIN_BUYBOX') AND NOT EXISTS (
       SELECT 1 FROM channel_data.pricing_strategy_undercut u
        WHERE u.tenant_id = NEW.tenant_id AND u.pricing_strategy_id = NEW.pricing_strategy_id AND u.version = NEW.version) THEN
    RAISE EXCEPTION 'strategy % version % (%) needs its undercut in channel_data.pricing_strategy_undercut (Р-91)', NEW.pricing_strategy_id, NEW.version, NEW.type
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.type = 'WIN_BUYBOX' AND NOT EXISTS (
       SELECT 1 FROM channel_data.pricing_strategy_undercut u
        WHERE u.tenant_id = NEW.tenant_id AND u.pricing_strategy_id = NEW.pricing_strategy_id AND u.version = NEW.version
          AND u.fulfillment_handicap_minor IS NOT NULL) THEN
    RAISE EXCEPTION 'strategy % version % (WIN_BUYBOX) needs its fulfilment handicap in channel_data.pricing_strategy_undercut (Р-91, Р-219)', NEW.pricing_strategy_id, NEW.version
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END $$;

-- ---------------------------------------------------------------- 2. Цена из данных конкурентов: WIN_BUYBOX
ALTER TABLE channel_data.price_intent DROP COLUMN competitor_derived;
ALTER TABLE channel_data.price_intent
  ADD COLUMN competitor_derived boolean GENERATED ALWAYS AS (coalesce(rule_code IN ('MATCH_BUYBOX', 'BEAT_LOWEST', 'POSITION', 'WIN_BUYBOX'), false)) STORED;

-- Два CHECK ядра зависят от столбца: DROP COLUMN снимает их вместе с ним — возвращаются под прежними именами и с прежним текстом
ALTER TABLE tenant_data.price_intent_core DROP CONSTRAINT price_intent_core_competitor_rejection_not_kept;
ALTER TABLE tenant_data.price_intent_core DROP CONSTRAINT price_intent_core_explanation_keys_declared;
ALTER TABLE tenant_data.price_intent_core DROP COLUMN competitor_derived;
ALTER TABLE tenant_data.price_intent_core
  ADD COLUMN competitor_derived boolean GENERATED ALWAYS AS (coalesce(rule_code = ANY (ARRAY['MATCH_BUYBOX', 'BEAT_LOWEST', 'POSITION', 'WIN_BUYBOX']), false)) STORED;
ALTER TABLE tenant_data.price_intent_core ADD CONSTRAINT price_intent_core_competitor_rejection_not_kept CHECK (
  CASE WHEN competitor_derived AND intent_class = 'REJECTED_BY_GATE'
       THEN proposed_amount_minor IS NULL AND bound_deviation_bp IS NULL AND NOT (reason_params ?| security.channel_rule_derived_param_keys())
       ELSE proposed_amount_minor IS NOT NULL END);
ALTER TABLE tenant_data.price_intent_core
  ADD CONSTRAINT price_intent_core_explanation_keys_declared CHECK (security.explanation_keys_declared(explanation, competitor_derived));

-- Снятие остановки витрины выборкой [Р-52] смотрит предложения со стратегией из данных конкурентов — и WIN_BUYBOX. Функция принадлежит
-- своей узкой роли (repracer_halt_reviewer): заменяется вне роли владельца схемы, владелец при замене сохраняется
RESET ROLE;
DO $do$
DECLARE
  d text := pg_get_functiondef('channel_data.review_halt_by_sample(uuid,uuid,timestamp with time zone)'::regprocedure);
  a text := $s$ps.type IN ('MATCH_BUYBOX', 'BEAT_LOWEST', 'POSITION')$s$;
BEGIN
  IF (length(d) - length(replace(d, a, ''))) / length(a) <> 1 THEN
    RAISE EXCEPTION '0189: channel_data.review_halt_by_sample is not the definition the migration expects';
  END IF;
  EXECUTE replace(d, a, $s$ps.type IN ('MATCH_BUYBOX', 'BEAT_LOWEST', 'POSITION', 'WIN_BUYBOX')$s$);
END $do$;
SET ROLE repracer_owner;

-- ---------------------------------------------------------------- 3. Доступность стратегии: цена Buy Box и держатель — раздельно
ALTER TABLE platform.competitor_source ADD COLUMN has_buybox_price boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN platform.competitor_source.has_buybox_price IS
  'Шаг 97: источник отдаёт цену Buy Box (нужна «Match the Buy Box»); has_buybox_winner — называет держателя (нужен «Win the Buy Box» и доле Buy Box)';
UPDATE platform.competitor_source SET has_buybox_price = true
 WHERE source IN ('KAUFLAND_BUYBOX', 'KAUFLAND_BUY_BOX_CHANGED', 'WALMART_BUY_BOX', 'AMAZON_ANY_OFFER_CHANGED');
-- A-29: схема уведомления ANY_OFFER_CHANGED снимка держателя Buy Box не называет — признака IsBuyBoxWinner в ней нет
UPDATE platform.competitor_source SET has_buybox_winner = false WHERE source = 'AMAZON_ANY_OFFER_CHANGED';

CREATE OR REPLACE FUNCTION channel_data.strategy_unmet(p_channel text, p_params jsonb) RETURNS jsonb
  LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS $fn$
DECLARE
  t          text := p_params ->> 'type';
  req_kind   text;
  min_n      int := 1;
  bb_price   boolean := false;
  bb_winner  boolean := false;
  shipping   boolean := false;
  staleness  int := 900;
  s          record;
  u          text[];
  out        jsonb := '{}'::jsonb;
BEGIN
  IF t IN ('FIXED', 'TARGET_MARGIN') THEN
    RETURN '{}'::jsonb;
  ELSIF t = 'MATCH_BUYBOX' THEN
    req_kind := 'TOP_N'; bb_price := true;
  ELSIF t = 'WIN_BUYBOX' THEN
    -- Шаг 97: держатель Buy Box и доставка — цель от landed-цены победителя
    req_kind := 'TOP_N'; bb_price := true; bb_winner := true; shipping := true;
  ELSIF t = 'BEAT_LOWEST' THEN
    req_kind := CASE WHEN p_params ->> 'scope' = 'MARKET' THEN 'CHEAPEST_ONLY' ELSE 'TOP_N' END;
    shipping := coalesce((p_params ->> 'compareLanded')::boolean, false);
  ELSE
    RETURN jsonb_build_object('*', jsonb_build_array('UNKNOWN_STRATEGY_TYPE'));
  END IF;
  FOR s IN SELECT * FROM platform.competitor_source c WHERE c.channel = p_channel ORDER BY c.source LOOP
    u := '{}';
    IF s.role <> 'PRIMARY' THEN u := u || 'RECONCILIATION_ONLY'::text; END IF;
    IF s.availability <> 'AVAILABLE' THEN u := u || ('AVAILABILITY_' || s.availability)::text; END IF;
    IF NOT (s.completeness_kind = 'FULL'
            OR (req_kind = 'TOP_N' AND s.completeness_kind = 'TOP_N' AND s.completeness_n >= min_n)
            OR (req_kind <> 'TOP_N' AND s.completeness_kind = req_kind)) THEN
      u := u || 'COMPLETENESS'::text;
    END IF;
    IF bb_price AND NOT s.has_buybox_price THEN u := u || 'BUYBOX_PRICE'::text; END IF;
    IF bb_winner AND NOT s.has_buybox_winner THEN u := u || 'BUYBOX_WINNER'::text; END IF;
    IF shipping AND NOT s.has_shipping THEN u := u || 'SHIPPING'::text; END IF;
    IF NOT ('new' = ANY (s.conditions)) THEN u := u || 'CONDITION'::text; END IF;
    IF s.typical_staleness_seconds IS NOT NULL AND s.typical_staleness_seconds > staleness THEN u := u || 'STALENESS'::text; END IF;
    IF cardinality(u) = 0 THEN
      RETURN '{}'::jsonb;
    END IF;
    out := out || jsonb_build_object(s.source, to_jsonb(u));
  END LOOP;
  IF out = '{}'::jsonb THEN
    out := jsonb_build_object('*', jsonb_build_array('NO_COMPETITOR_SOURCE'));
  END IF;
  RETURN out;
END $fn$;

-- ---------------------------------------------------------------- 4. Коды «без изменения» и реестры слепка
ALTER TABLE channel_data.price_decision DROP CONSTRAINT price_decision_no_change_reason_code;
ALTER TABLE channel_data.price_decision ADD CONSTRAINT price_decision_no_change_reason_code CHECK (no_change_reason = ANY (ARRAY[
  'ALREADY_AT_TARGET', 'WITHIN_DEADBAND', 'ALREADY_WINNING_BUYBOX', 'NO_COMPETITOR_OFFERS', 'TARGET_OUTSIDE_BOUNDS_HOLD',
  'SHADOW_ALREADY_PROPOSED', 'LADDER_PACED', 'BUYBOX_HOLDER_UNKNOWN', 'CREEP_PACED', 'CREEP_PAUSED', 'CREEP_AT_MAX']));

DO $do$
DECLARE
  keys jsonb := security.eternal_param_keys();
  kinds jsonb := security.eternal_param_kinds();
  channel text[] := security.channel_param_keys();
  derived jsonb := security.channel_derived_param_keys();
  money jsonb := '{"k":"money"}';
  cur jsonb := '{"k":"currency"}';
  inst jsonb := '{"k":"instant"}';
BEGIN
  IF keys ? 'CREEP_UP' OR kinds ? 'CREEP_UP' OR 'winnerLandedMinor' = ANY (channel) OR derived ? 'BUYBOX_WIN_TARGET'
     OR kinds #> '{INVALID_STRATEGY_PARAMS,param,v}' <> '["deadbandMinor","priceMinor","targetMarginBp","undercutMinor"]'::jsonb
     OR kinds #> '{MARGIN_WITHOUT_COST,strategyType,v}' <> '["FIXED","TARGET_MARGIN","MATCH_BUYBOX","BEAT_LOWEST"]'::jsonb
     OR kinds #> '{CHANNEL_HALTED,ruleCode,v}' <> '["FIXED","TARGET_MARGIN","MATCH_BUYBOX","BEAT_LOWEST","POSITION"]'::jsonb THEN
    RAISE EXCEPTION '0189: the reason registries are not the ones the migration expects';
  END IF;
  keys := keys || jsonb_build_object(
    'BUYBOX_HOLDER_UNKNOWN', '["currency","currentMinor"]'::jsonb, 'BUYBOX_WIN_TARGET', '["currency"]'::jsonb,
    'CAPPED_AT_CREEP_CEILING', '["currency"]'::jsonb, 'CREEP_AT_MAX', '["currency","currentMinor","maxMinor"]'::jsonb,
    'CREEP_PACED', '["currency","currentMinor","nextStepAt"]'::jsonb, 'CREEP_PAUSED', '["currency","currentMinor","pausedUntil"]'::jsonb,
    'CREEP_STEP_BACK', '["backToMinor","currency","pausedUntil"]'::jsonb, 'CREEP_UP', '["creepStepBp","currency","fromMinor","toMinor"]'::jsonb);
  kinds := jsonb_set(jsonb_set(jsonb_set(kinds,
      '{INVALID_STRATEGY_PARAMS,param,v}', '["deadbandMinor","priceMinor","targetMarginBp","undercutMinor","fulfillmentHandicapMinor","creepStepBp"]'),
      '{MARGIN_WITHOUT_COST,strategyType,v}', '["FIXED","TARGET_MARGIN","MATCH_BUYBOX","BEAT_LOWEST","WIN_BUYBOX"]'),
      '{CHANNEL_HALTED,ruleCode,v}', '["FIXED","TARGET_MARGIN","MATCH_BUYBOX","BEAT_LOWEST","POSITION","WIN_BUYBOX"]')
    || jsonb_build_object(
      'BUYBOX_HOLDER_UNKNOWN', jsonb_build_object('currentMinor', money, 'currency', cur),
      'BUYBOX_WIN_TARGET', jsonb_build_object('currency', cur),
      'CAPPED_AT_CREEP_CEILING', jsonb_build_object('currency', cur),
      'CREEP_AT_MAX', jsonb_build_object('currentMinor', money, 'maxMinor', money, 'currency', cur),
      'CREEP_PACED', jsonb_build_object('currentMinor', money, 'nextStepAt', inst, 'currency', cur),
      'CREEP_PAUSED', jsonb_build_object('currentMinor', money, 'pausedUntil', inst, 'currency', cur),
      'CREEP_STEP_BACK', jsonb_build_object('backToMinor', money, 'pausedUntil', inst, 'currency', cur),
      'CREEP_UP', jsonb_build_object('fromMinor', money, 'toMinor', money, 'creepStepBp', '{"k":"bp"}'::jsonb, 'currency', cur));
  -- Ключи класса CHANNEL — в порядке кода (по кодовым единицам, COLLATE "C"); производные — по кодам
  channel := ARRAY(SELECT x FROM (SELECT DISTINCT x FROM unnest(channel || ARRAY['ownShippingMinor', 'winnerFulfilment', 'winnerLandedMinor']) x) d ORDER BY x COLLATE "C");
  derived := derived || '{"BUYBOX_WIN_TARGET": ["handicapMinor", "targetMinor", "undercutMinor"], "CAPPED_AT_CREEP_CEILING": ["ceilingMinor", "targetMinor"], "CREEP_STEP_BACK": ["lostAtMinor"]}'::jsonb;
  EXECUTE format($f$CREATE OR REPLACE FUNCTION security.eternal_param_keys() RETURNS jsonb
    LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $b$ SELECT %L::jsonb $b$$f$, keys);
  EXECUTE format($f$CREATE OR REPLACE FUNCTION security.eternal_param_kinds() RETURNS jsonb
    LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $b$ SELECT %L::jsonb $b$$f$, kinds);
  EXECUTE format($f$CREATE OR REPLACE FUNCTION security.channel_param_keys() RETURNS text[]
    LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $b$ SELECT %L::text[] $b$$f$, channel);
  EXECUTE format($f$CREATE OR REPLACE FUNCTION security.channel_derived_param_keys() RETURNS jsonb
    LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $b$ SELECT %L::jsonb $b$$f$, derived);
END $do$;

RESET ROLE;
COMMIT;
