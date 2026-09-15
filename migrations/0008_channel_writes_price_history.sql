-- 0008_channel_writes_price_history.sql
-- Записи в каналы (INV-02, INV-03, Р-12, Р-17, Р-19), бюджеты правок, история наших цен (Р-3).
-- channel_write и price_history — данные тенанта (бессрочно), HASH-партиции по tenant_id [Р-16].
-- Ответы каналов на запись — Amazon Information/данные канала — в channel_data.channel_write_response (0009).

BEGIN;
SET ROLE repracer_owner;

-- ---------------------------------------------------------------------------
-- Партиции: RLS включён и на каждой партиции; прямого доступа к партициям у приложения нет.
-- ---------------------------------------------------------------------------
CREATE FUNCTION security.protect_partition(p_partition regclass) RETURNS void
  LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', p_partition);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', p_partition);
  EXECUTE format('REVOKE ALL ON %s FROM PUBLIC, repracer_app, repracer_resolver', p_partition);
END $$;

CREATE FUNCTION security.create_hash_partitions(p_parent regclass, p_modulus int) RETURNS void
  LANGUAGE plpgsql AS $$
DECLARE
  i    int;
  part text;
BEGIN
  FOR i IN 0 .. p_modulus - 1 LOOP
    part := format('%s_h%s', p_parent::text, lpad(i::text, 2, '0'));
    EXECUTE format('CREATE TABLE %s PARTITION OF %s FOR VALUES WITH (MODULUS %s, REMAINDER %s)',
                   part, p_parent, p_modulus, i);
    PERFORM security.protect_partition(part::regclass);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- channel_write — команда записи одного поля в единицу записи.
-- Бессрочно хранится только наше: значение, версия, статус, время [Р-17].
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
  -- Вычисляется триггером: sha256(tenant | account | field | scope_key | version)
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
  -- INV-03: одна версия — одна запись в пределах единицы записи
  UNIQUE (tenant_id, write_scope_id, version),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, write_scope_id) REFERENCES tenant_data.write_scope (tenant_id, write_scope_id),
  CHECK ((field = 'QUANTITY') = (quantity IS NOT NULL)),
  CHECK ((field <> 'QUANTITY') = (amount_minor IS NOT NULL AND currency IS NOT NULL AND price_basis IS NOT NULL)),
  -- INV-02: цена в канал — только из решения Price Gate
  CHECK ((field = 'PRICE') = (price_decision_id IS NOT NULL)),
  CHECK (field <> 'PRICE'             OR origin IN ('PRICE_DECISION', 'DIVERGENCE_REASSERT')),
  CHECK (field <> 'QUANTITY'          OR origin IN ('STOCK_RECALC', 'DIVERGENCE_REASSERT')),
  CHECK (field <> 'CHANNEL_MIN_PRICE' OR origin = 'SMART_PRICING_FLOOR'),
  CHECK ((budget_scope_key IS NULL) = (budget_day IS NULL)),
  CHECK (status NOT IN ('DISPATCHED', 'ACCEPTED', 'APPLIED', 'NOT_APPLIED', 'FAILED') OR dispatched_at IS NOT NULL),
  CHECK (status NOT IN ('ACCEPTED', 'APPLIED') OR accepted_at IS NOT NULL),
  CHECK (field = 'QUANTITY' OR status NOT IN ('DISPATCHED', 'ACCEPTED', 'APPLIED', 'NOT_APPLIED')
         OR floor_at_dispatch_minor IS NOT NULL)
) PARTITION BY HASH (tenant_id);

SELECT security.create_hash_partitions('tenant_data.channel_write', 64);

-- Незавершённые записи единицы: вытеснение старых версий, запрет смены режима цены, очередь по единице
CREATE INDEX channel_write_open_idx ON tenant_data.channel_write (tenant_id, write_scope_id, version)
  WHERE status IN ('PENDING', 'BLOCKED', 'DISPATCHED', 'FAILED');

