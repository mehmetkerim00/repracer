-- 0108: массовые операции продавца — фоновые задания [Р-139, шаг 30]
--
-- Причина. Применение импорта 10 000 строк занимало 8 секунд на машине разработчика и 19 на раннере CI (шаг 29). На медленной
-- базе синхронный запрос упрётся в таймаут прокси, и продавец увидит ошибку при том, что изменения прошли: транзакция в базе
-- завершится, а ответа он не получит. Поэтому массовая операция — это ЗАДАНИЕ: оно создаётся, показывает ход, переживает
-- перезагрузку страницы (состояние в базе, а не в браузере), применяется целиком или никак [Р-134] и возобновляется после
-- падения процесса.
--
-- Второй фактор [Р-135]. Задание создаёт человек — и предъявляет второй фактор при СОЗДАНИИ. Применяет его фоновый процесс, у
-- которого сессии человека нет. Поэтому стражи массового изменения принимают второй фактор «сейчас в сессии ИЛИ при создании
-- задания, которое сейчас применяется»: `security.second_factor_present(kinds)`. Вид задания сверяется с тем, что пишется, —
-- задание импорта не открывает правку границ.

BEGIN;

SET ROLE repracer_owner;

CREATE TABLE tenant_data.bulk_job (
  tenant_id                uuid NOT NULL,
  bulk_job_id              uuid NOT NULL DEFAULT gen_random_uuid(),
  -- Что делает задание: четыре массовые операции продавца [Р-139]
  kind                     text NOT NULL CONSTRAINT bulk_job_kind_known
                             CHECK (kind IN ('COST_IMPORT', 'BOUNDS_EDIT', 'STRATEGY_ASSIGN', 'PRICE_EVIDENCE')),
  status                   text NOT NULL DEFAULT 'PENDING' CONSTRAINT bulk_job_status_known
                             CHECK (status IN ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'INTERRUPTED')),
  /** Что именно делать: файл импорта, правка границ, черновик стратегии, период выгрузки — ровно то, что видел человек */
  params                   jsonb NOT NULL,
  /** Ход: сколько строк обработано из скольких и на каком шаге. Пишется ОТДЕЛЬНЫМ соединением, поэтому переживает откат работы */
  phase                    text CONSTRAINT bulk_job_phase_known CHECK (phase IN ('PREPARING', 'APPLYING', 'PRODUCING', 'DONE')),
  total_items              int CONSTRAINT bulk_job_total_non_negative CHECK (total_items IS NULL OR total_items >= 0),
  done_items               int NOT NULL DEFAULT 0 CONSTRAINT bulk_job_done_non_negative CHECK (done_items >= 0),
  /** Итог задания глазами продавца: сколько применено, к скольким предложениям, что не сопоставилось */
  result                   jsonb,
  error_code               text,
  attempts                 int NOT NULL DEFAULT 0 CONSTRAINT bulk_job_attempts_non_negative CHECK (attempts >= 0),
  -- Второй фактор предъявлен при создании: ставит база, а не вызывающий [Р-90]
  created_with_mfa         boolean NOT NULL DEFAULT false,
  created_by_membership_id uuid NOT NULL,
  /**
   * Человек, создавший задание [Р-97]. Применяет задание фоновый процесс, у которого сессии человека нет, — но автором версий
   * цен остаётся человек, а не процесс. Ставит столбец база из пользователя сессии: иначе процесс назвал бы автора сам.
   */
  created_by_user_id       uuid NOT NULL REFERENCES platform.app_user (user_id),
  -- Аренда: одно задание выполняет один процесс; упавший процесс отпускает задание сроком аренды [Р-126]
  lease_owner              text,
  lease_until              timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  started_at               timestamptz,
  finished_at              timestamptz,
  PRIMARY KEY (tenant_id, bulk_job_id),
  FOREIGN KEY (tenant_id, created_by_membership_id) REFERENCES tenant_data.membership (tenant_id, membership_id),
  CONSTRAINT bulk_job_lease_pair CHECK ((lease_owner IS NULL) = (lease_until IS NULL)),
  CONSTRAINT bulk_job_finished_has_outcome CHECK ((status IN ('SUCCEEDED', 'FAILED')) = (finished_at IS NOT NULL)),
  CONSTRAINT bulk_job_failed_has_reason CHECK (status <> 'FAILED' OR error_code IS NOT NULL)
);
COMMENT ON TABLE tenant_data.bulk_job IS 'Шаг 30 [Р-139]: массовая операция продавца — фоновое задание с видимым ходом; применяется целиком или никак';
SELECT security.register_table('tenant_data.bulk_job', 'TENANT', 'mutable');
SELECT security.grant_retention('tenant_data.bulk_job');
INSERT INTO maintenance.retention_policy (table_name, method, bound)
VALUES ('tenant_data.bulk_job', 'TENANT_CLOSURE_ONLY', 'MAX_AGE');

