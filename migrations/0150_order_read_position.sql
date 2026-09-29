-- 0150_order_read_position.sql
-- Шаг 56 (ревью шага 54, находка 8): чтение заказов канала обрывалось на 200 страницах МОЛЧА — хвост окна терялся. Теперь заход, упёршийся
-- в предел страниц, записывает, где остановился (начало окна и курсор), и следующий продолжает оттуда с тем же началом окна; дочитал —
-- место снимается. Место живёт рядом с кругом обнаружения (0148): та же строка аккаунта, та же узкая роль, путь решения — только функциями.

BEGIN;
SET ROLE repracer_owner;

ALTER TABLE tenant_data.channel_discovery_circle
  ADD COLUMN order_since  timestamptz,
  ADD COLUMN order_cursor text;
COMMENT ON COLUMN tenant_data.channel_discovery_circle.order_since IS 'Шаг 56: начало окна чтения заказов, которое продолжается следующим заходом; NULL — продолжать нечего';
COMMENT ON COLUMN tenant_data.channel_discovery_circle.order_cursor IS 'Шаг 56: курсор страницы заказов, с которой продолжит следующий заход';
GRANT INSERT (order_since, order_cursor), UPDATE (order_since, order_cursor) ON tenant_data.channel_discovery_circle TO repracer_discovery;

RESET ROLE;

/**
 * Шаг 56: место чтения заказов — начало окна и курсор вместе или ни того ни другого. Прерванное чтение без курсора продолжить нечем,
 * курсор без начала окна прочитал бы другое окно
 */
CREATE OR REPLACE FUNCTION tenant_data.save_order_read_position(p_tenant_id uuid, p_channel_account_id uuid, p_since timestamptz, p_cursor text, p_at timestamptz)
  RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
BEGIN
  IF (p_since IS NULL) <> (p_cursor IS NULL) THEN
    RAISE EXCEPTION 'an order read position keeps the window start and the cursor together' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO tenant_data.channel_discovery_circle AS c (tenant_id, channel_account_id, order_since, order_cursor, updated_at)
  VALUES (p_tenant_id, p_channel_account_id, p_since, p_cursor, p_at)
  ON CONFLICT (tenant_id, channel_account_id) DO UPDATE SET order_since = excluded.order_since, order_cursor = excluded.order_cursor, updated_at = excluded.updated_at;
