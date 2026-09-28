-- Шаг 49 [Р-189, Р-192], от суперпользователя (роли переключаются внутри): режим пакетов eBay и удаление данных продавца по
-- уведомлению eBay Marketplace Account Deletion. Данные синтетические. Идёт ДО smoke_append_only.sql: у журнала уведомлений
-- должна быть строка в мире смоука [Р-103]. Аккаунт eBay мира смоука нужен файлам ниже, поэтому его удаление проверяется в
-- откатываемой транзакции.
\set ON_ERROR_STOP 1
CREATE FUNCTION pg_temp.expect_fail(label text, q text, reason text DEFAULT NULL) RETURNS void LANGUAGE plpgsql AS $$
-- Р-94: reason — ожидаемая причина отказа; отказ по другой причине — провал проверки.
-- Р-95: при repracer.smoke_collect = on провал не останавливает прогон, а пишется предупреждением CHECK FAILED.
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

-- ================================================================ Р-192: уведомление о пользователе, которого у нас нет
-- Находка 3 ревью: уведомления идут обо всех закрытых аккаунтах eBay (в основном о покупателях) — о чужих людях журнал не пишет
-- ничего, даже хэша
BEGIN;
SET LOCAL ROLE repracer_ebay_deletion;
SELECT pg_temp.ok('an eBay deletion notice for a user we do not know deletes nothing and records nothing (Р-192)', $q$
  DO $i$
  DECLARE
    n int;
  BEGIN
    SELECT accounts_deleted INTO n FROM security.ebay_account_deletion('syn-notice-0001-unknown', 'syn_unknown_user', now() - interval '1 minute', 1);
    IF n <> 0 THEN RAISE EXCEPTION 'unknown eBay user deleted % accounts', n; END IF;
  END $i$ $q$);
RESET ROLE;
SELECT pg_temp.ok('a notice about a stranger leaves no trace, not even a hash (Р-192)', $q$
  DO $i$
  BEGIN
    IF EXISTS (SELECT 1 FROM platform.ebay_account_deletion_notice WHERE notification_id = 'syn-notice-0001-unknown') THEN
      RAISE EXCEPTION 'the notice about a user we never had is stored';
    END IF;
  END $i$ $q$);
COMMIT;

-- Строка журнала мира смоука [Р-103]: исполненное удаление отдельного аккаунта eBay, заведённого только для этого
BEGIN;
SET LOCAL session_replication_role = replica;
INSERT INTO tenant_data.channel_account SELECT (jsonb_populate_record(a, jsonb_build_object(
    'channel_account_id', 'a4000000-0000-0000-0000-0000000000d1', 'external_account_id', 'syn_ebay_seller_smoke_deleted', 'write_mode', 'SHADOW'))).*
  FROM tenant_data.channel_account a WHERE channel_account_id = 'a4000000-0000-0000-0000-000000000003';
SET LOCAL session_replication_role = origin;
SET LOCAL ROLE repracer_ebay_deletion;
SELECT * FROM security.ebay_account_deletion('syn-notice-0000-smoke-world', 'syn_ebay_seller_smoke_deleted', now() - interval '1 minute', 1);
COMMIT;

-- ================================================================ Р-192: удаление подключённого продавца (откатывается)
BEGIN;
-- Синтетический токен аккаунта eBay мира смоука (шифротекст — не токен; стражи вставки здесь не предмет проверки)
SET LOCAL session_replication_role = replica;
INSERT INTO tenant_data.channel_credential (tenant_id, channel_account_id, version, key_id, iv, auth_tag, ciphertext)
VALUES ('a0000000-0000-0000-0000-00000000000a', 'a4000000-0000-0000-0000-000000000003', 1, 'syn-key', '\x000102030405060708090a0b',
        '\x000102030405060708090a0b0c0d0e0f', '\x73796e2d636970686572746578742d3031');
