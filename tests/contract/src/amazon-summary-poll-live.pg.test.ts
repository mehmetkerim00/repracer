import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createPool, PgPricingStore, type PgPool } from '@repracer/pricing-store-pg';
import { createScheduler, jobSource, PgSchedulerState, pgJobDeps, runScheduler, type JobDeps } from '@repracer/scheduler';
import { createIsolatedDatabase, requireEnv } from '../../../packages/pricing-store-pg/test/isolated-db.ts';
import { VirtualClock } from './harness/world.ts';
import { amazonLiveWorld, type AmazonLiveWorld } from './live/amazon-world.ts';
import { noViewMajority } from './simulator/amazon-port.ts';

/**
 * Шаг 115 [Р-240, Р-128]: живой прогон — конкуренты Amazon известны ТОЛЬКО из опроса `getCompetitiveSummary`, как у пилота без скоупа уведомлений.
 * Настоящий планировщик и его работа, настоящий путь решения и PostgreSQL; канал — модель порта Amazon: 0.033 запроса в секунду на пару, burst 1,
 * пакет 20 товаров [док]. Цель аудита §4.1 — каталог обновляется кругом: 1 000 предложений — 50 окон по 31 с, около 26 минут; здесь 120 — 6 окон,
 * 186 с. Утверждается наблюдаемое: темп вызовов, охват, решения из снимков опроса, держатель Buy Box, тишина алертов о потере. Данные синтетические
 */
const OFFERS = 120;
/** Стратегия «Win the Buy Box» — у первых шести товаров с большинством просмотров и первых шести без него; номер в мире — `B0LIVE<tag><i>` */
const asinAt = (i: number) => `B0LIVE1150${String(i).padStart(2, '0')}`;
const indexes = Array.from({ length: OFFERS }, (_, i) => i);
const WIN_MAJORITY = indexes.filter((i) => !noViewMajority(asinAt(i))).slice(0, 6);
const WIN_NO_MAJORITY = indexes.filter((i) => noViewMajority(asinAt(i))).slice(0, 6);
const WIN_INDEXES = new Set([...WIN_MAJORITY, ...WIN_NO_MAJORITY]);
const ROUND_MS = Math.ceil(OFFERS / 20) * 31_000;
const TICK_MS = 5_000;
const MINUTE = 60_000;

let db: Awaited<ReturnType<typeof createIsolatedDatabase>>;
let observer: PgPool;
let clock: VirtualClock;
let world: AmazonLiveWorld;
let store: PgPricingStore;
let startMs: number;
let runScheduled: (ms: number) => Promise<void>;
const alerts: Array<{ code: string; severity: string }> = [];

const WIN = { strategyId: 'st-amz-win', version: 1, deadbandMinor: 0, params: { type: 'WIN_BUYBOX' as const, undercutMinor: 1, fulfillmentHandicapMinor: 0, creepUp: false, creepStepBp: 100, atBound: 'CAP' as const } };

const BEAT = { strategyId: 'st-amz-lowest', version: 1, deadbandMinor: 0, params: { type: 'BEAT_LOWEST' as const, undercutMinor: 1, scope: 'VISIBLE_TOP_N' as const, compareLanded: false, atBound: 'CAP' as const } } as never;

