-- 0111_bulk_job_lifecycle.sql: жизнь фонового задания — отмена, предел очереди, срок хранения [Р-139; OQ-207, OQ-208 шага 30]
--
-- Ревью шага 30 нашло три вещи, до которых шаг не дошёл. Ошибочно запущенная правка всего каталога останавливалась только
-- ожиданием. Участник с правом ТОЛЬКО СМОТРЕТЬ мог поставить в очередь сколько угодно предпросмотров по 10 000 предложений —
-- очередь у тенанта одна и строго по времени создания, и массовые операции вставали. А файл продавца и готовая выгрузка
-- лежали в базе до закрытия тенанта: каждый импорт и каждое доказательство оставляли копию навсегда.

BEGIN;

SET ROLE repracer_owner;

-- Отменённое задание — такой же итог, как отказ: дальше оно не берётся и не переписывается
ALTER TABLE tenant_data.bulk_job DROP CONSTRAINT bulk_job_status_known;
ALTER TABLE tenant_data.bulk_job ADD CONSTRAINT bulk_job_status_known
  CHECK (status IN ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'INTERRUPTED', 'CANCELLED'));
ALTER TABLE tenant_data.bulk_job DROP CONSTRAINT bulk_job_finished_has_outcome;
ALTER TABLE tenant_data.bulk_job ADD CONSTRAINT bulk_job_finished_has_outcome
  CHECK ((status IN ('SUCCEEDED', 'FAILED', 'CANCELLED')) = (finished_at IS NOT NULL));

/**
 * OQ-207: отменить можно ТОЛЬКО ожидающее задание. Отменять применение посередине нечего — оно целиком или никак [Р-134], и
 * «отмена» на полпути означала бы ровно то же, что падение процесса: откат и повтор. Поэтому отмена — про очередь.
 */
CREATE OR REPLACE FUNCTION tenant_data.bulk_job_status_forward_only() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  IF OLD.status IN ('SUCCEEDED', 'FAILED', 'CANCELLED') AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'bulk job % is finished as %: its outcome is not rewritten (Р-139)', OLD.bulk_job_id, OLD.status
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status = 'PENDING' AND NEW.status NOT IN ('PENDING', 'RUNNING', 'CANCELLED') THEN
    RAISE EXCEPTION 'bulk job % goes from PENDING to RUNNING or CANCELLED, not to % (Р-139)', OLD.bulk_job_id, NEW.status
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.status = 'CANCELLED' AND OLD.status <> 'PENDING' THEN
    RAISE EXCEPTION 'bulk job % is %, not waiting: applying is all or nothing and is not cancelled halfway (Р-134, Р-139)', OLD.bulk_job_id, OLD.status
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $fn$;
ALTER FUNCTION tenant_data.bulk_job_status_forward_only() OWNER TO repracer_owner;

/**
 * OQ-207: сколько заданий тенант может поставить в очередь. Очередь у тенанта одна и строго по времени создания, поэтому
 * длинная очередь одного человека задерживает всех остальных в том же тенанте. Число — предел продукта: массовых операций
 * подряд столько не делают, а поставить их сотню можно только по ошибке или намеренно.
 */
CREATE FUNCTION tenant_data.bulk_job_queue_limit() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
DECLARE
  waiting int;
  mine    int;
BEGIN
  SELECT count(*) FILTER (WHERE true), count(*) FILTER (WHERE j.created_by_membership_id = NEW.created_by_membership_id)
    INTO waiting, mine
    FROM tenant_data.bulk_job j
   WHERE j.tenant_id = NEW.tenant_id AND j.status IN ('PENDING', 'RUNNING', 'INTERRUPTED');
  /**
   * Предел у КАЖДОГО участника свой, и он меньше общего (находка 14 ревью шага 31). Иначе участник с правом только смотреть
   * занимает всю очередь тенанта выгрузками доказательства — и владелец получает отказ на импорт себестоимости.
   */
  IF mine > 5 THEN
    RAISE EXCEPTION 'member % already has % bulk jobs waiting: finish or cancel them before starting more (Р-139)', NEW.created_by_membership_id, mine - 1
      USING ERRCODE = 'too_many_rows';
  END IF;
  IF waiting > 20 THEN
    RAISE EXCEPTION 'tenant % already has % bulk jobs waiting: finish or cancel them before starting more (Р-139)', NEW.tenant_id, waiting - 1
      USING ERRCODE = 'too_many_rows';
  END IF;
  RETURN NULL;
END $fn$;
CREATE TRIGGER zd_bulk_job_queue_limit AFTER INSERT ON tenant_data.bulk_job
  FOR EACH ROW EXECUTE FUNCTION tenant_data.bulk_job_queue_limit();
ALTER FUNCTION tenant_data.bulk_job_queue_limit() OWNER TO repracer_owner;

/**
 * OQ-208 (срок хранения) закрыт НЕ здесь и здесь закрыт быть не может. Удалять данные тенанта по времени разрешено только
 * после подтверждённого экспорта (инвариант 9, docs/data-retention.md), а экспорта заданий нет: ни файл продавца в параметрах,
 * ни готовая выгрузка в архив не выгружаются. Правило проверки схемы это и показало — попытка поставить обоим таблицам
 * удаление по сроку упёрлась в «tenant data deleted by time without export».
 *
 * Что сделано взамен: файл, на который ссылается готовая выгрузка, удаляется ВМЕСТЕ со своим заданием — без этого закрытие
 * тенанта пришлось бы удалять две таблицы в правильном порядке, и порядок этот держался бы только текстом очистки.
 */
ALTER TABLE tenant_data.bulk_job_artifact DROP CONSTRAINT bulk_job_artifact_tenant_id_bulk_job_id_fkey;
ALTER TABLE tenant_data.bulk_job_artifact ADD CONSTRAINT bulk_job_artifact_tenant_id_bulk_job_id_fkey
  FOREIGN KEY (tenant_id, bulk_job_id) REFERENCES tenant_data.bulk_job (tenant_id, bulk_job_id) ON DELETE CASCADE;

RESET ROLE;


-- Отмена — действие ЧЕЛОВЕКА: у неё автор и строка аудита, как у создания задания [Р-97]
GRANT UPDATE (status, finished_at) ON tenant_data.bulk_job TO repracer_admin;
CREATE TRIGGER a0_admin_write_person_update BEFORE UPDATE ON tenant_data.bulk_job
  FOR EACH ROW EXECUTE FUNCTION security.require_person_for_admin_write();
CREATE TRIGGER zz_admin_write_audit_update AFTER UPDATE ON tenant_data.bulk_job
  FOR EACH ROW EXECUTE FUNCTION security.audit_admin_write();

COMMIT;
