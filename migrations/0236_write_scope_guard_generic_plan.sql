-- 0236_write_scope_guard_generic_plan.sql
-- Шаг 155 (находка выкладки QA-A 2026-11-17): новые предложения с правилом умолчания не заводились на общем плане PL/pgSQL.
--
-- Журнал стенда QA-A с 13 ноября: «demo US new offers failed: permission denied for table tenant». Страж единицы записи (0005)
-- держал подзапрос к `tenant_data.tenant` в ОДНОМ выражении с проверкой режима Smart Pricing. Правило умолчания (0199) назначает
-- стратегию новичку узкой ролью `repracer_default_strategy` — UPDATE единицы в транзакции обнаружения; права на `tenant` у неё нет и не
-- нужно. На своём плане выражение сворачивается (режим не Smart Pricing — подзапроса нет), на общем (с шестого исполнения в сессии)
-- подзапрос остаётся, проверка прав идёт на весь запрос — и обнаружение отказывает целиком: у продавца с умолчанием новые предложения
-- не появляются никогда. Класс шага 61 (0160): подзапрос — только в ветке Smart Pricing. Поведение стража не меняется.

BEGIN;

SET ROLE repracer_owner;
CREATE OR REPLACE FUNCTION tenant_data.write_scope_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  c record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT status, write_scope_kind, processing_mode, requires_side_effects_ack, budget_scope_attribute INTO c
      FROM platform.channel_capability
     WHERE capability_id = NEW.capability_id AND version = NEW.capability_version;
    IF c.status IS DISTINCT FROM 'ACTIVE' THEN
      RAISE EXCEPTION 'write_scope must be derived from an ACTIVE capability' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF (c.budget_scope_attribute IS NULL) <> (NEW.budget_scope_key IS NULL) THEN
      RAISE EXCEPTION 'budget_scope_key presence must follow capability budget_scope_attribute'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    NEW.scope_kind                := c.write_scope_kind;
    NEW.processing_mode           := c.processing_mode;
    NEW.requires_side_effects_ack := c.requires_side_effects_ack;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'RETIRED' THEN
    RAISE EXCEPTION 'write_scope % is RETIRED', OLD.write_scope_id USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  -- Шаг 155: подзапрос к тенанту — только в ветке Smart Pricing; одним выражением он оставался на общем плане и требовал права на
  -- `tenant` у любой роли, меняющей единицу (узкая роль правила умолчания)
  IF NEW.pricing_mode = 'KAUFLAND_SMART_PRICING' THEN
    IF NOT EXISTS (SELECT 1 FROM tenant_data.tenant
                    WHERE tenant_id = NEW.tenant_id AND kaufland_smart_pricing_opt_in_at IS NOT NULL) THEN
      RAISE EXCEPTION 'tenant has not opted in to Kaufland Smart Pricing' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
RESET ROLE;

COMMIT;
