import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MemorySeedScope } from '@repracer/pricing-pipeline';
import { counterfactual, LIES, runBacktest, wins } from './backtest/backtest.ts';
import { syntheticHistory } from './backtest/history.ts';

/** Бэктест на записанной истории [Р-38]: окно, контрфактический снимок, метрики. Данные синтетические. */
const NOW = '2026-09-17T00:00:00.000Z';
const WINDOW = { from: '2025-03-17T00:00:00.000Z', to: NOW };
const ACCOUNT = '20000000-0000-4000-8000-000000000001';
const TENANT = '10000000-0000-4000-8000-000000000001';

const product = { channelProductRef: '362008101', historicalSelfPriceMinor: 1990, marketPriceMinor: 1900 };
const history = syntheticHistory({ seed: 38, marketplace: 'de', currency: 'EUR', from: WINDOW.from, to: WINDOW.to, everyMs: 43_200_000, products: [product],
  dailyVolatilityBp: 150, promo: { everyDays: 14, days: 2, discountBp: 1500 }, corruptShare: 0.004 });

const scope = (params: NonNullable<MemorySeedScope['strategy']>['params']): MemorySeedScope => ({
  writeScopeId: 'ws-bt', productId: 'prod-bt', channelAccountId: ACCOUNT, marketplace: 'de', externalUnitId: '8101', channelProductRef: product.channelProductRef,
  condition: 'new', currency: 'EUR', basis: 'GROSS', pricingMode: 'ENGINE', strategy: { strategyId: 'st-bt', version: 1, params, deadbandMinor: 0 },
  currentPriceMinor: 1990, minPrice: { amountMinor: 1615, id: 'min-bt' }, maxPrice: { amountMinor: 2470, id: 'max-bt' },
  cost: { currency: 'EUR', costProfileId: 'cp-bt', unitCostMinor: 1045, fixedFeeMinor: 0, feeRateBp: 1200, tax: { regime: 'VAT_INCLUDED', vatRateBp: 1900 } },
});

test('Р-38: a backtest window longer than 18 months or older than the retention is refused before reading anything', async () => {
  const base = { tenantId: TENANT, channelAccountId: ACCOUNT, scopes: [scope({ type: 'TARGET_MARGIN', targetMarginBp: 2000 })], history: history.snapshots, now: NOW };
  await assert.rejects(runBacktest({ ...base, window: { from: '2025-03-16T00:00:00.000Z', to: NOW } }), /longer than 18 months/);
  await assert.rejects(runBacktest({ ...base, window: { from: '2025-01-01T00:00:00.000Z', to: '2026-01-01T00:00:00.000Z' } }), /earlier than 18 months ago/);
});

test('the counterfactual snapshot keeps the competitors, replaces our price and re-ranks the Buy Box (a tie goes to the competitor)', () => {
  const recorded = history.snapshots[0]!;
  const lowestCompetitor = Math.min(...recorded.offers.filter((o) => !o.isSelf).map((o) => o.price.amountMinor));
  const tie = counterfactual(recorded, lowestCompetitor);
  assert.equal(tie.buybox?.isSelf, false);
  assert.deepEqual(tie.offers.filter((o) => !o.isSelf), recorded.offers.filter((o) => !o.isSelf).map((o) => ({ ...o, rank: tie.offers.find((x) => x.sellerRef === o.sellerRef)!.rank })));
  const cheaper = counterfactual(recorded, lowestCompetitor - 1);
  assert.equal(cheaper.buybox?.isSelf, true);
  assert.equal(cheaper.offers[0]?.price.amountMinor, lowestCompetitor - 1);
});