-- ---------------------------------------------------------------------------
-- edit_budget — дневной бюджет правок объекта канала [Р-19]. Ведётся только триггером channel_write.
-- ---------------------------------------------------------------------------
CREATE TABLE tenant_data.edit_budget (
  tenant_id                  uuid NOT NULL,
  channel_account_id         uuid NOT NULL,
  budget_scope_key           text NOT NULL,
  budget_day                 date NOT NULL,
  edit_limit                 int  NOT NULL CHECK (edit_limit > 0),
  quantity_reserve           int  NOT NULL DEFAULT 0 CHECK (quantity_reserve >= 0),
  unaccounted_margin         int  NOT NULL DEFAULT 0 CHECK (unaccounted_margin >= 0),
  attempts_price             int  NOT NULL DEFAULT 0 CHECK (attempts_price >= 0),
  attempts_quantity          int  NOT NULL DEFAULT 0 CHECK (attempts_quantity >= 0),
  attempts_quantity_decrease int  NOT NULL DEFAULT 0 CHECK (attempts_quantity_decrease >= 0),
  PRIMARY KEY (tenant_id, channel_account_id, budget_scope_key, budget_day),
  FOREIGN KEY (tenant_id, channel_account_id) REFERENCES tenant_data.channel_account (tenant_id, channel_account_id),
  CHECK (quantity_reserve + unaccounted_margin < edit_limit),
  -- Р-19: считаются все попытки. Цена не трогает резерв под остаток и запас на невидимые правки
  CONSTRAINT edit_budget_price_limit    CHECK (attempts_price <= edit_limit - quantity_reserve - unaccounted_margin),
  CONSTRAINT edit_budget_quantity_limit CHECK (attempts_price + attempts_quantity <= edit_limit - unaccounted_margin),
  -- Уменьшение остатка может использовать весь лимит
  CONSTRAINT edit_budget_total_limit    CHECK (attempts_price + attempts_quantity + attempts_quantity_decrease <= edit_limit)
);

CREATE TRIGGER edit_budget_only_from_trigger BEFORE INSERT OR UPDATE ON tenant_data.edit_budget
  FOR EACH ROW EXECUTE FUNCTION security.only_from_trigger();

SELECT security.register_table('tenant_data.edit_budget', 'TENANT', 'mutable');

CREATE FUNCTION tenant_data.consume_edit_budget(
  p_tenant_id uuid, p_channel_account_id uuid, p_budget_scope_key text, p_budget_day date,
  p_capability_id uuid, p_capability_version int, p_bucket text, p_attempts int
) RETURNS void
  LANGUAGE plpgsql AS $$
DECLARE
  lim jsonb;
BEGIN
  SELECT coalesce(
           (SELECT o.object_edit_limit FROM tenant_data.channel_capability_override o
             WHERE o.tenant_id = p_tenant_id AND o.channel_account_id = p_channel_account_id
               AND o.capability_id = p_capability_id AND o.object_edit_limit IS NOT NULL
               AND o.valid_from <= now() AND (o.valid_to IS NULL OR o.valid_to > now())
             ORDER BY o.valid_from DESC LIMIT 1),
           c.object_edit_limit)
    INTO lim
    FROM platform.channel_capability c
   WHERE c.capability_id = p_capability_id AND c.version = p_capability_version;

  IF lim IS NULL THEN
    RAISE EXCEPTION 'write has budget_scope_key but capability defines no object_edit_limit'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  INSERT INTO tenant_data.edit_budget
    (tenant_id, channel_account_id, budget_scope_key, budget_day, edit_limit, quantity_reserve, unaccounted_margin)
  VALUES (p_tenant_id, p_channel_account_id, p_budget_scope_key, p_budget_day, (lim ->> 'limit')::int,
          coalesce((lim ->> 'quantity_reserve')::int, 0), coalesce((lim ->> 'unaccounted_margin')::int, 0))
  ON CONFLICT DO NOTHING;

  UPDATE tenant_data.edit_budget
     SET attempts_price             = attempts_price             + CASE WHEN p_bucket = 'PRICE'             THEN p_attempts ELSE 0 END,
         attempts_quantity          = attempts_quantity          + CASE WHEN p_bucket = 'QUANTITY'          THEN p_attempts ELSE 0 END,
         attempts_quantity_decrease = attempts_quantity_decrease + CASE WHEN p_bucket = 'QUANTITY_DECREASE' THEN p_attempts ELSE 0 END
   WHERE tenant_id = p_tenant_id AND channel_account_id = p_channel_account_id
     AND budget_scope_key = p_budget_scope_key AND budget_day = p_budget_day;
END $$;

-- ---------------------------------------------------------------------------
-- Триггеры channel_write
-- ---------------------------------------------------------------------------
CREATE FUNCTION tenant_data.channel_write_before_insert() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  s           record;
  st          record;
  floor_minor bigint;
