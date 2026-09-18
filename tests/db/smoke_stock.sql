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


CREATE FUNCTION pg_temp.ok(label text, q text) RETURNS void LANGUAGE plpgsql AS $$
-- Р-95 (шаг 28): как и у expect_fail, при repracer.smoke_collect = on отказ разрешённого действия не останавливает прогон, а
-- пишется предупреждением CHECK FAILED. Иначе снятая защита, ломающая законное действие, обрывала бы файл, и раннер считал бы
-- все проверки ниже «не достигнутыми», то есть зелёными.
BEGIN
  BEGIN
    EXECUTE q;
    SET CONSTRAINTS ALL IMMEDIATE;
  EXCEPTION WHEN others THEN
    IF current_setting('repracer.smoke_collect', true) = 'on' THEN
      RAISE WARNING 'CHECK FAILED: % | ACCEPTED ACTION WAS REFUSED (% %)', label, SQLSTATE, left(SQLERRM, 160);
      RETURN;
    END IF;
    RAISE;
  END;
  RAISE NOTICE 'PASS accept | %', label;
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
SELECT pg_temp.expect_fail('stock role changes the pricing of a write scope (Р-102)', $q$
  UPDATE tenant_data.write_scope SET pricing_mode = 'OFF' $q$, '^permission denied for table write_scope$');
SELECT pg_temp.expect_fail('stock role writes the audit log (Р-102)', $q$
  INSERT INTO audit.audit_event (tenant_id, occurred_at, actor_type, action, entity_type) VALUES ('a0000000-0000-0000-0000-00000000000a', now(), 'SYSTEM', 'stock.forged', 'stock_pool') $q$,
  '^permission denied for schema audit$');
SELECT pg_temp.expect_fail('stock role reads memberships (Р-102)', $q$ SELECT count(*) FROM tenant_data.membership $q$, '^permission denied for table membership$');
SELECT pg_temp.expect_fail('stock role creates a product (Р-102)', $q$
  INSERT INTO tenant_data.product (tenant_id, sku, kind) VALUES ('a0000000-0000-0000-0000-00000000000a', 'stock-forged', 'SIMPLE') $q$, '^permission denied for table product$');
-- Р-105 (шаг 19, OQ-152): запись в канал — только поле QUANTITY; право ограничено видом поля, а не таблицей
SELECT pg_temp.ok('the stock role completes a quantity write (Р-105)', $q$
  UPDATE tenant_data.channel_write SET status = 'ACCEPTED' WHERE channel_write_id = 'a9000000-0000-0000-0000-000000000012' $q$);
SELECT pg_temp.ok('the stock role creates a quantity write (Р-105)', $q$
  INSERT INTO tenant_data.channel_write (tenant_id, channel_write_id, write_scope_id, field, quantity, version, origin, budget_scope_key, budget_day)
  VALUES ('a0000000-0000-0000-0000-00000000000a', 'a9190000-0000-4000-8000-000000000001', 'a6000000-0000-0000-0000-000000000003', 'QUANTITY', 4, 3, 'STOCK_RECALC', 'L1', (now() AT TIME ZONE 'Europe/Berlin')::date) $q$);
-- Ревью шага 19, находка 6: новая версия вытесняет ждущую — завершение вытесненной (история, удаление строки и отправок) проходит
SELECT pg_temp.ok('the stock role supersedes a pending quantity write (Р-105)', $q$
  INSERT INTO tenant_data.channel_write (tenant_id, channel_write_id, write_scope_id, field, quantity, version, origin, budget_scope_key, budget_day)
  VALUES ('a0000000-0000-0000-0000-00000000000a', 'a9190000-0000-4000-8000-000000000002', 'a6000000-0000-0000-0000-000000000003', 'QUANTITY', 3, 4, 'STOCK_RECALC', 'L1', (now() AT TIME ZONE 'Europe/Berlin')::date) $q$);
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM tenant_data.channel_write WHERE channel_write_id = 'a9190000-0000-4000-8000-000000000001')
     OR NOT EXISTS (SELECT 1 FROM tenant_data.channel_write_history WHERE channel_write_id = 'a9190000-0000-4000-8000-000000000001' AND final_status = 'SUPERSEDED') THEN
    RAISE EXCEPTION 'the superseded quantity write was not moved to the history (Р-105)'; END IF;
  RAISE NOTICE 'PASS accept | the superseded quantity write is moved to the history (Р-105)';
END $$;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM tenant_data.channel_write WHERE field <> 'QUANTITY') OR EXISTS (SELECT 1 FROM tenant_data.write_scope WHERE field <> 'QUANTITY')
     OR NOT EXISTS (SELECT 1 FROM tenant_data.channel_write WHERE field = 'QUANTITY') THEN
    RAISE EXCEPTION 'the stock role sees price writes or does not see quantity writes (Р-105)'; END IF;
  RAISE NOTICE 'PASS accept | the stock role sees only quantity writes and their write scopes (Р-105)';
END $$;
-- Цена в запись канала: отказ даёт первой проверка пола (у роли нет права читать границы) — это не собственная проверка политики;
-- собственные проверки политики — видимость (выше) и вставка в историю записей, где триггера с чтением границ нет
SELECT pg_temp.expect_fail('stock role writes price history of a channel write (Р-105)', $q$
  INSERT INTO tenant_data.channel_write_history (tenant_id, channel_write_id, finished_at, write_scope_id, field, amount_minor, currency, price_basis, version, origin, final_status, attempt_count, created_at)
  VALUES ('a0000000-0000-0000-0000-00000000000a', gen_random_uuid(), now(), 'a6000000-0000-0000-0000-000000000001', 'PRICE', 1, 'EUR', 'GROSS', 9, 'STOCK_RECALC', 'APPLIED', 1, now()) $q$,
  'new row violates row-level security policy for table "channel_write_history');
-- Изоляция тенанта: чужой остаток не виден
SELECT set_config('app.tenant_id', 'b0000000-0000-0000-0000-00000000000b', true) \gset
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM tenant_data.stock_pool WHERE tenant_id = 'a0000000-0000-0000-0000-00000000000a') THEN
    RAISE EXCEPTION 'the stock role sees the stock of another tenant (Р-102)'; END IF;
  RAISE NOTICE 'PASS reject | the stock role does not see the stock of another tenant (Р-102)';
END $$;
ROLLBACK;
