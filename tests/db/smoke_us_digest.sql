-- Р-172…Р-174 (шаг 42): свойства витрин с честным статусом, деньги в дайджесте тени и отметка его доставки.
-- Выполнять БЕЗ PGUSER (суперпользователем) после smoke_shadow.sql: файл проверяет три разные роли — владельца схемы
-- (справочник витрин), административную (журнал переключений) и роль доставки (дайджест), — и каждая часть идёт под
-- СВОЕЙ ролью через SET ROLE, чтобы политики строк и права по столбцам работали как в работе. Данные синтетические.
--
-- Проверяется здесь три вещи:
--   Р-172) статус свойства витрины — конфигурируемое значение с названным вопросом, и НЕИЗВЕСТНОЕ свойство держит БОЙ;
--   Р-173) суммы дайджеста — по каждой валюте отдельно, и сумма без валюты в базу не попадает [Р-71];
--   Р-174) у дайджеста одна строка на период, числа неизменяемы, доставка отмечается один раз.
\set ON_ERROR_STOP 1
\set QUIET 1

\i tests/db/smoke_helpers.sql

\set tA '''a0000000-0000-0000-0000-00000000000a'''
\set ownerM '''a2000000-0000-0000-0000-00000000000a'''
\set ownerU '''a1000000-0000-0000-0000-00000000000a'''
-- Теневой аккаунт, оставленный smoke_shadow.sql: витрина `de` (Kaufland), свойства известны или консервативны
\set shadowAcc '''a4410000-0000-4000-8000-000000000001'''

SELECT set_config('app.tenant_id', :tA, false), set_config('app.user_id', :ownerU, false), set_config('app.auth_mfa', 'on', false) \gset

-- ---------------------------------------------------------------- Р-172: статус свойства витрины
SET ROLE repracer_owner;

-- Статус — из закрытого списка: «почти подтверждено» и прочие оттенки в базу не попадают
SELECT pg_temp.expect_fail('an unknown property status (Р-172)', $q$
  UPDATE platform.marketplace SET tax_status = 'ALMOST' WHERE marketplace = 'de' $q$,
  'marketplace_property_status_known');

-- «Чем закрывается» — тоже из закрытого списка: свойство, которое закрывается «как-нибудь», не закроется никогда
SELECT pg_temp.expect_fail('an unknown way to close a property (Р-172)', $q$
  UPDATE platform.marketplace SET tax_closes_by = 'SOMEDAY' WHERE marketplace = 'de' $q$,
  'marketplace_property_closes_by_known');

-- Неподтверждённое свойство ОБЯЗАНО называть вопрос: иначе «проверить» теряется молча
SELECT pg_temp.expect_fail('an unconfirmed tax basis without a named question (Р-172)', $q$
  UPDATE platform.marketplace SET tax_question = NULL WHERE marketplace = 'de' $q$,
  'marketplace_tax_question_named_while_unconfirmed');
SELECT pg_temp.expect_fail('an unconfirmed day boundary without a named question (Р-172)', $q$
  UPDATE platform.marketplace SET time_zone_question = NULL WHERE marketplace = 'de' $q$,
  'marketplace_time_zone_question_named_while_unconfirmed');

-- Вопрос — код вопроса, а не фраза: «спросить у Amazon» не ищется ни в одном документе
SELECT pg_temp.expect_fail('a question that is not a question code (Р-172)', $q$
  UPDATE platform.marketplace SET tax_question = 'спросить у Amazon' WHERE marketplace = 'de' $q$,
  'marketplace_question_shape');

-- Источник значения назван: «ну так принято» источником не считается
SELECT pg_temp.expect_fail('a tax basis without a named source (Р-172)', $q$
  UPDATE platform.marketplace SET tax_source = 'принято' WHERE marketplace = 'de' $q$,
  'marketplace_tax_source_named');

/**
 * Подтверждение свойства УБИРАЕТ его вопрос — это уборка, а не отказ: подтвердить свойство можно, не зная про столбец
 * вопроса, и «подтверждено, но вопрос открыт» не остаётся в базе никогда.
 */
