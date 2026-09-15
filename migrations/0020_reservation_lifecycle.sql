-- 0020_reservation_lifecycle.sql
-- Р-25: CREATED -> CONFIRMED_BY_SOURCE -> CONSUMED | RELEASED.
-- Подтверждение — только вызовом источника с внешним идентификатором заказа; TTL 24 часа, затем RELEASED с алертом.
-- Заменяет статусы резервации шага 3 (ACTIVE / RELEASED_BY_SOURCE / CANCELLED / EXPIRED).

BEGIN;

SET ROLE repracer_retention;
DO $$
DECLARE
  has_rows boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM channel_data.reservation) INTO has_rows;
  IF has_rows THEN
    RAISE EXCEPTION 'channel_data.reservation is not empty: close or migrate reservations before this migration';
  END IF;
END $$;

SET ROLE repracer_owner;

DELETE FROM security.table_registry WHERE table_name = 'channel_data.reservation'::regclass;
DELETE FROM maintenance.retention_policy WHERE table_name = 'channel_data.reservation'::regclass;
DROP TABLE channel_data.reservation;
DROP FUNCTION channel_data.reservation_transition();

-- Подтверждать может только источник, которому принадлежит пул
ALTER TABLE tenant_data.stock_pool ADD CONSTRAINT stock_pool_source_uq UNIQUE (tenant_id, stock_pool_id, stock_source_id);

CREATE TABLE channel_data.reservation (
  tenant_id                    uuid NOT NULL,
  reservation_id               uuid NOT NULL DEFAULT gen_random_uuid(),
  stock_pool_id                uuid NOT NULL,
  source_mode                  text NOT NULL,
  product_id                   uuid NOT NULL,
  quantity                     int  NOT NULL CHECK (quantity > 0),
  channel_account_id           uuid NOT NULL,
  channel                      text NOT NULL,
  channel_order_ref            text NOT NULL,
  channel_order_line_ref       text NOT NULL,
  order_created_at             timestamptz NOT NULL,
  managed_listing              boolean NOT NULL DEFAULT true,
  status                       text NOT NULL DEFAULT 'CREATED'
                               CHECK (status IN ('CREATED', 'CONFIRMED_BY_SOURCE', 'CONSUMED', 'RELEASED')),
  created_at                   timestamptz NOT NULL DEFAULT now(),
  expires_at                   timestamptz NOT NULL,
  confirmed_at                 timestamptz,
  confirmed_by_stock_source_id uuid,
  confirmed_external_order_ref text,
  consumed_at                  timestamptz,
  released_at                  timestamptz,
  release_reason               text CHECK (release_reason IN ('ORDER_CANCELLED', 'TTL_EXPIRED', 'SOURCE_REJECTED', 'MANUAL')),
  closed_at                    timestamptz,
  PRIMARY KEY (tenant_id, reservation_id),
  UNIQUE (tenant_id, channel_account_id, channel_order_line_ref, product_id),
  FOREIGN KEY (tenant_id, stock_pool_id, source_mode, product_id)
    REFERENCES tenant_data.stock_pool (tenant_id, stock_pool_id, source_mode, product_id),
  FOREIGN KEY (tenant_id, stock_pool_id, confirmed_by_stock_source_id)
    REFERENCES tenant_data.stock_pool (tenant_id, stock_pool_id, stock_source_id),
  FOREIGN KEY (tenant_id, channel_account_id, channel)
    REFERENCES tenant_data.channel_account (tenant_id, channel_account_id, channel),
  -- Р-25: TTL ровно 24 часа
  CONSTRAINT reservation_ttl_24h CHECK (expires_at = created_at + interval '24 hours'),
  -- Р-25: подтверждение несёт внешний идентификатор этого заказа
  CONSTRAINT reservation_confirmation_matches_order CHECK (
    confirmed_at IS NULL
    OR (confirmed_by_stock_source_id IS NOT NULL AND confirmed_external_order_ref = channel_order_ref)),
  CHECK ((status = 'CREATED') = (confirmed_at IS NULL AND closed_at IS NULL)),
  CHECK (status NOT IN ('CONFIRMED_BY_SOURCE', 'CONSUMED') OR confirmed_at IS NOT NULL),
  CHECK ((status = 'CONSUMED') = (consumed_at IS NOT NULL)),
  CHECK ((status = 'RELEASED') = (released_at IS NOT NULL AND release_reason IS NOT NULL)),
  CHECK ((status IN ('CONSUMED', 'RELEASED')) = (closed_at IS NOT NULL)),
  CHECK (release_reason IS DISTINCT FROM 'TTL_EXPIRED' OR (confirmed_at IS NULL AND released_at >= expires_at))
);

-- Доступный остаток: открытые резервации товара
CREATE INDEX reservation_open_product_idx ON channel_data.reservation (tenant_id, product_id)
  WHERE status IN ('CREATED', 'CONFIRMED_BY_SOURCE');
-- Подтверждение источником по внешнему идентификатору заказа
CREATE INDEX reservation_confirm_idx ON channel_data.reservation (tenant_id, channel_order_ref) WHERE status = 'CREATED';
-- Истечение TTL (все тенанты)
CREATE INDEX reservation_ttl_idx ON channel_data.reservation (expires_at) WHERE status = 'CREATED';
-- Удаление закрытых по сроку
CREATE INDEX reservation_retention_idx ON channel_data.reservation (closed_at) WHERE closed_at IS NOT NULL;

