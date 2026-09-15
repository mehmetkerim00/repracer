import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ALL_REASON_CODES, boundDeviationBp, buildExplanation, can, CHANNEL_PARAM_KEYS, channelKeysIn, classifyBoundIntervention, ENGINE_REASON_CODES, explainedReason,
  GATE_REASON_CODES, marginBpAtPrice, PIPELINE_REASON_CODES, REASON_PARAMS, SANITY_NOTE_PARAMS, SANITY_REASON_CODES, SANITY_WARNING_CODES, stopCovers,
  storefrontPriceForMarginBp, summarizeSanity, validateReason, type CostInputs, type PriceDecisionDraft, type PriceIntentDraft,
  expandExplanation, explanationRowOf,
  type GateProfile,
  type SanityRuleset,
  type StrategyDefinition,
} from './index.ts';

const cost: CostInputs = { currency: 'EUR', costProfileId: 'cp-1', unitCostMinor: 1000, fixedFeeMinor: 0, feeRateBp: 1500, tax: { regime: 'VAT_INCLUDED', vatRateBp: 1900 } };

test('gross price for margin is the smallest price reaching the margin', () => {
  const r = storefrontPriceForMarginBp(cost, 2000);
  assert.deepEqual(r, { ok: true, priceMinor: 1915 });
  assert.ok((marginBpAtPrice(cost, 1915) ?? -1) >= 2000);
  assert.ok((marginBpAtPrice(cost, 1914) ?? 99_999) < 2000);
});

test('margin math fails closed', () => {
  const noVat: CostInputs = { ...cost, tax: { regime: 'VAT_INCLUDED', vatRateBp: null } };
  assert.deepEqual(storefrontPriceForMarginBp(noVat, 2000), { ok: false, cause: 'VAT_UNKNOWN' });
  assert.deepEqual(storefrontPriceForMarginBp({ ...cost, feeRateBp: 9000 }, 2000), { ok: false, cause: 'UNATTAINABLE' });
  assert.equal(marginBpAtPrice(noVat, 1915), null);
  assert.ok((marginBpAtPrice(cost, 500) ?? 0) < 0);
});

test('Р-58: the same cost gives a lower floor for a net US price than for a gross EU price', () => {
  const usd: CostInputs = { ...cost, currency: 'USD', tax: { regime: 'SALES_TAX_EXCLUDED' } };
  assert.deepEqual(storefrontPriceForMarginBp(usd, 2000), { ok: true, priceMinor: 1539 });
});

test('Р-72: every reason code has a parameter schema, no texts; one parameter name has one source class everywhere', () => {
  const layers = [SANITY_REASON_CODES, SANITY_WARNING_CODES, ENGINE_REASON_CODES, GATE_REASON_CODES, PIPELINE_REASON_CODES] as readonly (readonly string[])[];
  const shared = [...new Set(layers.flat())].filter((c) => layers.filter((l) => l.includes(c)).length > 1);
  assert.deepEqual(shared, ['CHANNEL_HALTED']);
  assert.deepEqual(Object.keys(REASON_PARAMS).sort(), [...ALL_REASON_CODES].sort());
  const classOf = new Map<string, Set<string>>();
  for (const schema of [...Object.values(REASON_PARAMS), ...Object.values(SANITY_NOTE_PARAMS)]) {
    for (const [key, spec] of Object.entries(schema)) classOf.set(key, (classOf.get(key) ?? new Set()).add(spec.class === 'CHANNEL' ? 'CHANNEL' : 'OTHER'));
    // Р-71: причина с суммой объявляет валюту
    if (Object.values(schema).some((s) => s.kind === 'money')) assert.ok(schema.currency, `money without currency in ${JSON.stringify(Object.keys(schema))}`);
  }
  assert.deepEqual([...classOf].filter(([, c]) => c.size > 1).map(([k]) => k), []);
  assert.ok(CHANNEL_PARAM_KEYS.includes('buyboxMinor') && !CHANNEL_PARAM_KEYS.includes('proposedMinor'));
});

