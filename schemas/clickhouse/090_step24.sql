-- 090_step24.sql
-- Шаг 24 [Р-122, OQ-156]: снимки конкурентов приходят в competitor_snapshot из журнала пути решения (channel_data.competitor_snapshot_log)
-- при любом вердикте проверки входов — история для бэктеста содержит и испорченные снимки, которые путь решения отклонил [Р-38, Р-42].
-- Вердикт — отдельный столбец; строки до шага 24 (писателя не было) — ACCEPT по умолчанию. RECONCILIATION — снимок источника только для
-- сверки (Amazon getCompetitiveSummary, Р-121): проверку входов и решение не проходил.
-- Доставка [Р-121]: PUSH — уведомление с данными, PUSH_FETCH — чтение по уведомлению без данных, POLL — опрос, SAMPLE — выборка проверки
-- остановки; строки до шага 24 — UNKNOWN. Бэктест различает снимки уведомлений и опроса.

ALTER TABLE repracer_analytics.competitor_snapshot
    ADD COLUMN IF NOT EXISTS sanity_verdict LowCardinality(String) DEFAULT 'ACCEPT' AFTER source_event_id;
ALTER TABLE repracer_analytics.competitor_snapshot
    ADD CONSTRAINT IF NOT EXISTS sanity_verdict_known CHECK sanity_verdict IN ('ACCEPT', 'REJECT', 'HALT_CHANNEL', 'RECONCILIATION');
ALTER TABLE repracer_analytics.competitor_snapshot
    ADD COLUMN IF NOT EXISTS delivery LowCardinality(String) DEFAULT 'UNKNOWN' AFTER sanity_verdict;
ALTER TABLE repracer_analytics.competitor_snapshot
    ADD CONSTRAINT IF NOT EXISTS delivery_known CHECK delivery IN ('UNKNOWN', 'PUSH', 'PUSH_FETCH', 'POLL', 'SAMPLE');
