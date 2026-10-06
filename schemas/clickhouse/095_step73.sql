-- 095_step73.sql
-- Шаг 73 [Р-208]: ступень лестницы к полу — единственная одобренная цена ниже пола: ниже пола, но выше нынешней цены, от которой она
-- поднимается (`ladder_from_minor`, как channel_data.price_decision в PostgreSQL, 0180). Без исключения выгрузка суток со ступенью
-- отказывала бы целиком на ограничении floor_respected (ревью шага 73, находка 2). Применяется после 090; идемпотентно.

ALTER TABLE repracer_analytics.price_decision
    ADD COLUMN IF NOT EXISTS ladder_from_minor Nullable(Int64) AFTER effective_ceiling_minor;

ALTER TABLE repracer_analytics.price_decision DROP CONSTRAINT IF EXISTS floor_respected;
ALTER TABLE repracer_analytics.price_decision
    ADD CONSTRAINT floor_respected CHECK final_amount_minor IS NULL
        OR ((final_amount_minor >= effective_floor_minor OR (ladder_from_minor IS NOT NULL AND final_amount_minor > ladder_from_minor))
            AND final_amount_minor <= effective_ceiling_minor);
