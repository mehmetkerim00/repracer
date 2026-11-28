import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { MemorySeedScope } from '@repracer/pricing-pipeline';
import { inTenant, PgPricingStore, seedPricingWorld, type PgPool, type SeededPricingWorld } from '../src/index.ts';
import { createIsolatedDatabase, type IsolatedDatabase } from './isolated-db.ts';

/**
 * Шаг 187 (письмо Мердана 28.11, §5): себестоимость и комиссии ОДНОГО предложения — вводом на его странице, без таблицы. Тот же путь, что у
 * применения импорта: новая версия себестоимости (источник MANUAL, без пакета импорта), оценка комиссии продавца (SELLER_DECLARED, 90 суток),
 * запрос базы на переоценку пола [Р-210]. Второй фактор правке одного предложения не нужен [Р-144]; окно массовой правки базы (больше пяти
 * предложений за десять минут без второго фактора) держит и этот путь — разбить импорт на ручные правки нельзя (риск 17). Данные синтетические.
 */

const ACCOUNT = '20000000-0000-4000-8000-000000001871';
const TENANT = '10000000-0000-4000-8000-000000001871';

let db: IsolatedDatabase;
let admin: PgPool;
let world: SeededPricingWorld;
let store: PgPricingStore;

function scope(n: number): MemorySeedScope {
  return {
    writeScopeId: `ws-${n}`, productId: `prod-${n}`, channelAccountId: ACCOUNT, marketplace: 'de', externalUnitId: String(18700 + n),
    channelProductRef: `18718${n}`, condition: 'new', currency: 'EUR', basis: 'GROSS', pricingMode: 'OFF', strategy: null,
    currentPriceMinor: 1900, minPrice: { amountMinor: 1000, id: `min-${n}` }, maxPrice: { amountMinor: 5000, id: `max-${n}` },
  };
}

before(async () => {
  db = await createIsolatedDatabase('offercost');
  admin = db.pool('svc_admin', 3);
  world = await seedPricingWorld(db.pool('svc_app'), {
    provisioningPool: db.pool('svc_provisioning', 1), adminPool: admin, fixtureTenantId: TENANT, fixtureChannelAccountId: ACCOUNT,
    marketplaces: ['de'], clock: new Date().toISOString(), seed: { scopes: [1, 2, 3, 4, 5, 6, 7, 8].map(scope) },
  });
  store = new PgPricingStore(db.pool('svc_app'), { adminPool: admin });
});

after(async () => { await db.drop(); });

const actor = (mfa: boolean) => ({ membershipId: world.ownerMembershipId, userId: world.userId, mfa });
const ws = (n: number) => world.ids.dbId(`ws-${n}`);
const read = (sql: string, args: unknown[] = []) => inTenant(admin, world.tenantId, async (tx) => (await tx.query(sql, args)).rows);

test('step 187 (§5): one offer — unit cost and fees typed on its page, no second factor; the same versions and fee estimate as an import', async () => {
  const saved = await store.setOfferCost(world.tenantId, { writeScopeId: ws(1), currency: 'EUR', unitCostMinor: 650, feeRateBp: 1500, fixedFeeMinor: 30 }, actor(false));
  assert.deepEqual(saved, { status: 'SAVED' });
  const [cost] = await read(`SELECT purchase_cost_minor, source, cost_import_id, version, currency, created_with_mfa FROM tenant_data.cost_profile`);
  assert.deepEqual([cost.purchase_cost_minor, cost.source, cost.cost_import_id, cost.version, cost.currency, cost.created_with_mfa], [650, 'MANUAL', null, 1, 'EUR', false]);
  const [fee] = await read(`SELECT fee_model, source FROM channel_data.fee_estimate WHERE write_scope_id = $1`, [ws(1)]);
  assert.deepEqual([fee.source, fee.fee_model], ['SELLER_DECLARED', { feeRateBp: 1500, fixedFeeMinor: 30 }]);
  // Тот же расчёт пола, что после импорта: себестоимость есть — включение репрайсинга в неё больше не упирается [Р-131]
  const [has] = await read(`SELECT tenant_data.write_scope_has_cost($1, $2) AS ok`, [world.tenantId, ws(1)]);
  assert.equal(has.ok, true);

  // Вторая правка — новая версия, прежние составляющие и прежняя комиссия остаются (поле не задано — не трогается)
  assert.deepEqual(await store.setOfferCost(world.tenantId, { writeScopeId: ws(1), currency: 'EUR', unitCostMinor: 700 }, actor(false)), { status: 'SAVED' });
  const versions = await read(`SELECT version, purchase_cost_minor FROM tenant_data.cost_profile ORDER BY version`);
  assert.deepEqual(versions.map((v) => [v.version, v.purchase_cost_minor]), [[1, 650], [2, 700]]);
  const [fee2] = await read(`SELECT fee_model FROM channel_data.fee_estimate WHERE write_scope_id = $1`, [ws(1)]);
  assert.deepEqual(fee2.fee_model, { feeRateBp: 1500, fixedFeeMinor: 30 });
  // Только комиссия — себестоимость не трогается, оценка сливается с прежней
  assert.deepEqual(await store.setOfferCost(world.tenantId, { writeScopeId: ws(1), currency: 'EUR', fixedFeeMinor: 45 }, actor(false)), { status: 'SAVED' });
  const [fee3] = await read(`SELECT fee_model FROM channel_data.fee_estimate WHERE write_scope_id = $1`, [ws(1)]);
  assert.deepEqual(fee3.fee_model, { feeRateBp: 1500, fixedFeeMinor: 45 });
  assert.equal((await read(`SELECT count(*)::int AS n FROM tenant_data.cost_profile`))[0].n, 2);
});

