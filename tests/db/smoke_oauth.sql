-- Р-175…Р-177 (шаг 43): подключение канала продавцом — запрос согласия, зашифрованный токен, права ролей, отзыв.
-- Выполнять БЕЗ PGUSER (суперпользователем) после smoke_us_digest.sql и до smoke_retention.sql: файл проверяет четыре роли —
-- административную (консоль), путь решения, роль панели и роль адаптеров, — каждую через SET ROLE, чтобы политики строк
-- и права по столбцам работали как в работе. Данные синтетические, мир — тенант A смоука.
\set ON_ERROR_STOP 1
\set QUIET 1

\i tests/db/smoke_helpers.sql
-- Случайные байты без pgcrypto (расширения в базе нет): шифротекст смоука — просто случайный, он ничего не шифрует
CREATE FUNCTION pg_temp.rb(n int) RETURNS bytea LANGUAGE sql VOLATILE AS $$
  SELECT substring(decode(md5(random()::text) || md5(random()::text) || md5(random()::text) || md5(random()::text), 'hex') FROM 1 FOR n)
$$;

\set tA '''a0000000-0000-0000-0000-00000000000a'''
\set ownerM '''a2000000-0000-0000-0000-00000000000a'''
\set ownerU '''a1000000-0000-0000-0000-00000000000a'''
\set oAcc '''a4430000-0000-4000-8000-000000000001'''

-- ================================================================ запрос согласия [Р-175]
-- Сессия — настоящий логин консоли, а не SET ROLE: стражи «человек в сессии» и аудит смотрят на session_user [Р-97]
SET SESSION AUTHORIZATION svc_admin;
SELECT set_config('app.tenant_id', :tA, false), set_config('app.user_id', :ownerU, false), set_config('app.auth_mfa', 'on', false) \gset

SELECT pg_temp.ok('the owner starts an authorization request (Р-175)', format($q$
  INSERT INTO tenant_data.channel_authorization_request (tenant_id, authorization_request_id, channel, region, marketplaces, state_sha256, requested_by_membership_id, expires_at)
  VALUES (%L, 'a4430000-0000-4000-8000-0000000000a1', 'AMAZON', 'EU', ARRAY['A1PA6795UKMFR9'], sha256('state-1'), %L, now() + interval '10 minutes') $q$, :tA, :ownerM));

-- Запрос согласия — административная запись: только от человека в сессии и вся в аудите [Р-97]
SELECT set_config('app.user_id', '', false) \gset
SELECT pg_temp.expect_fail('an authorization request without a person (Р-97)', format($q$
  INSERT INTO tenant_data.channel_authorization_request (tenant_id, channel, region, marketplaces, state_sha256, requested_by_membership_id, expires_at)
  VALUES (%L, 'AMAZON', 'EU', ARRAY['A1PA6795UKMFR9'], sha256('state-noone'), %L, now() + interval '5 minutes') $q$, :tA, :ownerM),
  'without a person');
SELECT pg_temp.expect_fail('closing an authorization request without a person (Р-97)', format($q$
  UPDATE tenant_data.channel_authorization_request SET status = 'FAILED', failure_code = 'x'
   WHERE tenant_id = %L AND authorization_request_id = 'a4430000-0000-4000-8000-0000000000a1' $q$, :tA),
  'without a person');
-- Подключает канал тот, кто управляет тенантом [Р-175]: наблюдатель тенанта запроса не начинает и не закрывает
SELECT set_config('app.user_id', 'a1000000-0000-0000-0000-0000000000a9', false) \gset
SELECT pg_temp.expect_fail('a viewer starts an authorization request (Р-175, Р-100)', format($q$
  INSERT INTO tenant_data.channel_authorization_request (tenant_id, channel, region, marketplaces, state_sha256, requested_by_membership_id, expires_at)
  VALUES (%L, 'AMAZON', 'EU', ARRAY['A1PA6795UKMFR9'], sha256('state-viewer'), 'a2000000-0000-0000-0000-0000000000a9', now() + interval '5 minutes') $q$, :tA),
  'role VIEWER may not MANAGE_TENANT');
SELECT pg_temp.expect_fail('a viewer closes an authorization request (Р-175, Р-100)', format($q$
  UPDATE tenant_data.channel_authorization_request SET status = 'FAILED', failure_code = 'x'
   WHERE tenant_id = %L AND authorization_request_id = 'a4430000-0000-4000-8000-0000000000a1' $q$, :tA),
  'role VIEWER may not MANAGE_TENANT');
SELECT set_config('app.user_id', :ownerU, false) \gset
SELECT pg_temp.ok('starting a request is written to the audit log (Р-97)', format($q$
  DO $inner$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM audit.audit_event WHERE tenant_id = %L AND entity_type = 'tenant_data.channel_authorization_request'
                    AND entity_id = 'a4430000-0000-4000-8000-0000000000a1' AND action = 'admin_change.insert') THEN
      RAISE EXCEPTION 'an authorization request is not in the audit log (Р-97)';
    END IF;
  END $inner$ $q$, :tA));

-- Срок считается от момента вставки, а не от присланного времени: «запрос из будущего» живёт год (находка 11 ревью шага 43)
SELECT pg_temp.expect_fail('an authorization request dated a year ahead (Р-175)', format($q$
  INSERT INTO tenant_data.channel_authorization_request (tenant_id, channel, region, marketplaces, state_sha256, requested_by_membership_id, requested_at, expires_at)
  VALUES (%L, 'AMAZON', 'EU', ARRAY['A1PA6795UKMFR9'], sha256('state-future'), %L, now() + interval '1 year', now() + interval '1 year 5 minutes') $q$, :tA, :ownerM),
  'channel_authorization_request_short_lived');
-- Обмен кода захватывается один раз: второй одновременный возврат его не повторяет (находка 9 ревью шага 43)
SELECT pg_temp.ok('the console claims the code exchange of a request (Р-175)', format($q$
  UPDATE tenant_data.channel_authorization_request SET exchange_started_at = now()
   WHERE tenant_id = %L AND authorization_request_id = 'a4430000-0000-4000-8000-0000000000a1' $q$, :tA));
SELECT pg_temp.expect_fail('claiming the code exchange twice (Р-175)', format($q$
  UPDATE tenant_data.channel_authorization_request SET exchange_started_at = now() + interval '1 second'
   WHERE tenant_id = %L AND authorization_request_id = 'a4430000-0000-4000-8000-0000000000a1' $q$, :tA),
  'is already claimed');

-- Запрос дольше десяти минут — окно для подмены возврата, а не удобство (документация Amazon: поток дольше 10 минут ломается)
SELECT pg_temp.expect_fail('an authorization request that lives thirty minutes (Р-175)', format($q$
  INSERT INTO tenant_data.channel_authorization_request (tenant_id, channel, region, marketplaces, state_sha256, requested_by_membership_id, expires_at)
  VALUES (%L, 'AMAZON', 'EU', ARRAY['A1PA6795UKMFR9'], sha256('state-2'), %L, now() + interval '30 minutes') $q$, :tA, :ownerM),
  'channel_authorization_request_short_lived');
-- В базе только отпечаток state: строка, которая «похожа на state», а не на SHA-256, отклоняется
SELECT pg_temp.expect_fail('an authorization request that keeps the state itself (Р-177)', format($q$
  INSERT INTO tenant_data.channel_authorization_request (tenant_id, channel, region, marketplaces, state_sha256, requested_by_membership_id, expires_at)
  VALUES (%L, 'AMAZON', 'EU', ARRAY['A1PA6795UKMFR9'], convert_to('state-in-clear', 'UTF8'), %L, now() + interval '5 minutes') $q$, :tA, :ownerM),
  'channel_authorization_request_state_is_sha256');
SELECT pg_temp.expect_fail('the same state twice (Р-175)', format($q$
  INSERT INTO tenant_data.channel_authorization_request (tenant_id, channel, region, marketplaces, state_sha256, requested_by_membership_id, expires_at)
  VALUES (%L, 'AMAZON', 'EU', ARRAY['A1PA6795UKMFR9'], sha256('state-1'), %L, now() + interval '5 minutes') $q$, :tA, :ownerM),
  'channel_authorization_request_state_unique');
SELECT pg_temp.expect_fail('an authorization request born completed (Р-175)', format($q$
  INSERT INTO tenant_data.channel_authorization_request (tenant_id, channel, region, marketplaces, state_sha256, requested_by_membership_id, expires_at, status, channel_account_id)
  VALUES (%L, 'AMAZON', 'EU', ARRAY['A1PA6795UKMFR9'], sha256('state-3'), %L, now() + interval '5 minutes', 'COMPLETED', 'a4000000-0000-0000-0000-000000000002') $q$, :tA, :ownerM),
  'starts PENDING');
