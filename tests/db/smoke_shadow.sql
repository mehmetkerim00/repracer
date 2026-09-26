-- Р-169…Р-171 (шаг 41): теневой режим аккаунта канала. Выполнять административной ролью (svc_admin) после smoke_stock.sql.
-- Данные синтетические, мир — тенант A смоука.
--
-- Главное здесь — доказательство уровня Р-83: теневая запись пробует уйти в канал ВСЕМИ путями, и каждый отказ приходит
-- от базы своей причиной [Р-94]:
--   путь 1) очередь диспетчера — теневая запись не бывает `PENDING`, в очередь не попадает и в ней не ждёт;
--   путь 2) прямая отправка — запись с состоянием тени и следами отправки отвергается ограничением;
--   путь 3) повтор после отказа канала — запись, ушедшая ДО перехода в тень, при повторе упирается в режим аккаунта.
\set ON_ERROR_STOP 1
\set QUIET 1

\i tests/db/smoke_helpers.sql

\set tA '''a0000000-0000-0000-0000-00000000000a'''
\set ownerM '''a2000000-0000-0000-0000-00000000000a'''
\set ownerU '''a1000000-0000-0000-0000-00000000000a'''
\set adminM '''a2000000-0000-0000-0000-0000000000ad'''
\set adminU '''a1000000-0000-0000-0000-0000000000ad'''
-- Kaufland: у остатка нет внешнего бюджета правок — на нём проверяются отправка и повтор
\set kAcc '''a4000000-0000-0000-0000-000000000001'''
\set kScope '''a6410000-0000-4000-8000-000000000001'''
\set kScope2 '''a6410000-0000-4000-8000-000000000002'''
\set pScope '''a6000000-0000-0000-0000-000000000009'''
-- eBay: бюджет правок листинга есть — на нём проверяется «потратило бы» [Р-171]
\set eAcc '''a4000000-0000-0000-0000-000000000003'''
\set qScope '''a6000000-0000-0000-0000-000000000003'''

SELECT set_config('app.tenant_id', :tA, false), set_config('app.user_id', :ownerU, false), set_config('app.auth_mfa', 'on', false) \gset

/**
 * Фикстура: единица записи ЦЕНЫ в режиме ENGINE на аккаунте Kaufland. Она нужна признаку тени у решения [Р-171]:
 * намерение цены база принимает только у включённого движка, а единственная такая единица смоук-мира к этому файлу уже
 * переведена в режим Smart Pricing. Границы, себестоимость и стратегия — на своём товаре [Р-131, Р-43].
 */
INSERT INTO tenant_data.cost_profile (tenant_id, product_id, version, valid_from, currency, purchase_cost_minor, source)
VALUES (:tA, 'a5000000-0000-0000-0000-000000000009', 1, now() - interval '1 day', 'EUR', 700, 'MANUAL');
-- Границы у этого товара уже есть (их заводит smoke_bulk_jobs.sql): своих версий здесь не создаём — версии границ идут
-- подряд, и лишняя строка сломала бы соседний файл
UPDATE tenant_data.write_scope
   SET pricing_strategy_id = 'a9000000-0000-0000-0000-000000000001', pricing_strategy_version = 1, pricing_mode = 'ENGINE'
 WHERE tenant_id = :tA AND write_scope_id = :pScope;

-- Дальше второй фактор снят: переключение в тень его не требует, а в бой — требует, и это проверяется отказом
SELECT set_config('app.auth_mfa', 'off', false) \gset

-- --------------------------------------------------------------- переключение режима [Р-170]
-- Столбец режима меняет только строка журнала: иначе бой включался бы обычным UPDATE, без автора и подтверждения
SELECT pg_temp.expect_fail('the write mode is changed by a direct update (Р-170)', format($q$
  UPDATE tenant_data.channel_account SET write_mode = 'SHADOW' WHERE tenant_id = %L AND channel_account_id = %L $q$, :tA, :kAcc),
  'write_mode is changed by a row of tenant_data.channel_write_mode_change');

-- Режим аккаунта — из списка: аккаунт с выдуманным режимом база не принимает
SELECT pg_temp.expect_fail('a channel account with an unknown write mode (Р-169)', format($q$
  INSERT INTO tenant_data.channel_account (tenant_id, channel, external_account_id, marketplaces, credentials_ref, connected_by_membership_id, write_mode)
  VALUES (%L, 'KAUFLAND', 'shadow-bogus', ARRAY['de'], 'vault://bogus', %L, 'MAYBE') $q$, :tA, :ownerM),
  'channel_account_write_mode_known');
