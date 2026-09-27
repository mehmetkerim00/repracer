-- 0132_channel_oauth_credentials.sql
-- Шаг 43 [Р-175…Р-177]: канал подключает сам продавец — OAuth поставщика канала, токены как секреты, отзыв авторизации.
--
-- Часть A — запрос согласия (`channel_authorization_request`). Продавец нажимает «Подключить», мы уводим его на страницу
-- согласия канала и ждём возврата с кодом. В базе НЕТ самого `state` — только его SHA-256: строка запроса, попавшая в
-- чужие руки, не даёт подделать возврат. Срок запроса — не больше десяти минут: так говорит документация Amazon
-- («поток дольше 10 минут может сломаться», код живёт 5 минут — vendor/amazon/lwa-authorization).
--
-- Часть B — токены (`channel_credential`) [Р-177]. Хранится ТОЛЬКО refresh-токен, и только зашифрованным (AES-256-GCM,
-- ключ — в файле секретов на машине, в базе его нет): копия базы токенов не раскрывает. Короткоживущий access-токен в
-- базу не пишется вовсе — он живёт в памяти процесса адаптера. Шифротекст читает ОДНА роль — `repracer_credentials`,
-- роль адаптеров; административная роль (консоль) токен ЗАПИСЫВАЕТ, но прочитать его не может — право по столбцам.
--
-- Часть C — отзыв [Р-177]. Продавец отзывает авторизацию на стороне канала; уведомления об этом каналы не шлют
-- (A-18), и обнаруживается отзыв обменом токена. Функция базы переводит аккаунт в понятное состояние и поднимает
-- CRITICAL-алерт, который доставка [Р-156] отправляет владельцу письмом.
--
-- Часть D — хвосты шага 42: деньги дайджеста за ВСЮ неделю (OQ-232), индексированная сумма (OQ-233), витрина вне
-- справочника держит бой (OQ-231), период дайджеста — ISO-неделя в UTC (находка 13), индекс без читателя (находка 12).

BEGIN;

-- ================================================================ роль адаптеров: единственная, кто читает токен
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'repracer_credentials') THEN
    CREATE ROLE repracer_credentials NOLOGIN NOBYPASSRLS;
  END IF;
END $$;
COMMENT ON ROLE repracer_credentials IS
  'Шаг 43 [Р-177]: роль адаптеров каналов — единственная, кто читает шифротекст refresh-токена; ни цен, ни решений не видит';
GRANT USAGE ON SCHEMA tenant_data, security, platform TO repracer_credentials;

SET ROLE repracer_owner;

-- ================================================================ A. запрос согласия
CREATE TABLE tenant_data.channel_authorization_request (
  tenant_id                   uuid NOT NULL,
  authorization_request_id    uuid NOT NULL DEFAULT gen_random_uuid(),
  channel                     text NOT NULL CONSTRAINT channel_authorization_request_channel_oauth CHECK (channel IN ('AMAZON', 'EBAY')),
  -- Регион Amazon: страница согласия и конечная точка SP-API зависят от него; у eBay — NULL
  region                      text,
  marketplaces                text[] NOT NULL,
  /**
   * SHA-256 параметра `state`. Сам `state` не хранится нигде: он уходит в адрес согласия и возвращается с кодом, а база
   * сверяет отпечаток. Утечка строки запроса не даёт подделать возврат [Р-177].
   */
  state_sha256                bytea NOT NULL CONSTRAINT channel_authorization_request_state_is_sha256 CHECK (octet_length(state_sha256) = 32),
  requested_by_membership_id  uuid NOT NULL,
  requested_at                timestamptz NOT NULL DEFAULT now(),
  expires_at                  timestamptz NOT NULL,
  status                      text NOT NULL DEFAULT 'PENDING'
    CONSTRAINT channel_authorization_request_status_known CHECK (status IN ('PENDING', 'COMPLETED', 'EXPIRED', 'DENIED', 'FAILED')),
  completed_at                timestamptz,
  channel_account_id          uuid,
  failure_code                text,
  /**
   * Находка 9 ревью шага 43: обмен кода ЗАХВАТЫВАЕТСЯ до обращения к каналу — один возврат из двух одновременных
   * (двойной эффект страницы, повтор из вкладки) меняет код, второй получает «уже обменивается» и ничего не портит.
   */
  exchange_started_at         timestamptz,
  PRIMARY KEY (tenant_id, authorization_request_id),
  CONSTRAINT channel_authorization_request_state_unique UNIQUE (state_sha256),
  FOREIGN KEY (tenant_id, channel_account_id) REFERENCES tenant_data.channel_account (tenant_id, channel_account_id),
  /**
   * Не дольше десяти минут: документация Amazon — «если весь поток дольше 10 минут, он может сломаться», код живёт пять.
   * Запрос, который можно завершить через час, — это окно для атаки подменой возврата, а не удобство.
   */
  CONSTRAINT channel_authorization_request_short_lived
    CHECK (expires_at > requested_at AND expires_at <= requested_at + interval '10 minutes'),
  CONSTRAINT channel_authorization_request_completed_names_account CHECK ((status = 'COMPLETED') = (channel_account_id IS NOT NULL)),
  CONSTRAINT channel_authorization_request_failure_named CHECK ((status IN ('DENIED', 'FAILED')) = (failure_code IS NOT NULL)),
  CONSTRAINT channel_authorization_request_region_for_amazon CHECK ((channel = 'AMAZON') = (region IS NOT NULL))
);
COMMENT ON TABLE tenant_data.channel_authorization_request IS
  'Шаг 43 [Р-175]: продавец ушёл на страницу согласия канала; в базе только SHA-256 параметра state, срок — до 10 минут';

