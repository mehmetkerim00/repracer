import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { MemorySeedScope } from '@repracer/pricing-pipeline';
import { createPool, PgPricingStore, seedPricingWorld, type PgPool, type SeededPricingWorld } from '../src/index.ts';
import { createIsolatedDatabase, requireEnv, type IsolatedDatabase } from './isolated-db.ts';

/**
 * Шаг 67 (Р-146): чтения консоли по каталогу — без квадрата при ЛЮБОЙ статистике. Сразу после посева (демо, новый тенант, первый
 * импорт) статистики у таблиц каталога нет, планировщик ждёт по строке и соединяет предложения тенанта × товары тенанта вложенными
 * циклами: страница каталога демо из 200 предложений — 7 979 900 отброшенных строк и 9,6 с, мир страницы из 50 единиц — 1 999 950 и
 * 10 с; на CI экран товаров гостя шёл 19,2 с при пределе 10 (быстрый прогон шага 66). Класс уже встречался (шаг 35) и вернулся
 * новыми запросами — поэтому тест нарочно стирает статистику каталога и держит ВСЕ чтения консоли по каталогу: мир страницы, страницу
 * каталога, факты каталога и каталог целиком. Положительный контроль — прежний свободный запрос страницы при той же статистике упирается
 * в предел времени: ловушка взведена, и быстрые чтения быстры не потому, что она пуста.
 */
const TENANT = '10000000-0000-4000-8000-000000000367';
const ACCOUNT = '20000000-0000-4000-8000-000000000367';
const UNITS = 400;
const CATALOG_TABLES = ['tenant_data.offer_mapping', 'tenant_data.write_scope', 'tenant_data.product', 'tenant_data.write_scope_sync_state', 'tenant_data.pricing_strategy'];

let db: IsolatedDatabase;
let world: SeededPricingWorld;
let su: PgPool;
let store: PgPricingStore;

const scope = (n: number): MemorySeedScope => ({
  writeScopeId: `ws-${n}`, productId: `prod-${n}`, channelAccountId: ACCOUNT, marketplace: 'de', externalUnitId: String(670000 + n), externalOfferId: `SYN-OFFER-67-${n}`,
  channelProductRef: `3670${n}`, condition: 'new', currency: 'EUR', basis: 'GROSS', pricingMode: 'OFF', strategy: null, currentPriceMinor: 1900,
});

before(async () => {
  db = await createIsolatedDatabase('freshstats');
  const url = new URL(requireEnv('REPRACER_PG_ADMIN_URL')); url.pathname = `/${db.name}`;
  su = createPool(url.toString(), { max: 1, applicationName: 'repracer-fresh-stats' });
  const admin = db.pool('svc_admin', 3);
  world = await seedPricingWorld(db.pool('svc_app', 4), {
    provisioningPool: db.pool('svc_provisioning', 1), adminPool: admin, fixtureTenantId: TENANT, fixtureChannelAccountId: ACCOUNT,
    marketplaces: ['de'], clock: new Date().toISOString(), seed: { scopes: Array.from({ length: UNITS }, (_, i) => scope(i + 1)) },
  });
  store = new PgPricingStore(db.pool('svc_app', 2), { adminPool: admin });
  // Статистика — как у свежей базы: стёрта и не появится сама (автоанализ этих таблиц выключен в одноразовой базе)
  for (const t of CATALOG_TABLES) {
    await su.query(`ALTER TABLE ${t} SET (autovacuum_enabled = false)`);
    await su.query(`DELETE FROM pg_catalog.pg_statistic WHERE starelid = '${t}'::regclass`);
    await su.query(`UPDATE pg_catalog.pg_class SET reltuples = -1, relpages = 0 WHERE oid = '${t}'::regclass`);
  }
});

after(async () => {
  await su?.end();
  await db?.drop();
});

const timed = async <T>(fn: () => Promise<T>): Promise<{ result: T; seconds: number }> => {
  const started = performance.now();
  const result = await fn();
  return { result, seconds: (performance.now() - started) / 1000 };
};

test('step 67 (Р-146): with no catalog statistics, every console read over the catalog stays linear — the page world, the catalog page, the catalog facts, the whole catalog', async () => {
  const now = new Date().toISOString() as never;
  const tenant = world.tenantId;
  // Положительный контроль: прежняя форма мира страницы (свободный план, единицы — фильтром) на этой статистике квадратична
  const ids = (await su.query(`SELECT price_write_scope_id AS id FROM tenant_data.offer_mapping WHERE tenant_id = $1 ORDER BY created_at LIMIT 50`, [tenant])).rows.map((r) => String(r.id));
  const client = await su.connect();
  let controlSeconds = 0;
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE svc_admin');
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenant]);
    await client.query(`SET LOCAL statement_timeout = '5s'`);
    const started = performance.now();
    const control = await client.query(
      `SELECT count(*) FROM tenant_data.offer_mapping m
         JOIN tenant_data.write_scope s ON s.tenant_id = m.tenant_id AND s.write_scope_id = m.price_write_scope_id AND s.field = 'PRICE' AND s.status <> 'RETIRED'
         JOIN tenant_data.product p ON p.tenant_id = s.tenant_id AND p.product_id = s.product_id
         JOIN tenant_data.write_scope_sync_state ss ON ss.tenant_id = s.tenant_id AND ss.write_scope_id = s.write_scope_id
        WHERE m.tenant_id = $1 AND m.status <> 'ENDED' AND s.write_scope_id = ANY ($2::uuid[])`, [tenant, ids]).then(() => 'finished', (e: { code?: string }) => e.code ?? 'error');
    controlSeconds = (performance.now() - started) / 1000;
    assert.equal(control, '57014', `the trap is set: the free plan of the old page query runs into the time limit (${controlSeconds.toFixed(1)} s)`);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }

  const page = await timed(() => store.consoleCatalogPage(tenant, now, { offset: 200, limit: 50 }));
  assert.equal(page.result.total, UNITS);
  const listed = await timed(() => store.readConsoleState(tenant, now, { scopeIds: page.result.scopeIds }));
  assert.equal(listed.result.scopes.length, 50, 'the page world carries exactly the listed units');
  const facts = await timed(() => store.consoleCatalogFacts(tenant, {
    first: 200, search: { q: '6702', limit: 200, labelTemplate: '{p} · {s}', marketplaceWords: {}, channelNames: { KAUFLAND: 'Kaufland' }, unknownChannel: 'UNKNOWN_CHANNEL' },
    strategyUsage: { examples: 10 }, stopImpact: true, channelPricing: { limit: 200 }, keys: [{ marketplace: 'de', channelProductRef: '3670100', condition: 'new' }],
  }));
  assert.ok(facts.result.search!.total > 0 && facts.result.keyed!.length === 1, `the facts found what the catalog has: ${JSON.stringify({ search: facts.result.search!.total, keyed: facts.result.keyed })}`);
  const whole = await timed(() => store.readConsoleState(tenant, now));
  assert.equal(whole.result.scopes.length, UNITS);
  const seconds = { page: page.seconds, listed: listed.seconds, facts: facts.seconds, whole: whole.seconds };
  // Без защиты каждое из них — секунды и десятки секунд уже на 400 предложениях (контроль выше); с защитой — доли секунды
  assert.ok(Object.values(seconds).every((s) => s < 3), `every catalog read stays linear without statistics: ${JSON.stringify(seconds)}`);
});
