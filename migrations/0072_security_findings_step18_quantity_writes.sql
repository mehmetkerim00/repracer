-- 0072: шаг 19 — закрытие находок 1–7 ревью шага 18 и Р-105, Р-107.
--  1. Находка 1: в сессии административного сервиса любое изменение строки административной таблицы — от человека с ролью и в аудите
--     (в том числе статус единицы записи).
--  2. Находка 2, Р-101: элемент согласия добавляет только владелец, давший согласие, в той же транзакции, со вторым фактором и по
--     существующей предполётной проверке листинга; отзыв — только от своего имени, владельцем, со вторым фактором.
--  3. Р-107: ручной intent (trigger_type или rule_code MANUAL, автор-участник) вставляет только человек в административном сервисе.
--  4. Находка 4, Р-69: системную остановку административный сервис не создаёт (путь решения снятых остановок не вставляет — права по столбцам).
--  5. Находка 5, OQ-153: у роли хранения нет прямого удаления привязок; удаляет только функция роли repracer_identity_purger.
--  6. Находка 6: привязка входа принимается только в READ COMMITTED — иначе проверка единственности не видит конкурента.
--  7. Находка 7: скаляры на месте объектов слепка (элементы массивов причин и проверок, сам слепок) — отказ.
--  8. Р-105: роль остатков пишет в channel_write только поле QUANTITY — право ограничено видом поля политикой строк.

BEGIN;

-- 1 -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION security.require_person_for_admin_write() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  row_tenant uuid;
  u          uuid;
  r          text;
  action     text := security.admin_write_action(TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME);
  n          jsonb;
  o          jsonb;
BEGIN
  IF NOT security.admin_session() THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  -- Находка 1 ревью шага 18: в сессии административного сервиса любое изменение строки — административная операция, включая
  -- столбцы, которые путь решения тоже меняет (статус единицы записи); аргументы триггера — только перечень административных столбцов
  u := security.current_user_id();
  IF u IS NULL THEN
    RAISE EXCEPTION 'administrative change of %.% without a person: the administrative service writes only on an explicit action of a user (Р-97)',
      TG_TABLE_SCHEMA, TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'DELETE' THEN
    row_tenant := OLD.tenant_id;
  ELSE
    row_tenant := NEW.tenant_id;
  END IF;
  IF action IS NULL THEN
    RAISE EXCEPTION 'administrative change of %.%: no administrative action is declared for the table (Р-100)', TG_TABLE_SCHEMA, TG_TABLE_NAME
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Шаг 19 [Р-104]: проверка «пользователь — действующий участник тенанта строки» удалена как дубль. Мутационная проверка показала:
  -- без неё изменение постороннего (и строки платформенного тенанта, где участников нет) отклоняет журнал аудита — событие USER
  -- без членства не записывается (audit_event_check1), а административная запись без события не фиксируется (Р-97). Таблицы без
  -- общего аудита (остановки человеком, проверки остановок, членства) проверяют участника своими стражами.
  SELECT m.role INTO r FROM tenant_data.membership m WHERE m.tenant_id = row_tenant AND m.user_id = u AND m.status = 'ACTIVE';
  IF action <> 'OWN_GUARD' AND r IS NOT NULL AND NOT security.pricing_permission(r, action) THEN
    RAISE EXCEPTION 'administrative change of %.%: role % may not %, membership is not enough (Р-100, step 17 finding 1)', TG_TABLE_SCHEMA, TG_TABLE_NAME, r, action
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION security.audit_admin_write() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  r          jsonb;
  o          jsonb;
  u          uuid := security.current_user_id();
  row_tenant uuid;
  member     uuid;
  entity     text;
  cols       text[];
