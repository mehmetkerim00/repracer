-- Р-256 (шаг 176): база, где клиентский тенант — только amazon.com. Выполнять БЕЗ PGUSER (суперпользователем) после smoke_live_writes.sql:
-- настройку базы ставит владелец базы (`ALTER DATABASE … SET repracer.client_channels`), а действия идут административной ролью через SET ROLE.
-- Файл целиком — одна транзакция с откатом: настройка и строки в смоук-мире не остаются. Данные синтетические.
--
-- Проверяется:
--   1) у тенанта не демо аккаунт канала заводится только на amazon.com: eBay, Kaufland, amazon.de и пустой список витрин — отказ своей причиной;
--   2) витрины уже заведённого аккаунта amazon.com не расширяются за amazon.com;
--   3) подключение (запрос согласия OAuth) к другому каналу не начинается;
--   4) настройку видит только уровень БАЗЫ: `SET` в сессии её не снимает; незнакомое значение сужает (fail-closed), открывает только `all`;
--   5) демо-тенант — исключение: симуляторная витрина держит три канала.
\set ON_ERROR_STOP 1
\set QUIET 1

\i tests/db/smoke_helpers.sql

\set tA '''a0000000-0000-0000-0000-00000000000a'''
\set ownerM '''a2000000-0000-0000-0000-00000000000a'''
\set ownerU '''a1000000-0000-0000-0000-00000000000a'''
\set tD '''d0000000-0000-0000-0000-00000000000d'''
\set demoM '''d2000000-0000-0000-0000-00000000000d'''
\set demoU '''d1000000-0000-0000-0000-00000000000d'''
\set amazonUs '''a4560000-0000-4000-8000-000000000001'''

CREATE FUNCTION pg_temp.client_channels(v text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF v IS NULL THEN
    EXECUTE format('ALTER DATABASE %I RESET repracer.client_channels', current_database());
  ELSE
    EXECUTE format('ALTER DATABASE %I SET repracer.client_channels = %L', current_database(), v);
  END IF;
END $$;

BEGIN;

SELECT pg_temp.client_channels('amazon_us');

-- --------------------------------------------------------------- 1) аккаунт канала клиента — только amazon.com
SET ROLE repracer_admin;
SELECT set_config('app.tenant_id', :tA, false), set_config('app.user_id', :ownerU, false), set_config('app.auth_mfa', 'on', false) \gset
SELECT pg_temp.expect_fail('a client tenant connects an eBay account on a database with client channels Amazon US only (R-256)', format($q$
  INSERT INTO tenant_data.channel_account (tenant_id, channel_account_id, channel, external_account_id, marketplaces, credentials_ref, connected_by_membership_id)
  VALUES (%L, 'a4560000-0000-4000-8000-000000000002', 'EBAY', 'seller-ebay-176', ARRAY['EBAY_US'], 'vault://a/ebay-176', %L) $q$, :tA, :ownerM),
  'client channels are Amazon US only on this database: tenant a0000000-0000-0000-0000-00000000000a is a client tenant, EBAY {EBAY_US}');
SELECT pg_temp.expect_fail('a client tenant connects amazon.de on a database with client channels Amazon US only (R-256)', format($q$
  INSERT INTO tenant_data.channel_account (tenant_id, channel_account_id, channel, region, external_account_id, marketplaces, credentials_ref, connected_by_membership_id)
  VALUES (%L, 'a4560000-0000-4000-8000-000000000003', 'AMAZON', 'EU', 'seller-de-176', ARRAY['A1PA6795UKMFR9'], 'vault://a/de-176', %L) $q$, :tA, :ownerM),
  'client channels are Amazon US only on this database: tenant a0000000-0000-0000-0000-00000000000a is a client tenant, AMAZON {A1PA6795UKMFR9}');
SELECT pg_temp.expect_fail('an account without storefronts is not Amazon US (R-256, fail-closed)', format($q$
  INSERT INTO tenant_data.channel_account (tenant_id, channel_account_id, channel, region, external_account_id, marketplaces, credentials_ref, connected_by_membership_id)
  VALUES (%L, 'a4560000-0000-4000-8000-000000000004', 'AMAZON', 'NA', 'seller-none-176', ARRAY[]::text[], 'vault://a/none-176', %L) $q$, :tA, :ownerM),
  'client channels are Amazon US only on this database');
-- amazon.com — можно: рамка MVP сужает, а не закрывает
SELECT pg_temp.ok('a client tenant connects amazon.com on a database with client channels Amazon US only (R-256)', format($q$
  INSERT INTO tenant_data.channel_account (tenant_id, channel_account_id, channel, region, external_account_id, marketplaces, credentials_ref, connected_by_membership_id)
  VALUES (%L, %L, 'AMAZON', 'NA', 'seller-us-176', ARRAY['ATVPDKIKX0DER'], 'vault://a/us-176', %L) $q$, :tA, :amazonUs, :ownerM));

