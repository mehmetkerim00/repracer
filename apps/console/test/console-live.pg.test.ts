import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { BoundsIndexView, PriceEvidenceResponse, StandToken } from '../src/api-types.ts';
import { DIFF_ROWS_SHOWN, LIST_PAGE_DEFAULT, type BoundsDiffView, type CostImportView, type ProductListView, type StopPlan, type StopView, type StrategyListView, type StrategyPreviewView } from '@repracer/console-model';
import { STAND_AUDIENCE, STAND_ISSUER, type LiveWorld } from '@repracer/contract-tests/stand';
import { createAuthenticator, MemoryIdentityDirectory, staticJwks } from '@repracer/identity';
import { createTestIssuer } from '@repracer/identity/test-issuer';
import { inTenant, seedPricingWorld, PgPricingStore, type PgPool, type SeededPricingWorld } from '@repracer/pricing-store-pg';
import { createPricingPipeline, type MemorySeedScope } from '@repracer/pricing-pipeline';
import { KAUFLAND_DESCRIPTOR } from '@repracer/kaufland-adapter';
import { createIsolatedDatabase, type IsolatedDatabase } from '../../../packages/pricing-store-pg/test/isolated-db.ts';
import { createStandApi, createStandServer } from '../server/stand-server.ts';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

/**
 * Р-136 (шаг 29): живой прогон ВСЕХ операций продавца ЧЕРЕЗ КОНСОЛЬ на объёме целевого клиента — 10 000 офферов. Не вызов
 * хранилища: те же HTTP-запросы, которыми ходит браузер, с теми же телами и тем же разбором ответа. Шаг 28 показал, зачем это
 * нужно: импорт себестоимости не проходил через консоль (тело запроса 64 КиБ ≈ 2 180 строк), а живой прогон этого не видел,
 * потому что звал хранилище напрямую. Утверждается наблюдаемое: что продавец получает и сколько это стоит. Данные синтетические.
 */

const TENANT = '10000000-0000-4000-8000-000000000291';
const ACCOUNT = '20000000-0000-4000-8000-000000000291';
/** Каталог целевого клиента: столько офферов у продавца, ради которого написан импорт [Р-134] */
const OFFERS = 10_000;
/** Предел ответа, после которого экран продавца в браузере перестаёт быть полезным: 8 МБ — уже минуты разбора и прокрутки */
const RESPONSE_LIMIT_BYTES = 8 * 1024 * 1024;
/** Предел ожидания живого экрана: дольше — продавец считает, что консоль зависла */
const SCREEN_LIMIT_SECONDS = 10;

let db: IsolatedDatabase;
let pool: PgPool;
let admin: PgPool;
let world: SeededPricingWorld;
let handle: ReturnType<typeof createStandApi>;
let server: Server;
let origin: string;
let owner: { authorization: string; cookie: string };
const measured: Array<{ operation: string; seconds: number; bytes: number; status: number; note: string }> = [];

function scope(n: number): MemorySeedScope {
  return {
    writeScopeId: `ws-${n}`, productId: `prod-${n}`, channelAccountId: ACCOUNT, marketplace: 'de', externalUnitId: `SKU-${n}`,
    channelProductRef: `3729${String(n).padStart(6, '0')}`, condition: 'new', currency: 'EUR', basis: 'GROSS', pricingMode: 'OFF', strategy: null,
    currentPriceMinor: 1900, minPrice: { amountMinor: 1000, id: `min-${n}` }, maxPrice: { amountMinor: 9000, id: `max-${n}` },
  };
}

const WORLD_ID = 'live/console/10k';
const api = (screen: string, param?: string, query = '') => `/api/worlds/${encodeURIComponent(WORLD_ID)}/${screen}${param ? `/${param}` : ''}${query}`;

