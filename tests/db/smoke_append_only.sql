-- Р-103 (шаг 18): у каждой append-only таблицы в смоук-мире есть строка — иначе проверка неизменяемости попыткой изменения ничего
-- не проверяет. Пустые до этого места таблицы получают синтетическую строку в транзакции, которая откатывается: последующие
-- смоук-тесты (хранение, закрытие тенанта) видят мир без неё. Затем каждое изменение строки каждой append-only таблицы обязано
-- отклоняться именно триггером неизменяемости (находка 4 ревью шага 16). Выполнять суперпользователем после smoke_r65.sql.
\set ON_ERROR_STOP 1

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
SELECT set_config('app.tenant_id', 'a0000000-0000-0000-0000-00000000000a', true) \gset

INSERT INTO channel_data.competitor_move (tenant_id, channel_account_id, marketplace, channel_product_ref, condition, observed_at, move_bp, verdict)
VALUES ('a0000000-0000-0000-0000-00000000000a', 'a4000000-0000-0000-0000-000000000001', 'de', 'R103-1', 'new', now(), 150, 'ACCEPT');
-- Р-120 (0082): наблюдение собственного ценообразования канала
INSERT INTO channel_data.offer_channel_pricing (tenant_id, channel_account_id, channel, marketplace, external_sku, automated_pricing, channel_bounds, source, observed_at)
VALUES ('a0000000-0000-0000-0000-00000000000a', 'a4000000-0000-0000-0000-000000000001', 'KAUFLAND', 'de', 'R103-SKU', false, false, 'DISCOVERY', now());
-- Шаг 23, A (0083): журнал обработанных уведомлений и состояние PRICING_HEALTH
INSERT INTO channel_data.inbound_notification (tenant_id, channel_account_id, channel, notification_id, notification_type, event_time, received_at)
VALUES ('a0000000-0000-0000-0000-00000000000a', 'a4000000-0000-0000-0000-000000000001', 'KAUFLAND', 'SYN-N-R103', 'ANY_OFFER_CHANGED', now(), now());
INSERT INTO channel_data.offer_pricing_health (tenant_id, channel_account_id, channel, marketplace, channel_product_ref, condition, issue_type, event_time,
  competitive_price_threshold_minor, currency, notification_id)
VALUES ('a0000000-0000-0000-0000-00000000000a', 'a4000000-0000-0000-0000-000000000001', 'KAUFLAND', 'de', 'R103-1', 'new', 'BuyBoxDisqualification', now(), 1999, 'EUR', 'SYN-N-R103-H');
-- Шаг 24, A (0086) [Р-122]: журнал полных снимков конкурентов
INSERT INTO channel_data.competitor_snapshot_log (tenant_id, competitor_snapshot_id, received_at, observed_at, channel_account_id, channel, marketplace, channel_product_ref, condition, source, sanity_verdict, snapshot)
VALUES ('a0000000-0000-0000-0000-00000000000a', 'a9124000-0000-4000-8000-000000000001', now(), now(), 'a4000000-0000-0000-0000-000000000001', 'KAUFLAND', 'de', 'R103-1', 'new', 'KAUFLAND_BUYBOX', 'ACCEPT', '{"offers": []}');
SELECT pg_temp.expect_fail('competitor snapshot log with an unknown sanity verdict (Р-122)', $q$
  INSERT INTO channel_data.competitor_snapshot_log (tenant_id, competitor_snapshot_id, received_at, observed_at, channel_account_id, channel, marketplace, channel_product_ref, condition, source, sanity_verdict, snapshot)
  VALUES ('a0000000-0000-0000-0000-00000000000a', gen_random_uuid(), now(), now(), 'a4000000-0000-0000-0000-000000000001', 'KAUFLAND', 'de', 'R103-1', 'new', 'KAUFLAND_BUYBOX', 'MAYBE', '{}') $q$, 'competitor_snapshot_log_verdict_known');
SELECT pg_temp.expect_fail('competitor snapshot log whose snapshot is not an object (Р-122)', $q$
  INSERT INTO channel_data.competitor_snapshot_log (tenant_id, competitor_snapshot_id, received_at, observed_at, channel_account_id, channel, marketplace, channel_product_ref, condition, source, sanity_verdict, snapshot)
  VALUES ('a0000000-0000-0000-0000-00000000000a', gen_random_uuid(), now(), now(), 'a4000000-0000-0000-0000-000000000001', 'KAUFLAND', 'de', 'R103-1', 'new', 'KAUFLAND_BUYBOX', 'ACCEPT', '[]') $q$, 'competitor_snapshot_log_snapshot_object');
