-- Р-65 после smoke_app.sql, от суперпользователя: запись с бюджетом правок требует подтверждённой границы суток витрины
\set ON_ERROR_STOP 1
\set tA 'a0000000-0000-0000-0000-00000000000a'
CREATE FUNCTION pg_temp.expect_fail(label text, q text, reason text DEFAULT NULL) RETURNS void LANGUAGE plpgsql AS $$
-- Р-94: reason — ожидаемая причина отказа (SQLSTATE или шаблон сообщения); отказ по другой причине — провал проверки.
-- Р-95: при repracer.smoke_collect = on (мутационная проверка) провал не останавливает прогон, а пишется предупреждением CHECK FAILED.
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
      -- Р-94 (шаг 18): причина обязательна и сверяется с текстом отказа — SQLSTATE недостаточно (42501 дают и защитные триггеры)
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
-- Р-95: как у expect_fail — при repracer.smoke_collect = on отказ разрешённого действия пишется предупреждением CHECK FAILED
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
BEGIN;
-- Р-172: снятие подтверждения НАЗЫВАЕТ вопрос — «снова не подтверждено, а почему» база хранить обязывает
UPDATE platform.marketplace SET time_zone_status = 'TO_VERIFY', time_zone_question = 'OQ-112' WHERE channel = 'EBAY' AND marketplace = 'EBAY_DE';
SELECT pg_temp.expect_fail('budgeted write while the storefront day boundary is unconfirmed (Р-65)', $q$
  INSERT INTO tenant_data.channel_write (tenant_id, channel_write_id, write_scope_id, field, quantity, version, origin, budget_scope_key, budget_day)
  VALUES ('a0000000-0000-0000-0000-00000000000a', gen_random_uuid(), 'a6000000-0000-0000-0000-000000000003', 'QUANTITY', 2, 90, 'STOCK_RECALC', 'L1', (now() AT TIME ZONE 'Europe/Berlin')::date) $q$, 'edit budget day of storefront EBAY_DE is not confirmed');
UPDATE platform.marketplace SET time_zone_status = 'CONFIRMED' WHERE channel = 'EBAY' AND marketplace = 'EBAY_DE';
SELECT pg_temp.expect_fail('budget day is not the current storefront day (Р-65)', $q$
  INSERT INTO tenant_data.channel_write (tenant_id, channel_write_id, write_scope_id, field, quantity, version, origin, budget_scope_key, budget_day)
  VALUES ('a0000000-0000-0000-0000-00000000000a', gen_random_uuid(), 'a6000000-0000-0000-0000-000000000003', 'QUANTITY', 2, 90, 'STOCK_RECALC', 'L1', (now() AT TIME ZONE 'Europe/Berlin')::date - 1) $q$, 'is not the current day .* of storefront');
SELECT pg_temp.expect_fail('US storefront confirmed without a time zone', $q$
  UPDATE platform.marketplace SET time_zone_status = 'CONFIRMED' WHERE marketplace = 'EBAY_US' $q$, 'marketplace_time_zone_known_if_confirmed');
-- C2 (ретроспективное ревью шага 14): повтор записи после полуночи витрины расходует бюджет ТЕКУЩЕГО дня, а не дня создания.
-- Бюджет сегодняшнего дня листинга L1 исчерпан smoke_app.sql (200 + 50 = 250). Запись переводится в FAILED, её день
-- переносится на вчера (как если бы она была создана до полуночи), и повтор обязан упереться в сегодняшний лимит.
-- До 0055 повтор списывался на вчерашний день и проходил.
UPDATE tenant_data.channel_write SET status = 'FAILED', next_attempt_at = now() WHERE channel_write_id = 'a9000000-0000-0000-0000-000000000012';
SET LOCAL session_replication_role = replica;
UPDATE tenant_data.channel_write SET budget_day = budget_day - 1 WHERE channel_write_id = 'a9000000-0000-0000-0000-000000000012';
/**
 * Шаг 52 (полный CI шага 51 около 22:08 UTC): smoke_app мог списать бюджет правок ДО полуночи витрины, а эта проверка идёт ПОСЛЕ неё —
 * тогда «сегодняшний бюджет исчерпан» было неправдой, а строка бюджета вчерашнего дня — законной, и проверка краснела раз в сутки
 * (скрытый вход «время на часах», как на шаге 29). Исчерпанный бюджет переносится на ТЕКУЩИЕ сутки витрины явно, а не зависит от часов
 */
