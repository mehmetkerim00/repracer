-- 0007_inventory.sql
-- Остатки [Р-6, Р-15]: источники (внутренний пул / Inbound API; зеркало ERP — не в Release 1.0),
-- ключи Inbound API, пулы, журнал движений внутреннего пула, буферы каналов.

BEGIN;
SET ROLE repracer_owner;

-- ---------------------------------------------------------------------------
-- stock_source
-- ---------------------------------------------------------------------------
CREATE TABLE tenant_data.stock_source (
  tenant_id       uuid NOT NULL REFERENCES tenant_data.tenant (tenant_id),
  stock_source_id uuid NOT NULL DEFAULT gen_random_uuid(),
  mode            text NOT NULL CHECK (mode IN ('INTERNAL_POOL', 'INBOUND_API', 'ERP_MIRROR')),
  name            text NOT NULL,
  status          text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISABLED')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, stock_source_id),
  -- Цель FK, переносящих режим источника в пулы, ключи и резервации
  UNIQUE (tenant_id, stock_source_id, mode),
  -- Р-15: зеркало ERP не входит в Release 1.0; снимается отдельной миграцией
  CONSTRAINT stock_source_release_1_0_modes CHECK (mode <> 'ERP_MIRROR')
);

CREATE TRIGGER stock_source_restrict_update BEFORE UPDATE ON tenant_data.stock_source
  FOR EACH ROW EXECUTE FUNCTION security.restrict_update('name', 'status');

SELECT security.register_table('tenant_data.stock_source', 'TENANT', 'mutable');

-- ---------------------------------------------------------------------------
-- inbound_api_key — только для источников INBOUND_API. Хранится SHA-256 ключа, не сам ключ.
-- ---------------------------------------------------------------------------
CREATE TABLE tenant_data.inbound_api_key (
  tenant_id                uuid NOT NULL,
  inbound_api_key_id       uuid NOT NULL DEFAULT gen_random_uuid(),
  stock_source_id          uuid NOT NULL,
  source_mode              text NOT NULL DEFAULT 'INBOUND_API' CHECK (source_mode = 'INBOUND_API'),
  -- Поиск ключа до установки контекста тенанта (функция резолва 0013); уникален на платформе
  key_prefix               text NOT NULL UNIQUE CHECK (length(key_prefix) BETWEEN 8 AND 32),
  key_sha256               bytea NOT NULL CHECK (length(key_sha256) = 32),
  created_by_membership_id uuid NOT NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  revoked_at               timestamptz,
  PRIMARY KEY (tenant_id, inbound_api_key_id),
  FOREIGN KEY (tenant_id, stock_source_id, source_mode)
    REFERENCES tenant_data.stock_source (tenant_id, stock_source_id, mode),
  FOREIGN KEY (tenant_id, created_by_membership_id) REFERENCES tenant_data.membership (tenant_id, membership_id)
);

CREATE TRIGGER inbound_api_key_restrict_update BEFORE UPDATE ON tenant_data.inbound_api_key
  FOR EACH ROW EXECUTE FUNCTION security.restrict_update('revoked_at');

SELECT security.register_table('tenant_data.inbound_api_key', 'TENANT', 'mutable');

-- ---------------------------------------------------------------------------
-- stock_pool — остаток простого товара в одном месте хранения
-- ---------------------------------------------------------------------------
CREATE TABLE tenant_data.stock_pool (
  tenant_id       uuid NOT NULL,
  stock_pool_id   uuid NOT NULL DEFAULT gen_random_uuid(),
  stock_source_id uuid NOT NULL,
  source_mode     text NOT NULL,
  product_id      uuid NOT NULL,
  product_kind    text NOT NULL DEFAULT 'SIMPLE' CHECK (product_kind = 'SIMPLE'),
  location_ref    text NOT NULL DEFAULT 'default',
  on_hand         int  NOT NULL DEFAULT 0 CHECK (on_hand >= 0),
  source_as_of    timestamptz,
  source_version  bigint,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, stock_pool_id),
  -- Цель FK из резерваций и движений: правила статусов зависят от режима источника
  UNIQUE (tenant_id, stock_pool_id, source_mode),
  -- Цель FK из резерваций: резервация товара — только в пуле этого товара
  UNIQUE (tenant_id, stock_pool_id, source_mode, product_id),
  -- Inbound API: upsert остатка по (источник, товар, место)
  UNIQUE (tenant_id, stock_source_id, product_id, location_ref),
  FOREIGN KEY (tenant_id, stock_source_id, source_mode)
    REFERENCES tenant_data.stock_source (tenant_id, stock_source_id, mode),
  FOREIGN KEY (tenant_id, product_id, product_kind) REFERENCES tenant_data.product (tenant_id, product_id, kind),
  CHECK (source_mode <> 'INBOUND_API' OR on_hand = 0 OR source_as_of IS NOT NULL)
);

