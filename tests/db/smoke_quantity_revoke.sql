-- Шаг 61 [Р-202]: отзыв подтверждения записи количества. Тем же порядком, что выдача: владелец, набранный идентификатор аккаунта,
-- строка журнала, аудит. С момента отзыва запись количества выключена сразу: синхронизация количества у единиц аккаунта выключена,
-- неотправленные версии сняты, повтор уже ушедшей записи в канал не идёт; повторное включение — только новым подтверждением.
-- Административной ролью (отзывает человек); одна откатываемая транзакция — мир следующих файлов не меняется.
\set ON_ERROR_STOP 1
\set QUIET 1

\i tests/db/smoke_helpers.sql

\set tA '''a0000000-0000-0000-0000-00000000000a'''
\set ownerM '''a2000000-0000-0000-0000-00000000000a'''
\set ownerU '''a1000000-0000-0000-0000-00000000000a'''
\set kAcc '''a4000000-0000-0000-0000-000000000001'''
\set rScope1 '''a6610000-0000-4000-8000-000000000001'''
\set rScope2 '''a6610000-0000-4000-8000-000000000002'''
\set rScope3 '''a6610000-0000-4000-8000-000000000003'''

BEGIN;
SELECT set_config('app.tenant_id', :tA, true), set_config('app.user_id', :ownerU, true) \gset

-- ---------------------------------------------------------------- мир: аккаунт Kaufland подтверждён (smoke_app), три единицы количества
-- Синхронизация остатка требует действующего буфера канала [Р-6]
INSERT INTO tenant_data.stock_allocation (tenant_id, scope_type, channel_account_id, buffer_units, version, created_by_membership_id)
VALUES (:tA, 'CHANNEL_ACCOUNT', :kAcc, 1, 1, :ownerM);
INSERT INTO tenant_data.write_scope (tenant_id, write_scope_id, channel_account_id, channel, field, product_id, capability_id, capability_version,
  scope_kind, scope_key, quantity_sync_enabled)
VALUES (:tA, :rScope1, :kAcc, 'KAUFLAND', 'QUANTITY', 'a5000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000011', 1,
        'ACCOUNT_OFFER', '["a4000000-0000-0000-0000-000000000001", "OFF-61A"]', true),
       (:tA, :rScope2, :kAcc, 'KAUFLAND', 'QUANTITY', 'a5000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000011', 1,
        'ACCOUNT_OFFER', '["a4000000-0000-0000-0000-000000000001", "OFF-61B"]', true),
       (:tA, :rScope3, :kAcc, 'KAUFLAND', 'QUANTITY', 'a5000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000011', 1,
        'ACCOUNT_OFFER', '["a4000000-0000-0000-0000-000000000001", "OFF-61C"]', true);
-- Первая запись в полёте на момент отзыва: её уже не вернуть
INSERT INTO tenant_data.channel_write (tenant_id, channel_write_id, write_scope_id, field, quantity, version, origin)
VALUES (:tA, 'a9610000-0000-4000-8000-000000000001', :rScope1, 'QUANTITY', 7, 1, 'STOCK_RECALC');
UPDATE tenant_data.channel_write SET status = 'DISPATCHED', attempt_count = 1 WHERE channel_write_id = 'a9610000-0000-4000-8000-000000000001';
-- Вторая ушла, получила отказ канала и ждёт повтора
INSERT INTO tenant_data.channel_write (tenant_id, channel_write_id, write_scope_id, field, quantity, version, origin)
VALUES (:tA, 'a9610000-0000-4000-8000-000000000002', :rScope2, 'QUANTITY', 3, 1, 'STOCK_RECALC');
UPDATE tenant_data.channel_write SET status = 'DISPATCHED', attempt_count = 1 WHERE channel_write_id = 'a9610000-0000-4000-8000-000000000002';
UPDATE tenant_data.channel_write SET status = 'FAILED', last_error_code = 'KFL_5XX' WHERE channel_write_id = 'a9610000-0000-4000-8000-000000000002';
-- Третья ждёт отправки
INSERT INTO tenant_data.channel_write (tenant_id, channel_write_id, write_scope_id, field, quantity, version, origin)
VALUES (:tA, 'a9610000-0000-4000-8000-000000000003', :rScope3, 'QUANTITY', 9, 1, 'STOCK_RECALC');

