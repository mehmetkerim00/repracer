-- 0216_buybox_holder_required.sql
-- Шаг 115.2 (решение владельца по докладу шага 115): стратегия, которой нужен держатель Buy Box, без него цену не двигает, и причина видна в журнале цен так же,
-- как у NO_ELIGIBLE_COMPETITORS. До шага такая оценка не оставляла строки решения вовсе: причина жила только в стадиях отчёта пути решения.
--
-- Новый код «без изменения» BUYBOX_HOLDER_REQUIRED и реестры параметров слепка. Параметр `buyboxHolder` — класс CHANNEL (он уже в списке ключей класса): в вечное
-- ядро не попадает [Р-85]. Новых защит нет: ограничение кода и реестры прежние, их держат строка каталога мутаций и тесты равенства кода и базы.
BEGIN;
SET ROLE repracer_owner;

ALTER TABLE channel_data.price_decision DROP CONSTRAINT price_decision_no_change_reason_code;
ALTER TABLE channel_data.price_decision ADD CONSTRAINT price_decision_no_change_reason_code CHECK (no_change_reason = ANY (ARRAY[
  'ALREADY_AT_TARGET', 'WITHIN_DEADBAND', 'ALREADY_WINNING_BUYBOX', 'NO_COMPETITOR_OFFERS', 'TARGET_OUTSIDE_BOUNDS_HOLD',
  'SHADOW_ALREADY_PROPOSED', 'LADDER_PACED', 'BUYBOX_HOLDER_UNKNOWN', 'CREEP_PACED', 'CREEP_PAUSED', 'CREEP_AT_MAX', 'NO_ELIGIBLE_COMPETITORS',
  'CHANNEL_BOUNDS_HOLD', 'BUYBOX_HOLDER_REQUIRED']));

DO $do$
DECLARE
  keys jsonb := security.eternal_param_keys();
  kinds jsonb := security.eternal_param_kinds();
BEGIN
  IF keys ? 'BUYBOX_HOLDER_REQUIRED' OR kinds ? 'BUYBOX_HOLDER_REQUIRED' OR NOT 'buyboxHolder' = ANY (security.channel_param_keys()) THEN
    RAISE EXCEPTION '0216: the reason registries are not the ones the migration expects';
  END IF;
  keys := keys || '{"BUYBOX_HOLDER_REQUIRED": []}'::jsonb;
  kinds := kinds || '{"BUYBOX_HOLDER_REQUIRED": {}}'::jsonb;
  EXECUTE format($f$CREATE OR REPLACE FUNCTION security.eternal_param_keys() RETURNS jsonb
    LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $b$ SELECT %L::jsonb $b$$f$, keys);
  EXECUTE format($f$CREATE OR REPLACE FUNCTION security.eternal_param_kinds() RETURNS jsonb
    LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $b$ SELECT %L::jsonb $b$$f$, kinds);
END $do$;

RESET ROLE;
COMMIT;
