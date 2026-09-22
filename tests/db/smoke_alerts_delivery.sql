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
