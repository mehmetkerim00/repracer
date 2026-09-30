-- 0158_external_writers.sql
-- Шаг 60 [Р-202]: внешние писатели канала. У первого пилота преп-софт сам пушит остатки на eBay — если и мы начнём писать количество,
-- два инструмента будут перетирать друг друга («два писателя», только снаружи системы).
--
-- 1. Запись количества в канал по умолчанию выключена: синхронизацию количества у единиц аккаунта нельзя включить, пока владелец не
--    подтвердил «другие инструменты количество в этом канале не ведут» — строкой журнала с набранным идентификатором аккаунта, в аудит;
--    второй фактор не нужен (подтверждение — знание владельца о своих инструментах, а не опасное действие над ценами). Цен это не касается.
-- 2. У аккаунта — ответ владельца «обновляет ли другой инструмент остатки или цены в этом канале» (NONE / STOCK / PRICES /
--    STOCK_AND_PRICES). Ответ «остатки» запрещает подтверждение; при действующем подтверждении ответ «остатки» отклоняется.
-- 3. Внешние правки: обход предложений сообщает цену и количество канала; значение, которого мы не писали и которое не совпадает с нашей
--    целью, — строка `channel_data.external_edit`. Количество — только ВВЕРХ от нашего применённого: продажа уменьшает количество у канала
--    сама (K-11), и уменьшение от чужой правки не отличить.

BEGIN;
SET ROLE repracer_owner;

-- ---------------------------------------------------------------- 2. ответ владельца о других инструментах
ALTER TABLE tenant_data.channel_account
  ADD COLUMN other_tools text CONSTRAINT channel_account_other_tools_known CHECK (other_tools IN ('NONE', 'STOCK', 'PRICES', 'STOCK_AND_PRICES')),
  ADD COLUMN other_tools_answered_at timestamptz,
  ADD COLUMN other_tools_answered_by uuid,
  ADD COLUMN quantity_writes_confirmed boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN tenant_data.channel_account.other_tools IS
  'Шаг 60 [Р-202]: обновляет ли другой инструмент остатки или цены в этом канале — ответ владельца; NULL — не отвечено';
COMMENT ON COLUMN tenant_data.channel_account.quantity_writes_confirmed IS
  'Шаг 60 [Р-202]: владелец подтвердил, что количество в этом канале не ведут другие инструменты; меняет только строка журнала подтверждения';

/**
 * Ответ владельца: автор и время ставит база; «остатки ведёт другой инструмент» при действующем подтверждении записи количества
 * отклоняется — два писателя не должны появиться обходом через ответ. Столбец подтверждения меняет только журнал
 */
CREATE FUNCTION tenant_data.channel_account_other_tools_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  IF NEW.quantity_writes_confirmed IS DISTINCT FROM OLD.quantity_writes_confirmed AND pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'quantity writes are confirmed by a row of tenant_data.channel_quantity_writes_confirmation, not directly (Р-202)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.other_tools IS DISTINCT FROM OLD.other_tools THEN
    IF NEW.other_tools IN ('STOCK', 'STOCK_AND_PRICES') AND NEW.quantity_writes_confirmed THEN
      RAISE EXCEPTION 'quantity writes of this channel account are confirmed: another tool managing stock would make two writers (Р-202)'
        USING ERRCODE = 'check_violation';
    END IF;
    NEW.other_tools_answered_at := now();
    NEW.other_tools_answered_by := security.current_user_id();
  END IF;
  RETURN NEW;
END $fn$;
-- Страж изменяемых столбцов аккаунта — с новыми столбцами
DROP TRIGGER channel_account_restrict_update ON tenant_data.channel_account;
CREATE TRIGGER channel_account_restrict_update BEFORE UPDATE ON tenant_data.channel_account
  FOR EACH ROW EXECUTE FUNCTION security.restrict_update('display_name', 'marketplaces', 'known_other_marketplaces', 'credentials_ref', 'auth_status',
    'access_token_expires_at', 'authorization_expires_at', 'granted_scopes', 'disconnected_at', 'write_mode', 'ebay_batch_mode', 'external_account_id',
    'other_tools', 'other_tools_answered_at', 'other_tools_answered_by', 'quantity_writes_confirmed');
