import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { StandToken, WorldSummary } from '../src/api-types.ts';
import { STAND_AUDIENCE, STAND_ISSUER, type LiveWorld } from '@repracer/contract-tests/stand';
import { demoWorld, DEMO_OFFERS, type DemoWorld } from '@repracer/contract-tests/live';
import { createAuthenticator, MemoryIdentityDirectory, staticJwks } from '@repracer/identity';
import { createTestIssuer } from '@repracer/identity/test-issuer';
import { PgPricingStore, PgStockStore, type PgPool } from '@repracer/pricing-store-pg';
import { createIsolatedDatabase, type IsolatedDatabase } from '../../../packages/pricing-store-pg/test/isolated-db.ts';
import { createStandApi, createStandServer } from '../server/stand-server.ts';

/**
 * Р-154 (шаг 35), критерий закрытия OQ-214: демо-стенд живёт виртуальные СУТКИ под настоящим планировщиком, и после них
 * КАЖДЫЙ экран консоли отвечает в пределе экрана [Р-136] — 10 с и 8 МБ. До шага 35 экран пути отвечал 10,98 с уже
 * после двух часов: состояние консоли читало все решения тенанта ради шести счётчиков. Сутки на 200 предложениях — порядка
 * ста тысяч решений; это и есть нагрузка, которую увидит первый живой тенант через неделю.
 *
 * Прогон идёт как браузер [Р-142]: настоящий HTTP-сервер стенда, токен, те же адреса. Данные синтетические.
 */

const SCREEN_LIMIT_SECONDS = 10;
const SCREEN_LIMIT_BYTES = 8 * 1024 * 1024;
const VIRTUAL_HOURS = 24;
const DEMO_WORLD = 'demo/kaufland';
/** Нижняя граница объёма — чтобы прогон нельзя было «пройти» пустым миром: замер шага 34 — 9000 решений за два часа */
const MIN_DECISIONS = 50_000;

let db: IsolatedDatabase;
let demo: DemoWorld;
let server: Server;
let origin: string;
let owner: { authorization: string; cookie: string };
let observer: PgPool;
const measured: Array<{ operation: string; seconds: number; bytes: number; status: number }> = [];

const api = (screen: string, param?: string) => `/api/worlds/${encodeURIComponent(DEMO_WORLD)}/${screen}${param ? `/${param}` : ''}`;

async function get<T>(operation: string, url: string): Promise<{ status: number; body: T; bytes: number; seconds: number }> {
  const started = process.hrtime.bigint();
  const r = await fetch(`${origin}${url}`, { headers: { authorization: owner.authorization, cookie: owner.cookie } });
  const text = await r.text();
  const seconds = Math.round(Number(process.hrtime.bigint() - started) / 1e6) / 1000;
  const bytes = Buffer.byteLength(text, 'utf8');
  measured.push({ operation, seconds, bytes, status: r.status });
  return { status: r.status, body: (text ? JSON.parse(text) : null) as T, bytes, seconds };
}

