-- 080_step23.sql
-- Шаг 23: причина отклонения `CHANNEL_DISTRUSTED` [Р-118]. Список причин в ClickHouse отставал от PostgreSQL и с шага 12: не было
-- `PRICING_STOPPED` [Р-69] — выгрузка решения, удержанного остановкой человеком, отклонялась бы ограничением. Нашёл CI шага 23
-- (выгрузка дня с решением CHANNEL_DISTRUSTED). Список равен `GATE_REASON_CODES` без APPROVED и NO_CHANGE и ограничению
-- `price_decision_rejection_reason_known` в PostgreSQL — сверяет `packages/analytics-export/test/ddl-reasons.test.ts`.

ALTER TABLE repracer_analytics.price_decision DROP CONSTRAINT IF EXISTS rejection_reason_known;
ALTER TABLE repracer_analytics.price_decision
    ADD CONSTRAINT rejection_reason_known CHECK rejection_reason IS NULL OR rejection_reason IN (
        'BELOW_MIN_PRICE', 'BELOW_MARGIN_FLOOR', 'ABOVE_MAX_PRICE', 'BOUND_UNRESOLVABLE', 'STEP_LIMIT', 'CHANGE_RATE_LIMIT',
        'INTENT_EXPIRED', 'INTENT_INVALID', 'SCOPE_NOT_ACTIVE', 'CHANNEL_HALTED', 'PRICING_STOPPED', 'CHANNEL_DISTRUSTED', 'INTERNAL_BOUND_VIOLATION');
