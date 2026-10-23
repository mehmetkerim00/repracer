-- 0205_channel_bound_values.sql
-- Шаг 107 [Р-233, Р-231]: рамки цены, заданные продавцом в канале (Amazon Min/Max на SKU — `minimum_seller_allowed_price` /
-- `maximum_seller_allowed_price`), хранятся со ЗНАЧЕНИЯМИ, которые назвал канал. Мы их по-прежнему не пишем [Р-111, Р-114].
--
-- До шага наблюдение знало только «рамки есть», и любые рамки блокировали предложение целиком (`CHANNEL_BOUNDS_PRESENT`, 0082). Решение
-- владельца после шага 105 (Р-231): рамки, которые не сужают наш диапазон, — законная настройка продавца; более узкие — блок с названными
-- значениями. Решение владельца на шаге 107: блок — у ЦЕНЫ, а не у предложения: цена вне рамок канала не уходит (движок, «без изменения»
-- CHANNEL_BOUNDS_HOLD с обеими суммами), цена внутри — уходит; распродажа ниже Min канала — предупреждение, цена уходит, конфликт записан
-- в квитанции (CLEARANCE_BELOW_CHANNEL_MIN).
--
-- 1. Значения рамок у наблюдения: в валюте витрины и без доставки — как наша цена записи (A-30, docs/channels/amazon.md). Данные канала:
--    срок таблицы прежний (≤ 18 мес, Р-3), в вечное ядро не попадают [Р-85].
-- 2. Блок предложения целиком (страж назначения стратегии и страж привязки) остаётся только у рамок, чьи значения неизвестны: канал
--    значений не назвал (так читает настоящий адаптер Amazon до живого аккаунта, A-30) или назвал не в валюте предложения — сравнивать не
--    с чем, fail-closed.
-- 3. Новый код «без изменения» и реестры параметров слепка.

BEGIN;
SET ROLE repracer_owner;

-- ---------------------------------------------------------------- 1. Значения рамок
ALTER TABLE channel_data.offer_channel_pricing
  ADD COLUMN channel_min_minor bigint,
  ADD COLUMN channel_max_minor bigint,
  ADD COLUMN bounds_currency text,
  -- Значения — только у рамок; валюта — ровно тогда, когда названа хоть одна сторона (рамки без значений — «не прочитаны», а не «нет»)
  ADD CONSTRAINT offer_channel_pricing_bound_values_shape CHECK (
    (bounds_currency IS NULL) = (channel_min_minor IS NULL AND channel_max_minor IS NULL)
    AND (bounds_currency IS NULL OR (channel_bounds AND bounds_currency ~ '^[A-Z]{3}$'))),
  -- Суммы — положительные, Min не выше Max
  ADD CONSTRAINT offer_channel_pricing_bound_values_range CHECK (channel_min_minor > 0 AND channel_max_minor > 0 AND channel_min_minor <= channel_max_minor);

COMMENT ON COLUMN channel_data.offer_channel_pricing.channel_min_minor IS
  'Р-233: Min, заданный продавцом в канале (Amazon minimum_seller_allowed_price), в валюте bounds_currency, без доставки; NULL — канал не назвал';
COMMENT ON COLUMN channel_data.offer_channel_pricing.channel_max_minor IS
  'Р-233: Max, заданный продавцом в канале (Amazon maximum_seller_allowed_price), в валюте bounds_currency, без доставки; NULL — канал не назвал';
COMMENT ON COLUMN channel_data.offer_channel_pricing.bounds_currency IS
  'Р-233: валюта значений рамок; NULL при channel_bounds — значения не прочитаны (блок предложения целиком, Р-120)';

-- ---------------------------------------------------------------- 2. Блок предложения — только у рамок с неизвестными значениями
/** Р-120, Р-231: у предложения единицы записи действует собственное ценообразование канала по последнему наблюдению */
CREATE OR REPLACE FUNCTION channel_data.offer_channel_pricing_active(p_tenant_id uuid, p_write_scope_id uuid) RETURNS text
  LANGUAGE sql STABLE SET search_path = pg_catalog AS $fn$
  SELECT CASE WHEN o.automated_pricing THEN 'CHANNEL_REPRICER_ACTIVE'
              -- Шаг 107 [Р-231]: рамки со значениями в валюте предложения — не блок; цену вне них держит путь решения [Р-233]
              WHEN o.channel_bounds AND o.bounds_currency IS DISTINCT FROM s.currency THEN 'CHANNEL_BOUNDS_PRESENT' END
    FROM tenant_data.offer_mapping m
    JOIN tenant_data.write_scope s ON s.tenant_id = m.tenant_id AND s.write_scope_id = m.price_write_scope_id
    JOIN LATERAL (
      SELECT x.automated_pricing, x.channel_bounds, x.bounds_currency FROM channel_data.offer_channel_pricing x
       WHERE x.tenant_id = m.tenant_id AND x.channel_account_id = m.channel_account_id AND x.marketplace = m.marketplace AND x.external_sku = m.external_sku
       ORDER BY x.observed_at DESC, x.recorded_at DESC LIMIT 1) o ON true
   WHERE m.tenant_id = p_tenant_id AND m.price_write_scope_id = p_write_scope_id AND m.external_sku IS NOT NULL
     AND (o.automated_pricing OR (o.channel_bounds AND o.bounds_currency IS DISTINCT FROM s.currency))
   LIMIT 1
$fn$;

