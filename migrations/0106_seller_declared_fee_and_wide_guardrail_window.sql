-- 0106: комиссия «от продавца» отдельным источником и гардрейл шире оффера в окне массовой правки [Р-138, Р-135; шаг 29, C и D]
--
-- Р-138: комиссия из файла продавца — НЕ тарифная таблица репозитория [Р-32]. Раньше импорт писал её как `FEE_SCHEDULE`, и
-- число, набранное продавцом в Excel, было неотличимо от версии тарифа, которую ведут разработчики (ревью шага 28, замечание 19;
-- OQ-197). Теперь у неё свой источник `SELLER_DECLARED`, она не смешивается с тарифом, и обе оценки живут рядом.
-- Пол маржи считается по БОЛЬШЕЙ комиссии из действующих оценок: расхождение оценок не должно молча опускать пол [Р-83].
--
-- Р-135 (задача D шага 29): гардрейл уровня тенанта и аккаунта меняет пол маржи у ВСЕХ предложений. Шаг 28 потребовал для него
-- второй фактор, но в окно массовой правки он не попадал: правка десяти предложений и правка всего тенанта считались по-разному.
-- Теперь гардрейл шире оффера попадает в то же окно — и как виновник, и как то, что учитывается следующей правкой.

BEGIN;

SET ROLE repracer_owner;

-- Источник оценки комиссии: объявленная продавцом стоит рядом с тарифной, а не вместо неё
ALTER TABLE channel_data.fee_estimate DROP CONSTRAINT fee_estimate_source_check;
ALTER TABLE channel_data.fee_estimate ADD CONSTRAINT fee_estimate_source_check
  CHECK (source IN ('CHANNEL_API', 'FEE_SCHEDULE', 'CALIBRATED', 'SELLER_DECLARED'));
COMMENT ON COLUMN channel_data.fee_estimate.source IS
  'Р-32, Р-138: CHANNEL_API — от канала, FEE_SCHEDULE — тарифная таблица репозитория, CALIBRATED — из фактических выплат, SELLER_DECLARED — число продавца из его выгрузки';
-- Версия тарифа обязательна только у тарифной таблицы: у числа продавца её нет и быть не может
ALTER TABLE channel_data.fee_estimate DROP CONSTRAINT fee_estimate_check1;
ALTER TABLE channel_data.fee_estimate ADD CONSTRAINT fee_estimate_schedule_version_iff
  CHECK (source <> 'FEE_SCHEDULE' OR fee_schedule_version IS NOT NULL);
ALTER TABLE channel_data.fee_estimate ADD CONSTRAINT fee_estimate_seller_declared_has_no_schedule_version
  CHECK (source <> 'SELLER_DECLARED' OR fee_schedule_version IS NULL);

RESET ROLE;

/**
 * Р-138: пол маржи считается по НАИБОЛЬШЕЙ действующей оценке комиссии. Тело функции — как было (0051, 0060, 0098), изменён
 * только выбор оценки: раньше бралась просто самая свежая, и объявленная продавцом заниженная комиссия молча опускала пол.
 */
CREATE OR REPLACE FUNCTION tenant_data.effective_price_floor(p_tenant_id uuid, p_write_scope_id uuid, p_at timestamp with time zone DEFAULT now())
 RETURNS TABLE(floor_minor bigint, min_price_minor bigint, margin_floor_minor bigint, min_margin_bp integer, cause text)
 LANGUAGE plpgsql
 STABLE
