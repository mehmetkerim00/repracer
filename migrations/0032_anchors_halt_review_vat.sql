-- 0032_anchors_halt_review_vat.sql
-- Р-49: якорь «тот же EAN на другом канале» — EAN в состоянии конкурентов; коды отказов проверки входов.
-- Р-50: продавец в окне движений (сдвиг одного продавца — рыночное событие).
-- Р-51: остановка канала блокирует только цены, выведенные из данных конкурентов (признак competitor_derived).
-- Р-52: окно остановки, автоматическая проверка свежей выборкой, журнал проверок и снятий.
-- Р-53: ставка НДС объявляется на товаре; по умолчанию DE 19 %, AT 20 %.

BEGIN;
SET ROLE repracer_owner;

-- ---------------------------------------------------------------------------
-- 1. НДС [Р-53]
-- ---------------------------------------------------------------------------
CREATE TABLE platform.vat_rate_default (
  tenant_id  uuid NOT NULL DEFAULT security.platform_tenant_id() CHECK (tenant_id = security.platform_tenant_id()),
  country    text NOT NULL CHECK (country ~ '^[A-Z]{2}$'),
  rate_bp    int  NOT NULL CHECK (rate_bp BETWEEN 0 AND 3000),
  valid_from date NOT NULL,
  source     text NOT NULL,
  PRIMARY KEY (tenant_id, country, valid_from)
);

SELECT security.register_table('platform.vat_rate_default', 'PLATFORM', 'reference', 'none');
CREATE POLICY vat_rate_default_read ON platform.vat_rate_default FOR SELECT TO repracer_app
  USING (tenant_id = security.platform_tenant_id());
CREATE POLICY vat_rate_default_owner_load ON platform.vat_rate_default TO repracer_owner
  USING (tenant_id = security.platform_tenant_id()) WITH CHECK (tenant_id = security.platform_tenant_id());

INSERT INTO platform.vat_rate_default (country, rate_bp, valid_from, source) VALUES
  ('DE', 1900, '2021-01-01', 'Р-53: стандартная ставка по умолчанию'),
  ('AT', 2000, '2016-01-01', 'Р-53: стандартная ставка по умолчанию');

CREATE TABLE tenant_data.product_vat_rate (
  tenant_id                uuid NOT NULL,
  product_vat_rate_id      uuid NOT NULL DEFAULT gen_random_uuid(),
  product_id               uuid NOT NULL,
  country                  text NOT NULL CHECK (country IN ('DE', 'AT')),
  rate_bp                  int  NOT NULL CHECK (rate_bp BETWEEN 0 AND 3000),
  version                  int  NOT NULL CHECK (version >= 1),
  created_by_membership_id uuid NOT NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, product_vat_rate_id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES tenant_data.product (tenant_id, product_id),
  FOREIGN KEY (tenant_id, created_by_membership_id) REFERENCES tenant_data.membership (tenant_id, membership_id)
);

-- Действующая ставка товара в стране — последняя версия
CREATE UNIQUE INDEX product_vat_rate_version_uq ON tenant_data.product_vat_rate (tenant_id, product_id, country, version);

CREATE TRIGGER a_product_vat_rate_version BEFORE INSERT ON tenant_data.product_vat_rate
  FOR EACH ROW EXECUTE FUNCTION security.enforce_next_version('product_id', 'country');

SELECT security.register_table('tenant_data.product_vat_rate', 'TENANT', 'append_only');
SELECT security.grant_retention('tenant_data.product_vat_rate');
INSERT INTO maintenance.retention_policy (table_name, method) VALUES ('tenant_data.product_vat_rate', 'TENANT_CLOSURE_ONLY');

-- Объявленная продавцом ставка, иначе ставка страны по умолчанию. Сопоставления категорий нет [Р-53].
CREATE FUNCTION tenant_data.effective_vat_rate_bp(p_tenant_id uuid, p_product_id uuid, p_country text) RETURNS int
  LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    (SELECT v.rate_bp FROM tenant_data.product_vat_rate v
      WHERE v.tenant_id = p_tenant_id AND v.product_id = p_product_id AND v.country = p_country
      ORDER BY v.version DESC LIMIT 1),
    (SELECT d.rate_bp FROM platform.vat_rate_default d
      WHERE d.country = p_country AND d.valid_from <= current_date
      ORDER BY d.valid_from DESC LIMIT 1))
$$;

