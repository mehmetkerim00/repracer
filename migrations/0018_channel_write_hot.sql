-- 0018_channel_write_hot.sql
-- Р-20: в PostgreSQL остаются только незавершённые записи в каналы. Завершённая запись в той же транзакции
-- переносится в транзитную channel_write_history (дневные партиции) и выгружается в ClickHouse и архив [Р-17].
-- HASH-партиции (64) больше не нужны: живых записей — не больше нескольких на единицу записи.

BEGIN;

SET ROLE repracer_retention;
DO $$
DECLARE
  has_rows boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM tenant_data.channel_write) INTO has_rows;
  IF has_rows THEN
    RAISE EXCEPTION 'tenant_data.channel_write is not empty: move completed writes to the analytics layer before this migration';
  END IF;
END $$;

SET ROLE repracer_owner;

-- FK из price_history на channel_write снимается: завершённая запись уходит из PostgreSQL, ссылка становится мягкой
DO $$
DECLARE
  fk text;
BEGIN
  FOR fk IN SELECT conname FROM pg_constraint
             WHERE conrelid = 'tenant_data.price_history'::regclass AND confrelid = 'tenant_data.channel_write'::regclass
               AND contype = 'f' AND conparentid = 0
  LOOP
    EXECUTE format('ALTER TABLE tenant_data.price_history DROP CONSTRAINT %I', fk);
  END LOOP;
END $$;

DELETE FROM security.table_registry WHERE table_name = 'tenant_data.channel_write'::regclass;
DELETE FROM maintenance.retention_policy WHERE table_name = 'tenant_data.channel_write'::regclass;
DROP TABLE tenant_data.channel_write;

-- ---------------------------------------------------------------------------
-- channel_write — только незавершённые записи
-- ---------------------------------------------------------------------------
CREATE TABLE tenant_data.channel_write (
  tenant_id               uuid   NOT NULL,
  channel_write_id        uuid   NOT NULL DEFAULT gen_random_uuid(),
  write_scope_id          uuid   NOT NULL,
  field                   text   NOT NULL CHECK (field IN ('PRICE', 'QUANTITY', 'CHANNEL_MIN_PRICE')),
  amount_minor            bigint CHECK (amount_minor > 0),
  currency                text   CHECK (currency ~ '^[A-Z]{3}$'),
  price_basis             text   CHECK (price_basis IN ('GROSS', 'NET')),
  quantity                int    CHECK (quantity >= 0),
  version                 bigint NOT NULL CHECK (version >= 1),
  idempotency_key         text   NOT NULL DEFAULT '',
  origin                  text   NOT NULL
                          CHECK (origin IN ('PRICE_DECISION', 'STOCK_RECALC', 'DIVERGENCE_REASSERT', 'SMART_PRICING_FLOOR')),
  price_decision_id       uuid,
  direction               text   CHECK (direction IN ('DECREASE', 'INCREASE', 'SAME')),
  status                  text   NOT NULL DEFAULT 'PENDING'
                          CHECK (status IN ('PENDING', 'BLOCKED', 'DISPATCHED', 'ACCEPTED', 'APPLIED', 'NOT_APPLIED',
                                            'FAILED', 'SUPERSEDED', 'DISCARDED_STALE', 'BUDGET_EXHAUSTED')),
  attempt_count           int    NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  budget_scope_key        text,
  budget_day              date,
  floor_at_dispatch_minor bigint,
  sync_job_id             uuid,
  trigger_received_at     timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  dispatched_at           timestamptz,
  accepted_at             timestamptz,
  applied_at              timestamptz,
  finished_at             timestamptz,
  PRIMARY KEY (tenant_id, channel_write_id),
  -- INV-03; также вытеснение старых версий и проверка незавершённых записей при смене режима цены
  UNIQUE (tenant_id, write_scope_id, version),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, write_scope_id) REFERENCES tenant_data.write_scope (tenant_id, write_scope_id),
  CHECK ((field = 'QUANTITY') = (quantity IS NOT NULL)),
  CHECK ((field <> 'QUANTITY') = (amount_minor IS NOT NULL AND currency IS NOT NULL AND price_basis IS NOT NULL)),
  CHECK ((field = 'PRICE') = (price_decision_id IS NOT NULL)),
  CHECK (field <> 'PRICE'             OR origin IN ('PRICE_DECISION', 'DIVERGENCE_REASSERT')),
  CHECK (field <> 'QUANTITY'          OR origin IN ('STOCK_RECALC', 'DIVERGENCE_REASSERT')),
  CHECK (field <> 'CHANNEL_MIN_PRICE' OR origin = 'SMART_PRICING_FLOOR'),
  CHECK ((budget_scope_key IS NULL) = (budget_day IS NULL)),
  CHECK (status NOT IN ('DISPATCHED', 'ACCEPTED', 'APPLIED', 'NOT_APPLIED', 'FAILED') OR dispatched_at IS NOT NULL),
  CHECK (status NOT IN ('ACCEPTED', 'APPLIED') OR accepted_at IS NOT NULL),
  CHECK (field = 'QUANTITY' OR status NOT IN ('DISPATCHED', 'ACCEPTED', 'APPLIED', 'NOT_APPLIED')
         OR floor_at_dispatch_minor IS NOT NULL)
);

