-- 0087_omnibus_prior_price.sql
-- Шаг 24, C [Р-123]: комплаенс-модуль Omnibus на суточной свёртке цен [Р-21], которая хранится вечно ради него.
-- Правило: объявляя скидку, продавец указывает прежнюю цену; она не может быть выше наименьшей цены этого оффера за 30 суток до суток
-- начала скидки, отдельно по каждому каналу (единица записи цены) и по суткам часового пояса витрины [Р-62, Р-65].
-- 1. tenant_data.omnibus_lowest_prior_price — наименьшая цена окна. Суточная свёртка хранит только дни с изменениями, поэтому в окно входит
--    цена, действовавшая к его началу; закрытые сутки — из price_daily_effective (с исправлениями, Р-29), незакрытые — из сырья
--    price_history. Та же логика в коде — omnibusLowestPriorPrice (packages/pricing-model), равенство проверяет omnibus.pg.test.ts.
-- 2. tenant_data.discount_announcement — объявления скидок: проверку вычисляет база при вставке и хранит вместе с объявлением
--    (доказательство); явное нарушение база отклоняет. Не подтверждённое (история короче окна, пояс неизвестен) — принимается с отметкой.
--    Хранится до закрытия тенанта, как суточная свёртка.

BEGIN;

/** Сырьё цен единицы до момента: без исправленных строк и без суток, у которых уже есть суточная свёртка (она несёт исправления, Р-29) */
CREATE FUNCTION tenant_data.omnibus_raw_prices(p_tenant_id uuid, p_write_scope_id uuid, p_tz text, p_before timestamptz)
  RETURNS TABLE (accepted_at timestamptz, amount_minor bigint)
  LANGUAGE sql STABLE SET search_path = pg_catalog AS $fn$
  SELECT h.accepted_at, h.amount_minor FROM tenant_data.price_history h
   WHERE h.tenant_id = p_tenant_id AND h.write_scope_id = p_write_scope_id AND h.price_type IN ('REGULAR', 'SALE') AND h.accepted_at < p_before
     AND NOT EXISTS (SELECT 1 FROM tenant_data.price_history c WHERE c.tenant_id = h.tenant_id AND c.corrects_price_history_id = h.price_history_id)
     AND NOT EXISTS (SELECT 1 FROM tenant_data.price_daily d
                      WHERE d.tenant_id = h.tenant_id AND d.write_scope_id = h.write_scope_id AND d.price_type = h.price_type
                        AND d.price_day = (h.accepted_at AT TIME ZONE p_tz)::date)
$fn$;
GRANT EXECUTE ON FUNCTION tenant_data.omnibus_raw_prices(uuid, uuid, text, timestamptz) TO repracer_admin;

CREATE FUNCTION tenant_data.omnibus_lowest_prior_price(p_tenant_id uuid, p_write_scope_id uuid, p_starts_at timestamptz)
  RETURNS TABLE (status text, lowest_minor bigint, window_from date, window_to date, day_tz text, history_since timestamptz)
  LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS $fn$
DECLARE
  tz        text;
  start_day date;
  wfrom     date;
  wto       date;
  from_ts   timestamptz;
  to_ts     timestamptz;
  since     timestamptz;
  before_m  bigint;
  inside_m  bigint;
BEGIN
  tz := tenant_data.write_scope_time_zone(p_tenant_id, p_write_scope_id);
  SELECT least(
           (SELECT min(h.accepted_at) FROM tenant_data.price_history h
             WHERE h.tenant_id = p_tenant_id AND h.write_scope_id = p_write_scope_id AND h.price_type IN ('REGULAR', 'SALE')),
           (SELECT min(d.first_accepted_at) FROM tenant_data.price_daily_effective d
             WHERE d.tenant_id = p_tenant_id AND d.write_scope_id = p_write_scope_id AND d.price_type IN ('REGULAR', 'SALE')))
    INTO since;
  IF tz IS NULL THEN
    RETURN QUERY SELECT 'TIME_ZONE_UNKNOWN'::text, NULL::bigint, NULL::date, NULL::date, NULL::text, since;
    RETURN;
  END IF;
  start_day := (p_starts_at AT TIME ZONE tz)::date;
  wfrom := start_day - 30;
  wto := start_day - 1;
  from_ts := wfrom::timestamp AT TIME ZONE tz;
  to_ts := start_day::timestamp AT TIME ZONE tz;

  -- Цена, действовавшая к началу окна: последнее изменение до него
  SELECT x.amount INTO before_m FROM (
    SELECT r.accepted_at AS at, r.amount_minor AS amount FROM tenant_data.omnibus_raw_prices(p_tenant_id, p_write_scope_id, tz, to_ts) r WHERE r.accepted_at < from_ts
    UNION ALL
    SELECT d.last_accepted_at, d.last_amount_minor FROM tenant_data.price_daily_effective d
     WHERE d.tenant_id = p_tenant_id AND d.write_scope_id = p_write_scope_id AND d.price_type IN ('REGULAR', 'SALE') AND d.price_day < wfrom
  ) x ORDER BY x.at DESC LIMIT 1;

  -- Цены внутри окна: закрытые сутки — наименьшая цена суток, незакрытые — сырьё
  SELECT min(y.v) INTO inside_m FROM (
    SELECT d.min_amount_minor AS v FROM tenant_data.price_daily_effective d
     WHERE d.tenant_id = p_tenant_id AND d.write_scope_id = p_write_scope_id AND d.price_type IN ('REGULAR', 'SALE') AND d.price_day BETWEEN wfrom AND wto
    UNION ALL
    SELECT r.amount_minor FROM tenant_data.omnibus_raw_prices(p_tenant_id, p_write_scope_id, tz, to_ts) r WHERE r.accepted_at >= from_ts AND r.accepted_at < to_ts
  ) y;

  RETURN QUERY SELECT
    CASE WHEN before_m IS NOT NULL THEN 'OK' WHEN inside_m IS NULL THEN 'NO_PRICE_HISTORY' ELSE 'INCOMPLETE_HISTORY' END,
    CASE WHEN before_m IS NULL THEN inside_m WHEN inside_m IS NULL THEN before_m ELSE least(before_m, inside_m) END,
    wfrom, wto, tz, since;