END $fn$;
ALTER FUNCTION tenant_data.save_order_read_position(uuid, uuid, timestamptz, text, timestamptz) OWNER TO repracer_discovery;
REVOKE EXECUTE ON FUNCTION tenant_data.save_order_read_position(uuid, uuid, timestamptz, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenant_data.save_order_read_position(uuid, uuid, timestamptz, text, timestamptz) TO repracer_app;

CREATE OR REPLACE FUNCTION tenant_data.order_read_position(p_tenant_id uuid, p_channel_account_id uuid)
  RETURNS TABLE (since timestamptz, cursor text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $fn$
  SELECT c.order_since, c.order_cursor FROM tenant_data.channel_discovery_circle c
   WHERE c.tenant_id = p_tenant_id AND c.channel_account_id = p_channel_account_id AND c.order_since IS NOT NULL
$fn$;
ALTER FUNCTION tenant_data.order_read_position(uuid, uuid) OWNER TO repracer_discovery;
REVOKE EXECUTE ON FUNCTION tenant_data.order_read_position(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenant_data.order_read_position(uuid, uuid) TO repracer_app;

COMMIT;

-- ================================================================ ревью шага 55, находка 6: квота — часовыми корзинами, а не сутками UTC
-- Граница суток квоты eBay не подтверждена (E-04; пример ответа Developer Analytics в тесте адаптера сбрасывает в 07:00 UTC). Сутки UTC
-- давали приложению в одни сутки eBay до двух «суточных» бюджетов обхода. Теперь корзина — час, и в корзину — не больше ceil(лимит / 24):
-- в ЛЮБЫЕ 24 часа, где бы ни начинались сутки канала, — не больше лимита; размазанность по суткам — следствие, а не отдельная формула.
-- Невыбранный час не переносится — консервативно, как граница суток бюджета правок [Р-163]
BEGIN;
SET ROLE repracer_owner;
DELETE FROM security.table_registry WHERE table_name = 'platform.channel_app_quota_day'::regclass;
DELETE FROM maintenance.retention_policy WHERE table_name = 'platform.channel_app_quota_day'::regclass;
DROP TABLE platform.channel_app_quota_day;

CREATE TABLE platform.channel_app_quota_hour (
  tenant_id   uuid NOT NULL DEFAULT security.platform_tenant_id() REFERENCES tenant_data.tenant (tenant_id),
  channel     text NOT NULL,
  api         text NOT NULL,
  hour        timestamptz NOT NULL,
  spent       integer NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, channel, api, hour)
);
COMMENT ON TABLE platform.channel_app_quota_hour IS
  'Шаг 56 (ревью шага 55, находка 6): расход квоты канала на приложение по часам — операционный счётчик без данных тенантов; пишет только platform.reserve_channel_app_call';
SELECT security.register_table('platform.channel_app_quota_hour', 'PLATFORM', 'mutable', 'none');
SELECT security.grant_retention('platform.channel_app_quota_hour');
INSERT INTO maintenance.retention_policy (table_name, method, anchor_column, retention, bound)
VALUES ('platform.channel_app_quota_hour', 'DELETE_ROWS', 'updated_at', interval '90 days', 'MAX_AGE');
GRANT SELECT, INSERT (channel, api, hour, spent, updated_at), UPDATE (spent, updated_at) ON platform.channel_app_quota_hour TO repracer_discovery;
CREATE POLICY discovery_quota ON platform.channel_app_quota_hour FOR ALL TO repracer_discovery
  USING (tenant_id = security.platform_tenant_id()) WITH CHECK (tenant_id = security.platform_tenant_id());
REVOKE ALL ON platform.channel_app_quota_hour FROM repracer_admin, repracer_app;
CREATE POLICY app_quota_isolation ON platform.channel_app_quota_hour FOR SELECT TO repracer_app USING (tenant_id = security.platform_tenant_id());
RESET ROLE;

/**
 * Шаг 56: вызов из квоты канала на приложение — не больше ceil(лимит / 24) в час (часы UTC от `p_at`, времени вызывающего). В любые 24 часа
 * — не больше лимита при любой границе суток канала. true — вызов разрешён и списан; false — доля часа исчерпана, вызов откладывается
 */
CREATE OR REPLACE FUNCTION platform.reserve_channel_app_call(p_channel text, p_api text, p_day_limit integer, p_at timestamptz)
  RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
DECLARE
  h        timestamptz := date_trunc('hour', p_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  per_hour integer;
  granted  boolean;
BEGIN
  IF p_day_limit IS NULL OR p_day_limit <= 0 THEN
    RAISE EXCEPTION 'app quota needs a positive daily limit, got %', p_day_limit USING ERRCODE = 'check_violation';
  END IF;
  per_hour := ceil(p_day_limit / 24.0)::integer;
  INSERT INTO platform.channel_app_quota_hour AS q (channel, api, hour, spent, updated_at)
  VALUES (p_channel, p_api, h, 1, p_at)
  ON CONFLICT (tenant_id, channel, api, hour) DO UPDATE SET spent = q.spent + 1, updated_at = excluded.updated_at
   WHERE q.spent < per_hour
  RETURNING true INTO granted;
  RETURN coalesce(granted, false);
END $fn$;

-- ================================================================ ревью шага 55, находка 3: заход, упавший посреди, сохраняет место
/**
 * Шаг 55, 56: закрытый круг — без курсора; остановленный сроком, квотой или пределом — с курсором; упавший (FAILED) — с курсором последней
 * прочитанной страницы или без него (круг сбрасывается к началу: страница, отказывающая всегда, не держит круг на себе)
 */
CREATE OR REPLACE FUNCTION tenant_data.save_discovery_circle(p_tenant_id uuid, p_channel_account_id uuid, p_started_from_cursor text,
                                                             p_cursor text, p_stop text, p_at timestamptz)
  RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
BEGIN
  IF p_stop NOT IN ('COMPLETED', 'DEADLINE', 'APP_QUOTA', 'PAGE_LIMIT', 'FAILED') THEN
    RAISE EXCEPTION 'unknown discovery stop %', p_stop USING ERRCODE = 'check_violation';
  END IF;
  IF p_stop = 'COMPLETED' AND p_cursor IS NOT NULL OR p_stop IN ('DEADLINE', 'APP_QUOTA', 'PAGE_LIMIT') AND p_cursor IS NULL THEN
    RAISE EXCEPTION 'a completed circle has no cursor, an interrupted one has one (stop %)', p_stop USING ERRCODE = 'check_violation';
  END IF;
  -- Аккаунт вне тенанта отклоняет составной внешний ключ, чужого тенанта — политика строк круга [Р-104]
  INSERT INTO tenant_data.channel_discovery_circle AS c (tenant_id, channel_account_id, cursor, circle_started_at, last_circle_completed_at, last_stop, updated_at)
  VALUES (p_tenant_id, p_channel_account_id, p_cursor, p_at, CASE WHEN p_stop = 'COMPLETED' THEN p_at END, p_stop, p_at)
  ON CONFLICT (tenant_id, channel_account_id) DO UPDATE SET
    cursor = excluded.cursor,
    circle_started_at = CASE WHEN p_started_from_cursor IS NULL THEN p_at ELSE c.circle_started_at END,
    last_circle_completed_at = CASE WHEN p_stop = 'COMPLETED' THEN p_at ELSE c.last_circle_completed_at END,
    last_stop = excluded.last_stop, updated_at = excluded.updated_at;
END $fn$;

/**
 * Шаг 56 (п. 7 задания): состояние круга обнаружения — для решения «заходить ли сейчас» и для наблюдаемости: сколько длится круг аккаунта
 * (новый старый листинг eBay попадает в систему не позже одного круга, Р-198)
 */
CREATE OR REPLACE FUNCTION tenant_data.discovery_circle_state(p_tenant_id uuid, p_channel_account_id uuid)
  RETURNS TABLE (cursor text, circle_started_at timestamptz, last_circle_completed_at timestamptz, last_stop text, updated_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $fn$
  SELECT c.cursor, c.circle_started_at, c.last_circle_completed_at, c.last_stop, c.updated_at FROM tenant_data.channel_discovery_circle c
   WHERE c.tenant_id = p_tenant_id AND c.channel_account_id = p_channel_account_id
$fn$;
ALTER FUNCTION tenant_data.discovery_circle_state(uuid, uuid) OWNER TO repracer_discovery;
REVOKE EXECUTE ON FUNCTION tenant_data.discovery_circle_state(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenant_data.discovery_circle_state(uuid, uuid) TO repracer_app, repracer_admin;
COMMIT;
