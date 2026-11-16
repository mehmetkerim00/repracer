-- 0234_floor_hold_episodes.sql
-- Шаг 144 (внешний аудит UX, корзина 1.2–1.3): «удержание пола» — одно определение у экрана тени, недельного письма и Protections.
--
-- До шага экран тени и письмо складывали строку `floor_hold` КАЖДОГО записанного намерения, а Protections склеивал подряд идущие
-- удержания одного предложения в эпизод и брал сумму из горячих намерений (3 суток, Р-28). Одно удержание в тени пишет два намерения:
-- одобренное решение на полу и следующий повтор «уже предложено в тени» с тем же шагом пола (схлопывание шага 116 пишет первый
-- повтор строкой) — на QA-A за 7 суток 359 строк = 179 одобренных + 180 повторов, и сумма тени ровно вдвое больше суммы Protections.
--
-- 1. Строка удержания несёт эпизод (`episode_intent_id`: намерение, с которого удержание началось), удержанную цену (`kept_minor`) и
--    шаг причины (`hold_reason`: код и параметры, как в объяснении), — их ставит тот же триггер намерения. Эпизод продолжается, если
--    ПРЕДЫДУЩЕЕ намерение того же предложения тоже было удержанием пола того же вида (распродажа или нет); оценка без удержания
--    его закрывает — то же правило, что у Protections (ревью шага 22, находка 4). Строки до шага — каждая своим эпизодом.
-- 2. `platform.floor_hold_episodes` — эпизоды окна, одно место определения: сумма эпизода — наибольшая разница за эпизод.
--    `platform.floor_hold_totals` — события, уникальные SKU, суммы по валюте [Р-71] и удержания распродажи отдельно.
--    Сумма экрана тени и письма (`shadow_floor_savings_between`) — по эпизодам.

BEGIN;

SET ROLE repracer_owner;
ALTER TABLE channel_data.floor_hold
  ADD COLUMN episode_intent_id uuid,
  ADD COLUMN kept_minor bigint,
  ADD COLUMN hold_reason jsonb;
COMMENT ON COLUMN channel_data.floor_hold.episode_intent_id IS
  'Шаг 144: намерение, с которого началось удержание; повторы одного удержания — один эпизод. NULL — строка до шага, свой эпизод';
COMMENT ON COLUMN channel_data.floor_hold.kept_minor IS 'Шаг 144: цена, которую удержал пол (пол, текущая цена или ступень лестницы)';
COMMENT ON COLUMN channel_data.floor_hold.hold_reason IS
  'Шаг 144: шаг объяснения, на котором пол удержал цену, — код и параметры; цель стратегии в нём — производная от цены конкурента, срок строки 18 месяцев';
RESET ROLE;

-- Триггер читает предыдущее намерение предложения и его строку удержания — только своего тенанта
GRANT SELECT (tenant_id, price_intent_id, write_scope_id, created_at) ON channel_data.price_intent TO repracer_floor_hold;
CREATE POLICY floor_hold_previous_intent ON channel_data.price_intent FOR SELECT TO repracer_floor_hold USING (tenant_id = security.current_tenant_id());
GRANT SELECT (tenant_id, price_intent_id, episode_intent_id, clearance) ON channel_data.floor_hold TO repracer_floor_hold;
CREATE POLICY floor_hold_previous_hold ON channel_data.floor_hold FOR SELECT TO repracer_floor_hold USING (tenant_id = security.current_tenant_id());

-- Тот же владелец, SECURITY DEFINER и search_path, что в 0132/0180; тексты, которые мутирует каталог (OQ-232, шаги 73 и 102), — прежние
CREATE OR REPLACE FUNCTION channel_data.price_intent_record_floor_hold() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
DECLARE
  target bigint;
  held bigint;
  hold jsonb;
  in_shadow boolean;
  in_clearance boolean;
  episode uuid;