/**
 * Итог выгрузки доказательной истории: файл, который продавец скачивает [OQ-202]. В ответе экрана его нет — экран показывает
 * готовность задания и ссылку; 28 МБ внутри JSON были бы тем же самым синхронным запросом, только длиннее.
 */
CREATE TABLE tenant_data.bulk_job_artifact (
  tenant_id     uuid NOT NULL,
  bulk_job_id   uuid NOT NULL,
  file_name     text NOT NULL CHECK (length(file_name) BETWEEN 1 AND 200),
  content_type  text NOT NULL CHECK (content_type IN ('text/csv')),
  content       text NOT NULL,
  sha256        text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  rows_count    int NOT NULL CHECK (rows_count >= 0),
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, bulk_job_id),
  FOREIGN KEY (tenant_id, bulk_job_id) REFERENCES tenant_data.bulk_job (tenant_id, bulk_job_id)
);
COMMENT ON TABLE tenant_data.bulk_job_artifact IS 'Шаг 30 [Р-139, OQ-202]: файл, подготовленный заданием — доказательная история цен';
SELECT security.register_table('tenant_data.bulk_job_artifact', 'TENANT', 'mutable');
SELECT security.grant_retention('tenant_data.bulk_job_artifact');
INSERT INTO maintenance.retention_policy (table_name, method, bound)
VALUES ('tenant_data.bulk_job_artifact', 'TENANT_CLOSURE_ONLY', 'MAX_AGE');

-- Очередь заданий: берётся самое старое ожидающее, поэтому индекс по состоянию и времени
CREATE INDEX bulk_job_queue_idx ON tenant_data.bulk_job (tenant_id, status, created_at) WHERE status IN ('PENDING', 'RUNNING');

RESET ROLE;

/** Признак второго фактора ставит база, а не вызывающий [Р-90]: иначе приложение объявило бы его за человека */
CREATE FUNCTION tenant_data.bulk_job_created_with_mfa() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  NEW.created_with_mfa := security.session_mfa();
  NEW.created_by_user_id := security.current_user_id();
  RETURN NEW;
END $fn$;
CREATE TRIGGER a_bulk_job_created_with_mfa BEFORE INSERT ON tenant_data.bulk_job
  FOR EACH ROW EXECUTE FUNCTION tenant_data.bulk_job_created_with_mfa();
ALTER FUNCTION tenant_data.bulk_job_created_with_mfa() OWNER TO repracer_owner;

/**
 * Р-135, Р-139: задание, которое МЕНЯЕТ цены, создаётся только со вторым фактором. Выгрузка доказательства (`PRICE_EVIDENCE`)
 * ничего не меняет — ей второй фактор не нужен.
 */
CREATE FUNCTION tenant_data.bulk_job_requires_mfa() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  IF NEW.kind <> 'PRICE_EVIDENCE' AND NOT NEW.created_with_mfa THEN
    RAISE EXCEPTION 'a bulk job of kind % changes prices: creating it needs a second factor (Р-135, Р-139)', NEW.kind
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NULL;
END $fn$;
CREATE TRIGGER zb_bulk_job_requires_mfa AFTER INSERT ON tenant_data.bulk_job
  FOR EACH ROW EXECUTE FUNCTION tenant_data.bulk_job_requires_mfa();
ALTER FUNCTION tenant_data.bulk_job_requires_mfa() OWNER TO repracer_owner;

/**
 * Право — по тому, что задание ДЕЛАЕТ [Р-100]. Страж административной записи проверяет одно право на всю таблицу, а виды
 * заданий разные: выгрузка доказательной истории [Р-123] ничего не меняет и нужна тому, кто отвечает за спор о скидке, — её
 * создаёт любой участник; задание, меняющее цены, требует MANAGE_PRICING. Поэтому у таблицы объявлено слабейшее право
 * (VIEW_PRICING), а сильное проверяет этот страж — по виду строки.
 */
