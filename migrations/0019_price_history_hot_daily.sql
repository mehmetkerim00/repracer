-- 0019_price_history_hot_daily.sql
-- Р-20, Р-21: сырьё price_history — 90 дней в PostgreSQL (RANGE по месяцу -> HASH по тенанту, 8 подпартиций),
-- затем архив; суточная свёртка price_daily — вечно, юридическое доказательство Omnibus.

BEGIN;

SET ROLE repracer_retention;
DO $$
DECLARE
  has_rows boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM tenant_data.price_history) INTO has_rows;
  IF has_rows THEN
    RAISE EXCEPTION 'tenant_data.price_history is not empty: archive raw rows and build price_daily before this migration';
  END IF;
END $$;

SET ROLE repracer_owner;

DELETE FROM security.table_registry WHERE table_name = 'tenant_data.price_history'::regclass;
DELETE FROM maintenance.retention_policy WHERE table_name = 'tenant_data.price_history'::regclass;
DROP TABLE tenant_data.price_history;

-- ---------------------------------------------------------------------------
-- price_history — сырьё наших цен, горячие 90 дней (append-only)
-- ---------------------------------------------------------------------------
CREATE TABLE tenant_data.price_history (
  tenant_id                 uuid   NOT NULL,
  price_history_id          uuid   NOT NULL DEFAULT gen_random_uuid(),
  accepted_at               timestamptz NOT NULL,
  write_scope_id            uuid   NOT NULL,
  product_id                uuid   NOT NULL,
  price_type                text   NOT NULL DEFAULT 'REGULAR' CHECK (price_type IN ('REGULAR', 'SALE', 'REFERENCE')),
  amount_minor              bigint NOT NULL CHECK (amount_minor > 0),
  currency                  text   NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  price_basis               text   NOT NULL CHECK (price_basis IN ('GROSS', 'NET')),
  effective_min_price_minor bigint NOT NULL CHECK (effective_min_price_minor > 0),
  -- Мягкие ссылки: запись канала и исправляемая строка могут уже быть вне PostgreSQL
  channel_write_id          uuid,
  write_version             bigint,
  dispatched_at             timestamptz,
  corrects_price_history_id uuid,
  recorded_at               timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, accepted_at, price_history_id),
  FOREIGN KEY (tenant_id, write_scope_id) REFERENCES tenant_data.write_scope (tenant_id, write_scope_id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES tenant_data.product (tenant_id, product_id),
  CHECK (channel_write_id IS NOT NULL OR corrects_price_history_id IS NOT NULL),
  CHECK ((channel_write_id IS NULL) = (write_version IS NULL)),
  CHECK (amount_minor >= effective_min_price_minor)
) PARTITION BY RANGE (accepted_at);

-- Omnibus в горячем окне и последняя наша цена единицы
CREATE INDEX price_history_scope_time_idx ON tenant_data.price_history (tenant_id, write_scope_id, accepted_at DESC);
-- Одна исходная строка на принятую запись (accepted_at записи единственен)
CREATE UNIQUE INDEX price_history_write_uq ON tenant_data.price_history (tenant_id, accepted_at, channel_write_id)
  WHERE channel_write_id IS NOT NULL AND corrects_price_history_id IS NULL;

SELECT security.register_table('tenant_data.price_history', 'TENANT', 'append_only');
SELECT security.grant_retention('tenant_data.price_history');
SELECT security.grant_export('tenant_data.price_history');

INSERT INTO maintenance.retention_policy
  (table_name, method, anchor_column, retention, safety_margin, bound, partition_interval, hash_modulus,
   requires_export, months_ahead, drop_order)
VALUES
  ('tenant_data.price_history', 'DROP_PARTITION', 'accepted_at', '90 days', '0 days', 'MIN_AGE', 'month', 8,
   ARRAY['ARCHIVE'], 2, 40);

