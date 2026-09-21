-- 0115_onboarding_demo_channel_access.sql: путь онбординга, демо-тенант, честное состояние канала без доступов (шаг 34)
-- [Р-149, Р-150, Р-151].
--
-- Три вещи, которых схема не умела выразить:
--   1. «Аккаунт канала заведён, ключей нет» — CHECK требовал `credentials_ref` у всего, что не DISCONNECTED, и единственный
--      способ сказать «доступа нет» был «отключён». Продавец видел бы либо ошибку, либо пустоту [Р-150].
--   2. «Тенант — демо» — ни признака, ни способа завести. Демо — обычный CUSTOMER с флагом: все стражи вида тенанта (вход,
--      очистка, аудит) видят его как клиента, и путь у него настоящий [Р-151].
--   3. «Где продавец остановился в онбординге» — нигде не хранилось [Р-149].

BEGIN;

SET ROLE repracer_owner;

-- ---------------------------------------------------------------- Р-151: признак демо
ALTER TABLE tenant_data.tenant ADD COLUMN demo boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN tenant_data.tenant.demo IS 'Шаг 34 [Р-151]: тенант на симуляторе канала; данные синтетические, путь настоящий; помечается везде, где показываются деньги';

/**
 * Признак задаётся при создании и не меняется (ревью шага 34, находка 5): демо, ставшее «клиентом», показывало бы
 * синтетические деньги без метки, а клиент, ставший «демо», — настоящие деньги под меткой «не настоящие».
 *
 * Этот же страж держит и «платформенный тенант демо быть не может». Отдельная проверка значений для этого была и удалена
 * как дубль [Р-104]: платформенный тенант один (`tenant_check` привязывает вид к идентификатору), создан не демо, а
 * признак не меняется — проверку значений нечем было провалить, мутация её снятия не ловилась ничем.
 */
CREATE FUNCTION tenant_data.tenant_demo_is_immutable() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  IF NEW.demo IS DISTINCT FROM OLD.demo THEN
    RAISE EXCEPTION 'tenant % cannot change its demo flag: it is set when the tenant is created (Р-151)', OLD.tenant_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER a_tenant_demo_is_immutable BEFORE UPDATE OF demo ON tenant_data.tenant
  FOR EACH ROW EXECUTE FUNCTION tenant_data.tenant_demo_is_immutable();

-- provision_tenant принадлежит repracer_resolver: переопределяется ниже, вне SET ROLE (как в 0058 и 0066)


-- ---------------------------------------------------------------- Р-150: канал без доступов
/**
 * Чего именно не хватает каналу — названо кодами, а не прозой. Коды соответствуют открытым вопросам к каналам:
 *   PARTNER_REGISTRATION — регистрация технологического партнёра (Kaufland, OQ-75);
 *   DEVELOPER_KEYS       — ключи разработчика (eBay, OQ-112 / E-01);
 *   NOTIFICATION_QUEUE   — живая очередь уведомлений (Amazon SQS, OQ-167);
 *   SELLER_AUTHORIZATION — авторизация продавца в его кабинете (OAuth / ключи продавца).
 */
CREATE FUNCTION security.channel_access_blockers() RETURNS SETOF text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
  SELECT unnest(ARRAY['PARTNER_REGISTRATION', 'DEVELOPER_KEYS', 'NOTIFICATION_QUEUE', 'SELLER_AUTHORIZATION'])
$fn$;
ALTER FUNCTION security.channel_access_blockers() OWNER TO repracer_owner;
GRANT EXECUTE ON FUNCTION security.channel_access_blockers() TO repracer_app, repracer_admin;

ALTER TABLE tenant_data.channel_account ADD COLUMN access_blockers text[] NOT NULL DEFAULT '{}';
ALTER TABLE tenant_data.channel_account DROP CONSTRAINT channel_account_auth_status_check;
ALTER TABLE tenant_data.channel_account ADD CONSTRAINT channel_account_auth_status_check
  CHECK (auth_status IN ('ACTIVE', 'REAUTH_REQUIRED', 'REVOKED', 'DISCONNECTED', 'AWAITING_ACCESS'));
