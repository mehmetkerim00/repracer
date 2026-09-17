import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CostInputs, PriceBounds, PriceIntentDraft } from '@repracer/pricing-model';
import { assertWriteWithinBounds, decide, NO_GUARDRAILS, validateRepricingEnablement, type GateInput,
  GATE_PROFILE,
  repricingWarnings,
} from './index.ts';

const NOW = '2026-09-14T10:00:00.000Z';

function intent(proposedMinor: number, over: Partial<PriceIntentDraft> = {}): PriceIntentDraft {
  return {
    writeScopeId: 'ws-1', strategyId: 'st-1', strategyVersion: 1, trigger: { type: 'COMPETITOR_CHANGE' }, ruleCode: 'MATCH_BUYBOX',
    intentClass: 'CHANGED', proposedMinor, currentMinor: 1850, referenceMinor: 1795, currency: 'EUR', basis: 'GROSS',
    reason: { code: 'BUYBOX_MATCH', params: {} }, explanation: [], inputs: { boundsAtStrategy: { minMinor: 1000, maxMinor: 3000 } },
    createdAt: NOW, expiresAt: '2026-09-14T10:10:00.000Z', ...over,
  };
}

function bounds(min: number | null, max: number | null): PriceBounds {
  return {
    currency: 'EUR', basis: 'GROSS',
    min: min === null ? { status: 'UNRESOLVABLE', cause: 'MISSING' } : { status: 'RESOLVED', amountMinor: min, sourceIds: ['min-1'] },
    max: max === null ? { status: 'UNRESOLVABLE', cause: 'MISSING' } : { status: 'RESOLVED', amountMinor: max, sourceIds: ['max-1'] },
  };
}

function gate(proposed: number, over: Partial<GateInput> = {}): GateInput {
  return {
    intent: intent(proposed),
    scope: { writeScopeId: 'ws-1', currency: 'EUR', basis: 'GROSS', pricingMode: 'ENGINE', status: 'ACTIVE', channelHalt: null, priceStop: null },
    bounds: bounds(1000, 3000), guardrails: NO_GUARDRAILS, cost: null, changesInLastHour: 0, now: NOW, ...over,
  };
}

const cost: CostInputs = { currency: 'EUR', costProfileId: 'cp-1', unitCostMinor: 1000, fixedFeeMinor: 0, feeRateBp: 1500, tax: { regime: 'VAT_INCLUDED', vatRateBp: 1900 } };

test('price within both bounds is approved with bound sources recorded', () => {
  const d = decide(gate(1790));
  assert.equal(d.outcome, 'APPROVED');
  assert.deepEqual([d.finalMinor, d.effectiveFloorMinor, d.effectiveCeilingMinor, d.minPriceIds, d.maxPriceIds], [1790, 1000, 3000, ['min-1'], ['max-1']]);
  assert.ok(d.checks.some((c) => c.check === 'FINAL_RECHECK' && c.passed));
});

test('above max price is rejected and classified exactly like below min price', () => {
  const above = decide(gate(3500));
  const below = decide(gate(900));
  assert.deepEqual([above.outcome, above.decisionClass, above.rejectionReason, above.finalMinor], ['REJECTED', 'REJECTED_BY_GATE', 'ABOVE_MAX_PRICE', null]);
  assert.deepEqual([below.outcome, below.decisionClass, below.rejectionReason], ['REJECTED', 'REJECTED_BY_GATE', 'BELOW_MIN_PRICE']);
  assert.equal(above.effectiveCeilingMinor, 3000);
  assert.ok(above.checks.some((c) => c.check === 'UPPER_BOUND' && !c.passed));
});

test('missing or inverted bound: rejected as BOUND_UNRESOLVABLE with a critical alert', () => {
  for (const b of [bounds(1000, null), bounds(null, 3000), bounds(3000, 1000)]) {
    const d = decide(gate(1790, { bounds: b }));
    assert.deepEqual([d.outcome, d.rejectionReason, d.alert?.severity], ['REJECTED', 'BOUND_UNRESOLVABLE', 'CRITICAL']);
    assert.equal(d.finalMinor, null);
  }
});

