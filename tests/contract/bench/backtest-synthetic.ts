import { writeFileSync } from 'node:fs';
import type { StrategyParams } from '@repracer/pricing-model';
import { runBacktest, type BacktestReport } from '../src/backtest/backtest.ts';
import { syntheticHistory } from '../src/backtest/history.ts';

/**
 * Шаг 21: бэктест четырёх стратегий на синтетической истории за 18 месяцев [Р-38]. Итог — JSON в docs/benchmarks/results.
 * Запуск: node --experimental-strip-types tests/contract/bench/backtest-synthetic.ts [интервал_снимков_мс]. Данные синтетические.
 */
const everyMs = Number(process.argv[2] ?? 7_200_000);
const now = '2026-09-17T00:00:00.000Z';
const window = { from: '2025-03-17T00:00:00.000Z', to: now };
const products = [0, 1, 2, 3].map((i) => ({ channelProductRef: String(362008001 + i), historicalSelfPriceMinor: 1990 + i * 300, marketPriceMinor: 1900 + i * 300 }));
const market = { seed: 38, marketplace: 'de', currency: 'EUR', from: window.from, to: window.to, everyMs, products, dailyVolatilityBp: 150,
  promo: { everyDays: 14, days: 2, discountBp: 1500 }, corruptShare: 0.0005 };
const history = syntheticHistory(market);
const ACCOUNT = '20000000-0000-4000-8000-000000000001';

const strategies: Array<{ label: string; params: StrategyParams }> = [
  { label: 'MATCH_BUYBOX −5, hold when winning', params: { type: 'MATCH_BUYBOX', undercutMinor: 5, holdWhenWinning: true, atBound: 'CAP' } },
  { label: 'MATCH_BUYBOX −5, no hold', params: { type: 'MATCH_BUYBOX', undercutMinor: 5, holdWhenWinning: false, atBound: 'CAP' } },
  { label: 'BEAT_LOWEST −5 landed, HOLD at bound', params: { type: 'BEAT_LOWEST', undercutMinor: 5, scope: 'VISIBLE_TOP_N', compareLanded: true, atBound: 'HOLD' } },
  { label: 'TARGET_MARGIN 20 %', params: { type: 'TARGET_MARGIN', targetMarginBp: 2000 } },
];

const results: Array<{ label: string; report: BacktestReport }> = [];
for (const s of strategies) {
  const scopes = products.map((p, i) => ({
    writeScopeId: `ws-bt-${i}`, productId: `prod-bt-${i}`, channelAccountId: ACCOUNT, marketplace: 'de', externalUnitId: String(8001 + i), channelProductRef: p.channelProductRef,
    condition: 'new', currency: 'EUR', basis: 'GROSS' as const, pricingMode: 'ENGINE' as const,
    strategy: { strategyId: 'st-bt', version: 1, params: s.params, deadbandMinor: 0 },
    currentPriceMinor: p.historicalSelfPriceMinor, minPrice: { amountMinor: Math.round(p.marketPriceMinor * 0.85), id: `min-bt-${i}` }, maxPrice: { amountMinor: Math.round(p.marketPriceMinor * 1.3), id: `max-bt-${i}` },
    cost: { currency: 'EUR', costProfileId: `cp-bt-${i}`, unitCostMinor: Math.round(p.marketPriceMinor * 0.55), fixedFeeMinor: 0, feeRateBp: 1200, tax: { regime: 'VAT_INCLUDED' as const, vatRateBp: 1900 } },
  }));
  const report = await runBacktest({ tenantId: '10000000-0000-4000-8000-000000000001', channelAccountId: ACCOUNT, scopes, history: history.snapshots, window, now, demand: { unitsPerBuyBoxHour: 0.2 } });
  results.push({ label: s.label, report });
  console.log(`${s.label}: ${report.snapshots} snapshots, ${report.elapsedMs} ms`);
  for (const [k, bundle] of [['strategy', report.strategy], ['baseline', report.baseline]] as const) {
    for (const m of bundle.perScope) console.log(`  ${k} ${m.writeScopeId} bb ${m.buyBoxShareBp} margin ${m.avgMarginBp}/${m.minMarginBp} changes ${m.priceChanges} gate ${m.gateRejected} dangerous ${m.dangerousStopped} sanity ${m.sanityRejected} units ${m.estimatedUnits} profit ${m.estimatedProfitMinor}`);
  }
}
const out = process.env.BACKTEST_OUT;
if (out) writeFileSync(out, `${JSON.stringify({ market: { ...market, products }, everyMs, results }, null, 2)}\n`);