-- ---------------------------------------------------------------- кто отзывает
-- Администратор: право MANAGE_TENANT у него есть, поэтому отказывает именно правило «только владелец»
SELECT pg_temp.expect_fail('quantity writes revoked by a non-owner (Р-202)', $q$
  DO $d$ BEGIN
    PERFORM set_config('app.user_id', 'a1000000-0000-0000-0000-0000000000ad', true);
    INSERT INTO tenant_data.channel_quantity_writes_confirmation (tenant_id, channel_account_id, typed_confirmation, confirmed_by_membership_id, action)
    VALUES ('a0000000-0000-0000-0000-00000000000a', 'a4000000-0000-0000-0000-000000000001', 'seller-A', 'a2000000-0000-0000-0000-0000000000ad', 'REVOKE');
  END $d$ $q$, 'only the owner confirms or revokes quantity writes');
SELECT pg_temp.expect_fail('quantity writes revoked with a mistyped account (Р-202)', format($q$
  INSERT INTO tenant_data.channel_quantity_writes_confirmation (tenant_id, channel_account_id, typed_confirmation, confirmed_by_membership_id, action)
  VALUES (%L, %L, 'seller-B', %L, 'REVOKE') $q$, :tA, :kAcc, :ownerM), 'the typed confirmation does not name the channel account');
SELECT pg_temp.expect_fail('a journal row of an unknown action (Р-202)', format($q$
  INSERT INTO tenant_data.channel_quantity_writes_confirmation (tenant_id, channel_account_id, typed_confirmation, confirmed_by_membership_id, action)
  VALUES (%L, %L, 'seller-A', %L, 'PAUSE') $q$, :tA, :kAcc, :ownerM), 'channel_quantity_writes_confirmation_action_known');

-- ---------------------------------------------------------------- отзыв
SELECT pg_temp.ok('the owner revokes quantity writes with the typed account (Р-202)', format($q$
  INSERT INTO tenant_data.channel_quantity_writes_confirmation (tenant_id, channel_account_id, typed_confirmation, confirmed_by_membership_id, action)
  VALUES (%L, %L, ' seller-A ', %L, 'REVOKE') $q$, :tA, :kAcc, :ownerM));
SELECT pg_temp.ok('a revocation switches quantity sync of the account off at once (Р-202)', $q$
  DO $d$ BEGIN
    IF (SELECT quantity_writes_confirmed FROM tenant_data.channel_account WHERE channel_account_id = 'a4000000-0000-0000-0000-000000000001') THEN
      RAISE EXCEPTION 'the account is still confirmed after the revocation';
    END IF;
    IF EXISTS (SELECT 1 FROM tenant_data.write_scope WHERE channel_account_id = 'a4000000-0000-0000-0000-000000000001' AND field = 'QUANTITY' AND quantity_sync_enabled) THEN
      RAISE EXCEPTION 'quantity sync stays on after the revocation';
    END IF;
  END $d$ $q$);
SELECT pg_temp.ok('a revocation discards the unsent quantity versions with its reason (Р-202)', $q$
  DO $d$
  DECLARE h record;
  BEGIN
    IF EXISTS (SELECT 1 FROM tenant_data.channel_write WHERE channel_write_id IN ('a9610000-0000-4000-8000-000000000002', 'a9610000-0000-4000-8000-000000000003')) THEN
      RAISE EXCEPTION 'an unsent quantity version waits in the queue after the revocation';
    END IF;
    FOR h IN SELECT final_status, end_reason FROM tenant_data.channel_write_history
              WHERE channel_write_id IN ('a9610000-0000-4000-8000-000000000002', 'a9610000-0000-4000-8000-000000000003') LOOP
      IF h.final_status <> 'DISCARDED_STALE' OR h.end_reason <> 'QUANTITY_WRITES_REVOKED' THEN
        RAISE EXCEPTION 'an unsent quantity version is ended as %/% instead of by the revocation', h.final_status, h.end_reason;
      END IF;
    END LOOP;
    IF (SELECT count(*) FROM tenant_data.channel_write_history
         WHERE channel_write_id IN ('a9610000-0000-4000-8000-000000000002', 'a9610000-0000-4000-8000-000000000003')) <> 2 THEN
      RAISE EXCEPTION 'the discarded quantity versions are not in the history';
    END IF;
    -- Ушедшая запись не отзывается: её не вернуть
    IF (SELECT status FROM tenant_data.channel_write WHERE channel_write_id = 'a9610000-0000-4000-8000-000000000001') <> 'DISPATCHED' THEN
      RAISE EXCEPTION 'the revocation rewrote a write that had already left';
    END IF;
  END $d$ $q$);
