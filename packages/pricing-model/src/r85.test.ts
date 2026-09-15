import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildExplanation, eternalCoreOf, type GateProfile, type PriceDecisionDraft, type PriceIntentDraft, type Reason, type StrategyDefinition } from './index.ts';

/**
 * Р-85: вечное ядро (слепок и столбцы, которые ядро хранит вместе со справочником стратегий) не позволяет ВОССТАНОВИТЬ цену
 * конкурента. Проверка — перебор: цена конкурента выводится, если в ядре есть число, равное ей или отличающееся на подрез
 * стратегии. Опубликованная цена (итог CHANGED) — наша цена [Р-3], хранится вечно для Omnibus [Р-21] и в перебор не входит;
 * вывод цены конкурента из опубликованной цены и подреза — остаток, вопрос владельцу (OQ-142).
 * Данные синтетические.
 */

const gate: GateProfile = {
  rulesetId: 'g74.1', kind: 'GATE',
  definition: { CHANGED: ['PRICE_STOP', 'LOWER_BOUND', 'UPPER_BOUND'], NO_OP: ['PRICE_STOP', 'CURRENT_WITHIN_BOUNDS'] },
};
const BUYBOX = 1780;
const LOWEST = 1720;
const UNDERCUT = 5;
const strategy: StrategyDefinition = { strategyId: 'st', version: 1, params: { type: 'MATCH_BUYBOX', undercutMinor: UNDERCUT, holdWhenWinning: true, atBound: 'CAP' }, deadbandMinor: 0 };

const baseIntent = (over: Partial<PriceIntentDraft>): PriceIntentDraft => ({
  writeScopeId: 'ws', strategyId: 'st', strategyVersion: 1, trigger: { type: 'COMPETITOR_CHANGE' }, ruleCode: 'MATCH_BUYBOX', intentClass: 'CHANGED',
  proposedMinor: BUYBOX - UNDERCUT, currentMinor: 1850, referenceMinor: BUYBOX, currency: 'EUR', basis: 'GROSS',
  reason: { code: 'BUYBOX_UNDERCUT', params: { buyboxMinor: BUYBOX, undercutMinor: UNDERCUT, targetMinor: BUYBOX - UNDERCUT, currency: 'EUR' } },
  explanation: [], inputs: { boundsAtStrategy: { minMinor: 1500, maxMinor: 2500 } }, createdAt: '2026-09-15T10:00:00.000Z', expiresAt: '2026-09-15T10:10:00.000Z', ...over,
});
const baseDecision = (over: Partial<PriceDecisionDraft>): PriceDecisionDraft => ({
  writeScopeId: 'ws', outcome: 'APPROVED', decisionClass: 'CHANGED', finalMinor: BUYBOX - UNDERCUT, currency: 'EUR', basis: 'GROSS', effectiveFloorMinor: 1500,
  effectiveCeilingMinor: 2500, minPriceIds: [], maxPriceIds: [], guardrailIds: [], rejectionReason: null,
  reason: { code: 'APPROVED', params: { finalMinor: BUYBOX - UNDERCUT, floorMinor: 1500, ceilingMinor: 2500, currency: 'EUR' } },
  checks: [{ check: 'PRICE_STOP', passed: true, detail: null }, { check: 'LOWER_BOUND', passed: true, detail: null }, { check: 'UPPER_BOUND', passed: true, detail: null }],
  alert: null, decidedAt: '2026-09-15T10:00:00.000Z', boundDeviationBp: null, ...over,
});

function numbersIn(value: unknown, out: number[] = []): number[] {
  if (typeof value === 'number') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => numbersIn(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => numbersIn(v, out));
  return out;
}

/** Числа вечного ядра, из которых выводится цена конкурента (по совпадению или со сдвигом на подрез) */
function recoverable(stored: unknown, channelValues: number[], published: number | null): number[] {
  const numbers = numbersIn(stored).filter((n) => n !== published);
  return numbers.filter((n) => channelValues.some((c) => n === c || n + UNDERCUT === c || n - UNDERCUT === c));
}

function eternal(intent: PriceIntentDraft, decision: PriceDecisionDraft) {
  const built = buildExplanation({ snapshot: { source: 'KAUFLAND_BUYBOX' }, sanity: null, intent, decision, minMarginBp: null, channelHalt: null, priceStop: null }, gate);
  return eternalCoreOf(intent, decision, built);
}

