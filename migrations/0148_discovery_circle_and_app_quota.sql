-- 0148_discovery_circle_and_app_quota.sql
-- Шаг 55 (OQ-240; ревью шага 54, находки 3 и 9; ревью шага 53, находка 8).
--
-- 1. Суточная квота вызовов канала НА ПРИЛОЖЕНИЕ (eBay Trading — 5 000 в сутки по умолчанию, снимок vendor/ebay/2026-09-28/api-call-limits.html)
--    общая для всех тенантов и процессов, поэтому её счётчик — в базе, а не в памяти процесса. Счётчик — операционный, бизнес-данных
--    тенантов в нём нет (канал, API, сутки, число вызовов). Запрос на вызов РАЗМАЗАН по суткам: к моменту t можно потратить не больше
--    доли суточного бюджета, прошедшей к t (плюс час), — квота не выбирается первыми продавцами утра.
-- 2. Круг обнаружения предложений аккаунта: где остановился прошлый заход (срок вызова или квота) — следующий продолжает оттуда. Каталог
--    крупного продавца обходится за несколько заходов, а не обрывается каждые сутки на одном и том же месте.
-- 3. Индекс истории записей КОЛИЧЕСТВА под сравнение «что держит канал» (PgStockStore, ревью шага 54, находка 3).
-- 4. `record_channel_quantities` считает только записанные строки (ревью шага 53, находка 8).

BEGIN;

DO $$
BEGIN
  -- Владелец функций квоты и круга: права ровно на две таблицы [Р-90]; путь решения зовёт функции, прав на таблицы у него нет [Р-96]
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'repracer_discovery') THEN
    CREATE ROLE repracer_discovery NOLOGIN NOBYPASSRLS;
  END IF;
END $$;
COMMENT ON ROLE repracer_discovery IS 'Шаг 55 (OQ-240): владелец функций суточной квоты приложения и круга обнаружения предложений';

SET ROLE repracer_owner;
GRANT USAGE ON SCHEMA security, platform, tenant_data TO repracer_discovery;
GRANT EXECUTE ON FUNCTION security.current_tenant_id(), security.platform_tenant_id() TO repracer_discovery;

-- ================================================================ 1. суточная квота приложения
CREATE TABLE platform.channel_app_quota_day (
  tenant_id   uuid NOT NULL DEFAULT security.platform_tenant_id() CHECK (tenant_id = security.platform_tenant_id())
              REFERENCES tenant_data.tenant (tenant_id),
  channel     text NOT NULL,
  api         text NOT NULL,
  -- Сутки квоты — UTC: граница суток квоты eBay документацией не названа (проверить, E-04); сутки UTC — одинаковые для всех процессов
  day         date NOT NULL,
  day_limit   integer NOT NULL,
  spent       integer NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, channel, api, day)
);
COMMENT ON TABLE platform.channel_app_quota_day IS
  'Шаг 55 (OQ-240): расход суточной квоты канала на приложение (все тенанты) — операционный счётчик без данных тенантов; пишет только platform.reserve_channel_app_call';
SELECT security.register_table('platform.channel_app_quota_day', 'PLATFORM', 'mutable', 'none');
SELECT security.grant_retention('platform.channel_app_quota_day');
INSERT INTO maintenance.retention_policy (table_name, method, anchor_column, retention, bound)
VALUES ('platform.channel_app_quota_day', 'DELETE_ROWS', 'updated_at', interval '90 days', 'MAX_AGE');
GRANT SELECT, INSERT (channel, api, day, day_limit, spent, updated_at), UPDATE (spent, updated_at) ON platform.channel_app_quota_day TO repracer_discovery;
CREATE POLICY discovery_quota ON platform.channel_app_quota_day FOR ALL TO repracer_discovery
  USING (tenant_id = security.platform_tenant_id()) WITH CHECK (tenant_id = security.platform_tenant_id());
-- Права на таблицу у пути решения и административной роли нет — только функция; политика приложения — изоляция на случай выдачи прав
REVOKE ALL ON platform.channel_app_quota_day FROM repracer_admin, repracer_app;
CREATE POLICY app_quota_isolation ON platform.channel_app_quota_day FOR SELECT TO repracer_app USING (tenant_id = security.platform_tenant_id());

-- ================================================================ 2. круг обнаружения аккаунта
CREATE TABLE tenant_data.channel_discovery_circle (
  tenant_id                 uuid NOT NULL,
  channel_account_id        uuid NOT NULL,
  -- Курсор, с которого продолжит следующий заход; NULL — следующий заход начинает круг с начала
  cursor                    text,
  circle_started_at         timestamptz,
  last_circle_completed_at  timestamptz,
  -- Чем кончился последний заход: круг закрыт, остановил срок вызова или квота приложения
  last_stop                 text,
  updated_at                timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, channel_account_id),
  FOREIGN KEY (tenant_id, channel_account_id) REFERENCES tenant_data.channel_account (tenant_id, channel_account_id)
);
COMMENT ON TABLE tenant_data.channel_discovery_circle IS
  'Шаг 55 (OQ-240, ревью шага 54, находка 9): где остановился обход предложений аккаунта; пишет только tenant_data.save_discovery_circle';
