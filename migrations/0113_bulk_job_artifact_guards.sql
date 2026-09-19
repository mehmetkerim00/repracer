-- 0113_bulk_job_artifact_guards.sql: у файла задания появляются свои стражи (шаг 32) [Р-145, Р-146].
--
-- До этого шага таблица `tenant_data.bulk_job_artifact` не имела НИ ОДНОЙ защиты: кто угодно с правом фонового исполнителя мог
-- положить файл любому заданию, с любой контрольной суммой и любым содержимым. Это заметили не мутации и не ревью — это
-- заметил Р-145, когда потребовалось назвать «единственный путь выгрузки»: путь, который ничем не закреплён в базе, — это
-- договорённость, а не путь.
--
-- Три стража, и каждый закрывает свой способ обойти единственный путь:
--   1. контрольная сумма считается по содержимому, а не объявляется — файл, собранный мимо пути, не сойдётся с ней;
--   2. файл кладётся ТОЛЬКО к заданию, которое этот процесс сейчас держит и которое ещё идёт;
--   3. файл бывает только у вида задания, который файлы и делает, — список один и назван в базе [Р-146].

BEGIN;

SET ROLE repracer_owner;

/**
 * Р-145: виды заданий, которые ОТДАЮТ продавцу файл. Список один на всю систему, как и список видов без второго фактора
 * [Р-143]: новый вид, которому понадобился файл, называется здесь, а не заводит себе выгрузку молча.
 *
 * COST_IMPORT в списке потому, что отчёт о несопоставленных строках — такой же файл продавца, хотя само задание меняет базу.
 */
CREATE FUNCTION security.file_producing_job_kinds() RETURNS SETOF text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
  SELECT unnest(ARRAY['COST_IMPORT', 'PRICE_EVIDENCE', 'PRICE_FEED_EXPORT'])
$fn$;
ALTER FUNCTION security.file_producing_job_kinds() OWNER TO repracer_owner;
GRANT EXECUTE ON FUNCTION security.file_producing_job_kinds() TO repracer_app, repracer_admin, repracer_bulk_worker;

/**
 * Р-145: контрольная сумма ФАЙЛА, а не то, что о ней сказали. Продавец сверяет её со скачанным файлом [Р-123]: если её
 * объявляет тот же код, который собрал файл, она подтверждает лишь саму себя.
 *
 * Именно это делало возможным второй путь выгрузки: обработчик, собравший файл по-своему, мог посчитать сумму по-своему — или
 * не посчитать вовсе, — и база принимала это молча.
 */
CREATE FUNCTION tenant_data.bulk_job_artifact_digest_matches() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  IF NEW.sha256 IS DISTINCT FROM encode(sha256(convert_to(NEW.content, 'UTF8')), 'hex') THEN
    RAISE EXCEPTION 'the checksum of the file of bulk job % does not match its content: the database computes it, it is not declared (Р-145)',
      NEW.bulk_job_id USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER a_bulk_job_artifact_digest_matches BEFORE INSERT OR UPDATE ON tenant_data.bulk_job_artifact
  FOR EACH ROW EXECUTE FUNCTION tenant_data.bulk_job_artifact_digest_matches();
ALTER FUNCTION tenant_data.bulk_job_artifact_digest_matches() OWNER TO repracer_owner;

/**
 * Р-145: файл кладётся к СВОЕМУ заданию. Процесс, потерявший аренду, не дописывает файл заданию, которое уже взял другой:
 * ровно это делало потерю аренды молчаливой — задание не знало о записи, которую процесс всё-таки сделал (находка 3 ревью
 * шага 30, закрытая тогда только в коде исполнителя).
 *
 * Аренда называется тем же способом, что у стража самого задания, — `app.bulk_lease_owner`.
 */
CREATE FUNCTION tenant_data.bulk_job_artifact_own_job() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
DECLARE
  j tenant_data.bulk_job;