UPDATE tenant_data.edit_budget SET budget_day = (now() AT TIME ZONE 'Europe/Berlin')::date
 WHERE budget_scope_key = 'L1' AND budget_day < (now() AT TIME ZONE 'Europe/Berlin')::date
   AND NOT EXISTS (SELECT 1 FROM tenant_data.edit_budget t WHERE t.budget_scope_key = 'L1' AND t.budget_day = (now() AT TIME ZONE 'Europe/Berlin')::date);
SET LOCAL session_replication_role = origin;
SELECT pg_temp.expect_fail('retry after midnight is charged to today, whose budget is exhausted (C2, Р-19)', $q$
  UPDATE tenant_data.channel_write SET status = 'DISPATCHED', attempt_count = attempt_count + 1, next_attempt_at = NULL
   WHERE channel_write_id = 'a9000000-0000-0000-0000-000000000012' $q$, 'edit_budget_total_limit');
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM tenant_data.edit_budget WHERE budget_scope_key = 'L1' AND budget_day < (now() AT TIME ZONE 'Europe/Berlin')::date) THEN
    RAISE EXCEPTION 'a retry charged the edit budget of a past day';
  END IF;
  RAISE NOTICE 'PASS reject | no attempt charged to a past budget day (C2)';
END $$;
-- Р-172: снятие подтверждения НАЗЫВАЕТ вопрос — «снова не подтверждено, а почему» база хранить обязывает
UPDATE platform.marketplace SET time_zone_status = 'TO_VERIFY', time_zone_question = 'OQ-112' WHERE channel = 'EBAY' AND marketplace = 'EBAY_DE';
SELECT pg_temp.expect_fail('retry while the storefront day boundary is unconfirmed (C2, Р-65)', $q$
  UPDATE tenant_data.channel_write SET status = 'DISPATCHED', attempt_count = attempt_count + 1, next_attempt_at = NULL
   WHERE channel_write_id = 'a9000000-0000-0000-0000-000000000012' $q$, 'retry of a budgeted write: the day boundary of storefront');
UPDATE platform.marketplace SET time_zone_status = 'CONFIRMED' WHERE channel = 'EBAY' AND marketplace = 'EBAY_DE';
-- Р-188 (шаг 47): граница суток нужна только БОЕВОЙ записи. Теневая запись создаётся без дня бюджета, а боевая при
-- неподтверждённой границе невозможна по-прежнему — ослабление для тени не протекает в бой. Режим аккаунта в смоуке
-- переключается мимо журнала (от суперпользователя, без триггеров): журнал и его стражи проверяет smoke_shadow.sql.
UPDATE platform.marketplace SET time_zone_status = 'TO_VERIFY', time_zone_question = 'OQ-112' WHERE channel = 'EBAY' AND marketplace = 'EBAY_DE';
SET LOCAL session_replication_role = replica;
UPDATE tenant_data.channel_account SET write_mode = 'SHADOW' WHERE channel_account_id = 'a4000000-0000-0000-0000-000000000003';
SET LOCAL session_replication_role = origin;
SELECT pg_temp.ok('a shadow budgeted write needs no confirmed day boundary and gets no budget day (Р-188)', $q$
  DO $i$
  DECLARE
    w uuid := gen_random_uuid();
    r record;
  BEGIN
    INSERT INTO tenant_data.channel_write (tenant_id, channel_write_id, write_scope_id, field, quantity, version, origin, budget_scope_key, budget_day)
    VALUES ('a0000000-0000-0000-0000-00000000000a', w, 'a6000000-0000-0000-0000-000000000003', 'QUANTITY', 2, 188, 'STOCK_RECALC', 'L1', (now() AT TIME ZONE 'Europe/Berlin')::date);
    SELECT final_status, budget_day, would_spend_budget INTO r FROM tenant_data.channel_write_history WHERE channel_write_id = w;
    IF r.final_status IS DISTINCT FROM 'SHADOW_HELD' OR r.budget_day IS NOT NULL OR r.would_spend_budget IS NOT TRUE THEN
      RAISE EXCEPTION 'shadow write kept a budget day or lost «would spend»: %', row_to_json(r);
    END IF;
    -- Условие 2 Р-188: «потратило бы» на витрине без подтверждённой границы — приблизительно, и база это считает
    IF platform.shadow_would_spend_unconfirmed('a0000000-0000-0000-0000-00000000000a', now() - interval '1 hour', now() + interval '1 hour') < 1 THEN
      RAISE EXCEPTION 'a would-spend write at an unconfirmed day boundary is not counted as approximate';
    END IF;
  END $i$ $q$);
