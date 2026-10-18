-- 0195_anchor_and_compete_with.sql
-- Шаг 101 [Р-226]: ориентир цены и фильтр конкурентов по исполнению — две настройки конкурентных стратегий (отзыв клиента).
--
-- 1. Ориентир (anchor: BUYBOX / LOWEST / LOWER_OF_TWO) — у «Beat the lowest» и «Win the Buy Box»; фильтр (compete_with: ALL / CHANNEL /
--    MERCHANT) — у них и у «Match the Buy Box». Решение владельца: обе настройки — рядом с подрезом и гандикапом (18 месяцев после замены
--    версии, Р-91), вечная версия стратегии их не хранит — как гандикап в 0189. NULL — умолчание типа (прежнее поведение): «Beat the lowest» —
--    самая низкая цена, «Win the Buy Box» — Buy Box, фильтр — все. Настройки версии неизменяемы, как подрез.
-- 2. Доступность [Р-39]: фильтр нужен источник, называющий исполнение предложений (`has_fulfilment`): Amazon ANY_OFFER_CHANGED —
--    IsFulfilledByAmazon (обязательное поле схемы уведомления снимка), Kaufland /buybox — fulfillment_type; Walmart — нет (W-05). Под
--    фильтром ориентир «только Buy Box» («Match the Buy Box», «Beat the lowest» с ориентиром Buy Box) требует и держателя: без него не
--    понять, входит ли Buy Box в фильтр. Страж назначения стратегии видит настройки версии из таблицы подреза.
-- 3. Картина рынка решения [Р-218]: строки, исключённые фильтром или с неизвестным исполнением, остаются с пометкой `excluded`, а итог
--    фильтра по всему снимку — полем `filter`. Проверка формы знает оба поля.
-- 4. Новый код «без изменения» NO_ELIGIBLE_COMPETITORS (после фильтра соревноваться не с кем — к «всем» фильтр не откатывается) и
--    реестры параметров слепка (дополняются значением прежних, а не переписываются руками).

BEGIN;
SET ROLE repracer_owner;

-- ---------------------------------------------------------------- 1. Ориентир и фильтр — рядом с подрезом
ALTER TABLE channel_data.pricing_strategy_undercut ADD COLUMN anchor text, ADD COLUMN compete_with text;
COMMENT ON COLUMN channel_data.pricing_strategy_undercut.anchor IS
  'Р-226 (шаг 101): ориентир «Beat the lowest» и «Win the Buy Box» — BUYBOX, LOWEST или LOWER_OF_TWO; NULL — умолчание типа';
COMMENT ON COLUMN channel_data.pricing_strategy_undercut.compete_with IS
  'Р-226 (шаг 101): с кем соревноваться — ALL, CHANNEL (исполняет канал, FBA) или MERCHANT (исполняет продавец, FBM); NULL — со всеми';
ALTER TABLE channel_data.pricing_strategy_undercut
  ADD CONSTRAINT pricing_strategy_undercut_anchor_known CHECK (anchor IS NULL OR anchor IN ('BUYBOX', 'LOWEST', 'LOWER_OF_TWO')),
  ADD CONSTRAINT pricing_strategy_undercut_compete_with_known CHECK (compete_with IS NULL OR compete_with IN ('ALL', 'CHANNEL', 'MERCHANT'));
-- Решение владельца: в вечной версии стратегии ни ориентира, ни фильтра — как гандикапа (0189)
ALTER TABLE tenant_data.pricing_strategy
  ADD CONSTRAINT pricing_strategy_choice_not_eternal CHECK (NOT params ?| ARRAY['anchor', 'competeWith']);

-- Настройки версии неизменяемы — тот же страж, что у подреза и гандикапа, на два столбца больше
DO $do$
DECLARE
  d text := pg_get_functiondef('channel_data.pricing_strategy_undercut_guard()'::regprocedure);
  a text := 'NEW.undercut_minor, NEW.fulfillment_handicap_minor, NEW.created_at)';
  b text := 'OLD.undercut_minor, OLD.fulfillment_handicap_minor, OLD.created_at)';