SELECT pg_temp.expect_fail('an OAuth request for a channel without OAuth (Р-175)', format($q$
  INSERT INTO tenant_data.channel_authorization_request (tenant_id, channel, region, marketplaces, state_sha256, requested_by_membership_id, expires_at)
  VALUES (%L, 'KAUFLAND', NULL, ARRAY['de'], sha256('state-4'), %L, now() + interval '5 minutes') $q$, :tA, :ownerM),
  'channel_authorization_request_channel_oauth');
SELECT pg_temp.expect_fail('an Amazon request without a region (Р-175)', format($q$
  INSERT INTO tenant_data.channel_authorization_request (tenant_id, channel, region, marketplaces, state_sha256, requested_by_membership_id, expires_at)
  VALUES (%L, 'AMAZON', NULL, ARRAY['A1PA6795UKMFR9'], sha256('state-5'), %L, now() + interval '5 minutes') $q$, :tA, :ownerM),
  'channel_authorization_request_region_for_amazon');
SELECT pg_temp.expect_fail('an unknown request status (Р-175)', format($q$
  UPDATE tenant_data.channel_authorization_request SET status = 'MAYBE' WHERE tenant_id = %L AND authorization_request_id = 'a4430000-0000-4000-8000-0000000000a1' $q$, :tA),
  'channel_authorization_request_status_known');
SELECT pg_temp.expect_fail('a completed request that names no account (Р-175)', format($q$
  UPDATE tenant_data.channel_authorization_request SET status = 'COMPLETED' WHERE tenant_id = %L AND authorization_request_id = 'a4430000-0000-4000-8000-0000000000a1' $q$, :tA),
  'channel_authorization_request_completed_names_account');
SELECT pg_temp.expect_fail('a denied request without a code (Р-175)', format($q$
  UPDATE tenant_data.channel_authorization_request SET status = 'DENIED' WHERE tenant_id = %L AND authorization_request_id = 'a4430000-0000-4000-8000-0000000000a1' $q$, :tA),
  'channel_authorization_request_failure_named');
-- Отпечаток state после создания не меняется: иначе запрос «переезжал» бы на чужой возврат
SELECT pg_temp.expect_fail('rewriting the state of a request (Р-177)', format($q$
  UPDATE tenant_data.channel_authorization_request SET state_sha256 = sha256('other') WHERE tenant_id = %L AND authorization_request_id = 'a4430000-0000-4000-8000-0000000000a1' $q$, :tA),
  'may be updated');

-- Возврат, пришедший после срока, отклоняет база: код мог давно уйти кому-то другому
SELECT pg_temp.ok('a short request for the late consent probe (Р-175)', format($q$
  INSERT INTO tenant_data.channel_authorization_request (tenant_id, authorization_request_id, channel, region, marketplaces, state_sha256, requested_by_membership_id, expires_at)
  VALUES (%L, 'a4430000-0000-4000-8000-0000000000a2', 'AMAZON', 'EU', ARRAY['A1PA6795UKMFR9'], sha256('state-late'), %L, now() + interval '20 milliseconds') $q$, :tA, :ownerM));

SELECT pg_sleep(0.1);
SELECT pg_temp.expect_fail('a consent that came back after the request expired (Р-175)', format($q$
  UPDATE tenant_data.channel_authorization_request SET status = 'COMPLETED', channel_account_id = 'a4000000-0000-0000-0000-000000000002'
   WHERE tenant_id = %L AND authorization_request_id = 'a4430000-0000-4000-8000-0000000000a2' $q$, :tA),
  'consent came back too late');
-- Захватить обмен кода после срока тоже нельзя: «поздно» проверяется на входе возврата, до обращения к каналу
SELECT pg_temp.expect_fail('claiming the code exchange of an expired request (Р-175)', format($q$
  UPDATE tenant_data.channel_authorization_request SET exchange_started_at = now()
   WHERE tenant_id = %L AND authorization_request_id = 'a4430000-0000-4000-8000-0000000000a2' $q$, :tA),
  'consent came back too late');

-- ================================================================ токен [Р-177]
-- Аккаунт, подключённый по OAuth: ссылка на учётные данные — база, рождается в тени [Р-170, Р-176]
SELECT pg_temp.ok('an account connected by OAuth is born in the shadow (Р-176)', format($q$
  INSERT INTO tenant_data.channel_account (tenant_id, channel_account_id, channel, region, external_account_id, marketplaces, credentials_ref, connected_by_membership_id)
  VALUES (%L, %L, 'AMAZON', 'EU', 'A3OAUTHSELLER', ARRAY['A1PA6795UKMFR9'], 'db:a4430000-0000-4000-8000-000000000001', %L) $q$, :tA, :oAcc, :ownerM));
SELECT pg_temp.expect_fail('an account that points at the token of another account (Р-177)', format($q$
  INSERT INTO tenant_data.channel_account (tenant_id, channel_account_id, channel, region, external_account_id, marketplaces, credentials_ref, connected_by_membership_id)
  VALUES (%L, 'a4430000-0000-4000-8000-000000000002', 'AMAZON', 'EU', 'A3OTHERSELLER', ARRAY['A1PA6795UKMFR9'], 'db:a4430000-0000-4000-8000-000000000001', %L) $q$, :tA, :ownerM),
  'channel_account_db_credentials_own');
SELECT pg_temp.expect_fail('an eBay account without a known seller goes live (Р-177, E-11)', format($q$
  INSERT INTO tenant_data.channel_account (tenant_id, channel_account_id, channel, external_account_id, marketplaces, credentials_ref, connected_by_membership_id, write_mode)
  VALUES (%L, 'a4430000-0000-4000-8000-000000000003', 'EBAY', 'pending-identity:a4430000-0000-4000-8000-0000000000a9', ARRAY['EBAY_DE'], 'db:a4430000-0000-4000-8000-000000000003', %L, 'LIVE') $q$, :tA, :ownerM),
  'channel_account_pending_identity_not_live');
SELECT pg_temp.ok('the console completes the request with the new account (Р-175)', format($q$
  UPDATE tenant_data.channel_authorization_request SET status = 'COMPLETED', channel_account_id = %L
   WHERE tenant_id = %L AND authorization_request_id = 'a4430000-0000-4000-8000-0000000000a1' $q$, :oAcc, :tA));
-- Завершённый запрос не «переезжает» на другой аккаунт: иначе один возврат согласия подключил бы два
SELECT pg_temp.expect_fail('moving a completed request to another account (Р-175)', format($q$
  UPDATE tenant_data.channel_authorization_request SET channel_account_id = 'a4000000-0000-0000-0000-000000000002'
   WHERE tenant_id = %L AND authorization_request_id = 'a4430000-0000-4000-8000-0000000000a1' $q$, :tA),
  'is already COMPLETED');
SELECT pg_temp.expect_fail('completing a request twice (Р-175)', format($q$
  UPDATE tenant_data.channel_authorization_request SET status = 'FAILED', failure_code = 'x'
   WHERE tenant_id = %L AND authorization_request_id = 'a4430000-0000-4000-8000-0000000000a1' $q$, :tA),
  'is already COMPLETED');

SELECT pg_temp.ok('the console stores the sealed refresh token (Р-177)', format($q$
  INSERT INTO tenant_data.channel_credential (tenant_id, channel_account_id, key_id, iv, auth_tag, ciphertext, created_by_membership_id)
  VALUES (%L, %L, 'k1', pg_temp.rb(12), pg_temp.rb(16), pg_temp.rb(48), %L) $q$, :tA, :oAcc, :ownerM));
-- ОТКРЫТЫЙ токен в базу не кладётся: самая вероятная ошибка — забытое шифрование
SELECT pg_temp.expect_fail('storing a refresh token in the clear (Р-177)', format($q$
  INSERT INTO tenant_data.channel_credential (tenant_id, channel_account_id, key_id, iv, auth_tag, ciphertext, created_by_membership_id)
  VALUES (%L, %L, 'k1', pg_temp.rb(12), pg_temp.rb(16), convert_to('Atzr|syn-plaintext-refresh-token-0043', 'UTF8'), %L) $q$, :tA, :oAcc, :ownerM),
  'channel_credential_not_plaintext');
SELECT pg_temp.expect_fail('a sealed token with a wrong nonce length (Р-177)', format($q$
  INSERT INTO tenant_data.channel_credential (tenant_id, channel_account_id, key_id, iv, auth_tag, ciphertext, created_by_membership_id)
  VALUES (%L, %L, 'k1', pg_temp.rb(11), pg_temp.rb(16), pg_temp.rb(48), %L) $q$, :tA, :oAcc, :ownerM),
  'channel_credential_iv_gcm');
SELECT pg_temp.expect_fail('a sealed token without its authentication tag (Р-177)', format($q$
  INSERT INTO tenant_data.channel_credential (tenant_id, channel_account_id, key_id, iv, auth_tag, ciphertext, created_by_membership_id)
  VALUES (%L, %L, 'k1', pg_temp.rb(12), pg_temp.rb(15), pg_temp.rb(48), %L) $q$, :tA, :oAcc, :ownerM),
  'channel_credential_tag_gcm');
