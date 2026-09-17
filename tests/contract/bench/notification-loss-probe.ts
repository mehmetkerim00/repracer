/**
 * Шаг 24 [Р-121]: сверка опросом на модели Kaufland — сколько потерянных buy_box_changed обнаруживается и сколько ложных тревог при
 * разных потерях, debounce (K-10) и частоте опроса. 72 часа мира, 5 зёрен. Результат — docs/evidence/step24-notification-loss-simulator.jsonl.
 * Запуск: node --experimental-strip-types tests/contract/bench/notification-loss-probe.ts
 */
import { kauflandUnderTest } from '../src/adapters.ts';
import { runScenario } from '../src/harness/runner.ts';
import { loadScenarios } from '../src/harness/scenario.ts';
const loaded = loadScenarios(new URL('../fixtures/kaufland-sim/', import.meta.url).pathname);
const base = loaded.find((l) => l.scenario.id === 'kaufland-sim/notification-loss-reconciliation')!.scenario;
for (const [loss, debounce, tick] of [[0, 60_000, 300_000], [0.3, 60_000, 300_000], [0.3, 60_000, 900_000], [0, 300_000, 300_000], [0, 1_200_000, 300_000], [1, 0, 300_000]] as const) {
  const agg = { runs: 0, buyBoxChanges: 0, scheduled: 0, lost: 0, delivered: 0, polls: 0, diverged: 0, delayed: 0, lossSuspected: 0 };
  for (const seed of [11, 23, 37, 41, 59]) {
    const s = structuredClone(base);
    (s.world as any).channelModel.seed = seed;
    (s.world as any).channelModel.params.buyBoxChanged = { delivered: loss < 1, lossShare: loss, debounceMs: debounce };
    Object.assign(s.steps[0] as any, { durationMs: 72 * 3_600_000, tickMs: tick, expect: undefined });
    s.expect = {}; delete (s as any).variants;
    let st: any;
    const r = await runScenario(s, kauflandUnderTest, undefined, undefined, { async onFinish(f) { st = (f.simulator!.dump() as { stats: unknown }).stats; } });
    const run = r.results['twelve-hours'] as any;
    agg.runs++; agg.buyBoxChanges += st.buyBoxChanges; agg.scheduled += st.notificationsScheduled; agg.lost += st.notificationsLost; agg.delivered += st.notificationsDelivered;
    agg.polls += st.requests['GET /v2/buybox'] ?? 0; agg.diverged += run.reconciliation.diverged; agg.delayed += run.loss.delayed; agg.lossSuspected += run.loss.lossSuspected;
  }
  console.log(JSON.stringify({ lossShare: loss, debounceMs: debounce, pollEveryMs: tick, hours: 72, seeds: 5, ...agg }));
}
