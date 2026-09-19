-- Настройка одноразовой базы для сценариев стенда и замера на PostgreSQL (выполнять суперпользователем после миграций).
-- Только синтетические данные: тестовые роли входа и строки возможностей канала Kaufland.
\set ON_ERROR_STOP 1
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'svc_app') THEN
    CREATE ROLE svc_app LOGIN IN ROLE repracer_app;
  END IF;
  -- Диспетчер записей [Р-64]: транзакции тенанта — как приложение; обход ждущих записей всех тенантов — только идентификаторы
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'svc_dispatcher') THEN
    CREATE ROLE svc_dispatcher LOGIN IN ROLE repracer_app, repracer_dispatcher;
  END IF;
  -- Загрузчик курсов ЕЦБ [Р-61]: только вставка в platform.fx_rate
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'svc_fx_loader') THEN
    CREATE ROLE svc_fx_loader LOGIN IN ROLE repracer_fx_loader;
  END IF;
  -- Ретранслятор outbox → брокер [Р-34]
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'svc_relay') THEN
    CREATE ROLE svc_relay LOGIN IN ROLE repracer_relay;
  END IF;
  -- Задание хранения и закрытия дней (проверка границы суток [Р-62])
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'svc_scheduler') THEN
    CREATE ROLE svc_scheduler LOGIN IN ROLE repracer_retention;
  END IF;
  -- Онбординг платформы [Р-88]: регистрация владельца нового тенанта — приглашением
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'svc_onboarding') THEN
    CREATE ROLE svc_onboarding LOGIN IN ROLE repracer_onboarding;
  END IF;
  -- Р-90: административный сервис (консоль) — права приложения + остановки человеком, роли и отзыв участников, приглашения
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'svc_admin') THEN
    CREATE ROLE svc_admin LOGIN IN ROLE repracer_admin;
  END IF;
  -- Р-90: создание тенанта с владельцем и участниками (онбординг, посев стенда) — только security.provision_tenant
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'svc_provisioning') THEN
    CREATE ROLE svc_provisioning LOGIN IN ROLE repracer_provisioning;
  END IF;
  -- Р-102: синхронизация остатка — только остатки и резервации, без цен и без аудита
  -- Шаг 23: приёмник уведомлений Amazon — маршрут продавца (repracer_inbound) и запись в транзакции тенанта (repracer_app)
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'svc_inbound') THEN
    CREATE ROLE svc_inbound LOGIN IN ROLE repracer_app, repracer_inbound;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'svc_stock') THEN
    CREATE ROLE svc_stock LOGIN IN ROLE repracer_stock;
  END IF;
  -- Р-139 (шаг 30): фоновый исполнитель массовых операций — аренда, ход и итог задания; САМУ работу он делает ролью
  -- административного сервиса от имени человека, создавшего задание
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'svc_bulk_worker') THEN
    CREATE ROLE svc_bulk_worker LOGIN IN ROLE repracer_bulk_worker;
  END IF;
  -- Р-90: вход — сопоставление внешнего пользователя с членствами и приём приглашения
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'svc_authenticator') THEN
    CREATE ROLE svc_authenticator LOGIN IN ROLE repracer_authenticator;
  END IF;
  -- Экспортёр дневных секций в ClickHouse [Р-20]
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'svc_exporter') THEN
    CREATE ROLE svc_exporter LOGIN IN ROLE repracer_exporter;
  END IF;
  -- Шаг 25 [OQ-181]: разбор пропущенных выгрузкой снимков оператором
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'svc_export_triage') THEN
    CREATE ROLE svc_export_triage LOGIN IN ROLE repracer_export_triage;
  END IF;
END $$;

SET ROLE repracer_owner;
INSERT INTO platform.channel_capability
  (capability_id, version, status, valid_from, channel, region, api_mode, field, write_scope_kind,
   write_scope_key_template, budget_scope_attribute, object_edit_limit, processing_mode,
   requires_side_effects_ack, observation_data_class)
VALUES
  ('c0000000-0000-0000-0000-000000000001', 1, 'ACTIVE', now(), 'KAUFLAND', NULL, 'KAUFLAND_SELLER_API_V2', 'PRICE',
   'ACCOUNT_STOREFRONT_UNIT', ARRAY['channel_account','marketplace','external_unit_id'], NULL, NULL, 'SYNC', false, 'CHANNEL_INFO'),
  -- Синтетическая строка для сценариев в USD [Р-57]: шаблон и режим обработки Amazon — (проверить) при адаптере Amazon
  ('c0000000-0000-0000-0000-000000000005', 1, 'ACTIVE', now(), 'AMAZON', 'NA', 'AMAZON_LISTINGS_ITEMS', 'PRICE',
   'ACCOUNT_REGION_MARKETPLACE_SKU', ARRAY['channel_account','region','marketplace','external_sku'], NULL, NULL, 'ASYNC', false, 'AMAZON_INFO')
ON CONFLICT DO NOTHING;
RESET ROLE;

-- Смоук-мир (tests/db) и сценарии стенда живут в фиксированной дате: секции суточных таблиц под неё создаются явно,
-- иначе прогон зависит от текущей даты (секции price_intent — суточные, ensure_partitions(now()) покрывает только вчера…+3)
SELECT maintenance.ensure_partitions('2026-09-15 12:00+00'::timestamptz);
SELECT maintenance.ensure_partitions(now());
