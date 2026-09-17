-- 0085_stop_holds_channel_floor_strategy_assignment.sql
-- Шаг 24, E.
-- 1. OQ-172 (ревью шага 23, находка вне шага В-1): остановка человеком [Р-69] держит и порог цены канала CHANNEL_MIN_PRICE — создание и
--    отправку, как недоверие каналу (0082). До 0085 страж 0042 пропускал все поля, кроме PRICE.
-- 2. OQ-169: назначение существующей версии стратегии без новой версии — только версии в статусе ACTIVE (версия неизменяема,
--    append-only: черновик и архивная версия не назначаются никогда). Проверка — в стражe назначения 0082.

BEGIN;

CREATE OR REPLACE FUNCTION tenant_data.channel_write_stop_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  stop_id uuid;
BEGIN
  IF NEW.field NOT IN ('PRICE', 'CHANNEL_MIN_PRICE') OR (TG_OP = 'UPDATE' AND NOT (NEW.status = 'DISPATCHED' AND OLD.status IS DISTINCT FROM 'DISPATCHED')) THEN
    RETURN NEW;
  END IF;
  stop_id := tenant_data.pricing_stop_for(NEW.tenant_id, NEW.write_scope_id);
  IF stop_id IS NOT NULL THEN
    RAISE EXCEPTION 'pricing is stopped by price_stop % for write_scope % (Р-69)', stop_id, NEW.write_scope_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION tenant_data.write_scope_strategy_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  params  jsonb;
  status  text;
  unmet   jsonb;
  pricing text;
BEGIN
  IF NEW.field <> 'PRICE' OR NEW.pricing_strategy_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.pricing_strategy_id IS NOT DISTINCT FROM OLD.pricing_strategy_id
     AND NEW.pricing_strategy_version IS NOT DISTINCT FROM OLD.pricing_strategy_version
     AND (NEW.pricing_mode IS NOT DISTINCT FROM OLD.pricing_mode OR NEW.pricing_mode <> 'ENGINE') THEN
    RETURN NEW;
  END IF;
  SELECT ps.params || jsonb_build_object('type', ps.type), ps.status INTO params, status FROM tenant_data.pricing_strategy ps
   WHERE ps.tenant_id = NEW.tenant_id AND ps.pricing_strategy_id = NEW.pricing_strategy_id AND ps.version = NEW.pricing_strategy_version;
  -- OQ-169 (0085): назначается только действующая версия
  IF (TG_OP = 'INSERT' OR NEW.pricing_strategy_id IS DISTINCT FROM OLD.pricing_strategy_id OR NEW.pricing_strategy_version IS DISTINCT FROM OLD.pricing_strategy_version)
     AND status IS DISTINCT FROM 'ACTIVE' THEN
    RAISE EXCEPTION 'strategy % version % is % and cannot be assigned (OQ-169)', NEW.pricing_strategy_id, NEW.pricing_strategy_version, status
      USING ERRCODE = 'check_violation';
  END IF;
  unmet := channel_data.strategy_unmet(NEW.channel, params);
  IF unmet <> '{}'::jsonb THEN
    RAISE EXCEPTION 'strategy % version % is not available on channel %: %', NEW.pricing_strategy_id, NEW.pricing_strategy_version, NEW.channel, unmet
      USING ERRCODE = 'check_violation', HINT = 'Р-39';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    pricing := channel_data.offer_channel_pricing_active(NEW.tenant_id, NEW.write_scope_id);
    IF pricing IS NOT NULL THEN
      RAISE EXCEPTION 'write_scope % has channel-owned pricing (%): a strategy cannot be assigned (Р-120)', NEW.write_scope_id, pricing
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $function$;

COMMIT;