INSERT INTO channel_data.price_decision_snapshot_ref (tenant_id, price_decision_id, decided_at, write_scope_id, competitor_snapshot_id, source, observed_at)
SELECT tenant_id, price_decision_id, decided_at, write_scope_id, 'a9103000-0000-4000-8000-000000000001', 'KAUFLAND_BUYBOX', decided_at
  FROM channel_data.price_decision WHERE price_decision_id = 'a8000000-0000-0000-0000-000000000001';
-- Остановка витрины at — фикстура smoke_app.sql (одна действующая остановка на витрину)
INSERT INTO channel_data.pricing_halt_sample (tenant_id, pricing_halt_id, channel_product_ref, observed_at, verdict, reason_code)
VALUES ('a0000000-0000-0000-0000-00000000000a', 'ab180000-0000-4000-8000-000000000001', 'R103-1', now(), 'READ_FAILED', 'CHANNEL_TIMEOUT');
INSERT INTO channel_data.pricing_halt_review (tenant_id, pricing_halt_id, kind, outcome, sample_size, failed_count, reviewed_at)
VALUES ('a0000000-0000-0000-0000-00000000000a', 'ab180000-0000-4000-8000-000000000001', 'AUTO_SAMPLE', 'SAMPLE_FAILED', 1, 1, now());
INSERT INTO channel_data.rejected_competitor_snapshot (tenant_id, channel_account_id, channel, marketplace, channel_product_ref, condition, source, observed_at,
  received_at, verdict, reason_code, alarm_class, ruleset_version)
VALUES ('a0000000-0000-0000-0000-00000000000a', 'a4000000-0000-0000-0000-000000000001', 'KAUFLAND', 'de', 'R103-1', 'new', 'KAUFLAND_BUYBOX', now(), now(), 'REJECT', 'INVALID_AMOUNT', 'STRUCTURE', 'r49.1');
INSERT INTO legal.migration_consent_record (tenant_id, migration_consent_id, channel_account_id, channel_external_account_id, consenting_user_id, consenting_role,
  mfa_verified_at, disclosure_version, disclosure_text_sha256, other_tools_declaration, typed_confirmation, given_at, expires_at, items, tenant_closed_at)
VALUES ('a0000000-0000-0000-0000-00000000000a', 'ae103000-0000-4000-8000-000000000001', 'a4000000-0000-0000-0000-000000000003', 'syn-ebay-account', 'a1000000-0000-0000-0000-00000000000a', 'OWNER',
        now(), 'd1', sha256('text'), 'NONE', 'I understand', now(), now() + interval '3 days', '[]', now());
INSERT INTO maintenance.price_day_close (price_day, day_tz, rows_inserted) VALUES (current_date - 400, 'Europe/Berlin', 0);
INSERT INTO platform.external_identity (issuer, subject, user_id) VALUES ('https://idp.smoke.repracer.test', 'r103-previous', 'a1000000-0000-0000-0000-00000000000a');
INSERT INTO platform.external_identity_revocation (issuer, subject, invitation_id)
VALUES ('https://idp.smoke.repracer.test', 'r103-previous', 'ad103000-0000-4000-8000-000000000001');
INSERT INTO tenant_data.cost_profile (tenant_id, product_id, version, valid_from, currency, purchase_cost_minor, source)
SELECT 'a0000000-0000-0000-0000-00000000000a', 'a5000000-0000-0000-0000-000000000001', coalesce(max(version), 0) + 1, now(), 'EUR', 900, 'MANUAL'
  FROM tenant_data.cost_profile WHERE tenant_id = 'a0000000-0000-0000-0000-00000000000a' AND product_id = 'a5000000-0000-0000-0000-000000000001' AND channel_account_id IS NULL;
INSERT INTO tenant_data.divergence_policy (tenant_id, scope_type, field, on_external_change, version, created_by_membership_id)
VALUES ('a0000000-0000-0000-0000-00000000000a', 'TENANT', 'PRICE', 'ASK_HUMAN', 1, 'a2000000-0000-0000-0000-00000000000a');
INSERT INTO tenant_data.guardrail (tenant_id, scope_type, product_id, min_margin_bp, on_violation, version, created_by_membership_id)
SELECT 'a0000000-0000-0000-0000-00000000000a', 'PRODUCT', 'a5000000-0000-0000-0000-000000000001', 500, 'HOLD', coalesce(max(version), 0) + 1, 'a2000000-0000-0000-0000-00000000000a'
  FROM tenant_data.guardrail WHERE tenant_id = 'a0000000-0000-0000-0000-00000000000a' AND product_id = 'a5000000-0000-0000-0000-000000000001';