test('Р-71: an amount without currency, an undeclared or mistyped parameter is a problem', () => {
  assert.deepEqual(validateReason({ code: 'ABOVE_MAX_PRICE', params: { proposedMinor: 3500, maxMinor: 3000, currency: 'EUR' } }), []);
  assert.match(validateReason({ code: 'ABOVE_MAX_PRICE', params: { proposedMinor: 3500, maxMinor: 3000 } }).join(), /currency: missing.*amount without currency/);
  assert.match(validateReason({ code: 'INTENT_INVALID', params: { detail: 'write scope mismatch' } }).join(), /undeclared parameter.*problem: missing/);
  assert.match(validateReason({ code: 'WRITE_SCOPE_BLOCKED', params: { code: 'AUTH_EXPIRED', action: 'PANIC' } }).join(), /action: one of/);
});

test('Р-74, Р-75, Р-80: the explanation references dictionaries, repeats no row columns, keeps no channel values and expands back to the full view', () => {
  const sanityRuleset: SanityRuleset = {
    rulesetId: 'r49.1', kind: 'SANITY',
    definition: { rules: ['CHANNEL_HALTED', 'STRUCTURE', 'HISTORY_ANCHOR', 'INTERNAL_ANCHOR'], config: { TOO_FEW_COMPETITOR_OFFERS: { minOffers: 3 } } },
  };
  const gate: GateProfile = { rulesetId: 'g74.1', kind: 'GATE', definition: { CHANGED: ['PRICE_STOP', 'LOWER_BOUND'], NO_OP: ['PRICE_STOP'] } };
  const strategy: StrategyDefinition = { strategyId: 'st', version: 3, params: { type: 'MATCH_BUYBOX', undercutMinor: 5, holdWhenWinning: true, atBound: 'CAP' }, deadbandMinor: 0 };
  const intent: PriceIntentDraft = {
    writeScopeId: 'ws', strategyId: 'st', strategyVersion: 3, trigger: { type: 'COMPETITOR_CHANGE' }, ruleCode: 'MATCH_BUYBOX', intentClass: 'CHANGED',
    proposedMinor: 1775, currentMinor: 1850, referenceMinor: 1780, currency: 'EUR', basis: 'GROSS',
    reason: { code: 'BUYBOX_UNDERCUT', params: { buyboxMinor: 1780, undercutMinor: 5, targetMinor: 1775, currency: 'EUR' } },
    explanation: [{ code: 'BUYBOX_UNDERCUT', params: { buyboxMinor: 1780, undercutMinor: 5, targetMinor: 1775, currency: 'EUR' } }],
    inputs: { boundsAtStrategy: { minMinor: 1500, maxMinor: 2500 } }, createdAt: '2026-09-15T10:00:00.000Z', expiresAt: '2026-09-15T10:10:00.000Z',
  };
  const decision: PriceDecisionDraft = {
    writeScopeId: 'ws', outcome: 'APPROVED', decisionClass: 'CHANGED', finalMinor: 1775, currency: 'EUR', basis: 'GROSS', effectiveFloorMinor: 1500,
    effectiveCeilingMinor: 2500, minPriceIds: [], maxPriceIds: [], guardrailIds: [], rejectionReason: null,
    reason: { code: 'APPROVED', params: { finalMinor: 1775, floorMinor: 1500, ceilingMinor: 2500, currency: 'EUR' } },
    checks: [{ check: 'PRICE_STOP', passed: true, detail: null }, { check: 'LOWER_BOUND', passed: true, detail: null }],
    alert: null, decidedAt: '2026-09-15T10:00:00.000Z', boundDeviationBp: null,
  };
  const sanity = summarizeSanity({
    ruleset: 'r49.1', anchorsUsed: ['HISTORY'], warnings: [],
    checks: [
      { rule: 'CHANNEL_HALTED', outcome: 'PASS' },
      { rule: 'STRUCTURE', outcome: 'PASS' },
      { rule: 'HISTORY_ANCHOR', outcome: 'PASS', detail: { code: 'HISTORY_AVAILABLE', params: { days: 20 } } },
      { rule: 'INTERNAL_ANCHOR', outcome: 'SKIPPED', detail: { code: 'TOO_FEW_COMPETITOR_OFFERS', params: { offers: 1, minOffers: 3 } } },
    ],
  }, sanityRuleset);
  const input = { snapshot: { source: 'KAUFLAND_BUYBOX' }, sanity, intent, decision, minMarginBp: null, channelHalt: null, priceStop: null };
  const built = buildExplanation(input, gate);
  const explanation = built.explanation;
  assert.deepEqual([built.gateProfile, built.sanityRuleset], ['g74.1', 'r49.1']);
  const rowOf = (d: PriceDecisionDraft, refs: { gateProfile: string | null; sanityRuleset: string | null }) =>
    explanationRowOf({ ...intent, trigger: intent.trigger.type }, { ...d, ...refs });
  const row = rowOf(decision, built);
  assert.deepEqual(channelKeysIn(explanation), []);
  // Прошедшие правила без пояснения и порог набора не дублируются; проверки Gate и параметры стратегии — в справочниках
  assert.deepEqual(explanation.sanity!.checks, [
    { rule: 'HISTORY_ANCHOR', outcome: 'PASS', detail: { code: 'HISTORY_AVAILABLE' } },
    { rule: 'INTERNAL_ANCHOR', outcome: 'SKIPPED', detail: { code: 'TOO_FEW_COMPETITOR_OFFERS' } },
  ]);
  assert.equal(explanation.gate, undefined, 'an approved decision without margin floor or rate keeps nothing of the Gate: all is in columns');
  assert.equal('params' in explanation.strategy, false);
  // Р-80: столбцы строки не повторяются в слепке
  for (const key of ['strategyId', 'version', 'ruleCode', 'trigger', 'proposedMinor']) assert.equal(key in explanation.strategy, false, key);
  assert.equal('ruleset' in explanation.sanity!, false);
  assert.equal(explanation.strategy.steps, undefined, 'the chain is the reason itself');
  // Обязательный ключ канала buyboxMinor не перечисляется: реестр знает его; развёрнутая причина помечает его вырезанным
  // Р-85: цель «Buy Box минус подрез» — производная от цены конкурента, в слепке её нет; реестр знает ключ
  assert.deepEqual(explanation.strategy.reason, { code: 'BUYBOX_UNDERCUT', params: { currency: 'EUR' } });

  const { value, gaps } = expandExplanation(explanation, row, { rulesets: [sanityRuleset, gate], strategies: [strategy] });
  assert.deepEqual(gaps, []);
  assert.deepEqual(value.sanity!.checks.map((c) => [c.rule, c.outcome]), [['CHANNEL_HALTED', 'PASS'], ['STRUCTURE', 'PASS'], ['HISTORY_ANCHOR', 'PASS'], ['INTERNAL_ANCHOR', 'SKIPPED']]);
  assert.deepEqual(value.sanity!.checks[3]!.detail, { code: 'TOO_FEW_COMPETITOR_OFFERS', params: { minOffers: 3 }, withheld: ['offers'] });
  assert.deepEqual(value.gate.checks, [{ check: 'PRICE_STOP', passed: true, detail: null }, { check: 'LOWER_BOUND', passed: true, detail: null }]);
  assert.deepEqual([value.gate.profileKnown, value.gate.notRun, value.gate.reason.code, value.gate.floorMinor, value.strategy.proposedMinor, value.strategy.ruleCode, value.sanity!.ruleset],
    [true, [], 'APPROVED', 1500, 1775, 'MATCH_BUYBOX', 'r49.1']);
  assert.deepEqual([value.strategy.type, value.strategy.params.undercutMinor, value.strategy.params.currency], ['MATCH_BUYBOX', 5, 'EUR']);
  assert.deepEqual(value.strategy.steps.map((r) => r.code), ['BUYBOX_UNDERCUT']);
  // Р-91: подрез в слепке не хранится, развёрнутый вид берёт его из версии стратегии, пока он у неё есть
  assert.deepEqual(value.strategy.reason, { code: 'BUYBOX_UNDERCUT', params: { undercutMinor: 5, currency: 'EUR' }, withheld: ['buyboxMinor', 'targetMinor'] });
  // Необязательный ключ канала сохраняется в списке: без него нельзя отличить «не было» от «вырезано»
  assert.deepEqual(explainedReason({ code: 'INVALID_AMOUNT', params: { field: 'OFFER_PRICE', offerRank: 2 } }), { code: 'INVALID_AMOUNT', params: { field: 'OFFER_PRICE' }, withheld: ['offerRank'] });
  // Без справочников — названные пробелы, а не пустота
  const bare = expandExplanation(explanation, row, { rulesets: [], strategies: [] });
  assert.deepEqual(bare.gaps.map((g) => g.kind).sort(), ['GATE_PROFILE', 'SANITY_RULESET', 'STRATEGY']);
  assert.equal(bare.value.gate.profileKnown, false, 'without the profile the order of Gate checks is unknown, not assumed (finding 8)');

  // Отказ Gate: только непрошедшая проверка, прошедшие до неё — из профиля
  const failedDetail = { code: 'BELOW_MIN_PRICE' as const, params: { proposedMinor: 1485, minMinor: 1500, deviationBp: 100, currency: 'EUR' } };
  const rejectedDecision: PriceDecisionDraft = {
    ...decision, outcome: 'REJECTED', decisionClass: 'REJECTED_BY_GATE', finalMinor: null, rejectionReason: 'BELOW_MIN_PRICE', boundDeviationBp: 100,
    reason: failedDetail, checks: [{ check: 'PRICE_STOP', passed: true, detail: null }, { check: 'LOWER_BOUND', passed: false, detail: failedDetail }],
  };
  const rejected = buildExplanation({ ...input, decision: rejectedDecision }, gate);
  assert.equal(rejected.explanation.gate?.failed?.check, 'LOWER_BOUND');
  const rejectedView = expandExplanation(rejected.explanation, rowOf(rejectedDecision, rejected), { rulesets: [gate], strategies: [strategy] }).value.gate;
  assert.deepEqual(rejectedView.checks.map((c) => [c.check, c.passed]), [['PRICE_STOP', true], ['LOWER_BOUND', false]]);
  assert.deepEqual([rejectedView.reason.code, rejectedView.reason.params.minMinor, rejectedView.boundDeviationBp], ['BELOW_MIN_PRICE', 1500, 100]);

  // Р-74: у NO_OP слепка нет; порядок проверок не по профилю — ошибка кода, а не молча другой слепок
  assert.throws(() => buildExplanation({ ...input, decision: { ...decision, outcome: 'NO_CHANGE', decisionClass: 'NO_OP' } }, gate), /Р-74/);
  assert.throws(() => buildExplanation({ ...input, decision: { ...decision, checks: [{ check: 'LOWER_BOUND', passed: true, detail: null }] } }, gate), /Р-75/);
  assert.throws(() => summarizeSanity({ ruleset: 'r49.1', anchorsUsed: [], warnings: [], checks: [] }, sanityRuleset), /Р-75/);
  // Порог, отличный от набора, остаётся в слепке
  assert.deepEqual(explainedReason({ code: 'TOO_FEW_COMPETITOR_OFFERS', params: { offers: 1, minOffers: 5 } }, { minOffers: 3 }).params, { minOffers: 5 });
  assert.deepEqual(explainedReason({ code: 'UNKNOWN_CODE', params: { x: 1 } }).withheld, ['x'], 'undeclared parameters are withheld (fail-closed)');
});