SELECT security.register_table('tenant_data.channel_authorization_request', 'TENANT', 'mutable');
SELECT security.grant_retention('tenant_data.channel_authorization_request');
INSERT INTO maintenance.retention_policy (table_name, method, bound)
VALUES ('tenant_data.channel_authorization_request', 'TENANT_CLOSURE_ONLY', 'MAX_AGE');

/**
 * Запрос завершается ОДИН раз, только из ожидания и только до срока. Возврат, пришедший через час, отклоняет база:
 * завершить просроченный запрос значило бы принять код, который продавец давно мог выдать кому-то другому.
 */
CREATE FUNCTION tenant_data.channel_authorization_request_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.requested_at := now();
    IF NEW.status <> 'PENDING' THEN
      RAISE EXCEPTION 'an authorization request starts PENDING (Р-175)' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status <> 'PENDING' THEN
    RAISE EXCEPTION 'authorization request % is already %', OLD.authorization_request_id, OLD.status
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.exchange_started_at IS DISTINCT FROM OLD.exchange_started_at THEN
    IF OLD.exchange_started_at IS NOT NULL THEN
      RAISE EXCEPTION 'the code exchange of authorization request % is already claimed (Р-175)', OLD.authorization_request_id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF now() > OLD.expires_at THEN
      RAISE EXCEPTION 'authorization request % expired at %: the consent came back too late (Р-175)', OLD.authorization_request_id, OLD.expires_at
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  IF NEW.status = 'COMPLETED' AND now() > OLD.expires_at THEN
    RAISE EXCEPTION 'authorization request % expired at %: the consent came back too late (Р-175)', OLD.authorization_request_id, OLD.expires_at
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.status <> 'PENDING' THEN NEW.completed_at := now(); END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER b_channel_authorization_request_guard BEFORE INSERT OR UPDATE ON tenant_data.channel_authorization_request
  FOR EACH ROW EXECUTE FUNCTION tenant_data.channel_authorization_request_guard();
CREATE TRIGGER channel_authorization_request_restrict_update BEFORE UPDATE ON tenant_data.channel_authorization_request
  FOR EACH ROW EXECUTE FUNCTION security.restrict_update('status', 'completed_at', 'channel_account_id', 'failure_code', 'exchange_started_at');

-- ================================================================ B. токены
CREATE TABLE tenant_data.channel_credential (
  tenant_id                 uuid NOT NULL,
  channel_credential_id     uuid NOT NULL DEFAULT gen_random_uuid(),
  channel_account_id        uuid NOT NULL,
  -- Версию считает база (страж вставки), права задать её нет ни у кого: ограничение «≥ 1» было бы нечем провалить [Р-104]
  version                   int NOT NULL,
  /** Ключ шифрования — имя ключа из файла секретов; сам ключ в базе не лежит никогда */
  key_id                    text NOT NULL CONSTRAINT channel_credential_key_id_shape CHECK (key_id ~ '^[a-z0-9][a-z0-9-]{0,31}$'),
  iv                        bytea NOT NULL CONSTRAINT channel_credential_iv_gcm CHECK (octet_length(iv) = 12),
  auth_tag                  bytea NOT NULL CONSTRAINT channel_credential_tag_gcm CHECK (octet_length(auth_tag) = 16),
  ciphertext                bytea NOT NULL,
  obtained_at               timestamptz NOT NULL DEFAULT now(),
  /** Срок refresh-токена, если канал его сообщает (eBay — E-10); у Amazon — «авторизовать заново раз в год» */
  refresh_expires_at        timestamptz,
  created_by_membership_id  uuid,
  /** Последняя успешная проверка обменом токена и число провалов подряд — пишет только роль адаптеров */
  verified_at               timestamptz,
  check_failures            int NOT NULL DEFAULT 0 CONSTRAINT channel_credential_failures_non_negative CHECK (check_failures >= 0),
  last_check_code           text,
  superseded_at             timestamptz,
  PRIMARY KEY (tenant_id, channel_credential_id),
  CONSTRAINT channel_credential_version_unique UNIQUE (tenant_id, channel_account_id, version),
  FOREIGN KEY (tenant_id, channel_account_id) REFERENCES tenant_data.channel_account (tenant_id, channel_account_id),
  /**
   * ОТКРЫТЫЙ ТОКЕН В БАЗУ НЕ ПОПАДАЕТ. Шифротекст AES-GCM случаен, а refresh-токен Amazon начинается с `Atzr|` (пример
   * документации) — строка с таким началом значит, что сюда положили открытый текст. Проверка грубая намеренно: она
   * ловит самую вероятную ошибку — забытое шифрование, — а не угадывает формат токенов всех каналов.
   */
  CONSTRAINT channel_credential_not_plaintext
    CHECK (octet_length(ciphertext) >= 16 AND substring(ciphertext FROM 1 FOR 5) <> convert_to('Atzr|', 'UTF8'))
);
COMMENT ON TABLE tenant_data.channel_credential IS
  'Шаг 43 [Р-177]: refresh-токен канала — ТОЛЬКО шифротекст AES-256-GCM; читает одна роль адаптеров; access-токен в базе не хранится';

