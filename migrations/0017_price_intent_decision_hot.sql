-- 0017_price_intent_decision_hot.sql
-- Р-20: price_intent и price_decision в PostgreSQL — горячий буфер на 3 дня (Price Gate и отладка),
-- дневные партиции без подпартиций; копия для аналитики и бэктеста — в ClickHouse.
-- Партиция удаляется после подтверждённого экспорта; без экспорта — принудительно через 14 дней (данные канала, не доказательство).

BEGIN;

SET ROLE repracer_retention;
DO $$
DECLARE
  has_rows boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM channel_data.price_decision) OR EXISTS (SELECT 1 FROM channel_data.price_intent) INTO has_rows;
  IF has_rows THEN
    RAISE EXCEPTION 'price_intent/price_decision are not empty: export to ClickHouse before this migration';
  END IF;
END $$;

SET ROLE repracer_owner;

DELETE FROM maintenance.retention_policy WHERE table_name::text IN ('channel_data.price_decision', 'channel_data.price_intent');
DELETE FROM security.table_registry     WHERE table_name::text IN ('channel_data.price_decision', 'channel_data.price_intent');
DROP TABLE channel_data.price_decision;
DROP TABLE channel_data.price_intent;

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
  -- Ссылка на снимок конкурентов (ClickHouse) вместо копии предложений во входах
  competitor_snapshot_id   uuid,
  proposed_amount_minor    bigint NOT NULL CHECK (proposed_amount_minor > 0),
  currency                 text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  price_basis              text NOT NULL CHECK (price_basis IN ('GROSS', 'NET')),
  inputs                   jsonb NOT NULL DEFAULT '{}'::jsonb,
  rationale                jsonb NOT NULL DEFAULT '{}'::jsonb,
  expires_at               timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, created_at, price_intent_id),
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

-- Последний intent единицы (вытеснение, «почему такая цена» в пределах горячего окна)
CREATE INDEX price_intent_scope_idx ON channel_data.price_intent (tenant_id, write_scope_id, created_at DESC);

CREATE TRIGGER price_intent_engine_mode BEFORE INSERT ON channel_data.price_intent
  FOR EACH ROW EXECUTE FUNCTION channel_data.assert_engine_mode();

SELECT security.register_table('channel_data.price_intent', 'CHANNEL', 'append_only');
SELECT security.grant_retention('channel_data.price_intent');
SELECT security.grant_export('channel_data.price_intent');

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
  UNIQUE (tenant_id, intent_created_at, price_intent_id),
  FOREIGN KEY (tenant_id, intent_created_at, price_intent_id, write_scope_id)
    REFERENCES channel_data.price_intent (tenant_id, created_at, price_intent_id, write_scope_id),
  CHECK ((outcome IN ('APPROVED', 'CLAMPED_FLOOR', 'CLAMPED_CEILING')) = (final_amount_minor IS NOT NULL)),
  CHECK (final_amount_minor IS NULL OR final_amount_minor >= effective_floor_minor),
  CHECK (final_amount_minor IS NULL OR effective_ceiling_minor IS NULL OR final_amount_minor <= effective_ceiling_minor),
  CHECK (outcome <> 'CLAMPED_FLOOR' OR final_amount_minor = effective_floor_minor),
  CHECK (outcome <> 'CLAMPED_CEILING' OR final_amount_minor = effective_ceiling_minor),
  CHECK (cardinality(min_price_ids) >= 1)
) PARTITION BY RANGE (intent_created_at);

-- Проверка решения при создании записи цены в канал (0008)
CREATE INDEX price_decision_id_idx ON channel_data.price_decision (tenant_id, price_decision_id);

CREATE TRIGGER a_price_decision_engine_mode BEFORE INSERT ON channel_data.price_decision
  FOR EACH ROW EXECUTE FUNCTION channel_data.assert_engine_mode();
CREATE TRIGGER b_price_decision_floor_guard BEFORE INSERT ON channel_data.price_decision
  FOR EACH ROW EXECUTE FUNCTION channel_data.price_decision_floor_guard();

SELECT security.register_table('channel_data.price_decision', 'CHANNEL', 'append_only');
SELECT security.grant_retention('channel_data.price_decision');
SELECT security.grant_export('channel_data.price_decision');

INSERT INTO maintenance.retention_policy
  (table_name, method, anchor_column, retention, safety_margin, bound, partition_interval, requires_export,
   force_drop_after, days_ahead, drop_order)
VALUES
  ('channel_data.price_decision', 'DROP_PARTITION', 'intent_created_at', '3 days', '0 days', 'MIN_AGE', 'day',
   ARRAY['CLICKHOUSE'], '14 days', 3, 10),
  ('channel_data.price_intent',   'DROP_PARTITION', 'created_at',        '3 days', '0 days', 'MIN_AGE', 'day',
   ARRAY['CLICKHOUSE'], '14 days', 3, 20);

RESET ROLE;
COMMIT;
