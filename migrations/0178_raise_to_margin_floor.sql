-- 0178_raise_to_margin_floor.sql
-- Шаг 72 [Р-207, OQ-250]: стратегия, следующая за рынком, встаёт на ПОЛ МАРЖИ, а не только на min_price, и поднимает до пола цену,
-- которая ниже него. До решения пол маржи держала только Gate отказом (`BELOW_MARGIN_FLOOR`), и цена, уже стоящая ниже пола маржи,
-- там и оставалась — kill-test шага 71 нашёл это на синтетике. Две новые причины движка:
--   CAPPED_AT_MARGIN_FLOOR — цель стратегии ниже пола маржи, цена на полу маржи (аналог CAPPED_AT_MIN_PRICE);
--   RAISED_TO_FLOOR        — нынешняя цена ниже пола, цена поднята до пола (min_price или пол маржи — параметр `bound`).
--
-- 1. Реестры параметров слепка объяснения (ключи, виды значений, ключи, выведенные из цены конкурента) знают обе причины — иначе
--    слепок решения отклонялся бы fail-closed [Р-85]. Реестры дополняются ЗНАЧЕНИЕМ прежнего, как в 0160 и 0175: два кода
--    дописываются, остальное не трогается; совпадение с кодом держит тест «finding 15» (undercut-eternal.pg.test.ts) и
--    channel-derived.pg.test.ts. Цель стратегии (`targetMinor`) у CAPPED_AT_MARGIN_FLOOR выведена из цены конкурента — в вечный
--    слепок не попадает, как у CAPPED_AT_MIN_PRICE.
-- 2. Удержание пола (`channel_data.floor_hold`, 0132) пишется и для цели ниже ПОЛА МАРЖИ: «без пола вы продали бы дешевле» [Р-173]
--    считается по обоим полам. Удержанная цена у шагов CAPPED_* — сама граница из шага цепочки (min_price или пол маржи), как в отчёте
--    опасных изменений, а не цена намерения: в тени повторный опрос даёт «уже предложено» с нынешней ценой витрины, и сумма считалась
--    бы от неё (ревью шага 72, находка 5). У удержания вне границ (HOLD) — цена намерения, как прежде. Функция переопределяется с тем
--    же владельцем, SECURITY DEFINER и search_path. Новых защит нет.

BEGIN;
SET ROLE repracer_owner;

DO $do$
DECLARE
  keys jsonb := security.eternal_param_keys();
  kinds jsonb := security.eternal_param_kinds();
  derived jsonb := security.channel_derived_param_keys();
BEGIN
  IF keys ? 'CAPPED_AT_MARGIN_FLOOR' OR keys ? 'RAISED_TO_FLOOR' OR kinds ? 'CAPPED_AT_MARGIN_FLOOR' OR derived ? 'CAPPED_AT_MARGIN_FLOOR' THEN
    RAISE EXCEPTION '0178: the reason registries already know the step 72 codes — the migration must not guess';
  END IF;
  keys := keys || jsonb_build_object(
    'CAPPED_AT_MARGIN_FLOOR', '["currency","floorMinor","minMarginBp","minMinor"]'::jsonb,
    'RAISED_TO_FLOOR', '["bound","currency","currentMinor","floorMinor","minMarginBp"]'::jsonb);
  kinds := kinds || jsonb_build_object(
    'CAPPED_AT_MARGIN_FLOOR', '{"floorMinor":{"k":"money"},"minMinor":{"k":"money"},"minMarginBp":{"k":"bp"},"currency":{"k":"currency"}}'::jsonb,
    'RAISED_TO_FLOOR', '{"currentMinor":{"k":"money"},"floorMinor":{"k":"money"},"bound":{"k":"enum","v":["min","margin_floor"]},"minMarginBp":{"k":"bp"},"currency":{"k":"currency"}}'::jsonb);
  derived := derived || jsonb_build_object('CAPPED_AT_MARGIN_FLOOR', '["targetMinor"]'::jsonb);
  EXECUTE format($f$CREATE OR REPLACE FUNCTION security.eternal_param_keys() RETURNS jsonb
    LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $b$ SELECT %L::jsonb $b$$f$, keys);
  EXECUTE format($f$CREATE OR REPLACE FUNCTION security.eternal_param_kinds() RETURNS jsonb
    LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $b$ SELECT %L::jsonb $b$$f$, kinds);
  EXECUTE format($f$CREATE OR REPLACE FUNCTION security.channel_derived_param_keys() RETURNS jsonb
    LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $b$ SELECT %L::jsonb $b$$f$, derived);
END $do$;

RESET ROLE;

-- Владелец функции — узкая роль repracer_floor_hold (0132); CREATE OR REPLACE владельца и права не меняет, а SECURITY DEFINER и
-- search_path — часть определения и повторены явно (шаг 19: CREATE OR REPLACE без них их сбрасывал)
CREATE OR REPLACE FUNCTION channel_data.price_intent_record_floor_hold() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
DECLARE
  target bigint;
  held bigint;
  in_shadow boolean;
BEGIN
  SELECT (x -> 'params' ->> 'targetMinor')::bigint,
         CASE x ->> 'code' WHEN 'CAPPED_AT_MIN_PRICE' THEN (x -> 'params' ->> 'minMinor')::bigint
                           WHEN 'CAPPED_AT_MARGIN_FLOOR' THEN (x -> 'params' ->> 'floorMinor')::bigint
                           ELSE NEW.proposed_amount_minor END
    INTO target, held
    FROM jsonb_array_elements(coalesce(NEW.rationale -> 'explanation', '[]'::jsonb)) x
   WHERE x ->> 'code' IN ('CAPPED_AT_MIN_PRICE', 'CAPPED_AT_MARGIN_FLOOR', 'TARGET_OUTSIDE_BOUNDS_HOLD') AND x -> 'params' ? 'targetMinor'
   LIMIT 1;
  held := coalesce(held, NEW.proposed_amount_minor);
  IF target IS NOT NULL AND target < held THEN
    -- Тот же источник, что у признака тени решения (0128): режим аккаунта единицы записи в этой транзакции
    SELECT ca.write_mode = 'SHADOW' INTO in_shadow
      FROM tenant_data.write_scope ws
      JOIN tenant_data.channel_account ca ON ca.tenant_id = ws.tenant_id AND ca.channel_account_id = ws.channel_account_id
     WHERE ws.tenant_id = NEW.tenant_id AND ws.write_scope_id = NEW.write_scope_id;
    INSERT INTO channel_data.floor_hold (tenant_id, price_intent_id, intent_created_at, write_scope_id, currency, below_minor, shadow)
    VALUES (NEW.tenant_id, NEW.price_intent_id, NEW.created_at, NEW.write_scope_id, NEW.currency, held - target, coalesce(in_shadow, false))
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NULL;
END $fn$;

DO $do$
BEGIN
  IF (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid = 'channel_data.price_intent_record_floor_hold()'::regprocedure) <> 'repracer_floor_hold'
     OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'channel_data.price_intent_record_floor_hold()'::regprocedure) THEN
    RAISE EXCEPTION '0178: the floor hold recorder lost its owner or SECURITY DEFINER';
  END IF;
END $do$;

COMMIT;