-- Ключей нет только у отключённого и у ждущего доступа; у остальных они обязаны быть
ALTER TABLE tenant_data.channel_account DROP CONSTRAINT channel_account_check2;
ALTER TABLE tenant_data.channel_account ADD CONSTRAINT channel_account_credentials_unless_no_access
  CHECK (auth_status IN ('DISCONNECTED', 'AWAITING_ACCESS') OR credentials_ref IS NOT NULL);
-- Ждущий доступа обязан НАЗВАТЬ, чего ждёт; у остальных перечня нет — «ожидает» без перечня и есть та самая пустота [Р-150]
ALTER TABLE tenant_data.channel_account ADD CONSTRAINT channel_account_awaiting_names_blockers
  CHECK ((auth_status = 'AWAITING_ACCESS') = (cardinality(access_blockers) > 0));
COMMENT ON COLUMN tenant_data.channel_account.access_blockers IS 'Шаг 34 [Р-150]: чего не хватает, чтобы канал заработал; коды — security.channel_access_blockers()';

/** Коды перечня — только из списка: свободный текст никому ничего не скажет */
CREATE FUNCTION tenant_data.channel_account_blockers_known() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  IF EXISTS (SELECT 1 FROM unnest(NEW.access_blockers) b WHERE b NOT IN (SELECT k FROM security.channel_access_blockers() AS k)) THEN
    RAISE EXCEPTION 'channel account % names an access blocker that does not exist: %; see security.channel_access_blockers (Р-150)',
      NEW.channel_account_id, NEW.access_blockers USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER a_channel_account_blockers_known BEFORE INSERT OR UPDATE OF access_blockers ON tenant_data.channel_account
  FOR EACH ROW EXECUTE FUNCTION tenant_data.channel_account_blockers_known();
ALTER FUNCTION tenant_data.channel_account_blockers_known() OWNER TO repracer_owner;

-- ---------------------------------------------------------------- Р-149: прогресс онбординга
/**
 * Хранится ТОЛЬКО то, чего нельзя вывести из данных: набор предложений, до которого продавец сузил путь. Отметки
 * «последний шаг» здесь НЕТ намеренно (ревью шага 34, находка 6): первая редакция её хранила, никто её не читал, а
 * `DONE` принимался в любой момент — та самая галочка, от которой путь отказался. Место остановки — первый
 * незавершённый шаг `onboarding_status`.
 * Итак, хранится набор предложений, до которого продавец сузил путь [Р-131 — пропустить
 * себестоимость нельзя, можно сузить]. Всё остальное — «есть ли себестоимость, границы,
 * стратегия, включён ли движок» — ВЫВОДИТСЯ из настоящих таблиц функцией `tenant_data.onboarding_status`: шаг завершён,
 * потому что состояние проверяемо, а не потому, что кто-то поставил галочку.
 */
CREATE TABLE tenant_data.onboarding_progress (
  tenant_id                 uuid NOT NULL REFERENCES tenant_data.tenant (tenant_id),
  -- Свой идентификатор нужен аудиту: запись называется по столбцу ключа, отличному от tenant_id
  onboarding_id             uuid NOT NULL DEFAULT gen_random_uuid(),
  /** NULL — весь каталог; иначе — предложения, до которых путь сужен */
  scope_write_scope_ids     uuid[],
  started_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  updated_by_membership_id  uuid NOT NULL,
  -- Сужение до пустого набора — не сужение, а отказ от пути [Р-131]
  CONSTRAINT onboarding_narrowed_set_not_empty CHECK (scope_write_scope_ids IS NULL OR cardinality(scope_write_scope_ids) > 0),
  FOREIGN KEY (tenant_id, updated_by_membership_id) REFERENCES tenant_data.membership (tenant_id, membership_id),
  PRIMARY KEY (tenant_id, onboarding_id),
  -- Путь у тенанта один
  UNIQUE (tenant_id)
);
COMMENT ON TABLE tenant_data.onboarding_progress IS 'Шаг 34 [Р-149]: где продавец остановился в направляемом пути и до какого набора предложений его сузил';
SELECT security.register_table('tenant_data.onboarding_progress', 'TENANT', 'mutable');
SELECT security.grant_retention('tenant_data.onboarding_progress');
INSERT INTO maintenance.retention_policy (table_name, method, bound)
VALUES ('tenant_data.onboarding_progress', 'TENANT_CLOSURE_ONLY', 'MAX_AGE');
GRANT SELECT, INSERT, UPDATE ON tenant_data.onboarding_progress TO repracer_admin;

