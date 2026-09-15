-- 0024_price_intent_classes.sql
-- Р-27: классы intent — CHANGED, REJECTED_BY_GATE (целиком всегда), NO_OP (сырьём 7 дней, затем почасовой агрегат).
-- Р-38: вечно хранится ядро intent без входов из данных канала; входы — ClickHouse, 18 месяцев.
-- Р-28: буферы PostgreSQL — price_intent 3 дня, price_decision 30 дней, observed_price_daily 45 дней.
-- NO_OP: в PostgreSQL живёт 3 дня как любой intent; сырьё 7 дней и почасовой агрегат — в ClickHouse (schemas/clickhouse).

BEGIN;
SET ROLE repracer_owner;

-- ---------------------------------------------------------------------------
-- 1. Класс intent — производное итога Price Gate
-- ---------------------------------------------------------------------------
ALTER TABLE channel_data.price_decision
  ADD COLUMN intent_class text GENERATED ALWAYS AS (
    CASE WHEN outcome IN ('APPROVED', 'CLAMPED_FLOOR', 'CLAMPED_CEILING') THEN 'CHANGED'
         WHEN outcome IN ('REJECTED', 'HELD') THEN 'REJECTED_BY_GATE'
         ELSE 'NO_OP' END) STORED;

-- Код правила стратегии и эталонное значение входа: агрегат NO_OP строится без разбора JSON входов
ALTER TABLE channel_data.price_intent
  ADD COLUMN rule_code text CHECK (rule_code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  ADD COLUMN reference_amount_minor bigint CHECK (reference_amount_minor > 0);

-- ---------------------------------------------------------------------------
-- 2. Решение живёт 30 дней, intent — 3 дня [Р-28]: FK decision -> intent снимается,
--    соответствие единице записи проверяется при вставке решения.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  fk text;
BEGIN
  FOR fk IN SELECT conname FROM pg_constraint
             WHERE conrelid = 'channel_data.price_decision'::regclass AND confrelid = 'channel_data.price_intent'::regclass
               AND contype = 'f' AND conparentid = 0
  LOOP
    EXECUTE format('ALTER TABLE channel_data.price_decision DROP CONSTRAINT %I', fk);
  END LOOP;
END $$;

CREATE FUNCTION channel_data.price_decision_intent_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM channel_data.price_intent i
                  WHERE i.tenant_id = NEW.tenant_id AND i.created_at = NEW.intent_created_at
                    AND i.price_intent_id = NEW.price_intent_id AND i.write_scope_id = NEW.write_scope_id) THEN
    RAISE EXCEPTION 'price_decision must reference an existing price_intent of the same write_scope'
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER c_price_decision_intent_guard BEFORE INSERT ON channel_data.price_decision
  FOR EACH ROW EXECUTE FUNCTION channel_data.price_decision_intent_guard();

UPDATE maintenance.retention_policy
   SET retention = '30 days', force_drop_after = '45 days'
 WHERE table_name = 'channel_data.price_decision'::regclass;
UPDATE maintenance.retention_policy
   SET retention = '45 days'
 WHERE table_name = 'channel_data.observed_price_daily'::regclass;

-- ---------------------------------------------------------------------------
-- 3. Ядро intent [Р-27, Р-38]: CHANGED и REJECTED_BY_GATE, без входов с данными канала.
--    Горячо 30 дней (месяц -> HASH 8), затем архив навсегда (удаление партиции — только после экспорта).
-- ---------------------------------------------------------------------------
CREATE TABLE tenant_data.price_intent_core (
  tenant_id                uuid   NOT NULL,
  price_intent_id          uuid   NOT NULL,
  intent_created_at        timestamptz NOT NULL,
  write_scope_id           uuid   NOT NULL,
  pricing_strategy_id      uuid,
  pricing_strategy_version int,
  trigger_type             text   NOT NULL,
  rule_code                text,
  proposed_amount_minor    bigint NOT NULL CHECK (proposed_amount_minor > 0),
  currency                 text   NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  price_basis              text   NOT NULL CHECK (price_basis IN ('GROSS', 'NET')),
  intent_class             text   NOT NULL CHECK (intent_class IN ('CHANGED', 'REJECTED_BY_GATE')),
  price_decision_id        uuid   NOT NULL,
  decision_outcome         text   NOT NULL,
  final_amount_minor       bigint,
  effective_floor_minor    bigint NOT NULL CHECK (effective_floor_minor > 0),
  effective_ceiling_minor  bigint,
  violations               text[] NOT NULL DEFAULT '{}',
  decided_at               timestamptz NOT NULL,
  recorded_at              timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, intent_created_at, price_intent_id),
  FOREIGN KEY (tenant_id, write_scope_id) REFERENCES tenant_data.write_scope (tenant_id, write_scope_id),
  CHECK ((intent_class = 'CHANGED') = (final_amount_minor IS NOT NULL)),
  CHECK (final_amount_minor IS NULL OR final_amount_minor >= effective_floor_minor)
) PARTITION BY RANGE (intent_created_at);

-- История решений единицы записи в горячем окне («почему менялась цена»)
CREATE INDEX price_intent_core_scope_idx ON tenant_data.price_intent_core (tenant_id, write_scope_id, intent_created_at DESC);

SELECT security.register_table('tenant_data.price_intent_core', 'TENANT', 'append_only');
SELECT security.grant_retention('tenant_data.price_intent_core');
SELECT security.grant_export('tenant_data.price_intent_core');

INSERT INTO maintenance.retention_policy
  (table_name, method, anchor_column, retention, safety_margin, bound, partition_interval, hash_modulus,
   requires_export, months_ahead, drop_order)
VALUES
  ('tenant_data.price_intent_core', 'DROP_PARTITION', 'intent_created_at', '30 days', '0 days', 'MIN_AGE', 'month', 8,
   ARRAY['ARCHIVE'], 2, 35);

-- Ядро записывается в той же транзакции, что и решение (генерируемый intent_class доступен в AFTER-триггере)
CREATE FUNCTION channel_data.price_decision_record_core() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.intent_class <> 'NO_OP' THEN
    INSERT INTO tenant_data.price_intent_core
      (tenant_id, price_intent_id, intent_created_at, write_scope_id, pricing_strategy_id, pricing_strategy_version,
       trigger_type, rule_code, proposed_amount_minor, currency, price_basis, intent_class, price_decision_id,
       decision_outcome, final_amount_minor, effective_floor_minor, effective_ceiling_minor, violations, decided_at)
    SELECT i.tenant_id, i.price_intent_id, i.created_at, i.write_scope_id, i.pricing_strategy_id, i.pricing_strategy_version,
           i.trigger_type, i.rule_code, i.proposed_amount_minor, i.currency, i.price_basis, NEW.intent_class,
           NEW.price_decision_id, NEW.outcome, NEW.final_amount_minor, NEW.effective_floor_minor,
           NEW.effective_ceiling_minor, NEW.violations, NEW.decided_at
      FROM channel_data.price_intent i
     WHERE i.tenant_id = NEW.tenant_id AND i.created_at = NEW.intent_created_at
       AND i.price_intent_id = NEW.price_intent_id;
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER d_price_decision_record_core AFTER INSERT ON channel_data.price_decision
  FOR EACH ROW EXECUTE FUNCTION channel_data.price_decision_record_core();

SELECT maintenance.ensure_partitions();

RESET ROLE;
COMMIT;
