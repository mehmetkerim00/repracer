-- 0230_channel_bounds_unread_no_offer_block.sql
-- Шаг 127 [Р-250] (П1 аудита авторизации Amazon 2026-11-14, решение владельца): рамки Amazon Min/Max на SKU, чьи значения мы не прочитали (так
-- читает настоящий адаптер до живого аккаунта, A-30) или прочитали не в валюте предложения, больше НЕ блокируют предложение целиком.
--
-- До шага (0082, 0205) такие рамки были «ценообразованием канала» наравне с Automate Pricing: стратегию не назначала база, движок не включался,
-- умолчание аккаунта не назначалось — и у такого SKU не было ни одного теневого решения. Решение владельца: «теневые решения считать и показывать
-- с честной пометкой «запись будет удержана: на SKU стоят рамки Amazon»; сама блокировка записи остаётся как есть». Блок записи — у адаптера
-- Amazon: перед каждой отправкой цены он читает листинг и с рамками запись не отправляет (AMZ_C03, шаг 22) — здесь он не меняется.
--
-- Ценообразованием канала остаётся только правило автоматического ценообразования (Automate Pricing, `automated_pricing_merchandising_rule_plan`):
-- это чужой репрайсер [Р-115, Р-120], и блок предложения у него прежний. Одна функция у стражей назначения стратегии и включения движка (0085) и у
-- стратегии по умолчанию (0199); страж привязки предложения (0205) — то же правило своей выборкой.
BEGIN;
SET ROLE repracer_owner;

/** Р-120, Р-250: у предложения единицы записи действует собственное ценообразование канала (Automate Pricing) по последнему наблюдению */
CREATE OR REPLACE FUNCTION channel_data.offer_channel_pricing_active(p_tenant_id uuid, p_write_scope_id uuid) RETURNS text
  LANGUAGE sql STABLE SET search_path = pg_catalog AS $fn$
  SELECT 'CHANNEL_REPRICER_ACTIVE'::text
    FROM tenant_data.offer_mapping m
    JOIN LATERAL (
      SELECT x.automated_pricing FROM channel_data.offer_channel_pricing x
       WHERE x.tenant_id = m.tenant_id AND x.channel_account_id = m.channel_account_id AND x.marketplace = m.marketplace AND x.external_sku = m.external_sku
       ORDER BY x.observed_at DESC, x.recorded_at DESC LIMIT 1) o ON true
   WHERE m.tenant_id = p_tenant_id AND m.price_write_scope_id = p_write_scope_id AND m.external_sku IS NOT NULL
     AND o.automated_pricing
   LIMIT 1
$fn$;

-- Р-120, Р-250: страж привязки — то же правило, что у стража назначения: блок — только правило автоматического ценообразования канала
CREATE OR REPLACE FUNCTION tenant_data.offer_mapping_channel_pricing_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
DECLARE
  pricing text;
BEGIN
  IF NEW.price_write_scope_id IS NULL OR NEW.external_sku IS NULL
     OR (TG_OP = 'UPDATE' AND NEW.price_write_scope_id IS NOT DISTINCT FROM OLD.price_write_scope_id AND NEW.external_sku IS NOT DISTINCT FROM OLD.external_sku) THEN
    RETURN NEW;
  END IF;
  PERFORM 1 FROM tenant_data.write_scope s WHERE s.tenant_id = NEW.tenant_id AND s.write_scope_id = NEW.price_write_scope_id
     AND s.pricing_mode = 'ENGINE' AND s.pricing_strategy_id IS NOT NULL;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  SELECT CASE WHEN x.automated_pricing THEN 'CHANNEL_REPRICER_ACTIVE' END INTO pricing
    FROM channel_data.offer_channel_pricing x
   WHERE x.tenant_id = NEW.tenant_id AND x.channel_account_id = NEW.channel_account_id AND x.marketplace = NEW.marketplace AND x.external_sku = NEW.external_sku
   ORDER BY x.observed_at DESC, x.recorded_at DESC LIMIT 1;
  IF pricing IS NOT NULL THEN
    RAISE EXCEPTION 'write_scope % has channel-owned pricing (%): a strategy cannot be assigned (Р-120)', NEW.price_write_scope_id, pricing
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $fn$;

COMMENT ON COLUMN channel_data.offer_channel_pricing.bounds_currency IS
  'Р-233: валюта значений рамок; NULL при channel_bounds — значения не прочитаны: предложение не блокируется (Р-250), запись держит адаптер перед отправкой';

RESET ROLE;
COMMIT;
