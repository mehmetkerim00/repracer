-- 0213_notification_journal_and_listing_status.sql
-- Шаг 114: приёмник уведомлений Amazon, часть А (без живого AWS).
--
-- 1. Журнал сырья уведомлений `channel_data.notification_journal`. Приёмник кладёт сообщение очереди В НЕГО ДО пути решения — тело как
--    пришло, с конвертом (уведомление SP-API или событие EventBridge). Одна строка на уведомление тенанта: повтор доставки (стандартная
--    очередь SQS доставляет повторно, EventBridge — тоже) — не ошибка и не вторая строка. Обработку по-прежнему решает журнал обработанных
--    (`inbound_notification`, 0083), который пишется в транзакции снимка. Срок — 16 суток: дольше предельного хранения сообщения в очереди
--    (14 суток, SetQueueAttributes MessageRetentionPeriod — тот же факт, что у 0083) с запасом двое суток; тела ANY_OFFER_CHANGED — данные
--    конкурентов, а PostgreSQL держит только нужное текущему решению [Р-20], поэтому журнал сырья не живёт дольше, чем нужен повтору.
-- 2. Наблюдение «статус и проблемы листинга» `channel_data.listing_status` — из трёх источников: уведомление (LISTINGS_ITEM_STATUS_CHANGE,
--    LISTINGS_ITEM_ISSUES_CHANGE), обратное чтение после записи и обнаружение каталога. Данные канала — 18 месяцев [Р-3]. В решение о цене
--    не входит; из него — пилюля «Not buyable on Amazon» и CRITICAL, когда включённое предложение перестало продаваться (часть A-30).

BEGIN;
SET ROLE repracer_owner;

-- ---------------------------------------------------------------- 1. Журнал сырья уведомлений
CREATE TABLE channel_data.notification_journal (
  tenant_id                uuid NOT NULL,
  notification_journal_id  uuid NOT NULL DEFAULT gen_random_uuid(),
  channel_account_id       uuid NOT NULL,
  channel                  text NOT NULL,
  notification_id          text NOT NULL,
  notification_type        text NOT NULL,
  -- Как сообщение легло в очередь: SQS — уведомление SP-API телом сообщения, EVENTBRIDGE — событие правила с уведомлением в `detail`
  envelope                 text NOT NULL,
  event_time               timestamptz,
  received_at              timestamptz NOT NULL,
  raw_body                 text NOT NULL,
  recorded_at              timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, notification_journal_id),
  -- Повтор доставки — ON CONFLICT DO NOTHING у приёмника: одна строка на уведомление тенанта и канала
  CONSTRAINT notification_journal_once UNIQUE (tenant_id, channel, notification_id),
  CONSTRAINT notification_journal_envelope_known CHECK (envelope IN ('SQS', 'EVENTBRIDGE')),
  -- Тот же вид идентификатора, что принимает приёмник (envelope.ts); тип — слово канала заглавными
  CONSTRAINT notification_journal_ids_form CHECK (notification_id ~ '^[A-Za-z0-9._:-]{1,128}$' AND notification_type ~ '^[A-Z][A-Z_]{0,63}$'),
  -- Граница проекта, не факт SQS: уведомление SP-API — единицы килобайт; мегабайт держит строку журнала ограниченной
  CONSTRAINT notification_journal_body_size CHECK (octet_length(raw_body) BETWEEN 2 AND 1048576),
  FOREIGN KEY (tenant_id, channel_account_id, channel) REFERENCES tenant_data.channel_account (tenant_id, channel_account_id, channel)
);
COMMENT ON TABLE channel_data.notification_journal IS
  'Шаг 114: журнал сырья уведомлений канала — тело сообщения очереди с конвертом, одна строка на уведомление тенанта; повтор доставки — не вторая строка; 16 суток';
SELECT security.register_table('channel_data.notification_journal', 'CHANNEL', 'append_only');
SELECT security.grant_retention('channel_data.notification_journal');
GRANT SELECT, INSERT ON channel_data.notification_journal TO repracer_app;
INSERT INTO maintenance.retention_policy (table_name, method, anchor_column, retention, safety_margin, drop_order)
VALUES ('channel_data.notification_journal', 'DELETE_ROWS', 'received_at', interval '16 days', interval '0', 64);
-- Экран Channels: откуда данные аккаунта — последнее уведомление каждого вида за сутки
CREATE INDEX notification_journal_account_recent_idx ON channel_data.notification_journal (tenant_id, channel_account_id, received_at DESC);

