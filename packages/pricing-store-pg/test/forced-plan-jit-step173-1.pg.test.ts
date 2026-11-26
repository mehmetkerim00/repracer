import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { PgPricingStore, seedPricingWorld, type PgPool, type SeededPricingWorld } from '../src/index.ts';
import { explaining, jitCompiled, type Explained } from './explaining-pool.ts';
import { createIsolatedDatabase, type IsolatedDatabase } from './isolated-db.ts';

/**
 * Шаг 173.1: запросы по каталогу целиком идут с отключёнными вложенными циклами (`wholeCatalogPlan`, шаг 67). Где вложенный цикл неизбежен
 * (LATERAL по функции стража перевода), PostgreSQL прибавляет к оценке штраф 10^10 — и оценка проходит пороги JIT: на QA-A (PostgreSQL с LLVM)
 * оператор стражей чеклиста готовности компилировался с инлайнингом и оптимизацией — 2 133 мс исполнения на ноль строк, весь маршрут ~2 с.
 * Локальный PostgreSQL без LLVM JIT не исполняет, поэтому правило проверяет РЕШЕНИЕ PostgreSQL о JIT, а не время: оператор компилируется,
 * когда `jit` включён и оценка плана выше `jit_above_cost`. Каждый оператор фактов и страницы каталога объясняется в той же транзакции,
 * с теми же настройками и параметрами. Данные синтетические
 */
const ACCOUNT = '20000000-0000-4000-8000-000000001731';
let db: IsolatedDatabase;
let pool: PgPool;
let admin: PgPool;
let world: SeededPricingWorld;

before(async () => {
  db = await createIsolatedDatabase('step1731');
  pool = db.pool('svc_app');
  admin = db.pool('svc_admin', 2);
  world = await seedPricingWorld(pool, { provisioningPool: db.pool('svc_provisioning', 1), adminPool: admin,
    fixtureTenantId: '10000000-0000-4000-8000-000000001731', fixtureChannelAccountId: ACCOUNT, fixtureChannel: 'AMAZON', fixtureRegion: 'US',
    fixtureExternalAccountId: `A1SYN1731${Date.now().toString(36).toUpperCase()}`, marketplaces: ['ATVPDKIKX0DER'], writeMode: 'SHADOW',
    clock: new Date().toISOString(), seed: { scopes: [] } });
});
after(async () => { await db?.drop(); });

test('step 173.1: no statement of the whole-catalog facts or page is JIT-compiled because the forced plan inflated its cost', async () => {
  const seen: Explained[] = [];
  const store = new PgPricingStore(explaining(db.pool('svc_app', 1), seen), { adminPool: explaining(db.pool('svc_admin', 1), seen) });
  const now = new Date().toISOString() as never;
  await store.consoleCatalogFacts(world.tenantId, { first: 3, strategyUsage: { examples: 3 }, stopImpact: true, channelPricing: { limit: 5 },
    attention: { now }, readiness: { now }, money: { now } });
  await store.consoleCatalogPage(world.tenantId, now, { offset: 0, limit: 10 });
  // Состояние каталога целиком (массовые операции) — тоже под отключёнными вложенными циклами
  await store.readConsoleState(world.tenantId, now);
  assert.ok(seen.some((s) => /live_switch_blocking_offers/.test(s.text)), 'the switch-guard statement of the readiness facts is among the explained ones');
  assert.ok(seen.some((s) => /json_agg/.test(s.text)), 'the whole-catalog state read is among the explained ones');
  assert.deepEqual(jitCompiled(seen), [],
    'PostgreSQL would JIT-compile these statements (jit on, cost above jit_above_cost)');
});