before(async () => {
  db = await createIsolatedDatabase('demoday');
  const appPool: PgPool = db.pool('svc_app', 4);
  const adminPool: PgPool = db.pool('svc_admin', 4);
  // Старт — 09:00 UTC завтрашних суток: сутки пересекут границу суток витрины ровно один раз, и это часть прогона, а не случайность
  const tomorrow = new Date(Date.now() + 24 * 3_600_000);
  const startIso = new Date(Date.UTC(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth(), tomorrow.getUTCDate(), 9, 0, 0)).toISOString();
  // bare: false — мир уже настроен (себестоимость, границы, стратегия, движок включён): как после пройденного онбординга
  demo = await demoWorld({
    tag: 3500, startIso, bare: false, appPool, adminPool, provisioningPool: db.pool('svc_provisioning', 1), dispatcherPool: db.pool('svc_dispatcher', 2),
    schedulerPool: db.pool('svc_scheduler', 3), exporterPool: db.pool('svc_exporter', 2),
  });
  const seeded = demo.live.seeded;
  const store = new PgPricingStore(appPool, { adminPool, bulkWorkerPool: db.pool('svc_bulk_worker', 2) });
  const stock = new PgStockStore({ adminPool, stockPool: db.pool('svc_stock', 2) });
  const nowIso = () => demo.clock.iso();
  const accounts = [{ channelAccountId: seeded.channelAccountId, channel: 'KAUFLAND', marketplaces: ['de'], haltRelease: 'SAMPLE' as const }];
  const live: LiveWorld = {
    id: DEMO_WORLD, title: 'Демо: Kaufland на симуляторе', description: `${DEMO_OFFERS} предложений`, tenantId: seeded.tenantId,
    accounts, identityTenantId: seeded.tenantId, membershipAlias: (id) => id, failures: [],
    store: store as never, stock, pipeline: demo.live.pipelineForDbIds() as never, clock: { iso: nowIso, nowMs: () => demo.clock.nowMs() } as never,
    callContext: (channelAccountId) => ({ tenantId: seeded.tenantId as never, channelAccountId: channelAccountId as never, correlationId: 'demo-day', deadline: nowIso() }),
    view: async (viewer) => ({
      id: DEMO_WORLD, title: 'Демо: Kaufland на симуляторе', description: `${DEMO_OFFERS} предложений`, tenantId: seeded.tenantId, now: nowIso(),
      accounts, viewer: { ...viewer }, state: await store.readConsoleState(seeded.tenantId, nowIso() as never),
    }) as never,
  };
  const directory = new MemoryIdentityDirectory();
  directory.link({ issuer: STAND_ISSUER, subject: 'demo-owner' }, seeded.userId);
  directory.addMembership(seeded.userId, { tenantId: seeded.tenantId, membershipId: seeded.ownerMembershipId, role: 'OWNER' });
  const issuer = createTestIssuer({ issuer: STAND_ISSUER, audience: STAND_AUDIENCE });
  const handle = createStandApi([live], {
    authenticator: createAuthenticator({ issuer: STAND_ISSUER, audience: STAND_AUDIENCE, jwks: staticJwks(issuer.jwks), directory }),
    simulator: { token: () => issuer.token('demo-owner', { email: 'owner@example.invalid', amr: ['pwd', 'otp'] }), expiresInSeconds: 3600 },
  });
  server = createStandServer(handle);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const token = await fetch(`${origin}/api/stand-issuer/token?locale=de`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: 'OWNER' }) });
  owner = { authorization: `Bearer ${((await token.json()) as StandToken).accessToken}`, cookie: 'repracer_locale=de' };
  const observerUrl = new URL(process.env.REPRACER_PG_ADMIN_URL!); observerUrl.pathname = `/${db.name}`;
  const { createPool } = await import('@repracer/pricing-store-pg');
  observer = createPool(observerUrl.toString(), { max: 1, applicationName: 'repracer-demo-day-observer' });
});

after(async () => {
  console.log(JSON.stringify({ virtualHours: VIRTUAL_HOURS, operations: measured }, null, 1));
  server?.close();
  await observer?.end();
  await db?.drop();
});

test('Р-154: сутки демо под планировщиком — объём настоящий', async () => {
  const started = Date.now();
  await demo.advance(VIRTUAL_HOURS);
  const seconds = Math.round((Date.now() - started) / 100) / 10;
  measured.push({ operation: `demo.advance (${VIRTUAL_HOURS} виртуальных часа планировщиком)`, seconds, bytes: 0, status: 200 });
  const { rows: [d] } = await observer.query(`SELECT count(*)::int AS n, count(*) FILTER (WHERE outcome <> 'NO_CHANGE')::int AS interventions FROM channel_data.price_decision WHERE tenant_id = $1`, [demo.live.seeded.tenantId]);
  const { rows: [w] } = await observer.query(`SELECT count(*)::int AS n FROM tenant_data.channel_write_history WHERE tenant_id = $1 AND final_status = 'APPLIED'`, [demo.live.seeded.tenantId]);
  const { rows: failures } = await observer.query(`SELECT job_name, error_code, count(*)::int AS n FROM maintenance.scheduled_job_run WHERE outcome = 'FAILED' GROUP BY 1, 2 ORDER BY 1`);
  console.log(JSON.stringify({ decisions: d!.n, interventions: d!.interventions, applied: w!.n, failures, seconds }));
  assert.ok(Number(d!.n) >= MIN_DECISIONS, `за сутки решений: ${d!.n} (ожидалось не меньше ${MIN_DECISIONS} — иначе нагрузка не та, что у живого тенанта)`);
  assert.ok(Number(w!.n) >= 1000, `записей цены, подтверждённых каналом: ${w!.n}`);
  assert.deepEqual(failures.filter((f) => f.job_name !== 'analytics-export-day'), [], `провалы работ планировщика: ${JSON.stringify(failures)}`);
});

