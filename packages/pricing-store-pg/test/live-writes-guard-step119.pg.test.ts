import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import type { AdapterCallContext, ChannelAdapter, FieldWrite } from '@repracer/channel-port';
import { createPricingPipeline, type MemorySeedScope } from '@repracer/pricing-pipeline';
import type { CostInputs } from '@repracer/pricing-model';
import { createWriteDispatcher, DEFAULT_RETRY_POLICY, writeAlertCode } from '@repracer/write-dispatcher';
import { PgPricingStore, PgWriteQueueStore, seedPricingWorld, type PgPool, type SeededPricingWorld } from '../src/index.ts';
import { approved, commit, contextOf } from './drafts.ts';
import { createIsolatedDatabase, type IsolatedDatabase } from './isolated-db.ts';

/**
 * Шаг 119 на PostgreSQL (P0-09): база, где боевые записи запрещены (`ALTER DATABASE … SET repracer.live_writes = 'forbidden'`, QA).
 *  - решение у боевого предложения не демо-тенанта принимается и остаётся, а его запись в канал не уходит: путь решения завершает её
 *    своей причиной, владелец получает алерт «не отправлено»;
 *  - запись, ждавшая очереди до того, как базу закрыли, тоже не уходит: диспетчер завершает её той же причиной, обход не падает;
 *  - демо-тенант на той же базе отправляет: боевой путь на симуляторе на QA проверяется;
 *  - последняя миграция проверки схемы применяется и на закрытой базе — иначе QA не получил бы ни одной следующей миграции.
 * Данные синтетические
 */

const ACCOUNT = '20000000-0000-4000-8000-000000000119';
const DEMO_ACCOUNT = '20000000-0000-4000-8000-000000000219';
const now = () => new Date().toISOString();
const COST: CostInputs = { currency: 'EUR', costProfileId: 'cp-119', unitCostMinor: 700, fixedFeeMinor: 0, feeRateBp: 1000, tax: { regime: 'VAT_INCLUDED', vatRateBp: 1900 } };
const FIXED = { strategyId: 'st-fixed', version: 1, params: { type: 'FIXED', priceMinor: 1600 }, deadbandMinor: 0 } as const;

function scope(n: number, account: string): MemorySeedScope {
  return {
    writeScopeId: `ws-${n}`, productId: `prod-${n}`, channelAccountId: account, marketplace: 'de', externalUnitId: String(11900 + n),
    channelProductRef: `11901${n}`, condition: 'new', currency: 'EUR', basis: 'GROSS', pricingMode: 'ENGINE', strategy: FIXED, cost: COST,
    currentPriceMinor: 1500, minPrice: { amountMinor: 1200, id: `min-${n}` }, maxPrice: { amountMinor: 5000, id: `max-${n}` },
  };
}

let db: IsolatedDatabase;
let pool: PgPool;
let world: SeededPricingWorld;
let demo: SeededPricingWorld;
let store: PgPricingStore;

before(async () => {
  db = await createIsolatedDatabase('step119');
  pool = db.pool('svc_app');
  const admin = db.pool('svc_admin', 2);
  const provisioningPool = db.pool('svc_provisioning', 1);
  world = await seedPricingWorld(pool, { provisioningPool, adminPool: admin, fixtureTenantId: '10000000-0000-4000-8000-000000000119',
    fixtureChannelAccountId: ACCOUNT, marketplaces: ['de'], clock: now(), seed: { scopes: [scope(1, ACCOUNT), scope(2, ACCOUNT)] } });
  demo = await seedPricingWorld(pool, { provisioningPool, adminPool: admin, fixtureTenantId: '10000000-0000-4000-8000-000000000219', demo: true,
    fixtureChannelAccountId: DEMO_ACCOUNT, marketplaces: ['de'], clock: now(), seed: { scopes: [scope(1, DEMO_ACCOUNT)] } });
  store = new PgPricingStore(pool, { adminPool: admin });
});
after(async () => { await db?.drop(); });

/** Настройку уровня базы ставит владелец базы; роли работы её не меняют и сессией не снимают */
const liveWrites = (value: string | null) => db.superuser(value === null
  ? `ALTER DATABASE ${db.name} RESET repracer.live_writes`
  : `ALTER DATABASE ${db.name} SET repracer.live_writes = '${value}'`);

const sent: FieldWrite[] = [];
const adapter = {
  descriptor: { channel: 'KAUFLAND', scheduledRecomputeSeconds: 900, competitorSources: [] },
  async planDispatch(_ctx: unknown, writes: readonly FieldWrite[]) {
    return { batches: writes.map((w) => ({ batchId: `b:${w.channelWriteId}`, operation: 'TEST', items: [w], budgetCharges: [], requestCount: 1 })), rejected: [] };
  },
  async dispatch(_ctx: unknown, batch: { batchId: string; items: FieldWrite[] }) {
    sent.push(...batch.items);
    return { batchId: batch.batchId, outcomes: batch.items.map((w) => ({ channelWriteId: w.channelWriteId, status: 'ACCEPTED', appliedImmediately: true })), attemptsMade: 1 };
  },
  async readBack() { return { observations: [], failures: [] }; },
} as unknown as ChannelAdapter;

const ctxOf = (w: SeededPricingWorld, account: string): AdapterCallContext =>
  ({ tenantId: w.tenantId as never, channelAccountId: w.ids.dbId(account) as never, correlationId: 'step119', deadline: new Date(Date.now() + 60_000).toISOString() as never });
const history = (tenantId: string, channelWriteId: string) => db.rows<{ final_status: string; end_reason: string | null; dispatched: boolean }>(
  `SELECT final_status, end_reason, dispatched_at IS NOT NULL AS dispatched FROM tenant_data.channel_write_history WHERE tenant_id = $1 AND channel_write_id = $2`,
  [tenantId, channelWriteId]);

