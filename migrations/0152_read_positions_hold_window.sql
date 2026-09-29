-- 0152_read_positions_hold_window.sql
-- Шаг 57 (ревью шага 56, находки 3, 4, 6, 8).
--
-- 1. Место чтения заказов может держать ТОЛЬКО начало окна, без курсора: курсор, который канал больше не принимает, или петля курсора в
--    продолжении сбрасывают курсор, но не начало окна — следующий заход перечитывает окно от его начала. Раньше место стиралось целиком,
--    а окно следующего захода считалось от прошлого успеха (заход с пределом страниц — тоже успех): хвост исходного окна не читал никто.
-- 2. Круг обнаружения сбрасывается к началу только после ТРЕХ подряд отказов на одном месте продолжения, а не после первого: один случайный
--    5xx на первой странице многочасового круга крупного продавца отбрасывал его к началу, и круг мог не закрыться никогда.
-- 3. Начало круга — время НАЧАЛА захода (`p_started_at`), а не время сохранения в его конце: длительность круга на экране подключений
--    [Р-198] иначе занижалась на длину первого захода, а круг из одного захода показывал «0 ч».

BEGIN;
SET ROLE repracer_owner;
ALTER TABLE tenant_data.channel_discovery_circle ADD COLUMN failed_attempts integer NOT NULL DEFAULT 0;
COMMENT ON COLUMN tenant_data.channel_discovery_circle.failed_attempts IS
  'Шаг 57: подряд отказов захода на месте продолжения без единой прочитанной страницы; на третьем круг сбрасывается к началу';
GRANT INSERT (failed_attempts), UPDATE (failed_attempts) ON tenant_data.channel_discovery_circle TO repracer_discovery;
RESET ROLE;

/** Шаг 56, 57: курсор — только вместе с началом окна; начало окна без курсора держит окно (перечитать от начала) */
CREATE OR REPLACE FUNCTION tenant_data.save_order_read_position(p_tenant_id uuid, p_channel_account_id uuid, p_since timestamptz, p_cursor text, p_at timestamptz)
  RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
BEGIN
  IF p_cursor IS NOT NULL AND p_since IS NULL THEN
    RAISE EXCEPTION 'an order read cursor needs the start of its window' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO tenant_data.channel_discovery_circle AS c (tenant_id, channel_account_id, order_since, order_cursor, updated_at)
  VALUES (p_tenant_id, p_channel_account_id, p_since, p_cursor, p_at)
  ON CONFLICT (tenant_id, channel_account_id) DO UPDATE SET order_since = excluded.order_since, order_cursor = excluded.order_cursor, updated_at = excluded.updated_at;
END $fn$;

/**
 * Шаг 57: сохранение захода обхода. `p_started_at` — начало захода; `p_no_progress` — заход упал, не прочитав ни страницы с места
 * продолжения. Возвращает 'RESET', если это третий такой отказ подряд и круг сброшен к началу, иначе 'SAVED'
 */
DROP FUNCTION tenant_data.save_discovery_circle(uuid, uuid, text, text, text, timestamptz);
CREATE FUNCTION tenant_data.save_discovery_circle(p_tenant_id uuid, p_channel_account_id uuid, p_started_from_cursor text,
                                                  p_cursor text, p_stop text, p_started_at timestamptz, p_at timestamptz, p_no_progress boolean)
  RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
DECLARE
  failures integer := 0;
  cursor_to_keep text := p_cursor;
  result text := 'SAVED';
BEGIN
  IF p_stop NOT IN ('COMPLETED', 'DEADLINE', 'APP_QUOTA', 'PAGE_LIMIT', 'FAILED') THEN
    RAISE EXCEPTION 'unknown discovery stop %', p_stop USING ERRCODE = 'check_violation';
  END IF;
  IF p_stop = 'COMPLETED' AND p_cursor IS NOT NULL OR p_stop IN ('DEADLINE', 'APP_QUOTA', 'PAGE_LIMIT') AND p_cursor IS NULL THEN
    RAISE EXCEPTION 'a completed circle has no cursor, an interrupted one has one (stop %)', p_stop USING ERRCODE = 'check_violation';
  END IF;
  IF p_stop = 'FAILED' AND p_no_progress THEN
    SELECT c.failed_attempts + 1 INTO failures FROM tenant_data.channel_discovery_circle c
     WHERE c.tenant_id = p_tenant_id AND c.channel_account_id = p_channel_account_id;
    failures := coalesce(failures, 1);
    IF failures >= 3 THEN
      cursor_to_keep := NULL;
      failures := 0;
      result := 'RESET';
    END IF;
  END IF;
  -- Аккаунт вне тенанта отклоняет составной внешний ключ, чужого тенанта — политика строк круга [Р-104]
  INSERT INTO tenant_data.channel_discovery_circle AS c (tenant_id, channel_account_id, cursor, circle_started_at, last_circle_completed_at, last_stop, failed_attempts, updated_at)
  VALUES (p_tenant_id, p_channel_account_id, cursor_to_keep, p_started_at, CASE WHEN p_stop = 'COMPLETED' THEN p_at END, p_stop, failures, p_at)
  ON CONFLICT (tenant_id, channel_account_id) DO UPDATE SET
    cursor = excluded.cursor,
    circle_started_at = CASE WHEN p_started_from_cursor IS NULL THEN p_started_at ELSE c.circle_started_at END,
    last_circle_completed_at = CASE WHEN p_stop = 'COMPLETED' THEN p_at ELSE c.last_circle_completed_at END,
    last_stop = excluded.last_stop, failed_attempts = excluded.failed_attempts, updated_at = excluded.updated_at;
  RETURN result;
END $fn$;
ALTER FUNCTION tenant_data.save_discovery_circle(uuid, uuid, text, text, text, timestamptz, timestamptz, boolean) OWNER TO repracer_discovery;
REVOKE EXECUTE ON FUNCTION tenant_data.save_discovery_circle(uuid, uuid, text, text, text, timestamptz, timestamptz, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenant_data.save_discovery_circle(uuid, uuid, text, text, text, timestamptz, timestamptz, boolean) TO repracer_app;

COMMIT;