test('step 187 (§5): what cannot be saved is refused by name — another currency, nothing typed, a fee alone without a unit cost, a fee of 100 %', async () => {
  const refuse = async (input: Parameters<PgPricingStore['setOfferCost']>[1]) => store.setOfferCost(world.tenantId, input, actor(false));
  assert.deepEqual(await refuse({ writeScopeId: ws(2), currency: 'USD', unitCostMinor: 500 }), { status: 'INVALID', cause: 'CURRENCY_MISMATCH' });
  assert.deepEqual(await refuse({ writeScopeId: ws(2), currency: 'EUR' }), { status: 'INVALID', cause: 'NOTHING_TO_SAVE' });
  assert.deepEqual(await refuse({ writeScopeId: ws(2), currency: 'EUR', feeRateBp: 1200 }), { status: 'INVALID', cause: 'COST_REQUIRED' });
  assert.deepEqual(await refuse({ writeScopeId: ws(2), currency: 'EUR', unitCostMinor: 500, feeRateBp: 10_000 }), { status: 'INVALID', cause: 'AMOUNT_INVALID' });
  assert.deepEqual(await refuse({ writeScopeId: ws(2), currency: 'EUR', unitCostMinor: -1 }), { status: 'INVALID', cause: 'AMOUNT_INVALID' });
  assert.deepEqual(await refuse({ writeScopeId: '00000000-0000-4000-8000-000000000000', currency: 'EUR', unitCostMinor: 500 }), { status: 'INVALID', cause: 'SCOPE_NOT_FOUND' });
  assert.equal((await read(`SELECT count(*)::int AS n FROM tenant_data.cost_profile WHERE product_id = (SELECT product_id FROM tenant_data.write_scope WHERE write_scope_id = $1)`, [ws(2)]))[0].n, 0);
});

test('step 187 (risk 17): the bulk-edit window holds manual entry too — the sixth offer in ten minutes without a second factor is refused, with it saved', async () => {
  // ws-1 уже правилось; ещё четыре — пять предложений за окно, шестое без второго фактора — отказ окна
  for (const n of [3, 4, 5, 6]) assert.deepEqual(await store.setOfferCost(world.tenantId, { writeScopeId: ws(n), currency: 'EUR', unitCostMinor: 500 }, actor(false)), { status: 'SAVED' }, `offer ${n}`);
  assert.deepEqual(await store.setOfferCost(world.tenantId, { writeScopeId: ws(7), currency: 'EUR', unitCostMinor: 500 }, actor(false)), { status: 'MFA_REQUIRED', window: true });
  assert.deepEqual(await store.setOfferCost(world.tenantId, { writeScopeId: ws(7), currency: 'EUR', unitCostMinor: 500 }, actor(true)), { status: 'SAVED' });
  const [mfa] = await read(`SELECT created_with_mfa FROM tenant_data.cost_profile WHERE product_id = (SELECT product_id FROM tenant_data.write_scope WHERE write_scope_id = $1)`, [ws(7)]);
  assert.equal(mfa.created_with_mfa, true);
});
