-- 0051_price_floor_recheck.sql
-- Шаг 15, Р-83 (главный инвариант безопасности): перед КАЖДОЙ отправкой цены в канал пол вычисляется заново и цена сверяется
-- с ним — не только абсолютный min_price, но и пол маржи. До этой миграции триггеры записи (0008, 0030) сверяли только
-- min_price и max_price; пол маржи при создании записи и при отправке не проверялся нигде (ретроспективное ревью шага 14, C4).
--
-- Пол маржи считается в БД по тем же правилам, что storefrontPriceForMarginBp и convertMinor (@repracer/pricing-model):
--  - минимальная маржа — наибольшая из действующих последних версий ограничителей тенанта, аккаунта, товара и единицы записи;
--  - себестоимость — последний профиль товара (сначала профиль аккаунта и витрины), действующий на момент проверки;
--  - комиссия — последняя действующая оценка единицы записи;
--  - перевод себестоимости в валюту цены — последний загруженный курс ЕЦБ не старше 6 дней, округление вверх [Р-61];
--  - НДС — ставка товара в стране витрины, иначе ставка страны [Р-53]; в режиме налога с продаж налога в цене нет [Р-58];
--  - цена для маржи m: ceil((fixedFee + unitCost)·(1+t) / ((1 − m) − fee·(1+t))), всё в базисных пунктах, точной арифметикой.
-- Арифметика — чистые функции price_for_margin_bp и convert_cost_up; их совпадение с storefrontPriceForMarginBp и convertMinor
-- на случайных входах проверяет packages/pricing-store-pg/test/write-recheck.pg.test.ts.
-- Если минимальная маржа задана, а пол маржи вычислить нельзя (нет себестоимости, комиссии, курса, ставки) — отказ (fail-closed).
-- Момент проверки — время транзакции (now()): приложение не выбирает, по какому дню считать.

BEGIN;
SET ROLE repracer_owner;

-- Цена витрины для маржи m, как storefrontPriceForMarginBp: ceil(cost·(1+t) / ((1 − m) − fee·(1+t))), не меньше 1;
-- NULL — маржа недостижима или вход неверен. cost — себестоимость и фиксированная комиссия в валюте цены
CREATE FUNCTION tenant_data.price_for_margin_bp(p_cost_minor bigint, p_fee_rate_bp bigint, p_tax_bp bigint, p_margin_bp int) RETURNS bigint
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT CASE
    WHEN p_cost_minor < 0 OR p_fee_rate_bp < 0 OR p_fee_rate_bp >= 10000 OR p_tax_bp < 0 OR p_margin_bp < 0 OR p_margin_bp >= 10000
      OR (10000 - p_margin_bp)::numeric * 10000 - p_fee_rate_bp::numeric * (10000 + p_tax_bp) <= 0 THEN NULL
    ELSE greatest(1, ceil(p_cost_minor::numeric * (10000 + p_tax_bp) * 10000
                         / ((10000 - p_margin_bp)::numeric * 10000 - p_fee_rate_bp::numeric * (10000 + p_tax_bp))))::bigint
  END
$$;

-- Перевод суммы вверх по курсу ЕЦБ (единиц валюты за 1 EUR × 10^6), как convertMinor(…, 'UP') для EUR и USD (оба — два знака)
CREATE FUNCTION tenant_data.convert_cost_up(p_amount_minor bigint, p_from text, p_to text, p_rate_micros bigint) RETURNS bigint
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT CASE
    WHEN p_from = p_to THEN p_amount_minor
    WHEN p_rate_micros <= 0 OR NOT (p_from = 'EUR' OR p_to = 'EUR') THEN NULL
    WHEN p_from = 'EUR' THEN ceil(p_amount_minor::numeric * p_rate_micros / 1000000)::bigint
    ELSE ceil(p_amount_minor::numeric * 1000000 / p_rate_micros)::bigint
  END
