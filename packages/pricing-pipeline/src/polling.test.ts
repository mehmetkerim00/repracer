import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_TIERS } from './polling.ts';
import { planPollingTiers, planSubscriptionCatchUp } from './index.ts';

test('tiers follow volatility and fit the budget by demoting the least volatile first', () => {
  const items = [
    { key: 'a', changesLast30Days: 300 },
    { key: 'b', changesLast30Days: 150 },
    { key: 'c', changesLast30Days: 30 },
    ...Array.from({ length: 1000 }, (_, i) => ({ key: `tail-${i}`, changesLast30Days: 0 })),
  ];
  const roomy = planPollingTiers(items, 1);
  assert.deepEqual(roomy.assignments.slice(0, 3).map((a) => a.tier), ['HOT', 'HOT', 'WARM']);
  assert.equal(roomy.assignments.at(-1)?.tier, 'COLD');
  assert.equal(roomy.demoted.length, 0);

  // 2 горячих = 1/60 rps, тёплый 1/3600, суточный хвост 1000 = 0.0116: всего 0.0285. Бюджет 0.021:
  // понижение одного горячего даёт 0.02046 — достаточно, второй остаётся горячим
  const tight = planPollingTiers(items, 0.021);
  assert.deepEqual(tight.demoted[0], { key: 'b', from: 'HOT', to: 'WARM' });
  assert.equal(tight.assignments.find((a) => a.key === 'a')?.tier, 'HOT');
  assert.equal(tight.demoted.length, 1);
  assert.ok(tight.requiredRequestsPerSecond <= 0.021);

  const impossible = planPollingTiers(items, 0.001);
  assert.equal(impossible.coldTierExceedsBudget, true);
});

test('catch-up after a lost subscription restores subscriptions, then stock, then prices by tier', () => {
  const tasks = planSubscriptionCatchUp({
    lostAt: '2026-09-14T00:00:00.000Z', restoredAt: '2026-09-14T13:00:00.000Z', marketplaces: ['de'],
    units: [{ marketplace: 'de', externalUnitId: '4101' }],
    products: [
      { marketplace: 'de', channelProductRef: '2', condition: 'new', tier: 'COLD' },
      { marketplace: 'de', channelProductRef: '1', condition: 'new', tier: 'HOT' },
    ],
  });
  assert.deepEqual(tasks.map((t) => t.kind), ['ENSURE_SUBSCRIPTIONS', 'READ_ORDER_LINES', 'READBACK_UNIT', 'POLL_COMPETITORS', 'POLL_COMPETITORS', 'RECONCILE_REPORT']);
  assert.ok(tasks[1]?.kind === 'READ_ORDER_LINES' && tasks[1].since === '2026-09-13T23:45:00.000Z');
  assert.ok(tasks[3]?.kind === 'POLL_COMPETITORS' && tasks[3].tier === 'HOT');
});

test('step 24: the snapshot volume model of the compression benchmark polls with the same tier intervals as DEFAULT_TIERS', async () => {
  const { readFileSync } = await import('node:fs');
  const bench = readFileSync(new URL('../../analytics-export/bench/compression.bench.ts', import.meta.url), 'utf8');
  const m = /BENCH_TIER_INTERVALS_SECONDS = \{ hot: ([\d_]+), warm: ([\d_]+), cold: ([\d_]+) \}/.exec(bench);
  assert.ok(m, 'the benchmark declares its tier intervals');
  const n = (v: string) => Number(v.replace(/_/g, ''));
  assert.deepEqual([n(m[1]!), n(m[2]!), n(m[3]!)], [DEFAULT_TIERS.hot.intervalSeconds, DEFAULT_TIERS.warm.intervalSeconds, DEFAULT_TIERS.cold.intervalSeconds]);
});

test('Р-128: волатильность неизвестна — проба не реже тёплого яруса; известная неподвижность оставляет товар холодным', () => {
  const plan = planPollingTiers([
    { key: 'new-quiet', changesLast30Days: 0, volatilityKnown: false },
    { key: 'known-quiet', changesLast30Days: 0, volatilityKnown: true },
    { key: 'default-quiet', changesLast30Days: 0 },
    { key: 'new-busy', changesLast30Days: 300, volatilityKnown: false },
  ], 1);
  const tier = (key: string) => plan.assignments.find((a) => a.key === key)!.tier;
  assert.equal(tier('new-quiet'), 'WARM', 'новый товар без наблюдений опрашивается не реже тёплого яруса');
  assert.equal(tier('known-quiet'), 'COLD', 'наблюдаемый неподвижный товар остаётся холодным');
  assert.equal(tier('default-quiet'), 'COLD', 'по умолчанию волатильность считается известной');
  assert.equal(tier('new-busy'), 'HOT', 'проба не понижает товар, который уже виден как волатильный');
  // Бюджет: проба понижается так же, как тёплый ярус
  const tight = planPollingTiers([...Array.from({ length: 100 }, (_, i) => ({ key: `probe-${i}`, changesLast30Days: 0, volatilityKnown: false }))], 0.002);
  assert.ok(tight.demoted.length > 0 && tight.assignments.some((a) => a.tier === 'COLD'), 'при нехватке бюджета проба понижается до холодного яруса');
});
