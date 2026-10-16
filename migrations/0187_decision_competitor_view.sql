-- 0187_decision_competitor_view.sql
-- Шаг 97 [Р-218]: квитанция решения называет конкурентов. Решение, цена которого выведена из данных конкурентов и которое что-то сделало
-- (одобрено, удержано или отклонено — не «без изменения»), несёт картину рынка на момент расчёта: продавец, цена, доставка, landed-цена,
-- исполнение, держит ли Buy Box, рейтинг — то, что канал назвал, и ничего сверх, — и дифф против предыдущего ПРИНЯТОГО снимка того же
-- предложения: кто изменил цену (было → стало), кто появился, кто ушёл, и кто из них подвинул цену (`trigger`).
--
-- Это данные канала, производные от цен конкурентов [Р-85]: место им — строка решения (30 суток, Р-28), а не вечное ядро. Ядро копирует
-- решение триггером по списку своих столбцов — нового в нём нет, и задним числом ничего не переписывается: у прежних решений столбец пуст.
-- Столбец пишется только при вставке (решение неизменяемо целиком, 0024).

BEGIN;
SET ROLE repracer_owner;

/**
 * Форма картины рынка в решении: объект с полями currency, trigger, offers; строк предложений от 1 до 21 (топ-10 по цене с доставкой, наше и все,
 * кто подвинулся или ушёл); у строки — только поля списка, суммы — целые центы, исполнение и движение — из перечня. Лишнее поле, текст
 * вместо суммы и сотня строк отклоняются: картина рынка — не место для произвольных данных канала
 */
CREATE FUNCTION channel_data.competitor_view_valid(v jsonb) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog AS $fn$
  SELECT jsonb_typeof(v) = 'object'
     AND NOT EXISTS (SELECT 1 FROM jsonb_object_keys(v) k WHERE k <> ALL (ARRAY['currency', 'trigger', 'offers']))
     AND jsonb_typeof(v -> 'currency') = 'string' AND (v ->> 'currency') ~ '^[A-Z]{3}$'
     AND jsonb_typeof(v -> 'offers') = 'array' AND jsonb_array_length(v -> 'offers') BETWEEN 1 AND 21
     AND coalesce(jsonb_typeof(v -> 'trigger'), 'null') IN ('object', 'null')
     AND (jsonb_typeof(v -> 'trigger') IS DISTINCT FROM 'object' OR (
           NOT EXISTS (SELECT 1 FROM jsonb_object_keys(v -> 'trigger') k WHERE k <> ALL (ARRAY['seller', 'self', 'move', 'wasMinor', 'nowMinor']))
           AND (v -> 'trigger' ->> 'move') IN ('UP', 'DOWN', 'APPEARED', 'GONE')))
     AND NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(v -> 'offers') o
        WHERE jsonb_typeof(o) <> 'object'
           OR EXISTS (SELECT 1 FROM jsonb_object_keys(o) k
                       WHERE k <> ALL (ARRAY['seller', 'self', 'rank', 'priceMinor', 'shippingMinor', 'landedMinor', 'fulfilment', 'holdsBuyBox',
                                             'ratingPct', 'ratingCount', 'move', 'wasMinor']))
           OR jsonb_typeof(o -> 'priceMinor') IS DISTINCT FROM 'number'
           OR EXISTS (SELECT 1 FROM unnest(ARRAY['priceMinor', 'shippingMinor', 'landedMinor', 'wasMinor', 'rank', 'ratingCount']) n
                       WHERE o ? n AND jsonb_typeof(o -> n) <> 'null'
                         -- CASE, а не OR: порядок вычисления OR не обещан, и приведение текста к числу упало бы ошибкой вместо «нет»
                         AND CASE WHEN jsonb_typeof(o -> n) = 'number' THEN (o ->> n)::numeric <> trunc((o ->> n)::numeric) OR (o ->> n)::numeric < 0
                                  ELSE true END)
           OR (o ? 'ratingPct' AND jsonb_typeof(o -> 'ratingPct') <> 'null'
               AND CASE WHEN jsonb_typeof(o -> 'ratingPct') = 'number' THEN (o ->> 'ratingPct')::numeric NOT BETWEEN 0 AND 100 ELSE true END)
           OR coalesce(jsonb_typeof(o -> 'self'), 'boolean') <> 'boolean'
           OR coalesce(jsonb_typeof(o -> 'holdsBuyBox'), 'null') NOT IN ('boolean', 'null')
           OR coalesce(jsonb_typeof(o -> 'seller'), 'null') NOT IN ('string', 'null')
           OR (o ? 'fulfilment' AND jsonb_typeof(o -> 'fulfilment') <> 'null' AND (o ->> 'fulfilment') NOT IN ('CHANNEL', 'MERCHANT'))
           OR (o ? 'move' AND jsonb_typeof(o -> 'move') <> 'null' AND (o ->> 'move') NOT IN ('UP', 'DOWN', 'APPEARED', 'GONE')))
$fn$;
GRANT EXECUTE ON FUNCTION channel_data.competitor_view_valid(jsonb) TO repracer_app, repracer_admin;

ALTER TABLE channel_data.price_decision ADD COLUMN competitor_view jsonb;
COMMENT ON COLUMN channel_data.price_decision.competitor_view IS
  'Р-218 (шаг 97): картина рынка на момент расчёта и дифф против предыдущего принятого снимка предложения (кто подвинул цену). Данные канала, 30 суток вместе с решением; в вечное ядро не копируется [Р-85]';
ALTER TABLE channel_data.price_decision
  ADD CONSTRAINT price_decision_competitor_view_shape CHECK (competitor_view IS NULL OR channel_data.competitor_view_valid(competitor_view));
-- Картина рынка — только у цены из данных конкурентов и только у решения, которое что-то сделало: у «без изменения» её нет, как нет и
-- слепка объяснения [Р-74]; у фиксированной и маржинальной цены рынок ни при чём
ALTER TABLE channel_data.price_decision
  ADD CONSTRAINT price_decision_competitor_view_scope CHECK (competitor_view IS NULL OR (competitor_derived AND outcome <> 'NO_CHANGE'));

RESET ROLE;
COMMIT;