-- Режим, в который переводят, ложится на АККАУНТ, и там его отвергает список режимов (у журнала своего списка нет [Р-104])
SELECT pg_temp.expect_fail('a mode change to a mode that does not exist (Р-170)', format($q$
  INSERT INTO tenant_data.channel_write_mode_change (tenant_id, channel_account_id, from_mode, to_mode, changed_by_membership_id)
  VALUES (%L, %L, 'LIVE', 'MAYBE', %L) $q$, :tA, :kAcc, :ownerM),
  'channel_account_write_mode_known');
-- Подпись чужим членством: автор перехода — человек сессии, а не любой участник тенанта [Р-97]
SELECT pg_temp.expect_fail('a mode change signed with the membership of someone else (Р-97)', format($q$
  INSERT INTO tenant_data.channel_write_mode_change (tenant_id, channel_account_id, from_mode, to_mode, changed_by_membership_id, note)
  VALUES (%L, %L, 'LIVE', 'SHADOW', %L, 'чужой подписью') $q$, :tA, :kAcc, :adminM),
  'is not the membership of the session user');
/**
 * Административная запись — только при пользователе сессии [Р-97]: без него переключение режима стало бы действием без
 * автора. Страж общий для всех административных таблиц, но у КАЖДОЙ он свой триггер и своя строка каталога [Р-108].
 */
-- Отказ приходит от стража человека — журнального или аккаунтного: путь ВСЕГДА правит и аккаунт [Р-104], поэтому
-- проверка называет общую часть причины, а строки мутации у журнального стража нет намеренно (tests/db/mutations.mjs)
SELECT set_config('app.user_id', '', false) \gset
SELECT pg_temp.expect_fail('a mode change written without a person (Р-97)', format($q$
  INSERT INTO tenant_data.channel_write_mode_change (tenant_id, channel_account_id, from_mode, to_mode, changed_by_membership_id, note)
  VALUES (%L, %L, 'LIVE', 'SHADOW', %L, 'без человека') $q$, :tA, :kAcc, :ownerM),
  'without a person');
SELECT set_config('app.user_id', :ownerU, false) \gset

-- --------------------------------------------------------------- положительный контроль: боевая запись уходит
/**
 * Своя единица записи остатка на аккаунте Kaufland: у неё НЕТ внешнего бюджета правок, и проверки отправки не зависят от
 * того, сколько бюджета листинга eBay израсходовали соседние файлы (в смоук-мире он израсходован ПОЛНОСТЬЮ — ровно это
 * и поймало первую редакцию этого прогона).
 */
-- Синхронизация остатка требует действующего буфера канала [Р-6]: у аккаунта Kaufland его ещё не было
INSERT INTO tenant_data.stock_allocation (tenant_id, scope_type, channel_account_id, buffer_units, version, created_by_membership_id)
VALUES (:tA, 'CHANNEL_ACCOUNT', :kAcc, 1, 1, :ownerM);
INSERT INTO tenant_data.write_scope (tenant_id, write_scope_id, channel_account_id, channel, field, product_id, capability_id, capability_version,
  scope_kind, scope_key, quantity_sync_enabled)
VALUES (:tA, :kScope, :kAcc, 'KAUFLAND', 'QUANTITY', 'a5000000-0000-0000-0000-000000000001',
  'c0000000-0000-0000-0000-000000000011', 1, 'ACCOUNT_OFFER', '["a4000000-0000-0000-0000-000000000001", "OFF-41"]', true);
INSERT INTO tenant_data.write_scope (tenant_id, write_scope_id, channel_account_id, channel, field, product_id, capability_id, capability_version,
  scope_kind, scope_key, quantity_sync_enabled)
VALUES (:tA, :kScope2, :kAcc, 'KAUFLAND', 'QUANTITY', 'a5000000-0000-0000-0000-000000000001',
  'c0000000-0000-0000-0000-000000000011', 1, 'ACCOUNT_OFFER', '["a4000000-0000-0000-0000-000000000001", "OFF-42"]', true);
