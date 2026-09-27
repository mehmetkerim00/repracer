import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { createAuthenticator, staticJwks } from '@repracer/identity';
import { PgIdentityDirectory } from '@repracer/identity/pg';
import { createTestIssuer } from '@repracer/identity/test-issuer';
import type { PgPool } from '@repracer/pricing-store-pg';
import { createStandApi } from '../server/stand-server.ts';
import { createTenantWorlds } from '../server/tenant-worlds.ts';
import { createIsolatedDatabase, type IsolatedDatabase } from '../../../packages/pricing-store-pg/test/isolated-db.ts';

/**
 * Р-182 (шаг 45): клик пользователя агентства — считанные запросы к базе, а не «по запросу на каждый тенант».
 *
 * Мир: один пользователь с членством в 50 тенантах (агентство, Р-9). Считаются ОБРАЩЕНИЯ к базе всех пулов консоли на
 * один запрос страницы: `pool.query` и `client.query` внутри транзакций (BEGIN, контекст тенанта, COMMIT — каждое
 * отдельно, это сетевые обходы). До Р-182 клик в мир собирал все 50 миров — `security.console_tenant_worlds` и
 * аккаунты каждого тенанта (51 обращение сверх самого экрана).
 *
 * Второе свойство — то, ради которого кэш опасен: изменение членства видно СЛЕДУЮЩИМ запросом. Отозванное членство
 * убирает мир из списка и закрывает его прямой адрес (404), новое — добавляет мир, без ожидания срока кэша.
 *
 * Данные синтетические: тенанты, пользователь и привязка входа заводятся суперпользователем стенда без стражей
 * административной записи — предмет прогона не они, а число обращений.
 */

const TENANTS = 50;
const ISSUER = 'https://identity.agency.repracer.invalid';
const AUDIENCE = 'repracer-console';
let db: IsolatedDatabase;
let handle: ReturnType<typeof createStandApi>;
let token = '';
let userId = '';
const tenantIds: string[] = [];
const pools: PgPool[] = [];
let roundTrips = 0;

/** Пул, считающий обращения к базе: и одиночные запросы, и запросы клиента внутри транзакции */
function counting(pool: PgPool): PgPool {
  pools.push(pool);
  const query = pool.query.bind(pool);
  (pool as unknown as { query: unknown }).query = (...args: unknown[]) => { roundTrips += 1; return (query as (...a: unknown[]) => unknown)(...args); };
  const connect = pool.connect.bind(pool) as (cb?: unknown) => unknown;
  const mark = (client: unknown) => {
    const marked = client as { query: (...a: unknown[]) => unknown; __counted?: boolean };
    if (client && !marked.__counted) {
      const inner = marked.query.bind(client);
      marked.query = (...args: unknown[]) => { roundTrips += 1; return inner(...args); };
      marked.__counted = true;
    }
    return client;
  };
  // pg зовёт connect и с обратным вызовом (изнутри pool.query) — такие запросы уже сосчитаны самим pool.query
  (pool as unknown as { connect: unknown }).connect = (cb?: unknown) => (typeof cb === 'function'
    ? connect(cb)
    : (connect() as Promise<unknown>).then(mark));
  return pool;
}

async function click(url: string): Promise<{ status: number; body: unknown; roundTrips: number }> {
  const start = roundTrips;
  const r = await handle({ method: 'GET', url, body: undefined, authorization: `Bearer ${token}`, cookie: 'repracer_locale=en' });
  return { status: r.status, body: r.body, roundTrips: roundTrips - start };
}

before(async () => {
  db = await createIsolatedDatabase('agency');
  userId = randomUUID();
  const values: string[] = [];
  for (let i = 0; i < TENANTS; i += 1) {
    const id = randomUUID();
    tenantIds.push(id);
    values.push(`('${id}', 'Agentur-Kunde ${String(i).padStart(2, '0')}', 'EU', 'ACTIVE')`);
  }
  await db.superuser(`
    SET session_replication_role = replica;
    INSERT INTO tenant_data.tenant (tenant_id, name, data_region, status) VALUES ${values.join(', ')};
    INSERT INTO platform.app_user (user_id, email) VALUES ('${userId}', 'agency@example.test');
    INSERT INTO platform.external_identity (issuer, subject, user_id) VALUES ('${ISSUER}', 'agency-user', '${userId}');
    INSERT INTO tenant_data.membership (tenant_id, user_id, role, status)
      SELECT t, '${userId}', 'OWNER', 'ACTIVE' FROM unnest(ARRAY[${tenantIds.map((t) => `'${t}'::uuid`).join(', ')}]) t;
    SET session_replication_role = origin;`);

  const idp = createTestIssuer({ issuer: ISSUER, audience: AUDIENCE });
  token = idp.token('agency-user', { email: 'agency@example.test', amr: ['pwd', 'otp'] });
  const authenticator = counting(db.pool('svc_authenticator', 2));
  const worlds = createTenantWorlds({
    authenticator, app: counting(db.pool('svc_app', 4)), admin: counting(db.pool('svc_admin', 4)),
    bulkWorker: counting(db.pool('svc_bulk_worker', 2)), stock: counting(db.pool('svc_stock', 2)),
  });
  handle = createStandApi([], {
    authenticator: createAuthenticator({ issuer: ISSUER, audience: AUDIENCE, jwks: staticJwks(idp.jwks), directory: new PgIdentityDirectory(authenticator as never) }),
  }, { tenantWorlds: (principal) => worlds.worldsFor(principal) });
});