test('Р-154, Р-136: после суток каждый экран отвечает в пределе 10 с / 8 МБ, списки — страницами, счётчики — агрегатом', async () => {
  const worlds = await get<WorldSummary[]>('worlds (список миров)', '/api/worlds');
  assert.equal(worlds.status, 200);
  const summary = worlds.body.find((x) => x.id === DEMO_WORLD)!;
  assert.ok(summary.decisions >= MIN_DECISIONS, `список миров считает решения за сутки агрегатом: ${summary.decisions}`);

  const screens: Array<[string, string]> = [
    ['onboarding', api('onboarding')],
    ['products (первая страница)', api('products')],
    ['products (последняя страница)', `${api('products')}?offset=150&limit=50`],
    ['decisions (первая страница)', api('decisions')],
    ['decisions (страница из середины суток)', `${api('decisions')}?offset=${Math.floor(MIN_DECISIONS / 2)}&limit=200`],
    ['decisions (страница за концом списка)', `${api('decisions')}?offset=99000000&limit=50`],
    ['rejected (неделя)', api('rejected')],
    ['dangerous (сутки)', `${api('dangerous')}?days=1`],
    ['dangerous (30 суток)', `${api('dangerous')}?days=30`],
    ['feed (первая страница)', api('feed')],
    ['feed (применённые за сутки)', `${api('feed')}?status=APPLIED&days=1`],
    ['bounds (список)', api('bounds')],
    ['strategies', api('strategies')],
    ['compliance', api('compliance')],
    ['stop', api('stop')],
    ['jobs', api('jobs')],
    ['offers (поиск)', `${api('offers')}?q=340100`],
  ];
  const results: Record<string, unknown> = {};
  for (const [name, url] of screens) {
    const r = await get<unknown>(name, url);
    results[name] = r.body;
    assert.equal(r.status, 200, `${name}: ${JSON.stringify(r.body).slice(0, 200)}`);
    assert.ok(r.seconds <= SCREEN_LIMIT_SECONDS, `${name}: ${r.seconds} с при пределе ${SCREEN_LIMIT_SECONDS}`);
    assert.ok(r.bytes <= SCREEN_LIMIT_BYTES, `${name}: ${r.bytes} байт при пределе ${SCREEN_LIMIT_BYTES}`);
  }
  // Страницы — настоящие: итог со всех суток, показано не больше страницы, страница за концом подтянута к последней
  const first = results['decisions (первая страница)'] as { items: unknown[]; page: { total: number; to: number } };
  const last = results['decisions (страница за концом списка)'] as { items: unknown[]; page: { total: number; to: number; hasNext: boolean } };
  assert.ok(first.page.total >= MIN_DECISIONS && first.items.length <= 50, `страница решений: ${first.items.length} из ${first.page.total}`);
  assert.deepEqual([last.page.total, last.page.to, last.page.hasNext], [first.page.total, first.page.total, false], 'страница за концом — последняя');
  // Одно решение с объяснением — по идентификатору, не поиском по всем
  const withPrice = (first.items as Array<{ decisionId: string; tone: string }>).find((x) => x.tone !== 'off') ?? (first.items as Array<{ decisionId: string }>)[0]!;
  const trace = await get<{ steps: unknown[] }>('decisions/:id (почему эта цена)', api('decisions', withPrice.decisionId));
  assert.equal(trace.status, 200);
  assert.ok(trace.seconds <= SCREEN_LIMIT_SECONDS && trace.bytes <= SCREEN_LIMIT_BYTES);
  // Лента: счётчики групп — по суткам, страница — не больше 50
  const feed = results['feed (применённые за сутки)'] as { items: unknown[]; counts: { applied: number }; page: { total: number } };
  assert.ok(feed.counts.applied >= 1000 && feed.page.total === feed.counts.applied && feed.items.length <= 50, `лента: ${JSON.stringify({ counts: feed.counts, total: feed.page.total, shown: feed.items.length })}`);
  // Товары: у показанных строк статистика решений есть, и она с сутки
  const products = results['products (первая страница)'] as { rows: Array<{ decisions: number | null }> };
  assert.ok(products.rows.every((r) => r.decisions !== null && r.decisions >= 100), `решений у показанных предложений: ${products.rows.slice(0, 3).map((r) => r.decisions)}`);
});