INSERT INTO tenant_data.channel_write (tenant_id, channel_write_id, write_scope_id, field, quantity, version, origin)
VALUES (:tA, 'a9410000-0000-4000-8000-000000000001', :kScope, 'QUANTITY', 7, 1, 'STOCK_RECALC');
SELECT pg_temp.ok('a write of a LIVE account is dispatched (положительный контроль к Р-169)', $q$
  UPDATE tenant_data.channel_write SET status = 'DISPATCHED', attempt_count = 1
   WHERE channel_write_id = 'a9410000-0000-4000-8000-000000000001' $q$);

-- Вторая запись: ушла и получила отказ канала ДО перехода в тень. Тень её не переписывает — она завершается отказом
INSERT INTO tenant_data.channel_write (tenant_id, channel_write_id, write_scope_id, field, quantity, version, origin)
VALUES (:tA, 'a9410000-0000-4000-8000-000000000005', :kScope2, 'QUANTITY', 3, 1, 'STOCK_RECALC');
UPDATE tenant_data.channel_write SET status = 'DISPATCHED', attempt_count = 1 WHERE channel_write_id = 'a9410000-0000-4000-8000-000000000005';
UPDATE tenant_data.channel_write SET status = 'FAILED', last_error_code = 'KFL_5XX' WHERE channel_write_id = 'a9410000-0000-4000-8000-000000000005';

-- Третья запись: ЖДЁТ отправки на момент перехода в тень. Её удерживает тень, и это отдельная ветка применения перехода
-- (находка 4 ревью шага 41: ветка была объявлена необходимой и не проверялась ничем — мутация оставалась зелёной)
INSERT INTO tenant_data.write_scope (tenant_id, write_scope_id, channel_account_id, channel, field, product_id, capability_id, capability_version,
  scope_kind, scope_key, quantity_sync_enabled)
VALUES (:tA, 'a6410000-0000-4000-8000-000000000003', :kAcc, 'KAUFLAND', 'QUANTITY', 'a5000000-0000-0000-0000-000000000001',
  'c0000000-0000-0000-0000-000000000011', 1, 'ACCOUNT_OFFER', '["a4000000-0000-0000-0000-000000000001", "OFF-43"]', true);
INSERT INTO tenant_data.channel_write (tenant_id, channel_write_id, write_scope_id, field, quantity, version, origin)
VALUES (:tA, 'a9410000-0000-4000-8000-000000000006', 'a6410000-0000-4000-8000-000000000003', 'QUANTITY', 9, 1, 'STOCK_RECALC');

-- --------------------------------------------------------------- уход в тень: одно действие, без второго фактора [Р-170]
SELECT pg_temp.ok('the owner switches the account back to SHADOW without a second factor (Р-170)', format($q$
  INSERT INTO tenant_data.channel_write_mode_change (tenant_id, channel_account_id, from_mode, to_mode, changed_by_membership_id, note)
  VALUES (%L, %L, 'LIVE', 'SHADOW', %L, 'Прогон: возврат в тень') $q$, :tA, :kAcc, :ownerM));
DO $$
BEGIN
  IF (SELECT write_mode FROM tenant_data.channel_account WHERE channel_account_id = 'a4000000-0000-0000-0000-000000000001') <> 'SHADOW' THEN
    RAISE EXCEPTION 'the row of the journal did not switch the account (Р-170)';
  END IF;
  RAISE NOTICE 'PASS accept | the journal row switched the account to SHADOW (Р-170)';
END $$;

/**
 * Ждущая запись НИКУДА не уходила — её удерживает тень: в очереди её больше нет, в истории она `SHADOW_HELD`.
 */
DO $$
DECLARE
  h record;
BEGIN
  IF EXISTS (SELECT 1 FROM tenant_data.channel_write WHERE channel_write_id = 'a9410000-0000-4000-8000-000000000006') THEN
    RAISE EXCEPTION 'a pending write of an account that went to shadow still waits in the queue (Р-170)';
  END IF;
  SELECT final_status, end_reason, dispatched_at INTO h
    FROM tenant_data.channel_write_history WHERE channel_write_id = 'a9410000-0000-4000-8000-000000000006';
  IF h.final_status <> 'SHADOW_HELD' OR h.end_reason <> 'WRITE_HELD_IN_SHADOW' THEN
    RAISE EXCEPTION 'a pending write is recorded as %/% instead of held by the shadow', h.final_status, h.end_reason;
  END IF;
  IF h.dispatched_at IS NOT NULL THEN RAISE EXCEPTION 'a write that never left carries a dispatch time'; END IF;
  RAISE NOTICE 'PASS accept | going to shadow holds the writes that were still waiting (Р-170)';
