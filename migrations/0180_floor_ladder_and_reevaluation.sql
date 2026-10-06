-- 0180_floor_ladder_and_reevaluation.sql
-- Шаг 73: три решения владельца о подъёме к полу [Р-207].
--
-- Р-208 (OQ-251) — ЛЕСТНИЦА. Предел шага не снимается: подъём к полу больше предела идёт ступенями, каждая оценка — на предел шага.
-- Ступень — единственная цена НИЖЕ пола, которую пропускает база, и только как ступень:
--   1. решение несёт `ladder_from_minor` (нынешняя цена, от которой ступень), и ступень ниже пола, но выше неё (ограничения решения и
--      вечного ядра — вместо прежнего «итог не ниже пола»);
--   2. при создании записи и перед КАЖДОЙ отправкой [Р-83] запись ниже пола пропускается только если её решение — ступень с той же
--      суммой и сумма ВЫШЕ нынешней цены, которую база знает сама (последняя принятая каналом отправленная цена, иначе наблюдённая;
--      при расхождении витрины — выше обеих) — `tenant_data.price_ladder_step_allowed`, узкая роль только с чтением этих столбцов.
--      Иначе — прежний отказ тем же сообщением, и диспетчер, и хранилище распознают его, как раньше. Пол по-прежнему пересчитывается
--      заново перед каждой отправкой;
--   3. журнал наших цен, суточная свёртка и её системная поправка знают ступень (`ladder_from_minor`, `ladder_steps`): «цена не ниже
--      пола» там допускает ступень — иначе закрытие суток всех тенантов пояса падало бы на первой ступени (ревью шага 73); удержание
--      пола (0178) у ступени — сама ступень, а не пол.
-- Р-209 (OQ-252) и Р-210 (OQ-253) — ПЕРЕОЦЕНКА БЕЗ НАБЛЮДЕНИЯ КОНКУРЕНТОВ. Запрос на переоценку единицы (`tenant_data.floor_raise_request`)
-- ставит база: после отказа перепроверки пола перед отправкой (запись завершена `WRITE_BLOCKED_BY_BOUND_RECHECK`, нарушен пол) —
-- FLOOR_RECHECK; после новой версии себестоимости или оценки комиссии — COST_UPDATE. Запросы забирает пересчёт по расписанию
-- (`recomputeScheduled`) и переоценивает единицу; цену ниже пола стратегия поднимает к полу и без свежего снимка конкурентов.
-- Реестры параметров слепка знают новую причину RAISED_TOWARD_FLOOR и параметр `after` у RAISED_TO_FLOOR (дополняются значением прежних).

BEGIN;
SET ROLE repracer_owner;

-- ---------------------------------------------------------------- 1. Ступень лестницы в решении и в вечном ядре
ALTER TABLE channel_data.price_decision ADD COLUMN ladder_from_minor bigint;
COMMENT ON COLUMN channel_data.price_decision.ladder_from_minor IS
  'Р-208: ступень лестницы к полу — нынешняя цена, от которой поднимается ступень; ступень ниже пола и выше этой цены. У обычного решения NULL';
-- Прежнее ограничение «итог не ниже пола» (0024) — под тем же именем: исключение только у ступени, форму которой держит ограничение ниже
ALTER TABLE channel_data.price_decision DROP CONSTRAINT price_decision_check1;
ALTER TABLE channel_data.price_decision
  ADD CONSTRAINT price_decision_check1 CHECK (final_amount_minor IS NULL OR final_amount_minor >= effective_floor_minor OR ladder_from_minor IS NOT NULL);
ALTER TABLE channel_data.price_decision
  ADD CONSTRAINT price_decision_ladder_step CHECK (ladder_from_minor IS NULL
    OR (outcome = 'APPROVED' AND final_amount_minor > ladder_from_minor AND final_amount_minor < effective_floor_minor));

ALTER TABLE tenant_data.price_intent_core ADD COLUMN ladder_from_minor bigint;
-- Ядро копирует решение триггером: прежнее ограничение (то же имя) допускает ступень; форму ступени держит ограничение решения —
-- второе такое же у ядра было бы дублем, пойманным только соседним [Р-104]
ALTER TABLE tenant_data.price_intent_core DROP CONSTRAINT price_intent_core_check1;
ALTER TABLE tenant_data.price_intent_core
  ADD CONSTRAINT price_intent_core_check1 CHECK (final_amount_minor IS NULL OR final_amount_minor >= effective_floor_minor OR ladder_from_minor IS NOT NULL);

