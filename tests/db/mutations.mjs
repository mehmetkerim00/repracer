// Р-95: мутационная проверка схемы. Каждая мутация снимает одну защиту (триггер, ограничение, право или проверку в теле функции) в копии
// шаблона базы. Проверка, которая остаётся зелёной без своей защиты, не существует [Р-94].
//
// Р-99 (шаг 18): у КАЖДОЙ мутации — свои проверки (own). Мутация поймана, только если упала своя проверка и с совпавшей причиной;
// падение проверки соседней мутации той же строки — не поимка.
//
// Проверка:
//   { smoke: 'метка', reached? }                      — смоук-тест tests/db с этой меткой провален: pg_temp.expect_fail сам сверяет причину
//                                                        (не случился отказ или отказ по другой причине); reached — строка успеха для
//                                                        проверок DO-блоком, у которых метка есть только в тексте провала;
//   { node: 'путь/к/файлу.test.ts', test, reason }    — тест с подстрокой test в названии провален И текст провала совпал с reason
//                                                        (регулярное выражение: сообщение утверждения или ожидаемый шаблон отказа);
//   { verify: 'migrations/00NN_….sql', reason }       — проверка схемы падает с сообщением, совпавшим с reason.

const dropTrigger = (name, table) => `DROP TRIGGER ${name} ON ${table}`;
const dropConstraint = (name, table) => `ALTER TABLE ${table} DROP CONSTRAINT ${name}`;
/** Проверка в теле функции делается недостижимой: текст from заменяется на to */
const replaceInFunction = (fn, from, to) => ({ fn, from, to });
/** Мутация и её собственные проверки */
const m = (apply, ...own) => ({ apply, own });

const VERIFY = 'migrations/0114_verify_schema_invariants_v29.sql';
const T = (file) => `packages/pricing-store-pg/test/${file}`;
const smoke = (label, reached) => (reached ? { smoke: label, reached } : { smoke: label });
// Шаг 19, ревью шага 19 (находка 1): у проверки теста — точная метка утверждения (строка или { re } для метки с подстановкой; группа
// выражения — фактический результат) и результат «без защиты»: 'resolved' — отказа не было вовсе, иначе — выражение над фактическим
// результатом. Отказ по другой причине своей поимкой не считается
const node = (file, test, label, unprotected) => ({ node: file, test, label, unprotected });
const verify = (reason) => ({ verify: VERIFY, reason });

// Шаг 30, задача E [OQ-203]: `critical: true` — строки, которые идут в БЫСТРОМ прогоне CI. Мутационная проверка целиком занимает
// около получаса и потому живёт в полном прогоне; но быстрый не должен пропускать регрессию в защитах, которыми держится цена.
// Критичными объявлены четыре области: обе границы и пол маржи (Price Gate), проверка входов, диспетчер записей и роли подключения
// вместе со вторым фактором массового изменения. Всё остальное ловится полным прогоном при слиянии в main.
export const R93_ROWS = [
  {
    row: '12', critical: true, invariant: 'Р-43, Р-44: потолок при создании и отправке записи',
    mutations: [
      m(dropTrigger('ba_channel_write_ceiling_insert', 'tenant_data.channel_write'), smoke('write created above lowered max_price (Р-44, check 2)')),
      m(dropTrigger('ba_channel_write_ceiling_dispatch', 'tenant_data.channel_write'), smoke('dispatch above lowered max_price (Р-44, check 3)')),
    ],
  },
  {
    row: '13', critical: true, invariant: 'Р-44: без округления до границы, причина отказа обязательна',
    mutations: [
      m(dropConstraint('price_decision_no_bound_clamp', 'channel_data.price_decision'), smoke('clamp to floor instead of rejection (Р-44)')),
      m(dropConstraint('price_decision_rejection_reason_iff', 'channel_data.price_decision'), smoke('REJECTED without a reason')),
    ],
  },
  {
    row: '14', critical: true, invariant: 'Р-43: потолок не в guardrail',
    mutations: [m(dropConstraint('guardrail_ceiling_moved_to_max_price', 'tenant_data.guardrail'), smoke('guardrail carrying a ceiling (moved to max_price, Р-43)'))],
  },
  {
    row: '16', invariant: 'Р-52: снятие остановки только с записью журнала',
    mutations: [m(dropTrigger('c_pricing_halt_release_journal', 'channel_data.pricing_halt'), smoke('manual release without a journal record (Р-52)'))],
  },
  {
    row: '17', critical: true, invariant: 'Р-51: признак цены по конкурентам копируется в решение',
    mutations: [m(dropTrigger('aa_price_decision_copy_derivation', 'channel_data.price_decision'),
      smoke('competitor_derived is not derived from rule_code', 'competitor_derived: from intent rule_code, copied into the decision (Р-51)'))],
  },
  {
    row: '18', invariant: 'Р-57: валюты EUR и USD',
    mutations: [m(dropConstraint('write_scope_supported_currency', 'tenant_data.write_scope'), smoke('currency outside EUR and USD'))],
  },
  {
    row: '19', invariant: 'Р-58: налоговый режим единицы записи цены',
    mutations: [m(dropConstraint('write_scope_tax_regime_for_price', 'tenant_data.write_scope'),
      smoke('net price basis with VAT regime (Р-58)'), smoke('price write scope without tax regime (Р-58)'))],
  },
  {
    row: '20, 21', invariant: 'OQ-98: отказ хранит параметры причины',
    mutations: [m(dropConstraint('price_decision_rejection_explained', 'channel_data.price_decision'), smoke('rejection without its reason parameters (OQ-98)'),
      node(T('store.pg.test.ts'), 'OQ-93, OQ-94, OQ-98', 'OQ-98: a rejection without its reason parameters is refused', 'resolved'))],
  },
  {
    row: '22', critical: true, invariant: 'Р-64: завершение записи — с причиной; ждущая запись объявляется событием',
    mutations: [
      // Шаг 19 [Р-104]: channel_write_end_explained удалено (0072) — его отказ давало ограничение истории записей
      m(dropConstraint('channel_write_history_end_explained', 'tenant_data.channel_write_history'),
        smoke('write discarded without a reason (Р-64)'), smoke('write history ended without a reason (Р-64)')),
      m(dropTrigger('zz_channel_write_announce_dispatch', 'tenant_data.channel_write'),
        node(T('write-queue.pg.test.ts'), 'control — without the dispatcher', 'a PENDING write has no scope.write.v1 event: nobody would ever learn about it', '^[1-9][0-9]*$')),
    ],
  },
  {
    row: '23', invariant: 'Р-61: курс ЕЦБ неизменяем; курс — в решении с переводом себестоимости',
    mutations: [
      m(dropTrigger('zz_fx_rate_immutable', 'platform.fx_rate'), smoke('ECB rate is immutable (Р-61)')),
      m(dropTrigger('aa_price_decision_fx_recorded', 'channel_data.price_decision'),
        node(T('fx-day-boundary.pg.test.ts'), 'Р-61 in the database', 'Р-61: a decision on a converted cost without its exchange rate is refused', 'resolved')),
      m(dropConstraint('price_decision_fx_shape', 'channel_data.price_decision'), smoke('decision exchange rate without its fields (Р-61)')),
    ],
  },
  {
    row: '24, 26', invariant: 'Р-62, Р-65: граница суток — пояс витрины',
    mutations: [
      m(dropConstraint('marketplace_time_zone_known_if_confirmed', 'platform.marketplace'), smoke('US storefront confirmed without a time zone')),
      m(dropTrigger('aa_channel_write_budget_day_tz', 'tenant_data.channel_write'),
        smoke('budgeted write while the storefront day boundary is unconfirmed (Р-65)'), smoke('budget day is not the current storefront day (Р-65)')),
      m(dropTrigger('aa_price_daily_day_tz', 'tenant_data.price_daily'),
        node(T('fx-day-boundary.pg.test.ts'), 'Р-65: a US storefront', ['Р-65: a price day of a US storefront is not closed in Europe/Berlin', 'Р-65: a price day of a US storefront is not closed in America/Los_Angeles'], 'resolved')),
    ],
  },
  {
    row: '25', invariant: 'Р-60: тенант в базе своего региона',
    mutations: [m(dropTrigger('tenant_region_guard', 'tenant_data.tenant'), smoke('tenant in wrong region DB (Р-60)'))],
  },
  {
    row: '27', invariant: 'Р-69, Р-70: остановки человеком и системные',
    mutations: [
      m(dropConstraint('pricing_halt_system_only', 'channel_data.pricing_halt'),
        node(T('step12.pg.test.ts'), 'Р-69: a system halt is only for broken channel data', 'Р-69: a person cannot create a system halt', 'resolved')),
      m(dropTrigger('aa_price_stop_role_guard', 'tenant_data.price_stop'),
        node(T('step12.pg.test.ts'), 'Р-69, Р-70, OQ-125 in the database', ['OQ-129: a viewer does not stop pricing', 'OQ-125: an operator does not resume a tenant stop'], '^(STOPPED|RELEASED)$')),
      m(dropTrigger('ab_price_decision_stop_guard', 'channel_data.price_decision'), smoke('approval while the tenant is stopped by a person (Р-69)')),
      m(dropTrigger('bb_channel_write_stop_guard', 'tenant_data.channel_write'), smoke('dispatch while the tenant is stopped by a person (Р-69)')),
      m(dropTrigger('ca_pricing_halt_release_role_guard', 'channel_data.pricing_halt'), smoke('manual halt release without a second factor (finding 12, Р-88)')),
    ],
  },
  {
    row: '28, 32, 39, 40', invariant: 'Р-68, Р-74, Р-80: слепок по классам, код причины NO_OP, столбцы intent в решении, NO_OP без ссылки на снимок',
    mutations: [
      m(dropConstraint('price_decision_explanation_by_class', 'channel_data.price_decision'), smoke('NO_OP decision with an explanation (Р-74)')),
      m(dropConstraint('price_decision_no_change_reason_code', 'channel_data.price_decision'), smoke('NO_OP decision with an unknown no-change reason (Р-74)')),
      m(dropTrigger('a0_price_decision_intent_columns', 'channel_data.price_decision'),
        smoke('decision intent columns are taken from the client, not from the intent (Р-80)', 'decision intent columns come from the intent, not from the client (Р-80)')),
      m(dropTrigger('a_price_decision_snapshot_ref_guard', 'channel_data.price_decision_snapshot_ref'),
        node(T('step14.pg.test.ts'), 'finding 10, Р-80', 'finding 10: a snapshot reference of a NO_OP decision is refused', '"command":"INSERT"')),
    ],
  },
  {
    row: '29', invariant: 'Р-71: сумма с валютой',
    mutations: [
      m(dropConstraint('price_decision_amounts_have_currency', 'channel_data.price_decision'), smoke('rejection parameters with an amount without its currency (Р-71)')),
      m(dropConstraint('channel_write_end_params_currency', 'tenant_data.channel_write'), smoke('write ended with an amount without its currency (Р-71)')),
      m(dropConstraint('rejected_competitor_snapshot_details_currency', 'channel_data.rejected_competitor_snapshot'),
        smoke('rejected snapshot details: an amount without its currency (Р-71)')),
    ],
  },
  {
    row: '30', invariant: 'Р-73: «опасное» согласовано с отклонением',
    mutations: [m(dropConstraint('price_intent_core_dangerous_consistent', 'tenant_data.price_intent_core'), smoke('eternal core: dangerous flag against the deviation (Р-73)'))],
  },
  {
    row: '31, 37, 38', invariant: 'OQ-125, OQ-129, находка 4: матрица прав остановок, автор — пользователь сессии',
    mutations: [
      m(`CREATE OR REPLACE FUNCTION security.pricing_permission(p_role text, p_action text) RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT true $$`,
        node(T('step14.pg.test.ts'), 'finding 2', { re: '[A-Z_]+ × [A-Z_]+' }, '^true$')),
      m(replaceInFunction('tenant_data.price_stop_role_guard()', 'IF security.current_user_id() IS NULL OR u IS DISTINCT FROM security.current_user_id() THEN', 'IF false THEN'),
        node(T('step14.pg.test.ts'), 'finding 4', 'finding 4: a stop is not written in the name of another membership', '^STOPPED$')),
    ],
  },
  {
    row: '33', invariant: 'Р-75: справочник объяснения неизменяем',
    mutations: [m(dropTrigger('explanation_ruleset_immutable', 'platform.explanation_ruleset'), smoke('explanation ruleset is immutable (Р-75)'))],
  },
  {
    row: '34', invariant: 'Р-76: остановки и снятия — в журнале аудита',
    mutations: [
      m(dropTrigger('zb_price_stop_audit', 'tenant_data.price_stop'),
        node(T('role-separation.pg.test.ts'), 'the audit log is still written', 'Р-76: the stop is written to the audit log by the trigger with the session user as author', '\\+ \\[\\]')),
      m(dropTrigger('zb_pricing_halt_audit', 'channel_data.pricing_halt'),
        smoke('the system halt is not in the audit log', 'the system halt is written to the audit log by the trigger (Р-76)')),
      m(dropTrigger('zb_pricing_halt_review_audit', 'channel_data.pricing_halt_review'),
        smoke('the manual release is not in the audit log with its author', 'the audit event of the release is written by the trigger with the session user as author (Р-76)')),
    ],
  },
  {
    row: '35', invariant: 'Р-77: движок без стратегии не включается',
    mutations: [m(dropConstraint('write_scope_engine_has_strategy', 'tenant_data.write_scope'), smoke('ENGINE without a strategy (Р-77)'))],
  },
  {
    row: '41', invariant: 'Р-79: подтверждённый архив ядра — со справочниками',
    mutations: [m(dropConstraint('partition_export_core_archive_self_contained', 'maintenance.partition_export'),
      node(T('step14.pg.test.ts'), 'Р-79', 'Р-79: a verified archive of the core without the explanation dictionary is refused', '"command":"INSERT"'))],
  },
  {
    row: '42', critical: true, invariant: 'Р-83: пол с полом маржи перед каждой отправкой',
    mutations: [m(replaceInFunction('tenant_data.channel_write_before_update()',
      "NEW.floor_at_dispatch_minor := tenant_data.assert_price_floor(NEW.tenant_id, NEW.write_scope_id, NEW.amount_minor, 'at dispatch');",
      'NEW.floor_at_dispatch_minor := (SELECT f.min_price_minor FROM tenant_data.effective_price_floor(NEW.tenant_id, NEW.write_scope_id) f);'),
    verify('below the recomputed margin floor was dispatched'),
    node(T('write-recheck.pg.test.ts'), 'the unit cost rose between decision and dispatch', { re: 'cost: the write reached the channel: .*' }, '^false$'))],
  },
  {
    row: '43', invariant: 'Р-85, Р-91, находка 15: из вечного ядра не выводится значение канала',
    mutations: [
      m(dropConstraint('price_intent_core_competitor_rejection_not_kept', 'tenant_data.price_intent_core'),
        smoke('eternal core: a competitor-derived rejection keeps its proposed price (Р-85)')),
      // Шаг 19 [Р-104]: price_decision_explanation_keys_declared удалено (0072) — тот же слепок в той же вставке проверяет ядро
      m(dropConstraint('price_intent_core_explanation_keys_declared', 'tenant_data.price_intent_core'),
        smoke('eternal core: an undeclared reason parameter in the explanation (finding 15)'), smoke('decision explanation with an undeclared reason parameter (finding 15)'),
        verify('undeclared reason parameter was stored')),
    ],
  },
  {
    row: '44', invariant: 'Находки 1–3, Р-88: журнал проверок, автоматическое снятие, второй фактор',
    mutations: [
      m(dropTrigger('a_pricing_halt_review_guard', 'channel_data.pricing_halt_review'), smoke('automatic review recorded in a user session (finding 3)')),
      m(dropTrigger('zc_pricing_halt_review_released_in_tx', 'channel_data.pricing_halt_review'),
        node(T('audit-guards.pg.test.ts'), 'finding 1', 'a release record without the release fails at commit', '^accepted$')),
      m(replaceInFunction('tenant_data.price_stop_role_guard()', 'AND NOT security.session_mfa() THEN', 'AND false THEN'),
        node(T('audit-guards.pg.test.ts'), 'Р-88: releasing the tenant stop needs a second factor', 'Р-88: the tenant stop is not released without a second factor', '^RELEASED$')),
    ],
  },
  {
    row: '45', invariant: 'C2: день бюджета при повторе — текущий день витрины',
    mutations: [m(dropTrigger('ab_channel_write_budget_day_retry', 'tenant_data.channel_write'),
      smoke('retry after midnight is charged to today, whose budget is exhausted (C2, Р-19)'), smoke('retry while the storefront day boundary is unconfirmed (C2, Р-65)'))],
  },
];

