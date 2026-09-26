-- Р-165, Р-166 (шаг 40): панель оператора платформы. Выполнять ролью svc_operator (член repracer_operator) после
-- smoke_app.sql и smoke_alerts.sql. Данные синтетические.
--
-- Главное здесь — НЕ то, что панель умеет, а то, чего она не умеет: у роли панели нет прав ни на одну таблицу, и
-- каждое из четырёх действий требует действующей учётной записи оператора и второго фактора [Р-165].
\set ON_ERROR_STOP 1
\set QUIET 1

\i tests/db/smoke_helpers.sql

\set tA '''a0000000-0000-0000-0000-00000000000a'''
\set op '''ef000000-0000-4000-8000-000000000001'''
\set opGone '''ef000000-0000-4000-8000-000000000002'''

-- --------------------------------------------------------------- ЧТЕНИЕ: шесть экранов отвечают
DO $$
DECLARE
  n int;
BEGIN
  SELECT count(*) INTO n FROM platform.operator_tenants();
  IF n < 1 THEN RAISE EXCEPTION 'список тенантов пуст: экрану обзора нечего показывать'; END IF;
  PERFORM * FROM platform.operator_jobs();
  PERFORM * FROM platform.operator_alerts(50);
  PERFORM * FROM platform.operator_write_queue();
  PERFORM * FROM platform.operator_notifications();
  PERFORM * FROM platform.operator_snapshot_skips(50);
  PERFORM * FROM platform.operator_actions_log();
  RAISE NOTICE 'PASS accept | seven read screens of the operator panel answer (Р-168)';
END $$;

/**
 * Задача D шага 40: оператор видит ОПЕРАЦИОННОЕ состояние и не видит данных продавца. Проверяется не намерением, а
 * отсутствием права: себестоимость, границы и решения о цене — чужие деньги, и панели они не нужны.
 */
SELECT pg_temp.expect_fail('the operator reads the unit cost of a tenant (шаг 40, D)', $q$ SELECT count(*) FROM tenant_data.cost_profile $q$,
  '^permission denied for table cost_profile$');
SELECT pg_temp.expect_fail('the operator reads the price floors of a tenant (шаг 40, D)', $q$ SELECT count(*) FROM tenant_data.min_price $q$,
  '^permission denied for table min_price$');
SELECT pg_temp.expect_fail('the operator reads the price decisions of a tenant (шаг 40, D)', $q$ SELECT count(*) FROM channel_data.price_decision $q$,
  '^permission denied for table price_decision$');
SELECT pg_temp.expect_fail('the operator reads the tenants table directly (Р-165)', $q$ SELECT count(*) FROM tenant_data.tenant $q$,
  '^permission denied for table tenant$');
/**
 * Остановки, границы и стратегии чужих тенантов панель не трогает [Р-166]: у неё нет ни прав, ни функции. Строки
 * каталога мутаций у этой проверки НЕТ намеренно [Р-104, прецедент шага 38]: право на `price_stop` держат ДВА слоя —
 * отсутствие самого права и страж остановки, который читает членства (их панель тоже не видит). Верните первое — и
 * отказ придёт от второго, то есть своей проверкой мутация не ловится; прогон шага 40 это показал буквально.
 */
SELECT pg_temp.expect_fail('the operator stops the prices of a tenant (Р-166)', format($q$
  INSERT INTO tenant_data.price_stop (tenant_id, scope_type, stopped_at, stopped_by_membership_id, stop_note)
  VALUES (%L, 'TENANT', now(), 'a2000000-0000-0000-0000-00000000000a', 'operator tries to stop') $q$, :tA),
  '^permission denied for table price_stop$');