after(async () => {
  // Пулы закрывает сама изолированная база при удалении
  await db?.drop();
});

test('Р-182: клик агентства из 50 тенантов — обращения к базе на запрос страницы', async () => {
  const world = `tenant-${tenantIds[17]}`;
  const measured: Record<string, number[]> = { list: [], onboarding: [], products: [] };
  // Прогрев: первый запрос строит мир; затем по три клика каждого вида
  await click('/api/worlds');
  for (let i = 0; i < 3; i += 1) {
    const list = await click('/api/worlds');
    assert.equal(list.status, 200);
    assert.equal((list.body as unknown[]).length, TENANTS, 'в списке все 50 тенантов агентства');
    measured.list!.push(list.roundTrips);
    const onboarding = await click(`/api/worlds/${world}/onboarding`);
    assert.equal(onboarding.status, 200, JSON.stringify(onboarding.body).slice(0, 200));
    measured.onboarding!.push(onboarding.roundTrips);
    const products = await click(`/api/worlds/${world}/products?limit=200`);
    assert.equal(products.status, 200, JSON.stringify(products.body).slice(0, 200));
    measured.products!.push(products.roundTrips);
  }
  console.log(JSON.stringify({ agencyClick: { tenants: TENANTS, roundTrips: measured } }));
  /**
   * До Р-182 (замер шага 45 на том же мире): список — 452 обращения, клик в экран пути — 164, в товары — 171. Пределы ниже
   * не зависят от числа тенантов: список — вход и одно обращение за счётчиками всех; клик — вход, аккаунты ОДНОГО мира
   * и сам экран. Вернись сборка всех миров на запрос — клик снова вырастет на три обращения на тенант.
   */
  assert.ok(Math.max(...measured.list!) <= 3, `список миров: ${measured.list}`);
  assert.ok(Math.max(...measured.onboarding!) <= 20, `клик в экран пути: ${measured.onboarding}`);
  assert.ok(Math.max(...measured.products!) <= 30, `клик в товары: ${measured.products}`);
});

test('Р-182: кэш миров снимается изменением членства — следующим же запросом, без ожидания срока', async () => {
  const revoked = tenantIds[3]!;
  const world = `tenant-${revoked}`;
  assert.equal((await click(`/api/worlds/${world}/onboarding`)).status, 200, 'до отзыва мир открыт');
  await db.superuser(`SET session_replication_role = replica;
    UPDATE tenant_data.membership SET status = 'REVOKED', revoked_at = now() WHERE tenant_id = '${revoked}' AND user_id = '${userId}';
    SET session_replication_role = origin;`);
  const list = await click('/api/worlds');
  assert.equal((list.body as Array<{ id: string }>).some((w) => w.id === world), false, 'отозванное членство убирает мир из списка сразу');
  assert.equal((list.body as unknown[]).length, TENANTS - 1);
  assert.equal((await click(`/api/worlds/${world}/onboarding`)).status, 404, 'и закрывает его прямой адрес');

  // Новое членство — новый мир, тоже сразу
  const added = randomUUID();
  await db.superuser(`SET session_replication_role = replica;
    INSERT INTO tenant_data.tenant (tenant_id, name, data_region, status) VALUES ('${added}', 'Neuer Kunde', 'EU', 'ACTIVE');
    INSERT INTO tenant_data.membership (tenant_id, user_id, role, status) VALUES ('${added}', '${userId}', 'OPERATOR', 'ACTIVE');
    SET session_replication_role = origin;`);
  const after = await click('/api/worlds');
  const fresh = (after.body as Array<{ id: string; role: string }>).find((w) => w.id === `tenant-${added}`);
  assert.ok(fresh, 'новое членство видно следующим запросом');
  assert.equal(fresh.role, 'Operator', 'роль — из свежего членства');
  assert.equal((await click(`/api/worlds/tenant-${added}/onboarding`)).status, 200);
});
