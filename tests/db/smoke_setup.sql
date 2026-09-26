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
-- Шаг 40 [Р-165]: учётные записи операторов платформы — действующая и отозванная (её действия обязаны отказывать)
INSERT INTO platform.platform_operator (operator_id, issuer, subject, display_name, active) VALUES
  ('ef000000-0000-4000-8000-000000000001', 'https://accounts.example.test', 'operator-1', 'Synthetischer Betrieb', true),
  ('ef000000-0000-4000-8000-000000000002', 'https://accounts.example.test', 'operator-gone', 'Ehemaliger Betrieb', false);

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
   'ACCOUNT_REGION_MARKETPLACE_SKU', ARRAY['channel_account','region','marketplace','external_sku'], NULL, NULL, 'ASYNC', false, 'AMAZON_INFO'),
  ('c0000000-0000-0000-0000-000000000006', 1, 'ACTIVE', now(), 'AMAZON', 'EU', 'AMAZON_LISTINGS_ITEMS', 'PRICE',
   'ACCOUNT_REGION_MARKETPLACE_SKU', ARRAY['channel_account','region','marketplace','external_sku'], NULL, NULL, 'ASYNC', false, 'AMAZON_INFO')
ON CONFLICT DO NOTHING;
-- Р-111 (шаг 21): поле собственного пола цены канала (Amazon minimum_seller_allowed_price) не заводится как возможность Amazon
\ir smoke_helpers.sql
SELECT pg_temp.expect_fail('Amazon capability for the channel repricer floor (Р-111)', $q$
  INSERT INTO platform.channel_capability
    (capability_id, version, status, valid_from, channel, region, api_mode, field, write_scope_kind,
     write_scope_key_template, budget_scope_attribute, object_edit_limit, processing_mode, requires_side_effects_ack, observation_data_class)
  VALUES ('c0000000-0000-0000-0000-0000000000f1', 1, 'ACTIVE', now(), 'AMAZON', 'EU', 'AMAZON_LISTINGS_ITEMS', 'CHANNEL_MIN_PRICE',
     'ACCOUNT_REGION_MARKETPLACE_SKU', ARRAY['channel_account','region','marketplace','external_sku'], NULL, NULL, 'ASYNC', false, 'AMAZON_INFO') $q$,
  'channel_capability_channel_min_price_only_kaufland');
RESET ROLE;

-- Р-65: одноразовый стенд считает границу суток EBAY_DE подтверждённой, чтобы проверить бюджет правок (Р-19).
-- В справочнике миграций все витрины TO_VERIFY; отказ по неподтверждённой витрине — smoke_r65.sql.
SET ROLE repracer_owner;
UPDATE platform.marketplace SET time_zone_status = 'CONFIRMED' WHERE channel = 'EBAY' AND marketplace = 'EBAY_DE';
RESET ROLE;

-- Р-104 (шаг 19): уже входивший пользователь без тенанта — проверки роли и адреса при создании тенанта (smoke_provision.sql, находка 5
-- ревью шага 16) отказывают своей причиной, а не отказом «никогда не входил». Синтетические адрес и subject.
INSERT INTO platform.app_user (user_id, email) VALUES ('c1000000-0000-0000-0000-0000000000cc', 'signed-in@example.test') ON CONFLICT DO NOTHING;
INSERT INTO platform.external_identity (issuer, subject, user_id)
VALUES ('https://idp.smoke.repracer.test', 'signed-in-without-tenant', 'c1000000-0000-0000-0000-0000000000cc') ON CONFLICT DO NOTHING;
