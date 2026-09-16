-- 0064_explanation_constraints_consolidated.sql
-- Шаг 17, Р-94, Р-95: мутационная проверка (docs/evidence/step17-mutation-before.md) показала, что три ограничения слепка объяснения
-- на решении и на ядре intent нельзя проверить поведением: их удаление не меняет ничего, потому что те же строки отклоняет
-- explanation_keys_declared (0059, fail-closed). Защита, которую нельзя отличить от другой, — не защита, а источник ложной уверенности
-- в таблице соответствия. Остаётся одна проверка на одно свойство:
--   explanation_no_channel_data (0042, запрещённые ключи класса CHANNEL где угодно) — ключи канала не входят ни в поля формата r80.1,
--     ни в разрешённые ключи параметров ни одного кода;
--   explanation_derives_no_channel (0052, производные ключи) — производные ключи (класс CHANNEL_DERIVED) и ключи правила у цены из данных
--     конкурентов не входят в разрешённые;
--   explanation_no_column_copies (0049, копии столбцов строки) — ни один запрещённый ключ (strategy.strategyId/version/ruleCode/trigger/
--     proposedMinor, gate.profile/outcome/reason/checks/floorMinor/ceilingMinor/boundDeviationBp/currency, sanity.ruleset) не входит в
--     поля формата по своему пути.
-- Функции (security.explanation_derives_no_channel, security.strip_channel_derived, security.explanation_repeats_no_columns,
-- security.channel_param_keys) остаются: ими очищаются строки при миграциях и проверяется снимок competitor_state.sanity_summary.
-- Поведение — tests/db/smoke_app.sql «decision explanation with an undeclared reason parameter (finding 15)» с причиной отказа.

BEGIN;
SET ROLE repracer_owner;

ALTER TABLE channel_data.price_decision
  DROP CONSTRAINT price_decision_explanation_no_channel_data,
  DROP CONSTRAINT price_decision_explanation_derives_no_channel,
  DROP CONSTRAINT price_decision_explanation_no_column_copies;

ALTER TABLE tenant_data.price_intent_core
  DROP CONSTRAINT price_intent_core_explanation_no_channel_data,
  DROP CONSTRAINT price_intent_core_explanation_derives_no_channel,
  DROP CONSTRAINT price_intent_core_explanation_no_column_copies;

RESET ROLE;
COMMIT;