BEGIN
  IF NOT security.admin_session() THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'DELETE' THEN
    r := to_jsonb(OLD);
  ELSE
    r := to_jsonb(NEW);
  END IF;
  row_tenant := (r ->> 'tenant_id')::uuid;
  IF TG_OP = 'UPDATE' THEN
    o := to_jsonb(OLD);
    SELECT array_agg(k ORDER BY k) INTO cols FROM jsonb_object_keys(r) AS k WHERE r -> k IS DISTINCT FROM o -> k;
    -- Находка 1 ревью шага 18: в журнал попадает и изменение рабочих столбцов административным сервисом
  END IF;
  SELECT m.membership_id INTO member FROM tenant_data.membership m WHERE m.tenant_id = row_tenant AND m.user_id = u AND m.status = 'ACTIVE';
  SELECT r ->> a.attname INTO entity
    FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
   WHERE i.indrelid = TG_RELID AND i.indisprimary AND a.attname <> 'tenant_id' AND a.atttypid = 'uuid'::regtype
   ORDER BY a.attnum LIMIT 1;
  INSERT INTO audit.audit_event (tenant_id, occurred_at, actor_type, actor_user_id, actor_membership_id, action, entity_type, entity_id, changes)
  VALUES (row_tenant, now(), 'USER', u, member, 'admin_change.' || lower(TG_OP), TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME, entity::uuid,
          jsonb_build_object('columns', to_jsonb(cols), 'secondFactor', security.session_mfa(), 'at', now()));
  RETURN NULL;
END $$;

-- Замена сбрасывает атрибуты функций 0066/0068 (SECURITY DEFINER, search_path): восстанавливаются как в 0068
DO $$
DECLARE
  f regprocedure;
BEGIN
  FOREACH f IN ARRAY ARRAY['security.require_person_for_admin_write()', 'security.audit_admin_write()']::regprocedure[] LOOP
    EXECUTE format('ALTER FUNCTION %s SECURITY DEFINER SET search_path = pg_catalog, pg_temp', f);
    EXECUTE format('ALTER FUNCTION %s OWNER TO repracer_audit_writer', f);
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
END $$;

-- Р-104: из стража согласия (0068) убрана проверка «автор — владелец»: её дублирует общий страж роли GIVE_MIGRATION_CONSENT
-- (у сессии с автором = пользователь сессии обе проверки отклоняют одно и то же), и проверка действующего членства автора (её дублирует
-- тот же страж: пользователь сессии — действующий участник; пару членство–пользователь держит внешний ключ); остаются «от своего имени» и второй фактор
SET ROLE repracer_owner;
CREATE OR REPLACE FUNCTION tenant_data.migration_consent_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NOT security.superuser_session() AND (security.current_user_id() IS NULL OR NEW.user_id IS DISTINCT FROM security.current_user_id()) THEN
    RAISE EXCEPTION 'migration consent is given only by the session user in their own name (Р-101)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT security.superuser_session() AND NOT security.session_mfa() THEN
    RAISE EXCEPTION 'migration consent requires a second factor of the session (Р-101)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.given_at := now();
  NEW.mfa_verified_at := least(NEW.mfa_verified_at, NEW.given_at);
  RETURN NEW;
END $$;
RESET ROLE;

-- Р-104: channel_write_end_explained дублировала channel_write_history_end_explained — завершённая запись переносится в историю
-- тем же оператором, и без первого ограничения отказ даёт второе; оставлено ограничение истории (там запись хранится)
ALTER TABLE tenant_data.channel_write DROP CONSTRAINT channel_write_end_explained;
-- Р-104: price_decision_explanation_keys_declared дублировала price_intent_core_explanation_keys_declared — слепок есть только у
-- решения не NO_OP (price_decision_explanation_by_class), и каждое такое решение в той же вставке пишет тот же слепок в вечное ядро
-- (d_price_decision_record_core); без первого ограничения отказ даёт второе. Оставлено ограничение ядра (слепок хранится вечно там)
ALTER TABLE channel_data.price_decision DROP CONSTRAINT price_decision_explanation_keys_declared;

