-- 098_step109.sql
-- Шаг 109 [Р-234, Р-235, Р-122]: история снимков конкурентов хранит то, что снимок теперь несёт.
--   1. Цена конкурента с купоном (`offers.coupon_minor`) — когда канал её назвал (Amazon getCompetitiveSummary, акция COUPON). Стратегии
--      считают по базовой цене (`offers.amount_minor`); купона нет — NULL, а не цена.
--   2. Buy Box по группам покупателей с долей просмотров (`buybox_segments`) — Amazon getCompetitiveSummary, `featuredBuyingOptions`:
--      продавец предложения (у нашего — пусто), наш ли, группа (PRIME, NON_PRIME, DEFAULT) и доля просмотров в базисных пунктах.
--   Срок, ключ сортировки и политика строк таблицы прежние (данные канала, 18 месяцев). Применяется после 097; идемпотентно.

ALTER TABLE repracer_analytics.competitor_snapshot ADD COLUMN IF NOT EXISTS `offers.coupon_minor` Array(Nullable(Int64)) AFTER `offers.feedback_pct`;
-- Группы — массивами с общей приставкой, как offers.rank в 030: ClickHouse держит их длины вместе
ALTER TABLE repracer_analytics.competitor_snapshot
    ADD COLUMN IF NOT EXISTS `buybox_segments.seller_ref`    Array(String)                 AFTER `offers.coupon_minor`,
    ADD COLUMN IF NOT EXISTS `buybox_segments.is_self`       Array(Bool)                   AFTER `buybox_segments.seller_ref`,
    ADD COLUMN IF NOT EXISTS `buybox_segments.membership`    Array(LowCardinality(String)) AFTER `buybox_segments.is_self`,
    ADD COLUMN IF NOT EXISTS `buybox_segments.view_share_bp` Array(UInt16)                 AFTER `buybox_segments.membership`;
