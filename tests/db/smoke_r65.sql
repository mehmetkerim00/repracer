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
BEGIN;
UPDATE platform.marketplace SET time_zone_status = 'TO_VERIFY' WHERE channel = 'EBAY' AND marketplace = 'EBAY_DE';
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
UPDATE platform.marketplace SET time_zone_status = 'TO_VERIFY' WHERE channel = 'EBAY' AND marketplace = 'EBAY_DE';
SELECT pg_temp.expect_fail('retry while the storefront day boundary is unconfirmed (C2, Р-65)', $q$
  UPDATE tenant_data.channel_write SET status = 'DISPATCHED', attempt_count = attempt_count + 1, next_attempt_at = NULL
   WHERE channel_write_id = 'a9000000-0000-0000-0000-000000000012' $q$, 'retry of a budgeted write: the day boundary of storefront');
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