test('Р-85: a capped Buy Box target is not kept — the uncapped target would give the Buy Box price', () => {
  const target = 1400;
  const intent = baseIntent({
    proposedMinor: 1500, referenceMinor: 1405,
    reason: { code: 'CAPPED_AT_MIN_PRICE', params: { targetMinor: target, minMinor: 1500, currency: 'EUR' } },
    explanation: [{ code: 'BUYBOX_UNDERCUT', params: { buyboxMinor: 1405, undercutMinor: UNDERCUT, targetMinor: target, currency: 'EUR' } }, { code: 'CAPPED_AT_MIN_PRICE', params: { targetMinor: target, minMinor: 1500, currency: 'EUR' } }],
  });
  const decision = baseDecision({ finalMinor: 1500, reason: { code: 'APPROVED', params: { finalMinor: 1500, floorMinor: 1500, ceilingMinor: 2500, currency: 'EUR' } } });
  assert.deepEqual(recoverable(eternal(intent, decision), [1405], 1500), []);
});

test('Р-85: a rejected competitor-derived proposal keeps neither the proposed price nor its deviation from the bound', () => {
  const proposed = LOWEST - UNDERCUT;
  const intent = baseIntent({
    ruleCode: 'BEAT_LOWEST', proposedMinor: proposed, referenceMinor: LOWEST, intentClass: 'CHANGED',
    reason: { code: 'LOWEST_UNDERCUT', params: { lowestMinor: LOWEST, undercutMinor: UNDERCUT, scope: 'ALL', n: 3, targetMinor: proposed, currency: 'EUR' } },
    explanation: [{ code: 'LOWEST_UNDERCUT', params: { lowestMinor: LOWEST, undercutMinor: UNDERCUT, scope: 'ALL', n: 3, targetMinor: proposed, currency: 'EUR' } }],
  });
  const detail = { code: 'BELOW_MIN_PRICE' as const, params: { proposedMinor: proposed, minMinor: 1800, deviationBp: 473, currency: 'EUR' } };
  const decision = baseDecision({
    outcome: 'REJECTED', decisionClass: 'REJECTED_BY_GATE', finalMinor: null, rejectionReason: 'BELOW_MIN_PRICE', boundDeviationBp: 473, effectiveFloorMinor: 1800,
    reason: detail, checks: [{ check: 'PRICE_STOP', passed: true, detail: null }, { check: 'LOWER_BOUND', passed: false, detail }],
  });
  const stored = eternal(intent, decision);
  assert.deepEqual(recoverable(stored, [LOWEST], null), []);
  // Отклонение от границы с границей даёт предложенную цену с точностью до базисного пункта
  assert.equal(numbersIn(stored).includes(473), false, 'bound deviation of a competitor-derived rejection is not kept');
});

test('Р-85: an approved Buy Box undercut keeps only the published price — the target is not repeated', () => {
  const intent = baseIntent({ explanation: [{ code: 'BUYBOX_UNDERCUT', params: { buyboxMinor: BUYBOX, undercutMinor: UNDERCUT, targetMinor: BUYBOX - UNDERCUT, currency: 'EUR' } }] });
  const stored = eternal(intent, baseDecision({}));
  assert.deepEqual(recoverable(stored, [BUYBOX], BUYBOX - UNDERCUT), []);
  assert.equal(JSON.stringify(stored.explanation).includes('targetMinor'), false);
});

/** Отклонённая Gate цена из данных конкурентов: что осталось бы в вечном ядре */
function rejected(ruleCode: 'MATCH_BUYBOX' | 'BEAT_LOWEST', proposed: number, reference: number, detail: Reason, deviation: number | null) {
  const intent = baseIntent({
    ruleCode, proposedMinor: proposed, referenceMinor: reference,
    reason: { code: 'BUYBOX_UNDERCUT', params: { buyboxMinor: reference, undercutMinor: UNDERCUT, targetMinor: proposed, currency: 'EUR' } },
    explanation: [{ code: 'BUYBOX_UNDERCUT', params: { buyboxMinor: reference, undercutMinor: UNDERCUT, targetMinor: proposed, currency: 'EUR' } }],
  });
  // Проверки — в порядке профиля: прошедшие до отказавшей, затем отказавшая [Р-75]
  const failed = detail.code === 'STEP_LIMIT' ? 'STEP' : detail.code === 'ABOVE_MAX_PRICE' ? 'UPPER_BOUND' : 'LOWER_BOUND';
  const order = gateWithStep.definition.CHANGED;
  const checks = [...order.slice(0, order.indexOf(failed)).map((check) => ({ check, passed: true, detail: null })), { check: failed, passed: false, detail }];
  const decision = baseDecision({
    outcome: 'REJECTED', decisionClass: 'REJECTED_BY_GATE', finalMinor: null, rejectionReason: detail.code as PriceDecisionDraft['rejectionReason'], boundDeviationBp: deviation,
    reason: detail, checks,
  });
  const built = buildExplanation({ snapshot: { source: 'KAUFLAND_BUYBOX' }, sanity: null, intent, decision, minMarginBp: null, channelHalt: null, priceStop: null }, gateWithStep);
  return eternalCoreOf(intent, decision, built);
}