$$;
GRANT EXECUTE ON FUNCTION tenant_data.price_for_margin_bp(bigint, bigint, bigint, int), tenant_data.convert_cost_up(bigint, text, text, bigint) TO repracer_app;

CREATE FUNCTION tenant_data.effective_price_floor(p_tenant_id uuid, p_write_scope_id uuid, p_at timestamptz DEFAULT now())
  RETURNS TABLE (floor_minor bigint, min_price_minor bigint, margin_floor_minor bigint, min_margin_bp int, cause text)
  LANGUAGE plpgsql STABLE AS $$
DECLARE
  s        record;
  c        record;
  fee      jsonb;
  fee_bp   bigint;
  fixed    bigint;
  unit     bigint;
  micros   bigint;
  rate_day date;
  t        bigint;
  vat      int;
BEGIN
  min_price_minor := tenant_data.effective_min_price(p_tenant_id, p_write_scope_id);
  SELECT ws.product_id, ws.channel, ws.channel_account_id, ws.currency, ws.tax_regime,
         (SELECT om.marketplace FROM tenant_data.offer_mapping om
           WHERE om.tenant_id = ws.tenant_id AND (om.price_write_scope_id = ws.write_scope_id OR om.quantity_write_scope_id = ws.write_scope_id)
           ORDER BY om.created_at LIMIT 1) AS marketplace
    INTO s
    FROM tenant_data.write_scope ws WHERE ws.tenant_id = p_tenant_id AND ws.write_scope_id = p_write_scope_id;

  -- Минимальная маржа: последняя версия на каждом уровне, действующие — наибольшая (как GuardrailSet.minMarginBp)
  SELECT max(gg.min_margin_bp) INTO min_margin_bp
    FROM (SELECT DISTINCT ON (g.scope_type) g.min_margin_bp, g.is_active
            FROM tenant_data.guardrail g
           WHERE g.tenant_id = p_tenant_id
             AND (g.scope_type = 'TENANT'
                  OR (g.scope_type = 'CHANNEL_ACCOUNT' AND g.channel_account_id = s.channel_account_id)
                  OR (g.scope_type = 'PRODUCT' AND g.product_id = s.product_id)
                  OR (g.scope_type = 'WRITE_SCOPE' AND g.write_scope_id = p_write_scope_id))
           ORDER BY g.scope_type, g.version DESC) gg
   WHERE gg.is_active;

  IF min_price_minor IS NULL THEN
    cause := 'MIN_PRICE_MISSING';
    RETURN NEXT;
    RETURN;
  END IF;
  IF min_margin_bp IS NULL THEN
    floor_minor := min_price_minor;
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT cp.currency, cp.purchase_cost_minor + cp.inbound_logistics_minor + cp.packaging_minor + cp.handling_minor
                      + cp.outbound_shipping_minor + cp.other_fixed_minor AS unit_cost
    INTO c
    FROM tenant_data.cost_profile cp
   WHERE cp.tenant_id = p_tenant_id AND cp.product_id = s.product_id
     AND (cp.channel_account_id IS NULL OR (cp.channel_account_id = s.channel_account_id AND cp.marketplace = s.marketplace))
     AND cp.valid_from <= p_at
   ORDER BY (cp.channel_account_id IS NOT NULL) DESC, cp.valid_from DESC, cp.version DESC LIMIT 1;
  IF c IS NULL THEN
    cause := 'COST_PROFILE_MISSING';
  ELSE
    SELECT fe.fee_model INTO fee FROM channel_data.fee_estimate fe
     WHERE fe.tenant_id = p_tenant_id AND fe.write_scope_id = p_write_scope_id AND fe.valid_until > p_at
     ORDER BY fe.computed_at DESC LIMIT 1;
    IF fee IS NULL OR jsonb_typeof(fee -> 'feeRateBp') <> 'number' OR jsonb_typeof(fee -> 'fixedFeeMinor') <> 'number' THEN
      cause := 'FEE_ESTIMATE_MISSING';
    END IF;
  END IF;

  IF cause IS NULL THEN
    fee_bp := (fee ->> 'feeRateBp')::bigint;
    fixed := (fee ->> 'fixedFeeMinor')::bigint;
    unit := c.unit_cost;
    IF fee_bp < 0 OR fee_bp >= 10000 OR fixed < 0 OR unit < 0 OR min_margin_bp < 0 OR min_margin_bp >= 10000 THEN
      cause := 'INVALID_INPUT';
    END IF;
  END IF;

  -- Р-61: перевод по курсу ЕЦБ, известному на момент проверки, не старше 6 дней, вверх; пары только с EUR, EUR и USD — два знака
  IF cause IS NULL AND c.currency <> s.currency THEN
    IF c.currency NOT IN ('EUR', 'USD') OR s.currency NOT IN ('EUR', 'USD') THEN
      cause := 'UNSUPPORTED_CURRENCY';
    ELSE
      SELECT (x.rate * 1000000)::bigint, x.rate_date INTO micros, rate_day
        FROM platform.fx_rate x
       WHERE x.source = 'ECB' AND x.base_currency = 'EUR' AND x.quote_currency = CASE WHEN c.currency = 'EUR' THEN s.currency ELSE c.currency END
         AND x.available_from <= p_at AND x.rate_date <= (p_at AT TIME ZONE 'UTC')::date AND x.rate > 0
       ORDER BY x.rate_date DESC LIMIT 1;
      IF micros IS NULL THEN
        cause := 'FX_RATE_UNAVAILABLE';
      ELSIF (p_at AT TIME ZONE 'UTC')::date - rate_day > 6 THEN
        cause := 'FX_RATE_STALE';
      ELSE
        unit := tenant_data.convert_cost_up(unit, c.currency, s.currency, micros);
      END IF;
    END IF;
  END IF;

  IF cause IS NULL THEN
    IF s.tax_regime = 'SALES_TAX_EXCLUDED' THEN
      t := 0;
    ELSE
      vat := tenant_data.effective_vat_rate_bp(p_tenant_id, s.product_id,
               (SELECT mk.country FROM platform.marketplace mk WHERE mk.channel = s.channel AND mk.marketplace = s.marketplace));
      IF vat IS NULL THEN
        cause := 'VAT_UNKNOWN';
      ELSE
        t := vat;
      END IF;
    END IF;
  END IF;

  IF cause IS NULL THEN
    margin_floor_minor := tenant_data.price_for_margin_bp(fixed + unit, fee_bp, t, min_margin_bp);
    IF margin_floor_minor IS NULL THEN
      cause := 'MARGIN_FLOOR_UNATTAINABLE';
    ELSE
      floor_minor := greatest(min_price_minor, margin_floor_minor);
    END IF;
  END IF;
  RETURN NEXT;
