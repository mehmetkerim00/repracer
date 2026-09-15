-- 0036_write_dispatcher.sql
-- Р-64: записи в очереди отправляет диспетчер с упорядочиванием по write_scope_id. Запись не может остаться PENDING
-- бесследно: либо отправлена, либо вытеснена новой версией с записью причины.
--
-- До этой миграции запись, вставшая за записью в полёте, не отправлялась никем: путь решения отправлял только то, что
-- захватил сам, а вытеснение старых версий не хранило причину. Воспроизведение — packages/pricing-store-pg/test/write-queue.pg.test.ts.
--
-- 1. channel_write: причина завершения, ссылка на вытеснившую запись, последняя ошибка канала, срок следующей попытки.
-- 2. Вытеснение новой версией записывает причину; старая FAILED-запись завершается DISCARDED_STALE, а не висит вечно.
-- 3. Освободилась единица и есть ждущая запись — событие scope.write.v1 в outbox в той же транзакции (отложенный триггер
--    видит итог транзакции). Гонку «запись встала в очередь» / «запись в полёте завершилась» упорядочивает блокировка
--    строки write_scope_sync_state, которую берут обе стороны.
-- 4. Страховка на случай потерянного события: maintenance.due_write_scopes — только идентификаторы и сроки, без сумм.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'repracer_dispatcher') THEN
    CREATE ROLE repracer_dispatcher NOLOGIN NOBYPASSRLS;
  END IF;
END $$;
GRANT USAGE ON SCHEMA tenant_data TO repracer_dispatcher;

SET ROLE repracer_owner;

-- ---------------------------------------------------------------------------
-- 1. Причина завершения записи [Р-64]
-- ---------------------------------------------------------------------------
ALTER TABLE tenant_data.channel_write
  ADD COLUMN end_reason             text,
  ADD COLUMN end_params             jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN superseded_by_write_id uuid,
  ADD COLUMN last_error_code        text,
  ADD COLUMN next_attempt_at        timestamptz;

-- Коды — packages/pricing-model/src/reasons.ts (DISPATCH_END_REASON_CODES) с текстом объяснения
ALTER TABLE tenant_data.channel_write
  ADD CONSTRAINT channel_write_end_reason_known CHECK (end_reason IS NULL OR end_reason IN (
    'WRITE_SUPERSEDED_BY_NEWER_VERSION', 'WRITE_NOT_ACCEPTED_BY_CHANNEL', 'WRITE_RETRIES_EXHAUSTED',
    'WRITE_BLOCKED_BY_BOUND_RECHECK', 'CHANNEL_HALTED', 'WRITE_PRICING_MODE_CHANGED', 'WRITE_EDIT_BUDGET_EXHAUSTED')),
  ADD CONSTRAINT channel_write_end_explained
    CHECK (status NOT IN ('SUPERSEDED', 'DISCARDED_STALE', 'BUDGET_EXHAUSTED') OR end_reason IS NOT NULL),
  ADD CONSTRAINT channel_write_superseded_by CHECK (status <> 'SUPERSEDED' OR superseded_by_write_id IS NOT NULL),
  ADD CONSTRAINT channel_write_end_params_object CHECK (jsonb_typeof(end_params) = 'object'),
  ADD CONSTRAINT channel_write_last_error_code_format CHECK (last_error_code IS NULL OR last_error_code ~ '^[A-Z][A-Z0-9_]*$'),
  -- Срок попытки есть только у записи, которую ещё предстоит отправить или сверить
  ADD CONSTRAINT channel_write_next_attempt_status CHECK (next_attempt_at IS NULL OR status IN ('FAILED', 'DISPATCHED', 'ACCEPTED'));

DROP TRIGGER a_channel_write_restrict_update ON tenant_data.channel_write;
CREATE TRIGGER a_channel_write_restrict_update BEFORE UPDATE ON tenant_data.channel_write
  FOR EACH ROW EXECUTE FUNCTION security.restrict_update(
    'status', 'attempt_count', 'sync_job_id', 'floor_at_dispatch_minor',
    'dispatched_at', 'accepted_at', 'applied_at', 'finished_at',
    'end_reason', 'end_params', 'superseded_by_write_id', 'last_error_code', 'next_attempt_at');

-- Транзитная история: строки до 0036 причины не имели (дефект, который закрывает Р-64). Как в 0018, транзитные строки
-- выгружаются до миграции: ограничение проверяется на всех строках.
ALTER TABLE tenant_data.channel_write_history
  ADD COLUMN end_reason             text,
  ADD COLUMN end_params             jsonb,
  ADD COLUMN superseded_by_write_id uuid,
  ADD COLUMN last_error_code        text;
