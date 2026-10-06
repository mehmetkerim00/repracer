-- 0182_floor_inputs_requests_and_ladder_pace.sql
-- Шаг 74: два решения владельца о подъёме к полу и отложенная мелочь шага 73.
--
-- Р-211 (OQ-254) — обобщение Р-210: ЛЮБОЕ изменение входов пола создаёт запрос на переоценку единицы, подъём к полу не ждёт наблюдения
-- конкурента. Входы пола [Р-5, Р-83]: себестоимость и комиссия (0180), min_price и max_price, минимальная маржа гардрейла, НДС товара — триггерами
-- базы на версиях (таблицы только на добавление); курс ЕЦБ и НДС по умолчанию — данные ПЛАТФОРМЫ, общие для всех тенантов: запрос по ним
-- ставит функция базы, которую пересчёт по расписанию зовёт в границе своего тенанта и аккаунта; что она уже видела, держит отметка
-- аккаунта (`tenant_data.floor_raise_watermark`) — иначе единица, переоценка которой не даёт решения, выбиралась бы на каждом заходе.
-- Повод запроса — вход: BOUNDS_UPDATE (min_price и max_price), GUARDRAIL_UPDATE, VAT_UPDATE, FX_UPDATE (к COST_UPDATE и FLOOR_RECHECK шага 73).
--
-- Р-212 (OQ-255) — ступень лестницы не чаще периода планового пересчёта (свойство канала, 15 минут), наблюдения конкурентов её не
-- ускоряют: оценка внутри паузы — «без изменения» `LADDER_PACED` (новый код в ограничении решения и в реестрах).
--
-- Ревью шага 73 (отложенное): ручная поправка закрытых суток человеком (`price_daily_correction`) знает ступени, как свёртка и системная
-- поправка (0180): число ступеней в строке, «цена суток не ниже пола суток» допускает сутки со ступенями, итог суток несёт число ступеней.

BEGIN;

-- ---------------------------------------------------------------- 1. Повод запроса — любой вход пола [Р-211]
-- Права роли запросов: единицы (валюта, база, налоговый режим — для отбора по версии min_price и НДС), себестоимость и предложения (курс),
-- справочники платформы (курс, витрины, НДС по умолчанию) — только чтение нужных столбцов
GRANT SELECT (currency, price_basis, tax_regime, channel) ON tenant_data.write_scope TO repracer_floor_raise;
GRANT SELECT (tenant_id, product_id, channel_account_id, marketplace, currency, valid_from, version) ON tenant_data.cost_profile TO repracer_floor_raise;
CREATE POLICY floor_raise_cost_read ON tenant_data.cost_profile FOR SELECT TO repracer_floor_raise USING (tenant_id = security.current_tenant_id());
GRANT SELECT (tenant_id, price_write_scope_id, marketplace) ON tenant_data.offer_mapping TO repracer_floor_raise;
CREATE POLICY floor_raise_mapping_read ON tenant_data.offer_mapping FOR SELECT TO repracer_floor_raise USING (tenant_id = security.current_tenant_id());
GRANT USAGE ON SCHEMA platform TO repracer_floor_raise;
GRANT EXECUTE ON FUNCTION security.platform_tenant_id() TO repracer_floor_raise;
GRANT SELECT (tenant_id, source, quote_currency, rate_date, rate, available_from) ON platform.fx_rate TO repracer_floor_raise;
CREATE POLICY fx_rate_floor_raise_read ON platform.fx_rate FOR SELECT TO repracer_floor_raise USING (tenant_id = security.platform_tenant_id());
GRANT SELECT (tenant_id, channel, marketplace, country) ON platform.marketplace TO repracer_floor_raise;
CREATE POLICY marketplace_floor_raise_read ON platform.marketplace FOR SELECT TO repracer_floor_raise USING (tenant_id = security.platform_tenant_id());
GRANT SELECT (tenant_id, country, valid_from) ON platform.vat_rate_default TO repracer_floor_raise;
CREATE POLICY vat_rate_default_floor_raise_read ON platform.vat_rate_default FOR SELECT TO repracer_floor_raise USING (tenant_id = security.platform_tenant_id());

