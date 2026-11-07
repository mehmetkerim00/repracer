-- 0218_no_change_collapse.sql
-- Шаг 116 [Р-241, решения владельца по плану шага]: журнал о решениях, а не о чтениях. На опросе Amazon каждая оценка писала строку: до ~55 700 в сутки на аккаунт
-- (расчёт: 20 предложений раз в 31 с), и хранились они 30 суток. Теперь строка «без изменения» пишется при смене состояния единицы и не реже раза в сутки, между
-- ними — живая строка со счётчиком.
--
-- 1. `price_decision.repeats_before` — сколько оценок схлопнуто после прошлой строки единицы: плитки и счётчики считают строки плюс повторы, и число на экране не падает.
-- 2. `tenant_data.price_no_change_state` — живая строка единицы. Своя таблица, а не `write_scope_sync_state`: ту меняют только триггеры (`only_from_trigger`), а повтор
--    идёт без единой строки решения и без триггера. `shadow` — режим аккаунта при записи состояния: смена режима состояние забывает, решение в новом режиме не прячется
--    за строкой прежнего.
-- 3. Код «без изменения» принимает причины «не рассчитано»: устаревший снимок, нет Buy Box, нет доставки и прочее видны в журнале, как любая причина.
--
-- Новых защит нет: сумма и состояние не решают о цене. Форма кода — прежняя строка каталога мутаций, закрытие тенанта — правило 0102, права — правило списка разрешённого.
BEGIN;
SET ROLE repracer_owner;

ALTER TABLE channel_data.price_decision ADD COLUMN repeats_before integer NOT NULL DEFAULT 0;
COMMENT ON COLUMN channel_data.price_decision.repeats_before IS
  'Р-241 (шаг 116): сколько оценок с тем же состоянием схлопнуто после прошлой строки этой единицы; плитки и счётчики считают строки плюс повторы';

CREATE TABLE tenant_data.price_no_change_state (
  tenant_id         uuid NOT NULL,
  write_scope_id    uuid NOT NULL,
  -- NULL — последняя строка журнала изменила цену или отказала: следующее «без изменения» пишется
  state             text,
  decided_at        timestamptz NOT NULL,
  repeats           integer NOT NULL DEFAULT 0,
  last_evaluated_at timestamptz NOT NULL,
  shadow            boolean NOT NULL,
  PRIMARY KEY (tenant_id, write_scope_id),
  FOREIGN KEY (tenant_id, write_scope_id) REFERENCES tenant_data.write_scope (tenant_id, write_scope_id) ON DELETE CASCADE
);
COMMENT ON TABLE tenant_data.price_no_change_state IS
  'Р-241 (шаг 116): живая строка единицы — состояние последней строки журнала и счётчик повторов после неё; состояние без цены конкурента';
SELECT security.register_table('tenant_data.price_no_change_state', 'TENANT', 'mutable');
SELECT security.grant_retention('tenant_data.price_no_change_state');
-- Строка на единицу, уходит вместе с тенантом
INSERT INTO maintenance.retention_policy (table_name, method, bound) VALUES ('tenant_data.price_no_change_state', 'TENANT_CLOSURE_ONLY', 'MAX_AGE');
GRANT SELECT, INSERT, UPDATE ON tenant_data.price_no_change_state TO repracer_app;
RESET ROLE;

ALTER TABLE channel_data.price_decision DROP CONSTRAINT price_decision_no_change_reason_code;
ALTER TABLE channel_data.price_decision ADD CONSTRAINT price_decision_no_change_reason_code CHECK (no_change_reason = ANY (ARRAY[
  'ALREADY_AT_TARGET', 'WITHIN_DEADBAND', 'ALREADY_WINNING_BUYBOX', 'NO_COMPETITOR_OFFERS', 'TARGET_OUTSIDE_BOUNDS_HOLD',
  'SHADOW_ALREADY_PROPOSED', 'LADDER_PACED', 'BUYBOX_HOLDER_UNKNOWN', 'CREEP_PACED', 'CREEP_PAUSED', 'CREEP_AT_MAX', 'NO_ELIGIBLE_COMPETITORS',
  'CHANNEL_BOUNDS_HOLD', 'BUYBOX_HOLDER_REQUIRED',
  'COMPETITOR_REQUIREMENT_NOT_MET', 'ENGINE_CURRENCY_MISMATCH', 'COST_INPUTS_MISSING', 'MARGIN_UNATTAINABLE', 'INVALID_STRATEGY_PARAMS']));

-- Р-96: путь решения читает и пишет живую строку
DO $do$
DECLARE
  d text := pg_get_functiondef('security.decision_path_allowed_privileges()'::regprocedure);
  a text := $s$('tenant_data.guardrail', 'SELECT', NULL),$s$;
BEGIN
  IF (length(d) - length(replace(d, a, ''))) / length(a) <> 1 THEN
    RAISE EXCEPTION '0218: security.decision_path_allowed_privileges() is not the definition the migration expects';
  END IF;
  EXECUTE replace(d, a, a || $s$ ('tenant_data.price_no_change_state', 'SELECT', NULL), ('tenant_data.price_no_change_state', 'INSERT', NULL), ('tenant_data.price_no_change_state', 'UPDATE', NULL),$s$);
END $do$;

-- Закрытие тенанта уносит живую строку РАНЬШЕ единицы записи, на которую она ссылается (правило 0102)
DO $do$
DECLARE
  d text := pg_get_functiondef('maintenance.purge_tenant_data(uuid)'::regprocedure);
  a text := $s$'tenant_data.clearance_change',$s$;
BEGIN
  IF (length(d) - length(replace(d, a, ''))) / length(a) <> 1 THEN
    RAISE EXCEPTION '0218: maintenance.purge_tenant_data(uuid) is not the definition the migration expects';
  END IF;
  EXECUTE replace(d, a, $s$'tenant_data.price_no_change_state', 'tenant_data.clearance_change',$s$);
END $do$;

COMMIT;
