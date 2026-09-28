-- 0144_channel_managed_quantity.sql
-- Шаг 52, п. 7: количество, которым управляет КАНАЛ (Amazon FBA), видно продавцу в консоли — только для чтения.
--
-- Количество FBA ведёт Amazon [Р-6]: единицы записи количества у предложения CHANNEL нет (0005, offer_mapping_check7), и наша
-- запись его не касается (AMZ_C14). Обнаружение уже читает его (`getInventorySummaries`, AMZ_C13), но значение никуда не
-- попадало (ревью шага 51, находка 7). Теперь оно — НАБЛЮДЕНИЕ предложения: данные канала, не дольше 18 месяцев [Р-3],
-- действующее — последнее по времени наблюдения. Пишет его функция узкой роли каталога (как каталог из обнаружения, 0134):
-- у пути решения по-прежнему нет права писать в таблицы данных канала напрямую [Р-96]. Страж: наблюдение принадлежит
-- только предложению, которое исполняет канал, — количества «управляет Amazon» у нашего FBM-предложения не бывает.

BEGIN;

SET ROLE repracer_owner;

CREATE TABLE channel_data.channel_quantity_observation (
  tenant_id              uuid NOT NULL,
  observation_id         uuid NOT NULL DEFAULT gen_random_uuid(),
  offer_mapping_id       uuid NOT NULL,
  quantity               integer NOT NULL CONSTRAINT channel_quantity_observation_quantity_nonnegative CHECK (quantity >= 0),
  observed_at            timestamptz NOT NULL,
  recorded_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, observation_id),
  FOREIGN KEY (tenant_id, offer_mapping_id) REFERENCES tenant_data.offer_mapping (tenant_id, offer_mapping_id)
);
COMMENT ON TABLE channel_data.channel_quantity_observation IS
  'Шаг 52: количество, которым управляет канал (Amazon FBA), у предложения CHANNEL — наблюдение при обнаружении (данные канала, 18 месяцев); действующее — последнее по observed_at';
SELECT security.register_table('channel_data.channel_quantity_observation', 'CHANNEL', 'append_only');
SELECT security.grant_retention('channel_data.channel_quantity_observation');
INSERT INTO maintenance.retention_policy (table_name, method, anchor_column, retention, bound)
VALUES ('channel_data.channel_quantity_observation', 'DELETE_ROWS', 'recorded_at', interval '18 months', 'MAX_AGE');
-- Последнее наблюдение предложения: экран остатков консоли
CREATE INDEX channel_quantity_observation_latest_idx ON channel_data.channel_quantity_observation (tenant_id, offer_mapping_id, observed_at DESC);

/** Страж: количество «управляет канал» — только у предложения, которое исполняет канал (fulfillment = CHANNEL) [Р-6] */
CREATE FUNCTION channel_data.channel_quantity_observation_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM tenant_data.offer_mapping om
                  WHERE om.tenant_id = NEW.tenant_id AND om.offer_mapping_id = NEW.offer_mapping_id AND om.fulfillment = 'CHANNEL') THEN
    RAISE EXCEPTION 'channel managed quantity belongs only to an offer fulfilled by the channel (Р-6): offer % is merchant fulfilled', NEW.offer_mapping_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER channel_quantity_observation_channel_only BEFORE INSERT ON channel_data.channel_quantity_observation
  FOR EACH ROW EXECUTE FUNCTION channel_data.channel_quantity_observation_guard();

/**
 * Запись наблюдений количества канала по итогам обнаружения: элементы `{marketplace, external_sku, quantity, observed_at}`.
 * Предложение ищется среди действующих сопоставлений аккаунта с исполнением CHANNEL; остальные элементы пропускаются (у нашего
 * FBM-предложения такого количества нет). Тенант держат политики строк роли каталога [Р-31].
 */
CREATE FUNCTION channel_data.record_channel_quantities(p_tenant_id uuid, p_channel_account_id uuid, p_items jsonb)
  RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
DECLARE
  i record;
  om_id uuid;
  n integer := 0;
BEGIN
  FOR i IN SELECT * FROM jsonb_to_recordset(p_items) AS x(marketplace text, external_sku text, quantity integer, observed_at timestamptz) LOOP
    CONTINUE WHEN i.external_sku IS NULL OR i.quantity IS NULL OR i.quantity < 0 OR i.observed_at IS NULL;
    SELECT om.offer_mapping_id INTO om_id FROM tenant_data.offer_mapping om
     WHERE om.tenant_id = p_tenant_id AND om.channel_account_id = p_channel_account_id AND om.marketplace = i.marketplace
       AND om.external_sku = i.external_sku AND om.fulfillment = 'CHANNEL' AND om.status <> 'ENDED'
     ORDER BY om.created_at DESC LIMIT 1;
    CONTINUE WHEN om_id IS NULL;
    INSERT INTO channel_data.channel_quantity_observation (tenant_id, offer_mapping_id, quantity, observed_at)
    VALUES (p_tenant_id, om_id, i.quantity, i.observed_at);
    n := n + 1;
  END LOOP;
  RETURN n;
END $fn$;

RESET ROLE;

-- Роль каталога: читать сопоставления (уже может — 0134, 0140), вставлять наблюдения; политика строк — тенант сессии
GRANT SELECT (tenant_id, offer_mapping_id, channel_account_id, marketplace, external_sku, fulfillment, status, created_at) ON tenant_data.offer_mapping TO repracer_catalog;
GRANT INSERT (tenant_id, offer_mapping_id, quantity, observed_at) ON channel_data.channel_quantity_observation TO repracer_catalog;
CREATE POLICY catalog_channel_quantity_insert ON channel_data.channel_quantity_observation FOR INSERT TO repracer_catalog
  WITH CHECK (tenant_id = security.current_tenant_id());
ALTER FUNCTION channel_data.channel_quantity_observation_guard() OWNER TO repracer_owner;
ALTER FUNCTION channel_data.record_channel_quantities(uuid, uuid, jsonb) OWNER TO repracer_catalog;
REVOKE EXECUTE ON FUNCTION channel_data.record_channel_quantities(uuid, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION channel_data.record_channel_quantities(uuid, uuid, jsonb) TO repracer_app;

-- Пишет только функция роли каталога: у административной роли и пути решения вставки нет (как floor_hold, 0132). Экран остатков
-- читает административной ролью (чтение — политика таблицы тенанта); список разрешённого роли остатков не расширяется [Р-102]
REVOKE INSERT ON channel_data.channel_quantity_observation FROM repracer_admin, repracer_app;

-- Закрытие тенанта удаляет и эту таблицу — до сопоставлений, на которые она ссылается
DO $$
DECLARE
  def text := pg_get_functiondef('maintenance.purge_tenant_channel_data(uuid)'::regprocedure);
  anchor text := $a$'channel_data.offer_channel_pricing',$a$;
BEGIN
  IF position(anchor IN def) = 0 THEN
    RAISE EXCEPTION 'purge_tenant_channel_data: the anchor was not found — the function changed, update this migration';
  END IF;
  EXECUTE replace(def, anchor, $n$'channel_data.channel_quantity_observation', 'channel_data.offer_channel_pricing',$n$);
END $$;

COMMIT;