END $$;

-- Сверка цены с полом; возвращает пол. Сообщения разбирают хранилище (dbReason) и очередь записей (dispatchRefusal)
CREATE FUNCTION tenant_data.assert_price_floor(p_tenant_id uuid, p_write_scope_id uuid, p_amount_minor bigint, p_stage text)
  RETURNS bigint
  LANGUAGE plpgsql STABLE AS $$
DECLARE
  f record;
BEGIN
  SELECT * INTO f FROM tenant_data.effective_price_floor(p_tenant_id, p_write_scope_id, now());
  IF f.floor_minor IS NULL THEN
    RAISE EXCEPTION 'price floor of write_scope % cannot be computed %: % (Р-83)', p_write_scope_id, p_stage, f.cause
      USING ERRCODE = 'check_violation';
  END IF;
  IF p_amount_minor < f.floor_minor THEN
    RAISE EXCEPTION 'value % is below effective price floor % (min_price %, margin floor %, min margin % bp) % (Р-83)',
      p_amount_minor, f.floor_minor, f.min_price_minor, coalesce(f.margin_floor_minor::text, 'none'), coalesce(f.min_margin_bp::text, 'none'), p_stage
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN f.floor_minor;
END $$;

CREATE OR REPLACE FUNCTION tenant_data.channel_write_before_insert()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  s           record;
  st          record;
