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
INSERT INTO channel_data.competitor_snapshot_log (tenant_id, competitor_snapshot_id, received_at, observed_at, channel_account_id, channel, marketplace, channel_product_ref, condition, source, sanity_verdict, delivery, snapshot)
VALUES ('a0000000-0000-0000-0000-00000000000a', 'a9124000-0000-4000-8000-000000000001', now(), now(), 'a4000000-0000-0000-0000-000000000001', 'KAUFLAND', 'de', 'R103-1', 'new', 'KAUFLAND_BUYBOX', 'ACCEPT', 'POLL', '{"offers": []}');
SELECT pg_temp.expect_fail('competitor snapshot log with an unknown sanity verdict (Р-122)', $q$
  INSERT INTO channel_data.competitor_snapshot_log (tenant_id, competitor_snapshot_id, received_at, observed_at, channel_account_id, channel, marketplace, channel_product_ref, condition, source, sanity_verdict, delivery, snapshot)
  VALUES ('a0000000-0000-0000-0000-00000000000a', gen_random_uuid(), now(), now(), 'a4000000-0000-0000-0000-000000000001', 'KAUFLAND', 'de', 'R103-1', 'new', 'KAUFLAND_BUYBOX', 'MAYBE', 'POLL', '{}') $q$, 'competitor_snapshot_log_verdict_known');
SELECT pg_temp.expect_fail('competitor snapshot log whose snapshot is not an object (Р-122)', $q$
  INSERT INTO channel_data.competitor_snapshot_log (tenant_id, competitor_snapshot_id, received_at, observed_at, channel_account_id, channel, marketplace, channel_product_ref, condition, source, sanity_verdict, delivery, snapshot)
  VALUES ('a0000000-0000-0000-0000-00000000000a', gen_random_uuid(), now(), now(), 'a4000000-0000-0000-0000-000000000001', 'KAUFLAND', 'de', 'R103-1', 'new', 'KAUFLAND_BUYBOX', 'ACCEPT', 'POLL', '[]') $q$, 'competitor_snapshot_log_snapshot_object');
SELECT pg_temp.expect_fail('competitor snapshot log with an unknown delivery (Р-121)', $q$
  INSERT INTO channel_data.competitor_snapshot_log (tenant_id, competitor_snapshot_id, received_at, observed_at, channel_account_id, channel, marketplace, channel_product_ref, condition, source, sanity_verdict, delivery, snapshot)
  VALUES ('a0000000-0000-0000-0000-00000000000a', gen_random_uuid(), now(), now(), 'a4000000-0000-0000-0000-000000000001', 'KAUFLAND', 'de', 'R103-1', 'new', 'KAUFLAND_BUYBOX', 'ACCEPT', 'EMAIL', '{}') $q$, 'competitor_snapshot_log_delivery_known');

-- Шаг 24, D (0088) [Р-121]: сверка опросом. Прежнее состояние — 3 часа назад, опрос — 2 часа назад, срок — час назад.
-- A: уведомление пришло до срока — задержка; B: уведомление после срока — потеря; C: до срока пришёл только опрос — потеря;
-- D: срок ещё не наступил — вердикта нет
INSERT INTO channel_data.competitor_snapshot_log (tenant_id, competitor_snapshot_id, received_at, observed_at, channel_account_id, channel, marketplace, channel_product_ref, condition, source, sanity_verdict, delivery, snapshot)
VALUES ('a0000000-0000-0000-0000-00000000000a', 'a9121000-0000-4000-8000-00000000000a', now() - interval '90 minutes', now() - interval '95 minutes', 'a4000000-0000-0000-0000-000000000001', 'KAUFLAND', 'de', 'R121-A', 'new', 'KAUFLAND_BUY_BOX_CHANGED', 'ACCEPT', 'PUSH', '{}'),
       ('a0000000-0000-0000-0000-00000000000a', 'a9121000-0000-4000-8000-00000000000b', now() - interval '30 minutes', now() - interval '35 minutes', 'a4000000-0000-0000-0000-000000000001', 'KAUFLAND', 'de', 'R121-B', 'new', 'KAUFLAND_BUY_BOX_CHANGED', 'ACCEPT', 'PUSH', '{}'),
       ('a0000000-0000-0000-0000-00000000000a', 'a9121000-0000-4000-8000-00000000000c', now() - interval '90 minutes', now() - interval '95 minutes', 'a4000000-0000-0000-0000-000000000001', 'KAUFLAND', 'de', 'R121-C', 'new', 'KAUFLAND_BUYBOX', 'ACCEPT', 'POLL', '{}'),
       -- E: до срока пришло уведомление другого товара; F: до срока пришло уведомление этого товара, но наблюдённое раньше прежнего состояния
       ('a0000000-0000-0000-0000-00000000000a', 'a9121000-0000-4000-8000-00000000000e', now() - interval '90 minutes', now() - interval '95 minutes', 'a4000000-0000-0000-0000-000000000001', 'KAUFLAND', 'de', 'R121-X', 'new', 'KAUFLAND_BUY_BOX_CHANGED', 'ACCEPT', 'PUSH', '{}'),
       ('a0000000-0000-0000-0000-00000000000a', 'a9121000-0000-4000-8000-00000000000f', now() - interval '90 minutes', now() - interval '4 hours', 'a4000000-0000-0000-0000-000000000001', 'KAUFLAND', 'de', 'R121-F', 'new', 'KAUFLAND_BUY_BOX_CHANGED', 'ACCEPT', 'PUSH', '{}');
