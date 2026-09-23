-- 0124_guest_demo_access_tenant_locale.sql: гостевой вход в демо, язык тенанта, сухой режим доставки (шаг 37) [Р-160, Р-161].
--
-- Три несвязанные вещи в одной миграции, потому что каждая — один столбец и её стражи:
--
-- 1. Р-160 (ГОСТЬ). Публичное демо: кнопка «посмотреть демо» даёт вход БЕЗ регистрации. Это исключение из Р-98 («привязка
--    входа — только приёмом приглашения»), и потому оно закреплено не словом, а стражами: гостевое членство существует
--    только в ДЕМО-тенанте, всегда с ролью наблюдателя, перестать быть гостевым не может и не создаёт НИ ОДНОГО задания —
--    даже «ничего не меняющего». Последнее — не теория: выгрузку доказательной истории и ленту цен [Р-143] создаёт любой,
--    у кого есть VIEW_PRICING, а это 300 000 строк и 27 МБ файла (шаг 30). Гость с такой кнопкой — это способ занять
--    исполнителя заданий на сутки, ничего не «сломав» в интерфейсе.
--
-- 2. Р-161 (ЯЗЫК ТЕНАНТА). Письма о событиях [Р-156] уходили всегда по-немецки: словарь DE/EN есть с шага 12, а языка
--    тенанта в базе не было, и доставка брать его было неоткуда (отложенная находка 2 ревью шага 36).
--
-- 3. Сухой режим доставки (OQ-224). Провайдера почты у проекта нет. Молча копить недоставленные события — неправда:
--    у отметки доставки появился третий вид, DRY_RUN, который говорит прямо — письмо СОБРАНО и выброшено.

BEGIN;

SET ROLE repracer_owner;

-- ---------------------------------------------------------------- 1. Язык тенанта [Р-161]
ALTER TABLE tenant_data.tenant
  ADD COLUMN locale text NOT NULL DEFAULT 'de';
COMMENT ON COLUMN tenant_data.tenant.locale IS
  'Шаг 37 [Р-161, Р-72]: язык писем и текстов тенанта. Значение из того же списка, что у словаря консоли; экран берёт язык браузера, письмо — отсюда: у письма браузера нет.';
-- Список языков — тот же, что у словаря консоли (packages/console-model/src/i18n): язык, которого нет в словаре, дал бы письмо из кодов
ALTER TABLE tenant_data.tenant
  ADD CONSTRAINT tenant_locale_known CHECK (locale IN ('de', 'en'));
-- Язык меняет администратор тенанта: действие уже названо MANAGE_TENANT в security.admin_write_action
GRANT UPDATE (locale) ON tenant_data.tenant TO repracer_admin;

-- ---------------------------------------------------------------- 2. Гостевое членство [Р-160]
ALTER TABLE tenant_data.membership
  ADD COLUMN guest boolean NOT NULL DEFAULT false;
-- Право на столбец — тому единственному, кто вставляет членства [Р-100]: без него функция гостя падает «нет права»
GRANT INSERT (guest) ON tenant_data.membership TO repracer_resolver;
COMMENT ON COLUMN tenant_data.membership.guest IS
  'Шаг 37 [Р-160]: членство публичного гостя демо. Заводится без приглашения (исключение из Р-98), поэтому ограничено стражами: только демо-тенант, только роль VIEWER, гостем остаётся навсегда, заданий не создаёт.';

-- Гость — наблюдатель и только. Ограничения «guest ⇒ VIEWER» здесь НЕТ намеренно [Р-104, прецедент OQ-211]: членство
-- создаёт единственный писатель (`security.create_demo_guest`, вставку членства пускает только repracer_resolver), роль в
-- нём — литерал, а повышение потом отклоняет страж ниже. Провалить такое ограничение нечем, а ветка, которую нечем
-- провалить, — тавтология. Вместо него смоук УТВЕРЖДАЕТ роль созданного гостя.

/**
 * Гостевое членство живёт только в ДЕМО-тенанте. Проверить это ограничением нельзя — признак демо лежит в другой таблице,
 * поэтому страж. Без него один вызов функции гостя с чужим идентификатором тенанта открыл бы каталог настоящего продавца
 * любому, кто нажал «посмотреть демо».
 */
CREATE FUNCTION tenant_data.membership_guest_demo_only() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  IF NEW.guest AND NOT EXISTS (SELECT 1 FROM tenant_data.tenant t WHERE t.tenant_id = NEW.tenant_id AND t.demo) THEN
    RAISE EXCEPTION 'a guest membership exists only in a demo tenant (Р-160)' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $fn$;
-- Страж исполняется той же ролью, что вставляет членство (repracer_resolver), и ему нужен ровно один вопрос к таблице
-- тенантов: демо ли это. Право дано по столбцам [Р-100] — ни имени, ни состояния, ни региона он не видит
GRANT SELECT (tenant_id, demo) ON tenant_data.tenant TO repracer_resolver;
CREATE TRIGGER b_membership_guest_demo_only BEFORE INSERT OR UPDATE OF guest, tenant_id ON tenant_data.membership
  FOR EACH ROW EXECUTE FUNCTION tenant_data.membership_guest_demo_only();