-- Стражи административной записи навешиваются ниже, вне SET ROLE: их функции принадлежат не владельцу схемы (как в 0111)

/**
 * «Себестоимость готова» — ровно то, чего требует включение движка: объявленная себестоимость [Р-131] И полная оценка
 * комиссии (ставка и фиксированная часть). Первый живой прогон онбординга показал расхождение: файл без колонки комиссии
 * проходил шаг («себестоимость есть у 150»), а включение отказывало всем 150 с FEE_ESTIMATE_MISSING — путь говорил
 * «готово» и упирался на последнем шаге. Критерий шага и критерий включения обязаны совпадать.
 */
CREATE FUNCTION tenant_data.write_scope_cost_ready(p_tenant_id uuid, p_write_scope_id uuid, p_at timestamptz) RETURNS boolean
  LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog AS $fn$
  /**
   * Три условия, и все три — те, по которым отказывает включение (ревью шага 34, находка 7):
   *   себестоимость объявлена [Р-131]; она в валюте единицы записи ИЛИ переводится по курсу ЕЦБ не старше 6 дней
   *   [Р-61] — то же правило, что в пересчёте пола (0051); есть полная действующая оценка комиссии.
   * Равносильность с включением утверждает тест хранилища на всех четырёх случаях — иначе это третья копия критерия.
   */
  SELECT EXISTS (
    SELECT 1
      FROM tenant_data.write_scope s
      LEFT JOIN LATERAL (SELECT om.marketplace FROM tenant_data.offer_mapping om
                          WHERE om.tenant_id = s.tenant_id AND om.price_write_scope_id = s.write_scope_id
                          ORDER BY om.created_at LIMIT 1) m ON true
      JOIN LATERAL (SELECT cp.currency FROM tenant_data.cost_profile cp
                     WHERE cp.tenant_id = s.tenant_id AND cp.product_id = s.product_id
                       AND (cp.channel_account_id IS NULL OR (cp.channel_account_id = s.channel_account_id AND cp.marketplace = m.marketplace))
                       AND cp.valid_from <= p_at
                     ORDER BY (cp.channel_account_id IS NOT NULL) DESC, cp.valid_from DESC, cp.version DESC LIMIT 1) c ON true
     WHERE s.tenant_id = p_tenant_id AND s.write_scope_id = p_write_scope_id
       AND (c.currency = s.currency
            OR (c.currency IN ('EUR', 'USD') AND s.currency IN ('EUR', 'USD')
                AND EXISTS (SELECT 1 FROM platform.fx_rate x
                             WHERE x.source = 'ECB' AND x.base_currency = 'EUR'
                               AND x.quote_currency = CASE WHEN c.currency = 'EUR' THEN s.currency ELSE c.currency END
                               AND x.available_from <= p_at AND x.rate > 0
                               AND x.rate_date <= (p_at AT TIME ZONE 'UTC')::date
                               AND (p_at AT TIME ZONE 'UTC')::date - x.rate_date <= 6))))
     AND EXISTS (SELECT 1 FROM channel_data.fee_estimate fe
                  WHERE fe.tenant_id = p_tenant_id AND fe.write_scope_id = p_write_scope_id AND fe.valid_until > p_at
                    AND jsonb_typeof(fe.fee_model -> 'feeRateBp') = 'number' AND jsonb_typeof(fe.fee_model -> 'fixedFeeMinor') = 'number')
