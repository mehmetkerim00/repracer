-- 0068: шаг 18 — согласие eBay только от владельца от своего имени со вторым фактором (Р-101); страж административной записи
-- по столбцам и с проверкой роли (Р-100, находка 1 ревью шага 17); права пути решения по столбцам и только безопасный переход
-- статуса единицы записи (находка 4); перенос срока проверки остановки — ролью снятия, со вторым фактором и в аудите (находка 5);
-- строки платформенного тенанта не пишутся административным сервисом (находка 9); недостижимая ветка стража снятия удалена (OQ-154).

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Матрица прав: административные действия получают имена (код — policy.ts, совпадение проверяет step14.pg.test.ts)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION security.pricing_permission(p_role text, p_action text) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT coalesce(p_role = ANY (CASE p_action
    WHEN 'VIEW_PRICING'           THEN ARRAY['OWNER', 'ADMIN', 'OPERATOR', 'PRICING_MANAGER', 'INVENTORY_MANAGER', 'VIEWER']
    WHEN 'STOP_PRICING'           THEN ARRAY['OWNER', 'ADMIN', 'OPERATOR', 'PRICING_MANAGER']
    WHEN 'RESUME_TENANT_STOP'     THEN ARRAY['OWNER', 'ADMIN']
    WHEN 'RESUME_CHANNEL_STOP'    THEN ARRAY['OWNER', 'ADMIN', 'OPERATOR', 'PRICING_MANAGER']
    WHEN 'RELEASE_CHANNEL_HALT'   THEN ARRAY['OWNER', 'ADMIN', 'OPERATOR', 'PRICING_MANAGER']
    WHEN 'ENABLE_REPRICING'       THEN ARRAY['OWNER', 'ADMIN', 'OPERATOR', 'PRICING_MANAGER']
    WHEN 'MANAGE_PRICING'         THEN ARRAY['OWNER', 'ADMIN', 'PRICING_MANAGER']
    WHEN 'MANAGE_CATALOG'         THEN ARRAY['OWNER', 'ADMIN', 'INVENTORY_MANAGER']
    WHEN 'MANAGE_TENANT'          THEN ARRAY['OWNER', 'ADMIN']
    WHEN 'GIVE_MIGRATION_CONSENT' THEN ARRAY['OWNER']
    ELSE ARRAY[]::text[] END), false)
$$;

-- Действие, которым является административная запись в таблицу; NULL — таблица не объявлена (страж отказывает, fail-closed).
-- OWN_GUARD — у таблицы собственный страж ролей (остановки, записи проверки, членства)
CREATE FUNCTION security.admin_write_action(p_table text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
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
    ('tenant_data.price_stop', 'OWN_GUARD'), ('channel_data.pricing_halt_review', 'OWN_GUARD'), ('tenant_data.membership', 'OWN_GUARD'),
    ('channel_data.pricing_halt_sample', 'OWN_GUARD')
  ) AS t(tbl, a) WHERE tbl = p_table
$$;

-- ---------------------------------------------------------------------------
-- 2. Р-100: права пути решения по столбцам (pricing_halt, divergence_case)
-- ---------------------------------------------------------------------------
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
    ('channel_data.pricing_halt', 'INSERT', 'tenant_id'), ('channel_data.pricing_halt', 'INSERT', 'channel_account_id'), ('channel_data.pricing_halt', 'INSERT', 'channel'), ('channel_data.pricing_halt', 'INSERT', 'marketplace'), ('channel_data.pricing_halt', 'INSERT', 'reason_code'), ('channel_data.pricing_halt', 'INSERT', 'rejected_snapshot_id'), ('channel_data.pricing_halt', 'INSERT', 'details'), ('channel_data.pricing_halt', 'INSERT', 'halted_at'),
    ('channel_data.pricing_halt_sample', 'SELECT', NULL),
    ('channel_data.pricing_halt_sample', 'INSERT', 'tenant_id'), ('channel_data.pricing_halt_sample', 'INSERT', 'pricing_halt_id'), ('channel_data.pricing_halt_sample', 'INSERT', 'channel_product_ref'), ('channel_data.pricing_halt_sample', 'INSERT', 'observed_at'), ('channel_data.pricing_halt_sample', 'INSERT', 'verdict'), ('channel_data.pricing_halt_sample', 'INSERT', 'reason_code')
  ) AS a(t, p, c)
