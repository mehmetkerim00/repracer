-- Суперпользователем после миграций и packages/pricing-store-pg/test/setup.sql: тестовые роли входа и строки возможностей каналов
-- (синтетические). Повторный запуск ничего не меняет (Р-84: CI гоняет его на чистой базе).
\set ON_ERROR_STOP 1
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'svc_app') THEN CREATE ROLE svc_app LOGIN IN ROLE repracer_app; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'svc_scheduler') THEN CREATE ROLE svc_scheduler LOGIN IN ROLE repracer_retention; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'svc_exporter') THEN CREATE ROLE svc_exporter LOGIN IN ROLE repracer_exporter; END IF;
END $$;

SET ROLE repracer_owner;
INSERT INTO platform.channel_capability
  (capability_id, version, status, valid_from, channel, region, api_mode, field, write_scope_kind,
   write_scope_key_template, budget_scope_attribute, object_edit_limit, processing_mode,
   requires_side_effects_ack, observation_data_class)
VALUES
  ('c0000000-0000-0000-0000-000000000001', 1, 'ACTIVE', now(), 'KAUFLAND', NULL, 'KAUFLAND_SELLER_API_V2', 'PRICE',
   'ACCOUNT_STOREFRONT_UNIT', ARRAY['channel_account','marketplace','external_unit_id'], NULL, NULL, 'SYNC', false, 'CHANNEL_INFO'),
  ('c0000000-0000-0000-0000-000000000002', 1, 'ACTIVE', now(), 'KAUFLAND', NULL, 'KAUFLAND_SELLER_API_V2', 'QUANTITY',
   'ACCOUNT_OFFER', ARRAY['channel_account','external_offer_id'], NULL, NULL, 'SYNC', true, 'CHANNEL_INFO'),
  ('c0000000-0000-0000-0000-000000000003', 1, 'ACTIVE', now(), 'AMAZON', 'EU', 'AMAZON_LISTINGS_ITEMS', 'QUANTITY',
   'ACCOUNT_REGION_SKU', ARRAY['channel_account','region','external_sku'], NULL, NULL, 'ASYNC', true, 'AMAZON_INFO'),
  ('c0000000-0000-0000-0000-000000000004', 1, 'ACTIVE', now(), 'EBAY', NULL, 'EBAY_INVENTORY_API', 'QUANTITY',
   'ACCOUNT_INVENTORY_SKU', ARRAY['channel_account','external_sku'], 'external_listing_id',
   '{"limit": 250, "quantity_reserve": 50, "unaccounted_margin": 10}', 'SYNC', false, 'CHANNEL_INFO'),
  ('c0000000-0000-0000-0000-000000000005', 1, 'ACTIVE', now(), 'AMAZON', 'NA', 'AMAZON_LISTINGS_ITEMS', 'PRICE',
   'ACCOUNT_REGION_MARKETPLACE_SKU', ARRAY['channel_account','region','marketplace','external_sku'], NULL, NULL, 'ASYNC', false, 'AMAZON_INFO')
ON CONFLICT DO NOTHING;
RESET ROLE;

-- Р-65: одноразовый стенд считает границу суток EBAY_DE подтверждённой, чтобы проверить бюджет правок (Р-19).
-- В справочнике миграций все витрины TO_VERIFY; отказ по неподтверждённой витрине — smoke_r65.sql.
SET ROLE repracer_owner;
UPDATE platform.marketplace SET time_zone_status = 'CONFIRMED' WHERE channel = 'EBAY' AND marketplace = 'EBAY_DE';
RESET ROLE;