/**
 * Проверка идёт ЧЕРЕЗ ПОМОЩНИК, а не сырым `DO`: мутационная проверка читает вывод по метке [Р-99], а сырой `RAISE` обрывает
 * файл, ничего про метку не напечатав, — и снятая защита выглядела бы «проверка осталась зелёной». Мутационный прогон шага 42
 * на этом и поймал ложную строку каталога: снятие триггера уборки не роняло ни одной названной проверки.
 */
SELECT pg_temp.ok('confirming a property clears its open question (Р-172)', $q$
  DO $inner$
  DECLARE
    q text;
  BEGIN
    UPDATE platform.marketplace SET tax_status = 'CONFIRMED',
           tax_source = 'проба смоука: подтверждение убирает вопрос (Р-172)'
     WHERE marketplace = 'at';
    SELECT tax_question INTO q FROM platform.marketplace WHERE marketplace = 'at';
    IF q IS NOT NULL THEN
      RAISE EXCEPTION 'a confirmed property still carries an open question % (Р-172)', q;
    END IF;
  END $inner$ $q$);
-- Мир остаётся таким, каким его ждут соседние файлы (и после провала проверки выше — тоже)
UPDATE platform.marketplace SET tax_status = 'CONSERVATIVE', tax_question = 'K-12',
       tax_source = 'Р-53, Р-58: цены витрин Kaufland — брутто с НДС внутри; подтверждения документацией нет (K-12)'
 WHERE marketplace = 'at';

/**
 * Область записи — свойство ВОЗМОЖНОСТИ канала. Возможность версионируется, и правкой её не проверить (менять можно
 * только `status` и `valid_from`, 0027) — пробы идут НОВОЙ строкой возможности, как её и заводят в работе.
 */
SELECT pg_temp.expect_fail('an unknown write scope status (Р-172)', $q$
  INSERT INTO platform.channel_capability (capability_id, version, status, valid_from, channel, region, api_mode, field,
    write_scope_kind, write_scope_key_template, processing_mode, requires_side_effects_ack, observation_data_class,
    write_scope_status, write_scope_question, write_scope_closes_by)
  VALUES ('c0420000-0000-4000-8000-000000000001', 1, 'DRAFT', now(), 'KAUFLAND', NULL, 'KAUFLAND_SELLER_API_V2', 'PRICE',
    'ACCOUNT_STOREFRONT_UNIT', ARRAY['channel_account','marketplace','external_unit_id'], 'SYNC', false, 'CHANNEL_INFO',
    -- Вопрос назван: иначе первым отказал бы страж «неподтверждённое называет вопрос», то есть СОСЕДНЯЯ защита [Р-99]
    'MAYBE', 'A-16', 'CHANNEL_SUPPORT') $q$,
  'channel_capability_write_scope_status_known');
SELECT pg_temp.expect_fail('an unknown way to close the write scope question (Р-172)', $q$
  INSERT INTO platform.channel_capability (capability_id, version, status, valid_from, channel, region, api_mode, field,
    write_scope_kind, write_scope_key_template, processing_mode, requires_side_effects_ack, observation_data_class,
    write_scope_status, write_scope_closes_by)
  VALUES ('c0420000-0000-4000-8000-000000000002', 1, 'DRAFT', now(), 'KAUFLAND', NULL, 'KAUFLAND_SELLER_API_V2', 'PRICE',
    'ACCOUNT_STOREFRONT_UNIT', ARRAY['channel_account','marketplace','external_unit_id'], 'SYNC', false, 'CHANNEL_INFO',
    'CONFIRMED', 'LATER') $q$,
  'channel_capability_write_scope_closes_by_known');
SELECT pg_temp.expect_fail('a conservative write scope without a question (Р-172)', $q$
  INSERT INTO platform.channel_capability (capability_id, version, status, valid_from, channel, region, api_mode, field,
    write_scope_kind, write_scope_key_template, processing_mode, requires_side_effects_ack, observation_data_class,
    write_scope_status, write_scope_closes_by)
  VALUES ('c0420000-0000-4000-8000-000000000003', 1, 'DRAFT', now(), 'KAUFLAND', NULL, 'KAUFLAND_SELLER_API_V2', 'PRICE',
    'ACCOUNT_STOREFRONT_UNIT', ARRAY['channel_account','marketplace','external_unit_id'], 'SYNC', false, 'CHANNEL_INFO',
    'CONSERVATIVE', 'CHANNEL_SUPPORT') $q$,
  'channel_capability_write_scope_question_iff_unconfirmed');