$$;

REVOKE INSERT, UPDATE ON channel_data.pricing_halt, channel_data.divergence_case FROM repracer_app;
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT * FROM security.decision_path_allowed_privileges()
            WHERE table_name IN ('channel_data.pricing_halt', 'channel_data.divergence_case') AND column_name IS NOT NULL LOOP
    EXECUTE format('GRANT %s (%I) ON %s TO repracer_app', r.privilege, r.column_name, r.table_name);
  END LOOP;
END $$;

-- Административная запись: столбцы, которые путь решения менять не может. INSERT и DELETE — строкой целиком (admin_columns NULL);
-- UPDATE, если путь решения имеет право только на часть столбцов, — только эти столбцы админские (Р-100, находка 1)
DROP FUNCTION security.admin_only_writes();
CREATE FUNCTION security.admin_only_writes() RETURNS TABLE (table_name regclass, privilege text, admin_columns text[])
  LANGUAGE sql STABLE AS $$
  SELECT tr.table_name, p.privilege,
         CASE WHEN p.privilege = 'UPDATE' AND EXISTS (SELECT 1 FROM security.decision_path_allowed_privileges() al
                                                        WHERE al.table_name::regclass = tr.table_name AND al.privilege = 'UPDATE')
              THEN (SELECT array_agg(a.attname::text ORDER BY a.attname) FROM pg_attribute a
                     WHERE a.attrelid = tr.table_name AND a.attnum > 0 AND NOT a.attisdropped
                       AND NOT EXISTS (SELECT 1 FROM security.decision_path_allowed_privileges() al
                                        WHERE al.table_name::regclass = tr.table_name AND al.privilege = 'UPDATE' AND al.column_name = a.attname::text))
         END
    FROM security.table_registry tr CROSS JOIN unnest(ARRAY['INSERT', 'UPDATE', 'DELETE']) AS p(privilege)
   WHERE (has_table_privilege('repracer_admin', tr.table_name, p.privilege)
          OR CASE WHEN p.privilege = 'DELETE' THEN false
                  ELSE EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = tr.table_name AND a.attnum > 0 AND NOT a.attisdropped
                                 AND has_column_privilege('repracer_admin', tr.table_name, a.attnum, p.privilege)) END)
     AND NOT EXISTS (SELECT 1 FROM security.decision_path_allowed_privileges() al
                      WHERE al.table_name::regclass = tr.table_name AND al.privilege = p.privilege AND al.column_name IS NULL)
$$;

-- ---------------------------------------------------------------------------
-- 3. Страж и аудит административной записи: по столбцам, с ролью; платформенные строки — отказ
-- ---------------------------------------------------------------------------
SET ROLE repracer_owner;
CREATE FUNCTION security.superuser_session() RETURNS boolean
  LANGUAGE sql STABLE PARALLEL SAFE AS $$ SELECT coalesce((SELECT r.rolsuper FROM pg_roles r WHERE r.rolname = session_user), false) $$;
