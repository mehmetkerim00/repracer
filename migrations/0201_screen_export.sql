-- 0201_screen_export.sql
-- Шаг 104 [Р-229, ADR-0062]: выгрузка экранов в файл (CSV / XLSX) — кнопка «Export» на экранах с данными.
--
-- 1. Вид задания SCREEN_EXPORT: файл готовит исполнитель единственным путём выгрузки [Р-145], задание ничего не меняет (второй фактор
--    не нужен, Р-143), отменить чужое вправе тот, кто видит цены (VIEW_PRICING). Гость демо заданий не создаёт вовсе — страж 0124
--    остаётся как был (решение владельца шага 104).
-- 2. Потолок выгрузки — 50 000 строк: файл больше база не принимает — честный отказ «narrow the period», а не обрезанный файл.
-- 3. Каждая выгрузка — событие аудита (кто, что, сколько строк): его пишет база, когда исполнитель сохраняет файл, — от имени
--    человека, создавшего задание; журнал аудита только на добавление.

BEGIN;
SET ROLE repracer_owner;

-- ---------------------------------------------------------------- 1. Вид задания
ALTER TABLE tenant_data.bulk_job DROP CONSTRAINT bulk_job_kind_known;
ALTER TABLE tenant_data.bulk_job ADD CONSTRAINT bulk_job_kind_known
  CHECK (kind IN ('COST_IMPORT', 'BOUNDS_EDIT', 'BOUNDS_PLAN', 'STRATEGY_ASSIGN', 'STRATEGY_PREVIEW', 'PRICE_EVIDENCE', 'PRICE_FEED_EXPORT',
                  'REPRICING_ENABLE', 'STOCK_IMPORT', 'STOCK_SYNC_ENABLE', 'IMPORT_TEMPLATE', 'IMPORT_CHECK', 'SCREEN_EXPORT'));

/** Р-143: выгрузка экрана ничего не меняет. Прежний список не переписан, а дополнен: на его текст ссылаются строки каталога мутаций */
CREATE OR REPLACE FUNCTION security.read_only_job_kinds() RETURNS SETOF text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
  SELECT unnest(ARRAY['BOUNDS_PLAN', 'STRATEGY_PREVIEW', 'PRICE_EVIDENCE', 'PRICE_FEED_EXPORT'])
  -- Шаг 99 [Р-224]: шаблон импорта и примерка файла
  UNION ALL SELECT unnest(ARRAY['IMPORT_TEMPLATE', 'IMPORT_CHECK'])
  -- Шаг 104 [Р-229]: выгрузка экрана
  UNION ALL SELECT unnest(ARRAY['SCREEN_EXPORT'])
$fn$;

/** Р-145: выгрузка экрана отдаёт файл. Прежний список дополнен, а не переписан (его текст цитирует каталог мутаций) */
CREATE OR REPLACE FUNCTION security.file_producing_job_kinds() RETURNS SETOF text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
  SELECT unnest(ARRAY['IMPORT_TEMPLATE', 'IMPORT_CHECK', 'PRICE_EVIDENCE', 'PRICE_FEED_EXPORT'])
  -- Шаг 104 [Р-229]: выгрузка экрана
  UNION ALL SELECT unnest(ARRAY['SCREEN_EXPORT'])
$fn$;

-- Р-143: право на вид операции — выгрузку чужую отменяет тот, кто видит цены (как выгрузку ленты и доказательства)
DO $do$
DECLARE
  d text := pg_get_functiondef('security.bulk_job_cancel_action(text)'::regprocedure);
  a text := $s$WHEN p_kind = 'IMPORT_CHECK' THEN 'MANAGE_PRICING'$s$;
BEGIN
  IF (length(d) - length(replace(d, a, ''))) / length(a) <> 1 THEN
    RAISE EXCEPTION '0201: security.bulk_job_cancel_action(text) is not the definition the migration expects';
  END IF;
  EXECUTE replace(d, a, a || $s$
              -- Шаг 104 [Р-229]: выгрузка экрана — чтение
              WHEN p_kind = 'SCREEN_EXPORT' THEN 'VIEW_PRICING'$s$);