SET LOCAL session_replication_role = origin;
SET LOCAL ROLE repracer_ebay_deletion;
SELECT pg_temp.ok('an eBay deletion notice removes the tokens, disconnects the account, forgets the eBay user id and is audited (Р-192)', $q$
  DO $i$
  DECLARE
    n int;
    again int;
    ids uuid[];
    ids2 uuid[];
  BEGIN
    SELECT accounts_deleted, account_ids INTO n, ids FROM security.ebay_account_deletion('syn-notice-0002-seller-a', 'ebay-user-a', now() - interval '1 minute', 1);
    -- eBay повторяет до подтверждения: тот же номер уведомления исполняется один раз (прежнее число, пустой список)
    SELECT accounts_deleted, account_ids INTO again, ids2 FROM security.ebay_account_deletion('syn-notice-0002-seller-a', 'ebay-user-a', now() - interval '1 minute', 2);
    IF n <> 1 OR again <> 1 OR ids <> ARRAY['a4000000-0000-0000-0000-000000000003'::uuid] OR ids2 <> '{}'::uuid[] THEN
      RAISE EXCEPTION 'deleted accounts: % % then % %', n, ids, again, ids2;
    END IF;
  END $i$ $q$);
RESET ROLE;
SELECT pg_temp.ok('after the deletion notice nothing in the database names the eBay user (Р-192)', $q$
  DO $i$
  DECLARE
    a record;
    c record;
    hits bigint;
  BEGIN
    SELECT auth_status, credentials_ref, external_account_id, disconnected_at INTO a FROM tenant_data.channel_account
     WHERE channel_account_id = 'a4000000-0000-0000-0000-000000000003';
    IF a.auth_status <> 'DISCONNECTED' OR a.credentials_ref IS NOT NULL OR a.external_account_id <> 'deleted:a4000000-0000-0000-0000-000000000003' OR a.disconnected_at IS NULL THEN
      RAISE EXCEPTION 'account after deletion: %', row_to_json(a);
    END IF;
    IF EXISTS (SELECT 1 FROM tenant_data.channel_credential WHERE channel_account_id = 'a4000000-0000-0000-0000-000000000003') THEN
      RAISE EXCEPTION 'the eBay tokens of the deleted user are still stored';
    END IF;
    /**
     * Находка 2 ревью: не только аккаунт — ни один текстовый или jsonb-столбец схем данных продавца, каналов, платформы и аудита
     * не несёт идентификатора пользователя. Схема `legal` не проверяется намеренно: согласие на миграцию eBay хранится 3 года
     * после закрытия по требованию закона [Р-26] — «retained … to meet specific and demonstrable legal requirements» страницы.
     */
    FOR c IN SELECT table_schema, table_name, column_name FROM information_schema.columns col
              WHERE table_schema IN ('tenant_data', 'channel_data', 'platform', 'audit', 'maintenance', 'security')
                AND data_type IN ('text', 'jsonb', 'character varying')
                AND EXISTS (SELECT 1 FROM information_schema.tables t WHERE t.table_schema = col.table_schema AND t.table_name = col.table_name AND t.table_type = 'BASE TABLE') LOOP
      EXECUTE format('SELECT count(*) FROM %I.%I WHERE %I::text LIKE %L', c.table_schema, c.table_name, c.column_name, '%ebay-user-a%') INTO hits;
      IF hits > 0 THEN RAISE EXCEPTION 'the eBay user id is still stored in %.%.%', c.table_schema, c.table_name, c.column_name; END IF;
    END LOOP;
    IF (SELECT count(*) FROM tenant_data.alert WHERE code = 'EBAY_ACCOUNT_DELETED_BY_USER' AND channel_account_id = 'a4000000-0000-0000-0000-000000000003') <> 1 THEN
      RAISE EXCEPTION 'the owner is not told exactly once';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM audit.audit_event WHERE action = 'channel.ebay_account_deleted_by_user' AND entity_id = 'a4000000-0000-0000-0000-000000000003') THEN
      RAISE EXCEPTION 'the deletion is not in the audit log';
    END IF;
    IF (SELECT user_id_sha256 FROM platform.ebay_account_deletion_notice WHERE notification_id = 'syn-notice-0002-seller-a')
       IS DISTINCT FROM sha256(convert_to('ebay-user-a', 'UTF8')) THEN
      RAISE EXCEPTION 'the notice does not keep the hash of the user id';
    END IF;
  END $i$ $q$);