/**
 * Запрос на переоценку ставит ТОЛЬКО база, триггерами на входах пола: себестоимость (новая версия профиля товара), оценка комиссии
 * единицы, min_price, гардрейл, НДС товара и запись цены, завершённая отказом перепроверки пола. Только единицы цены в режиме ENGINE;
 * повторный запрос сдвигает время — пересчёт забирает запрос не новее прочитанного. Время — часы исполнения (ревью шага 73). Признак
 * «нарушен пол» отказа записи пишет диспетчер по причине отказа базы (`end_params.violated`)
 */
CREATE OR REPLACE FUNCTION tenant_data.request_floor_raise() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
DECLARE
  why text;
BEGIN
  -- Источник — аргументом триггера, а не TG_TABLE_NAME: у секции истории записей там имя секции, а не родителя
  IF TG_ARGV[0] = 'cost_profile' THEN
    INSERT INTO tenant_data.floor_raise_request (tenant_id, write_scope_id, reason, requested_at)
    SELECT s.tenant_id, s.write_scope_id, 'COST_UPDATE', clock_timestamp()
      FROM tenant_data.write_scope s
     WHERE s.tenant_id = NEW.tenant_id AND s.product_id = NEW.product_id AND s.field = 'PRICE' AND s.pricing_mode = 'ENGINE'
       AND (NEW.channel_account_id IS NULL OR s.channel_account_id = NEW.channel_account_id)
    ON CONFLICT (tenant_id, write_scope_id, reason) DO UPDATE SET requested_at = greatest(floor_raise_request.requested_at, EXCLUDED.requested_at);
    RETURN NULL;
  END IF;
  -- Р-211: новая версия min_price или max_price — у единицы или у товара (валюта и база цены те же, что у версии). max_price — тоже вход
  -- пола: пол маржи действует, только пока он не выше max_price (ревью шага 74, находка 1 по Р-211)
  IF TG_ARGV[0] IN ('min_price', 'max_price') THEN
    INSERT INTO tenant_data.floor_raise_request (tenant_id, write_scope_id, reason, requested_at)
    SELECT s.tenant_id, s.write_scope_id, 'BOUNDS_UPDATE', clock_timestamp()
      FROM tenant_data.write_scope s
     WHERE s.tenant_id = NEW.tenant_id AND s.field = 'PRICE' AND s.pricing_mode = 'ENGINE'
       AND ((NEW.scope_type = 'WRITE_SCOPE' AND s.write_scope_id = NEW.write_scope_id)
         OR (NEW.scope_type = 'PRODUCT' AND s.product_id = NEW.product_id AND s.currency = NEW.currency AND s.price_basis = NEW.price_basis))
    ON CONFLICT (tenant_id, write_scope_id, reason) DO UPDATE SET requested_at = greatest(floor_raise_request.requested_at, EXCLUDED.requested_at);
    RETURN NULL;
  END IF;
  -- Р-211: новая версия гардрейла (минимальная маржа и предел шага) — на своём уровне: тенант, аккаунт, товар или единица
  IF TG_ARGV[0] = 'guardrail' THEN
    INSERT INTO tenant_data.floor_raise_request (tenant_id, write_scope_id, reason, requested_at)
    SELECT s.tenant_id, s.write_scope_id, 'GUARDRAIL_UPDATE', clock_timestamp()
      FROM tenant_data.write_scope s
     WHERE s.tenant_id = NEW.tenant_id AND s.field = 'PRICE' AND s.pricing_mode = 'ENGINE'
       AND (NEW.scope_type = 'TENANT'
         OR (NEW.scope_type = 'CHANNEL_ACCOUNT' AND s.channel_account_id = NEW.channel_account_id)
         OR (NEW.scope_type = 'PRODUCT' AND s.product_id = NEW.product_id)
         OR (NEW.scope_type = 'WRITE_SCOPE' AND s.write_scope_id = NEW.write_scope_id))
    ON CONFLICT (tenant_id, write_scope_id, reason) DO UPDATE SET requested_at = greatest(floor_raise_request.requested_at, EXCLUDED.requested_at);
    RETURN NULL;
  END IF;
  -- Р-211: новая ставка НДС товара — у единиц товара с ценой брутто (НДС внутри цены, Р-58) на витринах страны ставки
  IF TG_ARGV[0] = 'product_vat_rate' THEN
    INSERT INTO tenant_data.floor_raise_request (tenant_id, write_scope_id, reason, requested_at)
    SELECT DISTINCT s.tenant_id, s.write_scope_id, 'VAT_UPDATE', clock_timestamp()
      FROM tenant_data.write_scope s
      JOIN tenant_data.offer_mapping m ON m.tenant_id = s.tenant_id AND m.price_write_scope_id = s.write_scope_id
      JOIN platform.marketplace mk ON mk.channel = s.channel AND mk.marketplace = m.marketplace
     WHERE s.tenant_id = NEW.tenant_id AND s.product_id = NEW.product_id AND s.field = 'PRICE' AND s.pricing_mode = 'ENGINE'
       AND s.tax_regime = 'VAT_INCLUDED' AND mk.country = NEW.country
    ON CONFLICT (tenant_id, write_scope_id, reason) DO UPDATE SET requested_at = greatest(floor_raise_request.requested_at, EXCLUDED.requested_at);
    RETURN NULL;
  END IF;
  IF TG_ARGV[0] = 'fee_estimate' THEN
    -- Перезапись той же оценки (повторный расчёт тарифа) — не изменение себестоимости и не повод (условие WHEN у триггера запрещено, шаг 19)
    IF TG_OP = 'UPDATE' AND OLD.fee_model IS NOT DISTINCT FROM NEW.fee_model THEN
      RETURN NULL;
    END IF;
    why := 'COST_UPDATE';
  ELSIF TG_ARGV[0] = 'channel_write_history'
        AND NEW.field = 'PRICE' AND NEW.end_reason = 'WRITE_BLOCKED_BY_BOUND_RECHECK' AND NEW.end_params ->> 'violated' = 'FLOOR' THEN
    why := 'FLOOR_RECHECK';
  ELSE
    RETURN NULL;
  END IF;
  INSERT INTO tenant_data.floor_raise_request (tenant_id, write_scope_id, reason, requested_at)
  SELECT s.tenant_id, s.write_scope_id, why, clock_timestamp()
    FROM tenant_data.write_scope s
   WHERE s.tenant_id = NEW.tenant_id AND s.write_scope_id = NEW.write_scope_id AND s.field = 'PRICE' AND s.pricing_mode = 'ENGINE'
  ON CONFLICT (tenant_id, write_scope_id, reason) DO UPDATE SET requested_at = greatest(floor_raise_request.requested_at, EXCLUDED.requested_at);
  RETURN NULL;
