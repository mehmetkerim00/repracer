import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CompetitorOffer, CompetitorSnapshot } from '@repracer/channel-port';
import { evaluateSnapshot, type SanityContext, type SanityVerdict } from './index.ts';

const NOW = '2026-09-14T10:00:00.000Z';
const eur = (amountMinor: number) => ({ amountMinor, currency: 'EUR', basis: 'GROSS' as const });

function offer(rank: number, price: number, over: Partial<CompetitorOffer> = {}): CompetitorOffer {
  return { rank, isSelf: false, sellerRef: `Seller ${rank}`, price: eur(price), ...over };
}

function snap(buybox: number, over: Partial<CompetitorSnapshot> = {}): CompetitorSnapshot {
  return {
    marketplace: 'de', channelProductRef: 'P1', condition: 'new', source: 'KAUFLAND_BUYBOX',
    observedAt: '2026-09-14T09:59:00.000Z', completeness: { kind: 'TOP_N', n: 10 },
    buybox: { price: eur(buybox), isSelf: false },
    offers: [offer(1, buybox), offer(2, 1850, { isSelf: true, sellerRef: 'Us' })],
    ...over,
  };
}

function history(days: number, lo = 1700, hi = 1950): SanityContext['competitorDaily'] {
  return Array.from({ length: days }, (_, i) => ({ day: new Date(Date.parse(NOW) - (i + 1) * 86_400_000).toISOString().slice(0, 10), minMinor: lo, maxMinor: hi }));
}

function ctx(over: Partial<SanityContext> = {}): SanityContext {
  return {
    now: NOW, expectedCurrency: 'EUR', expectedBasis: 'GROSS', unitCostMinor: 1000, crossChannel: [], competitorDaily: history(20),
    lastAccepted: { observedAt: '2026-09-14T09:00:00.000Z', buyboxMinor: 1795, lowestMinor: 1795 },
    ourPriceMinor: 1850, ourKnownPricesMinor: [1850], channel: { halt: null, recentMoves: [] },
    ...over,
  };
}

/** Холодный старт: нет истории, нет принятого снимка, нашей цены ещё нет */
const COLD = { competitorDaily: [], lastAccepted: null, ourPriceMinor: null, ourKnownPricesMinor: [] };

const code = (v: SanityVerdict) => (v.verdict === 'ACCEPT' ? 'ACCEPT' : v.reason.code);
const moves = (n: number, bp: number | ((i: number) => number), seller: (i: number) => string | null = (i) => `S${i}`) =>
  Array.from({ length: n }, (_, i) => ({ productRef: `Q${i}|new`, evaluatedAt: '2026-09-14T09:55:00.000Z', moveBp: typeof bp === 'number' ? bp : bp(i), sellerRef: seller(i) }));

test('normal snapshot is accepted with the anchors it was checked against', () => {
  const v = evaluateSnapshot(snap(1790), ctx());
  assert.equal(v.verdict, 'ACCEPT');
  assert.deepEqual(v.anchorsUsed, ['COST', 'HISTORY']);
  assert.deepEqual(v.warnings, []);
});

test('OQ-90 closed: our own price far from the market only warns, the snapshot is accepted', () => {
  const v = evaluateSnapshot(snap(1790), ctx({ ourPriceMinor: 99_999, ourKnownPricesMinor: [99_999] }));
  assert.equal(v.verdict, 'ACCEPT');
  assert.ok(v.warnings.some((w) => w.code === 'OWN_PRICE_DEVIATION'));
  // Наша цена-заглушка ровно ×100 к рынку тоже не считается ошибкой единиц
  const placeholder = evaluateSnapshot(snap(1000), ctx({ ourPriceMinor: 100_000, ourKnownPricesMinor: [100_000], competitorDaily: history(20, 900, 1100) }));
  assert.equal(placeholder.verdict, 'ACCEPT');
});

