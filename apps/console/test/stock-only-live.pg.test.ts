import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { JobCreatedResponse, StandToken } from '../src/api-types.ts';
import type { BulkJobView, ConnectionsView, OnboardingView, StockDivergencesView, StockReturnsView, StockView } from '@repracer/console-model';
import { STAND_AUDIENCE, STAND_ISSUER, type LiveWorld } from '@repracer/contract-tests/stand';
import { demoWorld, nextNineUtc, DEMO_OFFERS, type DemoWorld } from '@repracer/contract-tests/live';
import { createAuthenticator, MemoryIdentityDirectory, staticJwks } from '@repracer/identity';
import { createTestIssuer } from '@repracer/identity/test-issuer';
import { PgChannelConnectStore, PgPricingStore, PgStockStore, type PgPool } from '@repracer/pricing-store-pg';
import { createStockPipeline, type StockPipeline } from '@repracer/stock-sync';
import { createIsolatedDatabase, type IsolatedDatabase } from '../../../packages/pricing-store-pg/test/isolated-db.ts';
import { createStandApi, createStandServer } from '../server/stand-server.ts';
import type { BulkWorkerConfig } from '../server/bulk-worker.ts';
import { connectionsOnly } from './quantity-writes.ts';

/**
 * Р-152 (шаг 35): путь «только остатки» живым прогоном через консоль как браузер [Р-136, Р-142] — от пустого пути до
 * записи остатка, ПОДТВЕРЖДЁННОЙ каналом (симулятор Kaufland шага 21), без единого ввода себестоимости и без единого
 * упоминания стратегий на пути. Второй источник — Inbound API: ключ, устаревшее значение, распространение в канал.
 * Данные синтетические.
 */

const WORLD = 'demo/kaufland';
const LEASE_SECONDS = 5;
const APPLY_LIMIT_SECONDS = 120;
/** Срок ответа экрана [шаг 29]: столько же отводится и партии Inbound API предельного размера (находка 10 ревью шага 36) */
const INBOUND_ORDERS_LIMIT_SECONDS = 10;

let db: IsolatedDatabase;
let demo: DemoWorld;
let server: Server;
let origin: string;
let owner: { authorization: string; cookie: string };
let observer: PgPool;
const workers: ChildProcess[] = [];
let workerConfigPath = '';
/** Сколько запросов сделал продавец и сколько прошло времени — ответ на «сколько шагов и минут до работающей синхронизации» */
const journey: Array<{ step: string; method: string; url: string; seconds: number; status: number }> = [];
let journeyStart = 0;
/** Ключ Inbound API, выданный вторым тестом: третий шлёт им остаток единицы, которой в канале уже нет */
let inboundKey = '';
/**
 * Хранилище остатков мира. Заказ канала приходит НЕ от продавца: его приносит работа `order-lines` планировщика тем же
 * вызовом `recordOrderLines` (packages/stock-sync/src/pipeline.ts). Здесь им подставляется заказ, которого модель канала
 * сама не создаёт (мир этого прогона — пустой, без спроса); всё, что делает продавец и его склад, идёт по HTTP.
 */
let stockStore: PgStockStore;
/** Шаг 59 [Р-199]: конвейер мира — им прогон делает то, что после заказа делает работа `order-lines` (пересчёт и запись) */
let worldStockPipeline: StockPipeline;
/** Шаг 59 [Р-199]: наблюдатель тенанта — видит возвраты, но не решает (403 у консоли) */
let viewerAuth: { authorization: string; cookie: string };
/** Шаг 60 [Р-202]: администратор тенанта — управляет подключениями, но запись количества подтверждает только владелец (база) */
let adminAuth: { authorization: string; cookie: string };

const api = (screen: string, param?: string) => `/api/worlds/${encodeURIComponent(WORLD)}/${screen}${param ? `/${param}` : ''}`;

async function call(method: 'GET' | 'POST', url: string, body?: unknown, auth = owner): Promise<{ status: number; text: string }> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const r = await fetch(`${origin}${url}`, { method, headers: { ...(auth.authorization ? { authorization: auth.authorization } : {}), cookie: auth.cookie, ...(payload ? { 'content-type': 'application/json' } : {}) }, ...(payload === undefined ? {} : { body: payload }) });
  return { status: r.status, text: await r.text() };
}

async function step<T>(name: string, method: 'GET' | 'POST', url: string, body?: unknown): Promise<{ status: number; body: T }> {
  const started = process.hrtime.bigint();
  const r = await call(method, url, body);
  journey.push({ step: name, method, url, seconds: Math.round(Number(process.hrtime.bigint() - started) / 1e6) / 1000, status: r.status });
  return { status: r.status, body: (r.text ? JSON.parse(r.text) : null) as T };
}

