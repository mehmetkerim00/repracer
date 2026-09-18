-- 0103: массовый импорт себестоимости и второй фактор массового изменения [Р-134, Р-135, шаг 28; OQ-144, риск 17]
--
-- Р-134: импорт себестоимости — часть онбординга. Без себестоимости репрайсинг не включается [Р-131], а 76 из 101 оффера тестовых
-- данных её не имели: руками столько не завести. Импорт применяется ЦЕЛИКОМ: пакет объявляет, сколько строк он принесёт, и если в его
-- транзакции появилось другое число — база отказывает. Частичного применения нет.
--
-- Р-135 и риск 17: массовое изменение себестоимости и границ требует второго фактора, и разбиение на отдельные транзакции его не
-- обходит. Две защиты:
--   1) строки импорта живут только внутри своего пакета и только в его транзакции (страж `cost_profile_import_guard`), а сам пакет
--      без второго фактора не создаётся (`cost_import_requires_mfa`) — значит импорт по одной строке за транзакцию невозможен;
--   2) окно: если за последние 10 минут тенант поменял себестоимость или границы больше чем у 5 предложений, следующая правка без
--      второго фактора отклоняется (`mass_change_window_requires_mfa`). Это и есть закрытие риска 17: раздробить массовую правку на
--      отдельные транзакции больше нельзя. Числа — ограничение продукта: правка десятка предложений руками в окно укладывается,
--      выгрузка на тысячи строк — нет.

BEGIN;

SET ROLE repracer_owner;

CREATE TABLE tenant_data.cost_import (
  tenant_id                uuid NOT NULL,
  cost_import_id           uuid NOT NULL DEFAULT gen_random_uuid(),
  created_by_membership_id uuid NOT NULL,
  -- Имя файла продавца: нужно ему самому, чтобы узнать свой импорт в списке
  source_name              text NOT NULL CHECK (length(source_name) BETWEEN 1 AND 200),
  source_format            text NOT NULL CHECK (source_format IN ('CSV', 'XLSX')),
  -- Сколько строк пакет обязан принести: меньше — частичное применение, больше — не то, что видел продавец
  row_count                int NOT NULL CHECK (row_count >= 1 AND row_count <= 200000),
  -- Отпечаток показанного предпросмотра: применяется ровно то, что продавец видел [Р-134]
  fingerprint              text NOT NULL CHECK (length(fingerprint) BETWEEN 3 AND 80),
  /** Строки файла, которые применены НЕ будут, по причинам: продавец видит их числом, а не догадывается */
  skipped_rows             int NOT NULL DEFAULT 0 CHECK (skipped_rows >= 0),
  created_at               timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, cost_import_id),
  FOREIGN KEY (tenant_id, created_by_membership_id) REFERENCES tenant_data.membership (tenant_id, membership_id)
);
COMMENT ON TABLE tenant_data.cost_import IS 'Шаг 28 [Р-134, Р-135]: пакет массового импорта себестоимости — применяется целиком и только со вторым фактором';
SELECT security.register_table('tenant_data.cost_import', 'TENANT', 'append_only');
SELECT security.grant_retention('tenant_data.cost_import');
INSERT INTO maintenance.retention_policy (table_name, method, bound)
VALUES ('tenant_data.cost_import', 'TENANT_CLOSURE_ONLY', 'MAX_AGE');

-- Строка себестоимости знает свой пакет: без него она не из импорта, с ним — из него
ALTER TABLE tenant_data.cost_profile ADD COLUMN cost_import_id uuid;
ALTER TABLE tenant_data.cost_profile ADD CONSTRAINT cost_profile_import_batch_fk
  FOREIGN KEY (tenant_id, cost_import_id) REFERENCES tenant_data.cost_import (tenant_id, cost_import_id);
ALTER TABLE tenant_data.cost_profile ADD CONSTRAINT cost_profile_import_source
  CHECK ((source = 'IMPORT') = (cost_import_id IS NOT NULL));
COMMENT ON COLUMN tenant_data.cost_profile.cost_import_id IS 'Шаг 28 [Р-134]: пакет импорта, которым создана строка; у ручной правки его нет';

-- Пересчёт пакета: сколько строк уже принесено. Запрос стража пакета — по нему и индекс
CREATE INDEX cost_profile_import_idx ON tenant_data.cost_profile (tenant_id, cost_import_id) WHERE cost_import_id IS NOT NULL;
-- Окно массового изменения: «сколько предложений тенант поменял за последние 10 минут» — по нему индекс на себестоимости
-- (у границ такие индексы уже есть с 0078: min_price_tenant_created_idx, max_price_tenant_created_idx)
CREATE INDEX cost_profile_tenant_created_idx ON tenant_data.cost_profile (tenant_id, created_at);

