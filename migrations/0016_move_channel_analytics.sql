-- 0016_move_channel_analytics.sql
-- Р-20: сырые наблюдения, снимки конкурентов, ответы каналов на запись и фактические комиссии уходят из PostgreSQL
-- в ClickHouse (schemas/clickhouse/). Адаптеры публикуют их в брокер; в PostgreSQL остаются только горячие проекции,
-- нужные текущему решению [Р-22]: competitor_state, observed_price_daily, write_submission.

-- Файл выполняется несколькими транзакциями: удаление таблицы с сотнями партиций берёт тысячи блокировок,
-- поэтому каждая таблица удаляется отдельно. Все шаги идемпотентны — повторный запуск после сбоя безопасен.

BEGIN;
-- Проверка пустоты — ролью, которая видит строки всех тенантов (у владельца под FORCE RLS строк не видно).
SET ROLE repracer_retention;
DO $$
DECLARE
  t        text;
  has_rows boolean;
BEGIN
  FOREACH t IN ARRAY ARRAY['channel_data.channel_observation', 'channel_data.competitor_snapshot',
                           'channel_data.channel_write_response', 'channel_data.fee_actual'] LOOP
    CONTINUE WHEN to_regclass(t) IS NULL;
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %s)', t) INTO has_rows;
    IF has_rows THEN
      RAISE EXCEPTION '% is not empty: export rows to ClickHouse before this migration', t;
    END IF;
  END LOOP;
END $$;
SET ROLE repracer_owner;
DELETE FROM maintenance.retention_policy
 WHERE table_name::text IN ('channel_data.channel_observation', 'channel_data.competitor_snapshot',
                            'channel_data.channel_write_response', 'channel_data.fee_actual');
DELETE FROM security.table_registry
 WHERE table_name::text IN ('channel_data.channel_observation', 'channel_data.competitor_snapshot',
                            'channel_data.channel_write_response', 'channel_data.fee_actual');
RESET ROLE;
COMMIT;

BEGIN; SET ROLE repracer_owner; DROP TABLE IF EXISTS channel_data.channel_write_response; RESET ROLE; COMMIT;
BEGIN; SET ROLE repracer_owner; DROP TABLE IF EXISTS channel_data.channel_observation;    RESET ROLE; COMMIT;
BEGIN; SET ROLE repracer_owner; DROP TABLE IF EXISTS channel_data.competitor_snapshot;    RESET ROLE; COMMIT;
BEGIN; SET ROLE repracer_owner; DROP TABLE IF EXISTS channel_data.fee_actual;             RESET ROLE; COMMIT;

BEGIN;
SET ROLE repracer_owner;

-- ---------------------------------------------------------------------------
-- competitor_state — последнее конкурентное состояние по товару канала (вход стратегии, Р-22)
-- ---------------------------------------------------------------------------
CREATE TABLE channel_data.competitor_state (
  tenant_id             uuid NOT NULL,
  channel_account_id    uuid NOT NULL,
  channel               text NOT NULL,
  marketplace           text NOT NULL,
  channel_product_ref   text NOT NULL,
  condition             text NOT NULL DEFAULT 'NEW',
  source                text NOT NULL CHECK (source IN ('AMAZON_ANY_OFFER_CHANGED', 'AMAZON_COMPETITIVE_SUMMARY',
                                                        'KAUFLAND_COMPETITORS_COMPARER')),
  source_event_id       text,
  -- Ссылка на сырой снимок в ClickHouse (для объяснения решения), без синхронного чтения
  competitor_snapshot_id uuid NOT NULL,
  observed_at           timestamptz NOT NULL,
  received_at           timestamptz NOT NULL,
  buybox_amount_minor   bigint CHECK (buybox_amount_minor > 0),
  buybox_is_self        boolean,
  lowest_landed_minor   bigint CHECK (lowest_landed_minor > 0),
  offer_count           int CHECK (offer_count >= 0),
  offers                jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(offers) = 'array'),
  -- Поиск состояния стратегией по товару канала на маркетплейсе; ключ upsert потребителя
  PRIMARY KEY (tenant_id, channel_account_id, marketplace, channel_product_ref, condition),
  FOREIGN KEY (tenant_id, channel_account_id, channel)
    REFERENCES tenant_data.channel_account (tenant_id, channel_account_id, channel),
  CHECK ((source LIKE 'AMAZON\_%') = (channel = 'AMAZON')),
  CHECK ((source LIKE 'KAUFLAND\_%') = (channel = 'KAUFLAND'))
);

-- Удаление по сроку
CREATE INDEX competitor_state_retention_idx ON channel_data.competitor_state (observed_at);

CREATE TRIGGER a_competitor_state_restrict_update BEFORE UPDATE ON channel_data.competitor_state
  FOR EACH ROW EXECUTE FUNCTION security.restrict_update(
    'source', 'source_event_id', 'competitor_snapshot_id', 'observed_at', 'received_at', 'buybox_amount_minor',
    'buybox_is_self', 'lowest_landed_minor', 'offer_count', 'offers');