SELECT security.register_table('tenant_data.channel_credential', 'TENANT', 'mutable');
SELECT security.grant_retention('tenant_data.channel_credential');
/**
 * Находка 1 ревью шага 43 (критичная): `grant_retention` выдаёт роли удаления по сроку SELECT на ВСЕ столбцы, а в ней
 * состоят планировщик и пул консоли — то есть консоль с кольцом ключей расшифровала бы токены всех тенантов. Удалению
 * нужен предикат, а не шифротекст: право — по столбцам ключа.
 */
REVOKE SELECT ON tenant_data.channel_credential FROM repracer_retention;
GRANT SELECT (tenant_id, channel_credential_id, channel_account_id) ON tenant_data.channel_credential TO repracer_retention;
INSERT INTO maintenance.retention_policy (table_name, method, bound)
VALUES ('tenant_data.channel_credential', 'TENANT_CLOSURE_ONLY', 'MAX_AGE');

-- Одна действующая версия на аккаунт: адаптер берёт её, а не «какую-нибудь»
CREATE UNIQUE INDEX channel_credential_one_current ON tenant_data.channel_credential (tenant_id, channel_account_id)
  WHERE superseded_at IS NULL;
-- Проверка авторизаций планировщиком: действующие версии, давно не проверенные, — первыми
CREATE INDEX channel_credential_check_due_idx ON tenant_data.channel_credential (verified_at NULLS FIRST)
  WHERE superseded_at IS NULL;

/**
 * Новая версия вытесняет прежнюю ЗДЕСЬ, а не у вызывающего: иначе две действующие версии жили бы до исправления кода.
 * Версия считается базой — вызывающий её не выбирает. Права менять строку у административной роли нет вовсе.
 */
CREATE FUNCTION tenant_data.channel_credential_before_insert() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
BEGIN
  -- Время получения, отметки проверки и вытеснения административная роль не вставляет вовсе (права по столбцам):
  -- их сброс здесь был бы дублем, который нечем провалить [Р-104, находка 11 ревью шага 43]
  SELECT coalesce(max(c.version), 0) + 1 INTO NEW.version FROM tenant_data.channel_credential c
   WHERE c.tenant_id = NEW.tenant_id AND c.channel_account_id = NEW.channel_account_id;
  UPDATE tenant_data.channel_credential SET superseded_at = now()
   WHERE tenant_id = NEW.tenant_id AND channel_account_id = NEW.channel_account_id AND superseded_at IS NULL;
  RETURN NEW;
END $fn$;
CREATE TRIGGER a_channel_credential_before_insert BEFORE INSERT ON tenant_data.channel_credential
  FOR EACH ROW EXECUTE FUNCTION tenant_data.channel_credential_before_insert();

/**
 * Шифротекст неизменяем: новая авторизация — новая версия. Стражем `restrict_update` это НЕ дублируется [Р-104]:
 * менять строку может только роль адаптеров, и право у неё дано ПО СТОЛБЦАМ отметок (ниже) — шифротекст ей переписать
 * нечем, а у административной роли права на UPDATE нет вовсе.
 */

RESET ROLE;

-- Владелец функции вытеснения — роль адаптеров: ей и нужно право менять отметки; у административной его нет
ALTER FUNCTION tenant_data.channel_credential_before_insert() OWNER TO repracer_credentials;

/**
 * ПРАВА [Р-177, Р-100]. Административная роль (консоль после обмена кода) токен ЗАПИСЫВАЕТ и видит, что он есть и когда
 * получен, — но не шифротекст. Роль адаптеров читает всё и ставит отметки проверки. Остальные роли не видят таблицу
 * вовсе; удаление по сроку — только при закрытии тенанта.
 */
