-- 0027_kaufland_scopes_and_sources.sql
-- Р-35: Kaufland — единица записи цены: аккаунт + витрина + unit; единица записи остатка: аккаунт + id_offer (общая для витрин).
-- Р-36: источники конкурентов Kaufland — buy_box_changed и GET /buybox (основные), competitors-comparer (сверка).

BEGIN;
SET ROLE repracer_owner;

-- ---------------------------------------------------------------------------
-- 1. Шаблоны ключей Kaufland в справочнике возможностей (заменяет правило Р-14 из 0003)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  con text;
BEGIN
  FOR con IN SELECT conname FROM pg_constraint
              WHERE conrelid = 'platform.channel_capability'::regclass AND contype = 'c'
                AND pg_get_constraintdef(oid) LIKE '%KAUFLAND%external_unit_id%'
  LOOP
    EXECUTE format('ALTER TABLE platform.channel_capability DROP CONSTRAINT %I', con);
  END LOOP;
END $$;

ALTER TABLE platform.channel_capability ADD CONSTRAINT channel_capability_kaufland_templates CHECK (
  channel <> 'KAUFLAND'
  OR (field IN ('PRICE', 'CHANNEL_MIN_PRICE')
      AND write_scope_key_template = ARRAY['channel_account', 'marketplace', 'external_unit_id'])
  OR (field = 'QUANTITY'
      AND write_scope_key_template = ARRAY['channel_account', 'external_offer_id'])
);

-- ---------------------------------------------------------------------------
-- 2. Синхронизация остатка Kaufland требует id_offer: без него unit не связан между витринами и единица не определена
-- ---------------------------------------------------------------------------
ALTER TABLE tenant_data.offer_mapping ADD CONSTRAINT offer_mapping_kaufland_quantity_needs_offer_id CHECK (
  channel <> 'KAUFLAND' OR quantity_write_scope_id IS NULL OR external_offer_id IS NOT NULL
);

-- ---------------------------------------------------------------------------
-- 3. Источники конкурентных данных [Р-36]
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  con text;
BEGIN
  FOR con IN SELECT conname FROM pg_constraint
              WHERE conrelid = 'channel_data.competitor_state'::regclass AND contype = 'c'
                AND pg_get_constraintdef(oid) LIKE '%AMAZON_ANY_OFFER_CHANGED%'
  LOOP
    EXECUTE format('ALTER TABLE channel_data.competitor_state DROP CONSTRAINT %I', con);
  END LOOP;
END $$;

ALTER TABLE channel_data.competitor_state ADD CONSTRAINT competitor_state_source_known CHECK (
  source IN ('AMAZON_ANY_OFFER_CHANGED', 'AMAZON_COMPETITIVE_SUMMARY',
             'KAUFLAND_BUY_BOX_CHANGED', 'KAUFLAND_BUYBOX', 'KAUFLAND_COMPETITORS_COMPARER')
);

-- Полнота снимка [Р-39]: стратегия проверяет, достаточно ли данных (ADR-0007)
-- Подкоманды ALTER COLUMN выполняются раньше ADD COLUMN, поэтому операторы раздельные.
-- Существующие строки (таблица пуста до шага 6) получают TOP_N/10 — топ-10 buybox Kaufland.
ALTER TABLE channel_data.competitor_state
  ADD COLUMN completeness text NOT NULL DEFAULT 'TOP_N' CHECK (completeness IN ('TOP_N', 'CHEAPEST_ONLY', 'FULL')),
  ADD COLUMN completeness_n int DEFAULT 10 CHECK (completeness_n > 0);
ALTER TABLE channel_data.competitor_state
  ALTER COLUMN completeness DROP DEFAULT,
  ALTER COLUMN completeness_n DROP DEFAULT,
  ADD CONSTRAINT competitor_state_completeness_n CHECK ((completeness = 'TOP_N') = (completeness_n IS NOT NULL));

DROP TRIGGER a_competitor_state_restrict_update ON channel_data.competitor_state;
CREATE TRIGGER a_competitor_state_restrict_update BEFORE UPDATE ON channel_data.competitor_state
  FOR EACH ROW EXECUTE FUNCTION security.restrict_update(
    'source', 'source_event_id', 'competitor_snapshot_id', 'observed_at', 'received_at', 'buybox_amount_minor',
    'buybox_is_self', 'lowest_landed_minor', 'offer_count', 'offers', 'completeness', 'completeness_n');

RESET ROLE;
COMMIT;