CREATE TRIGGER a_channel_account_other_tools_guard BEFORE UPDATE OF other_tools, quantity_writes_confirmed ON tenant_data.channel_account
  FOR EACH ROW EXECUTE FUNCTION tenant_data.channel_account_other_tools_guard();

-- ---------------------------------------------------------------- 1. подтверждение записи количества
CREATE TABLE tenant_data.channel_quantity_writes_confirmation (
  tenant_id                  uuid NOT NULL,
  confirmation_id            uuid NOT NULL DEFAULT gen_random_uuid(),
  channel_account_id         uuid NOT NULL,
  /** Набранный владельцем внешний идентификатор аккаунта проверяет страж; хранится отметка `matched` (у eBay это userId продавца, Р-192) */
  typed_confirmation         text NOT NULL,
  confirmed_by_membership_id uuid NOT NULL,
  confirmed_at               timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, confirmation_id),
  -- Одно подтверждение на аккаунт: отзыв — отдельным шагом (pilot-readiness, «осталось»)
  CONSTRAINT channel_quantity_writes_confirmation_once UNIQUE (tenant_id, channel_account_id),
  FOREIGN KEY (tenant_id, channel_account_id) REFERENCES tenant_data.channel_account (tenant_id, channel_account_id),
  FOREIGN KEY (tenant_id, confirmed_by_membership_id) REFERENCES tenant_data.membership (tenant_id, membership_id)
);
COMMENT ON TABLE tenant_data.channel_quantity_writes_confirmation IS
  'Шаг 60 [Р-202]: владелец подтвердил, что количество в канале не ведут другие инструменты — без этого запись количества выключена';
SELECT security.register_table('tenant_data.channel_quantity_writes_confirmation', 'TENANT', 'append_only');
SELECT security.grant_retention('tenant_data.channel_quantity_writes_confirmation');
INSERT INTO maintenance.retention_policy (table_name, method, bound)
VALUES ('tenant_data.channel_quantity_writes_confirmation', 'TENANT_CLOSURE_ONLY', 'MAX_AGE');
GRANT SELECT, INSERT (tenant_id, channel_account_id, typed_confirmation, confirmed_by_membership_id) ON tenant_data.channel_quantity_writes_confirmation TO repracer_admin;

/**
 * Кто подтверждает: только владелец, от своего имени, с набранным внешним идентификатором аккаунта; ответ о других инструментах дан, и в
 * нём нет «остатки ведёт другой инструмент». Второй фактор не требуется [Р-202]
 */
CREATE FUNCTION tenant_data.channel_quantity_writes_confirmation_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
DECLARE
  m record;
  a record;
BEGIN
  SELECT mb.user_id, mb.role INTO m FROM tenant_data.membership mb
   WHERE mb.tenant_id = NEW.tenant_id AND mb.membership_id = NEW.confirmed_by_membership_id AND mb.status = 'ACTIVE';
  IF security.current_user_id() IS NOT NULL AND (m.user_id IS NULL OR m.user_id IS DISTINCT FROM security.current_user_id()) THEN
    RAISE EXCEPTION 'membership % is not the membership of the session user', NEW.confirmed_by_membership_id USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF m.role IS DISTINCT FROM 'OWNER' THEN
    RAISE EXCEPTION 'only the owner confirms quantity writes of a channel account (Р-202)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT ca.external_account_id, ca.other_tools INTO a FROM tenant_data.channel_account ca
   WHERE ca.tenant_id = NEW.tenant_id AND ca.channel_account_id = NEW.channel_account_id;
  IF a.other_tools IS NULL THEN
    RAISE EXCEPTION 'answer first whether another tool updates stock or prices in this channel (Р-202)' USING ERRCODE = 'check_violation';
  END IF;
  IF a.other_tools IN ('STOCK', 'STOCK_AND_PRICES') THEN
    RAISE EXCEPTION 'another tool updates stock in this channel: quantity writes would make two writers (Р-202)' USING ERRCODE = 'check_violation';
  END IF;
  IF btrim(NEW.typed_confirmation) IS DISTINCT FROM a.external_account_id THEN
    RAISE EXCEPTION 'the typed confirmation does not name the channel account (Р-202)' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- Как у журнала переключений (0142, Р-192): у eBay внешний идентификатор — userId продавца; подтверждение проверено базой, хранится отметка
  NEW.typed_confirmation := 'matched';
  NEW.confirmed_at := now();
  RETURN NEW;