SELECT pg_temp.expect_fail('a key id that is not a key name (Р-177)', format($q$
  INSERT INTO tenant_data.channel_credential (tenant_id, channel_account_id, key_id, iv, auth_tag, ciphertext, created_by_membership_id)
  VALUES (%L, %L, 'K1 = base64 of the key', pg_temp.rb(12), pg_temp.rb(16), pg_temp.rb(48), %L) $q$, :tA, :oAcc, :ownerM),
  'channel_credential_key_id_shape');

-- Консоль токен ЗАПИСЫВАЕТ, но прочитать шифротекст не может: право по столбцам [Р-177, Р-100]
SELECT pg_temp.expect_fail('the administrative role reads the ciphertext (Р-177)',
  $q$ SELECT ciphertext FROM tenant_data.channel_credential $q$, 'permission denied for table channel_credential');
SELECT pg_temp.ok('the administrative role sees that a token exists and when it was obtained (Р-177)',
  $q$ SELECT version, obtained_at, verified_at FROM tenant_data.channel_credential $q$);
SELECT pg_temp.expect_fail('the administrative role rewrites a token (Р-177)', format($q$
  UPDATE tenant_data.channel_credential SET ciphertext = pg_temp.rb(48) WHERE tenant_id = %L $q$, :tA),
  'permission denied for table channel_credential');

-- Новая авторизация — новая версия; прежняя вытесняется БАЗОЙ, и версию считает база
SELECT pg_temp.ok('a second authorization supersedes the first and is numbered by the database (Р-177)', format($q$
  DO $inner$
  DECLARE
    v int[];
    current int;
  BEGIN
    INSERT INTO tenant_data.channel_credential (tenant_id, channel_account_id, key_id, iv, auth_tag, ciphertext, created_by_membership_id)
    VALUES (%L, %L, 'k1', pg_temp.rb(12), pg_temp.rb(16), pg_temp.rb(48), %L);
    SELECT array_agg(version ORDER BY version), count(*) FILTER (WHERE superseded_at IS NULL) INTO v, current
      FROM tenant_data.channel_credential WHERE tenant_id = %L AND channel_account_id = %L;
    IF v <> ARRAY[1, 2] OR current <> 1 THEN
      RAISE EXCEPTION 'versions %% with %% current — expected [1,2] with one current (Р-177)', v, current;
    END IF;
  END $inner$ $q$, :tA, :oAcc, :ownerM, :tA, :oAcc));

SELECT set_config('app.user_id', '', false) \gset
SELECT pg_temp.expect_fail('storing a token without a person (Р-97, Р-177)', format($q$
  INSERT INTO tenant_data.channel_credential (tenant_id, channel_account_id, key_id, iv, auth_tag, ciphertext, created_by_membership_id)
  VALUES (%L, %L, 'k1', pg_temp.rb(12), pg_temp.rb(16), pg_temp.rb(48), %L) $q$, :tA, :oAcc, :ownerM),
  'without a person');
SELECT set_config('app.user_id', 'a1000000-0000-0000-0000-0000000000a9', false) \gset
SELECT pg_temp.expect_fail('a viewer stores a channel token (Р-177, Р-100)', format($q$
  INSERT INTO tenant_data.channel_credential (tenant_id, channel_account_id, key_id, iv, auth_tag, ciphertext, created_by_membership_id)
  VALUES (%L, %L, 'k1', pg_temp.rb(12), pg_temp.rb(16), pg_temp.rb(48), 'a2000000-0000-0000-0000-0000000000a9') $q$, :tA, :oAcc),
  'role VIEWER may not MANAGE_TENANT');
SELECT set_config('app.user_id', :ownerU, false) \gset
-- В аудите — ИМЕНА столбцов, а не значения: шифротекста в журнале нет
SELECT pg_temp.ok('storing a token is written to the audit log without the token (Р-97, Р-177)', format($q$
  DO $inner$
  DECLARE
    ev jsonb;
  BEGIN
    SELECT changes INTO ev FROM audit.audit_event
     WHERE tenant_id = %L AND entity_type = 'tenant_data.channel_credential' AND action = 'admin_change.insert' LIMIT 1;
    IF ev IS NULL THEN
      RAISE EXCEPTION 'storing a token is not in the audit log (Р-97)';
    END IF;
    -- Находка 20 ревью шага 43: в событии — только имена столбцов, фактор и время, значений (и шифротекста) нет
    IF EXISTS (SELECT 1 FROM jsonb_object_keys(ev) k WHERE k NOT IN ('columns', 'secondFactor', 'at')) THEN
      RAISE EXCEPTION 'the audit event of a token carries values: %%', ev;
    END IF;
  END $inner$ $q$, :tA));

RESET SESSION AUTHORIZATION;
-- Путь решения и панель оператора токена не видят вовсе
SET ROLE repracer_app;
SELECT pg_temp.expect_fail('the decision path reads channel tokens (Р-177)',
  $q$ SELECT 1 FROM tenant_data.channel_credential $q$, 'permission denied for table channel_credential');
RESET ROLE;
SET ROLE repracer_operator;
SELECT pg_temp.expect_fail('the operator panel reads channel tokens (Р-177, Р-165)',
  $q$ SELECT 1 FROM tenant_data.channel_credential $q$, 'permission denied');
RESET ROLE;

-- Находка 1 ревью шага 43: шифротекст не читает НИ ОДИН вход, кроме роли адаптеров, — ни прямо, ни через членство
-- (роль удаления по сроку, в которой состоят планировщик и пул консоли, читала его целиком)
SELECT pg_temp.ok('no login role except the adapter role reads the ciphertext of channel tokens (Р-177)', $q$
  DO $inner$
  DECLARE
    readers text;
  BEGIN
    SELECT string_agg(r.rolname, ', ' ORDER BY r.rolname) INTO readers
      FROM pg_roles r
     WHERE r.rolcanlogin AND NOT r.rolsuper AND NOT pg_has_role(r.oid, 'repracer_credentials', 'MEMBER')
       AND has_column_privilege(r.oid, 'tenant_data.channel_credential', 'ciphertext', 'SELECT');
    IF readers IS NOT NULL THEN
      RAISE EXCEPTION 'login roles read the ciphertext of channel tokens: %', readers;
    END IF;
  END $inner$ $q$);

-- ================================================================ роль адаптеров [Р-177]
SET ROLE repracer_credentials;
SELECT pg_temp.ok('the adapter role reads the ciphertext (Р-177)', format($q$
  SELECT ciphertext, iv, auth_tag, key_id FROM tenant_data.channel_credential WHERE tenant_id = %L AND superseded_at IS NULL $q$, :tA));
-- Шифротекст неизменяем и для неё: новая авторизация — новая версия от человека
SELECT pg_temp.expect_fail('the adapter role rewrites a token (Р-177)', format($q$
  UPDATE tenant_data.channel_credential SET ciphertext = pg_temp.rb(48) WHERE tenant_id = %L $q$, :tA),
  'permission denied for table channel_credential');
-- Находка 21 ревью шага 43: статус аккаунта и алерты роль адаптеров напрямую не трогает — только вызовом проверки
SELECT pg_temp.expect_fail('the adapter role sets the auth status of an account directly (Р-177)', format($q$
  UPDATE tenant_data.channel_account SET auth_status = 'ACTIVE' WHERE tenant_id = %L AND channel_account_id = %L $q$, :tA, :oAcc),
  'permission denied for table channel_account');
SELECT pg_temp.expect_fail('the adapter role raises an alert directly (Р-177)', format($q$
  INSERT INTO tenant_data.alert (tenant_id, code, severity, details) VALUES (%L, 'CHANNEL_AUTHORIZATION_REVOKED', 'CRITICAL', '{}') $q$, :tA),
  'permission denied for table alert');
RESET ROLE;
SET ROLE repracer_credential_keeper;
SELECT pg_temp.expect_fail('a negative count of failed checks (Р-177)', format($q$
  UPDATE tenant_data.channel_credential SET check_failures = -1 WHERE tenant_id = %L AND channel_account_id = %L AND superseded_at IS NULL $q$, :tA, :oAcc),
  'channel_credential_failures_non_negative');
-- Действующая версия одна: «воскресить» вытесненную отметкой нельзя
SELECT pg_temp.expect_fail('two current versions of a token (Р-177)', format($q$
  UPDATE tenant_data.channel_credential SET superseded_at = NULL WHERE tenant_id = %L AND channel_account_id = %L AND version = 1 $q$, :tA, :oAcc),
  'channel_credential_one_current');

RESET ROLE;
SET ROLE repracer_credentials;
-- Итоги проверки обменом токена
SELECT pg_temp.expect_fail('an unknown check outcome (Р-177)', format($q$
  SELECT security.channel_authorization_checked(%L, (SELECT channel_credential_id FROM tenant_data.channel_credential WHERE tenant_id = %L AND channel_account_id = %L AND superseded_at IS NULL), 'FINE') $q$, :tA, :tA, :oAcc),
  'unknown authorization check outcome');
