-- Шаг 36 [Р-156]: алерт в базе и его доставка. Каждая защита проверяется СВОЕЙ проверкой с её причиной [Р-94, Р-99] и
-- названа строкой каталога мутаций при создании [Р-108]. Данные синтетические.
\set ON_ERROR_STOP 1
\set QUIET 1

\i tests/db/smoke_helpers.sql

\set tA '''a0000000-0000-0000-0000-00000000000a'''
\set owner '''a1000000-0000-0000-0000-00000000000a'''
\set account '''a4000000-0000-0000-0000-000000000001'''

SELECT set_config('app.tenant_id', :tA, false), set_config('app.user_id', :owner, false) \gset

-- --------------------------------------------------------------- Р-156: алерт поднимается и НЕ доставлен
SELECT pg_temp.ok('a process raises an alert for the owner (Р-156)', format($q$
  INSERT INTO tenant_data.alert (tenant_id, alert_id, code, severity, channel_account_id, details)
  VALUES (%L, 'ae000000-0000-0000-0000-000000000001', 'PRICING_STOPPED_BY_PERSON', 'CRITICAL', %L, '{"scope":"TENANT"}'::jsonb) $q$, :tA, :account));


-- Шаг 37 (задача D, OQ-224): второе событие — для сухого прогона доставки: письмо собирается и не уходит
SELECT pg_temp.ok('an alert for the dry run of the delivery (OQ-224)', format($q$
  INSERT INTO tenant_data.alert (tenant_id, alert_id, code, severity, channel_account_id, details)
  VALUES (%L, 'ae000000-0000-0000-0000-000000000002', 'ANALYTICS_EXPORT_BACKLOG', 'WARNING', %L, '{"days":3}'::jsonb) $q$, :tA, :account));

SELECT pg_temp.ok('a raised alert is undelivered until delivery marks it (Р-156)', format($q$
  DO $x$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM tenant_data.alert WHERE alert_id = 'ae000000-0000-0000-0000-000000000001' AND delivered_at IS NULL) THEN
      RAISE EXCEPTION 'a fresh alert must be undelivered';
    END IF;
  END $x$ $q$));
-- Алерт нельзя поднять УЖЕ доставленным: иначе «доставлено» получают, не отправив письма
SELECT pg_temp.expect_fail('an alert raised as already delivered (Р-156)', format($q$
  INSERT INTO tenant_data.alert (tenant_id, code, severity, delivered_at, delivery_kind)
  VALUES (%L, 'PRICE_WRITE_NOT_SENT', 'CRITICAL', now(), 'EMAIL_IMMEDIATE') $q$, :tA), 'cannot be raised as already delivered');
-- Уровень и код — из известных списков: молчаливая опечатка в коде события сделала бы письмо безымянным
SELECT pg_temp.expect_fail('an alert of an unknown severity (Р-156)', format($q$
  INSERT INTO tenant_data.alert (tenant_id, code, severity) VALUES (%L, 'PRICE_WRITE_NOT_SENT', 'INFO') $q$, :tA), 'alert_severity_known');
SELECT pg_temp.expect_fail('an alert code that is not a code (Р-156)', format($q$
  INSERT INTO tenant_data.alert (tenant_id, code, severity) VALUES (%L, 'preis kaputt', 'WARNING') $q$, :tA), 'alert_code_shape');

-- Подробности события — объект, а не строка и не число: иначе письмо соберётся из чего угодно
SELECT pg_temp.expect_fail('alert details that are not an object (Р-156)', format($q$
  INSERT INTO tenant_data.alert (tenant_id, code, severity, details) VALUES (%L, 'PRICE_WRITE_NOT_SENT', 'WARNING', '"kaputt"'::jsonb) $q$, :tA),
  'alert_details_object');
