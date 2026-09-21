-- Шаг 34 [Р-149, Р-150, Р-151]: онбординг, канал без доступов, демо-тенант. Каждая защита проверяется СВОЕЙ проверкой с её
-- причиной [Р-94, Р-99] и названа строкой каталога мутаций при создании [Р-108]. Данные синтетические.
\set ON_ERROR_STOP 1
\set QUIET 1

\i tests/db/smoke_helpers.sql

\set tA '''a0000000-0000-0000-0000-00000000000a'''
\set owner '''a1000000-0000-0000-0000-00000000000a'''
\set ownerM '''a2000000-0000-0000-0000-00000000000a'''
\set viewer '''a1000000-0000-0000-0000-0000000000a9'''
\set viewerM '''a2000000-0000-0000-0000-0000000000a9'''
\set operator '''a1000000-0000-0000-0000-0000000000a0'''
\set operatorM '''a2000000-0000-0000-0000-0000000000a0'''

SELECT set_config('app.tenant_id', :tA, false), set_config('app.user_id', :owner, false), set_config('app.auth_mfa', 'on', false) \gset

-- --------------------------------------------------------------- Р-150: канал без доступов — честное состояние
-- Ждущий доступа аккаунт обязан НАЗВАТЬ, чего ждёт: «ожидает» без перечня и есть та самая пустота
SELECT pg_temp.expect_fail('a channel account awaiting access without naming what it waits for (Р-150)', format($q$
  INSERT INTO tenant_data.channel_account (tenant_id, channel_account_id, channel, external_account_id, display_name, marketplaces, auth_status, connected_by_membership_id)
  VALUES (%L, 'ca340000-0000-4000-8000-000000000001', 'KAUFLAND', 'demo-seller-1', 'Kaufland без ключей', ARRAY['de'], 'AWAITING_ACCESS', %L) $q$, :tA, :ownerM),
  'channel_account_awaiting_names_blockers');
-- И наоборот: перечень без состояния «ожидает» — противоречие
SELECT pg_temp.expect_fail('an active channel account that names access blockers (Р-150)', format($q$
  INSERT INTO tenant_data.channel_account (tenant_id, channel_account_id, channel, external_account_id, display_name, marketplaces, auth_status, credentials_ref, access_blockers, connected_by_membership_id)
  VALUES (%L, 'ca340000-0000-4000-8000-000000000002', 'KAUFLAND', 'demo-seller-2', 'Kaufland', ARRAY['de'], 'ACTIVE', 'secret-ref:synthetic', ARRAY['PARTNER_REGISTRATION'], %L) $q$, :tA, :ownerM),
  'channel_account_awaiting_names_blockers');
-- Код перечня — только из списка
SELECT pg_temp.expect_fail('a channel account names an access blocker that does not exist (Р-150)', format($q$
  INSERT INTO tenant_data.channel_account (tenant_id, channel_account_id, channel, external_account_id, display_name, marketplaces, auth_status, access_blockers, connected_by_membership_id)
  VALUES (%L, 'ca340000-0000-4000-8000-000000000003', 'KAUFLAND', 'demo-seller-3', 'Kaufland', ARRAY['de'], 'AWAITING_ACCESS', ARRAY['SOMETHING_ELSE'], %L) $q$, :tA, :ownerM),
  'does not exist');
-- Без ключей, но ждёт доступа и называет чего — принимается: это и есть честное состояние
SELECT pg_temp.ok('a channel account awaiting access with named blockers and no credentials (Р-150)', format($q$
  INSERT INTO tenant_data.channel_account (tenant_id, channel_account_id, channel, external_account_id, display_name, marketplaces, auth_status, access_blockers, connected_by_membership_id)
  VALUES (%L, 'ca340000-0000-4000-8000-000000000004', 'KAUFLAND', 'demo-seller-4', 'Kaufland ждёт партнёрства', ARRAY['de'], 'AWAITING_ACCESS', ARRAY['PARTNER_REGISTRATION', 'SELLER_AUTHORIZATION'], %L) $q$, :tA, :ownerM));