-- 2 -------------------------------------------------------------------------
SET ROLE repracer_owner;
CREATE FUNCTION tenant_data.migration_consent_item_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  c record;
BEGIN
  IF security.superuser_session() THEN
    RETURN NEW;
  END IF;
  SELECT mc.user_id, mc.given_at, mc.channel_account_id INTO c FROM tenant_data.migration_consent mc
   WHERE mc.tenant_id = NEW.tenant_id AND mc.migration_consent_id = NEW.migration_consent_id;
  IF c.user_id IS NULL OR c.user_id IS DISTINCT FROM security.current_user_id() THEN
    RAISE EXCEPTION 'a listing is added to a migration consent only by the owner who gave it (Р-101)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT security.session_mfa() THEN
    RAISE EXCEPTION 'adding a listing to a migration consent requires a second factor of the session (Р-101)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF c.given_at <> now() THEN
    RAISE EXCEPTION 'listings are added to a migration consent only in the transaction that gives it (Р-101)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM channel_data.listing_migration_check lc
                  WHERE lc.tenant_id = NEW.tenant_id AND lc.channel_account_id = c.channel_account_id AND lc.listing_id = NEW.listing_id
                    AND lc.listing_migration_check_id = NEW.listing_migration_check_id AND lc.listing_snapshot_sha256 = NEW.listing_snapshot_sha256) THEN
    RAISE EXCEPTION 'migration consent item for listing % refers to no preflight check of this listing (Р-101, Р-2)', NEW.listing_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER a00_migration_consent_item_guard BEFORE INSERT ON tenant_data.migration_consent_item
  FOR EACH ROW EXECUTE FUNCTION tenant_data.migration_consent_item_guard();

CREATE FUNCTION tenant_data.migration_consent_revocation_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  mem record;
BEGIN
  IF security.superuser_session() THEN
    RETURN NEW;
  END IF;
  SELECT m.membership_id, m.role INTO mem FROM tenant_data.membership m
   WHERE m.tenant_id = NEW.tenant_id AND m.user_id = security.current_user_id() AND m.status = 'ACTIVE';
  IF mem.membership_id IS NULL OR NEW.revoked_by_membership_id IS DISTINCT FROM mem.membership_id THEN
    RAISE EXCEPTION 'a migration consent is revoked only in the name of the session user (Р-101)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Роль (только владелец) проверяет общий страж административной записи (действие GIVE_MIGRATION_CONSENT): отдельная ветка здесь была
  -- недостижима своей причиной — страж роли срабатывает после этого, но отклоняет то же самое [Р-104]
  IF NOT security.session_mfa() THEN
    RAISE EXCEPTION 'revoking a migration consent requires a second factor of the session (Р-101)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER a00_migration_consent_revocation_guard BEFORE INSERT ON tenant_data.migration_consent_revocation
  FOR EACH ROW EXECUTE FUNCTION tenant_data.migration_consent_revocation_guard();

-- 3 -------------------------------------------------------------------------
CREATE FUNCTION channel_data.price_intent_manual_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  mem record;
BEGIN
  IF security.superuser_session() OR NOT (NEW.trigger_type = 'MANUAL' OR NEW.rule_code = 'MANUAL' OR NEW.created_by_membership_id IS NOT NULL) THEN
    RETURN NEW;
  END IF;
  -- Пользователь сессии есть только у административного сервиса (Р-90): у пути решения current_user_id() пуст, и intent отклоняет
  -- проверка «от своего имени» — отдельная проверка сервиса была бы недостижима своей причиной [Р-104]. Функция исполняется правами
  -- роли аудита (ниже): у пути решения нет чтения членств, и без этого отказ давало бы отсутствие права, а не страж
  SELECT m.membership_id, m.role INTO mem FROM tenant_data.membership m
   WHERE m.tenant_id = NEW.tenant_id AND m.user_id = security.current_user_id() AND m.status = 'ACTIVE';
  IF mem.membership_id IS NULL OR NEW.created_by_membership_id IS DISTINCT FROM mem.membership_id THEN
    RAISE EXCEPTION 'a manual price intent is created only by a person in the administrative service in the name of the session user, not by the decision path (Р-107)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT security.pricing_permission(mem.role, 'ENABLE_REPRICING') THEN
    RAISE EXCEPTION 'role % may not set a manual price (Р-107)', mem.role USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER a00_price_intent_manual_guard BEFORE INSERT ON channel_data.price_intent
  FOR EACH ROW EXECUTE FUNCTION channel_data.price_intent_manual_guard();

-- 4 -------------------------------------------------------------------------
CREATE FUNCTION channel_data.pricing_halt_insert_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF security.superuser_session() THEN
    RETURN NEW;
  END IF;
  IF security.admin_session() THEN
    RAISE EXCEPTION 'a person does not create a system halt: it is set by the input checks of the decision path (Р-69, step 18 finding 4)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Вставку уже снятой остановки путём решения отклоняют права по столбцам (0068): отдельная проверка была бы недостижимой [Р-94]
  RETURN NEW;