SELECT pg_temp.ok('a successful check marks the token verified (Р-177)', format($q$
  DO $inner$
  DECLARE
    cred uuid := (SELECT channel_credential_id FROM tenant_data.channel_credential WHERE tenant_id = %L AND channel_account_id = %L AND superseded_at IS NULL);
    result text;
  BEGIN
    -- Вызов и проверка — РАЗНЫМИ операторами: подзапрос в одном операторе с вызовом видит снимок до его обновления
    result := security.channel_authorization_checked(%L, cred, 'OK');
    IF result <> 'OK' OR (SELECT verified_at FROM tenant_data.channel_credential WHERE tenant_id = %L AND channel_credential_id = cred) IS NULL THEN
      RAISE EXCEPTION 'a successful check did not mark the token verified (Р-177): %%', result;
    END IF;
  END $inner$ $q$, :tA, :oAcc, :tA, :tA));
SELECT pg_temp.ok('the adapter role records four transient failures (Р-177)', format($q$
  DO $inner$
  DECLARE
    cred uuid := (SELECT channel_credential_id FROM tenant_data.channel_credential WHERE tenant_id = %L AND channel_account_id = %L AND superseded_at IS NULL);
  BEGIN
    PERFORM security.channel_authorization_checked(%L, cred, 'TRANSIENT', 'HTTP_503');
    PERFORM security.channel_authorization_checked(%L, cred, 'TRANSIENT', 'NETWORK');
    PERFORM security.channel_authorization_checked(%L, cred, 'TRANSIENT', 'NETWORK');
    PERFORM security.channel_authorization_checked(%L, cred, 'TRANSIENT', 'NETWORK');
  END $inner$ $q$, :tA, :oAcc, :tA, :tA, :tA, :tA));
RESET ROLE;
-- Проверка — суперпользователем: читать алерты роли адаптеров не нужно, и права на это у неё нет
SELECT pg_temp.ok('three transient failures raise one warning and keep the account connected (Р-177)', format($q$
  DO $inner$
  DECLARE
    warnings int;
    auth text;
  BEGIN
    SELECT count(*) INTO warnings FROM tenant_data.alert
     WHERE tenant_id = %L AND channel_account_id = %L AND code = 'CHANNEL_AUTHORIZATION_CHECK_FAILING';
    SELECT auth_status INTO auth FROM tenant_data.channel_account WHERE tenant_id = %L AND channel_account_id = %L;
    IF warnings <> 1 OR auth <> 'ACTIVE' THEN
      RAISE EXCEPTION 'transient failures: %% warnings, account %% (expected one warning and ACTIVE)', warnings, auth;
    END IF;
  END $inner$ $q$, :tA, :oAcc, :tA, :oAcc));
SET ROLE repracer_credentials;
-- Отзыв продавцом: аккаунт в понятном состоянии и CRITICAL-алерт — доставка отправит его владельцу письмом [Р-156]
SELECT pg_temp.ok('the adapter role records a revoked authorization (Р-177)', format($q$
  DO $inner$
  DECLARE
    cred uuid := (SELECT channel_credential_id FROM tenant_data.channel_credential WHERE tenant_id = %L AND channel_account_id = %L AND superseded_at IS NULL);
  BEGIN
    IF security.channel_authorization_checked(%L, cred, 'REVOKED', 'invalid_grant') <> 'REVOKED' THEN
      RAISE EXCEPTION 'a revoked check was not recorded as revoked';
    END IF;
  END $inner$ $q$, :tA, :oAcc, :tA));
RESET ROLE;
SELECT pg_temp.ok('a revoked authorization moves the account to REVOKED and raises a critical alert (Р-177)', format($q$
  DO $inner$
  BEGIN
    IF (SELECT auth_status FROM tenant_data.channel_account WHERE tenant_id = %L AND channel_account_id = %L) <> 'REVOKED' THEN
      RAISE EXCEPTION 'the account did not move to REVOKED (Р-177)';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM tenant_data.alert WHERE tenant_id = %L AND channel_account_id = %L
                    AND code = 'CHANNEL_AUTHORIZATION_REVOKED' AND severity = 'CRITICAL') THEN
      RAISE EXCEPTION 'no critical alert for the owner (Р-177, Р-156)';
    END IF;
  END $inner$ $q$, :tA, :oAcc, :tA, :oAcc));
-- Хвост шага 43 (шаг 45, 0138): перевод в REVOKED — событие аудита от имени системы; пишет его функция роли аудита
SELECT pg_temp.ok('a revoked authorization is an audit event of the system (step 45)', format($q$
  DO $inner$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM audit.audit_event WHERE tenant_id = %L AND entity_id = %L AND actor_type = 'SYSTEM'
                    AND action = 'channel.authorization_revoked' AND changes ->> 'from' = 'ACTIVE' AND changes ->> 'to' = 'REVOKED') THEN
      RAISE EXCEPTION 'the move to REVOKED left no audit event';
    END IF;
  END $inner$ $q$, :tA, :oAcc));
SET ROLE repracer_credentials;
-- Итог проверки ВЫТЕСНЕННОЙ версии аккаунт не трогает: продавец уже авторизовал заново
SELECT pg_temp.ok('a check of a superseded token changes nothing (Р-177)', format($q$
  DO $inner$
  BEGIN
    IF security.channel_authorization_checked(%L,
         (SELECT channel_credential_id FROM tenant_data.channel_credential WHERE tenant_id = %L AND channel_account_id = %L AND version = 1),
         'REVOKED', 'invalid_grant') <> 'SUPERSEDED' THEN
      RAISE EXCEPTION 'a superseded token was checked as current';
    END IF;
  END $inner$ $q$, :tA, :tA, :oAcc));
RESET ROLE;
-- Хвост шага 43 (шаг 45, 0138): вытесненная версия токена удаляется через 30 суток, не раньше; действующая — никогда.
-- Время — часы базы, поэтому возраст отметки вытеснения задаёт суперпользователь смоука (функция определителя) внутри
-- проверки, а транзакция откатывается. Находка 4 ревью шага 45: версия моложе срока ОБЯЗАНА остаться
BEGIN;
CREATE FUNCTION pg_temp.age_superseded(p_tenant uuid, p_account uuid, p_age interval) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $f$
BEGIN
  SET LOCAL session_replication_role = replica;
  UPDATE tenant_data.channel_credential SET superseded_at = now() - p_age
   WHERE tenant_id = p_tenant AND channel_account_id = p_account AND superseded_at IS NOT NULL;
  SET LOCAL session_replication_role = origin;
END $f$;
GRANT EXECUTE ON FUNCTION pg_temp.age_superseded(uuid, uuid, interval) TO repracer_credentials;
SET LOCAL ROLE repracer_credentials;
SELECT pg_temp.ok('a superseded channel token is deleted after its term, the current one is kept (step 45)', format($q$
  DO $inner$
  DECLARE
    young_purged int;
    young_left int;
    purged int;
    superseded int;
    current_left int;
  BEGIN
    PERFORM pg_temp.age_superseded(%L, %L, interval '1 day');
    young_purged := security.purge_superseded_channel_credentials();
    SELECT count(*) INTO young_left FROM tenant_data.channel_credential WHERE tenant_id = %L AND channel_account_id = %L AND superseded_at IS NOT NULL;
    PERFORM pg_temp.age_superseded(%L, %L, interval '31 days');
    purged := security.purge_superseded_channel_credentials();
    SELECT count(*) FILTER (WHERE superseded_at IS NOT NULL), count(*) FILTER (WHERE superseded_at IS NULL) INTO superseded, current_left
      FROM tenant_data.channel_credential WHERE tenant_id = %L AND channel_account_id = %L;
    IF young_purged <> 0 OR young_left < 1 OR purged < 1 OR superseded <> 0 OR current_left <> 1 THEN
      RAISE EXCEPTION 'term: 1 day old purged %%, left %%; 31 days old purged %%, %% superseded left, %% current (expected 0, >=1, >=1, 0, 1)',
        young_purged, young_left, purged, superseded, current_left;
    END IF;
  END $inner$ $q$, :tA, :oAcc, :tA, :oAcc, :tA, :oAcc, :tA, :oAcc));
ROLLBACK;
-- Действующую версию функция хранителя не удалит, даже если её текст изменят: политика строк — только вытесненные
BEGIN;
SET LOCAL ROLE repracer_credential_keeper;
SELECT pg_temp.ok('the keeper cannot delete the current channel token (step 45)', format($q$
  DO $inner$
  DECLARE
    n int;
  BEGIN
    DELETE FROM tenant_data.channel_credential WHERE tenant_id = %L AND channel_account_id = %L AND superseded_at IS NULL;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 0 THEN
      RAISE EXCEPTION 'the keeper deleted %% current token(s)', n;
    END IF;
  END $inner$ $q$, :tA, :oAcc));
ROLLBACK;