CREATE FUNCTION channel_data.reservation_before_write() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'CREATED' THEN
      RAISE EXCEPTION 'reservation must be created in status CREATED' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    NEW.created_at := now();
    NEW.expires_at := NEW.created_at + interval '24 hours';
    RETURN NEW;
  END IF;

  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;
  IF (OLD.status, NEW.status) NOT IN (VALUES
       ('CREATED', 'CONFIRMED_BY_SOURCE'), ('CREATED', 'RELEASED'),
       ('CONFIRMED_BY_SOURCE', 'CONSUMED'), ('CONFIRMED_BY_SOURCE', 'RELEASED')) THEN
    RAISE EXCEPTION 'reservation transition % -> % is not allowed', OLD.status, NEW.status
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.status = 'CONFIRMED_BY_SOURCE' AND now() >= OLD.expires_at THEN
    RAISE EXCEPTION 'reservation % expired at %; confirmation rejected', OLD.reservation_id, OLD.expires_at
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.release_reason = 'TTL_EXPIRED' AND now() < OLD.expires_at THEN
    RAISE EXCEPTION 'reservation % has not expired yet', OLD.reservation_id USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  NEW.closed_at := CASE WHEN NEW.status IN ('CONSUMED', 'RELEASED') THEN coalesce(NEW.closed_at, now()) END;
  RETURN NEW;
END $$;

-- Внутренний пул: CONSUMED списывает остаток ровно один раз. Истечение TTL — алерт через outbox.
CREATE OR REPLACE FUNCTION channel_data.reservation_consume() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'CONSUMED' AND OLD.status <> 'CONSUMED' AND NEW.source_mode = 'INTERNAL_POOL' THEN
    INSERT INTO tenant_data.stock_movement (tenant_id, stock_pool_id, delta, reason, reservation_id)
    VALUES (NEW.tenant_id, NEW.stock_pool_id, -NEW.quantity, 'ORDER_SHIPPED', NEW.reservation_id);
  END IF;
  IF NEW.release_reason = 'TTL_EXPIRED' AND OLD.status = 'CREATED' THEN
    INSERT INTO tenant_data.outbox_event (tenant_id, topic, partition_key, event_type, payload)
    VALUES (NEW.tenant_id, 'alert.reservation-ttl-expired.v1', NEW.tenant_id, 'ReservationTtlExpired',
            jsonb_build_object('reservation_id', NEW.reservation_id, 'product_id', NEW.product_id,
                               'stock_pool_id', NEW.stock_pool_id, 'expires_at', NEW.expires_at));
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER a_reservation_restrict_update BEFORE UPDATE ON channel_data.reservation
  FOR EACH ROW EXECUTE FUNCTION security.restrict_update(
    'status', 'confirmed_at', 'confirmed_by_stock_source_id', 'confirmed_external_order_ref',
    'consumed_at', 'released_at', 'release_reason', 'closed_at');
CREATE TRIGGER b_reservation_before_write BEFORE INSERT OR UPDATE ON channel_data.reservation
  FOR EACH ROW EXECUTE FUNCTION channel_data.reservation_before_write();
CREATE TRIGGER c_reservation_consume AFTER UPDATE OF status ON channel_data.reservation
  FOR EACH ROW EXECUTE FUNCTION channel_data.reservation_consume();

SELECT security.register_table('channel_data.reservation', 'CHANNEL', 'mutable');
SELECT security.grant_retention('channel_data.reservation');

INSERT INTO maintenance.retention_policy (table_name, method, anchor_column, retention, safety_margin, drop_order)
VALUES ('channel_data.reservation', 'DELETE_ROWS', 'closed_at', '30 days', '0 days', 60);

-- Подтверждение источником: все открытые строки заказа в пулах этого источника (вызывается Inbound API).
CREATE FUNCTION channel_data.confirm_reservations_by_source(p_stock_source_id uuid, p_external_order_ref text) RETURNS int
  LANGUAGE plpgsql AS $$
DECLARE
  n int;
BEGIN
  UPDATE channel_data.reservation r
     SET status = 'CONFIRMED_BY_SOURCE', confirmed_at = now(),
         confirmed_by_stock_source_id = p_stock_source_id, confirmed_external_order_ref = p_external_order_ref
    FROM tenant_data.stock_pool sp
   WHERE r.status = 'CREATED' AND r.channel_order_ref = p_external_order_ref
     AND sp.tenant_id = r.tenant_id AND sp.stock_pool_id = r.stock_pool_id AND sp.stock_source_id = p_stock_source_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- Истечение TTL через всех тенантов (планировщик): RELEASED + алерт.
CREATE FUNCTION maintenance.release_expired_reservations(p_now timestamptz DEFAULT now(), p_batch int DEFAULT 1000) RETURNS int
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  n int;
BEGIN
  UPDATE channel_data.reservation
     SET status = 'RELEASED', released_at = p_now, release_reason = 'TTL_EXPIRED'
   WHERE ctid = ANY (ARRAY(SELECT ctid FROM channel_data.reservation
                            WHERE status = 'CREATED' AND expires_at <= p_now LIMIT p_batch));
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

REVOKE ALL ON FUNCTION maintenance.release_expired_reservations(timestamptz, int) FROM PUBLIC;

CREATE POLICY retention_ttl_update ON channel_data.reservation FOR UPDATE TO repracer_retention USING (true) WITH CHECK (true);
GRANT UPDATE ON channel_data.reservation TO repracer_retention;
CREATE POLICY retention_alert_insert ON tenant_data.outbox_event FOR INSERT TO repracer_retention WITH CHECK (true);
GRANT INSERT ON tenant_data.outbox_event TO repracer_retention;
CREATE POLICY retention_movement_insert ON tenant_data.stock_movement FOR INSERT TO repracer_retention WITH CHECK (true);

RESET ROLE;

GRANT CREATE ON SCHEMA maintenance TO repracer_retention;
ALTER FUNCTION maintenance.release_expired_reservations(timestamptz, int) OWNER TO repracer_retention;
REVOKE CREATE ON SCHEMA maintenance FROM repracer_retention;

COMMIT;
