import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';

import { ModelOAuthProvider } from '@repracer/channel-oauth/model';
import type { BulkJobView, ConnectionsView, CostImportView, BoundsDiffView, EnableResultView, OnboardingView, StrategyPreviewView } from '@repracer/console-model';
import { nextNineUtc, VirtualClock } from '@repracer/contract-tests/live';
import { AMAZON_DE, SimulatedAmazonPort } from '@repracer/contract-tests/simulator';
import { FakeMail } from '@repracer/alert-delivery/testing';
import { startModelIdentityProvider, type ModelIdentityProvider } from '@repracer/identity/test-provider';
import { createPricingPipeline } from '@repracer/pricing-pipeline';
import { createPool, PgPricingStore, PgWriteQueueStore, type PgPool } from '@repracer/pricing-store-pg';
import { createWriteDispatcher, type WriteDispatcher } from '@repracer/write-dispatcher';
import { createScheduler, jobSource, PgSchedulerState, pgJobDeps, runScheduler, type JobDeps } from '@repracer/scheduler';
import { startOperatorPanel, type RunningPanel } from '../../operator/server/operator-service.ts';
import type { JobCreatedResponse, SessionView, WorldSummary } from '../src/api-types.ts';
import { beginLogin, finishLogin } from '../src/oidc.ts';
import { createIsolatedDatabase, type IsolatedDatabase, type TestRole } from '../../../packages/pricing-store-pg/test/isolated-db.ts';
import { startConsole, type RunningConsole } from '../server/console-service.ts';
import { CONSOLE_ROLES } from '../server/config.ts';
import { ID_TOKEN_HEADER } from '../src/api.ts';

/**
 * Р-179 (шаг 44): ПОЛНЫЙ путь пилота одним живым прогоном через HTTP как браузер [Р-136, Р-142], без склеек:
 * оператор в панели заводит тенанта → приглашение письмом → владелец входит у поставщика identity и принимает его →
 * консоль показывает ЕГО пустой мир → онбординг → Connect Amazon (модель LWA) → тень нашла офферы → остатки →
 * себестоимость → границы → стратегия → включение → тень считает → «почему эта цена».
 *
 * «Без склеек» значит: прогон не зовёт ни хранилище, ни функции базы от имени человека. Поставщик identity — МОДЕЛЬ по
 * HTTP (код с PKCE, как ZITADEL), консоль и панель проверяют её токены по ключам, полученным по сети; вход владельца —
 * тем же модулем, что страница (`src/oidc.ts`). Канал — модель поставщика LWA и модель порта Amazon [Р-113].
 * Наблюдатель базы только ЧИТАЕТ, чтобы утверждать то, чего экран не показывает. Данные синтетические.
 */

const SELLER = 'A3SYNPILOT44';
const OFFERS = 20;
const SCREEN_LIMIT_SECONDS = 10;
const JOB_LIMIT_SECONDS = 120;
const TENANT_NAME = 'Pilot Händler GmbH';
const OWNER_EMAIL = 'pilot-owner@example.test';
const OPERATOR_SUBJECT = 'pilot-operator';
const CONSOLE_AUDIENCE = 'repracer-console';
const OPERATOR_AUDIENCE = 'repracer-operator';

let db: IsolatedDatabase;
let provider: ModelIdentityProvider;
let panel: RunningPanel;
let consoleProcess: RunningConsole;
let lwaServer: HttpServer;
let consoleOrigin = '';
let observer: PgPool;
let lwa: ModelOAuthProvider;
let deps: JobDeps;
let clock: VirtualClock;
let port: SimulatedAmazonPort;
let amazonPipeline: ReturnType<typeof createPricingPipeline>;
let dispatcher: WriteDispatcher;
let worker: ChildProcess | null = null;
const mail = new FakeMail();
const clients: Record<string, { redirectUris: string[]; audience: string }> = {};
const journey: Array<{ step: string; seconds: number; status?: number; note?: string }> = [];
const stumbles: string[] = [];
const ids = { tenantId: '', accountId: '' };
type Tokens = { access: string; id: string | null };
let owner: Tokens = { access: '', id: null };