-- Признак второго фактора у версии цены: окно [Р-135] считает только правки БЕЗ него, иначе законная массовая правка со вторым
-- фактором закрывала бы продавцу ручную правку на десять минут
ALTER TABLE tenant_data.cost_profile ADD COLUMN created_with_mfa boolean NOT NULL DEFAULT false;
ALTER TABLE tenant_data.min_price ADD COLUMN created_with_mfa boolean NOT NULL DEFAULT false;
ALTER TABLE tenant_data.max_price ADD COLUMN created_with_mfa boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN tenant_data.cost_profile.created_with_mfa IS 'Шаг 28 [Р-135]: версия создана в сессии со вторым фактором — окно массовой правки её не считает';

RESET ROLE;

/** Признак ставит база, а не вызывающий: иначе приложение объявило бы второй фактор за пользователя [Р-90] */
CREATE FUNCTION tenant_data.mark_created_with_mfa() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  NEW.created_with_mfa := security.session_mfa();
  RETURN NEW;
END $fn$;
CREATE TRIGGER a_cost_profile_created_with_mfa BEFORE INSERT ON tenant_data.cost_profile
  FOR EACH ROW EXECUTE FUNCTION tenant_data.mark_created_with_mfa();
CREATE TRIGGER a_min_price_created_with_mfa BEFORE INSERT ON tenant_data.min_price
  FOR EACH ROW EXECUTE FUNCTION tenant_data.mark_created_with_mfa();
CREATE TRIGGER a_max_price_created_with_mfa BEFORE INSERT ON tenant_data.max_price
  FOR EACH ROW EXECUTE FUNCTION tenant_data.mark_created_with_mfa();
ALTER FUNCTION tenant_data.mark_created_with_mfa() OWNER TO repracer_owner;