ROLLBACK;

-- ================================================================ Р-192: границы
BEGIN;
SELECT pg_temp.expect_fail('the eBay user id of an account changes to anything but deleted:<account> (Р-192)', $q$
  UPDATE tenant_data.channel_account SET external_account_id = 'ebay-user-b' WHERE channel_account_id = 'a4000000-0000-0000-0000-000000000003' $q$,
  'external account id changes only to deleted:<account> of a disconnected eBay account');
SELECT pg_temp.expect_fail('an eBay user id is erased while the account stays connected (Р-192)', $q$
  UPDATE tenant_data.channel_account SET external_account_id = 'deleted:a4000000-0000-0000-0000-000000000003' WHERE channel_account_id = 'a4000000-0000-0000-0000-000000000003' $q$,
  'external account id changes only to deleted:<account> of a disconnected eBay account');
SET LOCAL ROLE repracer_ebay_deletion;
SELECT pg_temp.expect_fail('the eBay deletion receiver reads accounts directly (Р-192)', $q$
  SELECT count(*) FROM tenant_data.channel_account $q$, 'permission denied');
SELECT pg_temp.expect_fail('the eBay deletion receiver deletes tokens directly (Р-192)', $q$
  DELETE FROM tenant_data.channel_credential $q$, 'permission denied');
ROLLBACK;

-- ================================================================ Р-189: режим пакетов аккаунта eBay
BEGIN;
SET LOCAL ROLE repracer_app;
-- Находка 8 ревью: функция сверяет тенант вызова с тенантом сессии — чужой тенант отклоняется
SELECT set_config('app.tenant_id', 'b0000000-0000-0000-0000-00000000000b', true) \gset
SELECT pg_temp.expect_fail('an eBay batch outcome for an account of another tenant (Р-189)', $q$
  SELECT channel_data.record_ebay_batch_outcome('a0000000-0000-0000-0000-00000000000a', 'a4000000-0000-0000-0000-000000000003', false) $q$,
  'from a session of tenant');
SELECT set_config('app.tenant_id', 'a0000000-0000-0000-0000-00000000000a', true) \gset
SELECT pg_temp.ok('an accepted multi-SKU batch moves the eBay account from the probe to MULTI; a refusal moves it to SINGLE with an E-22 alert (Р-189)', $q$
  DO $i$
  DECLARE
    m1 text;
    m2 text;
    m3 text;
  BEGIN
    m1 := channel_data.record_ebay_batch_outcome('a0000000-0000-0000-0000-00000000000a', 'a4000000-0000-0000-0000-000000000003', true);
    m2 := channel_data.record_ebay_batch_outcome('a0000000-0000-0000-0000-00000000000a', 'a4000000-0000-0000-0000-000000000003', false);
    -- После отказа мультипакет не возвращается даже принятым пакетом: снять SINGLE может только человек
    m3 := channel_data.record_ebay_batch_outcome('a0000000-0000-0000-0000-00000000000a', 'a4000000-0000-0000-0000-000000000003', true);
    IF (m1, m2, m3) IS DISTINCT FROM ('MULTI', 'SINGLE', 'SINGLE') THEN RAISE EXCEPTION 'batch modes: %, %, %', m1, m2, m3; END IF;
  END $i$ $q$);
RESET ROLE;
SELECT pg_temp.ok('the refused multi-SKU batch raises one alert naming E-22 (Р-189)', $q$
  DO $i$
  BEGIN
    IF (SELECT count(*) FROM tenant_data.alert WHERE code = 'EBAY_MULTI_SKU_REFUSED' AND details ->> 'question' = 'E-22'
         AND channel_account_id = 'a4000000-0000-0000-0000-000000000003') <> 1 THEN
      RAISE EXCEPTION 'expected exactly one EBAY_MULTI_SKU_REFUSED alert with E-22';
    END IF;
  END $i$ $q$);
SELECT pg_temp.expect_fail('the eBay batch mode goes back from SINGLE to MULTI (Р-189)', $q$
  UPDATE tenant_data.channel_account SET ebay_batch_mode = 'MULTI' WHERE channel_account_id = 'a4000000-0000-0000-0000-000000000003' $q$,
  'eBay batch mode moves only forward');
