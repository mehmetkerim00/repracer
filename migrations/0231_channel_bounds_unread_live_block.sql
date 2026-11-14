-- 0231_channel_bounds_unread_live_block.sql
-- Шаг 128 [Р-250] (решение владельца по докладу шага 127, П1 в бою): рамки Amazon Min/Max на SKU, чьи значения мы не прочитали (или прочитали
-- не в валюте предложения), у аккаунта В БОЮ снова блокируют предложение целиком — как до шага 127 (0205): стратегию не назначит база, движок не
-- включится, умолчание аккаунта не назначится, привязку отклонит страж — отказ своей причиной CHANNEL_BOUNDS_PRESENT. В тени — как сделано шагом 127
-- (0230): решения считаются, пометка «Price held: Amazon bounds».
--
-- Причина владельца: «CRITICAL должен означать неожиданное; предсказуемый стоп по известному заранее состоянию — шум, приучающий игнорировать
-- алерты». В бою включённое предложение с известными рамками упиралось бы в адаптер на первой же записи (AMZ_C03: BLOCKED и CRITICAL) — теперь его
-- не включить. Стоп записи и алерт для рамок, появившихся ПОСЛЕ включения, остаются у адаптера: это неожиданное событие.
--
-- Режим — текущий режим аккаунта (`channel_account.write_mode`, 0128). Правило — одно у стражей назначения стратегии и включения движка (0085),
-- стратегии по умолчанию (0199) и привязки предложения (0205, 0230).
BEGIN;
SET ROLE repracer_owner;

-- Роль стратегии по умолчанию зовёт правило в транзакции обнаружения (0199), роль каталога проходит страж привязки — режим аккаунта им нужен для чтения
GRANT SELECT (write_mode) ON tenant_data.channel_account TO repracer_default_strategy, repracer_catalog;

/** Р-120, Р-250: у предложения единицы записи действует ценообразование канала по последнему наблюдению — Automate Pricing всегда, рамки без
 *  прочитанных значений — у аккаунта в бою (шаг 128) */
CREATE OR REPLACE FUNCTION channel_data.offer_channel_pricing_active(p_tenant_id uuid, p_write_scope_id uuid) RETURNS text
  LANGUAGE sql STABLE SET search_path = pg_catalog AS $fn$
  SELECT CASE WHEN o.automated_pricing THEN 'CHANNEL_REPRICER_ACTIVE'
              -- Шаг 128: в бою рамки без значений в валюте предложения — блок предложения целиком; в тени — нет (0230)
              WHEN o.channel_bounds AND o.bounds_currency IS DISTINCT FROM s.currency AND a.write_mode = 'LIVE' THEN 'CHANNEL_BOUNDS_PRESENT' END
    FROM tenant_data.offer_mapping m
    JOIN tenant_data.write_scope s ON s.tenant_id = m.tenant_id AND s.write_scope_id = m.price_write_scope_id
    JOIN tenant_data.channel_account a ON a.tenant_id = m.tenant_id AND a.channel_account_id = m.channel_account_id
    JOIN LATERAL (
      SELECT x.automated_pricing, x.channel_bounds, x.bounds_currency FROM channel_data.offer_channel_pricing x
       WHERE x.tenant_id = m.tenant_id AND x.channel_account_id = m.channel_account_id AND x.marketplace = m.marketplace AND x.external_sku = m.external_sku
       ORDER BY x.observed_at DESC, x.recorded_at DESC LIMIT 1) o ON true
   WHERE m.tenant_id = p_tenant_id AND m.price_write_scope_id = p_write_scope_id AND m.external_sku IS NOT NULL
     AND (o.automated_pricing OR (o.channel_bounds AND o.bounds_currency IS DISTINCT FROM s.currency AND a.write_mode = 'LIVE'))
   LIMIT 1
$fn$;

-- Р-120, Р-250: страж привязки — то же правило, что у стража назначения
CREATE OR REPLACE FUNCTION tenant_data.offer_mapping_channel_pricing_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
DECLARE
  pricing  text;
  currency text;
  live     boolean;
BEGIN
  IF NEW.price_write_scope_id IS NULL OR NEW.external_sku IS NULL
     OR (TG_OP = 'UPDATE' AND NEW.price_write_scope_id IS NOT DISTINCT FROM OLD.price_write_scope_id AND NEW.external_sku IS NOT DISTINCT FROM OLD.external_sku) THEN
    RETURN NEW;
  END IF;
  SELECT s.currency, a.write_mode = 'LIVE' INTO currency, live
    FROM tenant_data.write_scope s JOIN tenant_data.channel_account a ON a.tenant_id = s.tenant_id AND a.channel_account_id = s.channel_account_id
   WHERE s.tenant_id = NEW.tenant_id AND s.write_scope_id = NEW.price_write_scope_id AND s.pricing_mode = 'ENGINE' AND s.pricing_strategy_id IS NOT NULL;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  SELECT CASE WHEN x.automated_pricing THEN 'CHANNEL_REPRICER_ACTIVE'
              WHEN x.channel_bounds AND x.bounds_currency IS DISTINCT FROM currency AND live THEN 'CHANNEL_BOUNDS_PRESENT' END INTO pricing
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
  'Р-233: валюта значений рамок; NULL при channel_bounds — значения не прочитаны: у аккаунта в бою блок предложения (шаг 128), в тени — пометка (Р-250)';

RESET ROLE;
COMMIT;
