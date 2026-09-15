-- 0004_catalog.sql
-- Мастер-товары и комплекты.

BEGIN;
SET ROLE repracer_owner;

CREATE TABLE tenant_data.product (
  tenant_id    uuid NOT NULL REFERENCES tenant_data.tenant (tenant_id),
  product_id   uuid NOT NULL DEFAULT gen_random_uuid(),
  sku          text NOT NULL CHECK (length(sku) BETWEEN 1 AND 200),
  kind         text NOT NULL CHECK (kind IN ('SIMPLE', 'BUNDLE')),
  title        text,
  gtin         text CHECK (gtin ~ '^[0-9]{8,14}$'),
  mpn          text,
  brand        text,
  tax_category text NOT NULL DEFAULT 'STANDARD',
  status       text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, product_id),
  -- Внутренний SKU уникален в тенанте; поиск товара по SKU (импорт, Inbound API)
  UNIQUE (tenant_id, sku),
  -- Цель составных FK, требующих конкретный вид товара (компонент — SIMPLE, пул — SIMPLE)
  UNIQUE (tenant_id, product_id, kind)
);

-- Сопоставление офферов, найденных в канале, с товарами по EAN/GTIN
CREATE INDEX product_gtin_idx ON tenant_data.product (tenant_id, gtin) WHERE gtin IS NOT NULL;

-- Вид товара неизменяем: от него зависят комплекты и пулы остатка
CREATE TRIGGER product_restrict_update BEFORE UPDATE ON tenant_data.product
  FOR EACH ROW EXECUTE FUNCTION security.restrict_update(
    'sku', 'title', 'gtin', 'mpn', 'brand', 'tax_category', 'status', 'updated_at');

SELECT security.register_table('tenant_data.product', 'TENANT', 'mutable');

-- ---------------------------------------------------------------------------
-- bundle_component: комплект (BUNDLE) из простых товаров (SIMPLE), без вложенности.
-- Виды обеспечиваются составными FK с константными столбцами вида.
-- ---------------------------------------------------------------------------
CREATE TABLE tenant_data.bundle_component (
  tenant_id            uuid NOT NULL,
  bundle_product_id    uuid NOT NULL,
  bundle_kind          text NOT NULL DEFAULT 'BUNDLE' CHECK (bundle_kind = 'BUNDLE'),
  component_product_id uuid NOT NULL,
  component_kind       text NOT NULL DEFAULT 'SIMPLE' CHECK (component_kind = 'SIMPLE'),
  quantity             int  NOT NULL CHECK (quantity >= 1),
  created_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, bundle_product_id, component_product_id),
  FOREIGN KEY (tenant_id, bundle_product_id, bundle_kind)
    REFERENCES tenant_data.product (tenant_id, product_id, kind),
  FOREIGN KEY (tenant_id, component_product_id, component_kind)
    REFERENCES tenant_data.product (tenant_id, product_id, kind)
);

-- Пересчёт остатка: все комплекты, содержащие изменившийся компонент
CREATE INDEX bundle_component_component_idx ON tenant_data.bundle_component (tenant_id, component_product_id);

CREATE TRIGGER bundle_component_restrict_update BEFORE UPDATE ON tenant_data.bundle_component
  FOR EACH ROW EXECUTE FUNCTION security.restrict_update('quantity');

SELECT security.register_table('tenant_data.bundle_component', 'TENANT', 'mutable_delete');

-- У активного комплекта есть хотя бы один компонент (проверка при коммите).
CREATE FUNCTION tenant_data.assert_bundle_has_components() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  t uuid;
  p uuid;
BEGIN
  IF TG_TABLE_NAME = 'product' THEN
    t := NEW.tenant_id; p := NEW.product_id;
  ELSE
    t := OLD.tenant_id; p := OLD.bundle_product_id;
  END IF;

  IF EXISTS (SELECT 1 FROM tenant_data.product
              WHERE tenant_id = t AND product_id = p AND kind = 'BUNDLE' AND status = 'ACTIVE')
     AND NOT EXISTS (SELECT 1 FROM tenant_data.bundle_component
                      WHERE tenant_id = t AND bundle_product_id = p) THEN
    RAISE EXCEPTION 'active bundle % must have at least one component', p
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER product_bundle_has_components AFTER INSERT OR UPDATE OF status ON tenant_data.product
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION tenant_data.assert_bundle_has_components();
CREATE CONSTRAINT TRIGGER bundle_component_not_last AFTER DELETE ON tenant_data.bundle_component
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION tenant_data.assert_bundle_has_components();

RESET ROLE;
COMMIT;
