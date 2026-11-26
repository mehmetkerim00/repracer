import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { MemorySeedScope } from '@repracer/pricing-pipeline';
import { PgPricingStore, PgStockStore, seedPricingWorld, type SeededPricingWorld } from '../src/index.ts';
import { explaining, jitCompiled, type Explained } from './explaining-pool.ts';
import { createIsolatedDatabase, type IsolatedDatabase } from './isolated-db.ts';

/**
 * Шаг 184: правило шага 173.1 — на фоновых заданиях импорта. Импорт остатков (товары глазами импорта — `stockImportTargets` у шаблона,
 * примерки и применения; `importStock`) и применение импорта себестоимости (сверка с примеркой — `importCosts` с ожидаемыми значениями)
 * читают каталог с отключёнными вложенными циклами (шаг 66). Где вложенный цикл неизбежен, PostgreSQL прибавляет к оценке штраф 10^10,
 * оценка проходит пороги JIT, и на PostgreSQL с LLVM (QA-A, CI) оператор компилируется: секунды к заданию на ровном месте (шаг 173.1 —
 * 2 133 мс на ноль строк). Правило — решение PostgreSQL о JIT, а не время. Данные синтетические
 */
const ACCOUNT = '20000000-0000-4000-8000-000000001841';
let db: IsolatedDatabase;
let world: SeededPricingWorld;

function scope(n: number): MemorySeedScope {
  return {
    writeScopeId: `ws-${n}`, productId: `prod-${n}`, channelAccountId: ACCOUNT, marketplace: 'de', externalUnitId: String(18400 + n),
    channelProductRef: `184${n}`, condition: 'new', currency: 'EUR', basis: 'GROSS', pricingMode: 'OFF', strategy: null,
    currentPriceMinor: 1900, minPrice: { amountMinor: 1000, id: `min-${n}` }, maxPrice: { amountMinor: 5000, id: `max-${n}` },
  };
}

before(async () => {
  db = await createIsolatedDatabase('step184');
  world = await seedPricingWorld(db.pool('svc_app'), {
    provisioningPool: db.pool('svc_provisioning', 1), adminPool: db.pool('svc_admin', 2), fixtureTenantId: '10000000-0000-4000-8000-000000001841',
    fixtureChannelAccountId: ACCOUNT, marketplaces: ['de'], clock: new Date().toISOString(), seed: { scopes: [1, 2, 3].map(scope) },
  });
});
after(async () => { await db?.drop(); });

const owner = () => ({ membershipId: world.ownerMembershipId, userId: world.userId, mfa: true });

test('step 184: no statement of the stock import or of the unit-cost import apply is JIT-compiled because the forced plan inflated its cost', async () => {
  const seen: Explained[] = [];
  const admin = explaining(db.pool('svc_admin', 1), seen);
  const stock = new PgStockStore({ adminPool: admin, stockPool: db.pool('svc_stock', 1) });
  const store = new PgPricingStore(db.pool('svc_app', 1), { adminPool: admin });

  // Импорт остатков: товары глазами импорта (шаблон, примерка и применение задания) и прежний путь `importStock`
  const source = await stock.createStockSource(world.tenantId, { mode: 'INTERNAL_POOL', name: 'Warehouse' }, owner());
  assert.equal(source.status, 'CREATED', JSON.stringify(source));
  const sourceId = (source as { stockSourceId: string }).stockSourceId;
  const targets = await stock.stockImportTargets(world.tenantId, sourceId);
  assert.ok(Array.isArray(targets) && targets.length === 3, 'the stock import sees the three products');
  const imported = await stock.importStock(world.tenantId, sourceId, [{ sku: '18401', quantity: 7 }], owner());
  assert.equal(imported.status, 'APPLIED', JSON.stringify(imported));

  // Применение импорта себестоимости ровно по примерке: себестоимость и комиссия продавца сверяются с тем, что видела примерка
  const id = (n: number) => world.ids.dbId(`ws-${n}`);
  const applied = await store.importCosts(world.tenantId, { sourceName: 'costs.csv', sourceFormat: 'CSV', fingerprint: 'fp-184', skippedRows: 0,
    rows: [1, 2].map((n) => ({ writeScopeId: id(n), unitCostMinor: 400 + n, currency: 'EUR', expected: { costProfileId: null, sellerFee: null } })) }, owner(), 'APPLY');
  assert.equal(applied.status, 'APPLIED', JSON.stringify(applied));

  // Положительный контроль: каждый оператор под отключёнными вложенными циклами — среди объяснённых
  for (const [what, form] of [
    ['the products of the stock import (template, check and apply)', /array_remove\(array_agg\(DISTINCT/],
    ['the products of the earlier stock import path', /unnest\(array_remove\(ARRAY\[p\.sku/],
    ['the unit-cost profiles compared with the check', /DISTINCT ON \(i\.ws\)/],
    ['the seller fees compared with the check', /source = 'SELLER_DECLARED' AND valid_until/],
  ] as const) assert.ok(seen.some((s) => form.test(s.text)), `${what} — among the explained statements`);
  assert.deepEqual(jitCompiled(seen), [], 'PostgreSQL would JIT-compile these statements (jit on, cost above jit_above_cost)');
});