-- Журнал наших цен (доказательство Omnibus) держит «опубликованная цена не ниже пола на момент отправки»; ступень — единственное
-- исключение, и журнал называет, от какой цены она поднялась
ALTER TABLE tenant_data.price_history ADD COLUMN ladder_from_minor bigint;
ALTER TABLE tenant_data.price_history DROP CONSTRAINT price_history_check2;
ALTER TABLE tenant_data.price_history
  ADD CONSTRAINT price_history_check2 CHECK (amount_minor >= effective_min_price_minor OR (ladder_from_minor IS NOT NULL AND amount_minor > ladder_from_minor));

-- Суточная свёртка (вечно, Р-21) и системная поправка закрытых суток (0101) держат «цена суток не ниже пола суток»; сутки со ступенью —
-- исключение, и строка говорит, сколько ступеней в ней было. Без этого закрытие суток — одна вставка по всем тенантам пояса — падало бы
-- целиком на первой ступени (ревью шага 73, находка 1). Имена ограничений прежние: смоуки и строки каталога держат их же
ALTER TABLE tenant_data.price_daily ADD COLUMN ladder_steps int NOT NULL DEFAULT 0;
COMMENT ON COLUMN tenant_data.price_daily.ladder_steps IS
  'Р-208: сколько цен суток — ступени лестницы к полу (ниже пола, выше нынешней цены); min_floor_minor — по-прежнему наименьший пол суток';
ALTER TABLE tenant_data.price_daily DROP CONSTRAINT price_daily_check3;
ALTER TABLE tenant_data.price_daily ADD CONSTRAINT price_daily_check3 CHECK (min_amount_minor >= min_floor_minor OR ladder_steps > 0);
ALTER TABLE tenant_data.price_daily_system_correction ADD COLUMN ladder_steps int NOT NULL DEFAULT 0;
ALTER TABLE tenant_data.price_daily_system_correction DROP CONSTRAINT price_daily_system_correction_bounds;
ALTER TABLE tenant_data.price_daily_system_correction ADD CONSTRAINT price_daily_system_correction_bounds CHECK (change_count = 0 OR (
  min_amount_minor <= first_amount_minor AND first_amount_minor <= max_amount_minor AND min_amount_minor <= last_amount_minor
  AND last_amount_minor <= max_amount_minor AND first_accepted_at <= last_accepted_at AND (min_amount_minor >= min_floor_minor OR ladder_steps > 0)));

-- Под запрос лестниц пересчёта по расписанию (PgPricingStore.listFloorRaiseScopes): ступени тенанта за последние сутки
CREATE INDEX price_decision_ladder_idx ON channel_data.price_decision (tenant_id, decided_at) WHERE ladder_from_minor IS NOT NULL;

RESET ROLE;

-- Свёртка суток считает ступени: закрытие суток (0096), пересчёт закрытых суток (0101) и общий расчёт суток для поправки (0101).
-- У расчёта суток меняется состав результата — функция пересоздаётся тем же владельцем, без права исполнения у других
DROP FUNCTION maintenance.price_day_rollup(uuid, uuid, text, date, text);
CREATE FUNCTION maintenance.price_day_rollup(p_tenant_id uuid, p_write_scope_id uuid, p_price_type text, p_day date, p_tz text)
  RETURNS TABLE(currency text, price_basis text, min_amount_minor bigint, max_amount_minor bigint, first_amount_minor bigint,
                first_accepted_at timestamptz, last_amount_minor bigint, last_accepted_at timestamptz, change_count integer,
                min_floor_minor bigint, ladder_steps integer)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $function$
  SELECT h.currency, h.price_basis, min(h.amount_minor), max(h.amount_minor),
         (array_agg(h.amount_minor ORDER BY coalesce(ap.applied_at, h.accepted_at), h.price_history_id))[1], min(coalesce(ap.applied_at, h.accepted_at)),
         (array_agg(h.amount_minor ORDER BY coalesce(ap.applied_at, h.accepted_at) DESC, h.price_history_id DESC))[1], max(coalesce(ap.applied_at, h.accepted_at)),
         count(*)::int, min(h.effective_min_price_minor), (count(*) FILTER (WHERE h.ladder_from_minor IS NOT NULL))::int
    FROM tenant_data.price_history h
    LEFT JOIN tenant_data.price_history_applied ap ON ap.tenant_id = h.tenant_id AND ap.price_history_id = h.price_history_id
   WHERE h.tenant_id = p_tenant_id AND h.write_scope_id = p_write_scope_id AND h.price_type = p_price_type
     AND coalesce(ap.applied_at, h.accepted_at) >= (p_day::timestamp AT TIME ZONE p_tz)
     AND coalesce(ap.applied_at, h.accepted_at) < ((p_day + 1)::timestamp AT TIME ZONE p_tz)
     -- Отсечение секций price_history (партиции по accepted_at): применение не раньше принятия
     AND h.accepted_at < ((p_day + 1)::timestamp AT TIME ZONE p_tz)
     AND NOT EXISTS (SELECT 1 FROM tenant_data.price_history c
                      WHERE c.tenant_id = h.tenant_id AND c.corrects_price_history_id = h.price_history_id)
     AND NOT EXISTS (SELECT 1 FROM tenant_data.price_history_not_applied na
                      WHERE na.tenant_id = h.tenant_id AND na.price_history_id = h.price_history_id)
   GROUP BY h.currency, h.price_basis
