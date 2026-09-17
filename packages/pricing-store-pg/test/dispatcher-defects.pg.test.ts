import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { AlertSink, ChannelAdapter, FieldWrite } from '@repracer/channel-port';
import type { MemorySeedScope } from '@repracer/pricing-pipeline';
import { createWriteDispatcher, DEFAULT_RETRY_POLICY } from '@repracer/write-dispatcher';
import { createPool, inTenant, PgPricingStore, PgWriteQueueStore, seedPricingWorld, type SeededPricingWorld } from '../src/index.ts';
import { approved, commit, contextOf } from './drafts.ts';
import { requireEnv } from './isolated-db.ts';

/**
 * Дефекты диспетчера из ретроспективного ревью шага 14 — на PostgreSQL:
 *  D1: неизвестный итог не сверяется бесконечно и молча — после предела единица блокируется, один CRITICAL-алерт, больше не в обходе;
 *  D2: повтор записи в удержанной единице не попадает в обход — нет лавины CRITICAL-алертов; единица снова активна — повтор идёт.
 * Данные синтетические.
 */

const url = requireEnv('REPRACER_PG_URL');
const pool = createPool(url, { max: 4, applicationName: 'repracer-dispatcher-defects' });
const provisioning = createPool(url.replace('svc_app@', 'svc_provisioning@'), { max: 1, applicationName: 'repracer-test-provisioning' });
const admin = createPool(url.replace('svc_app@', 'svc_admin@'), { max: 2, applicationName: 'repracer-test-admin' });
const scanPool = createPool(url.replace('svc_app@', 'svc_dispatcher@'), { max: 2, applicationName: 'repracer-dispatcher-scan' });
after(async () => {
  await pool.end();
  await provisioning.end();
  await admin.end();
  await scanPool.end();
});

const ACCOUNT = '20000000-0000-4000-8000-000000000150';
const now = () => new Date().toISOString();
const later = (ms: number) => () => new Date(Date.now() + ms).toISOString();

function scope(n: number): MemorySeedScope {
  return {
    writeScopeId: `ws-${n}`, productId: `prod-${n}`, channelAccountId: ACCOUNT, marketplace: 'de', externalUnitId: String(15000 + n), channelProductRef: `36215${n}`,
    condition: 'new', currency: 'EUR', basis: 'GROSS', pricingMode: 'ENGINE', strategy: { strategyId: 'st', version: 1, params: { type: 'FIXED', priceMinor: 1900 }, deadbandMinor: 0 },
    currentPriceMinor: 1850, minPrice: { amountMinor: 1500, id: `min-${n}` }, maxPrice: { amountMinor: 2500, id: `max-${n}` },
  };
}

function harness(w: SeededPricingWorld, clock: () => string) {
  const queue = new PgWriteQueueStore(pool, { scanPool });
  const alerts: Array<Parameters<AlertSink['raise']>[0]> = [];
  const adapter = {
    async planDispatch(_c: unknown, writes: readonly FieldWrite[]) {
      return { batches: writes.map((x) => ({ batchId: `b:${x.channelWriteId}`, operation: 'TEST', items: [x], budgetCharges: [], requestCount: 1 })), rejected: [] };
    },
    async dispatch(_c: unknown, batch: { batchId: string; items: FieldWrite[] }) {
      return { batchId: batch.batchId, outcomes: batch.items.map((x) => ({ channelWriteId: x.channelWriteId, status: 'ACCEPTED', appliedImmediately: true })), attemptsMade: 1 };
    },
    // Обратное чтение не отвечает: итог узнать нельзя
    async readBack() {
      return { observations: [], failures: [] };
    },
  } as unknown as ChannelAdapter;
  const dispatcher = createWriteDispatcher({
    store: { claimNext: queue.claimNext.bind(queue), recordOutcome: queue.recordOutcome.bind(queue), recordReconciliation: queue.recordReconciliation.bind(queue),
      checkPriceBasis: queue.checkPriceBasis.bind(queue),
      dueScopes: async (at, o) => (await queue.dueScopes(at, o)).filter((d) => d.tenantId === w.tenantId) },
    adapterFor: () => adapter, alerts: { raise: async (a) => { alerts.push(a); } }, now: clock,
  });
  return { queue, dispatcher, alerts };
}