END $$;
CREATE TRIGGER a00_pricing_halt_insert_guard BEFORE INSERT ON channel_data.pricing_halt
  FOR EACH ROW EXECUTE FUNCTION channel_data.pricing_halt_insert_guard();
RESET ROLE;
ALTER FUNCTION channel_data.price_intent_manual_guard() SECURITY DEFINER SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION channel_data.price_intent_manual_guard() OWNER TO repracer_audit_writer;
REVOKE EXECUTE ON FUNCTION channel_data.price_intent_manual_guard() FROM PUBLIC;
-- Секции price_intent создаёт maintenance.ensure_partitions правами владельца схемы: при создании секции копируются триггеры,
-- что требует права исполнения функции триггера
GRANT EXECUTE ON FUNCTION channel_data.price_intent_manual_guard() TO repracer_owner;

CREATE OR REPLACE FUNCTION security.decision_path_allowed_privileges()
  RETURNS TABLE (table_name text, privilege text, column_name text)
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT t, p, c FROM (VALUES
    ('platform.marketplace', 'SELECT', NULL), ('platform.fx_rate', 'SELECT', NULL), ('platform.explanation_ruleset', 'SELECT', NULL),
    ('platform.channel_capability', 'SELECT', NULL), ('platform.vat_rate_default', 'SELECT', NULL),
    -- лимит правок аккаунта для бюджета записи (0008, channel_write_budget)
    ('tenant_data.channel_capability_override', 'SELECT', NULL),
    ('tenant_data.tenant', 'SELECT', NULL), ('tenant_data.channel_account', 'SELECT', NULL), ('tenant_data.product', 'SELECT', NULL),
    ('tenant_data.product_vat_rate', 'SELECT', NULL), ('tenant_data.offer_mapping', 'SELECT', NULL), ('tenant_data.pricing_strategy', 'SELECT', NULL),
    ('channel_data.pricing_strategy_undercut', 'SELECT', NULL), ('tenant_data.min_price', 'SELECT', NULL), ('tenant_data.max_price', 'SELECT', NULL),
    ('tenant_data.guardrail', 'SELECT', NULL), ('tenant_data.cost_profile', 'SELECT', NULL), ('channel_data.fee_estimate', 'SELECT', NULL),
    ('tenant_data.price_stop', 'SELECT', NULL), ('channel_data.pricing_halt_review', 'SELECT', NULL),
    ('tenant_data.write_scope', 'SELECT', NULL), ('tenant_data.write_scope', 'UPDATE', 'status'),
    ('tenant_data.write_scope_sync_state', 'SELECT', NULL), ('tenant_data.write_scope_sync_state', 'INSERT', NULL), ('tenant_data.write_scope_sync_state', 'UPDATE', NULL),
    ('channel_data.competitor_state', 'SELECT', NULL), ('channel_data.competitor_state', 'INSERT', NULL), ('channel_data.competitor_state', 'UPDATE', NULL),
    ('channel_data.competitor_move', 'SELECT', NULL), ('channel_data.competitor_move', 'INSERT', NULL),
    ('channel_data.competitor_move_latest', 'SELECT', NULL), ('channel_data.competitor_move_latest', 'INSERT', NULL), ('channel_data.competitor_move_latest', 'UPDATE', NULL),
    ('channel_data.competitor_price_daily', 'SELECT', NULL), ('channel_data.competitor_price_daily', 'INSERT', NULL), ('channel_data.competitor_price_daily', 'UPDATE', NULL),
    ('channel_data.rejected_competitor_snapshot', 'SELECT', NULL), ('channel_data.rejected_competitor_snapshot', 'INSERT', NULL),
    ('channel_data.divergence_case', 'SELECT', NULL),
    -- Р-100: путь решения открывает случай расхождения; разрешение (resolution, resolved_*, status) — действие человека
    ('channel_data.divergence_case', 'INSERT', 'tenant_id'), ('channel_data.divergence_case', 'INSERT', 'write_scope_id'), ('channel_data.divergence_case', 'INSERT', 'field'), ('channel_data.divergence_case', 'INSERT', 'expected_amount_minor'), ('channel_data.divergence_case', 'INSERT', 'observed_amount_minor'), ('channel_data.divergence_case', 'INSERT', 'cause'), ('channel_data.divergence_case', 'INSERT', 'opened_at'),
    ('channel_data.observed_channel_state', 'SELECT', NULL), ('channel_data.observed_channel_state', 'INSERT', NULL), ('channel_data.observed_channel_state', 'UPDATE', NULL),
    ('channel_data.observed_price_daily', 'SELECT', NULL), ('channel_data.observed_price_daily', 'INSERT', NULL), ('channel_data.observed_price_daily', 'UPDATE', NULL),
    ('channel_data.price_intent', 'SELECT', NULL), ('channel_data.price_intent', 'INSERT', NULL),
    ('channel_data.price_decision', 'SELECT', NULL), ('channel_data.price_decision', 'INSERT', NULL),
    ('channel_data.price_decision_snapshot_ref', 'SELECT', NULL), ('channel_data.price_decision_snapshot_ref', 'INSERT', NULL),
    ('tenant_data.price_intent_core', 'INSERT', NULL),
    ('tenant_data.channel_write', 'SELECT', NULL), ('tenant_data.channel_write', 'INSERT', NULL), ('tenant_data.channel_write', 'UPDATE', NULL), ('tenant_data.channel_write', 'DELETE', NULL),
    ('tenant_data.channel_write_history', 'SELECT', NULL), ('tenant_data.channel_write_history', 'INSERT', NULL),
    ('channel_data.write_submission', 'SELECT', NULL), ('channel_data.write_submission', 'INSERT', NULL), ('channel_data.write_submission', 'UPDATE', NULL), ('channel_data.write_submission', 'DELETE', NULL),
    ('tenant_data.edit_budget', 'SELECT', NULL), ('tenant_data.edit_budget', 'INSERT', NULL), ('tenant_data.edit_budget', 'UPDATE', NULL),
    ('tenant_data.outbox_event', 'INSERT', NULL), ('tenant_data.price_history', 'SELECT', NULL), ('tenant_data.price_history', 'INSERT', NULL),
    ('channel_data.pricing_halt', 'SELECT', NULL),
    -- Р-100: путь решения ставит системную остановку; снятие, срок проверки и окно — не его столбцы (находка 4 ревью шага 17)
    ('channel_data.pricing_halt', 'INSERT', 'tenant_id'), ('channel_data.pricing_halt', 'INSERT', 'channel_account_id'), ('channel_data.pricing_halt', 'INSERT', 'channel'), ('channel_data.pricing_halt', 'INSERT', 'marketplace'), ('channel_data.pricing_halt', 'INSERT', 'reason_code'), ('channel_data.pricing_halt', 'INSERT', 'rejected_snapshot_id'), ('channel_data.pricing_halt', 'INSERT', 'details'), ('channel_data.pricing_halt', 'INSERT', 'halted_at'), ('channel_data.pricing_halt', 'INSERT', 'review_window'),
    ('channel_data.pricing_halt_sample', 'SELECT', NULL),
    ('channel_data.pricing_halt_sample', 'INSERT', 'tenant_id'), ('channel_data.pricing_halt_sample', 'INSERT', 'pricing_halt_id'), ('channel_data.pricing_halt_sample', 'INSERT', 'channel_product_ref'), ('channel_data.pricing_halt_sample', 'INSERT', 'observed_at'), ('channel_data.pricing_halt_sample', 'INSERT', 'verdict'), ('channel_data.pricing_halt_sample', 'INSERT', 'reason_code')
  ) AS a(t, p, c)