INSERT INTO channel_data.notification_loss_check (tenant_id, notification_loss_check_id, channel_account_id, channel, marketplace, channel_product_ref, condition, compared,
  held_observed_at, held_minor, poll_snapshot_id, poll_observed_at, poll_minor, currency, due_at)
SELECT 'a0000000-0000-0000-0000-00000000000a', ('a9121100-0000-4000-8000-00000000000' || x.k)::uuid, 'a4000000-0000-0000-0000-000000000001', 'KAUFLAND', 'de', 'R121-' || upper(x.k), 'new', 'BUYBOX',
       now() - interval '3 hours', 1500, gen_random_uuid(), now() - interval '2 hours', 1450, 'EUR', now() + x.due
  FROM (VALUES ('a', interval '-1 hour'), ('b', interval '-1 hour'), ('c', interval '-1 hour'), ('d', interval '1 hour'), ('e', interval '-1 hour'), ('f', interval '-1 hour')) AS x(k, due);
SELECT pg_temp.expect_fail('notification loss check without a divergence (Р-121)', $q$
  INSERT INTO channel_data.notification_loss_check (tenant_id, channel_account_id, channel, marketplace, channel_product_ref, condition, compared, held_observed_at, held_minor, poll_snapshot_id, poll_observed_at, poll_minor, currency, due_at)
  VALUES ('a0000000-0000-0000-0000-00000000000a', 'a4000000-0000-0000-0000-000000000001', 'KAUFLAND', 'de', 'R121-X', 'new', 'BUYBOX', now() - interval '3 hours', 1500, gen_random_uuid(), now() - interval '2 hours', 1500, 'EUR', now()) $q$,
  'notification_loss_check_diverged');
SELECT pg_temp.expect_fail('notification loss check due before the poll (Р-121)', $q$
  INSERT INTO channel_data.notification_loss_check (tenant_id, channel_account_id, channel, marketplace, channel_product_ref, condition, compared, held_observed_at, held_minor, poll_snapshot_id, poll_observed_at, poll_minor, currency, due_at)
  VALUES ('a0000000-0000-0000-0000-00000000000a', 'a4000000-0000-0000-0000-000000000001', 'KAUFLAND', 'de', 'R121-X', 'new', 'BUYBOX', now() - interval '3 hours', 1500, gen_random_uuid(), now() - interval '2 hours', 1450, 'EUR', now() - interval '150 minutes') $q$,
  'notification_loss_check_order');
SELECT pg_temp.expect_fail('notification loss check comparing an unknown value (Р-121)', $q$
  INSERT INTO channel_data.notification_loss_check (tenant_id, channel_account_id, channel, marketplace, channel_product_ref, condition, compared, held_observed_at, held_minor, poll_snapshot_id, poll_observed_at, poll_minor, currency, due_at)
  VALUES ('a0000000-0000-0000-0000-00000000000a', 'a4000000-0000-0000-0000-000000000001', 'KAUFLAND', 'de', 'R121-X', 'new', 'OFFER_COUNT', now() - interval '3 hours', 1500, gen_random_uuid(), now() - interval '2 hours', 1450, 'EUR', now()) $q$,
  'notification_loss_check_compared_known');
CREATE TEMP TABLE r121_verdicts ON COMMIT DROP AS
  SELECT channel_product_ref, verdict FROM channel_data.review_notification_loss('a0000000-0000-0000-0000-00000000000a', 'a4000000-0000-0000-0000-000000000001', now());