test('finding 2 of the step 21 review: the Buy Box metric compares our price with our shipping against competitor totals, like the counterfactual', () => {
  const recorded = history.snapshots[0]!;
  const lowestTotal = Math.min(...recorded.offers.filter((o) => !o.isSelf).map((o) => o.totalPrice?.amountMinor ?? o.price.amountMinor));
  const self = recorded.offers.find((o) => o.isSelf)!;
  const shipped = { ...recorded, offers: recorded.offers.map((o) => (o.isSelf ? { ...o, shipping: { ...self.price, amountMinor: 300 } } : o)) };
  // Цена на 1 цент ниже лучшего конкурента, но с нашей доставкой 3.00 — проигрыш, как в контрфактическом снимке
  assert.equal(wins(shipped, lowestTotal - 1), false, 'our shipping counts');
  assert.equal(wins(shipped, lowestTotal - 1), counterfactual(shipped, lowestTotal - 1).buybox?.isSelf, 'the metric agrees with the counterfactual Buy Box');
  assert.equal(wins(shipped, lowestTotal - 301), true);
});

test('18 months of synthetic history: undercutting wins the Buy Box more often at a lower margin, never below min_price; corrupted snapshots are rejected', async () => {
  const report = await runBacktest({ tenantId: TENANT, channelAccountId: ACCOUNT, scopes: [scope({ type: 'MATCH_BUYBOX', undercutMinor: 5, holdWhenWinning: false, atBound: 'CAP' })],
    history: history.snapshots, window: WINDOW, now: NOW, demand: { unitsPerBuyBoxHour: 0.2 } });
  const [s] = report.strategy.perScope;
  const [b] = report.baseline.perScope;
  assert.equal(report.snapshots, history.snapshots.length);
  assert.equal(s!.hours, b!.hours);
  assert.ok(s!.buyBoxShareBp > b!.buyBoxShareBp, `Buy Box ${s!.buyBoxShareBp} vs baseline ${b!.buyBoxShareBp}`);
  assert.ok(s!.avgMarginBp! < b!.avgMarginBp!, `margin ${s!.avgMarginBp} vs baseline ${b!.avgMarginBp}`);
  assert.ok(s!.priceChanges > 10, `changes ${s!.priceChanges}`);
  assert.ok(s!.lowestWrittenMinor! >= 1615, `lowest ${s!.lowestWrittenMinor}`);
  const corrupted = history.snapshots.filter((x) => x.offers.some((o) => o.price.amountMinor < 100)).length;
  assert.ok(corrupted > 0);
  assert.equal(s!.sanityRejected, corrupted, 'every snapshot with a price parsed ×0.01 is rejected by the input checks');
  assert.equal(b!.priceChanges, 0);
  assert.ok(s!.estimatedProfitMinor !== null && b!.estimatedProfitMinor !== null);
  // Калибровка правила Buy Box на синтетике тривиальна: генератор выбирает победителя тем же правилом
  assert.equal(report.buyBoxRuleMismatchBp, 0);
  assert.ok(LIES.length >= 6);
});

test('without a demand assumption the backtest reports no profit', async () => {
  const report = await runBacktest({ tenantId: TENANT, channelAccountId: ACCOUNT, scopes: [scope({ type: 'TARGET_MARGIN', targetMarginBp: 2000 })],
    history: history.snapshots.slice(0, 200), window: WINDOW, now: NOW });
  assert.equal(report.strategy.perScope[0]!.estimatedProfitMinor, null);
  // Цена для маржи округляется вверх, маржа при ней — вниз: не ниже цели и в пределах пары б. п.
  const margin = report.strategy.perScope[0]!.avgMarginBp!;
  assert.ok(margin >= 2000 && margin < 2010, `margin ${margin}`);
});