$$;
GRANT INSERT (review_window) ON channel_data.pricing_halt TO repracer_app;

-- 5 -------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'repracer_identity_purger') THEN
    CREATE ROLE repracer_identity_purger NOLOGIN NOBYPASSRLS;
  END IF;
END $$;
DROP POLICY retention_user_identity ON platform.external_identity;
DROP POLICY retention_user_identity ON platform.external_identity_revocation;
REVOKE ALL ON platform.external_identity, platform.external_identity_revocation FROM repracer_retention;
REVOKE SELECT (user_id, status) ON platform.app_user FROM repracer_retention;
GRANT USAGE ON SCHEMA platform, maintenance TO repracer_identity_purger;
GRANT SELECT, DELETE ON platform.external_identity, platform.external_identity_revocation TO repracer_identity_purger;
GRANT SELECT (user_id, status) ON platform.app_user TO repracer_identity_purger;
CREATE POLICY identity_purger ON platform.external_identity FOR ALL TO repracer_identity_purger USING (true);
CREATE POLICY identity_purger ON platform.external_identity_revocation FOR ALL TO repracer_identity_purger USING (true);
CREATE POLICY identity_purger ON platform.app_user FOR SELECT TO repracer_identity_purger USING (true);
ALTER FUNCTION maintenance.purge_user_identities(uuid) OWNER TO repracer_identity_purger;
GRANT EXECUTE ON FUNCTION maintenance.purge_user_identities(uuid) TO repracer_retention;