BEGIN
  IF (length(d) - length(replace(d, a, ''))) / length(a) <> 1 OR (length(d) - length(replace(d, b, ''))) / length(b) <> 1 THEN
    RAISE EXCEPTION '0195: channel_data.pricing_strategy_undercut_guard() is not the definition the migration expects';
  END IF;
  EXECUTE replace(replace(d, a, 'NEW.undercut_minor, NEW.fulfillment_handicap_minor, NEW.anchor, NEW.compete_with, NEW.created_at)'),
                  b, 'OLD.undercut_minor, OLD.fulfillment_handicap_minor, OLD.anchor, OLD.compete_with, OLD.created_at)');
END $do$;

-- Ориентир есть только у «Beat the lowest» и «Win the Buy Box»: у «Match the Buy Box» ориентир — Buy Box по смыслу, у прочих — нет рынка
DO $do$
DECLARE
  d text := pg_get_functiondef('tenant_data.pricing_strategy_requires_undercut()'::regprocedure);
  a text := '  RETURN NULL;';
BEGIN
  IF (length(d) - length(replace(d, a, ''))) / length(a) <> 1 THEN
    RAISE EXCEPTION '0195: tenant_data.pricing_strategy_requires_undercut() is not the definition the migration expects';
  END IF;
  EXECUTE replace(d, a, $s$  IF NEW.type NOT IN ('BEAT_LOWEST', 'WIN_BUYBOX') AND EXISTS (
       SELECT 1 FROM channel_data.pricing_strategy_undercut u
        WHERE u.tenant_id = NEW.tenant_id AND u.pricing_strategy_id = NEW.pricing_strategy_id AND u.version = NEW.version AND u.anchor IS NOT NULL) THEN
    RAISE EXCEPTION 'strategy % version % (%) takes no anchor: only Beat the lowest and Win the Buy Box choose one (Р-226)', NEW.pricing_strategy_id, NEW.version, NEW.type
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;$s$);
END $do$;

-- ---------------------------------------------------------------- 2. Доступность: источник называет исполнение
ALTER TABLE platform.competitor_source ADD COLUMN has_fulfilment boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN platform.competitor_source.has_fulfilment IS
  'Шаг 101 [Р-226]: источник называет исполнение предложений (канал или продавец) — нужно фильтру «Compete with»; Walmart — нет (W-05)';
-- Amazon ANY_OFFER_CHANGED — IsFulfilledByAmazon (обязательное поле предложения); Kaufland /buybox — fulfillment_type предложения
UPDATE platform.competitor_source SET has_fulfilment = true WHERE source IN ('AMAZON_ANY_OFFER_CHANGED', 'KAUFLAND_BUYBOX');

CREATE OR REPLACE FUNCTION channel_data.strategy_unmet(p_channel text, p_params jsonb) RETURNS jsonb
  LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS $fn$
DECLARE
  t          text := p_params ->> 'type';
  -- Шаг 101 [Р-226]: фильтр «Compete with» (не все) и ориентир «Beat the lowest» (нет поля — самая низкая цена)
  filtered   boolean := coalesce(p_params ->> 'competeWith', 'ALL') <> 'ALL';
  req_kind   text;
  min_n      int := 1;
  bb_price   boolean := false;
  bb_winner  boolean := false;
  shipping   boolean := false;
  fulfilment boolean := false;
  staleness  int := 900;
  s          record;
  u          text[];
  out        jsonb := '{}'::jsonb;
BEGIN
  IF t IN ('FIXED', 'TARGET_MARGIN') THEN
    RETURN '{}'::jsonb;
  ELSIF t = 'MATCH_BUYBOX' THEN
    -- Шаг 101: под фильтром Buy Box — ориентир, только если канал назвал держателя (входит ли он в фильтр)
    req_kind := 'TOP_N'; bb_price := true; bb_winner := filtered; fulfilment := filtered;
  ELSIF t = 'WIN_BUYBOX' THEN
    -- Шаг 97: держатель Buy Box и доставка — цель от landed-цены победителя
    req_kind := 'TOP_N'; bb_price := true; bb_winner := true; shipping := true; fulfilment := filtered;
  ELSIF t = 'BEAT_LOWEST' THEN
    req_kind := CASE WHEN p_params ->> 'scope' = 'MARKET' THEN 'CHEAPEST_ONLY' ELSE 'TOP_N' END;
    shipping := coalesce((p_params ->> 'compareLanded')::boolean, false);
    -- Шаг 101: ориентир «только Buy Box» — цена Buy Box, под фильтром ещё и держатель; меньшая из двух обходится одной из цен
    bb_price := coalesce(p_params ->> 'anchor', 'LOWEST') = 'BUYBOX'; bb_winner := bb_price AND filtered; fulfilment := filtered;
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
    IF fulfilment AND NOT s.has_fulfilment THEN u := u || 'FULFILMENT'::text; END IF;
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