END $fn$;
CREATE TRIGGER b_channel_quantity_writes_confirmation_guard BEFORE INSERT ON tenant_data.channel_quantity_writes_confirmation
  FOR EACH ROW EXECUTE FUNCTION tenant_data.channel_quantity_writes_confirmation_guard();

CREATE FUNCTION tenant_data.channel_quantity_writes_confirmation_apply() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  UPDATE tenant_data.channel_account SET quantity_writes_confirmed = true
   WHERE tenant_id = NEW.tenant_id AND channel_account_id = NEW.channel_account_id;
  RETURN NULL;
END $fn$;
CREATE TRIGGER c_channel_quantity_writes_confirmation_apply AFTER INSERT ON tenant_data.channel_quantity_writes_confirmation
  FOR EACH ROW EXECUTE FUNCTION tenant_data.channel_quantity_writes_confirmation_apply();

/** Синхронизация количества включается только у аккаунта с подтверждением [Р-202] — это и есть «по умолчанию выключено» */
CREATE FUNCTION tenant_data.write_scope_quantity_writes_confirmed() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  IF NEW.field = 'QUANTITY' AND NEW.quantity_sync_enabled
     AND (TG_OP = 'INSERT' OR NOT OLD.quantity_sync_enabled)
     AND NOT EXISTS (SELECT 1 FROM tenant_data.channel_account ca
                      WHERE ca.tenant_id = NEW.tenant_id AND ca.channel_account_id = NEW.channel_account_id AND ca.quantity_writes_confirmed) THEN
    RAISE EXCEPTION 'quantity writes of channel account % are not confirmed by the owner: another tool may manage stock there (Р-202)', NEW.channel_account_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER a3_write_scope_quantity_writes_confirmed BEFORE INSERT OR UPDATE OF quantity_sync_enabled ON tenant_data.write_scope
  FOR EACH ROW EXECUTE FUNCTION tenant_data.write_scope_quantity_writes_confirmed();

-- ---------------------------------------------------------------- 3. внешние правки
CREATE TABLE channel_data.external_edit (
  tenant_id          uuid NOT NULL,
  external_edit_id   uuid NOT NULL DEFAULT gen_random_uuid(),
  channel_account_id uuid NOT NULL,
  write_scope_id     uuid NOT NULL,
  field              text NOT NULL CONSTRAINT external_edit_field_known CHECK (field IN ('PRICE', 'QUANTITY')),
  observed_value     bigint NOT NULL,
  our_value          bigint NOT NULL,
  currency           text,
  -- Наша последняя применённая запись, после которой замечено чужое значение: одно значение после одной нашей записи — одна правка
  since_write_id     uuid NOT NULL,
  observed_at        timestamptz NOT NULL,
  recorded_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, external_edit_id),
  CONSTRAINT external_edit_once UNIQUE (tenant_id, write_scope_id, since_write_id, observed_value),
  FOREIGN KEY (tenant_id, channel_account_id) REFERENCES tenant_data.channel_account (tenant_id, channel_account_id),
  CONSTRAINT external_edit_currency_of_price CHECK ((field = 'PRICE') = (currency IS NOT NULL))
);
COMMENT ON TABLE channel_data.external_edit IS
  'Шаг 60 [Р-202]: значение канала, которого мы не писали и которое не совпадает с нашей целью, — диагностика двух писателей';
