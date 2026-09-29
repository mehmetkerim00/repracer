-- 0154_app_quota_exact_window.sql
-- Шаг 58 (ревью шага 56, находки 7 и 18).
--
-- 1. Квота канала на приложение обещала «в любые 24 часа — не больше лимита», а корзина часа была ceil(L / 24). Окно [t, t + 24 ч), начатое не
--    на границе часа, задевает 25 часовых корзин: 25 · ceil(L / 24) — при L = 3000 это 3125 вызовов, на 125 больше обещанного (и ceil сам
--    добавлял до 24 вызовов в сутки при L, не делящемся на 24). Корзина теперь floor(L / 25): 25 · floor(L / 25) ≤ L для ЛЮБОГО окна в 24 часа,
--    где бы ни начинались сутки канала. Цена — недобор: в сутки, выровненные по часу, приложение выбирает 24 · floor(L / 25) (при L = 3000 —
--    2880 из 3000, 96 %). Лимит меньше 25 корзинами не делится — отказ своей причиной, а не корзина 0, молча не дающая ни одного вызова.
-- 2. Политика `app_quota_isolation` (0148, перенесена в 0150) не действовала ни на одну роль: у `repracer_app` права на таблицу отозваны той же
--    миграцией, а чтение и запись идут только функцией роли `repracer_discovery`, у которой своя политика. Мёртвая политика выглядит защитой,
--    которой нет, — удалена; доступ `repracer_app` к счётчику закрыт отсутствием прав, это и проверяется
BEGIN;
SET ROLE repracer_owner;
DROP POLICY app_quota_isolation ON platform.channel_app_quota_hour;
RESET ROLE;

/**
 * Шаг 56, 58: вызов из квоты канала на приложение — не больше floor(лимит / 25) в час UTC (часы — от `p_at`, времени вызывающего). В любые
 * 24 часа — не больше лимита: окно задевает не больше 25 часовых корзин. true — вызов разрешён и списан; false — доля часа исчерпана
 */
CREATE OR REPLACE FUNCTION platform.reserve_channel_app_call(p_channel text, p_api text, p_day_limit integer, p_at timestamptz)
  RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
DECLARE
  h        timestamptz := date_trunc('hour', p_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  per_hour integer;
  granted  boolean;
BEGIN
  IF p_day_limit IS NULL OR p_day_limit < 25 THEN
    RAISE EXCEPTION 'app quota needs a daily limit of at least 25 (one call per hourly bucket of any 24-hour window), got %', p_day_limit USING ERRCODE = 'check_violation';
  END IF;
  per_hour := p_day_limit / 25;
  INSERT INTO platform.channel_app_quota_hour AS q (channel, api, hour, spent, updated_at)
  VALUES (p_channel, p_api, h, 1, p_at)
  ON CONFLICT (tenant_id, channel, api, hour) DO UPDATE SET spent = q.spent + 1, updated_at = excluded.updated_at
   WHERE q.spent < per_hour
  RETURNING true INTO granted;
  RETURN coalesce(granted, false);
END $fn$;

COMMIT;
