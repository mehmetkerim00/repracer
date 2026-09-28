import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';

import type { AdapterDependencies } from '@repracer/channel-port';
import { loadKeyring } from '@repracer/channel-oauth';
import { ModelOAuthProvider } from '@repracer/channel-oauth/model';
import type { BulkJobView, ConnectionsView, CostImportView, BoundsDiffView, EnableResultView, OnboardingView, StrategyPreviewView } from '@repracer/console-model';
import { createEbayAdapter, EBAY_DESCRIPTOR, TokenBucket } from '@repracer/ebay-adapter';
import { nextNineUtc, VirtualClock } from '@repracer/contract-tests/live';
import { channelFetch, SimulatedEbayChannel, type TraceEntry } from '@repracer/contract-tests/simulator';
import { FakeMail } from '@repracer/alert-delivery/testing';
import { startModelIdentityProvider, type ModelIdentityProvider } from '@repracer/identity/test-provider';
import { createPricingPipeline } from '@repracer/pricing-pipeline';
import { createPool, PgPricingStore, PgWriteQueueStore, type PgPool } from '@repracer/pricing-store-pg';
import { createWriteDispatcher, type WriteDispatcher } from '@repracer/write-dispatcher';
import { createScheduler, jobSource, PgSchedulerState, pgJobDeps, runScheduler, type JobDeps } from '@repracer/scheduler';
import { channelCredentialsProvider, EBAY_APPLICATION_REF, EBAY_IDENTITY_SCOPE, pgAccountDirectory } from '@repracer/service-runtime';
import { startOperatorPanel, type RunningPanel } from '../../operator/server/operator-service.ts';
import type { JobCreatedResponse, SessionView, WorldSummary } from '../src/api-types.ts';
import { beginLogin, finishLogin } from '../src/oidc.ts';
import { createIsolatedDatabase, type IsolatedDatabase, type TestRole } from '../../../packages/pricing-store-pg/test/isolated-db.ts';
import { startConsole, type RunningConsole } from '../server/console-service.ts';
import { CONSOLE_ROLES } from '../server/config.ts';
import { ID_TOKEN_HEADER } from '../src/api.ts';

/**
 * Шаг 47, задача D: полный путь пилота с каналом eBay одним живым прогоном через HTTP как браузер [Р-179, Р-136, Р-142]:
 * оператор в панели заводит тенанта → приглашение → владелец входит у поставщика identity (код с PKCE) и принимает его →
 * онбординг «остатки + репрайсинг» → Connect eBay (модель поставщика OAuth eBay: согласие, обмен кода, Commerce Identity
 * называет продавца, E-11) → аккаунт в тени → первый такт планировщика: обнаружение НАСТОЯЩИМ адаптером eBay против модели
 * канала eBay [Р-187] — листинги под Inventory API, старая фиксированная цена и аукцион → каталог ACTIVE / MIGRATION_REQUIRED /
 * INELIGIBLE → себестоимость, границы, фиксированная стратегия (стратегий по конкурентам у eBay нет, Р-39), включение заданиями
 * исполнителя → час виртуального времени в тени → решения есть, все записи SHADOW_HELD, до модели eBay не дошло ни одной записи.
 *
 * Консоль — промышленная проводка `startConsole` в режиме стенда [Р-181]; модель поставщика eBay отвечает на петле
 * (`REPRACER_EBAY_OAUTH_BASE`, принимается только в режиме стенда). Адаптер, планировщик и диспетчер собраны из тех же
 * частей, что процессы services/scheduler и services/pricing-worker: учётные данные — channelCredentialsProvider со ссылкой
 * EBAY_APPLICATION_REF и refresh-токен продавца из хранилища (`db:`), каталог аккаунтов — pgAccountDirectory. Данные синтетические.
 */

const SELLER = 'syn_ebay_pilot_47';
const MANAGED = 8;
const SCREEN_LIMIT_SECONDS = 10;
const JOB_LIMIT_SECONDS = 120;
const TENANT_NAME = 'Pilot eBay Händler GmbH';
const OWNER_EMAIL = 'pilot-ebay-owner@example.test';
const OPERATOR_SUBJECT = 'pilot-ebay-operator';
const CONSOLE_AUDIENCE = 'repracer-console';
const OPERATOR_AUDIENCE = 'repracer-operator';
const EBAY_CLIENT_ID = 'Syn-Repracer-SBX-pilot47';
const EBAY_CLIENT_SECRET = 'SBX-syn-pilot47-client-secret';
const EBAY_SCOPES = ['https://api.ebay.com/oauth/api_scope', 'https://api.ebay.com/oauth/api_scope/sell.inventory', 'https://api.ebay.com/oauth/api_scope/sell.account', EBAY_IDENTITY_SCOPE];
const KEYRING = JSON.stringify({ current: 'k-pilot-ebay', keys: { 'k-pilot-ebay': Buffer.alloc(32, 47).toString('base64') } });

/** Листинг n модели eBay: 1400000000nn, предложение 94000000nn, SKU SYN-EBAY-PILOT-nn */
const L = (n: number) => ({ listingId: `1400000000${String(n).padStart(2, '0')}`, offerId: `94000000${String(n).padStart(2, '0')}`, sku: `SYN-EBAY-PILOT-${String(n).padStart(2, '0')}` });