BEGIN
  -- Блокировка единицы: смена режима цены не может пройти одновременно с созданием записи
  SELECT * INTO s FROM tenant_data.write_scope
   WHERE tenant_id = NEW.tenant_id AND write_scope_id = NEW.write_scope_id FOR SHARE;

  IF s.status = 'RETIRED' THEN
    RAISE EXCEPTION 'write_scope % is RETIRED', NEW.write_scope_id USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  -- Р-12: minimum_price Kaufland — только в режиме Smart Pricing; наша цена — только в режиме ENGINE
  IF NEW.field = 'CHANNEL_MIN_PRICE' THEN
    IF s.field <> 'PRICE' OR s.pricing_mode <> 'KAUFLAND_SMART_PRICING' THEN
      RAISE EXCEPTION 'CHANNEL_MIN_PRICE may be written only in KAUFLAND_SMART_PRICING mode'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  ELSIF NEW.field <> s.field THEN
    RAISE EXCEPTION 'write field % does not match write_scope field %', NEW.field, s.field
      USING ERRCODE = 'integrity_constraint_violation';
  ELSIF NEW.field = 'PRICE' AND s.pricing_mode <> 'ENGINE' THEN
    RAISE EXCEPTION 'PRICE writes require pricing_mode ENGINE (scope is %)', s.pricing_mode
      USING ERRCODE = 'integrity_constraint_violation';
  ELSIF NEW.field = 'QUANTITY' AND NOT s.quantity_sync_enabled THEN
    RAISE EXCEPTION 'quantity sync is disabled for write_scope %', NEW.write_scope_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF NEW.field <> 'QUANTITY' THEN
    IF NEW.currency <> s.currency OR NEW.price_basis <> s.price_basis THEN
      RAISE EXCEPTION 'write currency/basis must match write_scope' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    -- INV-02 (абсолютная часть): значение не ниже действующего min_price
    floor_minor := tenant_data.effective_min_price(NEW.tenant_id, NEW.write_scope_id);
    IF floor_minor IS NULL OR NEW.amount_minor < floor_minor THEN
      RAISE EXCEPTION 'value % is below effective min_price %', NEW.amount_minor, floor_minor
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW.field = 'PRICE' AND NOT EXISTS (
       SELECT 1 FROM channel_data.price_decision d
        WHERE d.tenant_id = NEW.tenant_id AND d.price_decision_id = NEW.price_decision_id
          AND d.write_scope_id = NEW.write_scope_id
          AND d.outcome IN ('APPROVED', 'CLAMPED_FLOOR', 'CLAMPED_CEILING')
          AND d.final_amount_minor = NEW.amount_minor
          AND d.currency = NEW.currency AND d.price_basis = NEW.price_basis) THEN
    RAISE EXCEPTION 'PRICE write must equal an approved price_decision of the same write_scope'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  SELECT * INTO st FROM tenant_data.write_scope_sync_state
   WHERE tenant_id = NEW.tenant_id AND write_scope_id = NEW.write_scope_id;

  IF NEW.field = 'QUANTITY' THEN
    NEW.direction := CASE
      WHEN st.last_sent_quantity IS NULL        THEN 'INCREASE'
      WHEN NEW.quantity < st.last_sent_quantity THEN 'DECREASE'
      WHEN NEW.quantity > st.last_sent_quantity THEN 'INCREASE'
      ELSE 'SAME' END;
  ELSE
    NEW.direction := NULL;
  END IF;

  IF NEW.status <> 'PENDING' THEN
    RAISE EXCEPTION 'new channel_write must be PENDING' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  -- INV-14: в удержанной единице запись создаётся заблокированной, кроме уменьшения остатка
  IF s.status IN ('HELD', 'CONTESTED', 'BLOCKED') AND NOT (NEW.field = 'QUANTITY' AND NEW.direction = 'DECREASE') THEN
    NEW.status := 'BLOCKED';
  END IF;

  IF NEW.budget_scope_key IS DISTINCT FROM s.budget_scope_key THEN
    RAISE EXCEPTION 'budget_scope_key must match write_scope (%)', s.budget_scope_key
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  -- INV-03: версия строго больше последней созданной в единице записи
  UPDATE tenant_data.write_scope_sync_state
     SET latest_version_created = NEW.version
   WHERE tenant_id = NEW.tenant_id AND write_scope_id = NEW.write_scope_id
     AND latest_version_created < NEW.version;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'version % is not greater than latest created version % of write_scope %',
      NEW.version, st.latest_version_created, NEW.write_scope_id USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  NEW.idempotency_key := encode(sha256(convert_to(
    concat_ws('|', NEW.tenant_id, s.channel_account_id, NEW.field, s.scope_key, NEW.version), 'UTF8')), 'hex');
  NEW.created_at := now();
  RETURN NEW;