CREATE FUNCTION tenant_data.bulk_job_requires_right() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
DECLARE
  member_role text;
BEGIN
  IF NOT security.admin_session() OR NEW.kind = 'PRICE_EVIDENCE' THEN RETURN NULL; END IF;
  SELECT m.role INTO member_role FROM tenant_data.membership m
   WHERE m.tenant_id = NEW.tenant_id AND m.user_id = security.current_user_id() AND m.status = 'ACTIVE';
  IF member_role IS NULL OR NOT security.pricing_permission(member_role, 'MANAGE_PRICING') THEN
    RAISE EXCEPTION 'a bulk job of kind % changes prices: the role % may not manage pricing (Р-100)', NEW.kind, coalesce(member_role, 'none')
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NULL;
END $fn$;
CREATE TRIGGER zc_bulk_job_requires_right AFTER INSERT ON tenant_data.bulk_job
  FOR EACH ROW EXECUTE FUNCTION tenant_data.bulk_job_requires_right();
ALTER FUNCTION tenant_data.bulk_job_requires_right() OWNER TO repracer_owner;

/** Действие участника для новой таблицы [Р-100]: создать задание может любой участник — вид задания проверяет страж выше */
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
    -- Шаг 30 [Р-139]: создать задание может любой участник — выгрузка доказательства [Р-123] ничего не меняет;
    -- задание, меняющее цены, требует MANAGE_PRICING — это проверяет zc_bulk_job_requires_right по виду строки
    ('tenant_data.bulk_job', 'VIEW_PRICING'),
    ('tenant_data.price_stop', 'OWN_GUARD'), ('channel_data.pricing_halt_review', 'OWN_GUARD'), ('tenant_data.membership', 'OWN_GUARD'),
    ('channel_data.pricing_halt_sample', 'OWN_GUARD')
  ) AS t(tbl, a) WHERE tbl = p_table
$function$;

/**
 * Аренда задания: действующую аренду трогает только тот процесс, который её держит, — как у периодических работ [Р-126].
 * Процесс называет себя в `app.bulk_lease_owner`; условие `WHERE lease_owner = …` в запросе этого не гарантирует — запрос без
 * него отберёт у соседа задание посреди применения. Истёкшую аренду берёт кто угодно: это и есть возобновление после падения.
 */
CREATE FUNCTION tenant_data.bulk_job_lease_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  IF OLD.lease_owner IS NOT NULL AND OLD.lease_until > now()
     AND nullif(current_setting('app.bulk_lease_owner', true), '') IS DISTINCT FROM OLD.lease_owner THEN
    RAISE EXCEPTION 'bulk job % is leased by % until %: another process may not take it or release it (Р-139)',
      OLD.bulk_job_id, OLD.lease_owner, OLD.lease_until USING ERRCODE = 'lock_not_available';
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER a_bulk_job_lease_guard BEFORE UPDATE ON tenant_data.bulk_job
  FOR EACH ROW EXECUTE FUNCTION tenant_data.bulk_job_lease_guard();
ALTER FUNCTION tenant_data.bulk_job_lease_guard() OWNER TO repracer_owner;

/** Итог задания не переписывается: завершённое задание неизменяемо, кроме возврата прерванного в очередь */
CREATE FUNCTION tenant_data.bulk_job_status_forward_only() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  IF OLD.status IN ('SUCCEEDED', 'FAILED') AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'bulk job % is finished as %: its outcome is not rewritten (Р-139)', OLD.bulk_job_id, OLD.status
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status = 'PENDING' AND NEW.status NOT IN ('PENDING', 'RUNNING') THEN
    RAISE EXCEPTION 'bulk job % goes from PENDING to RUNNING, not to % (Р-139)', OLD.bulk_job_id, NEW.status
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER b_bulk_job_status_forward_only BEFORE UPDATE ON tenant_data.bulk_job
  FOR EACH ROW EXECUTE FUNCTION tenant_data.bulk_job_status_forward_only();
ALTER FUNCTION tenant_data.bulk_job_status_forward_only() OWNER TO repracer_owner;

