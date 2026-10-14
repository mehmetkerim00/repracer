-- 096_step89.sql
-- Шаг 89: снимки конкурентов Walmart (источник WALMART_BUY_BOX, опрос — W-05) — в том же списке источников, что у остальных каналов
-- (как channel_data.competitor_state в PostgreSQL, 0186). Без него выгрузка суток пропускала бы снимки Walmart с причиной SOURCE_UNKNOWN,
-- и сутки с пропусками не отмечались бы проверенными. Применяется после 095; идемпотентно.

ALTER TABLE repracer_analytics.competitor_snapshot DROP CONSTRAINT IF EXISTS source_known;
ALTER TABLE repracer_analytics.competitor_snapshot
    ADD CONSTRAINT source_known CHECK source IN ('AMAZON_ANY_OFFER_CHANGED', 'AMAZON_COMPETITIVE_SUMMARY',
                                                 'KAUFLAND_BUY_BOX_CHANGED', 'KAUFLAND_BUYBOX', 'KAUFLAND_COMPETITORS_COMPARER',
                                                 'WALMART_BUY_BOX');