async function pollJob(jobId: string): Promise<BulkJobView> {
  const deadline = Date.now() + APPLY_LIMIT_SECONDS * 1000;
  for (;;) {
    const r = await call('GET', api('jobs', jobId));
    assert.equal(r.status, 200, r.text);
    const job = JSON.parse(r.text) as BulkJobView;
    if (job.status === 'SUCCEEDED' || job.status === 'FAILED') return job;
    if (Date.now() > deadline) throw new Error(`bulk job ${jobId} stayed ${job.status}/${job.headline}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const NO_PRICING_WORDS = /Strateg|Selbstkosten|Einstandspreis|Grenzen|Repricing|Preisregel|min_price|max_price/;

before(async () => {
  db = await createIsolatedDatabase('stockonly');
  const appPool: PgPool = db.pool('svc_app', 4);
  const adminPool: PgPool = db.pool('svc_admin', 4);
  // Ближайшие 09:00 UTC после текущего момента: граница суток пересекается всегда, а мир не уходит от часов базы дальше суток
  const startIso = nextNineUtc();
  // bare: true — предложения как пришли с канала; ни себестоимости, ни границ, ни стратегий здесь не появится
  demo = await demoWorld({
    tag: 3502, startIso, bare: true, appPool, adminPool, provisioningPool: db.pool('svc_provisioning', 1), dispatcherPool: db.pool('svc_dispatcher', 2),
    schedulerPool: db.pool('svc_scheduler', 3), exporterPool: db.pool('svc_exporter', 2), stockPool: db.pool('svc_stock', 2),
  });
  const seeded = demo.live.seeded;
  const store = new PgPricingStore(appPool, { adminPool, bulkWorkerPool: db.pool('svc_bulk_worker', 2) });
  const stock = new PgStockStore({ adminPool, stockPool: db.pool('svc_stock', 2) });
  stockStore = stock;
  // Записи остатка отправляет диспетчер мира — тот же, что отправляет цены [Р-64]
  const stockPipeline = createStockPipeline({ store: stock, now: () => demo.clock.iso() as never, sleep: demo.clock.sleep, dispatchScope: (t, ws) => demo.live.dispatchScope(t, ws) });
  worldStockPipeline = stockPipeline;
  const nowIso = () => demo.clock.iso();
  const accounts = [{ channelAccountId: seeded.channelAccountId, channel: 'KAUFLAND', marketplaces: ['de'], haltRelease: 'SAMPLE' as const }];
  const live: LiveWorld = {
    id: WORLD, title: 'Демо: Kaufland на симуляторе', description: `${DEMO_OFFERS} предложений`, tenantId: seeded.tenantId,
    accounts, identityTenantId: seeded.tenantId, membershipAlias: (id) => id, failures: [],
    store: store as never, stock, stockPipeline, pipeline: demo.live.pipelineForDbIds() as never, clock: { iso: nowIso, nowMs: () => demo.clock.nowMs() } as never,
    callContext: (channelAccountId) => ({ tenantId: seeded.tenantId as never, channelAccountId: channelAccountId as never, correlationId: 'stock-only-live', deadline: nowIso() }),
    view: async (viewer) => ({
      id: WORLD, title: 'Демо: Kaufland на симуляторе', description: `${DEMO_OFFERS} предложений`, tenantId: seeded.tenantId, now: nowIso(),
      accounts, viewer: { ...viewer }, state: await store.readConsoleState(seeded.tenantId, nowIso() as never),
    }) as never,
  };
  const directory = new MemoryIdentityDirectory();
  directory.link({ issuer: STAND_ISSUER, subject: 'demo-owner' }, seeded.userId);
  directory.addMembership(seeded.userId, { tenantId: seeded.tenantId, membershipId: seeded.ownerMembershipId, role: 'OWNER' });
  // Шаг 59 [Р-199]: наблюдатель — синтетический пользователь стенда; 403 ему отвечает консоль, до базы
  const viewerUser = '1d000000-0000-4000-8000-000000000199';
  directory.link({ issuer: STAND_ISSUER, subject: 'demo-viewer' }, viewerUser);
  directory.addMembership(viewerUser, { tenantId: seeded.tenantId, membershipId: '1e000000-0000-4000-8000-000000000199', role: 'VIEWER' });
  /**
   * Шаг 60 [Р-202]: администратор — настоящий участник тенанта в базе (как агентство шага 45, вставкой суперпользователя в мир
   * прогона): консоль пропускает его к подтверждению записи количества, и отказ «только владелец» даёт база своим стражем
   */
  const adminUser = '1d000000-0000-4000-8000-000000000198';
  const adminMembership = '1e000000-0000-4000-8000-000000000198';
  await db.superuser(`
    SET session_replication_role = replica;
    INSERT INTO platform.app_user (user_id, email) VALUES ('${adminUser}', 'admin@example.invalid');
    INSERT INTO tenant_data.membership (tenant_id, membership_id, user_id, role, status) VALUES ('${seeded.tenantId}', '${adminMembership}', '${adminUser}', 'ADMIN', 'ACTIVE');
    SET session_replication_role = origin;`);
  directory.link({ issuer: STAND_ISSUER, subject: 'demo-admin' }, adminUser);
  directory.addMembership(adminUser, { tenantId: seeded.tenantId, membershipId: adminMembership, role: 'ADMIN' });
  const issuer = createTestIssuer({ issuer: STAND_ISSUER, audience: STAND_AUDIENCE });
  /**
   * Мир-приманка на ТОЙ ЖЕ базе и с тем же хранилищем остатков, но другого тенанта — и первым в списке. Его хранилище
   * находит ключ Inbound API настоящего тенанта (поиск идёт до контекста тенанта); сервер обязан отдать запись миру
   * ТЕНАНТА КЛЮЧА, а не первому нашедшему (находка 5 ревью шага 35). Тест Inbound API ниже зеленеет только так.
   */
  const decoy: LiveWorld = { ...live, id: 'demo/decoy', title: 'Приманка', tenantId: '10000000-0000-4000-8000-00000000d3c0' };
  const handle = createStandApi([decoy, live], {
    authenticator: createAuthenticator({ issuer: STAND_ISSUER, audience: STAND_AUDIENCE, jwks: staticJwks(issuer.jwks), directory }),
    simulator: { token: (account) => issuer.token(account.role === 'VIEWER' ? 'demo-viewer' : account.role === 'ADMIN' ? 'demo-admin' : 'demo-owner', { email: 'owner@example.invalid', amr: ['pwd', 'otp'] }), expiresInSeconds: 3600 },
  }, {
    // Шаг 60 [Р-202]: экран подключений мира — аккаунты из базы тем же хранилищем, что в работе; подключать новые каналы нечем
    connect: (worldId) => (worldId === WORLD ? connectionsOnly(new PgChannelConnectStore(adminPool)) : null),
  });
  server = createStandServer(handle);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const token = await fetch(`${origin}/api/stand-issuer/token?locale=de`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: 'OWNER' }) });
  owner = { authorization: `Bearer ${((await token.json()) as StandToken).accessToken}`, cookie: 'repracer_locale=de' };
  const viewerToken = await fetch(`${origin}/api/stand-issuer/token?locale=de`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: 'VIEWER' }) });
  viewerAuth = { authorization: `Bearer ${((await viewerToken.json()) as StandToken).accessToken}`, cookie: 'repracer_locale=de' };
  const adminToken = await fetch(`${origin}/api/stand-issuer/token?locale=de`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: 'ADMIN' }) });
  adminAuth = { authorization: `Bearer ${((await adminToken.json()) as StandToken).accessToken}`, cookie: 'repracer_locale=de' };
  const observerUrl = new URL(process.env.REPRACER_PG_ADMIN_URL!); observerUrl.pathname = `/${db.name}`;
  const { createPool } = await import('@repracer/pricing-store-pg');
  observer = createPool(observerUrl.toString(), { max: 1, applicationName: 'repracer-stock-only-observer' });
  const config: BulkWorkerConfig = {
    pgUrl: db.url('svc_app'), leaseSeconds: LEASE_SECONDS, progressEverySeconds: 1, idleMs: 100,
    worlds: [{ descriptor: { id: WORLD, title: 'Демо', description: '', tenantId: seeded.tenantId, accounts }, now: 'WALL_CLOCK' }],
  };
  workerConfigPath = join(mkdtempSync(join(tmpdir(), 'repracer-stock-only-')), 'worker.json');
  writeFileSync(workerConfigPath, JSON.stringify(config), 'utf8');
  const child = spawn(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', fileURLToPath(new URL('../server/bulk-worker.ts', import.meta.url))],
    { env: { ...process.env, BULK_WORKER_CONFIG: workerConfigPath }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr?.on('data', (chunk: Buffer) => console.error('bulk-worker:', chunk.toString().trim()));
  workers.push(child);
  journeyStart = Date.now();
});

after(async () => {
  console.log(JSON.stringify({ journey, totalSeconds: Math.round((Date.now() - journeyStart) / 100) / 10 }, null, 1));
  for (const child of workers) child.kill('SIGKILL');
  server?.close();
  await observer?.end();
  await db?.drop();
});

test('Р-152: путь «только остатки» — от выбора пути до записи остатка, подтверждённой каналом', async () => {
  // 1. Путь не выбран: экран предлагает два пути, и на нём нет «готово»
  let view = (await step<OnboardingView>('экран пути', 'GET', api('onboarding'))).body;
  assert.deepEqual([view.path, view.choices.map((c) => c.path), view.resumeAt === 'DONE'], [null, ['STOCK', 'STOCK_AND_PRICING'], false]);
  // 2. Выбор — «остатки»
  assert.equal((await step('выбор пути «остатки»', 'POST', api('onboarding', 'path'), { path: 'STOCK' })).status, 200);
  view = (await step<OnboardingView>('экран пути', 'GET', api('onboarding'))).body;
  assert.deepEqual(view.steps.map((s) => s.step), ['TENANT', 'CHANNEL', 'STOCK_SOURCE', 'STOCK_SYNC'], 'на пути остатков четыре шага');
  assert.equal(view.resumeAt, 'STOCK_SOURCE');
  // Ни одного упоминания стратегий, себестоимости и границ — по всему ответу экрана пути, на языке продавца
  assert.ok(!NO_PRICING_WORDS.test(JSON.stringify(view)), `на пути остатков нет слов о ценах: ${JSON.stringify(view).slice(Math.max(0, (JSON.stringify(view).search(NO_PRICING_WORDS)) - 120), (JSON.stringify(view).search(NO_PRICING_WORDS)) + 60)}`);

  // 3. Источник — файл: артикулы канала и количество
  const source = await step<{ stockSourceId: string; apiKey: string | null }>('источник: внутренний пул', 'POST', api('stock', 'sources'), { mode: 'INTERNAL_POOL', name: 'Lager Hamburg' });
  assert.equal(source.status, 200, JSON.stringify(source.body));
  assert.equal(source.body.apiKey, null, 'у файлового источника ключа нет');
  const skus = Array.from({ length: DEMO_OFFERS }, (_, i) => String(340_100_001 + i).slice(-6));
  const csv = ['Artikelnummer;Bestand', ...skus.map((sku, i) => `${sku};${10 + (i % 7)}`), 'nicht-da;5'].join('\r\n');
  const created = await step<JobCreatedResponse>('файл остатков (задание)', 'POST', api('stock', 'import'), { fileName: 'bestand.csv', content: Buffer.from(csv, 'utf8').toString('base64'), stockSourceId: source.body.stockSourceId });
  assert.equal(created.status, 200, JSON.stringify(created.body).slice(0, 300));
  const imported = await pollJob(created.body.jobId);
  assert.equal(imported.status, 'SUCCEEDED', imported.error ?? imported.headline);
  const importView = (imported.result as { view: { matched: number; changed: number; unmatched: number; writes: number } }).view;
  assert.deepEqual([importView.matched, importView.changed, importView.unmatched, importView.writes], [DEMO_OFFERS, DEMO_OFFERS, 1, 0], 'все 200 строк применены, одна не найдена; записей ещё нет — синхронизация не включена');
  view = (await step<OnboardingView>('экран пути', 'GET', api('onboarding'))).body;
  assert.equal(view.resumeAt, 'STOCK_SYNC', `источник отдал остаток — дальше синхронизация: ${view.resumeText}`);

  // 4. Ловушка канала названа ДО включения; включение с буфером 2
  let stockScreen = (await step<StockView>('экран остатков', 'GET', api('stock'))).body;
  assert.ok(stockScreen.traps.some((t) => t.channel === 'KAUFLAND' && /id_offer/.test(t.text)), 'ловушка Kaufland названа до записи');
  assert.deepEqual([stockScreen.summary.products, stockScreen.summary.withStock, stockScreen.summary.synced], [DEMO_OFFERS, DEMO_OFFERS, 0]);

  /**
   * Шаг 60 [Р-202]: запись количества выключена, пока владелец не подтвердил на экране подключений, что другие инструменты
   * количество в этом канале не ведут. Путь продавца: отказ включения с объяснением → экран подключений → ответ → подтверждение
   */
  const accountId = demo.live.seeded.channelAccountId;
  const enableBody = { channelAccountId: accountId, bufferUnits: 2, maxQuantity: null, minQuantityToList: 0 };
  type Failure = { error: { code: string; message: string } };
  const notConfirmed = await step<Failure>('включение до подтверждения записи количества', 'POST', api('stock', 'enable'), enableBody);
  assert.deepEqual([notConfirmed.status, notConfirmed.body.error.code], [409, 'QUANTITY_WRITES_NOT_CONFIRMED'], JSON.stringify(notConfirmed.body));
  assert.match(notConfirmed.body.error.message, /Kanalverbindungen/, 'отказ отправляет на экран подключений');
  const connectionsOf = async (name: string) => {
    const screen = await step<ConnectionsView>(name, 'GET', api('connections'));
    assert.equal(screen.status, 200, JSON.stringify(screen.body).slice(0, 300));
    return screen.body.accounts.find((a) => a.channelAccountId === accountId)!;
  };
  let connection = await connectionsOf('экран подключений: вопрос о других инструментах');
  assert.deepEqual([connection.otherTools.answer, connection.otherTools.question, connection.quantityWrites.confirmed, connection.quantityWrites.canConfirm, connection.externalEdits24h],
    [null, 'Aktualisiert ein anderes Tool Bestände oder Preise in diesem Kanal?', false, false, 0], 'не отвечено, запись количества выключена, внешних правок нет');
  assert.match(connection.quantityWrites.text, /aus/, connection.quantityWrites.text);
  assert.match(connection.externalEditsText, /: 0$/, connection.externalEditsText);
  const answer = (name: string, value: string, auth = owner) => call('POST', api('connections', 'other-tools'), { channelAccountId: accountId, answer: value }, auth);
  const confirm = (typedConfirmation: string, auth = owner) => call('POST', api('connections', 'quantity-writes'), { channelAccountId: accountId, typedConfirmation }, auth);
  const codeOf = (r: { status: number; text: string }) => [r.status, (JSON.parse(r.text) as Failure).error.code];
  // Без ответа подтверждать нечего; ответ «остатки ведёт другой инструмент» подтверждение запрещает — своей причиной базы
  assert.deepEqual(codeOf(await confirm('irrelevant')), [409, 'ANSWER_FIRST']);
  assert.equal((await answer('остатки', 'STOCK')).status, 200);
  connection = await connectionsOf('экран подключений: остатки ведёт другой инструмент');
  assert.deepEqual([connection.otherTools.answer, connection.quantityWrites.canConfirm, connection.otherTools.warning], ['STOCK', false, null]);
  assert.ok(connection.quantityWrites.blockedText, 'сказано, почему подтвердить нельзя');
  assert.deepEqual(codeOf(await confirm(connection.label)), [409, 'OTHER_TOOL_MANAGES_STOCK']);
  const stockManaged = await step<Failure>('включение при чужом инструменте остатков', 'POST', api('stock', 'enable'), enableBody);
  assert.deepEqual([stockManaged.status, stockManaged.body.error.code], [409, 'QUANTITY_WRITES_NOT_CONFIRMED']);
  assert.notEqual(stockManaged.body.error.message, notConfirmed.body.error.message, 'при чужом инструменте остатков отказ говорит именно это');
  // Цены ведёт другой инструмент — два репрайсера на одном канале: предупреждение на экране подключений
  assert.equal((await answer('цены', 'PRICES')).status, 200);
  connection = await connectionsOf('экран подключений: цены ведёт другой инструмент');
  assert.match(connection.otherTools.warning ?? '', /Zwei Repricer/, 'предупреждение о двух репрайсерах');
  assert.equal(connection.quantityWrites.canConfirm, true, 'чужой инструмент цен запись количества не запрещает');
  assert.equal((await answer('других нет', 'NONE')).status, 200);
  connection = await connectionsOf('экран подключений: других инструментов нет');
  assert.deepEqual([connection.otherTools.answer, connection.otherTools.warning, connection.quantityWrites.canConfirm], ['NONE', null, true]);
  const typed = connection.quantityWrites.typeToConfirm!;
  assert.ok(connection.quantityWrites.confirmationHint!.includes(typed), 'экран показывает, что набрать');
  // Не владелец: наблюдателю отказывает консоль, администратору — база («подтверждает только владелец»)
  assert.deepEqual(codeOf(await confirm(typed, viewerAuth)), [403, 'FORBIDDEN']);
  assert.deepEqual(codeOf(await confirm(typed, adminAuth)), [403, 'NOT_OWNER']);
  assert.equal((await answer('администратор отвечает', 'NONE', adminAuth)).status, 200, 'ответ даёт тот, кто управляет подключениями');
  // Владелец с неверным текстом — отказ; верный — подтверждено, повтор — «уже подтверждено»
  assert.deepEqual(codeOf(await confirm(`${typed}x`)), [400, 'CONFIRMATION_MISMATCH']);
  const confirmedNow = await step<{ confirmed: boolean }>('подтверждение записи количества владельцем', 'POST', api('connections', 'quantity-writes'), { channelAccountId: accountId, typedConfirmation: ` ${typed} ` });
  assert.equal(confirmedNow.status, 200, JSON.stringify(confirmedNow.body));
  assert.deepEqual(codeOf(await confirm(typed)), [409, 'ALREADY_CONFIRMED']);
  // При действующем подтверждении ответ «остатки ведёт другой инструмент» отклоняет база — два писателя не появятся обходом
  assert.deepEqual(codeOf(await answer('остатки после подтверждения', 'STOCK')), [409, 'QUANTITY_WRITES_CONFIRMED']);
  connection = await connectionsOf('экран подключений: запись количества включена');
  assert.deepEqual([connection.quantityWrites.confirmed, connection.quantityWrites.canConfirm, connection.otherTools.answer], [true, false, 'NONE']);
  assert.match(connection.quantityWrites.text, /an —/, connection.quantityWrites.text);
  const [journal] = (await observer.query(`SELECT count(*)::int AS n, min(typed_confirmation) AS typed FROM tenant_data.channel_quantity_writes_confirmation WHERE channel_account_id = $1`, [accountId])).rows;
  assert.deepEqual([journal.n, journal.typed], [1, 'matched'], 'одна строка журнала подтверждения; набранное хранится отметкой');

  const enableJob = await step<JobCreatedResponse>('включение синхронизации (задание)', 'POST', api('stock', 'enable'),
    { channelAccountId: demo.live.seeded.channelAccountId, bufferUnits: 2, maxQuantity: null, minQuantityToList: 0 });
  assert.equal(enableJob.status, 200, JSON.stringify(enableJob.body).slice(0, 300));
  const enabledJob = await pollJob(enableJob.body.jobId);
  assert.equal(enabledJob.status, 'SUCCEEDED', enabledJob.error ?? enabledJob.headline);
  const enabled = (enabledJob.result as { view: { scopes: number; created: number; writes: number } }).view;
  assert.deepEqual([enabled.scopes, enabled.created, enabled.writes], [DEMO_OFFERS, DEMO_OFFERS, DEMO_OFFERS]);
  const syncEnabledAt = Date.now();
  view = (await step<OnboardingView>('экран пути', 'GET', api('onboarding'))).body;
  assert.equal(view.resumeAt, 'DONE', `путь остатков пройден: ${view.resumeText}`);
  assert.ok(!NO_PRICING_WORDS.test(JSON.stringify(view)), 'и пройденный путь — без слов о ценах');

  // 5. Записи уходят в канал диспетчером, канал подтверждает обратным чтением — как у цен. Клиентский бюджет адаптера
  // (25 запросов в секунду, K-04) пропускает не всё сразу: остальное уходит повтором, когда проходит время, — как в жизни
  for (let i = 0; i < 20; i++) { await demo.live.betweenTicks(); demo.clock.advance(30_000); }
  stockScreen = (await step<StockView>('экран остатков после записи', 'GET', api('stock'))).body;
  assert.deepEqual([stockScreen.summary.synced, stockScreen.summary.pendingWrites, stockScreen.summary.diverged], [DEMO_OFFERS, 0, 0], JSON.stringify(stockScreen.summary));
  // Ожидаемое выведено из ФАЙЛА продавца, а не из экрана: строка i несла 10 + i mod 7, буфер 2, заказов на этом пути нет
  const fromFile = new Map(skus.map((sku, i) => [`syn-prod-de-340${sku}`, 10 + (i % 7) - 2]));
  assert.equal(stockScreen.rows.length, 50);
  for (const r of stockScreen.rows) {
    const c = r.channels[0]!;
    assert.equal(c.published, fromFile.get(r.sku), `${r.sku}: публикуемое = количество из файла − буфер`);
    assert.ok(/bestätigt/.test(c.confirmedText) && c.tone === 'ok', `${r.sku}: канал подтвердил: ${c.confirmedText}`);
  }
  // Подтверждение — настоящее: в симуляторе канала у единиц ровно то количество, что мы отправили
  const units = (demo.live.simulator.dump() as { units: Array<{ idUnit: number; amount: number }> }).units;
  // Товар мира — `prod-de-<id товара>`, единица канала — последние шесть цифр того же id; страница экрана — 50 строк, канал — 200
  const allRows = (await step<StockView>('экран остатков (все страницы)', 'GET', `${api('stock')}?limit=200`)).body.rows;
  const bySku = new Map(allRows.map((r) => [r.sku, r.channels[0]!.published]));
  assert.equal(allRows.length, DEMO_OFFERS);
  for (const u of units) {
    const sku = `syn-prod-de-340${u.idUnit}`;
    assert.equal(u.amount, bySku.get(sku) ?? -1, `единица ${u.idUnit}: количество в канале равно отправленному`);
  }
  const [applied] = (await observer.query(`SELECT count(*)::int AS n FROM tenant_data.channel_write_history WHERE field = 'QUANTITY' AND final_status = 'APPLIED'`)).rows;
  assert.equal(Number(applied.n), DEMO_OFFERS, 'каждая запись остатка подтверждена каналом');
  const divergences = (await step<StockDivergencesView>('расхождения', 'GET', api('stock', 'divergences'))).body;
  assert.deepEqual(divergences.items, []);
  console.log(JSON.stringify({ secondsToConfirmedSync: Math.round((Date.now() - journeyStart) / 100) / 10, secondsFromEnableToConfirmed: Math.round((Date.now() - syncEnabledAt) / 100) / 10 }));

  // 6. Себестоимости и стратегий не появилось — путь остатков их не требует [Р-152]
  const [pricing] = (await observer.query(`SELECT (SELECT count(*) FROM tenant_data.cost_profile)::int AS costs, (SELECT count(*) FROM tenant_data.pricing_strategy)::int AS strategies,
                                                  (SELECT count(*) FROM tenant_data.write_scope WHERE field = 'PRICE' AND pricing_mode = 'ENGINE')::int AS engines`)).rows;
  assert.deepEqual([pricing.costs, pricing.strategies, pricing.engines], [0, 0, 0]);
});

test('шаг 60 [Р-202]: счётчик внешних правок на экране подключений — правки аккаунта за сутки по часам базы', async () => {
  const accountId = demo.live.seeded.channelAccountId;
  const edits = async () => ((await step<ConnectionsView>('экран подключений: внешние правки', 'GET', api('connections'))).body.accounts.find((a) => a.channelAccountId === accountId)!);
  assert.equal((await edits()).externalEdits24h, 0, 'обход не видел чужих значений — правок нет');
  /**
   * Правки пишет обход предложений функцией роли каталога; здесь их кладёт суперпользователь мира прогона: две свежие (цена и
   * количество) и одна позавчерашняя — счётчик обязан показать ровно две, то есть и окно суток, и чтение журнала правок
   * административной ролью (политикой роли пути решения) настоящие
   */
  const [scope] = (await observer.query(`SELECT write_scope_id FROM tenant_data.write_scope WHERE channel_account_id = $1 AND field = 'QUANTITY' LIMIT 1`, [accountId])).rows;
  await db.superuser(`
    SET session_replication_role = replica;
    INSERT INTO channel_data.external_edit (tenant_id, channel_account_id, write_scope_id, field, observed_value, our_value, currency, since_write_id, observed_at, recorded_at) VALUES
      ('${demo.live.seeded.tenantId}', '${accountId}', '${scope.write_scope_id}', 'QUANTITY', 40, 12, NULL, gen_random_uuid(), now(), now()),
      ('${demo.live.seeded.tenantId}', '${accountId}', '${scope.write_scope_id}', 'PRICE', 1999, 2099, 'EUR', gen_random_uuid(), now(), now() - interval '1 hour'),
      ('${demo.live.seeded.tenantId}', '${accountId}', '${scope.write_scope_id}', 'QUANTITY', 50, 12, NULL, gen_random_uuid(), now() - interval '2 days', now() - interval '2 days');
    SET session_replication_role = origin;`);
  const after = await edits();
  assert.equal(after.externalEdits24h, 2, 'две правки за сутки; позавчерашняя не считается');
  assert.match(after.externalEditsText, /: 2$/, after.externalEditsText);
});

/**
 * Шаг 61 [Р-202, решение владельца]: отзыв подтверждения записи количества через консоль — тем же порядком, что выдача: владелец набирает
 * идентификатор аккаунта; наблюдателю отказывает консоль, администратору — база. Запись количества выключается сразу, и включение без
 * нового подтверждения снова отвечает 409. В конце — новое подтверждение и включение: следующим прогонам файла нужен работающий канал
 */
test('шаг 61 [Р-202]: отзыв записи количества через консоль — сразу выключено, включить снова — только новым подтверждением', async () => {
  const accountId = demo.live.seeded.channelAccountId;
  type Failure = { error: { code: string; message: string } };
  const codeOf = (r: { status: number; text: string }) => [r.status, (JSON.parse(r.text) as Failure).error.code];
  const connectionOf = async (name: string) => (await step<ConnectionsView>(name, 'GET', api('connections'))).body.accounts.find((a) => a.channelAccountId === accountId)!;
  const revoke = (typedConfirmation: string, auth = owner) => call('POST', api('connections', 'quantity-writes-revoke'), { channelAccountId: accountId, typedConfirmation }, auth);
  let connection = await connectionOf('экран подключений: запись количества включена, отзыв предложен');
  assert.deepEqual([connection.quantityWrites.confirmed, connection.quantityWrites.canRevoke, connection.quantityWrites.canConfirm], [true, true, false]);
  const typed = connection.quantityWrites.typeToRevoke!;
  assert.ok(connection.quantityWrites.revokeHint!.includes(typed), 'экран показывает, что набрать для отзыва');
  assert.deepEqual(codeOf(await revoke(typed, viewerAuth)), [403, 'FORBIDDEN']);
  assert.deepEqual(codeOf(await revoke(typed, adminAuth)), [403, 'NOT_OWNER'], 'администратору отказывает база: отзывает только владелец');
  assert.deepEqual(codeOf(await revoke(`${typed}x`)), [400, 'CONFIRMATION_MISMATCH']);
  const revoked = await step<{ revoked: boolean; disabledScopes: number; discardedWrites: number; inFlightWrites: number; message: string }>('отзыв записи количества владельцем', 'POST',
    api('connections', 'quantity-writes-revoke'), { channelAccountId: accountId, typedConfirmation: typed });
  assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
  // Все записи пути уже подтверждены каналом — снимать нечего, выключается синхронизация каждой единицы
  assert.deepEqual([revoked.body.disabledScopes, revoked.body.discardedWrites, revoked.body.inFlightWrites], [DEMO_OFFERS, 0, 0]);
  assert.match(revoked.body.message, /Widerrufen/, revoked.body.message);
  assert.deepEqual(codeOf(await revoke(typed)), [409, 'NOT_CONFIRMED'], 'отзывать нечего');
  connection = await connectionOf('экран подключений после отзыва');
  assert.deepEqual([connection.quantityWrites.confirmed, connection.quantityWrites.canRevoke, connection.quantityWrites.canConfirm], [false, false, true]);
  const stockScreen = (await step<StockView>('экран остатков после отзыва', 'GET', api('stock'))).body;
  assert.equal(stockScreen.summary.synced, 0, 'ни одна единица больше не синхронизируется');
  const enableBody = { channelAccountId: accountId, bufferUnits: 2, maxQuantity: null, minQuantityToList: 0 };
  const refused = await step<Failure>('включение после отзыва', 'POST', api('stock', 'enable'), enableBody);
  assert.deepEqual([refused.status, refused.body.error.code], [409, 'QUANTITY_WRITES_NOT_CONFIRMED']);
  const [journal] = (await observer.query(`SELECT count(*) FILTER (WHERE action = 'REVOKE')::int AS revokes, count(*)::int AS n FROM tenant_data.channel_quantity_writes_confirmation WHERE channel_account_id = $1`, [accountId])).rows;
  assert.deepEqual([journal.revokes, journal.n], [1, 2], 'отзыв — строка того же журнала');

  // Новое подтверждение и включение: запись количества снова идёт
  const confirmed = await call('POST', api('connections', 'quantity-writes'), { channelAccountId: accountId, typedConfirmation: typed });
  assert.equal(confirmed.status, 200, confirmed.text);
  const enableJob = await step<JobCreatedResponse>('включение после нового подтверждения', 'POST', api('stock', 'enable'), enableBody);
  assert.equal(enableJob.status, 200, JSON.stringify(enableJob.body).slice(0, 300));
  assert.equal((await pollJob(enableJob.body.jobId)).status, 'SUCCEEDED');
  assert.equal((await step<StockView>('экран остатков после нового подтверждения', 'GET', api('stock'))).body.summary.synced, DEMO_OFFERS);
});

test('Inbound API: ключ показан один раз; устаревшее значение не применяется; новое доходит до канала', async () => {
  const bad = await call('POST', '/inbound/v1/stock', { rows: [{ sku: '100001', quantity: 1, asOf: new Date().toISOString() }] }, { authorization: 'Bearer rpk_000000000000.0000000000000000000000000000000000000000000000000000', cookie: '' });
  assert.equal(bad.status, 401, 'неверный ключ — 401');
  const source = await step<{ stockSourceId: string; apiKey: string | null }>('источник: Inbound API', 'POST', api('stock', 'sources'), { mode: 'INBOUND_API', name: 'WMS' });
  assert.equal(source.status, 200);
  const key = source.body.apiKey!;
  inboundKey = key;
  assert.match(key, /^rpk_/);
  const sku = String(340_100_001).slice(-6);
  const t1 = '2026-09-23T10:00:00.000Z';
  const first = await call('POST', '/inbound/v1/stock', { rows: [{ sku, quantity: 30, asOf: t1 }, { sku: 'nope', quantity: 1, asOf: t1 }] }, { authorization: `Bearer ${key}`, cookie: '' });
  assert.equal(first.status, 200, first.text);
  assert.deepEqual(JSON.parse(first.text), { applied: 1, stale: 0, unknownSkus: ['nope'], writes: 1 });
  const stale = await call('POST', '/inbound/v1/stock', { rows: [{ sku, quantity: 5, asOf: '2026-09-23T09:00:00.000Z' }] }, { authorization: `Bearer ${key}`, cookie: '' });
  assert.deepEqual(JSON.parse(stale.text), { applied: 0, stale: 1, unknownSkus: [], writes: 0 });
  // Находка 6 ревью шага 35: объявленный предел — 5000 строк, и он достижим (тело резалось на 64 КиБ, это ~1200 строк)
  const batch = (n: number) => ({ rows: Array.from({ length: n }, (_, i) => ({ sku: `unbekannt-${i}`, quantity: 1, asOf: t1 })) });
  const full = await call('POST', '/inbound/v1/stock', batch(5000), { authorization: `Bearer ${key}`, cookie: '' });
  assert.equal(full.status, 200, `партия в 5000 строк доходит: ${full.status} ${full.text.slice(0, 120)}`);
  assert.equal((JSON.parse(full.text) as { unknownSkus: string[] }).unknownSkus.length, 5000);
  const over = await call('POST', '/inbound/v1/stock', batch(5001), { authorization: `Bearer ${key}`, cookie: '' });
  assert.equal(over.status, 400, 'партия больше предела — названный отказ, а не молчаливое усечение');
  for (let i = 0; i < 10; i++) { await demo.live.betweenTicks(); demo.clock.advance(30_000); }
  const screen = (await step<StockView>('экран остатков', 'GET', api('stock'))).body;
  const row = screen.rows.find((r) => r.sku === 'syn-prod-de-340100001')!;
  // Два пула одного товара складываются [Р-6]: файл 10 + Inbound 30 = 40, буфер 2 → 38, и канал это подтвердил
  assert.deepEqual([row.onHand, row.channels[0]!.published, row.channels[0]!.tone], [40, 38, 'ok'], JSON.stringify(row));
  const unit = (demo.live.simulator.dump() as { units: Array<{ idUnit: number; amount: number }> }).units.find((u) => String(u.idUnit) === sku)!;
  assert.equal(unit.amount, 38, 'новое количество дошло до канала');
});

test('Р-153: канал перестал принимать запись — расхождение «у нас / в канале» появляется и названо', async () => {
  // Продавец удалил единицу в кабинете канала — обычная жизнь. У нас остаток есть, канал его больше не примет
  const sku = String(340_100_002).slice(-6);
  const productSku = `syn-prod-de-340${sku}`;
  assert.equal(demo.live.simulator.removeUnit(Number(sku)), 1, 'единица была в канале и удалена продавцом');
  const pushed = await call('POST', '/inbound/v1/stock', { rows: [{ sku, quantity: 77, asOf: '2026-09-23T12:00:00.000Z' }] }, { authorization: `Bearer ${inboundKey}`, cookie: '' });
  assert.deepEqual(JSON.parse(pushed.text), { applied: 1, stale: 0, unknownSkus: [], writes: 1 }, pushed.text);
  for (let i = 0; i < 10; i++) { await demo.live.betweenTicks(); demo.clock.advance(30_000); }

  // Отдельный список расхождений: ровно эта единица, с тем, что отправлено, что подтверждено и почему не применено
  const divergences = (await step<StockDivergencesView>('расхождения (есть)', 'GET', api('stock', 'divergences'))).body;
  assert.equal(divergences.items.length, 1, JSON.stringify(divergences.items).slice(0, 400));
  const item = divergences.items[0]!;
  assert.deepEqual([item.sku, item.status, item.errorCode, item.channel], [productSku, 'DISCARDED_STALE', 'NOT_FOUND', 'KAUFLAND'], JSON.stringify(item));
  // Расхождение НАЗВАНО словами продавца: и отправленное количество, и то, что канал его не принял
  assert.match(item.text, new RegExp(String(item.sent)), item.text);
  assert.ok(item.text !== divergences.none && /[A-Za-zА-Яа-я]{4}/.test(item.text), `текст расхождения — не заглушка: ${item.text}`);

  // Та же строка на экране остатков: счётчик, бейдж строки и тон — одно правило расхождения на три места
  const screen = (await step<StockView>('экран остатков с расхождением', 'GET', `${api('stock')}?limit=200`)).body;
  assert.equal(screen.summary.diverged, 1, JSON.stringify(screen.summary));
  const row = screen.rows.find((r) => r.sku === productSku)!;
  assert.equal(row.channels[0]!.tone, 'stop', JSON.stringify(row.channels[0]));
  assert.ok(row.channels[0]!.divergedText && row.channels[0]!.divergedText.length > 0, 'строка товара называет расхождение');
  assert.equal(row.channels.filter((c) => c.divergedText !== null).length, 1);
  // У остальных 199 товаров расхождения нет — список не «всё подряд»
  assert.equal(screen.rows.filter((r) => r.channels.some((c) => c.divergedText !== null)).length, 1, 'расхождение только у своей единицы');

  // Расхождение показано именно потому, что повтора нет: пока запись в полёте, продавцу показывают ход, а не расхождение
  const [inFlight] = (await observer.query(`SELECT count(*)::int AS n FROM tenant_data.channel_write WHERE field = 'QUANTITY'`)).rows;
  assert.equal(Number(inFlight.n), 0, 'неприменённая запись завершена, повтора в полёте нет — иначе это был бы ход, а не расхождение');
});

/**
 * Находка 10 ревью шага 36: заголовок говорил «резервация закрывается сразу», а тест проверяет другое — подтверждение
 * ИСТОЧНИКОМ. Закрывает резервацию отгрузка (шаг 6), и именно она перестала ждать суток: без подтверждения отгрузка по
 * неподтверждённой резервации пропадала, и доступное возвращалось только по сроку [Р-25, Р-157].
 */
test('Р-157: склад подтверждает заказ по Inbound API — резервация подтверждена источником сразу, и отгрузка закрывает её, не дожидаясь суток TTL', async () => {
  /**
   * Шаг 36 [Р-157], OQ-217: резервацию Inbound API подтверждать было НЕКОМУ, и единственным выходом был срок в 24 часа —
   * товар уже уехал, а доступный остаток занижен сутки. Теперь склад продавца шлёт «заказ учтён» тем же ключом, что и
   * остаток. Проверяется по HTTP, как ходит склад: свой ключ, свой ответ; ошибки — названные, а не 500.
   *
   * Заказ канала здесь подставлен вызовом хранилища — так его приносит работа `order-lines` планировщика: модель Kaufland
   * в этом прогоне спроса не создаёт (мир пустой, `bare`), а маршрута «создай заказ» в консоли нет и быть не должно.
   */
  const productSku = 'syn-prod-de-340100001';
  const [offer] = (await observer.query(
    `SELECT om.external_offer_id, om.marketplace FROM tenant_data.offer_mapping om
       JOIN tenant_data.product p ON p.tenant_id = om.tenant_id AND p.product_id = om.product_id WHERE p.sku = $1`, [productSku])).rows;
  assert.ok(offer?.external_offer_id, `у товара ${productSku} есть предложение канала`);
  const orderRef = 'SYN-ORDER-R157';
  const orderLine = (status: 'OPEN' | 'SHIPPED') => ({
    externalOrderRef: orderRef, externalOrderLineRef: 'SYN-ORDER-R157-1', identity: { marketplace: offer.marketplace as string, externalOfferId: offer.external_offer_id as string },
    quantity: 3, orderedAt: demo.clock.iso(), status,
  });
  const recorded = await stockStore.recordOrderLines(demo.live.seeded.tenantId, demo.live.seeded.channelAccountId, [orderLine('OPEN')], demo.clock.iso());
  assert.deepEqual([recorded.created, recorded.consumed, recorded.awaitingConfirmation], [1, 0, 0]);
  // Пул источника (30 штук) больше внутреннего (10) — резервация создана в нём и подтверждения ждёт от НЕГО
  const [reserved] = (await observer.query(`SELECT status, source_mode FROM channel_data.reservation WHERE channel_order_ref = $1`, [orderRef])).rows;
  assert.deepEqual([reserved.status, reserved.source_mode], ['CREATED', 'INBOUND_API']);
  // Продавец видит это на своём экране: 40 в пулах, 3 держит заказ, доступно 37
  const beforeRow = (await step<StockView>('экран остатков с заказом', 'GET', `${api('stock')}?limit=200`)).body.rows.find((r) => r.sku === productSku)!;
  assert.deepEqual([beforeRow.onHand, beforeRow.reserved, beforeRow.available], [40, 3, 37]);

  // 1. Чужой ключ — 401 и названный код, без подробностей о том, чей заказ существует
  const bad = await call('POST', '/inbound/v1/orders', { orders: [{ externalOrderRef: orderRef }] },
    { authorization: 'Bearer rpk_000000000000.0000000000000000000000000000000000000000000000000000', cookie: '' });
  assert.equal(bad.status, 401, bad.text);
  assert.equal((JSON.parse(bad.text) as { error: { code: string } }).error.code, 'UNAUTHORIZED');
  assert.equal((await observer.query(`SELECT status FROM channel_data.reservation WHERE channel_order_ref = $1`, [orderRef])).rows[0].status, 'CREATED',
    'отказ в доступе ничего не подтвердил');
  // 2. Пустой список — 400 с причиной, а не молчаливое «ноль подтверждено» и не 500
  const empty = await call('POST', '/inbound/v1/orders', { orders: [] }, { authorization: `Bearer ${inboundKey}`, cookie: '' });
  assert.equal(empty.status, 400, empty.text);
  assert.equal((JSON.parse(empty.text) as { error: { code: string } }).error.code, 'BAD_ROWS');
  // 3. Заказ без номера — тот же названный отказ: пустая строка не считается номером заказа
  const blank = await call('POST', '/inbound/v1/orders', { orders: [{ externalOrderRef: '  ' }] }, { authorization: `Bearer ${inboundKey}`, cookie: '' });
  assert.equal(blank.status, 400, blank.text);

  // 4. Настоящий заказ своим ключом: подтверждён ровно один, неизвестный назван отдельно — склад видит, что расходится
  const confirmed = await call('POST', '/inbound/v1/orders', { orders: [{ externalOrderRef: orderRef }, { externalOrderRef: 'SYN-ORDER-NIE-GESEHEN' }] },
    { authorization: `Bearer ${inboundKey}`, cookie: '' });
  assert.equal(confirmed.status, 200, confirmed.text);
  assert.deepEqual(JSON.parse(confirmed.text), { confirmed: 1, alreadyConfirmed: [], releasedOrders: [], unknownOrders: ['SYN-ORDER-NIE-GESEHEN'] });
  const [after] = (await observer.query(
    `SELECT status, confirmed_at IS NOT NULL AS confirmed, confirmed_external_order_ref FROM channel_data.reservation WHERE channel_order_ref = $1`, [orderRef])).rows;
  assert.deepEqual([after.status, after.confirmed, after.confirmed_external_order_ref], ['CONFIRMED_BY_SOURCE', true, orderRef],
    'подтверждение записано в резервацию с номером СВОЕГО заказа');
  // 5. Повтор безвреден: склад, пославший подтверждение дважды, получает «уже подтверждён», а не ошибку
  const again = await call('POST', '/inbound/v1/orders', { orders: [{ externalOrderRef: orderRef }] }, { authorization: `Bearer ${inboundKey}`, cookie: '' });
  assert.deepEqual(JSON.parse(again.text), { confirmed: 0, alreadyConfirmed: [orderRef], releasedOrders: [], unknownOrders: [] });

  /**
   * Находка 10 ревью шага 36: предел «5000 заказов в одном вызове» был ОБЪЯВЛЕН и ни разу не измерен — ни по времени,
   * ни по размеру. Замер нашёл, что он недостижим: 5000 номеров весят ~200 КБ, а предел тела запроса у всего, что не
   * названо файлом продавца, — 64 КиБ, и склад получал 413 вместо ответа (исправлено в `bodyLimitFor`).
   *
   * Время печатается и утверждается: разбор идёт по одному номеру (две выборки на незнакомый заказ), и если предел
   * когда-нибудь перестанет укладываться в срок ответа, это увидит прогон, а не склад продавца.
   */
  const bulkRefs = [{ externalOrderRef: orderRef }, ...Array.from({ length: 4999 }, (_, i) => ({ externalOrderRef: `SYN-ORDER-MASSE-${i}` }))];
  const bulkBytes = Buffer.byteLength(JSON.stringify({ orders: bulkRefs }));
  assert.ok(bulkBytes > 64 * 1024, `партия предельного размера больше обычного тела запроса: ${bulkBytes} байт`);
  const bulkStarted = process.hrtime.bigint();
  const bulk = await call('POST', '/inbound/v1/orders', { orders: bulkRefs }, { authorization: `Bearer ${inboundKey}`, cookie: '' });
  const bulkSeconds = Math.round(Number(process.hrtime.bigint() - bulkStarted) / 1e6) / 1000;
  assert.equal(bulk.status, 200, `партия в ${bulkRefs.length} заказов доходит и обрабатывается: ${bulk.status} ${bulk.text.slice(0, 200)}`);
  const bulkBody = JSON.parse(bulk.text) as { confirmed: number; alreadyConfirmed: string[]; releasedOrders: string[]; unknownOrders: string[] };
  assert.deepEqual([bulkBody.confirmed, bulkBody.alreadyConfirmed, bulkBody.releasedOrders, bulkBody.unknownOrders.length], [0, [orderRef], [], 4999],
    'свой заказ назван уже подтверждённым, остальные 4999 — неизвестными: склад видит, что расходится');
  journey.push({ step: `Inbound API: ${bulkRefs.length} заказов одним вызовом (${bulkBytes} байт)`, method: 'POST', url: '/inbound/v1/orders', seconds: bulkSeconds, status: bulk.status });
  console.log(JSON.stringify({ inboundOrdersBatch: { orders: bulkRefs.length, bytes: bulkBytes, seconds: bulkSeconds } }));
  assert.ok(bulkSeconds < INBOUND_ORDERS_LIMIT_SECONDS, `партия предельного размера укладывается в срок ответа экрана: ${bulkSeconds} с`);
  // Партия больше предела — названный отказ, а не молчаливое усечение и не 413 без объяснения
  const overOrders = await call('POST', '/inbound/v1/orders', { orders: [...bulkRefs, { externalOrderRef: 'SYN-ORDER-5001' }] }, { authorization: `Bearer ${inboundKey}`, cookie: '' });
  assert.equal(overOrders.status, 400, overOrders.text.slice(0, 200));
  assert.equal((JSON.parse(overOrders.text) as { error: { code: string } }).error.code, 'BAD_ROWS');

  // 6. Отгрузка закрывает резервацию. Шаг 59 [Р-200, OQ-223]: доступное НЕ возвращается к 40 — товар уехал, а источник ещё не прислал
  // новый остаток; отгруженные 3 вычитаются, пока его присылка не окажется позже подтверждения заказа
  const shipped = await stockStore.recordOrderLines(demo.live.seeded.tenantId, demo.live.seeded.channelAccountId, [orderLine('SHIPPED')], demo.clock.iso());
  assert.deepEqual([shipped.consumed, shipped.awaitingConfirmation], [1, 0]);
  const afterRow = (await step<StockView>('экран остатков после отгрузки', 'GET', `${api('stock')}?limit=200`)).body.rows.find((r) => r.sku === productSku)!;
  assert.deepEqual([afterRow.onHand, afterRow.reserved, afterRow.available], [40, 3, 37], 'the shipped pieces stay subtracted until the source sends a newer figure');
  // 7. Склад присылает остаток после подтверждения — в нём отгрузка уже учтена (его пул 30 − 3 = 27; ещё 10 — во внутреннем пуле),
  // вычитание кончается само
  const pushed = await call('POST', '/inbound/v1/stock', { rows: [{ sku: productSku, quantity: 27, asOf: new Date(Date.now() + 1000).toISOString() }] }, { authorization: `Bearer ${inboundKey}`, cookie: '' });
  assert.equal(pushed.status, 200, pushed.text.slice(0, 200));
  const settledRow = (await step<StockView>('экран остатков после присылки склада', 'GET', `${api('stock')}?limit=200`)).body.rows.find((r) => r.sku === productSku)!;
  assert.deepEqual([settledRow.onHand, settledRow.reserved, settledRow.available], [37, 0, 37], 'the newer figure of the source already counts the shipment');
});

/**
 * Шаг 59 [Р-199], OQ-218: возврат по отгруженному заказу не возвращает остаток сам — товар мог вернуться повреждённым.
 * Строка возврата ждёт человека: наблюдатель её видит, но не решает; владелец «принимает на склад» — движение RETURN,
 * доступное растёт ровно на количество возврата, и новое количество уходит в канал; повторное решение — 409.
 * Заказ канала подставлен вызовом хранилища (как его приносит работа `order-lines`); всё, что делает продавец, — по HTTP.
 */
test('Р-199: возврат внутреннего пула — ждёт решения; наблюдатель 403; «принять на склад» поднимает доступное и уходит в канал; повтор — 409', async () => {
  const productSku = 'syn-prod-de-340100005';
  const unitId = 100005;
  const [offer] = (await observer.query(
    `SELECT om.external_offer_id, om.marketplace FROM tenant_data.offer_mapping om
       JOIN tenant_data.product p ON p.tenant_id = om.tenant_id AND p.product_id = om.product_id WHERE p.sku = $1`, [productSku])).rows;
  assert.ok(offer?.external_offer_id, `у товара ${productSku} есть предложение канала`);
  const orderLine = (status: 'OPEN' | 'SHIPPED' | 'RETURNED') => ({
    externalOrderRef: 'SYN-ORDER-R199', externalOrderLineRef: 'SYN-ORDER-R199-1', identity: { marketplace: offer.marketplace as string, externalOfferId: offer.external_offer_id as string },
    quantity: 3, orderedAt: demo.clock.iso(), status,
  });
  const rowOf = async (label: string) => (await step<StockView>(label, 'GET', `${api('stock')}?limit=200`)).body.rows.find((r) => r.sku === productSku)!;
  const settle = async () => { for (let i = 0; i < 10; i++) { await demo.live.betweenTicks(); demo.clock.advance(30_000); } };
  const unitAmount = () => (demo.live.simulator.dump() as { units: Array<{ idUnit: number; amount: number }> }).units.find((u) => u.idUnit === unitId)!.amount;
  const tenantId = demo.live.seeded.tenantId; const account = demo.live.seeded.channelAccountId;

  const start = await rowOf('экран остатков до заказа');
  // Файл первого теста: 10 + (4 mod 7) = 14 во внутреннем пуле, буфер 2 → в канале 12
  assert.deepEqual([start.onHand, start.reserved, start.available], [14, 0, 14], JSON.stringify(start));
  assert.equal(unitAmount(), 12);

  // Заказ, отгрузка — пул списан движением базы; пересчёт, как после работы `order-lines`, уносит 11 − 2 = 9 в канал
  assert.equal((await stockStore.recordOrderLines(tenantId, account, [orderLine('OPEN')], demo.clock.iso())).created, 1);
  assert.equal((await stockStore.recordOrderLines(tenantId, account, [orderLine('SHIPPED')], demo.clock.iso())).consumed, 1);
  await worldStockPipeline.propagate(tenantId, null);
  await settle();
  const shipped = await rowOf('экран остатков после отгрузки');
  assert.deepEqual([shipped.onHand, shipped.reserved, shipped.available], [11, 0, 11]);
  assert.equal(unitAmount(), 9, 'отгрузка дошла до канала');

  // Возврат: строка возврата PENDING, остаток НЕ изменился
  const returned = await stockStore.recordOrderLines(tenantId, account, [orderLine('RETURNED')], demo.clock.iso());
  assert.equal(returned.returns, 1, JSON.stringify(returned));
  await worldStockPipeline.propagate(tenantId, null);
  const list = await step<StockReturnsView>('возвраты', 'GET', api('stock', 'returns'));
  assert.equal(list.status, 200, JSON.stringify(list.body));
  const item = list.body.items.find((x) => x.sku === productSku)!;
  assert.ok(item, JSON.stringify(list.body.items));
  assert.deepEqual([item.status, item.pending, item.infoOnly, item.quantity, item.channelOrderLineRef, list.body.pendingCount, list.body.canDecide],
    ['PENDING', true, false, 3, 'SYN-ORDER-R199-1', 1, true]);
  assert.match(item.text, /wartet auf Ihre Entscheidung/, 'строка названа на языке продавца');
  assert.deepEqual([(await rowOf('экран остатков после возврата')).available, unitAmount()], [11, 9], 'возврат сам в пул не попадает');

  // Наблюдатель видит список, но решать не может — 403 от консоли, а в базе ничего не изменилось
  const viewerList = await call('GET', api('stock', 'returns'), undefined, viewerAuth);
  assert.equal(viewerList.status, 200, viewerList.text);
  assert.equal((JSON.parse(viewerList.text) as StockReturnsView).canDecide, false);
  const denied = await call('POST', api('stock', 'returns'), { orderReturnId: item.orderReturnId, accept: true }, viewerAuth);
  assert.equal(denied.status, 403, denied.text);
  assert.equal((JSON.parse(denied.text) as { error: { code: string } }).error.code, 'FORBIDDEN');
  assert.equal((await observer.query(`SELECT status FROM channel_data.order_return WHERE order_return_id = $1`, [item.orderReturnId])).rows[0].status, 'PENDING');
  // Не идентификатор — названный отказ до базы, а не 500
  const bad = await call('POST', api('stock', 'returns'), { orderReturnId: 'nope', accept: true });
  assert.equal(bad.status, 400, bad.text);

  // Владелец принимает на склад: 200, движение RETURN с автором, доступное +3, новое количество уходит в канал
  const accepted = await step<{ status: string; accepted: boolean; writes: number; message: string }>('принять возврат на склад', 'POST', api('stock', 'returns'),
    { orderReturnId: item.orderReturnId, accept: true, note: 'Ware unbeschädigt' });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.deepEqual([accepted.body.status, accepted.body.accepted, accepted.body.writes], ['DECIDED', true, 1]);
  const [movement] = (await observer.query(
    `SELECT m.reason, m.delta, m.created_by_membership_id::text AS author, o.status, o.note FROM channel_data.order_return o
       JOIN tenant_data.stock_movement m ON m.tenant_id = o.tenant_id AND m.stock_movement_id = o.stock_movement_id WHERE o.order_return_id = $1`, [item.orderReturnId])).rows;
  assert.deepEqual([movement.reason, Number(movement.delta), movement.author, movement.status, movement.note], ['RETURN', 3, demo.live.seeded.ownerMembershipId, 'ACCEPTED', 'Ware unbeschädigt']);
  await settle();
  const after = await rowOf('экран остатков после приёма возврата');
  assert.deepEqual([after.onHand, after.available], [14, 14], 'доступное выросло ровно на количество возврата');
  assert.equal(unitAmount(), 12, 'новое количество дошло до канала');
  const afterList = (await step<StockReturnsView>('возвраты после решения', 'GET', api('stock', 'returns'))).body;
  assert.deepEqual([afterList.pendingCount, afterList.items.find((x) => x.orderReturnId === item.orderReturnId)!.status], [0, 'ACCEPTED']);

  // Повторное решение — 409 своим кодом; остаток второй раз не растёт
  const again = await call('POST', api('stock', 'returns'), { orderReturnId: item.orderReturnId, accept: true });
  assert.equal(again.status, 409, again.text);
  assert.equal((JSON.parse(again.text) as { error: { code: string } }).error.code, 'RETURN_NOT_PENDING');
  assert.equal((await rowOf('экран остатков после повтора')).available, 14);
});