let db: IsolatedDatabase;
let provider: ModelIdentityProvider;
let panel: RunningPanel;
let consoleProcess: RunningConsole;
let ebayOauthServer: HttpServer;
let consoleOrigin = '';
let observer: PgPool;
let ebayOauth: ModelOAuthProvider;
let deps: JobDeps;
let clock: VirtualClock;
let channel: SimulatedEbayChannel;
let adapter: ReturnType<typeof createEbayAdapter>;
let dispatcher: WriteDispatcher;
let worker: ChildProcess | null = null;
const channelTrace: TraceEntry[] = [];
const channelViolations: string[] = [];
const adapterLogs: string[] = [];
const mail = new FakeMail();
const clients: Record<string, { redirectUris: string[]; audience: string }> = {};
const journey: Array<{ step: string; seconds: number; status?: number; note?: string }> = [];
const ids = { tenantId: '', accountId: '' };
type Tokens = { access: string; id: string | null };
let owner: Tokens = { access: '', id: null };

const worldId = () => `tenant-${ids.tenantId}`;
const api = (screen: string, param?: string) => `/api/worlds/${encodeURIComponent(worldId())}/${screen}${param ? `/${param}` : ''}`;

async function http<T>(step: string, base: string, method: 'GET' | 'POST', url: string, body?: unknown, token: Tokens | string = owner): Promise<{ status: number; body: T }> {
  const started = process.hrtime.bigint();
  const t = typeof token === 'string' ? { access: token, id: null } : token;
  const r = await fetch(`${base}${url}`, {
    method, headers: { ...(t.access ? { authorization: `Bearer ${t.access}` } : {}), ...(t.id ? { [ID_TOKEN_HEADER]: t.id } : {}),
      cookie: 'repracer_locale=en', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await r.text();
  const seconds = Math.round(Number(process.hrtime.bigint() - started) / 1e6) / 1000;
  journey.push({ step, seconds, status: r.status });
  assert.ok(seconds < SCREEN_LIMIT_SECONDS, `${step}: ${seconds} с при пределе экрана ${SCREEN_LIMIT_SECONDS} с`);
  let parsed: unknown = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: r.status, body: parsed as T };
}
const consoleCall = <T>(step: string, method: 'GET' | 'POST', url: string, body?: unknown) => http<T>(step, consoleOrigin, method, url, body);

async function timed<T>(step: string, fn: () => Promise<T>, note?: string): Promise<T> {
  const started = process.hrtime.bigint();
  const out = await fn();
  journey.push({ step, seconds: Math.round(Number(process.hrtime.bigint() - started) / 1e6) / 1000, ...(note ? { note } : {}) });
  return out;
}

type LoginModule = { beginLogin: typeof beginLogin; finishLogin: typeof finishLogin };
async function signIn(cfg: { issuer: string; clientId: string; scope: string }, redirectUri: string, user: { subject: string; email: string; amr: string[] },
  module: LoginModule = { beginLogin, finishLogin }): Promise<Tokens> {
  const { url, pending } = await module.beginLogin(cfg, redirectUri, provider.fetch as never);
  provider.signInAs(user);
  const r = await fetch(url, { redirect: 'manual' });
  assert.equal(r.status, 302, 'поставщик возвращает браузер с кодом');
  const back = new URL(r.headers.get('location')!);
  assert.equal(back.origin + back.pathname, redirectUri);
  const t = await module.finishLogin(cfg, { code: back.searchParams.get('code'), state: back.searchParams.get('state') }, pending, provider.fetch as never);
  return { access: t.accessToken, id: t.idToken };
}

async function freePort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port: p } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return p;
}