-- --------------------------------------------------------------- ДЕЙСТВИЯ: учётная запись и второй фактор [Р-165]
-- Без второго фактора не проходит НИ ОДНО действие: у оператора нет рутинных операций
SELECT set_config('app.auth_mfa', 'off', false) \gset
SELECT pg_temp.expect_fail('the operator acknowledges an alert without a second factor (Р-165)', format($q$
  SELECT security.operator_acknowledge_alert(%L, %L, 'ae000000-0000-0000-0000-000000000001') $q$, :op, :tA),
  'needs a second factor');
SELECT pg_temp.expect_fail('the operator creates a tenant without a second factor (Р-165)', format($q$
  SELECT security.operator_create_tenant(%L, gen_random_uuid(), 'Pilot ohne MFA', 'EU', gen_random_uuid(), 'pilot-nomfa@example.test', 'de') $q$, :op),
  'needs a second factor');
SELECT set_config('app.auth_mfa', 'on', false) \gset

-- Отозванная учётная запись не отличается от несуществующей
SELECT pg_temp.expect_fail('a revoked operator account acts (Р-165)', format($q$
  SELECT security.operator_acknowledge_alert(%L, %L, 'ae000000-0000-0000-0000-000000000001') $q$, :opGone, :tA),
  'is not an active platform operator');
SELECT pg_temp.expect_fail('an operator account that does not exist acts (Р-165)', format($q$
  SELECT security.operator_acknowledge_alert('ef000000-0000-4000-8000-0000000000ff', %L, 'ae000000-0000-0000-0000-000000000001') $q$, :tA),
  'is not an active platform operator');

-- --------------------------------------------------------------- отметка «алерт увиден» [Р-166]
SELECT pg_temp.ok('the operator acknowledges an alert (Р-166)', format($q$
  SELECT security.operator_acknowledge_alert(%L, %L, 'ae000000-0000-0000-0000-000000000001') $q$, :op, :tA));
-- Отметка называет ОПЕРАТОРА и время: ограничения на пару столбцов нет намеренно [Р-104], утверждается здесь
DO $$
DECLARE
  r record;
BEGIN
  SELECT acknowledged_at, acknowledged_by INTO r FROM platform.operator_alerts(50)
   WHERE alert_id = 'ae000000-0000-0000-0000-000000000001';
  IF r.acknowledged_at IS NULL OR r.acknowledged_by <> 'ef000000-0000-4000-8000-000000000001' THEN
    RAISE EXCEPTION 'отметка «увиден» не называет оператора: at=% by=%', r.acknowledged_at, r.acknowledged_by;
  END IF;
  RAISE NOTICE 'PASS accept | the acknowledgement names the operator who made it (Р-166)';
END $$;

-- Второй раз — не счётчик, а ошибка: «увидено» остаётся событием
SELECT pg_temp.expect_fail('the same alert is acknowledged twice (Р-166)', format($q$
  SELECT security.operator_acknowledge_alert(%L, %L, 'ae000000-0000-0000-0000-000000000001') $q$, :op, :tA),
  'is unknown or already acknowledged');

/**
 * Аудит ПРОДАВЦА панели не виден (находка 4а ревью шага 40). Границу держит политика строк `operator_actions_audit`
 * (`actor_type = 'SUPPORT_STAFF'`), и до этой проверки её снятие не краснело нигде: в смоук-мире больше сотни строк
 * административных действий тенанта, и панель показала бы их все.
 */
/**
 * Читать саму `audit_event` роль панели не может вовсе, поэтому «в мире есть аудит продавца» отсюда не утвердить. Зубы
 * этой проверке даёт её СТРОКА КАТАЛОГА: мутация расширяет политику до `USING (true)`, и если бы административных
 * действий тенанта в смоук-мире не было, мутационный прогон сказал бы «не поймана» [Р-99]. В мире их больше сотни.
 */
DO $$
DECLARE
  n int;
BEGIN
  SELECT count(*) INTO n FROM platform.operator_actions_log('admin_change.insert', 500);
  IF n > 0 THEN RAISE EXCEPTION 'the operator sees the audit log of a seller (Р-165)'; END IF;
  RAISE NOTICE 'PASS accept | the operator does not see the audit log of sellers (Р-165)';