END $$;

/**
 * Что стало с записью, которая уже уходила и получила отказ канала: она НЕ помечена тенью (следы отправки у неё есть, и
 * «удержано тенью» было бы неправдой), а завершена отказом с той же причиной — повторов не будет.
 */
DO $$
DECLARE
  h record;
BEGIN
  IF EXISTS (SELECT 1 FROM tenant_data.channel_write WHERE channel_write_id = 'a9410000-0000-4000-8000-000000000005') THEN
    RAISE EXCEPTION 'a failed write of a shadow account still waits for a retry (Р-169)';
  END IF;
  SELECT final_status, end_reason, would_spend_budget, dispatched_at INTO h
    FROM tenant_data.channel_write_history WHERE channel_write_id = 'a9410000-0000-4000-8000-000000000005';
  IF h.final_status <> 'DISCARDED_STALE' OR h.end_reason <> 'WRITE_HELD_IN_SHADOW' THEN
    RAISE EXCEPTION 'a write that had already left is recorded as %/% instead of a refusal caused by the shadow', h.final_status, h.end_reason;
  END IF;
  IF h.dispatched_at IS NULL THEN RAISE EXCEPTION 'the write that had left lost its dispatch time'; END IF;
  RAISE NOTICE 'PASS accept | a write that had already left is ended by its refusal, not marked as held (Р-169)';
END $$;

-- --------------------------------------------------------------- путь 3: повтор отправленной записи в тени [Р-169]
-- Запись ушла ДО перехода в тень и осталась в полёте: канал отказал, и повтор обязан упереться в режим
SELECT pg_temp.ok('the channel refuses the in-flight write (подготовка пути 3)', $q$
  UPDATE tenant_data.channel_write SET status = 'FAILED', last_error_code = 'KFL_TIMEOUT'
   WHERE channel_write_id = 'a9410000-0000-4000-8000-000000000001' $q$);
SELECT pg_temp.expect_fail('a retry after the channel failure leaves the shadow (Р-169, путь 3)', $q$
  UPDATE tenant_data.channel_write SET status = 'DISPATCHED', attempt_count = 2
   WHERE channel_write_id = 'a9410000-0000-4000-8000-000000000001' $q$,
  'is in SHADOW mode: no write leaves the shadow');

/**
 * Четвёртый путь, найденный при написании шага: диспетчер САМ пробует повторить отказавшую запись, и его захват отвергает
 * тот же страж режима. Отказ должен быть РАСПОЗНАН (`WRITE_HELD_IN_SHADOW`), иначе обход диспетчера падает на каждом
 * круге, а запись висит без причины — ровно находка 7 шага 15 в новой форме. Здесь проверяется, что база принимает
 * завершение записи этой причиной: распознавание на стороне диспетчера проверяет его собственный тест.
 */
SELECT pg_temp.ok('a write that had left is ended with the shadow reason (Р-169, путь 4)', $q$
  UPDATE tenant_data.channel_write SET status = 'DISCARDED_STALE', end_reason = 'WRITE_HELD_IN_SHADOW',
         end_params = '{"channelAccountId": "a4000000-0000-0000-0000-000000000001"}'::jsonb, next_attempt_at = NULL
   WHERE channel_write_id = 'a9410000-0000-4000-8000-000000000001' $q$);

-- --------------------------------------------------------------- путь 1: очередь диспетчера [Р-169]
-- Теневая запись рождается завершённой: в очереди (`PENDING`) её нет, и диспетчер её не видит
INSERT INTO tenant_data.channel_write (tenant_id, channel_write_id, write_scope_id, field, quantity, version, origin)
VALUES (:tA, 'a9410000-0000-4000-8000-000000000002', :kScope, 'QUANTITY', 6, 2, 'STOCK_RECALC');
DO $$
DECLARE
  h record;