RESET ROLE;

/**
 * ЗУБЫ Р-172: пока у витрины аккаунта есть свойство со статусом UNKNOWN, бой не включается — тень при этом работает.
 * Проверяется это НАСТОЯЩИМ переводом: заводится аккаунт на витрине amazon.com, у которой не известна граница суток, и
 * владелец со вторым фактором и верным подтверждением получает отказ, называющий витрину, свойство и вопрос.
 *
 * Аккаунт заводится ЗАНОВО, а не переставляется на другую витрину: канал аккаунта менять нельзя (0012), а `SET ROLE
 * repracer_owner` для правки данных тенанта бесполезен — у владельца схемы политики строк на `channel_account` нет, и
 * UPDATE молча меняет НОЛЬ строк (первая редакция этой проверки так и зеленела).
 */
SET ROLE repracer_admin;
SELECT set_config('app.tenant_id', :tA, false), set_config('app.user_id', :ownerU, false), set_config('app.auth_mfa', 'on', false) \gset
SELECT pg_temp.ok('a channel account on amazon.com is connected in the shadow (Р-170)', format($q$
  INSERT INTO tenant_data.channel_account (tenant_id, channel_account_id, channel, region, external_account_id, marketplaces, credentials_ref, connected_by_membership_id)
  VALUES (%L, 'a4420000-0000-4000-8000-000000000001', 'AMAZON', 'NA', 'seller-us', ARRAY['ATVPDKIKX0DER'], 'vault://a/us', %L) $q$, :tA, :ownerM));

SELECT set_config('app.tenant_id', :tA, false), set_config('app.user_id', :ownerU, false), set_config('app.auth_mfa', 'on', false) \gset
SELECT pg_temp.expect_fail('switching to LIVE on a marketplace with an unknown property (Р-172)', format($q$
  INSERT INTO tenant_data.channel_write_mode_change (tenant_id, channel_account_id, from_mode, to_mode, changed_by_membership_id, typed_confirmation)
  VALUES (%L, 'a4420000-0000-4000-8000-000000000001', 'SHADOW', 'LIVE', %L, 'seller-us') $q$, :tA, :ownerM),
  'marketplace property is unknown');

/**
 * Находка 1 ревью шага 42: состояние «боевой аккаунт с витриной, свойства которой неизвестны» достигалось ОБЫЧНОЙ
 * ПРАВКОЙ — `marketplaces` изменяемый столбец, и проверка стояла только на переходе в бой. Теперь правило проверяется у
 * обоих входов, и здесь — второй: боевому аккаунту добавляют `amazon.com`.
 */
SELECT pg_temp.expect_fail('adding amazon.com to a LIVE account (Р-172, находка 1 ревью шага 42)', format($q$
  UPDATE tenant_data.channel_account SET marketplaces = ARRAY['A1PA6795UKMFR9', 'ATVPDKIKX0DER']
   WHERE tenant_id = %L AND channel_account_id = 'a4000000-0000-0000-0000-000000000002' $q$, :tA),
  'marketplace property is unknown');
-- Положительный контроль [Р-94]: витрина с известными свойствами боевому аккаунту добавляется без возражений
SELECT pg_temp.ok('adding a known marketplace to a LIVE account (Р-172)', format($q$
  UPDATE tenant_data.channel_account SET marketplaces = ARRAY['A1PA6795UKMFR9']
   WHERE tenant_id = %L AND channel_account_id = 'a4000000-0000-0000-0000-000000000002' $q$, :tA));

/**
 * Находка 6 ревью шага 42: аккаунт мог РОДИТЬСЯ боевым — страж режима стоял только на UPDATE. Создание боевого аккаунта
 * на витрине с неизвестным свойством отклоняется тем же правилом.
 */
