import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { AlertSink, ChannelAdapter, FieldWrite } from '@repracer/channel-port';
import type { MemorySeedScope } from '@repracer/pricing-pipeline';
import { createWriteDispatcher, DEFAULT_RETRY_POLICY } from '@repracer/write-dispatcher';
import { inTenant, PgPricingStore, PgWriteQueueStore, seedPricingWorld, type PgPool, type SeededPricingWorld } from '../src/index.ts';
import { approved, commit, contextOf } from './drafts.ts';
import { createIsolatedDatabase, type IsolatedDatabase } from './isolated-db.ts';

/**
 * Находка 7 ревью шага 15 [Р-64, Р-65] на PostgreSQL: запись с бюджетом правок ушла, получила временную ошибку и ждёт повтора;
 * граница суток витрины стала неподтверждённой (TO_VERIFY). Триггер 0055 отказывает повтору. До исправления диспетчер этот
 * отказ не распознавал: захват пробрасывал ошибку, обход падал на каждом круге, запись висела FAILED без алерта.
 * Теперь: запись завершается с причиной WRITE_BUDGET_DAY_UNCONFIRMED, поднимается алерт, следующий обход её не видит.
 * Отдельная база: строка возможности eBay PRICE с бюджетом и статус витрины — данные платформы. Данные синтетические.
 */

const ACCOUNT = '20000000-0000-4000-8000-000000000160';
const EBAY_ACCOUNT = '20000000-0000-4000-8000-000000000161';
const now = () => new Date().toISOString();
const later = (ms: number) => () => new Date(Date.now() + ms).toISOString();

const ebayScope: MemorySeedScope = {
  writeScopeId: 'ws-ebay', productId: 'prod-ebay', channelAccountId: EBAY_ACCOUNT, marketplace: 'EBAY_DE', externalUnitId: '16001', channelProductRef: '362160',
  condition: 'new', currency: 'EUR', basis: 'GROSS', pricingMode: 'ENGINE', strategy: { strategyId: 'st', version: 1, params: { type: 'FIXED', priceMinor: 1900 }, deadbandMinor: 0 },
  currentPriceMinor: 1850, minPrice: { amountMinor: 1500, id: 'min-ebay' }, maxPrice: { amountMinor: 2500, id: 'max-ebay' },
};

let db: IsolatedDatabase;
let pool: PgPool;
let world: SeededPricingWorld;

before(async () => {
  db = await createIsolatedDatabase('finding7');
  // Синтетическая возможность eBay для цены с бюджетом правок на листинг [Р-19]. Лимиты — из строки
  // количества смоук-теста; настоящие параметры eBay PRICE — (проверить) при адаптере eBay (OQ-35, OQ-47)
  await db.superuser(`INSERT INTO platform.channel_capability
      (capability_id, version, status, valid_from, channel, region, api_mode, field, write_scope_kind, write_scope_key_template,
       budget_scope_attribute, object_edit_limit, processing_mode, requires_side_effects_ack, observation_data_class)
    VALUES ('c0000000-0000-0000-0000-000000000016', 1, 'ACTIVE', now(), 'EBAY', NULL, 'EBAY_INVENTORY_API', 'PRICE', 'ACCOUNT_MARKETPLACE_SKU',
      ARRAY['channel_account','marketplace','external_sku'], 'external_listing_id', '{"limit": 250, "quantity_reserve": 50, "unaccounted_margin": 10}', 'SYNC', false, 'CHANNEL_INFO')`);
  await db.superuser(`UPDATE platform.marketplace SET time_zone_status = 'CONFIRMED' WHERE channel = 'EBAY' AND marketplace = 'EBAY_DE'`);
  pool = db.pool('svc_app');
  world = await seedPricingWorld(pool, { provisioningPool: db.pool('svc_provisioning', 1), adminPool: db.pool('svc_admin', 2),
    fixtureTenantId: '10000000-0000-4000-8000-000000000160', fixtureChannelAccountId: ACCOUNT, marketplaces: ['de'], clock: now(),
    seed: { scopes: [ebayScope], accounts: [{ channelAccountId: EBAY_ACCOUNT, channel: 'EBAY', marketplaces: ['EBAY_DE'] }] },
  });
});

after(async () => {
  await db?.drop();
});

