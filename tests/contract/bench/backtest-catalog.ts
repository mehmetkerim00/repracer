import { writeFileSync } from 'node:fs';
import { runBacktest } from '../src/backtest/backtest.ts';
import { syntheticSnapshots } from '../src/backtest/history.ts';

/**
 * Шаг 24 (OQ-161): бэктест по каталогу за 18 месяцев — время, пропускная способность и память. История потоком, хранилище в памяти
 * удаляет строки по сроку. Данные синтетические. Запуск:
 *   node --experimental-strip-types tests/contract/bench/backtest-catalog.ts <товаров> <интервал_снимков_мс> [out.json]
 */
const productCount = Number(process.argv[2] ?? 1000);
const everyMs = Number(process.argv[3] ?? 7_200_000);
const out = process.argv[4];
const now = '2026-09-17T00:00:00.000Z';
const window = { from: '2025-03-17T00:00:00.000Z', to: now };
const products = Array.from({ length: productCount }, (_, i) => ({
  channelProductRef: String(362000000 + i), historicalSelfPriceMinor: 1990 + (i % 40) * 150, marketPriceMinor: 1900 + (i % 40) * 150,
}));
const ACCOUNT = '20000000-0000-4000-8000-000000000001';
const scopes = products.map((p, i) => ({
  writeScopeId: `ws-bt-${i}`, productId: `prod-bt-${i}`, channelAccountId: ACCOUNT, marketplace: 'de', externalUnitId: String(80000 + i), channelProductRef: p.channelProductRef,
  condition: 'new', currency: 'EUR', basis: 'GROSS' as const, pricingMode: 'ENGINE' as const,
  strategy: { strategyId: 'st-bt', version: 1, params: { type: 'MATCH_BUYBOX' as const, undercutMinor: 5, holdWhenWinning: false, atBound: 'CAP' as const }, deadbandMinor: 0 },
  currentPriceMinor: p.historicalSelfPriceMinor, minPrice: { amountMinor: Math.round(p.marketPriceMinor * 0.85), id: `min-bt-${i}` }, maxPrice: { amountMinor: Math.round(p.marketPriceMinor * 1.3), id: `max-bt-${i}` },
  cost: { currency: 'EUR', costProfileId: `cp-bt-${i}`, unitCostMinor: Math.round(p.marketPriceMinor * 0.55), fixedFeeMinor: 0, feeRateBp: 1200, tax: { regime: 'VAT_INCLUDED' as const, vatRateBp: 1900 } },
}));
let peakRss = 0;
const sampler = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 500);
const history = syntheticSnapshots({ seed: 24, marketplace: 'de', currency: 'EUR', from: window.from, to: window.to, everyMs, products, dailyVolatilityBp: 150,
  promo: { everyDays: 14, days: 2, discountBp: 1500 }, corruptShare: 0.0005 });
const report = await runBacktest({ tenantId: '10000000-0000-4000-8000-000000000001', channelAccountId: ACCOUNT, scopes, history, window, now });
clearInterval(sampler);
peakRss = Math.max(peakRss, process.memoryUsage().rss);
const sum = (f: (m: (typeof report.strategy.perScope)[number]) => number) => report.strategy.perScope.reduce((s, m) => s + f(m), 0);
const result = {
  products: productCount, everyMs, window, snapshots: report.snapshots, elapsedMs: report.elapsedMs,
  snapshotsPerSecond: Math.round((report.snapshots * 1000) / report.elapsedMs), peakRssMb: Math.round(peakRss / 1e6),
  halts: report.halts, sanityRejected: sum((m) => m.sanityRejected), priceChanges: sum((m) => m.priceChanges), gateRejected: sum((m) => m.gateRejected),
  belowMinPrice: report.strategy.perScope.filter((m, i) => m.lowestWrittenMinor !== null && m.lowestWrittenMinor < scopes[i]!.minPrice.amountMinor).length,
  node: process.version,
};
console.log(JSON.stringify(result));
if (out) writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