-- Страж назначения стратегии [Р-39] видит настройки версии там, где они живут, — рядом с подрезом. Роли, назначающие стратегию, таблицу
-- подреза читают (repracer_admin, repracer_catalog, repracer_app) — соединение, а не функция-определитель
DO $do$
DECLARE
  d text := pg_get_functiondef('tenant_data.write_scope_strategy_guard()'::regprocedure);
  a text := $s$SELECT ps.params || jsonb_build_object('type', ps.type), ps.status INTO params, status FROM tenant_data.pricing_strategy ps
   WHERE ps.tenant_id = NEW.tenant_id$s$;
BEGIN
  IF (length(d) - length(replace(d, a, ''))) / length(a) <> 1 THEN
    RAISE EXCEPTION '0195: tenant_data.write_scope_strategy_guard() is not the definition the migration expects';
  END IF;
  EXECUTE replace(d, a, $s$SELECT ps.params || jsonb_build_object('type', ps.type) || jsonb_strip_nulls(jsonb_build_object('anchor', u.anchor, 'competeWith', u.compete_with)), ps.status
    INTO params, status FROM tenant_data.pricing_strategy ps
    LEFT JOIN channel_data.pricing_strategy_undercut u ON u.tenant_id = ps.tenant_id AND u.pricing_strategy_id = ps.pricing_strategy_id AND u.version = ps.version
   WHERE ps.tenant_id = NEW.tenant_id$s$);
END $do$;

-- ---------------------------------------------------------------- 3. Картина рынка: пометки фильтра и его итог
CREATE FUNCTION channel_data.competitor_view_filter_valid(f jsonb) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog AS $$
  -- CASE, а не AND: порядок вычисления AND не обещан, и приведение текста к числу упало бы ошибкой вместо «нет»; ответ — никогда не NULL
  SELECT CASE coalesce(jsonb_typeof(f), 'null')
    WHEN 'null' THEN true
    WHEN 'object' THEN
      CASE WHEN EXISTS (SELECT 1 FROM jsonb_object_keys(f) k WHERE k <> ALL (ARRAY['competeWith', 'total', 'considered', 'unknown'])) THEN false
           WHEN coalesce(jsonb_typeof(f -> 'competeWith'), 'null') <> 'string' OR (f ->> 'competeWith') NOT IN ('CHANNEL', 'MERCHANT') THEN false
           WHEN coalesce(jsonb_typeof(f -> 'total'), 'null') <> 'number' OR coalesce(jsonb_typeof(f -> 'considered'), 'null') <> 'number'
             OR coalesce(jsonb_typeof(f -> 'unknown'), 'null') <> 'number' THEN false
           ELSE (f ->> 'total')::numeric = trunc((f ->> 'total')::numeric) AND (f ->> 'considered')::numeric = trunc((f ->> 'considered')::numeric)
            AND (f ->> 'unknown')::numeric = trunc((f ->> 'unknown')::numeric)
            AND (f ->> 'considered')::numeric >= 0 AND (f ->> 'unknown')::numeric >= 0
            AND (f ->> 'considered')::numeric + (f ->> 'unknown')::numeric <= (f ->> 'total')::numeric
            AND (f ->> 'total')::numeric <= 100000 END
    ELSE false END
$$;
COMMENT ON FUNCTION channel_data.competitor_view_filter_valid(jsonb) IS
  'Шаг 101 [Р-226]: итог фильтра «Compete with» в картине рынка — с кем соревновались и сколько предложений снимка прошли и исключены';

DO $do$
DECLARE
  d text := pg_get_functiondef('channel_data.competitor_view_valid(jsonb)'::regprocedure);
  a text := $s$k <> ALL (ARRAY['currency', 'trigger', 'offers'])$s$;
  b text := $s$AND coalesce(jsonb_typeof(v -> 'currency') = 'string' AND (v ->> 'currency') ~ '^[A-Z]{3}$', false)$s$;
  c text := $s$'ratingPct', 'ratingCount', 'move', 'wasMinor']$s$;
  e text := $s$(o ->> 'move') NOT IN ('UP', 'DOWN', 'APPEARED', 'GONE'))) END$s$;