/**
 * Гость остаётся гостем. Повышение роли гостя и снятие признака — это ровно тот путь, которым публичный вход превращается
 * в доступ продавца: членство уже создано, приглашения не нужно, достаточно UPDATE. Отзыв членства (status) страж не
 * трогает: закрыть гостя надо уметь.
 */
CREATE FUNCTION tenant_data.membership_guest_stays_guest() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  -- Проверяется только СМЕНА РОЛИ: снять сам признак нечем — `guest` нет в списке изменяемых столбцов
  -- (`security.restrict_update` на этой таблице), и такая правка отказывает раньше и по своей причине [Р-99]
  IF OLD.guest AND NEW.role <> OLD.role THEN
    RAISE EXCEPTION 'a guest membership is never promoted: it stays a guest with the VIEWER role (Р-160)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER b_membership_guest_stays_guest BEFORE UPDATE OF role ON tenant_data.membership
  FOR EACH ROW EXECUTE FUNCTION tenant_data.membership_guest_stays_guest();

/**
 * Гость не создаёт заданий — никаких. Право на вид задания [Р-143] у наблюдателя есть: выгрузка доказательной истории и
 * лента цен требуют VIEW_PRICING, потому что ничего не меняют. Но «ничего не меняет» не значит «ничего не стоит»: в замере
 * шага 30 доказательство — 300 000 строк и 27 МБ, и исполнитель занят этим десятки секунд. Публичная кнопка, запускающая
 * такое, — это способ занять демо целиком, и держать это должен не интерфейс.
 */
CREATE FUNCTION tenant_data.bulk_job_no_guest() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  IF EXISTS (SELECT 1 FROM tenant_data.membership m
              WHERE m.tenant_id = NEW.tenant_id AND m.membership_id = NEW.created_by_membership_id AND m.guest) THEN
    RAISE EXCEPTION 'a guest creates no bulk job, not even a read-only one (Р-160)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER zz_bulk_job_no_guest BEFORE INSERT ON tenant_data.bulk_job
  FOR EACH ROW EXECUTE FUNCTION tenant_data.bulk_job_no_guest();

RESET ROLE;

/**
 * Единственный путь, которым гость появляется. Членство создаёт только `repracer_resolver` (страж шага 19), поэтому
 * функция — SECURITY DEFINER и ПРИНАДЛЕЖИТ ему, как приглашение и заведение тенанта (определяется вне SET ROLE, как в
 * 0058, 0066 и 0115). Она НЕ повторяет проверок стражей (демо-тенант, отсутствие заданий) — их делает база [Р-104].
 *
 * Гость — настоящий пользователь платформы с настоящей привязкой (issuer, subject): иначе вход пришлось бы подделывать
 * мимо `security.resolve_external_identity`, и путь гостя перестал бы быть тем же путём, каким ходит продавец. Сам
 * пользователь и привязка живут у ПЛАТФОРМЕННОГО тенанта (так устроены `platform.app_user` и `platform.external_identity`
 * с шага 2), у демо-тенанта — только членство.
 */
CREATE FUNCTION security.create_demo_guest(p_tenant_id uuid, p_issuer text, p_subject text, p_email text)
  RETURNS TABLE (user_id uuid, membership_id uuid)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
DECLARE
  v_user uuid := gen_random_uuid();
  v_membership uuid := gen_random_uuid();
BEGIN
  -- Столбцы — ровно те, на которые у repracer_resolver есть право [Р-100]: статус ставит умолчание таблицы
  INSERT INTO platform.app_user (user_id, email, display_name)
  VALUES (v_user, lower(p_email), 'Demo-Gast');
  INSERT INTO platform.external_identity (issuer, subject, user_id)
  VALUES (p_issuer, p_subject, v_user);
  INSERT INTO tenant_data.membership (tenant_id, membership_id, user_id, role, status, guest)
  VALUES (p_tenant_id, v_membership, v_user, 'VIEWER', 'ACTIVE', true);
  RETURN QUERY SELECT v_user, v_membership;
END $fn$;
ALTER FUNCTION security.create_demo_guest(uuid, text, text, text) OWNER TO repracer_resolver;
REVOKE EXECUTE ON FUNCTION security.create_demo_guest(uuid, text, text, text) FROM PUBLIC;
-- Заводит гостей тот же, кто заводит приглашения на регистрацию, — роль онбординга
GRANT EXECUTE ON FUNCTION security.create_demo_guest(uuid, text, text, text) TO repracer_onboarding;

SET ROLE repracer_owner;

-- ---------------------------------------------------------------- 3. Сухой режим доставки (OQ-224)
/**
 * Третий вид отметки: письмо СОБРАНО и выброшено, потому что провайдер не настроен. Он не «доставлено» и не
 * «недоставлено»: запросом видно, что событие разобрано, письмо составлено, и никто его не получил.
 */
ALTER TABLE tenant_data.alert DROP CONSTRAINT alert_delivery_kind_known;
ALTER TABLE tenant_data.alert
  ADD CONSTRAINT alert_delivery_kind_known CHECK (delivery_kind = ANY (ARRAY['EMAIL_IMMEDIATE', 'EMAIL_DIGEST', 'DRY_RUN']));

RESET ROLE;

COMMIT;
