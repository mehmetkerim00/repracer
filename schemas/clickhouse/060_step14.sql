-- 060_step14.sql
-- Р-81: почасовой агрегат NO_OP хранит КОД ПРИЧИНЫ, а не только правило стратегии. Сырьё NO_OP живёт 7 дней; после этого
-- агрегат — единственный ответ на вопрос «почему цена не менялась». Правило (MATCH_BUYBOX) этого не говорит: причины внутри
-- одного правила разные (ALREADY_AT_TARGET, WITHIN_DEADBAND, ALREADY_WINNING_BUYBOX, NO_COMPETITOR_OFFERS, TARGET_OUTSIDE_BOUNDS_HOLD).
--
-- Ключ сортировки AggregatingMergeTree менять ALTER нельзя: агрегат пересоздаётся. Слой ClickHouse ни разу не развёрнут
-- (OQ-114), данных в нём нет. На развёрнутом слое пересоздание потеряло бы агрегат старше 7 дней без кода причины —
-- его восстановить нельзя; такой перенос — отдельная процедура с решением владельца.

-- ---------------------------------------------------------------------------
-- 1. Сырьё NO_OP: код причины (из price_decision.no_change_reason, Р-74)
-- ---------------------------------------------------------------------------
ALTER TABLE repracer_analytics.price_intent_noop
    ADD COLUMN IF NOT EXISTS no_change_reason LowCardinality(String) AFTER rule_code;

ALTER TABLE repracer_analytics.price_intent_noop
    ADD CONSTRAINT IF NOT EXISTS no_change_reason_present CHECK no_change_reason != '';

-- ---------------------------------------------------------------------------
-- 2. Почасовой агрегат с кодом причины в ключе
-- ---------------------------------------------------------------------------
DROP VIEW IF EXISTS repracer_analytics.price_intent_noop_hourly_mv;
DROP TABLE IF EXISTS repracer_analytics.price_intent_noop_hourly;

-- Класс: данные канала (входы из снимка) — 18 мес, как в 030
CREATE TABLE IF NOT EXISTS repracer_analytics.price_intent_noop_hourly
(
    tenant_id                  UUID,
    write_scope_id             UUID,
    hour                       DateTime('UTC'),
    no_change_reason           LowCardinality(String),
    rule_code                  LowCardinality(String),
    trigger_type               LowCardinality(String),
    intents                    SimpleAggregateFunction(sum, UInt64),
    proposed_min_minor         SimpleAggregateFunction(min, Int64),
    proposed_max_minor         SimpleAggregateFunction(max, Int64),
    reference_min_minor        SimpleAggregateFunction(min, Nullable(Int64)),
    reference_max_minor        SimpleAggregateFunction(max, Nullable(Int64)),
    CONSTRAINT tenant_not_platform CHECK tenant_id != toUUID('00000000-0000-0000-0000-000000000000')
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(hour)
ORDER BY (tenant_id, write_scope_id, hour, no_change_reason, rule_code, trigger_type)
TTL toStartOfMonth(hour) + INTERVAL 18 MONTH - INTERVAL 14 DAY DELETE
SETTINGS ttl_only_drop_parts = 1;

CREATE MATERIALIZED VIEW IF NOT EXISTS repracer_analytics.price_intent_noop_hourly_mv
TO repracer_analytics.price_intent_noop_hourly
AS SELECT
    tenant_id,
    write_scope_id,
    toStartOfHour(created_at)   AS hour,
    no_change_reason,
    rule_code,
    trigger_type,
    count()                     AS intents,
    min(proposed_amount_minor)  AS proposed_min_minor,
    max(proposed_amount_minor)  AS proposed_max_minor,
    min(reference_amount_minor) AS reference_min_minor,
    max(reference_amount_minor) AS reference_max_minor
FROM repracer_analytics.price_intent_noop
GROUP BY tenant_id, write_scope_id, hour, no_change_reason, rule_code, trigger_type;

-- Политики строк пересозданной таблицы — как в 030 (099_verify: у каждой MergeTree-таблицы есть tenant_isolation)
CREATE ROW POLICY IF NOT EXISTS tenant_isolation ON repracer_analytics.price_intent_noop_hourly
  AS PERMISSIVE FOR SELECT USING tenant_id = toUUID(getSetting('SQL_tenant_id')) TO repracer_tenant_reader;
CREATE ROW POLICY IF NOT EXISTS retention_all ON repracer_analytics.price_intent_noop_hourly AS PERMISSIVE FOR SELECT USING 1 TO repracer_retention;
