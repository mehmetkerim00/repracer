import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CompetitorSnapshot, CompetitorSourceDescriptor } from '@repracer/channel-port';
import { markAcceptedBySanity, type CostInputs, type StrategyParams } from '@repracer/pricing-model';
import { runStrategy, strategyAvailability, type EngineInput } from './index.ts';

const NOW = '2026-09-14T10:00:00.000Z';
const eur = (amountMinor: number) => ({ amountMinor, currency: 'EUR', basis: 'GROSS' as const });

function snapshot(over: Partial<CompetitorSnapshot> = {}): CompetitorSnapshot {
  return {
    marketplace: 'de', channelProductRef: 'P1', condition: 'new', source: 'KAUFLAND_BUYBOX', observedAt: '2026-09-14T09:59:00.000Z',
    completeness: { kind: 'TOP_N', n: 10 }, buybox: { price: eur(1795), isSelf: false },
    offers: [
      { rank: 1, isSelf: false, price: eur(1795), shipping: eur(0), totalPrice: eur(1795) },
      { rank: 2, isSelf: true, price: eur(1850), shipping: eur(495), totalPrice: eur(2345) },
    ],
    ...over,
  };
}

function input(params: StrategyParams, over: Partial<EngineInput> = {}): EngineInput {
  return {
    writeScope: { writeScopeId: 'ws-1', currency: 'EUR', basis: 'GROSS' },
    strategy: { strategyId: 'st-1', version: 1, params, deadbandMinor: 0 },
    snapshot: markAcceptedBySanity(snapshot(), 'test'),
    cost: null,
    bounds: { minMinor: 1000, maxMinor: 3000 },
    currentPriceMinor: 1850,
    now: NOW,
    trigger: { type: 'COMPETITOR_CHANGE', sourceEventId: 'evt-1' },
    ...over,
  };
}

const matchBuybox = (over: Partial<Extract<StrategyParams, { type: 'MATCH_BUYBOX' }>> = {}): StrategyParams =>
  ({ type: 'MATCH_BUYBOX', undercutMinor: 5, holdWhenWinning: true, atBound: 'CAP', ...over });

const cost: CostInputs = { currency: 'EUR', costProfileId: 'cp-1', unitCostMinor: 1000, fixedFeeMinor: 0, feeRateBp: 1500, tax: { regime: 'VAT_INCLUDED', vatRateBp: 1900 } };

test('match buy box with undercut proposes a CHANGED intent with the reason chain', () => {
  const r = runStrategy(input(matchBuybox()));
  assert.equal(r.kind, 'INTENT');
  assert.ok(r.kind === 'INTENT' && r.intent.intentClass === 'CHANGED' && r.intent.proposedMinor === 1790);
  assert.ok(r.kind === 'INTENT' && r.intent.reason.code === 'BUYBOX_UNDERCUT' && r.intent.referenceMinor === 1795);
});

test('competitor-following target below min price is capped at the bound (CAP) or held (HOLD)', () => {
  const capped = runStrategy(input(matchBuybox(), { bounds: { minMinor: 1800, maxMinor: 3000 } }));
  assert.ok(capped.kind === 'INTENT' && capped.intent.proposedMinor === 1800 && capped.intent.reason.code === 'CAPPED_AT_MIN_PRICE');
  const held = runStrategy(input(matchBuybox({ atBound: 'HOLD' }), { bounds: { minMinor: 1800, maxMinor: 3000 } }));
  assert.ok(held.kind === 'INTENT' && held.intent.intentClass === 'NO_OP' && held.intent.reason.code === 'TARGET_OUTSIDE_BOUNDS_HOLD');
});

test('fixed price above max price is not capped: the conflict must reach the Gate', () => {
  const r = runStrategy(input({ type: 'FIXED', priceMinor: 5000 }));
  assert.ok(r.kind === 'INTENT' && r.intent.intentClass === 'CHANGED' && r.intent.proposedMinor === 5000);
});

test('already winning the buy box is NO_OP', () => {
  const s = markAcceptedBySanity(snapshot({ buybox: { price: eur(1850), isSelf: true } , offers: [{ rank: 1, isSelf: true, price: eur(1850) }] }), 'test');
  const r = runStrategy(input(matchBuybox(), { snapshot: s }));
  assert.ok(r.kind === 'INTENT' && r.intent.intentClass === 'NO_OP' && r.intent.reason.code === 'ALREADY_WINNING_BUYBOX');
});

test('difference smaller than the deadband is NO_OP', () => {
  const r = runStrategy({ ...input(matchBuybox()), currentPriceMinor: 1795, strategy: { strategyId: 'st-1', version: 1, params: matchBuybox(), deadbandMinor: 10 } });
  assert.ok(r.kind === 'INTENT' && r.intent.intentClass === 'NO_OP' && r.intent.reason.code === 'WITHIN_DEADBAND' && r.intent.proposedMinor === 1795);
});

