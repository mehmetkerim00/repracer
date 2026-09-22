import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { JobCreatedResponse, StandToken, WorldSummary } from '../src/api-types.ts';
import type { BoundsDiffView, BulkJobView, CostImportView, EnableResultView, OnboardingView, StrategyPreviewView } from '@repracer/console-model';
import { DEMO_FILE_PREFIX, DEMO_ROW_MARK } from '@repracer/bulk-jobs';
import { STAND_AUDIENCE, STAND_ISSUER, type LiveWorld } from '@repracer/contract-tests/stand';
import { demoWorld, DEMO_COMPETITORS_PER_OFFER, DEMO_OFFERS, type DemoWorld } from '@repracer/contract-tests/live';
import { createAuthenticator, MemoryIdentityDirectory, staticJwks } from '@repracer/identity';
import { createTestIssuer } from '@repracer/identity/test-issuer';
import { seedPricingWorld, PgPricingStore, type PgPool } from '@repracer/pricing-store-pg';
import { createPricingPipeline } from '@repracer/pricing-pipeline';
import { KAUFLAND_DESCRIPTOR } from '@repracer/kaufland-adapter';
import { createIsolatedDatabase, type IsolatedDatabase } from '../../../packages/pricing-store-pg/test/isolated-db.ts';
import { createStandApi, createStandServer } from '../server/stand-server.ts';
import type { BulkWorkerConfig } from '../server/bulk-worker.ts';
import { setAccessToken, setApiOrigin } from '../src/api.ts';

/**
 * Р-149, Р-151 (шаг 34): онбординг ЦЕЛИКОМ живым прогоном через консоль как браузер [Р-136, Р-142] — на демо-тенанте, то есть
 * на симуляторе канала: тенант → канал → себестоимость → границы → стратегия → включение → первое решение с объяснением.
 * Данные синтетические, путь настоящий: те же маршруты, тот же движок, те же стражи базы.
 *
 * Здесь же — задача D: тенант БЕЗ ДАННЫХ. Проверка Р-136 покрывала только наполненные экраны; новый продавец не должен
 * видеть ни ошибок, ни вечных спиннеров, ни пустых таблиц без объяснения.
 */

const SCREEN_LIMIT_SECONDS = 10;
const APPLY_LIMIT_SECONDS = 120;
const DEMO_WORLD = 'demo/kaufland';
const EMPTY_WORLD = 'live/empty-tenant';
/** Себестоимость импортируется НЕ у всех: так виден единственный разрешённый способ пройти шаг — сужение набора [Р-131] */
const WITH_COST = 150;
const LEASE_SECONDS = 5;

let db: IsolatedDatabase;
let demo: DemoWorld;
let server: Server;
let origin: string;
let owner: { authorization: string; cookie: string };
let passwordOnly: { authorization: string; cookie: string };
let emptyOwner: { authorization: string; cookie: string };
/** Оператор включает движок, но цен не правит; зритель не делает ни того ни другого [Р-143] */
let operator: { authorization: string; cookie: string };
let viewerOnly: { authorization: string; cookie: string };
let observer: PgPool;
const workers: ChildProcess[] = [];
let workerConfigPath = '';
const measured: Array<{ operation: string; seconds: number; bytes: number; status: number; note: string }> = [];

const api = (world: string, screen: string, param?: string) => `/api/worlds/${encodeURIComponent(world)}/${screen}${param ? `/${param}` : ''}`;

async function call(method: 'GET' | 'POST', url: string, body?: unknown, auth = owner): Promise<{ status: number; text: string }> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const r = await fetch(`${origin}${url}`, {
    method, headers: { authorization: auth.authorization, cookie: auth.cookie, ...(payload ? { 'content-type': 'application/json' } : {}) },
    ...(payload === undefined ? {} : { body: payload }),
  });
  return { status: r.status, text: await r.text() };
}

async function measure<T>(operation: string, method: 'GET' | 'POST', url: string, body?: unknown, note = '', auth = owner): Promise<{ status: number; body: T }> {
  const started = process.hrtime.bigint();
  const r = await call(method, url, body, auth);
  const seconds = Math.round(Number(process.hrtime.bigint() - started) / 1e6) / 1000;
  measured.push({ operation, seconds, bytes: Buffer.byteLength(r.text, 'utf8'), status: r.status, note });
  const parsed = (() => { try { return JSON.parse(r.text) as T; } catch { return null as unknown as T; } })();
  return { status: r.status, body: parsed };
}

