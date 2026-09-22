-- Шаг 35 [Р-152, Р-153]: путь остатков в схеме. Каждая защита проверяется СВОЕЙ проверкой с её причиной [Р-94, Р-99] и
-- названа строкой каталога мутаций при создании [Р-108]. Идёт от административной роли: остатки ведёт человек [Р-97].
-- Данные синтетические.
\set ON_ERROR_STOP 1
\set QUIET 1

\i tests/db/smoke_helpers.sql

\set tA '''a0000000-0000-0000-0000-00000000000a'''
\set owner '''a1000000-0000-0000-0000-00000000000a'''
\set ownerM '''a2000000-0000-0000-0000-00000000000a'''
\set operator '''a1000000-0000-0000-0000-0000000000a0'''
\set operatorM '''a2000000-0000-0000-0000-0000000000a0'''
\set inventory '''a1000000-0000-0000-0000-0000000000a5'''

SELECT set_config('app.tenant_id', :tA, false), set_config('app.user_id', :owner, false), set_config('app.auth_mfa', 'on', false) \gset

-- --------------------------------------------------------------- Р-152: путь выбирается из двух, и только из двух
SELECT pg_temp.ok('the seller chooses the stock path (Р-152)', format($q$
  INSERT INTO tenant_data.onboarding_progress (tenant_id, path, updated_by_membership_id) VALUES (%L, 'STOCK', %L)
  ON CONFLICT (tenant_id) DO UPDATE SET path = 'STOCK', updated_by_membership_id = %L $q$, :tA, :ownerM, :ownerM));
SELECT pg_temp.expect_fail('the onboarding path is a name that does not exist (Р-152)', format($q$
  UPDATE tenant_data.onboarding_progress SET path = 'PRICING_ONLY' WHERE tenant_id = %L $q$, :tA), 'onboarding_path_known');

-- --------------------------------------------------------------- Р-152: состояние шагов остатков ВЫВОДИТСЯ из данных
-- Источник без единого остатка — не источник: он в знаменателе шага, но не в числителе
SELECT pg_temp.ok('a stock source without a single figure is not counted as delivering (Р-152)', format($q$
  DO $x$
  DECLARE before_done int; before_total int; after_done int; after_total int; src uuid; pool uuid;
  BEGIN
    SELECT done_count, total_count INTO before_done, before_total FROM tenant_data.onboarding_status(%L) WHERE step = 'STOCK_SOURCE';
    INSERT INTO tenant_data.stock_source (tenant_id, mode, name) VALUES (%L, 'INTERNAL_POOL', 'Leeres Lager') RETURNING stock_source_id INTO src;
    SELECT done_count, total_count INTO after_done, after_total FROM tenant_data.onboarding_status(%L) WHERE step = 'STOCK_SOURCE';
    IF after_done <> before_done OR after_total <> before_total + 1 THEN
      RAISE EXCEPTION 'an empty source changed the numerator';
    END IF;
    INSERT INTO tenant_data.stock_pool (tenant_id, stock_source_id, source_mode, product_id)
    VALUES (%L, src, 'INTERNAL_POOL', (SELECT product_id FROM tenant_data.product WHERE tenant_id = %L ORDER BY created_at LIMIT 1))
    RETURNING stock_pool_id INTO pool;
    INSERT INTO tenant_data.stock_movement (tenant_id, stock_pool_id, delta, reason, created_by_membership_id, occurred_at)
    VALUES (%L, pool, 7, 'STOCKTAKE', %L, now());
    SELECT done_count INTO after_done FROM tenant_data.onboarding_status(%L) WHERE step = 'STOCK_SOURCE';
    IF after_done <> before_done + 1 THEN RAISE EXCEPTION 'a source that delivered a figure is still not counted'; END IF;
  END $x$ $q$, :tA, :tA, :tA, :tA, :tA, :tA, :ownerM, :tA));
