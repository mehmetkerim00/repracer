import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { MemorySeedScope } from '@repracer/pricing-pipeline';
import { PgPricingStore, seedPricingWorld, type SeededPricingWorld } from '../src/index.ts';
import { createIsolatedDatabase, type IsolatedDatabase } from './isolated-db.ts';

/**
 * Шаг 56 (ревью шага 55, находка 1): приоритет круга сверки по давности последней сверки ДЕЙСТВУЕТ на PostgreSQL. Отметку сверки ставит
 * markPolled условием порта (`new`), предложение хранит его верхним регистром (`NEW`): соединение без приведения давало NULL у всех, и
 * «первыми — давние» тихо сводилось к ровному кругу, а живой прогон планировщика этого не видел. Данные синтетические.
 */
const TENANT = '10000000-0000-4000-8000-000000000561';
const ACCOUNT = '20000000-0000-4000-8000-000000000561';
const scope = (n: number): MemorySeedScope => ({
  writeScopeId: `ws-${n}`, productId: `prod-${n}`, channelAccountId: ACCOUNT, marketplace: 'de', externalUnitId: String(5600 + n),
  externalOfferId: `SYN-OFFER-${n}`, channelProductRef: `5610${n}`, condition: 'new', currency: 'EUR', basis: 'GROSS',
  pricingMode: 'OFF', strategy: null, currentPriceMinor: 1900,
});

let db: IsolatedDatabase;
let world: SeededPricingWorld;
let store: PgPricingStore;

before(async () => {
  db = await createIsolatedDatabase('recsample');
  world = await seedPricingWorld(db.pool('svc_app', 2), {
    provisioningPool: db.pool('svc_provisioning', 1), adminPool: db.pool('svc_admin', 2), fixtureTenantId: TENANT, fixtureChannelAccountId: ACCOUNT,
    marketplaces: ['de'], clock: new Date().toISOString(), seed: { scopes: [1, 2, 3, 4, 5].map(scope) },
  });
  store = new PgPricingStore(db.pool('svc_app', 2));
});

after(async () => { await db?.drop(); });

test('step 56: on PostgreSQL the reconciliation circle takes first what was reconciled longest ago — a never reconciled offer, then the oldest mark', async () => {
  const account = world.ids.dbId(ACCOUNT);
  const q = (n: number) => ({ marketplace: 'de', channelProductRef: `5610${n}`, condition: 'new' as const });
  // Сверены: 1 и 2 — только что, 3 — сутки назад, 5 — час назад; 4 не сверялся никогда
  const now = Date.parse('2026-09-29T12:00:00.000Z');
  await store.markPolled(world.tenantId, account, [q(1), q(2)], new Date(now).toISOString() as never);
  await store.markPolled(world.tenantId, account, [q(3)], new Date(now - 86_400_000).toISOString() as never);
  await store.markPolled(world.tenantId, account, [q(5)], new Date(now - 3_600_000).toISOString() as never);
  for (const cycle of [0, 1, 2, 3, 7]) {
    const { queries, total } = await store.pickReconciliationSample(world.tenantId, account, 3, cycle);
    assert.equal(total, 5);
    assert.deepEqual(queries.map((x) => x.channelProductRef), ['56104', '56103', '56105'], `cycle ${cycle}: never, a day ago, an hour ago — the freshly reconciled wait`);
  }
});