const AG = T('audit-guards.pg.test.ts');
const UE = T('undercut-eternal.pg.test.ts');
const ID = 'packages/identity/test/identity.pg.test.ts';
const pathRight = (table, privilege) => verify(`${table.replace('.', '\\.')}: ${privilege} of the decision path does not match the allow list`);

/** Защиты шага 17 и строки, пропущенные в каталоге шага 17 (находка 7 ревью шага 17) */
export const STEP17_ROWS = [
  {
    row: 'Р-96', critical: true, invariant: 'путь решения — только вычисление и запись цены',
    mutations: [
      m('GRANT INSERT ON tenant_data.migration_consent TO repracer_app', smoke('path creates an eBay migration consent (Р-96, Р-2)'), pathRight('tenant_data.migration_consent', 'INSERT')),
      m('GRANT UPDATE ON tenant_data.tenant TO repracer_app', smoke('path opts the tenant into Kaufland Smart Pricing (Р-96, Р-12, Р-41)'), pathRight('tenant_data.tenant', 'UPDATE')),
      m('GRANT INSERT ON tenant_data.min_price TO repracer_app', smoke('path lowers min_price (Р-96, Р-5)'), pathRight('tenant_data.min_price', 'INSERT')),
      m('GRANT INSERT ON tenant_data.cost_profile TO repracer_app', smoke('path changes the unit cost (Р-96, Р-83)'), pathRight('tenant_data.cost_profile', 'INSERT')),
      m('GRANT UPDATE ON channel_data.pricing_halt TO repracer_app', smoke('path schedules the review of a halt (finding 2 ревью шага 16)'), pathRight('channel_data.pricing_halt', 'UPDATE')),
      m('GRANT INSERT ON channel_data.pricing_halt_review TO repracer_app', smoke('path writes an automatic halt review (finding 2 ревью шага 16)'),
        pathRight('channel_data.pricing_halt_review', 'INSERT')),
      m('GRANT INSERT ON audit.audit_event TO repracer_app', smoke('path forges an audit event (finding 5, Р-90)'), pathRight('audit.audit_event', 'INSERT')),
      m('GRANT EXECUTE ON FUNCTION security.invite_member(uuid, text, text, bytea, interval) TO repracer_app', smoke('path invites a member (Р-90)'),
        verify('security\\.invite_member.*SECURITY DEFINER function executable by the decision path')),
      m(`CREATE OR REPLACE FUNCTION tenant_data.lock_decision_products(p_tenant_id uuid, p_write_scope_ids uuid[]) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ BEGIN NULL; END $$`,
        node(T('store.pg.test.ts'), 'Р-54: a concurrent bound change serialises', 'decision commit must wait for the bound change', '^true$')),
    ],
  },
  {
    row: 'находка 2', invariant: 'автоматическое снятие — итог базы по выборке, не запись пути решения',
    mutations: [
      m(replaceInFunction('channel_data.review_halt_by_sample(uuid,uuid,timestamptz)', 'IF failed > 0 THEN', 'IF false THEN'), node(AG, 'finding 3', 'SAMPLE_FAILED: one failed observation fails the review', '^RELEASED$')),
      m(replaceInFunction('channel_data.review_halt_by_sample(uuid,uuid,timestamptz)', 'IF accepted < required THEN', 'IF false THEN'), node(AG, 'finding 3', 'NO_SAMPLE: fewer accepted products than the sample requires', '^RELEASED$')),
      // Шаг 19 [Р-104]: ветка NOT_DUE — код ответа, не защита: до срока наблюдение, записанное базой после срока, существовать не может,
      // и без ветки ответ — NO_SAMPLE. Окно держит фильтр по моменту записи — он и снимается
      m(replaceInFunction('channel_data.review_halt_by_sample(uuid,uuid,timestamptz)', 'sm.recorded_at >= h.next_review_at AND ', ''),
        node(AG, 'finding 3', 'NO_SAMPLE: an observation recorded before the review window elapsed does not count', '^RELEASED$')),
      m(replaceInFunction('channel_data.review_halt_by_sample(uuid,uuid,timestamptz)', 'v_at      timestamptz := least(p_at, now());', 'v_at      timestamptz := p_at;'),
        node(AG, 'finding 3', 'finding 3: the next review is scheduled from the database clock, not from a moment in the future', '^false$')),
      m(replaceInFunction('channel_data.review_halt_by_sample(uuid,uuid,timestamptz)', 'AND sm.observed_at <= v_at;', ';'), node(AG, 'finding 3', 'NO_SAMPLE: an observation after the review moment does not count', '^RELEASED$')),
      m(replaceInFunction('channel_data.review_halt_by_sample(uuid,uuid,timestamptz)', 'AND om.channel_product_ref = sm.channel_product_ref))', '))'),
        node(AG, 'finding 3', 'NO_SAMPLE: a stale observation and a product outside the storefront do not count', '^RELEASED$')),
      m(replaceInFunction('channel_data.review_halt_by_sample(uuid,uuid,timestamptz)', 'IF p_tenant_id IS DISTINCT FROM security.current_tenant_id() THEN', 'IF false THEN'),
        node(AG, 'finding 3', 'the review of a halt runs only in the context of its own tenant', '^accepted$')),
    ],
  },
  {
    row: 'находка 4', invariant: 'неизменяемость проверяется попыткой изменения',
    mutations: [
      m('ALTER TABLE tenant_data.min_price DISABLE TRIGGER zz_append_only', smoke('append-only tenant_data.min_price')),
      m('ALTER TABLE channel_data.price_decision DISABLE TRIGGER zz_append_only', smoke('append-only channel_data.price_decision')),
      m('ALTER TABLE channel_data.price_intent DISABLE TRIGGER zz_append_only', smoke('append-only channel_data.price_intent')),
      m('ALTER TABLE tenant_data.pricing_strategy DISABLE TRIGGER zz_append_only', smoke('append-only tenant_data.pricing_strategy')),
      m(`CREATE OR REPLACE FUNCTION security.forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN coalesce(NEW, OLD); END $$`,
        smoke('append-only tenant_data.min_price'), verify('forbid_mutation does not refuse an UPDATE')),
    ],
  },
  {
    row: 'Р-97', critical: true, invariant: 'административная запись — только по действию человека и вся в аудите',
    mutations: [
      m(dropTrigger('a0_admin_write_person_insert', 'tenant_data.product'), smoke('administrative change without a person (Р-97)'),
        verify('tenant_data\\.product: administrative INSERT without the person guard')),
      m(dropTrigger('zz_admin_write_audit_insert', 'tenant_data.product'),
        smoke('an administrative change is not in the audit log (Р-97)', 'administrative change by a person is written to the audit log (Р-97)'),
        verify('tenant_data\\.product: administrative INSERT is not written to the audit log')),
      m(dropTrigger('a0_admin_write_person_insert', 'channel_data.pricing_halt_review'), smoke('the administrative service records an automatic review without a person (Р-97)')),
      // Шаг 19 [Р-104]: проверка участника в страже удалена как дубль (0072) — постороннего отклоняет журнал аудита: событие USER без членства
      m(dropConstraint('audit_event_check1', 'audit.audit_event'),
        smoke('administrative change by a user outside the tenant (Р-97)'), smoke('administrative change in the platform tenant (step 17 finding 9)')),
      m(replaceInFunction('security.audit_admin_write()', 'IF NOT security.admin_session() THEN', 'IF true THEN'),
        smoke('an administrative change is not in the audit log (Р-97)', 'administrative change by a person is written to the audit log (Р-97)')),
      m(replaceInFunction('security.admin_session()', "pg_has_role(session_user, 'repracer_admin', 'MEMBER')", 'false'), smoke('administrative change without a person (Р-97)')),
    ],
  },
  {
    row: 'находка 5', invariant: 'создание тенанта не присоединяет существующего пользователя мимо приглашения',
    mutations: [
      // Шаг 19 [Р-104]: роль и адрес проверяются у уже входившего пользователя (smoke_setup.sql) — отказ «никогда не входил» их не маскирует
      m(replaceInFunction('security.provision_tenant(uuid,text,text,jsonb)', "IF m ->> 'role' IS DISTINCT FROM 'OWNER' THEN", 'IF false THEN'),
        smoke('existing user attached as a member without an invitation (step 16 finding 5)')),
      m(replaceInFunction('security.provision_tenant(uuid,text,text,jsonb)', "IF lower(trim(m ->> 'email')) IS DISTINCT FROM existing.email THEN", 'IF false THEN'),
        smoke('existing user provisioned as owner under another email (step 16 finding 5)')),
      m(replaceInFunction('security.provision_tenant(uuid,text,text,jsonb)', 'IF NOT EXISTS (SELECT 1 FROM platform.external_identity e WHERE e.user_id = existing.user_id',
        'IF false AND NOT EXISTS (SELECT 1 FROM platform.external_identity e WHERE e.user_id = existing.user_id'),
        smoke('existing user who never signed in provisioned as owner (step 16 finding 5)')),
    ],
  },
  {
    row: 'Р-98', invariant: 'перепривязка входа — только приглашением владельца, прежний вход отозван',
    mutations: [
      m(replaceInFunction('security.accept_identity_invitation(bytea,text,text,text,boolean)', 'IF NOT inv.relink THEN', 'IF false THEN'),
        node(ID, 'Р-98', 'an ordinary invitation does not relink', 'resolved')),
      m(replaceInFunction('security.accept_identity_invitation(bytea,text,text,text,boolean)',
        'IF EXISTS (SELECT 1 FROM platform.external_identity_revocation rv WHERE rv.issuer = p_issuer AND rv.subject = p_subject) THEN', 'IF false THEN'),
        node(ID, 'Р-98', 'the revoked sign-in accepts nothing', 'resolved')),
      m(replaceInFunction('security.invite_relink(uuid,uuid,bytea,interval)', 'IF NOT security.session_mfa() THEN', 'IF false THEN'), node(ID, 'Р-98', 'Р-98: a relink invitation without a second factor', 'resolved')),
      m(replaceInFunction('security.invite_relink(uuid,uuid,bytea,interval)', "AND m.status = 'ACTIVE' AND m.role = 'OWNER') THEN", "AND m.status = 'ACTIVE') THEN"),
        node(ID, 'Р-98', 'Р-98: only an active owner relinks', 'resolved')),
      m(replaceInFunction('security.invite_relink(uuid,uuid,bytea,interval)',
        "IF NOT EXISTS (SELECT 1 FROM tenant_data.membership m WHERE m.tenant_id = p_tenant_id AND m.user_id = p_user_id AND m.status = 'ACTIVE') THEN", 'IF false THEN'),
        node(ID, 'Р-98', 'Р-98: a relink is issued only to a member of the tenant', 'resolved')),
      m(dropTrigger('a_external_identity_one_active', 'platform.external_identity'), node(ID, 'step 17 finding 3', ['Р-98: the second acceptance waits for the first', { re: 'Р-98: two active sign-ins of one provider for one user: ([0-9a-f-]{36})' }], '^(true|[0-9a-f-]{36})$')),
      m(replaceInFunction('platform.external_identity_one_active()', "PERFORM pg_advisory_xact_lock(hashtextextended('platform.external_identity:' || NEW.user_id::text || ':' || NEW.issuer, 0));", ''),
        node(ID, 'step 17 finding 3', 'Р-98: the second acceptance waits for the first', '^true$')),
      m(replaceInFunction('security.resolve_external_identity(text,text)',
        'AND NOT EXISTS (SELECT 1 FROM platform.external_identity_revocation rv WHERE rv.issuer = e.issuer AND rv.subject = e.subject)', ''),
        node(ID, 'Р-98', 'the revoked sign-in resolves nobody', 'userId')),
      m(dropTrigger('zz_identity_relinked_audit', 'platform.identity_invitation'), node(ID, 'Р-98', 'Р-98: the invitation and the relink are audited', '^(?!.*identity\\.relinked\\b)')),
      m(dropTrigger('zz_identity_relink_invited_audit', 'platform.identity_invitation'), node(ID, 'Р-98', 'Р-98: the invitation and the relink are audited', '^(?!.*identity\\.relink_invited)')),
    ],
  },
  {
    row: 'OQ-151', invariant: 'подрез закреплённой версии стратегии не начинает срок хранения',
    mutations: [
      m(replaceInFunction('channel_data.pricing_strategy_undercut_guard()', 'IF EXISTS (SELECT 1 FROM tenant_data.write_scope s', 'IF false AND EXISTS (SELECT 1 FROM tenant_data.write_scope s'),
        node(UE, 'Р-91: the strategy version keeps its type', 'OQ-151: the undercut of a pinned version does not start expiring', '^accepted$')),
      m(dropTrigger('b_write_scope_pins_live_strategy_version', 'tenant_data.write_scope'),
        node(UE, 'Р-91: the strategy version keeps its type', 'OQ-151: a scope is not pinned back to a version whose undercut expires', '^accepted$')),
      m(dropTrigger('zb_write_scope_release_strategy_version', 'tenant_data.write_scope'),
        node(UE, 'Р-91: the strategy version keeps its type', 'the released version starts its 18 months', '0: version: 1 superseded: false')),
      m(replaceInFunction('tenant_data.pricing_strategy_supersede_undercut()', "AND s.status <> 'RETIRED')", 'AND false)'),
        node(UE, 'Р-91: the strategy version keeps its type', 'OQ-151: a new version is created while the old one is still pinned', 'still pinned by a write scope')),
    ],
  },
  {
    row: 'находка 6', invariant: 'слепок проверяется по видам и значениям параметров, а не только по именам ключей',
    mutations: [
      m(replaceInFunction('security.param_value_valid(jsonb,jsonb)', "RETURN t = 'number' AND v::text ~ '^-?[0-9]+$';", "RETURN t = 'number';"),
        node(UE, 'finding 15', 'an amount that is not minor units', '^true$')),
      m(replaceInFunction('security.param_value_valid(jsonb,jsonb)', "RETURN t = 'string' AND s IN ('EUR', 'USD');", "RETURN t = 'string';"),
        node(UE, 'finding 15', ['a currency that is not an ISO code', 'a currency outside EUR and USD'], '^true$')),
      m(replaceInFunction('security.param_value_valid(jsonb,jsonb)', "RETURN t = 'string' AND (NOT spec ? 'v' OR (spec -> 'v') ? s);", "RETURN t = 'string';"),
        node(UE, 'finding 15', 'an enum value outside the registry', '^true$')),
      m(replaceInFunction('security.param_value_valid(jsonb,jsonb)', "RETURN t = 'number' AND v::text ~ '^-?[0-9]+$';", "RETURN t IN ('number', 'string') AND v::text ~ '^\"?-?[0-9]+\"?$';"),
        node(UE, 'finding 15', 'an amount as a string', '^true$')),
      // Формат r80.1 держит вид поля $.format (0070); отдельная проверка формата в теле функции удалена как дубль
      m(replaceInFunction('security.explanation_field_kinds()', '"$.format":{"k":"enum","v":["r80.1"]}', '"$.format":{"k":"code"}'),
        node(UE, 'finding 15', 'finding 6: an explanation format shaped as a code other than r80.1 is refused', '^true$')),
      m(replaceInFunction('security.explanation_node_declared(jsonb,text,boolean)', "OR (w.value #>> '{}') !~ '^[A-Za-z][A-Za-z0-9_]{0,63}$'", ''),
        node(UE, 'finding 15', 'a withheld name that is not an identifier', '^true$')),
    ],
  },
];