-- Отметку проверки ставит только роль адаптеров: консоль «проверенным» токен не объявит
SET ROLE repracer_admin;
SELECT set_config('app.tenant_id', :tA, false), set_config('app.user_id', :ownerU, false), set_config('app.auth_mfa', 'on', false) \gset
SELECT pg_temp.expect_fail('the console declares a token verified (Р-177)', format($q$
  SELECT security.channel_authorization_checked(%L,
    (SELECT channel_credential_id FROM tenant_data.channel_credential WHERE tenant_id = %L AND channel_account_id = %L AND superseded_at IS NULL), 'OK') $q$, :tA, :tA, :oAcc),
  'permission denied for function channel_authorization_checked');

-- ================================================================ OQ-231: витрина вне справочника держит бой
SELECT pg_temp.expect_fail('a LIVE account with a marketplace outside the reference (OQ-231)', format($q$
  INSERT INTO tenant_data.channel_account (tenant_id, channel_account_id, channel, external_account_id, marketplaces, credentials_ref, connected_by_membership_id, write_mode)
  VALUES (%L, 'a4430000-0000-4000-8000-000000000009', 'KAUFLAND', 'seller-cz', ARRAY['de', 'cz'], 'vault://a/cz', %L, 'LIVE') $q$, :tA, :ownerM),
  'витрины нет в справочнике');
RESET ROLE;

-- ================================================================ OQ-232: удержание полом — только деньги с валютой
SET ROLE repracer_app;
SELECT set_config('app.tenant_id', :tA, false) \gset
-- Строку удержания пишет только триггер намерения: путь решения подделать сумму дайджеста не может (находка 12 ревью шага 43)
SELECT pg_temp.expect_fail('the decision path writes a floor hold directly (Р-173)', format($q$
  INSERT INTO channel_data.floor_hold (tenant_id, price_intent_id, intent_created_at, write_scope_id, currency, below_minor, shadow)
  VALUES (%L, gen_random_uuid(), now(), 'a6000000-0000-0000-0000-000000000001', 'EUR', 100000, true) $q$, :tA),
  'permission denied for table floor_hold');
SELECT pg_temp.expect_fail('the decision path reads floor holds (OQ-232, Р-96)',
  $q$ SELECT 1 FROM channel_data.floor_hold $q$, 'permission denied for table floor_hold');
RESET ROLE;
SET ROLE repracer_floor_hold;
SELECT set_config('app.tenant_id', :tA, false) \gset
SELECT pg_temp.expect_fail('a floor hold without a currency code (OQ-232, Р-71)', format($q$
  INSERT INTO channel_data.floor_hold (tenant_id, price_intent_id, intent_created_at, write_scope_id, currency, below_minor, shadow)
  VALUES (%L, gen_random_uuid(), now(), 'a6000000-0000-0000-0000-000000000001', 'euro', 100, true) $q$, :tA),
  'floor_hold_currency_iso');
SELECT pg_temp.expect_fail('a floor hold that is not below the floor (OQ-232)', format($q$
  INSERT INTO channel_data.floor_hold (tenant_id, price_intent_id, intent_created_at, write_scope_id, currency, below_minor, shadow)
  VALUES (%L, gen_random_uuid(), now(), 'a6000000-0000-0000-0000-000000000001', 'EUR', 0, true) $q$, :tA),
  'floor_hold_below_positive');
RESET ROLE;

-- Строку удержания пишет БАЗА при вставке намерения: стратегия хотела 11,00 €, пол поднял до 12,50 € — удержано 1,50 €.
-- Намерение без цели ниже пола строки не оставляет. Единица записи цены — из смоука теневого режима (a6…09). Суперпользователем и в откатываемой транзакции: мир смоука не меняется
BEGIN;
SELECT pg_temp.ok('the database records how far below the floor the strategy wanted (OQ-232)', format($q$
  DO $inner$
  DECLARE
    held bigint;
    rows int;
    marked boolean;
  BEGIN
    INSERT INTO channel_data.price_intent (tenant_id, price_intent_id, created_at, write_scope_id, trigger_type, proposed_amount_minor, currency, price_basis, inputs, rationale, expires_at, rule_code)
    VALUES (%L, 'a4430000-0000-4000-8000-0000000000f1', now(), 'a6000000-0000-0000-0000-000000000009', 'DIVERGENCE_REASSERT', 1250, 'EUR', 'GROSS', '{}',
            '{"intentClass":"CHANGED","reason":{"code":"CAPPED_AT_MIN_PRICE"},"explanation":[{"code":"BUYBOX_UNDERCUT","params":{"targetMinor":1100,"currency":"EUR"}},{"code":"CAPPED_AT_MIN_PRICE","params":{"targetMinor":1100,"minMinor":1250,"currency":"EUR"}}]}',
            now() + interval '1 hour', 'MATCH_BUYBOX'),
           (%L, 'a4430000-0000-4000-8000-0000000000f2', now(), 'a6000000-0000-0000-0000-000000000009', 'DIVERGENCE_REASSERT', 1300, 'EUR', 'GROSS', '{}',
            '{"intentClass":"CHANGED","reason":{"code":"BUYBOX_UNDERCUT"},"explanation":[{"code":"BUYBOX_UNDERCUT","params":{"targetMinor":1300,"currency":"EUR"}}]}',
            now() + interval '1 hour', 'MATCH_BUYBOX');
    SELECT count(*), max(below_minor), bool_and(shadow) INTO rows, held, marked FROM channel_data.floor_hold WHERE tenant_id = %L
       AND price_intent_id IN ('a4430000-0000-4000-8000-0000000000f1', 'a4430000-0000-4000-8000-0000000000f2');
    IF rows <> 1 OR held <> 150 THEN
      RAISE EXCEPTION 'floor holds: %% rows, %% held — expected one row of 150 (OQ-232)', rows, held;
    END IF;
    -- Признак тени — режим аккаунта единицы записи: сумма дайджеста берёт только тень (OQ-233)
    IF marked IS DISTINCT FROM (SELECT ca.write_mode = 'SHADOW' FROM tenant_data.write_scope ws
        JOIN tenant_data.channel_account ca ON ca.tenant_id = ws.tenant_id AND ca.channel_account_id = ws.channel_account_id
       WHERE ws.write_scope_id = 'a6000000-0000-0000-0000-000000000009') THEN
      RAISE EXCEPTION 'the floor hold does not carry the write mode of its account (OQ-233)';
    END IF;
  END $inner$ $q$, :tA, :tA, :tA));
ROLLBACK;

-- ================================================================ Р-178 (шаг 44): миры тенантов без демо
-- Владелец демо-тенанта состоит в нём ДЕЙСТВУЮЩИМ членом — и мира тенанта у него нет: демо — только гостевой путь
SET ROLE repracer_authenticator;
SELECT pg_temp.ok('the console builds tenant worlds without the demo tenant (Р-178)', $q$
  DO $inner$
  DECLARE
    demo int;
    own int;
  BEGIN
    SELECT count(*) INTO demo FROM security.console_tenant_worlds('d1000000-0000-0000-0000-00000000000d');
    SELECT count(*) INTO own FROM security.console_tenant_worlds('a1000000-0000-0000-0000-00000000000a') WHERE tenant_id = 'a0000000-0000-0000-0000-00000000000a';
    IF demo <> 0 OR own <> 1 THEN
      RAISE EXCEPTION 'tenant worlds: demo owner sees %, owner of tenant A sees own world % time(s)', demo, own;
    END IF;
  END $inner$ $q$);
RESET ROLE;
SET ROLE repracer_app;
SELECT pg_temp.expect_fail('the decision path lists the worlds of a user (Р-178)',
  $q$ SELECT 1 FROM security.console_tenant_worlds('a1000000-0000-0000-0000-00000000000a') $q$, 'permission denied for function console_tenant_worlds');
RESET ROLE;