test('cold start with cost: corrupted snapshot rejected by the cost anchor, normal one accepted', () => {
  const x100 = evaluateSnapshot(snap(178_000, { offers: [offer(1, 178_000), offer(2, 185_000, { isSelf: true })] }), ctx(COLD));
  assert.deepEqual([code(x100), x100.anchorsUsed], ['PRICE_ABOVE_COST_ANCHOR', ['COST']]);
  const low = evaluateSnapshot(snap(18, { offers: [offer(1, 18)] }), ctx(COLD));
  assert.equal(code(low), 'PRICE_BELOW_COST_ANCHOR');
  const exact = evaluateSnapshot(snap(100_000, { offers: [offer(1, 100_000)] }), ctx(COLD));
  assert.ok(exact.verdict === 'REJECT' && exact.reason.code === 'UNIT_SCALE_X100' && exact.reason.params.anchor === 'COST');
  const normal = evaluateSnapshot(snap(1790), ctx(COLD));
  assert.deepEqual([code(normal), normal.anchorsUsed], ['ACCEPT', ['COST']]);
});

test('no primary anchor at all: fail closed', () => {
  const v = evaluateSnapshot(snap(1790), ctx({ ...COLD, unitCostMinor: null }));
  assert.ok(v.verdict === 'REJECT' && v.reason.code === 'NO_PLAUSIBILITY_ANCHOR' && v.alarmClass === 'ANCHOR_MISSING' && v.alert);
});

test('internal consistency: an outlier used by the strategy rejects, an unused outlier warns', () => {
  const penny = snap(1790, { offers: [offer(1, 1790), offer(2, 1800), offer(3, 1850), offer(4, 9)] });
  assert.equal(code(evaluateSnapshot(penny, ctx({ ...COLD, unitCostMinor: null }))), 'SNAPSHOT_INTERNAL_OUTLIER');
  const unusedHigh = evaluateSnapshot(snap(1790, { offers: [offer(1, 1790), offer(2, 1800), offer(3, 1850), offer(4, 9900)] }), ctx({ ...COLD, unitCostMinor: null }));
  assert.equal(unusedHigh.verdict, 'ACCEPT');
  assert.deepEqual(unusedHigh.anchorsUsed, ['INTERNAL']);
  assert.ok(unusedHigh.warnings.some((w) => w.code === 'INTERNAL_OUTLIER_IGNORED'));
});

test('same EAN on another channel of the tenant anchors a snapshot without cost and history', () => {
  const cross = [{ channel: 'KAUFLAND', marketplace: 'at', referenceMinor: 1800, currency: 'EUR', observedAt: '2026-09-14T08:00:00.000Z' }];
  assert.equal(code(evaluateSnapshot(snap(9000, { offers: [offer(1, 9000)] }), ctx({ ...COLD, unitCostMinor: null, crossChannel: cross }))), 'CROSS_CHANNEL_MISMATCH');
  const ok = evaluateSnapshot(snap(1790, { offers: [offer(1, 1790)] }), ctx({ ...COLD, unitCostMinor: null, crossChannel: cross }));
  assert.deepEqual([code(ok), ok.anchorsUsed], ['ACCEPT', ['CROSS_CHANNEL']]);
  const stale = [{ ...cross[0]!, observedAt: '2026-09-01T00:00:00.000Z' }];
  assert.equal(code(evaluateSnapshot(snap(1790, { offers: [offer(1, 1790)] }), ctx({ ...COLD, unitCostMinor: null, crossChannel: stale }))), 'NO_PLAUSIBILITY_ANCHOR');
});

test('history band is the fourth anchor', () => {
  assert.equal(code(evaluateSnapshot(snap(6000), ctx({ unitCostMinor: null, lastAccepted: null }))), 'OUTSIDE_HISTORY_BAND');
});

test('Р-50: many products shifting by an almost identical factor across sellers halts the channel', () => {
  const v = evaluateSnapshot(snap(5400), ctx({ channel: { halt: null, recentMoves: moves(9, 30_000) } }));
  assert.equal(v.verdict, 'HALT_CHANNEL');
  assert.ok(v.verdict === 'HALT_CHANNEL' && v.reason.params.sameDirection === 10 && Number(v.reason.params.spread) <= 0.005);
});