const gateWithStep: GateProfile = { rulesetId: 'g74.1', kind: 'GATE', definition: { CHANGED: ['PRICE_STOP', 'LOWER_BOUND', 'UPPER_BOUND', 'STEP'], NO_OP: gate.definition.NO_OP } };

test('finding 16: a competitor-derived rejection below the margin floor keeps neither the proposed price nor its deviation', () => {
  const proposed = BUYBOX - UNDERCUT;
  const stored = rejected('MATCH_BUYBOX', proposed, BUYBOX, { code: 'BELOW_MARGIN_FLOOR', params: { proposedMinor: proposed, floorMinor: 1800, minMinor: 1500, minMarginBp: 1000, deviationBp: 139, currency: 'EUR' } }, 139);
  assert.deepEqual(recoverable(stored, [BUYBOX], null), []);
  assert.equal(numbersIn(stored).includes(139), false, 'deviation from the margin floor is not kept');
  assert.equal(JSON.stringify(stored.explanation).includes('undercutMinor'), false, 'Р-91: the undercut is not kept either');
});

test('finding 16: a competitor-derived rejection above max_price keeps neither the proposed price nor its deviation', () => {
  const reference = 2605;
  const proposed = reference - UNDERCUT;
  const stored = rejected('MATCH_BUYBOX', proposed, reference, { code: 'ABOVE_MAX_PRICE', params: { proposedMinor: proposed, maxMinor: 2500, deviationBp: 400, currency: 'EUR' } }, 400);
  assert.deepEqual(recoverable(stored, [reference], null), []);
  assert.equal(numbersIn(stored).includes(400), false);
});

test('finding 16: a competitor-derived step-limit rejection keeps the current price and the limit, not the step that gives the proposed price', () => {
  const proposed = BUYBOX - UNDERCUT;
  const stored = rejected('MATCH_BUYBOX', proposed, BUYBOX, { code: 'STEP_LIMIT', params: { stepBp: 405, limitBp: 300, currentMinor: 1850, proposedMinor: proposed, currency: 'EUR' } }, null);
  assert.deepEqual(recoverable(stored, [BUYBOX], null), []);
  assert.equal(numbersIn(stored).includes(405), false, 'the step with the current price would give the proposed price');
});

test('finding 16, Р-91: an approved lowest-price undercut compared with shipping keeps no undercut — published price, undercut and own shipping would give the lowest landed price', () => {
  const lowestLanded = 1720;
  const ownShipping = 495;
  const published = lowestLanded - UNDERCUT - ownShipping;
  const params = { lowestMinor: lowestLanded, undercutMinor: UNDERCUT, scope: 'VISIBLE_TOP_N', n: 3, targetMinor: published, currency: 'EUR' };
  const intent = baseIntent({ ruleCode: 'BEAT_LOWEST', proposedMinor: published, referenceMinor: lowestLanded, reason: { code: 'LOWEST_UNDERCUT', params }, explanation: [{ code: 'LOWEST_UNDERCUT', params }] });
  const stored = eternal(intent, baseDecision({ finalMinor: published, reason: { code: 'APPROVED', params: { finalMinor: published, floorMinor: 1000, ceilingMinor: 2500, currency: 'EUR' } } }));
  assert.equal(JSON.stringify(stored.explanation).includes('undercutMinor'), false);
  assert.deepEqual(numbersIn(stored).filter((n) => n === lowestLanded || n === UNDERCUT || n === lowestLanded - UNDERCUT), []);
});

test('Р-91: an approved Buy Box undercut keeps the published price but not the undercut that would give the Buy Box price', () => {
  const stored = eternal(baseIntent({}), baseDecision({}));
  assert.equal(JSON.stringify(stored.explanation).includes('undercutMinor'), false);
  assert.equal(numbersIn(stored.explanation).includes(UNDERCUT), false);
});