REVOKE ALL ON tenant_data.channel_credential FROM repracer_app, repracer_admin;
GRANT INSERT (tenant_id, channel_account_id, key_id, iv, auth_tag, ciphertext, refresh_expires_at, created_by_membership_id)
  ON tenant_data.channel_credential TO repracer_admin;
GRANT SELECT (tenant_id, channel_credential_id, channel_account_id, version, key_id, obtained_at, refresh_expires_at,
              created_by_membership_id, verified_at, check_failures, last_check_code, superseded_at)
  ON tenant_data.channel_credential TO repracer_admin;
GRANT SELECT ON tenant_data.channel_credential TO repracer_credentials;
GRANT UPDATE (verified_at, check_failures, last_check_code, superseded_at) ON tenant_data.channel_credential TO repracer_credentials;
CREATE POLICY credentials_read ON tenant_data.channel_credential FOR SELECT TO repracer_credentials USING (true);
CREATE POLICY credentials_mark ON tenant_data.channel_credential FOR UPDATE TO repracer_credentials USING (true) WITH CHECK (true);
-- Адаптеру нужен аккаунт (канал, регион), чтобы выбрать конечную точку обмена токена
GRANT SELECT (tenant_id, channel_account_id, channel, region, marketplaces, auth_status, disconnected_at, credentials_ref)
  ON tenant_data.channel_account TO repracer_credentials;
CREATE POLICY credentials_account_read ON tenant_data.channel_account FOR SELECT TO repracer_credentials USING (true);

-- ================================================================ C. отзыв и проверка
/**
 * Итог проверки обменом токена. Успех — отметка времени и сброс провалов. Отзыв (`invalid_grant`, A-17) — аккаунт
 * переходит в `REVOKED`, и это НЕ тихая ошибка: поднимается CRITICAL-алерт, который доставка отправляет владельцу
 * письмом [Р-156]. Временный провал — счётчик; после трёх подряд — WARNING, аккаунт не трогается: сеть и сбой канала
 * не отзыв, и объявлять их отзывом значило бы пугать продавца.
 */
CREATE FUNCTION security.channel_authorization_checked(p_tenant_id uuid, p_credential_id uuid, p_outcome text, p_code text DEFAULT NULL)
  RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
DECLARE
  c record;
  failures int;
BEGIN
  IF p_outcome NOT IN ('OK', 'REVOKED', 'TRANSIENT', 'PLATFORM') THEN
    RAISE EXCEPTION 'unknown authorization check outcome %', p_outcome USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT cr.channel_account_id, cr.superseded_at, ca.auth_status INTO c
    FROM tenant_data.channel_credential cr
    JOIN tenant_data.channel_account ca ON ca.tenant_id = cr.tenant_id AND ca.channel_account_id = cr.channel_account_id
   WHERE cr.tenant_id = p_tenant_id AND cr.channel_credential_id = p_credential_id;
  IF c.channel_account_id IS NULL THEN
    RAISE EXCEPTION 'credential % of tenant % is unknown', p_credential_id, p_tenant_id USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  -- Итог проверки ВЫТЕСНЕННОЙ версии аккаунт не трогает: продавец уже авторизовал заново, и старый отказ — не новость
  IF c.superseded_at IS NOT NULL THEN
    RETURN 'SUPERSEDED';
  END IF;
  IF p_outcome = 'OK' THEN
    UPDATE tenant_data.channel_credential SET verified_at = now(), check_failures = 0, last_check_code = NULL
     WHERE tenant_id = p_tenant_id AND channel_credential_id = p_credential_id;
    RETURN 'OK';
  END IF;
  UPDATE tenant_data.channel_credential SET check_failures = check_failures + 1, last_check_code = left(coalesce(p_code, p_outcome), 64)
   WHERE tenant_id = p_tenant_id AND channel_credential_id = p_credential_id
  RETURNING check_failures INTO failures;
  IF p_outcome = 'REVOKED' THEN
    IF c.auth_status = 'ACTIVE' THEN
      UPDATE tenant_data.channel_account SET auth_status = 'REVOKED'
       WHERE tenant_id = p_tenant_id AND channel_account_id = c.channel_account_id;
      INSERT INTO tenant_data.alert (tenant_id, code, severity, channel_account_id, details)
      VALUES (p_tenant_id, 'CHANNEL_AUTHORIZATION_REVOKED', 'CRITICAL', c.channel_account_id,
              jsonb_build_object('code', left(coalesce(p_code, 'invalid_grant'), 64)));
    END IF;
    RETURN 'REVOKED';
  END IF;
  IF p_outcome = 'TRANSIENT' AND failures = 3 THEN
    INSERT INTO tenant_data.alert (tenant_id, code, severity, channel_account_id, details)
    VALUES (p_tenant_id, 'CHANNEL_AUTHORIZATION_CHECK_FAILING', 'WARNING', c.channel_account_id,
            jsonb_build_object('failures', failures, 'code', left(coalesce(p_code, 'TRANSIENT'), 64)));
  END IF;
  RETURN p_outcome;
