-- 0009_channel_data.sql
-- Класс хранения CHANNEL: всё прочитанное из каналов и производное от этого. 18 месяцев, автоудаление (0012).
-- Партиционированные таблицы: RANGE по месяцу (удаление = DROP партиции) -> HASH по tenant_id на больших таблицах.
-- Партиции создаёт maintenance.ensure_partitions() (0012).
-- Ссылки из tenant_data сюда запрещены (кроме «мягких» uuid без FK).

BEGIN;
SET ROLE repracer_owner;

-- ---------------------------------------------------------------------------
-- channel_observation — что мы видим в канале по единице записи (append-only)
-- ---------------------------------------------------------------------------
CREATE TABLE channel_data.channel_observation (
  tenant_id              uuid NOT NULL,
  channel_observation_id uuid NOT NULL DEFAULT gen_random_uuid(),
  received_at            timestamptz NOT NULL DEFAULT now(),
  write_scope_id         uuid NOT NULL,
  field                  text NOT NULL CHECK (field IN ('PRICE', 'QUANTITY', 'CHANNEL_MIN_PRICE')),
  amount_minor           bigint CHECK (amount_minor >= 0),
  currency               text CHECK (currency ~ '^[A-Z]{3}$'),
  price_basis            text CHECK (price_basis IN ('GROSS', 'NET')),
  quantity               int  CHECK (quantity >= 0),
  observed_at            timestamptz NOT NULL,
  source                 text NOT NULL CHECK (source IN ('NOTIFICATION', 'READBACK', 'REPORT')),
  source_event_id        text,
  PRIMARY KEY (tenant_id, received_at, channel_observation_id),
  FOREIGN KEY (tenant_id, write_scope_id) REFERENCES tenant_data.write_scope (tenant_id, write_scope_id),
  CHECK ((field = 'QUANTITY') = (quantity IS NOT NULL)),
  CHECK ((field <> 'QUANTITY') = (amount_minor IS NOT NULL AND currency IS NOT NULL AND price_basis IS NOT NULL)),
  CHECK (observed_at <= received_at + interval '5 minutes')
) PARTITION BY RANGE (received_at);

-- Наблюдаемая история единицы; минимум за 30 дней для Omnibus
CREATE INDEX channel_observation_scope_time_idx
  ON channel_data.channel_observation (tenant_id, write_scope_id, observed_at DESC);
-- Идемпотентность потребителя нотификаций
CREATE INDEX channel_observation_event_idx
  ON channel_data.channel_observation (tenant_id, source_event_id) WHERE source_event_id IS NOT NULL;

SELECT security.register_table('channel_data.channel_observation', 'CHANNEL', 'append_only');

-- ---------------------------------------------------------------------------
-- observed_channel_state — проекция последнего наблюдения по единице и полю
-- ---------------------------------------------------------------------------
CREATE TABLE channel_data.observed_channel_state (
  tenant_id              uuid NOT NULL,
  write_scope_id         uuid NOT NULL,
  field                  text NOT NULL CHECK (field IN ('PRICE', 'QUANTITY', 'CHANNEL_MIN_PRICE')),
  observed_amount_minor  bigint,
  observed_quantity      int,
  observed_at            timestamptz NOT NULL,
  received_at            timestamptz NOT NULL,
  source                 text NOT NULL CHECK (source IN ('NOTIFICATION', 'READBACK', 'REPORT')),
  expected_write_id      uuid,
  sync_status            text NOT NULL
                         CHECK (sync_status IN ('UNKNOWN', 'IN_SYNC', 'PENDING_APPLY', 'DIVERGED', 'STALE')),
  divergence_cause       text CHECK (divergence_cause IN ('NOT_APPLIED', 'EXTERNAL_CHANGE',
                                                           'CHANNEL_ORDER_DECREMENT', 'CHANNEL_SUPPRESSION')),
  diverged_since         timestamptz,
  external_changes_in_window int NOT NULL DEFAULT 0 CHECK (external_changes_in_window >= 0),
  PRIMARY KEY (tenant_id, write_scope_id, field),
  FOREIGN KEY (tenant_id, write_scope_id) REFERENCES tenant_data.write_scope (tenant_id, write_scope_id),
  CHECK ((sync_status = 'DIVERGED') = (divergence_cause IS NOT NULL AND diverged_since IS NOT NULL))
);

