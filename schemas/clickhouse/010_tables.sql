-- 010_tables.sql
-- Таблицы аналитического слоя. Общие правила:
--  * tenant_id — первый столбец ключа сортировки (быстрый доступ к одному тенанту, эффективное удаление тенанта);
--  * PARTITION BY месяц + TTL с ttl_only_drop_parts: данные удаляются целыми частями;
--  * TTL = начало месяца + 18 месяцев − 14 дней: ни одна строка не живёт дольше 18 месяцев (как в PostgreSQL, data-retention.md);
--    данные тенанта (завершённые записи) хранятся вечно только в архиве Parquet, здесь — аналитическая копия на тот же срок;
--  * ReplacingMergeTree(ingested_at) + уникальный идентификатор в ключе: доставка из брокера at-least-once даёт дубли,
--    слияние их схлопывает; запросы, где дубли важны, используют FINAL или argMax по ingested_at;
--  * CHECK-ограничения проверяются при вставке.
-- Для кластера с репликацией — Replicated*MergeTree с ON CLUSTER (топология — OQ-67).

-- ---------------------------------------------------------------------------
-- Наблюдения за нашими единицами записи (что видим в канале). Класс: данные канала.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS repracer_analytics.channel_observation
(
    tenant_id              UUID,
    channel_observation_id UUID,
    received_at            DateTime64(3, 'UTC'),
    observed_at            DateTime64(3, 'UTC') CODEC(Delta, ZSTD(1)),
    write_scope_id         UUID,
    channel_account_id     UUID,
    channel                LowCardinality(String),
    marketplace            LowCardinality(String),
    field                  LowCardinality(String),
    amount_minor           Nullable(Int64) CODEC(ZSTD(1)),
    currency               LowCardinality(Nullable(String)),
    price_basis            LowCardinality(Nullable(String)),
    quantity               Nullable(Int32) CODEC(ZSTD(1)),
    source                 LowCardinality(String),
    source_event_id        Nullable(String) CODEC(ZSTD(3)),
    data_class             LowCardinality(String),
    ingested_at            DateTime64(3, 'UTC') DEFAULT now64(3),
    CONSTRAINT tenant_not_platform CHECK tenant_id != toUUID('00000000-0000-0000-0000-000000000000'),
    CONSTRAINT field_known         CHECK field IN ('PRICE', 'QUANTITY', 'CHANNEL_MIN_PRICE'),
    CONSTRAINT data_class_known    CHECK (channel = 'AMAZON') = (data_class = 'AMAZON_INFO')
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMM(received_at)
ORDER BY (tenant_id, write_scope_id, observed_at, channel_observation_id)
TTL toStartOfMonth(received_at) + INTERVAL 18 MONTH - INTERVAL 14 DAY DELETE
SETTINGS ttl_only_drop_parts = 1;

-- ---------------------------------------------------------------------------
-- Снимки конкурентов (ANY_OFFER_CHANGED, getCompetitiveSummary, competitorsComparer). Класс: данные канала.
-- Предложения — массивами (Nested): сжимаются по столбцам. Только внутри тенанта (Р-23, AUP).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS repracer_analytics.competitor_snapshot
(
    tenant_id              UUID,
    competitor_snapshot_id UUID,
    received_at            DateTime64(3, 'UTC'),
    observed_at            DateTime64(3, 'UTC') CODEC(Delta, ZSTD(1)),
    channel_account_id     UUID,
    channel                LowCardinality(String),
    marketplace            LowCardinality(String),
    channel_product_ref    String,
    condition              LowCardinality(String),
    source                 LowCardinality(String),
    source_event_id        Nullable(String) CODEC(ZSTD(3)),
    buybox_amount_minor    Nullable(Int64),
    buybox_shipping_minor  Nullable(Int64),
    buybox_is_self         Nullable(Bool),
    offers Nested
    (
        seller_ref     String,
        amount_minor   Int64,
        shipping_minor Int64,
        condition      LowCardinality(String),
        fulfillment    LowCardinality(String),
        is_self        Bool,
        feedback_count Nullable(UInt32),
        feedback_pct   Nullable(UInt8)
    ),
    offer_counts           Map(LowCardinality(String), UInt32),
    data_class             LowCardinality(String),
    ingested_at            DateTime64(3, 'UTC') DEFAULT now64(3),
    CONSTRAINT tenant_not_platform CHECK tenant_id != toUUID('00000000-0000-0000-0000-000000000000'),
    CONSTRAINT source_known        CHECK source IN ('AMAZON_ANY_OFFER_CHANGED', 'AMAZON_COMPETITIVE_SUMMARY', 'KAUFLAND_COMPETITORS_COMPARER'),
    CONSTRAINT data_class_known    CHECK (channel = 'AMAZON') = (data_class = 'AMAZON_INFO')
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMM(received_at)
ORDER BY (tenant_id, channel_account_id, marketplace, channel_product_ref, observed_at, competitor_snapshot_id)
TTL toStartOfMonth(received_at) + INTERVAL 18 MONTH - INTERVAL 14 DAY DELETE
SETTINGS ttl_only_drop_parts = 1;

-- ---------------------------------------------------------------------------
-- Завершённые записи в каналы (из tenant_data.channel_write_history). Класс: данные тенанта; аналитическая копия.
-- Бессрочно — только в архиве (write_id, статус, время — Р-17).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS repracer_analytics.channel_write_completed
(
    tenant_id               UUID,
    channel_write_id        UUID,
    finished_at             DateTime64(3, 'UTC'),
    write_scope_id          UUID,
    field                   LowCardinality(String),
    amount_minor            Nullable(Int64),
    currency                LowCardinality(Nullable(String)),
    price_basis             LowCardinality(Nullable(String)),
    quantity                Nullable(Int32),
    version                 UInt64,
    origin                  LowCardinality(String),
    price_decision_id       Nullable(UUID),
    direction               LowCardinality(Nullable(String)),
    final_status            LowCardinality(String),
    attempt_count           UInt32,
    budget_scope_key        Nullable(String),
    budget_day              Nullable(Date),
    floor_at_dispatch_minor Nullable(Int64),
    trigger_received_at     Nullable(DateTime64(3, 'UTC')),
    created_at              DateTime64(3, 'UTC'),
    dispatched_at           Nullable(DateTime64(3, 'UTC')),
    accepted_at             Nullable(DateTime64(3, 'UTC')),
    applied_at              Nullable(DateTime64(3, 'UTC')),
    ingested_at             DateTime64(3, 'UTC') DEFAULT now64(3),
    CONSTRAINT tenant_not_platform CHECK tenant_id != toUUID('00000000-0000-0000-0000-000000000000'),
    CONSTRAINT final_status_known  CHECK final_status IN ('APPLIED', 'NOT_APPLIED', 'SUPERSEDED', 'DISCARDED_STALE', 'BUDGET_EXHAUSTED')
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMM(finished_at)
ORDER BY (tenant_id, write_scope_id, version, channel_write_id)
TTL toStartOfMonth(finished_at) + INTERVAL 18 MONTH - INTERVAL 14 DAY DELETE
SETTINGS ttl_only_drop_parts = 1;

-- ---------------------------------------------------------------------------
-- Ответы каналов на запись (Р-17: Amazon Information). Класс: данные канала. Без PII.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS repracer_analytics.channel_write_response
(
    tenant_id                 UUID,
    channel_write_response_id UUID,
    received_at               DateTime64(3, 'UTC'),
    channel_write_id          UUID,
    write_scope_id            UUID,
    channel                   LowCardinality(String),
    attempt_no                UInt16,
    outcome                   LowCardinality(String),
    http_status               Nullable(UInt16),
    channel_submission_ref    Nullable(String) CODEC(ZSTD(3)),
    response_summary          String CODEC(ZSTD(3)),
    issues                    String CODEC(ZSTD(3)),
    data_class                LowCardinality(String),
    ingested_at               DateTime64(3, 'UTC') DEFAULT now64(3),
    CONSTRAINT tenant_not_platform CHECK tenant_id != toUUID('00000000-0000-0000-0000-000000000000'),
    CONSTRAINT outcome_known       CHECK outcome IN ('ACCEPTED', 'REJECTED', 'ERROR', 'TIMEOUT', 'RATE_LIMITED'),
    CONSTRAINT data_class_known    CHECK (channel = 'AMAZON') = (data_class = 'AMAZON_INFO')
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMM(received_at)
ORDER BY (tenant_id, write_scope_id, channel_write_id, attempt_no, channel_write_response_id)
TTL toStartOfMonth(received_at) + INTERVAL 18 MONTH - INTERVAL 14 DAY DELETE
SETTINGS ttl_only_drop_parts = 1;

-- ---------------------------------------------------------------------------
-- Intent и решения Price Gate (из дневных партиций PostgreSQL). Класс: данные канала (входы содержат цены конкурентов).
-- Входы ссылаются на competitor_snapshot_id, а не копируют предложения.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS repracer_analytics.price_intent
(
    tenant_id                UUID,
    price_intent_id          UUID,
    created_at               DateTime64(3, 'UTC'),
    write_scope_id           UUID,
    pricing_strategy_id      Nullable(UUID),
    pricing_strategy_version Nullable(UInt32),
    trigger_type             LowCardinality(String),
    source_event_id          Nullable(String) CODEC(ZSTD(3)),
    competitor_snapshot_id   Nullable(UUID),
    proposed_amount_minor    Int64,
    currency                 LowCardinality(String),
    price_basis              LowCardinality(String),
    inputs                   String CODEC(ZSTD(3)),
    rationale                String CODEC(ZSTD(3)),
    expires_at               DateTime64(3, 'UTC'),
    ingested_at              DateTime64(3, 'UTC') DEFAULT now64(3),
    CONSTRAINT tenant_not_platform CHECK tenant_id != toUUID('00000000-0000-0000-0000-000000000000')
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMM(created_at)
ORDER BY (tenant_id, write_scope_id, created_at, price_intent_id)
TTL toStartOfMonth(created_at) + INTERVAL 18 MONTH - INTERVAL 14 DAY DELETE
SETTINGS ttl_only_drop_parts = 1;

CREATE TABLE IF NOT EXISTS repracer_analytics.price_decision
(
    tenant_id               UUID,
    price_decision_id       UUID,
    intent_created_at       DateTime64(3, 'UTC'),
    price_intent_id         UUID,
    write_scope_id          UUID,
    decided_at              DateTime64(3, 'UTC'),
    outcome                 LowCardinality(String),
    final_amount_minor      Nullable(Int64),
    currency                LowCardinality(String),
    price_basis             LowCardinality(String),
    effective_floor_minor   Int64,
    effective_ceiling_minor Nullable(Int64),
    min_price_ids           Array(UUID),
    guardrail_ids           Array(UUID),
    cost_profile_id         Nullable(UUID),
    fee_inputs              String CODEC(ZSTD(3)),
    violations              Array(LowCardinality(String)),
    ingested_at             DateTime64(3, 'UTC') DEFAULT now64(3),
    CONSTRAINT tenant_not_platform CHECK tenant_id != toUUID('00000000-0000-0000-0000-000000000000'),
    CONSTRAINT floor_respected     CHECK final_amount_minor IS NULL OR final_amount_minor >= effective_floor_minor
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMM(intent_created_at)
ORDER BY (tenant_id, write_scope_id, decided_at, price_decision_id)
TTL toStartOfMonth(intent_created_at) + INTERVAL 18 MONTH - INTERVAL 14 DAY DELETE
SETTINGS ttl_only_drop_parts = 1;

-- ---------------------------------------------------------------------------
-- Фактические комиссии. Класс: данные канала. Ключ — проводка канала: повторный импорт схлопывается.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS repracer_analytics.fee_actual
(
    tenant_id               UUID,
    fee_actual_id           UUID,
    posted_at               DateTime64(3, 'UTC'),
    received_at             DateTime64(3, 'UTC'),
    channel_account_id      UUID,
    channel                 LowCardinality(String),
    write_scope_id          Nullable(UUID),
    marketplace             LowCardinality(String),
    channel_order_ref       Nullable(String),
    channel_transaction_ref String,
    fee_type                LowCardinality(String),
    amount_minor            Int64,
    currency                LowCardinality(String),
    data_class              LowCardinality(String),
    ingested_at             DateTime64(3, 'UTC') DEFAULT now64(3),
    CONSTRAINT tenant_not_platform CHECK tenant_id != toUUID('00000000-0000-0000-0000-000000000000'),
    CONSTRAINT data_class_known    CHECK (channel = 'AMAZON') = (data_class = 'AMAZON_INFO')
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMM(posted_at)
ORDER BY (tenant_id, channel_account_id, channel_transaction_ref, fee_type)
TTL toStartOfMonth(posted_at) + INTERVAL 18 MONTH - INTERVAL 14 DAY DELETE
SETTINGS ttl_only_drop_parts = 1;