SELECT pg_temp.expect_fail('a channel account born LIVE on amazon.com (Р-172, находка 6 ревью шага 42)', format($q$
  INSERT INTO tenant_data.channel_account (tenant_id, channel_account_id, channel, region, external_account_id, marketplaces, credentials_ref, connected_by_membership_id, write_mode)
  VALUES (%L, 'a4420000-0000-4000-8000-000000000002', 'AMAZON', 'NA', 'seller-us-2', ARRAY['ATVPDKIKX0DER'], 'vault://a/us2', %L, 'LIVE') $q$, :tA, :ownerM),
  'marketplace property is unknown');

/**
 * Находка 2 ревью шага 42: ветку fail-closed «витрины аккаунта не ВИДНЫ» нечем было провалить — в мире не было аккаунта
 * без витрин из справочника. Теперь есть: аккаунт, не называющий ни одной витрины, в бой не переводится, и причина
 * своя — «свойства витрин не видны», а не «свойство неизвестно».
 */
SELECT pg_temp.ok('a channel account without marketplaces is connected in the shadow (Р-170)', format($q$
  INSERT INTO tenant_data.channel_account (tenant_id, channel_account_id, channel, external_account_id, marketplaces, credentials_ref, connected_by_membership_id)
  VALUES (%L, 'a4420000-0000-4000-8000-000000000003', 'KAUFLAND', 'seller-no-storefront', ARRAY[]::text[], 'vault://a/none', %L) $q$, :tA, :ownerM));
SELECT pg_temp.expect_fail('switching to LIVE an account whose marketplaces are not visible (Р-172, находка 2 ревью шага 42)', format($q$
  INSERT INTO tenant_data.channel_write_mode_change (tenant_id, channel_account_id, from_mode, to_mode, changed_by_membership_id, typed_confirmation)
  VALUES (%L, 'a4420000-0000-4000-8000-000000000003', 'SHADOW', 'LIVE', %L, 'seller-no-storefront') $q$, :tA, :ownerM),
  'свойства витрин не видны');

-- Положительный контроль [Р-94]: та же строка у аккаунта витрины `de`, свойства которой известны или консервативны

SELECT pg_temp.ok('switching to LIVE on a marketplace whose properties are known (Р-172)', format($q$
  INSERT INTO tenant_data.channel_write_mode_change (tenant_id, channel_account_id, from_mode, to_mode, changed_by_membership_id, typed_confirmation)
  VALUES (%L, %L, 'SHADOW', 'LIVE', %L, 'seller-shadow') $q$, :tA, :shadowAcc, :ownerM));
-- Мир остаётся с теневым аккаунтом: его ждут цели дайджеста
SELECT pg_temp.ok('the shadow account goes back to the shadow (Р-170)', format($q$
  INSERT INTO tenant_data.channel_write_mode_change (tenant_id, channel_account_id, from_mode, to_mode, changed_by_membership_id)
  VALUES (%L, %L, 'LIVE', 'SHADOW', %L) $q$, :tA, :shadowAcc, :ownerM));

-- ---------------------------------------------------------------- Р-173, Р-174: дайджест с деньгами и отметкой доставки
RESET ROLE;
SET ROLE repracer_alert_delivery;
SELECT set_config('app.tenant_id', :tA, false) \gset

SELECT pg_temp.ok('the delivery role records a digest of a period (Р-174)', format($q$
  INSERT INTO tenant_data.shadow_digest (tenant_id, period_start, period_end, decisions, changes, held_writes, floor_held, floor_savings)
  VALUES (%L, now() - interval '7 days', now(), 1200, 34, 48, 12, '[{"currency": "EUR", "minor": 4500}]'::jsonb) $q$, :tA));

-- Одно письмо на период: второе отклоняет БАЗА, а не осторожность процесса
SELECT pg_temp.expect_fail('a second digest for the same period (Р-174)', format($q$
  INSERT INTO tenant_data.shadow_digest (tenant_id, period_start, period_end, decisions, changes, held_writes, floor_held)
  SELECT %L, period_start, period_end, 1, 1, 1, 1 FROM tenant_data.shadow_digest WHERE tenant_id = %L $q$, :tA, :tA),
  'shadow_digest_one_per_period');