const SA = 'packages/pricing-store-pg/test/audit-guards.pg.test.ts';
/** Защиты шага 18 */
export const STEP18_ROWS = [
  {
    row: 'Р-101', invariant: 'согласие на миграцию eBay — только владелец, от своего имени, со вторым фактором',
    mutations: [
      m(replaceInFunction('tenant_data.migration_consent_guard()', 'AND (security.current_user_id() IS NULL OR NEW.user_id IS DISTINCT FROM security.current_user_id()) THEN', 'AND false THEN'),
        smoke('eBay consent in the name of another owner (Р-101)')),
      // Шаг 19 [Р-104]: проверка владельца удалена из стража согласия (0072) — роль проверяет общий страж (строка Р-100)
      m(replaceInFunction('tenant_data.migration_consent_guard()', 'AND NOT security.session_mfa() THEN', 'AND false THEN'), smoke('eBay consent by the owner without a second factor (Р-101)')),
    ],
  },
  {
    row: 'Р-100', critical: true, invariant: 'административная запись проверяет роль и административные столбцы',
    mutations: [
      m(replaceInFunction('security.require_person_for_admin_write()', "IF action <> 'OWN_GUARD' AND r IS NOT NULL AND NOT security.pricing_permission(r, action) THEN", 'IF false THEN'),
        smoke('an operator lowers min_price (Р-100)'), smoke('eBay consent by an admin in their own name (Р-101)'), smoke('write scope status changed by a viewer (step 18 finding 1)'),
        smoke('consent revoked by an admin (Р-101)')),
      m(dropTrigger('a0_admin_write_person_update', 'tenant_data.write_scope'), smoke('pricing mode changed without a person (step 17 finding 1)'),
        verify('tenant_data\\.write_scope: administrative UPDATE without the person guard')),
      m(replaceInFunction('security.admin_write_action(text)', "('tenant_data.min_price', 'MANAGE_PRICING'), ", ''),
        verify('tenant_data\\.min_price: no administrative action is declared')),
      // Шаг 19: отдельная проверка платформенного тенанта удалена (0072) — у него нет участников, отказывает проверка членства (строка Р-97)
    ],
  },
  {
    row: 'находка 4 (шаг 17)', invariant: 'путь решения не пишет действия человека в свои таблицы',
    mutations: [
      m('GRANT INSERT ON channel_data.pricing_halt TO repracer_app', smoke('path inserts a halt released by a person (step 17 finding 4)'), pathRight('channel_data.pricing_halt', 'INSERT')),
      m('GRANT UPDATE ON channel_data.divergence_case TO repracer_app', smoke('path resolves a divergence case for a person (step 17 finding 4)'),
        pathRight('channel_data.divergence_case', 'UPDATE')),
      m(dropTrigger('a1_write_scope_path_status_guard', 'tenant_data.write_scope'), smoke('path unblocks a write scope (step 17 finding 4)'), smoke('path holds a write scope (step 17 finding 4)')),
    ],
  },
  {
    row: 'находка 5 (шаг 17)', invariant: 'срок проверки остановки переносится со вторым фактором и в аудите',
    mutations: [
      m(dropTrigger('a1_pricing_halt_review_schedule_guard', 'channel_data.pricing_halt'), smoke('the review of a halt moved without a second factor (step 17 finding 5)')),
      m(dropTrigger('zz_admin_write_audit_update', 'channel_data.pricing_halt'),
        smoke('the moved review of a halt is not in the audit log (step 17 finding 5)', 'a moved review of a halt is written to the audit log (step 17 finding 5)'),
        verify('channel_data\\.pricing_halt: administrative UPDATE is not written to the audit log')),
    ],
  },
  {
    row: 'находка 8 (шаг 17)', invariant: 'виды значений у каждого скалярного поля слепка',
    mutations: [
      m(replaceInFunction('security.explanation_node_declared(jsonb,text,boolean)', "ELSIF NOT security.param_value_valid(v, fields -> (path || '.' || k)) THEN", 'ELSIF false THEN'),
        node(UE, 'finding 15', 'a free text in strategy.currentMinor', '^true$')),
      m(replaceInFunction('security.param_value_valid(jsonb,jsonb)', "RETURN t = 'string' AND s IN ('EUR', 'USD');", "RETURN t = 'string' AND s ~ '^[A-Z]{3}$';"),
        node(UE, 'finding 15', 'a currency outside EUR and USD', '^true$')),
      m(replaceInFunction('security.param_value_valid(jsonb,jsonb)', 'PERFORM s::timestamptz;', 'NULL;'), node(UE, 'finding 15', 'an invalid moment in the price stop context', '^true$')),
      m(replaceInFunction('security.param_value_valid(jsonb,jsonb)', 'BETWEEN 0 AND 1000;', 'IS NOT NULL;'), node(UE, 'finding 15', 'a ratio outside its range', '^true$')),
      m(replaceInFunction('security.param_value_valid(jsonb,jsonb)', "RETURN t = 'number' AND v::text ~ '^[0-9]+$';", "RETURN t = 'number';"), node(UE, 'finding 15', 'a negative count', '^true$')),
      m(replaceInFunction('security.param_value_valid(jsonb,jsonb)', "RETURN t = 'string' AND s ~ '^[A-Za-z0-9_.:@-]{1,128}$';", "RETURN t = 'string';"),
        node(UE, 'finding 15', 'a free text as an id', '^true$')),
    ],
  },
  {
    row: 'Р-102', critical: true, invariant: 'роль остатков — только остатки и резервации',
    mutations: [
      m('GRANT SELECT ON tenant_data.min_price TO repracer_stock', smoke('stock role reads prices (Р-102)'), verify('tenant_data\\.min_price: SELECT of the stock role does not match its allow list')),
      m('GRANT UPDATE ON tenant_data.write_scope TO repracer_stock', verify('tenant_data\\.write_scope: UPDATE of the stock role does not match its allow list')),
      m('GRANT UPDATE (pricing_mode) ON tenant_data.write_scope TO repracer_stock',
        smoke('stock role changes the pricing of a write scope (Р-102)'), verify('tenant_data\\.write_scope\\.pricing_mode: UPDATE of the stock role is not in its allow list')),
      // Членство ролей общее для кластера, а не для копии базы: такую мутацию нельзя откатить удалением копии — в каталог не входит
    ],
  },
  {
    row: 'Р-103', invariant: 'неизменяемость таблиц, у которых раньше не было строк, проверяется попыткой изменения',
    mutations: [
      m('ALTER TABLE tenant_data.guardrail DISABLE TRIGGER zz_append_only', smoke('append-only tenant_data.guardrail')),
      m('ALTER TABLE channel_data.pricing_halt_review DISABLE TRIGGER zz_append_only', smoke('append-only channel_data.pricing_halt_review')),
      m('ALTER TABLE platform.external_identity_revocation DISABLE TRIGGER zz_append_only', smoke('append-only platform.external_identity_revocation')),
      m('ALTER TABLE tenant_data.price_daily_correction DISABLE TRIGGER zz_append_only', smoke('append-only tenant_data.price_daily_correction')),
    ],
  },
  {
    row: 'OQ-153', invariant: 'привязки входа удаляются только у отключённого пользователя',
    mutations: [
      m(replaceInFunction('maintenance.purge_user_identities(uuid)', 'IF NOT EXISTS (SELECT 1 FROM platform.app_user u WHERE u.user_id = p_user_id AND u.status = \'DISABLED\') THEN', 'IF false THEN'),
        smoke('sign-ins of an active user are purged (OQ-153)')),
    ],
  },
];