-- Экран расхождений тенанта
CREATE INDEX observed_channel_state_diverged_idx
  ON channel_data.observed_channel_state (tenant_id, diverged_since) WHERE sync_status = 'DIVERGED';
-- Удаление по сроку (все тенанты)
CREATE INDEX observed_channel_state_retention_idx ON channel_data.observed_channel_state (observed_at);

-- INV-10: более старое наблюдение не заменяет более новое.
CREATE FUNCTION channel_data.observed_state_monotonic() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.observed_at < OLD.observed_at THEN
    RAISE EXCEPTION 'observation at % is older than current %', NEW.observed_at, OLD.observed_at
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER a_observed_state_restrict_update BEFORE UPDATE ON channel_data.observed_channel_state
  FOR EACH ROW EXECUTE FUNCTION security.restrict_update(
    'observed_amount_minor', 'observed_quantity', 'observed_at', 'received_at', 'source', 'expected_write_id',
    'sync_status', 'divergence_cause', 'diverged_since', 'external_changes_in_window');
CREATE TRIGGER b_observed_state_monotonic BEFORE UPDATE ON channel_data.observed_channel_state
  FOR EACH ROW EXECUTE FUNCTION channel_data.observed_state_monotonic();

SELECT security.register_table('channel_data.observed_channel_state', 'CHANNEL', 'mutable');

-- ---------------------------------------------------------------------------
-- divergence_case
-- ---------------------------------------------------------------------------
CREATE TABLE channel_data.divergence_case (
  tenant_id                 uuid NOT NULL,
  divergence_case_id        uuid NOT NULL DEFAULT gen_random_uuid(),
  write_scope_id            uuid NOT NULL,
  field                     text NOT NULL CHECK (field IN ('PRICE', 'QUANTITY', 'CHANNEL_MIN_PRICE')),
  expected_amount_minor     bigint,
  expected_quantity         int,
  observed_amount_minor     bigint,
  observed_quantity         int,
  cause                     text NOT NULL CHECK (cause IN ('NOT_APPLIED', 'EXTERNAL_CHANGE', 'CHANNEL_SUPPRESSION',
                                                           'BELOW_FLOOR', 'CONTESTED')),
  divergence_policy_id      uuid,
  action_taken              text CHECK (action_taken IN ('REASSERTED', 'YIELDED', 'ESCALATED', 'RETRIED')),
  status                    text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'RESOLVED')),
  resolution                text CHECK (resolution IN ('KEEP_OURS', 'ACCEPT_OBSERVED', 'PAUSE_SCOPE', 'EXPIRED')),
  resolved_by_membership_id uuid,
  opened_at                 timestamptz NOT NULL DEFAULT now(),
  resolved_at               timestamptz,
  PRIMARY KEY (tenant_id, divergence_case_id),
  FOREIGN KEY (tenant_id, write_scope_id) REFERENCES tenant_data.write_scope (tenant_id, write_scope_id),
  FOREIGN KEY (tenant_id, divergence_policy_id) REFERENCES tenant_data.divergence_policy (tenant_id, divergence_policy_id),
  FOREIGN KEY (tenant_id, resolved_by_membership_id) REFERENCES tenant_data.membership (tenant_id, membership_id),
  CHECK ((status = 'RESOLVED') = (resolution IS NOT NULL AND resolved_at IS NOT NULL))
);

-- Не более одного открытого кейса на единицу и поле; поиск открытого кейса при новом расхождении
CREATE UNIQUE INDEX divergence_case_open_uq
  ON channel_data.divergence_case (tenant_id, write_scope_id, field) WHERE status = 'OPEN';
-- Удаление по сроку
CREATE INDEX divergence_case_retention_idx ON channel_data.divergence_case (opened_at);

CREATE FUNCTION channel_data.divergence_case_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'RESOLVED' THEN
    RAISE EXCEPTION 'divergence_case % is RESOLVED', OLD.divergence_case_id USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER a_divergence_case_restrict_update BEFORE UPDATE ON channel_data.divergence_case
  FOR EACH ROW EXECUTE FUNCTION security.restrict_update(
    'observed_amount_minor', 'observed_quantity', 'action_taken', 'status', 'resolution',
    'resolved_by_membership_id', 'resolved_at');