test('Р-125: the default backtest runs a sample of the products giving most revenue; the full catalog runs as a resumable background job with the same results', async () => {
  const { MemoryCatalogJobStore, runCatalogJob, runSampleBacktest, selectBacktestSample, BATCH_LIE } = await import('./backtest/catalog.ts');
  // Парето: 10 товаров, выручка 1000, 500, 200, 100×7 = 2400; пять первых — 79 %, шесть — 83 % (минимальная выборка — 2 товара)
  const revenue = [1000, 500, 200, 100, 100, 100, 100, 100, 100, 100].map((r, i) => ({ writeScopeId: `ws-${i}`, channelProductRef: String(362009000 + i), revenueMinor: r }));
  const eighty = selectBacktestSample(revenue, 'ORDER_LINES', { revenueShare: 0.8, maxProducts: 200, minProducts: 2 });
  assert.deepEqual([eighty.writeScopeIds, eighty.revenueCoverageBp, eighty.cappedBeforeShare], [['ws-0', 'ws-1', 'ws-2', 'ws-3', 'ws-4', 'ws-5'], 8_333, false]);
  const capped = selectBacktestSample(revenue, 'PRICE_ASSUMPTION', { revenueShare: 0.8, maxProducts: 2, minProducts: 1 });
  assert.deepEqual([capped.writeScopeIds.length, capped.revenueCoverageBp, capped.cappedBeforeShare, capped.source], [2, 6_250, true, 'PRICE_ASSUMPTION']);

  // Четыре товара рынка; выборка — два с наибольшей выручкой; полный каталог — партиями по 2, прерван после первой партии и продолжен
  const products = [0, 1, 2, 3].map((i) => ({ channelProductRef: String(362008200 + i), historicalSelfPriceMinor: 1990 + i * 100, marketPriceMinor: 1900 + i * 100 }));
  const market = { seed: 125, marketplace: 'de', currency: 'EUR', from: WINDOW.from, to: WINDOW.to, everyMs: 86_400_000, products, dailyVolatilityBp: 150, promo: { everyDays: 14, days: 2, discountBp: 1500 }, corruptShare: 0 };
  const scopes = products.map((p, i): MemorySeedScope => ({
    ...scope({ type: 'MATCH_BUYBOX', undercutMinor: 5, holdWhenWinning: false, atBound: 'CAP' }), writeScopeId: `ws-cat-${i}`, productId: `prod-cat-${i}`, externalUnitId: String(8200 + i),
    channelProductRef: p.channelProductRef, currentPriceMinor: p.historicalSelfPriceMinor, minPrice: { amountMinor: Math.round(p.marketPriceMinor * 0.85), id: `min-cat-${i}` },
    maxPrice: { amountMinor: Math.round(p.marketPriceMinor * 1.3), id: `max-cat-${i}` },
  }));
  const { syntheticSnapshots } = await import('./backtest/history.ts');
  const input = { tenantId: TENANT, channelAccountId: ACCOUNT, scopes, history: (refs: ReadonlySet<string>) => syntheticSnapshots({ ...market, products: products.filter((x) => refs.has(x.channelProductRef)) }), window: WINDOW, now: NOW };
  const sample = await runSampleBacktest(input, scopes.map((s, i) => ({ writeScopeId: s.writeScopeId, channelProductRef: s.channelProductRef, revenueMinor: (i + 1) * 1000 })), 'PRICE_ASSUMPTION',
    { revenueShare: 0.6, maxProducts: 200, minProducts: 1 });
  assert.deepEqual([sample.mode, sample.sample.writeScopeIds], ['SAMPLE', ['ws-cat-3', 'ws-cat-2']]);
  assert.deepEqual(sample.report.strategy.perScope.map((m) => m.writeScopeId).sort(), ['ws-cat-2', 'ws-cat-3']);

  const store = new MemoryCatalogJobStore();
  const interrupted = await runCatalogJob('job-1', input, store, { batchProducts: 2, maxBatches: 1 });
  assert.deepEqual([interrupted.completed, interrupted.batchesDone, interrupted.batchesTotal], [false, 1, 2]);
  const resumed = await runCatalogJob('job-1', input, store, { batchProducts: 2 });
  assert.deepEqual([resumed.completed, resumed.batchesDone], [true, 2]);
  assert.ok(resumed.lies.includes(BATCH_LIE));
  // Товары независимы (массового сдвига нет): полный каталог по партиям = выборке по тем же товарам
  const strip = (m: { writeScopeId: string; buyBoxShareBp: number; avgMarginBp: number | null; priceChanges: number }) => [m.writeScopeId, m.buyBoxShareBp, m.avgMarginBp, m.priceChanges];
  const fromJob = resumed.perScope.filter((m) => m.writeScopeId === 'ws-cat-2' || m.writeScopeId === 'ws-cat-3').map(strip).sort();
  assert.deepEqual(fromJob, sample.report.strategy.perScope.map(strip).sort());
});
