import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CompetitorSnapshot } from '@repracer/channel-port';
import { markAcceptedBySanity, type StrategyParams } from '@repracer/pricing-model';
import { ladderSteps, runStrategy, type EngineInput, type EngineResult } from './index.ts';

/**
 * Шаг 102 [Р-227]: режим распродажи — пол распродажи заменяет весь пол (min_price и пол маржи); без режима безубыточность (маржа 0 %)
 * входит в пол. Возврат из распродажи — лестницей по Р-208, первый же пересчёт начинает подъём и цену не опускает. Данные синтетические
 */

const NOW = '2026-10-18T10:00:00.000Z';
const usd = (amountMinor: number) => ({ amountMinor, currency: 'USD', basis: 'NET' as const });
const BEAT: StrategyParams = { type: 'BEAT_LOWEST', undercutMinor: 1, scope: 'VISIBLE_TOP_N', compareLanded: false, atBound: 'CAP' };
const BREAK_EVEN = { amountMinor: 1295, minMarginBp: 0, source: 'BREAK_EVEN' as const };

function snapshot(competitorMinor: number, selfMinor: number): CompetitorSnapshot {
  return {
    marketplace: 'ATVPDKIKX0DER', channelProductRef: 'SYN-102', condition: 'new', source: 'SYN', observedAt: '2026-10-18T09:59:00.000Z',
    completeness: { kind: 'TOP_N', n: 20 }, buybox: { price: usd(competitorMinor), isSelf: null },
    offers: [{ isSelf: false, sellerRef: 'Harbor Goods', price: usd(competitorMinor), shipping: usd(0) }, { isSelf: true, price: usd(selfMinor), shipping: usd(0) }],
  };
}

function run(competitorMinor: number, current: number, over: Partial<EngineInput> = {}, bounds: Partial<EngineInput['bounds']> = {}): EngineResult {
  return runStrategy({
    writeScope: { writeScopeId: 'ws-102', currency: 'USD', basis: 'NET' }, strategy: { strategyId: 'st', version: 1, params: BEAT, deadbandMinor: 0 },
    snapshot: markAcceptedBySanity(snapshot(competitorMinor, current), 'test'), cost: null,
    bounds: { minMinor: 1400, maxMinor: 5000, marginFloor: BREAK_EVEN, ...bounds },
    currentPriceMinor: current, now: NOW, trigger: { type: 'COMPETITOR_CHANGE', sourceEventId: 'e' }, ...over,
  });
}
const intentOf = (r: EngineResult) => { assert.equal(r.kind, 'INTENT', JSON.stringify(r)); return (r as Extract<EngineResult, { kind: 'INTENT' }>).intent; };

test('step 102 [Р-227]: the clearance floor replaces min_price and the margin floor; the receipt chain opens with the clearance context', () => {
  const clearance = { floorMinor: 1000, breakEvenMinor: 1295 };
  // Конкурент $11.00: цель $10.99 — ниже min_price $14.00 и безубыточности $12.95, но не ниже пола распродажи — продаём в убыток намеренно
  const loss = intentOf(run(1100, 1850, {}, { clearance }));
  assert.equal(loss.proposedMinor, 1099);
  assert.equal(loss.explanation[0]!.code, 'CLEARANCE_FLOOR');
  assert.deepEqual(loss.explanation[0]!.params, { floorMinor: 1000, breakEvenMinor: 1295, lossPerUnitMinor: 295, currency: 'USD' });
  // Конкурент $9.00: цель $8.99 ниже пола распродажи — на пол распродажи, своей причиной
  const capped = intentOf(run(900, 1850, {}, { clearance }));
  assert.equal(capped.proposedMinor, 1000);
  assert.deepEqual(capped.explanation.map((r) => r.code), ['CLEARANCE_FLOOR', 'LOWEST_UNDERCUT', 'CAPPED_AT_CLEARANCE_FLOOR']);
  assert.deepEqual(capped.reason.params, { targetMinor: 899, floorMinor: 1000, currency: 'USD' });
  // Цена ниже пола распродажи — подъём к нему, граница названа
  const raised = intentOf(run(900, 950, {}, { clearance }));
  assert.equal(raised.reason.code, 'RAISED_TO_FLOOR');
  assert.equal(raised.reason.params.bound, 'clearance');
});

test('step 102 [Р-227]: without clearance break-even is a floor even with min_price below it', () => {
  const capped = intentOf(run(1100, 1850, {}, { minMinor: 1000 }));
  assert.equal(capped.proposedMinor, 1295, 'not $10.99: a sale below break-even is not accidental');
  assert.equal(capped.reason.code, 'CAPPED_AT_MARGIN_FLOOR');
  assert.equal(capped.reason.params.minMarginBp, 0);
  const raised = intentOf(run(1100, 1200, {}, { minMinor: 1000 }));
  assert.deepEqual([raised.reason.code, raised.reason.params.bound], ['RAISED_TO_FLOOR', 'break_even']);
});

test('step 102 (D3) [Р-208, Р-227]: after clearance ends the first recompute starts the climb to the floor and never lowers the price', () => {
  // Распродажа на $10.00 выключена; пол — min_price $14.00; предел шага 10 %; конкурент всё ещё $8.99
  const first = intentOf(run(899, 1000, { stepLimitBp: 1000, raiseAfter: 'CLEARANCE_ENDED', trigger: { type: 'SCHEDULE' } }));
  assert.equal(first.intentClass, 'CHANGED');
  assert.equal(first.reason.code, 'RAISED_TOWARD_FLOOR');
  assert.equal(first.proposedMinor, 1100, 'one step up, not down to the competitor');
  assert.equal(first.reason.params.after, 'CLEARANCE_ENDED');
  assert.ok(first.proposedMinor >= 1000, 'the price is not lowered');
  // «Примерно N шагов»: та же арифметика, что у лестницы движка (сама ступень + оставшиеся)
  assert.equal(ladderSteps(1000, 1400, 1000), (first.reason.params.stepsLeft as number) + 1);
  assert.equal(ladderSteps(1000, 1400, null), 1, 'without a step limit — at once');
  assert.equal(ladderSteps(1400, 1400, 1000), 0, 'at the floor — nothing to climb');
});