CREATE TRIGGER b_divergence_case_guard BEFORE UPDATE ON channel_data.divergence_case
  FOR EACH ROW EXECUTE FUNCTION channel_data.divergence_case_guard();

SELECT security.register_table('channel_data.divergence_case', 'CHANNEL', 'mutable');

-- ---------------------------------------------------------------------------
-- competitor_snapshot — строго внутри тенанта, без межтенантной дедупликации (append-only)
-- ---------------------------------------------------------------------------
CREATE TABLE channel_data.competitor_snapshot (
  tenant_id              uuid NOT NULL,
  competitor_snapshot_id uuid NOT NULL DEFAULT gen_random_uuid(),
  received_at            timestamptz NOT NULL DEFAULT now(),
  channel_account_id     uuid NOT NULL,
  channel                text NOT NULL,
  marketplace            text NOT NULL,
  channel_product_ref    text NOT NULL,
  condition              text NOT NULL DEFAULT 'NEW',
  source                 text NOT NULL CHECK (source IN ('AMAZON_ANY_OFFER_CHANGED', 'AMAZON_COMPETITIVE_SUMMARY',
                                                         'KAUFLAND_COMPETITORS_COMPARER')),
  source_event_id        text,
  observed_at            timestamptz NOT NULL,
  buybox                 jsonb,
  offers                 jsonb NOT NULL DEFAULT '[]'::jsonb,
  offer_counts           jsonb,
  PRIMARY KEY (tenant_id, received_at, competitor_snapshot_id),
  FOREIGN KEY (tenant_id, channel_account_id, channel)
    REFERENCES tenant_data.channel_account (tenant_id, channel_account_id, channel),
  -- Источник соответствует каналу аккаунта (Р-13 для Kaufland)
  CHECK ((source LIKE 'AMAZON\_%') = (channel = 'AMAZON')),
  CHECK ((source LIKE 'KAUFLAND\_%') = (channel = 'KAUFLAND'))
) PARTITION BY RANGE (received_at);

-- Вход стратегии: последний снимок по товару канала на маркетплейсе
CREATE INDEX competitor_snapshot_latest_idx
  ON channel_data.competitor_snapshot (tenant_id, channel_account_id, marketplace, channel_product_ref, observed_at DESC);
-- Идемпотентность потребителя нотификаций
CREATE INDEX competitor_snapshot_event_idx
  ON channel_data.competitor_snapshot (tenant_id, source_event_id) WHERE source_event_id IS NOT NULL;

SELECT security.register_table('channel_data.competitor_snapshot', 'CHANNEL', 'append_only');

-- ---------------------------------------------------------------------------
-- price_intent / price_decision — производные от данных каналов (цены конкурентов во входах)
-- ---------------------------------------------------------------------------
CREATE TABLE channel_data.price_intent (
  tenant_id                uuid NOT NULL,
  price_intent_id          uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at               timestamptz NOT NULL DEFAULT now(),
  write_scope_id           uuid NOT NULL,
  pricing_strategy_id      uuid,
  pricing_strategy_version int,
  created_by_membership_id uuid,
  trigger_type             text NOT NULL CHECK (trigger_type IN ('COMPETITOR_CHANGE', 'COST_CHANGE', 'STOCK_CHANGE',
                                                                 'SCHEDULE', 'MANUAL', 'DIVERGENCE_REASSERT')),
  source_event_id          text,
  proposed_amount_minor    bigint NOT NULL CHECK (proposed_amount_minor > 0),
  currency                 text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  price_basis              text NOT NULL CHECK (price_basis IN ('GROSS', 'NET')),
  inputs                   jsonb NOT NULL DEFAULT '{}'::jsonb,
  rationale                jsonb NOT NULL DEFAULT '{}'::jsonb,
  expires_at               timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, created_at, price_intent_id),
  -- Цель FK из price_decision: решение относится к той же единице записи
  UNIQUE (tenant_id, created_at, price_intent_id, write_scope_id),
  FOREIGN KEY (tenant_id, write_scope_id) REFERENCES tenant_data.write_scope (tenant_id, write_scope_id),
  FOREIGN KEY (tenant_id, pricing_strategy_id, pricing_strategy_version)
    REFERENCES tenant_data.pricing_strategy (tenant_id, pricing_strategy_id, version),
  FOREIGN KEY (tenant_id, created_by_membership_id) REFERENCES tenant_data.membership (tenant_id, membership_id),
  CHECK ((pricing_strategy_id IS NULL) = (pricing_strategy_version IS NULL)),
  CHECK ((trigger_type = 'MANUAL') = (created_by_membership_id IS NOT NULL)),
  CHECK (pricing_strategy_id IS NOT NULL OR trigger_type IN ('MANUAL', 'DIVERGENCE_REASSERT')),
  CHECK (expires_at > created_at)
) PARTITION BY RANGE (created_at);

