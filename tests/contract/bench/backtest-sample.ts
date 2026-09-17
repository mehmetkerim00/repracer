import { writeFileSync } from 'node:fs';
import { runSampleBacktest } from '../src/backtest/catalog.ts';
import { syntheticSnapshots } from '../src/backtest/history.ts';

/**
 * Р-125 (шаг 25): бэктест выборки на каталоге — сколько товаров и какая доля выручки попадает в выборку по умолчанию, за сколько она
 * считается. Выручка каталога — синтетическое распределение Ципфа (товар i — 1/(i+1)): так распределены продажи типичного каталога
 * (допущение). История — 18 месяцев, снимок раз в 30 минут; генератор строит историю только товаров выборки. Данные синтетические.
 *   node --experimental-strip-types tests/contract/bench/backtest-sample.ts <товаров> [out.json]
 */
const productCount = Number(process.argv[2] ?? 10_000);
const out = process.argv[3];
const everyMs = 1_800_000;
const now = '2026-09-17T00:00:00.000Z';
const window = { from: '2025-03-17T00:00:00.000Z', to: now };
const ACCOUNT = '20000000-0000-4000-8000-000000000001';
const products = Array.from({ length: productCount }, (_, i) => ({
  channelProductRef: String(362000000 + i), historicalSelfPriceMinor: 1990 + (i % 40) * 150, marketPriceMinor: 1900 + (i % 40) * 150,
}));
const scopes = products.map((p, i) => ({
  writeScopeId: `ws-bt-${i}`, productId: `prod-bt-${i}`, channelAccountId: ACCOUNT, marketplace: 'de', externalUnitId: String(80000 + i), channelProductRef: p.channelProductRef,
  condition: 'new', currency: 'EUR', basis: 'GROSS' as const, pricingMode: 'ENGINE' as const,
  strategy: { strategyId: 'st-bt', version: 1, params: { type: 'MATCH_BUYBOX' as const, undercutMinor: 5, holdWhenWinning: false, atBound: 'CAP' as const }, deadbandMinor: 0 },
  currentPriceMinor: p.historicalSelfPriceMinor, minPrice: { amountMinor: Math.round(p.marketPriceMinor * 0.85), id: `min-bt-${i}` }, maxPrice: { amountMinor: Math.round(p.marketPriceMinor * 1.3), id: `max-bt-${i}` },
  cost: { currency: 'EUR', costProfileId: `cp-bt-${i}`, unitCostMinor: Math.round(p.marketPriceMinor * 0.55), fixedFeeMinor: 0, feeRateBp: 1200, tax: { regime: 'VAT_INCLUDED' as const, vatRateBp: 1900 } },
}));
const revenue = scopes.map((s, i) => ({ writeScopeId: s.writeScopeId, channelProductRef: s.channelProductRef, revenueMinor: Math.round(100_000_000 / (i + 1)) }));
let peakRss = 0;
const sampler = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 500);
const started = Date.now();
const r = await runSampleBacktest({
  tenantId: '10000000-0000-4000-8000-000000000001', channelAccountId: ACCOUNT, scopes, window, now,
  history: (refs) => syntheticSnapshots({ seed: 25, marketplace: 'de', currency: 'EUR', from: window.from, to: window.to, everyMs, products: products.filter((p) => refs.has(p.channelProductRef)),
    dailyVolatilityBp: 150, promo: { everyDays: 14, days: 2, discountBp: 1500 }, corruptShare: 0.0005 }),
}, revenue, 'PRICE_ASSUMPTION');
clearInterval(sampler);
peakRss = Math.max(peakRss, process.memoryUsage().rss);
const result = {
  catalogProducts: productCount, sampledProducts: r.sample.writeScopeIds.length, revenueCoverageBp: r.sample.revenueCoverageBp, cappedBeforeShare: r.sample.cappedBeforeShare,
  everyMs, window, snapshots: r.report.snapshots, elapsedMs: Date.now() - started, snapshotsPerSecond: Math.round((r.report.snapshots * 1000) / r.report.elapsedMs),
  peakRssMb: Math.round(peakRss / 1e6), halts: r.report.halts, node: process.version,
};
console.log(JSON.stringify(result));
if (out) writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