BEGIN
  IF EXISTS (SELECT 1 FROM tenant_data.channel_write WHERE channel_write_id = 'a9410000-0000-4000-8000-000000000002') THEN
    RAISE EXCEPTION 'a write of a shadow account waits in the queue (Р-169, путь 1)';
  END IF;
  SELECT final_status, end_reason, would_spend_budget, dispatched_at, attempt_count INTO h
    FROM tenant_data.channel_write_history WHERE channel_write_id = 'a9410000-0000-4000-8000-000000000002';
  IF h.final_status <> 'SHADOW_HELD' OR h.end_reason <> 'WRITE_HELD_IN_SHADOW' THEN
    RAISE EXCEPTION 'a shadow write is not recorded as held: status=% reason=%', h.final_status, h.end_reason;
  END IF;
  IF h.dispatched_at IS NOT NULL OR h.attempt_count <> 0 THEN
    RAISE EXCEPTION 'the shadow write carries traces of a dispatch: at=% attempts=%', h.dispatched_at, h.attempt_count;
  END IF;
  -- У остатка Kaufland внешнего бюджета нет: «потратило бы» тут ложь, и это тоже утверждается
  IF h.would_spend_budget THEN
    RAISE EXCEPTION 'a write without an external budget says it would have spent one (Р-171)';
  END IF;
  RAISE NOTICE 'PASS accept | a write of a shadow account is born finished and never queued (Р-169)';
END $$;

-- --------------------------------------------------------------- Р-171: «потратило бы бюджет» и нерастраченный бюджет
-- Аккаунт eBay уходит в тень: у его листинга бюджет правок 250 в сутки, и в смоук-мире он израсходован полностью
SELECT pg_temp.ok('the owner switches the eBay account to SHADOW (Р-170)', format($q$
  INSERT INTO tenant_data.channel_write_mode_change (tenant_id, channel_account_id, from_mode, to_mode, changed_by_membership_id, note)
  VALUES (%L, %L, 'LIVE', 'SHADOW', %L, 'Прогон: бюджет правок в тени') $q$, :tA, :eAcc, :ownerM));
INSERT INTO tenant_data.channel_write (tenant_id, channel_write_id, write_scope_id, field, quantity, version, origin, budget_scope_key, budget_day)
VALUES (:tA, 'a9410000-0000-4000-8000-000000000003', :qScope, 'QUANTITY', 4, 41, 'STOCK_RECALC', 'L1', (now() AT TIME ZONE 'Europe/Berlin')::date);
DO $$
DECLARE
  spent boolean;
  b record;
BEGIN
  SELECT would_spend_budget INTO spent FROM tenant_data.channel_write_history
   WHERE channel_write_id = 'a9410000-0000-4000-8000-000000000003';
  IF NOT spent THEN
    RAISE EXCEPTION 'the shadow write does not say it would have spent the edit budget (Р-171)';
  END IF;
  /**
   * И при этом бюджет НЕ израсходован: он был исчерпан соседними проверками (250 из 250), и боевая запись здесь
   * отказала бы ограничением `edit_budget_total_limit`. Теневая прошла — значит расхода не было.
   */
  SELECT attempts_price + attempts_quantity + attempts_quantity_decrease AS used, edit_limit INTO b
    FROM tenant_data.edit_budget
   WHERE tenant_id = 'a0000000-0000-0000-0000-00000000000a' AND budget_scope_key = 'L1'
     AND budget_day = (now() AT TIME ZONE 'Europe/Berlin')::date;
  IF b.used > b.edit_limit THEN
    RAISE EXCEPTION 'the shadow write spent the edit budget: % of % (Р-171)', b.used, b.edit_limit;
  END IF;
  RAISE NOTICE 'PASS accept | the shadow write would have spent the budget and spent none of it (Р-171)';
END $$;

-- --------------------------------------------------------------- путь 2: состояние тени со следами отправки [Р-169]
SELECT pg_temp.expect_fail('a held write is recorded with a dispatch time (Р-169, путь 2)', format($q$
  INSERT INTO tenant_data.channel_write_history (tenant_id, channel_write_id, finished_at, write_scope_id, field, quantity,
    version, origin, final_status, end_reason, attempt_count, created_at, dispatched_at)
  VALUES (%L, gen_random_uuid(), now(), %L, 'QUANTITY', 6, 43, 'STOCK_RECALC', 'SHADOW_HELD', 'WRITE_HELD_IN_SHADOW', 0, now(), now()) $q$, :tA, :kScope),
  'channel_write_history_shadow_never_left');