-- Последний intent единицы (вытеснение, экран «почему такая цена»)
CREATE INDEX price_intent_scope_idx ON channel_data.price_intent (tenant_id, write_scope_id, created_at DESC);

-- Р-12: intent и decision существуют только в режиме ENGINE; валюта — как у единицы.
CREATE FUNCTION channel_data.assert_engine_mode() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  s record;
BEGIN
  SELECT field, pricing_mode, currency, price_basis INTO s
    FROM tenant_data.write_scope WHERE tenant_id = NEW.tenant_id AND write_scope_id = NEW.write_scope_id;
  IF s.field <> 'PRICE' OR s.pricing_mode <> 'ENGINE' THEN
    RAISE EXCEPTION '%.% requires a PRICE write_scope in ENGINE mode (got % / %)', TG_TABLE_SCHEMA, TG_TABLE_NAME,
      s.field, s.pricing_mode USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.currency <> s.currency OR NEW.price_basis <> s.price_basis THEN
    RAISE EXCEPTION 'currency/basis must match write_scope' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER price_intent_engine_mode BEFORE INSERT ON channel_data.price_intent
  FOR EACH ROW EXECUTE FUNCTION channel_data.assert_engine_mode();

SELECT security.register_table('channel_data.price_intent', 'CHANNEL', 'append_only');

CREATE TABLE channel_data.price_decision (
  tenant_id               uuid NOT NULL,
  price_decision_id       uuid NOT NULL DEFAULT gen_random_uuid(),
  intent_created_at       timestamptz NOT NULL,
  price_intent_id         uuid NOT NULL,
  write_scope_id          uuid NOT NULL,
  decided_at              timestamptz NOT NULL DEFAULT now(),
  outcome                 text NOT NULL CHECK (outcome IN ('APPROVED', 'CLAMPED_FLOOR', 'CLAMPED_CEILING',
                                                           'REJECTED', 'HELD', 'NO_CHANGE')),
  final_amount_minor      bigint CHECK (final_amount_minor > 0),
  currency                text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  price_basis             text NOT NULL CHECK (price_basis IN ('GROSS', 'NET')),
  effective_floor_minor   bigint NOT NULL CHECK (effective_floor_minor > 0),
  effective_ceiling_minor bigint CHECK (effective_ceiling_minor > 0),
  min_price_ids           uuid[] NOT NULL,
  guardrail_ids           uuid[] NOT NULL DEFAULT '{}',
  cost_profile_id         uuid,
  fee_inputs              jsonb,
  violations              text[] NOT NULL DEFAULT '{}',
  PRIMARY KEY (tenant_id, intent_created_at, price_decision_id),
  -- Ровно одно решение на intent (партиция решения = месяц intent)
  UNIQUE (tenant_id, intent_created_at, price_intent_id),
  FOREIGN KEY (tenant_id, intent_created_at, price_intent_id, write_scope_id)
    REFERENCES channel_data.price_intent (tenant_id, created_at, price_intent_id, write_scope_id),
  CHECK ((outcome IN ('APPROVED', 'CLAMPED_FLOOR', 'CLAMPED_CEILING')) = (final_amount_minor IS NOT NULL)),
  -- INV-02: одобренная цена в пределах [floor, ceiling]
  CHECK (final_amount_minor IS NULL OR final_amount_minor >= effective_floor_minor),
  CHECK (final_amount_minor IS NULL OR effective_ceiling_minor IS NULL OR final_amount_minor <= effective_ceiling_minor),
  CHECK (outcome <> 'CLAMPED_FLOOR' OR final_amount_minor = effective_floor_minor),
  CHECK (outcome <> 'CLAMPED_CEILING' OR final_amount_minor = effective_ceiling_minor),
  CHECK (cardinality(min_price_ids) >= 1)
) PARTITION BY RANGE (intent_created_at);