const PERSON_GUARD = 'security.require_person_for_admin_write()';
/** Защиты шага 19: находки ревью шага 18, Р-101 для элементов и отзывов, Р-105, Р-107, проверка схемы 0073 */
export const STEP19_ROWS = [
  {
    row: 'находка 1 (шаг 18)', invariant: 'в сессии административного сервиса любое изменение строки — под стражем человека и в аудите',
    mutations: [
      // Пропуск стража для рабочих столбцов удалён (0072); мутация, возвращающая пропуск, ловится только журналом аудита: событие USER без
      // пользователя сессии не пишется (audit_event_check). Две защиты держат одно — отдельной строки у добавленного кода нет (ADR-0019)
      m(replaceInFunction(PERSON_GUARD, 'IF u IS NULL THEN', 'IF false THEN'),
        smoke('the administrative service records an automatic review without a person (Р-97)')),
      m(replaceInFunction('security.audit_admin_write()', '    -- Находка 1 ревью шага 18: в журнал попадает и изменение рабочих столбцов административным сервисом\n  END IF;',
        "    IF NOT cols && TG_ARGV THEN RETURN NULL; END IF;\n  END IF;"),
        smoke('a status change of a write scope by a person is not in the audit log (step 18 finding 1)', 'a status change of a write scope by a person is written to the audit log (step 18 finding 1)')),
    ],
  },
  {
    row: 'Р-101 (находка 2, шаг 18)', invariant: 'листинг в согласие добавляет владелец, давший его, со вторым фактором, в той же транзакции, по предполётной проверке; отзыв — владелец от своего имени со вторым фактором',
    mutations: [
      m(replaceInFunction('tenant_data.migration_consent_item_guard()', 'IF c.user_id IS NULL OR c.user_id IS DISTINCT FROM security.current_user_id() THEN', 'IF false THEN'),
        smoke('listing added to a consent by another owner (Р-101)')),
      m(replaceInFunction('tenant_data.migration_consent_item_guard()', 'IF NOT security.session_mfa() THEN', 'IF false THEN'), smoke('listing added to a consent without a second factor (Р-101)')),
      m(replaceInFunction('tenant_data.migration_consent_item_guard()', 'IF c.given_at <> now() THEN', 'IF false THEN'), smoke('listing added to a consent given in an earlier transaction (Р-101)')),
      // Шаг 20 (0074): «нет предполётной проверки» и «вердикт не совпадает» — одно условие; мутация — в строке Р-109
      m(replaceInFunction('tenant_data.migration_consent_revocation_guard()', 'IF mem.membership_id IS NULL OR NEW.revoked_by_membership_id IS DISTINCT FROM mem.membership_id THEN', 'IF false THEN'),
        smoke('consent revoked in the name of another owner (Р-101)')),
      m(replaceInFunction('tenant_data.migration_consent_revocation_guard()', 'IF NOT security.session_mfa() THEN', 'IF false THEN'), smoke('consent revoked without a second factor (Р-101)')),
    ],
  },
  {
    row: 'Р-107 (находка 3, шаг 18)', invariant: 'ручной intent — только человек в административном сервисе, от своего имени, с правом менять цену',
    mutations: [
      m(replaceInFunction('channel_data.price_intent_manual_guard()', 'IF mem.membership_id IS NULL OR NEW.created_by_membership_id IS DISTINCT FROM mem.membership_id THEN', 'IF false THEN'),
        smoke('manual price intent in the name of another member (Р-107)')),
      m(replaceInFunction('channel_data.price_intent_manual_guard()', "IF NOT security.pricing_permission(mem.role, 'ENABLE_REPRICING') THEN", 'IF false THEN'),
        smoke('manual price intent by a viewer (Р-107)')),
      m(replaceInFunction('channel_data.price_intent_manual_guard()', "NOT (NEW.trigger_type = 'MANUAL' OR coalesce(NEW.rule_code, '') = 'MANUAL' OR NEW.created_by_membership_id IS NOT NULL)",
        "NOT (NEW.trigger_type = 'MANUAL' AND NEW.created_by_membership_id IS NULL)"),
        smoke('path creates a manual price intent of the owner (Р-107)')),
    ],
  },
  {
    row: 'находка 4 (шаг 18)', critical: true, invariant: 'системную остановку ставит проверка входов пути решения, а не человек',
    mutations: [
      m(replaceInFunction('channel_data.pricing_halt_insert_guard()', 'IF security.admin_session() THEN', 'IF false THEN'), smoke('system halt created by a person (step 18 finding 4)')),
      m(replaceInFunction('channel_data.pricing_halt_sample_insert_guard()', 'IF security.admin_session() THEN', 'IF false THEN'),
        smoke('halt sample observation recorded by a viewer in the administrative service (step 19 review finding 3)')),
      m(`DROP TRIGGER a00_pricing_halt_insert_guard ON channel_data.pricing_halt;
         CREATE TRIGGER a00_pricing_halt_insert_guard BEFORE INSERT ON channel_data.pricing_halt FOR EACH ROW WHEN (false) EXECUTE FUNCTION channel_data.pricing_halt_insert_guard()`,
        smoke('system halt created by a person (step 18 finding 4)'), verify('pricing_halt: trigger a00_pricing_halt_insert_guard has a WHEN condition that is not in the list')),
    ],
  },
  {
    row: 'находка 6 (шаг 18)', invariant: 'одна действующая привязка входа — и при изоляции строже READ COMMITTED',
    mutations: [
      m(replaceInFunction('platform.external_identity_one_active()', "IF current_setting('transaction_isolation') <> 'read committed' THEN", 'IF false THEN'),
        node(ID, 'step 18 finding 6', 'step 18 finding 6: a link in REPEATABLE READ is refused', '^linked$')),
      m('ALTER FUNCTION platform.external_identity_one_active() SECURITY INVOKER', verify('platform\\.external_identity_one_active\\(\\): owned by repracer_resolver but not SECURITY DEFINER')),
    ],
  },
  {
    row: 'находка 5 (шаг 18)', invariant: 'привязки входа удаляет только удаление привязок отключённого пользователя',
    mutations: [
      m('GRANT DELETE ON platform.external_identity_revocation TO repracer_retention',
        smoke('retention role deletes sign-in revocations directly (step 18 finding 5)'), verify('role repracer_retention may delete sign-in links')),
      m('GRANT DELETE ON platform.external_identity TO repracer_retention',
        smoke('retention role deletes sign-in links directly (step 18 finding 5)'), verify('role repracer_retention may delete sign-in links')),
      m(replaceInFunction('security.forbid_mutation()', "IF TG_OP = 'DELETE' AND current_user IN ('repracer_retention', 'repracer_identity_purger') THEN", "IF TG_OP = 'DELETE' THEN"),
        verify('security\\.forbid_mutation does not refuse a DELETE')),
    ],
  },
  {
    row: 'находка 7 (шаг 18)', invariant: 'скаляр на месте узла слепка — отказ',
    mutations: [
      m(replaceInFunction('security.explanation_node_declared(jsonb,text,boolean)', "IF jsonb_typeof(node) NOT IN ('object', 'array') THEN", 'IF false THEN'),
        node(UE, 'finding 15', 'step 18 finding 7: a scalar among the sanity checks is refused as a declared-keys violation', '^error: cannot call jsonb_each')),
      // Сама находка: элементы массива проверялись только если это объекты
      m(replaceInFunction('security.explanation_node_declared(jsonb,text,boolean)', 'IF NOT security.explanation_node_declared(v, path || \'[]\', p_competitor_derived) THEN',
        "IF jsonb_typeof(v) = 'object' AND NOT security.explanation_node_declared(v, path || '[]', p_competitor_derived) THEN"),
        node(UE, 'finding 15', ['step 18 finding 7: a scalar among the strategy steps is refused', 'step 18 finding 7: a scalar among the sanity checks is refused'], '^true$')),
    ],
  },
  {
    row: 'Р-105', critical: true, invariant: 'роль остатков пишет в канал только поле QUANTITY',
    mutations: [
      m("ALTER POLICY stock_quantity ON tenant_data.channel_write_history USING (tenant_id = security.current_tenant_id()) WITH CHECK (tenant_id = security.current_tenant_id())",
        smoke('stock role writes price history of a channel write (Р-105)'), verify('channel_write_history: policy stock_quantity of the stock role is not limited to the QUANTITY field')),
      m("ALTER POLICY stock_quantity ON tenant_data.channel_write USING (tenant_id = security.current_tenant_id()) WITH CHECK (tenant_id = security.current_tenant_id())",
        smoke('the stock role sees price writes or does not see quantity writes (Р-105)', 'the stock role sees only quantity writes and their write scopes (Р-105)'),
        verify('channel_write: policy stock_quantity of the stock role is not limited to the QUANTITY field')),
      m("ALTER POLICY stock_quantity ON tenant_data.write_scope USING (tenant_id = security.current_tenant_id())",
        smoke('the stock role sees price writes or does not see quantity writes (Р-105)', 'the stock role sees only quantity writes and their write scopes (Р-105)'),
        verify('write_scope: policy stock_quantity of the stock role is not limited to the QUANTITY field')),
      m('GRANT UPDATE (pricing_mode) ON tenant_data.write_scope TO repracer_stock', verify('tenant_data\\.write_scope\\.pricing_mode: UPDATE of the stock role is not in its allow list')),
      m("ALTER POLICY stock_quantity ON channel_data.write_submission USING (tenant_id = security.current_tenant_id())",
        verify('write_submission: policy stock_quantity of the stock role is not limited to the QUANTITY field')),
    ],
  },
  {
    row: 'шаг 19: атрибуты функций защит', invariant: 'функция служебной роли исполняется её правами',
    mutations: [
      m('ALTER FUNCTION security.audit_admin_write() SECURITY INVOKER',
        smoke('an administrative change is not in the audit log (Р-97)', 'administrative change by a person is written to the audit log (Р-97)'),
        verify('security\\.audit_admin_write\\(\\): owned by repracer_audit_writer but not SECURITY DEFINER')),
    ],
  },
];

/** Защиты шага 20 — в каталоге при создании [Р-108] */
export const STEP20_ROWS = [
  {
    row: 'Р-109', invariant: 'элемент согласия eBay — по вердикту, последней и свежей предполётной проверке, с поимённо принятыми потерями',
    mutations: [
      m(replaceInFunction('tenant_data.migration_consent_item_guard()', 'IF lc.verdict IS NULL OR lc.verdict IS DISTINCT FROM NEW.verdict_at_consent THEN', 'IF false THEN'),
        smoke('consent to a listing whose preflight verdict is INELIGIBLE (Р-109)'), smoke('listing added to a consent without a preflight check (Р-101, Р-2)')),
      m(replaceInFunction('tenant_data.migration_consent_item_guard()', 'AND l.listing_migration_check_id <> NEW.listing_migration_check_id AND l.checked_at >= lc.checked_at) THEN', 'AND false) THEN'),
        smoke('consent to a superseded preflight check (Р-109)')),
      m(replaceInFunction('tenant_data.migration_consent_item_guard()', "IF lc.checked_at < now() - interval '24 hours' THEN", 'IF false THEN'),
        smoke('consent to a preflight check older than 24 hours (Р-109)')),
      m(replaceInFunction('tenant_data.migration_consent_item_guard()', 'IF losses IS DISTINCT FROM (SELECT', 'IF false AND losses IS DISTINCT FROM (SELECT'),
        smoke('consent acknowledging other losses than the preflight check found (Р-109)')),
      m(dropConstraint('listing_migration_check_findings_shape', 'channel_data.listing_migration_check'),
        smoke('preflight LOSS finding without the name of the loss (Р-109)')),
      // Ревью шага 20
      m(dropTrigger('a00_listing_migration_check_not_future', 'channel_data.listing_migration_check'), smoke('preflight check dated in the future (Р-109, step 20 review)')),
      m(dropConstraint('listing_migration_check_verdict_matches_findings', 'channel_data.listing_migration_check'),
        smoke('preflight verdict READY with a blocking finding (Р-109, step 20 review)')),
      m(replaceInFunction('tenant_data.migration_consent_item_guard()', 'AND l.listing_migration_check_id <> NEW.listing_migration_check_id AND l.checked_at >= lc.checked_at) THEN',
        'AND l.checked_at > lc.checked_at) THEN'),
        smoke('consent to one of two preflight checks recorded at the same moment (Р-109, step 20 review)')),
      m(replaceInFunction('tenant_data.offer_mapping_migration_guard()', 'OR latest.verdict IS DISTINCT FROM i.verdict_at_consent', ''),
        smoke('migration started after the fresh check became INELIGIBLE (INV-12, step 20 review)')),
      m(replaceInFunction('tenant_data.offer_mapping_migration_guard()', `OR channel_data.migration_check_losses(latest.findings)
                           IS DISTINCT FROM (SELECT coalesce(array_agg(DISTINCT x ORDER BY x), '{}') FROM unnest(i.acknowledged_losses) x)`, ''),
        smoke('migration started with a loss the owner did not acknowledge (INV-12, Р-109, step 20 review)')),
    ],
  },
];

export const STEP21_ROWS = [
  {
    row: 'Р-111', invariant: 'собственный пол цены канала (Kaufland minimum_price, Amazon minimum_seller_allowed_price) не пишется: поле — только у Kaufland и только в явном режиме Smart Pricing',
    mutations: [
      m(dropConstraint('channel_capability_channel_min_price_only_kaufland', 'platform.channel_capability'),
        smoke('Amazon capability for the channel repricer floor (Р-111)')),
      m(dropConstraint('write_scope_smart_pricing_only_kaufland', 'tenant_data.write_scope'),
        smoke('Amazon write scope in Smart Pricing mode (Р-111)')),
      m(replaceInFunction('tenant_data.channel_write_before_insert()', "IF s.field <> 'PRICE' OR s.pricing_mode <> 'KAUFLAND_SMART_PRICING' THEN", 'IF false THEN'),
        smoke('CHANNEL_MIN_PRICE write in ENGINE mode (Р-12)')),
    ],
  },
  {
    row: 'Р-88/OQ-144', invariant: 'границы больше чем одного предложения одной транзакцией административного сервиса — только со вторым фактором; версия границы — время транзакции',
    mutations: [
      m(dropTrigger('zc_min_price_mass_edit_requires_mfa', 'tenant_data.min_price'), smoke('min_price of two offers in one transaction without a second factor (Р-88)')),
      m(dropTrigger('zc_max_price_mass_edit_requires_mfa', 'tenant_data.max_price'), smoke('max_price of two offers in one transaction without a second factor (Р-88)')),
      m(replaceInFunction('tenant_data.bounds_mass_edit_requires_mfa()', 'IF offers > 1 THEN', 'IF false THEN'),
        smoke('min_price of two offers in one transaction without a second factor (Р-88)'), smoke('max_price of two offers in one transaction without a second factor (Р-88)')),
      // Шаг 31: страж считает один раз на оператор, и тенант берётся из таблицы переходов, а не из строки
      m(replaceInFunction('tenant_data.bounds_mass_edit_requires_mfa()', `WHERE b.tenant_id = tenant AND b.created_at = now() AND tenant_data.row_in_current_transaction(b.xmin)
  ) edited;`, `WHERE false
  ) edited;`), smoke('min_price of one offer and max_price of another in one transaction without a second factor (Р-88)')),
      m(replaceInFunction('tenant_data.row_in_current_transaction(xid)', "= 'in progress'", "= 'committed'"),
        smoke('min_price of two offers in one transaction without a second factor (Р-88)'), smoke('max_price of two offers in one transaction without a second factor (Р-88)')),
      /**
       * Шаг 31 (задача D): проверка «время версии — время транзакции» стала своим строковым триггером, а подсчёт окна ушёл на
       * уровень оператора. Защита та же и ловится тем же утверждением; снимается теперь два раза — по разу на таблицу границ.
       */
      m(dropTrigger('za_min_price_created_now', 'tenant_data.min_price'),
        smoke('backdated bound version from the administrative service (Р-88)')),
      m(dropTrigger('za_max_price_created_now', 'tenant_data.max_price'),
        smoke('backdated max_price version from the administrative service (Р-88)')),
    ],
  },
];

// Шаг 23: защиты строки «Р-116» шага 22 (0080) удалены миграцией 0082 — неверная база цены стала причиной остановки по недоверию каналу [Р-118]
export const STEP22_ROWS = [];

// Шаг 24
export const STEP25_ROWS = [
  {
    row: 'Р-126', invariant: 'периодическую работу выполняет один планировщик — аренда; состояние и журнал запусков известной формы; журнал неизменяем',
    mutations: [
      m(dropTrigger('a_scheduled_job_lease_guard', 'maintenance.scheduled_job'), smoke('a scheduled job taken over while another scheduler holds its lease (Р-126)')),
      m(replaceInFunction('maintenance.scheduled_job_lease_guard()', 'AND OLD.lease_until > now()', 'AND false'), smoke('a scheduled job taken over while another scheduler holds its lease (Р-126)')),
      m(replaceInFunction('maintenance.scheduled_job_lease_guard()', "AND current_setting('repracer.scheduler_owner', true) IS DISTINCT FROM OLD.lease_owner THEN", 'AND false THEN'),
        smoke('an active scheduled job lease released by another scheduler (Р-126)')),
      m(dropConstraint('scheduled_job_key_format', 'maintenance.scheduled_job'), smoke('a scheduled job key outside the job and account format (Р-126)')),
      m(dropConstraint('scheduled_job_catch_up_known', 'maintenance.scheduled_job'), smoke('a scheduled job with an unknown catch-up rule (Р-126)')),
      m(dropConstraint('scheduled_job_interval_positive', 'maintenance.scheduled_job'), smoke('a scheduled job without a positive interval (Р-126)')),
      m(dropConstraint('scheduled_job_scope_pair', 'maintenance.scheduled_job'), smoke('a scheduled job scoped to a tenant without an account (Р-126)')),
      m(dropConstraint('scheduled_job_lease_pair', 'maintenance.scheduled_job'), smoke('a scheduled job lease without its end (Р-126)')),
      m(dropConstraint('scheduled_job_outcome_known', 'maintenance.scheduled_job'), smoke('a scheduled job with an unknown last outcome (Р-126)')),
      m(dropConstraint('scheduled_job_run_outcome_known', 'maintenance.scheduled_job_run'), smoke('a scheduler run with an unknown outcome (Р-126)')),
      m(dropConstraint('scheduled_job_run_order', 'maintenance.scheduled_job_run'), smoke('a scheduler run finished before it started (Р-126)')),
      m(dropTrigger('zz_append_only', 'maintenance.scheduled_job_run'), smoke('append-only maintenance.scheduled_job_run')),
      m(dropTrigger('zz_no_truncate', 'maintenance.scheduled_job_run'), smoke('truncate maintenance.scheduled_job_run')),
    ],
  },
];

