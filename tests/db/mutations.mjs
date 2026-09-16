// Р-95: мутационная проверка схемы. Каждая мутация снимает одну защиту (триггер, ограничение или проверку в теле функции) в копии
// шаблона базы; ожидаемые проверки обязаны на ней упасть. Проверка, которая остаётся зелёной без своей защиты, не существует [Р-94].
//
// expect:
//   { smoke: 'метка проверки', reached? }  — смоук-тест tests/db с этой меткой провален (не случился отказ или отказ по другой причине);
//                                             reached — строка успеха для проверок DO-блоком, у которых метка есть только в тексте провала;
//   { node: 'путь/к/файлу.test.ts', test } — тест с подстрокой test в названии провален (test: null — любой тест файла);
//   { verify: 'migrations/00NN_….sql' }    — проверка схемы падает.
// Каталог шага 17 (А): строки таблицы соответствия Р-93 (migrations/README.md) и ровно те проверки, которые таблица заявляет.

const dropTrigger = (name, table) => `DROP TRIGGER ${name} ON ${table}`;
const dropConstraint = (name, table) => `ALTER TABLE ${table} DROP CONSTRAINT ${name}`;
/** Проверка в теле функции делается недостижимой: текст from заменяется на to */
const replaceInFunction = (fn, from, to) => ({ fn, from, to });

