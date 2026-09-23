-- Р-160, Р-161 (шаг 37): что гость демо может и чего не может — глазами административной роли (svc_admin), потому что
-- именно она пишет всё, чего гость не должен мочь. Выполнять после smoke_guest.sql. Данные синтетические.
--
-- Проверки здесь про ДВЕ разные вещи:
--   1) гость остаётся наблюдателем: его роль не повышается и задания он не создаёт — даже те, что «ничего не меняют»
--      (выгрузку доказательства и ленту цен создаёт любой с VIEW_PRICING [Р-143], а это 27 МБ файла на публичной кнопке);
--   2) язык тенанта [Р-161] — из списка словаря консоли, иначе письмо ушло бы кодами.
\set ON_ERROR_STOP 1
\set QUIET 1

\i tests/db/smoke_helpers.sql

\set tDemo '''d0000000-0000-0000-0000-00000000000d'''
\set ownerDemo '''d1000000-0000-0000-0000-00000000000d'''
\set ownerDemoM '''d2000000-0000-0000-0000-00000000000d'''

SELECT set_config('app.tenant_id', :tDemo, false), set_config('app.user_id', :ownerDemo, false), set_config('app.auth_mfa', 'on', false) \gset

-- Гостевое членство, созданное смоуком онбординга: его идентификатор выдала база, поэтому он ищется, а не подставляется
SELECT membership_id AS "guestM", user_id AS "guestU" FROM tenant_data.membership WHERE guest ORDER BY created_at LIMIT 1 \gset

-- --------------------------------------------------------------- гость — наблюдатель, и это УТВЕРЖДАЕТСЯ, а не подразумевается
DO $$
DECLARE
  r record;
BEGIN
  SELECT role, status, guest INTO r FROM tenant_data.membership WHERE guest ORDER BY created_at LIMIT 1;
  IF r.role <> 'VIEWER' OR r.status <> 'ACTIVE' OR NOT r.guest THEN
    RAISE EXCEPTION 'a demo guest is an ACTIVE VIEWER, got role=% status=% guest=%', r.role, r.status, r.guest;
  END IF;
  RAISE NOTICE 'PASS accept | a demo guest is created as an ACTIVE VIEWER (Р-160)';
END $$;

-- --------------------------------------------------------------- повышение гостя [Р-160]
-- Ровно этим UPDATE публичный вход превратился бы в доступ продавца: членство уже есть, приглашения не нужно
SELECT pg_temp.expect_fail('a demo guest is promoted to a pricing manager (Р-160)', format($q$
  UPDATE tenant_data.membership SET role = 'PRICING_MANAGER' WHERE tenant_id = %L AND membership_id = %L $q$, :tDemo, :'guestM'),
  'a guest membership is never promoted');

-- --------------------------------------------------------------- задание от имени гостя [Р-160]
-- Выгрузка доказательной истории требует лишь VIEW_PRICING [Р-143], и у наблюдателя оно есть: отказать обязан страж гостя
SELECT pg_temp.expect_fail('a demo guest creates a price evidence job (Р-160)', format($q$
  INSERT INTO tenant_data.bulk_job (tenant_id, kind, params, created_by_membership_id)
  VALUES (%L, 'PRICE_EVIDENCE', '{}'::jsonb, %L) $q$, :tDemo, :'guestM'),
  'a guest creates no bulk job');

-- Тот же вид задания от владельца демо проходит: отказ выше — про ГОСТЯ, а не про вид задания [Р-99]
SELECT pg_temp.ok('the demo owner creates the same price evidence job (Р-160)', format($q$
  INSERT INTO tenant_data.bulk_job (tenant_id, kind, params, created_by_membership_id)
  VALUES (%L, 'PRICE_EVIDENCE', '{}'::jsonb, %L) $q$, :tDemo, :ownerDemoM));

-- --------------------------------------------------------------- язык тенанта [Р-161]
SELECT pg_temp.ok('the tenant language is set to English (Р-161)', format($q$
  UPDATE tenant_data.tenant SET locale = 'en' WHERE tenant_id = %L $q$, :tDemo));
SELECT pg_temp.expect_fail('a tenant language the console dictionary does not have (Р-161)', format($q$
  UPDATE tenant_data.tenant SET locale = 'fr' WHERE tenant_id = %L $q$, :tDemo),
  'tenant_locale_known');
-- Язык возвращается к немецкому: остальные проверки смотрят мир таким, каким его оставил посев
SELECT pg_temp.ok('the tenant language is set back to German (Р-161)', format($q$
  UPDATE tenant_data.tenant SET locale = 'de' WHERE tenant_id = %L $q$, :tDemo));