SELECT pg_temp.expect_fail('a live write claims it would have spent the budget (Р-171)', format($q$
  INSERT INTO tenant_data.channel_write_history (tenant_id, channel_write_id, finished_at, write_scope_id, field, quantity,
    version, origin, final_status, end_reason, attempt_count, created_at, would_spend_budget)
  VALUES (%L, gen_random_uuid(), now(), %L, 'QUANTITY', 6, 44, 'STOCK_RECALC', 'SUPERSEDED', 'WRITE_SUPERSEDED_BY_NEWER_VERSION', 0, now(), true) $q$, :tA, :kScope),
  'channel_write_history_would_spend_only_in_shadow');

-- --------------------------------------------------------------- решение помечено тенью [Р-171]
/**
 * Признак тени ставит БАЗА по режиму аккаунта, и проверяется он парой [Р-94]: у теневого аккаунта — истина, у боевого —
 * ложь, а решения в остальном одинаковы. Аккаунт Kaufland сейчас в тени, ниже он вернётся в бой.
 */
INSERT INTO channel_data.price_intent (tenant_id, price_intent_id, created_at, write_scope_id, created_by_membership_id, trigger_type, proposed_amount_minor, currency, price_basis, expires_at, rule_code)
VALUES (:tA, 'a7410000-0000-4000-8000-000000000001', '2026-09-14 10:41+00', :pScope, :ownerM, 'MANUAL', 1290, 'EUR', 'GROSS', '2026-09-14 11:41+00', 'FIXED_PRICE');
INSERT INTO channel_data.price_decision (tenant_id, intent_created_at, price_intent_id, write_scope_id, outcome, currency, price_basis,
  effective_floor_minor, min_price_ids, effective_ceiling_minor, max_price_ids, rejection_reason, reason_params, explanation, sanity_ruleset, gate_profile)
VALUES (:tA, '2026-09-14 10:41+00', 'a7410000-0000-4000-8000-000000000001', :pScope, 'HELD', 'EUR', 'GROSS',
  1000, ARRAY[gen_random_uuid()], 5000, ARRAY[gen_random_uuid()], 'STEP_LIMIT', '{"stepLimitBp": 500}',
  '{"format":"r80.1","strategy":{"reason":{"code":"FIXED_PRICE"}}}', NULL, 'g74.1');

-- --------------------------------------------------------------- включение боя [Р-170]
SELECT pg_temp.expect_fail('switching to LIVE without a second factor (Р-170)', format($q$
  INSERT INTO tenant_data.channel_write_mode_change (tenant_id, channel_account_id, from_mode, to_mode, changed_by_membership_id, typed_confirmation)
  VALUES (%L, %L, 'SHADOW', 'LIVE', %L, 'seller-A') $q$, :tA, :kAcc, :ownerM),
  'switching to LIVE writes requires a second factor');

SELECT set_config('app.auth_mfa', 'on', false) \gset
SELECT pg_temp.expect_fail('switching to LIVE with a confirmation that does not name the account (Р-170)', format($q$
  INSERT INTO tenant_data.channel_write_mode_change (tenant_id, channel_account_id, from_mode, to_mode, changed_by_membership_id, typed_confirmation)
  VALUES (%L, %L, 'SHADOW', 'LIVE', %L, 'ja, bitte') $q$, :tA, :kAcc, :ownerM),
  'the typed confirmation does not name the channel account');

-- Администратор со вторым фактором и верным подтверждением — всё равно не владелец
SELECT set_config('app.user_id', :adminU, false) \gset
SELECT pg_temp.expect_fail('an admin switches the account to LIVE (Р-170)', format($q$
  INSERT INTO tenant_data.channel_write_mode_change (tenant_id, channel_account_id, from_mode, to_mode, changed_by_membership_id, typed_confirmation)
  VALUES (%L, %L, 'SHADOW', 'LIVE', %L, 'seller-A') $q$, :tA, :kAcc, :adminM),
  'only the owner switches a channel account to LIVE');

SELECT set_config('app.user_id', :ownerU, false) \gset
SELECT pg_temp.ok('the owner switches the account to LIVE with a second factor and a typed confirmation (Р-170)', format($q$
  INSERT INTO tenant_data.channel_write_mode_change (tenant_id, channel_account_id, from_mode, to_mode, changed_by_membership_id, typed_confirmation)
  VALUES (%L, %L, 'SHADOW', 'LIVE', %L, 'seller-A') $q$, :tA, :kAcc, :ownerM));