-- ================================================================ Р-179 (шаг 44): каталог из обнаружения офферов
BEGIN;
SET LOCAL ROLE repracer_app;
SELECT set_config('app.tenant_id', 'a0000000-0000-0000-0000-00000000000a', true) \gset
-- Шаг 45 (Р-104): действующее предложение, чья единица записи выведена из работы (RETIRED), обнаружение не трогает —
-- иначе рождается вторая единица с тем же ключом и второе сопоставление, и такт падает на уникальности сопоставления.
-- Вывод из работы — суперпользователем смоука (функция определителя), чтобы весь сценарий шёл ВНУТРИ своей проверки:
-- сбой подготовки вне неё не засчитывался бы этой проверке [Р-99]
RESET ROLE;
CREATE FUNCTION pg_temp.retire_discovered(p_unit text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $f$
BEGIN
  SET LOCAL session_replication_role = replica;
  UPDATE tenant_data.write_scope SET status = 'RETIRED', retired_at = now()
   WHERE write_scope_id = (SELECT price_write_scope_id FROM tenant_data.offer_mapping WHERE external_unit_id = p_unit);
  SET LOCAL session_replication_role = origin;
END $f$;
SET LOCAL ROLE repracer_app;
SELECT pg_temp.ok('discovered offers become the catalog: only storefronts of the account, once (Р-179)', $q$
  DO $inner$
  DECLARE
    first int;
    again int;
    retired int;
    mode text;
  BEGIN
    PERFORM tenant_data.record_discovered_offers('a0000000-0000-0000-0000-00000000000a', 'a4000000-0000-0000-0000-000000000001',
      '[{"marketplace": "de", "external_unit_id": "944009", "external_sku": null, "channel_product_ref": null, "gtin": null, "condition": "new"}]');
    PERFORM pg_temp.retire_discovered('944009');
    retired := tenant_data.record_discovered_offers('a0000000-0000-0000-0000-00000000000a', 'a4000000-0000-0000-0000-000000000001',
      '[{"marketplace": "de", "external_unit_id": "944009", "external_sku": null, "channel_product_ref": null, "gtin": null, "condition": "new"}]');
    first := tenant_data.record_discovered_offers('a0000000-0000-0000-0000-00000000000a', 'a4000000-0000-0000-0000-000000000001',
      '[{"marketplace": "de", "external_unit_id": "944001", "external_sku": null, "channel_product_ref": "SYN-P-944001", "gtin": null, "condition": "new"},
        {"marketplace": "at", "external_unit_id": "944002", "external_sku": null, "channel_product_ref": "SYN-P-944002", "gtin": null, "condition": "new"}]');
    again := tenant_data.record_discovered_offers('a0000000-0000-0000-0000-00000000000a', 'a4000000-0000-0000-0000-000000000001',
      '[{"marketplace": "de", "external_unit_id": "944001", "external_sku": null, "channel_product_ref": "SYN-P-944001", "gtin": null, "condition": "new"}]');
    SELECT ws.pricing_mode INTO mode FROM tenant_data.offer_mapping om
      JOIN tenant_data.write_scope ws ON ws.tenant_id = om.tenant_id AND ws.write_scope_id = om.price_write_scope_id
     WHERE om.external_unit_id = '944001';
    IF first <> 1 OR again <> 0 OR retired <> 0 OR mode IS DISTINCT FROM 'OFF' THEN
      RAISE EXCEPTION 'catalog from discovery: first %, again %, retired scope %, mode % (expected 1, 0, 0, OFF)', first, again, retired, mode;
    END IF;
  END $inner$ $q$);
ROLLBACK;
-- Находки 2 и 3 ревью шага 44: один `id_offer` Kaufland на двух витринах — ОДИН товар [Р-35]; оффер FBK — CHANNEL
BEGIN;
UPDATE tenant_data.channel_account SET marketplaces = ARRAY['de', 'at'] WHERE channel_account_id = 'a4000000-0000-0000-0000-000000000001';
SET LOCAL ROLE repracer_app;
SELECT set_config('app.tenant_id', 'a0000000-0000-0000-0000-00000000000a', true) \gset
SELECT pg_temp.ok('one Kaufland offer on two storefronts is one product; a channel-fulfilled offer stays out of stock sync (Р-35, Р-179)', $q$
  DO $inner$
  DECLARE
    products int;
    fbk text;
  BEGIN
    PERFORM tenant_data.record_discovered_offers('a0000000-0000-0000-0000-00000000000a', 'a4000000-0000-0000-0000-000000000001',
      '[{"marketplace": "de", "external_unit_id": "944101", "external_offer_id": "SYN-OFFER-944", "external_sku": null, "channel_product_ref": null, "gtin": null, "condition": "new", "fulfillment": "MERCHANT"},
        {"marketplace": "at", "external_unit_id": "944102", "external_offer_id": "SYN-OFFER-944", "external_sku": null, "channel_product_ref": null, "gtin": null, "condition": "new", "fulfillment": "MERCHANT"},
        {"marketplace": "de", "external_unit_id": "944103", "external_offer_id": "SYN-OFFER-945", "external_sku": null, "channel_product_ref": null, "gtin": null, "condition": "new", "fulfillment": "CHANNEL"}]');
    SELECT count(DISTINCT product_id) INTO products FROM tenant_data.offer_mapping WHERE external_offer_id = 'SYN-OFFER-944';
    SELECT fulfillment INTO fbk FROM tenant_data.offer_mapping WHERE external_unit_id = '944103';
    IF products <> 1 OR fbk IS DISTINCT FROM 'CHANNEL' THEN
      RAISE EXCEPTION 'discovered Kaufland offer: % product(s) for one id_offer, fulfillment %', products, fbk;
    END IF;
  END $inner$ $q$);
ROLLBACK;
-- Шаг 69 (OQ-249, Р-3): название из канала называет новый товар и обновляется при следующем обнаружении; название продавца
-- (без отметки чтения) обнаружение не затирает
BEGIN;
CREATE FUNCTION pg_temp.set_seller_title(p_sku text, p_title text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $f$
BEGIN
  SET LOCAL session_replication_role = replica;
  UPDATE tenant_data.product SET title = p_title, title_channel_read_at = NULL WHERE sku = p_sku;
  SET LOCAL session_replication_role = origin;
END $f$;
SET LOCAL ROLE repracer_app;
SELECT set_config('app.tenant_id', 'a0000000-0000-0000-0000-00000000000a', true) \gset
SELECT pg_temp.ok('a channel title names a new product and is refreshed; the seller title is never overwritten (OQ-249, Р-3)', $q$
  DO $inner$
  DECLARE
    t1 text;
    r1 timestamptz;
    t2 text;
    seller text;
  BEGIN
    PERFORM tenant_data.record_discovered_offers('a0000000-0000-0000-0000-00000000000a', 'a4000000-0000-0000-0000-000000000001',
      '[{"marketplace": "de", "external_unit_id": "944301", "external_sku": "SYN-TITLE-1", "channel_product_ref": null, "gtin": null, "condition": "new", "title": "Synthetic channel title A"}]');
    SELECT title, title_channel_read_at INTO t1, r1 FROM tenant_data.product WHERE sku = 'SYN-TITLE-1';
    PERFORM tenant_data.record_discovered_offers('a0000000-0000-0000-0000-00000000000a', 'a4000000-0000-0000-0000-000000000001',
      '[{"marketplace": "de", "external_unit_id": "944301", "external_sku": "SYN-TITLE-1", "channel_product_ref": null, "gtin": null, "condition": "new", "title": "Synthetic channel title B"}]');
    SELECT title INTO t2 FROM tenant_data.product WHERE sku = 'SYN-TITLE-1';
    PERFORM pg_temp.set_seller_title('SYN-TITLE-1', 'Seller title of the product');
    PERFORM tenant_data.record_discovered_offers('a0000000-0000-0000-0000-00000000000a', 'a4000000-0000-0000-0000-000000000001',
      '[{"marketplace": "de", "external_unit_id": "944301", "external_sku": "SYN-TITLE-1", "channel_product_ref": null, "gtin": null, "condition": "new", "title": "Synthetic channel title C"}]');
    SELECT title INTO seller FROM tenant_data.product WHERE sku = 'SYN-TITLE-1';
    IF t1 IS DISTINCT FROM 'Synthetic channel title A' OR r1 IS NULL OR t2 IS DISTINCT FROM 'Synthetic channel title B'
       OR seller IS DISTINCT FROM 'Seller title of the product' THEN
      RAISE EXCEPTION 'channel title: new %, read at %, refreshed %, after the seller named it %', t1, r1, t2, seller;
    END IF;
  END $inner$ $q$);
ROLLBACK;
-- Название из канала, не читавшееся 18 месяцев, стирает удаление по сроку [Р-3]: товар остаётся, название — нет
BEGIN;
UPDATE tenant_data.product SET title = 'Synthetic stale channel title', title_channel_read_at = now() - interval '19 months'
 WHERE product_id = (SELECT product_id FROM tenant_data.product WHERE tenant_id = 'a0000000-0000-0000-0000-00000000000a' ORDER BY sku LIMIT 1);
SELECT maintenance.delete_expired_rows(now()) AS expired \gset
SELECT pg_temp.ok('a channel title not read for 18 months is erased by retention (OQ-249, Р-3)', $q$
  DO $inner$
  BEGIN
    IF EXISTS (SELECT 1 FROM tenant_data.product WHERE title = 'Synthetic stale channel title') THEN
      RAISE EXCEPTION 'a channel title older than 18 months is still kept';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM tenant_data.product WHERE tenant_id = 'a0000000-0000-0000-0000-00000000000a') THEN
      RAISE EXCEPTION 'retention removed the products instead of the stale title';
    END IF;
  END $inner$ $q$);
ROLLBACK;
-- Находка 15 ревью шага 44 (шаг 45, 0138): идемпотентность — по КЛЮЧУ единицы записи, а завершённое предложение
-- возвращается в каталог. Прежняя функция роняла такт нарушением `write_scope_key_uq`, когда то же предложение
-- приходило с SKU, а в первый раз — без него, и держала вне каталога навсегда предложение, выставленное снова
BEGIN;
SET LOCAL ROLE repracer_app;
SELECT set_config('app.tenant_id', 'a0000000-0000-0000-0000-00000000000a', true) \gset
SELECT pg_temp.ok('the same channel unit written differently is catalogued once, by the write scope key (step 45)', $q$
  DO $inner$
  DECLARE
    first int;
    again int;
    scopes int;
  BEGIN
    first := tenant_data.record_discovered_offers('a0000000-0000-0000-0000-00000000000a', 'a4000000-0000-0000-0000-000000000001',
      '[{"marketplace": "de", "external_unit_id": "944201", "external_sku": null, "channel_product_ref": null, "gtin": null, "condition": "new"}]');
    again := tenant_data.record_discovered_offers('a0000000-0000-0000-0000-00000000000a', 'a4000000-0000-0000-0000-000000000001',
      '[{"marketplace": "de", "external_unit_id": "944201", "external_sku": "SYN-SKU-944201", "channel_product_ref": null, "gtin": null, "condition": "new"}]');
    SELECT count(*) INTO scopes FROM tenant_data.write_scope ws
      JOIN tenant_data.offer_mapping om ON om.tenant_id = ws.tenant_id AND om.price_write_scope_id = ws.write_scope_id
     WHERE om.external_unit_id = '944201';
    IF first <> 1 OR again <> 0 OR scopes <> 1 THEN
      RAISE EXCEPTION 'same unit twice: first %, again %, mapped scopes % (expected 1, 0, 1)', first, again, scopes;
    END IF;
  END $inner$ $q$);
ROLLBACK;
BEGIN;
SET LOCAL ROLE repracer_app;
SELECT set_config('app.tenant_id', 'a0000000-0000-0000-0000-00000000000a', true) \gset
SELECT tenant_data.record_discovered_offers('a0000000-0000-0000-0000-00000000000a', 'a4000000-0000-0000-0000-000000000001',
  '[{"marketplace": "de", "external_unit_id": "944301", "external_sku": null, "channel_product_ref": null, "gtin": null, "condition": "new"}]') \gset
RESET ROLE;
-- Канал завершил предложение (строку помечает синхронизация каталога; здесь — суперпользователь смоука)
SET LOCAL session_replication_role = replica;
UPDATE tenant_data.offer_mapping SET status = 'ENDED', ended_at = now() WHERE external_unit_id = '944301';
SET LOCAL session_replication_role = origin;
SET LOCAL ROLE repracer_app;
SELECT pg_temp.ok('an ended offer listed again returns to the catalog on its own write scope (step 45)', $q$
  DO $inner$
  DECLARE
    back int;
    active int;
    scopes int;
  BEGIN
    back := tenant_data.record_discovered_offers('a0000000-0000-0000-0000-00000000000a', 'a4000000-0000-0000-0000-000000000001',
      '[{"marketplace": "de", "external_unit_id": "944301", "external_sku": null, "channel_product_ref": null, "gtin": null, "condition": "new"}]');
    SELECT count(*) FILTER (WHERE status <> 'ENDED'), count(DISTINCT price_write_scope_id) INTO active, scopes
      FROM tenant_data.offer_mapping WHERE external_unit_id = '944301';
    IF back <> 1 OR active <> 1 OR scopes <> 1 THEN
      RAISE EXCEPTION 'ended offer listed again: catalogued %, active %, scopes % (expected 1, 1, 1)', back, active, scopes;
    END IF;
  END $inner$ $q$);
ROLLBACK;
BEGIN;
SET LOCAL ROLE repracer_app;
SELECT set_config('app.tenant_id', 'd0000000-0000-0000-0000-00000000000d', true) \gset
SELECT pg_temp.expect_fail('discovered offers written into the catalog of another tenant (Р-31)', $q$
  SELECT tenant_data.record_discovered_offers('a0000000-0000-0000-0000-00000000000a', 'a4000000-0000-0000-0000-000000000001',
    '[{"marketplace": "de", "external_unit_id": "944003", "external_sku": null, "channel_product_ref": null, "gtin": null, "condition": "new"}]') $q$,
  'is unknown or disconnected');
ROLLBACK;

-- ================================================================ шаг 47 [Р-164]: каталог из обнаружения eBay
-- Листинги eBay попадают в каталог все, с честным статусом: под Inventory API — ACTIVE с единицей записи цены (OFF),
-- немигрированный — MIGRATION_REQUIRED, аукцион — INELIGIBLE; у двух последних единицы записи нет
BEGIN;
SET LOCAL ROLE repracer_app;
SELECT set_config('app.tenant_id', 'a0000000-0000-0000-0000-00000000000a', true) \gset
SELECT pg_temp.ok('eBay listings enter the catalog with an honest write status (step 47, Р-164)', $q$
  DO $inner$
  DECLARE
    first int;
    again int;
    got text;
  BEGIN
    first := tenant_data.record_discovered_offers('a0000000-0000-0000-0000-00000000000a', 'a4000000-0000-0000-0000-000000000003',
      '[{"marketplace": "EBAY_DE", "external_sku": "SYN-EB-47-1", "external_offer_id": "91000000471", "external_listing_id": "110000000471", "listing_format": "FIXED_PRICE", "writable": true, "condition": "new"},
        {"marketplace": "EBAY_DE", "external_sku": "SYN-EB-47-2", "external_listing_id": "110000000472", "listing_format": "FIXED_PRICE", "writable": false, "condition": "new"},
        {"marketplace": "EBAY_DE", "external_sku": "SYN-EB-47-3", "external_listing_id": "110000000473", "listing_format": "AUCTION", "writable": false, "condition": "new"},
        {"marketplace": "EBAY_DE", "external_sku": null, "external_listing_id": "110000000474", "listing_format": "FIXED_PRICE", "writable": false, "condition": "new"}]');
    again := tenant_data.record_discovered_offers('a0000000-0000-0000-0000-00000000000a', 'a4000000-0000-0000-0000-000000000003',
      '[{"marketplace": "EBAY_DE", "external_sku": "SYN-EB-47-2", "external_listing_id": "110000000472", "listing_format": "FIXED_PRICE", "writable": false, "condition": "new"}]');
    SELECT string_agg(coalesce(om.external_sku, 'L:' || om.external_listing_id) || ':' || om.status || ':' || om.ebay_migration_status || ':' || coalesce(ws.pricing_mode, 'no-scope'), ','
                      ORDER BY coalesce(om.external_sku, 'L:' || om.external_listing_id)) INTO got
      FROM tenant_data.offer_mapping om
      LEFT JOIN tenant_data.write_scope ws ON ws.tenant_id = om.tenant_id AND ws.write_scope_id = om.price_write_scope_id
     WHERE om.external_sku LIKE 'SYN-EB-47-%' OR om.external_listing_id = '110000000474';
    -- Находка 3 ревью шага 47: листинг без SKU — тоже в каталоге, по номеру листинга, без единицы записи; повтор его не дублирует
    IF first <> 4 OR again <> 0
       OR got IS DISTINCT FROM 'L:110000000474:MIGRATION_REQUIRED:REQUIRED:no-scope,SYN-EB-47-1:ACTIVE:NOT_REQUIRED:OFF,SYN-EB-47-2:MIGRATION_REQUIRED:REQUIRED:no-scope,SYN-EB-47-3:INELIGIBLE:INELIGIBLE:no-scope' THEN
      RAISE EXCEPTION 'eBay catalog: first %, again %, mappings % (expected 4, 0 and ACTIVE/MIGRATION_REQUIRED/INELIGIBLE)', first, again, got;
    END IF;
    again := tenant_data.record_discovered_offers('a0000000-0000-0000-0000-00000000000a', 'a4000000-0000-0000-0000-000000000003',
      '[{"marketplace": "EBAY_DE", "external_sku": null, "external_listing_id": "110000000474", "listing_format": "FIXED_PRICE", "writable": false, "condition": "new"}]');
    IF again <> 0 THEN RAISE EXCEPTION 'SKU-less eBay listing catalogued twice'; END IF;
    -- Находка 2 ревью шага 47: листинг мигрировали — прежнее «недоступное» сопоставление закрыто, новое пишется
    again := tenant_data.record_discovered_offers('a0000000-0000-0000-0000-00000000000a', 'a4000000-0000-0000-0000-000000000003',
      '[{"marketplace": "EBAY_DE", "external_sku": "SYN-EB-47-2", "external_offer_id": "91000000472", "external_listing_id": "110000000472", "listing_format": "FIXED_PRICE", "writable": true, "condition": "new"}]');
    SELECT string_agg(om.status || ':' || om.ebay_migration_status || ':' || coalesce(ws.pricing_mode, 'no-scope'), ',' ORDER BY om.status) INTO got
      FROM tenant_data.offer_mapping om
      LEFT JOIN tenant_data.write_scope ws ON ws.tenant_id = om.tenant_id AND ws.write_scope_id = om.price_write_scope_id
     WHERE om.external_sku = 'SYN-EB-47-2';
    IF again <> 1 OR got IS DISTINCT FROM 'ACTIVE:NOT_REQUIRED:OFF,ENDED:REQUIRED:no-scope' THEN
      RAISE EXCEPTION 'migrated eBay listing on rediscovery: catalogued %, mappings % (expected 1 and ACTIVE with scope + ENDED)', again, got;
    END IF;
  END $inner$ $q$);
ROLLBACK;

-- Шаг 47 (находка 3 ревью): без SKU — только сопоставление без единицы записи (единицу не даёт страж ключа единицы);
-- без номера листинга сопоставления eBay нет вовсе
BEGIN;
SET LOCAL ROLE repracer_admin;
SELECT set_config('app.tenant_id', 'a0000000-0000-0000-0000-00000000000a', true), set_config('app.user_id', 'a1000000-0000-0000-0000-00000000000a', true) \gset
SELECT pg_temp.expect_fail('an eBay mapping with a write scope but without SKU (step 47)', $q$
  INSERT INTO tenant_data.offer_mapping (tenant_id, product_id, channel_account_id, channel, marketplace, channel_offer_key, external_listing_id,
                                         ebay_listing_format, ebay_migration_status, status, quantity_write_scope_id)
  VALUES ('a0000000-0000-0000-0000-00000000000a', 'a5000000-0000-0000-0000-000000000001', 'a4000000-0000-0000-0000-000000000003', 'EBAY', 'EBAY_DE',
          'syn-no-sku-with-scope', '110000000479', 'FIXED_PRICE', 'NOT_REQUIRED', 'ACTIVE', 'a6000000-0000-0000-0000-000000000003') $q$,
  'offer identity does not produce scope_key');
SELECT pg_temp.expect_fail('an eBay mapping without a listing id (step 47)', $q$
  INSERT INTO tenant_data.offer_mapping (tenant_id, product_id, channel_account_id, channel, marketplace, channel_offer_key, external_sku,
                                         ebay_listing_format, ebay_migration_status, status)
  VALUES ('a0000000-0000-0000-0000-00000000000a', 'a5000000-0000-0000-0000-000000000001', 'a4000000-0000-0000-0000-000000000003', 'EBAY', 'EBAY_DE',
          'syn-no-listing-id', 'SYN-EB-47-9', 'FIXED_PRICE', 'REQUIRED', 'MIGRATION_REQUIRED') $q$,
  'offer_mapping_ebay_identity');
ROLLBACK;

-- ================================================================ находка 12 ревью шага 44: свои проверки новых защит
-- Мир тенанта — только по ДЕЙСТВУЮЩЕМУ членству и только у действующего тенанта
-- Наблюдатель тенанта A видит мир A, пока членство действует; отзыв делает владелец в своей сессии
SET ROLE repracer_authenticator;
SELECT pg_temp.ok('an active viewer sees the world of the tenant (Р-178)', $q$
  DO $inner$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM security.console_tenant_worlds('a1000000-0000-0000-0000-0000000000a9') WHERE tenant_id = 'a0000000-0000-0000-0000-00000000000a') THEN
      RAISE EXCEPTION 'an active viewer does not see the world of tenant A';
    END IF;
  END $inner$ $q$);