RESET ROLE;
-- Функции стража и аудита принадлежат repracer_audit_writer (0066): заменяются от суперпользователя, владелец сохраняется

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
  -- Р-100: изменение только столбцов пути решения — не административная операция
  IF TG_OP = 'UPDATE' AND TG_NARGS > 0 THEN
    n := to_jsonb(NEW);
    o := to_jsonb(OLD);
    IF NOT EXISTS (SELECT 1 FROM jsonb_object_keys(n) AS k WHERE n -> k IS DISTINCT FROM o -> k AND k = ANY (TG_ARGV)) THEN
      RETURN NEW;
    END IF;
  END IF;
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
  IF row_tenant = security.platform_tenant_id() THEN
    RAISE EXCEPTION 'administrative change of %.% in the platform tenant: it belongs to no member (step 17 finding 9)', TG_TABLE_SCHEMA, TG_TABLE_NAME
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT m.role INTO r FROM tenant_data.membership m WHERE m.tenant_id = row_tenant AND m.user_id = u AND m.status = 'ACTIVE';
  IF r IS NULL THEN
    RAISE EXCEPTION 'administrative change of %.% by user % who is not an active member of tenant % (Р-97)', TG_TABLE_SCHEMA, TG_TABLE_NAME, u, row_tenant
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF action IS NULL THEN
    RAISE EXCEPTION 'administrative change of %.%: no administrative action is declared for the table (Р-100)', TG_TABLE_SCHEMA, TG_TABLE_NAME
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF action <> 'OWN_GUARD' AND NOT security.pricing_permission(r, action) THEN
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
    -- Р-100: изменение только столбцов пути решения в журнал административных действий не пишется
    IF TG_NARGS > 0 AND NOT cols && TG_ARGV THEN
      RETURN NULL;
    END IF;
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
GRANT EXECUTE ON FUNCTION security.superuser_session(), security.admin_write_action(text) TO repracer_audit_writer, repracer_app;

GRANT EXECUTE ON FUNCTION security.admin_only_writes() TO repracer_admin;

-- Триггеры пересоздаются по новому составу: на операцию — свой триггер, у UPDATE аргументы — административные столбцы
DO $$
DECLARE
  t record;
  r record;
  args text;
BEGIN
  FOR t IN SELECT tg.tgname, tg.tgrelid::regclass AS rel FROM pg_trigger tg
            WHERE tg.tgfoid IN ('security.require_person_for_admin_write()'::regprocedure, 'security.audit_admin_write()'::regprocedure) AND NOT tg.tgisinternal LOOP
    EXECUTE format('DROP TRIGGER %I ON %s', t.tgname, t.rel);
  END LOOP;
  FOR r IN SELECT * FROM security.admin_only_writes() LOOP
    args := coalesce((SELECT string_agg(quote_literal(c), ', ') FROM unnest(r.admin_columns) AS c), '');
    EXECUTE format('CREATE TRIGGER a0_admin_write_person_%s BEFORE %s ON %s FOR EACH ROW EXECUTE FUNCTION security.require_person_for_admin_write(%s)',
                   lower(r.privilege), r.privilege, r.table_name, args);
    -- Собственный аудит — у остановок человеком, записей проверки и членств; UPDATE системной остановки (срок проверки) — в общем аудите (находка 5)
    IF r.table_name NOT IN ('tenant_data.price_stop'::regclass, 'channel_data.pricing_halt_review'::regclass, 'tenant_data.membership'::regclass)
       AND NOT (r.table_name = 'channel_data.pricing_halt'::regclass AND r.privilege = 'INSERT') THEN
      EXECUTE format('CREATE TRIGGER zz_admin_write_audit_%s AFTER %s ON %s FOR EACH ROW EXECUTE FUNCTION security.audit_admin_write(%s)',
                     lower(r.privilege), r.privilege, r.table_name, args);
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 4. Р-101: согласие на миграцию eBay — владелец, от своего имени, со вторым фактором сессии
-- ---------------------------------------------------------------------------
SET ROLE repracer_owner;
CREATE OR REPLACE FUNCTION tenant_data.migration_consent_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  -- Р-101: действие необратимо — после миграции продавец навсегда теряет управление настройками Best Offer
  IF NOT security.superuser_session() AND (security.current_user_id() IS NULL OR NEW.user_id IS DISTINCT FROM security.current_user_id()) THEN
    RAISE EXCEPTION 'migration consent is given only by the session user in their own name (Р-101)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM tenant_data.membership
                  WHERE tenant_id = NEW.tenant_id AND membership_id = NEW.membership_id AND user_id = NEW.user_id
                    AND role = 'OWNER' AND status = 'ACTIVE') THEN
    RAISE EXCEPTION 'migration consent requires an ACTIVE OWNER (Р-101)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT security.superuser_session() AND NOT security.session_mfa() THEN
    RAISE EXCEPTION 'migration consent requires a second factor of the session (Р-101)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.given_at := now();
  NEW.mfa_verified_at := least(NEW.mfa_verified_at, NEW.given_at);
  RETURN NEW;