/** Действие участника для новой таблицы [Р-100]: импорт себестоимости — работа менеджера цен */
CREATE OR REPLACE FUNCTION security.admin_write_action(p_table text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $function$
  SELECT a FROM (VALUES
    ('tenant_data.tenant', 'MANAGE_TENANT'), ('tenant_data.channel_account', 'MANAGE_TENANT'), ('tenant_data.inbound_api_key', 'MANAGE_TENANT'),
    ('tenant_data.channel_capability_override', 'MANAGE_TENANT'), ('tenant_data.price_daily_correction', 'MANAGE_TENANT'),
    ('tenant_data.write_scope', 'ENABLE_REPRICING'),
    ('tenant_data.cost_profile', 'MANAGE_PRICING'), ('tenant_data.min_price', 'MANAGE_PRICING'), ('tenant_data.max_price', 'MANAGE_PRICING'),
    ('tenant_data.cost_import', 'MANAGE_PRICING'),
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
    ('tenant_data.discount_announcement', 'MANAGE_PRICING'),
    ('tenant_data.price_stop', 'OWN_GUARD'), ('channel_data.pricing_halt_review', 'OWN_GUARD'), ('tenant_data.membership', 'OWN_GUARD'),
    ('channel_data.pricing_halt_sample', 'OWN_GUARD')
  ) AS t(tbl, a) WHERE tbl = p_table
$function$;

/** Р-135: пакет импорта заводится только со вторым фактором — как массовая правка границ [Р-88] */
CREATE FUNCTION tenant_data.cost_import_requires_mfa() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  IF NOT security.admin_session() THEN RETURN NULL; END IF;
  IF security.session_mfa() THEN RETURN NULL; END IF;
  RAISE EXCEPTION 'a cost import needs a second factor (Р-135)' USING ERRCODE = 'insufficient_privilege';
END $fn$;
CREATE TRIGGER zc_cost_import_requires_mfa AFTER INSERT ON tenant_data.cost_import
  FOR EACH ROW EXECUTE FUNCTION tenant_data.cost_import_requires_mfa();

/**
 * Р-134: строка импорта существует только вместе со своим пакетом и только в его транзакции. Отсюда два следствия:
 * импорт нельзя раздробить на транзакции (риск 17), и он не может дописывать строки в старый пакет задним числом.
 */
CREATE FUNCTION tenant_data.cost_profile_import_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
DECLARE
  batch_xmin xid;
BEGIN
  IF NEW.cost_import_id IS NULL THEN RETURN NULL; END IF;
  SELECT i.xmin INTO batch_xmin FROM tenant_data.cost_import i
   WHERE i.tenant_id = NEW.tenant_id AND i.cost_import_id = NEW.cost_import_id;
  IF batch_xmin IS NULL OR NOT tenant_data.row_in_current_transaction(batch_xmin) THEN
    RAISE EXCEPTION 'a cost import row belongs to a batch of another transaction (Р-134)' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END $fn$;
CREATE TRIGGER zd_cost_profile_import_guard AFTER INSERT ON tenant_data.cost_profile
  FOR EACH ROW EXECUTE FUNCTION tenant_data.cost_profile_import_guard();

/** Р-134: пакет приносит ровно столько строк, сколько объявил. Проверка отложенная — строки идут после пакета */
CREATE FUNCTION tenant_data.cost_import_all_or_nothing() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
DECLARE
  brought int;
BEGIN
  SELECT count(*)::int INTO brought FROM tenant_data.cost_profile c
   WHERE c.tenant_id = NEW.tenant_id AND c.cost_import_id = NEW.cost_import_id;
  IF brought <> NEW.row_count THEN
    RAISE EXCEPTION 'a cost import applies in full: the batch declared % rows and brought % (Р-134)', NEW.row_count, brought
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END $fn$;
CREATE CONSTRAINT TRIGGER ze_cost_import_all_or_nothing AFTER INSERT ON tenant_data.cost_import
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION tenant_data.cost_import_all_or_nothing();

/**
 * Ревью шага 28, находка 1: окно смотрит на `created_at`, поэтому у версии себестоимости, как у версии границы (0078), должно быть
 * время транзакции. Без этого стража административная роль без второго фактора ставила строкам время «одиннадцать минут назад» и
 * выходила из окна, не разбивая правку даже на транзакции.
 */
CREATE FUNCTION tenant_data.cost_version_is_transaction_time() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  IF NOT security.admin_session() THEN RETURN NEW; END IF;
  IF NEW.created_at IS DISTINCT FROM now() THEN
    RAISE EXCEPTION 'a cost version is created at the transaction time, not %: backdated versions are not accepted from the administrative service (Р-135)', NEW.created_at
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER a1_cost_profile_transaction_time BEFORE INSERT ON tenant_data.cost_profile
  FOR EACH ROW EXECUTE FUNCTION tenant_data.cost_version_is_transaction_time();

/**
 * Р-135, риск 17: массовое изменение цен второй фактор не обходит разбиением на транзакции. Окно — последние 10 минут тенанта:
 * себестоимость и границы считаются вместе, потому что массовая правка бывает и той и другой. Порог — 5 предложений: ручная правка
 * десятка предложений в окно укладывается, выгрузка на тысячи строк — нет, и ей нужен второй фактор (или импорт, у которого он свой).
 * Импортные строки в счёт не идут: их пакет второй фактор уже проверил.
 *
 * Ревью шага 28, находка 9: считается ПРЕДЛОЖЕНИЕ, а не строка. Один оффер, которому завели и себестоимость, и обе границы, — это
 * один ключ: иначе честному продавцу оставалось бы два с половиной оффера за десять минут.
 */
CREATE FUNCTION tenant_data.mass_change_window_requires_mfa() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
DECLARE
  window_start timestamptz := now() - interval '10 minutes';
  offers       int;
BEGIN
  IF NOT security.admin_session() THEN RETURN NULL; END IF;
  IF security.session_mfa() THEN RETURN NULL; END IF;
  -- Считаются только правки БЕЗ второго фактора: массовый импорт и массовая правка его уже предъявили. Ключ — товар: граница
  -- уровня единицы записи приводится к товару этой единицы, поэтому себестоимость и границы одного оффера — один ключ.
  SELECT count(DISTINCT k) INTO offers FROM (
    SELECT 'PRODUCT:' || c.product_id::text AS k FROM tenant_data.cost_profile c
     WHERE c.tenant_id = NEW.tenant_id AND c.created_at >= window_start AND NOT c.created_with_mfa
    UNION ALL
    SELECT 'PRODUCT:' || coalesce(b.product_id, w.product_id)::text FROM tenant_data.min_price b
     LEFT JOIN tenant_data.write_scope w ON w.tenant_id = b.tenant_id AND w.write_scope_id = b.write_scope_id AND w.field = 'PRICE'
     WHERE b.tenant_id = NEW.tenant_id AND b.created_at >= window_start AND NOT b.created_with_mfa
    UNION ALL
    SELECT 'PRODUCT:' || coalesce(b.product_id, w.product_id)::text FROM tenant_data.max_price b
     LEFT JOIN tenant_data.write_scope w ON w.tenant_id = b.tenant_id AND w.write_scope_id = b.write_scope_id AND w.field = 'PRICE'
     WHERE b.tenant_id = NEW.tenant_id AND b.created_at >= window_start AND NOT b.created_with_mfa
  ) changed;
  IF offers > 5 THEN
    RAISE EXCEPTION 'prices of % offers changed within ten minutes without a second factor: a mass change requires it (Р-135)', offers
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NULL;
END $fn$;
CREATE TRIGGER zf_cost_profile_mass_window_requires_mfa AFTER INSERT ON tenant_data.cost_profile
  FOR EACH ROW EXECUTE FUNCTION tenant_data.mass_change_window_requires_mfa();
CREATE TRIGGER zf_min_price_mass_window_requires_mfa AFTER INSERT ON tenant_data.min_price
  FOR EACH ROW EXECUTE FUNCTION tenant_data.mass_change_window_requires_mfa();
CREATE TRIGGER zf_max_price_mass_window_requires_mfa AFTER INSERT ON tenant_data.max_price
  FOR EACH ROW EXECUTE FUNCTION tenant_data.mass_change_window_requires_mfa();

/**
 * Ревью шага 28, находка 2: гардрейл уровня тенанта или аккаунта меняет пол маржи и потолок сразу у ВСЕХ предложений — это
 * изменение массовее любого импорта, а окно его не видело вовсе (оно считает предложения). Считать такую правку в предложениях
 * нечестно: её область — весь тенант. Поэтому правило прямое — второй фактор [Р-135]. Гардрейл товара и единицы записи
 * остаётся обычной правкой: он про одно предложение.
 */
CREATE FUNCTION tenant_data.wide_guardrail_requires_mfa() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  IF NOT security.admin_session() THEN RETURN NULL; END IF;
  IF security.session_mfa() THEN RETURN NULL; END IF;
  IF NEW.scope_type IN ('TENANT', 'CHANNEL_ACCOUNT') THEN
    RAISE EXCEPTION 'a guardrail of scope % covers every offer: changing it requires a second factor (Р-135)', NEW.scope_type
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NULL;
END $fn$;
CREATE TRIGGER zg_guardrail_wide_scope_requires_mfa AFTER INSERT ON tenant_data.guardrail
  FOR EACH ROW EXECUTE FUNCTION tenant_data.wide_guardrail_requires_mfa();

-- Стражи принадлежат владельцу схемы, как остальные стражи тенантских таблиц (их накатывает суперпользователь)
ALTER FUNCTION tenant_data.cost_import_requires_mfa() OWNER TO repracer_owner;
ALTER FUNCTION tenant_data.cost_profile_import_guard() OWNER TO repracer_owner;
ALTER FUNCTION tenant_data.cost_import_all_or_nothing() OWNER TO repracer_owner;
ALTER FUNCTION tenant_data.mass_change_window_requires_mfa() OWNER TO repracer_owner;
ALTER FUNCTION tenant_data.cost_version_is_transaction_time() OWNER TO repracer_owner;
ALTER FUNCTION tenant_data.wide_guardrail_requires_mfa() OWNER TO repracer_owner;

-- Страж и аудит административной записи [Р-97, Р-100]
CREATE TRIGGER a0_admin_write_person_insert BEFORE INSERT ON tenant_data.cost_import
  FOR EACH ROW EXECUTE FUNCTION security.require_person_for_admin_write();
CREATE TRIGGER zz_admin_write_audit_insert AFTER INSERT ON tenant_data.cost_import
  FOR EACH ROW EXECUTE FUNCTION security.audit_admin_write();

-- Закрытие тенанта удаляет и пакеты импорта: строки себестоимости ссылаются на них, поэтому пакеты — после себестоимости
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
    'tenant_data.outbox_event', 'tenant_data.price_history_not_applied', 'tenant_data.price_history_applied', 'tenant_data.price_history', 'tenant_data.price_daily_correction', 'tenant_data.price_daily_system_correction',
    'tenant_data.price_daily', 'tenant_data.price_intent_core',
    'tenant_data.channel_write_history', 'tenant_data.channel_write', 'tenant_data.edit_budget',
    'tenant_data.migration_consent_revocation', 'tenant_data.migration_consent_item', 'tenant_data.migration_consent',
    'tenant_data.stock_movement', 'tenant_data.stock_allocation', 'tenant_data.stock_pool',
    'tenant_data.inbound_api_key', 'tenant_data.stock_source',
    -- Остановки цен человеком: тоже данные тенанта, удалялись только вместе с базой (найдено правилом проверки схемы шага 26)
    'tenant_data.price_stop',
    'tenant_data.min_price', 'tenant_data.max_price', 'tenant_data.product_vat_rate', 'tenant_data.guardrail', 'tenant_data.divergence_policy',
    'tenant_data.cost_profile', 'tenant_data.cost_import',
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