AS $function$
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
  fee_count int;
  candidate bigint;
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
    /**
     * Р-138 (шаг 29): действующих оценок может быть несколько — своя у продавца, своя у тарифной таблицы. Они НЕ смешиваются:
     * пол считается по каждой, и берётся САМЫЙ ВЫСОКИЙ — то есть оценка, которая обходится продавцу дороже. Сравнивать оценки
     * по ставке нельзя: 10 % без фиксированной части и 0 % плюс 5 € — разные деньги на разной цене (ревью шага 29, находка 8).
     */
    SELECT count(*) INTO fee_count FROM channel_data.fee_estimate fe
     WHERE fe.tenant_id = p_tenant_id AND fe.write_scope_id = p_write_scope_id AND fe.valid_until > p_at
       AND jsonb_typeof(fe.fee_model -> 'feeRateBp') = 'number' AND jsonb_typeof(fe.fee_model -> 'fixedFeeMinor') = 'number';
    IF fee_count = 0 THEN
      cause := 'FEE_ESTIMATE_MISSING';
    END IF;
  END IF;

  IF cause IS NULL THEN
    unit := c.unit_cost;
    IF unit < 0 OR min_margin_bp < 0 OR min_margin_bp >= 10000 THEN
      cause := 'INVALID_INPUT';
    END IF;
    FOR fee IN SELECT fe.fee_model FROM channel_data.fee_estimate fe
                WHERE fe.tenant_id = p_tenant_id AND fe.write_scope_id = p_write_scope_id AND fe.valid_until > p_at
                  AND jsonb_typeof(fe.fee_model -> 'feeRateBp') = 'number' AND jsonb_typeof(fe.fee_model -> 'fixedFeeMinor') = 'number'
    LOOP
      fee_bp := (fee ->> 'feeRateBp')::bigint;
      fixed := (fee ->> 'fixedFeeMinor')::bigint;
      IF fee_bp < 0 OR fee_bp >= 10000 OR fixed < 0 THEN
        cause := 'INVALID_INPUT';
      END IF;
    END LOOP;
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
    -- Пол по каждой действующей оценке; берётся наибольший — расхождение оценок не должно опускать пол [Р-138, Р-83]
    FOR fee IN SELECT fe.fee_model FROM channel_data.fee_estimate fe
                WHERE fe.tenant_id = p_tenant_id AND fe.write_scope_id = p_write_scope_id AND fe.valid_until > p_at
                  AND jsonb_typeof(fe.fee_model -> 'feeRateBp') = 'number' AND jsonb_typeof(fe.fee_model -> 'fixedFeeMinor') = 'number'
    LOOP
      candidate := tenant_data.price_for_margin_bp((fee ->> 'fixedFeeMinor')::bigint + unit, (fee ->> 'feeRateBp')::bigint, t, min_margin_bp);
      IF candidate IS NULL THEN
        cause := 'MARGIN_FLOOR_UNATTAINABLE';
        margin_floor_minor := NULL;
        EXIT;
      END IF;
      margin_floor_minor := greatest(coalesce(margin_floor_minor, 0), candidate);
    END LOOP;
    IF cause IS NULL AND margin_floor_minor IS NOT NULL THEN
      floor_minor := greatest(min_price_minor, margin_floor_minor);
    END IF;
  END IF;
  RETURN NEXT;
END $function$;
ALTER FUNCTION tenant_data.effective_price_floor(uuid, uuid, timestamptz) OWNER TO repracer_owner;

/**
 * Задача D шага 29 [Р-135]: гардрейл шире одного предложения попадает в окно массовой правки. Он и так требует второго фактора
 * (0103), но окно его не видело: продавец мог поменять пол маржи всему тенанту и сразу после этого править предложения по одному,
 * как будто ничего не случилось. Гардрейл уровня тенанта или аккаунта считается в окне как изменение ВСЕХ предложений тенанта.
 */
CREATE OR REPLACE FUNCTION tenant_data.mass_change_window_requires_mfa() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
DECLARE
  window_start timestamptz := now() - interval '10 minutes';
  offers       int;
  wide         boolean;
BEGIN
  IF NOT security.admin_session() THEN RETURN NULL; END IF;
  IF security.session_mfa() THEN RETURN NULL; END IF;
  -- Считаются только правки БЕЗ второго фактора: массовый импорт и массовая правка его уже предъявили. Ключ — товар: граница
  -- уровня единицы записи приводится к товару этой единицы, поэтому себестоимость и границы одного оффера — один ключ.
  SELECT count(DISTINCT k) INTO offers FROM (
    SELECT 'PRODUCT:' || c.product_id::text AS k FROM tenant_data.cost_profile c
     WHERE c.tenant_id = NEW.tenant_id AND c.created_at >= window_start AND NOT c.created_with_mfa
    UNION ALL
    SELECT 'PRODUCT:' || coalesce(b.product_id, w.product_id)::text FROM tenant_data.min_price b
     LEFT JOIN tenant_data.write_scope w ON w.tenant_id = b.tenant_id AND w.write_scope_id = b.write_scope_id AND w.field = 'PRICE'
     WHERE b.tenant_id = NEW.tenant_id AND b.created_at >= window_start AND NOT b.created_with_mfa
    UNION ALL
    SELECT 'PRODUCT:' || coalesce(b.product_id, w.product_id)::text FROM tenant_data.max_price b
     LEFT JOIN tenant_data.write_scope w ON w.tenant_id = b.tenant_id AND w.write_scope_id = b.write_scope_id AND w.field = 'PRICE'
     WHERE b.tenant_id = NEW.tenant_id AND b.created_at >= window_start AND NOT b.created_with_mfa
  ) changed;
  -- Гардрейл шире предложения в окне: он уже изменил пол маржи у всех — следующая правка без второго фактора не проходит
  SELECT EXISTS (
    SELECT 1 FROM tenant_data.guardrail g
     WHERE g.tenant_id = NEW.tenant_id AND g.created_at >= window_start AND g.scope_type IN ('TENANT', 'CHANNEL_ACCOUNT')
  ) INTO wide;
  IF wide THEN
    RAISE EXCEPTION 'a guardrail of every offer was changed within ten minutes: further changes need a second factor (Р-135)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF offers > 5 THEN
    RAISE EXCEPTION 'prices of % offers changed within ten minutes without a second factor: a mass change requires it (Р-135)', offers
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NULL;
END $fn$;
ALTER FUNCTION tenant_data.mass_change_window_requires_mfa() OWNER TO repracer_owner;

COMMIT;