$function$;
ALTER FUNCTION maintenance.price_day_rollup(uuid, uuid, text, date, text) OWNER TO repracer_retention;
REVOKE EXECUTE ON FUNCTION maintenance.price_day_rollup(uuid, uuid, text, date, text) FROM PUBLIC;

DO $do$
DECLARE
  c text := pg_get_functiondef('maintenance.close_price_days(timestamptz,integer)'::regprocedure);
  r text := pg_get_functiondef('maintenance.correct_closed_price_days(timestamptz)'::regprocedure);
  cols text := 'first_amount_minor, first_accepted_at, last_amount_minor, last_accepted_at, change_count, min_floor_minor)';
  agg text := 'count(*), min(h.effective_min_price_minor)';
  v1 text := 'roll.change_count, roll.min_floor_minor)';
  cols2 text := 'last_amount_minor, last_accepted_at, change_count, min_floor_minor, reason, supersedes_correction_id)';
  v2 text := 'coalesce(roll.change_count, 0), roll.min_floor_minor,';
  n int;
BEGIN
  n := (length(c) - length(replace(c, cols, ''))) / length(cols) * 10 + (length(c) - length(replace(c, agg, ''))) / length(agg);
  IF n <> 11 THEN RAISE EXCEPTION '0180: close_price_days() is not the definition the migration expects (%)', n; END IF;
  n := (length(r) - length(replace(r, cols, ''))) / length(cols) * 100 + (length(r) - length(replace(r, v1, ''))) / length(v1) * 10
     + (length(r) - length(replace(r, cols2, ''))) / length(cols2);
  IF n <> 111 OR (length(r) - length(replace(r, v2, ''))) / length(v2) <> 1 THEN
    RAISE EXCEPTION '0180: correct_closed_price_days() is not the definition the migration expects (%)', n;
  END IF;
  c := replace(c, cols, 'first_amount_minor, first_accepted_at, last_amount_minor, last_accepted_at, change_count, min_floor_minor, ladder_steps)');
  c := replace(c, agg, 'count(*), min(h.effective_min_price_minor), count(*) FILTER (WHERE h.ladder_from_minor IS NOT NULL)');
  r := replace(r, cols, 'first_amount_minor, first_accepted_at, last_amount_minor, last_accepted_at, change_count, min_floor_minor, ladder_steps)');
  r := replace(r, v1, 'roll.change_count, roll.min_floor_minor, roll.ladder_steps)');
  r := replace(r, cols2, 'last_amount_minor, last_accepted_at, change_count, min_floor_minor, ladder_steps, reason, supersedes_correction_id)');
  r := replace(r, v2, 'coalesce(roll.change_count, 0), roll.min_floor_minor, coalesce(roll.ladder_steps, 0),');
  EXECUTE c;
  EXECUTE r;
END $do$;

-- Вечное ядро уносит признак ступени: через 30 суток решение объясняет, почему цена была ниже пола
DO $do$
DECLARE
  d text := pg_get_functiondef('channel_data.price_decision_record_core()'::regprocedure);
  a text := 'decided_at,
       rejection_reason, reason_params, explanation, bound_deviation_bp, dangerous, sanity_ruleset, gate_profile, shadow)';
  b text := 'NEW.sanity_ruleset, NEW.gate_profile, NEW.shadow
      FROM channel_data.price_intent i';