-- ---------------------------------------------------------------------------
-- 2. Остановка канала: окно, автоматическая проверка, журнал [Р-52]
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  con text;
BEGIN
  FOR con IN SELECT conname FROM pg_constraint
              WHERE conrelid = 'channel_data.pricing_halt'::regclass AND contype = 'c'
                AND (pg_get_constraintdef(oid) LIKE '%released_by_membership_id IS NULL%'
                     OR pg_get_constraintdef(oid) LIKE '%release_note IS NULL%')
  LOOP
    EXECUTE format('ALTER TABLE channel_data.pricing_halt DROP CONSTRAINT %I', con);
  END LOOP;
END $$;

ALTER TABLE channel_data.pricing_halt
  ADD COLUMN review_window  interval NOT NULL DEFAULT interval '30 minutes'
    CHECK (review_window BETWEEN interval '1 minute' AND interval '24 hours'),
  ADD COLUMN next_review_at timestamptz,
  ADD COLUMN released_kind  text CHECK (released_kind IN ('AUTO', 'MANUAL'));
ALTER TABLE channel_data.pricing_halt
  ALTER COLUMN next_review_at SET NOT NULL,
  ADD CONSTRAINT pricing_halt_released_kind CHECK ((released_at IS NULL) = (released_kind IS NULL)),
  -- Ручное снятие — человек и заметка; автоматическое — без них, основание в журнале
  ADD CONSTRAINT pricing_halt_manual_release_by_member CHECK ((coalesce(released_kind, '') = 'MANUAL') = (released_by_membership_id IS NOT NULL)),
  ADD CONSTRAINT pricing_halt_manual_release_note CHECK ((coalesce(released_kind, '') = 'MANUAL') = (release_note IS NOT NULL));

-- Проверка остановок, у которых подошло окно
CREATE INDEX pricing_halt_due_review_idx ON channel_data.pricing_halt (tenant_id, next_review_at) WHERE released_at IS NULL;

CREATE FUNCTION channel_data.pricing_halt_schedule_review() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  NEW.next_review_at := coalesce(NEW.next_review_at, NEW.halted_at + NEW.review_window);
  RETURN NEW;
END $$;

CREATE TRIGGER aa_pricing_halt_schedule_review BEFORE INSERT ON channel_data.pricing_halt
  FOR EACH ROW EXECUTE FUNCTION channel_data.pricing_halt_schedule_review();

DROP TRIGGER a_pricing_halt_restrict_update ON channel_data.pricing_halt;
CREATE TRIGGER a_pricing_halt_restrict_update BEFORE UPDATE ON channel_data.pricing_halt
  FOR EACH ROW EXECUTE FUNCTION security.restrict_update(
    'released_at', 'released_by_membership_id', 'release_note', 'released_kind', 'next_review_at');

CREATE TABLE channel_data.pricing_halt_review (
  tenant_id              uuid NOT NULL,
  pricing_halt_review_id uuid NOT NULL DEFAULT gen_random_uuid(),
  pricing_halt_id        uuid NOT NULL,
  kind                   text NOT NULL CHECK (kind IN ('AUTO_SAMPLE', 'MANUAL_RELEASE')),
  outcome                text NOT NULL CHECK (outcome IN ('RELEASED', 'SAMPLE_FAILED')),
  sample_size            int  NOT NULL DEFAULT 0 CHECK (sample_size >= 0),
  failed_count           int  NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  details                jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  membership_id          uuid,
  note                   text CHECK (length(note) BETWEEN 10 AND 2000),
  reviewed_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, pricing_halt_review_id),
  FOREIGN KEY (tenant_id, pricing_halt_id) REFERENCES channel_data.pricing_halt (tenant_id, pricing_halt_id),
  FOREIGN KEY (tenant_id, membership_id) REFERENCES tenant_data.membership (tenant_id, membership_id),
  CHECK (failed_count <= sample_size),
  CHECK ((kind = 'MANUAL_RELEASE') = (membership_id IS NOT NULL)),
  CHECK ((kind = 'MANUAL_RELEASE') = (note IS NOT NULL)),
  CHECK (kind <> 'MANUAL_RELEASE' OR outcome = 'RELEASED'),
  CHECK (kind <> 'AUTO_SAMPLE' OR (sample_size >= 1 AND (outcome = 'RELEASED') = (failed_count = 0)))
);

