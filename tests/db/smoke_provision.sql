-- Р-90: создание тенантов смоук-тестов — ролью создания тенанта (svc_provisioning, член repracer_provisioning), единственным
-- её действием security.provision_tenant. Выполнять до smoke_app.sql. Данные синтетические.
\set ON_ERROR_STOP 1
\set QUIET 1

CREATE FUNCTION pg_temp.expect_fail(label text, q text, reason text DEFAULT NULL) RETURNS void LANGUAGE plpgsql AS $$
-- Р-94: reason — ожидаемая причина отказа (SQLSTATE или шаблон сообщения); отказ по другой причине — провал проверки.
-- Р-95: при repracer.smoke_collect = on (мутационная проверка) провал не останавливает прогон, а пишется предупреждением CHECK FAILED.
DECLARE
  failure text;
BEGIN
  BEGIN
    EXECUTE q;
    RAISE EXCEPTION 'did not happen' USING ERRCODE = 'RS001';
  EXCEPTION
    WHEN SQLSTATE 'RS001' THEN
      failure := 'EXPECTED FAILURE DID NOT HAPPEN';
    WHEN others THEN
      -- Р-94 (шаг 18): причина обязательна и сверяется с текстом отказа — SQLSTATE недостаточно (42501 дают и защитные триггеры)
      IF reason IS NOT NULL AND SQLERRM ~* reason THEN
        RAISE NOTICE 'PASS reject | % | %', label, left(SQLERRM, 110);
        RETURN;
      END IF;
      failure := CASE WHEN reason IS NULL THEN format('EXPECTED FAILURE HAS NO DECLARED REASON (got %s %s)', SQLSTATE, left(SQLERRM, 160))
                      ELSE format('EXPECTED FAILURE HAD ANOTHER REASON (expected %s, got %s %s)', reason, SQLSTATE, left(SQLERRM, 160)) END;
  END;
  IF current_setting('repracer.smoke_collect', true) = 'on' THEN
    RAISE WARNING 'CHECK FAILED: % | %', label, failure;
  ELSE
    RAISE EXCEPTION '%: %', failure, label;
  END IF;
END $$;

-- Тенант A: владелец, администратор и оператор (для проверок ролей в smoke_admin.sql); тенант B: владелец
SELECT security.provision_tenant('a0000000-0000-0000-0000-00000000000a', 'Tenant A', 'EU', '[
  {"membershipId": "a2000000-0000-0000-0000-00000000000a", "userId": "a1000000-0000-0000-0000-00000000000a", "email": "owner-a@example.test", "role": "OWNER", "mfaEnabled": true},
  {"membershipId": "a2000000-0000-0000-0000-0000000000ad", "userId": "a1000000-0000-0000-0000-0000000000ad", "email": "admin-a@example.test", "role": "ADMIN"},
  {"membershipId": "a2000000-0000-0000-0000-0000000000a0", "userId": "a1000000-0000-0000-0000-0000000000a0", "email": "operator-a@example.test", "role": "OPERATOR"}
]'::jsonb);
SELECT security.provision_tenant('b0000000-0000-0000-0000-00000000000b', 'Tenant B', 'EU', '[
  {"membershipId": "b2000000-0000-0000-0000-00000000000b", "userId": "b1000000-0000-0000-0000-00000000000b", "email": "owner-b@example.test", "role": "OWNER", "mfaEnabled": true}
]'::jsonb);
DO $$ BEGIN RAISE NOTICE 'PASS accept | tenants A and B provisioned with their owners (Р-90)'; END $$;

-- Р-60, Р-94: тенант региона US в базе EU отклоняет именно проверка региона
SELECT pg_temp.expect_fail('tenant in wrong region DB (Р-60)', $q$
  SELECT security.provision_tenant('c0000000-0000-0000-0000-0000000000c2', 'US tenant', 'US', '[{"userId": "c1000000-0000-0000-0000-0000000000c2", "email": "us-owner@example.test", "role": "OWNER"}]') $q$,
  'does not match database region');
-- Находка 5 ревью шага 16 (0066): существующий пользователь не присоединяется к новому тенанту мимо приглашения
SELECT pg_temp.expect_fail('existing user attached as a member without an invitation (step 16 finding 5)', $q$
  SELECT security.provision_tenant('c0000000-0000-0000-0000-0000000000c3', 'Attach', 'EU', '[
    {"userId": "c1000000-0000-0000-0000-0000000000c3", "email": "attach-owner@example.test", "role": "OWNER"},
    {"userId": "a1000000-0000-0000-0000-00000000000a", "email": "owner-a@example.test", "role": "ADMIN"}]') $q$,
  'only by an invitation of its owner');
SELECT pg_temp.expect_fail('existing user provisioned as owner under another email (step 16 finding 5)', $q$
  SELECT security.provision_tenant('c0000000-0000-0000-0000-0000000000c4', 'Other email', 'EU', '[
    {"userId": "a1000000-0000-0000-0000-00000000000a", "email": "someone-else@example.test", "role": "OWNER"}]') $q$,
  'does not match the user');
SELECT pg_temp.expect_fail('existing user who never signed in provisioned as owner (step 16 finding 5)', $q$
  SELECT security.provision_tenant('c0000000-0000-0000-0000-0000000000c5', 'Never signed in', 'EU', '[
    {"userId": "a1000000-0000-0000-0000-00000000000a", "email": "owner-a@example.test", "role": "OWNER"}]') $q$,
  'has never signed in');
SELECT pg_temp.expect_fail('tenant provisioned without an owner (Р-90)', $q$
  SELECT security.provision_tenant('c0000000-0000-0000-0000-0000000000c1', 'No owner', 'EU', '[{"userId": "c1000000-0000-0000-0000-0000000000c1", "email": "x@example.test", "role": "ADMIN"}]') $q$, 'a tenant is provisioned together with its owner');
SELECT pg_temp.expect_fail('provisioning role inserts a membership directly (Р-90)', $q$
  INSERT INTO tenant_data.membership (tenant_id, user_id, role, status) VALUES ('b0000000-0000-0000-0000-00000000000b', 'a1000000-0000-0000-0000-00000000000a', 'OWNER', 'ACTIVE') $q$, '^permission denied for schema tenant_data$');
SELECT pg_temp.expect_fail('provisioning role inserts a tenant directly (Р-90)', $q$
  INSERT INTO tenant_data.tenant (name, data_region) VALUES ('direct', 'EU') $q$, '^permission denied for schema tenant_data$');
SELECT pg_temp.expect_fail('provisioning role reads tenant data (Р-90)', $q$ SELECT count(*) FROM tenant_data.product $q$, '^permission denied for schema tenant_data$');
SELECT pg_temp.expect_fail('provisioning role writes the audit log (Р-90)', $q$
  INSERT INTO audit.audit_event (tenant_id, occurred_at, actor_type, action, entity_type) VALUES ('a0000000-0000-0000-0000-00000000000a', now(), 'SYSTEM', 'forged.event', 'price_stop') $q$, '^permission denied for schema audit$');