SELECT security.register_table('tenant_data.channel_discovery_circle', 'TENANT', 'mutable');
SELECT security.grant_retention('tenant_data.channel_discovery_circle');
INSERT INTO maintenance.retention_policy (table_name, method, bound)
VALUES ('tenant_data.channel_discovery_circle', 'TENANT_CLOSURE_ONLY', 'MAX_AGE');
GRANT SELECT, INSERT (tenant_id, channel_account_id, cursor, circle_started_at, last_circle_completed_at, last_stop, updated_at),
      UPDATE (cursor, circle_started_at, last_circle_completed_at, last_stop, updated_at) ON tenant_data.channel_discovery_circle TO repracer_discovery;
CREATE POLICY discovery_circle ON tenant_data.channel_discovery_circle FOR ALL TO repracer_discovery
  USING (tenant_id = security.current_tenant_id()) WITH CHECK (tenant_id = security.current_tenant_id());
-- Путь решения читает и пишет круг только функциями (прав на таблицу нет — список разрешённого не растёт [Р-96]); политика — изоляция
REVOKE ALL ON tenant_data.channel_discovery_circle FROM repracer_admin, repracer_app;
CREATE POLICY app_circle_isolation ON tenant_data.channel_discovery_circle FOR SELECT TO repracer_app USING (tenant_id = security.current_tenant_id());

-- ================================================================ 3. индекс истории количества
-- Запрос: PgStockStore.TARGETS_SQL и productsNeedingQuantityWrite — последняя версия единицы и версии после последней применённой
-- (tenant_id, write_scope_id, version DESC) по одной единице; частичный — только QUANTITY (цене служит channel_write_history_scope_feed_idx, 0117)
CREATE INDEX channel_write_history_scope_quantity_idx ON tenant_data.channel_write_history (tenant_id, write_scope_id, version DESC)
  WHERE field = 'QUANTITY';

RESET ROLE;

-- ================================================================ функции: владелец — узкая роль
/**
 * Шаг 55 (OQ-240): один вызов из суточной квоты канала на приложение. Сутки — UTC от `p_at` (время вызывающего: у стенда — его часы,
 * а не часы базы). Размазано по суткам: к моменту t разрешено не больше ceil(лимит × (секунды с полуночи + 3600) / 86400) — первый час
 * даёт 1/24 суток, дальше доля растёт; квоту не выбирают первые продавцы утра, и у вечерних заходов она остаётся. true — вызов разрешён
 * и уже списан; false — бюджет этой доли суток исчерпан, вызывающий откладывает вызов (круг обнаружения продолжится следующим заходом)
 */
CREATE OR REPLACE FUNCTION platform.reserve_channel_app_call(p_channel text, p_api text, p_day_limit integer, p_at timestamptz)
  RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
DECLARE
  d        date := (p_at AT TIME ZONE 'UTC')::date;
  allowed  integer;
  granted  boolean;
BEGIN
  IF p_day_limit IS NULL OR p_day_limit <= 0 THEN
    RAISE EXCEPTION 'app quota needs a positive daily limit, got %', p_day_limit USING ERRCODE = 'check_violation';
  END IF;
  allowed := least(p_day_limit, ceil(p_day_limit * (extract(epoch FROM (p_at - (d::timestamp AT TIME ZONE 'UTC'))) + 3600) / 86400.0)::integer);
  INSERT INTO platform.channel_app_quota_day AS q (channel, api, day, day_limit, spent, updated_at)
  VALUES (p_channel, p_api, d, p_day_limit, 1, p_at)
  ON CONFLICT (tenant_id, channel, api, day) DO UPDATE SET spent = q.spent + 1, updated_at = excluded.updated_at
   WHERE q.spent < least(q.day_limit, allowed)
  RETURNING true INTO granted;
  RETURN coalesce(granted, false);