END $fn$;
ALTER FUNCTION security.channel_authorization_checked(uuid, uuid, text, text) OWNER TO repracer_credentials;
REVOKE EXECUTE ON FUNCTION security.channel_authorization_checked(uuid, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION security.channel_authorization_checked(uuid, uuid, text, text) TO repracer_credentials;
-- Роль адаптеров переводит аккаунт в REVOKED — только этот столбец — и поднимает алерт
GRANT UPDATE (auth_status) ON tenant_data.channel_account TO repracer_credentials;
CREATE POLICY credentials_account_revoke ON tenant_data.channel_account FOR UPDATE TO repracer_credentials USING (true) WITH CHECK (true);
GRANT INSERT ON tenant_data.alert TO repracer_credentials;
CREATE POLICY credentials_alert_raise ON tenant_data.alert FOR INSERT TO repracer_credentials WITH CHECK (true);

-- ================================================================ административная запись: действие и его стражи
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
    ('tenant_data.stock_allocation', 'MANAGE_CATALOG'), ('channel_data.reservation', 'MANAGE_CATALOG'), ('channel_data.sync_job', 'MANAGE_CATALOG'),
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
    ('tenant_data.price_stop', 'OWN_GUARD'), ('channel_data.pricing_halt_review', 'OWN_GUARD'), ('tenant_data.membership', 'OWN_GUARD'),
    ('channel_data.pricing_halt_sample', 'OWN_GUARD')
  ) AS t(tbl, a) WHERE tbl = p_table
$function$;

CREATE TRIGGER a0_admin_write_person_insert BEFORE INSERT ON tenant_data.channel_authorization_request
  FOR EACH ROW EXECUTE FUNCTION security.require_person_for_admin_write();
CREATE TRIGGER a0_admin_write_person_update BEFORE UPDATE ON tenant_data.channel_authorization_request
  FOR EACH ROW EXECUTE FUNCTION security.require_person_for_admin_write();
CREATE TRIGGER zc_channel_authorization_request_audit AFTER INSERT OR UPDATE ON tenant_data.channel_authorization_request
  FOR EACH ROW EXECUTE FUNCTION security.audit_admin_write();
CREATE TRIGGER a0_admin_write_person_insert BEFORE INSERT ON tenant_data.channel_credential
  FOR EACH ROW EXECUTE FUNCTION security.require_person_for_admin_write();
-- Аудит пишет ИМЕНА изменённых столбцов, а не значения: шифротекст в журнал не попадает (security.audit_admin_write)
CREATE TRIGGER zc_channel_credential_audit AFTER INSERT ON tenant_data.channel_credential
  FOR EACH ROW EXECUTE FUNCTION security.audit_admin_write();

-- ================================================================ D. хвосты шага 42
/**
 * OQ-232: деньги дайджеста — за ВСЮ неделю, а не за три дня горячего намерения. Цель стратегии выведена из цены
 * конкурента, и в вечное ядро ей нельзя [Р-85]; но Р-91 уже нашёл форму для таких величин: отдельная таблица со сроком
 * данных канала. Здесь — «на сколько ниже пола хотела стратегия», записанное В МОМЕНТ намерения триггером.
 */
SET ROLE repracer_owner;
CREATE TABLE channel_data.floor_hold (
  tenant_id          uuid NOT NULL,
  price_intent_id    uuid NOT NULL,
  intent_created_at  timestamptz NOT NULL,
  write_scope_id     uuid NOT NULL,
  currency           text NOT NULL CONSTRAINT floor_hold_currency_iso CHECK (currency ~ '^[A-Z]{3}$'),
  below_minor        bigint NOT NULL CONSTRAINT floor_hold_below_positive CHECK (below_minor > 0),
  -- Режим аккаунта в момент намерения: сумма дайджеста берёт только тень и не соединяется с решениями (OQ-233)
  shadow             boolean NOT NULL,
  PRIMARY KEY (tenant_id, price_intent_id)
);
COMMENT ON TABLE channel_data.floor_hold IS
  'Шаг 42→43 [Р-173, OQ-232]: на сколько ниже пола хотела стратегия — производная от цены конкурента, срок данных канала, не вечное ядро';
SELECT security.register_table('channel_data.floor_hold', 'CHANNEL', 'append_only');
SELECT security.grant_retention('channel_data.floor_hold');
-- Данные канала — не дольше 18 месяцев [Р-3, Р-38]; дайджесту хватает недели, отчёту границ — горячего окна
INSERT INTO maintenance.retention_policy (table_name, method, anchor_column, retention, bound)
VALUES ('channel_data.floor_hold', 'DELETE_ROWS', 'intent_created_at', interval '18 months', 'MAX_AGE');
-- OQ-233: сумма за окно — диапазон по индексу, а не проход по слепкам намерений с разбором JSON у каждой строки
CREATE INDEX floor_hold_tenant_time_idx ON channel_data.floor_hold (tenant_id, intent_created_at);