BEGIN
  IF (length(d) - length(replace(d, a, ''))) / length(a) <> 1 OR (length(d) - length(replace(d, b, ''))) / length(b) <> 1
     OR (length(d) - length(replace(d, c, ''))) / length(c) <> 1 OR (length(d) - length(replace(d, e, ''))) / length(e) <> 1 THEN
    RAISE EXCEPTION '0195: channel_data.competitor_view_valid(jsonb) is not the definition the migration expects';
  END IF;
  EXECUTE replace(replace(replace(replace(d,
    a, $s$k <> ALL (ARRAY['currency', 'trigger', 'offers', 'filter'])$s$),
    b, b || $s$
     AND channel_data.competitor_view_filter_valid(v -> 'filter')$s$),
    c, $s$'ratingPct', 'ratingCount', 'move', 'wasMinor', 'excluded']$s$),
    e, $s$(o ->> 'move') NOT IN ('UP', 'DOWN', 'APPEARED', 'GONE'))
           OR (o ? 'excluded' AND coalesce(o ->> 'excluded', '') NOT IN ('FILTER', 'UNKNOWN'))) END$s$);
END $do$;

-- ---------------------------------------------------------------- 4. Код «без изменения» и реестры слепка
ALTER TABLE channel_data.price_decision DROP CONSTRAINT price_decision_no_change_reason_code;
ALTER TABLE channel_data.price_decision ADD CONSTRAINT price_decision_no_change_reason_code CHECK (no_change_reason = ANY (ARRAY[
  'ALREADY_AT_TARGET', 'WITHIN_DEADBAND', 'ALREADY_WINNING_BUYBOX', 'NO_COMPETITOR_OFFERS', 'TARGET_OUTSIDE_BOUNDS_HOLD',
  'SHADOW_ALREADY_PROPOSED', 'LADDER_PACED', 'BUYBOX_HOLDER_UNKNOWN', 'CREEP_PACED', 'CREEP_PAUSED', 'CREEP_AT_MAX', 'NO_ELIGIBLE_COMPETITORS']));

DO $do$
DECLARE
  keys jsonb := security.eternal_param_keys();
  kinds jsonb := security.eternal_param_kinds();
  channel text[] := security.channel_param_keys();
  derived jsonb := security.channel_derived_param_keys();
BEGIN
  IF keys ? 'ANCHOR_UNDERCUT' OR kinds ? 'ANCHOR_UNDERCUT' OR 'anchorMinor' = ANY (channel) OR derived ? 'ANCHOR_UNDERCUT'
     OR NOT keys ? 'CREEP_UP' OR kinds #> '{MARGIN_WITHOUT_COST,strategyType,v}' <> '["FIXED","TARGET_MARGIN","MATCH_BUYBOX","BEAT_LOWEST","WIN_BUYBOX"]'::jsonb THEN
    RAISE EXCEPTION '0195: the reason registries are not the ones the migration expects';
  END IF;
  -- Вечные — только тип стратегии и валюта: цены, число предложений, ориентир и фильтр живут не дольше подреза [Р-85, Р-91]
  keys := keys || '{"ANCHOR_UNDERCUT": ["currency", "strategyType"], "COMPETITORS_FILTERED": [], "NO_ELIGIBLE_COMPETITORS": []}'::jsonb;
  kinds := kinds || jsonb_build_object(
    'ANCHOR_UNDERCUT', jsonb_build_object('strategyType', kinds #> '{MARGIN_WITHOUT_COST,strategyType}', 'currency', '{"k":"currency"}'::jsonb),
    'COMPETITORS_FILTERED', '{}'::jsonb, 'NO_ELIGIBLE_COMPETITORS', '{}'::jsonb);
  -- Ключи класса CHANNEL — в порядке кода (по кодовым единицам, COLLATE "C"); производные — по кодам
  channel := ARRAY(SELECT x FROM (SELECT DISTINCT x FROM unnest(channel || ARRAY['anchorMinor', 'otherAnchorMinor', 'buyboxUnused', 'buyboxHolder',
                                                                                 'offersConsidered', 'offersTotal', 'offersUnknown']) x) d ORDER BY x COLLATE "C");
  derived := derived || '{"ANCHOR_UNDERCUT": ["anchorSetting", "anchorUsed", "handicapMinor", "targetMinor", "undercutMinor"], "COMPETITORS_FILTERED": ["competeWith"], "NO_ELIGIBLE_COMPETITORS": ["competeWith"]}'::jsonb;
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
