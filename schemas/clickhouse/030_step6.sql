-- 030_step6.sql
-- Изменения аналитического слоя шага 6. Применяется после 010 и 020; идемпотентно.
-- DDL не прогонялся на ClickHouse (установки нет) — синтаксис ALTER для Nested и поведение TTL проверить на целевой версии (OQ-67).
--
-- Р-27: классы intent. CHANGED и REJECTED_BY_GATE — в price_intent (входы с данными канала — 18 месяцев, Р-38);
--       NO_OP — сырьём 7 дней в price_intent_noop, затем только почасовой агрегат.
--       Условный TTL (DELETE WHERE intent_class = 'NO_OP') в price_intent не работает при ttl_only_drop_parts = 1:
--       строки внутри части не удаляются, пока не истекла вся часть. Поэтому NO_OP — отдельная таблица с дневными частями.
-- Р-36: источники конкурентов Kaufland; ADR-0007: полнота снимка.

-- ---------------------------------------------------------------------------
-- 1. price_intent / price_decision: класс, правило, опорное значение
-- ---------------------------------------------------------------------------
ALTER TABLE repracer_analytics.price_intent
    ADD COLUMN IF NOT EXISTS intent_class           LowCardinality(String) DEFAULT 'CHANGED' AFTER trigger_type,
    ADD COLUMN IF NOT EXISTS rule_code              Nullable(String) AFTER intent_class,
    ADD COLUMN IF NOT EXISTS reference_amount_minor Nullable(Int64) AFTER proposed_amount_minor;

ALTER TABLE repracer_analytics.price_intent
    ADD CONSTRAINT IF NOT EXISTS intent_class_kept CHECK intent_class IN ('CHANGED', 'REJECTED_BY_GATE');

ALTER TABLE repracer_analytics.price_decision
    ADD COLUMN IF NOT EXISTS intent_class LowCardinality(String) DEFAULT 'CHANGED' AFTER outcome;

ALTER TABLE repracer_analytics.price_decision
    ADD CONSTRAINT IF NOT EXISTS intent_class_kept CHECK intent_class IN ('CHANGED', 'REJECTED_BY_GATE');

