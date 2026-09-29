-- 0146_channel_quantity_current.sql
-- Шаг 53, решение Р-196 (ревью шага 52, находка 7): количество, которым управляет канал (FBA), в PostgreSQL — ПРОЕКЦИЯ текущего значения
-- предложения, а не 18 месяцев наблюдений. Экрану нужно одно последнее значение, решение о цене его не читает; по Р-20 в PostgreSQL лежит
-- текущее, а временной ряд данных канала — место ClickHouse (сейчас ряд не нужен, и он не собирается). Журнал наблюдений 0144 заменяется:
-- строка на предложение обновляется на месте; значение старше 18 месяцев (канал давно не отвечал) удаляется сроком данных канала [Р-3].
-- Страж и пишущая функция роли каталога — те же, что в 0144.

BEGIN;

SET ROLE repracer_owner;

-- Регистрация и срок — до удаления таблицы, пока её имя разрешается
DELETE FROM security.table_registry WHERE table_name = 'channel_data.channel_quantity_observation'::regclass;
DELETE FROM maintenance.retention_policy WHERE table_name = 'channel_data.channel_quantity_observation'::regclass;
DROP TABLE channel_data.channel_quantity_observation;

CREATE TABLE channel_data.channel_quantity_current (
  tenant_id              uuid NOT NULL,
  offer_mapping_id       uuid NOT NULL,
  quantity               integer NOT NULL CONSTRAINT channel_quantity_current_quantity_nonnegative CHECK (quantity >= 0),
  observed_at            timestamptz NOT NULL,
  updated_at             timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, offer_mapping_id),
  FOREIGN KEY (tenant_id, offer_mapping_id) REFERENCES tenant_data.offer_mapping (tenant_id, offer_mapping_id)
);
COMMENT ON TABLE channel_data.channel_quantity_current IS
  'Р-196: текущее количество, которым управляет канал (Amazon FBA), у предложения CHANNEL — проекция последнего наблюдения, только для показа; срок данных канала 18 месяцев по observed_at';
SELECT security.register_table('channel_data.channel_quantity_current', 'CHANNEL', 'mutable');
SELECT security.grant_retention('channel_data.channel_quantity_current');
INSERT INTO maintenance.retention_policy (table_name, method, anchor_column, retention, bound)
VALUES ('channel_data.channel_quantity_current', 'DELETE_ROWS', 'observed_at', interval '18 months', 'MAX_AGE');

CREATE OR REPLACE FUNCTION channel_data.channel_quantity_observation_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM tenant_data.offer_mapping om
                  WHERE om.tenant_id = NEW.tenant_id AND om.offer_mapping_id = NEW.offer_mapping_id AND om.fulfillment = 'CHANNEL') THEN
    RAISE EXCEPTION 'channel managed quantity belongs only to an offer fulfilled by the channel (Р-6): offer % is merchant fulfilled', NEW.offer_mapping_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER channel_quantity_current_channel_only BEFORE INSERT OR UPDATE ON channel_data.channel_quantity_current
  FOR EACH ROW EXECUTE FUNCTION channel_data.channel_quantity_observation_guard();

RESET ROLE;

-- Функция принадлежит роли каталога (0144) — заменяется вне роли владельца схемы
/** Р-196: наблюдение обновляет текущее значение предложения; более старое наблюдение новое не перезаписывает */
CREATE OR REPLACE FUNCTION channel_data.record_channel_quantities(p_tenant_id uuid, p_channel_account_id uuid, p_items jsonb)
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
    INSERT INTO channel_data.channel_quantity_current AS c (tenant_id, offer_mapping_id, quantity, observed_at)
    VALUES (p_tenant_id, om_id, i.quantity, i.observed_at)
    ON CONFLICT (tenant_id, offer_mapping_id) DO UPDATE SET quantity = excluded.quantity, observed_at = excluded.observed_at, updated_at = now()
     WHERE c.observed_at <= excluded.observed_at;
    n := n + 1;
  END LOOP;
  RETURN n;
END $fn$;


GRANT SELECT, INSERT (tenant_id, offer_mapping_id, quantity, observed_at),
      UPDATE (quantity, observed_at, updated_at) ON channel_data.channel_quantity_current TO repracer_catalog;
CREATE POLICY catalog_channel_quantity_current ON channel_data.channel_quantity_current FOR ALL TO repracer_catalog
  USING (tenant_id = security.current_tenant_id()) WITH CHECK (tenant_id = security.current_tenant_id());
REVOKE INSERT, UPDATE, DELETE ON channel_data.channel_quantity_current FROM repracer_admin, repracer_app;
ALTER FUNCTION channel_data.record_channel_quantities(uuid, uuid, jsonb) OWNER TO repracer_catalog;
REVOKE EXECUTE ON FUNCTION channel_data.record_channel_quantities(uuid, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION channel_data.record_channel_quantities(uuid, uuid, jsonb) TO repracer_app;

-- Закрытие тенанта удаляет проекцию — прежнее имя в списке очистки заменяется новым
DO $$
DECLARE
  def text := pg_get_functiondef('maintenance.purge_tenant_channel_data(uuid)'::regprocedure);
  anchor text := $a$'channel_data.channel_quantity_observation',$a$;
BEGIN
  IF position(anchor IN def) = 0 THEN
    RAISE EXCEPTION 'purge_tenant_channel_data: the anchor was not found — the function changed, update this migration';
  END IF;
  EXECUTE replace(def, anchor, $n$'channel_data.channel_quantity_current',$n$);
END $$;

COMMIT;