END $fn$;
ALTER FUNCTION platform.reserve_channel_app_call(text, text, integer, timestamptz) OWNER TO repracer_discovery;
REVOKE EXECUTE ON FUNCTION platform.reserve_channel_app_call(text, text, integer, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.reserve_channel_app_call(text, text, integer, timestamptz) TO repracer_app;

/**
 * Шаг 55: заход обхода кончился — `p_cursor` NULL и `p_completed` — круг закрыт, следующий начнётся с начала; иначе следующий заход
 * продолжит с `p_cursor`. Начало круга отмечается, когда заход стартовал без курсора
 */
CREATE OR REPLACE FUNCTION tenant_data.save_discovery_circle(p_tenant_id uuid, p_channel_account_id uuid, p_started_from_cursor text,
                                                             p_cursor text, p_stop text, p_at timestamptz)
  RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
BEGIN
  IF p_stop NOT IN ('COMPLETED', 'DEADLINE', 'APP_QUOTA', 'PAGE_LIMIT') THEN
    RAISE EXCEPTION 'unknown discovery stop %', p_stop USING ERRCODE = 'check_violation';
  END IF;
  IF (p_stop = 'COMPLETED') <> (p_cursor IS NULL) THEN
    RAISE EXCEPTION 'a completed circle has no cursor, an interrupted one has one (stop %)', p_stop USING ERRCODE = 'check_violation';
  END IF;
  -- Аккаунт вне тенанта отклоняет составной внешний ключ (tenant_id, channel_account_id), чужого тенанта — политика строк круга: отдельная
  -- проверка здесь была бы дублем, пойманным только соседней защитой [Р-104]
  INSERT INTO tenant_data.channel_discovery_circle AS c (tenant_id, channel_account_id, cursor, circle_started_at, last_circle_completed_at, last_stop, updated_at)
  VALUES (p_tenant_id, p_channel_account_id, p_cursor, p_at, CASE WHEN p_stop = 'COMPLETED' THEN p_at END, p_stop, p_at)
  ON CONFLICT (tenant_id, channel_account_id) DO UPDATE SET
    cursor = excluded.cursor,
    circle_started_at = CASE WHEN p_started_from_cursor IS NULL THEN p_at ELSE c.circle_started_at END,
    last_circle_completed_at = CASE WHEN p_stop = 'COMPLETED' THEN p_at ELSE c.last_circle_completed_at END,
    last_stop = excluded.last_stop, updated_at = excluded.updated_at;
END $fn$;
ALTER FUNCTION tenant_data.save_discovery_circle(uuid, uuid, text, text, text, timestamptz) OWNER TO repracer_discovery;
REVOKE EXECUTE ON FUNCTION tenant_data.save_discovery_circle(uuid, uuid, text, text, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenant_data.save_discovery_circle(uuid, uuid, text, text, text, timestamptz) TO repracer_app;

/** Шаг 55: курсор, с которого продолжит заход обхода аккаунта (NULL — круг с начала) */
CREATE OR REPLACE FUNCTION tenant_data.discovery_circle_cursor(p_tenant_id uuid, p_channel_account_id uuid)
  RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $fn$
  SELECT c.cursor FROM tenant_data.channel_discovery_circle c WHERE c.tenant_id = p_tenant_id AND c.channel_account_id = p_channel_account_id
$fn$;
ALTER FUNCTION tenant_data.discovery_circle_cursor(uuid, uuid) OWNER TO repracer_discovery;
REVOKE EXECUTE ON FUNCTION tenant_data.discovery_circle_cursor(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenant_data.discovery_circle_cursor(uuid, uuid) TO repracer_app;

-- ================================================================ 4. ревью шага 53, находка 8: число — записанных строк
CREATE OR REPLACE FUNCTION channel_data.record_channel_quantities(p_tenant_id uuid, p_channel_account_id uuid, p_items jsonb)
  RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
DECLARE
  i record;
  om_id uuid;
  rc integer;
  n integer := 0;
BEGIN
  FOR i IN SELECT * FROM jsonb_to_recordset(p_items) AS x(marketplace text, external_sku text, quantity integer, observed_at timestamptz) LOOP
    CONTINUE WHEN i.external_sku IS NULL OR i.quantity IS NULL OR i.quantity < 0 OR i.observed_at IS NULL;
    SELECT om.offer_mapping_id INTO om_id FROM tenant_data.offer_mapping om
     WHERE om.tenant_id = p_tenant_id AND om.channel_account_id = p_channel_account_id AND om.marketplace = i.marketplace
       AND om.external_sku = i.external_sku AND om.fulfillment = 'CHANNEL' AND om.status <> 'ENDED'
     ORDER BY om.created_at DESC LIMIT 1;
    CONTINUE WHEN om_id IS NULL;
    INSERT INTO channel_data.channel_quantity_current AS c (tenant_id, offer_mapping_id, quantity, observed_at)
    VALUES (p_tenant_id, om_id, i.quantity, i.observed_at)
    ON CONFLICT (tenant_id, offer_mapping_id) DO UPDATE SET quantity = excluded.quantity, observed_at = excluded.observed_at, updated_at = now()
     WHERE c.observed_at <= excluded.observed_at;
    -- Более старое наблюдение не записано — и не считается записанным
    GET DIAGNOSTICS rc = ROW_COUNT;
    n := n + rc;
  END LOOP;
  RETURN n;
END $fn$;

-- ================================================================ закрытие тенанта удаляет круг — до аккаунта, на который он ссылается
DO $$
DECLARE
  def text := pg_get_functiondef('maintenance.purge_tenant_data(uuid, boolean)'::regprocedure);
  anchor text := $a$'tenant_data.channel_credential',$a$;
BEGIN
  IF position(anchor IN def) = 0 THEN
    RAISE EXCEPTION 'purge_tenant_data: the anchor was not found — the function changed, update this migration';
  END IF;
  EXECUTE replace(def, anchor, $n$'tenant_data.channel_discovery_circle', 'tenant_data.channel_credential',$n$);
END $$;

COMMIT;
