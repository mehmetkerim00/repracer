-- 0126_operator_panel.sql: панель оператора платформы (шаг 40) [Р-165…Р-168].
--
-- До этого шага оператор платформы существовал ровно настолько, чтобы подписать разбор пропуска выгрузки (0095):
-- учётная запись есть, интерфейса нет, а его действия не попадают в аудит (OQ-191). Пилоты завести тоже нечем —
-- тенанта создаёт миграция или суперпользователь руками (OQ-213).
--
-- Здесь появляется ВСЁ, что панель умеет, и ровно оно:
--
--   ЧТЕНИЕ (Р-168) — СЕМЬ функций, каждая отдаёт ОПЕРАЦИОННОЕ состояние: работы планировщика, алерты и их доставку,
--   очередь диспетчера, приёмник уведомлений, список тенантов, пропуски снимков и журнал действий операторов. Ни цен,
--   ни себестоимости, ни границ в них нет — это данные продавца, и оператору они не нужны (Р-97: меньше поверхность —
--   меньше катастрофа).
--
--   ДЕЙСТВИЯ (Р-166) — ровно четыре: создать тенанта, пригласить владельца, пометить пропуск разобранным, отметить
--   алерт увиденным. Каждое требует ДЕЙСТВУЮЩЕЙ учётной записи оператора, ВТОРОГО ФАКТОРА и пишет `audit_event`
--   (OQ-191 закрывается здесь).
--
-- Права роли панели — только EXECUTE на эти функции. Ни одной таблицы она не видит: то, чего нет в списке, недоступно
-- не по забывчивости, а потому что доступа нет вовсе.

BEGIN;

SET ROLE repracer_owner;

-- ---------------------------------------------------------------- отметка «алерт увиден» [Р-166]
ALTER TABLE tenant_data.alert
  ADD COLUMN acknowledged_at timestamptz,
  ADD COLUMN acknowledged_by uuid;
COMMENT ON COLUMN tenant_data.alert.acknowledged_at IS
  'Шаг 40 [Р-166]: оператор платформы увидел событие. Это НЕ доставка владельцу [Р-156] и не решение проблемы — только «мы знаем».';
COMMENT ON COLUMN tenant_data.alert.acknowledged_by IS
  'Шаг 40 [Р-166]: УЧЁТНАЯ ЗАПИСЬ оператора, который отметил событие. Не текст и не имя: «увидено» без автора — слово.';
/**
 * Ограничения «время и автор появляются вместе» здесь НЕТ намеренно [Р-104, прецедент OQ-211]: оба столбца ставит
 * единственный писатель — `security.operator_acknowledge_alert` — одним присваиванием, а право UPDATE на них есть
 * только у владельца функций панели (ниже). Провалить такое ограничение нечем, а ветка, которую нечем провалить, —
 * тавтология [Р-94]. Вместо него смоук утверждает, что отметка называет оператора.
 */

/**
 * Страж доставленного события (0120, находка 5 ревью шага 36) говорил: доставленная строка не меняется ВООБЩЕ. Отметка
 * «оператор увидел» в него упиралась — доставленный алерт отметить было нечем, а отмечать нужно именно такие: письмо
 * ушло владельцу, а знает ли о событии платформа — отдельный вопрос.
 *
 * Правило сужено, а не снято: у ДОСТАВЛЕННОЙ строки могут измениться ровно два столбца отметки и НИ ОДИН другой.
 * Сравниваются не перечисленные поля, а строка целиком за вычетом этих двух: столбец, добавленный завтра, попадает под
 * запрет сам, без правки стража. Доказательство отправки по-прежнему переставить нечем.
 */
CREATE OR REPLACE FUNCTION tenant_data.alert_before_write() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Время события ставит база: процесс со сбитыми часами не двигает очередь доставки
    NEW.raised_at := now();
    IF NEW.delivered_at IS NOT NULL THEN
      RAISE EXCEPTION 'an alert cannot be raised as already delivered (Р-156)' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.delivered_at IS NOT NULL THEN
    IF to_jsonb(NEW) - 'acknowledged_at' - 'acknowledged_by' IS DISTINCT FROM to_jsonb(OLD) - 'acknowledged_at' - 'acknowledged_by' THEN
      RAISE EXCEPTION 'delivery of alert % is already recorded (Р-156)', OLD.alert_id USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.delivered_at IS NOT NULL THEN NEW.delivered_at := now(); END IF;
  RETURN NEW;
END $$;

RESET ROLE;

