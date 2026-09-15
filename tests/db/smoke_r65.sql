-- Р-65 после smoke_app.sql, от суперпользователя: запись с бюджетом правок требует подтверждённой границы суток витрины
\set ON_ERROR_STOP 1
\set tA 'a0000000-0000-0000-0000-00000000000a'
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
BEGIN;
UPDATE platform.marketplace SET time_zone_status = 'TO_VERIFY' WHERE channel = 'EBAY' AND marketplace = 'EBAY_DE';
SELECT pg_temp.expect_fail('budgeted write while the storefront day boundary is unconfirmed (Р-65)', $q$
  INSERT INTO tenant_data.channel_write (tenant_id, channel_write_id, write_scope_id, field, quantity, version, origin, budget_scope_key, budget_day)
  VALUES ('a0000000-0000-0000-0000-00000000000a', gen_random_uuid(), 'a6000000-0000-0000-0000-000000000003', 'QUANTITY', 2, 90, 'STOCK_RECALC', 'L1', (now() AT TIME ZONE 'Europe/Berlin')::date) $q$);
UPDATE platform.marketplace SET time_zone_status = 'CONFIRMED' WHERE channel = 'EBAY' AND marketplace = 'EBAY_DE';
SELECT pg_temp.expect_fail('budget day is not the current storefront day (Р-65)', $q$
  INSERT INTO tenant_data.channel_write (tenant_id, channel_write_id, write_scope_id, field, quantity, version, origin, budget_scope_key, budget_day)
  VALUES ('a0000000-0000-0000-0000-00000000000a', gen_random_uuid(), 'a6000000-0000-0000-0000-000000000003', 'QUANTITY', 2, 90, 'STOCK_RECALC', 'L1', (now() AT TIME ZONE 'Europe/Berlin')::date - 1) $q$);
SELECT pg_temp.expect_fail('US storefront confirmed without a time zone', $q$
  UPDATE platform.marketplace SET time_zone_status = 'CONFIRMED' WHERE marketplace = 'EBAY_US' $q$);
-- C2 (ретроспективное ревью шага 14): повтор записи после полуночи витрины расходует бюджет ТЕКУЩЕГО дня, а не дня создания.
-- Бюджет сегодняшнего дня листинга L1 исчерпан smoke_app.sql (200 + 50 = 250). Запись переводится в FAILED, её день
-- переносится на вчера (как если бы она была создана до полуночи), и повтор обязан упереться в сегодняшний лимит.
-- До 0055 повтор списывался на вчерашний день и проходил.
UPDATE tenant_data.channel_write SET status = 'FAILED', next_attempt_at = now() WHERE channel_write_id = 'a9000000-0000-0000-0000-000000000012';
SET LOCAL session_replication_role = replica;
UPDATE tenant_data.channel_write SET budget_day = budget_day - 1 WHERE channel_write_id = 'a9000000-0000-0000-0000-000000000012';
SET LOCAL session_replication_role = origin;
SELECT pg_temp.expect_fail('retry after midnight is charged to today, whose budget is exhausted (C2, Р-19)', $q$
  UPDATE tenant_data.channel_write SET status = 'DISPATCHED', attempt_count = attempt_count + 1, next_attempt_at = NULL
   WHERE channel_write_id = 'a9000000-0000-0000-0000-000000000012' $q$);
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM tenant_data.edit_budget WHERE budget_scope_key = 'L1' AND budget_day < (now() AT TIME ZONE 'Europe/Berlin')::date) THEN
    RAISE EXCEPTION 'a retry charged the edit budget of a past day';
  END IF;
  RAISE NOTICE 'PASS reject | no attempt charged to a past budget day (C2)';
END $$;
UPDATE platform.marketplace SET time_zone_status = 'TO_VERIFY' WHERE channel = 'EBAY' AND marketplace = 'EBAY_DE';
SELECT pg_temp.expect_fail('retry while the storefront day boundary is unconfirmed (C2, Р-65)', $q$
  UPDATE tenant_data.channel_write SET status = 'DISPATCHED', attempt_count = attempt_count + 1, next_attempt_at = NULL
   WHERE channel_write_id = 'a9000000-0000-0000-0000-000000000012' $q$);
UPDATE platform.marketplace SET time_zone_status = 'CONFIRMED' WHERE channel = 'EBAY' AND marketplace = 'EBAY_DE';
SELECT pg_temp.expect_fail('manual halt without a member and a note', $q$
  INSERT INTO channel_data.pricing_halt (tenant_id, channel_account_id, channel, marketplace, reason_code, details, halted_at)
  VALUES ('a0000000-0000-0000-0000-00000000000a', 'a4000000-0000-0000-0000-000000000003', 'EBAY', 'EBAY_DE', 'MANUAL', '{}', now()) $q$);
ROLLBACK;