test('step 119 (P0-09): on a guarded database the decision of a non-demo LIVE offer stays, its write never leaves and is ended with its reason', async () => {
  await liveWrites('forbidden');
  const alerts: Array<{ code: string; details: Record<string, unknown> }> = [];
  const p = createPricingPipeline({ store, adapter, alerts: { raise: async (a) => { alerts.push({ code: a.code, details: a.details as Record<string, unknown> }); } },
    logger: { log: () => undefined }, now: () => now() as never });
  const report = await p.recompute(ctxOf(world, ACCOUNT), world.ids.dbId('ws-1'), { type: 'SCHEDULE' });
  assert.ok(report.decisionId && report.channelWriteId, `the engine decided and the write was created: ${JSON.stringify(report.stages)}`);
  assert.equal(sent.some((w) => w.channelWriteId === report.channelWriteId), false, `the write of a non-demo LIVE offer reached the channel on a guarded database: ${JSON.stringify(report.stages)}`);
  const plan = report.stages.find((s) => s.stage === 'DISPATCH_PLAN');
  assert.deepEqual(plan && [plan.outcome, plan.reason?.code], ['DISCARDED_STALE', 'WRITE_LIVE_WRITES_FORBIDDEN'], `the path names the guard: ${JSON.stringify(report.stages)}`);
  assert.deepEqual(await history(world.tenantId, report.channelWriteId!), [{ final_status: 'DISCARDED_STALE', end_reason: 'WRITE_LIVE_WRITES_FORBIDDEN', dispatched: false }],
    'the write is ended with the reason of the guard and never dispatched');
  assert.ok(alerts.some((a) => a.code === writeAlertCode('PRICE', 'notSent') && a.details.reason === 'WRITE_LIVE_WRITES_FORBIDDEN'), `the owner is alerted: ${JSON.stringify(alerts)}`);
  const decided = await db.rows<{ outcome: string }>('SELECT outcome FROM channel_data.price_decision WHERE tenant_id = $1 AND price_decision_id = $2', [world.tenantId, report.decisionId]);
  assert.equal(decided[0]?.outcome, 'APPROVED', 'the decision itself is kept — the guard stops the write, not the engine');
});

test('step 119 (P0-09): a write that waited in the queue before the database was guarded never leaves — the dispatcher ends it with its reason', async () => {
  await liveWrites(null);
  const draft = async (amountMinor: number) => approved(await contextOf(store, world.tenantId, world.ids.dbId('ws-2')), amountMinor);
  const r1 = await commit(store, world.tenantId, await draft(1600));
  assert.ok(r1.status === 'COMMITTED' && r1.decisions[0]!.write, `the first write is in flight: ${JSON.stringify(r1)}`);
  const r2 = await commit(store, world.tenantId, await draft(1610));
  const pendingWriteId = r2.status === 'COMMITTED' ? r2.decisions[0]!.pendingWriteId : undefined;
  assert.ok(pendingWriteId, `the second write waits in the queue: ${JSON.stringify(r2)}`);

  await liveWrites('forbidden');
  const queue = new PgWriteQueueStore(pool);
  const inFlight = r1.decisions[0]!.write!;
  await queue.recordOutcome(world.tenantId, inFlight, { channelWriteId: inFlight.channelWriteId, status: 'ACCEPTED', appliedImmediately: true }, now(), DEFAULT_RETRY_POLICY);
  const report = await createWriteDispatcher({ store: queue, adapterFor: () => adapter, alerts: { raise: async () => undefined }, now })
    .dispatchScope(world.tenantId, world.ids.dbId('ws-2'));
  assert.equal(sent.some((w) => w.channelWriteId === pendingWriteId), false, `the queued write reached the channel on a guarded database: ${JSON.stringify(report.steps)}`);
  const ended = report.steps.find((s) => s.action === 'ENDED' && s.channelWriteId === pendingWriteId);
  assert.deepEqual(ended && ended.action === 'ENDED' ? [ended.reason.code, ended.reason.params] : null,
    ['WRITE_LIVE_WRITES_FORBIDDEN', { channelAccountId: world.ids.dbId(ACCOUNT) }], `the dispatcher ends the queued write with the guard: ${JSON.stringify(report.steps)}`);
});

test('step 119 (P0-09): a demo tenant on the same guarded database sends — the live path of the simulator stays testable on QA', async () => {
  await liveWrites('forbidden');
  const p = createPricingPipeline({ store, adapter, alerts: { raise: async () => undefined }, logger: { log: () => undefined }, now: () => now() as never });
  const report = await p.recompute(ctxOf(demo, DEMO_ACCOUNT), demo.ids.dbId('ws-1'), { type: 'SCHEDULE' });
  assert.ok(report.channelWriteId && sent.some((w) => w.channelWriteId === report.channelWriteId), `the demo write was sent: ${JSON.stringify(report.stages)}`);
});

/**
 * Проверка схемы строит в откатываемой подтранзакции свой мир с БОЕВЫМ аккаунтом и отправляет его записи. На закрытой базе мир не
 * демо-тенанта упирался бы в страж — и QA не получил бы ни одной следующей миграции: каждая новая проверка схемы — копия последней.
 */
test('step 119 (P0-09): the latest schema verification applies on a guarded database', async () => {
  await liveWrites('forbidden');
  const dir = new URL('../../../migrations/', import.meta.url);
  const latest = readdirSync(dir).filter((f) => /^\d{4}_verify_schema_invariants_v\d+\.sql$/.test(f)).sort().at(-1)!;
  await assert.doesNotReject(db.superuser(readFileSync(new URL(latest, dir), 'utf8')), `${latest} applies on a database with live writes forbidden`);
});