END $fn$;

CREATE TRIGGER zf_min_price_request_floor_raise AFTER INSERT ON tenant_data.min_price
  FOR EACH ROW EXECUTE FUNCTION tenant_data.request_floor_raise('min_price');
CREATE TRIGGER zf_max_price_request_floor_raise AFTER INSERT ON tenant_data.max_price
  FOR EACH ROW EXECUTE FUNCTION tenant_data.request_floor_raise('max_price');
CREATE TRIGGER zf_guardrail_request_floor_raise AFTER INSERT ON tenant_data.guardrail
  FOR EACH ROW EXECUTE FUNCTION tenant_data.request_floor_raise('guardrail');
CREATE TRIGGER zf_product_vat_rate_request_floor_raise AFTER INSERT ON tenant_data.product_vat_rate
  FOR EACH ROW EXECUTE FUNCTION tenant_data.request_floor_raise('product_vat_rate');

-- ---------------------------------------------------------------- 2. Курс ЕЦБ и НДС по умолчанию [Р-211]
SET ROLE repracer_owner;
CREATE TABLE tenant_data.floor_raise_watermark (
  tenant_id            uuid NOT NULL,
  channel_account_id   uuid NOT NULL,
  /**
   * Что функция уже обратила в запросы — по КЛЮЧАМ, а не по времени (ревью шага 74, находка 5 по Р-211): действующий курс каждой
   * валюты (`{"USD": {"date": "…", "rate": …}}`) и дата действующей ставки НДС по умолчанию каждой страны (`{"DE": "…"}`). Время
   * появления строки теряло бы курс, загруженный транзакцией, открытой во время захода, и ставку, вставленную задним числом
   */
  fx_seen              jsonb NOT NULL,
  vat_seen             jsonb NOT NULL,
  PRIMARY KEY (tenant_id, channel_account_id),
  FOREIGN KEY (tenant_id, channel_account_id) REFERENCES tenant_data.channel_account (tenant_id, channel_account_id) ON DELETE CASCADE
);
COMMENT ON TABLE tenant_data.floor_raise_watermark IS
  'Р-211 (шаг 74): отметка аккаунта — действующие курсы ЕЦБ и ставки НДС по умолчанию, уже обращённые в запросы на переоценку; пишет только функция базы';