END $$;
RESET ROLE;
-- Р-94: страж согласия срабатывает раньше общего стража роли (a0_admin_write_person_insert), иначе его причины («от своего имени»,
-- «второй фактор») недостижимы для не-владельца — отказ давала бы проверка роли
ALTER TRIGGER migration_consent_guard ON tenant_data.migration_consent RENAME TO a00_migration_consent_guard;

-- ---------------------------------------------------------------------------
-- 5. Находка 4: путь решения только блокирует действующую единицу записи
-- ---------------------------------------------------------------------------
SET ROLE repracer_owner;
CREATE FUNCTION tenant_data.write_scope_path_status_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT security.admin_session() AND NOT security.superuser_session()
     AND NOT (OLD.status = 'ACTIVE' AND NEW.status = 'BLOCKED') THEN
    RAISE EXCEPTION 'write scope % status % -> %: the decision path only blocks an active write scope; holding and unblocking are actions of a person (step 17 finding 4)',
      NEW.write_scope_id, OLD.status, NEW.status USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER a1_write_scope_path_status_guard BEFORE UPDATE OF status ON tenant_data.write_scope
  FOR EACH ROW EXECUTE FUNCTION tenant_data.write_scope_path_status_guard();

-- ---------------------------------------------------------------------------
-- 6. Находка 5: срок проверки остановки переносит человек с правом снятия и вторым фактором (роль — страж выше, аудит — admin_change)
-- ---------------------------------------------------------------------------
CREATE FUNCTION channel_data.pricing_halt_review_schedule_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.next_review_at IS DISTINCT FROM OLD.next_review_at AND security.admin_session() AND NOT security.session_mfa() THEN
    RAISE EXCEPTION 'moving the review of pricing halt % requires a second factor (step 17 finding 5)', NEW.pricing_halt_id USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER a1_pricing_halt_review_schedule_guard BEFORE UPDATE OF next_review_at ON channel_data.pricing_halt
  FOR EACH ROW EXECUTE FUNCTION channel_data.pricing_halt_review_schedule_guard();

-- ---------------------------------------------------------------------------
-- 7. OQ-154: ветка «автоматическое снятие в сессии человека» недостижима (запись автоматической проверки в сессии человека
--    невозможна, без неё снятие раньше отклоняет Р-52) — удалена; проверка чистой выборки на момент снятия остаётся
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION channel_data.pricing_halt_release_role_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  r text;
  u uuid;
BEGIN
  IF OLD.released_at IS NOT NULL OR NEW.released_at IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.released_kind = 'MANUAL' THEN
    SELECT m.role, m.user_id INTO r, u FROM tenant_data.membership m
     WHERE m.tenant_id = NEW.tenant_id AND m.membership_id = NEW.released_by_membership_id AND m.status = 'ACTIVE';
    IF r IS NULL OR NOT security.pricing_permission(r, 'RELEASE_CHANNEL_HALT') THEN
      RAISE EXCEPTION 'membership % (role %) may not release a channel halt', NEW.released_by_membership_id, coalesce(r, 'none')
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF security.current_user_id() IS NULL OR u IS DISTINCT FROM security.current_user_id() THEN
      RAISE EXCEPTION 'membership % is not the membership of the session user', NEW.released_by_membership_id USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NOT security.session_mfa() THEN
      RAISE EXCEPTION 'releasing channel halt % manually requires a second factor (finding 12, Р-88)', NEW.pricing_halt_id USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSIF NOT EXISTS (
         SELECT 1 FROM channel_data.pricing_halt_review rv
          WHERE rv.tenant_id = NEW.tenant_id AND rv.pricing_halt_id = NEW.pricing_halt_id AND rv.kind = 'AUTO_SAMPLE' AND rv.outcome = 'RELEASED'
            AND rv.sample_size >= 1 AND rv.failed_count = 0 AND rv.reviewed_at = NEW.released_at AND rv.reviewed_at >= OLD.next_review_at) THEN
    RAISE EXCEPTION 'automatic release of pricing halt % needs a clean sample reviewed at the release after the review window (Р-52)', NEW.pricing_halt_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
RESET ROLE;

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

COMMIT;