$fn$;
ALTER FUNCTION tenant_data.write_scope_cost_ready(uuid, uuid, timestamptz) OWNER TO repracer_owner;
GRANT EXECUTE ON FUNCTION tenant_data.write_scope_cost_ready(uuid, uuid, timestamptz) TO repracer_app, repracer_admin;

/**
 * Состояние пути, ВЫВЕДЕННОЕ из данных: по каждому шагу — сколько предложений набора его прошло. Набор — сужение из
 * `onboarding_progress` либо весь каталог цен тенанта.
 */
CREATE FUNCTION tenant_data.onboarding_status(p_tenant_id uuid)
  RETURNS TABLE (step text, done_count int, total_count int, done boolean, awaiting boolean)
  LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog AS $fn$
  WITH chosen AS (
    SELECT p.scope_write_scope_ids AS ids FROM tenant_data.onboarding_progress p WHERE p.tenant_id = p_tenant_id
  ),
  scopes AS (
    SELECT s.write_scope_id, s.pricing_mode, s.pricing_strategy_id
      FROM tenant_data.write_scope s
     WHERE s.tenant_id = p_tenant_id AND s.field = 'PRICE' AND s.status <> 'RETIRED'
       AND (NOT EXISTS (SELECT 1 FROM chosen WHERE ids IS NOT NULL) OR s.write_scope_id = ANY (ARRAY(SELECT unnest(c.ids) FROM chosen c)))
  ),
  accounts AS (
    SELECT count(*) FILTER (WHERE a.auth_status = 'ACTIVE') AS active,
           count(*) FILTER (WHERE a.auth_status = 'AWAITING_ACCESS') AS awaiting
      FROM tenant_data.channel_account a WHERE a.tenant_id = p_tenant_id AND a.disconnected_at IS NULL
  ),
  per_step AS (
    SELECT 'TENANT'::text AS step, 1 AS done_count, 1 AS total_count, false AS awaiting
    UNION ALL
    -- Канал «сделан», если есть хотя бы один рабочий аккаунт; «ожидает» — если хотя бы один ждёт доступа. Это независимые
    -- вещи: один канал может работать, пока другой ждёт партнёрства [Р-150]
    SELECT 'CHANNEL', (SELECT active FROM accounts)::int, (SELECT active + awaiting FROM accounts)::int, (SELECT awaiting > 0 FROM accounts)
    UNION ALL
    SELECT 'COSTS', count(*) FILTER (WHERE tenant_data.write_scope_cost_ready(p_tenant_id, s.write_scope_id, now()))::int, count(*)::int, false FROM scopes s
    UNION ALL
    SELECT 'BOUNDS', count(*) FILTER (WHERE tenant_data.effective_min_price(p_tenant_id, s.write_scope_id) IS NOT NULL
                                        AND tenant_data.effective_max_price(p_tenant_id, s.write_scope_id) IS NOT NULL)::int, count(*)::int, false FROM scopes s
    UNION ALL
    SELECT 'STRATEGY', count(*) FILTER (WHERE s.pricing_strategy_id IS NOT NULL)::int, count(*)::int, false FROM scopes s
    UNION ALL
    SELECT 'ENABLE', count(*) FILTER (WHERE s.pricing_mode = 'ENGINE')::int, count(*)::int, false FROM scopes s
  )
  SELECT step, done_count, total_count,
         CASE WHEN step = 'CHANNEL' THEN done_count > 0 ELSE total_count > 0 AND done_count = total_count END AS done,
         awaiting
    FROM per_step