CREATE FUNCTION channel_data.price_intent_record_floor_hold() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
DECLARE
  target bigint;
  in_shadow boolean;
BEGIN
  SELECT (x -> 'params' ->> 'targetMinor')::bigint INTO target
    FROM jsonb_array_elements(coalesce(NEW.rationale -> 'explanation', '[]'::jsonb)) x
   WHERE x ->> 'code' IN ('CAPPED_AT_MIN_PRICE', 'TARGET_OUTSIDE_BOUNDS_HOLD') AND x -> 'params' ? 'targetMinor'
   LIMIT 1;
  IF target IS NOT NULL AND target < NEW.proposed_amount_minor THEN
    -- Тот же источник, что у признака тени решения (0128): режим аккаунта единицы записи в этой транзакции
    SELECT ca.write_mode = 'SHADOW' INTO in_shadow
      FROM tenant_data.write_scope ws
      JOIN tenant_data.channel_account ca ON ca.tenant_id = ws.tenant_id AND ca.channel_account_id = ws.channel_account_id
     WHERE ws.tenant_id = NEW.tenant_id AND ws.write_scope_id = NEW.write_scope_id;
    INSERT INTO channel_data.floor_hold (tenant_id, price_intent_id, intent_created_at, write_scope_id, currency, below_minor, shadow)
    VALUES (NEW.tenant_id, NEW.price_intent_id, NEW.created_at, NEW.write_scope_id, NEW.currency, NEW.proposed_amount_minor - target, coalesce(in_shadow, false))
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NULL;
END $fn$;
CREATE TRIGGER zd_price_intent_record_floor_hold AFTER INSERT ON channel_data.price_intent
  FOR EACH ROW EXECUTE FUNCTION channel_data.price_intent_record_floor_hold();
RESET ROLE;
/**
 * Находка 12 ревью шага 43: строку удержания пишет ТОЛЬКО триггер намерения. Право вставки у пути решения позволяло бы
 * любому его коду подделать сумму «без пола продали бы дешевле» [Р-173]; у функции — своя узкая роль [Р-90]: вставить
 * удержание и прочитать режим аккаунта единицы записи, больше ничего.
 */
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'repracer_floor_hold') THEN CREATE ROLE repracer_floor_hold NOLOGIN; END IF;
END $$;
GRANT USAGE ON SCHEMA channel_data, tenant_data, security TO repracer_floor_hold;
GRANT EXECUTE ON FUNCTION security.current_tenant_id() TO repracer_floor_hold;
GRANT INSERT ON channel_data.floor_hold TO repracer_floor_hold;
-- Консоль (ручная цена) вставляет намерение — удержание пишет тот же триггер; своего права вставки у неё нет
REVOKE INSERT ON channel_data.floor_hold FROM repracer_admin, repracer_app;
CREATE POLICY floor_hold_writer ON channel_data.floor_hold FOR INSERT TO repracer_floor_hold WITH CHECK (tenant_id = security.current_tenant_id());
GRANT SELECT (tenant_id, write_scope_id, channel_account_id) ON tenant_data.write_scope TO repracer_floor_hold;
CREATE POLICY floor_hold_scope_read ON tenant_data.write_scope FOR SELECT TO repracer_floor_hold USING (tenant_id = security.current_tenant_id());
GRANT SELECT (tenant_id, channel_account_id, write_mode) ON tenant_data.channel_account TO repracer_floor_hold;
CREATE POLICY floor_hold_account_read ON tenant_data.channel_account FOR SELECT TO repracer_floor_hold USING (tenant_id = security.current_tenant_id());
ALTER FUNCTION channel_data.price_intent_record_floor_hold() SECURITY DEFINER;
ALTER FUNCTION channel_data.price_intent_record_floor_hold() OWNER TO repracer_floor_hold;
REVOKE EXECUTE ON FUNCTION channel_data.price_intent_record_floor_hold() FROM PUBLIC;
-- Секции намерений создаёт владелец схемы (ensure_partitions) — с копией триггера, для чего ему нужен EXECUTE
GRANT EXECUTE ON FUNCTION channel_data.price_intent_record_floor_hold() TO repracer_owner;
GRANT SELECT ON channel_data.floor_hold TO repracer_admin;

/**
 * Сумма и число удержаний — теперь из `floor_hold` по индексу и за всё окно. Окно по-прежнему приходит моментом
 * (находка 4 ревью шага 42). Решение нужно, чтобы отличить тень от боя: теневые — только решения с признаком shadow.
 */