BEGIN
  IF (length(d) - length(replace(d, a, ''))) / length(a) <> 1 OR (length(d) - length(replace(d, b, ''))) / length(b) <> 1 THEN
    RAISE EXCEPTION '0180: price_decision_record_core() is not the definition the migration expects';
  END IF;
  d := replace(d, a, 'decided_at,
       rejection_reason, reason_params, explanation, bound_deviation_bp, dangerous, sanity_ruleset, gate_profile, shadow, ladder_from_minor)');
  d := replace(d, b, 'NEW.sanity_ruleset, NEW.gate_profile, NEW.shadow, NEW.ladder_from_minor
      FROM channel_data.price_intent i');
  EXECUTE d;
END $do$;

-- ---------------------------------------------------------------- 2. Ступень — только выше нынешней цены, которую база знает сама
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'repracer_price_ladder') THEN CREATE ROLE repracer_price_ladder NOLOGIN; END IF;
END $$;
GRANT USAGE ON SCHEMA channel_data, tenant_data, security TO repracer_price_ladder;
GRANT EXECUTE ON FUNCTION security.current_tenant_id() TO repracer_price_ladder;
GRANT SELECT (tenant_id, price_decision_id, write_scope_id, outcome, final_amount_minor, ladder_from_minor) ON channel_data.price_decision TO repracer_price_ladder;
GRANT SELECT (tenant_id, write_scope_id, latest_version_accepted, last_sent_amount_minor) ON tenant_data.write_scope_sync_state TO repracer_price_ladder;
GRANT SELECT (tenant_id, write_scope_id, field, observed_amount_minor, sync_status) ON channel_data.observed_channel_state TO repracer_price_ladder;
CREATE POLICY price_ladder_read ON channel_data.price_decision FOR SELECT TO repracer_price_ladder USING (tenant_id = security.current_tenant_id());
CREATE POLICY price_ladder_read ON tenant_data.write_scope_sync_state FOR SELECT TO repracer_price_ladder USING (tenant_id = security.current_tenant_id());
CREATE POLICY price_ladder_read ON channel_data.observed_channel_state FOR SELECT TO repracer_price_ladder USING (tenant_id = security.current_tenant_id());

/**
 * Р-208: запись ниже пола — ступень лестницы? Её решение — одобренная ступень с той же суммой, и сумма выше нынешней цены единицы:
 * последней принятой каналом отправленной цены, а без принятых отправок — наблюдённой (как контекст решения, PgPricingStore). Нынешнюю
 * цену знает база, а не приложение: ступень не ниже того, что уже стоит на витрине. Нет нынешней цены — ступени нет
 */
CREATE FUNCTION tenant_data.price_ladder_step_allowed(p_tenant_id uuid, p_write_scope_id uuid, p_amount_minor bigint, p_decision_id uuid)
  RETURNS boolean
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $fn$
DECLARE
  d record;
  s record;
  observed_minor bigint;
  observed_status text;
  current_minor bigint;
BEGIN
  IF p_decision_id IS NULL THEN
    RETURN false;
  END IF;
  SELECT x.outcome, x.final_amount_minor, x.ladder_from_minor INTO d
    FROM channel_data.price_decision x
   WHERE x.tenant_id = p_tenant_id AND x.price_decision_id = p_decision_id AND x.write_scope_id = p_write_scope_id;
  IF d.ladder_from_minor IS NULL OR d.outcome IS DISTINCT FROM 'APPROVED' OR d.final_amount_minor IS DISTINCT FROM p_amount_minor THEN
    RETURN false;
  END IF;
  SELECT y.latest_version_accepted, y.last_sent_amount_minor INTO s
    FROM tenant_data.write_scope_sync_state y WHERE y.tenant_id = p_tenant_id AND y.write_scope_id = p_write_scope_id;
  SELECT o.observed_amount_minor, o.sync_status INTO observed_minor, observed_status
    FROM channel_data.observed_channel_state o
   WHERE o.tenant_id = p_tenant_id AND o.write_scope_id = p_write_scope_id AND o.field = 'PRICE';
  IF s.latest_version_accepted > 0 AND s.last_sent_amount_minor IS NOT NULL THEN
    current_minor := s.last_sent_amount_minor;
    -- Ревью шага 73, находка 3: витрина разошлась с отправленным (правка в кабинете канала, Р-55) — на витрине может стоять цена выше
    -- нашей; ступень не должна её снизить, поэтому она выше обеих
    IF observed_status = 'DIVERGED' AND observed_minor IS NOT NULL THEN
      current_minor := greatest(current_minor, observed_minor);
    END IF;
  ELSE
    current_minor := observed_minor;
  END IF;
  RETURN current_minor IS NOT NULL AND p_amount_minor > current_minor;