-- ---------------------------------------------------------------- 2. Статус и проблемы листинга
CREATE TABLE channel_data.listing_status (
  tenant_id                uuid NOT NULL,
  listing_status_id        uuid NOT NULL DEFAULT gen_random_uuid(),
  channel_account_id       uuid NOT NULL,
  channel                  text NOT NULL,
  marketplace              text NOT NULL,
  external_sku             text NOT NULL,
  channel_product_ref      text,
  source                   text NOT NULL,
  notification_id          text,
  -- Статус: отсутствие флага у канала — «нет», а не «неизвестно»; все три — вместе или ни одного (источник статус не назвал)
  buyable                  boolean,
  discoverable             boolean,
  deleted                  boolean,
  -- Проблемы: серьёзности и принудительные действия канала — вместе или ни одного
  severities               text[],
  enforcement_actions      text[],
  observed_at              timestamptz NOT NULL,
  recorded_at              timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, listing_status_id),
  CONSTRAINT listing_status_source_known CHECK (source IN ('NOTIFICATION', 'READBACK', 'DISCOVERY')),
  -- Идентификатор уведомления — ровно у наблюдения из уведомления
  CONSTRAINT listing_status_notification_ref CHECK ((source = 'NOTIFICATION') = (notification_id IS NOT NULL)),
  CONSTRAINT listing_status_parts CHECK (num_nonnulls(buyable, discoverable, deleted) IN (0, 3) AND (severities IS NULL) = (enforcement_actions IS NULL)
                                         AND (buyable IS NOT NULL OR severities IS NOT NULL)),
  CONSTRAINT listing_status_issue_values CHECK (severities <@ ARRAY['ERROR', 'WARNING', 'INFO', 'NONE'] AND cardinality(severities) BETWEEN 1 AND 4
                                                AND cardinality(enforcement_actions) <= 12
                                                AND array_to_string(enforcement_actions, ',') ~ '^([A-Z][A-Z_]{0,63}(,[A-Z][A-Z_]{0,63})*)?$'),
  CONSTRAINT listing_status_sku_form CHECK (char_length(external_sku) BETWEEN 1 AND 200 AND external_sku !~ '[[:cntrl:]]'),
  -- Повтор уведомления — не второе наблюдение (у чтения и обнаружения идентификатора нет, NULL не совпадает с NULL)
  CONSTRAINT listing_status_once_per_notification UNIQUE (tenant_id, channel, notification_id),
  FOREIGN KEY (tenant_id, channel_account_id, channel) REFERENCES tenant_data.channel_account (tenant_id, channel_account_id, channel)
);
COMMENT ON TABLE channel_data.listing_status IS
  'Шаг 114: статус и проблемы листинга из уведомления, обратного чтения и обнаружения; данные канала, 18 месяцев [Р-3]; в решение о цене не входит';
SELECT security.register_table('channel_data.listing_status', 'CHANNEL', 'append_only');
SELECT security.grant_retention('channel_data.listing_status');
GRANT SELECT, INSERT ON channel_data.listing_status TO repracer_app;
INSERT INTO maintenance.retention_policy (table_name, method, anchor_column, retention, safety_margin, drop_order)
VALUES ('channel_data.listing_status', 'DELETE_ROWS', 'recorded_at', interval '18 months', interval '0', 66);
-- Последнее состояние предложения (пилюля Offers, переход «перестало продаваться»): по аккаунту, витрине и SKU — к моменту наблюдения
CREATE INDEX listing_status_latest_idx ON channel_data.listing_status (tenant_id, channel_account_id, marketplace, external_sku, observed_at DESC);

RESET ROLE;

-- Р-96: обе таблицы пишет путь решения — приёмник (журнал сырья, статус из уведомления), диспетчер (статус после записи), обнаружение
DO $do$
DECLARE
  d text := pg_get_functiondef('security.decision_path_allowed_privileges()'::regprocedure);
  a text := $s$('channel_data.offer_pricing_health', 'SELECT', NULL), ('channel_data.offer_pricing_health', 'INSERT', NULL),$s$;
BEGIN
  IF (length(d) - length(replace(d, a, ''))) / length(a) <> 1 THEN
    RAISE EXCEPTION '0213: security.decision_path_allowed_privileges() is not the definition the migration expects';
  END IF;
  EXECUTE replace(d, a, a || $s$
    -- Шаг 114 (0213): журнал сырья уведомлений и статус листинга — пишут приёмник, диспетчер и обнаружение в транзакции тенанта
    ('channel_data.notification_journal', 'SELECT', NULL), ('channel_data.notification_journal', 'INSERT', NULL),
    ('channel_data.listing_status', 'SELECT', NULL), ('channel_data.listing_status', 'INSERT', NULL),$s$);
END $do$;

-- Очистка данных канала тенанта (правило 0102: таблица тенанта названа в очистке) — обе таблицы ссылаются на аккаунт канала
DO $do$
DECLARE
  d text := pg_get_functiondef('maintenance.purge_tenant_channel_data(uuid)'::regprocedure);
  a text := $s$'channel_data.inbound_notification',$s$;
BEGIN
  IF (length(d) - length(replace(d, a, ''))) / length(a) <> 1 THEN
    RAISE EXCEPTION '0213: maintenance.purge_tenant_channel_data(uuid) is not the definition the migration expects';
  END IF;
  EXECUTE replace(d, a, $s$'channel_data.notification_journal', 'channel_data.listing_status', 'channel_data.inbound_notification',$s$);
END $do$;

COMMIT;