-- А активный без ключей — по-прежнему нет
SELECT pg_temp.expect_fail('an active channel account without credentials (Р-150)', format($q$
  INSERT INTO tenant_data.channel_account (tenant_id, channel_account_id, channel, external_account_id, display_name, marketplaces, auth_status, connected_by_membership_id)
  VALUES (%L, 'ca340000-0000-4000-8000-000000000005', 'KAUFLAND', 'demo-seller-5', 'Kaufland', ARRAY['de'], 'ACTIVE', %L) $q$, :tA, :ownerM),
  'channel_account_credentials_unless_no_access');

-- --------------------------------------------------------------- Р-149: прогресс онбординга — административная запись человека
SELECT pg_temp.ok('onboarding progress is started by the owner (Р-149)', format($q$
  INSERT INTO tenant_data.onboarding_progress (tenant_id, updated_by_membership_id)
  VALUES (%L, %L) $q$, :tA, :ownerM));
SELECT pg_temp.ok('starting the onboarding is written to the audit log (Р-97)', format($q$
  DO $x$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM audit.audit_event WHERE entity_type = 'tenant_data.onboarding_progress' AND tenant_id = %L) THEN
      RAISE EXCEPTION 'onboarding progress is not in the audit log';
    END IF;
  END $x$ $q$, :tA));
-- Путь у тенанта один
SELECT pg_temp.expect_fail('a second onboarding path for the same tenant (Р-149)', format($q$
  INSERT INTO tenant_data.onboarding_progress (tenant_id, updated_by_membership_id)
  VALUES (%L, %L) $q$, :tA, :ownerM), 'onboarding_progress_tenant_id_key');
-- Сужение до пустого набора — не сужение
SELECT pg_temp.expect_fail('the onboarding set is narrowed to nothing (Р-131, Р-149)', format($q$
  UPDATE tenant_data.onboarding_progress SET scope_write_scope_ids = '{}' WHERE tenant_id = %L $q$, :tA),
  'onboarding_narrowed_set_not_empty');
-- Состояние пути ВЫВОДИТСЯ из данных: шаг канала видит ждущий аккаунт как «ожидает», а не как «сделано»
SELECT pg_temp.ok('the onboarding status derives the channel step from real accounts (Р-149, Р-150)', format($q$
  DO $x$
  DECLARE s record;
  BEGIN
    SELECT * INTO s FROM tenant_data.onboarding_status(%L) WHERE step = 'CHANNEL';
    IF NOT s.awaiting THEN RAISE EXCEPTION 'the channel step does not report the account awaiting access'; END IF;
    IF s.done_count >= s.total_count THEN RAISE EXCEPTION 'the awaiting account is counted as active'; END IF;
    -- В этом мире есть и рабочие аккаунты: шаг сделан, хотя один канал ждёт — это разные вещи
    IF NOT s.done THEN RAISE EXCEPTION 'an active account exists, yet the channel step is not done'; END IF;
  END $x$ $q$, :tA));

-- --------------------------------------------------------------- Р-149, Р-143: включение движка набора — задание с СВОИМ правом
SELECT set_config('app.user_id', :viewer, false) \gset
SELECT pg_temp.expect_fail('a viewer creates a repricing enablement job (Р-143)', format($q$
  INSERT INTO tenant_data.bulk_job (tenant_id, kind, params, created_by_membership_id)
  VALUES (%L, 'REPRICING_ENABLE', '{}'::jsonb, %L) $q$, :tA, :viewerM), 'needs the right ENABLE_REPRICING');