SELECT security.register_table('channel_data.external_edit', 'CHANNEL', 'append_only', 'none');
SELECT security.grant_retention('channel_data.external_edit');
INSERT INTO maintenance.retention_policy (table_name, method, anchor_column, retention, bound)
VALUES ('channel_data.external_edit', 'DELETE_ROWS', 'recorded_at', interval '90 days', 'MAX_AGE');
ALTER TABLE channel_data.external_edit ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_data.external_edit FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON channel_data.external_edit FOR SELECT TO repracer_app USING (tenant_id = security.current_tenant_id());
GRANT SELECT ON channel_data.external_edit TO repracer_admin;
-- Экран подключений читает счётчик административной ролью — своей политикой, а не через членство в роли пути решения
CREATE POLICY admin_read ON channel_data.external_edit FOR SELECT TO repracer_admin USING (tenant_id = security.current_tenant_id());
-- Правки пишет только обход (роль каталога функцией); у административной роли записи в журнал правок нет [Р-97]
REVOKE INSERT, UPDATE, DELETE ON channel_data.external_edit FROM repracer_admin;
-- Экран подключений: правки аккаунта за сутки
CREATE INDEX external_edit_account_recent_idx ON channel_data.external_edit (tenant_id, channel_account_id, recorded_at DESC);

/**
 * Наблюдения обхода [Р-202]: для каждого предложения — наша последняя ПРИМЕНЁННАЯ запись (`applied_at`: канал применил её сразу или это
 * подтвердила сверка) и последняя созданная (цель). Значение канала,
 * не равное ни той, ни другой, — внешняя правка; количество — только вверх (продажу канал списывает сам, K-11). Пока мы не писали ничего,
 * правок нет: значение до нашей первой записи — не чужая правка, а исходное состояние
 */
CREATE FUNCTION channel_data.record_channel_observations(p_tenant_id uuid, p_channel_account_id uuid, p_items jsonb)
  RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
DECLARE
  i record;
  om record;
  lw record;
  tw record;
  n integer := 0;
  inserted integer;