-- История проверок остановки; проверка журнала при снятии
CREATE INDEX pricing_halt_review_halt_idx ON channel_data.pricing_halt_review (tenant_id, pricing_halt_id, reviewed_at DESC);
-- Удаление по сроку
CREATE INDEX pricing_halt_review_retention_idx ON channel_data.pricing_halt_review (reviewed_at);

SELECT security.register_table('channel_data.pricing_halt_review', 'CHANNEL', 'append_only');
SELECT security.grant_retention('channel_data.pricing_halt_review');
-- Удаляется раньше остановок (drop_order): ссылается на них
INSERT INTO maintenance.retention_policy (table_name, method, anchor_column, retention, safety_margin, drop_order)
VALUES ('channel_data.pricing_halt_review', 'DELETE_ROWS', 'reviewed_at', '18 months', '14 days', 55);

-- Снятие без записи в журнале невозможно
CREATE FUNCTION channel_data.pricing_halt_release_journal() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.released_at IS NULL AND NEW.released_at IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM channel_data.pricing_halt_review r
        WHERE r.tenant_id = NEW.tenant_id AND r.pricing_halt_id = NEW.pricing_halt_id AND r.outcome = 'RELEASED'
          AND r.kind = CASE NEW.released_kind WHEN 'AUTO' THEN 'AUTO_SAMPLE' ELSE 'MANUAL_RELEASE' END) THEN
    RAISE EXCEPTION 'pricing halt % released without a review record (Р-52)', NEW.pricing_halt_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER c_pricing_halt_release_journal BEFORE UPDATE ON channel_data.pricing_halt
  FOR EACH ROW EXECUTE FUNCTION channel_data.pricing_halt_release_journal();

-- ---------------------------------------------------------------------------
-- 3. Остановка блокирует только цены, выведенные из данных конкурентов [Р-51]
-- ---------------------------------------------------------------------------
ALTER TABLE channel_data.price_intent
  ADD COLUMN competitor_derived boolean GENERATED ALWAYS AS (coalesce(rule_code IN ('MATCH_BUYBOX', 'BEAT_LOWEST', 'POSITION'), false)) STORED;
ALTER TABLE channel_data.price_decision
  ADD COLUMN competitor_derived boolean NOT NULL DEFAULT false;

-- Признак решения — из его intent: решение живёт дольше intent, записи проверяют его по решению
CREATE FUNCTION channel_data.price_decision_copy_derivation() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  NEW.competitor_derived := coalesce((
    SELECT i.competitor_derived FROM channel_data.price_intent i
     WHERE i.tenant_id = NEW.tenant_id AND i.created_at = NEW.intent_created_at AND i.price_intent_id = NEW.price_intent_id), false);
  RETURN NEW;
END $$;

CREATE TRIGGER aa_price_decision_copy_derivation BEFORE INSERT ON channel_data.price_decision
  FOR EACH ROW EXECUTE FUNCTION channel_data.price_decision_copy_derivation();

CREATE OR REPLACE FUNCTION channel_data.price_decision_floor_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  floor_minor   bigint;
  ceiling_minor bigint;
  proposed      bigint;
BEGIN
  IF NEW.rejection_reason = 'BOUND_UNRESOLVABLE' THEN
    RETURN NEW;
  END IF;
  floor_minor := tenant_data.effective_min_price(NEW.tenant_id, NEW.write_scope_id);
  ceiling_minor := tenant_data.effective_max_price(NEW.tenant_id, NEW.write_scope_id);
  IF floor_minor IS NULL OR NEW.effective_floor_minor < floor_minor THEN
    RAISE EXCEPTION 'decision floor % is below effective min_price %', NEW.effective_floor_minor, floor_minor
      USING ERRCODE = 'check_violation';
  END IF;
  IF ceiling_minor IS NULL OR NEW.effective_ceiling_minor > ceiling_minor THEN
    RAISE EXCEPTION 'decision ceiling % is above effective max_price % (Р-43)', NEW.effective_ceiling_minor, ceiling_minor
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.rejection_reason IN ('BELOW_MIN_PRICE', 'BELOW_MARGIN_FLOOR', 'ABOVE_MAX_PRICE') THEN
    SELECT proposed_amount_minor INTO proposed FROM channel_data.price_intent
     WHERE tenant_id = NEW.tenant_id AND created_at = NEW.intent_created_at AND price_intent_id = NEW.price_intent_id;
    IF (NEW.rejection_reason = 'BELOW_MIN_PRICE' AND proposed >= floor_minor)
       OR (NEW.rejection_reason = 'BELOW_MARGIN_FLOOR' AND proposed >= NEW.effective_floor_minor)
       OR (NEW.rejection_reason = 'ABOVE_MAX_PRICE' AND proposed <= NEW.effective_ceiling_minor) THEN
      RAISE EXCEPTION 'rejection reason % contradicts proposed price %', NEW.rejection_reason, proposed
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW.outcome = 'APPROVED' AND NEW.competitor_derived AND channel_data.pricing_halted(NEW.tenant_id, NEW.write_scope_id) THEN
    RAISE EXCEPTION 'competitor-derived pricing is halted for the channel of write_scope % (Р-51)', NEW.write_scope_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION tenant_data.channel_write_ceiling_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  ceiling_minor bigint;
