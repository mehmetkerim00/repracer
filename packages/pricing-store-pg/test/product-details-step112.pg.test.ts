import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, test } from 'node:test';
import type { MemorySeedScope } from '@repracer/pricing-pipeline';
import { inTenant, PgPricingStore, seedPricingWorld, type PgPool, type SeededPricingWorld } from '../src/index.ts';
import { createIsolatedDatabase, type IsolatedDatabase } from './isolated-db.ts';

/**
 * Шаг 112 [Р-238] в базе: цвет товара — слово продавца, форму значения держит база (`product_color_form`, 0209); применение импорта
 * «Product details» — задание PRODUCT_IMPORT — пишет в журнал импортов только строку своего вида PRODUCTS (страж 0193, ветка 0209);
 * хранилище применяет цвет товаров одной транзакцией вместе со строкой журнала, а изменившийся после примерки цвет — отказ без записи.
 * Каждая проверка — своя, с причиной отказа [Р-94, Р-99]. Данные синтетические.
 */

const ACCOUNT = '20000000-0000-4000-8000-000000001121';
const TENANT = '10000000-0000-4000-8000-000000001121';

let db: IsolatedDatabase;
let admin: PgPool;
let world: SeededPricingWorld;
let store: PgPricingStore;

function scope(n: number, product: number, color?: string): MemorySeedScope {
  return {
    writeScopeId: `ws-${n}`, productId: `prod-${product}`, title: `Synthetic product ${product}`, ...(color ? { color } : {}), channelAccountId: ACCOUNT, marketplace: 'de',
    externalUnitId: String(11200 + n), channelProductRef: `11228${n}`, condition: 'new', currency: 'EUR', basis: 'GROSS', pricingMode: 'OFF', strategy: null,
    currentPriceMinor: 1900, minPrice: { amountMinor: 1000, id: `min-${n}` }, maxPrice: { amountMinor: 5000, id: `max-${n}` },
  };
}

before(async () => {
  db = await createIsolatedDatabase('product112');
  const pool = db.pool('svc_app');
  admin = db.pool('svc_admin', 3);
  world = await seedPricingWorld(pool, {
    provisioningPool: db.pool('svc_provisioning', 1), adminPool: admin, fixtureTenantId: TENANT, fixtureChannelAccountId: ACCOUNT,
    marketplaces: ['de'], clock: new Date().toISOString(), seed: { scopes: [scope(1, 1, 'grey'), scope(2, 1, 'grey'), scope(3, 2), scope(4, 3)] },
  });
  store = new PgPricingStore(pool, { adminPool: admin, bulkWorkerPool: db.pool('svc_bulk_worker', 2) });
});
after(async () => {
  await db?.drop();
});

const outcome = (p: Promise<unknown>) => p.then(() => 'accepted', (e: unknown) => String(e instanceof Error ? e.message : e));
const productOf = (n: number) => world.ids.dbId(`prod-${n}`);
const colorOf = async (n: number) => (await db.rows<{ color: string | null }>(`SELECT color FROM tenant_data.product WHERE product_id = $1`, [productOf(n)]))[0]!.color;
const setColor = (n: number, color: string) => outcome(inTenant(admin, world.tenantId,
  (tx) => tx.query(`UPDATE tenant_data.product SET color = $3 WHERE tenant_id = $1 AND product_id = $2`, [world.tenantId, productOf(n), color]), world.userId, { mfa: false }));

test('step 112 [Р-238]: the database keeps the form of a product color', async () => {
  assert.equal(await setColor(3, 'Navy blue'), 'accepted', 'a word of the seller is kept as written');
  assert.match(await setColor(3, ' grey'), /product_color_form/, 'a color with spaces around is refused');
  assert.match(await setColor(3, 'navy  blue'), /product_color_form/, 'a color with a double space is refused');
  assert.match(await setColor(3, 'grey\nred'), /product_color_form/, 'a color with a line break is refused');
  assert.match(await setColor(3, 'x'.repeat(41)), /product_color_form/, 'a color longer than 40 characters is refused');
  assert.match(await setColor(3, ''), /product_color_form/, 'an empty color is refused — no color is NULL');
  assert.equal(await colorOf(3), 'Navy blue');
});