-- ---------------------------------------------------------------------------
-- price_daily — суточная свёртка наших цен по единице записи [Р-21]. Вечно. Ведётся только триггером.
-- День — местный день маркетплейса (Германия и Австрия: Europe/Berlin, Р-26).
-- ---------------------------------------------------------------------------
CREATE TABLE tenant_data.price_daily (
  tenant_id          uuid   NOT NULL,
  write_scope_id     uuid   NOT NULL,
  price_type         text   NOT NULL CHECK (price_type IN ('REGULAR', 'SALE', 'REFERENCE')),
  price_day          date   NOT NULL,
  day_tz             text   NOT NULL DEFAULT 'Europe/Berlin' CHECK (day_tz = 'Europe/Berlin'),
  currency           text   NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  price_basis        text   NOT NULL CHECK (price_basis IN ('GROSS', 'NET')),
  min_amount_minor   bigint NOT NULL CHECK (min_amount_minor > 0),
  max_amount_minor   bigint NOT NULL,
  first_amount_minor bigint NOT NULL,
  first_accepted_at  timestamptz NOT NULL,
  last_amount_minor  bigint NOT NULL,
  last_accepted_at   timestamptz NOT NULL,
  change_count       int    NOT NULL CHECK (change_count >= 1),
  min_floor_minor    bigint NOT NULL CHECK (min_floor_minor > 0),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  -- Omnibus: дни окна [D-30, D) по единице и последняя цена перед окном
  PRIMARY KEY (tenant_id, write_scope_id, price_type, price_day),
  FOREIGN KEY (tenant_id, write_scope_id) REFERENCES tenant_data.write_scope (tenant_id, write_scope_id),
  CHECK (min_amount_minor <= first_amount_minor AND first_amount_minor <= max_amount_minor),
  CHECK (min_amount_minor <= last_amount_minor AND last_amount_minor <= max_amount_minor),
  CHECK (first_accepted_at <= last_accepted_at),
  CHECK (min_amount_minor >= min_floor_minor)
);

-- Закрытый день неизменяем (день D можно дополнять до конца дня D+1 по местному времени); свёртка только расширяется.
CREATE FUNCTION tenant_data.price_daily_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.price_day < (now() AT TIME ZONE OLD.day_tz)::date - 1 THEN
    RAISE EXCEPTION 'price_daily for closed day % is immutable', OLD.price_day USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.min_amount_minor > OLD.min_amount_minor OR NEW.max_amount_minor < OLD.max_amount_minor
     OR NEW.change_count <= OLD.change_count
     OR NEW.first_accepted_at > OLD.first_accepted_at OR NEW.last_accepted_at < OLD.last_accepted_at THEN
    RAISE EXCEPTION 'price_daily may only widen' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER a_price_daily_only_from_trigger BEFORE INSERT OR UPDATE ON tenant_data.price_daily
  FOR EACH ROW EXECUTE FUNCTION security.only_from_trigger();
CREATE TRIGGER b_price_daily_restrict_update BEFORE UPDATE ON tenant_data.price_daily
  FOR EACH ROW EXECUTE FUNCTION security.restrict_update(
    'min_amount_minor', 'max_amount_minor', 'first_amount_minor', 'first_accepted_at', 'last_amount_minor',
    'last_accepted_at', 'change_count', 'min_floor_minor', 'updated_at');
CREATE TRIGGER c_price_daily_guard BEFORE UPDATE ON tenant_data.price_daily
  FOR EACH ROW EXECUTE FUNCTION tenant_data.price_daily_guard();
CREATE TRIGGER zz_price_daily_no_delete BEFORE DELETE ON tenant_data.price_daily
  FOR EACH ROW EXECUTE FUNCTION security.forbid_mutation();
CREATE TRIGGER zz_price_daily_no_truncate BEFORE TRUNCATE ON tenant_data.price_daily
  FOR EACH STATEMENT EXECUTE FUNCTION security.forbid_truncate();