-- --------------------------------------------------------------- 2) витрины заведённого аккаунта amazon.com не расширяются
SELECT pg_temp.expect_fail('a client amazon.com account gains a European storefront on a database with client channels Amazon US only (R-256)', format($q$
  UPDATE tenant_data.channel_account SET marketplaces = ARRAY['ATVPDKIKX0DER', 'A1PA6795UKMFR9'] WHERE tenant_id = %L AND channel_account_id = %L $q$, :tA, :amazonUs),
  'client channels are Amazon US only on this database: tenant a0000000-0000-0000-0000-00000000000a is a client tenant, AMAZON {ATVPDKIKX0DER,A1PA6795UKMFR9}');

-- --------------------------------------------------------------- 3) подключение к другому каналу не начинается
SELECT pg_temp.expect_fail('a client tenant starts an eBay authorization on a database with client channels Amazon US only (R-256)', format($q$
  INSERT INTO tenant_data.channel_authorization_request (tenant_id, channel, region, marketplaces, state_sha256, requested_by_membership_id, expires_at)
  VALUES (%L, 'EBAY', NULL, ARRAY['EBAY_US'], sha256('state-176-ebay'), %L, now() + interval '10 minutes') $q$, :tA, :ownerM),
  'client channels are Amazon US only on this database: tenant a0000000-0000-0000-0000-00000000000a is a client tenant, EBAY {EBAY_US}');
SELECT pg_temp.ok('a client tenant starts an amazon.com authorization on a database with client channels Amazon US only (R-256)', format($q$
  INSERT INTO tenant_data.channel_authorization_request (tenant_id, channel, region, marketplaces, state_sha256, requested_by_membership_id, expires_at)
  VALUES (%L, 'AMAZON', 'NA', ARRAY['ATVPDKIKX0DER'], sha256('state-176-us'), %L, now() + interval '10 minutes') $q$, :tA, :ownerM));

-- --------------------------------------------------------------- 4) настройку снимает только владелец базы; незнакомое значение сужает
SELECT set_config('repracer.client_channels', 'all', false) \gset
SELECT pg_temp.expect_fail('a session SET does not lift the client channels guard (R-256)', format($q$
  INSERT INTO tenant_data.channel_account (tenant_id, channel_account_id, channel, external_account_id, marketplaces, credentials_ref, connected_by_membership_id)
  VALUES (%L, 'a4560000-0000-4000-8000-000000000005', 'KAUFLAND', 'seller-kfl-176', ARRAY['de'], 'vault://a/kfl-176', %L) $q$, :tA, :ownerM),
  'client channels are Amazon US only on this database');
RESET repracer.client_channels;
RESET ROLE;
SELECT pg_temp.client_channels('amazon');
SET ROLE repracer_admin;
SELECT set_config('app.tenant_id', :tA, false), set_config('app.user_id', :ownerU, false), set_config('app.auth_mfa', 'on', false) \gset
SELECT pg_temp.expect_fail('an unknown value of the database setting restricts client channels too (R-256, fail-closed)', format($q$
  INSERT INTO tenant_data.channel_account (tenant_id, channel_account_id, channel, external_account_id, marketplaces, credentials_ref, connected_by_membership_id)
  VALUES (%L, 'a4560000-0000-4000-8000-000000000006', 'EBAY', 'seller-ebay2-176', ARRAY['EBAY_US'], 'vault://a/ebay2-176', %L) $q$, :tA, :ownerM),
  'client channels are Amazon US only on this database');
RESET ROLE;
SELECT pg_temp.client_channels('amazon_us');

-- --------------------------------------------------------------- 5) демо-тенант — исключение: три канала симулятора
SET ROLE repracer_admin;
SELECT set_config('app.tenant_id', :tD, false), set_config('app.user_id', :demoU, false), set_config('app.auth_mfa', 'on', false) \gset
SELECT pg_temp.ok('a demo tenant connects eBay on a database with client channels Amazon US only (R-256)', format($q$
  INSERT INTO tenant_data.channel_account (tenant_id, channel_account_id, channel, external_account_id, marketplaces, credentials_ref, connected_by_membership_id)
  VALUES (%L, 'd4560000-0000-4000-8000-000000000001', 'EBAY', 'demo-ebay-176', ARRAY['EBAY_US'], 'vault://d/ebay-176', %L) $q$, :tD, :demoM));
RESET ROLE;

-- --------------------------------------------------------------- положительный контроль [Р-94]: `all` — тот же eBay клиента проходит
SELECT pg_temp.client_channels('all');
SET ROLE repracer_admin;
SELECT set_config('app.tenant_id', :tA, false), set_config('app.user_id', :ownerU, false), set_config('app.auth_mfa', 'on', false) \gset
SELECT pg_temp.ok('the same eBay account of a client tenant is connected when the database allows all channels (control to R-256)', format($q$
  INSERT INTO tenant_data.channel_account (tenant_id, channel_account_id, channel, external_account_id, marketplaces, credentials_ref, connected_by_membership_id)
  VALUES (%L, 'a4560000-0000-4000-8000-000000000002', 'EBAY', 'seller-ebay-176', ARRAY['EBAY_US'], 'vault://a/ebay-176', %L) $q$, :tA, :ownerM));
RESET ROLE;

ROLLBACK;
