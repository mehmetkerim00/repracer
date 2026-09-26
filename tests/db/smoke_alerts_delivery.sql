-- Шаг 36 [Р-156]: доставка алертов — СВОЕЙ ролью (`svc_alert_delivery`). Она читает алерты всех тенантов и ставит
-- отметку доставки; ни цен, ни решений она не видит. Каждая защита проверяется своей проверкой с её причиной [Р-94].
\set ON_ERROR_STOP 1
\set QUIET 1

\i tests/db/smoke_helpers.sql

\set tA '''a0000000-0000-0000-0000-00000000000a'''

-- Отметка доставки без вида доставки ничего не доказывает
SELECT pg_temp.expect_fail('delivery recorded without naming how (Р-156)', format($q$
  UPDATE tenant_data.alert SET delivered_at = now() WHERE tenant_id = %L AND alert_id = 'ae000000-0000-0000-0000-000000000001' $q$, :tA),
  'alert_delivered_names_kind');
-- CRITICAL дайджестом не доставляется: он уходит немедленно [Р-156]
SELECT pg_temp.expect_fail('a CRITICAL alert delivered as an hourly digest (Р-156)', format($q$
  UPDATE tenant_data.alert SET delivered_at = now(), delivery_kind = 'EMAIL_DIGEST'
   WHERE tenant_id = %L AND alert_id = 'ae000000-0000-0000-0000-000000000001' $q$, :tA), 'alert_digest_is_warning_only');
-- Вид доставки — из известных: «как-то доставлено» ничего не доказывает
SELECT pg_temp.expect_fail('delivery of an unknown kind (Р-156)', format($q$
  UPDATE tenant_data.alert SET delivered_at = now(), delivery_kind = 'CARRIER_PIGEON'
   WHERE tenant_id = %L AND delivered_at IS NULL $q$, :tA), 'alert_delivery_kind_known');
-- Отрицательное число попыток: счётчик, который умеет уменьшаться, скрывает неудачные отправки
SELECT pg_temp.expect_fail('a negative number of delivery attempts (Р-156)', format($q$
  UPDATE tenant_data.alert SET delivery_attempts = -1 WHERE tenant_id = %L AND delivered_at IS NULL $q$, :tA),
  'alert_delivery_attempts_non_negative');

-- --------------------------------------------------------------- Р-156: событие неизменяемо, кроме отметки доставки
SELECT pg_temp.expect_fail('rewriting the code of a raised alert (Р-156)', format($q$
  UPDATE tenant_data.alert SET code = 'ANALYTICS_EXPORT_BACKLOG' WHERE tenant_id = %L AND alert_id = 'ae000000-0000-0000-0000-000000000001' $q$, :tA),
  'permission denied for table alert');
SELECT pg_temp.expect_fail('rewriting the severity of a raised alert (Р-156)', format($q$
  UPDATE tenant_data.alert SET severity = 'WARNING' WHERE tenant_id = %L AND alert_id = 'ae000000-0000-0000-0000-000000000001' $q$, :tA),
  'permission denied for table alert');

-- --------------------------------------------------------------- Р-156: доставка отмечается один раз
SELECT pg_temp.ok('delivery of an alert is recorded once (Р-156)', format($q$
  UPDATE tenant_data.alert SET delivered_at = now(), delivery_kind = 'EMAIL_IMMEDIATE', delivery_ref = 'synthetic-mail-1'
   WHERE tenant_id = %L AND alert_id = 'ae000000-0000-0000-0000-000000000001' $q$, :tA));
SELECT pg_temp.expect_fail('recording a second delivery of the same alert (Р-156)', format($q$
  UPDATE tenant_data.alert SET delivered_at = now() + interval '1 minute', delivery_kind = 'EMAIL_IMMEDIATE', delivery_ref = 'synthetic-mail-2'
   WHERE tenant_id = %L AND alert_id = 'ae000000-0000-0000-0000-000000000001' $q$, :tA), 'is already recorded');

-- --------------------------------------------------------------- Р-156: адрес владельца — для письма, и только он
SELECT pg_temp.ok('the delivery role finds the owner email of the tenant (Р-156)', format($q$
  DO $x$
  DECLARE mail text;
  BEGIN
    SELECT security.tenant_owner_email(%L) INTO mail;
    IF mail IS NULL OR position('@' IN mail) = 0 THEN RAISE EXCEPTION 'owner email of the tenant is not found'; END IF;
  END $x$ $q$, :tA));

-- Находка 5 ревью шага 36: правка ДОСТАВЛЕННОЙ строки, не трогающая время доставки, переставляла его молча
SELECT pg_temp.expect_fail('changing a delivered alert without touching the delivery time (Р-156)', format($q$
  UPDATE tenant_data.alert SET delivery_ref = 'synthetic-mail-second'
   WHERE tenant_id = %L AND alert_id = 'ae000000-0000-0000-0000-000000000001' $q$, :tA), 'is already recorded');

-- --------------------------------------------------------------- шаг 37 (задача D, OQ-224): третий вид отметки
-- Провайдера почты у проекта нет, и письмо не уходит. База знает это состояние ОТДЕЛЬНЫМ видом: не «доставлено»
-- (неправда) и не «недоставлено» (потеряли бы то, что событие разобрано и текст построен)
SELECT pg_temp.ok('a letter composed and not sent is recorded as a dry run (OQ-224)', format($q$
  UPDATE tenant_data.alert SET delivered_at = now(), delivery_kind = 'DRY_RUN', delivery_ref = 'dry-run-1'
   WHERE tenant_id = %L AND alert_id = 'ae000000-0000-0000-0000-000000000002' $q$, :tA));

/**
 * Шаг 41 [Р-171, находка 13 ревью]: цели недельного дайджеста тени читает ЭТА роль, и до сих пор функция не проверялась
 * ни быстрым, ни полным прогоном — только длинным заданием суток. Здесь она проверяется тем, чем и должна: правами этой
 * роли на настоящих данных. В смоук-мире теневых аккаунтов нет (все объявлены боевыми), поэтому целей ноль — и это
 * утверждается вместе с тем, что функция ВЫПОЛНЯЕТСЯ этой ролью (до исправления она молча отдавала ноль из-за RLS).
 */
DO $$
DECLARE
  t record;
  n int;
BEGIN
  SELECT count(*) INTO n FROM platform.shadow_digest_targets();
  -- Теневой аккаунт в мире ОДИН (его оставил smoke_shadow.sql); ноль здесь был бы истиной из пустоты [Р-94]
  IF n <> 1 THEN
    RAISE EXCEPTION 'the digest sees % targets, the world has exactly one shadow account (Р-171)', n;
  END IF;
  SELECT * INTO t FROM platform.shadow_digest_targets();
  IF t.owner_email IS NULL OR position('@' IN t.owner_email) = 0 THEN
    RAISE EXCEPTION 'the digest target has no owner to write to: % (Р-156)', t.owner_email;
  END IF;
  IF t.shadow_accounts <> 1 OR t.locale NOT IN ('de', 'en') THEN
    RAISE EXCEPTION 'the digest target is described wrongly: accounts=% locale=%', t.shadow_accounts, t.locale;
  END IF;
  RAISE NOTICE 'PASS accept | the delivery role reads the shadow digest targets: one tenant, its owner and its language (Р-171)';
END $$;