export const STEP25_B_ROWS = [
  {
    row: 'Р-124', invariant: 'проверка Omnibus показывает глубину видимой истории и цены, выставленные мимо нас; такие цены — в окне, проверка с ними не достоверна',
    mutations: [
      m(replaceInFunction('tenant_data.omnibus_lowest_prior_price(uuid,uuid,timestamp with time zone)', "WHEN external_n > 0 THEN 'EXTERNAL_CHANGES'", "WHEN false THEN 'EXTERNAL_CHANGES'"),
        smoke('a price set outside repracer does not make the Omnibus check unverifiable (Р-124)', 'a price set outside repracer makes the Omnibus check unverifiable (Р-124)')),
      m(replaceInFunction('tenant_data.omnibus_lowest_prior_price(uuid,uuid,timestamp with time zone)', 'AND c.opened_at >= from_ts AND c.opened_at < p_starts_at', 'AND false'),
        smoke('a price set outside repracer does not make the Omnibus check unverifiable (Р-124)', 'a price set outside repracer makes the Omnibus check unverifiable (Р-124)')),
      // Начало видимой истории — самое раннее из подключения и первых цен; «самое позднее» отсчитывало бы глубину с подключения в смоук-мире
      m(replaceInFunction('tenant_data.omnibus_lowest_prior_price(uuid,uuid,timestamp with time zone)', 'SELECT least(', 'SELECT greatest('),
        smoke('the history depth of an offer is not counted from its first known price (Р-124)', 'the history depth of an offer is counted from its first known price (Р-124)')),
    ],
  },
  {
    row: 'риск 28', invariant: 'цена, которую канал не применил, отмечается и не входит ни в суточную свёртку, ни в окно Omnibus',
    mutations: [
      m(dropTrigger('a_price_history_not_applied_guard', 'tenant_data.price_history_not_applied'), smoke('a price of an applied write marked as not applied (risk 28)')),
      m(replaceInFunction('tenant_data.price_history_not_applied_guard()', "AND w.final_status = 'NOT_APPLIED'", ''), smoke('a price of a write the channel applied marked as not applied (risk 28)')),
      m(dropTrigger('b_price_history_mark_not_applied', 'tenant_data.channel_write_history'),
        smoke('a price write the channel did not apply is not marked (risk 28)', 'a price write the channel did not apply is marked (risk 28)')),
      m(replaceInFunction('tenant_data.omnibus_raw_prices(uuid,uuid,text,timestamp with time zone)', 'na.price_history_id = h.price_history_id)', 'na.price_history_id = h.price_history_id AND false)'),
        smoke('a price the channel did not apply is in the Omnibus window (risk 28)', 'a price the channel did not apply is not in the Omnibus window (risk 28)')),
      m(replaceInFunction('tenant_data.omnibus_lowest_prior_price(uuid,uuid,timestamp with time zone)', 'na.price_history_id = h.price_history_id)', 'na.price_history_id = h.price_history_id AND false)'),
        smoke('a price the channel did not apply is in the Omnibus window (risk 28)', 'a price the channel did not apply is not in the Omnibus window (risk 28)')),
      m(replaceInFunction('maintenance.close_price_days(timestamp with time zone,integer)', 'na.price_history_id = h.price_history_id)', 'na.price_history_id = h.price_history_id AND false)'),
        node(T('omnibus-not-applied.pg.test.ts'), 'risk 28', 'risk 28: a price the channel did not apply is rolled up into the daily price', '^900$')),
      m(dropTrigger('zz_append_only', 'tenant_data.price_history_not_applied'), smoke('append-only tenant_data.price_history_not_applied')),
      m(dropTrigger('zz_no_truncate', 'tenant_data.price_history_not_applied'), smoke('truncate tenant_data.price_history_not_applied')),
    ],
  },
];

export const STEP25_D_ROWS = [
  {
    row: 'OQ-181', invariant: 'пропущенный выгрузкой снимок записан и разобран человеком с именем и заметкой; секция с неразобранным пропуском не отмечается проверенной',
    mutations: [
      m(dropTrigger('a_partition_export_skip_guard', 'maintenance.partition_export'), smoke('a partition with an unresolved skipped snapshot marked as verified (OQ-181)')),
      m(replaceInFunction('maintenance.partition_export_skip_guard()', 'IF open_skips > 0 THEN', 'IF false THEN'), smoke('a partition with an unresolved skipped snapshot marked as verified (OQ-181)')),
      m(dropConstraint('snapshot_export_skip_reason_known', 'maintenance.snapshot_export_skip'), smoke('a skipped snapshot with an unknown reason (OQ-181)')),
      m(dropConstraint('snapshot_export_skip_resolution_known', 'maintenance.snapshot_export_skip_resolution'), smoke('a skipped snapshot resolution of an unknown kind (OQ-181)')),
      m(dropConstraint('snapshot_export_skip_resolution_operator', 'maintenance.snapshot_export_skip_resolution'), smoke('a skipped snapshot resolved without the operator (OQ-181)')),
      m(dropConstraint('snapshot_export_skip_resolution_note', 'maintenance.snapshot_export_skip_resolution'), smoke('a skipped snapshot resolved without a note (OQ-181)')),
      m(dropTrigger('zz_append_only', 'maintenance.snapshot_export_skip'), smoke('append-only maintenance.snapshot_export_skip')),
      m(dropTrigger('zz_no_truncate', 'maintenance.snapshot_export_skip'), smoke('truncate maintenance.snapshot_export_skip')),
      m(dropTrigger('zz_append_only', 'maintenance.snapshot_export_skip_resolution'), smoke('append-only maintenance.snapshot_export_skip_resolution')),
      m(dropTrigger('zz_no_truncate', 'maintenance.snapshot_export_skip_resolution'), smoke('truncate maintenance.snapshot_export_skip_resolution')),
    ],
  },
];

export const STEP24_ROWS = [
  {
    row: 'OQ-172', invariant: 'остановка человеком держит и порог цены канала CHANNEL_MIN_PRICE — создание и отправку',
    mutations: [
      m(replaceInFunction('tenant_data.channel_write_stop_guard()', "IF NEW.field NOT IN ('PRICE', 'CHANNEL_MIN_PRICE')", "IF NEW.field NOT IN ('PRICE')"),
        smoke('channel price floor write created while pricing is stopped by a person (Р-69, OQ-172)'),
        smoke('dispatch of a channel price floor write while pricing is stopped by a person (Р-69, OQ-172)')),
    ],
  },
  {
    row: 'Р-122', invariant: 'журнал полных снимков конкурентов не переписывается и не очищается целиком; вердикт и форма снимка известны',
    mutations: [
      m(dropTrigger('zz_append_only', 'channel_data.competitor_snapshot_log'), smoke('append-only channel_data.competitor_snapshot_log')),
      m(dropTrigger('zz_no_truncate', 'channel_data.competitor_snapshot_log'), smoke('truncate channel_data.competitor_snapshot_log')),
      m(dropConstraint('competitor_snapshot_log_verdict_known', 'channel_data.competitor_snapshot_log'), smoke('competitor snapshot log with an unknown sanity verdict (Р-122)')),
      m(dropConstraint('competitor_snapshot_log_snapshot_object', 'channel_data.competitor_snapshot_log'), smoke('competitor snapshot log whose snapshot is not an object (Р-122)')),
    ],
  },
  {
    row: 'Р-123', invariant: 'объявленная прежняя цена скидки не выше наименьшей цены оффера за 30 суток витрины; проверку вычисляет база; объявления не переписываются',
    mutations: [
      m(dropTrigger('a1_discount_announcement_guard', 'tenant_data.discount_announcement'),
        smoke('discount announced with a prior price above the lowest price of 30 days (Omnibus, Р-123)'), smoke('discount announced in a currency other than the currency of the offer (Р-71, Р-123)'),
        smoke('the Omnibus check of a discount announcement is not computed by the database (Р-123)', 'the Omnibus check of a discount announcement is computed by the database (Р-123)')),
      m(replaceInFunction('tenant_data.discount_announcement_guard()', 'IF p.lowest_minor IS NOT NULL AND NEW.reference_price_minor > p.lowest_minor THEN', 'IF false THEN'),
        smoke('discount announced with a prior price above the lowest price of 30 days (Omnibus, Р-123)')),
      m(replaceInFunction('tenant_data.discount_announcement_guard()', 'IF scope IS NULL OR scope.currency IS DISTINCT FROM NEW.currency THEN', 'IF false THEN'),
        smoke('discount announced in a currency other than the currency of the offer (Р-71, Р-123)')),
      m(replaceInFunction('tenant_data.omnibus_lowest_prior_price(uuid,uuid,timestamp with time zone)', "AND d.price_day < wfrom", 'AND false'),
        smoke('the Omnibus check of a discount announcement is not computed by the database (Р-123)', 'the Omnibus check of a discount announcement is computed by the database (Р-123)')),
      m(replaceInFunction('tenant_data.discount_announcement_guard()', 'IF NEW.starts_at < (', 'IF false AND NEW.starts_at < ('),
        smoke('discount announced to start before the current storefront day (Omnibus, Р-123)')),
      m(replaceInFunction('tenant_data.omnibus_lowest_prior_price(uuid,uuid,timestamp with time zone)', "CASE WHEN p_starts_at > now() THEN 'WINDOW_OPEN'", "CASE WHEN false THEN 'WINDOW_OPEN'"),
        smoke('a discount starting later is confirmed before its window closes (Р-123)', 'a discount starting later is not confirmed before its window closes (Р-123)')),
      m(replaceInFunction('tenant_data.omnibus_lowest_prior_price(uuid,uuid,timestamp with time zone)', 'AND coalesce(ap.applied_at, h.accepted_at) >= to_ts AND coalesce(ap.applied_at, h.accepted_at) < p_starts_at', 'AND false'),
        smoke('the prices of the discount day before its start are not in the window (Р-123)', 'the prices of the discount day before its start are in the window (Р-123)')),
      m(dropConstraint('discount_announcement_prices', 'tenant_data.discount_announcement'), smoke('discount whose sale price is not below the prior price (Р-123)')),
      m(dropConstraint('discount_announcement_period', 'tenant_data.discount_announcement'), smoke('discount ending before it starts (Р-123)')),
      m(dropTrigger('zz_append_only', 'tenant_data.discount_announcement'), smoke('append-only tenant_data.discount_announcement')),
      m(dropTrigger('zz_no_truncate', 'tenant_data.discount_announcement'), smoke('truncate tenant_data.discount_announcement')),
      m(dropTrigger('a0_admin_write_person_insert', 'tenant_data.discount_announcement'), verify('tenant_data\\.discount_announcement: administrative INSERT without the person guard')),
      m(dropTrigger('zz_admin_write_audit_insert', 'tenant_data.discount_announcement'), verify('tenant_data\\.discount_announcement: administrative INSERT is not written to the audit log')),
    ],
  },
  {
    row: 'Р-121', invariant: 'сверка опросом: проверка потери уведомления — только при расхождении и со сроком после опроса; вердикт ставит база и только по снимку уведомления того же товара до срока',
    mutations: [
      m(dropConstraint('competitor_snapshot_log_delivery_known', 'channel_data.competitor_snapshot_log'), smoke('competitor snapshot log with an unknown delivery (Р-121)')),
      m(dropConstraint('notification_loss_check_diverged', 'channel_data.notification_loss_check'), smoke('notification loss check without a divergence (Р-121)')),
      m(dropConstraint('notification_loss_check_order', 'channel_data.notification_loss_check'), smoke('notification loss check due before the poll (Р-121)')),
      m(dropConstraint('notification_loss_check_compared_known', 'channel_data.notification_loss_check'), smoke('notification loss check comparing an unknown value (Р-121)')),
      m(dropConstraint('notification_loss_verdict_evidence', 'channel_data.notification_loss_verdict'), smoke('notification loss verdict delayed without the notification snapshot (Р-121)')),
      m(dropConstraint('notification_loss_verdict_known', 'channel_data.notification_loss_verdict'), smoke('notification loss verdict of an unknown kind (Р-121)')),
      m(replaceInFunction('channel_data.review_notification_loss(uuid,uuid,timestamp with time zone)', 'AND l.received_at <= d.due_at', ''),
        smoke('a notification after the due time resolves a loss check (Р-121)', 'a notification after the due time does not resolve a loss check (Р-121)')),
      m(replaceInFunction('channel_data.review_notification_loss(uuid,uuid,timestamp with time zone)', "AND l.delivery IN ('PUSH', 'PUSH_FETCH') AND", 'AND'),
        smoke('a polled snapshot counts as a delivered notification (Р-121)', 'a polled snapshot does not count as a delivered notification (Р-121)')),
      m(replaceInFunction('channel_data.review_notification_loss(uuid,uuid,timestamp with time zone)', 'AND c.due_at <= v_at', ''),
        smoke('a loss check is decided before its due time (Р-121)', 'a loss check is not decided before its due time (Р-121)')),
      // Выбор вердикта в теле функции своей мутации не имеет: «потеря» при найденном уведомлении отклоняет notification_loss_verdict_evidence (Р-104)
      m(replaceInFunction('channel_data.review_notification_loss(uuid,uuid,timestamp with time zone)', 'AND (l.channel_account_id, l.marketplace, l.channel_product_ref, l.condition) = (d.channel_account_id, d.marketplace, d.channel_product_ref, d.condition)', ''),
        smoke('a notification of another product resolves a loss check (Р-121)', 'a notification of another product does not resolve a loss check (Р-121)')),
      m(replaceInFunction('channel_data.review_notification_loss(uuid,uuid,timestamp with time zone)', "AND l.delivery IN ('PUSH', 'PUSH_FETCH') AND l.observed_at > d.held_observed_at", "AND l.delivery IN ('PUSH', 'PUSH_FETCH')"),
        smoke('a notification observed before the held state resolves a loss check (Р-121)', 'a notification observed before the held state does not resolve a loss check (Р-121)')),
      m('GRANT INSERT ON channel_data.notification_loss_verdict TO repracer_admin', verify('channel_data\\.notification_loss_verdict: administrative INSERT without the person guard')),
      m('GRANT INSERT ON channel_data.notification_loss_verdict TO repracer_app', smoke('path sets a notification loss verdict itself (Р-121)'), pathRight('channel_data.notification_loss_verdict', 'INSERT')),
      m(dropTrigger('zz_append_only', 'channel_data.notification_loss_check'), smoke('append-only channel_data.notification_loss_check')),
      m(dropTrigger('zz_no_truncate', 'channel_data.notification_loss_check'), smoke('truncate channel_data.notification_loss_check')),
      m(dropTrigger('zz_append_only', 'channel_data.notification_loss_verdict'), smoke('append-only channel_data.notification_loss_verdict')),
      m(dropTrigger('zz_no_truncate', 'channel_data.notification_loss_verdict'), smoke('truncate channel_data.notification_loss_verdict')),
    ],
  },
  {
    row: 'OQ-169', invariant: 'единице записи назначается только действующая версия стратегии',
    mutations: [
      m(replaceInFunction('tenant_data.write_scope_strategy_guard()', "AND status IS DISTINCT FROM 'ACTIVE' THEN", 'AND false THEN'),
        smoke('a draft strategy version assigned to an offer (OQ-169)')),
    ],
  },
];