END $$;

-- Писать в журнал напрямую панель не может: право есть только у функции, принадлежащей РОЛИ АУДИТА [Р-90]
SELECT pg_temp.expect_fail('the operator writes the audit log directly (Р-165)', format($q$
  SELECT security.operator_audit(%L, %L, 'operator.forged', 'tenant_data.tenant', %L, '{}'::jsonb) $q$, :op, :tA, :tA),
  'permission denied for function operator_audit');

-- Действие оператора попало в аудит [OQ-191]: без этого панель — чужие руки без имени
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM platform.operator_actions_log('operator.alert_acknowledged', 10)) THEN
    RAISE EXCEPTION 'действие оператора не записано в audit_event (OQ-191)';
  END IF;
  RAISE NOTICE 'PASS accept | an action of the operator is written to the audit log (OQ-191)';
END $$;

-- Приглашение — ПЕРВЫЙ вход владельца: у владельца с привязанным входом панель приглашения не выдаёт [находка 7 ревью шага 40]
-- --------------------------------------------------------------- пилот: тенант и приглашение владельца [Р-167]
-- Язык пилота называет оператор [Р-161, находка 6 ревью шага 40]: письмо читает продавец, а не панель
SELECT pg_temp.ok('the operator creates a pilot tenant (Р-167)', $q$
  SELECT security.operator_create_tenant('ef000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-0000000000e1',
    'Pilot Händler', 'EU', 'e1000000-0000-4000-8000-0000000000e1', 'pilot-owner@example.test', 'en') $q$);
DO $$
DECLARE
  loc text;
BEGIN
  SELECT locale INTO loc FROM platform.operator_tenants() WHERE tenant_id = 'e0000000-0000-4000-8000-0000000000e1'::uuid;
  IF loc <> 'en' THEN RAISE EXCEPTION 'the language of the pilot is not the one the operator named (Р-161)'; END IF;
  RAISE NOTICE 'PASS accept | the pilot is created in the language its owner reads (Р-161)';
END $$;
SELECT pg_temp.expect_fail('the operator creates a pilot in a language the dictionary does not have (Р-161)', $q$
  SELECT security.operator_create_tenant('ef000000-0000-4000-8000-000000000001', 'e0000000-4000-8000-0000-0000000000e2',
    'Pilot FR', 'EU', 'e1000000-4000-8000-0000-0000000000e2', 'pilot-fr@example.test', 'fr') $q$,
  'tenant_locale_known');
SELECT pg_temp.ok('the operator invites the owner of the pilot (Р-167)', $q$
  SELECT security.operator_invite_owner('ef000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-0000000000e1',
    'pilot-owner@example.test', sha256('pilot-token'), interval '7 days') $q$);
-- Приглашение уходит ВЛАДЕЛЬЦУ этого тенанта, а не любому адресу: иначе панель рассылает приглашения кому угодно
SELECT pg_temp.expect_fail('the operator invites an address that is not the owner (Р-166)', $q$
  SELECT security.operator_invite_owner('ef000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-0000000000e1',
    'someone-else@example.test', sha256('pilot-token-2'), interval '7 days') $q$,
  'is not the owner of tenant');

/**
 * Владелец, у которого вход УЖЕ привязан, приглашения от панели не получает [находка 7 ревью шага 40]: это не пилот, а
 * перепривязка, и она — дело владельца тенанта [Р-98]. Владелец мира смоука привязан посевом.
 */
SELECT pg_temp.expect_fail('the operator invites an owner who already has a sign-in (Р-98)', format($q$
  SELECT security.operator_invite_owner(%L, 'c0000000-0000-0000-0000-00000000000c', 'signed-in@example.test',
    sha256('relink-attempt'), interval '7 days') $q$, :op),
  'already has a linked sign-in');