DO $$ BEGIN
  IF (SELECT verdict FROM r121_verdicts WHERE channel_product_ref = 'R121-A') IS DISTINCT FROM 'DELAYED' THEN
    RAISE EXCEPTION 'a notification delivered before the due time does not resolve a loss check (Р-121)';
  END IF;
  RAISE NOTICE 'PASS accept | a notification delivered before the due time resolves a loss check as delayed (Р-121)';
END $$;
-- Совпадение товара и «новее прежнего состояния» — раньше проверки срока: без них падала бы она, а не своя проверка [Р-99]
DO $$ BEGIN
  IF (SELECT verdict FROM r121_verdicts WHERE channel_product_ref = 'R121-E') IS DISTINCT FROM 'LOSS_SUSPECTED' THEN
    RAISE EXCEPTION 'a notification of another product resolves a loss check (Р-121)';
  END IF;
  RAISE NOTICE 'PASS accept | a notification of another product does not resolve a loss check (Р-121)';
END $$;
DO $$ BEGIN
  IF (SELECT verdict FROM r121_verdicts WHERE channel_product_ref = 'R121-F') IS DISTINCT FROM 'LOSS_SUSPECTED' THEN
    RAISE EXCEPTION 'a notification observed before the held state resolves a loss check (Р-121)';
  END IF;
  RAISE NOTICE 'PASS accept | a notification observed before the held state does not resolve a loss check (Р-121)';
END $$;
DO $$ BEGIN
  IF (SELECT verdict FROM r121_verdicts WHERE channel_product_ref = 'R121-B') IS DISTINCT FROM 'LOSS_SUSPECTED' THEN
    RAISE EXCEPTION 'a notification after the due time resolves a loss check (Р-121)';
  END IF;
  RAISE NOTICE 'PASS accept | a notification after the due time does not resolve a loss check (Р-121)';
END $$;
DO $$ BEGIN
  IF (SELECT verdict FROM r121_verdicts WHERE channel_product_ref = 'R121-C') IS DISTINCT FROM 'LOSS_SUSPECTED' THEN
    RAISE EXCEPTION 'a polled snapshot counts as a delivered notification (Р-121)';
  END IF;
  RAISE NOTICE 'PASS accept | a polled snapshot does not count as a delivered notification (Р-121)';
END $$;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM r121_verdicts WHERE channel_product_ref = 'R121-D') THEN
    RAISE EXCEPTION 'a loss check is decided before its due time (Р-121)';
  END IF;
  RAISE NOTICE 'PASS accept | a loss check is not decided before its due time (Р-121)';
END $$;
SELECT pg_temp.expect_fail('notification loss verdict delayed without the notification snapshot (Р-121)', $q$
  INSERT INTO channel_data.notification_loss_verdict (tenant_id, notification_loss_check_id, verdict, decided_at)
  VALUES ('a0000000-0000-0000-0000-00000000000a', 'a9121100-0000-4000-8000-00000000000d', 'DELAYED', now()) $q$, 'notification_loss_verdict_evidence');
SELECT pg_temp.expect_fail('notification loss verdict of an unknown kind (Р-121)', $q$
  INSERT INTO channel_data.notification_loss_verdict (tenant_id, notification_loss_check_id, verdict, decided_at)
  VALUES ('a0000000-0000-0000-0000-00000000000a', 'a9121100-0000-4000-8000-00000000000d', 'IGNORED', now()) $q$, 'notification_loss_verdict_known');
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
SELECT pg_temp.expect_fail('discount announced to start before the current storefront day (Omnibus, Р-123)', $q$
  INSERT INTO tenant_data.discount_announcement (tenant_id, write_scope_id, reference_price_minor, sale_price_minor, currency, starts_at, created_by_membership_id, check_status)
  VALUES ('a0000000-0000-0000-0000-00000000000a', 'a6000000-0000-0000-0000-000000000001', 1200, 1000, 'EUR', now() - interval '2 days', 'a2000000-0000-0000-0000-00000000000a', 'OK') $q$,
  'before the current storefront day');
DO $$ BEGIN
  IF (SELECT status FROM tenant_data.omnibus_lowest_prior_price('a0000000-0000-0000-0000-00000000000a', 'a6000000-0000-0000-0000-000000000001', now() + interval '1 day'))
     IS DISTINCT FROM 'WINDOW_OPEN' THEN
    RAISE EXCEPTION 'a discount starting later is confirmed before its window closes (Р-123)';
  END IF;
  RAISE NOTICE 'PASS accept | a discount starting later is not confirmed before its window closes (Р-123)';