-- Признак тени у решения: теневое — истина, боевое — ложь
INSERT INTO channel_data.price_intent (tenant_id, price_intent_id, created_at, write_scope_id, created_by_membership_id, trigger_type, proposed_amount_minor, currency, price_basis, expires_at, rule_code)
VALUES (:tA, 'a7410000-0000-4000-8000-000000000002', '2026-09-14 10:42+00', :pScope, :ownerM, 'MANUAL', 1291, 'EUR', 'GROSS', '2026-09-14 11:42+00', 'FIXED_PRICE');
INSERT INTO channel_data.price_decision (tenant_id, intent_created_at, price_intent_id, write_scope_id, outcome, currency, price_basis,
  effective_floor_minor, min_price_ids, effective_ceiling_minor, max_price_ids, rejection_reason, reason_params, explanation, sanity_ruleset, gate_profile)
VALUES (:tA, '2026-09-14 10:42+00', 'a7410000-0000-4000-8000-000000000002', :pScope, 'HELD', 'EUR', 'GROSS',
  1000, ARRAY[gen_random_uuid()], 5000, ARRAY[gen_random_uuid()], 'STEP_LIMIT', '{"stepLimitBp": 500}',
  '{"format":"r80.1","strategy":{"reason":{"code":"FIXED_PRICE"}}}', NULL, 'g74.1');
DO $$
DECLARE
  inShadow boolean;
  inLive boolean;
  n int;
BEGIN
  SELECT shadow INTO inShadow FROM channel_data.price_decision WHERE price_intent_id = 'a7410000-0000-4000-8000-000000000001';
  SELECT shadow INTO inLive FROM channel_data.price_decision WHERE price_intent_id = 'a7410000-0000-4000-8000-000000000002';
  IF inShadow IS NOT TRUE THEN RAISE EXCEPTION 'a decision of a shadow account is not marked as shadow (Р-171)'; END IF;
  IF inLive IS NOT FALSE THEN RAISE EXCEPTION 'a decision of a LIVE account is marked as shadow (Р-171)'; END IF;
  -- Находка 9 ревью шага 41: признак жил только в буфере решений (30 суток) — теперь он и в ВЕЧНОМ ядре [Р-38]
  IF NOT EXISTS (SELECT 1 FROM tenant_data.price_intent_core
                  WHERE price_intent_id = 'a7410000-0000-4000-8000-000000000001' AND shadow) THEN
    RAISE EXCEPTION 'the shadow flag of a decision does not reach the eternal core (Р-171, Р-38)';
  END IF;
  IF EXISTS (SELECT 1 FROM tenant_data.price_intent_core
              WHERE price_intent_id = 'a7410000-0000-4000-8000-000000000002' AND shadow) THEN
    RAISE EXCEPTION 'a live decision is marked as shadow in the eternal core (Р-171)';
  END IF;
  IF (SELECT write_mode FROM tenant_data.channel_account WHERE channel_account_id = 'a4000000-0000-0000-0000-000000000001') <> 'LIVE' THEN
    RAISE EXCEPTION 'the account did not switch to LIVE (Р-170)';
  END IF;
  -- Каждое переключение — событие аудита [Р-97]: журнал и аудит идут парой, а не вместо друг друга
  SELECT count(*) INTO n FROM audit.audit_event
   WHERE entity_type = 'tenant_data.channel_write_mode_change' AND tenant_id = 'a0000000-0000-0000-0000-00000000000a';
  IF n < 3 THEN
    RAISE NOTICE 'событий аудита переключения режима: %', n;
    RAISE EXCEPTION 'switching the write mode is not written to the audit log (Р-97)';
  END IF;
  RAISE NOTICE 'PASS accept | the database marks a decision of a shadow account and only it, and every switch is audited (Р-171, Р-97)';
END $$;

-- После включения боя новая запись снова уходит: тень выключена не словом, а поведением
INSERT INTO tenant_data.channel_write (tenant_id, channel_write_id, write_scope_id, field, quantity, version, origin)
VALUES (:tA, 'a9410000-0000-4000-8000-000000000004', :kScope, 'QUANTITY', 5, 3, 'STOCK_RECALC');
SELECT pg_temp.ok('after switching to LIVE a new write is dispatched again (Р-170)', $q$
  UPDATE tenant_data.channel_write SET status = 'DISPATCHED', attempt_count = 1
   WHERE channel_write_id = 'a9410000-0000-4000-8000-000000000004' $q$);

