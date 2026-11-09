-- P0-09 (шаг 119): база, где боевые записи запрещены (QA). Выполнять БЕЗ PGUSER (суперпользователем) после smoke_us_digest.sql:
-- настройку базы ставит владелец базы (`ALTER DATABASE … SET repracer.live_writes`), а действия идут ролями работы через SET ROLE.
-- Файл целиком — одна транзакция с откатом: настройка базы в смоук-мире не остаётся и соседние файлы не видят её. Данные синтетические.
--
-- Проверяется:
--   1) у аккаунта не демо-тенанта на такой базе ни одна запись не уходит в канал — отказ перед КАЖДОЙ отправкой своей причиной;
--   2) его нельзя перевести в бой и нельзя завести сразу боевым — та же причина, раньше остальных проверок перевода;
--   3) настройку видит только уровень БАЗЫ: `SET` в сессии её не снимает; незнакомое значение запрещает (fail-closed), разрешает только `allowed`;
--   4) демо-тенант — исключение: его боевой путь на симуляторе тестируется и на QA;
--   5) уйти в тень можно всегда — это безопасная сторона.
\set ON_ERROR_STOP 1
\set QUIET 1

\i tests/db/smoke_helpers.sql

\set tA '''a0000000-0000-0000-0000-00000000000a'''
\set ownerM '''a2000000-0000-0000-0000-00000000000a'''
\set ownerU '''a1000000-0000-0000-0000-00000000000a'''
-- Kaufland тенанта A: боевой после smoke_shadow.sql, запись количества подтверждена (smoke_app.sql)
\set kAcc '''a4000000-0000-0000-0000-000000000001'''
-- Теневой аккаунт тенанта A на витрине `de`: свойства витрины известны или консервативны (smoke_us_digest.sql)
\set shadowAcc '''a4410000-0000-4000-8000-000000000001'''
\set qScope '''a6419000-0000-4000-8000-000000000001'''
\set qWrite '''a9419000-0000-4000-8000-000000000001'''
-- Демо-тенант смоук-мира (smoke_provision.sql): признак демо задан при создании и неизменяем (0115)
\set tD '''d0000000-0000-0000-0000-00000000000d'''
\set demoM '''d2000000-0000-0000-0000-00000000000d'''
\set demoU '''d1000000-0000-0000-0000-00000000000d'''

-- Настройку уровня базы ставит владелец базы; пустое значение снимает её
CREATE FUNCTION pg_temp.live_writes(v text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF v IS NULL THEN
    EXECUTE format('ALTER DATABASE %I RESET repracer.live_writes', current_database());
  ELSE
    EXECUTE format('ALTER DATABASE %I SET repracer.live_writes = %L', current_database(), v);
  END IF;
END $$;

BEGIN;

-- Предусловие мира: боевой аккаунт и теневой аккаунт тенанта A — иначе проверки ниже проверяли бы не то
DO $$
BEGIN
  IF (SELECT write_mode FROM tenant_data.channel_account WHERE channel_account_id = 'a4000000-0000-0000-0000-000000000001') IS DISTINCT FROM 'LIVE'
     OR (SELECT write_mode FROM tenant_data.channel_account WHERE channel_account_id = 'a4410000-0000-4000-8000-000000000001') IS DISTINCT FROM 'SHADOW' THEN
    RAISE EXCEPTION 'the smoke world is not as this file expects: the Kaufland account of tenant A must be LIVE and its shadow account SHADOW';
  END IF;
END $$;

-- Фикстура: своя единица записи количества на боевом аккаунте и запись, ждущая отправки. Своя — чтобы версии и запись в полёте
-- соседних файлов не решали за этот
SET ROLE repracer_admin;
SELECT set_config('app.tenant_id', :tA, false), set_config('app.user_id', :ownerU, false), set_config('app.auth_mfa', 'on', false) \gset
INSERT INTO tenant_data.write_scope (tenant_id, write_scope_id, channel_account_id, channel, field, product_id, capability_id, capability_version,
  scope_kind, scope_key, quantity_sync_enabled)
VALUES (:tA, :qScope, :kAcc, 'KAUFLAND', 'QUANTITY', 'a5000000-0000-0000-0000-000000000001',
  'c0000000-0000-0000-0000-000000000011', 1, 'ACCOUNT_OFFER', '["a4000000-0000-0000-0000-000000000001", "OFF-119"]', true);
INSERT INTO tenant_data.channel_write (tenant_id, channel_write_id, write_scope_id, field, quantity, version, origin)
VALUES (:tA, :qWrite, :qScope, 'QUANTITY', 5, 1, 'STOCK_RECALC');
-- Отложенные стражи единицы записи срабатывают здесь, правами того, кто её завёл: иначе их вызвала бы первая проверка ниже
-- (`SET CONSTRAINTS ALL IMMEDIATE` помощника) правами диспетчера, и отказ пришёл бы не от той защиты [Р-94]
SET CONSTRAINTS ALL IMMEDIATE;
RESET ROLE;

SELECT pg_temp.live_writes('forbidden');

-- --------------------------------------------------------------- 1) отправка: перед КАЖДОЙ отправкой заново, как пол цены [Р-83]
-- Отправку ведёт диспетчер (svc_dispatcher — роли приложения и диспетчера): отказ приходит от базы, а не от того, что процесс сам себя проверил
SET ROLE svc_dispatcher;
SELECT set_config('app.tenant_id', :tA, false), set_config('app.user_id', '', false), set_config('app.auth_mfa', 'off', false) \gset
SELECT pg_temp.expect_fail('dispatching a write of a non-demo LIVE account on a database with live writes forbidden (P0-09)', format($q$
  UPDATE tenant_data.channel_write SET status = 'DISPATCHED', attempt_count = 1 WHERE tenant_id = %L AND channel_write_id = %L $q$, :tA, :qWrite),
  'live writes are forbidden on this database: channel account a4000000-0000-0000-0000-000000000001 of a non-demo tenant sends nothing');

