import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { PgPricingStore, seedPricingWorld, type PgPool, type SeededPricingWorld } from '../src/index.ts';
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

interface Explained { text: string; cost: number; jit: string; above: number }

/** Пул, у которого каждый оператор чтения объясняется сразу после исполнения — в той же транзакции и с теми же параметрами */
function explaining(target: PgPool, seen: Explained[]): PgPool {
  const connect = target.connect.bind(target);
  const wrapped = new WeakSet<object>();
  (target as unknown as { connect: () => Promise<unknown> }).connect = async () => {
    const client = await connect() as unknown as { query: (text: unknown, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> };
    // Пул выдаёт тот же клиент снова — обёртка ставится один раз, иначе объяснялись бы и её собственные запросы
    if (wrapped.has(client)) return client;
    wrapped.add(client);
    const query = client.query.bind(client);
    client.query = async (text: unknown, values?: unknown[]) => {
      const result = await query(text, values);
      if (typeof text === 'string' && /^\s*(WITH|SELECT)\b/i.test(text) && !/set_config\(/.test(text)) {
        const { rows: [plan] } = await query(`EXPLAIN (FORMAT JSON) ${text}`, values);
        const { rows: [s] } = await query(`SELECT current_setting('jit') AS jit, current_setting('jit_above_cost')::float8 AS above`);
        const cost = Number((plan!['QUERY PLAN'] as Array<{ Plan: { 'Total Cost': number } }>)[0]!.Plan['Total Cost']);
        seen.push({ text: text.replace(/\s+/g, ' ').trim(), cost, jit: String(s!.jit), above: Number(s!.above) });
      }
      return result;
    };
    return client;
  };
  return target;
}

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
  const compiled = seen.filter((s) => s.jit === 'on' && s.cost > s.above);
  assert.deepEqual(compiled.map((s) => `${s.cost.toExponential(2)} > ${s.above}: ${s.text.slice(0, 200)}`), [],
    'PostgreSQL would JIT-compile these statements (jit on, cost above jit_above_cost)');
});
