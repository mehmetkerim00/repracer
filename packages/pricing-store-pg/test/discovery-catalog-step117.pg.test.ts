import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { inTenant, PgChannelConnectStore, PgPricingStore, seedPricingWorld, type PgPool, type SeededPricingWorld } from '../src/index.ts';
import { createIsolatedDatabase, type IsolatedDatabase } from './isolated-db.ts';

/**
 * Шаг 117 в базе (0220, P0-16): источник каталога витрины — строка на аккаунт и витрину, пишет её только функция обнаружения. Форму держит база: у отчёта нет
 * причины отказа и неполноты, у поиска — причина из известного списка; число — не отрицательное, витрина — идентификатором канала. Каждая форма — своей
 * проверкой с причиной отказа [Р-94, Р-99]. Экран Channels читает источники функцией. Данные синтетические
 */
const ACCOUNT = '20000000-0000-4000-8000-000000001173';
const TENANT = '10000000-0000-4000-8000-000000001173';
const US = 'ATVPDKIKX0DER';

let db: IsolatedDatabase;
let app: PgPool;
let admin: PgPool;
let world: SeededPricingWorld;

before(async () => {
  db = await createIsolatedDatabase('catalog117');
  app = db.pool('svc_app', 2);
  admin = db.pool('svc_admin', 2);
  world = await seedPricingWorld(app, {
    provisioningPool: db.pool('svc_provisioning', 1), adminPool: admin, fixtureTenantId: TENANT, fixtureChannelAccountId: ACCOUNT, fixtureChannel: 'AMAZON',
    fixtureRegion: 'NA', marketplaces: [US], clock: new Date().toISOString(), writeMode: 'SHADOW', seed: { scopes: [], marketplaces: { [US]: { currency: 'USD', basis: 'NET' } } } as never,
  });
});
after(async () => { await db?.drop(); });

const outcome = (p: Promise<unknown>) => p.then(() => 'accepted', (e: unknown) => String(e instanceof Error ? e.message : e));
const record = (over: Partial<{ marketplace: string; source: string; listed: number | null; reason: string | null; incomplete: boolean }>) => outcome(inTenant(app, world.tenantId, (tx) => tx.query(
  'SELECT tenant_data.record_discovery_catalog($1, $2, $3, $4, $5, $6, $7, now())',
  [world.tenantId, world.ids.dbId(ACCOUNT), over.marketplace ?? US, over.source ?? 'REPORT', over.listed === undefined ? 2500 : over.listed,
    over.reason === undefined ? null : over.reason, over.incomplete ?? false])));

test('step 117: the database keeps the form of the catalog source', async () => {
  assert.equal(await record({}), 'accepted');
  assert.equal(await record({ source: 'SEARCH', listed: 2500, reason: 'REPORT_REFUSED', incomplete: true }), 'accepted');
  assert.equal(await record({ source: 'SEARCH', listed: null, reason: 'REPORT_HEADER', incomplete: true }), 'accepted');
  assert.match(await record({ reason: 'REPORT_REFUSED' }), /discovery_catalog_source_shape/, 'a report with a fallback reason is refused');
  assert.match(await record({ incomplete: true }), /discovery_catalog_source_shape/, 'a report that may be incomplete is refused');
  assert.match(await record({ listed: null }), /discovery_catalog_source_shape/, 'a report without a count is refused');
  assert.match(await record({ source: 'SEARCH', reason: null }), /discovery_catalog_source_shape/, 'a search without a reason is refused');
  assert.match(await record({ source: 'SEARCH', reason: 'NO_REASON' }), /discovery_catalog_source_shape/, 'a search with an unknown reason is refused');
  assert.match(await record({ source: 'FEED', reason: null }), /discovery_catalog_source_shape/, 'an unknown source is refused');
  assert.match(await record({ source: 'SEARCH', listed: -1, reason: 'REPORT_FATAL' }), /discovery_catalog_source_listed/, 'a negative count is refused');
  assert.match(await record({ marketplace: 'amazon.com' }), /discovery_catalog_source_marketplace_form/, 'a storefront outside the form is refused');
});

test('step 117: one row per storefront — the next circle replaces it, and Channels reads it through the function', async () => {
  assert.equal(await record({ source: 'SEARCH', listed: 1200, reason: 'REPORT_TIMEOUT', incomplete: true }), 'accepted');
  assert.equal(await record({ listed: 3100 }), 'accepted');
  const { rows } = await inTenant(admin, world.tenantId, (tx) => tx.query('SELECT marketplace, source, listed, fallback_reason, may_be_incomplete FROM tenant_data.discovery_catalog_sources($1, $2)',
    [world.tenantId, world.ids.dbId(ACCOUNT)]));
  assert.deepEqual(rows, [{ marketplace: US, source: 'REPORT', listed: 3100, fallback_reason: null, may_be_incomplete: false }], 'the last circle wins');
  // Таблицу административная роль не читает и не пишет: только функции [Р-96]
  assert.match(await outcome(inTenant(admin, world.tenantId, (tx) => tx.query('SELECT * FROM tenant_data.discovery_catalog_source'))), /permission denied/);
  assert.match(await outcome(inTenant(app, world.tenantId, (tx) => tx.query('SELECT * FROM tenant_data.discovery_catalog_source'))), /permission denied/);
  const store = new PgPricingStore(app, { adminPool: admin });
  await store.recordDiscoveryCatalog(world.tenantId, world.ids.dbId(ACCOUNT), { marketplace: US, source: 'SEARCH', listed: 2500, fallbackReason: 'REPORT_REFUSED', mayBeIncomplete: true,
    observedAt: new Date().toISOString() as never });
  const [account] = (await new PgChannelConnectStore(admin).connections(world.tenantId)).accounts;
  assert.deepEqual(account!.catalogSources.map((c) => [c.marketplace, c.source, c.listed, c.fallbackReason, c.mayBeIncomplete]), [[US, 'SEARCH', 2500, 'REPORT_REFUSED', true]]);
});