END $do$;

-- ---------------------------------------------------------------- 2. Потолок выгрузки
/**
 * Выгрузка экрана — не больше 50 000 строк. Сервер отказывает до создания задания, исполнитель — если строк стало больше за время
 * работы; база держит то же свойство у самого файла: обрезанный или раздутый файл выгрузки не сохраняется
 */
CREATE FUNCTION tenant_data.bulk_job_artifact_export_cap() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  IF NEW.rows_count > 50000 AND EXISTS (SELECT 1 FROM tenant_data.bulk_job j
                                         WHERE j.tenant_id = NEW.tenant_id AND j.bulk_job_id = NEW.bulk_job_id AND j.kind = 'SCREEN_EXPORT') THEN
    RAISE EXCEPTION 'a screen export of % rows is over the limit of 50 000 rows: narrow the period (Р-229)', NEW.rows_count
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER c_bulk_job_artifact_export_cap BEFORE INSERT OR UPDATE ON tenant_data.bulk_job_artifact
  FOR EACH ROW EXECUTE FUNCTION tenant_data.bulk_job_artifact_export_cap();

RESET ROLE;

-- ---------------------------------------------------------------- 3. Событие аудита выгрузки
/**
 * Кто, что и сколько строк: человек — создатель задания (его членство и пользователь), что — экран, формат, период и фильтры из
 * параметров задания, сколько — строки сохранённого файла. Пишет база при сохранении файла исполнителем (повтор, перезаписавший файл, —
 * тоже событие: файл снова выдан); у других видов заданий события нет
 */
CREATE FUNCTION tenant_data.screen_export_audit() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
DECLARE
  j record;
BEGIN
  SELECT b.kind, b.params, b.created_by_membership_id, m.user_id INTO j
    FROM tenant_data.bulk_job b
    JOIN tenant_data.membership m ON m.tenant_id = b.tenant_id AND m.membership_id = b.created_by_membership_id
   WHERE b.tenant_id = NEW.tenant_id AND b.bulk_job_id = NEW.bulk_job_id;
  -- Условие — в теле, а не в WHEN триггера: список допустимых условий WHEN держит проверка схемы (шаг 19)
  IF j.kind IS DISTINCT FROM 'SCREEN_EXPORT' THEN
    RETURN NULL;
  END IF;
  INSERT INTO audit.audit_event (tenant_id, occurred_at, actor_type, actor_user_id, actor_membership_id, action, entity_type, entity_id, changes)
  VALUES (NEW.tenant_id, now(), 'USER', j.user_id, j.created_by_membership_id, 'data_export.file_produced', 'tenant_data.bulk_job', NEW.bulk_job_id,
          jsonb_strip_nulls(jsonb_build_object('screen', j.params ->> 'screen', 'format', j.params ->> 'format', 'rows', NEW.rows_count,
            'fileName', NEW.file_name, 'period', j.params -> 'period', 'filters', j.params -> 'filters', 'at', now())));
  RETURN NULL;
END $fn$;
ALTER FUNCTION tenant_data.screen_export_audit() OWNER TO repracer_audit_writer;
REVOKE EXECUTE ON FUNCTION tenant_data.screen_export_audit() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenant_data.screen_export_audit() TO repracer_owner;
-- Роль аудита читает задание: вид, параметры и автора (как членства и системные остановки, 0058)
GRANT SELECT (tenant_id, bulk_job_id, kind, params, created_by_membership_id) ON tenant_data.bulk_job TO repracer_audit_writer;
CREATE POLICY audit_writer_read ON tenant_data.bulk_job FOR SELECT TO repracer_audit_writer USING (true);

SET ROLE repracer_owner;
CREATE TRIGGER zb_screen_export_audit AFTER INSERT OR UPDATE ON tenant_data.bulk_job_artifact
  FOR EACH ROW EXECUTE FUNCTION tenant_data.screen_export_audit();
RESET ROLE;

COMMIT;
