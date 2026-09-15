-- 0003_channels.sql
-- Справочник возможностей каналов (данные, не код), аккаунты каналов, переопределения лимитов.

BEGIN;
SET ROLE repracer_owner;

-- ---------------------------------------------------------------------------
-- channel_capability — глобальный версионированный справочник (docs/channel-capabilities.md).
-- Неизвестные значения — NULL, статус проверки — в verification.
-- ---------------------------------------------------------------------------
CREATE TABLE platform.channel_capability (
  tenant_id                   uuid NOT NULL DEFAULT security.platform_tenant_id()
                              CHECK (tenant_id = security.platform_tenant_id())
                              REFERENCES tenant_data.tenant (tenant_id),
  capability_id               uuid NOT NULL,
  version                     int  NOT NULL CHECK (version >= 1),
  status                      text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'ACTIVE', 'DEPRECATED')),
  valid_from                  timestamptz,
  channel                     text NOT NULL CHECK (channel IN ('AMAZON', 'EBAY', 'KAUFLAND', 'OTTO')),
  region                      text,
  marketplace_pattern         text NOT NULL DEFAULT '*',
  api_mode                    text NOT NULL,
  field                       text NOT NULL CHECK (field IN ('PRICE', 'QUANTITY', 'CHANNEL_MIN_PRICE')),
  write_operation             text,
  write_scope_kind            text NOT NULL,
  write_scope_key_template    text[] NOT NULL
                              CHECK (cardinality(write_scope_key_template) >= 1
                                     AND write_scope_key_template <@ ARRAY['channel_account', 'region', 'marketplace',
                                         'external_sku', 'external_offer_id', 'external_listing_id', 'external_unit_id']),
  budget_scope_attribute      text CHECK (budget_scope_attribute IN ('external_listing_id', 'external_unit_id', 'external_sku')),
  write_semantics             text NOT NULL DEFAULT 'LAST_WRITE_WINS',
  conditional_write_supported boolean,
  batch_max_items             int CHECK (batch_max_items > 0),
  rate_limit                  jsonb,
  object_edit_limit           jsonb,
  processing_mode             text CHECK (processing_mode IN ('SYNC', 'ASYNC')),
  confirmation_methods        jsonb,
  apply_grace_period          interval CHECK (apply_grace_period > interval '0'),
  reversible                  text CHECK (reversible IN ('YES', 'NO', 'CONDITIONAL')),
  reversible_condition        text,
  webhooks                    text CHECK (webhooks IN ('YES', 'NO', 'UNKNOWN')),
  channel_decrements_on_order boolean,
  side_effects                text,
  requires_side_effects_ack   boolean NOT NULL DEFAULT false,
  preconditions               text,
  target_latency_p95          interval,
  observation_data_class      text NOT NULL CHECK (observation_data_class IN ('AMAZON_INFO', 'CHANNEL_INFO')),
  verification                jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (capability_id, version),
  -- Цель составного FK из write_scope: канал и поле единицы записи совпадают с правилом
  UNIQUE (capability_id, version, channel, field),
  -- ADR-0002 п.7: цена всегда различает маркетплейс/витрину (Omnibus по каналу)
  CHECK (field <> 'PRICE' OR 'marketplace' = ANY (write_scope_key_template)),
  -- Р-12: поле minimum_price существует только у Kaufland
  CHECK (field <> 'CHANNEL_MIN_PRICE' OR channel = 'KAUFLAND'),
  -- Р-14: Kaufland — аккаунт + витрина + unit для обоих полей
  CHECK (channel <> 'KAUFLAND'
         OR write_scope_key_template = ARRAY['channel_account', 'marketplace', 'external_unit_id']),
  CHECK ((channel = 'AMAZON') = (region IS NOT NULL)),
  CHECK (channel <> 'AMAZON' OR observation_data_class = 'AMAZON_INFO'),
  CHECK (object_edit_limit IS NULL
         OR (jsonb_typeof(object_edit_limit -> 'limit') = 'number' AND budget_scope_attribute IS NOT NULL)),
  CHECK (status = 'DRAFT' OR valid_from IS NOT NULL)
);

-- Ровно одна ACTIVE версия правила; выбор правила при выводе единицы записи
CREATE UNIQUE INDEX channel_capability_active_uq
  ON platform.channel_capability (channel, coalesce(region, ''), marketplace_pattern, api_mode, field)
  WHERE status = 'ACTIVE';

-- Версия неизменяема; меняется только статус по пути DRAFT -> ACTIVE -> DEPRECATED.
CREATE FUNCTION platform.channel_capability_status_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NOT ((OLD.status = 'DRAFT' AND NEW.status IN ('DRAFT', 'ACTIVE'))
          OR (OLD.status = 'ACTIVE' AND NEW.status IN ('ACTIVE', 'DEPRECATED'))
          OR (OLD.status = 'DEPRECATED' AND NEW.status = 'DEPRECATED')) THEN
    RAISE EXCEPTION 'capability status transition % -> % is not allowed', OLD.status, NEW.status
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER channel_capability_restrict_update BEFORE UPDATE ON platform.channel_capability
  FOR EACH ROW EXECUTE FUNCTION security.restrict_update('status', 'valid_from');
CREATE TRIGGER channel_capability_status_guard BEFORE UPDATE OF status ON platform.channel_capability
  FOR EACH ROW EXECUTE FUNCTION platform.channel_capability_status_guard();