const worldId = () => `tenant-${ids.tenantId}`;
const api = (screen: string, param?: string) => `/api/worlds/${encodeURIComponent(worldId())}/${screen}${param ? `/${param}` : ''}`;

async function http<T>(step: string, base: string, method: 'GET' | 'POST', url: string, body?: unknown, token: Tokens | string = owner): Promise<{ status: number; body: T }> {
  const started = process.hrtime.bigint();
  // Как страница: токен доступа и ID-токен (методы входа — только в нём у ZITADEL [OQ-238]); ключ склада — строкой
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

/** Вход у поставщика так, как его делает страница: адрес входа, «Allow» у поставщика, возврат с кодом, обмен кода */
type LoginModule = { beginLogin: typeof beginLogin; finishLogin: typeof finishLogin };
/** cfg — то, что страница получила от своего сервера; module — модуль входа, который страница исполняет */
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
    state: new PgSchedulerState(db.pool('svc_scheduler', 2)), source: jobSource(deps), owner: 'pilot-44', now: () => clock.iso(),
    alerts: { raise: async () => undefined },
  });
  const running = runScheduler(scheduler, {
    tickMs: 30_000, clockMs: () => clock.nowMs(), logger: { log: () => undefined },
    sleep: async (ms) => {
      await clock.sleep(ms);
      // Приёмник уведомлений: снимки ANY_OFFER_CHANGED, срок доставки которых наступил, идут настоящим путём решения
      for (const snapshot of port.drainSnapshots()) {
        await amazonPipeline.processSnapshot({ tenantId: ids.tenantId as never, channelAccountId: ids.accountId as never, correlationId: 'pilot-receiver', deadline: clock.iso(60_000) as never }, snapshot);
      }
      // Диспетчер записей — как процесс worker в работе: в тени ему отправлять нечего, и это утверждается ниже
      await dispatcher.sweep({ pendingMinAgeMs: 0 });
    },
    shouldStop: () => clock.nowMs() >= endMs,
  });
  await running.finished;
}