END $$;

-- Новая версия вытесняет старые неотправленные записи единицы.
CREATE FUNCTION tenant_data.channel_write_after_insert() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  UPDATE tenant_data.channel_write
     SET status = 'SUPERSEDED'
   WHERE tenant_id = NEW.tenant_id AND write_scope_id = NEW.write_scope_id
     AND version < NEW.version AND status IN ('PENDING', 'BLOCKED');
  RETURN NULL;
END $$;

CREATE FUNCTION tenant_data.channel_write_before_update() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  s           record;
  st          record;
  floor_minor bigint;
BEGIN
  IF NEW.status <> OLD.status AND (OLD.status, NEW.status) NOT IN (VALUES
       ('PENDING', 'DISPATCHED'), ('PENDING', 'SUPERSEDED'), ('PENDING', 'BLOCKED'),
       ('PENDING', 'DISCARDED_STALE'), ('PENDING', 'BUDGET_EXHAUSTED'),
       ('BLOCKED', 'PENDING'), ('BLOCKED', 'SUPERSEDED'), ('BLOCKED', 'DISCARDED_STALE'),
       ('DISPATCHED', 'ACCEPTED'), ('DISPATCHED', 'FAILED'), ('DISPATCHED', 'BUDGET_EXHAUSTED'),
       ('FAILED', 'DISPATCHED'), ('FAILED', 'DISCARDED_STALE'), ('FAILED', 'BUDGET_EXHAUSTED'),
       ('ACCEPTED', 'APPLIED'), ('ACCEPTED', 'NOT_APPLIED')) THEN
    RAISE EXCEPTION 'channel_write status transition % -> % is not allowed', OLD.status, NEW.status
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  SELECT * INTO s FROM tenant_data.write_scope WHERE tenant_id = NEW.tenant_id AND write_scope_id = NEW.write_scope_id;

  -- Выход из BLOCKED и отправка возможны только в незаблокированной единице (кроме уменьшения остатка)
  IF NEW.status IN ('PENDING', 'DISPATCHED') AND NEW.status <> OLD.status
     AND (s.status = 'RETIRED'
          OR (s.status IN ('HELD', 'CONTESTED', 'BLOCKED') AND NOT (NEW.field = 'QUANTITY' AND NEW.direction = 'DECREASE'))) THEN
    RAISE EXCEPTION 'write_scope % is %: write cannot proceed', s.write_scope_id, s.status
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF NEW.status = 'DISPATCHED' AND OLD.status <> 'DISPATCHED' THEN
    SELECT * INTO st FROM tenant_data.write_scope_sync_state
     WHERE tenant_id = NEW.tenant_id AND write_scope_id = NEW.write_scope_id FOR UPDATE;

    -- INV-03: отправляется только самая свежая версия; старое значение не может перезаписать новое
    IF NEW.version <> st.latest_version_created THEN
      RAISE EXCEPTION 'stale write: version % < latest created %', NEW.version, st.latest_version_created
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF st.in_flight_write_id IS NOT NULL AND st.in_flight_write_id <> NEW.channel_write_id THEN
      RAISE EXCEPTION 'write_scope % already has in-flight write %', NEW.write_scope_id, st.in_flight_write_id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF (NEW.field = 'PRICE' AND s.pricing_mode <> 'ENGINE')
       OR (NEW.field = 'CHANNEL_MIN_PRICE' AND s.pricing_mode <> 'KAUFLAND_SMART_PRICING') THEN
      RAISE EXCEPTION 'pricing_mode changed to %: write cannot be dispatched', s.pricing_mode
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    -- INV-02: повторная проверка пола непосредственно перед отправкой
    IF NEW.field <> 'QUANTITY' THEN
      floor_minor := tenant_data.effective_min_price(NEW.tenant_id, NEW.write_scope_id);
      IF floor_minor IS NULL OR NEW.amount_minor < floor_minor THEN
        RAISE EXCEPTION 'value % is below effective min_price % at dispatch', NEW.amount_minor, floor_minor
          USING ERRCODE = 'check_violation';
      END IF;
      NEW.floor_at_dispatch_minor := floor_minor;
    END IF;

    UPDATE tenant_data.write_scope_sync_state
       SET latest_version_dispatched = greatest(latest_version_dispatched, NEW.version),
           in_flight_write_id = NEW.channel_write_id
     WHERE tenant_id = NEW.tenant_id AND write_scope_id = NEW.write_scope_id;
    NEW.dispatched_at := coalesce(NEW.dispatched_at, now());
  END IF;

  -- Р-19: каждая попытка расходует бюджет до отправки; превышение лимита отклоняет обновление
  IF NEW.attempt_count <> OLD.attempt_count THEN
    IF NEW.attempt_count < OLD.attempt_count OR NEW.status <> 'DISPATCHED' THEN
      RAISE EXCEPTION 'attempt_count may only grow while DISPATCHED' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.budget_scope_key IS NOT NULL THEN
      PERFORM tenant_data.consume_edit_budget(
        NEW.tenant_id, s.channel_account_id, NEW.budget_scope_key, NEW.budget_day,
        s.capability_id, s.capability_version,
        CASE WHEN NEW.field <> 'QUANTITY' THEN 'PRICE'
             WHEN NEW.direction = 'DECREASE' THEN 'QUANTITY_DECREASE'
             ELSE 'QUANTITY' END,
        NEW.attempt_count - OLD.attempt_count);
    END IF;
  END IF;

  IF NEW.status = 'ACCEPTED' AND OLD.status <> 'ACCEPTED' THEN
    NEW.accepted_at := coalesce(NEW.accepted_at, now());
    UPDATE tenant_data.write_scope_sync_state
       SET latest_version_accepted = greatest(latest_version_accepted, NEW.version),
           last_sent_amount_minor  = CASE WHEN NEW.field <> 'QUANTITY' THEN NEW.amount_minor ELSE last_sent_amount_minor END,
           last_sent_quantity      = CASE WHEN NEW.field = 'QUANTITY' THEN NEW.quantity ELSE last_sent_quantity END,
           -- Синхронные каналы: запись завершена; асинхронные: в полёте до APPLIED/NOT_APPLIED
           in_flight_write_id      = CASE WHEN s.processing_mode = 'SYNC' AND in_flight_write_id = NEW.channel_write_id
                                          THEN NULL ELSE in_flight_write_id END
     WHERE tenant_id = NEW.tenant_id AND write_scope_id = NEW.write_scope_id;
  END IF;

  IF NEW.status = 'APPLIED' AND OLD.status <> 'APPLIED' THEN
    NEW.applied_at := coalesce(NEW.applied_at, now());
    UPDATE tenant_data.write_scope_sync_state
       SET latest_version_applied = greatest(latest_version_applied, NEW.version)
     WHERE tenant_id = NEW.tenant_id AND write_scope_id = NEW.write_scope_id;
  END IF;

  IF NEW.status IN ('APPLIED', 'NOT_APPLIED', 'FAILED', 'SUPERSEDED', 'DISCARDED_STALE', 'BUDGET_EXHAUSTED')
     AND NEW.status <> OLD.status THEN
    UPDATE tenant_data.write_scope_sync_state
       SET in_flight_write_id = NULL
     WHERE tenant_id = NEW.tenant_id AND write_scope_id = NEW.write_scope_id
       AND in_flight_write_id = NEW.channel_write_id;
    IF NEW.status <> 'FAILED' THEN
      NEW.finished_at := coalesce(NEW.finished_at, now());
    END IF;
  END IF;

  RETURN NEW;