BEGIN
  FOR i IN SELECT * FROM jsonb_to_recordset(p_items) AS x(marketplace text, external_sku text, external_offer_id text, external_unit_id text,
                                                         price_minor bigint, currency text, quantity bigint, observed_at timestamptz) LOOP
    CONTINUE WHEN i.observed_at IS NULL;
    SELECT m.price_write_scope_id, m.quantity_write_scope_id INTO om FROM tenant_data.offer_mapping m
     WHERE m.tenant_id = p_tenant_id AND m.channel_account_id = p_channel_account_id AND m.marketplace = i.marketplace AND m.status = 'ACTIVE'
       AND ((i.external_offer_id IS NOT NULL AND m.external_offer_id = i.external_offer_id) OR (i.external_unit_id IS NOT NULL AND m.external_unit_id = i.external_unit_id)
            OR (i.external_sku IS NOT NULL AND m.external_sku = i.external_sku))
     ORDER BY m.created_at DESC LIMIT 1;
    CONTINUE WHEN NOT FOUND;
    IF i.price_minor IS NOT NULL AND om.price_write_scope_id IS NOT NULL THEN
      -- Наша применённая: текущая запись, применённая сразу (`applied_at`), или завершённая в истории как APPLIED — самая свежая версия
      SELECT x.channel_write_id, x.amount_minor, x.currency INTO lw FROM (
        SELECT w.channel_write_id, w.amount_minor, w.currency, w.version FROM tenant_data.channel_write w
         WHERE w.tenant_id = p_tenant_id AND w.write_scope_id = om.price_write_scope_id AND w.field = 'PRICE' AND w.applied_at IS NOT NULL
        UNION ALL
        SELECT h.channel_write_id, h.amount_minor, h.currency, h.version FROM tenant_data.channel_write_history h
         WHERE h.tenant_id = p_tenant_id AND h.write_scope_id = om.price_write_scope_id AND h.field = 'PRICE' AND h.final_status = 'APPLIED') x
       ORDER BY x.version DESC LIMIT 1;
      -- Цель — самая свежая созданная версия (ждущая, в полёте или завершённая)
      SELECT x.amount_minor INTO tw FROM (
        SELECT w.amount_minor, w.version FROM tenant_data.channel_write w WHERE w.tenant_id = p_tenant_id AND w.write_scope_id = om.price_write_scope_id AND w.field = 'PRICE'
        UNION ALL
        SELECT h.amount_minor, h.version FROM tenant_data.channel_write_history h WHERE h.tenant_id = p_tenant_id AND h.write_scope_id = om.price_write_scope_id AND h.field = 'PRICE') x
       ORDER BY x.version DESC LIMIT 1;
      IF lw.channel_write_id IS NOT NULL AND i.currency = lw.currency AND i.price_minor <> lw.amount_minor AND i.price_minor IS DISTINCT FROM tw.amount_minor THEN
        INSERT INTO channel_data.external_edit (tenant_id, channel_account_id, write_scope_id, field, observed_value, our_value, currency, since_write_id, observed_at)
        VALUES (p_tenant_id, p_channel_account_id, om.price_write_scope_id, 'PRICE', i.price_minor, lw.amount_minor, i.currency, lw.channel_write_id, i.observed_at)
        ON CONFLICT ON CONSTRAINT external_edit_once DO NOTHING;
        GET DIAGNOSTICS inserted = ROW_COUNT;
        n := n + inserted;
      END IF;
    END IF;
    IF i.quantity IS NOT NULL AND om.quantity_write_scope_id IS NOT NULL THEN
      SELECT x.channel_write_id, x.quantity INTO lw FROM (
        SELECT w.channel_write_id, w.quantity, w.version FROM tenant_data.channel_write w
         WHERE w.tenant_id = p_tenant_id AND w.write_scope_id = om.quantity_write_scope_id AND w.field = 'QUANTITY' AND w.applied_at IS NOT NULL
        UNION ALL
        SELECT h.channel_write_id, h.quantity, h.version FROM tenant_data.channel_write_history h
         WHERE h.tenant_id = p_tenant_id AND h.write_scope_id = om.quantity_write_scope_id AND h.field = 'QUANTITY' AND h.final_status = 'APPLIED') x
       ORDER BY x.version DESC LIMIT 1;
      SELECT x.quantity INTO tw FROM (
        SELECT w.quantity, w.version FROM tenant_data.channel_write w WHERE w.tenant_id = p_tenant_id AND w.write_scope_id = om.quantity_write_scope_id AND w.field = 'QUANTITY'
        UNION ALL
        SELECT h.quantity, h.version FROM tenant_data.channel_write_history h WHERE h.tenant_id = p_tenant_id AND h.write_scope_id = om.quantity_write_scope_id AND h.field = 'QUANTITY') x
       ORDER BY x.version DESC LIMIT 1;
      IF lw.channel_write_id IS NOT NULL AND i.quantity > lw.quantity AND i.quantity IS DISTINCT FROM tw.quantity::bigint THEN
        INSERT INTO channel_data.external_edit (tenant_id, channel_account_id, write_scope_id, field, observed_value, our_value, currency, since_write_id, observed_at)
        VALUES (p_tenant_id, p_channel_account_id, om.quantity_write_scope_id, 'QUANTITY', i.quantity, lw.quantity, NULL, lw.channel_write_id, i.observed_at)
        ON CONFLICT ON CONSTRAINT external_edit_once DO NOTHING;
        GET DIAGNOSTICS inserted = ROW_COUNT;
        n := n + inserted;
      END IF;
    END IF;
  END LOOP;
  RETURN n;
END $fn$;

RESET ROLE;