test('Р-50: dispersed factors are a market event, not a halt', () => {
  const v = evaluateSnapshot(snap(5400), ctx({ channel: { halt: null, recentMoves: moves(9, (i) => 20_000 + i * 2_500) } }));
  assert.equal(v.verdict, 'ACCEPT');
  assert.ok(v.warnings.some((w) => w.code === 'MARKET_SHIFT_DISPERSED'));
});

test('Р-50: one seller shifting many products is a market event, even with an identical factor', () => {
  const s = snap(5400, { offers: [offer(1, 5400, { sellerRef: 'Big Seller' }), offer(2, 1850, { isSelf: true })] });
  const v = evaluateSnapshot(s, ctx({ channel: { halt: null, recentMoves: moves(9, 30_000, () => 'Big Seller') } }));
  assert.equal(v.verdict, 'ACCEPT');
  assert.ok(v.warnings.some((w) => w.code === 'MARKET_SHIFT_SINGLE_SELLER'));
});

test('Р-50: the share counts every product that moved in the window, not only the large moves the store returns', () => {
  // Хранилище отдаёт только большие движения; 9 больших из 60 товаров в окне — меньше 80 %, остановки нет
  const v = evaluateSnapshot(snap(5400), ctx({ channel: { halt: null, recentMoves: moves(9, 30_000), windowProducts: 60 } }));
  assert.equal(v.verdict, 'ACCEPT');
  const halted = evaluateSnapshot(snap(5400), ctx({ channel: { halt: null, recentMoves: moves(9, 30_000), windowProducts: 9 } }));
  assert.equal(halted.verdict, 'HALT_CHANNEL');
});

test('unit scale error against the last accepted value is its own alarm class', () => {
  const v = evaluateSnapshot(snap(179_500, { offers: [offer(1, 179_500)] }), ctx({ unitCostMinor: null, competitorDaily: [] }));
  assert.ok(v.verdict === 'REJECT' && v.reason.code === 'UNIT_SCALE_X100' && v.alarmClass === 'UNIT_SCALE');
});

test('Р-55: stale snapshot rejected with an alert; own offer mismatch opens a divergence, not a rejection', () => {
  const old = evaluateSnapshot(snap(1790, { observedAt: '2026-09-14T08:00:00.000Z' }), ctx({ lastAccepted: null }));
  assert.ok(old.verdict === 'REJECT' && old.reason.code === 'SNAPSHOT_TOO_OLD' && old.alert);
  const edited = evaluateSnapshot(snap(1790, { offers: [offer(1, 1790), offer(2, 3700, { isSelf: true })] }), ctx());
  assert.ok(edited.verdict === 'ACCEPT' && edited.divergence?.valueMinor === 3700);
  assert.ok(edited.warnings.some((w) => w.code === 'SELF_OFFER_DIVERGENCE'));
});

test('halted channel rejects silently; structure errors are rejected', () => {
  const halted = evaluateSnapshot(snap(1790), ctx({ channel: { halt: { haltId: 'h-1', haltedAt: NOW, reasonCode: 'CHANNEL_MASS_SHIFT', marketplace: 'de' }, recentMoves: [] } }));
  assert.ok(halted.verdict === 'REJECT' && halted.reason.code === 'CHANNEL_HALTED' && !halted.alert);
  const pln = evaluateSnapshot(snap(1790, { buybox: { price: { amountMinor: 1790, currency: 'PLN', basis: 'GROSS' }, isSelf: false } }), ctx());
  assert.equal(code(pln), 'CURRENCY_MISMATCH');
  const net = evaluateSnapshot(snap(1790, { buybox: { price: { amountMinor: 1790, currency: 'EUR', basis: 'NET' }, isSelf: false } }), ctx());
  assert.equal(code(net), 'PRICE_BASIS_MISMATCH');
});