BEGIN
  -- Блокировка единицы: смена режима цены не может пройти одновременно с созданием записи
  SELECT * INTO s FROM tenant_data.write_scope
   WHERE tenant_id = NEW.tenant_id AND write_scope_id = NEW.write_scope_id FOR SHARE;

  IF s.status = 'RETIRED' THEN
    RAISE EXCEPTION 'write_scope % is RETIRED', NEW.write_scope_id USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  -- Р-12: minimum_price Kaufland — только в режиме Smart Pricing; наша цена — только в режиме ENGINE
  IF NEW.field = 'CHANNEL_MIN_PRICE' THEN
    IF s.field <> 'PRICE' OR s.pricing_mode <> 'KAUFLAND_SMART_PRICING' THEN
      RAISE EXCEPTION 'CHANNEL_MIN_PRICE may be written only in KAUFLAND_SMART_PRICING mode'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  ELSIF NEW.field <> s.field THEN
    RAISE EXCEPTION 'write field % does not match write_scope field %', NEW.field, s.field
      USING ERRCODE = 'integrity_constraint_violation';
  ELSIF NEW.field = 'PRICE' AND s.pricing_mode <> 'ENGINE' THEN
    RAISE EXCEPTION 'PRICE writes require pricing_mode ENGINE (scope is %)', s.pricing_mode
      USING ERRCODE = 'integrity_constraint_violation';
  ELSIF NEW.field = 'QUANTITY' AND NOT s.quantity_sync_enabled THEN
    RAISE EXCEPTION 'quantity sync is disabled for write_scope %', NEW.write_scope_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF NEW.field <> 'QUANTITY' THEN
    IF NEW.currency <> s.currency OR NEW.price_basis <> s.price_basis THEN
      RAISE EXCEPTION 'write currency/basis must match write_scope' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    -- INV-02, Р-83: значение не ниже пола, вычисленного заново: min_price и пол маржи по текущим себестоимости, комиссии,
    -- курсу ЕЦБ и ставке НДС
    PERFORM tenant_data.assert_price_floor(NEW.tenant_id, NEW.write_scope_id, NEW.amount_minor, 'at creation');
  END IF;

  IF NEW.field = 'PRICE' AND NOT EXISTS (
       SELECT 1 FROM channel_data.price_decision d
        WHERE d.tenant_id = NEW.tenant_id AND d.price_decision_id = NEW.price_decision_id
          AND d.write_scope_id = NEW.write_scope_id
          AND d.outcome IN ('APPROVED', 'CLAMPED_FLOOR', 'CLAMPED_CEILING')
          AND d.final_amount_minor = NEW.amount_minor
          AND d.currency = NEW.currency AND d.price_basis = NEW.price_basis) THEN
    RAISE EXCEPTION 'PRICE write must equal an approved price_decision of the same write_scope'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  SELECT * INTO st FROM tenant_data.write_scope_sync_state
   WHERE tenant_id = NEW.tenant_id AND write_scope_id = NEW.write_scope_id;

  IF NEW.field = 'QUANTITY' THEN
    NEW.direction := CASE
      WHEN st.last_sent_quantity IS NULL        THEN 'INCREASE'
      WHEN NEW.quantity < st.last_sent_quantity THEN 'DECREASE'
      WHEN NEW.quantity > st.last_sent_quantity THEN 'INCREASE'
      ELSE 'SAME' END;
  ELSE
    NEW.direction := NULL;
  END IF;

  IF NEW.status <> 'PENDING' THEN
    RAISE EXCEPTION 'new channel_write must be PENDING' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  -- INV-14: в удержанной единице запись создаётся заблокированной, кроме уменьшения остатка
  IF s.status IN ('HELD', 'CONTESTED', 'BLOCKED') AND NOT (NEW.field = 'QUANTITY' AND NEW.direction = 'DECREASE') THEN
    NEW.status := 'BLOCKED';
  END IF;

  IF NEW.budget_scope_key IS DISTINCT FROM s.budget_scope_key THEN
    RAISE EXCEPTION 'budget_scope_key must match write_scope (%)', s.budget_scope_key
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  -- INV-03: версия строго больше последней созданной в единице записи
  UPDATE tenant_data.write_scope_sync_state
     SET latest_version_created = NEW.version
   WHERE tenant_id = NEW.tenant_id AND write_scope_id = NEW.write_scope_id
     AND latest_version_created < NEW.version;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'version % is not greater than latest created version % of write_scope %',
      NEW.version, st.latest_version_created, NEW.write_scope_id USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  NEW.idempotency_key := encode(sha256(convert_to(
    concat_ws('|', NEW.tenant_id, s.channel_account_id, NEW.field, s.scope_key, NEW.version), 'UTF8')), 'hex');
  NEW.created_at := now();
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION tenant_data.channel_write_before_update()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  s           record;
  st          record;