before(async () => {
  requireEnv('REPRACER_PG_ADMIN_URL');
  db = await createIsolatedDatabase('amzsummary');
  const url = new URL(process.env.REPRACER_PG_ADMIN_URL!); url.pathname = `/${db.name}`;
  observer = createPool(url.toString(), { max: 1, applicationName: 'repracer-amazon-summary-observer' });
  clock = new VirtualClock(new Date(Date.now() - 3 * 3_600_000).toISOString());
  startMs = clock.nowMs();
  const pools = { appPool: db.pool('svc_app', 4), adminPool: db.pool('svc_admin', 2), provisioningPool: db.pool('svc_provisioning', 1), dispatcherPool: db.pool('svc_dispatcher', 2) };
  world = await amazonLiveWorld({
    tag: 1150, clock, offers: OFFERS, seed: 1150, lossShare: 0, priceChangeEveryHours: 0.25, us: true, engine: true, writeMode: 'SHADOW', fxLoaderPool: db.pool('svc_fx_loader', 1), ...pools,
    strategyOf: (i) => (WIN_INDEXES.has(i) ? WIN as never : BEAT),
  });
  store = new PgPricingStore(pools.appPool, { adminPool: pools.adminPool });
  const schedulerPool = db.pool('svc_scheduler', 2);
  const pipeline = world.pipelineForDbIds();
  const base = pgJobDeps({
    schedulerPool, exporterPool: db.pool('svc_exporter', 1), ingest: null as never, verifier: null as never,
    descriptorOf: (channel) => (channel === 'AMAZON' ? world.port.descriptor : null), pipelineFor: () => pipeline,
  });
  const deps: JobDeps = { ...base, exportDay: async (range) => ({ range, exports: [], unverified: [], missing: [] }), exportBacklog: async () => [] };
  const scheduler = createScheduler({ state: new PgSchedulerState(schedulerPool), source: jobSource(deps), owner: 'amazon-summary', now: () => clock.iso(),
    alerts: { raise: async (a) => { alerts.push({ code: a.code, severity: a.severity }); } } });
  runScheduled = async (ms) => {
    const endMs = clock.nowMs() + ms;
    await runScheduler(scheduler, {
      tickMs: TICK_MS, clockMs: () => clock.nowMs(), logger: { log: () => {} },
      sleep: async (d) => { clock.advance(d); await world.sweep(); },
      shouldStop: () => clock.nowMs() > endMs,
    }).finished;
  };
  // Час виртуального времени: конкурент двигает цену каждые 15 минут, уведомлений нет вовсе
  await runScheduled(60 * MINUTE);
  const calls = [...new Set([...world.summaryCalls.values()].flat())].length;
  console.log(JSON.stringify({ step115: { offers: OFFERS, calls, rateLimited: world.port.stats.summaryRateLimited, reads: [...world.comparedAt.values()].flat().length, patches: world.port.stats.patchCalls } }));
});

after(async () => {
  await observer?.end();
  await db?.drop();
});

test('step 115 [Р-240]: the pace is the pair budget — windows at least 31 s apart, not one refused; every offer is read within a round and never waits longer', () => {
  assert.equal(world.port.stats.summaryRateLimited, 0, 'the channel model refused nothing at 0.033 rps, burst 1');
  const calls = [...new Set([...world.summaryCalls.values()].flat())].sort((a, b) => a - b);
  const closest = Math.min(...calls.slice(1).map((t, i) => t - calls[i]!));
  assert.ok(closest >= 31_000, `two calls closer than the limit: ${closest} ms`);
  assert.ok(calls.length >= 100 && calls.length <= 3600 / 30.3 + 1, `about one call in 31 seconds: ${calls.length} in an hour`);
  for (const asin of world.asins) {
    const at = (world.comparedAt.get(asin) ?? []).sort((a, b) => a - b);
    assert.ok(at.length > 0, `${asin} was never read`);
    assert.ok(at[0]! - startMs <= ROUND_MS + 2 * 31_000, `${asin}: first read ${Math.round((at[0]! - startMs) / 1000)} s after the start, the round is ${ROUND_MS / 1000} s`);
    const longest = Math.max(0, ...at.slice(1).map((t, i) => t - at[i]!));
    assert.ok(longest <= ROUND_MS + 2 * 31_000, `${asin}: ${Math.round(longest / 1000)} s between reads, the round is ${ROUND_MS / 1000} s`);
  }
});