before(async () => {
  db = await createIsolatedDatabase('pilot44');
  const appPool: PgPool = db.pool('svc_app', 4);
  const adminPool: PgPool = db.pool('svc_admin', 4);
  const authenticatorPool: PgPool = db.pool('svc_authenticator', 2);
  clock = new VirtualClock(nextNineUtc());
  provider = await startModelIdentityProvider({ clients, issuer: 'https://identity.pilot.repracer.test' });

  // Оператор платформы заводится суперпользователем стенда: заводить операторов панель не умеет [Р-166]
  await db.superuser(
    `INSERT INTO platform.platform_operator (operator_id, tenant_id, issuer, subject, display_name, active)
     VALUES (gen_random_uuid(), security.platform_tenant_id(), $1, $2, 'Operator im Pilotlauf', true)`, [provider.issuer, OPERATOR_SUBJECT]);

  /**
   * Р-181 (шаг 45): консоль — ПРОМЫШЛЕННАЯ проводка `startConsole` с конфигурацией из окружения, как в профиле: миры
   * тенантов, приём приглашений, подключение канала, вход у поставщика — те же службы, что в работе. Отличия от работы
   * названы и ограничены режимом стенда: издатель модели поставщика — https-имя, а отвечает она на петле
   * (`REPRACER_CONSOLE_OIDC_DISCOVERY_BASE`), и адрес токенов LWA — модель на петле (`REPRACER_AMAZON_LWA_TOKEN_URL`).
   */
  const consolePort = await freePort();
  consoleOrigin = `http://127.0.0.1:${consolePort}`;
  clients['console-spa'] = { redirectUris: [`${consoleOrigin}/auth/callback`], audience: CONSOLE_AUDIENCE };
  const redirectUri = `${consoleOrigin}/connect/callback`;
  lwa = new ModelOAuthProvider({ channel: 'AMAZON', clientId: 'amzn1.application-oa2-client.pilot', clientSecret: 'syn-pilot-client-secret', redirectUri, now: () => Date.now() });
  // Конечная точка токенов LWA по HTTP — консоль ходит к ней обычным fetch, как к api.amazon.com
  lwaServer = createHttpServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const out = await lwa.fetch(req.url ?? '/', { method: req.method ?? 'POST', headers: req.headers as Record<string, string>, body: Buffer.concat(chunks).toString('utf8') });
    res.writeHead(out.status, { 'content-type': 'application/json' });
    res.end(await out.text());
  });
  await new Promise<void>((resolve) => lwaServer.listen(0, '127.0.0.1', resolve));
  const dist = mkdtempSync(join(tmpdir(), 'repracer-pilot-dist-'));
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>repracer</title>', 'utf8');
  // Роли — закрытым списком конфигурации консоли, как их видит compose
  const roleUrls = Object.fromEntries(CONSOLE_ROLES.map((r) => [`REPRACER_CONSOLE_${r.toUpperCase()}_PG_URL`, db.url(`svc_${r}` as TestRole)]));
  consoleProcess = await startConsole({
    REPRACER_MODE: 'stand', REPRACER_CONSOLE_PORT: String(consolePort), REPRACER_CONSOLE_METRICS_PORT: '0', REPRACER_CONSOLE_DIST: dist,
    REPRACER_CONSOLE_PUBLIC_DEMO: 'off', REPRACER_CONSOLE_HEARTBEAT: 'off', ...roleUrls,
    REPRACER_CONSOLE_OIDC_ISSUER: provider.issuer, REPRACER_CONSOLE_OIDC_AUDIENCE: CONSOLE_AUDIENCE, REPRACER_CONSOLE_OIDC_JWKS_URL: provider.jwksUrl,
    REPRACER_CONSOLE_OIDC_CLIENT_ID: 'console-spa', REPRACER_CONSOLE_OIDC_DISCOVERY_BASE: provider.origin,
    REPRACER_AMAZON_APP_ID: 'amzn1.sellerapps.app.pilot', REPRACER_AMAZON_LWA_CLIENT_ID: 'amzn1.application-oa2-client.pilot',
    REPRACER_AMAZON_LWA_CLIENT_SECRET: 'syn-pilot-client-secret', REPRACER_AMAZON_APP_DRAFT: 'on',
    REPRACER_AMAZON_LWA_TOKEN_URL: `http://127.0.0.1:${(lwaServer.address() as AddressInfo).port}/auth/o2/token`,
    REPRACER_CHANNEL_KEYRING: JSON.stringify({ current: 'k-pilot', keys: { 'k-pilot': Buffer.alloc(32, 45).toString('base64') } }),
    REPRACER_CONNECT_REDIRECT_URL: redirectUri,
  });

  panel = await startOperatorPanel({
    REPRACER_MODE: 'stand', REPRACER_OPERATOR_PORT: '0', REPRACER_OPERATOR_METRICS_PORT: '0',
    REPRACER_OPERATOR_PG_URL: db.url('svc_operator'),
    REPRACER_OPERATOR_OIDC_ISSUER: provider.issuer, REPRACER_OPERATOR_OIDC_AUDIENCE: OPERATOR_AUDIENCE, REPRACER_OPERATOR_OIDC_JWKS_URL: provider.jwksUrl,
    REPRACER_OPERATOR_OIDC_CLIENT_ID: 'operator-panel',
    // Ссылка приглашения ведёт в КОНСОЛЬ прогона: по ней владелец и придёт
    REPRACER_OPERATOR_INVITATION_URL: `${consoleOrigin}/invite`, REPRACER_OPERATOR_HEARTBEAT: 'off',
  }, { mail });
  clients['operator-panel'] = { redirectUris: [`http://127.0.0.1:${panel.port}/auth/callback`], audience: OPERATOR_AUDIENCE };

  // Канал: модель порта Amazon продавца (20 SKU на amazon.de, у каждого конкурент со своим расписанием)
  const asins = Array.from({ length: OFFERS }, (_, i) => `B0PILOT${String(i).padStart(3, '0')}`);
  port = new SimulatedAmazonPort({
    seed: 4400, params: { anyOfferChanged: { delayMs: 30_000, lossShare: 0 } },
    skus: asins.map((asin, i) => ({ sku: `SYN-PILOT-${String(i).padStart(2, '0')}`, asin, marketplaces: [AMAZON_DE], priceMinor: 2400, quantity: 5 })),
    competitors: asins.map((asin, i) => ({
      sellerRef: `Synthetic Pilot Competitor ${i}`, marketplace: AMAZON_DE, asin, priceMinor: 2300,
      schedule: Array.from({ length: 12 }, (_, k) => ({ atOffsetMs: (k + 1) * 10 * 60_000 + i * 20_000, priceMinor: k % 2 === 0 ? 2250 : 2300 })),
    })),
  }, {
    accounts: { async verify(tenantId, channelAccountId) {
      if (channelAccountId !== ids.accountId) return { ok: false, reason: 'NOT_FOUND' };
      if (tenantId !== ids.tenantId) return { ok: false, reason: 'TENANT_MISMATCH' };
      return { ok: true, account: { tenantId, channelAccountId, channel: 'AMAZON', region: 'EU', externalAccountId: SELLER, marketplaces: [AMAZON_DE], credentialsRef: `db:${channelAccountId}` } };
    } },
    credentials: { async get() { return {}; } },
    alerts: { async raise() {} }, logger: { log() {} }, now: () => clock.iso(),
  });
  const writeQueue = new PgWriteQueueStore(appPool, { scanPool: db.pool('svc_dispatcher', 2) });
  dispatcher = createWriteDispatcher({
    store: {
      claimNext: writeQueue.claimNext.bind(writeQueue), recordOutcome: writeQueue.recordOutcome.bind(writeQueue),
      recordReconciliation: writeQueue.recordReconciliation.bind(writeQueue), checkPriceBasis: writeQueue.checkPriceBasis.bind(writeQueue),
      dueScopes: async (at: Parameters<typeof writeQueue.dueScopes>[0], o: Parameters<typeof writeQueue.dueScopes>[1]) => (await writeQueue.dueScopes(at, o)).filter((d) => d.tenantId === ids.tenantId),
    } as never,
    adapterFor: () => port, alerts: { async raise() {} }, now: () => clock.iso(),
  });
  amazonPipeline = createPricingPipeline({
    store: new PgPricingStore(appPool, { adminPool }), adapter: port, alerts: { async raise() {} }, logger: { log() {} }, now: () => clock.iso(), dispatcher,
  });
  const base = pgJobDeps({
    schedulerPool: db.pool('svc_scheduler', 2), exporterPool: db.pool('svc_exporter', 1), ingest: null as never, verifier: null as never,
    descriptorOf: (channel) => (channel === 'AMAZON' ? port.descriptor : null), pipelineFor: () => amazonPipeline, reconcileEnabled: () => false,
  });
  deps = { ...base, accounts: async () => (await base.accounts()).filter((a) => a.tenantId === ids.tenantId), exportDay: async () => { throw new Error('CLICKHOUSE_NOT_IN_RUN'); } };

  // Исполнитель массовых заданий — сервис профиля `bulk-worker` в режиме окружения, как в работе [Р-181]
  worker = spawn(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', fileURLToPath(new URL('../server/bulk-worker.ts', import.meta.url))], {
    env: { ...process.env, BULK_WORKER_CONFIG: '', REPRACER_MODE: 'stand', REPRACER_BULK_HEARTBEAT: 'off', REPRACER_BULK_METRICS_PORT: '0', REPRACER_BULK_POLL_MS: '200', REPRACER_BULK_IDLE_MS: '100',
      REPRACER_BULK_APP_PG_URL: db.url('svc_app'), REPRACER_BULK_ADMIN_PG_URL: db.url('svc_admin'), REPRACER_BULK_BULK_WORKER_PG_URL: db.url('svc_bulk_worker'), REPRACER_BULK_STOCK_PG_URL: db.url('svc_stock') },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  worker.stderr?.on('data', (chunk: Buffer) => console.error('bulk-worker:', chunk.toString().trim()));

  const observerUrl = new URL(process.env.REPRACER_PG_ADMIN_URL!); observerUrl.pathname = `/${db.name}`;
  observer = createPool(observerUrl.toString(), { max: 1, applicationName: 'repracer-pilot-observer' });
});