BEGIN
  IF NEW.status <> OLD.status AND (OLD.status, NEW.status) NOT IN (VALUES
       ('PENDING', 'DISPATCHED'), ('PENDING', 'SUPERSEDED'), ('PENDING', 'BLOCKED'),
       ('PENDING', 'DISCARDED_STALE'), ('PENDING', 'BUDGET_EXHAUSTED'),
       ('BLOCKED', 'PENDING'), ('BLOCKED', 'SUPERSEDED'), ('BLOCKED', 'DISCARDED_STALE'),
       ('DISPATCHED', 'ACCEPTED'), ('DISPATCHED', 'FAILED'), ('DISPATCHED', 'BUDGET_EXHAUSTED'),
       ('FAILED', 'DISPATCHED'), ('FAILED', 'DISCARDED_STALE'), ('FAILED', 'BUDGET_EXHAUSTED'),
       ('ACCEPTED', 'APPLIED'), ('ACCEPTED', 'NOT_APPLIED')) THEN
    RAISE EXCEPTION 'channel_write status transition % -> % is not allowed', OLD.status, NEW.status
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  SELECT * INTO s FROM tenant_data.write_scope WHERE tenant_id = NEW.tenant_id AND write_scope_id = NEW.write_scope_id;

  -- Выход из BLOCKED и отправка возможны только в незаблокированной единице (кроме уменьшения остатка)
  IF NEW.status IN ('PENDING', 'DISPATCHED') AND NEW.status <> OLD.status
     AND (s.status = 'RETIRED'
          OR (s.status IN ('HELD', 'CONTESTED', 'BLOCKED') AND NOT (NEW.field = 'QUANTITY' AND NEW.direction = 'DECREASE'))) THEN
    RAISE EXCEPTION 'write_scope % is %: write cannot proceed', s.write_scope_id, s.status
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF NEW.status = 'DISPATCHED' AND OLD.status <> 'DISPATCHED' THEN
    SELECT * INTO st FROM tenant_data.write_scope_sync_state
     WHERE tenant_id = NEW.tenant_id AND write_scope_id = NEW.write_scope_id FOR UPDATE;

    -- INV-03: отправляется только самая свежая версия; старое значение не может перезаписать новое
    IF NEW.version <> st.latest_version_created THEN
      RAISE EXCEPTION 'stale write: version % < latest created %', NEW.version, st.latest_version_created
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF st.in_flight_write_id IS NOT NULL AND st.in_flight_write_id <> NEW.channel_write_id THEN
      RAISE EXCEPTION 'write_scope % already has in-flight write %', NEW.write_scope_id, st.in_flight_write_id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF (NEW.field = 'PRICE' AND s.pricing_mode <> 'ENGINE')
       OR (NEW.field = 'CHANNEL_MIN_PRICE' AND s.pricing_mode <> 'KAUFLAND_SMART_PRICING') THEN
      RAISE EXCEPTION 'pricing_mode changed to %: write cannot be dispatched', s.pricing_mode
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    -- INV-02, Р-83: пол вычисляется заново перед КАЖДОЙ отправкой (первая попытка и повторы): min_price и пол маржи
    IF NEW.field <> 'QUANTITY' THEN
      NEW.floor_at_dispatch_minor := tenant_data.assert_price_floor(NEW.tenant_id, NEW.write_scope_id, NEW.amount_minor, 'at dispatch');
    END IF;

    UPDATE tenant_data.write_scope_sync_state
       SET latest_version_dispatched = greatest(latest_version_dispatched, NEW.version),
           in_flight_write_id = NEW.channel_write_id
     WHERE tenant_id = NEW.tenant_id AND write_scope_id = NEW.write_scope_id;
    NEW.dispatched_at := coalesce(NEW.dispatched_at, now());
  END IF;

  -- Р-19: каждая попытка расходует бюджет до отправки; превышение лимита отклоняет обновление
  IF NEW.attempt_count <> OLD.attempt_count THEN
    IF NEW.attempt_count < OLD.attempt_count OR NEW.status <> 'DISPATCHED' THEN
      RAISE EXCEPTION 'attempt_count may only grow while DISPATCHED' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.budget_scope_key IS NOT NULL THEN
      PERFORM tenant_data.consume_edit_budget(
        NEW.tenant_id, s.channel_account_id, NEW.budget_scope_key, NEW.budget_day,
        s.capability_id, s.capability_version,
        CASE WHEN NEW.field <> 'QUANTITY' THEN 'PRICE'
             WHEN NEW.direction = 'DECREASE' THEN 'QUANTITY_DECREASE'
             ELSE 'QUANTITY' END,
        NEW.attempt_count - OLD.attempt_count);
    END IF;
  END IF;

  IF NEW.status = 'ACCEPTED' AND OLD.status <> 'ACCEPTED' THEN
    NEW.accepted_at := coalesce(NEW.accepted_at, now());
    UPDATE tenant_data.write_scope_sync_state
       SET latest_version_accepted = greatest(latest_version_accepted, NEW.version),
           last_sent_amount_minor  = CASE WHEN NEW.field <> 'QUANTITY' THEN NEW.amount_minor ELSE last_sent_amount_minor END,
           last_sent_quantity      = CASE WHEN NEW.field = 'QUANTITY' THEN NEW.quantity ELSE last_sent_quantity END,
           -- Синхронные каналы: запись завершена; асинхронные: в полёте до APPLIED/NOT_APPLIED
           in_flight_write_id      = CASE WHEN s.processing_mode = 'SYNC' AND in_flight_write_id = NEW.channel_write_id
                                          THEN NULL ELSE in_flight_write_id END
     WHERE tenant_id = NEW.tenant_id AND write_scope_id = NEW.write_scope_id;
  END IF;

  IF NEW.status = 'APPLIED' AND OLD.status <> 'APPLIED' THEN
    NEW.applied_at := coalesce(NEW.applied_at, now());
    UPDATE tenant_data.write_scope_sync_state
       SET latest_version_applied = greatest(latest_version_applied, NEW.version)
     WHERE tenant_id = NEW.tenant_id AND write_scope_id = NEW.write_scope_id;
  END IF;

  IF NEW.status IN ('APPLIED', 'NOT_APPLIED', 'FAILED', 'SUPERSEDED', 'DISCARDED_STALE', 'BUDGET_EXHAUSTED')
     AND NEW.status <> OLD.status THEN
    UPDATE tenant_data.write_scope_sync_state
       SET in_flight_write_id = NULL
     WHERE tenant_id = NEW.tenant_id AND write_scope_id = NEW.write_scope_id
       AND in_flight_write_id = NEW.channel_write_id;
    IF NEW.status <> 'FAILED' THEN
      NEW.finished_at := coalesce(NEW.finished_at, now());
    END IF;
  END IF;

  RETURN NEW;
END $function$;

RESET ROLE;
COMMIT;