$fn$;
ALTER FUNCTION tenant_data.onboarding_status(uuid) OWNER TO repracer_owner;
GRANT EXECUTE ON FUNCTION tenant_data.onboarding_status(uuid) TO repracer_app, repracer_admin;

-- ---------------------------------------------------------------- Р-149: включение репрайсинга набора — фоновое задание
/**
 * Последний шаг пути — включение движка у набора предложений. По одному это уже умеет `scopes/:id/enable`; для набора это
 * массовая операция, а массовые операции — задания [Р-139]. Право у вида своё: ENABLE_REPRICING, а не MANAGE_PRICING —
 * оператор включает движок, но цены не правит.
 */
ALTER TABLE tenant_data.bulk_job DROP CONSTRAINT bulk_job_kind_known;
ALTER TABLE tenant_data.bulk_job ADD CONSTRAINT bulk_job_kind_known
  CHECK (kind IN ('COST_IMPORT', 'BOUNDS_EDIT', 'BOUNDS_PLAN', 'STRATEGY_ASSIGN', 'STRATEGY_PREVIEW',
                  'PRICE_EVIDENCE', 'PRICE_FEED_EXPORT', 'REPRICING_ENABLE'));

CREATE OR REPLACE FUNCTION tenant_data.bulk_job_requires_right() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
DECLARE
  member_role text;
  needed text;
BEGIN
  IF NOT security.admin_session() OR NEW.kind IN (SELECT k FROM security.read_only_job_kinds() AS k) THEN RETURN NULL; END IF;
  /**
   * Право — по виду операции [Р-143], и оно ОДНО на создание и на отмену: кто вправе начать, тот вправе и остановить.
   * Ветки «иначе» нет намеренно (ревью шага 34, находка 1): виду без назначенного права достаётся право, которого нет
   * ни у одной роли, — такой вид не создаётся вовсе.
   */
  needed := coalesce(security.bulk_job_cancel_action(NEW.kind), 'NO_DECLARED_RIGHT');
  SELECT m.role INTO member_role FROM tenant_data.membership m
   WHERE m.tenant_id = NEW.tenant_id AND m.user_id = security.current_user_id() AND m.status = 'ACTIVE';
  IF member_role IS NULL OR NOT security.pricing_permission(member_role, needed) THEN
    RAISE EXCEPTION 'a bulk job of kind % needs the right %: the role % does not have it (Р-100, Р-143)', NEW.kind, needed, coalesce(member_role, 'none')
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NULL;
END $fn$;

CREATE OR REPLACE FUNCTION security.bulk_job_cancel_action(p_kind text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
  -- Без ветки «иначе»: новый вид без решения о праве получает NULL, и его не пропускают ни страж создания, ни правило 14е
  SELECT CASE WHEN p_kind IN ('PRICE_EVIDENCE', 'PRICE_FEED_EXPORT') THEN 'VIEW_PRICING'
              WHEN p_kind = 'REPRICING_ENABLE' THEN 'ENABLE_REPRICING'
              WHEN p_kind IN ('COST_IMPORT', 'BOUNDS_EDIT', 'BOUNDS_PLAN', 'STRATEGY_ASSIGN', 'STRATEGY_PREVIEW') THEN 'MANAGE_PRICING'
         END
$fn$;

RESET ROLE;

-- Административная запись человека с аудитом [Р-97, Р-100]
CREATE TRIGGER a0_admin_write_person BEFORE INSERT OR UPDATE ON tenant_data.onboarding_progress
  FOR EACH ROW EXECUTE FUNCTION security.require_person_for_admin_write();
CREATE TRIGGER zz_admin_write_audit AFTER INSERT OR UPDATE ON tenant_data.onboarding_progress
  FOR EACH ROW EXECUTE FUNCTION security.audit_admin_write();

-- Функции ниже принадлежат мигратору и роли хранения — переопределяются вне SET ROLE
-- ---------------------------------------------------------------- действие таблицы и очистка тенанта
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
    ('tenant_data.bulk_job', 'VIEW_PRICING'),
    -- Шаг 34 [Р-149]: путь ведёт тот, кто вправе править цены
    ('tenant_data.onboarding_progress', 'MANAGE_PRICING'),
    ('tenant_data.price_stop', 'OWN_GUARD'), ('channel_data.pricing_halt_review', 'OWN_GUARD'), ('tenant_data.membership', 'OWN_GUARD'),
    ('channel_data.pricing_halt_sample', 'OWN_GUARD')
  ) AS t(tbl, a) WHERE tbl = p_table