-- ---------------------------------------------------------------------------
-- 2. NO_OP: сырьё 7 дней. Intent и итог решения — одной строкой (решение без изменения цены).
--    Источник — экспортёр дневных партиций PostgreSQL; вставка с insert_deduplication_token = id партиции
--    (повтор экспорта не удваивает агрегат — проверить на целевой версии).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS repracer_analytics.price_intent_noop
(
    tenant_id              UUID,
    price_intent_id        UUID,
    created_at             DateTime64(3, 'UTC') CODEC(Delta, ZSTD(1)),
    write_scope_id         UUID,
    trigger_type           LowCardinality(String),
    rule_code              LowCardinality(String),
    proposed_amount_minor  Int64,
    reference_amount_minor Nullable(Int64),
    decision_outcome       LowCardinality(String),
    currency               LowCardinality(String),
    price_basis            LowCardinality(String),
    ingested_at            DateTime64(3, 'UTC') DEFAULT now64(3),
    CONSTRAINT tenant_not_platform CHECK tenant_id != toUUID('00000000-0000-0000-0000-000000000000')
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMMDD(created_at)
ORDER BY (tenant_id, write_scope_id, created_at, price_intent_id)
TTL toStartOfDay(created_at) + INTERVAL 8 DAY DELETE
SETTINGS ttl_only_drop_parts = 1;

-- Почасовой агрегат NO_OP: количество, причина (правило и триггер), диапазон входных значений. Класс: данные канала — 18 мес.
CREATE TABLE IF NOT EXISTS repracer_analytics.price_intent_noop_hourly
(
    tenant_id                  UUID,
    write_scope_id             UUID,
    hour                       DateTime('UTC'),
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
ORDER BY (tenant_id, write_scope_id, hour, rule_code, trigger_type)
TTL toStartOfMonth(hour) + INTERVAL 18 MONTH - INTERVAL 14 DAY DELETE
SETTINGS ttl_only_drop_parts = 1;

CREATE MATERIALIZED VIEW IF NOT EXISTS repracer_analytics.price_intent_noop_hourly_mv
TO repracer_analytics.price_intent_noop_hourly
AS SELECT
    tenant_id,
    write_scope_id,
    toStartOfHour(created_at)   AS hour,
    rule_code,
    trigger_type,
    count()                     AS intents,
    min(proposed_amount_minor)  AS proposed_min_minor,
    max(proposed_amount_minor)  AS proposed_max_minor,
    min(reference_amount_minor) AS reference_min_minor,
    max(reference_amount_minor) AS reference_max_minor
FROM repracer_analytics.price_intent_noop
GROUP BY tenant_id, write_scope_id, hour, rule_code, trigger_type;

-- ---------------------------------------------------------------------------
-- 3. competitor_snapshot: источники Kaufland [Р-36] и полнота [ADR-0007]
-- ---------------------------------------------------------------------------
ALTER TABLE repracer_analytics.competitor_snapshot
    ADD COLUMN IF NOT EXISTS completeness                   LowCardinality(String) DEFAULT 'TOP_N' AFTER source_event_id,
    ADD COLUMN IF NOT EXISTS completeness_n                 Nullable(UInt16) AFTER completeness,
    ADD COLUMN IF NOT EXISTS channel_suggested_amount_minor Nullable(Int64) AFTER buybox_is_self,
    ADD COLUMN IF NOT EXISTS `offers.rank`                  Array(Nullable(UInt16)) AFTER `offers.is_self`,
    ADD COLUMN IF NOT EXISTS `offers.delivery_min_days`     Array(Nullable(UInt16)) AFTER `offers.rank`,
    ADD COLUMN IF NOT EXISTS `offers.delivery_max_days`     Array(Nullable(UInt16)) AFTER `offers.delivery_min_days`;

ALTER TABLE repracer_analytics.competitor_snapshot DROP CONSTRAINT IF EXISTS source_known;
ALTER TABLE repracer_analytics.competitor_snapshot
    ADD CONSTRAINT source_known CHECK source IN ('AMAZON_ANY_OFFER_CHANGED', 'AMAZON_COMPETITIVE_SUMMARY',
                                                 'KAUFLAND_BUY_BOX_CHANGED', 'KAUFLAND_BUYBOX', 'KAUFLAND_COMPETITORS_COMPARER');
ALTER TABLE repracer_analytics.competitor_snapshot
    ADD CONSTRAINT IF NOT EXISTS completeness_known
        CHECK (completeness = 'TOP_N' AND completeness_n > 0) OR (completeness IN ('CHEAPEST_ONLY', 'FULL') AND completeness_n IS NULL);

-- ---------------------------------------------------------------------------
-- 4. Политики строк для новых таблиц (099_verify: у каждой MergeTree-таблицы есть tenant_isolation)
-- ---------------------------------------------------------------------------
CREATE ROW POLICY IF NOT EXISTS tenant_isolation ON repracer_analytics.price_intent_noop
  AS PERMISSIVE FOR SELECT USING tenant_id = toUUID(getSetting('SQL_tenant_id')) TO repracer_tenant_reader;
CREATE ROW POLICY IF NOT EXISTS tenant_isolation ON repracer_analytics.price_intent_noop_hourly
  AS PERMISSIVE FOR SELECT USING tenant_id = toUUID(getSetting('SQL_tenant_id')) TO repracer_tenant_reader;

CREATE ROW POLICY IF NOT EXISTS retention_all ON repracer_analytics.price_intent_noop        AS PERMISSIVE FOR SELECT USING 1 TO repracer_retention;
CREATE ROW POLICY IF NOT EXISTS retention_all ON repracer_analytics.price_intent_noop_hourly AS PERMISSIVE FOR SELECT USING 1 TO repracer_retention;
