-- 0142_ebay_batch_mode_and_account_deletion.sql
-- Шаг 49.
--
-- Р-189 (E-22): описание `bulkUpdatePriceQuantity` говорит «Only one SKU (one product) can be updated per call», а схема той
-- же спецификации и песочница — «до 25 предложений разных SKU». Пакет остаётся, но аккаунт доказывает его в бою сам:
-- режим пакетов аккаунта eBay — NULL (проба: первая боевая запись — пакет из 2 SKU), `MULTI` (пакет принят — до 25) или
-- `SINGLE` (боевой отказ пакета разных SKU — один SKU на вызов). Переход делает функция базы по итогу, который сообщает
-- диспетчер; отказ поднимает алерт с вопросом E-22. Обратно из `SINGLE` автоматически пути нет.
--
-- Р-192 (E-18): уведомления eBay Marketplace Account Deletion. До ПЕРВОГО боевого вызова приложение обязано их принимать
-- (vendor/ebay/2026-09-28/marketplace-user-account-deletion.html): мы данные eBay храним, исключение нам не подходит.
-- Уведомление называет пользователя eBay (`userId`, неизменный). Если это продавец, подключённый к нам, база:
--   * удаляет ВСЕ его токены (шифротекст [Р-177]) — без возможности восстановить;
--   * отключает аккаунт (`DISCONNECTED`), убирает ссылку на секреты;
--   * заменяет `external_account_id` (это и есть `userId`) на `deleted:<id аккаунта>` — идентификатор eBay в базе не остаётся;
--   * пишет событие аудита в каждый затронутый тенант (триггер, обойти нельзя) и алерт владельцу.
-- Журнал уведомлений хранит SHA-256 от `userId`, а не сам идентификатор: повторная доставка того же уведомления узнаётся
-- по `notificationId`. Наши цены по каналу остаются: история цен — доказательство Omnibus и §11 PAngV [Р-21], это
-- «retained … to meet specific and demonstrable legal requirements» из той же страницы; идентификатора eBay в ней нет.
-- Проверку подписи делает процесс-приёмник (`services/ebay-account-deletion`), в базу попадает только проверенное.

BEGIN;

-- ================================================================ роли Р-192
DO $$
BEGIN
  -- Роль процесса-приёмника: ни одной таблицы, только EXECUTE на функцию приёма (как панель оператора, 0126)
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'repracer_ebay_deletion') THEN
    CREATE ROLE repracer_ebay_deletion NOLOGIN NOBYPASSRLS;
  END IF;
  -- Владелец функции: права ровно на то, что делает удаление, и ничего сверх [Р-90]
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'repracer_ebay_deletion_actions') THEN
    CREATE ROLE repracer_ebay_deletion_actions NOLOGIN NOBYPASSRLS;
  END IF;
END $$;
COMMENT ON ROLE repracer_ebay_deletion IS 'Шаг 49 [Р-192]: приёмник уведомлений eBay Marketplace Account Deletion — только EXECUTE на функцию приёма';
COMMENT ON ROLE repracer_ebay_deletion_actions IS 'Шаг 49 [Р-192]: владелец функции удаления данных продавца eBay по уведомлению';

SET ROLE repracer_owner;
-- Роли входа нужна только схема функции приёма; владельцу функции — схемы, где он работает [Р-90, находка 12 ревью]
GRANT USAGE ON SCHEMA security TO repracer_ebay_deletion;
GRANT USAGE ON SCHEMA security, platform, tenant_data TO repracer_ebay_deletion_actions;

-- ================================================================ Р-189: режим пакетов аккаунта eBay
ALTER TABLE tenant_data.channel_account
  ADD COLUMN ebay_batch_mode text,
  ADD CONSTRAINT channel_account_ebay_batch_mode_known
    CHECK (ebay_batch_mode IS NULL OR (channel = 'EBAY' AND ebay_batch_mode IN ('MULTI', 'SINGLE')));