async function job(step: string, url: string, body: unknown): Promise<BulkJobView> {
  const created = await consoleCall<JobCreatedResponse & { error?: { message: string } }>(`${step}: создать задание`, 'POST', url, body);
  assert.equal(created.status, 200, `${step}: ${JSON.stringify(created.body).slice(0, 300)}`);
  return timed(`${step}: задание целиком`, async () => {
    const deadline = Date.now() + JOB_LIMIT_SECONDS * 1000;
    for (;;) {
      const r = await fetch(`${consoleOrigin}${api('jobs', created.body.jobId)}`, { headers: { authorization: `Bearer ${owner.access}`, ...(owner.id ? { [ID_TOKEN_HEADER]: owner.id } : {}), cookie: 'repracer_locale=en' } });
      const j = await r.json() as BulkJobView;
      if (j.status === 'SUCCEEDED' || j.status === 'FAILED') {
        assert.equal(j.status, 'SUCCEEDED', `${step}: ${j.error ?? j.headline}`);
        return j;
      }
      if (Date.now() > deadline) throw new Error(`${step}: задание ${j.status} дольше ${JOB_LIMIT_SECONDS} с`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  });
}

async function schedulerFor(minutes: number): Promise<void> {
  const endMs = clock.nowMs() + minutes * 60_000;
  const scheduler = createScheduler({
    state: new PgSchedulerState(db.pool('svc_scheduler', 2)), source: jobSource(deps), owner: 'pilot-ebay-47', now: () => clock.iso(),
    alerts: { raise: async () => undefined },
  });
  const running = runScheduler(scheduler, {
    tickMs: 30_000, clockMs: () => clock.nowMs(), logger: { log: () => undefined },
    sleep: async (ms) => {
      await clock.sleep(ms);
      // Диспетчер записей — как процесс worker в работе: в тени ему отправлять нечего, и это утверждается ниже
      await dispatcher.sweep({ pendingMinAgeMs: 0 });
    },
    shouldStop: () => clock.nowMs() >= endMs,
  });
  await running.finished;
}

/** Запросы, дошедшие до модели eBay, по маршрутам — чтения и записи раздельно */
const routes = () => channel.stats.requests;
const writeRequests = () => (routes()['POST /sell/inventory/v1/bulk_update_price_quantity'] ?? 0) + (routes()['POST /sell/inventory/v1/bulk_migrate_listing'] ?? 0);

before(async () => {
  db = await createIsolatedDatabase('pilot47ebay');
  /**
   * Р-188: граница суток EBAY_DE в шаблоне — TO_VERIFY (Р-65, OQ-112), и прогон её НЕ подтверждает. До Р-188 база отказывала
   * даже теневой записи с бюджетом правок, и прогон подтверждал границу суперпользователем — склейка против Р-179. Теперь
   * теневая запись создаётся без дня бюджета, а бой на такой витрине закрыт (утверждается в конце прогона).
   */
  const appPool: PgPool = db.pool('svc_app', 4);
  const adminPool: PgPool = db.pool('svc_admin', 4);
  clock = new VirtualClock(nextNineUtc());
  provider = await startModelIdentityProvider({ clients, issuer: 'https://identity.pilot-ebay.repracer.test' });
  await db.superuser(
    `INSERT INTO platform.platform_operator (operator_id, tenant_id, issuer, subject, display_name, active)
     VALUES (gen_random_uuid(), security.platform_tenant_id(), $1, $2, 'Operator im eBay-Pilotlauf', true)`, [provider.issuer, OPERATOR_SUBJECT]);

  const consolePort = await freePort();
  consoleOrigin = `http://127.0.0.1:${consolePort}`;
  clients['console-spa'] = { redirectUris: [`${consoleOrigin}/auth/callback`], audience: CONSOLE_AUDIENCE };
  // У eBay адрес возврата — имя RuName приложения; модель поставщика возвращает браузер на адрес возврата консоли
  const ruName = `${consoleOrigin}/connect/callback`;
  ebayOauth = new ModelOAuthProvider({ channel: 'EBAY', clientId: EBAY_CLIENT_ID, clientSecret: EBAY_CLIENT_SECRET, redirectUri: ruName, now: () => Date.now() });
  // Модель поставщика eBay по HTTP: обмен кода и Commerce Identity (E-11) — консоль ходит к ней обычным fetch
  ebayOauthServer = createHttpServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const out = await ebayOauth.fetch(req.url ?? '/', { method: req.method ?? 'POST', headers: req.headers as Record<string, string>, body: Buffer.concat(chunks).toString('utf8') });
    res.writeHead(out.status, { 'content-type': 'application/json' });
    res.end(await out.text());
  });
  await new Promise<void>((resolve) => ebayOauthServer.listen(0, '127.0.0.1', resolve));
  const dist = mkdtempSync(join(tmpdir(), 'repracer-pilot-ebay-dist-'));
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>repracer</title>', 'utf8');
  const roleUrls = Object.fromEntries(CONSOLE_ROLES.map((r) => [`REPRACER_CONSOLE_${r.toUpperCase()}_PG_URL`, db.url(`svc_${r}` as TestRole)]));
  consoleProcess = await startConsole({
    REPRACER_MODE: 'stand', REPRACER_CONSOLE_PORT: String(consolePort), REPRACER_CONSOLE_METRICS_PORT: '0', REPRACER_CONSOLE_DIST: dist,
    REPRACER_CONSOLE_PUBLIC_DEMO: 'off', REPRACER_CONSOLE_HEARTBEAT: 'off', ...roleUrls,
    REPRACER_CONSOLE_OIDC_ISSUER: provider.issuer, REPRACER_CONSOLE_OIDC_AUDIENCE: CONSOLE_AUDIENCE, REPRACER_CONSOLE_OIDC_JWKS_URL: provider.jwksUrl,
    REPRACER_CONSOLE_OIDC_CLIENT_ID: 'console-spa', REPRACER_CONSOLE_OIDC_DISCOVERY_BASE: provider.origin,
    REPRACER_EBAY_ENVIRONMENT: 'SANDBOX', REPRACER_EBAY_CLIENT_ID: EBAY_CLIENT_ID, REPRACER_EBAY_CLIENT_SECRET: EBAY_CLIENT_SECRET,
    REPRACER_EBAY_RUNAME: ruName, REPRACER_EBAY_SCOPES: EBAY_SCOPES.join(' '), REPRACER_EBAY_ACCOUNT_DELETION: 'registered',
    REPRACER_EBAY_OAUTH_BASE: `http://127.0.0.1:${(ebayOauthServer.address() as AddressInfo).port}`,
    REPRACER_CHANNEL_KEYRING: KEYRING, REPRACER_CONNECT_REDIRECT_URL: ruName,
  });

  panel = await startOperatorPanel({
    REPRACER_MODE: 'stand', REPRACER_OPERATOR_PORT: '0', REPRACER_OPERATOR_METRICS_PORT: '0',
    REPRACER_OPERATOR_PG_URL: db.url('svc_operator'),
    REPRACER_OPERATOR_OIDC_ISSUER: provider.issuer, REPRACER_OPERATOR_OIDC_AUDIENCE: OPERATOR_AUDIENCE, REPRACER_OPERATOR_OIDC_JWKS_URL: provider.jwksUrl,
    REPRACER_OPERATOR_OIDC_CLIENT_ID: 'operator-panel',
    REPRACER_OPERATOR_INVITATION_URL: `${consoleOrigin}/invite`, REPRACER_OPERATOR_HEARTBEAT: 'off',
  }, { mail });
  clients['operator-panel'] = { redirectUris: [`http://127.0.0.1:${panel.port}/auth/callback`], audience: OPERATOR_AUDIENCE };

  // Канал: модель eBay [Р-187] — 8 листингов под Inventory API, старая фиксированная цена и аукцион продавца
  channel = new SimulatedEbayChannel({
    seed: 4700,
    listings: [
      ...Array.from({ length: MANAGED }, (_, i) => ({ ...L(i + 1), marketplace: 'EBAY_DE' as const, priceMinor: 1149 + i * 10, quantity: 5 })),
      { ...L(20), offerId: undefined, marketplace: 'EBAY_DE' as const, priceMinor: 1499, quantity: 4, bestOffer: true },
      { ...L(21), offerId: undefined, marketplace: 'EBAY_DE' as const, priceMinor: 500, quantity: 1, format: 'AUCTION' as const },
    ],
  }, clock.iso(), { user: 'syn-pilot-ebay-user-token', application: 'syn-pilot-ebay-app-token' });

  /**
   * Адаптер — как в services/scheduler и services/pricing-worker: createEbayAdapter с ключами приложения по EBAY_APPLICATION_REF
   * и refresh-токеном продавца из хранилища (ссылка `db:` аккаунта, роль адаптеров и кольцо ключей процесса). Сеть — модель канала.
   */
  const adapterDeps: AdapterDependencies = {
    accounts: pgAccountDirectory(appPool),
    credentials: channelCredentialsProvider({
      files: { async get() { return {}; } },
      vault: { pool: db.pool('svc_credentials', 2), keyring: loadKeyring(KEYRING) },
      amazonApplication: null,
      ebayApplication: { ref: EBAY_APPLICATION_REF, clientId: EBAY_CLIENT_ID, clientSecret: EBAY_CLIENT_SECRET },
    }),
    alerts: { async raise() {} }, logger: { log: (e) => { adapterLogs.push(e.code); } }, now: () => clock.iso(),
  };
  adapter = createEbayAdapter({
    deps: adapterDeps, environment: 'SANDBOX', applicationCredentialsRef: EBAY_APPLICATION_REF, scopes: EBAY_SCOPES,
    fetch: channelFetch(channel, () => [], clock, channelViolations, channelTrace), sleep: clock.sleep, timeoutMs: 5_000,
    // Клиентский бюджет (EBAY_C01) — на реальных часах; прогон идёт по виртуальным, и бюджет не должен подменять собой поведение канала
    requestBudget: new TokenBucket({ ratePerSecond: 1_000, burst: 1_000 }),
  });
  const writeQueue = new PgWriteQueueStore(appPool, { scanPool: db.pool('svc_dispatcher', 2) });
  dispatcher = createWriteDispatcher({
    store: {
      claimNext: writeQueue.claimNext.bind(writeQueue), recordOutcome: writeQueue.recordOutcome.bind(writeQueue),
      recordReconciliation: writeQueue.recordReconciliation.bind(writeQueue), checkPriceBasis: writeQueue.checkPriceBasis.bind(writeQueue), recordEbayBatchOutcome: writeQueue.recordEbayBatchOutcome.bind(writeQueue),
      dueScopes: async (at: Parameters<typeof writeQueue.dueScopes>[0], o: Parameters<typeof writeQueue.dueScopes>[1]) => (await writeQueue.dueScopes(at, o)).filter((d) => d.tenantId === ids.tenantId),
    } as never,
    adapterFor: () => adapter, alerts: { async raise() {} }, now: () => clock.iso(),
  });
  const pipeline = createPricingPipeline({
    store: new PgPricingStore(appPool, { adminPool }), adapter, alerts: { async raise() {} }, logger: { log() {} }, now: () => clock.iso(), dispatcher,
  });
  const base = pgJobDeps({
    schedulerPool: db.pool('svc_scheduler', 2), exporterPool: db.pool('svc_exporter', 1), ingest: null as never, verifier: null as never,
    descriptorOf: (c) => (c === 'EBAY' ? EBAY_DESCRIPTOR : null), pipelineFor: () => pipeline, reconcileEnabled: () => false,
  });
  deps = { ...base, accounts: async () => (await base.accounts()).filter((a) => a.tenantId === ids.tenantId), exportDay: async () => { throw new Error('CLICKHOUSE_NOT_IN_RUN'); } };

  worker = spawn(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', fileURLToPath(new URL('../server/bulk-worker.ts', import.meta.url))], {
    env: { ...process.env, BULK_WORKER_CONFIG: '', REPRACER_MODE: 'stand', REPRACER_BULK_HEARTBEAT: 'off', REPRACER_BULK_METRICS_PORT: '0', REPRACER_BULK_POLL_MS: '200', REPRACER_BULK_IDLE_MS: '100',
      REPRACER_BULK_APP_PG_URL: db.url('svc_app'), REPRACER_BULK_ADMIN_PG_URL: db.url('svc_admin'), REPRACER_BULK_BULK_WORKER_PG_URL: db.url('svc_bulk_worker'), REPRACER_BULK_STOCK_PG_URL: db.url('svc_stock') },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  worker.stderr?.on('data', (chunk: Buffer) => console.error('bulk-worker:', chunk.toString().trim()));

  const observerUrl = new URL(process.env.REPRACER_PG_ADMIN_URL!); observerUrl.pathname = `/${db.name}`;
  observer = createPool(observerUrl.toString(), { max: 1, applicationName: 'repracer-pilot-ebay-observer' });
});

after(async () => {
  const total = journey.reduce((n, j) => n + j.seconds, 0);
  const screens = journey.filter((j) => j.status !== undefined);
  console.log(JSON.stringify({ pilotEbay: { journey, totalSeconds: Math.round(total * 1000) / 1000,
    maxScreenSeconds: Math.max(...screens.map((j) => j.seconds)), channelRequests: channel?.stats.requests, violations: channelViolations } }, null, 1));
  const exited = worker && worker.exitCode === null ? new Promise<number | null>((resolve) => worker!.once('exit', (code) => resolve(code))) : Promise.resolve(worker?.exitCode ?? null);
  worker?.kill('SIGTERM');
  const code = await Promise.race([exited, new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 15_000))]);
  if (code === 'hung') worker?.kill('SIGKILL');
  assert.notEqual(code, 'hung', 'исполнитель заданий вышел по SIGTERM');
  await consoleProcess?.close();
  ebayOauthServer?.close();
  await panel?.close();
  await provider?.close();
  await observer?.end();
  await db?.drop();
});

