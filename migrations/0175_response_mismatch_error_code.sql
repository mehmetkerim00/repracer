-- 0175_response_mismatch_error_code.sql
-- Шаг 70 [Р-205]: новый код ошибки канала `RESPONSE_MISMATCH` — ответ канала не о том SKU или не о той витрине, что спрошены
-- (песочница SP-API отдала образец о чужом товаре, и адаптер Amazon его принял). Код попадает в параметры причин, которые перечисляют
-- коды ошибок записи (`WRITE_ERROR_CODES` в packages/pricing-model/src/reasons.ts): `SCOPE_NOT_ACTIVE.blockedByErrorCode`,
-- `WRITE_NOT_ACCEPTED_BY_CHANNEL.status`, `WRITE_RETRIES_EXHAUSTED.code`, `WRITE_RETRY_SCHEDULED.code`, `WRITE_SCOPE_BLOCKED.code`.
--
-- Реестр видов параметров (0099) переопределяется значением прежнего реестра, как в 0160: в КАЖДОМ перечислении, где есть
-- `OUTCOME_UNRESOLVED` (последний код списка до шага), новый код дописывается в конец — порядок держит сравнение реестра базы с кодом
-- (тест «finding 15»). Ключи параметров не меняются, новых защит нет.

BEGIN;
SET ROLE repracer_owner;

DO $do$
DECLARE
  kinds jsonb := security.eternal_param_kinds();
  reason record;
  param record;
  extended int := 0;
BEGIN
  FOR reason IN SELECT key, value FROM jsonb_each(security.eternal_param_kinds()) LOOP
    FOR param IN SELECT key, value FROM jsonb_each(reason.value) LOOP
      IF param.value->>'k' = 'enum' AND (param.value->'v') ? 'OUTCOME_UNRESOLVED' AND NOT (param.value->'v') ? 'RESPONSE_MISMATCH' THEN
        kinds := jsonb_set(kinds, ARRAY[reason.key, param.key, 'v'], (param.value->'v') || '["RESPONSE_MISMATCH"]'::jsonb);
        extended := extended + 1;
      END IF;
    END LOOP;
  END LOOP;
  -- Пять параметров перечисляют коды ошибок записи; иное число — реестр не тот, что ожидает шаг, и миграция не должна угадывать
  IF extended <> 5 THEN
    RAISE EXCEPTION '0175: expected 5 write error code lists in security.eternal_param_kinds(), found %', extended;
  END IF;
  EXECUTE format($f$CREATE OR REPLACE FUNCTION security.eternal_param_kinds() RETURNS jsonb
    LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $b$ SELECT %L::jsonb $b$$f$, kinds);
END $do$;

RESET ROLE;
COMMIT;