/**
 * Один запрос браузера с замером: сколько ждал продавец и сколько байт приехало на экран. Запрос идёт ЧЕРЕЗ НАСТОЯЩИЙ HTTP-сервер
 * стенда — с пределом тела, разбором JSON и кодами ответа [Р-136]: вызов обработчика напрямую не увидел бы ни 413, ни битого JSON,
 * а именно на этом шаг 28 и споткнулся (ревью шага 29, находка 1).
 */
async function call(method: 'GET' | 'POST', url: string, body?: unknown): Promise<{ status: number; text: string; requestBytes: number }> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const r = await fetch(`${origin}${url}`, {
    method,
    headers: { ...owner.authorization ? { authorization: owner.authorization } : {}, cookie: owner.cookie, ...(payload ? { 'content-type': 'application/json' } : {}) },
    ...(payload === undefined ? {} : { body: payload }),
  });
  return { status: r.status, text: await r.text(), requestBytes: payload === undefined ? 0 : Buffer.byteLength(payload, 'utf8') };
}

async function measure<T>(operation: string, method: 'GET' | 'POST', url: string, body?: unknown, note = ''): Promise<{ status: number; body: T; seconds: number; bytes: number }> {
  const started = process.hrtime.bigint();
  const r = await call(method, url, body);
  const seconds = Math.round(Number(process.hrtime.bigint() - started) / 1e6) / 1000;
  const parsed = (() => { try { return JSON.parse(r.text) as T; } catch { return null as unknown as T; } })();
  measured.push({ operation, seconds, bytes: Buffer.byteLength(r.text, 'utf8'), status: r.status, note: note || (r.requestBytes > 0 ? `запрос ${Math.round(r.requestBytes / 1024)} КБ` : '') });
  return { status: r.status, body: parsed, seconds, bytes: Buffer.byteLength(r.text, 'utf8') };
}

before(async () => {
  db = await createIsolatedDatabase('consolelive');
  pool = db.pool('svc_app', 4);
  admin = db.pool('svc_admin', 4);
  world = await seedPricingWorld(pool, {
    provisioningPool: db.pool('svc_provisioning', 1), adminPool: admin, fixtureTenantId: TENANT, fixtureChannelAccountId: ACCOUNT,
    marketplaces: ['de'], clock: new Date().toISOString(),
    seed: { scopes: Array.from({ length: OFFERS }, (_, i) => scope(i + 1)) },
  });
  const store = new PgPricingStore(pool, { adminPool: admin });
  const now = new Date().toISOString();
  // Канал в этом прогоне не трогается: остановки и стратегии идут в базу. Любой вызов адаптера — ошибка прогона, а не тишина
  const channel = new Proxy({ descriptor: KAUFLAND_DESCRIPTOR } as Record<string, unknown>, {
    get: (target, key) => (key in target ? target[key as string] : () => { throw new Error(`живой прогон консоли обратился к каналу: ${String(key)}`); }),
  }) as never;
  const pipeline = createPricingPipeline({ store: store as never, adapter: channel, alerts: { raise: async () => undefined }, logger: { log: () => undefined }, now: () => now as never });
  // Мир консоли поверх засеянной базы: тот же путь, что у стенда, но каталог — целевого размера
  const live: LiveWorld = {
    id: WORLD_ID, title: 'Каталог целевого клиента', description: '10 000 предложений одного аккаунта', tenantId: world.tenantId,
    accounts: [{ channelAccountId: world.channelAccountId, channel: 'KAUFLAND', marketplaces: ['de'], haltRelease: 'SAMPLE' }],
    identityTenantId: world.tenantId, membershipAlias: (id) => id, failures: [],
    store: store as never, pipeline: pipeline as never, clock: { iso: () => now, nowMs: () => Date.parse(now) } as never,
    callContext: (channelAccountId) => ({
      tenantId: world.tenantId as never, channelAccountId: channelAccountId as never, correlationId: 'console-live', deadline: now,
    }),
    view: async (viewer) => ({
      id: WORLD_ID, title: 'Каталог целевого клиента', description: '10 000 предложений одного аккаунта', tenantId: world.tenantId,
      now, accounts: [{ channelAccountId: world.channelAccountId, channel: 'KAUFLAND', marketplaces: ['de'], haltRelease: 'SAMPLE' }],
      viewer: { ...viewer }, state: await store.readConsoleState(world.tenantId, now as never),
    }) as never,
  };
  // Вход: пользователь и членство — настоящие, из засеянной базы; поставщик identity — имитатор стенда [Р-78]
  const directory = new MemoryIdentityDirectory();
  directory.link({ issuer: STAND_ISSUER, subject: 'live-owner' }, world.userId);
  directory.addMembership(world.userId, { tenantId: world.tenantId, membershipId: world.ownerMembershipId, role: 'OWNER' });
  const issuer = createTestIssuer({ issuer: STAND_ISSUER, audience: STAND_AUDIENCE });
  handle = createStandApi([live], {
    authenticator: createAuthenticator({ issuer: STAND_ISSUER, audience: STAND_AUDIENCE, jwks: staticJwks(issuer.jwks), directory }),
    simulator: { token: () => issuer.token('live-owner', { email: 'owner@example.invalid' }), expiresInSeconds: 900 },
  });
  server = createStandServer(handle);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  owner = { authorization: '', cookie: 'repracer_locale=de' };
  const token = await call('POST', '/api/stand-issuer/token?locale=de', { role: 'OWNER' });
  assert.equal(token.status, 200, token.text);
  owner = { authorization: `Bearer ${(JSON.parse(token.text) as StandToken).accessToken}`, cookie: 'repracer_locale=de' };
});