-- Неизменяемость: удаление разрешено роли хранения (сроки) и роли удаления привязок (только её функцией, входа у роли нет)
CREATE OR REPLACE FUNCTION security.forbid_mutation() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_user IN ('repracer_retention', 'repracer_identity_purger') THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'append-only table %.%: % is forbidden', TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END $$;

-- 6 -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION platform.external_identity_one_active() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  -- Находка 6 ревью шага 18: блокировка сериализует проверку только в READ COMMITTED — снимок более строгой изоляции не видит
  -- привязку, зафиксированную конкурирующей транзакцией после его начала
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'a sign-in of user % is linked only in READ COMMITTED (got %): one active sign-in per issuer (Р-98)', NEW.user_id, current_setting('transaction_isolation')
      USING ERRCODE = 'serialization_failure';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('platform.external_identity:' || NEW.user_id::text || ':' || NEW.issuer, 0));
  IF EXISTS (SELECT 1 FROM platform.external_identity e
              WHERE e.user_id = NEW.user_id AND e.issuer = NEW.issuer AND e.subject <> NEW.subject
                AND NOT EXISTS (SELECT 1 FROM platform.external_identity_revocation rv WHERE rv.issuer = e.issuer AND rv.subject = e.subject)) THEN
    RAISE EXCEPTION 'user % already has an active sign-in of issuer % (Р-98)', NEW.user_id, NEW.issuer USING ERRCODE = 'unique_violation';
  END IF;
  RETURN NEW;
END $$;
-- CREATE OR REPLACE сбрасывает SECURITY DEFINER и search_path: 0069 на шаге 18 так лишила эту функцию атрибутов 0066 незаметно —
-- проверка схемы 0073 сверяет атрибуты функций защит
ALTER FUNCTION platform.external_identity_one_active() SECURITY DEFINER SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION platform.external_identity_one_active() OWNER TO repracer_resolver;
REVOKE EXECUTE ON FUNCTION platform.external_identity_one_active() FROM PUBLIC;

-- 7 -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION security.explanation_node_declared(node jsonb, path text, p_competitor_derived boolean) RETURNS boolean
  LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  shape   jsonb := security.explanation_shape();
  fields  jsonb := security.explanation_field_kinds();
  kinds   jsonb;
  k       text;
  v       jsonb;