SET LOCAL session_replication_role = replica;
UPDATE tenant_data.channel_account SET write_mode = 'LIVE' WHERE channel_account_id = 'a4000000-0000-0000-0000-000000000003';
SET LOCAL session_replication_role = origin;
SELECT pg_temp.expect_fail('a LIVE budgeted write at an unconfirmed day boundary stays impossible next to the shadow exception (Р-188)', $q$
  INSERT INTO tenant_data.channel_write (tenant_id, channel_write_id, write_scope_id, field, quantity, version, origin, budget_scope_key, budget_day)
  VALUES ('a0000000-0000-0000-0000-00000000000a', gen_random_uuid(), 'a6000000-0000-0000-0000-000000000003', 'QUANTITY', 2, 189, 'STOCK_RECALC', 'L1', (now() AT TIME ZONE 'Europe/Berlin')::date) $q$,
  'edit budget day of storefront EBAY_DE is not confirmed');
-- Условие 1 Р-188: перевод в бой при неподтверждённой границе — отказ. Второй вход того же правила (0130) — боевой аккаунт
-- eBay не получает витрину с неподтверждённой границей суток; перевод журналом проверяет smoke_shadow.sql
SELECT pg_temp.expect_fail('a LIVE eBay account on a storefront with an unconfirmed day boundary (Р-188, Р-172)', $q$
  UPDATE tenant_data.channel_account SET marketplaces = ARRAY['EBAY_DE'] WHERE channel_account_id = 'a4000000-0000-0000-0000-000000000003' $q$,
  'marketplace property is unknown: EBAY_DE / DAY_BOUNDARY');
-- Исключение ограничения — только у удержанной тенью записи: запись без дня при ключе бюджета в любом другом статусе
-- база не принимает. Триггеры выключены, чтобы ограничение отвечало само, а не страж дня выше [Р-99]
SET LOCAL session_replication_role = replica;
SELECT pg_temp.expect_fail('a budgeted write without a budget day outside the shadow (Р-188)', $q$
  INSERT INTO tenant_data.channel_write (tenant_id, channel_write_id, write_scope_id, field, quantity, version, origin, status, budget_scope_key)
  VALUES ('a0000000-0000-0000-0000-00000000000a', gen_random_uuid(), 'a6000000-0000-0000-0000-000000000003', 'QUANTITY', 2, 190, 'STOCK_RECALC', 'PENDING', 'L1') $q$,
  'channel_write_budget_day_iff_key');
SELECT pg_temp.expect_fail('a budget day without a budget key (Р-19, Р-188)', $q$
  INSERT INTO tenant_data.channel_write (tenant_id, channel_write_id, write_scope_id, field, quantity, version, origin, status, budget_day)
  VALUES ('a0000000-0000-0000-0000-00000000000a', gen_random_uuid(), 'a6000000-0000-0000-0000-000000000003', 'QUANTITY', 2, 191, 'STOCK_RECALC', 'SHADOW_HELD', current_date) $q$,
  'channel_write_budget_day_iff_key');