END $$;

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

-- Удаление записей — только процедурой закрытия тенанта (repracer_retention)
CREATE TRIGGER zz_channel_write_no_delete BEFORE DELETE ON tenant_data.channel_write
  FOR EACH ROW EXECUTE FUNCTION security.forbid_mutation();

SELECT security.register_table('tenant_data.channel_write', 'TENANT', 'mutable');

-- Р-12: режим цены нельзя переключить, пока у единицы есть незавершённые записи.
CREATE FUNCTION tenant_data.write_scope_mode_switch_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.pricing_mode IS DISTINCT FROM OLD.pricing_mode AND (
       EXISTS (SELECT 1 FROM tenant_data.channel_write w
                WHERE w.tenant_id = NEW.tenant_id AND w.write_scope_id = NEW.write_scope_id
                  AND w.status IN ('PENDING', 'BLOCKED', 'DISPATCHED', 'FAILED'))
    OR EXISTS (SELECT 1 FROM tenant_data.write_scope_sync_state ss
                WHERE ss.tenant_id = NEW.tenant_id AND ss.write_scope_id = NEW.write_scope_id
                  AND ss.in_flight_write_id IS NOT NULL)) THEN
    RAISE EXCEPTION 'write_scope % has unfinished writes; pricing_mode cannot change', NEW.write_scope_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER write_scope_mode_switch_guard BEFORE UPDATE OF pricing_mode ON tenant_data.write_scope
  FOR EACH ROW EXECUTE FUNCTION tenant_data.write_scope_mode_switch_guard();

