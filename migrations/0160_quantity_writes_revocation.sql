-- 0160_quantity_writes_revocation.sql
-- Шаг 61 [Р-202, решение владельца]: отзыв подтверждения записи количества — тем же порядком, что выдача: владелец, набранный
-- идентификатор аккаунта, строка журнала, запись в аудит. Поддержка для этого не нужна.
--
-- 1. Журнал подтверждений (0158) получает вид строки: CONFIRM или REVOKE. Отдельной таблицы нет — у выдачи и отзыва один страж
--    ролей, один аудит и одна очистка тенанта; «одно подтверждение на аккаунт навсегда» (0158) снято: повторное включение после отзыва —
--    новой строкой CONFIRM. Вместо уникальности — страж: подтвердить можно только неподтверждённое, отозвать — только подтверждённое,
--    под блокировкой строки аккаунта (две строки одновременно не пройдут обе).
-- 2. С момента отзыва запись количества выключена СРАЗУ, в той же транзакции: синхронизация количества у единиц аккаунта выключается,
--    неотправленные версии количества (ждущие, заблокированные и отказавшие в ожидании повтора) завершаются `DISCARDED_STALE` с
--    причиной `QUANTITY_WRITES_REVOKED`. Запись, уже ушедшая в канал, не отзывается — её не вернуть; но её ПОВТОР после отказа канала
--    держит страж отправки (как тень, Р-169: «перед каждой отправкой заново»).
-- 3. Повторное включение — только новым подтверждением: `quantity_sync_enabled` после отзыва выключен, а включить его без
--    подтверждения не даёт страж 0158.

BEGIN;
SET ROLE repracer_owner;

-- ---------------------------------------------------------------- 1. вид строки журнала
ALTER TABLE tenant_data.channel_quantity_writes_confirmation
  ADD COLUMN action text NOT NULL DEFAULT 'CONFIRM'
    CONSTRAINT channel_quantity_writes_confirmation_action_known CHECK (action IN ('CONFIRM', 'REVOKE'));
COMMENT ON COLUMN tenant_data.channel_quantity_writes_confirmation.action IS
  'Шаг 61 [Р-202]: CONFIRM — владелец подтвердил, что количество в канале не ведут другие инструменты; REVOKE — отозвал, запись количества выключена';
-- Повторное подтверждение после отзыва — новая строка; порядок держит страж под блокировкой аккаунта
ALTER TABLE tenant_data.channel_quantity_writes_confirmation DROP CONSTRAINT channel_quantity_writes_confirmation_once;
GRANT INSERT (action) ON tenant_data.channel_quantity_writes_confirmation TO repracer_admin;

/**
 * Кто и что: только владелец, от своего имени, с набранным внешним идентификатором аккаунта — и для выдачи, и для отзыва. Выдача —
 * только неподтверждённому аккаунту, после ответа без «остатки ведёт другой инструмент»; отзыв — только подтверждённому. Второй фактор
 * не требуется [Р-202]
 */
CREATE OR REPLACE FUNCTION tenant_data.channel_quantity_writes_confirmation_guard() RETURNS trigger
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
    RAISE EXCEPTION 'only the owner confirms or revokes quantity writes of a channel account (Р-202)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  /**
   * Блокировки аккаунта. Advisory — исключительная: страж отправки количества (ниже) берёт её разделяемой, и отзыв ждёт захвата,
   * начатого до него, а захват после отзыва видит отзыв (ревью шага 61, находка 2: без неё запись, захваченная диспетчером в момент
   * отзыва, уходила в канал после ответа «отозвано»). Строка аккаунта FOR UPDATE — выдача и отзыв одного аккаунта идут по очереди
   */
  PERFORM pg_advisory_xact_lock(202, hashtext(NEW.channel_account_id::text));
  SELECT ca.external_account_id, ca.other_tools, ca.quantity_writes_confirmed INTO a FROM tenant_data.channel_account ca
   WHERE ca.tenant_id = NEW.tenant_id AND ca.channel_account_id = NEW.channel_account_id FOR UPDATE;
  IF NEW.action = 'REVOKE' THEN
    IF NOT a.quantity_writes_confirmed THEN
      RAISE EXCEPTION 'quantity writes of this channel account are not confirmed: nothing to revoke (Р-202)' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.action = 'CONFIRM' THEN
    IF a.quantity_writes_confirmed THEN
      RAISE EXCEPTION 'quantity writes of this channel account are already confirmed (Р-202)' USING ERRCODE = 'check_violation';
    END IF;
    IF a.other_tools IS NULL THEN
      RAISE EXCEPTION 'answer first whether another tool updates stock or prices in this channel (Р-202)' USING ERRCODE = 'check_violation';
    END IF;
    IF a.other_tools IN ('STOCK', 'STOCK_AND_PRICES') THEN
      RAISE EXCEPTION 'another tool updates stock in this channel: quantity writes would make two writers (Р-202)' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF btrim(NEW.typed_confirmation) IS DISTINCT FROM a.external_account_id THEN
    RAISE EXCEPTION 'the typed confirmation does not name the channel account (Р-202)' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- Как у журнала переключений (0142, Р-192): у eBay внешний идентификатор — userId продавца; подтверждение проверено базой, хранится отметка
  NEW.typed_confirmation := 'matched';
  NEW.confirmed_at := now();
  RETURN NEW;
END $fn$;

/**
 * Применение. Отзыв выключает запись количества СРАЗУ: синхронизация количества у единиц аккаунта выключается (новых версий не будет —
 * их не создаст страж создания записи), а неотправленные версии завершаются с причиной. Отказавшая запись, ждущая повтора, тоже
 * снимается: её повтор был бы отправкой после отзыва
 */