-- 3) Настройку снимает только владелец базы: `SET` в сессии — нет. Иначе страж снимал бы любой, у кого есть соединение
SELECT set_config('repracer.live_writes', 'allowed', false) \gset
SELECT pg_temp.expect_fail('a session SET does not lift the database guard (P0-09)', format($q$
  UPDATE tenant_data.channel_write SET status = 'DISPATCHED', attempt_count = 1 WHERE tenant_id = %L AND channel_write_id = %L $q$, :tA, :qWrite),
  'live writes are forbidden on this database');
RESET repracer.live_writes;
RESET ROLE;

-- --------------------------------------------------------------- 2) перевод в бой и рождение боевым
SET ROLE repracer_admin;
SELECT set_config('app.tenant_id', :tA, false), set_config('app.user_id', :ownerU, false), set_config('app.auth_mfa', 'on', false) \gset
-- Владелец со вторым фактором и верным подтверждением: всё, что требует Р-170, есть — отказывает настройка базы
SELECT pg_temp.expect_fail('switching a non-demo account to LIVE on a database with live writes forbidden (P0-09)', format($q$
  INSERT INTO tenant_data.channel_write_mode_change (tenant_id, channel_account_id, from_mode, to_mode, changed_by_membership_id, typed_confirmation)
  VALUES (%L, %L, 'SHADOW', 'LIVE', %L, 'seller-shadow') $q$, :tA, :shadowAcc, :ownerM),
  'live writes are forbidden on this database: tenant a0000000-0000-0000-0000-00000000000a is not a demo tenant');
SELECT pg_temp.expect_fail('a non-demo channel account born LIVE on a database with live writes forbidden (P0-09)', format($q$
  INSERT INTO tenant_data.channel_account (tenant_id, channel_account_id, channel, external_account_id, marketplaces, credentials_ref, connected_by_membership_id, write_mode)
  VALUES (%L, 'a4419000-0000-4000-8000-000000000001', 'KAUFLAND', 'seller-qa-born', ARRAY['de'], 'vault://a/qa-born', %L, 'LIVE') $q$, :tA, :ownerM),
  'live writes are forbidden on this database: tenant a0000000-0000-0000-0000-00000000000a is not a demo tenant');
RESET ROLE;

-- --------------------------------------------------------------- 3) незнакомое значение запрещает (fail-closed): разрешает только `allowed`
SELECT pg_temp.live_writes('forbiden');
SET ROLE svc_dispatcher;
SELECT set_config('app.tenant_id', :tA, false) \gset
SELECT pg_temp.expect_fail('an unknown value of the database setting forbids live writes too (P0-09, fail-closed)', format($q$
  UPDATE tenant_data.channel_write SET status = 'DISPATCHED', attempt_count = 1 WHERE tenant_id = %L AND channel_write_id = %L $q$, :tA, :qWrite),
  'live writes are forbidden on this database');
