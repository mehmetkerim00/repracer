import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CostInputs, PriceBounds, PriceIntentDraft } from '@repracer/pricing-model';
import { decide, NO_GUARDRAILS, resolveMarginFloor, type GateInput } from './index.ts';

/**
 * Шаг 102 [Р-227]: безубыточность (маржа 0 %) всегда входит в пол, кроме режима распродажи; в режиме распродажи пол — распродажный, он
 * заменяет и min_price, и пол маржи, а всё остальное Gate проверяет как прежде. Данные синтетические
 */

const NOW = '2026-10-18T10:00:00.000Z';
const intent = (proposedMinor: number, over: Partial<PriceIntentDraft> = {}): PriceIntentDraft => ({
  writeScopeId: 'ws-1', strategyId: 'st-1', strategyVersion: 1, trigger: { type: 'COMPETITOR_CHANGE' }, ruleCode: 'BEAT_LOWEST',
  intentClass: 'CHANGED', proposedMinor, currentMinor: 1850, referenceMinor: 1000, currency: 'USD', basis: 'NET',
  reason: { code: 'LOWEST_UNDERCUT', params: {} }, explanation: [], inputs: { boundsAtStrategy: { minMinor: 1400, maxMinor: 5000 } },
  createdAt: NOW, expiresAt: '2026-10-18T10:10:00.000Z', ...over,
});
const bounds: PriceBounds = { currency: 'USD', basis: 'NET', min: { status: 'RESOLVED', amountMinor: 1000, sourceIds: ['min-1'] }, max: { status: 'RESOLVED', amountMinor: 5000, sourceIds: ['max-1'] } };
// Себестоимость $11.00, комиссия 15 %, налог с продаж вне цены: безубыточность — $12.95 (1100 / 0.85, вверх до цента)
const cost: CostInputs = { currency: 'USD', costProfileId: 'cp-1', unitCostMinor: 1100, fixedFeeMinor: 0, feeRateBp: 1500, tax: { regime: 'SALES_TAX_EXCLUDED' } };
const gate = (proposed: number, over: Partial<GateInput> = {}): GateInput => ({
  intent: intent(proposed), scope: { writeScopeId: 'ws-1', currency: 'USD', basis: 'NET', pricingMode: 'ENGINE', status: 'ACTIVE', channelHalt: null, priceStop: null },
  bounds, guardrails: NO_GUARDRAILS, cost, changesInLastHour: 0, now: NOW, ...over,
});

test('step 102 [Р-227]: break-even is part of the floor without a minimum margin; without a declared cost the floor is min_price as before', () => {
  assert.deepEqual(resolveMarginFloor(cost, null, 'USD'), { kind: 'OK', floorMinor: 1295, minMarginBp: 0, source: 'BREAK_EVEN' });
  assert.deepEqual(resolveMarginFloor(cost, 1200, 'USD'), { kind: 'OK', floorMinor: 1507, minMarginBp: 1200, source: 'MIN_MARGIN' });
  assert.deepEqual(resolveMarginFloor(null, null, 'USD'), { kind: 'NONE' }, 'no cost — Р-131, the floor is min_price');
  assert.deepEqual(resolveMarginFloor(null, null, 'USD', 'FEE_ESTIMATE_MISSING'), { kind: 'UNRESOLVABLE', cause: 'FEE_ESTIMATE_MISSING' },
    'a declared cost without fees: break-even must be known — fail closed');
  const below = decide(gate(1200));
  assert.deepEqual([below.outcome, below.rejectionReason, below.effectiveFloorMinor], ['REJECTED', 'BELOW_MARGIN_FLOOR', 1295], 'min_price $10 does not let a loss through');
  assert.deepEqual([decide(gate(1300)).outcome, decide(gate(1300)).effectiveFloorMinor], ['APPROVED', 1295]);
});

test('step 102 [Р-227]: in clearance mode the clearance floor replaces min_price and the margin floor; everything else is checked as before', () => {
  const clearance = { floorMinor: 700 };
  const sold = decide(gate(800, { clearance, guardrails: { ...NO_GUARDRAILS, minMarginBp: 1200 } }));
  assert.deepEqual([sold.outcome, sold.finalMinor, sold.effectiveFloorMinor], ['APPROVED', 800, 700], 'below min_price, the margin floor and break-even — on purpose');
  const below = decide(gate(650, { clearance }));
  assert.deepEqual([below.outcome, below.rejectionReason, below.reason.params.minMinor, below.reason.params.floor], ['REJECTED', 'BELOW_MIN_PRICE', 700, 'CLEARANCE'],
    'the clearance floor is still a floor');
  assert.equal(decide(gate(5100, { clearance })).rejectionReason, 'ABOVE_MAX_PRICE', 'the ceiling stays');
  const step = decide(gate(800, { clearance, guardrails: { ...NO_GUARDRAILS, maxStepChangeBp: 1000 } }));
  assert.equal(step.rejectionReason, 'STEP_LIMIT', 'the step limit stays');
  // Без себестоимости и без маржи режим ничего не требует от пола маржи
  assert.equal(decide(gate(800, { clearance, cost: null })).outcome, 'APPROVED');
});

test('step 102 [Р-227]: a cost rise that lifts break-even above the max price leaves no price without a loss — the Gate says so, not «above the max price»', () => {
  const cost = { currency: 'EUR', costProfileId: 'cp', unitCostMinor: 2000, fixedFeeMinor: 0, feeRateBp: 1500, tax: { regime: 'VAT_INCLUDED' as const, vatRateBp: 1900 } };
  const margin = resolveMarginFloor(cost, null, 'EUR');
  assert.equal(JSON.stringify(margin), JSON.stringify({ kind: 'OK', floorMinor: 2898, minMarginBp: 0, source: 'BREAK_EVEN' }), 'break-even €28.98 at a unit cost of €20.00');
  // Потолок $25.00 ниже безубыточности: ни одной цены без убытка — Gate отказывает «пол выше потолка», а не «цена выше потолка»
  const usd = { ...cost, currency: 'USD', tax: { regime: 'SALES_TAX_EXCLUDED' as const } };
  const r = decide(gate(3000, { cost: usd, bounds: { ...bounds, max: { status: 'RESOLVED', amountMinor: 2000, sourceIds: ['max-1'] } } }));
  assert.equal(JSON.stringify([r.outcome, r.rejectionReason, r.reason.params.cause, r.reason.params.bound, r.reason.params.minMarginBp]),
    JSON.stringify(['REJECTED', 'BOUND_UNRESOLVABLE', 'MARGIN_FLOOR_ABOVE_MAX_PRICE', 'break_even', undefined]), 'the refusal names break-even, not «a 0% margin floor»');
  const withMargin = decide(gate(3000, { cost: usd, guardrails: { ...NO_GUARDRAILS, minMarginBp: 1000 }, bounds: { ...bounds, max: { status: 'RESOLVED', amountMinor: 2000, sourceIds: ['max-1'] } } }));
  assert.equal(JSON.stringify([withMargin.reason.params.bound, withMargin.reason.params.minMarginBp]), JSON.stringify(['margin_floor', 1000]));
});