CREATE FUNCTION platform.shadow_floor_savings_between(p_tenant_id uuid, p_from timestamptz, p_to timestamptz)
  RETURNS TABLE (savings jsonb, priced bigint)
  LANGUAGE sql STABLE SET search_path = pg_catalog AS $fn$
  -- OQ-233: проход по индексу (tenant_id, intent_created_at) за окно — без соединения с решениями и без разбора JSON
  WITH held AS (
    SELECT fh.currency, fh.below_minor AS below
      FROM channel_data.floor_hold fh
     WHERE fh.tenant_id = p_tenant_id AND fh.intent_created_at >= p_from AND fh.intent_created_at < p_to AND fh.shadow
  )
  SELECT coalesce((SELECT jsonb_agg(jsonb_build_object('currency', currency, 'minor', total) ORDER BY currency)
                     FROM (SELECT currency, sum(below)::bigint AS total FROM held GROUP BY currency) g), '[]'::jsonb),
         (SELECT count(*) FROM held)
$fn$;
-- Экран тени — скользящее окно «до сих пор»: та же сумма с верхней границей «сейчас»
CREATE OR REPLACE FUNCTION platform.shadow_floor_savings(p_tenant_id uuid, p_from timestamptz)
  RETURNS TABLE (savings jsonb, priced bigint)
  LANGUAGE sql STABLE SET search_path = pg_catalog AS $fn$
  SELECT * FROM platform.shadow_floor_savings_between(p_tenant_id, p_from, now())
$fn$;
GRANT SELECT ON channel_data.floor_hold TO repracer_retention;

/**
 * Находка 13 ревью шага 42: период дайджеста — ISO-НЕДЕЛЯ в UTC, а не «сутки минус семь дней» в поясе сессии. Два
 * запуска в разные дни одной недели дают ОДИН период, и второе письмо о той же неделе отклоняет уникальность строки.
 */