export const STEP23_ROWS = [
  {
    row: 'Р-118', invariant: 'остановка по недоверию каналу держит любую цену и порог цены канала, ставит её система, снимает только человек с правом, от своего имени, со вторым фактором',
    mutations: [
      m(dropTrigger('ac_price_decision_distrust_guard', 'channel_data.price_decision'), smoke('fixed-price approval while the channel is distrusted (Р-118)')),
      m(dropTrigger('bc_channel_write_distrust_guard', 'tenant_data.channel_write'),
        smoke('dispatch of a fixed-price write while the channel is distrusted (Р-118)'), smoke('fixed-price write created while the channel is distrusted (Р-118)')),
      m(replaceInFunction('tenant_data.channel_write_distrust_guard()', "IF NEW.field NOT IN ('PRICE', 'CHANNEL_MIN_PRICE') OR (TG_OP = 'UPDATE'", "IF NEW.field NOT IN ('PRICE', 'CHANNEL_MIN_PRICE') OR TG_OP = 'INSERT' OR (TG_OP = 'UPDATE'"),
        smoke('fixed-price write created while the channel is distrusted (Р-118)')),
      m(replaceInFunction('tenant_data.channel_write_distrust_guard()', "IF NEW.field NOT IN ('PRICE', 'CHANNEL_MIN_PRICE')", "IF NEW.field NOT IN ('PRICE')"),
        smoke('channel price floor write created while the channel is distrusted (Р-118, OQ-166)'), smoke('dispatch of a channel price floor write while the channel is distrusted (Р-118, OQ-166)')),
      m(replaceInFunction('channel_data.channel_distrust_for(uuid,uuid)', 'AND d.released_at IS NULL', 'AND false'),
        smoke('fixed-price approval while the channel is distrusted (Р-118)'), smoke('dispatch of a fixed-price write while the channel is distrusted (Р-118)')),
      m(dropTrigger('a00_channel_distrust_insert_guard', 'channel_data.channel_distrust'), smoke('a person creates a channel distrust (Р-118)')),
      m(dropTrigger('ca_channel_distrust_release_guard', 'channel_data.channel_distrust'),
        smoke('channel distrust released without a second factor (Р-118)'), smoke('channel distrust released in the name of another member (Р-118)'), smoke('channel distrust released twice (Р-118)')),
      m(replaceInFunction('channel_data.channel_distrust_release_guard()', 'IF security.current_user_id() IS NULL OR u IS DISTINCT FROM security.current_user_id() THEN', 'IF false THEN'),
        smoke('channel distrust released in the name of another member (Р-118)')),
      m(replaceInFunction('channel_data.channel_distrust_release_guard()', 'IF NOT security.session_mfa() THEN', 'IF false THEN'), smoke('channel distrust released without a second factor (Р-118)')),
      m(replaceInFunction('channel_data.channel_distrust_release_guard()', 'IF OLD.released_at IS NOT NULL THEN', 'IF false THEN'), smoke('channel distrust released twice (Р-118)')),
      m(dropConstraint('channel_distrust_details_check', 'channel_data.channel_distrust'), smoke('buyer price read from the channel kept in a distrust (Р-3, Р-118)')),
      m(dropConstraint('channel_distrust_reason_known', 'channel_data.channel_distrust'), smoke('channel distrust with an unknown reason (Р-118)')),
      m(dropConstraint('channel_distrust_release_by_person', 'channel_data.channel_distrust'), smoke('channel distrust released with a note shorter than 10 characters (Р-118)')),
      m('GRANT UPDATE ON channel_data.channel_distrust TO repracer_admin', smoke('channel distrust reason changed (Р-118)')),
      m(dropTrigger('zb_channel_distrust_audit', 'channel_data.channel_distrust'),
        smoke('a channel distrust is created without an audit event (Р-76, Р-118)', 'a channel distrust is created with an audit event (Р-76, Р-118)')),
      m(replaceInFunction('channel_data.channel_distrust_audit()', 'IF OLD.released_at IS NOT NULL OR NEW.released_at IS NULL THEN', 'IF true THEN'),
        smoke('a channel distrust is released without an audit event with its author and note (Р-76, Р-118)', 'a channel distrust is released with an audit event with its author and note (Р-76, Р-118)')),
      m(dropTrigger('a0_admin_write_person_insert', 'channel_data.channel_distrust'), verify('channel_data\\.channel_distrust: administrative INSERT without the person guard')),
      m(dropTrigger('a0_admin_write_person_update', 'channel_data.channel_distrust'), verify('channel_data\\.channel_distrust: administrative UPDATE without the person guard')),
      m(dropTrigger('zz_admin_write_audit_insert', 'channel_data.channel_distrust'), verify('channel_data\\.channel_distrust: administrative INSERT is not written to the audit log')),
      m(dropTrigger('zz_admin_write_audit_update', 'channel_data.channel_distrust'), verify('channel_data\\.channel_distrust: administrative UPDATE is not written to the audit log')),
    ],
  },
  {
    row: 'Р-39/OQ-166, Р-120', invariant: 'стратегия назначается, только если канал даёт нужные ей данные конкурентов и у предложения нет собственного ценообразования канала',
    mutations: [
      m(dropTrigger('a2_write_scope_strategy_guard', 'tenant_data.write_scope'),
        smoke('strategy unavailable on the channel assigned to an offer (Р-39, OQ-166)'), smoke('strategy assigned to an offer with the channel repricer active (Р-120)')),
      m(replaceInFunction('tenant_data.write_scope_strategy_guard()', "IF unmet <> '{}'::jsonb THEN", 'IF false THEN'), smoke('strategy unavailable on the channel assigned to an offer (Р-39, OQ-166)')),
      m(replaceInFunction('tenant_data.write_scope_strategy_guard()', 'IF pricing IS NOT NULL THEN', 'IF false THEN'), smoke('strategy assigned to an offer with the channel repricer active (Р-120)')),
      m(replaceInFunction('channel_data.strategy_unmet(text,jsonb)', "u := u || 'COMPLETENESS'::text;", 'NULL;'), smoke('strategy unavailable on the channel assigned to an offer (Р-39, OQ-166)')),
      m(dropConstraint('offer_channel_pricing_source_known', 'channel_data.offer_channel_pricing'), smoke('channel pricing observation from an unknown source (Р-120)')),
      // Ревью шага 23, находки 1 и 3
      m(replaceInFunction('tenant_data.write_scope_strategy_guard()', "OR NEW.pricing_mode <> 'ENGINE')", 'OR false)'),
        node(T('channel-pricing-guard.pg.test.ts'), 'finding 1 [Р-120]', 'finding 1: switching repricing off is not refused by channel-owned pricing', 'channel-owned pricing')),
      m(dropTrigger('a2_offer_mapping_channel_pricing_guard', 'tenant_data.offer_mapping'),
        node(T('channel-pricing-guard.pg.test.ts'), 'finding 3 [Р-120]', 'finding 3: an offer with channel-owned pricing is mapped to a strategy write scope', 'resolved')),
      m(replaceInFunction('tenant_data.offer_mapping_channel_pricing_guard()', 'IF pricing IS NOT NULL THEN', 'IF false THEN'),
        node(T('channel-pricing-guard.pg.test.ts'), 'finding 3 [Р-120]', 'finding 3: an offer with channel-owned pricing is mapped to a strategy write scope', 'resolved')),
      // Р-119: канал без выборки — только человек (ревью шага 23, находка 8)
      m(replaceInFunction('channel_data.review_halt_by_sample(uuid,uuid,timestamp with time zone)', "RETURN 'MANUAL_ONLY';", 'NULL;'),
        node('tests/contract/src/channel-reference.pg.test.ts', 'Р-119: a storefront halt on Amazon', 'Р-119: a clean sample does not release a halt on a channel without competitor polling', '^(?!MANUAL_ONLY$).+')),
      m(dropTrigger('zz_append_only', 'channel_data.offer_channel_pricing'), smoke('append-only channel_data.offer_channel_pricing')),
      m(dropTrigger('zz_no_truncate', 'channel_data.offer_channel_pricing'), smoke('truncate channel_data.offer_channel_pricing')),
    ],
  },
  {
    row: 'Шаг 23 A (приёмник уведомлений)', invariant: 'журнал обработанных уведомлений и состояния PRICING_HEALTH не переписываются и не очищаются целиком',
    mutations: [
      // Маршрут продавца: межтенантный поиск только функцией у роли приёмника, только подключённые аккаунты Amazon (ревью шага 23, находка 9)
      m('ALTER POLICY inbound_router_resolve ON tenant_data.channel_account USING (true)',
        node(T('inbound.pg.test.ts'), 'step 23: the receiver role routes', 'a disconnected account receives no notifications', '.+')),
      m('GRANT EXECUTE ON FUNCTION security.resolve_amazon_seller(text, text) TO repracer_app',
        node(T('inbound.pg.test.ts'), 'step 23: the receiver role routes', 'the decision path role may not search accounts across tenants', 'resolved')),
      m(dropConstraint('offer_pricing_health_threshold_money', 'channel_data.offer_pricing_health'), smoke('pricing health threshold without its currency (Р-71)')),
      m(dropTrigger('zz_append_only', 'channel_data.inbound_notification'), smoke('append-only channel_data.inbound_notification')),
      m(dropTrigger('zz_no_truncate', 'channel_data.inbound_notification'), smoke('truncate channel_data.inbound_notification')),
      m(dropTrigger('zz_append_only', 'channel_data.offer_pricing_health'), smoke('append-only channel_data.offer_pricing_health')),
      m(dropTrigger('zz_no_truncate', 'channel_data.offer_pricing_health'), smoke('truncate channel_data.offer_pricing_health')),
    ],
  },
];

/** Строки таблицы, у которых нечего снимать: правило проверяло отсутствие объектов или свойства каталога, оставшиеся в проверке схемы */
export const R93_NOT_MUTATED = [
  { row: '1–11', why: 'свойства каталога остались в проверке схемы (0067)' },
  { row: '15', why: 'данные справочника НДС остались в проверке схемы (0067)' },
  { row: '36', why: 'правило проверяло отсутствие объектов входа' },
];

export const STEP26_ROWS = [
  {
    row: 'риск 31', invariant: 'уровень отставания работы планировщика хранится в базе: перезапуск и второй процесс алерт не повторяют',
    mutations: [
      m(dropConstraint('scheduled_job_lag_level_known', 'maintenance.scheduled_job'), smoke('a scheduled job with an unknown lag level (риск 31)')),
    ],
  },
  {
    row: 'OQ-182', invariant: 'разбор пропущенного снимка — от действующей учётной записи оператора платформы со вторым фактором; «выгружен после исправления» — только со сверкой ClickHouse',
    mutations: [
      m(dropTrigger('a_snapshot_export_skip_resolution_guard', 'maintenance.snapshot_export_skip_resolution'),
        smoke('a skipped snapshot resolved without a platform operator account (OQ-182)')),
      m(replaceInFunction('maintenance.snapshot_export_skip_resolution_guard()', 'o.operator_id = NEW.operator_id AND o.active', 'o.operator_id = NEW.operator_id'),
        smoke('a skipped snapshot resolved by a retired operator account (OQ-182)')),
      m(replaceInFunction('maintenance.snapshot_export_skip_resolution_guard()', 'IF NOT NEW.mfa THEN', 'IF false THEN'),
        smoke('a skipped snapshot resolved without the second factor (OQ-182)')),
      m(replaceInFunction('maintenance.partition_export_skip_guard()', "AND (r.resolution = 'LOSS_ACCEPTED'", 'AND (true'),
        smoke('a partition verified on the operator word that the snapshot was exported after the fix (OQ-182)')),
      m(dropConstraint('snapshot_export_skip_verification_rows', 'maintenance.snapshot_export_skip_verification'), smoke('a skip verification with no rows in ClickHouse (OQ-182)')),
      m(dropConstraint('snapshot_export_skip_verification_platform_tenant', 'maintenance.snapshot_export_skip_verification'), smoke('a skip verification that belongs to a tenant (OQ-182)')),
      m(dropConstraint('platform_operator_platform_tenant', 'platform.platform_operator'), smoke('a platform operator that belongs to a tenant (OQ-182)')),
      m(dropConstraint('platform_operator_issuer_url', 'platform.platform_operator'), smoke('a platform operator without an identity provider (OQ-182)')),
      m(dropConstraint('platform_operator_subject_present', 'platform.platform_operator'), smoke('a platform operator without a subject (OQ-182)')),
      m(dropConstraint('platform_operator_name_present', 'platform.platform_operator'), smoke('a platform operator without a name (OQ-182)')),
      m(dropTrigger('zz_append_only', 'maintenance.snapshot_export_skip_verification'), smoke('append-only maintenance.snapshot_export_skip_verification')),
      m(dropTrigger('zz_no_truncate', 'maintenance.snapshot_export_skip_verification'), smoke('truncate maintenance.snapshot_export_skip_verification')),
    ],
  },
  {
    row: 'OQ-180', invariant: 'цена входит в окно Omnibus и в суточную свёртку по времени, когда канал её применил',
    mutations: [
      m(dropTrigger('a_price_history_applied_guard', 'tenant_data.price_history_applied'),
        smoke('a price of a write the channel did not confirm marked with a time of application (OQ-180)')),
      m(replaceInFunction('tenant_data.price_history_applied_guard()', "AND w.final_status = 'APPLIED'", ''),
        smoke('a price of a write the channel reported a time for but did not apply marked with a time of application (OQ-180)')),
      m(dropTrigger('b_price_history_mark_applied', 'tenant_data.channel_write_history'),
        smoke('the time the channel applied a price is not recorded for its price history (OQ-180)', 'the Omnibus window counts the price at the time the channel applied it (OQ-180)')),
      m(replaceInFunction('tenant_data.omnibus_raw_prices(uuid,uuid,text,timestamp with time zone)', 'SELECT coalesce(ap.applied_at, h.accepted_at), h.amount_minor', 'SELECT h.accepted_at, h.amount_minor'),
        smoke('the Omnibus window uses the time the price was accepted, not applied (OQ-180)', 'the Omnibus window counts the price at the time the channel applied it (OQ-180)')),
      m(replaceInFunction('maintenance.close_price_days(timestamp with time zone,integer)', 'WHERE coalesce(ap.applied_at, h.accepted_at) >= day_start AND coalesce(ap.applied_at, h.accepted_at) < day_end', 'WHERE h.accepted_at >= day_start AND h.accepted_at < day_end'),
        node(T('omnibus-applied-time.pg.test.ts'), 'OQ-180', 'OQ-180: a price applied after midnight is rolled up into the day it was accepted', '^0$')),
      // Шаг 27, D [OQ-192]: правило «цена закрытых суток остаётся в них» заменено поправкой — мутации в строке OQ-192
      // Закрытие тенанта удаляет отметки времени применения: таблица названа в purge_tenant_data (правило проверки схемы)
      m(replaceInFunction('maintenance.purge_tenant_data(uuid,boolean)', "'tenant_data.price_history_applied', ", ''),
        verify('tenant_data\\.price_history_applied: tenant closure does not delete the table')),
      m(dropTrigger('zz_append_only', 'tenant_data.price_history_applied'), smoke('append-only tenant_data.price_history_applied')),
      m(dropTrigger('zz_no_truncate', 'tenant_data.price_history_applied'), smoke('truncate tenant_data.price_history_applied')),
    ],
  },
];