-- INV-10: более старый снимок не заменяет более новый
CREATE TRIGGER b_competitor_state_monotonic BEFORE UPDATE ON channel_data.competitor_state
  FOR EACH ROW EXECUTE FUNCTION channel_data.observed_state_monotonic();

SELECT security.register_table('channel_data.competitor_state', 'CHANNEL', 'mutable');
SELECT security.grant_retention('channel_data.competitor_state');

-- ---------------------------------------------------------------------------
-- observed_price_daily — суточная свёртка наблюдаемых цен (включая изменения вне системы).
-- Нужна решению о цене для окна 30 дней Omnibus без чтения ClickHouse [Р-22].
-- ---------------------------------------------------------------------------
CREATE TABLE channel_data.observed_price_daily (
  tenant_id         uuid NOT NULL,
  write_scope_id    uuid NOT NULL,
  price_day         date NOT NULL,
  day_tz            text NOT NULL DEFAULT 'Europe/Berlin' CHECK (day_tz = 'Europe/Berlin'),
  currency          text NOT NULL CHECK (currency = 'EUR'),
  price_basis       text NOT NULL CHECK (price_basis IN ('GROSS', 'NET')),
  min_amount_minor  bigint NOT NULL CHECK (min_amount_minor > 0),
  max_amount_minor  bigint NOT NULL,
  last_amount_minor bigint NOT NULL,
  last_observed_at  timestamptz NOT NULL,
  observation_count int NOT NULL CHECK (observation_count >= 1),
  -- Окно Omnibus по единице записи: дни [D-30, D)
  PRIMARY KEY (tenant_id, write_scope_id, price_day),
  FOREIGN KEY (tenant_id, write_scope_id) REFERENCES tenant_data.write_scope (tenant_id, write_scope_id),
  CHECK (min_amount_minor <= last_amount_minor AND last_amount_minor <= max_amount_minor)
);

-- Удаление по сроку
CREATE INDEX observed_price_daily_retention_idx ON channel_data.observed_price_daily (price_day);

-- Свёртка только расширяется: минимум не растёт, максимум не падает, счётчик не уменьшается.
CREATE FUNCTION channel_data.observed_price_daily_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.min_amount_minor > OLD.min_amount_minor OR NEW.max_amount_minor < OLD.max_amount_minor
     OR NEW.observation_count < OLD.observation_count
     OR (NEW.last_observed_at < OLD.last_observed_at AND NEW.last_amount_minor <> OLD.last_amount_minor) THEN
    RAISE EXCEPTION 'observed_price_daily may only widen (scope %, day %)', OLD.write_scope_id, OLD.price_day
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER a_observed_price_daily_restrict_update BEFORE UPDATE ON channel_data.observed_price_daily
  FOR EACH ROW EXECUTE FUNCTION security.restrict_update(
    'min_amount_minor', 'max_amount_minor', 'last_amount_minor', 'last_observed_at', 'observation_count');
CREATE TRIGGER b_observed_price_daily_guard BEFORE UPDATE ON channel_data.observed_price_daily
  FOR EACH ROW EXECUTE FUNCTION channel_data.observed_price_daily_guard();

SELECT security.register_table('channel_data.observed_price_daily', 'CHANNEL', 'mutable');
SELECT security.grant_retention('channel_data.observed_price_daily');

-- ---------------------------------------------------------------------------
-- write_submission — ссылки канала на отправленную запись (submissionId и т.п.) для опроса статуса.
-- Данные канала [Р-17]; живут, пока запись не завершена (удаляются триггером 0018), не дольше 30 дней.
-- ---------------------------------------------------------------------------
CREATE TABLE channel_data.write_submission (
  tenant_id              uuid NOT NULL,
  channel_write_id       uuid NOT NULL,
  attempt_no             int  NOT NULL CHECK (attempt_no >= 1),
  channel_submission_ref text NOT NULL,
  submitted_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, channel_write_id, attempt_no)
);

-- Опрос статуса асинхронной отправки по ссылке канала
CREATE INDEX write_submission_ref_idx ON channel_data.write_submission (tenant_id, channel_submission_ref);
-- Удаление по сроку
CREATE INDEX write_submission_retention_idx ON channel_data.write_submission (submitted_at);

SELECT security.register_table('channel_data.write_submission', 'CHANNEL', 'mutable_delete');
SELECT security.grant_retention('channel_data.write_submission');

INSERT INTO maintenance.retention_policy (table_name, method, anchor_column, retention, safety_margin, drop_order) VALUES
  ('channel_data.competitor_state',     'DELETE_ROWS', 'observed_at',  '18 months', '14 days', 60),
  ('channel_data.observed_price_daily', 'DELETE_ROWS', 'price_day',    '60 days',   '0 days',  60),
  ('channel_data.write_submission',     'DELETE_ROWS', 'submitted_at', '30 days',   '0 days',  60);

RESET ROLE;
COMMIT;