END $$;
INSERT INTO tenant_data.discount_announcement (tenant_id, write_scope_id, reference_price_minor, sale_price_minor, currency, starts_at, created_by_membership_id, check_status, lowest_prior_minor)
VALUES ('a0000000-0000-0000-0000-00000000000a', 'a6000000-0000-0000-0000-000000000001', 1200, 1000, 'EUR', now(), 'a2000000-0000-0000-0000-00000000000a', 'TIME_ZONE_UNKNOWN', 99999);
DO $$ BEGIN
  IF (SELECT (check_status, lowest_prior_minor) FROM tenant_data.discount_announcement WHERE tenant_id = 'a0000000-0000-0000-0000-00000000000a' ORDER BY created_at DESC LIMIT 1)
     IS DISTINCT FROM ('OK'::text, 1200::bigint) THEN
    RAISE EXCEPTION 'the Omnibus check of a discount announcement is not computed by the database (Р-123)';
  END IF;
  RAISE NOTICE 'PASS accept | the Omnibus check of a discount announcement is computed by the database (Р-123)';
END $$;
-- Сутки начала скидки до её начала — в окне (ревью шага 24, находка 14): 11.00 сегодня раньше момента проверки
INSERT INTO tenant_data.price_history (tenant_id, accepted_at, write_scope_id, product_id, amount_minor, currency, price_basis, effective_min_price_minor, channel_write_id, write_version)
SELECT 'a0000000-0000-0000-0000-00000000000a', greatest(date_trunc('day', now() AT TIME ZONE 'Europe/Berlin') AT TIME ZONE 'Europe/Berlin', now() - interval '1 second'),
       'a6000000-0000-0000-0000-000000000001', 'a5000000-0000-0000-0000-000000000001', 1100, 'EUR', 'GROSS', 1000, gen_random_uuid(), 9121;
DO $$ BEGIN
  IF (SELECT lowest_minor FROM tenant_data.omnibus_lowest_prior_price('a0000000-0000-0000-0000-00000000000a', 'a6000000-0000-0000-0000-000000000001', now()))
     IS DISTINCT FROM 1100::bigint THEN
    RAISE EXCEPTION 'the prices of the discount day before its start are not in the window (Р-123)';
  END IF;
  RAISE NOTICE 'PASS accept | the prices of the discount day before its start are in the window (Р-123)';
END $$;
INSERT INTO tenant_data.product_vat_rate (tenant_id, product_id, country, rate_bp, version, created_by_membership_id)
SELECT 'a0000000-0000-0000-0000-00000000000a', 'a5000000-0000-0000-0000-000000000001', 'AT', 1000, coalesce(max(version), 0) + 1, 'a2000000-0000-0000-0000-00000000000a'
  FROM tenant_data.product_vat_rate WHERE tenant_id = 'a0000000-0000-0000-0000-00000000000a' AND product_id = 'a5000000-0000-0000-0000-000000000001' AND country = 'AT';

-- Шаг 25, A (0090) [Р-126]: состояние и журнал запусков планировщика
INSERT INTO maintenance.scheduled_job (job_key, job_name, catch_up, interval_seconds, next_due_at, lease_owner, lease_until)
VALUES ('smoke-job', 'smoke-job', 'LATEST', 60, now(), 'scheduler-a', now() + interval '1 hour');
INSERT INTO maintenance.scheduled_job_run (job_key, job_name, slot_at, owner, started_at, finished_at, outcome, lag_seconds, items)
VALUES ('smoke-job', 'smoke-job', now() - interval '10 seconds', 'scheduler-a', now() - interval '5 seconds', now(), 'SUCCEEDED', 5, 0);
SELECT pg_temp.expect_fail('a scheduled job taken over while another scheduler holds its lease (Р-126)', $q$
  UPDATE maintenance.scheduled_job SET lease_owner = 'scheduler-b', lease_until = now() + interval '1 hour' WHERE job_key = 'smoke-job' $q$, 'is leased by scheduler-a');
SELECT pg_temp.expect_fail('a scheduled job key outside the job and account format (Р-126)', $q$
  INSERT INTO maintenance.scheduled_job (job_key, job_name, catch_up, interval_seconds, next_due_at) VALUES ('Smoke Job; drop', 'x', 'LATEST', 60, now()) $q$, 'scheduled_job_key_format');
SELECT pg_temp.expect_fail('a scheduled job with an unknown catch-up rule (Р-126)', $q$
  INSERT INTO maintenance.scheduled_job (job_key, job_name, catch_up, interval_seconds, next_due_at) VALUES ('smoke-job-2', 'smoke-job-2', 'SOMETIMES', 60, now()) $q$, 'scheduled_job_catch_up_known');