-- Проверка решения при создании записи цены в канал (0008)
CREATE INDEX price_decision_id_idx ON channel_data.price_decision (tenant_id, price_decision_id);

-- Р-5, Р-18: пол решения не ниже действующего абсолютного min_price.
CREATE FUNCTION channel_data.price_decision_floor_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  floor_minor bigint := tenant_data.effective_min_price(NEW.tenant_id, NEW.write_scope_id);
BEGIN
  IF floor_minor IS NULL OR NEW.effective_floor_minor < floor_minor THEN
    RAISE EXCEPTION 'decision floor % is below effective min_price %', NEW.effective_floor_minor, floor_minor
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER a_price_decision_engine_mode BEFORE INSERT ON channel_data.price_decision
  FOR EACH ROW EXECUTE FUNCTION channel_data.assert_engine_mode();
CREATE TRIGGER b_price_decision_floor_guard BEFORE INSERT ON channel_data.price_decision
  FOR EACH ROW EXECUTE FUNCTION channel_data.price_decision_floor_guard();

SELECT security.register_table('channel_data.price_decision', 'CHANNEL', 'append_only');

-- ---------------------------------------------------------------------------
-- channel_write_response — ответы каналов на наши записи [Р-17] (append-only)
-- ---------------------------------------------------------------------------
CREATE TABLE channel_data.channel_write_response (
  tenant_id                 uuid NOT NULL,
  channel_write_response_id uuid NOT NULL DEFAULT gen_random_uuid(),
  received_at               timestamptz NOT NULL DEFAULT now(),
  channel_write_id          uuid NOT NULL,
  attempt_no                int  NOT NULL CHECK (attempt_no >= 1),
  outcome                   text NOT NULL CHECK (outcome IN ('ACCEPTED', 'REJECTED', 'ERROR', 'TIMEOUT', 'RATE_LIMITED')),
  http_status               int,
  channel_submission_ref    text,
  response_summary          jsonb,
  issues                    jsonb,
  PRIMARY KEY (tenant_id, received_at, channel_write_response_id),
  FOREIGN KEY (tenant_id, channel_write_id) REFERENCES tenant_data.channel_write (tenant_id, channel_write_id)
) PARTITION BY RANGE (received_at);

-- Детали записи; опрос статуса асинхронной отправки по ссылке канала
CREATE INDEX channel_write_response_write_idx ON channel_data.channel_write_response (tenant_id, channel_write_id);
CREATE INDEX channel_write_response_submission_idx
  ON channel_data.channel_write_response (tenant_id, channel_submission_ref) WHERE channel_submission_ref IS NOT NULL;

SELECT security.register_table('channel_data.channel_write_response', 'CHANNEL', 'append_only');

-- ---------------------------------------------------------------------------
-- fee_estimate — текущая оценка комиссий по единице цены и источнику
-- ---------------------------------------------------------------------------
CREATE TABLE channel_data.fee_estimate (
  tenant_id                uuid NOT NULL,
  write_scope_id           uuid NOT NULL,
  source                   text NOT NULL CHECK (source IN ('CHANNEL_API', 'FEE_SCHEDULE', 'CALIBRATED')),
  fee_model                jsonb NOT NULL,
  fee_schedule_version     text,
  evaluated_at_price_minor bigint,
  breakdown                jsonb,
  computed_at              timestamptz NOT NULL DEFAULT now(),
  valid_until              timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, write_scope_id, source),
  FOREIGN KEY (tenant_id, write_scope_id) REFERENCES tenant_data.write_scope (tenant_id, write_scope_id),
  CHECK (valid_until > computed_at),
  CHECK (source <> 'FEE_SCHEDULE' OR fee_schedule_version IS NOT NULL)
);

-- Удаление по сроку
CREATE INDEX fee_estimate_retention_idx ON channel_data.fee_estimate (computed_at);

SELECT security.register_table('channel_data.fee_estimate', 'CHANNEL', 'mutable');