SELECT pg_temp.expect_fail('quantity writes revoked twice (Р-202)', format($q$
  INSERT INTO tenant_data.channel_quantity_writes_confirmation (tenant_id, channel_account_id, typed_confirmation, confirmed_by_membership_id, action)
  VALUES (%L, %L, 'seller-A', %L, 'REVOKE') $q$, :tA, :kAcc, :ownerM), 'nothing to revoke');
SELECT pg_temp.expect_fail('quantity sync switched back on without a new confirmation (Р-202)', format($q$
  UPDATE tenant_data.write_scope SET quantity_sync_enabled = true WHERE tenant_id = %L AND write_scope_id = %L $q$, :tA, :rScope1),
  'are not confirmed by the owner');

-- ---------------------------------------------------------------- повтор ушедшей записи после отзыва
SELECT pg_temp.ok('the channel refuses the write that was in flight at the revocation (подготовка)', $q$
  UPDATE tenant_data.channel_write SET status = 'FAILED', last_error_code = 'KFL_TIMEOUT' WHERE channel_write_id = 'a9610000-0000-4000-8000-000000000001' $q$);
SELECT pg_temp.expect_fail('a retry sends quantity after the revocation (Р-202)', $q$
  UPDATE tenant_data.channel_write SET status = 'DISPATCHED', attempt_count = 2 WHERE channel_write_id = 'a9610000-0000-4000-8000-000000000001' $q$,
  'no quantity is sent');
-- Диспетчер распознаёт отказ и завершает запись этой причиной — база её принимает
SELECT pg_temp.ok('a write that had left is ended with the revocation reason (Р-202)', $q$
  UPDATE tenant_data.channel_write SET status = 'DISCARDED_STALE', end_reason = 'QUANTITY_WRITES_REVOKED',
         end_params = '{"channelAccountId": "a4000000-0000-0000-0000-000000000001"}'::jsonb, next_attempt_at = NULL
   WHERE channel_write_id = 'a9610000-0000-4000-8000-000000000001' $q$);

-- ---------------------------------------------------------------- повторное включение — только новым подтверждением
SELECT pg_temp.ok('the owner confirms quantity writes again after a revocation (Р-202)', format($q$
  INSERT INTO tenant_data.channel_quantity_writes_confirmation (tenant_id, channel_account_id, typed_confirmation, confirmed_by_membership_id)
  VALUES (%L, %L, 'seller-A', %L) $q$, :tA, :kAcc, :ownerM));
SELECT pg_temp.expect_fail('quantity writes confirmed twice (Р-202)', format($q$
  INSERT INTO tenant_data.channel_quantity_writes_confirmation (tenant_id, channel_account_id, typed_confirmation, confirmed_by_membership_id)
  VALUES (%L, %L, 'seller-A', %L) $q$, :tA, :kAcc, :ownerM), 'are already confirmed');
SELECT pg_temp.ok('quantity sync is switched on again after the new confirmation (Р-202)', format($q$
  UPDATE tenant_data.write_scope SET quantity_sync_enabled = true WHERE tenant_id = %L AND write_scope_id = %L $q$, :tA, :rScope1));
SELECT pg_temp.ok('the revocation and the new confirmation are in the audit log (Р-202)', $q$
  DO $d$ BEGIN
    IF (SELECT count(*) FROM audit.audit_event WHERE entity_type LIKE '%channel_quantity_writes_confirmation' AND occurred_at >= now()
          AND actor_user_id = 'a1000000-0000-0000-0000-00000000000a') < 2 THEN
      RAISE EXCEPTION 'the revocation or the new confirmation is not in the audit log';
    END IF;
  END $d$ $q$);

ROLLBACK;
