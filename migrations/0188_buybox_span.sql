-- 0188_buybox_span.sql
-- Шаг 97 [Р-220]: доля Buy Box за период — по снимкам, не по продажам. Журнал снимков в PostgreSQL живёт 3 суток (0086), консоль ClickHouse
-- не читает [Р-22 — о пути решения, решение владельца шага 97 — и о консоли], поэтому держатель Buy Box копится в своей таблице отрезками:
-- отрезок — время, пока держатель (мы, другой продавец, никто) не менялся и снимки шли без дыры длиннее горизонта.
--
-- Отрезок открывается снимком, у которого держатель другой, или снимком после дыры длиннее горизонта (24 часа — самый редкий ярус опроса
-- раз в сутки, Р-47); каждый следующий снимок того же держателя продлевает `last_seen_at` — только вперёд, остальные поля неизменны
-- (страж). Держатель пишется, только когда канал его называет: у Amazon ANY_OFFER_CHANGED держателя в схеме нет (A-29) — отрезков нет,
-- и доля честно «неизвестна». Данные канала; 45 суток — запас под пресет 30 суток и свой диапазон, который календарь глубже не открывает.

BEGIN;
SET ROLE repracer_owner;

CREATE TABLE channel_data.buybox_span (
  tenant_id            uuid NOT NULL,
  buybox_span_id       uuid NOT NULL DEFAULT gen_random_uuid(),
  channel_account_id   uuid NOT NULL,
  marketplace          text NOT NULL,
  channel_product_ref  text NOT NULL,
  condition            text NOT NULL,
  -- SELF — Buy Box наш, OTHER — у другого продавца, NONE — канал назвал, что Buy Box нет ни у кого (снимок без Buy Box)
  holder               text NOT NULL CONSTRAINT buybox_span_holder_known CHECK (holder IN ('SELF', 'OTHER', 'NONE')),
  -- Продавец-держатель, если канал его назвал (псевдоним Kaufland, продавец модели Walmart); только у OTHER
  winner_seller_ref    text CONSTRAINT buybox_span_winner_only_other CHECK (winner_seller_ref IS NULL OR holder = 'OTHER'),
  started_at           timestamptz NOT NULL,
  last_seen_at         timestamptz NOT NULL,
  snapshots            int NOT NULL DEFAULT 1 CONSTRAINT buybox_span_snapshots_positive CHECK (snapshots >= 1),
  CONSTRAINT buybox_span_seen_after_start CHECK (last_seen_at >= started_at),
  PRIMARY KEY (tenant_id, buybox_span_id),
  FOREIGN KEY (tenant_id, channel_account_id) REFERENCES tenant_data.channel_account (tenant_id, channel_account_id)
);
COMMENT ON TABLE channel_data.buybox_span IS
  'Р-220 (шаг 97): держатель Buy Box отрезками времени по принятым снимкам — для доли Buy Box за период; данные канала, 45 суток';
SELECT security.register_table('channel_data.buybox_span', 'CHANNEL', 'mutable');
SELECT security.grant_retention('channel_data.buybox_span');
INSERT INTO maintenance.retention_policy (table_name, method, anchor_column, retention, safety_margin, bound, drop_order)
VALUES ('channel_data.buybox_span', 'DELETE_ROWS', 'last_seen_at', interval '45 days', interval '0', 'MAX_AGE', 60);
-- Под запрос доли Buy Box одного предложения за период (консоль, страница Competition) и под поиск последнего отрезка при записи снимка
CREATE INDEX buybox_span_offer_idx ON channel_data.buybox_span (tenant_id, channel_account_id, marketplace, channel_product_ref, condition, started_at DESC);

-- Путь решения пишет отрезок в транзакции снимка: новый — вставкой, продление — обновлением. Административных полей у отрезка нет — все
-- столбцы рабочие, и право на таблицу целиком [Р-100]; что меняется только продление, держит страж ниже
GRANT SELECT, INSERT, UPDATE ON channel_data.buybox_span TO repracer_app;

/**
 * Отрезок неизменяем, кроме продления: `last_seen_at` — только вперёд, счётчик снимков — только вверх. Перенести начало, сменить
 * держателя или продавца задним числом нечем — иначе доля Buy Box переписывалась бы
 */
CREATE FUNCTION channel_data.buybox_span_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  IF (NEW.tenant_id, NEW.buybox_span_id, NEW.channel_account_id, NEW.marketplace, NEW.channel_product_ref, NEW.condition, NEW.holder,
      NEW.winner_seller_ref, NEW.started_at)
     IS DISTINCT FROM (OLD.tenant_id, OLD.buybox_span_id, OLD.channel_account_id, OLD.marketplace, OLD.channel_product_ref, OLD.condition, OLD.holder,
      OLD.winner_seller_ref, OLD.started_at) THEN
    RAISE EXCEPTION 'a Buy Box span is immutable except its extension (Р-220)' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.last_seen_at < OLD.last_seen_at OR NEW.snapshots < OLD.snapshots THEN
    RAISE EXCEPTION 'a Buy Box span is only extended forward (Р-220)' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER a_buybox_span_guard BEFORE UPDATE ON channel_data.buybox_span
  FOR EACH ROW EXECUTE FUNCTION channel_data.buybox_span_guard();
RESET ROLE;

-- Р-96: права пути решения — списком разрешённого (тот же список сверяет проверка схемы в обе стороны)
DO $do$
DECLARE
  d text := pg_get_functiondef('security.decision_path_allowed_privileges()'::regprocedure);
  a text := $s$('channel_data.competitor_price_daily', 'SELECT', NULL),$s$;
BEGIN
  IF (length(d) - length(replace(d, a, ''))) / length(a) <> 1 THEN
    RAISE EXCEPTION '0188: security.decision_path_allowed_privileges() is not the definition the migration expects';
  END IF;
  EXECUTE replace(d, a, a || $s$
    -- Шаг 97 [Р-220]: отрезки держателя Buy Box — в транзакции снимка
    ('channel_data.buybox_span', 'SELECT', NULL), ('channel_data.buybox_span', 'INSERT', NULL), ('channel_data.buybox_span', 'UPDATE', NULL),$s$);
END $do$;

-- Закрытие тенанта уносит отрезки вместе с его данными канала (правило 0102)
DO $do$
DECLARE
  d text := pg_get_functiondef('maintenance.purge_tenant_channel_data(uuid)'::regprocedure);
  a text := $s$'channel_data.floor_hold',$s$;
BEGIN
  IF (length(d) - length(replace(d, a, ''))) / length(a) <> 1 THEN
    RAISE EXCEPTION '0188: maintenance.purge_tenant_channel_data(uuid) is not the definition the migration expects';
  END IF;
  EXECUTE replace(d, a, $s$'channel_data.floor_hold', 'channel_data.buybox_span',$s$);
END $do$;

COMMIT;