END $fn$;
ALTER FUNCTION tenant_data.price_ladder_step_allowed(uuid, uuid, bigint, uuid) OWNER TO repracer_price_ladder;
REVOKE EXECUTE ON FUNCTION tenant_data.price_ladder_step_allowed(uuid, uuid, bigint, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenant_data.price_ladder_step_allowed(uuid, uuid, bigint, uuid) TO repracer_app, repracer_admin, repracer_owner;

/** Р-208: от какой цены поднялась ступень — для журнала наших цен (у обычного решения NULL) */
CREATE FUNCTION tenant_data.price_ladder_from(p_tenant_id uuid, p_decision_id uuid) RETURNS bigint
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $fn$
  SELECT x.ladder_from_minor FROM channel_data.price_decision x WHERE x.tenant_id = p_tenant_id AND x.price_decision_id = p_decision_id
$fn$;
ALTER FUNCTION tenant_data.price_ladder_from(uuid, uuid) OWNER TO repracer_price_ladder;
REVOKE EXECUTE ON FUNCTION tenant_data.price_ladder_from(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenant_data.price_ladder_from(uuid, uuid) TO repracer_app, repracer_admin, repracer_owner;

SET ROLE repracer_owner;
/**
 * Сверка цены с полом с учётом ступени: ступень ниже пола — пол возвращается, отказа нет; всё остальное — прежняя сверка
 * `assert_price_floor(4)` [Р-83] с прежним сообщением отказа
 */
CREATE FUNCTION tenant_data.assert_price_floor(p_tenant_id uuid, p_write_scope_id uuid, p_amount_minor bigint, p_stage text, p_decision_id uuid)
  RETURNS bigint
  LANGUAGE plpgsql STABLE AS $fn$
DECLARE
  f record;
BEGIN
  IF p_decision_id IS NOT NULL AND tenant_data.price_ladder_step_allowed(p_tenant_id, p_write_scope_id, p_amount_minor, p_decision_id) THEN
    SELECT * INTO f FROM tenant_data.effective_price_floor(p_tenant_id, p_write_scope_id, now());
    IF f.floor_minor IS NOT NULL AND p_amount_minor < f.floor_minor THEN
      RETURN f.floor_minor;
    END IF;
  END IF;
  RETURN tenant_data.assert_price_floor(p_tenant_id, p_write_scope_id, p_amount_minor, p_stage);
END $fn$;
RESET ROLE;

-- Записи цены сверяются с полом с учётом ступени — при создании и перед каждой отправкой (вызов получает решение записи)
DO $do$
DECLARE
  ins text := pg_get_functiondef('tenant_data.channel_write_before_insert()'::regprocedure);
  upd text := pg_get_functiondef('tenant_data.channel_write_before_update()'::regprocedure);
  a text := $s$tenant_data.assert_price_floor(NEW.tenant_id, NEW.write_scope_id, NEW.amount_minor, 'at creation');$s$;
  b text := $s$tenant_data.assert_price_floor(NEW.tenant_id, NEW.write_scope_id, NEW.amount_minor, 'at dispatch');$s$;
BEGIN
  IF (length(ins) - length(replace(ins, a, ''))) / length(a) <> 1 OR (length(upd) - length(replace(upd, b, ''))) / length(b) <> 1 THEN
    RAISE EXCEPTION '0180: the channel write triggers are not the definitions the migration expects';
  END IF;
  EXECUTE replace(ins, a, $s$tenant_data.assert_price_floor(NEW.tenant_id, NEW.write_scope_id, NEW.amount_minor, 'at creation', NEW.price_decision_id);$s$);
  EXECUTE replace(upd, b, $s$tenant_data.assert_price_floor(NEW.tenant_id, NEW.write_scope_id, NEW.amount_minor, 'at dispatch', NEW.price_decision_id);$s$);
END $do$;

-- Журнал наших цен получает признак ступени из её решения — только у записи ниже пола на момент отправки
DO $do$
DECLARE
  d text := pg_get_functiondef('tenant_data.channel_write_record_price_history()'::regprocedure);
  a text := $s$effective_min_price_minor,
       channel_write_id, write_version, dispatched_at)$s$;
  b text := $s$NEW.floor_at_dispatch_minor, NEW.channel_write_id, NEW.version, NEW.dispatched_at$s$;
BEGIN
  IF (length(d) - length(replace(d, a, ''))) / length(a) <> 1 OR (length(d) - length(replace(d, b, ''))) / length(b) <> 1 THEN
    RAISE EXCEPTION '0180: channel_write_record_price_history() is not the definition the migration expects';
  END IF;
  d := replace(d, a, $s$effective_min_price_minor,
       channel_write_id, write_version, dispatched_at, ladder_from_minor)$s$);
  d := replace(d, b, $s$NEW.floor_at_dispatch_minor, NEW.channel_write_id, NEW.version, NEW.dispatched_at,
           CASE WHEN NEW.amount_minor < NEW.floor_at_dispatch_minor THEN tenant_data.price_ladder_from(NEW.tenant_id, NEW.price_decision_id) END$s$);
  EXECUTE d;