test('step 115 [Р-240]: the summary decides — snapshots are accepted on the decision path, a competitor move becomes our price within a round; shadow sends nothing', async () => {
  const { rows: log } = await observer.query(`SELECT source, sanity_verdict, delivery, count(*)::int AS n FROM channel_data.competitor_snapshot_log GROUP BY 1, 2, 3`);
  assert.deepEqual(log.filter((r) => r.source !== 'AMAZON_COMPETITIVE_SUMMARY'), [], `no other source in this world: ${JSON.stringify(log)}`);
  const accepted = log.find((r) => r.sanity_verdict === 'ACCEPT');
  assert.equal(accepted?.delivery, 'POLL');
  assert.equal(log.reduce((a, r) => a + r.n, 0), [...world.comparedAt.values()].flat().length, 'every read is logged');
  assert.ok(accepted!.n > 1000, `decisions come from these snapshots: ${JSON.stringify(log)}`);
  assert.equal(log.filter((r) => r.sanity_verdict === 'RECONCILIATION').length, 0, 'no snapshot took the reconciliation-only path');
  // Предложение со стратегией «подрезать самого дешёвого»: первое настоящее движение конкурента — вторая ступень мира, на 30 + i минуте, 18,00 → 15,00; подрез на цент — 14,99, выше пола 14,00
  const i = indexes.find((x) => !WIN_INDEXES.has(x) && x >= 15)!;
  const movedAtMs = startMs + 30 * MINUTE + i * MINUTE;
  const ws = world.seeded.ids.dbId(`ws-amz-${world.asins[i]}`);
  const { rows } = await observer.query(
    `SELECT decided_at, proposed_amount_minor, rule_code, shadow, competitor_derived FROM channel_data.price_decision WHERE write_scope_id = $1 AND proposed_amount_minor = 1499 ORDER BY decided_at LIMIT 1`, [ws]);
  assert.equal(rows.length, 1, 'the move became a proposal');
  const reacted = new Date(rows[0].decided_at).getTime() - movedAtMs;
  assert.ok(reacted >= 0 && reacted <= ROUND_MS + 2 * 31_000, `reacted in ${Math.round(reacted / 1000)} s, the round is ${ROUND_MS / 1000} s`);
  assert.deepEqual([rows[0].rule_code, rows[0].shadow, rows[0].competitor_derived], ['BEAT_LOWEST', true, true]);
  assert.equal(world.port.stats.patchCalls, 0, 'shadow: nothing reached the channel');
});

test('step 115 (Q11): Win the Buy Box decides on Amazon where the views name a holder and holds where nobody has the majority; the share is counted', async () => {
  const decisions = async (idx: number[]) => (await observer.query(
    `SELECT count(*) FILTER (WHERE d.intent_class = 'CHANGED')::int AS proposed, count(*) FILTER (WHERE d.no_change_reason = 'COMPETITOR_REQUIREMENT_NOT_MET')::int AS unmet, count(*)::int AS n
       FROM channel_data.price_decision d WHERE d.write_scope_id = ANY($1::uuid[])`, [idx.map((i) => world.seeded.ids.dbId(`ws-amz-${world.asins[i]}`))])).rows[0] as { proposed: number; unmet: number; n: number };
  const named = await decisions(WIN_MAJORITY);
  assert.ok(named.proposed > 0, `a named holder gives the strategy its target: ${JSON.stringify(named)}`);
  const held = await decisions(WIN_NO_MAJORITY);
  assert.equal(held.proposed, 0, `nobody has the majority — the strategy proposes nothing: ${JSON.stringify(held)}`);
  // Решения нет — стратегия говорит почему: цена самой большой группы есть, держатель не назван
  clock.advance(31_000);
  const ctx = { tenantId: world.seeded.tenantId, channelAccountId: world.seeded.channelAccountId, correlationId: 'step115-win', deadline: clock.iso(60_000) };
  const read = await world.pipelineForDbIds().pollCompetitors(ctx as never, [{ marketplace: 'ATVPDKIKX0DER', channelProductRef: world.asins[WIN_NO_MAJORITY[0]!]!, condition: 'new' }] as never);
  assert.equal(read.snapshots[0]?.snapshot?.buybox?.isSelf, null, 'the snapshot names no holder');
  const stages = JSON.stringify(read.snapshots[0]?.scopes[0]?.stages);
  assert.match(stages, /COMPETITOR_REQUIREMENT_NOT_MET/);
  assert.match(stages, /BUYBOX_WINNER/);
  const { rows: spans } = await observer.query(`SELECT holder, count(*)::int AS n FROM channel_data.buybox_span GROUP BY 1`);
  assert.ok(spans.some((s) => s.holder === 'OTHER'), `spans of a named holder: ${JSON.stringify(spans)}`);
  assert.ok(!spans.some((s) => s.holder === 'NONE'), `«no majority» is not «no Buy Box»: ${JSON.stringify(spans)}`);
  const { rows: [unknown] } = await observer.query(`SELECT count(*)::int AS n FROM channel_data.competitor_snapshot_log l WHERE l.channel_product_ref = ANY($1::text[]) AND l.snapshot -> 'buybox' -> 'isSelf' = 'null'::jsonb`,
    [WIN_NO_MAJORITY.map((i) => world.asins[i]!)]);
  assert.ok(unknown.n > 0, 'the snapshots without a majority carry the price of the largest group with the holder unknown');
});

