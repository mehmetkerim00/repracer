-- Run as svc_scheduler (member of repracer_retention) after smoke_app.sql.
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
      IF reason IS NULL OR SQLSTATE = reason OR SQLERRM ~* reason THEN
        RAISE NOTICE 'PASS reject | % | %', label, left(SQLERRM, 110);
        RETURN;
      END IF;
      failure := format('EXPECTED FAILURE HAD ANOTHER REASON (expected %s, got %s %s)', reason, SQLSTATE, left(SQLERRM, 160));
  END;
  IF current_setting('repracer.smoke_collect', true) = 'on' THEN
    RAISE WARNING 'CHECK FAILED: % | %', label, failure;
  ELSE
    RAISE EXCEPTION '%: %', failure, label;
  END IF;
END $$;

SELECT pg_temp.expect_fail('direct DELETE from append-only as scheduler', $q$ DELETE FROM tenant_data.min_price $q$);
SELECT pg_temp.expect_fail('purge ACTIVE tenant', $q$ SELECT maintenance.purge_tenant_channel_data('b0000000-0000-0000-0000-00000000000b') $q$);

SELECT count(*) AS ph_before FROM pg_inherits WHERE inhparent = 'tenant_data.price_history'::regclass \gset
SELECT count(*) AS intent_before FROM pg_inherits WHERE inhparent = 'channel_data.price_intent'::regclass \gset
SELECT 'SELECT maintenance.drop_expired_partitions(now() + interval ''19 months'', 10)' FROM generate_series(1, 6) \gexec
SELECT count(*) AS ph_after FROM pg_inherits WHERE inhparent = 'tenant_data.price_history'::regclass \gset
SELECT count(*) AS intent_after FROM pg_inherits WHERE inhparent = 'channel_data.price_intent'::regclass \gset
SELECT count(*) AS cwh_left FROM pg_inherits WHERE inhparent = 'tenant_data.channel_write_history'::regclass \gset
\echo 'price_history partitions (ARCHIVE export pending, must stay):' :ph_before '->' :ph_after
\echo 'price_intent partitions (force drop after 14 days, must go):' :intent_before '->' :intent_after
SELECT action, count(*) FROM maintenance.retention_run WHERE action LIKE 'PARTITION_%DROPPED' GROUP BY action ORDER BY 1;

-- Exporter confirms the channel_write_history partition that holds rows
\c - svc_exporter
SELECT tableoid::regclass::text AS cwh_part, count(*) AS cwh_rows
  FROM tenant_data.channel_write_history GROUP BY tableoid LIMIT 1 \gset
INSERT INTO maintenance.partition_export (parent_table, partition_name, target, exported_rows, verified_at)
VALUES ('tenant_data.channel_write_history', :'cwh_part', 'CLICKHOUSE', :cwh_rows, now()),
       ('tenant_data.channel_write_history', :'cwh_part', 'ARCHIVE', :cwh_rows - 1, now());
\c - svc_scheduler
SELECT maintenance.drop_expired_partitions(now() + interval '19 months', 100) AS dropped_with_bad_count \gset
SELECT count(*) AS still_there FROM pg_inherits WHERE inhrelid = to_regclass(:'cwh_part') \gset
\echo 'archive export row count mismatch -> partition kept:' :still_there
\c - svc_exporter
UPDATE maintenance.partition_export SET exported_rows = :cwh_rows WHERE partition_name = :'cwh_part' AND target = 'ARCHIVE';
\c - svc_scheduler
SELECT maintenance.drop_expired_partitions(now() + interval '19 months', 100) AS dropped_after_export \gset
SELECT count(*) AS gone FROM pg_inherits WHERE inhrelid = to_regclass(:'cwh_part') \gset
\echo 'verified export on both layers -> partition dropped (0 = gone):' :gone

-- Р-29: закрытие дней и неизменяемая свёртка
SELECT maintenance.close_price_days(now() + interval '2 days') AS days_closed \gset
SELECT count(*) AS daily_rows FROM tenant_data.price_daily \gset
SELECT maintenance.close_price_days(now() + interval '2 days') AS closed_again \gset
\echo 'price days closed:' :days_closed '; price_daily rows:' :daily_rows '; second run closes (expect 0):' :closed_again
-- Р-30: алерт по подтверждённой резервации старше 14 дней — один раз
SELECT maintenance.alert_stale_confirmed_reservations(now() + interval '15 days') AS stale_alerts \gset
SELECT maintenance.alert_stale_confirmed_reservations(now() + interval '15 days') AS stale_alerts_again \gset
SELECT count(*) AS stale_outbox FROM tenant_data.outbox_event WHERE topic = 'alert.reservation-confirmed-stale.v1' \gset
\echo 'stale confirmed reservation alerts (expect 1 then 0, outbox 1):' :stale_alerts :stale_alerts_again :stale_outbox
SELECT status AS reservation_2_status FROM channel_data.reservation WHERE reservation_id = 'ac000000-0000-0000-0000-000000000002' \gset
\echo 'reservation 2 stays (Р-30, expect CONFIRMED_BY_SOURCE):' :reservation_2_status

