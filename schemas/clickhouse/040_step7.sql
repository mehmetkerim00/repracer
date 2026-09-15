-- 040_step7.sql
-- Изменения аналитического слоя шага 7. Применяется после 030; идемпотентно.
-- DDL не прогонялся на ClickHouse (установки нет) — MODIFY COLUMN в Nullable и порядок мутаций проверить на целевой версии (OQ-67).
--
-- Р-43, Р-44: решение хранит обе границы и их источники, причину отклонения; отклонённое по любой границе —
-- REJECTED_BY_GATE; границу нельзя вычислить — пол и потолок пустые (как price_decision в PostgreSQL, 0030).
-- Забракованные снимки (Р-42) в аналитический слой не копируются: они живут в PostgreSQL 45 дней для разбора
-- инцидентов, сырой снимок уже есть в competitor_snapshot.

ALTER TABLE repracer_analytics.price_decision
    ADD COLUMN IF NOT EXISTS rejection_reason LowCardinality(Nullable(String)) AFTER intent_class,
    ADD COLUMN IF NOT EXISTS max_price_ids    Array(UUID) AFTER min_price_ids,
    MODIFY COLUMN effective_floor_minor Nullable(Int64);

ALTER TABLE repracer_analytics.price_decision DROP CONSTRAINT IF EXISTS floor_respected;
ALTER TABLE repracer_analytics.price_decision
    ADD CONSTRAINT floor_respected CHECK final_amount_minor IS NULL
        OR (final_amount_minor >= effective_floor_minor AND final_amount_minor <= effective_ceiling_minor);
ALTER TABLE repracer_analytics.price_decision
    ADD CONSTRAINT IF NOT EXISTS rejection_reason_known CHECK rejection_reason IS NULL OR rejection_reason IN (
        'BELOW_MIN_PRICE', 'BELOW_MARGIN_FLOOR', 'ABOVE_MAX_PRICE', 'BOUND_UNRESOLVABLE', 'STEP_LIMIT', 'CHANGE_RATE_LIMIT',
        'INTENT_EXPIRED', 'INTENT_INVALID', 'SCOPE_NOT_ACTIVE', 'CHANNEL_HALTED', 'INTERNAL_BOUND_VIOLATION');
ALTER TABLE repracer_analytics.price_decision
    ADD CONSTRAINT IF NOT EXISTS no_bound_clamp CHECK outcome NOT IN ('CLAMPED_FLOOR', 'CLAMPED_CEILING');