export const STEP27_ROWS = [
  {
    row: 'Р-131', invariant: 'единица записи переходит в ENGINE только с объявленной себестоимостью товара',
    mutations: [
      m(dropTrigger('zw_write_scope_cost_required_guard', 'tenant_data.write_scope'), smoke('ENGINE without the declared unit cost (Р-131)')),
      m(replaceInFunction('tenant_data.write_scope_cost_required_guard()', "IF NEW.pricing_mode = 'ENGINE'", 'IF false'),
        smoke('ENGINE without the declared unit cost (Р-131)')),
      m(replaceInFunction('tenant_data.write_scope_has_cost(uuid,uuid,timestamp with time zone)', 'SELECT EXISTS (', 'SELECT true OR EXISTS ('),
        smoke('ENGINE without the declared unit cost (Р-131)')),
    ],
  },
  {
    row: 'OQ-192', invariant: 'подтверждение применения после закрытия суток переносит цену строкой-поправкой [Р-29]: свёртка не меняется, повтор пересчёта ничего не пишет',
    mutations: [
      m(replaceInFunction('maintenance.correct_closed_price_days(timestamp with time zone)', 'AND c.closed_at < m.recorded_at', 'AND false'),
        smoke('the closed day of acceptance is recomputed without the price that moved (Р-29, OQ-192)',
          'a late confirmation moves the price by a correction row, not by changing the rollup (Р-29, OQ-192)')),
      m(replaceInFunction('maintenance.correct_closed_price_days(timestamp with time zone)', "CONTINUE WHEN eff.corrected_by = 'HUMAN';", ''),
        smoke('the recomputation does not touch a day a person corrected (Р-29, OQ-192)',
          'a late confirmation moves the price by a correction row, not by changing the rollup (Р-29, OQ-192)')),
      m(replaceInFunction('maintenance.price_day_rollup(uuid,uuid,text,date,text)', 'coalesce(ap.applied_at, h.accepted_at) >= (p_day::timestamp AT TIME ZONE p_tz)', 'h.accepted_at >= (p_day::timestamp AT TIME ZONE p_tz)'),
        smoke('the price is counted in the day the channel applied it (OQ-192)',
          'a late confirmation moves the price by a correction row, not by changing the rollup (Р-29, OQ-192)')),
      m(dropTrigger('a_price_daily_system_correction_chain', 'tenant_data.price_daily_system_correction'),
        smoke('a system correction that does not continue the chain of the day (Р-29)')),
      m(dropConstraint('price_daily_system_correction_shape', 'tenant_data.price_daily_system_correction'),
        smoke('a system correction of a day with prices but without the amounts (Р-29)')),
      m(dropConstraint('price_daily_system_correction_bounds', 'tenant_data.price_daily_system_correction'),
        smoke('a system correction whose lowest price is above its highest (OQ-192)')),
      m(dropConstraint('price_daily_system_correction_reason_check', 'tenant_data.price_daily_system_correction'),
        smoke('a system correction with an unknown reason (OQ-192)')),
      m(dropTrigger('zz_append_only', 'tenant_data.price_daily_system_correction'), smoke('append-only tenant_data.price_daily_system_correction')),
      m(dropTrigger('zz_no_truncate', 'tenant_data.price_daily_system_correction'), smoke('truncate tenant_data.price_daily_system_correction')),
      // Закрытие тенанта удаляет поправки: таблица названа в очистке (правило проверки схемы шага 27, задача F)
      m(replaceInFunction('maintenance.purge_tenant_data(uuid,boolean)', ", 'tenant_data.price_daily_system_correction'", ''),
        verify('tenant_data\\.price_daily_system_correction: tenant closure does not delete the table')),
    ],
  },
  {
    row: 'шаг 27, F', invariant: 'закрытие тенанта удаляет и таблицы данных канала, которые раньше ждали срока',
    mutations: [
      m(replaceInFunction('maintenance.purge_tenant_channel_data(uuid)', "'channel_data.pricing_halt_sample', ", ''),
        verify('channel_data\\.pricing_halt_sample: tenant closure does not delete the table')),
      m(replaceInFunction('maintenance.purge_tenant_channel_data(uuid)', "'channel_data.price_decision_snapshot_ref', ", ''),
        verify('channel_data\\.price_decision_snapshot_ref: tenant closure does not delete the table')),
      m(replaceInFunction('maintenance.purge_tenant_channel_data(uuid)', "'channel_data.pricing_strategy_undercut',", ''),
        verify('channel_data\\.pricing_strategy_undercut: tenant closure does not delete the table')),
    ],
  },
];

export const STEP28_ROWS = [
  {
    row: 'Р-134', invariant: 'массовый импорт себестоимости применяется целиком: строки живут только в транзакции своего пакета, пакет приносит ровно объявленное число строк, значения пакета не выдумываются',
    mutations: [
      m(dropTrigger('zd_cost_profile_import_guard', 'tenant_data.cost_profile'),
        smoke('a cost import row that belongs to a batch of another transaction (Р-134)')),
      m(replaceInFunction('tenant_data.cost_profile_import_guard()', 'IF batch_xmin IS NULL OR NOT tenant_data.row_in_current_transaction(batch_xmin) THEN', 'IF false THEN'),
        smoke('a cost import row that belongs to a batch of another transaction (Р-134)')),
      m(dropTrigger('ze_cost_import_all_or_nothing', 'tenant_data.cost_import'),
        smoke('a cost import that brings fewer rows than it declared (Р-134)')),
      m(replaceInFunction('tenant_data.cost_import_all_or_nothing()', 'IF brought <> NEW.row_count THEN', 'IF false THEN'),
        smoke('a cost import that brings fewer rows than it declared (Р-134)')),
      m(dropConstraint('cost_profile_import_source', 'tenant_data.cost_profile'), smoke('a cost row of source IMPORT without a batch (Р-134)')),
      m(dropConstraint('cost_import_source_format_check', 'tenant_data.cost_import'), smoke('a cost import of an unknown file format (Р-134)')),
      m(dropConstraint('cost_import_source_name_check', 'tenant_data.cost_import'), smoke('a cost import without a file name (Р-134)')),
      m(dropConstraint('cost_import_row_count_check', 'tenant_data.cost_import'), smoke('a cost import of no rows (Р-134)')),
      m(dropConstraint('cost_import_fingerprint_check', 'tenant_data.cost_import'), smoke('a cost import without the fingerprint of the preview (Р-134)')),
      m(dropConstraint('cost_import_skipped_rows_check', 'tenant_data.cost_import'), smoke('a cost import with a negative number of skipped rows (Р-134)')),
      m(dropTrigger('a0_admin_write_person_insert', 'tenant_data.cost_import'),
        verify('tenant_data\\.cost_import: administrative INSERT without the person guard')),
      m(dropTrigger('zz_admin_write_audit_insert', 'tenant_data.cost_import'), verify('tenant_data\\.cost_import: administrative INSERT is not written to the audit log')),
      m(dropTrigger('zz_append_only', 'tenant_data.cost_import'), smoke('append-only tenant_data.cost_import')),
      // Страж TRUNCATE у пакета наблюдаем только без внешнего ключа строк импорта: с ключом база всегда очищает обе таблицы, и
      // отказ даёт страж строк себестоимости — чужая защита [Р-99]. Мутация снимает обе связанные вещи, иначе её видит только сосед
      m(`${dropConstraint('cost_profile_import_batch_fk', 'tenant_data.cost_profile')}; ${dropTrigger('zz_no_truncate', 'tenant_data.cost_import')}`,
        smoke('truncate tenant_data.cost_import')),
      // Закрытие тенанта удаляет пакеты импорта: таблица названа в очистке (правило проверки схемы шага 27, задача F)
      m(replaceInFunction('maintenance.purge_tenant_data(uuid,boolean)', ", 'tenant_data.cost_import'", ''),
        verify('tenant_data\\.cost_import: tenant closure does not delete the table')),
    ],
  },
  {
    row: 'Р-135', critical: true, invariant: 'массовое изменение цен требует второго фактора, и разбиение на отдельные транзакции его не обходит (риск 17)',
    mutations: [
      m(dropTrigger('zc_cost_import_requires_mfa', 'tenant_data.cost_import'), smoke('a cost import without a second factor (Р-135)')),
      // Этот страж не должен мешать законному импорту: без раннего выхода по второму фактору он отказывал бы всем
      // Шаг 30 [Р-139]: ранний выход теперь «второй фактор сессии ИЛИ применяющееся задание импорта» — текст мутации обновлён вместе с ним
      m(replaceInFunction('tenant_data.cost_import_requires_mfa()', "IF security.second_factor_present(ARRAY['COST_IMPORT']) THEN RETURN NULL; END IF;", ''),
        smoke('a cost import batch and its row in one transaction are accepted (Р-134)')),
      m(dropTrigger('zf_cost_profile_mass_window_requires_mfa', 'tenant_data.cost_profile'),
        smoke('prices of more than five offers changed within ten minutes without a second factor (Р-135)')),
      m(replaceInFunction('tenant_data.mass_change_window_requires_mfa()', 'IF offers > 5 THEN', 'IF false THEN'),
        smoke('prices of more than five offers changed within ten minutes without a second factor (Р-135)')),
      // Окно длиной в ноль внутри одной транзакции незаметно: у всех её строк время транзакции. Видно его на правках, разложенных
      // по транзакциям, — там строки прежних транзакций перестают считаться
      m(replaceInFunction('tenant_data.mass_change_window_requires_mfa()', "window_start timestamptz := now() - interval '10 minutes';", 'window_start timestamptz := now();'),
        smoke('min_price of a sixth offer within ten minutes without a second factor (Р-135)')),
      // Признак второго фактора ставит база: без него окно считало бы и законные массовые правки
      m(dropTrigger('a_cost_profile_created_with_mfa', 'tenant_data.cost_profile'),
        smoke('a manual cost edit after a second-factor mass change is still accepted (Р-135)')),
      m(dropTrigger('a_min_price_created_with_mfa', 'tenant_data.min_price'),
        smoke('a manual min_price edit after a second-factor mass change is still accepted (Р-135)')),
      m(dropTrigger('a_max_price_created_with_mfa', 'tenant_data.max_price'),
        smoke('a manual max_price edit after a second-factor mass change is still accepted (Р-135)')),
      m(dropTrigger('zf_min_price_mass_window_requires_mfa', 'tenant_data.min_price'),
        smoke('min_price of a sixth offer within ten minutes without a second factor (Р-135)')),
      m(dropTrigger('zf_max_price_mass_window_requires_mfa', 'tenant_data.max_price'),
        smoke('max_price of a sixth offer within ten minutes without a second factor (Р-135)')),
      // Ревью шага 28, находка 1: без времени транзакции у версии себестоимости окно обходится датой задним числом
      m(dropTrigger('a1_cost_profile_transaction_time', 'tenant_data.cost_profile'),
        smoke('a backdated cost version from the administrative service (Р-135)')),
      m(replaceInFunction('tenant_data.cost_version_is_transaction_time()', 'IF NEW.created_at IS DISTINCT FROM now() THEN', 'IF false THEN'),
        smoke('a backdated cost version from the administrative service (Р-135)')),
      // Ревью шага 28, находка 2: гардрейл тенанта и аккаунта — изменение массовее любого импорта
      m(dropTrigger('zg_guardrail_wide_scope_requires_mfa', 'tenant_data.guardrail'),
        smoke('a tenant-wide guardrail without a second factor (Р-135)')),
      m(replaceInFunction('tenant_data.wide_guardrail_requires_mfa()', "IF NEW.scope_type IN ('TENANT', 'CHANNEL_ACCOUNT') THEN", 'IF false THEN'),
        smoke('a tenant-wide guardrail without a second factor (Р-135)')),
      // Ревью шага 28, находка 9: окно считает предложения; если считать строки, честная ручная правка упрётся в порог
      m(replaceInFunction('tenant_data.mass_change_window_requires_mfa()', "SELECT 'PRODUCT:' || coalesce(b.product_id, w.product_id)::text FROM tenant_data.min_price b",
        "SELECT 'MIN:' || b.min_price_id::text FROM tenant_data.min_price b"),
        smoke('onboarding of offer 3 in the window is accepted without a second factor (Р-135)'),
        smoke('cost and both bounds of a fifth offer in the window are accepted without a second factor (Р-135)')),
    ],
  },
  {
    row: 'Р-138', invariant: 'комиссия от продавца — свой источник оценки и не смешивается с тарифной таблицей репозитория; пол считается по большей оценке',
    mutations: [
      m(dropConstraint('fee_estimate_source_check', 'channel_data.fee_estimate'), smoke('a fee estimate of an unknown source (Р-138)')),
      m(dropConstraint('fee_estimate_seller_declared_has_no_schedule_version', 'channel_data.fee_estimate'),
        smoke('a seller-declared fee carrying a schedule version (Р-138)')),
      m(dropConstraint('fee_estimate_schedule_version_iff', 'channel_data.fee_estimate'),
        smoke('a fee schedule estimate without its version (Р-32)')),
      // Пол считается по САМОЙ ДОРОГОЙ оценке: если брать последнюю из перебора, заниженная комиссия опускает пол [Р-83]
      m(replaceInFunction('tenant_data.effective_price_floor(uuid,uuid,timestamptz)',
        'margin_floor_minor := greatest(coalesce(margin_floor_minor, 0), candidate);',
        'margin_floor_minor := candidate;'),
        node(T('cost-import.pg.test.ts'), 'Р-138',
          ['пол считается по большей комиссии, а не по объявленной продавцом', 'дороже — не значит «больше ставка»: пол посчитан по оценке с фиксированной частью'], 'false')),
      // Задача D шага 29: гардрейл шире предложения попадает в окно массовой правки
      m(replaceInFunction('tenant_data.mass_change_window_requires_mfa()', 'IF wide THEN', 'IF false THEN'),
        smoke('a manual edit right after a tenant-wide guardrail change (Р-135)')),
    ],
  },
  {
    row: 'Р-133', invariant: 'вид повтора работы хранится в базе: у внутренних работ пауза растёт от минуты, у работ канала — от периода работы',
    mutations: [
      m(dropConstraint('scheduled_job_retry_kind_known', 'maintenance.scheduled_job'), smoke('a scheduled job with an unknown retry kind (Р-133)')),
    ],
  },
];