/**
 * Р-139: второй фактор предъявлен — сейчас в сессии человека ИЛИ при создании задания, которое ИМЕННО СЕЙЧАС применяется.
 * Задание называет себя в `app.bulk_job_id`; проверяется, что оно того же тенанта, создано со вторым фактором, выполняется с
 * живой арендой и его вид совпадает с тем, что пишется. Задание импорта не открывает правку границ.
 */
CREATE FUNCTION security.second_factor_present(p_kinds text[] DEFAULT NULL) RETURNS boolean
  LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS $fn$
DECLARE
  job_id uuid;
  ok     boolean;
BEGIN
  IF security.session_mfa() THEN RETURN true; END IF;
  IF NOT security.admin_session() THEN RETURN false; END IF;
  BEGIN
    job_id := nullif(current_setting('app.bulk_job_id', true), '')::uuid;
  EXCEPTION WHEN others THEN
    RETURN false;
  END;
  IF job_id IS NULL THEN RETURN false; END IF;
  SELECT true INTO ok FROM tenant_data.bulk_job j
   WHERE j.tenant_id = security.current_tenant_id() AND j.bulk_job_id = job_id
     AND j.created_with_mfa AND j.status = 'RUNNING' AND j.lease_until > now()
     AND (p_kinds IS NULL OR j.kind = ANY (p_kinds));
  RETURN coalesce(ok, false);
END $fn$;
/**
 * Права вызывающего, а не владельца [Р-90]: функция читает ОДНУ строку задания текущего тенанта, и видеть её вызывающий должен
 * сам — под своей политикой изоляции. SECURITY DEFINER здесь был бы и лишним, и вредным: владелец таблицы политики изоляции
 * не имеет, и при FORCE ROW LEVEL SECURITY запрос не вернул бы ничего — второй фактор задания не признавался бы никогда.
 */
ALTER FUNCTION security.second_factor_present(text[]) OWNER TO repracer_owner;
GRANT EXECUTE ON FUNCTION security.second_factor_present(text[]) TO repracer_app, repracer_admin;

-- Стражи массового изменения принимают второй фактор задания: вид задания сверяется с тем, что пишется
CREATE OR REPLACE FUNCTION tenant_data.cost_import_requires_mfa() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  IF NOT security.admin_session() THEN RETURN NULL; END IF;
  IF security.second_factor_present(ARRAY['COST_IMPORT']) THEN RETURN NULL; END IF;
  RAISE EXCEPTION 'a cost import needs a second factor: mass changes of prices are confirmed by a person (Р-135)'
    USING ERRCODE = 'insufficient_privilege';
END $fn$;
ALTER FUNCTION tenant_data.cost_import_requires_mfa() OWNER TO repracer_owner;

CREATE OR REPLACE FUNCTION tenant_data.mass_change_window_requires_mfa() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
DECLARE
  window_start timestamptz := now() - interval '10 minutes';
  offers       int;
  wide         boolean;
BEGIN
  IF NOT security.admin_session() THEN RETURN NULL; END IF;
  IF security.second_factor_present(ARRAY['COST_IMPORT', 'BOUNDS_EDIT']) THEN RETURN NULL; END IF;
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
  -- Гардрейл шире предложения в окне: он уже изменил пол маржи у всех — следующая правка без второго фактора не проходит
  SELECT EXISTS (
    SELECT 1 FROM tenant_data.guardrail g
     WHERE g.tenant_id = NEW.tenant_id AND g.created_at >= window_start AND g.scope_type IN ('TENANT', 'CHANNEL_ACCOUNT')
  ) INTO wide;
  IF wide THEN
    RAISE EXCEPTION 'a guardrail of every offer was changed within ten minutes: further changes need a second factor (Р-135)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF offers > 5 THEN
    RAISE EXCEPTION 'prices of % offers changed within ten minutes without a second factor: a mass change requires it (Р-135)', offers
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NULL;
END $fn$;
ALTER FUNCTION tenant_data.mass_change_window_requires_mfa() OWNER TO repracer_owner;

CREATE OR REPLACE FUNCTION tenant_data.bounds_mass_edit_requires_mfa() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
DECLARE
  offers integer;