-- Расчёт доступного остатка товара: все пулы товара
CREATE INDEX stock_pool_product_idx ON tenant_data.stock_pool (tenant_id, product_id);

-- INBOUND_API: значение с source_as_of не новее текущего не применяется (INV-10).
-- INTERNAL_POOL: on_hand меняется только журналом движений.
CREATE FUNCTION tenant_data.stock_pool_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.source_mode = 'INTERNAL_POOL' AND NEW.on_hand <> 0 THEN
      RAISE EXCEPTION 'INTERNAL_POOL starts at 0; use stock_movement' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.on_hand IS DISTINCT FROM OLD.on_hand OR NEW.source_as_of IS DISTINCT FROM OLD.source_as_of THEN
    IF NEW.source_mode = 'INTERNAL_POOL' AND pg_trigger_depth() < 2 THEN
      RAISE EXCEPTION 'INTERNAL_POOL on_hand is changed only via stock_movement' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.source_mode = 'INBOUND_API' AND OLD.source_as_of IS NOT NULL
       AND (NEW.source_as_of IS NULL OR NEW.source_as_of <= OLD.source_as_of) THEN
      RAISE EXCEPTION 'stale stock update: source_as_of % is not newer than %', NEW.source_as_of, OLD.source_as_of
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

CREATE TRIGGER a_stock_pool_restrict_update BEFORE UPDATE ON tenant_data.stock_pool
  FOR EACH ROW EXECUTE FUNCTION security.restrict_update('on_hand', 'source_as_of', 'source_version', 'updated_at');
CREATE TRIGGER b_stock_pool_guard BEFORE INSERT OR UPDATE ON tenant_data.stock_pool
  FOR EACH ROW EXECUTE FUNCTION tenant_data.stock_pool_guard();

SELECT security.register_table('tenant_data.stock_pool', 'TENANT', 'mutable');

-- ---------------------------------------------------------------------------
-- stock_movement — журнал внутреннего пула (append-only). Ссылка на резервацию — без FK:
-- резервации живут в channel_data и удаляются по сроку.
-- ---------------------------------------------------------------------------
CREATE TABLE tenant_data.stock_movement (
  tenant_id                uuid NOT NULL,
  stock_movement_id        uuid NOT NULL DEFAULT gen_random_uuid(),
  stock_pool_id            uuid NOT NULL,
  source_mode              text NOT NULL DEFAULT 'INTERNAL_POOL' CHECK (source_mode = 'INTERNAL_POOL'),
  delta                    int  NOT NULL CHECK (delta <> 0),
  reason                   text NOT NULL CHECK (reason IN ('RECEIPT', 'ADJUSTMENT', 'STOCKTAKE', 'ORDER_SHIPPED', 'RETURN')),
  reservation_id           uuid,
  created_by_membership_id uuid,
  occurred_at              timestamptz NOT NULL DEFAULT now(),
  recorded_at              timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, stock_movement_id),
  FOREIGN KEY (tenant_id, stock_pool_id, source_mode) REFERENCES tenant_data.stock_pool (tenant_id, stock_pool_id, source_mode),
  FOREIGN KEY (tenant_id, created_by_membership_id) REFERENCES tenant_data.membership (tenant_id, membership_id),
  CHECK ((reason = 'ORDER_SHIPPED') = (reservation_id IS NOT NULL)),
  CHECK (reason <> 'ORDER_SHIPPED' OR delta < 0)
);

-- Резервация списывается ровно один раз
CREATE UNIQUE INDEX stock_movement_reservation_uq
  ON tenant_data.stock_movement (tenant_id, reservation_id) WHERE reservation_id IS NOT NULL;
-- История движений пула в интерфейсе
CREATE INDEX stock_movement_pool_idx ON tenant_data.stock_movement (tenant_id, stock_pool_id, recorded_at DESC);

CREATE FUNCTION tenant_data.stock_movement_apply() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  UPDATE tenant_data.stock_pool
     SET on_hand = on_hand + NEW.delta
   WHERE tenant_id = NEW.tenant_id AND stock_pool_id = NEW.stock_pool_id;
  RETURN NULL;
END $$;

CREATE TRIGGER stock_movement_apply AFTER INSERT ON tenant_data.stock_movement
  FOR EACH ROW EXECUTE FUNCTION tenant_data.stock_movement_apply();

SELECT security.register_table('tenant_data.stock_movement', 'TENANT', 'append_only');

