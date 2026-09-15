-- 0055_budget_retry_due_scopes.sql
-- Шаг 15, ретроспективное ревью шага 14:
--  C2: повтор записи с бюджетом правок расходует бюджет ТЕКУЩЕГО местного дня витрины, а не дня создания записи. Раньше запись,
--      созданная в 23:59, повторялась после полуночи за счёт вчерашних 250 правок, и лимит нового дня в БД не был виден; пояс,
--      сменившийся на TO_VERIFY, повторы не останавливал. Проверка — tests/db/smoke_r65.sql.
--  D2: повтор и сверка записи в удержанной (HELD, CONTESTED, BLOCKED, RETIRED) единице не попадают в обход диспетчера. Раньше
--      обход находил такую запись на каждом круге, захват отказывал, строка не менялась — и каждый круг поднимал новый
--      CRITICAL-алерт. Уменьшение опубликованного остатка не блокируется никогда. Проверка — dispatcher-defects.pg.test.ts.

BEGIN;
SET ROLE repracer_owner;

-- ---------------------------------------------------------------------------
-- C2. День бюджета — при каждом повторе заново, по подтверждённому поясу витрины
-- ---------------------------------------------------------------------------
CREATE FUNCTION tenant_data.channel_write_budget_day_on_retry() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  mk record;
BEGIN
  SELECT m.marketplace, m.time_zone, m.time_zone_status INTO mk
    FROM tenant_data.write_scope s
    JOIN tenant_data.offer_mapping om
      ON om.tenant_id = s.tenant_id AND (om.price_write_scope_id = s.write_scope_id OR om.quantity_write_scope_id = s.write_scope_id)
    JOIN platform.marketplace m ON m.channel = s.channel AND m.marketplace = om.marketplace
   WHERE s.tenant_id = NEW.tenant_id AND s.write_scope_id = NEW.write_scope_id
   ORDER BY om.created_at
   LIMIT 1;
  IF mk.time_zone IS NULL OR mk.time_zone_status <> 'CONFIRMED' THEN
    RAISE EXCEPTION 'retry of a budgeted write: the day boundary of storefront % is not confirmed (Р-65)', mk.marketplace
      USING ERRCODE = 'check_violation';
  END IF;
  -- Попытка списывается на сегодняшний день витрины (consume_edit_budget в channel_write_before_update берёт NEW.budget_day)
  NEW.budget_day := (now() AT TIME ZONE mk.time_zone)::date;
  RETURN NEW;
END $$;

-- После a_channel_write_restrict_update (приложение budget_day не меняет), до b_channel_write_before_update (списание попытки)
CREATE TRIGGER ab_channel_write_budget_day_retry BEFORE UPDATE OF status ON tenant_data.channel_write
  FOR EACH ROW WHEN (OLD.status = 'FAILED' AND NEW.status = 'DISPATCHED' AND NEW.budget_scope_key IS NOT NULL)
  EXECUTE FUNCTION tenant_data.channel_write_budget_day_on_retry();

-- ---------------------------------------------------------------------------
-- D2. Обход видит статус единицы (без сумм и значений)
-- ---------------------------------------------------------------------------
CREATE POLICY dispatcher_scope_status ON tenant_data.write_scope FOR SELECT TO repracer_dispatcher USING (true);
GRANT SELECT (tenant_id, write_scope_id, status) ON tenant_data.write_scope TO repracer_dispatcher;
GRANT SELECT (field, direction) ON tenant_data.channel_write TO repracer_dispatcher;

RESET ROLE;

-- Владелец функции — repracer_dispatcher (0036); замена суперпользователем владельца не меняет
CREATE OR REPLACE FUNCTION maintenance.due_write_scopes(p_now timestamptz, p_pending_min_age interval, p_in_flight_timeout interval, p_limit int)
  RETURNS TABLE (tenant_id uuid, write_scope_id uuid, due_kind text, due_since timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT d.tenant_id, d.write_scope_id, d.due_kind, d.due_since
    FROM (
      -- Ждущая запись при свободной единице: событие не дошло до диспетчера (в удержанной единице захват переведёт её в BLOCKED один раз)
      SELECT w.tenant_id, w.write_scope_id, 'PENDING' AS due_kind, min(w.created_at) AS due_since
        FROM tenant_data.channel_write w
        JOIN tenant_data.write_scope_sync_state ss ON ss.tenant_id = w.tenant_id AND ss.write_scope_id = w.write_scope_id
       WHERE w.status = 'PENDING' AND w.created_at <= p_now - p_pending_min_age AND ss.in_flight_write_id IS NULL
       GROUP BY w.tenant_id, w.write_scope_id
      UNION ALL
      -- Повтор после временной ошибки; сверка записи с неизвестным итогом — только в действующей единице (D2)
      SELECT w.tenant_id, w.write_scope_id, CASE w.status WHEN 'FAILED' THEN 'RETRY' ELSE 'RECONCILE' END, w.next_attempt_at
        FROM tenant_data.channel_write w
        JOIN tenant_data.write_scope s ON s.tenant_id = w.tenant_id AND s.write_scope_id = w.write_scope_id
       WHERE w.next_attempt_at IS NOT NULL AND w.next_attempt_at <= p_now
         AND (s.status = 'ACTIVE' OR (w.field = 'QUANTITY' AND w.direction = 'DECREASE'))
      UNION ALL
      -- Запись в полёте без срока сверки дольше допустимого (процесс упал между захватом и итогом); заблокированная единица — у человека
      SELECT w.tenant_id, w.write_scope_id, 'IN_FLIGHT_STALE', coalesce(w.accepted_at, w.dispatched_at)
        FROM tenant_data.channel_write w
        JOIN tenant_data.write_scope_sync_state ss ON ss.tenant_id = w.tenant_id AND ss.in_flight_write_id = w.channel_write_id
        JOIN tenant_data.write_scope s ON s.tenant_id = w.tenant_id AND s.write_scope_id = w.write_scope_id
       WHERE w.status IN ('DISPATCHED', 'ACCEPTED') AND w.next_attempt_at IS NULL
         AND coalesce(w.accepted_at, w.dispatched_at) <= p_now - p_in_flight_timeout
         AND (s.status = 'ACTIVE' OR (w.field = 'QUANTITY' AND w.direction = 'DECREASE'))
    ) d
   ORDER BY d.due_since
   LIMIT p_limit
$$;

COMMIT;