SELECT set_config('app.user_id', :owner, false) \gset
-- Очередь владельца заполнена предыдущим смоуком: продавец в такой ситуации отменяет своё ждущее задание [OQ-207]
SELECT pg_temp.ok('the owner frees a slot by cancelling their own waiting job (OQ-207)', format($q$
  UPDATE tenant_data.bulk_job SET status = 'CANCELLED', finished_at = now()
   WHERE tenant_id = %L AND bulk_job_id = (SELECT bulk_job_id FROM tenant_data.bulk_job
                                            WHERE tenant_id = %L AND created_by_membership_id = %L AND status = 'PENDING'
                                            ORDER BY created_at LIMIT 1) $q$, :tA, :tA, :ownerM));
SELECT pg_temp.ok('the owner creates a repricing enablement job (Р-149)', format($q$
  INSERT INTO tenant_data.bulk_job (tenant_id, bulk_job_id, kind, params, created_by_membership_id)
  VALUES (%L, 'bf340000-0000-4000-8000-000000000001', 'REPRICING_ENABLE', '{}'::jsonb, %L) $q$, :tA, :ownerM));
/**
 * Своё право — поведением, а не сравнением констант (ревью шага 34, находки 2 и 11а): ОПЕРАТОР включает движок, но цен
 * не правит. Он создаёт включение, ему отказано в правке границ, он отменяет ЧУЖОЕ включение; зритель — нет.
 */
SELECT set_config('app.user_id', :operator, false) \gset
SELECT pg_temp.ok('an operator creates a repricing enablement job (Р-143, Р-149)', format($q$
  INSERT INTO tenant_data.bulk_job (tenant_id, bulk_job_id, kind, params, created_by_membership_id)
  VALUES (%L, 'bf340000-0000-4000-8000-000000000002', 'REPRICING_ENABLE', '{}'::jsonb, %L) $q$, :tA, :operatorM));
SELECT pg_temp.expect_fail('an operator creates a bounds edit job (Р-143)', format($q$
  INSERT INTO tenant_data.bulk_job (tenant_id, kind, params, created_by_membership_id)
  VALUES (%L, 'BOUNDS_EDIT', '{}'::jsonb, %L) $q$, :tA, :operatorM), 'needs the right MANAGE_PRICING');
SELECT pg_temp.ok('an operator cancels the enablement job of another member (Р-143)', format($q$
  UPDATE tenant_data.bulk_job SET status = 'CANCELLED', finished_at = now()
   WHERE tenant_id = %L AND bulk_job_id = 'bf340000-0000-4000-8000-000000000001' $q$, :tA));
SELECT set_config('app.user_id', :viewer, false) \gset
SELECT pg_temp.expect_fail('a viewer cancels the enablement job of another member (Р-143)', format($q$
  UPDATE tenant_data.bulk_job SET status = 'CANCELLED', finished_at = now()
   WHERE tenant_id = %L AND bulk_job_id = 'bf340000-0000-4000-8000-000000000002' $q$, :tA),
  'needs the right to that operation');
SELECT set_config('app.user_id', :owner, false) \gset

-- --------------------------------------------------------------- Р-151: демо — только у клиентского тенанта
-- Строка платформенного тенанта под RLS администратору не видна, и UPDATE бил бы в пустоту: проверяется ролью без RLS
\c - postgres
\i tests/db/smoke_helpers.sql
-- Признак задаётся при создании: сменить его нельзя ни в одну сторону (ревью шага 34, находка 5)
SELECT pg_temp.expect_fail('a customer tenant is turned into a demo after creation (Р-151)', format($q$
  UPDATE tenant_data.tenant SET demo = true WHERE tenant_id = %L $q$, :tA), 'cannot change its demo flag');
-- Платформенный тенант демо быть не может: он один, создан не демо, и признак не меняется
SELECT pg_temp.expect_fail('the platform tenant is marked as a demo (Р-151)', $q$
  UPDATE tenant_data.tenant SET demo = true WHERE kind = 'PLATFORM' $q$, 'cannot change its demo flag');