-- ---------------------------------------------------------------- роль панели
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'repracer_operator') THEN
    CREATE ROLE repracer_operator NOLOGIN NOBYPASSRLS;
  END IF;
  /**
   * Отдельный ВЛАДЕЛЕЦ функций панели. Сделать их SECURITY DEFINER от владельца схемы было бы проще и означало бы,
   * что четыре действия оператора исполняются с правами на всё [Р-90]. У этой роли прав ровно столько, сколько
   * нужно четырём действиям и шести чтениям, — и снятие любого из них ловится своей проверкой [Р-99].
   */
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'repracer_operator_actions') THEN
    CREATE ROLE repracer_operator_actions NOLOGIN NOBYPASSRLS;
  END IF;
END $$;
COMMENT ON ROLE repracer_operator IS 'Шаг 40 [Р-165]: роль панели оператора платформы — только EXECUTE на функции панели, ни одной таблицы';
COMMENT ON ROLE repracer_operator_actions IS 'Шаг 40 [Р-165]: владелец функций панели — права ровно на то, что делают четыре действия и шесть чтений';

SET ROLE repracer_owner;
GRANT USAGE ON SCHEMA security, platform, tenant_data, channel_data, maintenance, audit TO repracer_operator, repracer_operator_actions;

-- Права ВЛАДЕЛЬЦА функций панели: ровно то, что делают четыре действия и шесть чтений, и ничего сверх
-- Привязка входа: панели нужен ОДИН факт — есть ли у владельца пилота вход [находка 7 ревью шага 40]. Право по столбцам
-- [Р-100]: ни издателя, ни субъекта, ни времени привязки она не видит
GRANT SELECT (user_id) ON platform.external_identity TO repracer_operator_actions;
GRANT SELECT ON platform.platform_operator, platform.app_user, tenant_data.tenant, tenant_data.membership,
                tenant_data.alert, tenant_data.channel_account, tenant_data.offer_mapping, tenant_data.write_scope,
                tenant_data.channel_write, tenant_data.price_stop, channel_data.pricing_halt, channel_data.channel_distrust,
                channel_data.inbound_notification, maintenance.scheduled_job, maintenance.snapshot_export_skip,
                maintenance.snapshot_export_skip_resolution, maintenance.snapshot_export_skip_verification
  TO repracer_operator_actions;
/**
 * Отметка «алерт увиден» — ДВА столбца и только они [Р-100]: код события и его доставку панель переписать не может.
 * Строки каталога мутаций у этого права НЕТ намеренно [Р-104, находка 4г ревью шага 40]: расширьте его до всей таблицы —
 * и ничего не изменится, потому что ЕДИНСТВЕННЫЙ писатель (`security.operator_acknowledge_alert`) присваивает ровно эти
 * два столбца, а провалить право нечем: роль-владелец функций не логинится, и запроса «от её имени» в смоуке быть не
 * может. У доставленной строки то же свойство держит страж, и он проверяется своей строкой каталога.
 */
GRANT UPDATE (acknowledged_at, acknowledged_by) ON tenant_data.alert TO repracer_operator_actions;
-- Язык тенанта пилота [Р-161, Р-167]: продавец читает приглашение на своём языке, и назвать его может только тот, кто
-- заводит пилота. Право — на ОДИН столбец: имени, состояния и региона панель не меняет
GRANT UPDATE (locale) ON tenant_data.tenant TO repracer_operator_actions;
GRANT INSERT ON maintenance.snapshot_export_skip_resolution TO repracer_operator_actions;
-- Политики строк: роль видит ВСЕ тенанты — это её работа (операционный обзор), но только перечисленными столбцами
CREATE POLICY operator_actions_read ON tenant_data.tenant FOR SELECT TO repracer_operator_actions USING (true);
-- Язык тенанта пилота: право UPDATE по столбцу без политики строк молча правит НОЛЬ строк (RLS FORCE), и пилот
-- оставался бы немецким — политика нужна вместе с правом [находка 6 ревью шага 40]
CREATE POLICY operator_actions_tenant_locale ON tenant_data.tenant FOR UPDATE TO repracer_operator_actions USING (true) WITH CHECK (true);
CREATE POLICY operator_actions_read ON tenant_data.membership FOR SELECT TO repracer_operator_actions USING (true);
CREATE POLICY operator_actions_read ON tenant_data.channel_account FOR SELECT TO repracer_operator_actions USING (true);
CREATE POLICY operator_actions_read ON tenant_data.offer_mapping FOR SELECT TO repracer_operator_actions USING (true);
CREATE POLICY operator_actions_read ON tenant_data.write_scope FOR SELECT TO repracer_operator_actions USING (true);
CREATE POLICY operator_actions_read ON tenant_data.channel_write FOR SELECT TO repracer_operator_actions USING (true);
CREATE POLICY operator_actions_read ON tenant_data.price_stop FOR SELECT TO repracer_operator_actions USING (true);
CREATE POLICY operator_actions_read ON channel_data.pricing_halt FOR SELECT TO repracer_operator_actions USING (true);
CREATE POLICY operator_actions_read ON channel_data.channel_distrust FOR SELECT TO repracer_operator_actions USING (true);
CREATE POLICY operator_actions_read ON channel_data.inbound_notification FOR SELECT TO repracer_operator_actions USING (true);
CREATE POLICY operator_actions_read ON maintenance.scheduled_job FOR SELECT TO repracer_operator_actions USING (true);
CREATE POLICY operator_actions_read ON maintenance.snapshot_export_skip FOR SELECT TO repracer_operator_actions USING (true);
CREATE POLICY operator_actions_skip_resolution ON maintenance.snapshot_export_skip_resolution TO repracer_operator_actions USING (true) WITH CHECK (true);
CREATE POLICY operator_actions_read ON maintenance.snapshot_export_skip_verification FOR SELECT TO repracer_operator_actions USING (true);
CREATE POLICY operator_actions_read ON platform.platform_operator FOR SELECT TO repracer_operator_actions USING (true);
CREATE POLICY operator_actions_read ON platform.app_user FOR SELECT TO repracer_operator_actions USING (true);
CREATE POLICY operator_actions_read ON platform.external_identity FOR SELECT TO repracer_operator_actions USING (true);
-- Алерт: читает и ставит ТОЛЬКО отметку «увиден»; проверка на запись — та же строка, что читается
CREATE POLICY operator_actions_alert ON tenant_data.alert TO repracer_operator_actions USING (true) WITH CHECK (true);
/**
 * Журнал: панель видит ТОЛЬКО действия операторов (`SUPPORT_STAFF`) — свои. Аудит продавца ей не принадлежит и не
 * показывается: «кто из сотрудников что сделал» — операционный вопрос, «что сделал продавец» — его дело.
 */