BEGIN
  SELECT (x -> 'params' ->> 'targetMinor')::bigint,
         CASE x ->> 'code' WHEN 'CAPPED_AT_MIN_PRICE' THEN (x -> 'params' ->> 'minMinor')::bigint
                           WHEN 'CAPPED_AT_MARGIN_FLOOR' THEN (x -> 'params' ->> 'floorMinor')::bigint
                           WHEN 'CAPPED_AT_CLEARANCE_FLOOR' THEN (x -> 'params' ->> 'floorMinor')::bigint
                           ELSE NEW.proposed_amount_minor END,
         jsonb_build_object('code', x ->> 'code', 'params', x -> 'params')
    INTO target, held, hold
    FROM jsonb_array_elements(coalesce(NEW.rationale -> 'explanation', '[]'::jsonb)) x
   WHERE x ->> 'code' IN ('CAPPED_AT_MIN_PRICE', 'CAPPED_AT_MARGIN_FLOOR', 'CAPPED_AT_CLEARANCE_FLOOR', 'TARGET_OUTSIDE_BOUNDS_HOLD') AND x -> 'params' ? 'targetMinor'
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
    -- Шаг 102 [Р-227]: решение в режиме распродажи открывается его причиной — удержание помечено как намеренный убыток
    in_clearance := EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(NEW.rationale -> 'explanation', '[]'::jsonb)) y WHERE y ->> 'code' = 'CLEARANCE_FLOOR');
    -- Шаг 144: эпизод продолжается, если предыдущее намерение предложения тоже было удержанием пола того же вида
    SELECT coalesce(fh.episode_intent_id, fh.price_intent_id) INTO episode
      FROM (SELECT pi.price_intent_id FROM channel_data.price_intent pi
             WHERE pi.tenant_id = NEW.tenant_id AND pi.write_scope_id = NEW.write_scope_id
               AND pi.created_at <= NEW.created_at AND pi.price_intent_id <> NEW.price_intent_id
             ORDER BY pi.created_at DESC, pi.price_intent_id DESC LIMIT 1) prev
      JOIN channel_data.floor_hold fh ON fh.tenant_id = NEW.tenant_id AND fh.price_intent_id = prev.price_intent_id AND fh.clearance = in_clearance;
    INSERT INTO channel_data.floor_hold (tenant_id, price_intent_id, intent_created_at, write_scope_id, currency, below_minor, shadow, clearance,
                                         episode_intent_id, kept_minor, hold_reason)
    VALUES (NEW.tenant_id, NEW.price_intent_id, NEW.created_at, NEW.write_scope_id, NEW.currency, held - target, coalesce(in_shadow, false), in_clearance,
            coalesce(episode, NEW.price_intent_id), held, hold)
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NULL;
END $fn$;

DO $do$
BEGIN
  IF (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid = 'channel_data.price_intent_record_floor_hold()'::regprocedure) <> 'repracer_floor_hold'
     OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'channel_data.price_intent_record_floor_hold()'::regprocedure) THEN
    RAISE EXCEPTION '0234: the floor hold recorder lost its owner or SECURITY DEFINER';
  END IF;
END $do$;

-- ---------------------------------------------------------------- Эпизоды окна — одно место определения
/**
 * Удержания пола окна [p_from, p_to) по эпизодам: строка на эпизод — его наибольшая разница и строка, на которой она была (удержанная
 * цена, шаг причины, намерение — по нему находится решение); начало — первая строка эпизода в окне. Удержание, начавшееся до окна и
 * длящееся в нём, — одно событие окна. `p_shadow_only` — только аккаунты в тени (экран тени и письмо); Protections — все
 */