test('finding 7: a budgeted retry refused because the storefront day boundary became unconfirmed ends with a reason and an alert; the sweep survives and does not repeat it', async () => {
  const store = new PgPricingStore(pool);
  const queue = new PgWriteQueueStore(pool, { scanPool: db.pool('svc_dispatcher', 2) });
  const r = await commit(store, world.tenantId, approved(await contextOf(store, world.tenantId, world.ids.dbId('ws-ebay')), 1900));
  assert.ok(r.status === 'COMMITTED' && r.decisions[0]!.write, JSON.stringify(r));
  const write: FieldWrite = r.decisions[0]!.write!;
  // Завершённая запись уходит из очереди в историю (channel_write_history)
  const row = () => inTenant(pool, world.tenantId, async (tx) => (await tx.query(
    `SELECT status, budget_scope_key, end_reason, end_params FROM tenant_data.channel_write WHERE tenant_id = $1 AND channel_write_id = $2
     UNION ALL
     SELECT final_status, NULL, end_reason, end_params FROM tenant_data.channel_write_history WHERE tenant_id = $1 AND channel_write_id = $2`,
    [world.tenantId, write.channelWriteId])).rows[0]);
  assert.ok((await row()).budget_scope_key, 'the write carries an edit budget key');

  await queue.recordOutcome(world.tenantId, write, { channelWriteId: write.channelWriteId, status: 'REJECTED', error: { class: 'TRANSIENT', code: 'RATE_LIMITED', scope: 'ITEM', message: 'synthetic', raiseAlert: false } }, now(), DEFAULT_RETRY_POLICY);
  assert.equal((await row()).status, 'FAILED');
  await db.superuser(`UPDATE platform.marketplace SET time_zone_status = 'TO_VERIFY' WHERE channel = 'EBAY' AND marketplace = 'EBAY_DE'`);

  const sent: FieldWrite[] = [];
  const alerts: Array<Parameters<AlertSink['raise']>[0]> = [];
  const adapter = {
    async planDispatch(_c: unknown, writes: readonly FieldWrite[]) {
      return { batches: writes.map((x) => ({ batchId: `b:${x.channelWriteId}`, operation: 'TEST', items: [x], budgetCharges: [], requestCount: 1 })), rejected: [] };
    },
    async dispatch(_c: unknown, batch: { batchId: string; items: FieldWrite[] }) {
      sent.push(...batch.items);
      return { batchId: batch.batchId, outcomes: batch.items.map((x) => ({ channelWriteId: x.channelWriteId, status: 'ACCEPTED', appliedImmediately: true })), attemptsMade: 1 };
    },
    async readBack() {
      return { observations: [], failures: [] };
    },
  } as unknown as ChannelAdapter;
  const dispatcher = createWriteDispatcher({
    store: { claimNext: queue.claimNext.bind(queue), recordOutcome: queue.recordOutcome.bind(queue), recordReconciliation: queue.recordReconciliation.bind(queue),
      checkPriceBasis: queue.checkPriceBasis.bind(queue),
      dueScopes: async (at, o) => (await queue.dueScopes(at, o)).filter((d) => d.tenantId === world.tenantId) },
    adapterFor: () => adapter, alerts: { raise: async (a) => { alerts.push(a); } }, now: later(600_000),
  });

  const first = await dispatcher.sweep({ pendingMinAgeMs: 0 });
  assert.equal(first.due, 1, 'the retry is due');
  assert.equal(sent.length, 0, 'nothing reached the channel');
  const ended = await row();
  assert.equal(ended.status, 'DISCARDED_STALE', JSON.stringify(ended));
  assert.equal(ended.end_reason, 'WRITE_BUDGET_DAY_UNCONFIRMED');
  assert.equal(ended.end_params.marketplace, 'EBAY_DE');
  const notSent = alerts.filter((a) => a.code === 'PRICE_WRITE_NOT_SENT');
  assert.equal(notSent.length, 1, JSON.stringify(alerts));
  assert.equal(notSent[0]!.details.reason, 'WRITE_BUDGET_DAY_UNCONFIRMED');

  const second = await dispatcher.sweep({ pendingMinAgeMs: 0 });
  assert.equal(second.due, 0, 'the ended write is not swept again');
  assert.equal(alerts.length, 1, 'no second alert');
});