-- Шаг синхронизации считает предложения, остаток которых ведём мы: числитель ходит вслед за включением единицы
SELECT pg_temp.ok('the sync step follows the enabled quantity scopes (Р-152)', format($q$
  DO $x$
  DECLARE ws uuid; before_done int; after_done int; total int;
  BEGIN
    SELECT write_scope_id INTO ws FROM tenant_data.write_scope WHERE tenant_id = %L AND field = 'QUANTITY' AND quantity_sync_enabled LIMIT 1;
    IF ws IS NULL THEN RAISE EXCEPTION 'the smoke world has no enabled quantity scope to observe'; END IF;
    SELECT done_count, total_count INTO before_done, total FROM tenant_data.onboarding_status(%L) WHERE step = 'STOCK_SYNC';
    IF total = 0 THEN RAISE EXCEPTION 'no offers counted for stock synchronisation'; END IF;
    UPDATE tenant_data.write_scope SET quantity_sync_enabled = false WHERE tenant_id = %L AND write_scope_id = ws;
    SELECT done_count INTO after_done FROM tenant_data.onboarding_status(%L) WHERE step = 'STOCK_SYNC';
    IF after_done <> before_done - 1 THEN RAISE EXCEPTION 'switching synchronisation off did not move the step'; END IF;
    UPDATE tenant_data.write_scope SET quantity_sync_enabled = true WHERE tenant_id = %L AND write_scope_id = ws;
    SELECT done_count INTO after_done FROM tenant_data.onboarding_status(%L) WHERE step = 'STOCK_SYNC';
    IF after_done <> before_done THEN RAISE EXCEPTION 'switching synchronisation on did not move the step back'; END IF;
  END $x$ $q$, :tA, :tA, :tA, :tA, :tA, :tA));

-- Сужение набора [Р-131] чтут ВСЕ шаги, и синхронизация тоже (находка 17 ревью шага 35: она считала весь каталог)
SELECT pg_temp.ok('the sync step follows the narrowed set like every other step (Р-152)', format($q$
  DO $x$
  DECLARE one uuid; wide int; narrow int;
  BEGIN
    SELECT total_count INTO wide FROM tenant_data.onboarding_status(%L) WHERE step = 'STOCK_SYNC';
    SELECT om.price_write_scope_id INTO one FROM tenant_data.offer_mapping om
     WHERE om.tenant_id = %L AND om.status = 'ACTIVE' AND om.fulfillment = 'MERCHANT' AND om.price_write_scope_id IS NOT NULL LIMIT 1;
    IF one IS NULL OR wide < 2 THEN RAISE EXCEPTION 'the smoke world has too few offers to narrow (%% offers)', wide; END IF;
    UPDATE tenant_data.onboarding_progress SET scope_write_scope_ids = ARRAY[one] WHERE tenant_id = %L;
    SELECT total_count INTO narrow FROM tenant_data.onboarding_status(%L) WHERE step = 'STOCK_SYNC';
    IF narrow <> 1 THEN RAISE EXCEPTION 'the sync step ignores the narrowed set: %% offers instead of 1', narrow; END IF;
    UPDATE tenant_data.onboarding_progress SET scope_write_scope_ids = NULL WHERE tenant_id = %L;
  END $x$ $q$, :tA, :tA, :tA, :tA, :tA));

-- --------------------------------------------------------------- Р-152, Р-143: импорт остатков — задание со своим правом
SELECT set_config('app.user_id', :inventory, false) \gset
-- Менеджер остатков ведёт остатки: источник заводит он, а не тот, кто правит цены [Р-100]
SELECT pg_temp.ok('an inventory manager creates a stock source (Р-152)', format($q$
  INSERT INTO tenant_data.stock_source (tenant_id, mode, name) VALUES (%L, 'INTERNAL_POOL', 'Lager des Bestandsmanagers') $q$, :tA));
SELECT pg_temp.ok('an inventory manager creates a stock import job (Р-152)', format($q$
  INSERT INTO tenant_data.bulk_job (tenant_id, bulk_job_id, kind, params, created_by_membership_id)
  VALUES (%L, 'bf350000-0000-4000-8000-000000000001', 'STOCK_IMPORT', '{}'::jsonb, %L) $q$, :tA,
  (SELECT membership_id FROM tenant_data.membership WHERE tenant_id = 'a0000000-0000-0000-0000-00000000000a' AND role = 'INVENTORY_MANAGER')));
