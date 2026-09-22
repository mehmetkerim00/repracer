-- 0120_alert_delivery.sql: алерт, который живёт только в базе, — недоставленный (шаг 36) [Р-156].
--
-- До этого шага алерт был строкой JSON в stdout процесса: «сбор — задача развёртывания», то есть никем. Теперь у него
-- есть место в базе и отметка доставки, а письмо владельцу шлёт работа планировщика [Р-126]: CRITICAL — немедленно,
-- WARNING — часовым дайджестом. Доставку выполняет СВОЯ роль (`repracer_alert_delivery`): она читает алерты всех
-- тенантов и адрес владельца, но не видит ни цен, ни решений — как ретранслятор outbox (0038).

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'repracer_alert_delivery') THEN
    CREATE ROLE repracer_alert_delivery NOLOGIN NOBYPASSRLS;
  END IF;
END $$;
GRANT USAGE ON SCHEMA tenant_data, platform, maintenance, security TO repracer_alert_delivery;

SET ROLE repracer_owner;

CREATE TABLE tenant_data.alert (
  tenant_id          uuid NOT NULL,
  alert_id           uuid NOT NULL DEFAULT gen_random_uuid(),
  -- Код события: тот же, что поднимает код [Р-72 — тексты в словаре, код в базе]
  code               text NOT NULL CONSTRAINT alert_code_shape CHECK (code ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  severity           text NOT NULL CONSTRAINT alert_severity_known CHECK (severity IN ('WARNING', 'CRITICAL')),
  channel_account_id uuid,
  -- Длина отрезается вызывающим; своей проверки у неё нет, и ограничение-дубль здесь не заводится [Р-104]
  correlation_id     text,
  /** Подробности события: только коды, идентификаторы и числа — секретов и данных покупателей здесь нет */
  details            jsonb NOT NULL DEFAULT '{}'::jsonb CONSTRAINT alert_details_object CHECK (jsonb_typeof(details) = 'object'),
  raised_at          timestamptz NOT NULL DEFAULT now(),
  /** Отметка доставки: пока NULL — алерт НЕ доставлен, и это видно запросом, а не на слово [Р-156] */
  delivered_at       timestamptz,
  delivery_kind      text CONSTRAINT alert_delivery_kind_known CHECK (delivery_kind IN ('EMAIL_IMMEDIATE', 'EMAIL_DIGEST')),
  /** Идентификатор письма у провайдера: доказательство отправки, не адрес получателя */
  delivery_ref       text,
  /** Сколько раз доставка не удалась: письмо, которое не ушло, не считается доставленным */
  delivery_attempts  int NOT NULL DEFAULT 0 CONSTRAINT alert_delivery_attempts_non_negative CHECK (delivery_attempts >= 0),
  last_delivery_error text,
  PRIMARY KEY (tenant_id, alert_id),
  FOREIGN KEY (tenant_id, channel_account_id) REFERENCES tenant_data.channel_account (tenant_id, channel_account_id),
  -- Доставлен — значит известно, КАК доставлен: отметка без вида доставки ничего не доказывает
  CONSTRAINT alert_delivered_names_kind CHECK ((delivered_at IS NULL) = (delivery_kind IS NULL)),
  -- CRITICAL уходит письмом немедленно, WARNING — дайджестом: вид доставки соответствует уровню [Р-156]
  CONSTRAINT alert_digest_is_warning_only CHECK (delivery_kind IS DISTINCT FROM 'EMAIL_DIGEST' OR severity = 'WARNING')
);
COMMENT ON TABLE tenant_data.alert IS 'Шаг 36 [Р-156]: событие, о котором должен узнать владелец. Без отметки доставки — недоставленное.';

SELECT security.register_table('tenant_data.alert', 'TENANT', 'mutable');
SELECT security.grant_retention('tenant_data.alert');
-- Данные тенанта по времени не удаляются без подтверждённого экспорта [ADR-0004]: алерт живёт до закрытия тенанта
INSERT INTO maintenance.retention_policy (table_name, method, bound)
VALUES ('tenant_data.alert', 'TENANT_CLOSURE_ONLY', 'MAX_AGE');

-- Недоставленные, свежие первыми: очередь доставки читается по этому индексу и не трогает доставленные
CREATE INDEX alert_undelivered_idx ON tenant_data.alert (severity, raised_at) WHERE delivered_at IS NULL;

/**
 * Алерт неизменяем, кроме отметки доставки. Стражем это НЕ дублируется [Р-104]: менять строку может только роль
 * доставки, и право у неё дано по столбцам (ниже) — переписать код или уровень события ей нечем, а страж
 * `restrict_update` был бы защитой, которую нечем провалить [Р-94].
 */
CREATE FUNCTION tenant_data.alert_before_write() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Время события ставит база: процесс со сбитыми часами не двигает очередь доставки
    NEW.raised_at := now();
    IF NEW.delivered_at IS NOT NULL THEN
      RAISE EXCEPTION 'an alert cannot be raised as already delivered (Р-156)' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  /**
   * Доставленная строка не меняется ВООБЩЕ. Первая редакция сравнивала время и пропускала любой UPDATE, который
   * `delivered_at` не трогал, — а следующая строка молча переставляла его на `now()` и меняла доказательство отправки
   * (находка 5 ревью шага 36). Отметка доставки — одна, и после неё событие неизменяемо.
   */
  IF OLD.delivered_at IS NOT NULL THEN
    RAISE EXCEPTION 'delivery of alert % is already recorded (Р-156)', OLD.alert_id USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.delivered_at IS NOT NULL THEN NEW.delivered_at := now(); END IF;
  RETURN NEW;
END $$;
ALTER FUNCTION tenant_data.alert_before_write() OWNER TO repracer_owner;
CREATE TRIGGER b_alert_before_write BEFORE INSERT OR UPDATE ON tenant_data.alert
  FOR EACH ROW EXECUTE FUNCTION tenant_data.alert_before_write();

/**
 * Поднимают алерты процессы, которые их и замечают: путь решения (недоверие каналу, заблокированная единица), диспетчер
 * записей и планировщик. Административной роли вставка не нужна — консоль алертов не поднимает, и её запись в эту
 * таблицу была бы административным действием со своими стражами [Р-97, Р-100]. Роли остатков — тоже: её список
 * разрешённого узок намеренно [Р-102, Р-105].
 */
GRANT INSERT ON tenant_data.alert TO repracer_app, repracer_dispatcher, repracer_retention;
/**
 * Менять и удалять событие административная роль не может: регистрация таблицы даёт ей эти права по умолчанию, и здесь
 * они снимаются — поднятое событие правит только доставка, и только отметкой.
 *
 * Честно про ВСТАВКУ (находка 6 ревью шага 36): снять её с административной роли нечем — `repracer_admin` входит в
 * `repracer_app`, а вставка нужна пути решения. Значит алерт может вставить любой процесс этого семейства, включая
 * административный сервис, и стража человека [Р-97] на этой таблице нет намеренно: алерт поднимает ПРОЦЕСС, а не
 * человек, и подписывать его человеком было бы неправдой. Цена этого названа: тот, кто уже имеет доступ к
 * административному сервису, может вписать в таблицу событие, которого не было. Читать и отмечать доставку он
 * по-прежнему не может.
 */
REVOKE UPDATE, DELETE ON tenant_data.alert FROM repracer_admin;
GRANT SELECT ON tenant_data.alert TO repracer_admin;

-- Доставка: читает алерты ВСЕХ тенантов и ставит только отметку доставки
CREATE POLICY alert_delivery_read ON tenant_data.alert FOR SELECT TO repracer_alert_delivery USING (true);
CREATE POLICY alert_delivery_mark ON tenant_data.alert FOR UPDATE TO repracer_alert_delivery USING (true) WITH CHECK (true);
GRANT SELECT ON tenant_data.alert TO repracer_alert_delivery;
GRANT UPDATE (delivered_at, delivery_kind, delivery_ref, delivery_attempts, last_delivery_error) ON tenant_data.alert TO repracer_alert_delivery;

/**
 * Кому писать: активный владелец тенанта. Доставка получает СВОИ политики чтения членств и пользователей — как
 * ретранслятор outbox (0038), который читает события всех тенантов. Больше она не видит ничего: ни цен, ни решений,
 * ни остатков. Адрес в журнал не попадает никогда — только код события и идентификаторы.
 */
CREATE POLICY alert_delivery_membership_read ON tenant_data.membership FOR SELECT TO repracer_alert_delivery USING (true);
GRANT SELECT (tenant_id, membership_id, user_id, role, status, created_at) ON tenant_data.membership TO repracer_alert_delivery;
CREATE POLICY alert_delivery_tenant_read ON tenant_data.tenant FOR SELECT TO repracer_alert_delivery USING (true);
GRANT SELECT (tenant_id, name, kind, status) ON tenant_data.tenant TO repracer_alert_delivery;
CREATE POLICY alert_delivery_user_read ON platform.app_user FOR SELECT TO repracer_alert_delivery USING (true);
GRANT SELECT (user_id, email) ON platform.app_user TO repracer_alert_delivery;
-- Письмо называет КАНАЛ: «у вас где-то не так» — не сообщение. Доставке нужны только имя канала и его витрины
CREATE POLICY alert_delivery_account_read ON tenant_data.channel_account FOR SELECT TO repracer_alert_delivery USING (true);
GRANT SELECT (tenant_id, channel_account_id, channel, marketplaces) ON tenant_data.channel_account TO repracer_alert_delivery;

CREATE FUNCTION security.tenant_owner_email(p_tenant_id uuid) RETURNS text
  LANGUAGE sql STABLE AS $fn$
  SELECT u.email
    FROM tenant_data.membership m
    JOIN platform.app_user u ON u.user_id = m.user_id
   WHERE m.tenant_id = p_tenant_id AND m.role = 'OWNER' AND m.status = 'ACTIVE'
   ORDER BY m.created_at
   LIMIT 1
$fn$;
ALTER FUNCTION security.tenant_owner_email(uuid) OWNER TO repracer_owner;
REVOKE ALL ON FUNCTION security.tenant_owner_email(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION security.tenant_owner_email(uuid) TO repracer_alert_delivery;

RESET ROLE;

-- Функции ниже принадлежат роли хранения и мигратору — переопределяются вне SET ROLE (как в 0115)
/**
 * Закрытие тенанта уносит и его алерты: правило «таблица тенанта названа в очистке тенанта» (0102) проверяет это само,
 * и без этой строки проверка схемы не проходит. Функция переписывается целиком — как принято в наборе миграций.
 */
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
    -- Шаг 36 [Р-156]: алерты тенанта уходят вместе с ним
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

/**
 * Р-96: путь решения ПОДНИМАЕТ алерты (недоверие каналу, заблокированная единица), значит вставка в `alert` входит в его
 * список разрешённого. Читать алерты он по-прежнему не может: письмо шлёт доставка, а не он.
 */
CREATE OR REPLACE FUNCTION security.decision_path_allowed_privileges()
 RETURNS TABLE(table_name text, privilege text, column_name text)
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
AS $function$
  SELECT t, p, c FROM (VALUES
    ('platform.marketplace', 'SELECT', NULL), ('platform.fx_rate', 'SELECT', NULL), ('platform.explanation_ruleset', 'SELECT', NULL),
    ('platform.channel_capability', 'SELECT', NULL), ('platform.vat_rate_default', 'SELECT', NULL),
    -- лимит правок аккаунта для бюджета записи (0008, channel_write_budget)
    ('tenant_data.channel_capability_override', 'SELECT', NULL),
    ('tenant_data.tenant', 'SELECT', NULL), ('tenant_data.channel_account', 'SELECT', NULL), ('tenant_data.product', 'SELECT', NULL),
    ('tenant_data.product_vat_rate', 'SELECT', NULL), ('tenant_data.offer_mapping', 'SELECT', NULL), ('tenant_data.pricing_strategy', 'SELECT', NULL),
    ('channel_data.pricing_strategy_undercut', 'SELECT', NULL), ('tenant_data.min_price', 'SELECT', NULL), ('tenant_data.max_price', 'SELECT', NULL),
    ('tenant_data.guardrail', 'SELECT', NULL), ('tenant_data.cost_profile', 'SELECT', NULL), ('channel_data.fee_estimate', 'SELECT', NULL),
    -- Шаг 36 [Р-156]: путь решения ПОДНИМАЕТ алерты (недоверие каналу, заблокированная единица); читать их он не может
    ('tenant_data.alert', 'INSERT', NULL),
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
    -- Шаг 23 [Р-118, Р-119, Р-39, Р-120]: недоверие каналу ставит путь решения и диспетчер; справочники каналов; наблюдения чужого ценообразования
    ('channel_data.channel_distrust', 'SELECT', NULL),
    ('channel_data.channel_distrust', 'INSERT', 'tenant_id'), ('channel_data.channel_distrust', 'INSERT', 'channel_account_id'), ('channel_data.channel_distrust', 'INSERT', 'channel'),
    ('channel_data.channel_distrust', 'INSERT', 'marketplace'), ('channel_data.channel_distrust', 'INSERT', 'reason_code'), ('channel_data.channel_distrust', 'INSERT', 'details'),
    ('channel_data.channel_distrust', 'INSERT', 'detected_at'),
    ('platform.channel_behaviour', 'SELECT', NULL), ('platform.competitor_source', 'SELECT', NULL),
    ('channel_data.offer_channel_pricing', 'SELECT', NULL), ('channel_data.offer_channel_pricing', 'INSERT', NULL),
    -- Шаг 23 (0083): журнал обработанных уведомлений и состояние PRICING_HEALTH — пишет приёмник уведомлений в транзакции тенанта
    ('channel_data.inbound_notification', 'SELECT', NULL), ('channel_data.inbound_notification', 'INSERT', NULL),
    ('channel_data.offer_pricing_health', 'SELECT', NULL), ('channel_data.offer_pricing_health', 'INSERT', NULL),
    -- Шаг 24 (0086) [Р-122]: полный снимок конкурентов — в транзитный журнал в транзакции снимка; выгрузка в ClickHouse — роль экспорта
    ('channel_data.competitor_snapshot_log', 'INSERT', NULL),
    -- Шаг 24 (0088) [Р-121]: проверку потери уведомления путь решения записывает, вердикт — только читает
    ('channel_data.notification_loss_check', 'SELECT', NULL), ('channel_data.notification_loss_check', 'INSERT', NULL),
    ('channel_data.notification_loss_verdict', 'SELECT', NULL),
    -- Шаг 25 (0090) [Р-121, Р-126]: время последнего опроса товара — ярусный опрос планировщика не зависит от времени уведомлений
    -- Шаг 25 (0091, риск 28): отметка неприменённой цены — триггер завершения записи в транзакции пути решения и диспетчера
    ('tenant_data.price_history_not_applied', 'INSERT', NULL),
    -- OQ-180 (шаг 26): время применения цены каналом пишет путь решения при завершении записи; закрытые сутки он читает
    ('tenant_data.price_history_applied', 'INSERT', NULL), 
    ('channel_data.competitor_poll_state', 'SELECT', NULL), ('channel_data.competitor_poll_state', 'INSERT', NULL), ('channel_data.competitor_poll_state', 'UPDATE', NULL),
    ('channel_data.pricing_halt_sample', 'SELECT', NULL),
    ('channel_data.pricing_halt_sample', 'INSERT', 'tenant_id'), ('channel_data.pricing_halt_sample', 'INSERT', 'pricing_halt_id'), ('channel_data.pricing_halt_sample', 'INSERT', 'channel_product_ref'), ('channel_data.pricing_halt_sample', 'INSERT', 'observed_at'), ('channel_data.pricing_halt_sample', 'INSERT', 'verdict'), ('channel_data.pricing_halt_sample', 'INSERT', 'reason_code')
  ) AS a(t, p, c)
$function$;

COMMIT;