BEGIN
  IF NEW.field <> 'PRICE' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NOT (NEW.status = 'DISPATCHED' AND OLD.status IS DISTINCT FROM 'DISPATCHED') THEN
    RETURN NEW;
  END IF;
  ceiling_minor := tenant_data.effective_max_price(NEW.tenant_id, NEW.write_scope_id);
  IF ceiling_minor IS NULL OR NEW.amount_minor > ceiling_minor THEN
    RAISE EXCEPTION 'value % is above effective max_price % (%)', NEW.amount_minor, ceiling_minor,
      CASE TG_OP WHEN 'INSERT' THEN 'at creation' ELSE 'at dispatch' END USING ERRCODE = 'check_violation';
  END IF;
  IF channel_data.pricing_halted(NEW.tenant_id, NEW.write_scope_id) AND EXISTS (
       SELECT 1 FROM channel_data.price_decision d
        WHERE d.tenant_id = NEW.tenant_id AND d.price_decision_id = NEW.price_decision_id AND d.competitor_derived) THEN
    RAISE EXCEPTION 'competitor-derived pricing is halted for the channel of write_scope % (Р-51)', NEW.write_scope_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------
-- 4. Якоря проверки входов [Р-49, Р-50]
-- ---------------------------------------------------------------------------
ALTER TABLE channel_data.competitor_state ADD COLUMN gtin text CHECK (gtin ~ '^[0-9]{8,14}$');

-- Якорь 3: тот же EAN на других каналах и витринах тенанта, свежие значения
CREATE INDEX competitor_state_gtin_idx ON channel_data.competitor_state (tenant_id, gtin, observed_at DESC) WHERE gtin IS NOT NULL;

DROP TRIGGER a_competitor_state_restrict_update ON channel_data.competitor_state;
CREATE TRIGGER a_competitor_state_restrict_update BEFORE UPDATE ON channel_data.competitor_state
  FOR EACH ROW EXECUTE FUNCTION security.restrict_update(
    'source', 'source_event_id', 'competitor_snapshot_id', 'observed_at', 'received_at', 'buybox_amount_minor',
    'buybox_is_self', 'lowest_landed_minor', 'offer_count', 'offers', 'completeness', 'completeness_n', 'gtin');

ALTER TABLE channel_data.competitor_move ADD COLUMN seller_ref text CHECK (length(seller_ref) BETWEEN 1 AND 200);

DO $$
DECLARE
  con text;
BEGIN
  FOR con IN SELECT conname FROM pg_constraint
              WHERE conrelid = 'channel_data.rejected_competitor_snapshot'::regclass AND contype = 'c'
                AND (pg_get_constraintdef(oid) LIKE '%DEVIATION_FROM_OWN_PRICE%' OR pg_get_constraintdef(oid) LIKE '%''OUTLIER''%')
  LOOP
    EXECUTE format('ALTER TABLE channel_data.rejected_competitor_snapshot DROP CONSTRAINT %I', con);
  END LOOP;
END $$;