-- Р-120 (ревью шага 23, находка 3), шаг 107 [Р-231]: страж привязки — то же правило, что у стража назначения
CREATE OR REPLACE FUNCTION tenant_data.offer_mapping_channel_pricing_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
DECLARE
  pricing  text;
  currency text;
BEGIN
  IF NEW.price_write_scope_id IS NULL OR NEW.external_sku IS NULL
     OR (TG_OP = 'UPDATE' AND NEW.price_write_scope_id IS NOT DISTINCT FROM OLD.price_write_scope_id AND NEW.external_sku IS NOT DISTINCT FROM OLD.external_sku) THEN
    RETURN NEW;
  END IF;
  SELECT s.currency INTO currency FROM tenant_data.write_scope s WHERE s.tenant_id = NEW.tenant_id AND s.write_scope_id = NEW.price_write_scope_id
     AND s.pricing_mode = 'ENGINE' AND s.pricing_strategy_id IS NOT NULL;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  SELECT CASE WHEN x.automated_pricing THEN 'CHANNEL_REPRICER_ACTIVE'
              WHEN x.channel_bounds AND x.bounds_currency IS DISTINCT FROM currency THEN 'CHANNEL_BOUNDS_PRESENT' END INTO pricing
    FROM channel_data.offer_channel_pricing x
   WHERE x.tenant_id = NEW.tenant_id AND x.channel_account_id = NEW.channel_account_id AND x.marketplace = NEW.marketplace AND x.external_sku = NEW.external_sku
   ORDER BY x.observed_at DESC, x.recorded_at DESC LIMIT 1;
  IF pricing IS NOT NULL THEN
    RAISE EXCEPTION 'write_scope % has channel-owned pricing (%): a strategy cannot be assigned (Р-120)', NEW.price_write_scope_id, pricing
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $fn$;

-- ---------------------------------------------------------------- 3. Код «без изменения» и реестры слепка
ALTER TABLE channel_data.price_decision DROP CONSTRAINT price_decision_no_change_reason_code;
ALTER TABLE channel_data.price_decision ADD CONSTRAINT price_decision_no_change_reason_code CHECK (no_change_reason = ANY (ARRAY[
  'ALREADY_AT_TARGET', 'WITHIN_DEADBAND', 'ALREADY_WINNING_BUYBOX', 'NO_COMPETITOR_OFFERS', 'TARGET_OUTSIDE_BOUNDS_HOLD',
  'SHADOW_ALREADY_PROPOSED', 'LADDER_PACED', 'BUYBOX_HOLDER_UNKNOWN', 'CREEP_PACED', 'CREEP_PAUSED', 'CREEP_AT_MAX', 'NO_ELIGIBLE_COMPETITORS',
  'CHANNEL_BOUNDS_HOLD']));

DO $do$
DECLARE
  keys jsonb := security.eternal_param_keys();
  kinds jsonb := security.eternal_param_kinds();
  channel text[] := security.channel_param_keys();
  derived jsonb := security.channel_derived_param_keys();
BEGIN
  IF keys ? 'CHANNEL_BOUNDS_HOLD' OR kinds ? 'CLEARANCE_BELOW_CHANNEL_MIN' OR 'channelMinMinor' = ANY (channel) OR derived ? 'CHANNEL_BOUNDS_HOLD'
     OR NOT keys ? 'CLEARANCE_FLOOR' OR NOT keys ? 'NO_ELIGIBLE_COMPETITORS' THEN
    RAISE EXCEPTION '0205: the reason registries are not the ones the migration expects';
  END IF;
  -- Вечные — сторона рамки, пол распродажи и валюта: суммы рамок — данные канала [Р-3], цель стратегии — производная цены конкурента [Р-85]
  keys := keys || '{"CHANNEL_BOUNDS_HOLD": ["currency", "side"], "CLEARANCE_BELOW_CHANNEL_MIN": ["currency", "floorMinor"]}'::jsonb;
  kinds := kinds || jsonb_build_object(
    'CHANNEL_BOUNDS_HOLD', '{"side": {"k": "enum", "v": ["MIN", "MAX"]}, "currency": {"k": "currency"}}'::jsonb,
    'CLEARANCE_BELOW_CHANNEL_MIN', '{"floorMinor": {"k": "money"}, "currency": {"k": "currency"}}'::jsonb);
  -- Ключи класса CHANNEL — в порядке кода (по кодовым единицам, COLLATE "C")
  channel := ARRAY(SELECT x FROM (SELECT DISTINCT x FROM unnest(channel || ARRAY['channelMaxMinor', 'channelMinMinor']) x) d ORDER BY x COLLATE "C");
  derived := derived || '{"CHANNEL_BOUNDS_HOLD": ["targetMinor"]}'::jsonb;
  EXECUTE format($f$CREATE OR REPLACE FUNCTION security.eternal_param_keys() RETURNS jsonb
    LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $b$ SELECT %L::jsonb $b$$f$, keys);
  EXECUTE format($f$CREATE OR REPLACE FUNCTION security.eternal_param_kinds() RETURNS jsonb
    LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $b$ SELECT %L::jsonb $b$$f$, kinds);
  EXECUTE format($f$CREATE OR REPLACE FUNCTION security.channel_param_keys() RETURNS text[]
    LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $b$ SELECT %L::text[] $b$$f$, channel);
  EXECUTE format($f$CREATE OR REPLACE FUNCTION security.channel_derived_param_keys() RETURNS jsonb
    LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $b$ SELECT %L::jsonb $b$$f$, derived);
END $do$;

RESET ROLE;
COMMIT;