test('margin floor that cannot be computed makes the bound unresolvable', () => {
  const guard = { ...NO_GUARDRAILS, guardrailIds: ['g-1'], minMarginBp: 2000 };
  const noCost = decide(gate(1790, { guardrails: guard }));
  assert.deepEqual([noCost.rejectionReason, noCost.reason.params.cause], ['BOUND_UNRESOLVABLE', 'COST_PROFILE_MISSING']);
  const noVat = decide(gate(1790, { guardrails: guard, cost: { ...cost, tax: { regime: 'VAT_INCLUDED', vatRateBp: null } } }));
  assert.deepEqual([noVat.rejectionReason, noVat.reason.params.cause], ['BOUND_UNRESOLVABLE', 'VAT_UNKNOWN']);
});

test('Р-58: margin floor follows the tax regime of the storefront price', () => {
  const guard = { ...NO_GUARDRAILS, guardrailIds: ['g-1'], minMarginBp: 2000 };
  const gross = decide(gate(1500, { guardrails: guard, cost }));
  const net = decide(gate(1500, { guardrails: guard, cost: { ...cost, tax: { regime: 'SALES_TAX_EXCLUDED' } } }));
  assert.deepEqual([gross.rejectionReason, gross.reason.params.floorMinor], ['BELOW_MARGIN_FLOOR', 1915]);
  assert.deepEqual([net.rejectionReason, net.reason.params.floorMinor], ['BELOW_MARGIN_FLOOR', 1539]);
});

test('margin floor raises the effective floor', () => {
  const guard = { ...NO_GUARDRAILS, guardrailIds: ['g-1'], minMarginBp: 2000 };
  const d = decide(gate(1900, { guardrails: guard, cost }));
  assert.deepEqual([d.rejectionReason, d.effectiveFloorMinor], ['BELOW_MARGIN_FLOOR', 1915]);
  assert.equal(decide(gate(1915, { guardrails: guard, cost })).outcome, 'APPROVED');
});

test('NO_OP intent becomes NO_CHANGE; current price outside bounds raises a warning', () => {
  const d = decide(gate(1850, { intent: intent(1850, { intentClass: 'NO_OP' }) }));
  assert.deepEqual([d.outcome, d.decisionClass, d.alert], ['NO_CHANGE', 'NO_OP', null]);
  const outside = decide(gate(3500, { intent: intent(3500, { intentClass: 'NO_OP', currentMinor: 3500 }) }));
  assert.equal(outside.alert?.code, 'CURRENT_PRICE_OUTSIDE_BOUNDS');
});

test('step and rate guardrails hold or reject by policy', () => {
  const step = decide(gate(2500, { guardrails: { ...NO_GUARDRAILS, maxStepChangeBp: 1000 } }));
  assert.deepEqual([step.outcome, step.rejectionReason], ['HELD', 'STEP_LIMIT']);
  const rate = decide(gate(1790, { guardrails: { ...NO_GUARDRAILS, maxChangesPerHour: 4, onViolation: 'REJECT' }, changesInLastHour: 4 }));
  assert.deepEqual([rate.outcome, rate.rejectionReason], ['REJECTED', 'CHANGE_RATE_LIMIT']);
});

test('halted channel, expired intent and inactive scope are refused', () => {
  const scope = gate(1790).scope;
  assert.equal(decide(gate(1790, { scope: { ...scope, channelHalt: { haltId: 'h-1', reasonCode: 'CHANNEL_MASS_SHIFT', marketplace: 'de', haltedAt: '2026-09-14T09:00:00.000Z' } } })).rejectionReason, 'CHANNEL_HALTED');
  // Р-51: фиксированная цена, маржа и ручная цена при остановке работают
  for (const ruleCode of ['FIXED', 'TARGET_MARGIN', 'MANUAL']) {
    assert.equal(decide(gate(1790, { scope: { ...scope, channelHalt: { haltId: 'h-1', reasonCode: 'CHANNEL_MASS_SHIFT', marketplace: 'de', haltedAt: '2026-09-14T09:00:00.000Z' } }, intent: intent(1790, { ruleCode }) })).outcome, 'APPROVED', ruleCode);
  }
  assert.equal(decide(gate(1790, { now: '2026-09-14T10:10:00.000Z' })).rejectionReason, 'INTENT_EXPIRED');
  assert.deepEqual(decide(gate(1790, { scope: { ...scope, status: 'HELD' } })).outcome, 'HELD');
});