after(async () => {
  console.log(JSON.stringify({ offers: OFFERS, operations: measured }, null, 1));
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await db.drop();
});

test('Р-136: список товаров и список границ — экраны, с которых продавец начинает', async () => {
  const products = await measure<ProductListView>('products (список товаров)', 'GET', api('products'));
  assert.equal(products.status, 200);
  // Р-136: экран отдаёт страницу, а итоги считает по всему каталогу — иначе «включено 3 из 50» вместо «3 из 10 000»
  assert.equal(products.body.rows.length, LIST_PAGE_DEFAULT, 'показана страница, а не весь каталог');
  assert.equal(products.body.totals.total, OFFERS, 'итоги — по всему каталогу');
  assert.deepEqual([products.body.page.from, products.body.page.to, products.body.page.total, products.body.page.hasNext], [1, LIST_PAGE_DEFAULT, OFFERS, true]);
  const second = await measure<ProductListView>('products (вторая страница)', 'GET', api('products', undefined, `?offset=${LIST_PAGE_DEFAULT}`));
  assert.equal(second.body.page.from, LIST_PAGE_DEFAULT + 1, 'вторая страница начинается там, где кончилась первая');
  assert.notDeepEqual(second.body.rows[0]!.unit.writeScopeId, products.body.rows[0]!.unit.writeScopeId);
  const tooBig = await call('GET', api('products', undefined, '?limit=5000'));
  assert.equal(tooBig.status, 400, 'страница больше предела — отказ, а не молчаливая выдача каталога');
  const bounds = await measure<BoundsIndexView>('bounds (список границ)', 'GET', api('bounds'));
  assert.equal(bounds.status, 200);
  assert.equal(bounds.body.items.length, LIST_PAGE_DEFAULT);
  assert.equal(bounds.body.page.total, OFFERS);
});