BEGIN
  SELECT * INTO j FROM tenant_data.bulk_job b
   WHERE b.tenant_id = NEW.tenant_id AND b.bulk_job_id = NEW.bulk_job_id;
  IF j.status <> 'RUNNING' OR j.lease_until <= now()
     OR j.lease_owner IS DISTINCT FROM nullif(current_setting('app.bulk_lease_owner', true), '') THEN
    RAISE EXCEPTION 'the file of bulk job % is written only by the process that holds its live lease while it runs (Р-145)',
      NEW.bulk_job_id USING ERRCODE = 'lock_not_available';
  END IF;
  IF j.kind NOT IN (SELECT k FROM security.file_producing_job_kinds() AS k) THEN
    RAISE EXCEPTION 'a bulk job of kind % does not give the seller a file: see security.file_producing_job_kinds (Р-145)',
      j.kind USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER b_bulk_job_artifact_own_job BEFORE INSERT OR UPDATE ON tenant_data.bulk_job_artifact
  FOR EACH ROW EXECUTE FUNCTION tenant_data.bulk_job_artifact_own_job();
ALTER FUNCTION tenant_data.bulk_job_artifact_own_job() OWNER TO repracer_owner;

/**
 * Задача D шага 32 [Р-143]: ЧУЖОЕ задание отменяет тот, у кого есть право на его ВИД операции. До шага 32 право было одно
 * на все виды — «менять цены», — и держалось оно только консолью: `cancelBulkJob` роль не проверяла вовсе.
 *
 * Своё задание отменяет любой участник: он сам его и создал.
 */
CREATE FUNCTION security.bulk_job_cancel_action(p_kind text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
  -- Экран различий и предпросмотр ничего не меняют САМИ, но применение на них ссылается: отменить чужой значит сорвать
  -- чужую правку каталога. Выгрузка не начинает собой ничего — её отмена стоит просмотра.
  SELECT CASE WHEN p_kind IN ('PRICE_EVIDENCE', 'PRICE_FEED_EXPORT') THEN 'VIEW_PRICING' ELSE 'MANAGE_PRICING' END
$fn$;
ALTER FUNCTION security.bulk_job_cancel_action(text) OWNER TO repracer_owner;
GRANT EXECUTE ON FUNCTION security.bulk_job_cancel_action(text) TO repracer_app, repracer_admin;

CREATE FUNCTION tenant_data.bulk_job_cancel_requires_right() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
DECLARE
  member_role text;
  member_id uuid;
BEGIN
  IF NEW.status <> 'CANCELLED' OR OLD.status = 'CANCELLED' OR NOT security.admin_session() THEN RETURN NULL; END IF;
  SELECT m.membership_id, m.role INTO member_id, member_role FROM tenant_data.membership m
   WHERE m.tenant_id = NEW.tenant_id AND m.user_id = security.current_user_id() AND m.status = 'ACTIVE';
  IF member_id IS NOT DISTINCT FROM OLD.created_by_membership_id THEN RETURN NULL; END IF;
  IF member_role IS NULL OR NOT security.pricing_permission(member_role, security.bulk_job_cancel_action(OLD.kind)) THEN
    RAISE EXCEPTION 'cancelling a bulk job of kind % belonging to another member needs the right to that operation; the role % does not have it (Р-143)',
      OLD.kind, coalesce(member_role, 'none') USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NULL;
END $fn$;
CREATE TRIGGER ze_bulk_job_cancel_requires_right AFTER UPDATE ON tenant_data.bulk_job
  FOR EACH ROW EXECUTE FUNCTION tenant_data.bulk_job_cancel_requires_right();
ALTER FUNCTION tenant_data.bulk_job_cancel_requires_right() OWNER TO repracer_owner;

RESET ROLE;

SET ROLE repracer_owner;

/**
 * Р-104: защита-дубль удаляется, а не остаётся исключением. Проверка формата `sha256 ~ '^[0-9a-f]{64}$'` теперь недостижима:
 * страж выше требует не «похоже на сумму», а «ЭТА сумма этого содержимого», и любое значение неверного вида он отклоняет
 * первым. Проверка, которую нельзя провалить своей причиной, не существует [Р-99].
 */
ALTER TABLE tenant_data.bulk_job_artifact DROP CONSTRAINT bulk_job_artifact_sha256_check;

RESET ROLE;

COMMIT;