END $fn$;
GRANT EXECUTE ON FUNCTION tenant_data.omnibus_lowest_prior_price(uuid, uuid, timestamptz) TO repracer_admin;

SET ROLE repracer_owner;

CREATE TABLE tenant_data.discount_announcement (
  tenant_id                 uuid NOT NULL,
  discount_announcement_id  uuid NOT NULL DEFAULT gen_random_uuid(),
  write_scope_id            uuid NOT NULL,
  -- Прежняя цена, которую продавец показывает рядом со скидкой
  reference_price_minor     bigint NOT NULL,
  sale_price_minor          bigint NOT NULL,
  currency                  text NOT NULL,
  starts_at                 timestamptz NOT NULL,
  ends_at                   timestamptz,
  created_by_membership_id  uuid NOT NULL,
  created_at                timestamptz NOT NULL DEFAULT now(),
  -- Итог проверки при объявлении — вычисляет база (discount_announcement_guard), значения из запроса заменяются
  check_status              text NOT NULL,
  lowest_prior_minor        bigint,
  window_from               date,
  window_to                 date,
  day_tz                    text,
  PRIMARY KEY (tenant_id, discount_announcement_id),
  FOREIGN KEY (tenant_id, write_scope_id) REFERENCES tenant_data.write_scope (tenant_id, write_scope_id),
  FOREIGN KEY (tenant_id, created_by_membership_id) REFERENCES tenant_data.membership (tenant_id, membership_id),
  CONSTRAINT discount_announcement_prices CHECK (sale_price_minor > 0 AND reference_price_minor > sale_price_minor),
  CONSTRAINT discount_announcement_period CHECK (ends_at IS NULL OR ends_at > starts_at)
  -- Статус и валюту не проверяют отдельные CHECK: статус ставит страж из omnibus_lowest_prior_price, валюта обязана совпасть с валютой
  -- единицы записи (страж) — второе ограничение было бы дублем [Р-104]
);
COMMENT ON TABLE tenant_data.discount_announcement IS
  'Шаг 24 [Р-123]: объявления скидок с прежней ценой и проверкой Omnibus на момент объявления; доказательство — до закрытия тенанта';
-- Отчёт по офферам и экран оффера: объявления единицы записи по времени начала
CREATE INDEX discount_announcement_scope_idx ON tenant_data.discount_announcement (tenant_id, write_scope_id, starts_at DESC);

SELECT security.register_table('tenant_data.discount_announcement', 'TENANT', 'append_only');
SELECT security.grant_retention('tenant_data.discount_announcement');
SELECT security.grant_export('tenant_data.discount_announcement');
GRANT SELECT, INSERT ON tenant_data.discount_announcement TO repracer_admin;
INSERT INTO maintenance.retention_policy (table_name, method, bound) VALUES ('tenant_data.discount_announcement', 'TENANT_CLOSURE_ONLY', 'MAX_AGE');

RESET ROLE;

/** Р-123: проверка Omnibus вычисляется базой при вставке; явное нарушение — отказ; валюта — валюта единицы записи [Р-71] */
CREATE FUNCTION tenant_data.discount_announcement_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
DECLARE
  p     record;
  scope record;