COMMENT ON COLUMN tenant_data.channel_account.ebay_batch_mode IS
  'Р-189, E-22: NULL — проба (первая боевая запись — пакет из 2 SKU), MULTI — пакет разных SKU принят, SINGLE — один SKU на вызов';

-- Список изменяемых столбцов (0128) пополняется режимом пакетов и идентификатором — последний меняет только страж ниже
DROP TRIGGER channel_account_restrict_update ON tenant_data.channel_account;
CREATE TRIGGER channel_account_restrict_update BEFORE UPDATE ON tenant_data.channel_account
  FOR EACH ROW EXECUTE FUNCTION security.restrict_update('display_name', 'marketplaces', 'known_other_marketplaces',
    'credentials_ref', 'auth_status', 'access_token_expires_at', 'authorization_expires_at', 'granted_scopes',
    'disconnected_at', 'write_mode', 'ebay_batch_mode', 'external_account_id');

/**
 * Р-189: режим пакетов меняется только вперёд — из пробы в MULTI или SINGLE, из MULTI в SINGLE. Вернуть мультипакет после
 * боевого отказа автоматически нельзя: его снимает человек, когда eBay ответит на E-22 (правкой от владельца схемы).
 * Р-192: идентификатор аккаунта меняется ровно в одну сторону — на `deleted:<id аккаунта>`, и только у отключённого аккаунта
 * eBay. Административная роль имеет UPDATE на всю таблицу (0012), поэтому без этого стража «идентификатор меняют только
 * при удалении» было бы неправдой.
 */
CREATE FUNCTION tenant_data.channel_account_ebay_transitions() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  IF NEW.ebay_batch_mode IS DISTINCT FROM OLD.ebay_batch_mode
     AND NOT (OLD.ebay_batch_mode IS NULL OR (OLD.ebay_batch_mode = 'MULTI' AND NEW.ebay_batch_mode = 'SINGLE')) THEN
    RAISE EXCEPTION 'eBay batch mode moves only forward (probe → MULTI or SINGLE, MULTI → SINGLE), not % → % (Р-189)',
      coalesce(OLD.ebay_batch_mode, 'PROBE'), coalesce(NEW.ebay_batch_mode, 'PROBE') USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.external_account_id IS DISTINCT FROM OLD.external_account_id
     AND NOT (OLD.channel = 'EBAY' AND NEW.auth_status = 'DISCONNECTED' AND NEW.external_account_id = 'deleted:' || NEW.channel_account_id::text) THEN
    RAISE EXCEPTION 'external account id changes only to deleted:<account> of a disconnected eBay account (Р-192)'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER a_channel_account_ebay_transitions BEFORE UPDATE OF ebay_batch_mode, external_account_id ON tenant_data.channel_account
  FOR EACH ROW EXECUTE FUNCTION tenant_data.channel_account_ebay_transitions();

RESET ROLE;

/**
 * Р-189: итог пакета разных SKU в бою. Вызывают путь решения (своя отправка) и диспетчер. Возвращает режим после итога.
 * Функция не решает, был ли это отказ «из-за мультипакета», — это классифицирует адаптер (EBAY_C18); здесь — только переход,
 * алерт с вопросом и неизменность «вперёд».
 */
CREATE FUNCTION channel_data.record_ebay_batch_outcome(p_tenant_id uuid, p_channel_account_id uuid, p_multi_sku_accepted boolean)
  RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
DECLARE
  a record;