async function pollJob(world: string, jobId: string, limitSeconds = APPLY_LIMIT_SECONDS): Promise<BulkJobView> {
  const deadline = Date.now() + limitSeconds * 1000;
  for (;;) {
    const r = await call('GET', api(world, 'jobs', jobId));
    assert.equal(r.status, 200, r.text);
    const job = JSON.parse(r.text) as BulkJobView;
    if (job.status === 'SUCCEEDED' || job.status === 'FAILED') return job;
    if (Date.now() > deadline) throw new Error(`bulk job ${jobId} stayed ${job.status}/${job.headline} for ${limitSeconds}s`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function runJob(operation: string, world: string, url: string, body: unknown): Promise<BulkJobView> {
  const created = await measure<JobCreatedResponse>(`${operation} (создание задания)`, 'POST', url, body);
  assert.equal(created.status, 200, `${operation}: ${JSON.stringify(created.body).slice(0, 300)}`);
  const started = process.hrtime.bigint();
  const job = await pollJob(world, created.body.jobId);
  measured.push({ operation: `${operation} (задание целиком)`, seconds: Math.round(Number(process.hrtime.bigint() - started) / 1e6) / 1000, bytes: 0, status: job.status === 'SUCCEEDED' ? 200 : 500, note: job.headline });
  assert.equal(job.status, 'SUCCEEDED', `${operation}: ${job.error ?? job.headline}`);
  return job;
}

const onboarding = async (world = DEMO_WORLD) => {
  const r = await measure<OnboardingView>('onboarding (экран пути)', 'GET', api(world, 'onboarding'), undefined, '', world === EMPTY_WORLD ? emptyOwner : owner);
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300));
  return r.body;
};

function startWorker(): ChildProcess {
  const child = spawn(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning',
    fileURLToPath(new URL('../server/bulk-worker.ts', import.meta.url))], { env: { ...process.env, BULK_WORKER_CONFIG: workerConfigPath }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr?.on('data', (chunk: Buffer) => console.error('bulk-worker:', chunk.toString().trim()));
  workers.push(child);
  return child;
}

before(async () => {
  db = await createIsolatedDatabase('onboarding');
  const appPool: PgPool = db.pool('svc_app', 4);
  const adminPool: PgPool = db.pool('svc_admin', 4);
  const provisioningPool = db.pool('svc_provisioning', 1);
  /**
   * Виртуальные часы демо НЕ МОГУТ быть в прошлом. Первая редакция стартовала на четыре часа раньше — и включение отказало
   * всем 150 предложениям: себестоимость, ввезённая через консоль, действует с НАСТОЯЩЕГО момента импорта (часы базы), а
   * путь решения смотрел на мир «четыре часа назад», где её ещё нет [Р-131].
   *
   * Старт — 09:00 UTC ЗАВТРАШНИХ суток, а не «сейчас»: иначе у прогона был бы скрытый вход — время суток. Два виртуальных
   * часа от «сейчас» в 22:30 пересекают границу суток (закрытие суток, секции по суткам UTC) — тот самый класс дефекта,
   * из-за которого три живых прогона шага 29 краснели час в сутки (ревью шага 34, находка 13).
   */
  const tomorrow = new Date(Date.now() + 24 * 3_600_000);
  const startIso = new Date(Date.UTC(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth(), tomorrow.getUTCDate(), 9, 0, 0)).toISOString();
  demo = await demoWorld({
    tag: 3401, startIso, bare: true, appPool, adminPool, provisioningPool, dispatcherPool: db.pool('svc_dispatcher', 2),
    schedulerPool: db.pool('svc_scheduler', 3), exporterPool: db.pool('svc_exporter', 2),
  });
  const seeded = demo.live.seeded;
  const store = new PgPricingStore(appPool, { adminPool, bulkWorkerPool: db.pool('svc_bulk_worker', 2) });
  const nowIso = () => demo.clock.iso();
  const demoAccounts = [{ channelAccountId: seeded.channelAccountId, channel: 'KAUFLAND', marketplaces: ['de'], haltRelease: 'SAMPLE' as const }];
  const demoLive: LiveWorld = {
    id: DEMO_WORLD, title: 'Демо: Kaufland на симуляторе', description: `${DEMO_OFFERS} предложений, три конкурента у каждого`, tenantId: seeded.tenantId,
    accounts: demoAccounts, identityTenantId: seeded.tenantId, membershipAlias: (id) => id, failures: [],
    store: store as never, pipeline: demo.live.pipelineForDbIds() as never, clock: { iso: nowIso, nowMs: () => demo.clock.nowMs() } as never,
    callContext: (channelAccountId) => ({ tenantId: seeded.tenantId as never, channelAccountId: channelAccountId as never, correlationId: 'onboarding-live', deadline: nowIso() }),
    view: async (viewer) => ({
      id: DEMO_WORLD, title: 'Демо: Kaufland на симуляторе', description: `${DEMO_OFFERS} предложений`, tenantId: seeded.tenantId, now: nowIso(),
      accounts: demoAccounts, viewer: { ...viewer }, state: await store.readConsoleState(seeded.tenantId, nowIso() as never),
    }) as never,
  };

  // Задача D: тенант без данных — ни предложений, ни канала с доступом; в базе у него только Amazon, ждущий доступа
  const empty = await seedPricingWorld(appPool, {
    provisioningPool, adminPool, fixtureTenantId: '10000000-0000-4000-8000-000000003402', fixtureChannelAccountId: '20000000-0000-4000-8000-000000003402',
    marketplaces: ['de'], clock: startIso,
    seed: { scopes: [], accounts: [{ channelAccountId: 'acc-amazon-3402', channel: 'AMAZON', region: 'EU', marketplaces: ['de'], awaitingAccess: ['NOTIFICATION_QUEUE', 'SELLER_AUTHORIZATION'] }] },
  });
  const noChannel = new Proxy({ descriptor: KAUFLAND_DESCRIPTOR } as Record<string, unknown>, {
    get: (target, key) => (key in target ? target[key as string] : () => { throw new Error(`пустой тенант обратился к каналу: ${String(key)}`); }),
  }) as never;
  const emptyPipeline = createPricingPipeline({ store: store as never, adapter: noChannel, alerts: { raise: async () => undefined }, logger: { log: () => undefined }, now: nowIso as never });
  const emptyLive: LiveWorld = {
    id: EMPTY_WORLD, title: 'Новый тенант', description: 'без данных', tenantId: empty.tenantId, accounts: [], identityTenantId: empty.tenantId,
    membershipAlias: (id) => id, failures: [], store: store as never, pipeline: emptyPipeline as never, clock: { iso: nowIso, nowMs: () => demo.clock.nowMs() } as never,
    callContext: (channelAccountId) => ({ tenantId: empty.tenantId as never, channelAccountId: channelAccountId as never, correlationId: 'empty-live', deadline: nowIso() }),
    view: async (viewer) => ({
      id: EMPTY_WORLD, title: 'Новый тенант', description: 'без данных', tenantId: empty.tenantId, now: nowIso(), accounts: [],
      viewer: { ...viewer }, state: await store.readConsoleState(empty.tenantId, nowIso() as never),
    }) as never,
  };

  const directory = new MemoryIdentityDirectory();
  directory.link({ issuer: STAND_ISSUER, subject: 'demo-owner' }, seeded.userId);
  directory.addMembership(seeded.userId, { tenantId: seeded.tenantId, membershipId: seeded.ownerMembershipId, role: 'OWNER' });
  // Владелец пустого тенанта — другой человек: существующий пользователь входит в чужой тенант только приглашением [Р-88]
  directory.link({ issuer: STAND_ISSUER, subject: 'empty-owner' }, empty.userId);
  directory.addMembership(empty.userId, { tenantId: empty.tenantId, membershipId: empty.ownerMembershipId, role: 'OWNER' });
  const issuer = createTestIssuer({ issuer: STAND_ISSUER, audience: STAND_AUDIENCE });
  // Наблюдатель — суперпользователь в отдельной базе прогона: только чтение, как в живом прогоне планировщика
  const observerUrl = new URL(process.env.REPRACER_PG_ADMIN_URL!); observerUrl.pathname = `/${db.name}`;
  const { createPool } = await import('@repracer/pricing-store-pg');
  observer = createPool(observerUrl.toString(), { max: 1, applicationName: 'repracer-onboarding-observer' });
  // Остальные участники демо-тенанта заведены посевом: оператор и зритель входят своими токенами
  const members = await observer.query(`SELECT role, user_id, membership_id FROM tenant_data.membership WHERE tenant_id = $1 AND role IN ('OPERATOR', 'VIEWER')`, [seeded.tenantId]);
  const authOf = (role: string, subject: string) => {
    const row = members.rows.find((r) => r.role === role);
    assert.ok(row, `в демо-тенанте есть участник с ролью ${role}`);
    directory.link({ issuer: STAND_ISSUER, subject }, row.user_id as string);
    directory.addMembership(row.user_id as string, { tenantId: seeded.tenantId, membershipId: row.membership_id as string, role: role as never });
    return { authorization: `Bearer ${issuer.token(subject, { email: `${subject}@example.invalid`, amr: ['pwd', 'otp'] })}`, cookie: 'repracer_locale=de' };
  };
  operator = authOf('OPERATOR', 'demo-operator');
  viewerOnly = authOf('VIEWER', 'demo-viewer');
  emptyOwner = { authorization: `Bearer ${issuer.token('empty-owner', { email: 'new-seller@example.invalid', amr: ['pwd', 'otp'] })}`, cookie: 'repracer_locale=de' };
  const handle = createStandApi([demoLive, emptyLive], {
    authenticator: createAuthenticator({ issuer: STAND_ISSUER, audience: STAND_AUDIENCE, jwks: staticJwks(issuer.jwks), directory }),
    simulator: { token: (_a, options) => issuer.token('demo-owner', { email: 'owner@example.invalid', amr: options?.secondFactor === false ? ['pwd'] : ['pwd', 'otp'] }), expiresInSeconds: 900 },
  });
  server = createStandServer(handle);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  owner = { authorization: '', cookie: 'repracer_locale=de' };
  const token = await call('POST', '/api/stand-issuer/token?locale=de', { role: 'OWNER' });
  assert.equal(token.status, 200, token.text);
  owner = { authorization: `Bearer ${(JSON.parse(token.text) as StandToken).accessToken}`, cookie: 'repracer_locale=de' };
  const weak = await call('POST', '/api/stand-issuer/token?locale=de', { role: 'OWNER', secondFactor: false });
  passwordOnly = { authorization: `Bearer ${(JSON.parse(weak.text) as StandToken).accessToken}`, cookie: 'repracer_locale=de' };
  setApiOrigin(origin);
  setAccessToken((JSON.parse(token.text) as StandToken).accessToken);

  const config: BulkWorkerConfig = {
    pgUrl: db.url('svc_app'), leaseSeconds: LEASE_SECONDS, progressEverySeconds: 1, idleMs: 100,
    worlds: [{ descriptor: { id: DEMO_WORLD, title: 'Демо', description: '', tenantId: seeded.tenantId, accounts: demoAccounts }, now: 'WALL_CLOCK' }],
  };
  workerConfigPath = join(mkdtempSync(join(tmpdir(), 'repracer-onboarding-')), 'worker.json');
  writeFileSync(workerConfigPath, JSON.stringify(config), 'utf8');
  startWorker();
});

after(async () => {
  console.log(JSON.stringify({ offers: DEMO_OFFERS, withCost: WITH_COST, operations: measured }, null, 1));
  for (const child of workers) child.kill('SIGKILL');
  server?.close();
  await observer?.end();
  await db?.drop();
});

test('задача D: новый тенант без данных — каждый экран отвечает без ошибок, пустоту объясняет, а не молчит', async () => {
  const worlds = await measure<WorldSummary[]>('worlds (список миров)', 'GET', '/api/worlds', undefined, '', emptyOwner);
  const summary = worlds.body.find((w) => w.id === EMPTY_WORLD)!;
  assert.deepEqual([summary.scopes, summary.awaitingAccess, summary.demo], [0, 1, false], 'список миров называет: предложений нет, один канал ждёт доступа, это не демо');

  for (const screen of ['onboarding', 'products', 'bounds', 'strategies', 'feed', 'decisions', 'rejected', 'dangerous', 'compliance', 'jobs', 'stop']) {
    const r = await measure<unknown>(`пустой тенант: ${screen}`, 'GET', api(EMPTY_WORLD, screen), undefined, '', emptyOwner);
    assert.equal(r.status, 200, `${screen}: ${JSON.stringify(r.body).slice(0, 200)}`);
  }
  /**
   * 200 — ещё не «пустое состояние» (ревью шага 34, находка 11б): экран обязан отдать ПУСТОЙ СПИСОК С ИТОГОМ НОЛЬ, по которому
   * интерфейс показывает объяснение, а не таблицу без строк. Сами объяснения отрисовываются в `console.test.ts`.
   */
  const emptyList = async <T>(screen: string) => (await measure<T>(`пустой тенант: ${screen} (содержимое)`, 'GET', api(EMPTY_WORLD, screen), undefined, '', emptyOwner)).body;
  const products = await emptyList<{ rows: unknown[]; page: { total: number } }>('products');
  assert.deepEqual([products.rows, products.page.total], [[], 0], 'товары: пустая страница с итогом ноль');
  const boundsIndex = await emptyList<{ items: unknown[] }>('bounds');
  assert.deepEqual(boundsIndex.items, [], 'границы: пустой список');
  const strategies = await emptyList<{ strategies: unknown[]; scopes: unknown[] }>('strategies');
  assert.deepEqual([strategies.strategies, strategies.scopes], [[], []], 'стратегии: ни стратегий, ни предложений');
  const decisionsEmpty = await emptyList<{ items: unknown[]; page: { total: number } }>('decisions');
  assert.deepEqual([decisionsEmpty.items, decisionsEmpty.page.total], [[], 0], 'решения: пустая страница с итогом ноль');
  const jobsEmpty = await emptyList<{ items: unknown[] }>('jobs');
  assert.deepEqual(jobsEmpty.items, [], 'задания: пустой список');
  // Р-150: канал без доступа — честное состояние с перечнем, а не ошибка и не пустота
  const view = await onboarding(EMPTY_WORLD);
  const amazon = view.channels.find((c) => c.channel === 'AMAZON');
  assert.ok(amazon && amazon.status === 'AWAITING_ACCESS', `канал без доступа показан: ${JSON.stringify(view.channels)}`);
  // Перечень — КОДАМИ из базы, а не текстом словаря (ревью шага 34, находка 11в); продавцу — слова без внутренних номеров
  assert.deepEqual(amazon.blockers.map((b) => b.code).sort(), ['NOTIFICATION_QUEUE', 'SELLER_AUTHORIZATION'], 'перечень того, чего не хватает');
  assert.ok(amazon.blockers.every((b) => b.text.length > 0 && !/OQ-\d+/.test(b.text)), `текст продавцу без внутренних номеров вопросов: ${JSON.stringify(amazon.blockers)}`);
  assert.ok(view.steps.find((s) => s.step === 'CHANNEL')!.awaiting, 'шаг канала говорит «ожидает доступа»');
  assert.equal(view.steps.find((s) => s.step === 'COSTS')!.totalCount, 0, 'предложений для импорта нет — и это сказано числом');
  // Операция, которой нужен канал, — не 500, а названный отказ
  const stop = await call('POST', api(EMPTY_WORLD, 'stop'), { target: { kind: 'TENANT' }, note: 'Проверка пустого тенанта: канала ещё нет', confirmed: true }, emptyOwner);
  assert.equal(stop.status, 409, `без единого канала операция отказывает названно: ${stop.status} ${stop.text.slice(0, 120)}`);
  assert.match(stop.text, /NO_CHANNEL/);
});

test('Р-149, Р-151: онбординг целиком на демо-тенанте — от пустого пути до включённого движка', async () => {
  const worlds = await call('GET', '/api/worlds');
  const summary = (JSON.parse(worlds.text) as WorldSummary[]).find((w) => w.id === DEMO_WORLD)!;
  assert.deepEqual([summary.demo, summary.scopes, summary.awaitingAccess], [true, DEMO_OFFERS, 1], 'демо помечено в списке миров, каталог 200, один канал ждёт доступа');

  // Шаг 1–2: тенант есть, Kaufland подключён (симулятор), Amazon ждёт доступа — путь начинается с себестоимости
  let view = await onboarding();
  assert.equal(view.demo, true, 'экран пути помечен как демо');
  assert.equal(view.resumeAt, 'COSTS', `путь начинается с себестоимости: ${view.resumeText}`);
  assert.deepEqual(view.steps.filter((s) => s.done).map((s) => s.step), ['TENANT', 'CHANNEL']);
  assert.equal(view.steps.find((s) => s.step === 'COSTS')!.totalCount, DEMO_OFFERS);

  // Шаг 3: импорт себестоимости — у 150 из 200. Пропустить шаг нельзя [Р-131]: остаётся сузить набор
  const skus = Array.from({ length: WITH_COST }, (_, i) => String(340_100_001 + i).slice(-6));
  /**
   * Файл несёт и комиссию канала [Р-138]. Первая редакция прогона ввозила только себестоимость — и включение отказало всем
   * 150 предложениям (FEE_ESTIMATE_MISSING): без комиссии пол маржи не считается. Путь при этом показывал шаг пройденным;
   * теперь критерий шага тот же, что у включения (`write_scope_cost_ready`).
   */
  const csv = ['Artikelnummer;Einstandspreis;Währung;Provision %;Fixkosten', ...skus.map((sku, i) => `${sku};${10 + (i % 9)},25;EUR;15;0,00`)].join('\r\n');
  const file = { fileName: 'demo-kosten.csv', content: Buffer.from(csv, 'utf8').toString('base64') };
  const plan = await measure<CostImportView>('cost-import/plan', 'POST', api(DEMO_WORLD, 'cost-import', 'plan'), file);
  assert.equal(plan.status, 200, JSON.stringify(plan.body).slice(0, 300));
  assert.equal(plan.body.summary.apply, WITH_COST, `сопоставлено ровно столько строк, сколько в файле: ${JSON.stringify(plan.body.summary)}`);
  const imported = await runJob('cost-import/apply', DEMO_WORLD, api(DEMO_WORLD, 'cost-import', 'apply'), { ...file, fingerprint: plan.body.fingerprint, confirmed: true });
  // Р-147: итог задания в ответ экрана не входит — о сделанном говорит заголовок задания и состояние пути ниже
  assert.match(imported.headline, new RegExp(String(WITH_COST)), `импорт назвал число предложений: ${imported.headline}`);

  view = await onboarding();
  const costs = view.steps.find((s) => s.step === 'COSTS')!;
  assert.deepEqual([costs.done, costs.doneCount, costs.totalCount], [false, WITH_COST, DEMO_OFFERS], 'себестоимость есть у 150 из 200 — шаг не пройден');
  assert.ok(view.narrowing?.offered, 'экран предлагает сузить набор до предложений с себестоимостью');

  /**
   * Права двух действий пути — разные [Р-143] (ревью шага 34, находки 2 и 11д): сужает тот, кто правит цены, включает тот,
   * кто вправе включать движок. Оператор — ровно между ними, и проверяется в обе стороны настоящим входом.
   */
  const refusedNarrow = await call('POST', api(DEMO_WORLD, 'onboarding', 'narrow'), {}, operator);
  assert.equal(refusedNarrow.status, 403, `оператор не сужает набор — это право того, кто правит цены: ${refusedNarrow.text.slice(0, 120)}`);
  for (const action of ['narrow', 'enable']) {
    const refused = await call('POST', api(DEMO_WORLD, 'onboarding', action), {}, viewerOnly);
    assert.equal(refused.status, 403, `зритель не делает «${action}»: ${refused.text.slice(0, 120)}`);
  }
  const operatorView = JSON.parse((await call('GET', api(DEMO_WORLD, 'onboarding'), undefined, operator)).text) as OnboardingView;
  assert.deepEqual([operatorView.canLead, operatorView.canEnable], [false, true], 'экран оператора: сужать нельзя, включать можно');

  /**
   * Включение ДО того, как путь пройден, — оператором. Это единственный случай, где видно, что продавец узнаёт об отказах
   * (ревью шага 34, находка 3): границ и стратегии нет ни у кого, себестоимости — у 50. Задание не падает, а называет
   * отказанные предложения поимённо и словами.
   */
  const earlyCreated = await call('POST', api(DEMO_WORLD, 'onboarding', 'enable'), {}, operator);
  assert.equal(earlyCreated.status, 200, `оператор создаёт задание включения: ${earlyCreated.text.slice(0, 200)}`);
  const early = await pollJob(DEMO_WORLD, (JSON.parse(earlyCreated.text) as JobCreatedResponse).jobId);
  assert.equal(early.status, 'SUCCEEDED', early.error ?? early.headline);
  const earlyView = (early.result as { view: EnableResultView }).view;
  assert.deepEqual([earlyView.enabled, earlyView.skipped], [0, DEMO_OFFERS], 'без границ и стратегии не включается ни одно предложение');
  const count = (code: string) => earlyView.byCode.find((c) => c.code === code)?.count ?? 0;
  assert.deepEqual([count('COST_REQUIRED'), count('MIN_PRICE_MISSING'), count('STRATEGY_MISSING')], [DEMO_OFFERS - WITH_COST, DEMO_OFFERS, DEMO_OFFERS],
    `причины отказа сосчитаны по коду: ${JSON.stringify(earlyView.byCode)}`);
  assert.ok(earlyView.byCode.every((c) => c.title.length > 0 && c.title !== c.code), `у каждой причины есть название из словаря: ${JSON.stringify(earlyView.byCode)}`);
  assert.equal(earlyView.examples.length, 50, 'поимённо — первые пятьдесят');
  for (const e of earlyView.examples) {
    assert.match(e.label, /Kaufland/, `предложение названо так же, как в списке товаров, а не идентификатором: ${e.label}`);
    assert.ok(e.reasons.length > 0 && e.reasons.every((r) => r.length > 20 && !/^[A-Z_]+$/.test(r)), `причины — словами: ${JSON.stringify(e.reasons)}`);
  }
  const stillOff = (await onboarding()).steps.find((s) => s.step === 'ENABLE')!;
  assert.equal(stillOff.doneCount, 0, 'отказанное включение ничего не включило');
  const narrowed = await measure<{ narrowedTo: number }>('onboarding/narrow', 'POST', api(DEMO_WORLD, 'onboarding', 'narrow'), { toOffersWithCost: true });
  assert.deepEqual([narrowed.status, narrowed.body.narrowedTo], [200, WITH_COST]);
  view = await onboarding();
  assert.equal(view.resumeAt, 'BOUNDS', `после сужения путь продолжается с границ: ${view.resumeText}`);
  assert.equal(view.narrowing?.narrowedTo, WITH_COST);

  // Шаг 4: границы у набора — экран различий заданием, применение со вторым фактором [Р-88]
  const products = await call('GET', api(DEMO_WORLD, 'products') + '?limit=200');
  const rows = (JSON.parse(products.text) as { rows: Array<{ unit: { writeScopeId: string; externalUnitId: string } }> }).rows;
  const chosen = rows.filter((r) => skus.includes(r.unit.externalUnitId)).map((r) => r.unit.writeScopeId);
  assert.ok(chosen.every((id) => typeof id === 'string' && id.length > 0), 'у каждого предложения набора есть идентификатор');
  assert.equal(chosen.length, WITH_COST, `идентификаторы набора найдены по артикулам: ${chosen.length}`);
  const boundsRequest = { request: { writeScopeIds: chosen, min: { kind: 'SET', minor: 1200 }, max: { kind: 'SET', minor: 3000 } } };
  const planJob = await runJob('bounds/plan (набор 150)', DEMO_WORLD, api(DEMO_WORLD, 'bounds', 'plan'), boundsRequest);
  const diff = (planJob.result as { view: BoundsDiffView }).view;
  const weakApply = await call('POST', api(DEMO_WORLD, 'bounds', 'apply'), { planJobId: planJob.jobId, planToken: diff.planToken, confirmed: true }, passwordOnly);
  assert.equal(weakApply.status, 403, 'массовая правка границ одним паролем не проходит [Р-88]');
  await runJob('bounds/apply (набор 150)', DEMO_WORLD, api(DEMO_WORLD, 'bounds', 'apply'), { planJobId: planJob.jobId, planToken: diff.planToken, confirmed: true });
  view = await onboarding();
  assert.equal(view.resumeAt, 'STRATEGY', `границы поставлены — дальше стратегия: ${view.resumeText}`);

  // Шаг 5: стратегия с предпросмотром по всему набору, сохранение сверяется с ЭТИМ предпросмотром
  const draft = { name: 'Демо: подрезать Buy Box', params: { type: 'MATCH_BUYBOX', undercutMinor: 5, holdWhenWinning: true, atBound: 'CAP' } };
  const previewJob = await runJob('strategies/preview (набор 150)', DEMO_WORLD, api(DEMO_WORLD, 'strategies', 'preview'), { draft, writeScopeIds: chosen });
  const preview = (previewJob.result as { view: StrategyPreviewView }).view;
  assert.equal(preview.sample.total, WITH_COST, 'предпросмотр посчитан по всему набору');
  await runJob('strategies (назначение набору)', DEMO_WORLD, api(DEMO_WORLD, 'strategies'), { draft, writeScopeIds: chosen, previewJobId: previewJob.jobId, previewToken: preview.previewToken, confirmed: true });
  view = await onboarding();
  assert.equal(view.resumeAt, 'ENABLE', `стратегия назначена — остаётся включить: ${view.resumeText}`);
  assert.equal(view.enableCount, WITH_COST);

  // Шаг 6: включение — задание со своим правом [Р-143]; ни одно предложение набора не отказано
  const enableJob = await runJob('onboarding/enable (набор 150)', DEMO_WORLD, api(DEMO_WORLD, 'onboarding', 'enable'), {});
  const enableView = (enableJob.result as { view: EnableResultView }).view;
  assert.deepEqual([enableView.enabled, enableView.skipped], [WITH_COST, 0], `включены все; отказы по причинам: ${JSON.stringify(enableView.byCode)}`);
  view = await onboarding();
  const enable = view.steps.find((s) => s.step === 'ENABLE')!;
  assert.deepEqual([enable.done, enable.doneCount], [true, WITH_COST], `включены все предложения набора: ${JSON.stringify(enable)}`);
  assert.equal(view.resumeAt, 'DONE', `путь пройден: ${view.resumeText}`);
  // Отметки «путь пройден» нет и быть не должно: маршрут, ставивший галочку, удалён (ревью шага 34, находка 6)
  assert.equal((await call('POST', api(DEMO_WORLD, 'onboarding', 'step'), { step: 'DONE' })).status, 404, 'галочку «готово» поставить нельзя');
  view = await onboarding();
  assert.deepEqual(view.steps.map((s) => s.done), [true, true, true, true, true, true], 'все шаги выведены из данных как завершённые');
  // Хранится ровно одно — сужение набора, и оно в БАЗЕ: строка прогресса читается наблюдателем, а не тем же кодом консоли
  const stored = await observer.query(`SELECT cardinality(scope_write_scope_ids) AS n, updated_by_membership_id FROM tenant_data.onboarding_progress WHERE tenant_id = $1`, [demo.live.seeded.tenantId]);
  assert.deepEqual(stored.rows.map((r) => [Number(r.n), r.updated_by_membership_id]), [[WITH_COST, demo.live.seeded.ownerMembershipId]], 'сужение записано в базе от имени владельца');
  // Признак демо — тоже из базы: столбец, а не настройка стенда (ревью шага 34, находка 4)
  const flag = await observer.query(`SELECT demo FROM tenant_data.tenant WHERE tenant_id = $1`, [demo.live.seeded.tenantId]);
  assert.equal(flag.rows[0]?.demo, true, 'тенант помечен демо в базе');

  // Р-136: ни один экран не вышел за предел
  for (const op of measured) {
    if (op.status !== 200) continue;
    const limit = / \(задание целиком\)$/.test(op.operation) ? APPLY_LIMIT_SECONDS : SCREEN_LIMIT_SECONDS;
    assert.ok(op.seconds <= limit, `${op.operation}: ${op.seconds} с при пределе ${limit}`);
  }
});

test('Р-151: два виртуальных часа демо — первые решения с объяснением, все пять шагов «почему эта цена» на демо-данных', async () => {
  const started = Date.now();
  await demo.advance(2);
  measured.push({ operation: 'demo.advance (2 виртуальных часа планировщиком)', seconds: Math.round((Date.now() - started) / 100) / 10, bytes: 0, status: 200, note: '' });

  const list = await measure<{ items: Array<{ decisionId: string; tone: string }>; page: { total: number } }>('decisions (после двух часов, страница)', 'GET', api(DEMO_WORLD, 'decisions') + '?limit=200');
  assert.equal(list.status, 200);
  const items = list.body.items;
  // Список — страница [Р-136]: первая редакция отдавала все 13 500 решений одним ответом в 5,8 МБ
  assert.ok(list.body.page.total > items.length, `решений больше, чем на странице: ${list.body.page.total} против ${items.length}`);
  /**
   * Числа доказательства УТВЕРЖДАЮТСЯ, а не печатаются (ревью шага 34, находка 10): первая редакция заворачивала запросы
   * наблюдателя в `catch` и подставляла текст ошибки вместо строки. Пороги — нижние границы с запасом в несколько раз от
   * замера (9000 решений, 756 применённых записей), чтобы не краснеть от случайного блуждания цен.
   */
  const runs = await observer.query(
    `SELECT job_name, count(*)::int AS runs, count(*) FILTER (WHERE outcome = 'FAILED')::int AS failed, coalesce(sum(items), 0)::int AS items
       FROM maintenance.scheduled_job_run GROUP BY 1 ORDER BY 1`);
  const decided = await observer.query(`SELECT count(*)::int AS n FROM channel_data.price_decision WHERE tenant_id = $1`, [demo.live.seeded.tenantId]);
  const written = await observer.query(
    `SELECT final_status, count(*)::int AS n FROM tenant_data.channel_write_history WHERE tenant_id = $1 GROUP BY 1 ORDER BY 1`, [demo.live.seeded.tenantId]);
  console.log(JSON.stringify({ virtualHours: 2, jobRuns: runs.rows, channelRequests: [...demo.live.requests], decisionsInDb: decided.rows[0], writes: written.rows, decisionsOnScreen: list.body.page.total }, null, 1));
  assert.ok(items.length > 0, 'за два виртуальных часа движок принял хотя бы одно решение');
  assert.ok(Number(decided.rows[0]!.n) >= 2000, `решений за два часа на 150 предложениях: ${decided.rows[0]!.n}`);
  assert.equal(list.body.page.total, Number(decided.rows[0]!.n), 'экран считает те же решения, что лежат в базе');
  // «Применено» — это подтверждение канала обратным чтением, а не отправленный запрос
  const applied = Number(written.rows.find((r) => r.final_status === 'APPLIED')?.n ?? 0);
  assert.ok(applied >= 100, `записей цены, подтверждённых каналом: ${JSON.stringify(written.rows)}`);
  // Планировщик отработал без провалов — кроме выгрузки суток: ClickHouse в демо нет, и это названо в самом мире
  const polled = runs.rows.find((r) => r.job_name === 'competitor-poll');
  assert.ok(polled && Number(polled.runs) >= 100, `опрос конкурентов шёл: ${JSON.stringify(polled)}`);
  // OQ-216: обход предложений состоялся и ДОШЁЛ до конца — все 200 предложений, а не ноль после отказа бюджета
  const discovery = runs.rows.find((r) => r.job_name === 'offer-discovery');
  assert.ok(discovery && Number(discovery.failed) === 0 && Number(discovery.items) >= DEMO_OFFERS, `обход предложений: ${JSON.stringify(discovery)}`);
  const failures = await observer.query(`SELECT job_name, error_code, count(*)::int AS n FROM maintenance.scheduled_job_run WHERE outcome = 'FAILED' GROUP BY 1, 2 ORDER BY 1`);
  /**
   * Допущен ОДИН провал, поимённо и с кодом: выгрузка суток — ClickHouse в демо нет. Обход предложений проваливался здесь
   * на шаге 34 (OQ-216: опрос конкурентов забирал клиентский бюджет адаптера, и обход получал RATE_LIMITED вместо ожидания);
   * с шага 35 путь решения ждёт до `retryAt`, и провала быть не должно — это и утверждается.
   */
  const KNOWN = new Set(['analytics-export-day|CLICKHOUSE_NOT_IN_DEMO']);
  assert.deepEqual(failures.rows.filter((r) => !KNOWN.has(`${r.job_name}|${r.error_code}`)), [], `провалы работ планировщика: ${JSON.stringify(failures.rows)}`);
  // Р-151: у предложения РОВНО три конкурента — считается по самому симулятору, а не по описанию сценария
  const rivals = demo.live.simulator.offersOf('de|340100001|new').filter((o) => !o.self);
  assert.equal(rivals.length, DEMO_COMPETITORS_PER_OFFER, `конкуренты предложения: ${rivals.map((o) => o.sellerRef).join(', ')}`);

  // Путь настоящий до конца: решения доходят до канала записью цены, а не остаются в базе
  const writes = [...demo.live.requests].filter(([route]) => /^(PATCH|POST) \/v2\/units/.test(route)).reduce((n, [, count]) => n + count, 0);
  assert.ok(writes > 0, `движок писал цены в канал (симулятор): ${JSON.stringify([...demo.live.requests])}`);
  assert.deepEqual(demo.live.violations, [], 'симулятор не зафиксировал нарушений протокола канала');

  const FIVE = ['SNAPSHOT', 'SANITY', 'ANCHORS', 'STRATEGY', 'GATE'];
  let explained = 0;
  // У решения без изменения цены слепка объяснения нет и быть не должно [Р-74] — объясняются решения, изменившие цену
  /**
   * Решения, изменившие цену, — не обязательно на первой странице: свежие решения почти все «без изменения». Продавец
   * листает; прогон делает то же — теми же запросами страниц, пока не наберёт решений для проверки.
   */
  const changed: Array<{ decisionId: string }> = items.filter((x) => x.tone !== 'off');
  for (let offset = 200; changed.length < 25 && offset < list.body.page.total; offset += 200) {
    const next = await measure<typeof list.body>('decisions (следующая страница)', 'GET', `${api(DEMO_WORLD, 'decisions')}?limit=200&offset=${offset}`);
    assert.equal(next.status, 200);
    changed.push(...next.body.items.filter((x) => x.tone !== 'off'));
  }
  assert.ok(changed.length > 0, 'среди решений есть изменившие цену');
  for (const d of changed.slice(0, 25)) {
    const trace = await measure<{ steps: Array<{ key: string; status: string; summary: string; items: unknown[] }>; gaps: Array<{ code: string }> }>(
      'decisions/:id (почему эта цена)', 'GET', api(DEMO_WORLD, 'decisions', d.decisionId));
    assert.equal(trace.status, 200);
    const steps = new Map(trace.body.steps.map((s) => [s.key, s]));
    if (steps.get('SNAPSHOT')?.status === 'SKIPPED') continue; // решение не из данных конкурентов: три шага не применимы
    explained += 1;
    for (const key of FIVE) {
      const step = steps.get(key);
      assert.ok(step, `${d.decisionId}: шага ${key} нет`);
      assert.notEqual(step.status, 'UNKNOWN', `${d.decisionId}: ${key} говорит «нет данных» — ${step.summary}`);
    }
    assert.ok(!trace.body.gaps.some((g) => g.code === 'EXPLANATION_DICTIONARY_MISSING'), 'объяснение ссылается на существующий справочник');
  }
  assert.ok(explained > 0, 'хотя бы одно решение принято по данным конкурентов и объяснено всеми пятью шагами');

  /**
   * Р-151: «помечен везде, где показываются деньги» — включая ФАЙЛЫ (ревью шага 34, находка 4). Выгрузка живёт дольше экрана:
   * её пересылают и переименовывают, поэтому метка стоит и в имени, и в каждой строке.
   */
  const exported = await runJob('feed/export (демо)', DEMO_WORLD, api(DEMO_WORLD, 'feed', 'export'), {});
  assert.ok(exported.artifact, 'у выгрузки есть файл');
  assert.ok(exported.artifact.fileName.startsWith(DEMO_FILE_PREFIX), `имя файла демо-тенанта помечено: ${exported.artifact.fileName}`);
  const fileResponse = await call('GET', api(DEMO_WORLD, 'jobs', `${exported.jobId}/artifact`));
  assert.equal(fileResponse.status, 200, fileResponse.text.slice(0, 200));
  const lines = fileResponse.text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.length > 0);
  assert.ok(lines.length > 1, `в ленте демо есть записи цен: ${lines.length - 1}`);
  assert.match(lines[0]!, /demo"?$/, `заголовок несёт колонку метки: ${lines[0]}`);
  const unmarked = lines.slice(1).filter((l) => !l.includes(DEMO_ROW_MARK));
  assert.deepEqual(unmarked.slice(0, 3), [], `каждая строка файла помечена как демо; без метки: ${unmarked.length}`);
});