ALTER TABLE tenant_data.channel_write_history
  ADD CONSTRAINT channel_write_history_end_explained
    CHECK (final_status NOT IN ('SUPERSEDED', 'DISCARDED_STALE', 'BUDGET_EXHAUSTED') OR end_reason IS NOT NULL);

CREATE OR REPLACE FUNCTION tenant_data.channel_write_complete() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IN ('APPLIED', 'NOT_APPLIED', 'SUPERSEDED', 'DISCARDED_STALE', 'BUDGET_EXHAUSTED')
     AND NEW.status <> OLD.status THEN
    INSERT INTO tenant_data.channel_write_history
      (tenant_id, channel_write_id, finished_at, write_scope_id, field, amount_minor, currency, price_basis, quantity,
       version, origin, price_decision_id, direction, final_status, attempt_count, budget_scope_key, budget_day,
       floor_at_dispatch_minor, trigger_received_at, created_at, dispatched_at, accepted_at, applied_at,
       end_reason, end_params, superseded_by_write_id, last_error_code)
    VALUES
      (NEW.tenant_id, NEW.channel_write_id, coalesce(NEW.finished_at, now()), NEW.write_scope_id, NEW.field,
       NEW.amount_minor, NEW.currency, NEW.price_basis, NEW.quantity, NEW.version, NEW.origin, NEW.price_decision_id,
       NEW.direction, NEW.status, NEW.attempt_count, NEW.budget_scope_key, NEW.budget_day, NEW.floor_at_dispatch_minor,
       NEW.trigger_received_at, NEW.created_at, NEW.dispatched_at, NEW.accepted_at, NEW.applied_at,
       NEW.end_reason, NEW.end_params, NEW.superseded_by_write_id, NEW.last_error_code);
    DELETE FROM channel_data.write_submission
     WHERE tenant_id = NEW.tenant_id AND channel_write_id = NEW.channel_write_id;
    DELETE FROM tenant_data.channel_write
     WHERE tenant_id = NEW.tenant_id AND channel_write_id = NEW.channel_write_id;
  END IF;
  RETURN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Вытеснение новой версией — с причиной и ссылкой; неудачная старая версия завершается, а не ждёт повтора вечно
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION tenant_data.channel_write_after_insert() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  UPDATE tenant_data.channel_write
     SET status                 = CASE WHEN status = 'FAILED' THEN 'DISCARDED_STALE' ELSE 'SUPERSEDED' END,
         end_reason             = 'WRITE_SUPERSEDED_BY_NEWER_VERSION',
         end_params             = jsonb_build_object('newerVersion', NEW.version, 'newerWriteId', NEW.channel_write_id),
         superseded_by_write_id = NEW.channel_write_id,
         next_attempt_at        = NULL
   WHERE tenant_id = NEW.tenant_id AND write_scope_id = NEW.write_scope_id
     AND version < NEW.version AND status IN ('PENDING', 'BLOCKED', 'FAILED');
  RETURN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Событие «единица свободна, есть ждущая запись» — в той же транзакции [Р-24, Р-64]
-- ---------------------------------------------------------------------------
CREATE FUNCTION tenant_data.channel_write_announce_dispatch() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  announced text := coalesce(current_setting('repracer.dispatch_announced', true), '');
  scope_key text := NEW.tenant_id::text || ':' || NEW.write_scope_id::text || ',';
BEGIN
  -- Одно событие на единицу за транзакцию: вставка и захват одной записи дают два срабатывания
  IF position(scope_key IN announced) > 0 THEN
    RETURN NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM tenant_data.write_scope_sync_state ss
              WHERE ss.tenant_id = NEW.tenant_id AND ss.write_scope_id = NEW.write_scope_id AND ss.in_flight_write_id IS NULL)
     AND EXISTS (SELECT 1 FROM tenant_data.channel_write w
                  WHERE w.tenant_id = NEW.tenant_id AND w.write_scope_id = NEW.write_scope_id AND w.status = 'PENDING') THEN
    INSERT INTO tenant_data.outbox_event (tenant_id, topic, partition_key, write_scope_id, event_type, payload)
    VALUES (NEW.tenant_id, 'scope.write.v1', NEW.write_scope_id, NEW.write_scope_id, 'WRITE_DISPATCH_DUE',
            jsonb_build_object('writeScopeId', NEW.write_scope_id));
    PERFORM set_config('repracer.dispatch_announced', announced || scope_key, true);
  END IF;
  RETURN NULL;
END $$;