-- Удаление по сроку выше сняло и текущую секцию журнала аудита (now() + 19 месяцев): поправка человека пишется в аудит (Р-97)
SELECT maintenance.ensure_partitions(now()) IS NOT NULL AS partitions_ensured \gset
-- Р-29: поправки вносит человек через административный сервис (Р-96: у пути решения поправок нет)
\c - svc_admin
BEGIN;
SELECT set_config('app.tenant_id', 'a0000000-0000-0000-0000-00000000000a', true), set_config('app.user_id', 'a1000000-0000-0000-0000-00000000000a', true) \gset
INSERT INTO tenant_data.price_daily_correction (tenant_id, price_daily_correction_id, write_scope_id, price_type, price_day,
  min_amount_minor, max_amount_minor, first_amount_minor, first_accepted_at, last_amount_minor, last_accepted_at, change_count,
  min_floor_minor, reason, created_by_membership_id)
SELECT tenant_id, 'ad100000-0000-0000-0000-000000000001', write_scope_id, price_type, price_day, 1200, max_amount_minor, 1200,
       first_accepted_at - interval '1 hour', last_amount_minor, last_accepted_at, change_count + 1, min_floor_minor,
       'Пропущенная запись цены 1200 в 09:00', 'a2000000-0000-0000-0000-00000000000a'
  FROM tenant_data.price_daily LIMIT 1;
DO $$ BEGIN
  BEGIN
    INSERT INTO tenant_data.price_daily_correction (tenant_id, write_scope_id, price_type, price_day, min_amount_minor, max_amount_minor,
      first_amount_minor, first_accepted_at, last_amount_minor, last_accepted_at, change_count, min_floor_minor, reason, created_by_membership_id)
    SELECT tenant_id, write_scope_id, price_type, price_day, 1100, max_amount_minor, 1100, first_accepted_at, last_amount_minor,
           last_accepted_at, 3, min_floor_minor, 'Вторая поправка без ссылки на первую', 'a2000000-0000-0000-0000-00000000000a'
      FROM tenant_data.price_daily LIMIT 1;
    RAISE EXCEPTION 'EXPECTED FAILURE DID NOT HAPPEN';
  EXCEPTION WHEN others THEN
    IF SQLERRM LIKE 'EXPECTED FAILURE%' THEN RAISE; END IF;
    RAISE NOTICE 'PASS reject | correction must supersede the current head | %', left(SQLERRM, 90);
  END;
  BEGIN
    UPDATE tenant_data.price_daily SET min_amount_minor = 1;
    RAISE EXCEPTION 'EXPECTED FAILURE DID NOT HAPPEN';
  EXCEPTION WHEN others THEN
    IF SQLERRM LIKE 'EXPECTED FAILURE%' THEN RAISE; END IF;
    RAISE NOTICE 'PASS reject | UPDATE of immutable price_daily | %', left(SQLERRM, 90);
  END;
END $$;
SELECT corrected, min_amount_minor, change_count FROM tenant_data.price_daily_effective;
COMMIT;
\c - svc_scheduler

-- Reconnect dropped the session temp schema: recreate the helper
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
      IF reason IS NULL OR SQLSTATE = reason OR SQLERRM ~* reason THEN
        RAISE NOTICE 'PASS reject | % | %', label, left(SQLERRM, 110);
        RETURN;
      END IF;
      failure := format('EXPECTED FAILURE HAD ANOTHER REASON (expected %s, got %s %s)', reason, SQLSTATE, left(SQLERRM, 160));
  END;
  IF current_setting('repracer.smoke_collect', true) = 'on' THEN
    RAISE WARNING 'CHECK FAILED: % | %', label, failure;
  ELSE
    RAISE EXCEPTION '%: %', failure, label;
  END IF;
END $$;

-- Tenant closure for tenant A (has price_history)
UPDATE tenant_data.tenant SET status = 'OFFBOARDING' WHERE tenant_id = 'a0000000-0000-0000-0000-00000000000a';
SELECT maintenance.purge_tenant_channel_data('a0000000-0000-0000-0000-00000000000a') AS channel_rows_purged \gset
\echo 'channel rows purged:' :channel_rows_purged
UPDATE tenant_data.tenant SET status = 'CLOSED', closed_at = now() WHERE tenant_id = 'a0000000-0000-0000-0000-00000000000a';
SELECT pg_temp.expect_fail('purge tenant data without price_history confirmation (OQ-22)',
  $q$ SELECT maintenance.purge_tenant_data('a0000000-0000-0000-0000-00000000000a') $q$);
SELECT maintenance.purge_tenant_data('a0000000-0000-0000-0000-00000000000a', true) AS tenant_rows_purged \gset
\echo 'tenant rows purged:' :tenant_rows_purged
SELECT count(*) AS legal_consents FROM legal.migration_consent_record WHERE tenant_id = 'a0000000-0000-0000-0000-00000000000a' \gset
\echo 'eBay consents kept in legal hold (Р-26):' :legal_consents
SELECT postgres_channel_purged_at IS NOT NULL AS ch_done, postgres_tenant_purged_at IS NOT NULL AS pg_done, legal_hold_until
  FROM maintenance.tenant_purge_status WHERE subject_tenant_id = 'a0000000-0000-0000-0000-00000000000a';

SELECT action, count(*) FROM maintenance.retention_run GROUP BY action ORDER BY action;
SELECT name, status FROM tenant_data.tenant WHERE tenant_id = 'a0000000-0000-0000-0000-00000000000a';