test('шаг 47, D: путь пилота с eBay — от оператора в панели до «почему эта цена» в тени', async () => {
  // ---------------------------------------------------------------- оператор: тенант и приглашение
  const panelOrigin = `http://127.0.0.1:${panel.port}`;
  const panelLogin = await http<{ issuer: string; clientId: string; scope: string }>('панель: где входить', panelOrigin, 'GET', '/api/operator/login-config', undefined, '');
  const panelModule = await import(`data:text/javascript,${encodeURIComponent(await (await fetch(`${panelOrigin}/oidc.js`)).text())}`) as LoginModule;
  const operator = await timed('оператор входит у поставщика со страницы панели', () => signIn(panelLogin.body, `${panelOrigin}/auth/callback`, { subject: OPERATOR_SUBJECT, email: 'operator@repracer.invalid', amr: ['pwd', 'otp'] }, panelModule));
  const created = await http<{ tenantId: string }>('панель: создать тенанта', panelOrigin, 'POST', '/api/operator/tenants', { name: TENANT_NAME, region: 'EU', ownerEmail: OWNER_EMAIL, locale: 'de' }, operator);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  ids.tenantId = created.body.tenantId;
  const invited = await http<{ invitationId: string }>('панель: пригласить владельца', panelOrigin, 'POST', `/api/operator/tenants/${ids.tenantId}/invite`, { email: OWNER_EMAIL }, operator);
  assert.equal(invited.status, 201, JSON.stringify(invited.body));
  const letter = mail.matching(TENANT_NAME)[0];
  assert.ok(letter, 'письмо приглашения ушло владельцу');
  const invitationToken = /\/invite#([A-Za-z0-9_-]+)/.exec(letter!.text)?.[1];
  assert.ok(invitationToken, 'ссылка приглашения — в письме');

  // ---------------------------------------------------------------- владелец: вход (PKCE), приём приглашения, свой мир
  const session = await consoleCall<SessionView>('консоль: страница входа', 'GET', '/api/session');
  owner = await timed('владелец входит у поставщика (код с PKCE, ID-токен)', () => signIn(session.body.oidc!, `${consoleOrigin}/auth/callback`, { subject: 'pilot-ebay-owner', email: OWNER_EMAIL, amr: ['pwd', 'otp'] }));
  assert.ok(owner.id, 'поставщик выдал ID-токен');
  const accepted = await consoleCall<{ accepted: boolean }>('консоль: принять приглашение', 'POST', '/api/invitations/accept', { token: invitationToken });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  const worlds = await consoleCall<WorldSummary[]>('консоль: мои миры', 'GET', '/api/worlds');
  assert.deepEqual(worlds.body.map((w) => [w.id, w.title, w.demo, w.scopes]), [[worldId(), TENANT_NAME, false, 0]], 'ровно один мир — свой, пустой, не демо');

  // ---------------------------------------------------------------- онбординг: путь, Connect eBay, тень нашла листинги
  const path = await consoleCall('онбординг: выбрать путь «остатки + репрайсинг»', 'POST', api('onboarding', 'path'), { path: 'STOCK_AND_PRICING' });
  assert.equal(path.status, 200, JSON.stringify(path.body));
  const before0 = await consoleCall<ConnectionsView>('экран подключений: eBay подключаем', 'GET', api('connections'));
  const ebayChannel = before0.body.channels.find((c) => c.channel === 'EBAY')!;
  assert.deepEqual([ebayChannel.canConnect, ebayChannel.missingText], [true, null], `приложение eBay платформы настроено: ${ebayChannel.stateText}`);
  const start = await consoleCall<{ consentUrl: string }>('Connect eBay', 'POST', api('connections', 'start'), { channel: 'EBAY', marketplaces: ['EBAY_DE'] });
  assert.equal(start.status, 200, JSON.stringify(start.body));
  const consent = new URL(start.body.consentUrl);
  assert.equal(consent.searchParams.get('client_id'), EBAY_CLIENT_ID);
  assert.equal(consent.searchParams.get('scope'), EBAY_SCOPES.join(' '), 'согласие спрашивает scope приложения, включая Commerce Identity (E-08, E-11)');
  const back = new URL(ebayOauth.approve(start.body.consentUrl, SELLER));
  assert.deepEqual([...back.searchParams.keys()].sort(), ['code', 'state'], 'eBay возвращает только code и state');
  const connected = await consoleCall<{ channelAccountId: string }>('возврат с кодом согласия', 'POST', api('connections', 'callback'), { params: Object.fromEntries(back.searchParams) });
  assert.equal(connected.status, 200, JSON.stringify(connected.body));
  ids.accountId = connected.body.channelAccountId;
  assert.equal(ebayOauth.stats.identities, 1, 'продавца назвал Commerce Identity API модели (E-11)');
  const { rows: [acc] } = await observer.query('SELECT external_account_id, write_mode, marketplaces, credentials_ref FROM tenant_data.channel_account WHERE channel_account_id = $1', [ids.accountId]);
  assert.deepEqual([acc.external_account_id, acc.write_mode, acc.marketplaces, acc.credentials_ref], [SELLER, 'SHADOW', ['EBAY_DE'], `db:${ids.accountId}`],
    'аккаунт назван продавцом eBay, рождён в тени [Р-176], токен — в хранилище');

  await timed('планировщик: первый такт — обнаружение листингов настоящим адаптером', () => schedulerFor(1));
  assert.equal(routes()['POST /ws/api.dll'] ?? 0, 1, 'фаза Trading (GetMyeBaySelling) прошла один раз');
  const found = await consoleCall<ConnectionsView>('экран подключений: тень нашла листинги', 'GET', api('connections'));
  const account = found.body.accounts.find((a) => a.channelAccountId === ids.accountId)!;
  assert.equal(account.state, 'SHADOW');
  assert.ok(account.offers >= MANAGED, `тень нашла листинги: ${account.offers} — ${account.progressText}`);
  // Шаг 48 (находка 9 ревью шага 47, находка 4 ревью шага 48): «нашли N» называет и то, что вести нельзя — аукцион и немигрированный
  assert.deepEqual([account.offers, account.unmanagedOffers], [MANAGED + 2, 2], `число найденных и неуправляемых: ${account.progressText}`);
  assert.match(account.progressText ?? '', new RegExp(`Found ${MANAGED + 2} offers\\..* we can write to ${MANAGED}; 2 are not open for our writes`), 'экран говорит оба числа');
  const { rows: catalog } = await observer.query<{ status: string; migration: string; format: string; n: number; scopes: number }>(
    `SELECT m.status, m.ebay_migration_status AS migration, m.ebay_listing_format AS format, count(*)::int AS n, count(m.price_write_scope_id)::int AS scopes
       FROM tenant_data.offer_mapping m WHERE m.tenant_id = $1 GROUP BY 1, 2, 3 ORDER BY 1`, [ids.tenantId]);
  assert.deepEqual(catalog, [
    { status: 'ACTIVE', migration: 'NOT_REQUIRED', format: 'FIXED_PRICE', n: MANAGED, scopes: MANAGED },
    { status: 'INELIGIBLE', migration: 'INELIGIBLE', format: 'AUCTION', n: 1, scopes: 0 },
    { status: 'MIGRATION_REQUIRED', migration: 'REQUIRED', format: 'FIXED_PRICE', n: 1, scopes: 0 },
  ], 'каталог: под Inventory API — с единицей записи; старый листинг ждёт миграции владельцем; аукцион не управляется');

  // ---------------------------------------------------------------- себестоимость, границы, стратегия, включение
  const skus = Array.from({ length: MANAGED }, (_, i) => L(i + 1).sku);
  const costCsv = ['Artikelnummer;Einstandspreis;Währung;Provision %;Fixkosten', ...skus.map((s) => `${s};5,00;EUR;11;0,00`)].join('\r\n');
  const file = { fileName: 'kosten.csv', content: Buffer.from(costCsv).toString('base64') };
  const plan = await consoleCall<CostImportView>('себестоимость: предпросмотр', 'POST', api('cost-import', 'plan'), file);
  assert.equal(plan.body.summary?.apply, MANAGED, `сопоставлены все листинги под Inventory API: ${JSON.stringify(plan.body).slice(0, 300)}`);
  await job('себестоимость: применить', api('cost-import', 'apply'), { ...file, fingerprint: plan.body.fingerprint, confirmed: true });
  const products = await consoleCall<{ rows: Array<{ unit: { writeScopeId: string } | null }> }>('товары', 'GET', `${api('products')}?limit=200`);
  const scopes = products.body.rows.flatMap((r) => (r.unit ? [r.unit.writeScopeId] : []));
  assert.equal(scopes.length, MANAGED, 'единицы записи цены — только у листингов под Inventory API');
  const boundsPlan = await job('границы: экран различий', api('bounds', 'plan'), { request: { writeScopeIds: scopes, min: { kind: 'SET', minor: 1000 }, max: { kind: 'SET', minor: 5000 } } });
  const diff = (boundsPlan.result as { view: BoundsDiffView }).view;
  await job('границы: применить', api('bounds', 'apply'), { planJobId: boundsPlan.jobId, planToken: diff.planToken, confirmed: true });
  // Р-39: у eBay нет данных конкурентов — стратегия по ним недоступна, фиксированная цена работает
  const buybox = { name: 'Pilot eBay: Buy Box', params: { type: 'MATCH_BUYBOX', undercutMinor: 5, holdWhenWinning: true, atBound: 'CAP' } };
  const refused = await job('стратегия по конкурентам: предпросмотр', api('strategies', 'preview'), { draft: buybox, writeScopeIds: scopes });
  const refusedRows = (refused.result as { view: { rows: Array<{ final: unknown; reason: { code: string } }> } }).view.rows;
  assert.equal(refusedRows.length, MANAGED);
  assert.ok(refusedRows.every((r) => r.final === null && r.reason.code === 'COMPETITOR_REQUIREMENT_NOT_MET'),
    `стратегия по конкурентам не считается ни для одного листинга eBay, и причина названа: ${JSON.stringify(refusedRows[0]).slice(0, 300)}`);
  const draft = { name: 'Pilot eBay: fixed 12.99', params: { type: 'FIXED', priceMinor: 1299 } };
  const preview = await job('стратегия: предпросмотр', api('strategies', 'preview'), { draft, writeScopeIds: scopes });
  const pv = (preview.result as { view: StrategyPreviewView }).view;
  await job('стратегия: назначить', api('strategies'), { draft, writeScopeIds: scopes, previewJobId: preview.jobId, previewToken: pv.previewToken, confirmed: true });
  const enabled = await job('включение движка', api('onboarding', 'enable'), {});
  const ev = (enabled.result as { view: EnableResultView }).view;
  assert.deepEqual([ev.enabled, ev.skipped], [MANAGED, 0], `включены все листинги под Inventory API: ${JSON.stringify(ev.byCode)}`);
  const view = (await consoleCall<OnboardingView>('онбординг после включения', 'GET', api('onboarding'))).body;
  journey.push({ step: 'онбординг: где продолжить', seconds: 0, note: `${view.resumeAt}: ${view.resumeText}` });
  // Путь «остатки + репрайсинг»: шаги остатков в этом прогоне не проходятся — онбординг честно говорит, где продолжить
  assert.equal(view.resumeAt, 'STOCK_SOURCE', view.resumeText);

  // ---------------------------------------------------------------- тень считает, «почему эта цена»
  const writesBefore = writeRequests();
  await timed('планировщик: час виртуального времени в тени', () => schedulerFor(60));
  const counting = await consoleCall<ConnectionsView>('экран подключений: тень считает', 'GET', api('connections'));
  const shadowAccount = counting.body.accounts.find((a) => a.channelAccountId === ids.accountId)!;
  assert.ok(shadowAccount.shadowDecisions24h > 0, `тень посчитала решения: ${shadowAccount.progressText}`);
  const decisions = await consoleCall<{ items: Array<{ decisionId: string }> }>('решения', 'GET', `${api('decisions')}?limit=20`);
  assert.ok(decisions.body.items.length > 0, 'список решений не пуст');
  const why = await consoleCall<{ steps: unknown[] }>('почему эта цена', 'GET', api('decisions', decisions.body.items[0]!.decisionId));
  assert.equal(why.status, 200, JSON.stringify(why.body).slice(0, 300));
  assert.ok(why.body.steps.length >= 5, `шагов объяснения: ${why.body.steps.length}`);
  const { rows: [w] } = await observer.query(
    `SELECT count(*)::int AS writes, count(*) FILTER (WHERE final_status = 'SHADOW_HELD')::int AS held FROM tenant_data.channel_write_history WHERE tenant_id = $1`, [ids.tenantId]);
  assert.ok(w.writes >= MANAGED, `записи созданы: ${w.writes}`);
  assert.equal(w.writes, w.held, 'в тени ни одна запись не ушла в канал');
  // Р-188: теневая запись — без дня бюджета, «потратило бы» — у каждой (у eBay бюджет есть у каждой записи цены, Р-19)
  const { rows: [b] } = await observer.query(
    `SELECT count(*) FILTER (WHERE budget_day IS NOT NULL)::int AS with_day, count(*) FILTER (WHERE would_spend_budget)::int AS would_spend
       FROM tenant_data.channel_write_history WHERE tenant_id = $1 AND final_status = 'SHADOW_HELD'`, [ids.tenantId]);
  assert.deepEqual([b.with_day, b.would_spend], [0, w.held], `у теневой записи дня бюджета нет, «потратило бы» — у каждой: ${JSON.stringify(b)}`);
  // Условие 2 Р-188: граница не подтверждена — число «потратило бы» экран называет приблизительным
  const shadowScreen = await consoleCall<{ summary: { wouldSpendBudget: number; wouldSpendUnconfirmed: number }; summaryLines: string[];
    properties: Array<{ marketplace: string; propertyText: string; blocksLive: boolean; question: string | null }>; liveBlockedText: string | null }>(
    'экран тени: «потратило бы» — приблизительно', 'GET', `${api('shadow')}?offset=0&limit=20`);
  assert.equal(shadowScreen.status, 200);
  assert.ok(shadowScreen.body.summary.wouldSpendBudget > 0, 'тень посчитала, сколько записей потратили бы бюджет правок');
  assert.equal(shadowScreen.body.summary.wouldSpendUnconfirmed, shadowScreen.body.summary.wouldSpendBudget, 'все они — на витрине без подтверждённой границы');
  assert.ok(shadowScreen.body.summaryLines.some((l) => /about \d+ would have used the external edit budget .*approximate: the day boundary of the storefront is not confirmed/.test(l)),
    `строка сводки помечена приблизительной: ${JSON.stringify(shadowScreen.body.summaryLines)}`);
  const boundary = shadowScreen.body.properties.find((p) => p.marketplace === 'EBAY_DE' && /Day boundary/.test(p.propertyText));
  assert.ok(boundary?.blocksLive && boundary.question === 'OQ-112', `граница суток EBAY_DE держит бой и названа вопросом: ${JSON.stringify(boundary)}`);
  assert.ok(shadowScreen.body.liveBlockedText !== null, 'экран говорит про закрытый бой ДО нажатия кнопки');
  // Условие 1 Р-188: перевод в бой при неподтверждённой границе — 409, и аккаунт остаётся в тени
  const live = await consoleCall<{ error: { code: string; message: string } }>('включить бой на EBAY_DE — отказ', 'POST', api('shadow', 'mode'),
    { channelAccountId: ids.accountId, toMode: 'LIVE', typedConfirmation: SELLER });
  assert.equal(live.status, 409, `бой на витрине с неподтверждённой границей суток: ${JSON.stringify(live.body)}`);
  assert.equal(live.body.error.code, 'PROPERTY_UNKNOWN');
  assert.match(live.body.error.message, /day boundary/i, 'отказ называет свойство витрины');
  const { rows: [still] } = await observer.query(`SELECT write_mode FROM tenant_data.channel_account WHERE channel_account_id = $1`, [ids.accountId]);
  assert.equal(still.write_mode, 'SHADOW', 'аккаунт остался в тени');
  const { rows: [t] } = await observer.query(`SELECT count(*)::int AS n FROM channel_data.price_decision WHERE tenant_id = $1 AND trigger_type = 'SCHEDULE'`, [ids.tenantId]);
  assert.ok(t.n >= MANAGED, `решения пришли от пересчёта по расписанию: ${t.n}`);
  assert.equal(writeRequests(), 0, `до модели eBay не дошло ни одной записи (только чтения): ${JSON.stringify(routes())}`);
  assert.equal(writesBefore, 0);
  assert.deepEqual(channelViolations, [], 'модель канала не видела ни одного непонятного запроса');
  // Положительный контроль счётчика: запись, отданная адаптеру напрямую, до модели доходит
  const probe = await adapter.dispatch({ tenantId: ids.tenantId as never, channelAccountId: ids.accountId as never, correlationId: 'pilot-ebay-control', deadline: clock.iso(60_000) as never }, {
    batchId: 'pilot-ebay-control', operation: 'bulkUpdatePriceQuantity', requestCount: 1, budgetCharges: [],
    items: [{ channelWriteId: 'pilot-ebay-control' as never, version: 1, idempotencyKey: 'pilot-ebay-control', attemptNo: 1,
      writeScope: { writeScopeId: 'pilot-ebay-control' as never, field: 'PRICE', scopeKey: L(1).sku, identity: { marketplace: 'EBAY_DE', externalSku: L(1).sku, externalOfferId: L(1).offerId, externalListingId: L(1).listingId } },
      value: { field: 'PRICE', price: { amountMinor: 1299, currency: 'EUR', basis: 'GROSS' } } }],
  });
  assert.equal(probe.outcomes[0]!.status, 'ACCEPTED', JSON.stringify(probe.outcomes));
  assert.equal(writeRequests(), 1, 'положительный контроль: счётчик записей модели растёт');
  // Токены продавца — только шифротекстом: ни ответы консоли, ни журнал адаптера их не несут [Р-177]
  const everywhere = JSON.stringify({ journey, found: found.body, counting: counting.body, adapterLogs });
  for (const token of ebayOauth.issuedTokens) assert.ok(!everywhere.includes(token), 'токен eBay не утёк');
});