CREATE OR REPLACE FUNCTION tenant_data.channel_quantity_writes_confirmation_apply() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  UPDATE tenant_data.channel_account SET quantity_writes_confirmed = (NEW.action = 'CONFIRM')
   WHERE tenant_id = NEW.tenant_id AND channel_account_id = NEW.channel_account_id;
  IF NEW.action = 'REVOKE' THEN
    UPDATE tenant_data.write_scope SET quantity_sync_enabled = false
     WHERE tenant_id = NEW.tenant_id AND channel_account_id = NEW.channel_account_id AND field = 'QUANTITY' AND quantity_sync_enabled;
    UPDATE tenant_data.channel_write w
       SET status = 'DISCARDED_STALE', end_reason = 'QUANTITY_WRITES_REVOKED',
           end_params = jsonb_build_object('channelAccountId', NEW.channel_account_id, 'confirmationId', NEW.confirmation_id),
           next_attempt_at = NULL
      FROM tenant_data.write_scope ws
     WHERE ws.tenant_id = w.tenant_id AND ws.write_scope_id = w.write_scope_id
       AND w.tenant_id = NEW.tenant_id AND ws.channel_account_id = NEW.channel_account_id
       AND w.field = 'QUANTITY' AND w.status IN ('PENDING', 'BLOCKED', 'FAILED');
  END IF;
  RETURN NULL;
END $fn$;

-- ---------------------------------------------------------------- 2. причина завершения и страж отправки
ALTER TABLE tenant_data.channel_write DROP CONSTRAINT channel_write_end_reason_known;
ALTER TABLE tenant_data.channel_write
  ADD CONSTRAINT channel_write_end_reason_known CHECK (end_reason IS NULL OR end_reason = ANY (ARRAY[
    'WRITE_SUPERSEDED_BY_NEWER_VERSION', 'WRITE_NOT_ACCEPTED_BY_CHANNEL', 'WRITE_RETRIES_EXHAUSTED',
    'WRITE_BLOCKED_BY_BOUND_RECHECK', 'CHANNEL_HALTED', 'CHANNEL_DISTRUSTED', 'PRICING_STOPPED',
    'WRITE_PRICING_MODE_CHANGED', 'WRITE_EDIT_BUDGET_EXHAUSTED', 'WRITE_BUDGET_DAY_UNCONFIRMED',
    'WRITE_HELD_IN_SHADOW', 'QUANTITY_WRITES_REVOKED']));

/**
 * Отправка количества — только у аккаунта с действующим подтверждением. Отзыв снимает неотправленное сам; этот страж держит запись,
 * которая была в канале в момент отзыва, получила отказ и идёт на повтор: повтор — новая отправка, а отправок после отзыва нет.
 * Проверяется на КАЖДОМ переходе в отправку, как режим тени (Р-169) и пол цены (Р-83)
 */
CREATE FUNCTION tenant_data.channel_write_quantity_writes_guard() RETURNS trigger
  LANGUAGE plpgsql AS $fn$
DECLARE
  account uuid;
BEGIN
  IF NEW.field <> 'QUANTITY' OR NOT (NEW.status = 'DISPATCHED' AND OLD.status IS DISTINCT FROM 'DISPATCHED') THEN
    RETURN NEW;
  END IF;
  SELECT ws.channel_account_id INTO account FROM tenant_data.write_scope ws
   WHERE ws.tenant_id = NEW.tenant_id AND ws.write_scope_id = NEW.write_scope_id;
  -- Разделяемая блокировка аккаунта: захваты не ждут друг друга, а идущий отзыв (исключительная) — ждут; признак читается после неё
  PERFORM pg_advisory_xact_lock_shared(202, hashtext(account::text));
  IF NOT EXISTS (SELECT 1 FROM tenant_data.channel_account ca
                  WHERE ca.tenant_id = NEW.tenant_id AND ca.channel_account_id = account AND ca.quantity_writes_confirmed) THEN
    RAISE EXCEPTION 'quantity writes of channel account % are not confirmed by the owner: no quantity is sent (Р-202)', account
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER bd_channel_write_quantity_writes_guard BEFORE UPDATE OF status ON tenant_data.channel_write
  FOR EACH ROW EXECUTE FUNCTION tenant_data.channel_write_quantity_writes_guard();

/**
 * Реестры параметров причин (0099) знают новую причину завершения записи — как `WRITE_HELD_IN_SHADOW` в 0128; иначе реестр базы и
 * реестр кода (`REASON_PARAMS`) расходятся. Функции переопределяются значением прежнего реестра плюс новая причина: список длинный, и
 * переписывать его руками — значит рисковать молча потерять чужую причину
 */
DO $do$
BEGIN
  EXECUTE format($f$CREATE OR REPLACE FUNCTION security.eternal_param_keys() RETURNS jsonb
    LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $b$ SELECT %L::jsonb $b$$f$,
    security.eternal_param_keys() || '{"QUANTITY_WRITES_REVOKED":["channelAccountId","confirmationId"]}'::jsonb);
  EXECUTE format($f$CREATE OR REPLACE FUNCTION security.eternal_param_kinds() RETURNS jsonb
    LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $b$ SELECT %L::jsonb $b$$f$,
    security.eternal_param_kinds() || '{"QUANTITY_WRITES_REVOKED":{"channelAccountId":{"k":"id"},"confirmationId":{"k":"id"}}}'::jsonb);
END $do$;

RESET ROLE;
COMMIT;