RESET ROLE;
SELECT pg_temp.live_writes('forbidden');

-- --------------------------------------------------------------- 4) демо-тенант — исключение: его боевой путь на симуляторе проверяется и на QA
SET ROLE repracer_admin;
SELECT set_config('app.tenant_id', :tD, false), set_config('app.user_id', :demoU, false), set_config('app.auth_mfa', 'on', false) \gset
SELECT pg_temp.ok('a demo channel account is born LIVE on a database with live writes forbidden (P0-09)', format($q$
  INSERT INTO tenant_data.channel_account (tenant_id, channel_account_id, channel, external_account_id, marketplaces, credentials_ref, connected_by_membership_id, write_mode)
  VALUES (%L, 'd4190000-0000-4000-8000-000000000001', 'KAUFLAND', 'demo-qa-born', ARRAY['de'], 'vault://d/qa-born', %L, 'LIVE') $q$, :tD, :demoM));
INSERT INTO tenant_data.channel_account (tenant_id, channel_account_id, channel, external_account_id, marketplaces, credentials_ref, connected_by_membership_id)
VALUES (:tD, 'd4190000-0000-4000-8000-000000000002', 'KAUFLAND', 'demo-qa-shadow', ARRAY['de'], 'vault://d/qa-shadow', :demoM);
SELECT pg_temp.ok('a demo channel account switches to LIVE on a database with live writes forbidden (P0-09)', format($q$
  INSERT INTO tenant_data.channel_write_mode_change (tenant_id, channel_account_id, from_mode, to_mode, changed_by_membership_id, typed_confirmation)
  VALUES (%L, 'd4190000-0000-4000-8000-000000000002', 'SHADOW', 'LIVE', %L, 'demo-qa-shadow') $q$, :tD, :demoM));
RESET ROLE;

-- --------------------------------------------------------------- положительный контроль [Р-94]: `allowed` — те же действия проходят
SELECT pg_temp.live_writes('allowed');
SET ROLE svc_dispatcher;
SELECT set_config('app.tenant_id', :tA, false), set_config('app.user_id', '', false), set_config('app.auth_mfa', 'off', false) \gset
SELECT pg_temp.ok('the same write is dispatched when the database allows live writes (control to P0-09)', format($q$
  UPDATE tenant_data.channel_write SET status = 'DISPATCHED', attempt_count = 1 WHERE tenant_id = %L AND channel_write_id = %L $q$, :tA, :qWrite));
RESET ROLE;
SET ROLE repracer_admin;
SELECT set_config('app.tenant_id', :tA, false), set_config('app.user_id', :ownerU, false), set_config('app.auth_mfa', 'on', false) \gset
SELECT pg_temp.ok('the same account switches to LIVE when the database allows live writes (control to P0-09)', format($q$
  INSERT INTO tenant_data.channel_write_mode_change (tenant_id, channel_account_id, from_mode, to_mode, changed_by_membership_id, typed_confirmation)
  VALUES (%L, %L, 'SHADOW', 'LIVE', %L, 'seller-shadow') $q$, :tA, :shadowAcc, :ownerM));
RESET ROLE;

-- --------------------------------------------------------------- 5) уйти в тень можно и на запрещённой базе — безопасная сторона
SELECT pg_temp.live_writes('forbidden');
SET ROLE repracer_admin;
SELECT set_config('app.tenant_id', :tA, false), set_config('app.user_id', :ownerU, false), set_config('app.auth_mfa', 'off', false) \gset
SELECT pg_temp.ok('a non-demo account goes back to SHADOW on a database with live writes forbidden (P0-09)', format($q$
  INSERT INTO tenant_data.channel_write_mode_change (tenant_id, channel_account_id, from_mode, to_mode, changed_by_membership_id)
  VALUES (%L, %L, 'LIVE', 'SHADOW', %L) $q$, :tA, :shadowAcc, :ownerM));
RESET ROLE;

ROLLBACK;
DO $$ BEGIN RAISE NOTICE 'PASS accept | the database setting of this file is rolled back with it (P0-09)'; END $$;