SET LOCAL session_replication_role = origin;
UPDATE platform.marketplace SET time_zone_status = 'CONFIRMED' WHERE channel = 'EBAY' AND marketplace = 'EBAY_DE';
-- Р-75, Р-61 (правила 23 и 33 проверки схемы заменены поведением, Р-93): справочник объяснения и курс ЕЦБ неизменяемы даже для суперпользователя
SELECT pg_temp.expect_fail('explanation ruleset is immutable (Р-75)', $q$
  UPDATE platform.explanation_ruleset SET definition = definition WHERE ruleset_id = 'r49.1' $q$, 'append-only table platform.explanation_ruleset: UPDATE is forbidden');
INSERT INTO platform.fx_rate (source, rate_date, base_currency, quote_currency, rate, available_from, source_ref)
VALUES ('ECB', DATE '2001-01-02', 'EUR', 'USD', 0.9423, TIMESTAMPTZ '2001-01-02 16:00+00', 'smoke r61 (rolled back)');
SELECT pg_temp.expect_fail('ECB rate is immutable (Р-61)', $q$
  UPDATE platform.fx_rate SET rate = 1.5 WHERE source_ref = 'smoke r61 (rolled back)' $q$, 'append-only table platform.fx_rate: UPDATE is forbidden');
-- Р-73, Р-85, Р-94: ядро intent, вставленное мимо решения (суперпользователем), тоже проверяется своими ограничениями
CREATE FUNCTION pg_temp.core_variant(overrides jsonb) RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  cols text;
BEGIN
  SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum) INTO cols FROM pg_attribute
   WHERE attrelid = 'tenant_data.price_intent_core'::regclass AND attnum > 0 AND NOT attisdropped AND attgenerated = '';
  RETURN format('INSERT INTO tenant_data.price_intent_core (%s) SELECT %s FROM tenant_data.price_intent_core src, jsonb_populate_record(NULL::tenant_data.price_intent_core, to_jsonb(src) || %L::jsonb) AS r WHERE src.intent_class = %L LIMIT 1',
                cols, regexp_replace(cols, '([^, ]+)', 'r.\1', 'g'), overrides || jsonb_build_object('price_intent_id', gen_random_uuid(), 'price_decision_id', gen_random_uuid()), 'CHANGED');
END $$;
SELECT pg_temp.expect_fail('eternal core: dangerous flag against the deviation (Р-73)', pg_temp.core_variant('{"bound_deviation_bp": 2000, "dangerous": false}'),
  'price_intent_core_dangerous_consistent');
SELECT pg_temp.expect_fail('eternal core: a competitor-derived rejection keeps its proposed price (Р-85)', pg_temp.core_variant('{"rule_code": "MATCH_BUYBOX", "intent_class": "REJECTED_BY_GATE", "decision_outcome": "REJECTED", "final_amount_minor": null, "rejection_reason": "ABOVE_MAX_PRICE", "reason_params": {"maxMinor": 5000, "currency": "EUR"}, "bound_deviation_bp": null, "dangerous": false}'),
  'price_intent_core_competitor_rejection_not_kept');
SELECT pg_temp.expect_fail('eternal core: an undeclared reason parameter in the explanation (finding 15)', pg_temp.core_variant('{"explanation": {"format":"r80.1","strategy":{"reason":{"code":"FIXED_PRICE","params":{"target":1780}}}}}'),
  'price_intent_core_explanation_keys_declared');
-- Неизменяемость всех append-only таблиц проверяется попыткой изменения в tests/db/smoke_append_only.sql (Р-103)
SELECT pg_temp.expect_fail('manual halt without a member and a note', $q$
  INSERT INTO channel_data.pricing_halt (tenant_id, channel_account_id, channel, marketplace, reason_code, details, halted_at)
  VALUES ('a0000000-0000-0000-0000-00000000000a', 'a4000000-0000-0000-0000-000000000003', 'EBAY', 'EBAY_DE', 'MANUAL', '{}', now()) $q$, 'pricing_halt_system_only');
ROLLBACK;