SELECT security.register_table('platform.channel_capability', 'PLATFORM', 'reference', 'none');
CREATE POLICY capability_read ON platform.channel_capability FOR SELECT TO repracer_app
  USING (tenant_id = security.platform_tenant_id());
-- Загрузка справочника — процедурой деплоя от имени владельца (OQ-55)
CREATE POLICY capability_owner_load ON platform.channel_capability TO repracer_owner
  USING (tenant_id = security.platform_tenant_id()) WITH CHECK (tenant_id = security.platform_tenant_id());

-- ---------------------------------------------------------------------------
-- channel_account
-- ---------------------------------------------------------------------------
CREATE TABLE tenant_data.channel_account (
  tenant_id                  uuid NOT NULL REFERENCES tenant_data.tenant (tenant_id),
  channel_account_id         uuid NOT NULL DEFAULT gen_random_uuid(),
  channel                    text NOT NULL CHECK (channel IN ('AMAZON', 'EBAY', 'KAUFLAND', 'OTTO')),
  region                     text,
  external_account_id        text NOT NULL CHECK (length(external_account_id) BETWEEN 1 AND 200),
  display_name               text,
  marketplaces               text[] NOT NULL DEFAULT '{}',
  known_other_marketplaces   text[] NOT NULL DEFAULT '{}',
  credentials_ref            text,
  auth_status                text NOT NULL DEFAULT 'ACTIVE'
                             CHECK (auth_status IN ('ACTIVE', 'REAUTH_REQUIRED', 'REVOKED', 'DISCONNECTED')),
  access_token_expires_at    timestamptz,
  authorization_expires_at   timestamptz,
  granted_scopes             text[] NOT NULL DEFAULT '{}',
  connected_by_membership_id uuid NOT NULL,
  connected_at               timestamptz NOT NULL DEFAULT now(),
  disconnected_at            timestamptz,
  PRIMARY KEY (tenant_id, channel_account_id),
  -- Цель составных FK, переносящих канал (write_scope, migration_consent)
  UNIQUE (tenant_id, channel_account_id, channel),
  FOREIGN KEY (tenant_id, connected_by_membership_id) REFERENCES tenant_data.membership (tenant_id, membership_id),
  CHECK ((channel = 'AMAZON') = (region IS NOT NULL)),
  CHECK ((auth_status = 'DISCONNECTED') = (disconnected_at IS NOT NULL)),
  CHECK (auth_status = 'DISCONNECTED' OR credentials_ref IS NOT NULL)
);

-- Один внешний аккаунт — максимум один неотключённый тенант на платформе.
-- Уникальный индекс проверяется вне RLS, то есть через всех тенантов; он же — поиск для резолва входящих событий.
CREATE UNIQUE INDEX channel_account_external_uq
  ON tenant_data.channel_account (channel, coalesce(region, ''), external_account_id)
  WHERE disconnected_at IS NULL;

CREATE TRIGGER channel_account_restrict_update BEFORE UPDATE ON tenant_data.channel_account
  FOR EACH ROW EXECUTE FUNCTION security.restrict_update(
    'display_name', 'marketplaces', 'known_other_marketplaces', 'credentials_ref', 'auth_status',
    'access_token_expires_at', 'authorization_expires_at', 'granted_scopes', 'disconnected_at');

SELECT security.register_table('tenant_data.channel_account', 'TENANT', 'mutable');

-- ---------------------------------------------------------------------------
-- channel_capability_override — лимиты по аккаунту (повышение — только с основанием)
-- ---------------------------------------------------------------------------
CREATE TABLE tenant_data.channel_capability_override (
  tenant_id                uuid NOT NULL,
  override_id              uuid NOT NULL DEFAULT gen_random_uuid(),
  channel_account_id       uuid NOT NULL,
  capability_id            uuid NOT NULL,
  capability_version       int  NOT NULL,
  direction                text NOT NULL CHECK (direction IN ('RAISE', 'LOWER')),
  rate_limit               jsonb,
  object_edit_limit        jsonb,
  batch_max_items          int CHECK (batch_max_items > 0),
  evidence                 text,
  valid_from               timestamptz NOT NULL DEFAULT now(),
  valid_to                 timestamptz,
  created_by_membership_id uuid NOT NULL,
  PRIMARY KEY (tenant_id, override_id),
  FOREIGN KEY (tenant_id, channel_account_id) REFERENCES tenant_data.channel_account (tenant_id, channel_account_id),
  FOREIGN KEY (capability_id, capability_version) REFERENCES platform.channel_capability (capability_id, version),
  FOREIGN KEY (tenant_id, created_by_membership_id) REFERENCES tenant_data.membership (tenant_id, membership_id),
  CHECK (num_nonnulls(rate_limit, object_edit_limit, batch_max_items) >= 1),
  CHECK (direction = 'LOWER' OR length(evidence) > 0),
  CHECK (valid_to IS NULL OR valid_to > valid_from)
);

-- Dispatcher: действующие лимиты аккаунта для правила
CREATE INDEX channel_capability_override_lookup_idx
  ON tenant_data.channel_capability_override (tenant_id, channel_account_id, capability_id, valid_from DESC);

CREATE TRIGGER channel_capability_override_restrict_update BEFORE UPDATE ON tenant_data.channel_capability_override
  FOR EACH ROW EXECUTE FUNCTION security.restrict_update('valid_to');

SELECT security.register_table('tenant_data.channel_capability_override', 'TENANT', 'mutable');

RESET ROLE;
COMMIT;
