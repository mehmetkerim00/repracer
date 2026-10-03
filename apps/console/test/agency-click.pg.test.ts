import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { createAuthenticator, staticJwks } from '@repracer/identity';
import { PgIdentityDirectory } from '@repracer/identity/pg';
import { createTestIssuer } from '@repracer/identity/test-issuer';
import { PgPricingStore, type PgPool } from '@repracer/pricing-store-pg';
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
let worldsIndex: ReturnType<typeof createTenantWorlds>;
let authenticate: (authorization: string) => Promise<import('@repracer/identity').Principal | null>;

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
  const worlds = worldsIndex = createTenantWorlds({
    authenticator, app: counting(db.pool('svc_app', 4)), admin: counting(db.pool('svc_admin', 4)),
    bulkWorker: counting(db.pool('svc_bulk_worker', 2)), stock: counting(db.pool('svc_stock', 2)),
  });
  const auth = createAuthenticator({ issuer: ISSUER, audience: AUDIENCE, jwks: staticJwks(idp.jwks), directory: new PgIdentityDirectory(authenticator as never) });
  authenticate = (a) => auth.authenticate(a);
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

/**
 * Находка 8 ревью шага 45: отзыв членства в маршруте отсекает и второй рубеж — роль из свежих членств, — поэтому
 * по ответу маршрута не видно, сброшен ли КЭШ. Здесь кэш проверяется сам: указатель миров после отзыва не содержит мира.
 */
test('Р-182: указатель миров (кэш) сбрасывается отзывом членства, а не сроком', async () => {
  const target = tenantIds[5]!;
  const before = await worldsIndex.worldsFor((await authenticate(`Bearer ${token}`))!);
  assert.ok(before.entries.some((e) => e.tenantId === target), 'до отзыва мир в указателе');
  await db.superuser(`SET session_replication_role = replica;
    UPDATE tenant_data.membership SET status = 'REVOKED', revoked_at = now() WHERE tenant_id = '${target}' AND user_id = '${userId}';
    SET session_replication_role = origin;`);
  const after = await worldsIndex.worldsFor((await authenticate(`Bearer ${token}`))!);
  assert.equal(after.entries.some((e) => e.tenantId === target), false, 'после отзыва — нет, хотя срок записи кэша не вышел');
  assert.equal(await after.open(`tenant-${target}`), null, 'и открыть его указателем нельзя');
});

/**
 * Находка 9 ревью шага 45: счётчики одним обращением сверяются с поштучными на НЕНУЛЕВЫХ данных — действующая остановка
 * цен у одного тенанта, снятая у второго, признак демо у третьего. Иначе перепутанный столбец или фильтр в тексте запроса не увидел бы никто.
 */
test('Р-182: worldSummaries совпадает с worldCounters тенант за тенантом на ненулевых данных', async () => {
  const [a, b, c] = [tenantIds[10]!, tenantIds[11]!, tenantIds[12]!];
  await db.superuser(`SET session_replication_role = replica;
    INSERT INTO tenant_data.price_stop (tenant_id, scope_type, stopped_by_membership_id, stop_note)
      SELECT m.tenant_id, 'TENANT', m.membership_id, 'synthetic stop for the counter check'
        FROM tenant_data.membership m WHERE m.user_id = '${userId}' AND m.tenant_id = '${a}';
    -- Снятая остановка не считается: фильтр «действует» тоже сверяется
    INSERT INTO tenant_data.price_stop (tenant_id, scope_type, stopped_by_membership_id, stop_note, released_at, released_by_membership_id, release_note)
      SELECT m.tenant_id, 'TENANT', m.membership_id, 'synthetic stop, already released', now(), m.membership_id, 'released for the counter check'
        FROM tenant_data.membership m WHERE m.user_id = '${userId}' AND m.tenant_id = '${b}';
    UPDATE tenant_data.tenant SET demo = true WHERE tenant_id = '${c}';
    SET session_replication_role = origin;`);
  const store = new PgPricingStore(db.pool('svc_app', 2), { adminPool: db.pool('svc_admin', 2) });
  const now = new Date().toISOString() as never;
  const ids = [a, b, c, tenantIds[13]!];
  const many = await store.worldSummaries(ids, now);
  for (const id of ids) {
    // Шаг 69 (K1, K4): язык и пояс показа — свойства тенанта в той же сводке, у счётчиков их нет
    const { awaitingAccess, locale, timeZone, ...counters } = many.get(id)!;
    assert.deepEqual(counters, await store.worldCounters(id, now), `тенант ${id}`);
    assert.ok(locale === 'de' || locale === 'en', `тенант ${id}: язык ${locale}`);
    assert.equal(typeof timeZone, 'string');
    assert.equal(awaitingAccess, 0);
  }
  assert.deepEqual([many.get(a)!.activeStops, many.get(b)!.activeStops, many.get(c)!.demo], [1, 0, true], 'данные ненулевые');
});