SELECT security.register_table('tenant_data.floor_raise_watermark', 'TENANT', 'mutable', 'none');
SELECT security.grant_retention('tenant_data.floor_raise_watermark');
-- Данные тенанта по времени без экспорта не удаляются: строка на аккаунт, уходит вместе с тенантом
INSERT INTO maintenance.retention_policy (table_name, method, bound) VALUES ('tenant_data.floor_raise_watermark', 'TENANT_CLOSURE_ONLY', 'MAX_AGE');
-- Пишет только функция узкой роли: административной роли вставка и правка не нужны
REVOKE INSERT, UPDATE ON tenant_data.floor_raise_watermark FROM repracer_admin;
RESET ROLE;

GRANT SELECT, INSERT (tenant_id, channel_account_id, fx_seen, vat_seen), UPDATE (fx_seen, vat_seen)
  ON tenant_data.floor_raise_watermark TO repracer_floor_raise;
CREATE POLICY floor_raise_watermark_writer ON tenant_data.floor_raise_watermark FOR ALL TO repracer_floor_raise
  USING (tenant_id = security.current_tenant_id()) WITH CHECK (tenant_id = security.current_tenant_id());

/**
 * Р-211: курсы ЕЦБ и ставки НДС по умолчанию, ставшие действующими с прошлого захода, — запросы на переоценку единиц аккаунта своего
 * тенанта. Действующие — как в контексте решения: курс с датой не позже суток момента и доступный к нему, ставка — с наибольшей датой
 * не позже суток момента. Курс — запрос только у единиц, чей пол он ПОДНЯЛ: себестоимость в валюте C, цена в валюте U, перевод
 * C → U по курсам к евро — пол растёт, когда растёт отношение курсов U/C (понижение пола цену ниже пола не ставит; ежедневный курс без
 * фильтра ставил бы запрос всему каталогу каждый рабочий день — ревью шага 74). Ставка НДС по умолчанию — у единиц с ценой брутто на
 * витрине страны ставки. Первый заход аккаунта ставит отметку без запросов; заход без новых курсов и ставок — без обхода единиц.
 * Зовёт пересчёт по расписанию (путь решения) в начале захода; момент — часы пересчёта
 */
CREATE FUNCTION tenant_data.request_floor_raise_for_platform_inputs(p_channel_account_id uuid, p_now timestamptz) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
DECLARE
  t uuid := security.current_tenant_id();
  w record;
  fx_now jsonb;
  vat_now jsonb;
  n integer := 0;