-- Роль каталога ведёт наблюдения обхода (как количество FBA, 0144): читает сопоставления и записи, вставляет правки
GRANT SELECT (quantity_write_scope_id) ON tenant_data.offer_mapping TO repracer_catalog;
GRANT SELECT ON tenant_data.channel_write TO repracer_catalog;
GRANT SELECT ON tenant_data.channel_write_history TO repracer_catalog;
CREATE POLICY catalog_history_read ON tenant_data.channel_write_history FOR SELECT TO repracer_catalog USING (tenant_id = security.current_tenant_id());
GRANT INSERT (tenant_id, channel_account_id, write_scope_id, field, observed_value, our_value, currency, since_write_id, observed_at)
  ON channel_data.external_edit TO repracer_catalog;
GRANT SELECT ON channel_data.external_edit TO repracer_catalog;
CREATE POLICY catalog_external_edit ON channel_data.external_edit FOR ALL TO repracer_catalog
  USING (tenant_id = security.current_tenant_id()) WITH CHECK (tenant_id = security.current_tenant_id());
ALTER FUNCTION channel_data.record_channel_observations(uuid, uuid, jsonb) OWNER TO repracer_catalog;
REVOKE EXECUTE ON FUNCTION channel_data.record_channel_observations(uuid, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION channel_data.record_channel_observations(uuid, uuid, jsonb) TO repracer_app;

-- Ответ о других инструментах пишет человек административной ролью (права на аккаунт у неё есть; страж человека и аудит стоят с шага 17)
GRANT UPDATE (other_tools) ON tenant_data.channel_account TO repracer_admin;

CREATE OR REPLACE FUNCTION security.admin_write_action(p_table text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
AS $function$
  SELECT a FROM (VALUES
    ('tenant_data.tenant', 'MANAGE_TENANT'), ('tenant_data.channel_account', 'MANAGE_TENANT'), ('tenant_data.inbound_api_key', 'MANAGE_CATALOG'),
    ('tenant_data.channel_capability_override', 'MANAGE_TENANT'), ('tenant_data.price_daily_correction', 'MANAGE_TENANT'),
    ('tenant_data.write_scope', 'ENABLE_REPRICING'),
    ('tenant_data.cost_profile', 'MANAGE_PRICING'), ('tenant_data.min_price', 'MANAGE_PRICING'), ('tenant_data.max_price', 'MANAGE_PRICING'),
    ('tenant_data.cost_import', 'MANAGE_PRICING'),
    ('tenant_data.guardrail', 'MANAGE_PRICING'), ('tenant_data.pricing_strategy', 'MANAGE_PRICING'), ('channel_data.pricing_strategy_undercut', 'MANAGE_PRICING'),
    ('tenant_data.divergence_policy', 'MANAGE_PRICING'), ('channel_data.fee_estimate', 'MANAGE_PRICING'), ('tenant_data.product_vat_rate', 'MANAGE_PRICING'),
    ('channel_data.divergence_case', 'MANAGE_PRICING'),
    ('tenant_data.product', 'MANAGE_CATALOG'), ('tenant_data.bundle_component', 'MANAGE_CATALOG'), ('tenant_data.offer_mapping', 'MANAGE_CATALOG'),
    ('tenant_data.stock_source', 'MANAGE_CATALOG'), ('tenant_data.stock_pool', 'MANAGE_CATALOG'), ('tenant_data.stock_movement', 'MANAGE_CATALOG'),
    ('tenant_data.stock_allocation', 'MANAGE_CATALOG'), ('channel_data.reservation', 'MANAGE_CATALOG'), ('channel_data.order_return', 'MANAGE_CATALOG'), ('channel_data.sync_job', 'MANAGE_CATALOG'),
    ('channel_data.listing_migration_check', 'MANAGE_CATALOG'),
    ('tenant_data.migration_consent', 'GIVE_MIGRATION_CONSENT'), ('tenant_data.migration_consent_item', 'GIVE_MIGRATION_CONSENT'),
    ('tenant_data.migration_consent_revocation', 'GIVE_MIGRATION_CONSENT'),
    ('channel_data.pricing_halt', 'RELEASE_CHANNEL_HALT'),
    ('channel_data.channel_distrust', 'RELEASE_CHANNEL_DISTRUST'), ('channel_data.offer_channel_pricing', 'MANAGE_CATALOG'),
    ('tenant_data.discount_announcement', 'MANAGE_PRICING'),
    ('tenant_data.bulk_job', 'VIEW_PRICING'),
    ('tenant_data.onboarding_progress', 'MANAGE_PRICING'),
    -- Шаг 43 [Р-175]: канал подключает тот, кто управляет тенантом, — и запрос согласия, и полученный токен
    ('tenant_data.channel_authorization_request', 'MANAGE_TENANT'), ('tenant_data.channel_credential', 'MANAGE_TENANT'),
    ('tenant_data.channel_write_mode_change', 'OWN_GUARD'),
    -- Шаг 60 [Р-202]: у подтверждения записи количества СВОЙ страж ролей (только владелец)
    ('tenant_data.channel_quantity_writes_confirmation', 'OWN_GUARD'),
    ('tenant_data.price_stop', 'OWN_GUARD'), ('channel_data.pricing_halt_review', 'OWN_GUARD'), ('tenant_data.membership', 'OWN_GUARD'),
    ('channel_data.pricing_halt_sample', 'OWN_GUARD')
  ) AS t(tbl, a) WHERE tbl = p_table
$function$;

-- Подтверждение — административная запись человека, в аудите [Р-97]
CREATE TRIGGER a0_admin_write_person_insert BEFORE INSERT ON tenant_data.channel_quantity_writes_confirmation
  FOR EACH ROW EXECUTE FUNCTION security.require_person_for_admin_write();
CREATE TRIGGER zc_channel_quantity_writes_confirmation_audit AFTER INSERT ON tenant_data.channel_quantity_writes_confirmation
  FOR EACH ROW EXECUTE FUNCTION security.audit_admin_write();

-- Закрытие тенанта удаляет и новые таблицы (правило проверки схемы: каждая таблица тенанта и канала названа в очистке)
CREATE OR REPLACE FUNCTION maintenance.purge_tenant_channel_data(p_tenant_id uuid)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
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
    'channel_data.price_decision_snapshot_ref', 'channel_data.price_decision', 'channel_data.price_intent',
    'channel_data.observed_channel_state',
    'channel_data.observed_price_daily', 'channel_data.divergence_case', 'channel_data.competitor_state',
    'channel_data.fee_estimate',
    -- Шаг 59 [Р-199]: возвраты ссылаются на резервацию — удаляются раньше неё
    'channel_data.order_return', 'channel_data.reservation',
    -- Шаг 60 [Р-202]: внешние правки канала — данные канала тенанта
    'channel_data.external_edit', 'channel_data.sync_job',
    'channel_data.listing_migration_check', 'channel_data.write_submission',
    'channel_data.pricing_halt_sample', 'channel_data.pricing_halt_review', 'channel_data.pricing_halt',
    'channel_data.channel_distrust', 'channel_data.channel_quantity_current', 'channel_data.offer_channel_pricing', 'channel_data.inbound_notification',
    'channel_data.offer_pricing_health', 'channel_data.notification_loss_verdict', 'channel_data.notification_loss_check',
    'channel_data.competitor_poll_state', 'channel_data.competitor_snapshot_log', 'channel_data.competitor_move_latest',
    'channel_data.competitor_move', 'channel_data.competitor_price_daily', 'channel_data.floor_hold', 'channel_data.pricing_strategy_undercut',
    'channel_data.rejected_competitor_snapshot']
  LOOP
    EXECUTE format('DELETE FROM %s WHERE tenant_id = $1', t) USING p_tenant_id;
    GET DIAGNOSTICS n = ROW_COUNT;
    total := total + n;
  END LOOP;

  -- Шаг 25 (ревью, находка 10): пропуски выгрузки и их разбор хранят идентификаторы снимков тенанта
  DELETE FROM maintenance.snapshot_export_skip_resolution r
   USING maintenance.snapshot_export_skip s WHERE s.competitor_snapshot_id = r.competitor_snapshot_id AND s.subject_tenant_id = p_tenant_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  total := total + n;
  DELETE FROM maintenance.snapshot_export_skip WHERE subject_tenant_id = p_tenant_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  total := total + n;

  INSERT INTO maintenance.tenant_purge_status (subject_tenant_id, postgres_channel_purged_at)
  VALUES (p_tenant_id, now())
  ON CONFLICT (subject_tenant_id) DO UPDATE SET postgres_channel_purged_at = now();
  INSERT INTO maintenance.retention_run (table_name, action, rows_affected, subject_tenant_id)
  VALUES ('channel_data.*', 'TENANT_PURGED', total, p_tenant_id);
  RETURN total;
END $function$;

CREATE OR REPLACE FUNCTION maintenance.purge_tenant_data(p_tenant_id uuid)
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
  hold      text;
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
  /**
   * Шаг 59 [Р-201]: льготный период 30 суток после закрытия — клиент может вернуться или оспорить выгрузку; раньше ничего не удаляется
   */
  IF closed_ts > now() - interval '30 days' THEN
    RAISE EXCEPTION 'tenant % is in its 30-day grace period after closure until % (Р-201)', p_tenant_id, (closed_ts + interval '30 days')::date
      USING ERRCODE = 'check_violation';
  END IF;
  -- Удержание доказательств — только с основанием, записанным в аудит (maintenance.hold_price_evidence); пока оно действует, не удаляется ничего
  SELECT evidence_hold_reason INTO hold FROM maintenance.tenant_purge_status WHERE subject_tenant_id = p_tenant_id;
  IF hold IS NOT NULL THEN
    RAISE EXCEPTION 'price evidence of tenant % is held: % (Р-201)', p_tenant_id, hold USING ERRCODE = 'check_violation';
  END IF;
  -- Доказательства цен уходят только после ВЫГРУЗКИ клиенту: он уносит их с собой, у нас они не остаются
  IF (EXISTS (SELECT 1 FROM tenant_data.price_daily WHERE tenant_id = p_tenant_id)
      OR EXISTS (SELECT 1 FROM tenant_data.price_history WHERE tenant_id = p_tenant_id)
      OR EXISTS (SELECT 1 FROM tenant_data.discount_announcement WHERE tenant_id = p_tenant_id)
      OR EXISTS (SELECT 1 FROM tenant_data.price_intent_core WHERE tenant_id = p_tenant_id))
     AND NOT EXISTS (SELECT 1 FROM maintenance.tenant_purge_status WHERE subject_tenant_id = p_tenant_id AND evidence_exported_at IS NOT NULL) THEN
    RAISE EXCEPTION 'tenant % has price evidence not yet exported to the customer (Р-201)', p_tenant_id USING ERRCODE = 'check_violation';
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
    -- Шаг 34 [Р-149]: прогресс онбординга — данные тенанта
    -- Шаг 36 [Р-156]: алерты тенанта уходят вместе с ним
    -- Шаг 41 [Р-170]: журнал переключений теневого режима — данные тенанта, уходят вместе с ним
    'tenant_data.channel_write_mode_change',
    -- Шаг 60 [Р-202]: подтверждения записи количества — данные тенанта
    'tenant_data.channel_quantity_writes_confirmation',
    -- Шаг 42 [Р-174]: дайджест тени с отметкой доставки — данные тенанта (таблицу заводит 0130; список исполняется
    -- динамически, поэтому порядок миграций здесь ничего не ломает)
    'tenant_data.channel_discovery_circle', 'tenant_data.channel_credential', 'tenant_data.channel_authorization_request', 'tenant_data.shadow_digest',
    'tenant_data.alert',
    'tenant_data.onboarding_progress',
    -- Шаг 30 [Р-139]: задания массовых операций и их файлы — данные тенанта; удаляются раньше членства, на которое ссылаются
    'tenant_data.bulk_job_artifact', 'tenant_data.bulk_job',
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