BEGIN
  IF node IS NULL THEN
    RETURN true;
  END IF;
  -- Находка 7 ревью шага 18: скаляр на месте объекта (сам слепок, элемент массива причин или проверок) — отказ, а не «без проверки»
  IF jsonb_typeof(node) NOT IN ('object', 'array') THEN
    RETURN false;
  END IF;
  IF jsonb_typeof(node) = 'array' THEN
    FOR v IN SELECT value FROM jsonb_array_elements(node) LOOP
      -- Скалярный элемент отклоняет рекурсивный вызов (проверка скаляра выше) — отдельная проверка вида элемента была бы дублем [Р-104]
      IF NOT security.explanation_node_declared(v, path || '[]', p_competitor_derived) THEN
        RETURN false;
      END IF;
    END LOOP;
    RETURN true;
  END IF;
  IF (shape -> 'reasons') ? path THEN
    IF jsonb_typeof(node -> 'code') IS DISTINCT FROM 'string' OR NOT security.eternal_param_keys() ? (node ->> 'code') THEN
      RETURN false;
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_object_keys(node) AS key WHERE key NOT IN ('code', 'params', 'withheld')) THEN
      RETURN false;
    END IF;
    IF node ? 'params' THEN
      IF jsonb_typeof(node -> 'params') <> 'object' THEN
        RETURN false;
      END IF;
      kinds := security.eternal_param_kinds() -> (node ->> 'code');
      FOR k, v IN SELECT key, value FROM jsonb_each(node -> 'params') LOOP
        IF NOT (security.eternal_param_keys() -> (node ->> 'code')) ? k OR (p_competitor_derived AND k = ANY (security.channel_rule_derived_param_keys()))
           OR NOT security.param_value_valid(v, kinds -> k) THEN
          RETURN false;
        END IF;
      END LOOP;
    END IF;
    IF node ? 'withheld' AND (jsonb_typeof(node -> 'withheld') <> 'array'
                              OR EXISTS (SELECT 1 FROM jsonb_array_elements(node -> 'withheld') w
                                          WHERE jsonb_typeof(w.value) <> 'string' OR (w.value #>> '{}') !~ '^[A-Za-z][A-Za-z0-9_]{0,63}$')) THEN
      RETURN false;
    END IF;
    RETURN true;
  END IF;
  IF NOT shape ? path OR path = 'reasons' THEN
    RETURN false;
  END IF;
  -- Формат — поле с видом enum ['r80.1'] (реестр полей); отдельной проверки нет: мутационная проверка показала, что она дублировала вид поля
  IF path = '$' AND NOT node ? 'format' THEN
    RETURN false;
  END IF;
  FOR k, v IN SELECT key, value FROM jsonb_each(node) LOOP
    IF NOT (shape -> path) ? k THEN
      RETURN false;
    END IF;
    -- Находка 8: скалярное поле и массив скаляров проверяются по виду; объекты и массивы объектов — по форме, рекурсивно
    -- (массив — по форме, если форма объявляет его элементы, даже пустой; иначе это массив скаляров с видом, как anchorsUsed)
    IF jsonb_typeof(v) = 'object'
       OR (jsonb_typeof(v) = 'array' AND (shape ? (path || '.' || k || '[]') OR (shape -> 'reasons') ? (path || '.' || k || '[]'))) THEN
      IF NOT security.explanation_node_declared(v, path || '.' || k, p_competitor_derived) THEN
        RETURN false;
      END IF;
    ELSIF NOT security.param_value_valid(v, fields -> (path || '.' || k)) THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
END $$;

-- 8 -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION security.stock_path_allowed_privileges()
  RETURNS TABLE (table_name text, privilege text, column_name text)
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT t, p, c FROM (VALUES
    ('tenant_data.product', 'SELECT', NULL), ('tenant_data.stock_source', 'SELECT', NULL), ('tenant_data.stock_allocation', 'SELECT', NULL),
    ('tenant_data.stock_pool', 'SELECT', NULL), ('tenant_data.stock_pool', 'INSERT', NULL), ('tenant_data.stock_pool', 'UPDATE', NULL),
    ('tenant_data.stock_movement', 'SELECT', NULL), ('tenant_data.stock_movement', 'INSERT', NULL),
    ('channel_data.reservation', 'SELECT', NULL), ('channel_data.reservation', 'INSERT', NULL), ('channel_data.reservation', 'UPDATE', NULL),
    -- Р-105: запись остатка в канал — только поле QUANTITY (политика строк по виду поля); таблицы, которые читают и пишут триггеры записи
    ('tenant_data.channel_write', 'SELECT', NULL), ('tenant_data.channel_write', 'INSERT', NULL), ('tenant_data.channel_write', 'UPDATE', NULL),
    ('tenant_data.channel_write_history', 'SELECT', NULL), ('tenant_data.channel_write_history', 'INSERT', NULL),
    -- UPDATE (status): триггер записи блокирует единицу FOR SHARE, а это требует права UPDATE хотя бы на один столбец; сменить статус
    -- роль может только как путь решения — ACTIVE → BLOCKED (страж 0068), и только у единицы остатка (политика)
    ('tenant_data.write_scope', 'SELECT', NULL), ('tenant_data.write_scope', 'UPDATE', 'status'),
    ('tenant_data.write_scope_sync_state', 'SELECT', NULL), ('tenant_data.write_scope_sync_state', 'INSERT', NULL), ('tenant_data.write_scope_sync_state', 'UPDATE', NULL),
    ('tenant_data.edit_budget', 'SELECT', NULL), ('tenant_data.edit_budget', 'INSERT', NULL), ('tenant_data.edit_budget', 'UPDATE', NULL),
    ('tenant_data.outbox_event', 'INSERT', NULL),
    ('tenant_data.channel_account', 'SELECT', NULL), ('tenant_data.offer_mapping', 'SELECT', NULL), ('tenant_data.channel_capability_override', 'SELECT', NULL),
    ('platform.channel_capability', 'SELECT', NULL), ('platform.marketplace', 'SELECT', NULL)
  ) AS a(t, p, c)
$$;

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT * FROM security.stock_path_allowed_privileges() LOOP
    EXECUTE format('GRANT %s%s ON %s TO repracer_stock', r.privilege, coalesce(' (' || r.column_name || ')', ''), r.table_name);
  END LOOP;
END $$;
GRANT USAGE ON SCHEMA platform TO repracer_stock;
-- Политики: запись и история — только поле QUANTITY; единица записи — только остатка; остальное — тенант
CREATE POLICY stock_quantity ON tenant_data.channel_write TO repracer_stock
  USING (tenant_id = security.current_tenant_id() AND field = 'QUANTITY') WITH CHECK (tenant_id = security.current_tenant_id() AND field = 'QUANTITY');
CREATE POLICY stock_quantity ON tenant_data.channel_write_history TO repracer_stock
  USING (tenant_id = security.current_tenant_id() AND field = 'QUANTITY') WITH CHECK (tenant_id = security.current_tenant_id() AND field = 'QUANTITY');
CREATE POLICY stock_quantity ON tenant_data.write_scope FOR SELECT TO repracer_stock USING (tenant_id = security.current_tenant_id() AND field = 'QUANTITY');
CREATE POLICY stock_quantity_lock ON tenant_data.write_scope FOR UPDATE TO repracer_stock
  USING (tenant_id = security.current_tenant_id() AND field = 'QUANTITY') WITH CHECK (tenant_id = security.current_tenant_id() AND field = 'QUANTITY');
CREATE POLICY stock_quantity ON tenant_data.write_scope_sync_state TO repracer_stock
  USING (tenant_id = security.current_tenant_id() AND EXISTS (SELECT 1 FROM tenant_data.write_scope s
         WHERE s.tenant_id = write_scope_sync_state.tenant_id AND s.write_scope_id = write_scope_sync_state.write_scope_id AND s.field = 'QUANTITY'))
  WITH CHECK (tenant_id = security.current_tenant_id() AND EXISTS (SELECT 1 FROM tenant_data.write_scope s
         WHERE s.tenant_id = write_scope_sync_state.tenant_id AND s.write_scope_id = write_scope_sync_state.write_scope_id AND s.field = 'QUANTITY'));
CREATE POLICY stock_tenant ON tenant_data.edit_budget TO repracer_stock USING (tenant_id = security.current_tenant_id()) WITH CHECK (tenant_id = security.current_tenant_id());
CREATE POLICY stock_tenant ON tenant_data.outbox_event FOR INSERT TO repracer_stock WITH CHECK (tenant_id = security.current_tenant_id());
CREATE POLICY stock_tenant ON tenant_data.channel_account FOR SELECT TO repracer_stock USING (tenant_id = security.current_tenant_id());
CREATE POLICY stock_tenant ON tenant_data.offer_mapping FOR SELECT TO repracer_stock USING (tenant_id = security.current_tenant_id());
CREATE POLICY stock_tenant ON tenant_data.channel_capability_override FOR SELECT TO repracer_stock USING (tenant_id = security.current_tenant_id());
CREATE POLICY stock_read ON platform.channel_capability FOR SELECT TO repracer_stock USING (true);
CREATE POLICY stock_read ON platform.marketplace FOR SELECT TO repracer_stock USING (true);

COMMIT;
