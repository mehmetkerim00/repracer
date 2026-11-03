import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { MemorySeedScope } from '@repracer/pricing-pipeline';
import { inTenant, PgPricingStore, seedPricingWorld, type PgPool, type SeededPricingWorld } from '../src/index.ts';
import { createIsolatedDatabase, type IsolatedDatabase } from './isolated-db.ts';

/**
 * Шаг 113 (билет 110.5): применение импорта себестоимости — 10 000 версий `cost_profile` одним оператором, и на каждую строку два
 * построчных запроса триггеров. Оба были квадратичными:
 *  - подъём пола (`request_floor_raise('cost_profile')`, 0182) ищет единицы товара по `(tenant_id, product_id)` с `field = 'PRICE'` и
 *    `pricing_mode = 'ENGINE'`, а индекс по товару — частичный «не RETIRED», под этот запрос не подходит: проход всех единиц тенанта;
 *  - страж `cost_profile_valid_from_guard` (0005) ищет более позднюю версию товара по фильтру поверх индекса тенанта: проход всех
 *    версий тенанта, растущих по ходу той же вставки.
 * 10 000 строк — 32 с на машине разработчика, из них 22,9 и 4,8 с в этих двух функциях (`pg_stat_user_functions`); индексы 0211 — 4,2 с.
 *
 * Правило держит план на каталоге с настоящей статистикой (1 000 единиц и 1 000 версий себестоимости, ANALYZE): оба запроса ищут по
 * индексу, где в условии поиска товар, у стража — и время. Первая редакция смотрела план на пяти единицах и пустой таблице и в CI
 * получила полный проход — на пустой таблице он и правда дешевле: план крошечной таблицы о квадрате не говорит. Время на свежей таблице
 * держит живой прогон (`cost-import-live.pg.test.ts`, предел 60 с). Тексты запросов — те же, что в функциях. Данные синтетические.
 */

const ACCOUNT = '20000000-0000-4000-8000-000000001131';
const N = 1_000;
let db: IsolatedDatabase;
let admin: PgPool;
let world: SeededPricingWorld;

function scope(n: number): MemorySeedScope {
  return {
    writeScopeId: `ws-${n}`, productId: `prod-${n}`, channelAccountId: ACCOUNT, marketplace: 'de', externalUnitId: `SKU-${n}`, channelProductRef: `3629${n}`,
    condition: 'new', currency: 'EUR', basis: 'GROSS', pricingMode: 'OFF', strategy: null, currentPriceMinor: 1900,
    minPrice: { amountMinor: 1000, id: `min-${n}` }, maxPrice: { amountMinor: 9000, id: `max-${n}` },
  };
}

before(async () => {
  db = await createIsolatedDatabase('costplan113');
  const pool = db.pool('svc_app', 2);
  admin = db.pool('svc_admin', 2);
  world = await seedPricingWorld(pool, {
    provisioningPool: db.pool('svc_provisioning', 1), adminPool: admin, fixtureTenantId: '10000000-0000-4000-8000-000000001131',
    fixtureChannelAccountId: ACCOUNT, marketplaces: ['de'], clock: new Date().toISOString(), seed: { scopes: Array.from({ length: N }, (_, i) => scope(i + 1)) },
  });
  // Версии себестоимости — тем же путём, что импорт продавца; затем настоящая статистика обеих таблиц
  const applied = await new PgPricingStore(pool, { adminPool: admin }).importCosts(world.tenantId, {
    sourceName: 'kosten.csv', sourceFormat: 'CSV', fingerprint: 'f'.repeat(64), skippedRows: 0,
    rows: Array.from({ length: N }, (_, i) => ({ writeScopeId: world.ids.dbId(`ws-${i + 1}`), currency: 'EUR', unitCostMinor: 900 + i })),
  } as never, { membershipId: world.ownerMembershipId, userId: world.userId, mfa: true }, 'APPLY');
  assert.equal(applied.status, 'APPLIED', JSON.stringify(applied));
  await db.superuser('ANALYZE tenant_data.write_scope');
  await db.superuser('ANALYZE tenant_data.cost_profile');
});
after(async () => { await db?.drop(); });

/** Общий план запроса с параметрами — как у построчного запроса триггера после пятого вызова */
async function genericPlan(sql: string, types: string, args: string): Promise<string> {
  return inTenant(admin, world.tenantId, async (tx) => {
    await tx.query('SET LOCAL plan_cache_mode = force_generic_plan');
    await tx.query(`PREPARE q(${types}) AS ${sql}`);
    const { rows } = await tx.query(`EXPLAIN EXECUTE q(${args})`);
    await tx.query('DEALLOCATE q');
    return rows.map((r) => String(r['QUERY PLAN'])).join('\n');
  }, world.userId, { mfa: true });
}
const indexConds = (plan: string) => [...plan.matchAll(/Index Cond: (.+)/g)].map((m) => m[1]!);

// Текст — как в ветке cost_profile функции tenant_data.request_floor_raise() (0182)
const FLOOR_RAISE = `SELECT s.tenant_id, s.write_scope_id FROM tenant_data.write_scope s
  WHERE s.tenant_id = $1 AND s.product_id = $2 AND s.field = 'PRICE' AND s.pricing_mode = 'ENGINE' AND ($3::uuid IS NULL OR s.channel_account_id = $3)`;
// Текст — как в функции tenant_data.cost_profile_valid_from_guard() (0005)
const VALID_FROM = `SELECT 1 FROM tenant_data.cost_profile
  WHERE tenant_id = $1 AND product_id = $2 AND channel_account_id IS NOT DISTINCT FROM $3 AND marketplace IS NOT DISTINCT FROM $4 AND valid_from > $5`;
const floorRaise = () => genericPlan(FLOOR_RAISE, 'uuid, uuid, uuid', `'${world.tenantId}', '${world.ids.dbId('prod-1')}', NULL`);
const validFrom = () => genericPlan(VALID_FROM, 'uuid, uuid, uuid, text, timestamptz', `'${world.tenantId}', '${world.ids.dbId('prod-1')}', '${world.ids.dbId(ACCOUNT)}', 'de', now()`);
const byProduct = (plan: string) => indexConds(plan).some((c) => c.includes('product_id'));
const byProductAndTime = (plan: string) => indexConds(plan).some((c) => c.includes('product_id') && c.includes('valid_from'));

test('step 113: the floor raise after a new unit cost finds the offers of the product by an index, not by every offer of the tenant', async () => {
  const plan = await floorRaise();
  assert.ok(byProduct(plan), `the plan looks the product up by an index:\n${plan}`);
});

test('step 113: the valid-from guard of a new unit cost version finds the later versions of the product by an index, product and time', async () => {
  const plan = await validFrom();
  assert.ok(byProductAndTime(plan), `the plan looks the product and the time up by an index:\n${plan}`);
});

test('step 113: control — without the indexes of 0211 the same plans walk the offers and versions of the tenant', async () => {
  // Зубы [Р-94] на той же базе и статистике: без индексов шага правило красное — оно смотрит на индекс, а не на что угодно
  await db.superuser('DROP INDEX tenant_data.write_scope_engine_product_idx');
  await db.superuser('DROP INDEX tenant_data.cost_profile_product_valid_from_idx');
  const raise = await floorRaise();
  const guard = await validFrom();
  assert.equal(byProduct(raise), false, `without the index the floor raise does not look the product up:\n${raise}`);
  assert.equal(byProductAndTime(guard), false, `without the index the guard does not look the product and the time up:\n${guard}`);
});