BEGIN
  /**
   * Находка 8 ревью шага 49: владелец функции видит все тенанты, а EXECUTE есть у пути решения. Тенант берётся из вызова и
   * обязан совпасть с тенантом сессии — иначе путь решения одного тенанта переключал бы режим пакетов чужого [инвариант 1].
   */
  IF p_tenant_id IS DISTINCT FROM security.current_tenant_id() THEN
    RAISE EXCEPTION 'eBay batch outcome for tenant % from a session of tenant %', p_tenant_id, security.current_tenant_id()
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT ca.channel, ca.ebay_batch_mode, ca.write_mode INTO a FROM tenant_data.channel_account ca
   WHERE ca.tenant_id = p_tenant_id AND ca.channel_account_id = p_channel_account_id;
  IF a.channel IS DISTINCT FROM 'EBAY' THEN
    RAISE EXCEPTION 'account % of tenant % is not an eBay account', p_channel_account_id, p_tenant_id USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  -- Итог пакета бывает только у боевой записи: теневая не отправляется [Р-169]
  IF a.write_mode <> 'LIVE' THEN
    RAISE EXCEPTION 'batch outcome of an eBay account in the shadow: nothing was sent (Р-169, Р-189)' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF p_multi_sku_accepted THEN
    IF a.ebay_batch_mode IS NULL THEN
      UPDATE tenant_data.channel_account SET ebay_batch_mode = 'MULTI' WHERE tenant_id = p_tenant_id AND channel_account_id = p_channel_account_id;
      RETURN 'MULTI';
    END IF;
    RETURN a.ebay_batch_mode;
  END IF;
  IF a.ebay_batch_mode IS DISTINCT FROM 'SINGLE' THEN
    UPDATE tenant_data.channel_account SET ebay_batch_mode = 'SINGLE' WHERE tenant_id = p_tenant_id AND channel_account_id = p_channel_account_id;
    INSERT INTO tenant_data.alert (tenant_id, code, severity, channel_account_id, details)
    VALUES (p_tenant_id, 'EBAY_MULTI_SKU_REFUSED', 'WARNING', p_channel_account_id,
            jsonb_build_object('from', coalesce(a.ebay_batch_mode, 'PROBE'), 'to', 'SINGLE', 'question', 'E-22'));
  END IF;
  RETURN 'SINGLE';