BEGIN
  IF NOT security.admin_session() THEN RETURN NULL; END IF;
  IF NEW.created_at IS DISTINCT FROM now() THEN
    RAISE EXCEPTION 'a bound version is created at the transaction time, not %: backdated versions are not accepted from the administrative service (Р-88)', NEW.created_at
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF security.second_factor_present(ARRAY['COST_IMPORT', 'BOUNDS_EDIT']) THEN RETURN NULL; END IF;
  SELECT count(DISTINCT k) INTO offers FROM (
    SELECT coalesce('WRITE_SCOPE:' || b.write_scope_id::text, 'PRODUCT:' || b.product_id::text) AS k
      FROM tenant_data.min_price b
     WHERE b.tenant_id = NEW.tenant_id AND b.created_at = now() AND tenant_data.row_in_current_transaction(b.xmin)
    UNION ALL
    SELECT coalesce('WRITE_SCOPE:' || b.write_scope_id::text, 'PRODUCT:' || b.product_id::text)
      FROM tenant_data.max_price b
     WHERE b.tenant_id = NEW.tenant_id AND b.created_at = now() AND tenant_data.row_in_current_transaction(b.xmin)
  ) edited;
  IF offers > 1 THEN
    RAISE EXCEPTION 'bounds of % offers changed in one transaction without a second factor: a mass bounds edit requires it (Р-88)', offers
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NULL;
END $fn$;
ALTER FUNCTION tenant_data.bounds_mass_edit_requires_mfa() OWNER TO repracer_owner;

CREATE OR REPLACE FUNCTION tenant_data.wide_guardrail_requires_mfa() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  IF NOT security.admin_session() THEN RETURN NULL; END IF;
  IF security.second_factor_present() THEN RETURN NULL; END IF;
  IF NEW.scope_type IN ('TENANT', 'CHANNEL_ACCOUNT') THEN
    RAISE EXCEPTION 'a guardrail of scope % covers every offer: changing it requires a second factor (Р-135)', NEW.scope_type
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NULL;
END $fn$;
ALTER FUNCTION tenant_data.wide_guardrail_requires_mfa() OWNER TO repracer_owner;

/**
 * Права [Р-90]. Создаёт задание ЧЕЛОВЕК через административный сервис — это административная запись с автором и аудитом.
 * ВЕДЁТ задание машина: аренда, ход и итог меняются раз в секунду, и человека за ними нет. Поэтому это разные роли, а не
 * разные права одной: иначе каждый тик хода был бы административной записью и строкой аудита.
 *
 * Роль исполнителя не умеет создавать задания и не умеет менять `params` и `kind`: что именно делать, решил человек.
 */
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'repracer_bulk_worker') THEN
    CREATE ROLE repracer_bulk_worker NOLOGIN NOBYPASSRLS;
  END IF;
END $$;
GRANT USAGE ON SCHEMA security, tenant_data TO repracer_bulk_worker;
GRANT EXECUTE ON FUNCTION security.current_tenant_id() TO repracer_bulk_worker;

GRANT SELECT, INSERT ON tenant_data.bulk_job TO repracer_admin;
GRANT SELECT ON tenant_data.bulk_job_artifact TO repracer_admin;
GRANT SELECT ON tenant_data.bulk_job, tenant_data.bulk_job_artifact TO repracer_app;
GRANT SELECT ON tenant_data.bulk_job TO repracer_bulk_worker;
GRANT UPDATE (status, phase, total_items, done_items, result, error_code, attempts, lease_owner, lease_until, started_at, finished_at)
  ON tenant_data.bulk_job TO repracer_bulk_worker;
GRANT SELECT, INSERT ON tenant_data.bulk_job_artifact TO repracer_bulk_worker;
CREATE POLICY bulk_worker_tenant ON tenant_data.bulk_job FOR ALL TO repracer_bulk_worker
  USING (tenant_id = security.current_tenant_id()) WITH CHECK (tenant_id = security.current_tenant_id());
CREATE POLICY bulk_worker_artifact ON tenant_data.bulk_job_artifact FOR ALL TO repracer_bulk_worker
  USING (tenant_id = security.current_tenant_id()) WITH CHECK (tenant_id = security.current_tenant_id());

-- Страж и аудит административной записи [Р-97, Р-100]: задание создаёт человек
CREATE TRIGGER a0_admin_write_person_insert BEFORE INSERT ON tenant_data.bulk_job
  FOR EACH ROW EXECUTE FUNCTION security.require_person_for_admin_write();
CREATE TRIGGER zz_admin_write_audit_insert AFTER INSERT ON tenant_data.bulk_job
  FOR EACH ROW EXECUTE FUNCTION security.audit_admin_write();

COMMIT;