/**
 * Переход объявляется от ТЕКУЩЕГО режима: строка «из тени» у боевого аккаунта — не история, а ложь. Проверка стоит
 * ЗДЕСЬ, где второй фактор включён, владелец тот же и подтверждение верное: в начале файла её отказ давал бы страж
 * второго фактора, то есть соседняя защита, и мутация не ловилась бы своей проверкой [Р-99] — прогон это показал.
 */
SELECT pg_temp.expect_fail('a mode change that names the wrong current mode (Р-170)', format($q$
  INSERT INTO tenant_data.channel_write_mode_change (tenant_id, channel_account_id, from_mode, to_mode, changed_by_membership_id, typed_confirmation)
  VALUES (%L, %L, 'SHADOW', 'LIVE', %L, 'seller-A') $q$, :tA, :kAcc, :ownerM),
  'is in LIVE mode, not in SHADOW');

-- Переключение «из боя в бой» — не история, а шум: направление обязано менять режим
SELECT pg_temp.expect_fail('a mode change that changes nothing (Р-170)', format($q$
  INSERT INTO tenant_data.channel_write_mode_change (tenant_id, channel_account_id, from_mode, to_mode, changed_by_membership_id, typed_confirmation)
  VALUES (%L, %L, 'LIVE', 'LIVE', %L, 'seller-A') $q$, :tA, :kAcc, :ownerM),
  'channel_write_mode_change_direction');
-- Подтверждение относится к включению боя: у возврата в тень его быть не может — иначе «подтвердил» значило бы что угодно
SELECT pg_temp.expect_fail('a switch back to SHADOW that carries a typed confirmation (Р-170)', format($q$
  INSERT INTO tenant_data.channel_write_mode_change (tenant_id, channel_account_id, from_mode, to_mode, changed_by_membership_id, typed_confirmation)
  VALUES (%L, %L, 'LIVE', 'SHADOW', %L, 'seller-A') $q$, :tA, :kAcc, :ownerM),
  'channel_write_mode_change_live_confirmed');

/**
 * Шаг 42 [Р-172]: у аккаунта, который переводят в БОЙ, должна быть названа хотя бы одна витрина ИЗ СПРАВОЧНИКА — иначе
 * неизвестно, куда он пишет, и свойства проверять не на чем (страж fail-closed). У аккаунта eBay смоука список витрин был
 * пуст, и это ровно тот случай.
 */
UPDATE tenant_data.channel_account SET marketplaces = ARRAY['EBAY_DE'] WHERE tenant_id = :tA AND channel_account_id = :eAcc;

-- Мир остаётся таким, каким его ждут соседние файлы: аккаунт eBay возвращается в бой
SELECT pg_temp.ok('the eBay account returns to LIVE (Р-170)', format($q$
  INSERT INTO tenant_data.channel_write_mode_change (tenant_id, channel_account_id, from_mode, to_mode, changed_by_membership_id, typed_confirmation)
  VALUES (%L, %L, 'SHADOW', 'LIVE', %L, 'ebay-user-a') $q$, :tA, :eAcc, :ownerM));

/**
 * Мир остаётся с ОДНИМ теневым аккаунтом — действующим, с ключами. Он нужен проверке целей недельного дайджеста
 * (`tests/db/smoke_alerts_delivery.sql`, находка 13 ревью шага 41): без теневого аккаунта та проверка утверждала бы ноль
 * из пустоты. Единиц записи у этого аккаунта нет: он существует ровно чтобы тень была не нулём.
 */
INSERT INTO tenant_data.channel_account (tenant_id, channel_account_id, channel, external_account_id, marketplaces, credentials_ref, connected_by_membership_id)
VALUES (:tA, 'a4410000-0000-4000-8000-000000000001', 'KAUFLAND', 'seller-shadow', ARRAY['de'], 'vault://a/shadow', :ownerM);
DO $$
BEGIN
  IF (SELECT write_mode FROM tenant_data.channel_account WHERE channel_account_id = 'a4410000-0000-4000-8000-000000000001') <> 'SHADOW' THEN
    RAISE EXCEPTION 'a new channel account is not connected in SHADOW mode (Р-170)';
  END IF;
  RAISE NOTICE 'PASS accept | a new channel account is connected in the shadow by default (Р-170)';
END $$;