SELECT security.register_table('tenant_data.price_daily', 'TENANT', 'mutable');
SELECT security.grant_retention('tenant_data.price_daily');
SELECT security.grant_export('tenant_data.price_daily');

INSERT INTO maintenance.retention_policy (table_name, method) VALUES ('tenant_data.price_daily', 'TENANT_CLOSURE_ONLY');

-- Каждая строка сырья попадает в свёртку в той же транзакции.
CREATE FUNCTION tenant_data.price_history_rollup() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.corrects_price_history_id IS NOT NULL THEN
    -- Семантика исправлений в вечной свёртке не определена (OQ-66): исправления пока запрещены
    RAISE EXCEPTION 'price_history corrections are not supported until price_daily correction rules are defined'
      USING ERRCODE = 'feature_not_supported';
  END IF;

  INSERT INTO tenant_data.price_daily AS d
    (tenant_id, write_scope_id, price_type, price_day, currency, price_basis,
     min_amount_minor, max_amount_minor, first_amount_minor, first_accepted_at, last_amount_minor, last_accepted_at,
     change_count, min_floor_minor)
  VALUES
    (NEW.tenant_id, NEW.write_scope_id, NEW.price_type, (NEW.accepted_at AT TIME ZONE 'Europe/Berlin')::date,
     NEW.currency, NEW.price_basis, NEW.amount_minor, NEW.amount_minor, NEW.amount_minor, NEW.accepted_at,
     NEW.amount_minor, NEW.accepted_at, 1, NEW.effective_min_price_minor)
  ON CONFLICT (tenant_id, write_scope_id, price_type, price_day) DO UPDATE SET
    min_amount_minor   = least(d.min_amount_minor, EXCLUDED.min_amount_minor),
    max_amount_minor   = greatest(d.max_amount_minor, EXCLUDED.max_amount_minor),
    first_amount_minor = CASE WHEN EXCLUDED.first_accepted_at < d.first_accepted_at
                              THEN EXCLUDED.first_amount_minor ELSE d.first_amount_minor END,
    first_accepted_at  = least(d.first_accepted_at, EXCLUDED.first_accepted_at),
    last_amount_minor  = CASE WHEN EXCLUDED.last_accepted_at >= d.last_accepted_at
                              THEN EXCLUDED.last_amount_minor ELSE d.last_amount_minor END,
    last_accepted_at   = greatest(d.last_accepted_at, EXCLUDED.last_accepted_at),
    change_count       = d.change_count + 1,
    min_floor_minor    = least(d.min_floor_minor, EXCLUDED.min_floor_minor),
    updated_at         = now();
  RETURN NULL;
END $$;

CREATE TRIGGER price_history_rollup AFTER INSERT ON tenant_data.price_history
  FOR EACH ROW EXECUTE FUNCTION tenant_data.price_history_rollup();

-- Р-21: у записи цены на момент ACCEPTED должен быть accepted_at (партиционный ключ сырья)
CREATE OR REPLACE FUNCTION tenant_data.channel_write_record_price_history() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.field = 'PRICE' AND NEW.status = 'ACCEPTED' AND OLD.status <> 'ACCEPTED' THEN
    INSERT INTO tenant_data.price_history
      (tenant_id, accepted_at, write_scope_id, product_id, amount_minor, currency, price_basis, effective_min_price_minor,
       channel_write_id, write_version, dispatched_at)
    SELECT NEW.tenant_id, NEW.accepted_at, NEW.write_scope_id, ws.product_id, NEW.amount_minor, NEW.currency,
           NEW.price_basis, NEW.floor_at_dispatch_minor, NEW.channel_write_id, NEW.version, NEW.dispatched_at
      FROM tenant_data.write_scope ws
     WHERE ws.tenant_id = NEW.tenant_id AND ws.write_scope_id = NEW.write_scope_id;
  END IF;
  RETURN NULL;
END $$;

RESET ROLE;
COMMIT;
