-- 0207_competitor_coupon_in_view.sql
-- Шаг 109 [Р-234]: цена конкурента с купоном. Канал называет её не всегда (сегодня — только Amazon getCompetitiveSummary, акция COUPON, а
-- это снимок сверки, а не решения), но снимок хранит ОБЕ цены у любого источника: базовую (`price`) и с купоном (`couponPrice`). Стратегии
-- считают по базовой — купон условен и не всякому покупателю виден; квитанция и страница Competition показывают купон честно:
-- «$17.15 ($16.29 with coupon)».
--
-- Картина рынка решения (`price_decision.competitor_view`, 0187) получает у строки предложения поле `couponMinor` — только когда купон был
-- в снимке ЭТОГО решения. Форма прежняя строгая: целое число центов, не больше триллиона, и строго ниже базовой цены строки (купон, который
-- не дешевле цены, — не купон). Снимок сверки с купонами и сегментами Buy Box [Р-235] пишется в журнал снимков как прежде: jsonb без
-- проверки формы (0086), выгрузка в ClickHouse — 098_step109.sql.

BEGIN;
SET ROLE repracer_owner;

DO $do$
DECLARE
  d text := pg_get_functiondef('channel_data.competitor_view_valid(jsonb)'::regprocedure);
  a text := $s$'ratingPct', 'ratingCount', 'move', 'wasMinor', 'excluded']$s$;
  b text := $s$unnest(ARRAY['priceMinor', 'shippingMinor', 'landedMinor', 'wasMinor', 'rank', 'ratingCount']) n$s$;
  c text := $s$OR (o ? 'excluded' AND coalesce(o ->> 'excluded', '') NOT IN ('FILTER', 'UNKNOWN'))) END$s$;
BEGIN
  IF (length(d) - length(replace(d, a, ''))) / length(a) <> 1 OR (length(d) - length(replace(d, b, ''))) / length(b) <> 1
     OR (length(d) - length(replace(d, c, ''))) / length(c) <> 1 THEN
    RAISE EXCEPTION '0207: channel_data.competitor_view_valid(jsonb) is not the definition the migration expects';
  END IF;
  EXECUTE replace(replace(replace(d,
    a, $s$'ratingPct', 'ratingCount', 'move', 'wasMinor', 'excluded', 'couponMinor']$s$),
    b, $s$unnest(ARRAY['priceMinor', 'shippingMinor', 'landedMinor', 'wasMinor', 'rank', 'ratingCount', 'couponMinor']) n$s$),
    c, $s$OR (o ? 'excluded' AND coalesce(o ->> 'excluded', '') NOT IN ('FILTER', 'UNKNOWN'))
           -- Шаг 109 [Р-234]: купон дешевле базовой цены; CASE — порядок вычисления OR не обещан
           OR (o ? 'couponMinor' AND jsonb_typeof(o -> 'couponMinor') <> 'null'
               AND CASE WHEN jsonb_typeof(o -> 'couponMinor') = 'number' AND jsonb_typeof(o -> 'priceMinor') = 'number'
                        THEN (o ->> 'couponMinor')::numeric >= (o ->> 'priceMinor')::numeric ELSE false END)) END$s$);
END $do$;

RESET ROLE;
COMMIT;
