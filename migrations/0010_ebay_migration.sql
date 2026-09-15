-- 0010_ebay_migration.sql
-- Предполётные проверки листингов eBay и согласия на необратимую миграцию [Р-2] (docs/onboarding-ebay-migration.md).
-- Проверки — данные канала (18 мес); согласия — данные тенанта (бессрочно, доказательство).

BEGIN;
SET ROLE repracer_owner;

-- ---------------------------------------------------------------------------
-- listing_migration_check (CHANNEL, append-only)
-- ---------------------------------------------------------------------------
CREATE TABLE channel_data.listing_migration_check (
  tenant_id                  uuid NOT NULL,
  listing_migration_check_id uuid NOT NULL DEFAULT gen_random_uuid(),
  channel_account_id         uuid NOT NULL,
  channel                    text NOT NULL DEFAULT 'EBAY' CHECK (channel = 'EBAY'),
  listing_id                 text NOT NULL,
  checked_at                 timestamptz NOT NULL DEFAULT now(),
  sync_job_id                uuid,
  listing_snapshot_sha256    bytea NOT NULL CHECK (length(listing_snapshot_sha256) = 32),
  findings                   jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(findings) = 'array'),
  verdict                    text NOT NULL CHECK (verdict IN ('ALREADY_MANAGED', 'READY', 'READY_WITH_LOSSES',
                                                              'FIXABLE', 'INELIGIBLE', 'UNKNOWN')),
  ruleset_version            text NOT NULL,
  PRIMARY KEY (tenant_id, listing_migration_check_id),
  FOREIGN KEY (tenant_id, channel_account_id, channel)
    REFERENCES tenant_data.channel_account (tenant_id, channel_account_id, channel)
);

-- Последняя проверка листинга (экран онбординга, допуск к миграции)
CREATE INDEX listing_migration_check_latest_idx
  ON channel_data.listing_migration_check (tenant_id, channel_account_id, listing_id, checked_at DESC);
-- Удаление по сроку
CREATE INDEX listing_migration_check_retention_idx ON channel_data.listing_migration_check (checked_at);

SELECT security.register_table('channel_data.listing_migration_check', 'CHANNEL', 'append_only');

-- ---------------------------------------------------------------------------
-- migration_consent (TENANT, append-only)
-- ---------------------------------------------------------------------------
ALTER TABLE tenant_data.membership ADD CONSTRAINT membership_user_uq UNIQUE (tenant_id, membership_id, user_id);

CREATE TABLE tenant_data.migration_consent (
  tenant_id               uuid NOT NULL,
  migration_consent_id    uuid NOT NULL DEFAULT gen_random_uuid(),
  channel_account_id      uuid NOT NULL,
  channel                 text NOT NULL DEFAULT 'EBAY' CHECK (channel = 'EBAY'),
  membership_id           uuid NOT NULL,
  user_id                 uuid NOT NULL,
  mfa_verified_at         timestamptz NOT NULL,
  disclosure_version      text NOT NULL,
  disclosure_text_sha256  bytea NOT NULL CHECK (length(disclosure_text_sha256) = 32),
  other_tools_declaration text NOT NULL CHECK (other_tools_declaration IN ('NONE', 'DECLARED')),
  other_tools_list        text,
  typed_confirmation      text NOT NULL CHECK (length(typed_confirmation) > 0),
  given_at                timestamptz NOT NULL DEFAULT now(),
  expires_at              timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, migration_consent_id),
  FOREIGN KEY (tenant_id, channel_account_id, channel)
    REFERENCES tenant_data.channel_account (tenant_id, channel_account_id, channel),
  FOREIGN KEY (tenant_id, membership_id, user_id) REFERENCES tenant_data.membership (tenant_id, membership_id, user_id),
  CHECK ((other_tools_declaration = 'DECLARED') = (other_tools_list IS NOT NULL)),
  CHECK (mfa_verified_at <= given_at),
  CHECK (expires_at > given_at)
);

-- Согласие даёт только активный OWNER с включённой MFA.
CREATE FUNCTION tenant_data.migration_consent_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM tenant_data.membership
                  WHERE tenant_id = NEW.tenant_id AND membership_id = NEW.membership_id
                    AND role = 'OWNER' AND status = 'ACTIVE') THEN
    RAISE EXCEPTION 'migration consent requires an ACTIVE OWNER' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM platform.app_user WHERE user_id = NEW.user_id AND mfa_enabled AND status = 'ACTIVE') THEN
    RAISE EXCEPTION 'migration consent requires MFA' USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.given_at := now();
  RETURN NEW;
END $$;

CREATE TRIGGER migration_consent_guard BEFORE INSERT ON tenant_data.migration_consent
  FOR EACH ROW EXECUTE FUNCTION tenant_data.migration_consent_guard();

SELECT security.register_table('tenant_data.migration_consent', 'TENANT', 'append_only');