test('step 115 [Р-121]: no subscription, no alarm — not one loss check and no failed run in an hour of market moves', async () => {
  const { rows: [c] } = await observer.query(`SELECT count(*)::int AS n FROM channel_data.notification_loss_check`);
  assert.equal(c.n, 0, 'without notifications every market move would be a «lost notification»');
  assert.equal(alerts.filter((a) => a.code === 'NOTIFICATION_LOSS_SUSPECTED').length, 0);
  const { rows: [job] } = await observer.query(
    `SELECT count(*)::int AS runs, count(*) FILTER (WHERE outcome = 'FAILED')::int AS failed FROM maintenance.scheduled_job_run WHERE job_name = 'amazon-summary-poll'`);
  assert.ok(job.runs >= 100, `the job ran about once in 31 seconds: ${job.runs}`);
  assert.equal(job.failed, 0);
});

test('step 115 [Р-240]: Channels knows how old the data of the account is — offers read and the oldest reading', async () => {
  const facts = await store.notificationSources!(world.seeded.tenantId, clock.iso() as never);
  const account = facts.find((f) => f.channelAccountId === world.seeded.channelAccountId)!;
  assert.equal(account.lastReceivedAt, null, 'no notification reached the journal');
  assert.equal(account.polled?.offers, OFFERS);
  const age = clock.nowMs() - Date.parse(account.polled!.oldestAt);
  assert.ok(age >= 0 && age <= ROUND_MS + 2 * 31_000, `the oldest reading is ${Math.round(age / 1000)} s old, the round is ${ROUND_MS / 1000} s`);
});

test('step 115 [Р-121]: positive control — once ANY_OFFER_CHANGED reaches the journal the same poll insures against losing them; listing notifications alone do not arm it', async () => {
  const raw = (id: string, notificationType: string, envelope: 'SQS' | 'EVENTBRIDGE') => ({
    channelAccountId: world.seeded.channelAccountId, notificationId: id, notificationType, envelope, eventTime: clock.iso(), receivedAt: clock.iso(), rawBody: '{}',
  });
  await store.recordInboundNotification(world.seeded.tenantId, raw('syn-115-listing', 'LISTINGS_ITEM_STATUS_CHANGE', 'EVENTBRIDGE') as never);
  await runScheduled(15 * MINUTE);
  const checks = async () => (await observer.query(`SELECT count(*)::int AS n FROM channel_data.notification_loss_check`)).rows[0].n as number;
  assert.equal(await checks(), 0, 'the EventBridge half says nothing about offers');
  await store.recordInboundNotification(world.seeded.tenantId, raw('syn-115-offer', 'ANY_OFFER_CHANGED', 'SQS') as never);
  await runScheduled(15 * MINUTE);
  assert.ok(await checks() > 0, 'a market move seen only by the poll is now a suspected loss');
});

test('step 115 [Р-240]: the live path — a polled snapshot of an offer in live mode reaches the channel and the store applies our price', async () => {
  const pools = { appPool: db.pool('svc_app', 2), adminPool: db.pool('svc_admin', 1), provisioningPool: db.pool('svc_provisioning', 1), dispatcherPool: db.pool('svc_dispatcher', 1) };
  const live = await amazonLiveWorld({ tag: 1151, clock, offers: 3, seed: 1151, lossShare: 0, priceChangeEveryHours: 0.25, engine: true, writeMode: 'LIVE', ...pools });
  const before = live.port.stats.patchCalls;
  const pipeline = live.pipelineForDbIds();
  const ctx = { tenantId: live.seeded.tenantId, channelAccountId: live.seeded.channelAccountId, correlationId: 'step115-live', deadline: clock.iso(60_000) };
  const r = await pipeline.pollRotation(ctx as never, { size: 20, cycle: 0, reconcile: false });
  assert.equal(r.windowFailure, null);
  assert.equal(r.snapshots.length, 3);
  await live.sweep();
  assert.ok(live.port.stats.patchCalls > before, 'the decision from the summary reached patchListingsItem');
  const { rows } = await observer.query(
    `SELECT final_amount_minor, shadow FROM channel_data.price_decision WHERE tenant_id = $1 AND outcome = 'APPROVED' AND intent_class = 'CHANGED'`, [live.seeded.tenantId]);
  assert.ok(rows.length >= 1 && rows.every((x) => x.shadow === false && Number(x.final_amount_minor) === 1799), JSON.stringify(rows));
});