INSERT INTO tenant_data.migration_consent_revocation (tenant_id, migration_consent_id, revoked_by_membership_id)
VALUES ('a0000000-0000-0000-0000-00000000000a', 'ae000000-0000-0000-0000-000000000001', 'a2000000-0000-0000-0000-00000000000a');
INSERT INTO tenant_data.price_daily (tenant_id, write_scope_id, price_type, price_day, day_tz, currency, price_basis, min_amount_minor, max_amount_minor,
  first_amount_minor, first_accepted_at, last_amount_minor, last_accepted_at, change_count, min_floor_minor)
VALUES ('a0000000-0000-0000-0000-00000000000a', 'a6000000-0000-0000-0000-000000000001', 'REGULAR', current_date - 400, 'Europe/Berlin', 'EUR', 'GROSS', 1200, 1200, 1200,
        (current_date - 400)::timestamp AT TIME ZONE 'Europe/Berlin' + interval '10 hours', 1200,
        (current_date - 400)::timestamp AT TIME ZONE 'Europe/Berlin' + interval '10 hours', 1, 1000);
INSERT INTO tenant_data.price_daily_correction (tenant_id, write_scope_id, price_type, price_day, min_amount_minor, max_amount_minor, first_amount_minor,
  first_accepted_at, last_amount_minor, last_accepted_at, change_count, min_floor_minor, reason, created_by_membership_id)
SELECT tenant_id, write_scope_id, price_type, price_day, 1100, 1200, 1100, first_accepted_at, last_amount_minor, last_accepted_at, 2, min_floor_minor,
       'Synthetic correction for the append-only check (Р-103)', 'a2000000-0000-0000-0000-00000000000a'
  FROM tenant_data.price_daily WHERE tenant_id = 'a0000000-0000-0000-0000-00000000000a' AND price_day = current_date - 400;
-- Шаг 24, C (0087) [Р-123]: объявление скидки проверяет Omnibus база. Цена единицы по суточной свёртке — 1200 (исправление выше),
-- действует к началу окна: прежняя цена выше 1200 — нарушение, 1200 — принято со статусом OK
SELECT pg_temp.expect_fail('discount announced with a prior price above the lowest price of 30 days (Omnibus, Р-123)', $q$
  INSERT INTO tenant_data.discount_announcement (tenant_id, write_scope_id, reference_price_minor, sale_price_minor, currency, starts_at, created_by_membership_id, check_status)
  VALUES ('a0000000-0000-0000-0000-00000000000a', 'a6000000-0000-0000-0000-000000000001', 1300, 1000, 'EUR', now(), 'a2000000-0000-0000-0000-00000000000a', 'OK') $q$,
  'is above the lowest price 1200 of the 30 days');
SELECT pg_temp.expect_fail('discount announced in a currency other than the currency of the offer (Р-71, Р-123)', $q$
  INSERT INTO tenant_data.discount_announcement (tenant_id, write_scope_id, reference_price_minor, sale_price_minor, currency, starts_at, created_by_membership_id, check_status)
  VALUES ('a0000000-0000-0000-0000-00000000000a', 'a6000000-0000-0000-0000-000000000001', 1200, 1000, 'USD', now(), 'a2000000-0000-0000-0000-00000000000a', 'OK') $q$,
  'is not the currency of price write_scope');
SELECT pg_temp.expect_fail('discount whose sale price is not below the prior price (Р-123)', $q$
  INSERT INTO tenant_data.discount_announcement (tenant_id, write_scope_id, reference_price_minor, sale_price_minor, currency, starts_at, created_by_membership_id, check_status)
  VALUES ('a0000000-0000-0000-0000-00000000000a', 'a6000000-0000-0000-0000-000000000001', 1200, 1200, 'EUR', now(), 'a2000000-0000-0000-0000-00000000000a', 'OK') $q$,
  'discount_announcement_prices');
SELECT pg_temp.expect_fail('discount ending before it starts (Р-123)', $q$
  INSERT INTO tenant_data.discount_announcement (tenant_id, write_scope_id, reference_price_minor, sale_price_minor, currency, starts_at, ends_at, created_by_membership_id, check_status)
  VALUES ('a0000000-0000-0000-0000-00000000000a', 'a6000000-0000-0000-0000-000000000001', 1200, 1000, 'EUR', now(), now() - interval '1 day', 'a2000000-0000-0000-0000-00000000000a', 'OK') $q$,
  'discount_announcement_period');
