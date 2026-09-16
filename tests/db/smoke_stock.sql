-- Р-102 (шаг 18): роль синхронизации остатка (svc_stock, repracer_stock) — только остатки и резервации, без цен и без аудита.
-- Выполнять ролью svc_stock после smoke_append_only.sql. Всё откатывается. Данные синтетические.
\set ON_ERROR_STOP 1

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


BEGIN;
SELECT set_config('app.tenant_id', 'a0000000-0000-0000-0000-00000000000a', true) \gset
-- Разрешённое: движение остатка пересчитывает пул; резервации читаются
INSERT INTO tenant_data.stock_movement (tenant_id, stock_pool_id, delta, reason)
VALUES ('a0000000-0000-0000-0000-00000000000a', 'ab000000-0000-0000-0000-000000000001', 1, 'RECEIPT');
DO $$
DECLARE
  n int;
BEGIN
  SELECT count(*) INTO n FROM channel_data.reservation;
  SELECT count(*) INTO n FROM tenant_data.stock_pool;
  RAISE NOTICE 'PASS accept | the stock role moves stock and reads reservations (Р-102)';
END $$;
-- Запрещённое — именно отсутствием права
SELECT pg_temp.expect_fail('stock role reads prices (Р-102)', $q$ SELECT count(*) FROM tenant_data.min_price $q$, '^permission denied for table min_price$');
SELECT pg_temp.expect_fail('stock role writes a price intent (Р-102)', $q$
  INSERT INTO channel_data.price_intent (tenant_id, write_scope_id, trigger_type, proposed_amount_minor, currency, price_basis, expires_at)
  VALUES ('a0000000-0000-0000-0000-00000000000a', 'a6000000-0000-0000-0000-000000000001', 'MANUAL', 1, 'EUR', 'GROSS', now() + interval '1 minute') $q$,
  '^permission denied for table price_intent$');
SELECT pg_temp.expect_fail('stock role changes a write scope (Р-102)', $q$
  UPDATE tenant_data.write_scope SET status = 'BLOCKED' $q$, '^permission denied for table write_scope$');
SELECT pg_temp.expect_fail('stock role writes the audit log (Р-102)', $q$
  INSERT INTO audit.audit_event (tenant_id, occurred_at, actor_type, action, entity_type) VALUES ('a0000000-0000-0000-0000-00000000000a', now(), 'SYSTEM', 'stock.forged', 'stock_pool') $q$,
  '^permission denied for schema audit$');
SELECT pg_temp.expect_fail('stock role reads memberships (Р-102)', $q$ SELECT count(*) FROM tenant_data.membership $q$, '^permission denied for table membership$');
SELECT pg_temp.expect_fail('stock role creates a product (Р-102)', $q$
  INSERT INTO tenant_data.product (tenant_id, sku, kind) VALUES ('a0000000-0000-0000-0000-00000000000a', 'stock-forged', 'SIMPLE') $q$, '^permission denied for table product$');
-- Изоляция тенанта: чужой остаток не виден
SELECT set_config('app.tenant_id', 'b0000000-0000-0000-0000-00000000000b', true) \gset
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM tenant_data.stock_pool WHERE tenant_id = 'a0000000-0000-0000-0000-00000000000a') THEN
    RAISE EXCEPTION 'the stock role sees the stock of another tenant (Р-102)'; END IF;
  RAISE NOTICE 'PASS reject | the stock role does not see the stock of another tenant (Р-102)';
END $$;
ROLLBACK;