-- Источник Inbound API и его ключ — тоже остаток: их заводит тот, кто ведёт каталог [Р-100, находка 16 ревью шага 35]
SELECT pg_temp.ok('an inventory manager creates an inbound API stock source (Р-152)', format($q$
  INSERT INTO tenant_data.stock_source (tenant_id, stock_source_id, mode, name)
  VALUES (%L, 'aa350000-0000-4000-8000-000000000001', 'INBOUND_API', 'WMS des Bestandsmanagers') $q$, :tA));
SELECT pg_temp.ok('an inventory manager creates an inbound API key (Р-152)', format($q$
  INSERT INTO tenant_data.inbound_api_key (tenant_id, stock_source_id, key_prefix, key_sha256, created_by_membership_id)
  VALUES (%L, 'aa350000-0000-4000-8000-000000000001', 'rpk_35000001', decode(repeat('ab', 32), 'hex'), %L) $q$, :tA,
  (SELECT membership_id FROM tenant_data.membership WHERE tenant_id = 'a0000000-0000-0000-0000-00000000000a' AND role = 'INVENTORY_MANAGER')));
-- Тот же человек цен не касается: право на каталог ≠ право на цены
SELECT pg_temp.expect_fail('an inventory manager creates a cost import job (Р-143)', format($q$
  INSERT INTO tenant_data.bulk_job (tenant_id, kind, params, created_by_membership_id)
  VALUES (%L, 'COST_IMPORT', '{}'::jsonb, %L) $q$, :tA,
  (SELECT membership_id FROM tenant_data.membership WHERE tenant_id = 'a0000000-0000-0000-0000-00000000000a' AND role = 'INVENTORY_MANAGER')),
  'needs the right MANAGE_PRICING');
SELECT set_config('app.user_id', :operator, false) \gset
-- Оператор ведёт цены, но не каталог: остатки — не его
SELECT pg_temp.expect_fail('an operator creates a stock import job (Р-143)', format($q$
  INSERT INTO tenant_data.bulk_job (tenant_id, kind, params, created_by_membership_id)
  VALUES (%L, 'STOCK_IMPORT', '{}'::jsonb, %L) $q$, :tA, :operatorM), 'needs the right MANAGE_CATALOG');
SELECT pg_temp.expect_fail('an operator creates an inbound API key (Р-100)', format($q$
  INSERT INTO tenant_data.inbound_api_key (tenant_id, stock_source_id, key_prefix, key_sha256, created_by_membership_id)
  VALUES (%L, 'aa350000-0000-4000-8000-000000000001', 'rpk_35000002', decode(repeat('cd', 32), 'hex'), %L) $q$, :tA, :operatorM),
  'may not MANAGE_CATALOG');
SELECT set_config('app.user_id', :owner, false) \gset

-- --------------------------------------------------------------- Р-97, Р-100: остатки ведёт человек, и это в аудите
SELECT pg_temp.ok('creating a stock source is written to the audit log (Р-97)', format($q$
  DO $x$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM audit.audit_event WHERE entity_type = 'tenant_data.stock_source' AND tenant_id = %L) THEN
      RAISE EXCEPTION 'creating a stock source is not in the audit log';
    END IF;
  END $x$ $q$, :tA));

-- --------------------------------------------------------------- Р-105: шестая запись остатка в сессии
-- Проверка «цена равна решению» стояла одним выражением с `field = 'PRICE'`; с шестого исполнения PL/pgSQL берёт общий план,
-- подзапрос по price_decision остаётся, и роль остатков получала отказ ПРАВА на записи остатка. Здесь тот же случай — но
-- административной ролью не воспроизводится: у неё право на price_decision есть. Своя проверка — в smoke_stock.sql
ROLLBACK;