-- ---------------------------------------------------------------------------
-- fee_actual — фактические комиссии (append-only). Партиция по posted_at: дедупликация повторного импорта
-- ---------------------------------------------------------------------------
CREATE TABLE channel_data.fee_actual (
  tenant_id               uuid NOT NULL,
  fee_actual_id           uuid NOT NULL DEFAULT gen_random_uuid(),
  posted_at               timestamptz NOT NULL,
  received_at             timestamptz NOT NULL DEFAULT now(),
  channel_account_id      uuid NOT NULL,
  write_scope_id          uuid,
  marketplace             text NOT NULL,
  channel_order_ref       text,
  channel_transaction_ref text NOT NULL,
  fee_type                text NOT NULL,
  amount_minor            bigint NOT NULL,
  currency                text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  sync_job_id             uuid,
  PRIMARY KEY (tenant_id, posted_at, fee_actual_id),
  -- Повторный импорт той же проводки не создаёт дубль
  UNIQUE (tenant_id, posted_at, channel_account_id, channel_transaction_ref, fee_type),
  FOREIGN KEY (tenant_id, channel_account_id) REFERENCES tenant_data.channel_account (tenant_id, channel_account_id),
  FOREIGN KEY (tenant_id, write_scope_id) REFERENCES tenant_data.write_scope (tenant_id, write_scope_id),
  CHECK (posted_at <= received_at + interval '1 day')
) PARTITION BY RANGE (posted_at);

-- Калибровка оценок комиссий по единице (только свой тенант)
CREATE INDEX fee_actual_scope_idx ON channel_data.fee_actual (tenant_id, write_scope_id, posted_at DESC)
  WHERE write_scope_id IS NOT NULL;

SELECT security.register_table('channel_data.fee_actual', 'CHANNEL', 'append_only');

-- ---------------------------------------------------------------------------
-- reservation — вычет под заказ до учёта источником [Р-15]
-- ---------------------------------------------------------------------------
CREATE TABLE channel_data.reservation (
  tenant_id              uuid NOT NULL,
  reservation_id         uuid NOT NULL DEFAULT gen_random_uuid(),
  stock_pool_id          uuid NOT NULL,
  source_mode            text NOT NULL,
  product_id             uuid NOT NULL,
  quantity               int  NOT NULL CHECK (quantity > 0),
  channel_account_id     uuid NOT NULL,
  channel_order_ref      text NOT NULL,
  channel_order_line_ref text NOT NULL,
  order_created_at       timestamptz NOT NULL,
  managed_listing        boolean NOT NULL DEFAULT true,
  status                 text NOT NULL DEFAULT 'ACTIVE'
                         CHECK (status IN ('ACTIVE', 'CONSUMED', 'RELEASED_BY_SOURCE', 'CANCELLED', 'EXPIRED')),
  expires_at             timestamptz NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  closed_at              timestamptz,
  PRIMARY KEY (tenant_id, reservation_id),
  -- Повтор события заказа не создаёт вторую резервацию; строка комплекта — по одной на компонент
  UNIQUE (tenant_id, channel_account_id, channel_order_line_ref, product_id),
  FOREIGN KEY (tenant_id, stock_pool_id, source_mode, product_id)
    REFERENCES tenant_data.stock_pool (tenant_id, stock_pool_id, source_mode, product_id),
  FOREIGN KEY (tenant_id, channel_account_id) REFERENCES tenant_data.channel_account (tenant_id, channel_account_id),
  -- Р-15: списывает только внутренний пул; «учтено источником» — только для Inbound API
  CHECK (status <> 'CONSUMED'           OR source_mode = 'INTERNAL_POOL'),
  CHECK (status <> 'RELEASED_BY_SOURCE' OR source_mode = 'INBOUND_API'),
  CHECK ((status = 'ACTIVE') = (closed_at IS NULL)),
  CHECK (expires_at > created_at)
);

-- Доступный остаток: активные резервации товара
CREATE INDEX reservation_active_product_idx ON channel_data.reservation (tenant_id, product_id) WHERE status = 'ACTIVE';
-- Удаление по сроку
CREATE INDEX reservation_retention_idx ON channel_data.reservation (created_at);