SELECT pg_temp.expect_fail('a batch mode on a non-eBay account (Р-189)', $q$
  UPDATE tenant_data.channel_account SET ebay_batch_mode = 'MULTI' WHERE channel_account_id = 'a4000000-0000-0000-0000-000000000001' $q$,
  'channel_account_ebay_batch_mode_known');
SET LOCAL session_replication_role = replica;
UPDATE tenant_data.channel_account SET write_mode = 'SHADOW' WHERE channel_account_id = 'a4000000-0000-0000-0000-000000000003';
SET LOCAL session_replication_role = origin;
SET LOCAL ROLE repracer_app;
SELECT set_config('app.tenant_id', 'a0000000-0000-0000-0000-00000000000a', true) \gset
SELECT pg_temp.expect_fail('a batch outcome of an eBay account in the shadow (Р-169, Р-189)', $q$
  SELECT channel_data.record_ebay_batch_outcome('a0000000-0000-0000-0000-00000000000a', 'a4000000-0000-0000-0000-000000000003', false) $q$,
  'nothing was sent');
ROLLBACK;

-- ================================================================ Р-192: форма журнала уведомлений (каждое ограничение — своя причина)
BEGIN;
SELECT pg_temp.expect_fail('an eBay deletion notice with a strange notification id (Р-192)', $q$
  INSERT INTO platform.ebay_account_deletion_notice (notification_id, user_id_sha256, event_date, publish_attempt, accounts_deleted)
  VALUES ('x', sha256('\x00'), now(), 1, 1) $q$, 'ebay_account_deletion_notice_id_shape');
SELECT pg_temp.expect_fail('an eBay deletion notice keeps something other than a SHA-256 of the user (Р-192)', $q$
  INSERT INTO platform.ebay_account_deletion_notice (notification_id, user_id_sha256, event_date, publish_attempt, accounts_deleted)
  VALUES ('syn-notice-shape-0001', convert_to('syn_user', 'UTF8'), now(), 1, 1) $q$, 'ebay_account_deletion_notice_hash_len');
SELECT pg_temp.expect_fail('an eBay deletion notice with no publish attempt (Р-192)', $q$
  INSERT INTO platform.ebay_account_deletion_notice (notification_id, user_id_sha256, event_date, publish_attempt, accounts_deleted)
  VALUES ('syn-notice-shape-0002', sha256('\x00'), now(), 0, 1) $q$, 'ebay_account_deletion_notice_attempt');
SELECT pg_temp.expect_fail('an eBay deletion notice with a negative count of deleted accounts (Р-192)', $q$
  INSERT INTO platform.ebay_account_deletion_notice (notification_id, user_id_sha256, event_date, publish_attempt, accounts_deleted)
  VALUES ('syn-notice-shape-0003', sha256('\x00'), now(), 1, -1) $q$, 'ebay_account_deletion_notice_accounts');
SELECT pg_temp.expect_fail('an eBay deletion notice in a seller tenant (Р-192)', $q$
  INSERT INTO platform.ebay_account_deletion_notice (tenant_id, notification_id, user_id_sha256, event_date, publish_attempt, accounts_deleted)
  VALUES ('a0000000-0000-0000-0000-00000000000a', 'syn-notice-shape-0004', sha256('\x00'), now(), 1, 1) $q$, 'ebay_account_deletion_notice_platform_tenant');
ROLLBACK;

-- ================================================================ Р-190 (находка 9 ревью): «подтверждено своей записью» — только у применённой
BEGIN;
SELECT pg_temp.expect_fail('a write confirmed by our own offer record that was not applied (Р-190)', $q$
  INSERT INTO tenant_data.channel_write_history SELECT (jsonb_populate_record(h, jsonb_build_object(
      'channel_write_id', gen_random_uuid(), 'confirmed_by_own_record', true))).*
    FROM tenant_data.channel_write_history h WHERE h.final_status <> 'APPLIED' LIMIT 1 $q$,
  'channel_write_history_own_record_only_applied');
ROLLBACK;
