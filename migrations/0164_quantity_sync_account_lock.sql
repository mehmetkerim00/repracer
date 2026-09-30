-- 0164_quantity_sync_account_lock.sql
-- Шаг 63 [Р-202]: гонка «отзыв ↔ включение синхронизации единицы» (ревью шага 62, находка 3). Страж включения читал признак подтверждения
-- без блокировки: единица, включённая одновременно с отзывом, оставалась включённой при отозванном подтверждении — версии создавались и
-- снимались, а внешние правки снова считались. Теперь включение упорядочено той же блокировкой аккаунта, что выдача, отзыв и отправка:
-- включение берёт её РАЗДЕЛЯЕМОЙ (включения друг друга не ждут), отзыв — исключительной. Включение, захватившее блокировку до отзыва,
-- законно: отзыв дождётся его и выключит единицу сам; включение после отзыва видит отзыв и получает отказ.

BEGIN;
SET ROLE repracer_owner;

CREATE OR REPLACE FUNCTION tenant_data.write_scope_quantity_writes_confirmed() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  IF NEW.field <> 'QUANTITY' OR NOT coalesce(NEW.quantity_sync_enabled, false) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.quantity_sync_enabled THEN
    RETURN NEW;
  END IF;
  -- Разделяемая блокировка аккаунта (ключ — как у стражей журнала и отправки): идущий отзыв ждём, признак читаем после неё
  PERFORM pg_advisory_xact_lock_shared(202, hashtext(NEW.channel_account_id::text));
  IF NOT EXISTS (SELECT 1 FROM tenant_data.channel_account ca
                  WHERE ca.tenant_id = NEW.tenant_id AND ca.channel_account_id = NEW.channel_account_id AND ca.quantity_writes_confirmed) THEN
    RAISE EXCEPTION 'quantity writes of channel account % are not confirmed by the owner: another tool may manage stock there (Р-202)', NEW.channel_account_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $fn$;

/**
 * Ревью шага 63, находка 3: взаимоблокировка «отзыв ↔ захват диспетчера». Захват сперва блокирует строку записи, затем страж отправки ждёт
 * блокировку аккаунта, которую держит отзыв; отзыв же снимал записи обычным UPDATE и ждал ту самую строку — цикл, `40P01`. Теперь отзыв
 * снимает только свободные записи (`FOR UPDATE SKIP LOCKED`): занятую захватом запись после фиксации отзыва отклонит страж отправки, и
 * диспетчер завершит её той же причиной (`QUANTITY_WRITES_REVOKED`)
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
     WHERE w.tenant_id = NEW.tenant_id
       AND w.channel_write_id IN (
         SELECT f.channel_write_id FROM tenant_data.channel_write f
           JOIN tenant_data.write_scope ws ON ws.tenant_id = f.tenant_id AND ws.write_scope_id = f.write_scope_id
          WHERE f.tenant_id = NEW.tenant_id AND ws.channel_account_id = NEW.channel_account_id
            AND f.field = 'QUANTITY' AND f.status IN ('PENDING', 'BLOCKED', 'FAILED')
            FOR UPDATE OF f SKIP LOCKED);
  END IF;
  RETURN NULL;
END $fn$;

RESET ROLE;
COMMIT;