CREATE FUNCTION channel_data.reservation_transition() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> OLD.status AND OLD.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'reservation % is already %', OLD.reservation_id, OLD.status
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.status <> 'ACTIVE' THEN
    NEW.closed_at := coalesce(NEW.closed_at, now());
  END IF;
  RETURN NEW;
END $$;

-- Внутренний пул: CONSUMED списывает остаток ровно один раз (уникальный индекс в stock_movement).
CREATE FUNCTION channel_data.reservation_consume() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'CONSUMED' AND OLD.status = 'ACTIVE' THEN
    INSERT INTO tenant_data.stock_movement (tenant_id, stock_pool_id, delta, reason, reservation_id)
    VALUES (NEW.tenant_id, NEW.stock_pool_id, -NEW.quantity, 'ORDER_SHIPPED', NEW.reservation_id);
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER a_reservation_restrict_update BEFORE UPDATE ON channel_data.reservation
  FOR EACH ROW EXECUTE FUNCTION security.restrict_update('status', 'closed_at');
CREATE TRIGGER b_reservation_transition BEFORE UPDATE ON channel_data.reservation
  FOR EACH ROW EXECUTE FUNCTION channel_data.reservation_transition();
CREATE TRIGGER c_reservation_consume AFTER UPDATE OF status ON channel_data.reservation
  FOR EACH ROW EXECUTE FUNCTION channel_data.reservation_consume();

SELECT security.register_table('channel_data.reservation', 'CHANNEL', 'mutable');

-- ---------------------------------------------------------------------------
-- sync_job
-- ---------------------------------------------------------------------------
CREATE TABLE channel_data.sync_job (
  tenant_id                  uuid NOT NULL,
  sync_job_id                uuid NOT NULL DEFAULT gen_random_uuid(),
  channel_account_id         uuid NOT NULL,
  type                       text NOT NULL CHECK (type IN ('OFFER_DISCOVERY', 'PRICE_PUSH', 'STOCK_PUSH', 'ORDER_IMPORT',
                               'FEE_IMPORT', 'COMPETITOR_SEED', 'RECONCILIATION', 'SUBSCRIPTION_SETUP', 'READBACK',
                               'CAPABILITY_PROBE', 'EBAY_MIGRATION_PREFLIGHT', 'EBAY_LISTING_MIGRATION')),
  status                     text NOT NULL DEFAULT 'QUEUED'
                             CHECK (status IN ('QUEUED', 'RUNNING', 'AWAITING_CHANNEL', 'SUCCEEDED', 'PARTIAL',
                                               'FAILED', 'CANCELLED', 'BLOCKED')),
  external_ref               text,
  checkpoint                 jsonb,
  attempt                    int NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  next_attempt_at            timestamptz,
  last_error                 text,
  items_total                int CHECK (items_total >= 0),
  items_succeeded            int NOT NULL DEFAULT 0 CHECK (items_succeeded >= 0),
  items_failed               int NOT NULL DEFAULT 0 CHECK (items_failed >= 0),
  requested_by_membership_id uuid,
  correlation_id             uuid,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  started_at                 timestamptz,
  finished_at                timestamptz,
  PRIMARY KEY (tenant_id, sync_job_id),
  FOREIGN KEY (tenant_id, channel_account_id) REFERENCES tenant_data.channel_account (tenant_id, channel_account_id),
  FOREIGN KEY (tenant_id, requested_by_membership_id) REFERENCES tenant_data.membership (tenant_id, membership_id)
);

-- Не более одного выполняющегося задания инвентаризации/сверки/проверки на аккаунт
CREATE UNIQUE INDEX sync_job_single_running_uq ON channel_data.sync_job (tenant_id, channel_account_id, type)
  WHERE status IN ('RUNNING', 'AWAITING_CHANNEL')
    AND type IN ('OFFER_DISCOVERY', 'RECONCILIATION', 'EBAY_MIGRATION_PREFLIGHT', 'EBAY_LISTING_MIGRATION');
-- Экран заданий аккаунта
CREATE INDEX sync_job_account_idx ON channel_data.sync_job (tenant_id, channel_account_id, created_at DESC);
-- Удаление по сроку
CREATE INDEX sync_job_retention_idx ON channel_data.sync_job (created_at);

SELECT security.register_table('channel_data.sync_job', 'CHANNEL', 'mutable');

RESET ROLE;
COMMIT;