BEGIN
  SELECT s.currency INTO scope FROM tenant_data.write_scope s
   WHERE s.tenant_id = NEW.tenant_id AND s.write_scope_id = NEW.write_scope_id AND s.field = 'PRICE';
  IF scope IS NULL OR scope.currency IS DISTINCT FROM NEW.currency THEN
    RAISE EXCEPTION 'discount announcement currency % is not the currency of price write_scope % (Р-71)', NEW.currency, NEW.write_scope_id
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO p FROM tenant_data.omnibus_lowest_prior_price(NEW.tenant_id, NEW.write_scope_id, NEW.starts_at);
  NEW.check_status := p.status;
  NEW.lowest_prior_minor := p.lowest_minor;
  NEW.window_from := p.window_from;
  NEW.window_to := p.window_to;
  NEW.day_tz := p.day_tz;
  NEW.created_at := now();
  IF p.lowest_minor IS NOT NULL AND NEW.reference_price_minor > p.lowest_minor THEN
    RAISE EXCEPTION 'announced prior price % is above the lowest price % of the 30 days % to % (Omnibus, Р-123)', NEW.reference_price_minor, p.lowest_minor, p.window_from, p.window_to
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER a1_discount_announcement_guard BEFORE INSERT ON tenant_data.discount_announcement
  FOR EACH ROW EXECUTE FUNCTION tenant_data.discount_announcement_guard();

-- Страж и аудит административной записи [Р-97, Р-100]
CREATE TRIGGER a0_admin_write_person_insert BEFORE INSERT ON tenant_data.discount_announcement
  FOR EACH ROW EXECUTE FUNCTION security.require_person_for_admin_write();
CREATE TRIGGER zz_admin_write_audit_insert AFTER INSERT ON tenant_data.discount_announcement
  FOR EACH ROW EXECUTE FUNCTION security.audit_admin_write();

CREATE OR REPLACE FUNCTION security.admin_write_action(p_table text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
AS $function$
  SELECT a FROM (VALUES
    ('tenant_data.tenant', 'MANAGE_TENANT'), ('tenant_data.channel_account', 'MANAGE_TENANT'), ('tenant_data.inbound_api_key', 'MANAGE_TENANT'),
    ('tenant_data.channel_capability_override', 'MANAGE_TENANT'), ('tenant_data.price_daily_correction', 'MANAGE_TENANT'),
    ('tenant_data.write_scope', 'ENABLE_REPRICING'),
    ('tenant_data.cost_profile', 'MANAGE_PRICING'), ('tenant_data.min_price', 'MANAGE_PRICING'), ('tenant_data.max_price', 'MANAGE_PRICING'),
    ('tenant_data.guardrail', 'MANAGE_PRICING'), ('tenant_data.pricing_strategy', 'MANAGE_PRICING'), ('channel_data.pricing_strategy_undercut', 'MANAGE_PRICING'),
    ('tenant_data.divergence_policy', 'MANAGE_PRICING'), ('channel_data.fee_estimate', 'MANAGE_PRICING'), ('tenant_data.product_vat_rate', 'MANAGE_PRICING'),
    ('channel_data.divergence_case', 'MANAGE_PRICING'),
    ('tenant_data.product', 'MANAGE_CATALOG'), ('tenant_data.bundle_component', 'MANAGE_CATALOG'), ('tenant_data.offer_mapping', 'MANAGE_CATALOG'),
    ('tenant_data.stock_source', 'MANAGE_CATALOG'), ('tenant_data.stock_pool', 'MANAGE_CATALOG'), ('tenant_data.stock_movement', 'MANAGE_CATALOG'),
    ('tenant_data.stock_allocation', 'MANAGE_CATALOG'), ('channel_data.reservation', 'MANAGE_CATALOG'), ('channel_data.sync_job', 'MANAGE_CATALOG'),
    ('channel_data.listing_migration_check', 'MANAGE_CATALOG'),
    ('tenant_data.migration_consent', 'GIVE_MIGRATION_CONSENT'), ('tenant_data.migration_consent_item', 'GIVE_MIGRATION_CONSENT'),
    ('tenant_data.migration_consent_revocation', 'GIVE_MIGRATION_CONSENT'),
    ('channel_data.pricing_halt', 'RELEASE_CHANNEL_HALT'),
    ('channel_data.channel_distrust', 'RELEASE_CHANNEL_DISTRUST'), ('channel_data.offer_channel_pricing', 'MANAGE_CATALOG'),
    -- Шаг 24 (0087) [Р-123]: объявление скидки — действие менеджера цен
    ('tenant_data.discount_announcement', 'MANAGE_PRICING'),
    ('tenant_data.price_stop', 'OWN_GUARD'), ('channel_data.pricing_halt_review', 'OWN_GUARD'), ('tenant_data.membership', 'OWN_GUARD'),
    ('channel_data.pricing_halt_sample', 'OWN_GUARD')
  ) AS t(tbl, a) WHERE tbl = p_table
$function$;

-- Закрытие тенанта: объявления скидок — доказательство цен, удаляются вместе с историей цен и только с явным подтверждением (OQ-22)
CREATE OR REPLACE FUNCTION maintenance.purge_tenant_data(p_tenant_id uuid, p_delete_price_history boolean DEFAULT false)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
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
          OR EXISTS (SELECT 1 FROM tenant_data.discount_announcement WHERE tenant_id = p_tenant_id)
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
    'tenant_data.discount_announcement', 'tenant_data.offer_mapping', 'tenant_data.write_scope_sync_state', 'tenant_data.write_scope',
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
END $function$;

COMMIT;
