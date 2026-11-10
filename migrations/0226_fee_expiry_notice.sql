-- 0226_fee_expiry_notice.sql: предупреждение об истечении оценки комиссии (шаг 120, P1-04).
--
-- Оценка комиссии предложения живёт 90 суток (оценка продавца из файла себестоимости). Когда кончается ПОСЛЕДНЯЯ действующая оценка,
-- пол не считается и цена предложения замерзает (fail-closed, 0051/0106). Так было и раньше — но владелец узнавал об этом постфактум.
-- Теперь пересчёт по расписанию в начале захода записывает уведомление:
--   EXPIRING — до конца последней действующей оценки 14 суток или меньше (WARNING владельцу);
--   EXPIRED  — она кончилась (CRITICAL).
-- Журнал уведомлений держит однократность: ключ — предложение, МОМЕНТ истечения и вид. Повторный заход строку не добавляет, и письма нет;
-- новая оценка — новый момент, и цикл начинается заново. Строку пишет путь решения (роль приложения) — это операционная отметка, как
-- журнал сырья уведомлений (0213), а не действие человека.

BEGIN;

SET ROLE repracer_owner;

CREATE TABLE channel_data.fee_expiry_notice (
  tenant_id       uuid NOT NULL,
  write_scope_id  uuid NOT NULL,
  -- Момент, когда кончается последняя действующая оценка предложения: он и есть ключ цикла
  valid_until     timestamptz NOT NULL,
  kind            text NOT NULL,
  noticed_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, write_scope_id, valid_until, kind),
  CONSTRAINT fee_expiry_notice_kind_known CHECK (kind IN ('EXPIRING', 'EXPIRED')),
  -- «Истекла» — только когда момент наступил; «скоро истечёт» — только пока он впереди. Время — часы базы
  CONSTRAINT fee_expiry_notice_kind_matches_time CHECK ((kind = 'EXPIRED') = (valid_until <= noticed_at)),
  FOREIGN KEY (tenant_id, write_scope_id) REFERENCES tenant_data.write_scope (tenant_id, write_scope_id)
);
COMMENT ON TABLE channel_data.fee_expiry_notice IS
  'Шаг 120 (P1-04): уведомления об истечении оценки комиссии — одна строка на предложение, момент истечения и вид (EXPIRING за 14 суток, EXPIRED в момент); 18 месяцев';
SELECT security.register_table('channel_data.fee_expiry_notice', 'CHANNEL', 'append_only');
SELECT security.grant_retention('channel_data.fee_expiry_notice');
GRANT SELECT, INSERT ON channel_data.fee_expiry_notice TO repracer_app;
-- Строка нужна, пока жива оценка, о которой она: оценка живёт 18 месяцев от вычисления, уведомление — 18 месяцев от записи (позже)
INSERT INTO maintenance.retention_policy (table_name, method, anchor_column, retention, safety_margin, drop_order)
VALUES ('channel_data.fee_expiry_notice', 'DELETE_ROWS', 'noticed_at', interval '18 months', interval '0', 60);

RESET ROLE;

-- Р-96: журнал пишет путь решения — пересчёт по расписанию в транзакции тенанта
DO $do$
DECLARE
  d text := pg_get_functiondef('security.decision_path_allowed_privileges()'::regprocedure);
  a text := $s$('channel_data.notification_journal', 'SELECT', NULL), ('channel_data.notification_journal', 'INSERT', NULL),$s$;
BEGIN
  IF (length(d) - length(replace(d, a, ''))) / length(a) <> 1 THEN
    RAISE EXCEPTION '0226: security.decision_path_allowed_privileges() is not the definition the migration expects';
  END IF;
  EXECUTE replace(d, a, a || $s$
    -- Шаг 120 (P1-04): уведомления об истечении оценки комиссии — пишет пересчёт по расписанию
    ('channel_data.fee_expiry_notice', 'SELECT', NULL), ('channel_data.fee_expiry_notice', 'INSERT', NULL),$s$);
END $do$;

-- Очистка данных канала тенанта (правило 0102) — журнал ссылается на единицу записи и уходит раньше неё
DO $do$
DECLARE
  d text := pg_get_functiondef('maintenance.purge_tenant_channel_data(uuid)'::regprocedure);
  a text := $s$'channel_data.notification_journal',$s$;
BEGIN
  IF (length(d) - length(replace(d, a, ''))) / length(a) <> 1 THEN
    RAISE EXCEPTION '0226: maintenance.purge_tenant_channel_data(uuid) is not the definition the migration expects';
  END IF;
  EXECUTE replace(d, a, $s$'channel_data.fee_expiry_notice', 'channel_data.notification_journal',$s$);
END $do$;

COMMIT;