INSERT INTO tenant_data.discount_announcement (tenant_id, write_scope_id, reference_price_minor, sale_price_minor, currency, starts_at, created_by_membership_id, check_status, lowest_prior_minor)
VALUES ('a0000000-0000-0000-0000-00000000000a', 'a6000000-0000-0000-0000-000000000001', 1200, 1000, 'EUR', now(), 'a2000000-0000-0000-0000-00000000000a', 'TIME_ZONE_UNKNOWN', 99999);
DO $$ BEGIN
  IF (SELECT (check_status, lowest_prior_minor) FROM tenant_data.discount_announcement WHERE tenant_id = 'a0000000-0000-0000-0000-00000000000a' ORDER BY created_at DESC LIMIT 1)
     IS DISTINCT FROM ('OK'::text, 1200::bigint) THEN
    RAISE EXCEPTION 'the Omnibus check of a discount announcement is not computed by the database (Р-123)';
  END IF;
  RAISE NOTICE 'PASS accept | the Omnibus check of a discount announcement is computed by the database (Р-123)';
END $$;
INSERT INTO tenant_data.product_vat_rate (tenant_id, product_id, country, rate_bp, version, created_by_membership_id)
SELECT 'a0000000-0000-0000-0000-00000000000a', 'a5000000-0000-0000-0000-000000000001', 'AT', 1000, coalesce(max(version), 0) + 1, 'a2000000-0000-0000-0000-00000000000a'
  FROM tenant_data.product_vat_rate WHERE tenant_id = 'a0000000-0000-0000-0000-00000000000a' AND product_id = 'a5000000-0000-0000-0000-000000000001' AND country = 'AT';

-- Шаг 23 [Р-108]: TRUNCATE новой append-only таблицы отклоняет свой триггер
SELECT pg_temp.expect_fail('truncate channel_data.offer_channel_pricing', $q$ TRUNCATE channel_data.offer_channel_pricing $q$, 'TRUNCATE of channel_data.offer_channel_pricing is forbidden');
SELECT pg_temp.expect_fail('truncate tenant_data.discount_announcement', $q$ TRUNCATE tenant_data.discount_announcement $q$, 'TRUNCATE of tenant_data.discount_announcement is forbidden');
SELECT pg_temp.expect_fail('truncate channel_data.competitor_snapshot_log', $q$ TRUNCATE channel_data.competitor_snapshot_log $q$, 'TRUNCATE of channel_data.competitor_snapshot_log is forbidden');
SELECT pg_temp.expect_fail('truncate channel_data.inbound_notification', $q$ TRUNCATE channel_data.inbound_notification $q$, 'TRUNCATE of channel_data.inbound_notification is forbidden');
SELECT pg_temp.expect_fail('pricing health threshold without its currency (Р-71)', $q$
  INSERT INTO channel_data.offer_pricing_health (tenant_id, channel_account_id, channel, marketplace, channel_product_ref, condition, issue_type, event_time, competitive_price_threshold_minor, currency, notification_id)
  VALUES ('a0000000-0000-0000-0000-00000000000a', 'a4000000-0000-0000-0000-000000000001', 'KAUFLAND', 'de', 'R103-1', 'new', 'BuyBoxDisqualification', now(), 1999, NULL, 'SYN-N-R71') $q$, 'offer_pricing_health_threshold_money');
SELECT pg_temp.expect_fail('truncate channel_data.offer_pricing_health', $q$ TRUNCATE channel_data.offer_pricing_health $q$, 'TRUNCATE of channel_data.offer_pricing_health is forbidden');

-- Находка 4 ревью шага 16, Р-93, Р-103: у каждой append-only таблицы есть строка, и изменение строки отклоняет именно триггер неизменяемости
DO $$
DECLARE
  t regclass;
  has_row boolean;
  uncovered text[] := '{}';
BEGIN
  FOR t IN SELECT table_name FROM security.table_registry WHERE mutation_mode = 'append_only' ORDER BY table_name::text LOOP
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %s)', t) INTO has_row;
    IF has_row THEN
      PERFORM pg_temp.expect_fail(format('append-only %s', t),
        format('UPDATE %1$s SET tenant_id = tenant_id WHERE (tableoid, ctid) = (SELECT tableoid, ctid FROM %1$s LIMIT 1)', t), 'append-only table');
    ELSE
      uncovered := uncovered || t::text;
    END IF;
  END LOOP;
  IF cardinality(uncovered) > 0 THEN
    IF current_setting('repracer.smoke_collect', true) = 'on' THEN
      RAISE WARNING 'CHECK FAILED: every append-only table has a row in the smoke world (Р-103) | no rows: %', array_to_string(uncovered, ', ');
    ELSE
      RAISE EXCEPTION 'append-only tables without a row in the smoke world (Р-103): %', array_to_string(uncovered, ', ');
    END IF;
  ELSE
    RAISE NOTICE 'PASS accept | every append-only table has a row in the smoke world (Р-103)';
  END IF;
END $$;
ROLLBACK;
