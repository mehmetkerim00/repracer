-- Р-90: создание тенантов смоук-тестов — ролью создания тенанта (svc_provisioning, член repracer_provisioning), единственным
-- её действием security.provision_tenant. Выполнять до smoke_app.sql. Данные синтетические.
\set ON_ERROR_STOP 1
\set QUIET 1

CREATE FUNCTION pg_temp.expect_fail(label text, q text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE q;
    RAISE EXCEPTION 'EXPECTED FAILURE DID NOT HAPPEN: %', label;
  EXCEPTION WHEN others THEN
    IF SQLERRM LIKE 'EXPECTED FAILURE DID NOT HAPPEN%' THEN RAISE; END IF;
    RAISE NOTICE 'PASS reject | % | %', label, left(SQLERRM, 110);
  END;
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

SELECT pg_temp.expect_fail('tenant provisioned without an owner (Р-90)', $q$
  SELECT security.provision_tenant('c0000000-0000-0000-0000-0000000000c1', 'No owner', 'EU', '[{"userId": "c1000000-0000-0000-0000-0000000000c1", "email": "x@example.test", "role": "ADMIN"}]') $q$);
SELECT pg_temp.expect_fail('provisioning role inserts a membership directly (Р-90)', $q$
  INSERT INTO tenant_data.membership (tenant_id, user_id, role, status) VALUES ('b0000000-0000-0000-0000-00000000000b', 'a1000000-0000-0000-0000-00000000000a', 'OWNER', 'ACTIVE') $q$);
SELECT pg_temp.expect_fail('provisioning role inserts a tenant directly (Р-90)', $q$
  INSERT INTO tenant_data.tenant (name, data_region) VALUES ('direct', 'EU') $q$);
SELECT pg_temp.expect_fail('provisioning role reads tenant data (Р-90)', $q$ SELECT count(*) FROM tenant_data.product $q$);
SELECT pg_temp.expect_fail('provisioning role writes the audit log (Р-90)', $q$
  INSERT INTO audit.audit_event (tenant_id, occurred_at, actor_type, action, entity_type) VALUES ('a0000000-0000-0000-0000-00000000000a', now(), 'SYSTEM', 'forged.event', 'price_stop') $q$);