CREATE OR REPLACE FUNCTION platform.shadow_digest_period_start(p_at timestamptz) RETURNS timestamptz
  LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $fn$
  SELECT date_trunc('week', p_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
$fn$;

DO $$
DECLARE
  def text := pg_get_functiondef('platform.shadow_digest_targets(interval)'::regprocedure);
  old_win text := $w$SELECT date_trunc('day', now()) - greatest(p_since, interval '1 hour') AS from_ts, now() AS to_ts$w$;
  /**
   * Находка 3 ревью шага 43 (критичная): период — ЦЕЛАЯ ISO-неделя [пн 00:00, пн 00:00) UTC, в которую попадает
   * `now() − p_since`; по умолчанию (7 суток) — прошлая, закрытая. Окно «с понедельника по сей день» теряло дни после
   * запуска: письмо в среду покрывало пн–ср, а чт–вс не попадали ни в одно. Прогоны на виртуальных часах текущей недели
   * передают `p_since` = 0.
   */
  new_win text := $w$SELECT platform.shadow_digest_period_start(now() - p_since) AS from_ts, platform.shadow_digest_period_start(now() - p_since) + interval '7 days' AS to_ts$w$;
  pairs text[][] := ARRAY[
    ARRAY['pd.decided_at >= w.from_ts)', 'pd.decided_at >= w.from_ts AND pd.decided_at < w.to_ts)'],
    ARRAY['wh.finished_at >= w.from_ts)', 'wh.finished_at >= w.from_ts AND wh.finished_at < w.to_ts)'],
    ARRAY['platform.shadow_floor_savings(s.tenant_id, w.from_ts)', 'platform.shadow_floor_savings_between(s.tenant_id, w.from_ts, w.to_ts)']];
  k int;
BEGIN
  IF position(old_win IN def) = 0 THEN
    RAISE EXCEPTION 'shadow_digest_targets: the window expression was not found — the function changed, update this migration';
  END IF;
  def := replace(def, old_win, new_win);
  FOR k IN 1 .. array_length(pairs, 1) LOOP
    IF position(pairs[k][1] IN def) = 0 THEN
      RAISE EXCEPTION 'shadow_digest_targets: % was not found — the function changed, update this migration', pairs[k][1];
    END IF;
    def := replace(def, pairs[k][1], pairs[k][2]);
  END LOOP;
  EXECUTE def;
END $$;
ALTER FUNCTION platform.shadow_digest_targets(interval) OWNER TO repracer_retention;

-- Находка 12 ревью шага 42: индекс без читателя удаляется — повтор недоставленного идёт по строке периода
DROP INDEX tenant_data.shadow_digest_undelivered_idx;

/**
 * Находка 14 ревью шага 42 — поправка к комментарию 0130 (сама 0130 уже в main и задним числом не правится [Р-146]):
 * «словарь статусов один на все свойства» верно для ОТВЕТА ревизии `platform.marketplace_readiness()`, а хранится он
 * по-разному. У налоговой базы и области записи — столбцом с этим словарём; у границы суток столбец прежний
 * (`time_zone_status`: CONFIRMED | TO_VERIFY, 0040), и статус ВЫВОДИТ функция: CONFIRMED → CONFIRMED, пояс не задан →
 * UNKNOWN, иначе CONSERVATIVE. Второго столбца статуса пояса не заводится [Р-104].
 */

/**
 * OQ-231: витрина аккаунта, которой НЕТ в справочнике, — неизвестна по определению: про её границу суток и налоговую базу
 * мы не знаем ничего и даже не считали это неизвестным. Правило Р-172 теперь считает такую витрину неизвестной.
 */
CREATE OR REPLACE FUNCTION security.marketplace_properties_unknown(p_channel text, p_marketplaces text[])
  RETURNS text
  LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS $fn$
DECLARE
  u record;
  outside text;
BEGIN
  SELECT string_agg(mk, ', ' ORDER BY mk) INTO outside
    FROM unnest(p_marketplaces) mk
   WHERE NOT EXISTS (SELECT 1 FROM platform.marketplace m WHERE m.channel = p_channel AND m.marketplace = mk);
  SELECT count(*) AS seen,
         count(*) FILTER (WHERE r.status = 'UNKNOWN') AS unknown,
         min(CASE WHEN r.status = 'UNKNOWN' THEN r.marketplace || ' / ' || r.property || ' (' || coalesce(r.question, 'вопрос не назван') || ')' END) AS first_unknown
    INTO u
    FROM platform.marketplace_readiness() r
   WHERE r.channel = p_channel AND r.marketplace = ANY (p_marketplaces);
  IF u.seen = 0 THEN
    RETURN 'свойства витрин не видны: ' || coalesce(array_to_string(p_marketplaces, ', '), 'витрины не названы');
  END IF;
  IF outside IS NOT NULL THEN
    RETURN outside || ' / витрины нет в справочнике (OQ-231)';
  END IF;
  IF u.unknown > 0 THEN
    RETURN u.first_unknown;
  END IF;
  RETURN NULL;
END $fn$;

-- ================================================================ закрытие тенанта удаляет и новые таблицы
DO $$
DECLARE
  def text := pg_get_functiondef('maintenance.purge_tenant_data(uuid, boolean)'::regprocedure);
  anchor text := $a$'tenant_data.shadow_digest',$a$;
BEGIN
  IF position(anchor IN def) = 0 THEN
    RAISE EXCEPTION 'purge_tenant_data: the anchor was not found — the function changed, update this migration';
  END IF;
  -- Токены и запросы согласия — ДО аккаунта, на который ссылаются
  EXECUTE replace(def, anchor, $n$'tenant_data.channel_credential', 'tenant_data.channel_authorization_request', 'tenant_data.shadow_digest',$n$);
END $$;

-- Данные канала тенанта уходят при закрытии тем же списком, что остальные производные от цены конкурента
DO $$
DECLARE
  def text := pg_get_functiondef('maintenance.purge_tenant_channel_data(uuid)'::regprocedure);
  anchor text := $a$'channel_data.pricing_strategy_undercut',$a$;
BEGIN
  IF position(anchor IN def) = 0 THEN
    RAISE EXCEPTION 'purge_tenant_channel_data: the anchor was not found — the function changed, update this migration';
  END IF;
  EXECUTE replace(def, anchor, $n$'channel_data.floor_hold', 'channel_data.pricing_strategy_undercut',$n$);
END $$;

/**
 * Путь решения ВСТАВЛЯЕТ строку удержания своего же намерения (триггер) — это право входит в список разрешённого [Р-96]:
 * ни читать удержания, ни менять их путь решения не может.
 */

/**
 * Находка 4 ревью шага 43 (критичная): ссылка `db:` указывает ТОЛЬКО на токен своего аккаунта. Иначе строка аккаунта
 * тенанта A со ссылкой на аккаунт тенанта B дала бы адаптеру A токен продавца B: хранилище находит владельца по ссылке,
 * и связанные данные шифра (тенант и аккаунт владельца) расшифровке не мешают.
 */
ALTER TABLE tenant_data.channel_account ADD CONSTRAINT channel_account_db_credentials_own
  CHECK (credentials_ref NOT LIKE 'db:%' OR credentials_ref = 'db:' || channel_account_id::text);
/**
 * Находка 6 ревью шага 43: продавец eBay не назван при обмене кода (E-11), и аккаунт живёт с временным идентификатором.
 * Такой аккаунт в бой не переводится: два аккаунта одного продавца писали бы в одни листинги и тратили один бюджет правок.
 */
ALTER TABLE tenant_data.channel_account ADD CONSTRAINT channel_account_pending_identity_not_live
  CHECK (write_mode <> 'LIVE' OR external_account_id NOT LIKE 'pending-identity:%');

-- Функция вытеснения версии токена — SECURITY DEFINER; звать её вручную не может никто [шаг 19]
REVOKE EXECUTE ON FUNCTION tenant_data.channel_credential_before_insert() FROM PUBLIC;

COMMIT;