test('Р-136: остальные экраны продавца — лента, решения, отчёт об опасных изменениях, комплаенс', async () => {
  const feed = await measure('feed (лента цен, первая страница)', 'GET', api('feed'));
  assert.equal(feed.status, 200, JSON.stringify(feed.body).slice(0, 200));
  const decisions = await measure('decisions (список решений)', 'GET', api('decisions'));
  assert.equal(decisions.status, 200, JSON.stringify(decisions.body).slice(0, 200));
  const dangerous = await measure('dangerous (опасные изменения за 7 суток)', 'GET', api('dangerous', undefined, '?days=7'));
  assert.equal(dangerous.status, 200, JSON.stringify(dangerous.body).slice(0, 200));
  const compliance = await measure('compliance (проверка Omnibus по каталогу)', 'GET', api('compliance'));
  assert.equal(compliance.status, 200, JSON.stringify(compliance.body).slice(0, 200));
  const stop = await measure('stop (экран остановок)', 'GET', api('stop'));
  assert.equal(stop.status, 200, JSON.stringify(stop.body).slice(0, 200));
});

test('Р-136: импорт себестоимости целого каталога — файл продавца через HTTP', async () => {
  const lines = ['Artikelnummer;Einstandspreis;Währung', ...Array.from({ length: OFFERS }, (_, i) => `SKU-${i + 1};${9 + (i % 40)},${String(i % 100).padStart(2, '0')};EUR`)];
  const content = Buffer.from(lines.join('\r\n'), 'utf8').toString('base64');
  const file = { fileName: 'kosten.csv', content };
  const plan = await measure<CostImportView>('cost-import/plan (предпросмотр 10 000 строк)', 'POST', api('cost-import', 'plan'), file,
    `файл ${Math.round(Buffer.byteLength(content) / 1024)} КБ в base64`);
  assert.equal(plan.status, 200, JSON.stringify(plan.body).slice(0, 300));
  assert.equal(plan.body.summary.apply, OFFERS);
  const applied = await measure('cost-import/apply (применение 10 000 строк)', 'POST', api('cost-import', 'apply'), { ...file, fingerprint: plan.body.fingerprint, confirmed: true });
  assert.equal(applied.status, 200, JSON.stringify(applied.body).slice(0, 300));
});

test('Р-136: массовая правка границ всего каталога', async () => {
  const ids = Array.from({ length: OFFERS }, (_, i) => world.ids.dbId(`ws-${i + 1}`));
  const request = (writeScopeIds: readonly string[]) => ({ request: { writeScopeIds, min: { kind: 'PERCENT', bp: 500 } } });
  // Каталог выбирается флагом, а не списком: перечисление 10 000 идентификаторов — 381 КБ и отказ 413 (ревью шага 29, находка 1)
  const all = { request: { all: true, min: { kind: 'PERCENT', bp: 500 } } };
  const listed = await measure('bounds/plan (каталог списком идентификаторов)', 'POST', api('bounds', 'plan'), request(ids));
  assert.equal(listed.status, 413, 'перечислять каталог в теле запроса нельзя — и это видно продавцу как отказ, а не как успех');
  const whole = await measure<BoundsDiffView>('bounds/plan (весь каталог, 10 000)', 'POST', api('bounds', 'plan'), all);
  // Сколько стоит одна разрешённая порция — это и есть цена правки каталога по частям
  assert.equal(whole.status, 200, `правка всего каталога отвергнута: ${JSON.stringify(whole.body).slice(0, 200)}`);
  const appliedAll = await measure('bounds/apply (весь каталог, 10 000)', 'POST', api('bounds', 'apply'),
    { ...all, planToken: whole.body.planToken, confirmed: true });
  assert.equal(appliedAll.status, 200, JSON.stringify(appliedAll.body).slice(0, 300));
  // Сколько стоит одна порция — это цена правки частями, если продавец выбрал не весь каталог
  const batch = await measure<BoundsDiffView>('bounds/plan (порция, 500)', 'POST', api('bounds', 'plan'), request(ids.slice(0, 500)));
  assert.equal(batch.status, 200, JSON.stringify(batch.body).slice(0, 300));
  const applied = await measure('bounds/apply (порция, 500)', 'POST', api('bounds', 'apply'),
    { ...request(ids.slice(0, 500)), planToken: batch.body.planToken, confirmed: true });
  assert.equal(applied.status, 200, JSON.stringify(applied.body).slice(0, 300));
  // Экран различий показывает первые строки и итог по всем — иначе ответ на каталог был 4,2 МБ
  assert.equal(whole.body.rows.length, DIFF_ROWS_SHOWN);
  assert.deepEqual([whole.body.shown.rows, whole.body.shown.of, whole.body.summary.scopes], [DIFF_ROWS_SHOWN, OFFERS, OFFERS]);
});

