-- 0028_fix_engine_mode_guard.sql
-- Дефект, найденный ревью кода шага 6: для несуществующей единицы записи сравнения в assert_engine_mode давали NULL,
-- и проверка режима [Р-12] молча пропускала вставку. Сейчас его маскируют FK price_intent → write_scope и триггер
-- c_price_decision_intent_guard (0024), но проверка не должна зависеть от них. Теперь неизвестная единица записи — отказ.

BEGIN;
SET ROLE repracer_owner;

CREATE OR REPLACE FUNCTION channel_data.assert_engine_mode() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  s record;
BEGIN
  SELECT field, pricing_mode, currency, price_basis INTO s
    FROM tenant_data.write_scope WHERE tenant_id = NEW.tenant_id AND write_scope_id = NEW.write_scope_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION '%.%: write_scope % does not exist', TG_TABLE_SCHEMA, TG_TABLE_NAME, NEW.write_scope_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF s.field IS DISTINCT FROM 'PRICE' OR s.pricing_mode IS DISTINCT FROM 'ENGINE' THEN
    RAISE EXCEPTION '%.% requires a PRICE write_scope in ENGINE mode (got % / %)', TG_TABLE_SCHEMA, TG_TABLE_NAME,
      s.field, s.pricing_mode USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.currency IS DISTINCT FROM s.currency OR NEW.price_basis IS DISTINCT FROM s.price_basis THEN
    RAISE EXCEPTION 'currency/basis must match write_scope' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;

RESET ROLE;
COMMIT;
