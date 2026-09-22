-- 0122_reservation_shipped_before_confirmation.sql: отгрузка, пришедшая ДО подтверждения источником (шаг 36) [Р-157].
--
-- Находка 7 ревью шага 36: нормальный порядок событий — канал отгружает, склад подтверждает позже. Резервация Inbound
-- API, по которой отгрузка УЖЕ была, после подтверждения не списывалась никем: `confirm_reservations_by_source` про
-- отгрузку не знает, а строку заказа канал повторно отдаст только в ближайшее окно работы `order-lines`. Дальше
-- резервация висела в CONFIRMED_BY_SOURCE вечно: освобождение по сроку берёт только CREATED, и доступный остаток
-- оставался занижен до алерта Р-30 через 14 суток.
--
-- Теперь факт «канал сообщил об отгрузке» ХРАНИТСЯ на резервации, и подтверждение списывает такие резервации сразу.

BEGIN;

SET ROLE repracer_owner;

ALTER TABLE channel_data.reservation
  ADD COLUMN shipped_reported_at timestamptz;
COMMENT ON COLUMN channel_data.reservation.shipped_reported_at IS
  'Шаг 36 [Р-157]: канал сообщил об отгрузке этой строки заказа, а источник ещё не подтвердил резервацию. Списать пул нельзя до подтверждения; после него резервация закрывается этим же фактом.';

-- Признак отгрузки ставится ДО закрытия резервации: у закрытой он уже ничего не меняет
ALTER TABLE channel_data.reservation
  ADD CONSTRAINT reservation_shipped_before_close CHECK (shipped_reported_at IS NULL OR status <> 'RELEASED' OR release_reason = 'ORDER_CANCELLED');

-- Столбец ведёт роль остатков вместе с остальными полями жизненного цикла [Р-102]
DROP TRIGGER a_reservation_restrict_update ON channel_data.reservation;
CREATE TRIGGER a_reservation_restrict_update BEFORE UPDATE ON channel_data.reservation
  FOR EACH ROW EXECUTE FUNCTION security.restrict_update(
    'status', 'confirmed_at', 'confirmed_by_stock_source_id', 'confirmed_external_order_ref',
    'consumed_at', 'released_at', 'release_reason', 'closed_at', 'shipped_reported_at', 'stale_alerted_at');

GRANT UPDATE (shipped_reported_at) ON channel_data.reservation TO repracer_stock;

/**
 * Подтверждение источником [Р-25] теперь закрывает и те резервации, отгрузку по которым канал уже сообщил: сперва
 * CREATED → CONFIRMED_BY_SOURCE, затем у отгруженных CONFIRMED_BY_SOURCE → CONSUMED. Списание пула делает триггер
 * `reservation_consume` — тот же, что при обычной отгрузке, и только у внутреннего пула [Р-6].
 */
CREATE OR REPLACE FUNCTION channel_data.confirm_reservations_by_source(p_stock_source_id uuid, p_external_order_ref text) RETURNS int
  LANGUAGE plpgsql AS $$
DECLARE
  n int;
BEGIN
  UPDATE channel_data.reservation r
     SET status = 'CONFIRMED_BY_SOURCE', confirmed_at = now(),
         confirmed_by_stock_source_id = p_stock_source_id, confirmed_external_order_ref = p_external_order_ref
    FROM tenant_data.stock_pool sp
   WHERE r.status = 'CREATED' AND r.channel_order_ref = p_external_order_ref
     AND sp.tenant_id = r.tenant_id AND sp.stock_pool_id = r.stock_pool_id AND sp.stock_source_id = p_stock_source_id;
  GET DIAGNOSTICS n = ROW_COUNT;

  -- Отгрузка была до подтверждения: резервация закрывается тем же вызовом, а не ждёт следующего окна работы order-lines
  UPDATE channel_data.reservation r
     SET status = 'CONSUMED', consumed_at = now()
    FROM tenant_data.stock_pool sp
   WHERE r.status = 'CONFIRMED_BY_SOURCE' AND r.shipped_reported_at IS NOT NULL
     AND r.channel_order_ref = p_external_order_ref
     AND sp.tenant_id = r.tenant_id AND sp.stock_pool_id = r.stock_pool_id AND sp.stock_source_id = p_stock_source_id;
  RETURN n;
END $$;

RESET ROLE;

COMMIT;