CREATE FUNCTION platform.floor_hold_episodes(p_tenant_id uuid, p_from timestamptz, p_to timestamptz, p_shadow_only boolean)
  RETURNS TABLE (write_scope_id uuid, currency text, clearance boolean, shadow boolean, started_at timestamptz, price_intent_id uuid,
                 intent_created_at timestamptz, below_minor bigint, kept_minor bigint, hold_reason jsonb)
  LANGUAGE sql STABLE SET search_path = pg_catalog AS $fn$
  SELECT DISTINCT ON (h.write_scope_id, h.episode)
         h.write_scope_id, h.currency, h.clearance, h.shadow, min(h.intent_created_at) OVER (PARTITION BY h.write_scope_id, h.episode),
         h.price_intent_id, h.intent_created_at, h.below_minor, h.kept_minor, h.hold_reason
    FROM (SELECT fh.*, coalesce(fh.episode_intent_id, fh.price_intent_id) AS episode
            FROM channel_data.floor_hold fh
           WHERE fh.tenant_id = p_tenant_id AND fh.intent_created_at >= p_from AND fh.intent_created_at < p_to AND (fh.shadow OR NOT p_shadow_only)) h
   ORDER BY h.write_scope_id, h.episode, h.below_minor DESC, h.intent_created_at
$fn$;

/** События (эпизоды без распродажи), уникальные SKU продавца, суммы по валюте и удержания пола распродажи — отдельно [Р-227] */
CREATE FUNCTION platform.floor_hold_totals(p_tenant_id uuid, p_from timestamptz, p_to timestamptz, p_shadow_only boolean)
  RETURNS TABLE (savings jsonb, events bigint, skus bigint, clearance_events bigint)
  LANGUAGE sql STABLE SET search_path = pg_catalog AS $fn$
  WITH e AS (SELECT * FROM platform.floor_hold_episodes(p_tenant_id, p_from, p_to, p_shadow_only))
  SELECT coalesce((SELECT jsonb_agg(jsonb_build_object('currency', g.currency, 'minor', g.total) ORDER BY g.currency)
                     FROM (SELECT e.currency, sum(e.below_minor)::bigint AS total FROM e WHERE NOT e.clearance GROUP BY e.currency) g), '[]'::jsonb),
         (SELECT count(*) FROM e WHERE NOT e.clearance),
         (SELECT count(DISTINCT ws.product_id) FROM e
            JOIN tenant_data.write_scope ws ON ws.tenant_id = p_tenant_id AND ws.write_scope_id = e.write_scope_id
           WHERE NOT e.clearance),
         (SELECT count(*) FROM e WHERE e.clearance)
$fn$;
REVOKE EXECUTE ON FUNCTION platform.floor_hold_episodes(uuid, timestamptz, timestamptz, boolean) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION platform.floor_hold_totals(uuid, timestamptz, timestamptz, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.floor_hold_episodes(uuid, timestamptz, timestamptz, boolean) TO repracer_admin, repracer_retention;
GRANT EXECUTE ON FUNCTION platform.floor_hold_totals(uuid, timestamptz, timestamptz, boolean) TO repracer_admin;

-- Сумма экрана тени и недельного письма [Р-173] — по эпизодам; распродажа — намеренный убыток, в сумму не входит [Р-227]
CREATE OR REPLACE FUNCTION platform.shadow_floor_savings_between(p_tenant_id uuid, p_from timestamptz, p_to timestamptz)
  RETURNS TABLE (savings jsonb, priced bigint)
  LANGUAGE sql STABLE SET search_path = pg_catalog AS $fn$
  WITH e AS (SELECT e.currency, e.below_minor FROM platform.floor_hold_episodes(p_tenant_id, p_from, p_to, true) e WHERE NOT e.clearance)
  SELECT coalesce((SELECT jsonb_agg(jsonb_build_object('currency', g.currency, 'minor', g.total) ORDER BY g.currency)
                     FROM (SELECT e.currency, sum(e.below_minor)::bigint AS total FROM e GROUP BY e.currency) g), '[]'::jsonb),
         (SELECT count(*) FROM e)
$fn$;

COMMIT;
