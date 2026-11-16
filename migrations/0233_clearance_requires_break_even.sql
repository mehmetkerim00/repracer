-- 0233_clearance_requires_break_even.sql
-- Шаг 140 [Р-227, решение владельца по #27 — вариант (а)]: режим распродажи включается только при посчитанной безубыточности.
--
-- До шага страж журнала (0197) безубыточность не спрашивал, а пол базы в режиме распродажи возвращает пол распродажи раньше, чем
-- считает безубыточность. Поэтому у предложения с объявленной себестоимостью, но без действующей оценки комиссии (истекает через
-- 90 суток, Р-244), без курса или без НДС распродажа включалась: вне режима цена такого предложения не уходит (пол не вычислить,
-- fail-closed), а в режиме — уходила в канал на пол распродажи. Подтверждение «каждая продажа ниже безубыточности — убыток» при этом
-- ни о чём: убыток на штуку не назвать.
--
-- 1. `tenant_data.break_even_floor` — безубыточность тем же расчётом, что пол перед каждой отправкой [Р-83]: функция ВЫВОДИТСЯ из
--    действующего `effective_price_floor` (без минимальной цены, без распродажи, маржа 0 %), второго правила пола нет.
--    `maintenance.derive_break_even_floor()` даёт её определение из текущего пола; тест шага держит их равными — изменение пола без
--    повторного вывода краснеет (`clearance-step102.pg.test.ts`, «step 140»).
-- 2. Страж включения требует безубыточность и называет причину (себестоимость, оценка комиссии, курс, НДС).
-- Пол перед отправкой, решения и выключение не меняются.

BEGIN;

SET ROLE repracer_owner;

-- ---------------------------------------------------------------- 1. Безубыточность — вывод из пола перед отправкой
/**
 * Определение `tenant_data.break_even_floor` из ДЕЙСТВУЮЩЕГО определения пола: заголовок, без «нет min_price — пол не вычислить» (для
 * безубыточности минимальная цена не нужна), без ветки распродажи (она возвращает пол распродажи раньше расчёта), минимальная маржа —
 * никакая (маржа 0 %). Каждый фрагмент обязан встретиться ровно один раз: иначе пол изменился так, что вывод надо пересмотреть
 */
CREATE FUNCTION maintenance.derive_break_even_floor() RETURNS text
  LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS $fn$
DECLARE
  d text := pg_get_functiondef('tenant_data.effective_price_floor(uuid,uuid,timestamptz)'::regprocedure);
  head_old text := 'CREATE OR REPLACE FUNCTION tenant_data.effective_price_floor(p_tenant_id uuid, p_write_scope_id uuid, p_at timestamp with time zone DEFAULT now())';
  head_new text := 'CREATE OR REPLACE FUNCTION tenant_data.break_even_floor(p_tenant_id uuid, p_write_scope_id uuid, p_at timestamp with time zone)';
  min_old text := $s$  IF min_price_minor IS NULL THEN
    cause := 'MIN_PRICE_MISSING';
    RETURN NEXT;
    RETURN;
  END IF;
$s$;
  clearance_old text := $s$  -- Шаг 102 [Р-227]: в режиме распродажи пол — пол распродажи; он заменяет min_price и пол маржи (решение владельца)
  SELECT ac.floor_minor INTO candidate FROM tenant_data.active_clearance(p_tenant_id, p_write_scope_id, p_at) ac;
  IF candidate IS NOT NULL THEN
    floor_minor := candidate;
    RETURN NEXT;
    RETURN;
  END IF;

$s$;
  margin_old text := $s$   WHERE gg.is_active;
$s$;
  margin_new text := $s$   WHERE gg.is_active;
  -- Шаг 140: безубыточность — маржа 0 %; минимальная маржа тенанта, аккаунта и товара в ней не участвует
  min_margin_bp := NULL;
$s$;
  part text;
BEGIN
  FOREACH part IN ARRAY ARRAY[head_old, min_old, clearance_old, margin_old] LOOP
    IF (length(d) - length(replace(d, part, ''))) / length(part) <> 1 THEN
      RAISE EXCEPTION 'tenant_data.effective_price_floor changed: break_even_floor cannot be derived from it (fragment %)', left(part, 60);
    END IF;
  END LOOP;
  RETURN replace(replace(replace(replace(d, head_old, head_new), min_old, ''), clearance_old, ''), margin_old, margin_new);
END $fn$;
REVOKE EXECUTE ON FUNCTION maintenance.derive_break_even_floor() FROM PUBLIC;

DO $do$ BEGIN EXECUTE maintenance.derive_break_even_floor(); END $do$;
COMMENT ON FUNCTION tenant_data.break_even_floor(uuid, uuid, timestamptz) IS
  'Шаг 140 [Р-227, Р-83]: безубыточность (margin_floor_minor) тем же расчётом, что пол перед отправкой, при марже 0 и без распродажи; '
  'NULL — не посчитана (cause, NULL — нет себестоимости). Выведена из effective_price_floor: maintenance.derive_break_even_floor()';

-- ---------------------------------------------------------------- 2. Страж включения: без безубыточности распродажи нет
DO $do$
DECLARE
  d text := pg_get_functiondef('tenant_data.clearance_change_guard()'::regprocedure);
  decl text := $s$  ceiling bigint;
BEGIN$s$;
  tail text := $s$    NEW.mfa := true;
  ELSIF NEW.action = 'DISABLE' THEN$s$;
BEGIN
  IF (length(d) - length(replace(d, decl, ''))) / length(decl) <> 1 OR (length(d) - length(replace(d, tail, ''))) / length(tail) <> 1 THEN
    RAISE EXCEPTION '0233: tenant_data.clearance_change_guard() is not the definition the migration expects';
  END IF;
  EXECUTE replace(replace(d, decl, $s$  ceiling bigint;
  be     record;
BEGIN$s$), tail, $s$    -- Шаг 140 [Р-227, решение владельца (а)]: убыток на штуку назван — безубыточность посчитана тем же расчётом, что пол перед
    -- отправкой (Р-83); без себестоимости, действующей оценки комиссии, курса или НДС подтверждение убытка ни о чём
    SELECT b.margin_floor_minor, b.cause INTO be FROM tenant_data.break_even_floor(NEW.tenant_id, NEW.write_scope_id, now()) b;
    IF be.margin_floor_minor IS NULL THEN
      RAISE EXCEPTION 'clearance needs a computed break-even: the loss per piece cannot be calculated (%) (Р-227)', coalesce(be.cause, 'COST_PROFILE_MISSING')
        USING ERRCODE = 'check_violation';
    END IF;
$s$ || tail);
END $do$;

RESET ROLE;

COMMIT;