test('Р-136: стратегия — предпросмотр, включение на каталог и снятие', async () => {
  const scopeIds = Array.from({ length: OFFERS }, (_, i) => world.ids.dbId(`ws-${i + 1}`));
  const draft = { name: 'Каталог целевого клиента', params: { type: 'FIXED', priceMinor: 1500 } };
  const listed = await measure('strategies/preview (каталог списком идентификаторов)', 'POST', api('strategies', 'preview'), { draft, writeScopeIds: scopeIds });
  assert.equal(listed.status, 413, 'перечисление каталога в теле запроса не проходит — стратегия выбирается флагом «все»');
  const whole = await measure<StrategyPreviewView>('strategies/preview (весь каталог, 10 000)', 'POST', api('strategies', 'preview'), { draft, all: true });
  assert.equal(whole.status, 200, `стратегия на весь каталог отвергнута: ${JSON.stringify(whole.body).slice(0, 200)}`);
  // Р-136, Р-125: предпросмотр — по выборке, и это сказано на экране; назначается стратегия на все выбранные предложения
  assert.equal(whole.body.rows.length, 500, 'предпросмотр считает выборку, а не весь каталог');
  assert.deepEqual([whole.body.sample.shown, whole.body.sample.total], [500, OFFERS]);
  assert.match(whole.body.sample.text ?? '', /500 von 10000/);
  const assignedAll = await measure<{ strategies: StrategyListView }>('strategies (назначение на весь каталог, 10 000)', 'POST', api('strategies'),
    { draft, all: true, previewToken: whole.body.previewToken, confirmed: true });
  assert.equal(assignedAll.status, 200, JSON.stringify(assignedAll.body).slice(0, 300));
  assert.equal(assignedAll.body.strategies.page.total, OFFERS, 'ответ на запись — страница экрана, а не весь каталог');
  assert.equal(assignedAll.body.strategies.strategies[0]!.scopeCount, OFFERS, 'стратегия назначена всем предложениям каталога');

  // Цена работы по частям: предпросмотр и назначение на порцию — то, что делает продавец, выбравший часть каталога
  const batchIds = scopeIds.slice(0, 200);
  const batch = await measure<StrategyPreviewView>('strategies/preview (порция, 200)', 'POST', api('strategies', 'preview'), { draft, writeScopeIds: batchIds });
  assert.equal(batch.status, 200, JSON.stringify(batch.body).slice(0, 300));
  const unassigned = await measure('strategies/unassign (снятие, 200)', 'POST', api('strategies', 'unassign'), { writeScopeIds: batchIds, confirmed: true });
  assert.equal(unassigned.status, 200, JSON.stringify(unassigned.body).slice(0, 300));
});

test('Р-136: kill switch и снятие остановки', async () => {
  const plan = await measure<StopPlan>('stop/plan (предупреждение о последствиях)', 'POST', api('stop', 'plan'), { target: { kind: 'TENANT' } });
  assert.equal(plan.status, 200, JSON.stringify(plan.body).slice(0, 300));
  const stopped = await measure<{ stop: StopView }>('stop (остановка всех цен)', 'POST', api('stop'),
    { target: { kind: 'TENANT' }, note: 'живой прогон каталога', confirmed: true });
  assert.equal(stopped.status, 200, JSON.stringify(stopped.body).slice(0, 300));
  const stopId = stopped.body.stop.stops.active[0]?.stopId;
  assert.ok(stopId, 'остановка видна на экране');
  const resumed = await measure('stops/:id/resume (снятие остановки)', 'POST', api('stops', `${stopId}/resume`), { note: 'живой прогон', confirmed: true });
  assert.equal(resumed.status, 200, JSON.stringify(resumed.body).slice(0, 300));
});

