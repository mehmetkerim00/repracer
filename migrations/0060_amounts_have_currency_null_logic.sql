-- 0060_amounts_have_currency_null_logic.sql
-- Шаг 16, найдено переводом правила 29 проверки схемы на поведение (Р-93): security.jsonb_amounts_have_currency (0042) не ловила сумму
-- БЕЗ ключа currency. Условие NOT (jsonb_typeof(j -> 'currency') = 'string' OR …) при отсутствующем ключе давало NULL, а IF NULL — это
-- «не выполнено»: функция возвращала true. Отказ был только для currency не строкой. Проверка Р-71 в БД (решение, ядро intent, параметры
-- завершения записи, отклонённый снимок) не работала с шага 12; правило 29 сверяло лишь имена ограничений и проходило.
-- Доказательство: tests/db/smoke_app.sql «rejected snapshot details: an amount without its currency (Р-71)» — падал до исправления
-- (docs/evidence/step16-r71-before.log), проходит после. Код (validateReason, reasons.ts) проверял валюту верно — через него суммы без
-- валюты в базу не попадали; незащищённым был путь в обход кода.

BEGIN;
SET ROLE repracer_owner;

CREATE OR REPLACE FUNCTION security.jsonb_amounts_have_currency(j jsonb) RETURNS boolean
  LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  k text;
  v jsonb;
BEGIN
  IF j IS NULL THEN
    RETURN true;
  END IF;
  IF jsonb_typeof(j) = 'array' THEN
    FOR v IN SELECT value FROM jsonb_array_elements(j) LOOP
      IF NOT security.jsonb_amounts_have_currency(v) THEN
        RETURN false;
      END IF;
    END LOOP;
    RETURN true;
  END IF;
  IF jsonb_typeof(j) <> 'object' THEN
    RETURN true;
  END IF;
  FOR k, v IN SELECT key, value FROM jsonb_each(j) LOOP
    -- coalesce: отсутствующий ключ currency (NULL) — это «валюты нет», а не «неизвестно»
    IF k LIKE '%Minor' AND jsonb_typeof(v) = 'number'
       AND NOT coalesce(jsonb_typeof(j -> 'currency') = 'string' OR (jsonb_typeof(j -> 'from') = 'string' AND jsonb_typeof(j -> 'to') = 'string'), false) THEN
      RETURN false;
    END IF;
    IF jsonb_typeof(v) IN ('object', 'array') AND NOT security.jsonb_amounts_have_currency(v) THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
END $$;

RESET ROLE;

-- Строки, записанные при неработающей проверке: исправленная функция не пересматривает их сама. Нарушение — отказ миграции с таблицей:
-- такие строки разбираются явно, а не остаются молча (в выпуске данных нет; стенд пересоздаётся)
DO $$
DECLARE
  bad text[] := '{}';
BEGIN
  IF EXISTS (SELECT 1 FROM channel_data.price_decision WHERE NOT (security.jsonb_amounts_have_currency(reason_params) AND security.jsonb_amounts_have_currency(checks) AND security.jsonb_amounts_have_currency(explanation))) THEN
    bad := bad || 'channel_data.price_decision';
  END IF;
  IF EXISTS (SELECT 1 FROM tenant_data.channel_write WHERE NOT security.jsonb_amounts_have_currency(end_params)) THEN
    bad := bad || 'tenant_data.channel_write';
  END IF;
  IF EXISTS (SELECT 1 FROM channel_data.rejected_competitor_snapshot WHERE NOT security.jsonb_amounts_have_currency(details)) THEN
    bad := bad || 'channel_data.rejected_competitor_snapshot';
  END IF;
  IF cardinality(bad) > 0 THEN
    RAISE EXCEPTION 'rows with amounts without currency written while the check did not work (Р-71): %', array_to_string(bad, ', ');
  END IF;
END $$;

COMMIT;