ALTER TABLE channel_data.rejected_competitor_snapshot
  ADD CONSTRAINT rejected_competitor_snapshot_reason_code_known CHECK (reason_code IN (
    'INVALID_AMOUNT', 'CURRENCY_MISMATCH', 'INCONSISTENT_SNAPSHOT', 'SNAPSHOT_FROM_FUTURE', 'SNAPSHOT_TOO_OLD', 'OUT_OF_ORDER',
    'CHANNEL_HALTED', 'CHANNEL_MASS_SHIFT', 'UNIT_SCALE_X100', 'UNIT_SCALE_X0_01', 'PRICE_BELOW_COST_ANCHOR',
    'PRICE_ABOVE_COST_ANCHOR', 'SNAPSHOT_INTERNAL_OUTLIER', 'CROSS_CHANNEL_MISMATCH', 'OUTSIDE_HISTORY_BAND',
    'NO_PLAUSIBILITY_ANCHOR')),
  ADD CONSTRAINT rejected_competitor_snapshot_alarm_class_known CHECK (alarm_class IN (
    'STRUCTURE', 'FRESHNESS', 'UNIT_SCALE', 'OUTLIER', 'CHANNEL_SHIFT', 'CHANNEL_HALTED', 'ANCHOR_MISSING')),
  ADD CONSTRAINT rejected_competitor_snapshot_anchor_missing CHECK ((reason_code = 'NO_PLAUSIBILITY_ANCHOR') = (alarm_class = 'ANCHOR_MISSING'));

RESET ROLE;

-- ---------------------------------------------------------------------------
-- 5. Закрытие тенанта учитывает новые таблицы (функции принадлежат repracer_retention)
-- ---------------------------------------------------------------------------
GRANT CREATE ON SCHEMA maintenance TO repracer_retention;
SET ROLE repracer_retention;

CREATE OR REPLACE FUNCTION maintenance.purge_tenant_channel_data(p_tenant_id uuid) RETURNS bigint
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  t     text;
  n     bigint;
  total bigint := 0;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM tenant_data.tenant
                  WHERE tenant_id = p_tenant_id AND kind = 'CUSTOMER' AND status IN ('OFFBOARDING', 'CLOSED')) THEN
    RAISE EXCEPTION 'tenant % must be a CUSTOMER in OFFBOARDING or CLOSED', p_tenant_id;
  END IF;
  FOREACH t IN ARRAY ARRAY[
    'channel_data.price_decision', 'channel_data.price_intent', 'channel_data.observed_channel_state',
    'channel_data.observed_price_daily', 'channel_data.divergence_case', 'channel_data.competitor_state',
    'channel_data.fee_estimate', 'channel_data.reservation', 'channel_data.sync_job',
    'channel_data.listing_migration_check', 'channel_data.write_submission',
    'channel_data.pricing_halt_review', 'channel_data.pricing_halt', 'channel_data.competitor_move', 'channel_data.competitor_price_daily',
    'channel_data.rejected_competitor_snapshot']
  LOOP
    EXECUTE format('DELETE FROM %s WHERE tenant_id = $1', t) USING p_tenant_id;
    GET DIAGNOSTICS n = ROW_COUNT;
    total := total + n;
  END LOOP;

  INSERT INTO maintenance.tenant_purge_status (subject_tenant_id, postgres_channel_purged_at)
  VALUES (p_tenant_id, now())
  ON CONFLICT (subject_tenant_id) DO UPDATE SET postgres_channel_purged_at = now();
  INSERT INTO maintenance.retention_run (table_name, action, rows_affected, subject_tenant_id)
  VALUES ('channel_data.*', 'TENANT_PURGED', total, p_tenant_id);
  RETURN total;
END $$;

CREATE OR REPLACE FUNCTION maintenance.purge_tenant_data(p_tenant_id uuid, p_delete_price_history boolean DEFAULT false) RETURNS bigint
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  t         text;
  n         bigint;
  total     bigint := 0;
  closed_ts timestamptz;
