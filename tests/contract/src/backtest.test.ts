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