test('target margin computes the gross price and fails closed without VAT', () => {
  const ok = runStrategy(input({ type: 'TARGET_MARGIN', targetMarginBp: 2000 }, { cost }));
  assert.ok(ok.kind === 'INTENT' && ok.intent.proposedMinor === 1915, JSON.stringify(ok));
  const noVat = runStrategy(input({ type: 'TARGET_MARGIN', targetMarginBp: 2000 }, { cost: { ...cost, tax: { regime: 'VAT_INCLUDED', vatRateBp: null } } }));
  assert.ok(noVat.kind === 'NOT_EVALUATED' && noVat.reason.code === 'COST_INPUTS_MISSING');
  const high = runStrategy(input({ type: 'TARGET_MARGIN', targetMarginBp: 2000 }, { cost: { ...cost, feeRateBp: 9000 } }));
  assert.ok(high.kind === 'NOT_EVALUATED' && high.reason.code === 'MARGIN_UNATTAINABLE');
});

test('beat lowest compares landed prices and subtracts own shipping', () => {
  const s = markAcceptedBySanity(snapshot({
    offers: [
      { rank: 1, isSelf: false, price: eur(1700), shipping: eur(300), totalPrice: eur(2000) },
      { rank: 2, isSelf: false, price: eur(1900), shipping: eur(0), totalPrice: eur(1900) },
      { rank: 3, isSelf: true, price: eur(1850), shipping: eur(100), totalPrice: eur(1950) },
    ],
    buybox: { price: eur(1700), isSelf: false },
  }), 'test');
  const r = runStrategy(input({ type: 'BEAT_LOWEST', undercutMinor: 0, scope: 'VISIBLE_TOP_N', compareLanded: true, atBound: 'CAP' }, { snapshot: s }));
  assert.ok(r.kind === 'INTENT' && r.intent.proposedMinor === 1800 && r.intent.reason.code === 'LOWEST_MATCH', JSON.stringify(r));
});

test('market-wide lowest needs CHEAPEST_ONLY or FULL: a top-10 snapshot is not enough', () => {
  const r = runStrategy(input({ type: 'BEAT_LOWEST', undercutMinor: 1, scope: 'MARKET', compareLanded: false, atBound: 'CAP' }));
  assert.ok(r.kind === 'NOT_EVALUATED' && r.reason.code === 'COMPETITOR_REQUIREMENT_NOT_MET' && String(r.reason.params.unmet).includes('COMPLETENESS'));
});

test('stale snapshot does not meet the requirement', () => {
  const r = runStrategy(input(matchBuybox(), { now: '2026-09-14T11:00:00.000Z' }));
  assert.ok(r.kind === 'NOT_EVALUATED' && String(r.reason.params.unmet).includes('STALENESS'));
});

test('availability on Kaufland sources: buy box via pull; early-access push does not count; market minimum unavailable', () => {
  const sources: CompetitorSourceDescriptor[] = [
    { source: 'KAUFLAND_BUY_BOX_CHANGED', kind: 'PUSH', completeness: { kind: 'TOP_N', n: 10 }, conditions: ['new'], hasBuyboxWinner: true, hasOwnRank: true, hasShipping: true, typicalStalenessSeconds: null, availability: 'EARLY_ACCESS', role: 'PRIMARY' },
    { source: 'KAUFLAND_BUYBOX', kind: 'PULL', completeness: { kind: 'TOP_N', n: 10 }, conditions: ['new', 'used'], hasBuyboxWinner: true, hasOwnRank: true, hasShipping: true, typicalStalenessSeconds: null, availability: 'AVAILABLE', role: 'PRIMARY' },
    { source: 'KAUFLAND_COMPETITORS_COMPARER', kind: 'REPORT', completeness: { kind: 'CHEAPEST_ONLY' }, conditions: ['new', 'used'], hasBuyboxWinner: false, hasOwnRank: false, hasShipping: false, typicalStalenessSeconds: null, availability: 'AVAILABLE', role: 'RECONCILIATION' },
  ];
  const buybox = strategyAvailability(matchBuybox(), sources);
  assert.deepEqual(buybox, { available: true, via: 'KAUFLAND_BUYBOX' });
  const market = strategyAvailability({ type: 'BEAT_LOWEST', undercutMinor: 0, scope: 'MARKET', compareLanded: false, atBound: 'CAP' }, sources);
  assert.equal(market.available, false);
  assert.ok(!market.available && market.unmet.KAUFLAND_COMPETITORS_COMPARER?.includes('RECONCILIATION_ONLY'));
  assert.ok(strategyAvailability({ type: 'FIXED', priceMinor: 1 }, []).available);
});