test('repricing cannot be enabled without both bounds (Р-43)', () => {
  assert.deepEqual(validateRepricingEnablement(bounds(1000, null), 'EUR', 'GROSS', STRATEGY).map((r) => r.code), ['MAX_PRICE_MISSING']);
  assert.deepEqual(validateRepricingEnablement(bounds(null, null), 'EUR', 'GROSS', STRATEGY).map((r) => r.code), ['MIN_PRICE_MISSING', 'MAX_PRICE_MISSING']);
  assert.deepEqual(validateRepricingEnablement(bounds(3000, 1000), 'EUR', 'GROSS', STRATEGY).map((r) => r.code), ['BOUNDS_INVERTED']);
  assert.deepEqual(validateRepricingEnablement(bounds(1000, 3000), 'EUR', 'GROSS', STRATEGY), []);
  // Р-77: без стратегии движок не включается
  assert.deepEqual(validateRepricingEnablement(bounds(1000, 3000), 'EUR', 'GROSS', null).map((r) => r.code), ['STRATEGY_MISSING']);
});

const STRATEGY = { strategyId: 'st-fixed', version: 1, params: { type: 'FIXED' as const, priceMinor: 1790 }, deadbandMinor: 0 };

test('Р-77: the warning names the strategy type and who needs the cost — no inference from the minimum margin', () => {
  const margin = { ...STRATEGY, params: { type: 'TARGET_MARGIN' as const, targetMarginBp: 2500 } };
  assert.deepEqual(repricingWarnings({ strategy: margin, minMarginBp: 1500, cost: null, costMissingCause: null }), [
    { code: 'MARGIN_WITHOUT_COST', params: { strategyType: 'TARGET_MARGIN', requiredBy: 'STRATEGY,MIN_MARGIN', minMarginBp: 1500, cause: 'COST_PROFILE_MISSING' } },
  ]);
  assert.deepEqual(repricingWarnings({ strategy: STRATEGY, minMarginBp: 1500, cost: null, costMissingCause: 'FX_RATE_STALE' })[0]!.params, {
    strategyType: 'FIXED', requiredBy: 'MIN_MARGIN', minMarginBp: 1500, cause: 'FX_RATE_STALE',
  });
  assert.deepEqual(repricingWarnings({ strategy: STRATEGY, minMarginBp: null, cost: null, costMissingCause: null }), [], 'a fixed price without a minimum margin needs no cost');
});

test('Р-75: Gate runs its checks exactly in the order of the profile stored with explanations', () => {
  assert.deepEqual(decide(gate(1790)).checks.map((c) => c.check), GATE_PROFILE.definition.CHANGED);
  assert.deepEqual(decide(gate(1790, { intent: intent(1850, { intentClass: 'NO_OP' }) })).checks.map((c) => c.check), GATE_PROFILE.definition.NO_OP);
  const rejected = decide(gate(900)).checks;
  assert.deepEqual(rejected.map((c) => c.check), GATE_PROFILE.definition.CHANGED.slice(0, rejected.length));
  assert.ok(rejected.slice(0, -1).every((c) => c.passed) && !rejected.at(-1)!.passed);
});

test('third check before the write uses fresh bounds', () => {
  assert.deepEqual(assertWriteWithinBounds(1790, bounds(1000, 3000), 'EUR', 'GROSS'), { ok: true });
  const lowered = assertWriteWithinBounds(1790, bounds(1000, 1500), 'EUR', 'GROSS');
  assert.ok(!lowered.ok && lowered.reason.code === 'WRITE_BLOCKED_BY_BOUND_RECHECK');
  const gone = assertWriteWithinBounds(1790, bounds(1000, null), 'EUR', 'GROSS');
  assert.ok(!gone.ok && gone.reason.code === 'BOUND_UNRESOLVABLE');
});

test('Р-116: a storefront halt for a wrong price basis blocks a fixed and a margin price too; a mass-shift halt does not', () => {
  const scope = gate(1790).scope;
  const halt = (reasonCode: 'CHANNEL_MASS_SHIFT' | 'CHANNEL_PRICE_BASIS_MISMATCH') => ({ haltId: 'h-2', reasonCode, marketplace: 'de', haltedAt: '2026-09-14T09:00:00.000Z' });
  for (const ruleCode of ['FIXED', 'TARGET_MARGIN', 'MANUAL']) {
    assert.equal(decide(gate(1790, { scope: { ...scope, channelHalt: halt('CHANNEL_PRICE_BASIS_MISMATCH') }, intent: intent(1790, { ruleCode }) })).rejectionReason, 'CHANNEL_HALTED', ruleCode);
    assert.equal(decide(gate(1790, { scope: { ...scope, channelHalt: halt('CHANNEL_MASS_SHIFT') }, intent: intent(1790, { ruleCode }) })).outcome, 'APPROVED', ruleCode);
  }
});
