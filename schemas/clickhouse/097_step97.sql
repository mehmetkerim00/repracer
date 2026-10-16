-- 097_step97.sql
-- Шаг 97 [Р-218]: снимок конкурентов в аналитическом слое — честное отсутствие поля вместо выдумки.
--   1. Доставка предложения, которую канал не назвал, писалась НУЛЁМ (`offers.shipping_minor Array(Int64)`) — задним числом её не отличить
--      от настоящей бесплатной доставки. С этой версии неизвестная доставка — NULL; прежние строки остаются как были (отличить нечем).
--   2. Держатель Buy Box у строки предложения (`offers.holds_buybox`) — только если канал его назвал (Kaufland — ранг 1, модель Walmart —
--      продавец Buy Box); у Amazon ANY_OFFER_CHANGED держателя нет (A-29) — NULL. Продавец Buy Box — `buybox_seller_ref`.
--   3. Рейтинг продавца (Amazon SellerFeedbackRating) идёт в `offers.feedback_pct` / `offers.feedback_count`, которые до шага 97 писались
--      пустыми. Применяется после 096; идемпотентно.

ALTER TABLE repracer_analytics.competitor_snapshot MODIFY COLUMN `offers.shipping_minor` Array(Nullable(Int64));
ALTER TABLE repracer_analytics.competitor_snapshot ADD COLUMN IF NOT EXISTS `offers.holds_buybox` Array(Nullable(Bool)) AFTER `offers.is_self`;
ALTER TABLE repracer_analytics.competitor_snapshot ADD COLUMN IF NOT EXISTS buybox_seller_ref Nullable(String) CODEC(ZSTD(3)) AFTER buybox_is_self;