CREATE TRIGGER a_channel_write_restrict_update BEFORE UPDATE ON tenant_data.channel_write
  FOR EACH ROW EXECUTE FUNCTION security.restrict_update(
    'status', 'attempt_count', 'sync_job_id', 'floor_at_dispatch_minor',
    'dispatched_at', 'accepted_at', 'applied_at', 'finished_at');
CREATE TRIGGER b_channel_write_before_insert BEFORE INSERT ON tenant_data.channel_write
  FOR EACH ROW EXECUTE FUNCTION tenant_data.channel_write_before_insert();
CREATE TRIGGER b_channel_write_before_update BEFORE UPDATE ON tenant_data.channel_write
  FOR EACH ROW EXECUTE FUNCTION tenant_data.channel_write_before_update();
CREATE TRIGGER c_channel_write_after_insert AFTER INSERT ON tenant_data.channel_write
  FOR EACH ROW EXECUTE FUNCTION tenant_data.channel_write_after_insert();
CREATE TRIGGER d_channel_write_record_price_history AFTER UPDATE OF status ON tenant_data.channel_write
  FOR EACH ROW EXECUTE FUNCTION tenant_data.channel_write_record_price_history();

-- ---------------------------------------------------------------------------
-- channel_write_history — завершённые записи до подтверждённой выгрузки в ClickHouse и архив (append-only, транзит)
-- ---------------------------------------------------------------------------
CREATE TABLE tenant_data.channel_write_history (
  tenant_id               uuid   NOT NULL,
  channel_write_id        uuid   NOT NULL,
  finished_at             timestamptz NOT NULL,
  write_scope_id          uuid   NOT NULL,
  field                   text   NOT NULL,
  amount_minor            bigint,
  currency                text,
  price_basis             text,
  quantity                int,
  version                 bigint NOT NULL,
  origin                  text   NOT NULL,
  price_decision_id       uuid,
  direction               text,
  final_status            text   NOT NULL CHECK (final_status IN ('APPLIED', 'NOT_APPLIED', 'SUPERSEDED',
                                                                  'DISCARDED_STALE', 'BUDGET_EXHAUSTED')),
  attempt_count           int    NOT NULL,
  budget_scope_key        text,
  budget_day              date,
  floor_at_dispatch_minor bigint,
  trigger_received_at     timestamptz,
  created_at              timestamptz NOT NULL,
  dispatched_at           timestamptz,
  accepted_at             timestamptz,
  applied_at              timestamptz,
  PRIMARY KEY (tenant_id, finished_at, channel_write_id),
  FOREIGN KEY (tenant_id, write_scope_id) REFERENCES tenant_data.write_scope (tenant_id, write_scope_id)
) PARTITION BY RANGE (finished_at);

