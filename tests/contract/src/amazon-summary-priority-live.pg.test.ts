import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { summaryRounds } from '@repracer/pricing-pipeline';
import { createPool, type PgPool } from '@repracer/pricing-store-pg';
import { createScheduler, DEFAULT_JOB_CONFIG, jobSource, PgSchedulerState, pgJobDeps, runScheduler, type JobDeps } from '@repracer/scheduler';
import { createIsolatedDatabase, requireEnv } from '../../../packages/pricing-store-pg/test/isolated-db.ts';
import { VirtualClock } from './harness/world.ts';
import { amazonLiveWorld, type AmazonLiveWorld } from './live/amazon-world.ts';

/**
 * Шаг 117 (P0-16, решение владельца 2026-11-07) [Р-240, Р-128]: живой прогон обеих цифр круга на модельном каталоге больше 1 000 предложений. 1 200 предложений
 * amazon.com: 200 — цену решает конкурент («подрезать самого дешёвого»), 1 000 — фиксированная цена. Настоящий планировщик и работа `amazon-summary-poll`,
 * путь решения и PostgreSQL, модель порта Amazon (0.033 запроса в секунду на пару, пакет 20). Утверждается наблюдаемое: конкурентное предложение читается
 * не реже раза в конкурентный круг, остальное — хотя бы раз за полный круг, и обе цифры совпадают с формулой абзаца. Данные синтетические
 */
const OFFERS = 1200;
const COMPETITIVE = 200;
const TICK_MS = 5_000;
const MINUTE = 60_000;
const { amazonBatch, amazonCallSeconds } = DEFAULT_JOB_CONFIG;
const rounds = summaryRounds({ competitive: COMPETITIVE, other: OFFERS - COMPETITIVE, batch: amazonBatch, intervalSeconds: amazonCallSeconds });
const RUN_MS = rounds.fullSeconds * 1000 + 20 * MINUTE;

const BEAT = { strategyId: 'st-amz-lowest', version: 1, deadbandMinor: 0,
  params: { type: 'BEAT_LOWEST' as const, undercutMinor: 1, scope: 'VISIBLE_TOP_N' as const, compareLanded: false, atBound: 'CAP' as const } };
const FIXED = { strategyId: 'st-amz-fixed', version: 1, deadbandMinor: 0, params: { type: 'FIXED' as const, priceMinor: 1850 } };

let db: Awaited<ReturnType<typeof createIsolatedDatabase>>;
let observer: PgPool;
let clock: VirtualClock;
let world: AmazonLiveWorld;
let startMs: number;
let seconds = 0;

before(async () => {
  requireEnv('REPRACER_PG_ADMIN_URL');
  const started = Date.now();
  db = await createIsolatedDatabase('amzprio');
  const url = new URL(process.env.REPRACER_PG_ADMIN_URL!); url.pathname = `/${db.name}`;
  observer = createPool(url.toString(), { max: 1, applicationName: 'repracer-amazon-priority-observer' });
  clock = new VirtualClock(new Date(Date.now() - 6 * 3_600_000).toISOString());
  const pools = { appPool: db.pool('svc_app', 4), adminPool: db.pool('svc_admin', 2), provisioningPool: db.pool('svc_provisioning', 1), dispatcherPool: db.pool('svc_dispatcher', 2) };
  world = await amazonLiveWorld({
    tag: 1172, clock, offers: OFFERS, seed: 1172, lossShare: 0, priceChangeEveryHours: 0.5, us: true, engine: true, writeMode: 'SHADOW', fxLoaderPool: db.pool('svc_fx_loader', 1), ...pools,
    strategyOf: (i) => (i < COMPETITIVE ? BEAT : FIXED as never),
  });
  startMs = clock.nowMs();
  const schedulerPool = db.pool('svc_scheduler', 2);
  const pipeline = world.pipelineForDbIds();
  const base = pgJobDeps({
    schedulerPool, exporterPool: db.pool('svc_exporter', 1), ingest: null as never, verifier: null as never,
    descriptorOf: (channel) => (channel === 'AMAZON' ? world.port.descriptor : null), pipelineFor: () => pipeline,
  });
  const deps: JobDeps = { ...base, exportDay: async (range) => ({ range, exports: [], unverified: [], missing: [] }), exportBacklog: async () => [] };
  const scheduler = createScheduler({ state: new PgSchedulerState(schedulerPool), source: jobSource(deps), owner: 'amazon-priority', now: () => clock.iso(), alerts: { raise: async () => {} } });
  const endMs = clock.nowMs() + RUN_MS;
  await runScheduler(scheduler, {
    tickMs: TICK_MS, clockMs: () => clock.nowMs(), logger: { log: () => {} },
    sleep: async (d) => { clock.advance(d); await world.sweep(); }, shouldStop: () => clock.nowMs() > endMs,
  }).finished;
  seconds = Math.round((Date.now() - started) / 100) / 10;
});

after(async () => {
  await observer?.end();
  await db?.drop();
});

test('step 117 (P0-16): 1 200 offers, 200 priced from competitors — the competitive round and the full round are the figures of the paragraph', () => {
  const reads = (i: number) => (world.comparedAt.get(world.asins[i]!) ?? []).sort((a, b) => a - b);
  const competitive = Array.from({ length: COMPETITIVE }, (_, i) => i);
  const rest = Array.from({ length: OFFERS - COMPETITIVE }, (_, k) => COMPETITIVE + k);
  // Конкурентный круг — самый долгий промежуток между чтениями конкурентного предложения (и от старта до первого чтения)
  const competitiveRound = Math.max(...competitive.map((i) => {
    const at = [startMs, ...reads(i)];
    return Math.max(...at.slice(1).map((t, k) => t - at[k]!));
  }));
  // Полный круг — когда прочитано последнее из остальных (впервые от старта)
  const fullRound = Math.max(...rest.map((i) => (reads(i)[0] ?? Number.POSITIVE_INFINITY) - startMs));
  console.log(JSON.stringify({ step117rounds: { offers: OFFERS, competitive: COMPETITIVE, formula: rounds,
    measured: { competitiveRoundSeconds: Math.round(competitiveRound / 1000), fullRoundSeconds: Math.round(fullRound / 1000) },
    competitiveReads: competitive.reduce((n, i) => n + reads(i).length, 0), otherReads: rest.reduce((n, i) => n + reads(i).length, 0),
    virtualMinutes: Math.round(RUN_MS / MINUTE), rateLimited: world.port.stats.summaryRateLimited, seconds } }));
  assert.equal(world.port.stats.summaryRateLimited, 0, 'the pair budget was kept');
  const window = amazonCallSeconds * 1000;
  assert.ok(competitiveRound > 0 && competitiveRound <= rounds.competitiveSeconds * 1000 + 2 * window,
    `a competitive offer waits at most ${Math.round(competitiveRound / 1000)} s; the competitive round of the paragraph is ${rounds.competitiveSeconds} s`);
  // Остальные не голодают: каждое прочитано, последнее — не позже полного круга
  assert.ok(Number.isFinite(fullRound) && fullRound <= rounds.fullSeconds * 1000 + 2 * window,
    `every other offer is read within the full round: the last at ${Math.round(fullRound / 1000)} s, the full round of the paragraph is ${rounds.fullSeconds} s`);
});