SELECT pg_temp.expect_fail('a scheduled job without a positive interval (Р-126)', $q$
  INSERT INTO maintenance.scheduled_job (job_key, job_name, catch_up, interval_seconds, next_due_at) VALUES ('smoke-job-2', 'smoke-job-2', 'LATEST', 0, now()) $q$, 'scheduled_job_interval_positive');
SELECT pg_temp.expect_fail('a scheduled job scoped to a tenant without an account (Р-126)', $q$
  INSERT INTO maintenance.scheduled_job (job_key, job_name, catch_up, interval_seconds, next_due_at, scope_tenant_id) VALUES ('smoke-job-2', 'smoke-job-2', 'LATEST', 60, now(), gen_random_uuid()) $q$, 'scheduled_job_scope_pair');
SELECT pg_temp.expect_fail('a scheduled job lease without its end (Р-126)', $q$
  INSERT INTO maintenance.scheduled_job (job_key, job_name, catch_up, interval_seconds, next_due_at, lease_owner) VALUES ('smoke-job-2', 'smoke-job-2', 'LATEST', 60, now(), 'scheduler-a') $q$, 'scheduled_job_lease_pair');
SELECT pg_temp.expect_fail('a scheduled job with an unknown last outcome (Р-126)', $q$
  INSERT INTO maintenance.scheduled_job (job_key, job_name, catch_up, interval_seconds, next_due_at, last_outcome) VALUES ('smoke-job-2', 'smoke-job-2', 'LATEST', 60, now(), 'MAYBE') $q$, 'scheduled_job_outcome_known');
SELECT pg_temp.expect_fail('a scheduler run with an unknown outcome (Р-126)', $q$
  INSERT INTO maintenance.scheduled_job_run (job_key, job_name, slot_at, owner, started_at, finished_at, outcome, lag_seconds) VALUES ('smoke-job', 'smoke-job', now(), 'a', now(), now(), 'MAYBE', 0) $q$, 'scheduled_job_run_outcome_known');
SELECT pg_temp.expect_fail('a scheduler run finished before it started (Р-126)', $q$
  INSERT INTO maintenance.scheduled_job_run (job_key, job_name, slot_at, owner, started_at, finished_at, outcome, lag_seconds) VALUES ('smoke-job', 'smoke-job', now() - interval '1 hour', 'a', now(), now() - interval '1 minute', 'SUCCEEDED', 0) $q$, 'scheduled_job_run_order');
SELECT pg_temp.expect_fail('truncate maintenance.scheduled_job_run', $q$ TRUNCATE maintenance.scheduled_job_run $q$, 'TRUNCATE of maintenance.scheduled_job_run is forbidden');

-- Шаг 23 [Р-108]: TRUNCATE новой append-only таблицы отклоняет свой триггер
SELECT pg_temp.expect_fail('truncate channel_data.offer_channel_pricing', $q$ TRUNCATE channel_data.offer_channel_pricing $q$, 'TRUNCATE of channel_data.offer_channel_pricing is forbidden');
SELECT pg_temp.expect_fail('truncate tenant_data.discount_announcement', $q$ TRUNCATE tenant_data.discount_announcement $q$, 'TRUNCATE of tenant_data.discount_announcement is forbidden');
SELECT pg_temp.expect_fail('truncate channel_data.competitor_snapshot_log', $q$ TRUNCATE channel_data.competitor_snapshot_log $q$, 'TRUNCATE of channel_data.competitor_snapshot_log is forbidden');
-- Проверки потерь ссылаются вердикты: TRUNCATE одной таблицы отклоняет внешний ключ раньше триггера — усекаются обе, триггер вердиктов
-- выключен внутри откатываемой проверки, чтобы отказ был именно триггером проверок
SELECT pg_temp.expect_fail('truncate channel_data.notification_loss_check', $q$ ALTER TABLE channel_data.notification_loss_verdict DISABLE TRIGGER zz_no_truncate; TRUNCATE channel_data.notification_loss_check, channel_data.notification_loss_verdict $q$, 'TRUNCATE of channel_data.notification_loss_check is forbidden');
SELECT pg_temp.expect_fail('truncate channel_data.notification_loss_verdict', $q$ TRUNCATE channel_data.notification_loss_verdict $q$, 'TRUNCATE of channel_data.notification_loss_verdict is forbidden');
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