RESET ROLE;
BEGIN;
SET SESSION AUTHORIZATION svc_admin;
SELECT set_config('app.tenant_id', :tA, true), set_config('app.user_id', :ownerU, true), set_config('app.auth_mfa', 'on', true) \gset
UPDATE tenant_data.membership SET status = 'REVOKED', revoked_at = now() WHERE membership_id = 'a2000000-0000-0000-0000-0000000000a9';
RESET SESSION AUTHORIZATION;
SET LOCAL ROLE repracer_authenticator;
SELECT pg_temp.ok('a revoked membership gives no tenant world (Р-178)', $q$
  DO $inner$ BEGIN
    IF EXISTS (SELECT 1 FROM security.console_tenant_worlds('a1000000-0000-0000-0000-0000000000a9') WHERE tenant_id = 'a0000000-0000-0000-0000-00000000000a') THEN
      RAISE EXCEPTION 'a revoked member still sees the world of tenant A';
    END IF;
  END $inner$ $q$);
ROLLBACK;
BEGIN;
UPDATE tenant_data.tenant SET status = 'OFFBOARDING', offboarding_requested_at = now() WHERE tenant_id = 'a0000000-0000-0000-0000-00000000000a';
SET LOCAL ROLE repracer_authenticator;
SELECT pg_temp.ok('a tenant being closed gives no tenant world (Р-178)', $q$
  DO $inner$ BEGIN
    IF EXISTS (SELECT 1 FROM security.console_tenant_worlds('a1000000-0000-0000-0000-00000000000a') WHERE tenant_id = 'a0000000-0000-0000-0000-00000000000a') THEN
      RAISE EXCEPTION 'the owner still sees the world of an offboarding tenant';
    END IF;
  END $inner$ $q$);