export const R93_ROWS = [
  {
    row: '12', invariant: 'Р-43, Р-44: потолок при создании и отправке записи',
    expect: [{ smoke: 'write created above lowered max_price (Р-44, check 2)' }, { smoke: 'dispatch above lowered max_price (Р-44, check 3)' },
      { node: 'packages/pricing-store-pg/test/store.pg.test.ts', test: 'refuses a price above max_price' }],
    mutations: [dropTrigger('ba_channel_write_ceiling_insert', 'tenant_data.channel_write'), dropTrigger('ba_channel_write_ceiling_dispatch', 'tenant_data.channel_write')],
  },
  {
    row: '13', invariant: 'Р-44: без округления до границы, причина отказа обязательна',
    expect: [{ smoke: 'clamp to floor instead of rejection (Р-44)' }, { smoke: 'REJECTED without a reason' }],
    mutations: [dropConstraint('price_decision_no_bound_clamp', 'channel_data.price_decision'), dropConstraint('price_decision_rejection_reason_iff', 'channel_data.price_decision')],
  },
  {
    row: '14', invariant: 'Р-43: потолок не в guardrail',
    expect: [{ smoke: 'guardrail carrying a ceiling (moved to max_price, Р-43)' }],
    mutations: [dropConstraint('guardrail_ceiling_moved_to_max_price', 'tenant_data.guardrail')],
  },
  {
    row: '16', invariant: 'Р-52: снятие остановки только с записью журнала',
    expect: [{ smoke: 'manual release without a journal record (Р-52)' }, { smoke: 'manual halt release by a member with a second factor, a note and a journal record (Р-52, Р-88)' },
      { node: 'packages/pricing-store-pg/test/audit-guards.pg.test.ts', test: 'finding 1' }],
    mutations: [dropTrigger('c_pricing_halt_release_journal', 'channel_data.pricing_halt')],
  },
  {
    row: '17', invariant: 'Р-51: признак цены по конкурентам копируется в решение',
    expect: [{ smoke: 'competitor_derived is not derived from rule_code', reached: 'competitor_derived: from intent rule_code, copied into the decision (Р-51)' }],
    mutations: [dropTrigger('aa_price_decision_copy_derivation', 'channel_data.price_decision')],
  },
  {
    row: '18', invariant: 'Р-57: валюты EUR и USD',
    expect: [{ smoke: 'currency outside EUR and USD' }],
    mutations: [dropConstraint('write_scope_supported_currency', 'tenant_data.write_scope')],
  },
  {
    row: '19', invariant: 'Р-58: налоговый режим единицы записи цены',
    expect: [{ smoke: 'USD write scope attached to a EUR gross storefront (Р-57, Р-58)' }, { smoke: 'net price basis with VAT regime (Р-58)' }, { smoke: 'price write scope without tax regime (Р-58)' }],
    mutations: [dropConstraint('write_scope_tax_regime_for_price', 'tenant_data.write_scope')],
  },
  {
    row: '20, 21', invariant: 'OQ-98: отказ хранит параметры причины',
    expect: [{ smoke: 'rejection without its reason parameters (OQ-98)' }, { node: 'packages/pricing-store-pg/test/store.pg.test.ts', test: 'OQ-93, OQ-94, OQ-98' }],
    mutations: [dropConstraint('price_decision_rejection_explained', 'channel_data.price_decision')],
  },
  {
    row: '22', invariant: 'Р-64: завершение записи — с причиной; ждущая запись объявляется событием',
    expect: [{ smoke: 'write discarded without a reason (Р-64)' }, { smoke: 'write history ended without a reason (Р-64)' },
      { node: 'packages/pricing-store-pg/test/write-queue.pg.test.ts', test: null }, { node: 'packages/pricing-store-pg/test/budget-retry-dispatch.pg.test.ts', test: null }],
    mutations: [dropConstraint('channel_write_end_explained', 'tenant_data.channel_write'), dropConstraint('channel_write_history_end_explained', 'tenant_data.channel_write_history'),
      dropTrigger('zz_channel_write_announce_dispatch', 'tenant_data.channel_write')],
  },
  {
    row: '23', invariant: 'Р-61: курс ЕЦБ неизменяем; курс — в решении с переводом себестоимости',
    expect: [{ smoke: 'ECB rate is immutable (Р-61)' }, { smoke: 'decision exchange rate without its fields (Р-61)' },
      { node: 'packages/pricing-store-pg/test/fx-day-boundary.pg.test.ts', test: 'Р-61 in the database' }],
    mutations: [dropTrigger('zz_fx_rate_immutable', 'platform.fx_rate'), dropTrigger('aa_price_decision_fx_recorded', 'channel_data.price_decision'),
      dropConstraint('price_decision_fx_shape', 'channel_data.price_decision')],
  },
  {
    row: '24, 26', invariant: 'Р-62, Р-65: граница суток — пояс витрины',
    expect: [{ node: 'packages/pricing-store-pg/test/fx-day-boundary.pg.test.ts', test: 'Р-65: a US storefront' }, { smoke: 'budgeted write while the storefront day boundary is unconfirmed (Р-65)' },
      { smoke: 'budget day is not the current storefront day (Р-65)' }, { smoke: 'US storefront confirmed without a time zone' }],
    mutations: [dropConstraint('marketplace_time_zone_known_if_confirmed', 'platform.marketplace'), dropTrigger('aa_channel_write_budget_day_tz', 'tenant_data.channel_write'),
      dropTrigger('aa_price_daily_day_tz', 'tenant_data.price_daily')],
  },
  {
    row: '25', invariant: 'Р-60: тенант в базе своего региона',
    expect: [{ smoke: 'tenant in wrong region DB (Р-60)' }],
    mutations: [dropTrigger('tenant_region_guard', 'tenant_data.tenant')],
  },
  {
    row: '27', invariant: 'Р-69, Р-70: остановки человеком и системные',
    expect: [{ node: 'packages/pricing-store-pg/test/step12.pg.test.ts', test: null }, { smoke: 'competitor-derived approval while halted (Р-51)' },
      { smoke: 'approval while the tenant is stopped by a person (Р-69)' }, { smoke: 'dispatch while the tenant is stopped by a person (Р-69)' },
      { smoke: 'dispatch of a competitor-derived write while halted (Р-51)' }, { node: 'packages/pricing-store-pg/test/audit-guards.pg.test.ts', test: null },
      { smoke: 'manual halt release without a second factor (finding 12, Р-88)' }],
    mutations: [dropConstraint('pricing_halt_system_only', 'channel_data.pricing_halt'), dropTrigger('aa_price_stop_role_guard', 'tenant_data.price_stop'),
      dropTrigger('ab_price_decision_stop_guard', 'channel_data.price_decision'), dropTrigger('bb_channel_write_stop_guard', 'tenant_data.channel_write'),
      dropTrigger('ca_pricing_halt_release_role_guard', 'channel_data.pricing_halt')],
  },
  {
    row: '28, 32, 39, 40', invariant: 'Р-68, Р-74, Р-80: слепок по классам, код причины NO_OP, столбцы intent в решении, NO_OP без ссылки на снимок',
    // Шаг 17: ограничения explanation_no_channel_data, explanation_derives_no_channel, explanation_no_column_copies снятие 0064 — их удаление
    // не меняло поведения (те же строки отклоняет explanation_keys_declared, строка 43); мутировать больше нечего
    expect: [{ smoke: 'NO_OP decision with an explanation (Р-74)' }, { smoke: 'NO_OP decision with an unknown no-change reason (Р-74)' },
      { node: 'packages/pricing-store-pg/test/step14.pg.test.ts', test: 'finding 10, Р-80' }, { node: 'packages/pricing-store-pg/test/channel-derived.pg.test.ts', test: null },
      { node: 'packages/pricing-store-pg/test/undercut-eternal.pg.test.ts', test: null }],
    mutations: [dropConstraint('price_decision_explanation_by_class', 'channel_data.price_decision'), dropConstraint('price_decision_no_change_reason_code', 'channel_data.price_decision'),
      dropTrigger('a0_price_decision_intent_columns', 'channel_data.price_decision'), dropTrigger('a_price_decision_snapshot_ref_guard', 'channel_data.price_decision_snapshot_ref')],
  },
  {
    row: '29', invariant: 'Р-71: сумма с валютой',
    expect: [{ smoke: 'rejected snapshot details: an amount without its currency (Р-71)' }, { smoke: 'rejection parameters with an amount without its currency (Р-71)' },
      { smoke: 'write ended with an amount without its currency (Р-71)' }],
    mutations: [dropConstraint('price_decision_amounts_have_currency', 'channel_data.price_decision'), dropConstraint('channel_write_end_params_currency', 'tenant_data.channel_write'),
      dropConstraint('rejected_competitor_snapshot_details_currency', 'channel_data.rejected_competitor_snapshot')],
  },
  {
    row: '30', invariant: 'Р-73: «опасное» согласовано с отклонением',
    expect: [{ smoke: 'eternal core: dangerous flag against the deviation (Р-73)' }, { node: 'packages/pricing-store-pg/test/channel-derived.pg.test.ts', test: null }],
    mutations: [dropConstraint('price_intent_core_dangerous_consistent', 'tenant_data.price_intent_core')],
  },
  {
    row: '31, 37, 38', invariant: 'OQ-125, OQ-129, находка 4: матрица прав остановок, автор — пользователь сессии',
    expect: [{ node: 'packages/pricing-store-pg/test/step14.pg.test.ts', test: 'finding 2' }, { node: 'packages/pricing-store-pg/test/step14.pg.test.ts', test: 'finding 4' },
      { node: 'packages/pricing-store-pg/test/step12.pg.test.ts', test: null }],
    mutations: [
      `CREATE OR REPLACE FUNCTION security.pricing_permission(p_role text, p_action text) RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT true $$`,
      replaceInFunction('tenant_data.price_stop_role_guard()', 'IF security.current_user_id() IS NULL OR u IS DISTINCT FROM security.current_user_id() THEN', 'IF false THEN'),
    ],
  },
  {
    row: '33', invariant: 'Р-75: справочник объяснения неизменяем',
    expect: [{ smoke: 'explanation ruleset is immutable (Р-75)' }, { node: 'packages/pricing-store-pg/test/step14.pg.test.ts', test: 'finding 2' }],
    mutations: [dropTrigger('explanation_ruleset_immutable', 'platform.explanation_ruleset')],
  },
  {
    row: '34', invariant: 'Р-76: остановки и снятия — в журнале аудита',
    expect: [{ node: 'packages/pricing-store-pg/test/step14.pg.test.ts', test: 'finding 4' }, { node: 'packages/pricing-store-pg/test/role-separation.pg.test.ts', test: null },
      { smoke: 'the manual release is not in the audit log with its author', reached: 'the audit event of the release is written by the trigger' },
      { smoke: 'the system halt is not in the audit log', reached: 'the system halt is written to the audit log by the trigger' }],
    mutations: [dropTrigger('zb_price_stop_audit', 'tenant_data.price_stop'), dropTrigger('zb_pricing_halt_audit', 'channel_data.pricing_halt'),
      dropTrigger('zb_pricing_halt_review_audit', 'channel_data.pricing_halt_review')],
  },
  {
    row: '35', invariant: 'Р-77: движок без стратегии не включается',
    expect: [{ smoke: 'ENGINE without a strategy (Р-77)' }],
    mutations: [dropConstraint('write_scope_engine_has_strategy', 'tenant_data.write_scope')],
  },
  {
    row: '41', invariant: 'Р-79: подтверждённый архив ядра — со справочниками',
    expect: [{ node: 'packages/pricing-store-pg/test/step14.pg.test.ts', test: 'Р-79' }],
    mutations: [dropConstraint('partition_export_core_archive_self_contained', 'maintenance.partition_export')],
  },
  {
    row: '42', invariant: 'Р-83: пол с полом маржи перед каждой отправкой',
    expect: [{ verify: 'migrations/0067_verify_schema_invariants_v14.sql' }, { node: 'packages/pricing-store-pg/test/write-recheck.pg.test.ts', test: null }],
    mutations: [replaceInFunction('tenant_data.channel_write_before_update()',
      "NEW.floor_at_dispatch_minor := tenant_data.assert_price_floor(NEW.tenant_id, NEW.write_scope_id, NEW.amount_minor, 'at dispatch');",
      'NEW.floor_at_dispatch_minor := (SELECT f.min_price_minor FROM tenant_data.effective_price_floor(NEW.tenant_id, NEW.write_scope_id) f);')],
  },
  {
    row: '43', invariant: 'Р-85, Р-91, находка 15: из вечного ядра не выводится значение канала',
    expect: [{ verify: 'migrations/0067_verify_schema_invariants_v14.sql' }, { smoke: 'decision explanation with an undeclared reason parameter (finding 15)' },
      { smoke: 'eternal core: a competitor-derived rejection keeps its proposed price (Р-85)' }, { smoke: 'eternal core: an undeclared reason parameter in the explanation (finding 15)' },
      { node: 'packages/pricing-store-pg/test/channel-derived.pg.test.ts', test: null }, { node: 'packages/pricing-store-pg/test/undercut-eternal.pg.test.ts', test: null }],
    mutations: [dropConstraint('price_intent_core_competitor_rejection_not_kept', 'tenant_data.price_intent_core'),
      dropConstraint('price_decision_explanation_keys_declared', 'channel_data.price_decision'),
      dropConstraint('price_intent_core_explanation_keys_declared', 'tenant_data.price_intent_core')],
  },
  {
    row: '44', invariant: 'Находки 1–3, Р-88: журнал проверок, автоматическое снятие, второй фактор',
    expect: [{ node: 'packages/pricing-store-pg/test/audit-guards.pg.test.ts', test: null }, { smoke: 'manual halt release without a second factor (finding 12, Р-88)' }],
    mutations: [dropTrigger('a_pricing_halt_review_guard', 'channel_data.pricing_halt_review'), dropTrigger('zc_pricing_halt_review_released_in_tx', 'channel_data.pricing_halt_review'),
      replaceInFunction('tenant_data.price_stop_role_guard()', "AND NOT security.session_mfa() THEN", 'AND false THEN')],
  },
  {
    row: '45', invariant: 'C2: день бюджета при повторе — текущий день витрины',
    expect: [{ smoke: 'retry after midnight is charged to today, whose budget is exhausted (C2, Р-19)' }, { smoke: 'retry while the storefront day boundary is unconfirmed (C2, Р-65)' },
      { node: 'packages/pricing-store-pg/test/dispatcher-defects.pg.test.ts', test: null }],
    mutations: [dropTrigger('ab_channel_write_budget_day_retry', 'tenant_data.channel_write')],
  },
];