-- Период с концом раньше начала — не период
SELECT pg_temp.expect_fail('a digest period that ends before it starts (Р-174)', format($q$
  INSERT INTO tenant_data.shadow_digest (tenant_id, period_start, period_end, decisions, changes, held_writes, floor_held)
  VALUES (%L, now(), now() - interval '1 day', 1, 1, 1, 1) $q$, :tA),
  'shadow_digest_period_sane');

-- Отрицательных чисел в отчёте не бывает: они означали бы ошибку агрегата, а не событие
SELECT pg_temp.expect_fail('a digest with a negative count (Р-174)', format($q$
  INSERT INTO tenant_data.shadow_digest (tenant_id, period_start, period_end, decisions, changes, held_writes, floor_held)
  VALUES (%L, now() - interval '1 day', now(), -1, 0, 0, 0) $q$, :tA),
  'shadow_digest_numbers_non_negative');

-- Сумма без валюты в базу не попадает [Р-71]: «на 4500 дешевле» без валюты — не деньги
SELECT pg_temp.expect_fail('a saving without a currency (Р-173, Р-71)', format($q$
  INSERT INTO tenant_data.shadow_digest (tenant_id, period_start, period_end, decisions, changes, held_writes, floor_held, floor_savings)
  VALUES (%L, now() - interval '2 days', now(), 1, 1, 1, 1, '[{"minor": 4500}]'::jsonb) $q$, :tA),
  'shadow_digest_savings_are_money');
SELECT pg_temp.expect_fail('a saving that is a bare number (Р-173, Р-71)', format($q$
  INSERT INTO tenant_data.shadow_digest (tenant_id, period_start, period_end, decisions, changes, held_writes, floor_held, floor_savings)
  VALUES (%L, now() - interval '2 days', now(), 1, 1, 1, 1, '[4500]'::jsonb) $q$, :tA),
  'shadow_digest_savings_are_money');

-- Дайджест не рождается доставленным: отметка ставится ПОСЛЕ отправки, иначе она ничего не доказывает
SELECT pg_temp.expect_fail('a digest recorded as already delivered (Р-174)', format($q$
  INSERT INTO tenant_data.shadow_digest (tenant_id, period_start, period_end, decisions, changes, held_writes, floor_held, delivered_at, delivery_kind)
  VALUES (%L, now() - interval '3 days', now(), 1, 1, 1, 1, now(), 'EMAIL_DIGEST') $q$, :tA),
  'cannot be recorded as already delivered');

-- Вид доставки — из закрытого списка, и третий вид — сухой режим
SELECT pg_temp.expect_fail('an unknown delivery kind (Р-174)', format($q$
  UPDATE tenant_data.shadow_digest SET delivered_at = now(), delivery_kind = 'PIGEON' WHERE tenant_id = %L $q$, :tA),
  'shadow_digest_delivery_kind_known');
-- Отметка без вида доставки ничего не доказывает
SELECT pg_temp.expect_fail('a delivery mark without its kind (Р-174)', format($q$
  UPDATE tenant_data.shadow_digest SET delivered_at = now() WHERE tenant_id = %L $q$, :tA),
  'shadow_digest_delivered_names_kind');

-- Числа письма неизменяемы: право роли доставки дано ПО СТОЛБЦАМ [Р-100], и переписать «что мы написали» ей нечем
SELECT pg_temp.expect_fail('rewriting the numbers of a digest (Р-174, Р-100)', format($q$
  UPDATE tenant_data.shadow_digest SET decisions = 99999 WHERE tenant_id = %L $q$, :tA),
  'permission denied for table shadow_digest');

SELECT pg_temp.ok('the delivery role marks the digest delivered (Р-174)', format($q$
  UPDATE tenant_data.shadow_digest SET delivered_at = now(), delivery_kind = 'DRY_RUN', delivery_ref = 'dry-run', delivery_attempts = 1
   WHERE tenant_id = %L $q$, :tA));

-- Доставленная строка не меняется вообще: второе письмо за тот же период не переписывает доказательство первого
SELECT pg_temp.expect_fail('marking a delivered digest again (Р-174)', format($q$
  UPDATE tenant_data.shadow_digest SET delivery_ref = 'second' WHERE tenant_id = %L $q$, :tA),
  'is already recorded');

RESET ROLE;
