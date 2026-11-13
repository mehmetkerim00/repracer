import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { inTenant, PgChannelConnectStore, PgPricingStore, seedPricingWorld, type PgPool, type SeededPricingWorld } from '../src/index.ts';
import { createIsolatedDatabase, type IsolatedDatabase } from './isolated-db.ts';

/**
 * Шаг 122 (П7, аудит авторизации Amazon; 0227): SKU, которые назвал отчёт каталога, а поиск подробностей не вернул (A-39), — не только число в журнале процесса:
 * они записываются у источника витрины (число за круг и первые 20 SKU), новый круг начинает счёт заново, экран Channels читает их функцией. Только у отчёта:
 * у поиска по витрине отчёта нет. Форму держит база — своей проверкой с причиной [Р-94, Р-99]. Данные синтетические
 */
const ACCOUNT = '20000000-0000-4000-8000-000000001223';
const TENANT = '10000000-0000-4000-8000-000000001223';
const US = 'ATVPDKIKX0DER';

let db: IsolatedDatabase;
let app: PgPool;
let admin: PgPool;
let world: SeededPricingWorld;
let store: PgPricingStore;

before(async () => {
  db = await createIsolatedDatabase('notfound122');
  app = db.pool('svc_app', 2);
  admin = db.pool('svc_admin', 2);
  world = await seedPricingWorld(app, {
    provisioningPool: db.pool('svc_provisioning', 1), adminPool: admin, fixtureTenantId: TENANT, fixtureChannelAccountId: ACCOUNT, fixtureChannel: 'AMAZON',
    fixtureRegion: 'NA', marketplaces: [US], clock: new Date().toISOString(), writeMode: 'SHADOW', seed: { scopes: [], marketplaces: { [US]: { currency: 'USD', basis: 'NET' } } } as never,
  });
  store = new PgPricingStore(app, { adminPool: admin });
});
after(async () => { await db?.drop(); });

const at = () => new Date().toISOString() as never;
const outcome = (p: Promise<unknown>) => p.then(() => 'accepted', (e: unknown) => String(e instanceof Error ? e.message : e));
const sources = async () => (await new PgChannelConnectStore(admin).connections(world.tenantId)).accounts[0]!.catalogSources
  .map((c) => ({ source: c.source, listed: c.listed, notFound: c.notFound, sample: c.notFoundSample }));
const sku = (i: number) => `SYN-GONE-${String(i).padStart(3, '0')}`;

test('step 122 (П7): report SKUs the search did not return are counted per circle, the first 20 named; a new circle counts afresh; a search source has none', async () => {
  await store.recordDiscoveryCatalog(world.tenantId, world.ids.dbId(ACCOUNT), { marketplace: US, source: 'REPORT', listed: 45, fallbackReason: null, mayBeIncomplete: false, observedAt: at() });
  await store.recordDiscoveryNotFound(world.tenantId, world.ids.dbId(ACCOUNT), { marketplace: US, skus: [sku(1), sku(2)] });
  await store.recordDiscoveryNotFound(world.tenantId, world.ids.dbId(ACCOUNT), { marketplace: US, skus: Array.from({ length: 19 }, (_, i) => sku(10 + i)) });
  assert.deepEqual(await sources(), [{ source: 'REPORT', listed: 45, notFound: 21, sample: [sku(1), sku(2), ...Array.from({ length: 18 }, (_, i) => sku(10 + i))] }],
    'all 21 counted, the first 20 named in the order they were found');
  await store.recordDiscoveryCatalog(world.tenantId, world.ids.dbId(ACCOUNT), { marketplace: US, source: 'REPORT', listed: 44, fallbackReason: null, mayBeIncomplete: false, observedAt: at() });
  assert.deepEqual(await sources(), [{ source: 'REPORT', listed: 44, notFound: 0, sample: [] }], 'the next circle starts its own count');
  await store.recordDiscoveryCatalog(world.tenantId, world.ids.dbId(ACCOUNT), { marketplace: US, source: 'SEARCH', listed: 44, fallbackReason: 'REPORT_REFUSED', mayBeIncomplete: false, observedAt: at() });
  await store.recordDiscoveryNotFound(world.tenantId, world.ids.dbId(ACCOUNT), { marketplace: US, skus: [sku(5)] });
  assert.deepEqual(await sources(), [{ source: 'SEARCH', listed: 44, notFound: 0, sample: [] }], 'a search source names nothing: there is no report to compare with');
  // Пишет только функция обнаружения: прав на таблицу у пути решения и консоли нет [Р-96]
  assert.match(await outcome(inTenant(app, world.tenantId, (tx) => tx.query('UPDATE tenant_data.discovery_catalog_source SET not_found = 1'))), /permission denied/);
});

test('step 122 (П7): the database keeps the form of the count — never negative, at most 20 named, never more named than counted, only for a report', async () => {
  await store.recordDiscoveryCatalog(world.tenantId, world.ids.dbId(ACCOUNT), { marketplace: US, source: 'REPORT', listed: 45, fallbackReason: null, mayBeIncomplete: false, observedAt: at() });
  const set = (assignment: string) => outcome(db.superuser(`UPDATE tenant_data.discovery_catalog_source SET ${assignment} WHERE tenant_id = '${world.tenantId}'`));
  assert.equal(await set(`not_found = 25, not_found_sample = ARRAY['${sku(1)}']`), 'accepted');
  assert.match(await set('not_found = -1, not_found_sample = \'{}\''), /discovery_catalog_source_not_found/, 'a negative count is refused');
  assert.match(await set(`not_found = 30, not_found_sample = ARRAY(SELECT 'SYN-' || g FROM generate_series(1, 21) g)`), /discovery_catalog_source_not_found/, 'more than 20 named is refused');
  assert.match(await set(`not_found = 1, not_found_sample = ARRAY['${sku(1)}', '${sku(2)}']`), /discovery_catalog_source_not_found/, 'more named than counted is refused');
  assert.match(await set(`source = 'SEARCH', fallback_reason = 'REPORT_REFUSED', not_found = 2, not_found_sample = '{}'`), /discovery_catalog_source_not_found/,
    'a search source with a count is refused');
});