BEGIN
  SELECT closed_at INTO closed_ts FROM tenant_data.tenant
   WHERE tenant_id = p_tenant_id AND kind = 'CUSTOMER' AND status = 'CLOSED';
  IF closed_ts IS NULL THEN
    RAISE EXCEPTION 'tenant % must be a CLOSED CUSTOMER', p_tenant_id;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM maintenance.tenant_purge_status
                  WHERE subject_tenant_id = p_tenant_id AND postgres_channel_purged_at IS NOT NULL) THEN
    RAISE EXCEPTION 'purge channel data first (maintenance.purge_tenant_channel_data)';
  END IF;
  IF NOT p_delete_price_history
     AND (EXISTS (SELECT 1 FROM tenant_data.price_daily WHERE tenant_id = p_tenant_id)
          OR EXISTS (SELECT 1 FROM tenant_data.price_history WHERE tenant_id = p_tenant_id)
          OR EXISTS (SELECT 1 FROM tenant_data.price_intent_core WHERE tenant_id = p_tenant_id)) THEN
    RAISE EXCEPTION 'tenant % has price evidence; deletion requires explicit confirmation (OQ-22)', p_tenant_id;
  END IF;

  INSERT INTO legal.migration_consent_record
    (tenant_id, migration_consent_id, channel_account_id, channel_external_account_id, consenting_user_id,
     consenting_role, mfa_verified_at, disclosure_version, disclosure_text_sha256, other_tools_declaration,
     other_tools_list, typed_confirmation, given_at, expires_at, revoked_at, items, tenant_closed_at)
  SELECT c.tenant_id, c.migration_consent_id, c.channel_account_id, ca.external_account_id, c.user_id,
         m.role, c.mfa_verified_at, c.disclosure_version, c.disclosure_text_sha256, c.other_tools_declaration,
         c.other_tools_list, c.typed_confirmation, c.given_at, c.expires_at, r.revoked_at,
         coalesce((SELECT jsonb_agg(jsonb_build_object(
                     'listing_id', i.listing_id,
                     'listing_snapshot_sha256', encode(i.listing_snapshot_sha256, 'hex'),
                     'verdict_at_consent', i.verdict_at_consent,
                     'acknowledged_losses', to_jsonb(i.acknowledged_losses)))
                     FROM tenant_data.migration_consent_item i
                    WHERE i.tenant_id = c.tenant_id AND i.migration_consent_id = c.migration_consent_id), '[]'::jsonb),
         closed_ts
    FROM tenant_data.migration_consent c
    JOIN tenant_data.channel_account ca ON ca.tenant_id = c.tenant_id AND ca.channel_account_id = c.channel_account_id
    JOIN tenant_data.membership m ON m.tenant_id = c.tenant_id AND m.membership_id = c.membership_id
    LEFT JOIN tenant_data.migration_consent_revocation r
      ON r.tenant_id = c.tenant_id AND r.migration_consent_id = c.migration_consent_id
   WHERE c.tenant_id = p_tenant_id
  ON CONFLICT (tenant_id, migration_consent_id) DO NOTHING;

  FOREACH t IN ARRAY ARRAY[
    'tenant_data.outbox_event', 'tenant_data.price_history', 'tenant_data.price_daily_correction',
    'tenant_data.price_daily', 'tenant_data.price_intent_core',
    'tenant_data.channel_write_history', 'tenant_data.channel_write', 'tenant_data.edit_budget',
    'tenant_data.migration_consent_revocation', 'tenant_data.migration_consent_item', 'tenant_data.migration_consent',
    'tenant_data.stock_movement', 'tenant_data.stock_allocation', 'tenant_data.stock_pool',
    'tenant_data.inbound_api_key', 'tenant_data.stock_source',
    'tenant_data.min_price', 'tenant_data.max_price', 'tenant_data.product_vat_rate', 'tenant_data.guardrail', 'tenant_data.divergence_policy',
    'tenant_data.cost_profile',
    'tenant_data.offer_mapping', 'tenant_data.write_scope_sync_state', 'tenant_data.write_scope',
    'tenant_data.pricing_strategy', 'tenant_data.channel_capability_override', 'tenant_data.channel_account',
    'tenant_data.bundle_component', 'tenant_data.product', 'tenant_data.membership']
  LOOP
    EXECUTE format('DELETE FROM %s WHERE tenant_id = $1', t) USING p_tenant_id;
    GET DIAGNOSTICS n = ROW_COUNT;
    total := total + n;
  END LOOP;

  UPDATE tenant_data.tenant SET name = 'closed tenant' WHERE tenant_id = p_tenant_id;
  UPDATE maintenance.tenant_purge_status
     SET postgres_tenant_purged_at = now(),
         legal_hold_until = CASE WHEN EXISTS (SELECT 1 FROM legal.migration_consent_record WHERE tenant_id = p_tenant_id)
                                 THEN (closed_ts + interval '3 years')::date END
   WHERE subject_tenant_id = p_tenant_id;
  INSERT INTO maintenance.retention_run (table_name, action, rows_affected, subject_tenant_id)
  VALUES ('tenant_data.*', 'TENANT_PURGED', total, p_tenant_id);
  RETURN total;
END $$;

RESET ROLE;
REVOKE CREATE ON SCHEMA maintenance FROM repracer_retention;
COMMIT;