-- ---------------------------------------------------------------------------
-- price_history — только наши цены [Р-3]; append-only; не удаляется (кроме закрытия тенанта, OQ-22).
-- ---------------------------------------------------------------------------
CREATE TABLE tenant_data.price_history (
  tenant_id                 uuid   NOT NULL,
  price_history_id          uuid   NOT NULL DEFAULT gen_random_uuid(),
  write_scope_id            uuid   NOT NULL,
  product_id                uuid   NOT NULL,
  price_type                text   NOT NULL DEFAULT 'REGULAR' CHECK (price_type IN ('REGULAR', 'SALE', 'REFERENCE')),
  amount_minor              bigint NOT NULL CHECK (amount_minor > 0),
  currency                  text   NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  price_basis               text   NOT NULL CHECK (price_basis IN ('GROSS', 'NET')),
  effective_min_price_minor bigint NOT NULL CHECK (effective_min_price_minor > 0),
  channel_write_id          uuid,
  write_version             bigint,
  dispatched_at             timestamptz,
  accepted_at               timestamptz NOT NULL,
  corrects_price_history_id uuid,
  recorded_at               timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, price_history_id),
  FOREIGN KEY (tenant_id, write_scope_id) REFERENCES tenant_data.write_scope (tenant_id, write_scope_id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES tenant_data.product (tenant_id, product_id),
  FOREIGN KEY (tenant_id, channel_write_id) REFERENCES tenant_data.channel_write (tenant_id, channel_write_id),
  FOREIGN KEY (tenant_id, corrects_price_history_id) REFERENCES tenant_data.price_history (tenant_id, price_history_id),
  CHECK (channel_write_id IS NOT NULL OR corrects_price_history_id IS NOT NULL),
  CHECK ((channel_write_id IS NULL) = (write_version IS NULL)),
  -- Наша цена никогда не ниже пола, действовавшего при отправке
  CHECK (amount_minor >= effective_min_price_minor)
) PARTITION BY HASH (tenant_id);

SELECT security.create_hash_partitions('tenant_data.price_history', 64);

-- Omnibus / §11 PAngV: минимальная цена единицы за 30 дней; последняя наша цена единицы
CREATE INDEX price_history_scope_time_idx ON tenant_data.price_history (tenant_id, write_scope_id, accepted_at DESC);
-- Одна исходная запись истории на одну принятую каналом запись
CREATE UNIQUE INDEX price_history_write_uq ON tenant_data.price_history (tenant_id, channel_write_id)
  WHERE channel_write_id IS NOT NULL AND corrects_price_history_id IS NULL;

SELECT security.register_table('tenant_data.price_history', 'TENANT', 'append_only');

-- Каждая принятая каналом запись цены попадает в историю в той же транзакции.
CREATE FUNCTION tenant_data.channel_write_record_price_history() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.field = 'PRICE' AND NEW.status = 'ACCEPTED' AND OLD.status <> 'ACCEPTED' THEN
    INSERT INTO tenant_data.price_history
      (tenant_id, write_scope_id, product_id, amount_minor, currency, price_basis, effective_min_price_minor,
       channel_write_id, write_version, dispatched_at, accepted_at)
    SELECT NEW.tenant_id, NEW.write_scope_id, ws.product_id, NEW.amount_minor, NEW.currency, NEW.price_basis,
           NEW.floor_at_dispatch_minor, NEW.channel_write_id, NEW.version, NEW.dispatched_at, NEW.accepted_at
      FROM tenant_data.write_scope ws
     WHERE ws.tenant_id = NEW.tenant_id AND ws.write_scope_id = NEW.write_scope_id;
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER d_channel_write_record_price_history AFTER UPDATE OF status ON tenant_data.channel_write
  FOR EACH ROW EXECUTE FUNCTION tenant_data.channel_write_record_price_history();

RESET ROLE;
COMMIT;