SELECT security.register_table('tenant_data.channel_write_history', 'TENANT', 'append_only');
SELECT security.grant_retention('tenant_data.channel_write_history');
SELECT security.grant_export('tenant_data.channel_write_history');

-- Завершение записи: перенос в историю, удаление ссылок канала и строки — атомарно.
CREATE FUNCTION tenant_data.channel_write_complete() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IN ('APPLIED', 'NOT_APPLIED', 'SUPERSEDED', 'DISCARDED_STALE', 'BUDGET_EXHAUSTED')
     AND NEW.status <> OLD.status THEN
    INSERT INTO tenant_data.channel_write_history
      (tenant_id, channel_write_id, finished_at, write_scope_id, field, amount_minor, currency, price_basis, quantity,
       version, origin, price_decision_id, direction, final_status, attempt_count, budget_scope_key, budget_day,
       floor_at_dispatch_minor, trigger_received_at, created_at, dispatched_at, accepted_at, applied_at)
    VALUES
      (NEW.tenant_id, NEW.channel_write_id, coalesce(NEW.finished_at, now()), NEW.write_scope_id, NEW.field,
       NEW.amount_minor, NEW.currency, NEW.price_basis, NEW.quantity, NEW.version, NEW.origin, NEW.price_decision_id,
       NEW.direction, NEW.status, NEW.attempt_count, NEW.budget_scope_key, NEW.budget_day, NEW.floor_at_dispatch_minor,
       NEW.trigger_received_at, NEW.created_at, NEW.dispatched_at, NEW.accepted_at, NEW.applied_at);
    DELETE FROM channel_data.write_submission
     WHERE tenant_id = NEW.tenant_id AND channel_write_id = NEW.channel_write_id;
    DELETE FROM tenant_data.channel_write
     WHERE tenant_id = NEW.tenant_id AND channel_write_id = NEW.channel_write_id;
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER e_channel_write_complete AFTER UPDATE OF status ON tenant_data.channel_write
  FOR EACH ROW EXECUTE FUNCTION tenant_data.channel_write_complete();

-- Удаление строки: только завершённой записи внутри триггера переноса или ролью хранения (закрытие тенанта).
CREATE FUNCTION tenant_data.channel_write_delete_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF current_user = 'repracer_retention'
     OR (pg_trigger_depth() >= 2
         AND OLD.status IN ('APPLIED', 'NOT_APPLIED', 'SUPERSEDED', 'DISCARDED_STALE', 'BUDGET_EXHAUSTED')) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'channel_write rows are removed only on completion' USING ERRCODE = 'insufficient_privilege';
END $$;

CREATE TRIGGER zz_channel_write_delete_guard BEFORE DELETE ON tenant_data.channel_write
  FOR EACH ROW EXECUTE FUNCTION tenant_data.channel_write_delete_guard();
CREATE TRIGGER zz_channel_write_no_truncate BEFORE TRUNCATE ON tenant_data.channel_write
  FOR EACH STATEMENT EXECUTE FUNCTION security.forbid_truncate();

SELECT security.register_table('tenant_data.channel_write', 'TENANT', 'mutable_delete');
SELECT security.grant_retention('tenant_data.channel_write');

INSERT INTO maintenance.retention_policy
  (table_name, method)
VALUES ('tenant_data.channel_write', 'TENANT_CLOSURE_ONLY');

INSERT INTO maintenance.retention_policy
  (table_name, method, anchor_column, retention, safety_margin, bound, partition_interval, requires_export,
   days_ahead, drop_order)
VALUES
  ('tenant_data.channel_write_history', 'DROP_PARTITION', 'finished_at', '1 day', '0 days', 'MIN_AGE', 'day',
   ARRAY['CLICKHOUSE', 'ARCHIVE'], 3, 30);

RESET ROLE;
COMMIT;