after(async () => {
  console.log(JSON.stringify({ pilot: { journey, stumbles } }, null, 1));
  // Исполнитель обязан ВЫЙТИ по сигналу (находка 17 ревью шага 44: пулы не закрывались, процесс висел)
  const exited = worker && worker.exitCode === null ? new Promise<number | null>((resolve) => worker!.once('exit', (code) => resolve(code))) : Promise.resolve(worker?.exitCode ?? null);
  worker?.kill('SIGTERM');
  const code = await Promise.race([exited, new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 15_000))]);
  if (code === 'hung') worker?.kill('SIGKILL');
  assert.notEqual(code, 'hung', 'исполнитель заданий вышел по SIGTERM');
  await consoleProcess?.close();
  lwaServer?.close();
  await panel?.close();
  await provider?.close();
  await observer?.end();
  await db?.drop();
});

test('Р-179: путь пилота целиком — от оператора в панели до «почему эта цена» в тени', async () => {
  // ---------------------------------------------------------------- оператор: тенант и приглашение
  const panelOrigin = `http://127.0.0.1:${panel.port}`;
  /**
   * Р-183 (шаг 45, OQ-236): оператор входит СО СТРАНИЦЫ ПАНЕЛИ — где входить, панель говорит сама, а модуль входа
   * прогон берёт у панели по `/oidc.js` и исполняет его, как исполнил бы браузер. Второй фактор — в ID-токене [OQ-238].
   */
  const panelLogin = await http<{ issuer: string; clientId: string; scope: string }>('панель: где входить', panelOrigin, 'GET', '/api/operator/login-config', undefined, '');
  assert.deepEqual(panelLogin.body, { issuer: provider.issuer, clientId: 'operator-panel', scope: 'openid profile' });
  const panelModule = await import(`data:text/javascript,${encodeURIComponent(await (await fetch(`${panelOrigin}/oidc.js`)).text())}`) as LoginModule;
  const operator = await timed('оператор входит у поставщика со страницы панели', () => signIn(panelLogin.body, `${panelOrigin}/auth/callback`, { subject: OPERATOR_SUBJECT, email: 'operator@repracer.invalid', amr: ['pwd', 'otp'] }, panelModule));
  assert.ok(operator.id, 'поставщик выдал ID-токен: второй фактор оператора — только в нём');
  // Находка 1 ревью шага 45: ID-токен (его аудитория у ZITADEL включает проект) как Bearer — не пропуск
  const idAsBearer = await http('панель: ID-токен как токен доступа', panelOrigin, 'GET', '/api/operator/session', undefined, { access: operator.id!, id: null });
  assert.equal(idAsBearer.status, 401, 'ID-токен не входит в панель как токен доступа');
  // Без ID-токена второго фактора нет — и действие панели отказывает база, своей причиной
  const noFactor = await http<{ code: string; message: string }>('панель: действие без ID-токена', panelOrigin, 'POST', '/api/operator/tenants', { name: 'Kein Faktor', region: 'EU', ownerEmail: 'nf@example.test', locale: 'en' }, { access: operator.access, id: null });
  assert.equal(noFactor.status, 403, `без ID-токена действие отказано базой: ${JSON.stringify(noFactor.body)}`);
  assert.match(noFactor.body.message, /second factor|второй фактор|MFA/i);
  const created = await http<{ tenantId: string }>('панель: создать тенанта', panelOrigin, 'POST', '/api/operator/tenants', { name: TENANT_NAME, region: 'EU', ownerEmail: OWNER_EMAIL, locale: 'en' }, operator);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  ids.tenantId = created.body.tenantId;
  const invited = await http<{ invitationId: string }>('панель: пригласить владельца', panelOrigin, 'POST', `/api/operator/tenants/${ids.tenantId}/invite`, { email: OWNER_EMAIL }, operator);
  assert.equal(invited.status, 201, JSON.stringify(invited.body));
  const letter = mail.matching(TENANT_NAME)[0];
  assert.ok(letter, 'письмо приглашения ушло владельцу');
  const link = new RegExp(`${consoleOrigin.replace(/[.:/]/g, (c) => `\\${c}`)}/invite#([A-Za-z0-9_-]+)`).exec(letter!.text);
  assert.ok(link, `ссылка приглашения ведёт в консоль: ${letter!.text.slice(0, 300)}`);
  const invitationToken = link[1]!;

  // ---------------------------------------------------------------- владелец: вход у поставщика, приём приглашения, СВОЙ мир
  const session = await consoleCall<SessionView>('консоль: страница входа', 'GET', '/api/session');
  assert.deepEqual(session.body.oidc, { issuer: provider.issuer, clientId: 'console-spa', scope: 'openid email profile' }, 'страница знает, где входить');
  owner = await timed('владелец входит у поставщика', () => signIn(session.body.oidc!, `${consoleOrigin}/auth/callback`, { subject: 'pilot-owner', email: OWNER_EMAIL, amr: ['pwd', 'otp'] }));
  // Находка 1 ревью шага 45: ID-токен владельца как токен доступа консоли — не пропуск
  const ownerIdAsBearer = await http('консоль: ID-токен как токен доступа', consoleOrigin, 'GET', '/api/session', undefined, { access: owner.id!, id: null });
  assert.equal((ownerIdAsBearer.body as { user: unknown }).user, null, 'ID-токен не делает запрос вошедшим');
  const before0 = await consoleCall<WorldSummary[]>('консоль: миры до приёма приглашения', 'GET', '/api/worlds');
  assert.equal(before0.status, 401, 'до приёма приглашения пользователя у нас нет — и миров тоже');
  const accepted = await consoleCall<{ accepted: boolean }>('консоль: принять приглашение', 'POST', '/api/invitations/accept', { token: invitationToken });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  const again = await consoleCall('консоль: принять то же приглашение второй раз', 'POST', '/api/invitations/accept', { token: invitationToken });
  assert.equal(again.status, 409, 'приглашение одноразовое');
  const worlds = await consoleCall<WorldSummary[]>('консоль: мои миры', 'GET', '/api/worlds');
  assert.deepEqual(worlds.body.map((w) => [w.id, w.title, w.demo, w.scopes]), [[worldId(), TENANT_NAME, false, 0]], 'ровно один мир — свой, пустой, не демо');

  // ---------------------------------------------------------------- онбординг: путь, Connect Amazon, тень нашла офферы
  const empty = await consoleCall<OnboardingView>('онбординг: пустой путь', 'GET', api('onboarding'));
  assert.equal(empty.status, 200, JSON.stringify(empty.body));
  const path = await consoleCall('онбординг: выбрать путь «остатки + репрайсинг»', 'POST', api('onboarding', 'path'), { path: 'STOCK_AND_PRICING' });
  assert.equal(path.status, 200, JSON.stringify(path.body));
  const start = await consoleCall<{ consentUrl: string }>('Connect Amazon', 'POST', api('connections', 'start'), { channel: 'AMAZON', marketplaces: [AMAZON_DE] });
  assert.equal(start.status, 200, JSON.stringify(start.body));
  const back = new URL(lwa.approve(start.body.consentUrl, SELLER));
  const connected = await consoleCall<{ channelAccountId: string }>('возврат с кодом согласия', 'POST', api('connections', 'callback'), { params: Object.fromEntries(back.searchParams) });
  assert.equal(connected.status, 200, JSON.stringify(connected.body));
  ids.accountId = connected.body.channelAccountId;
  await timed('планировщик: первый такт — обнаружение офферов', () => schedulerFor(1));
  const found = await consoleCall<ConnectionsView>('экран подключений: нашли офферы', 'GET', api('connections'));
  const account = found.body.accounts.find((a) => a.channelAccountId === ids.accountId)!;
  assert.deepEqual([account.state, account.offers], ['SHADOW', OFFERS], `тень нашла офферы: ${account.progressText}`);
  let view = (await consoleCall<OnboardingView>('онбординг после подключения', 'GET', api('onboarding'))).body;
  assert.equal(view.resumeAt, 'STOCK_SOURCE', `канал подключён — дальше остатки: ${view.resumeText}`);

  // ---------------------------------------------------------------- остатки
  const skus = Array.from({ length: OFFERS }, (_, i) => `SYN-PILOT-${String(i).padStart(2, '0')}`);
  const source = await consoleCall<{ stockSourceId: string }>('остатки: источник', 'POST', api('stock', 'sources'), { mode: 'INTERNAL_POOL', name: 'Pilot-Lager' });
  assert.equal(source.status, 200, JSON.stringify(source.body));
  const stockCsv = ['Artikelnummer;Bestand', ...skus.map((s) => `${s};7`)].join('\r\n');
  await job('остатки: файл', api('stock', 'import'), { fileName: 'bestand.csv', content: Buffer.from(stockCsv).toString('base64'), stockSourceId: source.body.stockSourceId });
  // Р-1: остаток Amazon ЕС пишется на весь регион — экран остатков называет это ДО записи, и продавец подтверждает
  const first = await job('остатки: синхронизация без подтверждения региона', api('stock', 'enable'), { channelAccountId: ids.accountId, bufferUnits: 1, maxQuantity: null, minQuantityToList: 0 });
  assert.match(first.headline, new RegExp(`NOT running yet for ${OFFERS} of ${OFFERS} channel units`), `без подтверждения региона синхронизация ждёт его: ${first.headline}`);
  assert.doesNotMatch(first.headline, /Synchronisation enabled/, 'заголовок не говорит «включено», пока единицы ждут подтверждения');
  const waitingSync = (await consoleCall<OnboardingView>('онбординг: синхронизация ждёт подтверждения', 'GET', api('onboarding'))).body;
  assert.equal(waitingSync.resumeAt, 'STOCK_SYNC', 'без подтверждения региона шаг не пройден');
  await job('остатки: синхронизация с подтверждением региона', api('stock', 'enable'), { channelAccountId: ids.accountId, bufferUnits: 1, maxQuantity: null, minQuantityToList: 0, acknowledgeSideEffects: true });
  view = (await consoleCall<OnboardingView>('онбординг после остатков', 'GET', api('onboarding'))).body;
  assert.equal(view.resumeAt, 'COSTS', `остатки готовы — дальше себестоимость: ${view.resumeText}`);
  // Находка 4 ревью шага 44: склад продавца шлёт остаток через Inbound API — мир тенанта находится по ключу источника
  const inboundSource = await consoleCall<{ apiKey: string }>('остатки: источник Inbound API', 'POST', api('stock', 'sources'), { mode: 'INBOUND_API', name: 'Pilot-Warehouse' });
  assert.equal(inboundSource.status, 200, JSON.stringify(inboundSource.body));
  const pushed = await http<{ applied: number }>('Inbound API: остаток со склада', consoleOrigin, 'POST', '/inbound/v1/stock',
    { rows: [{ sku: skus[0], quantity: 9, asOf: new Date().toISOString() }] }, inboundSource.body.apiKey);
  assert.deepEqual([pushed.status, pushed.body.applied], [200, 1], `склад пишет в мир тенанта: ${JSON.stringify(pushed.body)}`);

  // ---------------------------------------------------------------- себестоимость, границы, стратегия, включение
  const costCsv = ['Artikelnummer;Einstandspreis;Währung;Provision %;Fixkosten', ...skus.map((s) => `${s};8,00;EUR;15;0,00`)].join('\r\n');
  const file = { fileName: 'kosten.csv', content: Buffer.from(costCsv).toString('base64') };
  const plan = await consoleCall<CostImportView>('себестоимость: предпросмотр', 'POST', api('cost-import', 'plan'), file);
  assert.equal(plan.body.summary?.apply, OFFERS, `сопоставлены все офферы: ${JSON.stringify(plan.body).slice(0, 300)}`);
  await job('себестоимость: применить', api('cost-import', 'apply'), { ...file, fingerprint: plan.body.fingerprint, confirmed: true });
  const products = await consoleCall<{ rows: Array<{ unit: { writeScopeId: string } }> }>('товары', 'GET', `${api('products')}?limit=200`);
  const scopes = products.body.rows.map((r) => r.unit.writeScopeId);
  assert.equal(scopes.length, OFFERS);
  const boundsPlan = await job('границы: экран различий', api('bounds', 'plan'), { request: { writeScopeIds: scopes, min: { kind: 'SET', minor: 1500 }, max: { kind: 'SET', minor: 5000 } } });
  const diff = (boundsPlan.result as { view: BoundsDiffView }).view;
  await job('границы: применить', api('bounds', 'apply'), { planJobId: boundsPlan.jobId, planToken: diff.planToken, confirmed: true });
  const draft = { name: 'Pilot: beat the lowest', params: { type: 'BEAT_LOWEST', undercutMinor: 1, scope: 'VISIBLE_TOP_N', compareLanded: false, atBound: 'CAP' } };
  const preview = await job('стратегия: предпросмотр', api('strategies', 'preview'), { draft, writeScopeIds: scopes });
  const pv = (preview.result as { view: StrategyPreviewView }).view;
  await job('стратегия: назначить', api('strategies'), { draft, writeScopeIds: scopes, previewJobId: preview.jobId, previewToken: pv.previewToken, confirmed: true });
  const enabled = await job('включение движка', api('onboarding', 'enable'), {});
  const ev = (enabled.result as { view: EnableResultView }).view;
  assert.deepEqual([ev.enabled, ev.skipped], [OFFERS, 0], `включены все: ${JSON.stringify(ev.byCode)}`);
  view = (await consoleCall<OnboardingView>('онбординг: путь пройден', 'GET', api('onboarding'))).body;
  assert.equal(view.resumeAt, 'DONE', view.resumeText);

  // ---------------------------------------------------------------- тень считает, «почему эта цена»
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
  assert.ok(w.writes > 0, `записи созданы: ${w.writes}`);
  assert.equal(w.writes, w.held, 'в тени ни одна запись не ушла в канал');
  assert.equal(port.stats.patchCalls, 0, 'модель Amazon не получила ни одной записи, хотя диспетчер обходил очередь');
  // Положительный контроль счётчика: запись, отданная модели напрямую, его сдвигает
  await port.dispatch({ tenantId: ids.tenantId as never, channelAccountId: ids.accountId as never, correlationId: 'pilot-control', deadline: clock.iso(60_000) as never }, {
    batchId: 'pilot-control', operation: 'patchListingsItem', budgetCharges: [], requestCount: 1,
    items: [{ channelWriteId: 'pilot-control' as never, version: 1, idempotencyKey: 'pilot-control', attemptNo: 1,
      writeScope: { writeScopeId: 'pilot-control' as never, field: 'PRICE', scopeKey: skus[0]!, identity: { marketplace: AMAZON_DE, externalSku: skus[0]! } },
      value: { field: 'PRICE', price: { amountMinor: 2300, currency: 'EUR', basis: 'GROSS' } } }],
  });
  assert.equal(port.stats.patchCalls, 1, 'положительный контроль: счётчик записей модели растёт');

  // Р-178: второй продавец не видит мир пилота — ни в списке, ни по прямому адресу
  const created2 = await http<{ tenantId: string }>('панель: второй тенант', panelOrigin, 'POST', '/api/operator/tenants', { name: 'Zweiter Händler', region: 'EU', ownerEmail: 'second@example.test', locale: 'en' }, operator);
  await http('панель: пригласить второго владельца', panelOrigin, 'POST', `/api/operator/tenants/${created2.body.tenantId}/invite`, { email: 'second@example.test' }, operator);
  const link2 = /\/invite#([A-Za-z0-9_-]+)/.exec(mail.matching('Zweiter Händler')[0]!.text)![1]!;
  const pilotOwner = owner;
  owner = await timed('второй владелец входит', () => signIn({ issuer: provider.issuer, clientId: 'console-spa', scope: 'openid email profile' }, `${consoleOrigin}/auth/callback`, { subject: 'second-owner', email: 'second@example.test', amr: ['pwd', 'otp'] }));
  await consoleCall('второй: принять приглашение', 'POST', '/api/invitations/accept', { token: link2 });
  const secondWorlds = await consoleCall<WorldSummary[]>('второй: мои миры', 'GET', '/api/worlds');
  assert.deepEqual(secondWorlds.body.map((x) => x.title), ['Zweiter Händler'], 'второй продавец видит только свой мир');
  const foreign = await consoleCall('второй: мир пилота по прямому адресу', 'GET', api('onboarding'));
  assert.equal(foreign.status, 404, 'мир чужого тенанта по прямому адресу — 404');
  owner = pilotOwner;
  // Токен приглашения — только в письме: в базе его отпечаток
  const { rows: [inv] } = await observer.query('SELECT token_sha256 = $2 AS same FROM platform.identity_invitation WHERE invitation_id = $1',
    [invited.body.invitationId, createHash('sha256').update(invitationToken).digest()]);
  assert.equal(inv.same, true);
});