/** Задание, взятое в работу: строку журнала пишет только оно и только пока идёт */
async function running(kind: 'PRODUCT_IMPORT' | 'COST_IMPORT', params: Record<string, unknown>) {
  const created = await store.createBulkJob(world.tenantId, { kind, params }, { membershipId: world.ownerMembershipId, userId: world.userId, mfa: true });
  assert.equal(created.status, 'CREATED', JSON.stringify(created));
  const claimed = await store.claimBulkJob(world.tenantId, 'product112-worker', 60);
  assert.equal(claimed?.jobId, (created as { jobId: string }).jobId);
  return claimed!;
}
const finish = (jobId: string) => store.finishBulkJob(world.tenantId, jobId, 'product112-worker', { status: 'SUCCEEDED', result: {} });
const SHA = createHash('sha256').update('file').digest('hex');
const insertRun = (job: string, kind: string) => outcome(inTenant(admin, world.tenantId, (tx) => tx.query(
  `INSERT INTO tenant_data.import_run (tenant_id, kind, outcome, file_name, file_sha256, rows_total, rows_changed, rows_unchanged, rows_rejected,
                                       duration_ms, bulk_job_id, created_by_membership_id, created_by_user_id)
   VALUES ($1, $2, 'APPLIED', 'products.csv', $3, 2, 2, 0, 0, 0, $4, $5, $6)`,
  [world.tenantId, kind, SHA, job, world.ownerMembershipId, world.userId]), world.userId, { mfa: false, bulkJobId: job }));

test('step 112 [Р-238]: a Product details apply writes only a PRODUCTS run', async () => {
  const apply = await running('PRODUCT_IMPORT', { checkJobId: 'some-check', checkToken: 't' });
  assert.match(await insertRun(apply.jobId, 'COSTS'), /does not match its bulk job/, 'a Product details apply writes no unit-cost run');
  assert.equal(await insertRun(apply.jobId, 'PRODUCTS'), 'accepted', 'a Product details apply writes its own run');
  await finish(apply.jobId);
  const cost = await running('COST_IMPORT', { checkJobId: 'some-check', checkToken: 't' });
  assert.match(await insertRun(cost.jobId, 'PRODUCTS'), /does not match its bulk job/, 'a unit-cost apply writes no Product details run');
  await finish(cost.jobId);
});

test('step 112 [Р-238]: the store applies the colors of products in one transaction with the run; a color changed after the check — nothing applied', async () => {
  const job = await running('PRODUCT_IMPORT', { checkJobId: 'some-check', checkToken: 't' });
  const actor = { membershipId: world.ownerMembershipId, userId: world.userId, mfa: false, bulkJobId: job.jobId };
  const run = { kind: 'PRODUCTS' as const, outcome: 'APPLIED' as const, fileName: 'products.csv', fileSha256: SHA, rowsTotal: 2, rowsChanged: 2, rowsUnchanged: 0, rowsRejected: 0 };
  // Примерка видела у товара 1 «grey» — и сейчас так; у товара 2 — «Navy blue», а цвета у него нет: отказ, ничего не записано
  const stale = await store.importProductDetails(world.tenantId, { run, rows: [{ productId: productOf(1), color: 'black' }, { productId: productOf(2), color: 'red' }],
    expected: [{ productId: productOf(1), color: 'grey' }, { productId: productOf(2), color: 'Navy blue' }] }, actor);
  assert.deepEqual(stale, { status: 'CONFLICT', productId: productOf(2) });
  assert.deepEqual([await colorOf(1), await colorOf(2)], ['grey', null], 'nothing applied');
  const bad = await store.importProductDetails(world.tenantId, { run, rows: [{ productId: productOf(1), color: 'a\tb' }], expected: [{ productId: productOf(1), color: 'grey' }] }, actor);
  assert.deepEqual(bad, { status: 'INVALID', cause: 'COLOR_INVALID' });
  // Верная примерка: цвет у товара (оба его предложения), снятие цвета — NULL, строка журнала — той же транзакцией
  const applied = await store.importProductDetails(world.tenantId, { run, rows: [{ productId: productOf(1), color: 'black' }, { productId: productOf(3), color: null }],
    expected: [{ productId: productOf(1), color: 'grey' }, { productId: productOf(3), color: 'Navy blue' }] }, actor);
  assert.equal(applied.status, 'APPLIED', JSON.stringify(applied));
  assert.equal((applied as { run?: { kind: string; outcome: string } }).run?.kind, 'PRODUCTS');
  assert.deepEqual([await colorOf(1), await colorOf(3)], ['black', null]);
  const state = await store.readConsoleState(world.tenantId, new Date().toISOString() as never);
  assert.deepEqual(state.scopes.filter((s) => s.productId === productOf(1)).map((s) => s.color), ['black', 'black'], 'every offer of the product carries its color');
  await finish(job.jobId);
});