BEGIN
  IF t IS NULL THEN
    RAISE EXCEPTION 'floor raise requests for platform inputs need the tenant of the session';
  END IF;
  SELECT coalesce(jsonb_object_agg(f.quote_currency, jsonb_build_object('date', f.rate_date, 'rate', f.rate)), '{}'::jsonb) INTO fx_now
    FROM (SELECT DISTINCT ON (r.quote_currency) r.quote_currency, r.rate_date, r.rate FROM platform.fx_rate r
           WHERE r.source = 'ECB' AND r.available_from <= p_now AND r.rate_date <= p_now::date
           ORDER BY r.quote_currency, r.rate_date DESC) f;
  SELECT coalesce(jsonb_object_agg(d.country, d.valid_from), '{}'::jsonb) INTO vat_now
    FROM (SELECT DISTINCT ON (v.country) v.country, v.valid_from FROM platform.vat_rate_default v
           WHERE v.valid_from <= p_now::date ORDER BY v.country, v.valid_from DESC) d;
  SELECT x.fx_seen, x.vat_seen INTO w FROM tenant_data.floor_raise_watermark x
   WHERE x.tenant_id = t AND x.channel_account_id = p_channel_account_id FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO tenant_data.floor_raise_watermark (tenant_id, channel_account_id, fx_seen, vat_seen)
    VALUES (t, p_channel_account_id, fx_now, vat_now) ON CONFLICT DO NOTHING;
    RETURN 0;
  END IF;
  IF w.fx_seen = fx_now AND w.vat_seen = vat_now THEN
    RETURN 0;
  END IF;
  INSERT INTO tenant_data.floor_raise_request (tenant_id, write_scope_id, reason, requested_at)
  SELECT u.tenant_id, u.write_scope_id, u.reason, clock_timestamp()
    FROM (
      SELECT s.tenant_id, s.write_scope_id, 'FX_UPDATE' AS reason
        FROM tenant_data.write_scope s
        JOIN tenant_data.offer_mapping m ON m.tenant_id = s.tenant_id AND m.price_write_scope_id = s.write_scope_id
        JOIN LATERAL (
          -- Действующая себестоимость — как в контексте решения: своя витрины аккаунта раньше общей (ревью шага 74, находка 3 по Р-211)
          SELECT cp.currency FROM tenant_data.cost_profile cp
           WHERE cp.tenant_id = s.tenant_id AND cp.product_id = s.product_id
             AND (cp.channel_account_id IS NULL OR (cp.channel_account_id = s.channel_account_id AND cp.marketplace = m.marketplace))
             AND cp.valid_from <= p_now
           ORDER BY (cp.channel_account_id IS NOT NULL) DESC, cp.valid_from DESC, cp.version DESC LIMIT 1) c ON c.currency <> s.currency
        -- Отношение курсов к евро: сколько единиц валюты цены за единицу валюты себестоимости (у евро курс 1)
        JOIN LATERAL (SELECT
            (CASE WHEN s.currency = 'EUR' THEN 1 ELSE (fx_now -> s.currency ->> 'rate')::numeric END)
              / nullif(CASE WHEN c.currency = 'EUR' THEN 1 ELSE (fx_now -> c.currency ->> 'rate')::numeric END, 0) AS new_ratio,
            (CASE WHEN s.currency = 'EUR' THEN 1 ELSE (w.fx_seen -> s.currency ->> 'rate')::numeric END)
              / nullif(CASE WHEN c.currency = 'EUR' THEN 1 ELSE (w.fx_seen -> c.currency ->> 'rate')::numeric END, 0) AS old_ratio) q
          ON q.new_ratio > coalesce(q.old_ratio, 0)
       WHERE s.tenant_id = t AND s.channel_account_id = p_channel_account_id AND s.field = 'PRICE' AND s.pricing_mode = 'ENGINE'
      UNION
      SELECT s.tenant_id, s.write_scope_id, 'VAT_UPDATE'
        FROM tenant_data.write_scope s
        JOIN tenant_data.offer_mapping m ON m.tenant_id = s.tenant_id AND m.price_write_scope_id = s.write_scope_id
        JOIN platform.marketplace mk ON mk.channel = s.channel AND mk.marketplace = m.marketplace
       WHERE s.tenant_id = t AND s.channel_account_id = p_channel_account_id AND s.field = 'PRICE' AND s.pricing_mode = 'ENGINE'
         AND s.tax_regime = 'VAT_INCLUDED' AND (vat_now -> mk.country) IS DISTINCT FROM (w.vat_seen -> mk.country)
    ) u
  ON CONFLICT (tenant_id, write_scope_id, reason) DO UPDATE SET requested_at = greatest(floor_raise_request.requested_at, EXCLUDED.requested_at);
  GET DIAGNOSTICS n = ROW_COUNT;
  UPDATE tenant_data.floor_raise_watermark SET fx_seen = fx_now, vat_seen = vat_now
   WHERE tenant_id = t AND channel_account_id = p_channel_account_id;
  RETURN n;
