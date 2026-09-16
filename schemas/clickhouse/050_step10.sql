-- 050_step10.sql
-- Изменения аналитического слоя шагов 9–10. Применяется после 040; идемпотентно.
--
-- OQ-98: параметры причины и полный список проверок решения — в аналитическом слое, как в PostgreSQL (0034).
-- Р-61: курс ЕЦБ, по которому себестоимость переведена в валюту цены, — вместе с решением (0037).
-- Р-64: причина завершения записи без отправки, ссылка на вытеснившую запись, последняя ошибка канала (0036).
-- Р-57: валюта и база цены снимка конкурентов (0034); Р-62: часовой пояс суток витрины у завершённой записи.
-- JSON хранится строкой с ZSTD: схема параметров причины открыта (разные коды — разные параметры),
-- запросы разбирают её JSONExtract*; колонки с частыми фильтрами вынесены отдельно.

ALTER TABLE repracer_analytics.price_decision
    ADD COLUMN IF NOT EXISTS reason_code   LowCardinality(String) DEFAULT '' AFTER rejection_reason,
    ADD COLUMN IF NOT EXISTS reason_params String DEFAULT '{}' CODEC(ZSTD(3)) AFTER reason_code,
    ADD COLUMN IF NOT EXISTS checks        String DEFAULT '[]' CODEC(ZSTD(3)) AFTER violations,
    ADD COLUMN IF NOT EXISTS fx            Nullable(String) CODEC(ZSTD(3)) AFTER fee_inputs,
    ADD COLUMN IF NOT EXISTS fx_rate_date  Nullable(Date) AFTER fx,
    ADD COLUMN IF NOT EXISTS fx_from       LowCardinality(Nullable(String)) AFTER fx_rate_date;

-- Отказ без параметров причины (как price_decision_rejection_explained в PostgreSQL)
ALTER TABLE repracer_analytics.price_decision
    ADD CONSTRAINT IF NOT EXISTS rejection_explained CHECK rejection_reason IS NULL OR reason_params != '{}';
-- Курс записан — известны дата и исходная валюта
ALTER TABLE repracer_analytics.price_decision
    ADD CONSTRAINT IF NOT EXISTS fx_complete CHECK fx IS NULL OR (fx_rate_date IS NOT NULL AND fx_from IS NOT NULL);

ALTER TABLE repracer_analytics.price_intent
    ADD COLUMN IF NOT EXISTS reason_code   LowCardinality(String) DEFAULT '' AFTER rule_code,
    ADD COLUMN IF NOT EXISTS reason_params String DEFAULT '{}' CODEC(ZSTD(3)) AFTER reason_code;

ALTER TABLE repracer_analytics.channel_write_completed
    ADD COLUMN IF NOT EXISTS end_reason             LowCardinality(Nullable(String)) AFTER final_status,
    ADD COLUMN IF NOT EXISTS end_params             Nullable(String) CODEC(ZSTD(3)) AFTER end_reason,
    ADD COLUMN IF NOT EXISTS superseded_by_write_id Nullable(UUID) AFTER end_params,
    ADD COLUMN IF NOT EXISTS last_error_code        LowCardinality(Nullable(String)) AFTER superseded_by_write_id;

ALTER TABLE repracer_analytics.channel_write_completed DROP CONSTRAINT IF EXISTS final_status_known;
ALTER TABLE repracer_analytics.channel_write_completed
    ADD CONSTRAINT final_status_known CHECK final_status IN ('APPLIED', 'NOT_APPLIED', 'SUPERSEDED', 'DISCARDED_STALE', 'BUDGET_EXHAUSTED');
-- Р-64: запись не завершается без причины (как channel_write_history_end_explained)
ALTER TABLE repracer_analytics.channel_write_completed
    ADD CONSTRAINT IF NOT EXISTS end_explained CHECK final_status NOT IN ('SUPERSEDED', 'DISCARDED_STALE', 'BUDGET_EXHAUSTED') OR end_reason IS NOT NULL;

ALTER TABLE repracer_analytics.competitor_snapshot
    ADD COLUMN IF NOT EXISTS currency    LowCardinality(String) DEFAULT 'EUR' AFTER condition,
    ADD COLUMN IF NOT EXISTS price_basis LowCardinality(String) DEFAULT 'GROSS' AFTER currency;
ALTER TABLE repracer_analytics.competitor_snapshot
    ADD CONSTRAINT IF NOT EXISTS currency_supported CHECK currency IN ('EUR', 'USD');

-- Экспортёр дневных секций PostgreSQL вставляет с insert_deduplication_token = секция:часть:контрольная сумма.
-- На нереплицируемом MergeTree дедупликация вставок по умолчанию выключена (окно 0) — включается окном (проверить на 26.8;
-- в кластере с Replicated*MergeTree окно задаёт replicated_deduplication_window).
ALTER TABLE repracer_analytics.price_intent            MODIFY SETTING non_replicated_deduplication_window = 10000;
ALTER TABLE repracer_analytics.price_intent_noop       MODIFY SETTING non_replicated_deduplication_window = 10000;
ALTER TABLE repracer_analytics.price_decision          MODIFY SETTING non_replicated_deduplication_window = 10000;
ALTER TABLE repracer_analytics.channel_write_completed MODIFY SETTING non_replicated_deduplication_window = 10000;