CREATE TABLE tenant_data.migration_consent_item (
  tenant_id                  uuid NOT NULL,
  migration_consent_id       uuid NOT NULL,
  listing_id                 text NOT NULL,
  -- Ссылка на проверку без FK: проверки удаляются через 18 месяцев, согласие хранится бессрочно
  listing_migration_check_id uuid NOT NULL,
  listing_snapshot_sha256    bytea NOT NULL CHECK (length(listing_snapshot_sha256) = 32),
  verdict_at_consent         text NOT NULL CHECK (verdict_at_consent IN ('READY', 'READY_WITH_LOSSES')),
  acknowledged_losses        text[] NOT NULL DEFAULT '{}',
  PRIMARY KEY (tenant_id, migration_consent_id, listing_id),
  FOREIGN KEY (tenant_id, migration_consent_id) REFERENCES tenant_data.migration_consent (tenant_id, migration_consent_id),
  CHECK ((verdict_at_consent = 'READY_WITH_LOSSES') = (cardinality(acknowledged_losses) > 0))
);

-- Допуск листинга к миграции: действующие согласия по листингу
CREATE INDEX migration_consent_item_listing_idx ON tenant_data.migration_consent_item (tenant_id, listing_id);

SELECT security.register_table('tenant_data.migration_consent_item', 'TENANT', 'append_only');

CREATE TABLE tenant_data.migration_consent_revocation (
  tenant_id               uuid NOT NULL,
  migration_consent_id    uuid NOT NULL,
  revoked_by_membership_id uuid NOT NULL,
  revoked_at              timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, migration_consent_id),
  FOREIGN KEY (tenant_id, migration_consent_id) REFERENCES tenant_data.migration_consent (tenant_id, migration_consent_id),
  FOREIGN KEY (tenant_id, revoked_by_membership_id) REFERENCES tenant_data.membership (tenant_id, membership_id)
);

SELECT security.register_table('tenant_data.migration_consent_revocation', 'TENANT', 'append_only');

-- ---------------------------------------------------------------------------
-- INV-12: статус миграции оффера. MIGRATED необратим; начало миграции — только по действующему согласию,
-- выданному на проверку, повторённую после согласия и давшую тот же снимок листинга.
-- Приложение обязано перевести оффер в MIGRATION_STARTED до вызова bulkMigrateListing.
-- ---------------------------------------------------------------------------
CREATE FUNCTION tenant_data.offer_mapping_migration_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.ebay_migration_status IS NOT DISTINCT FROM OLD.ebay_migration_status THEN
    RETURN NEW;
  END IF;

  IF (OLD.ebay_migration_status, NEW.ebay_migration_status) NOT IN (VALUES
       ('REQUIRED', 'MIGRATION_STARTED'), ('REQUIRED', 'INELIGIBLE'), ('INELIGIBLE', 'REQUIRED'),
       ('MIGRATION_STARTED', 'MIGRATED'), ('MIGRATION_STARTED', 'FAILED'), ('MIGRATION_STARTED', 'OUTCOME_UNKNOWN'),
       ('OUTCOME_UNKNOWN', 'MIGRATED'), ('OUTCOME_UNKNOWN', 'FAILED'),
       ('FAILED', 'MIGRATION_STARTED'), ('FAILED', 'INELIGIBLE')) THEN
    RAISE EXCEPTION 'ebay_migration_status transition % -> % is not allowed', OLD.ebay_migration_status, NEW.ebay_migration_status
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF NEW.ebay_migration_status = 'MIGRATION_STARTED' AND NOT EXISTS (
       SELECT 1
         FROM tenant_data.migration_consent_item i
         JOIN tenant_data.migration_consent c
           ON c.tenant_id = i.tenant_id AND c.migration_consent_id = i.migration_consent_id
        WHERE i.tenant_id = NEW.tenant_id AND i.listing_id = NEW.external_listing_id
          AND c.channel_account_id = NEW.channel_account_id
          AND c.expires_at > now()
          AND NOT EXISTS (SELECT 1 FROM tenant_data.migration_consent_revocation r
                           WHERE r.tenant_id = c.tenant_id AND r.migration_consent_id = c.migration_consent_id)
          AND EXISTS (SELECT 1 FROM (
                        SELECT lc.listing_snapshot_sha256, lc.verdict, lc.checked_at
                          FROM channel_data.listing_migration_check lc
                         WHERE lc.tenant_id = NEW.tenant_id AND lc.channel_account_id = NEW.channel_account_id
                           AND lc.listing_id = NEW.external_listing_id
                         ORDER BY lc.checked_at DESC LIMIT 1) latest
                       WHERE latest.checked_at >= c.given_at
                         AND latest.listing_snapshot_sha256 = i.listing_snapshot_sha256
                         AND latest.verdict IN ('READY', 'READY_WITH_LOSSES'))) THEN
    RAISE EXCEPTION 'listing % has no valid migration consent matching a fresh preflight check', NEW.external_listing_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER offer_mapping_migration_guard BEFORE UPDATE OF ebay_migration_status ON tenant_data.offer_mapping
  FOR EACH ROW EXECUTE FUNCTION tenant_data.offer_mapping_migration_guard();

RESET ROLE;
COMMIT;