END $fn$;
ALTER FUNCTION channel_data.record_ebay_batch_outcome(uuid, uuid, boolean) OWNER TO repracer_credential_keeper;
REVOKE EXECUTE ON FUNCTION channel_data.record_ebay_batch_outcome(uuid, uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION channel_data.record_ebay_batch_outcome(uuid, uuid, boolean) TO repracer_app, repracer_dispatcher;

SET ROLE repracer_owner;
-- Хранителю (владельцу функции) — чтение режима и его запись; статус и алерты у него уже есть (0136)
GRANT SELECT (tenant_id, channel_account_id, channel, ebay_batch_mode, write_mode) ON tenant_data.channel_account TO repracer_credential_keeper;
GRANT UPDATE (ebay_batch_mode) ON tenant_data.channel_account TO repracer_credential_keeper;
GRANT USAGE ON SCHEMA channel_data TO repracer_credential_keeper;

-- ================================================================ Р-192: журнал уведомлений
CREATE TABLE platform.ebay_account_deletion_notice (
  tenant_id          uuid NOT NULL DEFAULT security.platform_tenant_id()
                       CONSTRAINT ebay_account_deletion_notice_platform_tenant CHECK (tenant_id = security.platform_tenant_id()),
  -- `notificationId` eBay: повторная доставка того же уведомления узнаётся по нему и ничего не делает второй раз
  notification_id    text PRIMARY KEY CONSTRAINT ebay_account_deletion_notice_id_shape CHECK (notification_id ~ '^[A-Za-z0-9_.:-]{8,200}$'),
  -- SHA-256 от `userId`: идентификатор пользователя eBay в журнале не хранится
  user_id_sha256     bytea NOT NULL CONSTRAINT ebay_account_deletion_notice_hash_len CHECK (octet_length(user_id_sha256) = 32),
  event_date         timestamptz NOT NULL,
  publish_attempt    integer NOT NULL CONSTRAINT ebay_account_deletion_notice_attempt CHECK (publish_attempt >= 1),
  received_at        timestamptz NOT NULL DEFAULT now(),
  -- Журнал — только исполненные удаления (0 аккаунтов не пишется, находка 3 ревью)
  accounts_deleted   integer NOT NULL CONSTRAINT ebay_account_deletion_notice_accounts CHECK (accounts_deleted >= 1)
);
COMMENT ON TABLE platform.ebay_account_deletion_notice IS
  'Шаг 49 [Р-192]: принятые уведомления eBay Marketplace Account Deletion — хэш пользователя и число удалённых аккаунтов';
-- Удаление по сроку
CREATE INDEX ebay_account_deletion_notice_expiry_idx ON platform.ebay_account_deletion_notice (received_at);
SELECT security.register_table('platform.ebay_account_deletion_notice', 'SYSTEM', 'append_only', 'none');
REVOKE ALL ON platform.ebay_account_deletion_notice FROM repracer_app;
REVOKE INSERT, UPDATE, DELETE ON platform.ebay_account_deletion_notice FROM repracer_admin;
CREATE POLICY ebay_account_deletion_notice_owner ON platform.ebay_account_deletion_notice TO repracer_owner USING (true) WITH CHECK (true);
CREATE POLICY ebay_account_deletion_notice_actions ON platform.ebay_account_deletion_notice TO repracer_ebay_deletion_actions USING (true) WITH CHECK (true);
GRANT SELECT, INSERT ON platform.ebay_account_deletion_notice TO repracer_ebay_deletion_actions;
SELECT security.grant_retention('platform.ebay_account_deletion_notice');
-- Три года — как согласия eBay после закрытия [Р-26]: доказательство, что уведомление принято и исполнено
INSERT INTO maintenance.retention_policy (table_name, method, anchor_column, retention, safety_margin, drop_order)
VALUES ('platform.ebay_account_deletion_notice', 'DELETE_ROWS', 'received_at', '3 years', '0 days', 69);

-- Права владельца функции удаления: найти аккаунт eBay, отключить, стереть идентификатор, удалить токены, поднять алерт
GRANT SELECT (tenant_id, channel_account_id, channel, external_account_id, auth_status, disconnected_at) ON tenant_data.channel_account TO repracer_ebay_deletion_actions;
GRANT UPDATE (auth_status, disconnected_at, credentials_ref, external_account_id) ON tenant_data.channel_account TO repracer_ebay_deletion_actions;
/**
 * Политики строк роли владельца функции открыты (как у хранителя, 0136): её границы держат права по столбцам, сама функция
 * (только аккаунты eBay с этим `userId`) и страж идентификатора выше (только `deleted:` у отключённого аккаунта eBay).
 * Сужение политики тем же условием было бы дублем, снятие которого не ловит ни одна проверка [Р-104].
 */
CREATE POLICY ebay_deletion_account_read ON tenant_data.channel_account FOR SELECT TO repracer_ebay_deletion_actions USING (true);
CREATE POLICY ebay_deletion_account_update ON tenant_data.channel_account FOR UPDATE TO repracer_ebay_deletion_actions USING (true) WITH CHECK (true);
GRANT SELECT (tenant_id, channel_account_id), DELETE ON tenant_data.channel_credential TO repracer_ebay_deletion_actions;
CREATE POLICY ebay_deletion_credential_read ON tenant_data.channel_credential FOR SELECT TO repracer_ebay_deletion_actions USING (true);
CREATE POLICY ebay_deletion_credential_delete ON tenant_data.channel_credential FOR DELETE TO repracer_ebay_deletion_actions USING (true);
GRANT INSERT ON tenant_data.alert TO repracer_ebay_deletion_actions;
CREATE POLICY ebay_deletion_alert_raise ON tenant_data.alert FOR INSERT TO repracer_ebay_deletion_actions WITH CHECK (true);
RESET ROLE;

-- ================================================================ Р-192: функция приёма
/**
 * Возвращает число удалённых аккаунтов и их идентификаторы (наши UUID, не данные пользователя eBay). Процесс пишет их в свой
 * журнал: после восстановления базы из копии удаление повторяется по ним (принятый риск 36, deploy/production/README.md).
 * Повтор того же уведомления — прежнее число и пустой список: исполнено раньше.
 */
CREATE FUNCTION security.ebay_account_deletion(p_notification_id text, p_user_id text, p_event_date timestamptz, p_publish_attempt integer)
  RETURNS TABLE (accounts_deleted integer, account_ids uuid[])
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
DECLARE
  a record;
  n integer := 0;
  ids uuid[] := '{}';
BEGIN
  IF p_user_id IS NULL OR length(p_user_id) NOT BETWEEN 1 AND 128 THEN
    RAISE EXCEPTION 'eBay account deletion without a user id' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- Повторная доставка того же уведомления (eBay повторяет до подтверждения): исполнено один раз, отвечаем тем же числом
  SELECT d.accounts_deleted INTO n FROM platform.ebay_account_deletion_notice d WHERE d.notification_id = p_notification_id;
  IF FOUND THEN
    RETURN QUERY SELECT n, '{}'::uuid[];
    RETURN;
  END IF;
  n := 0;
  FOR a IN SELECT ca.tenant_id, ca.channel_account_id FROM tenant_data.channel_account ca
            WHERE ca.channel = 'EBAY' AND ca.external_account_id = p_user_id LOOP
    -- Токены продавца — без возможности восстановления: строка удаляется, а не помечается
    DELETE FROM tenant_data.channel_credential WHERE tenant_id = a.tenant_id AND channel_account_id = a.channel_account_id;
    UPDATE tenant_data.channel_account
       SET auth_status = 'DISCONNECTED', disconnected_at = coalesce(disconnected_at, now()), credentials_ref = NULL,
           external_account_id = 'deleted:' || a.channel_account_id::text
     WHERE tenant_id = a.tenant_id AND channel_account_id = a.channel_account_id;
    INSERT INTO tenant_data.alert (tenant_id, code, severity, channel_account_id, details)
    VALUES (a.tenant_id, 'EBAY_ACCOUNT_DELETED_BY_USER', 'CRITICAL', a.channel_account_id,
            jsonb_build_object('notificationId', left(p_notification_id, 200)));
    n := n + 1;
    ids := ids || a.channel_account_id;
  END LOOP;
  /**
   * Находка 3 ревью шага 49: уведомления приходят обо ВСЕХ закрытых аккаунтах eBay — в основном о покупателях, которых у нас
   * не было. Их хэш — псевдоним, то есть персональные данные людей, о которых мы ничего не храним; журнал о них не пишется
   * вовсе (и повтор такого уведомления безопасен: снова 0). Журнал — только исполненные удаления наших продавцов.
   */
  IF n > 0 THEN
    INSERT INTO platform.ebay_account_deletion_notice (notification_id, user_id_sha256, event_date, publish_attempt, accounts_deleted)
    VALUES (p_notification_id, sha256(convert_to(p_user_id, 'UTF8')), p_event_date, p_publish_attempt, n);
  END IF;
  RETURN QUERY SELECT n, ids;
END $fn$;
ALTER FUNCTION security.ebay_account_deletion(text, text, timestamptz, integer) OWNER TO repracer_ebay_deletion_actions;
REVOKE EXECUTE ON FUNCTION security.ebay_account_deletion(text, text, timestamptz, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION security.ebay_account_deletion(text, text, timestamptz, integer) TO repracer_ebay_deletion;

-- ================================================================ Р-192: удаление — в аудит (триггер, обойти нельзя)
CREATE FUNCTION tenant_data.channel_account_deleted_audit() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
BEGIN
  -- Условие — в теле, а не в WHEN триггера: список допустимых условий WHEN держит проверка схемы (шаг 19)
  IF NEW.external_account_id IS NOT DISTINCT FROM OLD.external_account_id THEN
    RETURN NULL;
  END IF;
  INSERT INTO audit.audit_event (tenant_id, occurred_at, actor_type, action, entity_type, entity_id, changes)
  VALUES (NEW.tenant_id, now(), 'SYSTEM', 'channel.ebay_account_deleted_by_user', 'channel_account', NEW.channel_account_id,
          jsonb_build_object('channel', NEW.channel, 'from_status', OLD.auth_status, 'to_status', NEW.auth_status, 'reason', 'EBAY_MARKETPLACE_ACCOUNT_DELETION', 'at', now()));
  RETURN NULL;
END $fn$;
ALTER FUNCTION tenant_data.channel_account_deleted_audit() OWNER TO repracer_audit_writer;
REVOKE EXECUTE ON FUNCTION tenant_data.channel_account_deleted_audit() FROM PUBLIC;
CREATE TRIGGER zc_channel_account_deleted_audit AFTER UPDATE OF external_account_id ON tenant_data.channel_account
  FOR EACH ROW EXECUTE FUNCTION tenant_data.channel_account_deleted_audit();

-- ================================================================ находка 2 ревью: журнал переключения в бой не хранит userId
/**
 * Перевод в бой требует НАБРАТЬ идентификатор аккаунта (0128, Р-170), а у eBay это и есть `userId` пользователя eBay.
 * Журнал переключений неизменяем, и удаление по уведомлению его стереть не может. Поэтому страж после сверки хранит не
 * набранную строку, а отметку `matched`: подтверждение проверено базой, повторять его значение незачем.
 */
CREATE OR REPLACE FUNCTION tenant_data.channel_write_mode_change_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  m record;
  a record;
  unknown_detail text;
BEGIN
  SELECT mb.user_id, mb.role INTO m FROM tenant_data.membership mb
   WHERE mb.tenant_id = NEW.tenant_id AND mb.membership_id = NEW.changed_by_membership_id AND mb.status = 'ACTIVE';
  /**
   * «Человек в сессии есть» проверяет СТАНДАРТНЫЙ страж административной записи (`a0_admin_write_person_insert`), и его
   * случай сюда не попадает специально: иначе он отказывал бы дважды, и снятие стандартного стража ловилось бы этой
   * проверкой — соседней [Р-99, Р-104]. Здесь — только то, чего стандартный не знает: членство принадлежит ТОМУ человеку.
   */
  IF security.current_user_id() IS NOT NULL AND (m.user_id IS NULL OR m.user_id IS DISTINCT FROM security.current_user_id()) THEN
    RAISE EXCEPTION 'membership % is not the membership of the session user', NEW.changed_by_membership_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT ca.write_mode, ca.external_account_id, ca.channel, ca.marketplaces INTO a FROM tenant_data.channel_account ca
   WHERE ca.tenant_id = NEW.tenant_id AND ca.channel_account_id = NEW.channel_account_id;
  -- Переход объявляется от ТЕКУЩЕГО режима: строка «из тени в бой», записанная у боевого аккаунта, — не история, а ложь
  IF NEW.from_mode IS DISTINCT FROM a.write_mode THEN
    RAISE EXCEPTION 'channel account % is in % mode, not in %', NEW.channel_account_id, a.write_mode, NEW.from_mode
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF NEW.to_mode = 'LIVE' THEN
    IF m.role <> 'OWNER' THEN
      RAISE EXCEPTION 'only the owner switches a channel account to LIVE writes (Р-170)' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NOT security.session_mfa() THEN
      RAISE EXCEPTION 'switching to LIVE writes requires a second factor (Р-170, Р-88)' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF btrim(NEW.typed_confirmation) IS DISTINCT FROM a.external_account_id THEN
      RAISE EXCEPTION 'the typed confirmation does not name the channel account (Р-170)' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    -- Р-172: то же правило, что у стража аккаунта, — одной функцией (неизвестное свойство держит БОЙ, а не тень)
    unknown_detail := security.marketplace_properties_unknown(a.channel, a.marketplaces);
    IF unknown_detail IS NOT NULL THEN
      RAISE EXCEPTION 'marketplace property is unknown: % — LIVE writes stay closed while the shadow keeps working (Р-172)',
        unknown_detail USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    NEW.mfa := true;
    -- Находка 2 ревью шага 49: сверено — хранится отметка, а не набранный идентификатор (у eBay это userId пользователя)
    NEW.typed_confirmation := 'matched';
  ELSIF m.role NOT IN ('OWNER', 'ADMIN') THEN
    RAISE EXCEPTION 'only the owner or an admin switches a channel account back to SHADOW (Р-170)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.changed_at := now();
  RETURN NEW;
END $function$;

-- ================================================================ находка 9 ревью: вид подтверждения записи [Р-190]
ALTER TABLE tenant_data.channel_write ADD COLUMN confirmed_by_own_record boolean NOT NULL DEFAULT false;
ALTER TABLE tenant_data.channel_write_history ADD COLUMN confirmed_by_own_record boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT channel_write_history_own_record_only_applied CHECK (NOT confirmed_by_own_record OR final_status = 'APPLIED');
COMMENT ON COLUMN tenant_data.channel_write_history.confirmed_by_own_record IS
  'Р-190: применение подтверждено нашей же записью у канала (eBay: предложение), а не живым листингом — цену покупателя и чужие правки не видели';
SET ROLE repracer_owner;
DROP TRIGGER a_channel_write_restrict_update ON tenant_data.channel_write;
CREATE TRIGGER a_channel_write_restrict_update BEFORE UPDATE ON tenant_data.channel_write
  FOR EACH ROW EXECUTE FUNCTION security.restrict_update('status', 'attempt_count', 'sync_job_id', 'floor_at_dispatch_minor', 'dispatched_at',
    'accepted_at', 'applied_at', 'finished_at', 'end_reason', 'end_params', 'superseded_by_write_id', 'last_error_code', 'next_attempt_at',
    'confirmed_by_own_record');
RESET ROLE;
CREATE OR REPLACE FUNCTION tenant_data.channel_write_complete()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  /**
   * Шаг 41 [Р-169]: теневая запись завершена УЖЕ ПРИ ВСТАВКЕ, поэтому у этой функции появился вход по INSERT. Путь в
   * историю остаётся ОДИН [Р-145]: второй обработчик «почти такой же» разошёлся бы с этим в первый же шаг.
   */
  IF NEW.status IN ('APPLIED', 'NOT_APPLIED', 'SUPERSEDED', 'DISCARDED_STALE', 'BUDGET_EXHAUSTED', 'SHADOW_HELD')
     AND (TG_OP = 'INSERT' OR NEW.status <> OLD.status) THEN
    INSERT INTO tenant_data.channel_write_history
      (tenant_id, channel_write_id, finished_at, write_scope_id, field, amount_minor, currency, price_basis, quantity,
       version, origin, price_decision_id, direction, final_status, attempt_count, budget_scope_key, budget_day, would_spend_budget,
       floor_at_dispatch_minor, trigger_received_at, created_at, dispatched_at, accepted_at, applied_at,
       end_reason, end_params, superseded_by_write_id, last_error_code, confirmed_by_own_record)
    VALUES
      (NEW.tenant_id, NEW.channel_write_id, coalesce(NEW.finished_at, now()), NEW.write_scope_id, NEW.field,
       NEW.amount_minor, NEW.currency, NEW.price_basis, NEW.quantity, NEW.version, NEW.origin, NEW.price_decision_id,
       NEW.direction, NEW.status, NEW.attempt_count, NEW.budget_scope_key, NEW.budget_day, NEW.would_spend_budget, NEW.floor_at_dispatch_minor,
       NEW.trigger_received_at, NEW.created_at, NEW.dispatched_at, NEW.accepted_at, NEW.applied_at,
       NEW.end_reason, NEW.end_params, NEW.superseded_by_write_id, NEW.last_error_code, NEW.confirmed_by_own_record);
    DELETE FROM channel_data.write_submission
     WHERE tenant_id = NEW.tenant_id AND channel_write_id = NEW.channel_write_id;
    DELETE FROM tenant_data.channel_write
     WHERE tenant_id = NEW.tenant_id AND channel_write_id = NEW.channel_write_id;
  END IF;
  RETURN NULL;
END $function$;

-- ================================================================ находка 21 ревью: поиск аккаунта по userId
-- Функция удаления ищет аккаунт eBay по `external_account_id` среди всех тенантов; частичный уникальный индекс (0132) под
-- этот запрос не подходит (регион через coalesce и только неотключённые)
CREATE INDEX channel_account_ebay_external_idx ON tenant_data.channel_account (external_account_id) WHERE channel = 'EBAY';

COMMIT;