END $do$;

-- Удержание пола (0132, 0178) у ступени: стратегия хотела цену ниже пола маржи, но предложена ступень — она НИЖЕ пола, и удержанной
-- считается сама ступень, а не пол: «без пола продали бы на X дешевле» не приписывает полу денег, которых ступень не удержала (ревью
-- шага 73, находка 4). Функция переопределяется с тем же владельцем, SECURITY DEFINER и search_path, как в 0178
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
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(NEW.rationale -> 'explanation', '[]'::jsonb)) x WHERE x ->> 'code' = 'RAISED_TOWARD_FLOOR') THEN
    held := NEW.proposed_amount_minor;
  END IF;
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
    RAISE EXCEPTION '0180: the floor hold recorder lost its owner or SECURITY DEFINER';
  END IF;
END $do$;

-- ---------------------------------------------------------------- 3. Запросы на переоценку единицы [Р-209, Р-210]
SET ROLE repracer_owner;
CREATE TABLE tenant_data.floor_raise_request (
  tenant_id       uuid NOT NULL,
  write_scope_id  uuid NOT NULL,
  -- COST_UPDATE — новая версия себестоимости или оценки комиссии (Р-210); FLOOR_RECHECK — перепроверка пола перед отправкой отказала (Р-209).
  -- Значения ставит единственная функция-писатель ниже: ограничение перечня было бы её дублем [Р-104]
  reason          text NOT NULL,
  requested_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, write_scope_id, reason),
  FOREIGN KEY (tenant_id, write_scope_id) REFERENCES tenant_data.write_scope (tenant_id, write_scope_id) ON DELETE CASCADE
);
COMMENT ON TABLE tenant_data.floor_raise_request IS
  'Р-209, Р-210 (шаг 73): единица ждёт переоценки без наблюдения конкурентов — себестоимость выросла или перепроверка пола отказала; ставит база, забирает пересчёт по расписанию';
SELECT security.register_table('tenant_data.floor_raise_request', 'TENANT', 'mutable_delete', 'none');
SELECT security.grant_retention('tenant_data.floor_raise_request');
-- Данные тенанта по времени без экспорта не удаляются: запрос забирает пересчёт, строк не больше двух на единицу (ключ — единица и
-- повод), и остаток уходит вместе с тенантом
INSERT INTO maintenance.retention_policy (table_name, method, bound) VALUES ('tenant_data.floor_raise_request', 'TENANT_CLOSURE_ONLY', 'MAX_AGE');
-- Ставит запросы только база (функция узкой роли ниже): у пути решения — только чтение и снятие. Административная роль — член роли
-- пути решения и наследует ровно их же; вставки и правки у неё нет
REVOKE INSERT, UPDATE, DELETE ON tenant_data.floor_raise_request FROM repracer_admin;
-- Путь решения (пересчёт по расписанию) читает и забирает запросы своего тенанта
GRANT SELECT, DELETE ON tenant_data.floor_raise_request TO repracer_app;
CREATE POLICY floor_raise_consume ON tenant_data.floor_raise_request FOR ALL TO repracer_app
  USING (tenant_id = security.current_tenant_id()) WITH CHECK (tenant_id = security.current_tenant_id());
RESET ROLE;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'repracer_floor_raise') THEN CREATE ROLE repracer_floor_raise NOLOGIN; END IF;
END $$;
GRANT USAGE ON SCHEMA tenant_data, security TO repracer_floor_raise;
GRANT EXECUTE ON FUNCTION security.current_tenant_id() TO repracer_floor_raise;
GRANT SELECT (tenant_id, write_scope_id, reason, requested_at), INSERT (tenant_id, write_scope_id, reason, requested_at), UPDATE (requested_at)
  ON tenant_data.floor_raise_request TO repracer_floor_raise;