-- Отложенный: проверка видит итог транзакции (захваченная в той же транзакции запись события не порождает);
-- срабатывает и для строки, удалённой при завершении записи
CREATE CONSTRAINT TRIGGER zz_channel_write_announce_dispatch
  AFTER INSERT OR UPDATE OF status ON tenant_data.channel_write
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION tenant_data.channel_write_announce_dispatch();

-- ---------------------------------------------------------------------------
-- 4. Страховка диспетчера: что пора отправить, повторить или сверить. Только идентификаторы и сроки — без сумм и цен
-- ---------------------------------------------------------------------------
-- maintenance.due_write_scopes: ждущие отправки записи
CREATE INDEX channel_write_pending_due_idx ON tenant_data.channel_write (created_at) WHERE status = 'PENDING';
-- maintenance.due_write_scopes: повтор после временной ошибки и сверка неизвестного итога по сроку
CREATE INDEX channel_write_attempt_due_idx ON tenant_data.channel_write (next_attempt_at) WHERE next_attempt_at IS NOT NULL;
-- maintenance.due_write_scopes: запись в полёте дольше допустимого
CREATE INDEX channel_write_in_flight_age_idx ON tenant_data.channel_write (dispatched_at) WHERE status IN ('DISPATCHED', 'ACCEPTED');

CREATE POLICY dispatcher_scan ON tenant_data.channel_write FOR SELECT TO repracer_dispatcher USING (true);
GRANT SELECT (tenant_id, channel_write_id, write_scope_id, status, created_at, dispatched_at, accepted_at, next_attempt_at)
  ON tenant_data.channel_write TO repracer_dispatcher;
CREATE POLICY dispatcher_scan ON tenant_data.write_scope_sync_state FOR SELECT TO repracer_dispatcher USING (true);
GRANT SELECT (tenant_id, write_scope_id, in_flight_write_id) ON tenant_data.write_scope_sync_state TO repracer_dispatcher;

RESET ROLE;
GRANT CREATE, USAGE ON SCHEMA maintenance TO repracer_dispatcher;
GRANT repracer_dispatcher TO CURRENT_USER;
SET ROLE repracer_dispatcher;

CREATE FUNCTION maintenance.due_write_scopes(p_now timestamptz, p_pending_min_age interval, p_in_flight_timeout interval, p_limit int)
  RETURNS TABLE (tenant_id uuid, write_scope_id uuid, due_kind text, due_since timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT d.tenant_id, d.write_scope_id, d.due_kind, d.due_since
    FROM (
      -- Ждущая запись при свободной единице: событие не дошло до диспетчера
      SELECT w.tenant_id, w.write_scope_id, 'PENDING' AS due_kind, min(w.created_at) AS due_since
        FROM tenant_data.channel_write w
        JOIN tenant_data.write_scope_sync_state ss ON ss.tenant_id = w.tenant_id AND ss.write_scope_id = w.write_scope_id
       WHERE w.status = 'PENDING' AND w.created_at <= p_now - p_pending_min_age AND ss.in_flight_write_id IS NULL
       GROUP BY w.tenant_id, w.write_scope_id
      UNION ALL
      -- Повтор после временной ошибки; сверка записи с неизвестным итогом
      SELECT w.tenant_id, w.write_scope_id, CASE w.status WHEN 'FAILED' THEN 'RETRY' ELSE 'RECONCILE' END, w.next_attempt_at
        FROM tenant_data.channel_write w
       WHERE w.next_attempt_at IS NOT NULL AND w.next_attempt_at <= p_now
      UNION ALL
      -- Запись в полёте без срока сверки дольше допустимого (процесс упал между захватом и итогом)
      SELECT w.tenant_id, w.write_scope_id, 'IN_FLIGHT_STALE', coalesce(w.accepted_at, w.dispatched_at)
        FROM tenant_data.channel_write w
        JOIN tenant_data.write_scope_sync_state ss ON ss.tenant_id = w.tenant_id AND ss.in_flight_write_id = w.channel_write_id
       WHERE w.status IN ('DISPATCHED', 'ACCEPTED') AND w.next_attempt_at IS NULL
         AND coalesce(w.accepted_at, w.dispatched_at) <= p_now - p_in_flight_timeout
    ) d
   ORDER BY d.due_since
   LIMIT p_limit
$$;

RESET ROLE;
REVOKE repracer_dispatcher FROM CURRENT_USER;
REVOKE CREATE ON SCHEMA maintenance FROM repracer_dispatcher;
REVOKE ALL ON FUNCTION maintenance.due_write_scopes(timestamptz, interval, interval, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION maintenance.due_write_scopes(timestamptz, interval, interval, int) TO repracer_dispatcher;

COMMIT;