$function$;

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
    -- Шаг 34 [Р-149]: прогресс онбординга — данные тенанта
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


-- Владелец функции — repracer_resolver, поэтому она переопределяется от имени мигратора, как в 0058 и 0066
DROP FUNCTION security.provision_tenant(uuid, text, text, jsonb);
CREATE FUNCTION security.provision_tenant(p_tenant_id uuid, p_name text, p_data_region text, p_members jsonb, p_demo boolean DEFAULT false)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  m        jsonb;
  existing record;
BEGIN
  IF jsonb_typeof(p_members) IS DISTINCT FROM 'array'
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_members) e WHERE e.value ->> 'role' = 'OWNER') THEN
    RAISE EXCEPTION 'a tenant is provisioned together with its owner' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- Р-151: демо-тенант — обычный CUSTOMER с признаком; все стражи вида тенанта видят его как клиента
  INSERT INTO tenant_data.tenant (tenant_id, name, data_region, demo) VALUES (p_tenant_id, p_name, p_data_region, p_demo);
  FOR m IN SELECT value FROM jsonb_array_elements(p_members) LOOP
    SELECT u.user_id, u.email INTO existing FROM platform.app_user u WHERE u.user_id = (m ->> 'userId')::uuid;
    IF existing.user_id IS NULL THEN
      INSERT INTO platform.app_user (user_id, email, mfa_enabled)
      VALUES ((m ->> 'userId')::uuid, lower(trim(m ->> 'email')), coalesce((m ->> 'mfaEnabled')::boolean, false));
    ELSE
      -- Находка 5 ревью шага 16: существующий пользователь — только владелец нового тенанта, тем же адресом и уже входивший
      IF m ->> 'role' IS DISTINCT FROM 'OWNER' THEN
        RAISE EXCEPTION 'existing user % joins a tenant as % only by an invitation of its owner (step 16 finding 5)', existing.user_id, m ->> 'role'
          USING ERRCODE = 'insufficient_privilege';
      END IF;
      IF lower(trim(m ->> 'email')) IS DISTINCT FROM existing.email THEN
        RAISE EXCEPTION 'the provisioned email of existing user % does not match the user (step 16 finding 5)', existing.user_id USING ERRCODE = 'insufficient_privilege';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM platform.external_identity e WHERE e.user_id = existing.user_id
                        AND NOT EXISTS (SELECT 1 FROM platform.external_identity_revocation rv WHERE rv.issuer = e.issuer AND rv.subject = e.subject)) THEN
        RAISE EXCEPTION 'existing user % has never signed in: an owner is provisioned after accepting the signup invitation (step 16 finding 5)', existing.user_id
          USING ERRCODE = 'insufficient_privilege';
      END IF;
    END IF;
    INSERT INTO tenant_data.membership (tenant_id, membership_id, user_id, role, status)
    VALUES (p_tenant_id, coalesce((m ->> 'membershipId')::uuid, gen_random_uuid()), (m ->> 'userId')::uuid, m ->> 'role', 'ACTIVE');
  END LOOP;
END $function$;

ALTER FUNCTION security.provision_tenant(uuid, text, text, jsonb, boolean) OWNER TO repracer_resolver;
REVOKE ALL ON FUNCTION security.provision_tenant(uuid, text, text, jsonb, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION security.provision_tenant(uuid, text, text, jsonb, boolean) TO repracer_provisioning;

COMMIT;
