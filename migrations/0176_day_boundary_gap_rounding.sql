-- 0176_day_boundary_gap_rounding.sql
-- Шаг 70 (ревью шага 70, находка 5): самый длинный перерыв между теневыми решениями [Р-204] считает функция
-- `platform.longest_gap_hours(timestamptz[])` — в часах с округлением ВВЕРХ (0 — решение одно или их нет). До шага формула жила внутри
-- функции доказательства (0173), и ни одна проверка не отличала округление вверх от вниз: решения прожатой недели ложатся на целые часы,
-- а смоук журнала пишет числа прямо в строку. С округлением вниз перерыв 36 ч 59 мин считался бы 36 и проходил ограничение
-- `day_boundary_acceptance_no_long_gap`. Теперь смоук зовёт функцию сам: 36 ч — 36, 36 ч 1 мин — 37. Функция доказательства
-- переопределяется с тем же телом, перерыв — этой функцией. Новых защит нет: функция — вычисление, держит её смоук.

BEGIN;
SET ROLE repracer_owner;

CREATE FUNCTION platform.longest_gap_hours(p_at timestamptz[]) RETURNS integer
  LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog AS $fn$
  SELECT coalesce(ceil(max(extract(epoch FROM g.at - g.prev)) / 3600), 0)::int
    FROM (SELECT u.at, lag(u.at) OVER (ORDER BY u.at) AS prev FROM unnest(p_at) AS u(at)) g
$fn$;
COMMENT ON FUNCTION platform.longest_gap_hours(timestamptz[]) IS
  'Шаг 70 [Р-204]: самый длинный промежуток между соседними моментами в часах с округлением вверх; 0 — момент один или их нет';
REVOKE ALL ON FUNCTION platform.longest_gap_hours(timestamptz[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.longest_gap_hours(timestamptz[]) TO repracer_retention;

-- Функцией доказательства владеет хранитель (0173): правка — вне SET ROLE, CREATE OR REPLACE сохраняет владельца и права
RESET ROLE;

CREATE OR REPLACE FUNCTION platform.day_boundary_shadow_evidence(p_tenant_id uuid, p_channel_account_id uuid, p_marketplace text, p_days int DEFAULT 14)
  RETURNS TABLE (shadow_days integer, longest_gap_hours integer, shadow_since timestamptz, last_shadow_at timestamptz, decisions bigint,
                 held_writes bigint, budget_writes bigint, worst_window_max bigint, budget_limit integer, account_mode text, demo boolean)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $fn$
  WITH acc AS (
    SELECT a.channel, a.write_mode, t.demo FROM tenant_data.channel_account a JOIN tenant_data.tenant t ON t.tenant_id = a.tenant_id
     WHERE a.tenant_id = p_tenant_id AND a.channel_account_id = p_channel_account_id AND a.disconnected_at IS NULL
       AND p_marketplace = ANY (a.marketplaces)
  ), scopes AS (
    SELECT s.write_scope_id FROM tenant_data.offer_mapping om
     CROSS JOIN LATERAL (VALUES (om.price_write_scope_id), (om.quantity_write_scope_id)) s(write_scope_id)
     WHERE om.tenant_id = p_tenant_id AND om.channel_account_id = p_channel_account_id AND om.marketplace = p_marketplace
       AND s.write_scope_id IS NOT NULL
  ), dec AS (
    SELECT pd.decided_at FROM channel_data.price_decision pd
     WHERE pd.tenant_id = p_tenant_id AND pd.shadow AND pd.write_scope_id IN (SELECT write_scope_id FROM scopes)
       AND pd.decided_at >= now() - make_interval(days => p_days)
  ), held AS (
    SELECT h.finished_at, h.would_spend_budget, coalesce(h.budget_scope_key, h.write_scope_id::text) AS k
      FROM tenant_data.channel_write_history h
     WHERE h.tenant_id = p_tenant_id AND h.final_status = 'SHADOW_HELD' AND h.write_scope_id IN (SELECT write_scope_id FROM scopes)
       AND h.finished_at >= now() - make_interval(days => p_days)
  ), win AS (
    SELECT count(*) OVER (PARTITION BY k ORDER BY finished_at RANGE BETWEEN interval '24 hours' PRECEDING AND CURRENT ROW) AS n
      FROM held WHERE would_spend_budget
  )
  /**
   * Ревью шага 69, находка 3: сутки тени — ДЛИТЕЛЬНОСТЬ от первого до последнего решения в целых сутках. Перерыв — самый длинный
   * промежуток между соседними решениями в часах, с округлением вверх (0 — решение одно или их нет); даты UTC не считаются: решения раз
   * в сутки сдвигаются и перешагивают полночь (см. столбец журнала)
   */
  SELECT (SELECT floor(extract(epoch FROM max(decided_at) - min(decided_at)) / 86400)::int FROM dec),
         (SELECT platform.longest_gap_hours(array_agg(decided_at)) FROM dec),
         (SELECT min(decided_at) FROM dec), (SELECT max(decided_at) FROM dec), (SELECT count(*) FROM dec),
         (SELECT count(*) FROM held), (SELECT count(*) FROM held WHERE would_spend_budget),
         coalesce((SELECT max(n) FROM win), 0),
         (SELECT (c.object_edit_limit ->> 'limit')::int FROM platform.channel_capability c
           WHERE c.channel = (SELECT channel FROM acc) AND c.field = 'PRICE' AND c.status = 'ACTIVE' AND c.object_edit_limit IS NOT NULL
           ORDER BY c.valid_from DESC LIMIT 1),
         (SELECT write_mode FROM acc), (SELECT demo FROM acc)
$fn$;

COMMIT;