GRANT SELECT ON audit.audit_event TO repracer_operator_actions;
CREATE POLICY operator_actions_audit ON audit.audit_event FOR SELECT TO repracer_operator_actions USING (actor_type = 'SUPPORT_STAFF');
RESET ROLE;

-- Эти две функции принадлежат repracer_resolver (0053, 0115): право на них выдаётся вне SET ROLE, как в 0058 и 0124
GRANT EXECUTE ON FUNCTION security.provision_tenant(uuid, text, text, jsonb, boolean) TO repracer_operator_actions;
GRANT EXECUTE ON FUNCTION security.issue_signup_invitation(text, bytea, interval) TO repracer_operator_actions;

/**
 * Вход оператора: (издатель, субъект) токена → действующая учётная запись. Панель НЕ решает, кто оператор: решает
 * база, и неактивная запись не отличается от несуществующей.
 */
SET ROLE repracer_owner;

CREATE FUNCTION security.resolve_platform_operator(p_issuer text, p_subject text)
  RETURNS TABLE (operator_id uuid, display_name text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $fn$
  SELECT o.operator_id, o.display_name
    FROM platform.platform_operator o
   WHERE o.issuer = p_issuer AND o.subject = p_subject AND o.active
$fn$;

/**
 * Общий страж действий панели: действующая учётная запись И второй фактор в сессии. Второй фактор здесь обязателен
 * ВСЕГДА (Р-165), в отличие от продавца, у которого он нужен только части операций [Р-143]: у оператора нет рутинных
 * действий — все четыре меняют чужие данные или закрывают чужое событие.
 */
/**
 * Второй фактор ПАНЕЛИ — свой предикат. `security.session_mfa()` принимает заявление о втором факторе только у
 * административного сервиса [Р-90]: каждая роль отвечает за себя, и панель не может заявить фактор за продавца,
 * ровно как административный сервис не заявляет его за оператора.
 */
-- SECURITY DEFINER здесь ничего не расширяет: `session_user` не меняется от смены исполняющей роли, а правило 14f
-- требует, чтобы функция служебной роли исполнялась её правами (иначе `CREATE OR REPLACE` тихо меняет смысл)
CREATE FUNCTION security.operator_acting(p_operator_id uuid) RETURNS text
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $fn$
DECLARE
  name text;
BEGIN
  SELECT o.display_name INTO name FROM platform.platform_operator o WHERE o.operator_id = p_operator_id AND o.active;
  IF name IS NULL THEN
    RAISE EXCEPTION 'operator % is not an active platform operator (Р-165)', p_operator_id USING ERRCODE = 'insufficient_privilege';
  END IF;
  /**
   * Второй фактор ОБЪЯВЛЯЕТ процесс панели, и принять его утверждение может только он: PUBLIC у функций панели отозван,
   * а эту функцию зовут лишь четыре действия — она принадлежит `repracer_operator_actions`, и больше её не видит никто
   * (находка 8 ревью шага 40: прежний комментарий называл здесь не ту роль). Проверки «а та ли это роль» НЕТ намеренно
   * [Р-104, прецедент OQ-211]: её нечем провалить — тот, у кого нет права, до этой строки не доходит, а ветка,
   * которую нечем провалить, — тавтология [Р-94]. У `security.session_mfa()` (0058) такая проверка есть, и там она
   * falsifiable: ту функцию может звать кто угодно, включая путь решения.
   */
  IF coalesce(current_setting('app.auth_mfa', true), '') <> 'on' THEN
    RAISE EXCEPTION 'an action of the operator panel needs a second factor (Р-165)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN name;
END $fn$;

/**
 * Запись действия оператора в аудит [OQ-191]: актор — SUPPORT_STAFF, его идентификатор — учётная запись оператора.
 * Функция принадлежит РОЛИ АУДИТА: прямой вставки в журнал нет ни у кого, кроме неё (правило схемы, Р-90), и роль
 * действий панели получает только право позвать эту функцию — то есть записать событие, но не переписать журнал.
 */
CREATE FUNCTION security.operator_audit(p_operator_id uuid, p_tenant_id uuid, p_action text, p_entity_type text, p_entity_id uuid, p_changes jsonb)
  RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
  INSERT INTO audit.audit_event (tenant_id, occurred_at, actor_type, actor_user_id, action, entity_type, entity_id, changes)
  VALUES (p_tenant_id, now(), 'SUPPORT_STAFF', p_operator_id, p_action, p_entity_type, p_entity_id, p_changes);
$fn$;

-- ---------------------------------------------------------------- ЧТЕНИЕ [Р-168]
/**
 * Работы планировщика с отставанием. Отдаётся то, по чему оператор судит о живости фона: когда работа шла последний
 * раз, чем кончилась, сколько провалов подряд и какой уровень отставания поставила база (0094).
 */
CREATE FUNCTION platform.operator_jobs()
  RETURNS TABLE (job_key text, job_name text, next_due_at timestamptz, last_started_at timestamptz, last_finished_at timestamptz,
                 last_outcome text, last_error text, consecutive_failures int, lag_level text, runs_completed bigint, lease_owner text,
                 lease_until timestamptz, overdue_seconds bigint)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $fn$
  SELECT j.job_key, j.job_name, j.next_due_at, j.last_started_at, j.last_finished_at,
         j.last_outcome, j.last_error, j.consecutive_failures, j.lag_level, j.runs_completed, j.lease_owner, j.lease_until,
         /**
          * Сколько работа ПРОСРОЧЕНА прямо сейчас. Уровень отставания `lag_level` ставит сам планировщик (0094), и у
          * ОСТАНОВЛЕННОГО планировщика он остаётся тем, каким был в последний такт: экран, показывающий только его,
          * говорил бы «всё в порядке» ровно в том случае, ради которого панель и нужна. Это число считается по часам
          * базы при каждом запросе и растёт, пока процесс не работает.
          */
         greatest(0, floor(extract(epoch FROM now() - j.next_due_at)))::bigint
    FROM maintenance.scheduled_job j
   ORDER BY greatest(0, floor(extract(epoch FROM now() - j.next_due_at))) DESC, (j.lag_level <> 'OK') DESC, j.consecutive_failures DESC
$fn$;

/**
 * Алерты и СОСТОЯНИЕ ИХ ДОСТАВКИ [Р-156]: оператору важно не только «что случилось», но и «дошло ли до владельца».
 * Подробности события (`details`) не отдаются: там параметры бизнес-события тенанта, а оператору хватает кода.
 */
CREATE FUNCTION platform.operator_alerts(p_limit int DEFAULT 200)
  RETURNS TABLE (tenant_id uuid, tenant_name text, alert_id uuid, code text, severity text, raised_at timestamptz,
                 delivered_at timestamptz, delivery_kind text, delivery_attempts int, last_delivery_error text,
                 acknowledged_at timestamptz, acknowledged_by uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $fn$
  SELECT a.tenant_id, t.name, a.alert_id, a.code, a.severity, a.raised_at,
         a.delivered_at, a.delivery_kind, a.delivery_attempts, a.last_delivery_error, a.acknowledged_at, a.acknowledged_by
    FROM tenant_data.alert a
    JOIN tenant_data.tenant t ON t.tenant_id = a.tenant_id
   ORDER BY (a.acknowledged_at IS NULL) DESC, (a.severity = 'CRITICAL') DESC, a.raised_at DESC
   LIMIT greatest(1, least(p_limit, 1000))
$fn$;

/**
 * Очередь диспетчера: сколько записей ждёт, сколько в полёте и как давно лежит самая старая. Числа операционные —
 * ни цены, ни количества здесь нет, только вид поля и состояние.
 */
CREATE FUNCTION platform.operator_write_queue()
  RETURNS TABLE (tenant_id uuid, tenant_name text, channel text, field text, status text, writes bigint, oldest_created_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $fn$
  /**
   * Находка 5 ревью шага 40: `status IN ('PENDING','DISPATCHED','ACCEPTED')` не влечёт предикатов ЧАСТИЧНЫХ индексов
   * очереди (`channel_write_pending_due_idx` — только PENDING, `channel_write_in_flight_age_idx` — только DISPATCHED и
   * ACCEPTED), поэтому один запрос с тройкой статусов шёл полным проходом по записям ВСЕХ тенантов. Условия разделены на
   * две ветки ровно по этим предикатам: каждая берёт свой индекс, а объединение агрегируется поверх.
   */
  WITH queued AS (
    SELECT w.tenant_id, w.write_scope_id, w.field, w.status, w.created_at
      FROM tenant_data.channel_write w
     WHERE w.status = 'PENDING'
    UNION ALL
    SELECT w.tenant_id, w.write_scope_id, w.field, w.status, w.created_at
      FROM tenant_data.channel_write w
     WHERE w.status IN ('DISPATCHED', 'ACCEPTED')
  )
  SELECT q.tenant_id, t.name, ca.channel, q.field, q.status, count(*), min(q.created_at)
    FROM queued q
    JOIN tenant_data.tenant t ON t.tenant_id = q.tenant_id
    JOIN tenant_data.write_scope ws ON ws.tenant_id = q.tenant_id AND ws.write_scope_id = q.write_scope_id
    JOIN tenant_data.channel_account ca ON ca.tenant_id = ws.tenant_id AND ca.channel_account_id = ws.channel_account_id
   GROUP BY q.tenant_id, t.name, ca.channel, q.field, q.status
   ORDER BY min(q.created_at)
$fn$;

/**
 * Приёмник уведомлений: что пришло, по каналу и виду события.
 *
 * Столбца «разобрано» здесь НЕТ (шаг 41, задача E): `channel_data.inbound_notification` хранит РАЗОБРАННЫЕ уведомления —
 * `processed_at` у неё NOT NULL с умолчанием. Счётчик «разобрано» был бы равен «получено» всегда, то есть тавтологией
 * на экране [Р-94]; потерянное уведомление видно не здесь, а сверкой опросом [Р-121].
 */
CREATE FUNCTION platform.operator_notifications(p_since interval DEFAULT interval '24 hours')
  RETURNS TABLE (channel text, notification_type text, received bigint, last_received_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $fn$
  SELECT n.channel, n.notification_type, count(*), max(n.received_at)
    FROM channel_data.inbound_notification n
   -- Окно ограничено с ДВУХ сторон (находка 18 ревью шага 40): `interval '100 years'` давал полный проход по приёмнику
   WHERE n.received_at >= now() - least(greatest(p_since, interval '1 hour'), interval '30 days')
   GROUP BY n.channel, n.notification_type
   ORDER BY max(n.received_at) DESC
$fn$;

/**
 * Список тенантов: состояние, каналы, остановки и ОБЪЁМЫ. Объём — число предложений и включённых единиц записи;
 * себестоимости, границ и цен здесь нет и быть не может (задача D шага 40): это данные продавца.
 */
CREATE FUNCTION platform.operator_tenants()
  RETURNS TABLE (tenant_id uuid, name text, status text, data_region text, demo boolean, locale text, created_at timestamptz,
                 members bigint, channels bigint, awaiting_access bigint, offers bigint, repricing_on bigint,
                 active_stops bigint, active_halts bigint, active_distrust bigint, alerts_undelivered bigint)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $fn$
  SELECT t.tenant_id, t.name, t.status, t.data_region, t.demo, t.locale, t.created_at,
         (SELECT count(*) FROM tenant_data.membership m WHERE m.tenant_id = t.tenant_id AND m.status = 'ACTIVE' AND NOT m.guest),
         (SELECT count(*) FROM tenant_data.channel_account ca WHERE ca.tenant_id = t.tenant_id AND ca.auth_status <> 'DISCONNECTED'),
         (SELECT count(*) FROM tenant_data.channel_account ca WHERE ca.tenant_id = t.tenant_id AND ca.auth_status = 'AWAITING_ACCESS'),
         (SELECT count(*) FROM tenant_data.offer_mapping om WHERE om.tenant_id = t.tenant_id),
         (SELECT count(*) FROM tenant_data.write_scope ws WHERE ws.tenant_id = t.tenant_id AND ws.pricing_mode = 'ENGINE'),
         (SELECT count(*) FROM tenant_data.price_stop s WHERE s.tenant_id = t.tenant_id AND s.released_at IS NULL),
         (SELECT count(*) FROM channel_data.pricing_halt h WHERE h.tenant_id = t.tenant_id AND h.released_at IS NULL),
         (SELECT count(*) FROM channel_data.channel_distrust d WHERE d.tenant_id = t.tenant_id AND d.released_at IS NULL),
         (SELECT count(*) FROM tenant_data.alert a WHERE a.tenant_id = t.tenant_id AND a.delivered_at IS NULL)
    FROM tenant_data.tenant t
   WHERE t.kind = 'CUSTOMER'
   ORDER BY t.created_at DESC
$fn$;

/**
 * Пропуски снимков и их разбор [OQ-181, OQ-182]: видно и то, что пропущено, и то, подтверждена ли выгрузка сверкой с
 * ClickHouse. Слово оператора не заменяет проверку — поэтому подтверждение показывается отдельным полем.
 */
CREATE FUNCTION platform.operator_snapshot_skips(p_limit int DEFAULT 200)
  RETURNS TABLE (competitor_snapshot_id uuid, subject_tenant_id uuid, tenant_name text, partition_name text, reason text,
                 received_at timestamptz, recorded_at timestamptz, resolution text, resolved_at timestamptz, note text,
                 verified_rows int, verified_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $fn$
  SELECT s.competitor_snapshot_id, s.subject_tenant_id, t.name, s.partition_name, s.reason, s.received_at, s.recorded_at,
         r.resolution, r.resolved_at, r.note, v.rows_in_clickhouse, v.verified_at
    FROM maintenance.snapshot_export_skip s
    LEFT JOIN tenant_data.tenant t ON t.tenant_id = s.subject_tenant_id
    LEFT JOIN maintenance.snapshot_export_skip_resolution r ON r.competitor_snapshot_id = s.competitor_snapshot_id
    LEFT JOIN maintenance.snapshot_export_skip_verification v ON v.competitor_snapshot_id = s.competitor_snapshot_id
   ORDER BY (r.resolution IS NULL) DESC, s.recorded_at DESC
   LIMIT greatest(1, least(p_limit, 1000))
$fn$;

/**
 * Журнал действий операторов [OQ-191]: панель показывает, кто из операторов что сделал и когда.
 *
 * Условия `actor_type = 'SUPPORT_STAFF'` здесь НЕТ намеренно [Р-104]: границу держит ПОЛИТИКА СТРОК
 * `operator_actions_audit`, и пока это условие стояло ещё и в теле функции, снятие политики не краснело нигде —
 * полный прогон CI шага 40 показал это прямо (мутация «политика на USING (true)» осталась непойманной). Дубль удалён,
 * у политики своя строка каталога и своя проверка смоука.
 */
CREATE FUNCTION platform.operator_actions_log(p_action text DEFAULT NULL, p_limit int DEFAULT 200)
  RETURNS TABLE (occurred_at timestamptz, action text, tenant_id uuid, entity_type text, entity_id uuid, operator_id uuid, changes jsonb)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $fn$
  SELECT a.occurred_at, a.action, a.tenant_id, a.entity_type, a.entity_id, a.actor_user_id, a.changes
    FROM audit.audit_event a
   WHERE p_action IS NULL OR a.action = p_action
   ORDER BY a.occurred_at DESC
   LIMIT greatest(1, least(p_limit, 1000))
$fn$;

-- ---------------------------------------------------------------- ДЕЙСТВИЯ [Р-166]: ровно четыре
/**
 * 1. Создать тенанта пилота [Р-167]. Это часть OQ-213: пилота заводит оператор, дальше продавец идёт своим
 * онбордингом [Р-149]. Тенант создаётся ВМЕСТЕ с владельцем — иначе его некому было бы пригласить.
 */
CREATE FUNCTION security.operator_create_tenant(p_operator_id uuid, p_tenant_id uuid, p_name text, p_data_region text,
                                                p_owner_user_id uuid, p_owner_email text, p_locale text DEFAULT 'de')
  RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
DECLARE
  who text := security.operator_acting(p_operator_id);
BEGIN
  PERFORM security.provision_tenant(p_tenant_id, p_name, p_data_region,
    jsonb_build_array(jsonb_build_object('userId', p_owner_user_id, 'email', p_owner_email, 'role', 'OWNER')), false);
  /**
   * Язык пилота [Р-161] задаётся ЗДЕСЬ, а не остаётся умолчанием таблицы (находка 6 ревью шага 40): до этого у каждого
   * пилота был немецкий, и письмо-приглашение уходило по-немецки даже англоязычному продавцу. Значение проверяет
   * ограничение `tenant_locale_known` (0124) — списка языков функция не повторяет [Р-104].
   */
  UPDATE tenant_data.tenant SET locale = p_locale WHERE tenant_id = p_tenant_id;
  PERFORM security.operator_audit(p_operator_id, p_tenant_id, 'operator.tenant_created', 'tenant_data.tenant', p_tenant_id,
    jsonb_build_object('name', p_name, 'region', p_data_region, 'locale', p_locale, 'operator', who));
  RETURN p_tenant_id;
END $fn$;

/**
 * 2. Пригласить владельца: приглашение на регистрацию входа [Р-78, Р-98]. Письмо шлёт панель тем же отправителем, что
 * доставка событий [Р-156]; база выдаёт только приглашение — токен она видит лишь отпечатком.
 */
CREATE FUNCTION security.operator_invite_owner(p_operator_id uuid, p_tenant_id uuid, p_email text, p_token_sha256 bytea, p_ttl interval)
  RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
DECLARE
  who text := security.operator_acting(p_operator_id);
  inv uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM tenant_data.membership m JOIN platform.app_user u ON u.user_id = m.user_id
                  WHERE m.tenant_id = p_tenant_id AND m.role = 'OWNER' AND u.email = lower(btrim(p_email))) THEN
    RAISE EXCEPTION 'the invited address is not the owner of tenant % (Р-166)', p_tenant_id USING ERRCODE = 'invalid_parameter_value';
  END IF;
  /**
   * Приглашение панели — ПЕРВЫЙ вход владельца пилота [Р-167] и только он. Находка 7 ревью шага 40: без этого условия
   * оператор выпускал действующее приглашение владельцу ЛЮБОГО тенанта, в том числе давно работающего. Перехватить
   * вошедшего владельца и так нельзя (Р-98 требует приглашения на перепривязку), но выдавать приглашение туда, где вход
   * уже привязан, панели незачем — а то, что незачем, она не умеет. Перепривязка остаётся делом владельца тенанта.
   */
  IF EXISTS (SELECT 1 FROM tenant_data.membership m
              JOIN platform.app_user u ON u.user_id = m.user_id
              JOIN platform.external_identity e ON e.user_id = m.user_id
             WHERE m.tenant_id = p_tenant_id AND m.role = 'OWNER' AND u.email = lower(btrim(p_email))) THEN
    RAISE EXCEPTION 'the owner of tenant % already has a linked sign-in: a relink needs an invitation of the tenant owner (Р-98)', p_tenant_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  inv := security.issue_signup_invitation(p_email, p_token_sha256, p_ttl);
  PERFORM security.operator_audit(p_operator_id, p_tenant_id, 'operator.owner_invited', 'platform.identity_invitation', inv,
    jsonb_build_object('operator', who));
  RETURN inv;
END $fn$;

/** 3. Пропуск снимков разобран с заметкой [OQ-181]: запись идёт в ту же таблицу разбора, что у роли разбора (0092) */
CREATE FUNCTION security.operator_resolve_snapshot_skip(p_operator_id uuid, p_snapshot_id uuid, p_resolution text, p_note text)
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
DECLARE
  who text := security.operator_acting(p_operator_id);
BEGIN
  -- Заметка человека — заметка, а не файл (находка 20 ревью шага 40): снизу её длину держит ограничение таблицы
  IF length(p_note) > 2000 THEN
    RAISE EXCEPTION 'the note of a snapshot resolution is at most 2000 characters' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  INSERT INTO maintenance.snapshot_export_skip_resolution (competitor_snapshot_id, resolution, resolved_by, note, operator_id, mfa)
  VALUES (p_snapshot_id, p_resolution, who, p_note, p_operator_id, true);
  PERFORM security.operator_audit(p_operator_id, security.platform_tenant_id(), 'operator.snapshot_skip_resolved',
    'maintenance.snapshot_export_skip', p_snapshot_id, jsonb_build_object('resolution', p_resolution, 'operator', who));
END $fn$;

/**
 * 4. Алерт увиден. Это НЕ доставка владельцу и не решение: отметка говорит «мы знаем», и второй раз её поставить
 * нельзя — иначе «увидено» перестаёт быть событием и становится счётчиком.
 */
CREATE FUNCTION security.operator_acknowledge_alert(p_operator_id uuid, p_tenant_id uuid, p_alert_id uuid)
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
DECLARE
  who text := security.operator_acting(p_operator_id);
  updated int;
BEGIN
  UPDATE tenant_data.alert SET acknowledged_at = now(), acknowledged_by = p_operator_id
   WHERE tenant_id = p_tenant_id AND alert_id = p_alert_id AND acknowledged_at IS NULL;
  GET DIAGNOSTICS updated = ROW_COUNT;
  IF updated = 0 THEN
    RAISE EXCEPTION 'alert % of tenant % is unknown or already acknowledged (Р-166)', p_alert_id, p_tenant_id USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  PERFORM security.operator_audit(p_operator_id, p_tenant_id, 'operator.alert_acknowledged', 'tenant_data.alert', p_alert_id,
    jsonb_build_object('operator', who));
END $fn$;

RESET ROLE;

/**
 * Владелец функций — узкая роль, а не владелец схемы: SECURITY DEFINER исполняется с ЕГО правами, и «оператор может
 * ровно четыре действия» держится этим. Смена владельца идёт вне SET ROLE (как в 0058, 0066, 0115, 0124).
 */
DO $$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'security.resolve_platform_operator(text, text)', 'security.operator_acting(uuid)',
    'platform.operator_jobs()', 'platform.operator_alerts(int)', 'platform.operator_write_queue()',
    'platform.operator_notifications(interval)', 'platform.operator_tenants()', 'platform.operator_snapshot_skips(int)',
    -- Журнал действий — тоже функция панели: у владельца схемы своей политики на `audit_event` нет, и оставшись за ним,
    -- она отдавала бы ПУСТО при записанном действии (FORCE RLS смотрит и на владельца таблицы)
    'platform.operator_actions_log(text, int)',
    'security.operator_create_tenant(uuid, uuid, text, text, uuid, text, text)',
    'security.operator_invite_owner(uuid, uuid, text, bytea, interval)',
    'security.operator_resolve_snapshot_skip(uuid, uuid, text, text)',
    'security.operator_acknowledge_alert(uuid, uuid, uuid)'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO repracer_operator_actions', f);
  END LOOP;
END $$;
ALTER FUNCTION security.operator_audit(uuid, uuid, text, text, uuid, jsonb) OWNER TO repracer_audit_writer;
GRANT EXECUTE ON FUNCTION security.operator_audit(uuid, uuid, text, text, uuid, jsonb) TO repracer_operator_actions;

-- ---------------------------------------------------------------- права панели: ТОЛЬКО эти функции
-- Права выдаются ВНЕ `SET ROLE`: владелец схемы этими функциями уже не владеет (выше сменён владелец), и его GRANT
-- прошёл бы предупреждением «no privileges were granted» — то есть молча ничем. Так и случилось в первой редакции
-- Роль разбора уже умеет писать разбор; роль панели пишет его через SECURITY DEFINER — своих прав на таблицы у неё нет
-- Право звать её есть только у панели: роль входа операторов не разбирает (находка 13 ревью шага 40 — лишнее право [Р-96])
GRANT EXECUTE ON FUNCTION security.resolve_platform_operator(text, text) TO repracer_operator;
GRANT EXECUTE ON FUNCTION platform.operator_jobs() TO repracer_operator;
GRANT EXECUTE ON FUNCTION platform.operator_alerts(int) TO repracer_operator;
GRANT EXECUTE ON FUNCTION platform.operator_write_queue() TO repracer_operator;
GRANT EXECUTE ON FUNCTION platform.operator_notifications(interval) TO repracer_operator;
GRANT EXECUTE ON FUNCTION platform.operator_tenants() TO repracer_operator;
GRANT EXECUTE ON FUNCTION platform.operator_snapshot_skips(int) TO repracer_operator;
GRANT EXECUTE ON FUNCTION platform.operator_actions_log(text, int) TO repracer_operator;
GRANT EXECUTE ON FUNCTION security.operator_create_tenant(uuid, uuid, text, text, uuid, text, text) TO repracer_operator;
GRANT EXECUTE ON FUNCTION security.operator_invite_owner(uuid, uuid, text, bytea, interval) TO repracer_operator;
GRANT EXECUTE ON FUNCTION security.operator_resolve_snapshot_skip(uuid, uuid, text, text) TO repracer_operator;
GRANT EXECUTE ON FUNCTION security.operator_acknowledge_alert(uuid, uuid, uuid) TO repracer_operator;

-- Функции панели не исполняет кто попало: PUBLIC отзывается у каждой (иначе их мог бы звать путь решения)
DO $$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'platform.operator_jobs()', 'platform.operator_alerts(int)', 'platform.operator_write_queue()',
    'platform.operator_notifications(interval)', 'platform.operator_tenants()', 'platform.operator_snapshot_skips(int)',
    'platform.operator_actions_log(text, int)',
    'security.operator_create_tenant(uuid, uuid, text, text, uuid, text, text)', 'security.operator_invite_owner(uuid, uuid, text, bytea, interval)',
    'security.operator_resolve_snapshot_skip(uuid, uuid, text, text)', 'security.operator_acknowledge_alert(uuid, uuid, uuid)',
    'security.operator_acting(uuid)', 'security.operator_audit(uuid, uuid, text, text, uuid, jsonb)',
    'security.resolve_platform_operator(text, text)'
  ] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
END $$;

COMMIT;