test('Р-136: экспорт доказательной истории цен за 30 суток по всему каталогу', async () => {
  // Суточная свёртка цен [Р-21] за 30 суток по каждому предложению: 300 000 строк — столько истории у клиента через месяц работы
  const seeded = process.hrtime.bigint();
  // Суточную свёртку пишет роль планировщика (закрытие суток), а не административный сервис — посев идёт от неё
  const scheduler = db.pool('svc_scheduler', 1);
  await inTenant(scheduler, world.tenantId, async (tx) => {
    await tx.query(
      `INSERT INTO tenant_data.price_daily (tenant_id, write_scope_id, price_type, price_day, currency, price_basis,
                                            day_tz, min_amount_minor, max_amount_minor, first_amount_minor, first_accepted_at,
                                            last_amount_minor, last_accepted_at, change_count, min_floor_minor)
       SELECT $1, s.write_scope_id, 'REGULAR', d::date, s.currency, s.price_basis, 'Europe/Berlin',
              1800, 2000, 1900, d + interval '8 hours', 1950, d + interval '20 hours', 2, 1000
         FROM tenant_data.write_scope s
         CROSS JOIN generate_series((now() - interval '30 days')::date, (now() - interval '1 day')::date, interval '1 day') AS d
        WHERE s.tenant_id = $1 AND s.field = 'PRICE'`, [world.tenantId]);
  });
  const [count] = await inTenant(admin, world.tenantId, async (tx) => (await tx.query('SELECT count(*)::int AS n FROM tenant_data.price_daily')).rows);
  measured.push({ operation: 'посев истории цен (30 суток × каталог)', seconds: Math.round(Number(process.hrtime.bigint() - seeded) / 1e6) / 1000, bytes: 0, status: 0, note: `${count.n} суток цен` });
  const to = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const from = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  // Каталог целиком за 30 суток — 300 000 строк: выгрузка отказывает и говорит, что делать [Р-136]
  const whole = await measure<PriceEvidenceResponse>('compliance/evidence (30 суток, весь каталог)', 'GET', api('compliance', 'evidence', `?from=${from}&to=${to}`),
    undefined, `${count.n} суток цен в базе`);
  assert.equal(whole.status, 400, 'выгрузка каталога целиком не отдаётся молча');
  assert.match(JSON.stringify(whole.body), /300000/, 'в отказе названо, сколько строк получилось');
  // Доказательство нужно по предложению — так им и пользуются в споре
  const oneOffer = world.ids.dbId('ws-1');
  const single = await measure<PriceEvidenceResponse>('compliance/evidence (30 суток, одно предложение)', 'GET',
    api('compliance', 'evidence', `?from=${from}&to=${to}&writeScopeId=${oneOffer}`));
  assert.equal(single.status, 200, JSON.stringify(single.body).slice(0, 300));
  assert.equal(single.body.days, 30, 'в выгрузке 30 суток истории одного предложения');
});

test('Р-136: ни одна операция консоли не выходит за пределы живого экрана', () => {
  // Пределы — про ЗАПРОСЫ продавца. Посев данных прогона (status 0) в них не входит: это подготовка, а не экран
  const requests = measured.filter((x) => x.status > 0);
  assert.ok(requests.length >= 20, `замерены все операции продавца: ${requests.length}`);
  const slow = requests.filter((x) => x.seconds > SCREEN_LIMIT_SECONDS);
  const heavy = requests.filter((x) => x.bytes > RESPONSE_LIMIT_BYTES);
  assert.deepEqual(slow.map((x) => `${x.operation}: ${x.seconds} с`), [], 'экран отвечает за разумное время');
  assert.deepEqual(heavy.map((x) => `${x.operation}: ${Math.round(x.bytes / 1024)} КБ`), [], 'ответ экрана помещается в браузер');
});