-- ---------------------------------------------------------------------------
-- stock_allocation — буфер канала над общим пулом [Р-6]; переопределение на единице QUANTITY
-- ---------------------------------------------------------------------------
CREATE TABLE tenant_data.stock_allocation (
  tenant_id                uuid NOT NULL,
  stock_allocation_id      uuid NOT NULL DEFAULT gen_random_uuid(),
  scope_type               text NOT NULL CHECK (scope_type IN ('CHANNEL_ACCOUNT', 'WRITE_SCOPE')),
  channel_account_id       uuid,
  write_scope_id           uuid,
  write_scope_field        text NOT NULL DEFAULT 'QUANTITY' CHECK (write_scope_field = 'QUANTITY'),
  buffer_units             int NOT NULL DEFAULT 0 CHECK (buffer_units >= 0),
  max_quantity             int CHECK (max_quantity > 0),
  min_quantity_to_list     int NOT NULL DEFAULT 0 CHECK (min_quantity_to_list >= 0),
  is_active                boolean NOT NULL DEFAULT true,
  version                  int NOT NULL CHECK (version >= 1),
  created_by_membership_id uuid NOT NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, stock_allocation_id),
  FOREIGN KEY (tenant_id, channel_account_id) REFERENCES tenant_data.channel_account (tenant_id, channel_account_id),
  FOREIGN KEY (tenant_id, write_scope_id, write_scope_field) REFERENCES tenant_data.write_scope (tenant_id, write_scope_id, field),
  FOREIGN KEY (tenant_id, created_by_membership_id) REFERENCES tenant_data.membership (tenant_id, membership_id),
  CHECK ((scope_type = 'CHANNEL_ACCOUNT') = (channel_account_id IS NOT NULL)),
  CHECK ((scope_type = 'WRITE_SCOPE') = (write_scope_id IS NOT NULL)),
  CHECK (max_quantity IS NULL OR max_quantity >= min_quantity_to_list)
);

-- Пересчёт публикуемого количества: последняя версия буфера аккаунта и переопределения единицы
CREATE UNIQUE INDEX stock_allocation_version_uq
  ON tenant_data.stock_allocation (tenant_id, scope_type, channel_account_id, write_scope_id, version) NULLS NOT DISTINCT;

CREATE TRIGGER a_stock_allocation_version BEFORE INSERT ON tenant_data.stock_allocation
  FOR EACH ROW EXECUTE FUNCTION security.enforce_next_version('scope_type', 'channel_account_id', 'write_scope_id');

SELECT security.register_table('tenant_data.stock_allocation', 'TENANT', 'append_only');

-- Р-6: синхронизация остатка включается только при действующем буфере канала.
CREATE FUNCTION tenant_data.assert_quantity_scope_has_allocation(p_tenant_id uuid, p_write_scope_id uuid) RETURNS void
  LANGUAGE plpgsql AS $$
DECLARE
  s record;
BEGIN
  SELECT quantity_sync_enabled, status, channel_account_id INTO s
    FROM tenant_data.write_scope
   WHERE tenant_id = p_tenant_id AND write_scope_id = p_write_scope_id AND field = 'QUANTITY';

  IF s.quantity_sync_enabled AND s.status <> 'RETIRED' THEN
    PERFORM 1 FROM tenant_data.channel_account
     WHERE tenant_id = p_tenant_id AND channel_account_id = s.channel_account_id FOR UPDATE;
    IF NOT coalesce((SELECT a.is_active FROM tenant_data.stock_allocation a
                      WHERE a.tenant_id = p_tenant_id AND a.scope_type = 'CHANNEL_ACCOUNT'
                        AND a.channel_account_id = s.channel_account_id
                      ORDER BY a.version DESC LIMIT 1), false) THEN
      RAISE EXCEPTION 'write_scope % has quantity sync enabled but channel account has no active buffer', p_write_scope_id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
END $$;

CREATE FUNCTION tenant_data.write_scope_allocation_check() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.field = 'QUANTITY' THEN
    PERFORM tenant_data.assert_quantity_scope_has_allocation(NEW.tenant_id, NEW.write_scope_id);
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER write_scope_requires_allocation
  AFTER INSERT OR UPDATE OF quantity_sync_enabled, status ON tenant_data.write_scope
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION tenant_data.write_scope_allocation_check();

CREATE FUNCTION tenant_data.stock_allocation_change_check() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  sid uuid;
BEGIN
  IF NEW.scope_type = 'CHANNEL_ACCOUNT' THEN
    FOR sid IN
      SELECT write_scope_id FROM tenant_data.write_scope
       WHERE tenant_id = NEW.tenant_id AND channel_account_id = NEW.channel_account_id
         AND field = 'QUANTITY' AND quantity_sync_enabled AND status <> 'RETIRED'
    LOOP
      PERFORM tenant_data.assert_quantity_scope_has_allocation(NEW.tenant_id, sid);
    END LOOP;
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER stock_allocation_keeps_enabled_scopes_valid AFTER INSERT ON tenant_data.stock_allocation
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION tenant_data.stock_allocation_change_check();

RESET ROLE;
COMMIT;