/**
 * Шаг 69 (K1, K4): язык и пояс показа — свойства тенанта, а не развёртывания и не куки. Агентство с тенантами DE и US видит каждый на
 * его языке: кука браузера выбирает язык страницы входа и списка, а мир тенанта говорит языком тенанта. Время показа — в поясе
 * тенанта со смещением; внутри системы — UTC.
 */
test('шаг 69 (K1, K4): агентство видит каждый тенант на его языке и в его поясе — кука браузера этого не меняет', async () => {
  const [us, de] = [tenantIds[20]!, tenantIds[21]!];
  const post = (tenant: string, body: unknown) => handle({ method: 'POST', url: `/api/worlds/tenant-${tenant}/settings`, body, authorization: `Bearer ${token}`, cookie: 'repracer_locale=de' });
  const saved = await post(us, { locale: 'en', timeZone: 'Asia/Tokyo' });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual(saved.body, { locale: 'en', timeZone: 'Asia/Tokyo', timeZoneSet: true, canChange: true });
  // Пояс, которого нет в базе поясов, — отказ своей причиной; язык вне списка — отказ
  assert.equal((await post(us, { timeZone: 'Mars/Olympus_Mons' })).status, 400);
  assert.equal((await post(us, { locale: 'fr' })).status, 400);
  // Немецкий тенант — по умолчанию; у тенанта без витрин пояс показа — UTC
  const read = await handle({ method: 'GET', url: `/api/worlds/tenant-${de}/settings`, body: undefined, authorization: `Bearer ${token}`, cookie: 'repracer_locale=en' });
  assert.deepEqual(read.body, { locale: 'de', timeZone: 'UTC', timeZoneSet: false, canChange: true });

  // Кука — английская у одного запроса и немецкая у другого: экраны говорят языком тенанта, а не куки
  const usStop = await handle({ method: 'GET', url: `/api/worlds/tenant-${us}/stop`, body: undefined, authorization: `Bearer ${token}`, cookie: 'repracer_locale=de' });
  const deStop = await handle({ method: 'GET', url: `/api/worlds/tenant-${de}/stop`, body: undefined, authorization: `Bearer ${token}`, cookie: 'repracer_locale=en' });
  assert.equal(usStop.status, 200, JSON.stringify(usStop.body).slice(0, 300));
  assert.match(JSON.stringify(usStop.body), /Stop by a person/, 'тенант US — по-английски при немецкой куке');
  assert.match(JSON.stringify(deStop.body), /Stopp durch einen Menschen/, 'тенант DE — по-немецки при английской куке');
  const list = await click('/api/worlds');
  const rows = list.body as Array<{ id: string; locale: string | null; timeZone: string | null }>;
  assert.deepEqual([rows.find((r) => r.id === `tenant-${us}`)?.locale, rows.find((r) => r.id === `tenant-${us}`)?.timeZone], ['en', 'Asia/Tokyo'], 'список миров несёт язык и пояс тенанта');

  // Время показа — в поясе тенанта: остановка цен, поставленная сейчас, подписана смещением Токио (без перехода на летнее время)
  await db.superuser(`SET session_replication_role = replica;
    INSERT INTO tenant_data.price_stop (tenant_id, scope_type, stopped_by_membership_id, stop_note)
      SELECT m.tenant_id, 'TENANT', m.membership_id, 'synthetic stop for the time zone check'
        FROM tenant_data.membership m WHERE m.user_id = '${userId}' AND m.tenant_id = '${us}';
    SET session_replication_role = origin;`);
  const stopped = JSON.stringify((await handle({ method: 'GET', url: `/api/worlds/tenant-${us}/stop`, body: undefined, authorization: `Bearer ${token}`, cookie: '' })).body);
  assert.match(stopped, /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC\+9/, `время остановки — в поясе тенанта: ${stopped.slice(0, 400)}`);
  assert.doesNotMatch(stopped, /\d{2}:\d{2}:\d{2} UTC"/, 'и не в UTC');
});