/** Защиты шага 17: мутация — возврат одного права пути решения или снятие проверки; ожидается провал проверки с причиной отказа [Р-94] */
export const STEP17_ROWS = [
  {
    row: 'Р-96', invariant: 'путь решения — только вычисление и запись цены',
    expect: [
      { smoke: 'path creates an eBay migration consent (Р-96, Р-2)' }, { smoke: 'path opts the tenant into Kaufland Smart Pricing (Р-96, Р-12, Р-41)' },
      { smoke: 'path lowers min_price (Р-96, Р-5)' }, { smoke: 'path changes the unit cost (Р-96, Р-83)' },
      { smoke: 'path schedules the review of a halt (finding 2 ревью шага 16)' }, { smoke: 'path writes an automatic halt review (finding 2 ревью шага 16)' },
      { smoke: 'path forges an audit event (finding 5, Р-90)' }, { verify: 'migrations/0067_verify_schema_invariants_v14.sql' },
      { smoke: 'the decision path role is trusted with a session user or a second factor', reached: 'session user and second factor set by the decision path are ignored (Р-90)' },
    ],
    mutations: [
      'GRANT INSERT ON tenant_data.migration_consent TO repracer_app', 'GRANT UPDATE ON tenant_data.tenant TO repracer_app',
      'GRANT INSERT ON tenant_data.min_price TO repracer_app', 'GRANT INSERT ON tenant_data.cost_profile TO repracer_app',
      'GRANT UPDATE ON channel_data.pricing_halt TO repracer_app', 'GRANT INSERT ON channel_data.pricing_halt_review TO repracer_app',
      'GRANT INSERT ON audit.audit_event TO repracer_app',
      // Членство repracer_app в repracer_admin невозможно (административная роль — член пути решения): снимается право приглашать
      'GRANT EXECUTE ON FUNCTION security.invite_member(uuid, text, text, bytea, interval) TO repracer_app',
    ],
  },
  {
    row: 'находка 2', invariant: 'автоматическое снятие — итог базы по выборке, не запись пути решения',
    expect: [{ node: 'packages/pricing-store-pg/test/audit-guards.pg.test.ts', test: 'finding 3' }],
    mutations: [
      replaceInFunction('channel_data.review_halt_by_sample(uuid,uuid,timestamptz)', 'IF failed > 0 THEN', 'IF false THEN'),
      replaceInFunction('channel_data.review_halt_by_sample(uuid,uuid,timestamptz)', 'IF accepted < required THEN', 'IF false THEN'),
      replaceInFunction('channel_data.review_halt_by_sample(uuid,uuid,timestamptz)', 'IF v_at < h.next_review_at THEN', 'IF false THEN'),
    ],
  },
  {
    row: 'находка 4', invariant: 'append-only проверяется попыткой изменения',
    // Проверяются таблицы, где в смоук-мире есть строки; пустые (audit_event, pricing_halt_review, external_identity и др.) названы в выводе
    // smoke_r65.sql как непокрытые — их неизменяемость держит тот же триггер, но поведением здесь она не проверена
    expect: [{ smoke: 'append-only tenant_data.min_price' }, { smoke: 'append-only channel_data.price_decision' }, { smoke: 'append-only channel_data.price_intent' },
      { smoke: 'append-only tenant_data.pricing_strategy' }],
    mutations: [
      'ALTER TABLE tenant_data.min_price DISABLE TRIGGER zz_append_only', 'ALTER TABLE channel_data.price_decision DISABLE TRIGGER zz_append_only',
      'ALTER TABLE channel_data.price_intent DISABLE TRIGGER zz_append_only', 'ALTER TABLE tenant_data.pricing_strategy DISABLE TRIGGER zz_append_only',
      `CREATE OR REPLACE FUNCTION security.forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN coalesce(NEW, OLD); END $$`,
    ],
  },
  {
    row: 'Р-97', invariant: 'административная запись — только по действию человека и вся в аудите',
    expect: [{ smoke: 'administrative change without a person (Р-97)' }, { smoke: 'administrative change by a user outside the tenant (Р-97)' },
      { smoke: 'the administrative service records an automatic review without a person (Р-97)' },
      { verify: 'migrations/0067_verify_schema_invariants_v14.sql' }],
    mutations: [
      dropTrigger('a0_admin_write_person', 'tenant_data.product'),
      dropTrigger('zz_admin_write_audit', 'tenant_data.product'),
      dropTrigger('a0_admin_write_person', 'channel_data.pricing_halt_review'),
      replaceInFunction('security.require_person_for_admin_write()', 'IF security.admin_session() THEN', 'IF false THEN'),
      replaceInFunction('security.admin_session()', "pg_has_role(session_user, 'repracer_admin', 'MEMBER')", 'false'),
    ],
  },
  {
    row: 'находка 5', invariant: 'создание тенанта не присоединяет существующего пользователя мимо приглашения',
    expect: [{ smoke: 'existing user attached as a member without an invitation (step 16 finding 5)' },
      { smoke: 'existing user provisioned as owner under another email (step 16 finding 5)' },
      { smoke: 'existing user who never signed in provisioned as owner (step 16 finding 5)' }],
    mutations: [
      replaceInFunction('security.provision_tenant(uuid,text,text,jsonb)', "IF m ->> 'role' IS DISTINCT FROM 'OWNER' THEN", 'IF false THEN'),
      replaceInFunction('security.provision_tenant(uuid,text,text,jsonb)', "IF lower(trim(m ->> 'email')) IS DISTINCT FROM existing.email THEN", 'IF false THEN'),
      replaceInFunction('security.provision_tenant(uuid,text,text,jsonb)', 'IF NOT EXISTS (SELECT 1 FROM platform.external_identity e WHERE e.user_id = existing.user_id', 'IF false AND NOT EXISTS (SELECT 1 FROM platform.external_identity e WHERE e.user_id = existing.user_id'),
    ],
  },
  {
    row: 'Р-98', invariant: 'перепривязка входа — только приглашением владельца, прежний вход отозван',
    expect: [{ node: 'packages/identity/test/identity.pg.test.ts', test: 'Р-98' }],
    mutations: [
      replaceInFunction('security.accept_identity_invitation(bytea,text,text,text,boolean)', 'IF NOT inv.relink THEN', 'IF false THEN'),
      replaceInFunction('security.accept_identity_invitation(bytea,text,text,text,boolean)', 'IF EXISTS (SELECT 1 FROM platform.external_identity_revocation rv WHERE rv.issuer = p_issuer AND rv.subject = p_subject) THEN', 'IF false THEN'),
      replaceInFunction('security.invite_relink(uuid,uuid,bytea,interval)', 'IF NOT security.session_mfa() THEN', 'IF false THEN'),
      replaceInFunction('security.invite_relink(uuid,uuid,bytea,interval)', "AND m.status = 'ACTIVE' AND m.role = 'OWNER') THEN", "AND m.status = 'ACTIVE') THEN"),
    ],
  },
  {
    row: 'OQ-151', invariant: 'подрез закреплённой версии стратегии не начинает срок хранения',
    expect: [{ node: 'packages/pricing-store-pg/test/undercut-eternal.pg.test.ts', test: 'Р-91: the strategy version keeps its type' }],
    mutations: [
      replaceInFunction('channel_data.pricing_strategy_undercut_guard()', 'IF EXISTS (SELECT 1 FROM tenant_data.write_scope s', 'IF false AND EXISTS (SELECT 1 FROM tenant_data.write_scope s'),
      dropTrigger('b_write_scope_pins_live_strategy_version', 'tenant_data.write_scope'),
      dropTrigger('zb_write_scope_release_strategy_version', 'tenant_data.write_scope'),
    ],
  },
  {
    row: 'находка 6', invariant: 'слепок проверяется по видам и значениям параметров, а не только по именам ключей',
    expect: [{ node: 'packages/pricing-store-pg/test/undercut-eternal.pg.test.ts', test: 'finding 15' }],
    mutations: [
      replaceInFunction('security.param_value_valid(jsonb,jsonb)', 'IF spec IS NULL THEN', 'IF true THEN RETURN true; END IF; IF spec IS NULL THEN'),
      replaceInFunction('security.explanation_node_declared(jsonb,text,boolean)', "IF path = '$' AND (node -> 'format') IS DISTINCT FROM", "IF false AND (node -> 'format') IS DISTINCT FROM"),
      replaceInFunction('security.explanation_node_declared(jsonb,text,boolean)', "OR (w.value #>> '{}') !~ '^[A-Za-z][A-Za-z0-9_]{0,63}$'", ''),
    ],
  },
]


/** Строки таблицы, у которых нечего снимать: правило проверяло отсутствие объектов или свойства каталога, оставшиеся в 0061 */
export const R93_NOT_MUTATED = [
  { row: '1–11', why: 'свойства каталога остались в проверке схемы (0067)' },
  { row: '15', why: 'данные справочника НДС остались в проверке схемы (0067)' },
  { row: '36', why: 'правило проверяло отсутствие объектов входа' },
];