GRANT SELECT (tenant_id, write_scope_id, product_id, channel_account_id, field, pricing_mode) ON tenant_data.write_scope TO repracer_floor_raise;
CREATE POLICY floor_raise_writer ON tenant_data.floor_raise_request FOR ALL TO repracer_floor_raise
  USING (tenant_id = security.current_tenant_id()) WITH CHECK (tenant_id = security.current_tenant_id());
CREATE POLICY floor_raise_scope_read ON tenant_data.write_scope FOR SELECT TO repracer_floor_raise USING (tenant_id = security.current_tenant_id());

/**
 * Запрос на переоценку ставит ТОЛЬКО база, триггерами: себестоимость (новая версия профиля товара), оценка комиссии единицы и запись цены,
 * завершённая отказом перепроверки пола. Только единицы цены в режиме ENGINE; повторный запрос сдвигает время — пересчёт забирает запрос
 * не новее прочитанного. Время — часы исполнения, а не начала транзакции: запрос длинной транзакции, поставленный после прочитанного,
 * не окажется старше него и не снимется непрочитанным (ревью шага 73). Признак «нарушен пол» отказа записи пишет диспетчер по причине
 * отказа базы (`end_params.violated`)
 */
CREATE FUNCTION tenant_data.request_floor_raise() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
DECLARE
  why text;
BEGIN
  -- Источник — аргументом триггера, а не TG_TABLE_NAME: у секции истории записей там имя секции, а не родителя
  IF TG_ARGV[0] = 'cost_profile' THEN
    INSERT INTO tenant_data.floor_raise_request (tenant_id, write_scope_id, reason, requested_at)
    SELECT s.tenant_id, s.write_scope_id, 'COST_UPDATE', clock_timestamp()
      FROM tenant_data.write_scope s
     WHERE s.tenant_id = NEW.tenant_id AND s.product_id = NEW.product_id AND s.field = 'PRICE' AND s.pricing_mode = 'ENGINE'
       AND (NEW.channel_account_id IS NULL OR s.channel_account_id = NEW.channel_account_id)
    ON CONFLICT (tenant_id, write_scope_id, reason) DO UPDATE SET requested_at = greatest(floor_raise_request.requested_at, EXCLUDED.requested_at);
    RETURN NULL;
  END IF;
  IF TG_ARGV[0] = 'fee_estimate' THEN
    -- Перезапись той же оценки (повторный расчёт тарифа) — не изменение себестоимости и не повод (условие WHEN у триггера запрещено, шаг 19)
    IF TG_OP = 'UPDATE' AND OLD.fee_model IS NOT DISTINCT FROM NEW.fee_model THEN
      RETURN NULL;
    END IF;
    why := 'COST_UPDATE';
  ELSIF TG_ARGV[0] = 'channel_write_history'
        AND NEW.field = 'PRICE' AND NEW.end_reason = 'WRITE_BLOCKED_BY_BOUND_RECHECK' AND NEW.end_params ->> 'violated' = 'FLOOR' THEN
    why := 'FLOOR_RECHECK';
  ELSE
    RETURN NULL;
  END IF;
  INSERT INTO tenant_data.floor_raise_request (tenant_id, write_scope_id, reason, requested_at)
  SELECT s.tenant_id, s.write_scope_id, why, clock_timestamp()
    FROM tenant_data.write_scope s
   WHERE s.tenant_id = NEW.tenant_id AND s.write_scope_id = NEW.write_scope_id AND s.field = 'PRICE' AND s.pricing_mode = 'ENGINE'
  ON CONFLICT (tenant_id, write_scope_id, reason) DO UPDATE SET requested_at = greatest(floor_raise_request.requested_at, EXCLUDED.requested_at);
  RETURN NULL;
END $fn$;
ALTER FUNCTION tenant_data.request_floor_raise() OWNER TO repracer_floor_raise;
REVOKE EXECUTE ON FUNCTION tenant_data.request_floor_raise() FROM PUBLIC;
-- Секции истории записей создаёт владелец схемы: секция наследует триггер, и создающей роли нужно право исполнять его функцию (как 0132)
GRANT EXECUTE ON FUNCTION tenant_data.request_floor_raise() TO repracer_owner;

CREATE TRIGGER zf_cost_profile_request_floor_raise AFTER INSERT ON tenant_data.cost_profile
  FOR EACH ROW EXECUTE FUNCTION tenant_data.request_floor_raise('cost_profile');