export const STEP30_ROWS = [
  {
    row: 'Р-139', critical: true, invariant: 'массовая операция — фоновое задание: создаёт человек со вторым фактором и правом, ведёт роль исполнителя, итог не переписывается',
    mutations: [
      // Создание задания — административная запись человека: автор и аудит [Р-97]
      /**
       * Страж и аудит административной записи на таблице заданий. Своя проверка — правило проверки схемы: на этой таблице
       * «человек в сессии» дублируется столбцом автора (NOT NULL), а проверка участника из стража удалена ещё шагом 19 как
       * дубль журнала аудита [Р-104]. Правило же видит ровно отсутствие стража.
       */
      m(dropTrigger('a0_admin_write_person_insert', 'tenant_data.bulk_job'),
        verify('tenant_data\\.bulk_job: administrative INSERT without the person guard')),
      m(dropTrigger('zz_admin_write_audit_insert', 'tenant_data.bulk_job'),
        smoke('creating a bulk job is written to the audit log (Р-97)'),
        verify('tenant_data\\.bulk_job: administrative INSERT is not written to the audit log')),
      // Р-135: второй фактор предъявляется при создании задания, меняющего цены; ставит признак база, а не вызывающий [Р-90]
      m(dropTrigger('zb_bulk_job_requires_mfa', 'tenant_data.bulk_job'), smoke('cost import job created without a second factor (Р-135, Р-139)')),
      m(dropTrigger('a_bulk_job_created_with_mfa', 'tenant_data.bulk_job'),
        smoke('the database sets the second factor of a bulk job, not the caller (Р-90)')),
      // Р-100: право — по тому, что задание делает; выгрузка доказательства доступна и зрителю
      m(dropTrigger('zc_bulk_job_requires_right', 'tenant_data.bulk_job'), smoke('cost import job created by a viewer with a second factor (Р-100, Р-139)')),
      // Аренда: чужую живую аренду не перехватить и не отпустить — иначе задание применилось бы дважды
      m(dropTrigger('a_bulk_job_lease_guard', 'tenant_data.bulk_job'),
        smoke('another process takes a live lease of a bulk job (Р-139)'),
        smoke('another process releases a live lease of a bulk job (Р-139)')),
      // Итог задания неизменяем, и задание не прыгает через состояния
      m(dropTrigger('b_bulk_job_status_forward_only', 'tenant_data.bulk_job'),
        smoke('a finished bulk job is started again (Р-139)'),
        smoke('a pending bulk job jumps straight to succeeded (Р-139)')),
      // Виды значений строки задания: экран хода читает их как данность
      m(dropConstraint('bulk_job_kind_known', 'tenant_data.bulk_job'), smoke('bulk job of an unknown kind')),
      m(dropConstraint('bulk_job_status_known', 'tenant_data.bulk_job'), smoke('bulk job in an unknown status')),
      m(dropConstraint('bulk_job_phase_known', 'tenant_data.bulk_job'), smoke('bulk job in an unknown phase')),
      m(dropConstraint('bulk_job_total_non_negative', 'tenant_data.bulk_job'), smoke('bulk job with a negative total')),
      m(dropConstraint('bulk_job_done_non_negative', 'tenant_data.bulk_job'), smoke('bulk job with a negative progress')),
      m(dropConstraint('bulk_job_attempts_non_negative', 'tenant_data.bulk_job'), smoke('bulk job with a negative attempt count')),
      m(dropConstraint('bulk_job_lease_pair', 'tenant_data.bulk_job'), smoke('bulk job leased by nobody until a moment')),
      m(dropConstraint('bulk_job_finished_has_outcome', 'tenant_data.bulk_job'), smoke('bulk job finished without a moment of finishing')),
      m(dropConstraint('bulk_job_failed_has_reason', 'tenant_data.bulk_job'), smoke('bulk job failed without a reason')),
      // Файл задания [OQ-202]: продавец сверяет контрольную сумму с тем, что скачал
      m(dropConstraint('bulk_job_artifact_file_name_check', 'tenant_data.bulk_job_artifact'), smoke('artifact with an empty file name')),
      m(dropConstraint('bulk_job_artifact_content_type_check', 'tenant_data.bulk_job_artifact'), smoke('artifact of a kind the console cannot show')),
      // Шаг 32 [Р-104]: проверка формата суммы удалена как дубль — страж Р-145 требует не «похоже на сумму», а «эта сумма этого файла»
      m(dropConstraint('bulk_job_artifact_rows_count_check', 'tenant_data.bulk_job_artifact'), smoke('artifact with a negative row count')),
      /**
       * OQ-207 (шаг 31): отмена и предел очереди. Отмена — административная запись ЧЕЛОВЕКА: у неё автор и строка аудита, как
       * у создания задания; очередь тенанта одна, и без предела один участник задерживает массовые операции всех остальных.
       */
      m(dropTrigger('a0_admin_write_person_update', 'tenant_data.bulk_job'),
        verify('tenant_data\\.bulk_job: administrative UPDATE without the person guard')),
      m(dropTrigger('zz_admin_write_audit_update', 'tenant_data.bulk_job'),
        smoke('cancelling a bulk job is written to the audit log (Р-97)'),
        verify('tenant_data\\.bulk_job: administrative UPDATE is not written to the audit log')),
      m(dropTrigger('zd_bulk_job_queue_limit', 'tenant_data.bulk_job'), smoke('a member queues more bulk jobs than their own limit (OQ-207)')),
      // Отмена — только у ждущего задания: применение целиком или никак, и на полпути его не отменяют [Р-134]
      m(replaceInFunction('tenant_data.bulk_job_status_forward_only()', "IF NEW.status = 'CANCELLED' AND OLD.status <> 'PENDING' THEN", 'IF false THEN'),
        smoke('a running bulk job is cancelled halfway (Р-134, OQ-207)')),
      /**
       * Сам механизм «второй фактор предъявлен при создании задания» [Р-139]. Снимаем по одному условию: вид задания, живая
       * аренда, состояние «выполняется» и признак второго фактора при создании. Без каждого из них массовое изменение цен
       * открывается тем, чем открываться не должно, — и это ловит свой тест.
       */
      m(replaceInFunction('security.second_factor_present(text[])', 'AND j.kind = ANY (p_kinds)', 'AND true'),
        node(T('cost-import.pg.test.ts'), 'задание НЕ ТОГО вида', 'задание выгрузки не открывает импорт себестоимости', '^APPLIED$')),
      /**
       * Р-143 (шаг 31): записи задания, которому второй фактор предъявлен при создании, помечаются подтверждёнными. Иначе
       * окно массовой правки [Р-135] считает своими ровно те правки, которые человек только что подтвердил.
       */
      m(replaceInFunction('tenant_data.mark_created_with_mfa()', "security.second_factor_present(ARRAY['COST_IMPORT', 'BOUNDS_EDIT'])", 'security.session_mfa()'),
        node(T('cost-import.pg.test.ts'), 'помечена как подтверждённая вторым фактором',
          'запись задания подтверждена вторым фактором, который человек предъявил при его создании', '^false$')),
      m(replaceInFunction('security.second_factor_present(text[])', 'AND j.created_with_mfa', 'AND true'),
        node(T('cost-import.pg.test.ts'), 'не открывает массовую правку',
          'массовая правка под заданием без второго фактора не проходит', '^APPLIED$')),
      m(replaceInFunction('security.second_factor_present(text[])', "AND j.status = 'RUNNING' AND j.lease_until > now()", 'AND true'),
        node(T('cost-import.pg.test.ts'), 'завершённое задание', 'завершённое задание не открывает массовое изменение', '^APPLIED$')),
      /**
       * Р-143 (шаг 31), OQ-210: вид задания, которому второй фактор не нужен, не может стоять в списке стража. Ровно эта
       * ошибка и была на шаге 30 у стража широкого гардрейла, и нашла её тогда мутационная проверка, а не правило схемы.
       */
      /**
       * Сам список видов, которым второй фактор не нужен (находка 9 ревью шага 31). Добавить в него вид, который МЕНЯЕТ цены,
       * значит снять право `MANAGE_PRICING` при создании такого задания — первый рубеж, — и правило 14г этого не увидит: оно
       * смотрит на аргументы стражей, а не на сам список.
       */
      m(replaceInFunction('security.read_only_job_kinds()', "ARRAY['BOUNDS_PLAN', 'STRATEGY_PREVIEW', 'PRICE_EVIDENCE', 'PRICE_FEED_EXPORT']",
        "ARRAY['BOUNDS_PLAN', 'STRATEGY_PREVIEW', 'PRICE_EVIDENCE', 'PRICE_FEED_EXPORT', 'COST_IMPORT']"),
        smoke('cost import job created by a viewer with a second factor (Р-100, Р-139)')),
      m(replaceInFunction('tenant_data.cost_import_requires_mfa()', "ARRAY['COST_IMPORT']", "ARRAY['COST_IMPORT', 'PRICE_EVIDENCE']"),
        verify('a bulk job kind that needs no second factor \\(PRICE_EVIDENCE\\) opens an operation that needs one')),
      // Страж широкого гардрейла требует второго фактора ЧЕЛОВЕКА: задание пол маржи всего тенанта не меняет [Р-139]
      m(replaceInFunction('tenant_data.wide_guardrail_requires_mfa()', 'IF security.session_mfa() THEN RETURN NULL; END IF;',
        "IF security.second_factor_present(ARRAY['PRICE_EVIDENCE']) THEN RETURN NULL; END IF;"),
        node(T('cost-import.pg.test.ts'), 'не открывает гардрейл уровня тенанта',
          'гардрейл всего тенанта требует второго фактора человека', '^accepted$')),
    ],
  },

];

/**
 * Шаг 32 [Р-145]: выгрузка идёт ОДНИМ путём, и база это проверяет. До шага 32 у таблицы файлов задания не было ни одной
 * защиты: файл клался любому заданию, с любой контрольной суммой, любому виду задания. Каждый страж снимается своей мутацией.
 */
export const STEP32_ROWS = [
  {
    row: 'Р-145', critical: true,
    invariant: 'файл задания собирается одним путём: контрольную сумму считает база, файл кладётся к своему идущему заданию и только у вида, который файлы делает',
    mutations: [
      // Сумма, объявленная тем же кодом, который собрал файл, подтверждает только себя: база считает её сама
      m(dropTrigger('a_bulk_job_artifact_digest_matches', 'tenant_data.bulk_job_artifact'),
        smoke('a file whose checksum does not match its content (Р-145)')),
      // Файл кладётся к СВОЕМУ идущему заданию: процесс, потерявший аренду, не дописывает чужое
      m(replaceInFunction('tenant_data.bulk_job_artifact_own_job()',
        "IF j.status <> 'RUNNING' OR j.lease_until <= now()\n     OR j.lease_owner IS DISTINCT FROM nullif(current_setting('app.bulk_lease_owner', true), '') THEN",
        'IF false THEN'),
        smoke('a file written to a job this process does not lease (Р-145)')),
      // Файл бывает только у вида задания, который файлы и делает
      m(replaceInFunction('tenant_data.bulk_job_artifact_own_job()',
        'IF j.kind NOT IN (SELECT k FROM security.file_producing_job_kinds() AS k) THEN', 'IF false THEN'),
        smoke('a file attached to a job kind that gives the seller no file (Р-145)')),
      // Сам список видов, отдающих файл: добавить в него вид, который файлов не делает, — снять страж для него
      m(replaceInFunction('security.file_producing_job_kinds()', "ARRAY['COST_IMPORT', 'PRICE_EVIDENCE', 'PRICE_FEED_EXPORT']",
        "ARRAY['COST_IMPORT', 'PRICE_EVIDENCE', 'PRICE_FEED_EXPORT', 'BOUNDS_EDIT']"),
        smoke('a file attached to a job kind that gives the seller no file (Р-145)')),
      /**
       * Правило 14д: список называет вид, которого нет. Опечатка молча выводит вид из-под правила, и ни один тест её не
       * заметит — каждый смотрит на свой вид. Ловит это только проверка схемы.
       */
      m(replaceInFunction('security.file_producing_job_kinds()', "'PRICE_FEED_EXPORT'", "'PRICE_FEED_EXPORTS'"),
        verify('names a bulk job kind that does not exist: PRICE_FEED_EXPORTS')),
    ],
  },
];