ROLLBACK;

-- Исполнитель «все тенанты» не берёт демо: его ведёт исполнитель мира демо [Р-178]
BEGIN;
INSERT INTO tenant_data.bulk_job (tenant_id, kind, params, created_by_membership_id, created_by_user_id)
VALUES ('d0000000-0000-0000-0000-00000000000d', 'PRICE_FEED_EXPORT', '{}', 'd2000000-0000-0000-0000-00000000000d', 'd1000000-0000-0000-0000-00000000000d'),
       ('a0000000-0000-0000-0000-00000000000a', 'PRICE_FEED_EXPORT', '{}', 'a2000000-0000-0000-0000-00000000000a', 'a1000000-0000-0000-0000-00000000000a');
SET LOCAL ROLE repracer_bulk_worker;
SELECT pg_temp.ok('the all-tenants worker sees waiting tenants but never the demo tenant (Р-178)', $q$
  DO $inner$
  DECLARE
    demo int;
    own int;
  BEGIN
    SELECT count(*) FILTER (WHERE t = 'd0000000-0000-0000-0000-00000000000d'), count(*) FILTER (WHERE t = 'a0000000-0000-0000-0000-00000000000a')
      INTO demo, own FROM security.bulk_job_waiting_tenants() t;
    IF demo <> 0 OR own <> 1 THEN
      RAISE EXCEPTION 'waiting tenants: demo %, tenant A %', demo, own;
    END IF;
  END $inner$ $q$);
ROLLBACK;
SET ROLE repracer_app;
SELECT pg_temp.expect_fail('the decision path lists tenants with waiting jobs (Р-178)',
  $q$ SELECT 1 FROM security.bulk_job_waiting_tenants() $q$, 'permission denied for function bulk_job_waiting_tenants');
RESET ROLE;

-- Отключённый аккаунт каталога не пишет
BEGIN;
UPDATE tenant_data.channel_account SET disconnected_at = now(), auth_status = 'DISCONNECTED' WHERE channel_account_id = 'a4000000-0000-0000-0000-000000000001';
SET LOCAL ROLE repracer_app;
SELECT set_config('app.tenant_id', 'a0000000-0000-0000-0000-00000000000a', true) \gset
SELECT pg_temp.expect_fail('discovered offers of a disconnected account (Р-179)', $q$
  SELECT tenant_data.record_discovered_offers('a0000000-0000-0000-0000-00000000000a', 'a4000000-0000-0000-0000-000000000001',
    '[{"marketplace": "de", "external_unit_id": "944201", "external_sku": null, "channel_product_ref": null, "gtin": null, "condition": "new"}]') $q$,
  'is unknown or disconnected');
ROLLBACK;

-- Обмен, ЗАХВАЧЕННЫЙ до срока, завершается и чуть позже срока (находка 17 ревью шага 43)
SET SESSION AUTHORIZATION svc_admin;
SELECT set_config('app.tenant_id', :tA, false), set_config('app.user_id', :ownerU, false), set_config('app.auth_mfa', 'on', false) \gset
SELECT pg_temp.ok('a short request claimed in time (Р-175)', format($q$
  INSERT INTO tenant_data.channel_authorization_request (tenant_id, authorization_request_id, channel, region, marketplaces, state_sha256, requested_by_membership_id, expires_at)
  VALUES (%L, 'a4430000-0000-4000-8000-0000000000a5', 'AMAZON', 'EU', ARRAY['A1PA6795UKMFR9'], sha256('state-claimed'), %L, now() + interval '300 milliseconds') $q$, :tA, :ownerM));
SELECT pg_temp.ok('the console claims the exchange before the deadline (Р-175)', format($q$
  UPDATE tenant_data.channel_authorization_request SET exchange_started_at = now()
   WHERE tenant_id = %L AND authorization_request_id = 'a4430000-0000-4000-8000-0000000000a5' $q$, :tA));
SELECT pg_sleep(0.5);
SELECT pg_temp.ok('an exchange claimed in time completes shortly after the deadline (Р-175)', format($q$
  UPDATE tenant_data.channel_authorization_request SET status = 'COMPLETED', channel_account_id = %L
   WHERE tenant_id = %L AND authorization_request_id = 'a4430000-0000-4000-8000-0000000000a5' $q$, :oAcc, :tA));
RESET SESSION AUTHORIZATION;