test('Р-69, Р-70, Р-73: stop coverage, roles and dangerous changes', () => {
  assert.equal(stopCovers({ scope: 'TENANT', channelAccountId: null, marketplace: null }, 'any-account', 'de'), true);
  assert.equal(stopCovers({ scope: 'STOREFRONT', channelAccountId: 'a', marketplace: 'de' }, 'a', 'at'), false);
  assert.equal(stopCovers({ scope: 'CHANNEL_ACCOUNT', channelAccountId: 'a', marketplace: null }, 'a', 'at'), true);
  assert.deepEqual([can('OWNER', 'RESUME_TENANT_STOP'), can('OPERATOR', 'RESUME_TENANT_STOP'), can('OPERATOR', 'STOP_PRICING'), can('VIEWER', 'STOP_PRICING')], [true, false, true, false]);
  // OQ-129: администратор возобновляет тенант, менеджер цен останавливает, менеджер остатков — нет
  assert.deepEqual([can('ADMIN', 'RESUME_TENANT_STOP'), can('PRICING_MANAGER', 'STOP_PRICING'), can('PRICING_MANAGER', 'RESUME_TENANT_STOP'), can('INVENTORY_MANAGER', 'STOP_PRICING')], [true, true, false, false]);
  assert.equal(boundDeviationBp(3830, 2500), 5320);
  assert.equal(classifyBoundIntervention(boundDeviationBp(1100, 1000)), 'CORRECTED', 'exactly 10 % is corrected, not dangerous');
  assert.equal(classifyBoundIntervention(boundDeviationBp(1101, 1000)), 'DANGEROUS');
});