async function dispatched(w: SeededPricingWorld, n: number): Promise<FieldWrite> {
  const store = new PgPricingStore(pool);
  const r = await commit(store, w.tenantId, approved(await contextOf(store, w.tenantId, w.ids.dbId(`ws-${n}`)), 1900));
  assert.ok(r.status === 'COMMITTED' && r.decisions[0]!.write, JSON.stringify(r));
  return r.decisions[0]!.write!;
}

const scopeStatus = (w: SeededPricingWorld, n: number) => inTenant(pool, w.tenantId, async (tx) => (await tx.query(
  'SELECT status FROM tenant_data.write_scope WHERE tenant_id = $1 AND write_scope_id = $2', [w.tenantId, w.ids.dbId(`ws-${n}`)])).rows[0].status);

test('D1: an outcome unknown past the limit blocks the write scope with one CRITICAL alert and leaves the sweep', async () => {
  const w = await seedPricingWorld(pool, { provisioningPool: provisioning, adminPool: admin, fixtureTenantId: '10000000-0000-4000-8000-000000000150', fixtureChannelAccountId: ACCOUNT, marketplaces: ['de'], clock: now(), seed: { scopes: [scope(1)] } });
  const write = await dispatched(w, 1);
  const { queue, dispatcher, alerts } = harness(w, later(2 * 3_600_000));
  await queue.recordOutcome(w.tenantId, write, { channelWriteId: write.channelWriteId, status: 'OUTCOME_UNKNOWN', error: { class: 'TRANSIENT', code: 'TIMEOUT', scope: 'ITEM', message: 'synthetic', raiseAlert: false } }, now(), DEFAULT_RETRY_POLICY);

  const first = await dispatcher.sweep({ pendingMinAgeMs: 0 });
  assert.ok(first.due >= 1, 'the unknown outcome is due for a read-back');
  assert.equal(await scopeStatus(w, 1), 'BLOCKED');
  const blocked = alerts.filter((a) => a.code === 'PRICE_WRITE_SCOPE_BLOCKED' && a.severity === 'CRITICAL');
  assert.equal(blocked.length, 1, JSON.stringify(alerts));
  assert.equal(blocked[0]!.details.reason, 'WRITE_SCOPE_BLOCKED');

  const second = await dispatcher.sweep({ pendingMinAgeMs: 0 });
  assert.equal(second.due, 0, 'the blocked scope waits for a person, it is not reconciled again');
  assert.equal(alerts.filter((a) => a.code === 'PRICE_WRITE_SCOPE_BLOCKED').length, 1, 'no second alert');
});

test('D2: a retry in a held write scope is not swept — no alert storm; the scope active again, the retry is due', async () => {
  const w = await seedPricingWorld(pool, { provisioningPool: provisioning, adminPool: admin, fixtureTenantId: '10000000-0000-4000-8000-000000000151', fixtureChannelAccountId: ACCOUNT, marketplaces: ['de'], clock: now(), seed: { scopes: [scope(2)] } });
  const write = await dispatched(w, 2);
  const { queue, dispatcher, alerts } = harness(w, later(600_000));
  await queue.recordOutcome(w.tenantId, write, { channelWriteId: write.channelWriteId, status: 'REJECTED', error: { class: 'TRANSIENT', code: 'RATE_LIMITED', scope: 'ITEM', message: 'synthetic', raiseAlert: false } }, now(), DEFAULT_RETRY_POLICY);
  // Находка 4 ревью шага 17 (0068): удержание и снятие удержания единицы — действие человека в административном сервисе, не пути решения
  const setStatus = (status: string) => inTenant(admin, w.tenantId, (tx) => tx.query('UPDATE tenant_data.write_scope SET status = $3 WHERE tenant_id = $1 AND write_scope_id = $2', [w.tenantId, w.ids.dbId('ws-2'), status]), w.userId);

  await setStatus('HELD');
  for (let i = 0; i < 3; i++) assert.equal((await dispatcher.sweep({ pendingMinAgeMs: 0 })).due, 0, `sweep ${i + 1} found the held retry`);
  assert.equal(alerts.filter((a) => a.severity === 'CRITICAL').length, 0, JSON.stringify(alerts));

  await setStatus('ACTIVE');
  const resumed = await dispatcher.sweep({ pendingMinAgeMs: 0 });
  assert.equal(resumed.due, 1);
  assert.ok(resumed.reports[0]!.steps.some((s) => s.action === 'DISPATCHED'), JSON.stringify(resumed.reports));
});
