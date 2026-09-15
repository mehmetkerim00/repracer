-- 0057_budget_day_unconfirmed_end_reason.sql
-- Шаг 16, находка 7 ревью шага 15 [Р-64, Р-65]: повтор записи с бюджетом правок, которому отказал триггер 0055 (граница суток
-- витрины перестала быть подтверждённой), диспетчер не распознавал: захват пробрасывал ошибку, обход падал на каждом круге,
-- запись висела FAILED без алерта. Теперь запись завершается с причиной WRITE_BUDGET_DAY_UNCONFIRMED (параметр — витрина).
-- Проверка — packages/pricing-store-pg/test/budget-retry-dispatch.pg.test.ts (падал до исправления: docs/evidence/step16-finding7-before.log).

BEGIN;
SET ROLE repracer_owner;

ALTER TABLE tenant_data.channel_write
  DROP CONSTRAINT channel_write_end_reason_known,
  ADD CONSTRAINT channel_write_end_reason_known CHECK (end_reason IS NULL OR end_reason = ANY (ARRAY[
    'WRITE_SUPERSEDED_BY_NEWER_VERSION', 'WRITE_NOT_ACCEPTED_BY_CHANNEL', 'WRITE_RETRIES_EXHAUSTED', 'WRITE_BLOCKED_BY_BOUND_RECHECK',
    'CHANNEL_HALTED', 'PRICING_STOPPED', 'WRITE_PRICING_MODE_CHANGED', 'WRITE_EDIT_BUDGET_EXHAUSTED', 'WRITE_BUDGET_DAY_UNCONFIRMED']));

RESET ROLE;
COMMIT;
