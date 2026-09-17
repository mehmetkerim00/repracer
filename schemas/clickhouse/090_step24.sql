-- 090_step24.sql
-- Шаг 24 [Р-122, OQ-156]: снимки конкурентов приходят в competitor_snapshot из журнала пути решения (channel_data.competitor_snapshot_log)
-- при любом вердикте проверки входов — история для бэктеста содержит и испорченные снимки, которые путь решения отклонил [Р-38, Р-42].
-- Вердикт — отдельный столбец; строки до шага 24 (писателя не было) — ACCEPT по умолчанию.

ALTER TABLE repracer_analytics.competitor_snapshot
    ADD COLUMN IF NOT EXISTS sanity_verdict LowCardinality(String) DEFAULT 'ACCEPT' AFTER source_event_id;
ALTER TABLE repracer_analytics.competitor_snapshot
    ADD CONSTRAINT IF NOT EXISTS sanity_verdict_known CHECK sanity_verdict IN ('ACCEPT', 'REJECT', 'HALT_CHANNEL');