CREATE TRIGGER zf_fee_estimate_request_floor_raise AFTER INSERT ON channel_data.fee_estimate
  FOR EACH ROW EXECUTE FUNCTION tenant_data.request_floor_raise('fee_estimate');
CREATE TRIGGER zf_fee_estimate_changed_request_floor_raise AFTER UPDATE ON channel_data.fee_estimate
  FOR EACH ROW EXECUTE FUNCTION tenant_data.request_floor_raise('fee_estimate');
CREATE TRIGGER zf_channel_write_history_request_floor_raise AFTER INSERT ON tenant_data.channel_write_history
  FOR EACH ROW EXECUTE FUNCTION tenant_data.request_floor_raise('channel_write_history');

-- Р-96: путь решения читает и забирает запросы — строкой в списке разрешённого (проверку схемы держит правило «в обе стороны»)
DO $do$
DECLARE
  d text := pg_get_functiondef('security.decision_path_allowed_privileges()'::regprocedure);
  a text := $s$
  ) AS a(t, p, c)$s$;
BEGIN
  IF (length(d) - length(replace(d, a, ''))) / length(a) <> 1 THEN
    RAISE EXCEPTION '0180: security.decision_path_allowed_privileges() is not the definition the migration expects';
  END IF;
  EXECUTE replace(d, a, $s$,
    -- Шаг 73 [Р-209, Р-210]: пересчёт по расписанию забирает запросы на переоценку единицы, поставленные базой
    ('tenant_data.floor_raise_request', 'SELECT', NULL), ('tenant_data.floor_raise_request', 'DELETE', NULL)
  ) AS a(t, p, c)$s$);
END $do$;

-- Закрытие тенанта уносит запросы вместе с ним (правило 0102): в список удаления — перед единицами записи
DO $do$
DECLARE
  d text := pg_get_functiondef('maintenance.purge_tenant_data(uuid)'::regprocedure);
  a text := $s$'tenant_data.alert',$s$;
BEGIN
  IF (length(d) - length(replace(d, a, ''))) / length(a) <> 1 THEN
    RAISE EXCEPTION '0180: maintenance.purge_tenant_data(uuid) is not the definition the migration expects';
  END IF;
  EXECUTE replace(d, a, $s$'tenant_data.alert', 'tenant_data.floor_raise_request',$s$);
END $do$;

-- ---------------------------------------------------------------- 4. Реестры параметров слепка объяснения
SET ROLE repracer_owner;
DO $do$
DECLARE
  keys jsonb := security.eternal_param_keys();
  kinds jsonb := security.eternal_param_kinds();
BEGIN
  IF keys ? 'RAISED_TOWARD_FLOOR' OR NOT keys ? 'RAISED_TO_FLOOR' OR (keys -> 'RAISED_TO_FLOOR') ? 'after' THEN
    RAISE EXCEPTION '0180: the reason registries are not the ones the migration expects';
  END IF;
  keys := keys || jsonb_build_object(
    'RAISED_TO_FLOOR', '["after","bound","currency","currentMinor","floorMinor","minMarginBp"]'::jsonb,
    'RAISED_TOWARD_FLOOR', '["after","bound","currency","currentMinor","floorMinor","minMarginBp","stepLimitBp","stepsLeft"]'::jsonb);
  kinds := jsonb_set(kinds, '{RAISED_TO_FLOOR,after}', '{"k":"enum","v":["COST_UPDATE","FLOOR_RECHECK"]}'::jsonb)
    || jsonb_build_object('RAISED_TOWARD_FLOOR', '{"currentMinor":{"k":"money"},"floorMinor":{"k":"money"},"bound":{"k":"enum","v":["min","margin_floor"]},"minMarginBp":{"k":"bp"},"stepLimitBp":{"k":"bp"},"stepsLeft":{"k":"count"},"after":{"k":"enum","v":["COST_UPDATE","FLOOR_RECHECK"]},"currency":{"k":"currency"}}'::jsonb);
  EXECUTE format($f$CREATE OR REPLACE FUNCTION security.eternal_param_keys() RETURNS jsonb
    LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $b$ SELECT %L::jsonb $b$$f$, keys);
  EXECUTE format($f$CREATE OR REPLACE FUNCTION security.eternal_param_kinds() RETURNS jsonb
    LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $b$ SELECT %L::jsonb $b$$f$, kinds);
END $do$;
RESET ROLE;

COMMIT;