END $fn$;
ALTER FUNCTION tenant_data.request_floor_raise_for_platform_inputs(uuid, timestamptz) OWNER TO repracer_floor_raise;
REVOKE EXECUTE ON FUNCTION tenant_data.request_floor_raise_for_platform_inputs(uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenant_data.request_floor_raise_for_platform_inputs(uuid, timestamptz) TO repracer_app;

-- Закрытие тенанта уносит отметки вместе с ним (правило 0102)
DO $do$
DECLARE
  d text := pg_get_functiondef('maintenance.purge_tenant_data(uuid)'::regprocedure);
  a text := $s$'tenant_data.floor_raise_request',$s$;
BEGIN
  IF (length(d) - length(replace(d, a, ''))) / length(a) <> 1 THEN
    RAISE EXCEPTION '0182: maintenance.purge_tenant_data(uuid) is not the definition the migration expects';
  END IF;
  EXECUTE replace(d, a, $s$'tenant_data.floor_raise_request', 'tenant_data.floor_raise_watermark',$s$);
END $do$;

-- ---------------------------------------------------------------- 3. Пауза лестницы [Р-212]
-- Под запрос последней ступени единицы в контексте решения (PgPricingStore, SCOPE_COLUMNS `last_ladder_step_at`): ступени единицы за сутки
SET ROLE repracer_owner;
CREATE INDEX price_decision_ladder_scope_idx ON channel_data.price_decision (tenant_id, write_scope_id, decided_at)
  WHERE ladder_from_minor IS NOT NULL;
RESET ROLE;

-- Оценка внутри паузы лестницы — «без изменения» со своим кодом
ALTER TABLE channel_data.price_decision DROP CONSTRAINT price_decision_no_change_reason_code;
ALTER TABLE channel_data.price_decision ADD CONSTRAINT price_decision_no_change_reason_code CHECK (no_change_reason = ANY (ARRAY[
  'ALREADY_AT_TARGET', 'WITHIN_DEADBAND', 'ALREADY_WINNING_BUYBOX', 'NO_COMPETITOR_OFFERS', 'TARGET_OUTSIDE_BOUNDS_HOLD',
  'SHADOW_ALREADY_PROPOSED', 'LADDER_PACED']));

-- ---------------------------------------------------------------- 4. Реестры параметров слепка объяснения
SET ROLE repracer_owner;
DO $do$
DECLARE
  keys jsonb := security.eternal_param_keys();
  kinds jsonb := security.eternal_param_kinds();
  after jsonb := '{"k":"enum","v":["COST_UPDATE","FLOOR_RECHECK","FX_UPDATE","BOUNDS_UPDATE","GUARDRAIL_UPDATE","VAT_UPDATE"]}'::jsonb;
BEGIN
  IF keys ? 'LADDER_PACED' OR kinds #> '{RAISED_TO_FLOOR,after,v}' <> '["COST_UPDATE","FLOOR_RECHECK"]'::jsonb THEN
    RAISE EXCEPTION '0182: the reason registries are not the ones the migration expects';
  END IF;
  keys := keys || jsonb_build_object('LADDER_PACED', '["currency","currentMinor","floorMinor","nextStepAt"]'::jsonb);
  kinds := jsonb_set(jsonb_set(kinds, '{RAISED_TO_FLOOR,after}', after), '{RAISED_TOWARD_FLOOR,after}', after)
    || jsonb_build_object('LADDER_PACED', '{"currentMinor":{"k":"money"},"floorMinor":{"k":"money"},"nextStepAt":{"k":"instant"},"currency":{"k":"currency"}}'::jsonb);
  EXECUTE format($f$CREATE OR REPLACE FUNCTION security.eternal_param_keys() RETURNS jsonb
    LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $b$ SELECT %L::jsonb $b$$f$, keys);
  EXECUTE format($f$CREATE OR REPLACE FUNCTION security.eternal_param_kinds() RETURNS jsonb
    LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $b$ SELECT %L::jsonb $b$$f$, kinds);
END $do$;

-- ---------------------------------------------------------------- 5. Ручная поправка закрытых суток знает ступени (ревью шага 73)
ALTER TABLE tenant_data.price_daily_correction ADD COLUMN ladder_steps int NOT NULL DEFAULT 0;
COMMENT ON COLUMN tenant_data.price_daily_correction.ladder_steps IS
  'Р-208: сколько цен суток — ступени лестницы к полу; поправка человека называет их, как свёртка и системная поправка (0180)';
ALTER TABLE tenant_data.price_daily_correction DROP CONSTRAINT price_daily_correction_check3;
ALTER TABLE tenant_data.price_daily_correction ADD CONSTRAINT price_daily_correction_check3 CHECK (min_amount_minor >= min_floor_minor OR ladder_steps > 0);

-- Итог суток несёт число ступеней действующей строки: поправки человека, иначе системной, иначе свёртки (столбец — в конце, как требует
-- CREATE OR REPLACE VIEW; `x.*` и `y.*` раскрываются заново и берут новый столбец поправок)
CREATE OR REPLACE VIEW tenant_data.price_daily_effective WITH (security_invoker = true) AS
  SELECT d.tenant_id, d.write_scope_id, d.price_type, d.price_day, d.day_tz, d.currency, d.price_basis,
         CASE WHEN c.price_daily_correction_id IS NOT NULL THEN c.min_amount_minor WHEN s.correction_id IS NOT NULL THEN s.min_amount_minor ELSE d.min_amount_minor END AS min_amount_minor,
         CASE WHEN c.price_daily_correction_id IS NOT NULL THEN c.max_amount_minor WHEN s.correction_id IS NOT NULL THEN s.max_amount_minor ELSE d.max_amount_minor END AS max_amount_minor,
         CASE WHEN c.price_daily_correction_id IS NOT NULL THEN c.first_amount_minor WHEN s.correction_id IS NOT NULL THEN s.first_amount_minor ELSE d.first_amount_minor END AS first_amount_minor,
         CASE WHEN c.price_daily_correction_id IS NOT NULL THEN c.first_accepted_at WHEN s.correction_id IS NOT NULL THEN s.first_accepted_at ELSE d.first_accepted_at END AS first_accepted_at,
         CASE WHEN c.price_daily_correction_id IS NOT NULL THEN c.last_amount_minor WHEN s.correction_id IS NOT NULL THEN s.last_amount_minor ELSE d.last_amount_minor END AS last_amount_minor,
         CASE WHEN c.price_daily_correction_id IS NOT NULL THEN c.last_accepted_at WHEN s.correction_id IS NOT NULL THEN s.last_accepted_at ELSE d.last_accepted_at END AS last_accepted_at,
         CASE WHEN c.price_daily_correction_id IS NOT NULL THEN c.change_count WHEN s.correction_id IS NOT NULL THEN s.change_count ELSE d.change_count END AS change_count,
         CASE WHEN c.price_daily_correction_id IS NOT NULL THEN c.min_floor_minor WHEN s.correction_id IS NOT NULL THEN s.min_floor_minor ELSE d.min_floor_minor END AS min_floor_minor,
         COALESCE(c.price_daily_correction_id, s.correction_id) AS correction_id,
         COALESCE(c.reason, s.reason) AS correction_reason,
         CASE WHEN c.price_daily_correction_id IS NOT NULL THEN 'HUMAN'
              WHEN s.correction_id IS NOT NULL THEN 'SYSTEM' END AS corrected_by,
         (c.price_daily_correction_id IS NOT NULL OR s.correction_id IS NOT NULL) AS corrected,
         CASE WHEN c.price_daily_correction_id IS NOT NULL THEN c.ladder_steps WHEN s.correction_id IS NOT NULL THEN s.ladder_steps ELSE d.ladder_steps END AS ladder_steps
    FROM tenant_data.price_daily d
    LEFT JOIN LATERAL (
      SELECT x.* FROM tenant_data.price_daily_correction x
       WHERE x.tenant_id = d.tenant_id AND x.write_scope_id = d.write_scope_id AND x.price_type = d.price_type AND x.price_day = d.price_day
         AND NOT EXISTS (SELECT 1 FROM tenant_data.price_daily_correction n
                          WHERE n.tenant_id = x.tenant_id AND n.supersedes_correction_id = x.price_daily_correction_id)) c ON true
    LEFT JOIN LATERAL (
      SELECT y.* FROM tenant_data.price_daily_system_correction y
       WHERE y.tenant_id = d.tenant_id AND y.write_scope_id = d.write_scope_id AND y.price_type = d.price_type AND y.price_day = d.price_day
         AND NOT EXISTS (SELECT 1 FROM tenant_data.price_daily_system_correction n
                          WHERE n.tenant_id = y.tenant_id AND n.supersedes_correction_id = y.correction_id)) s ON true;
RESET ROLE;

COMMIT;
