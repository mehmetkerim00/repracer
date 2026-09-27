import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { after, before, test } from 'node:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { amazonLwa, createAuthorizationChecker, ephemeralKeyring } from '@repracer/channel-oauth';
import { channelCredentialsProvider } from '@repracer/service-runtime';
import { ModelOAuthProvider } from '@repracer/channel-oauth/model';
import type { ConnectionsView } from '@repracer/console-model';
import { STAND_AUDIENCE, STAND_ISSUER, type LiveWorld } from '@repracer/contract-tests/stand';
import { demoProducts, kauflandLiveWorld, VirtualClock, type KauflandLiveWorld } from '@repracer/contract-tests/live';
import { AMAZON_DE, SimulatedAmazonPort } from '@repracer/contract-tests/simulator';
import { createAlertDelivery } from '@repracer/alert-delivery';
import { FakeMail } from '@repracer/alert-delivery/testing';
import { createAuthenticator, MemoryIdentityDirectory, staticJwks } from '@repracer/identity';
import { createTestIssuer } from '@repracer/identity/test-issuer';
import { createPricingPipeline } from '@repracer/pricing-pipeline';
import { createPool, PgAlertDeliveryStore, PgChannelConnectStore, PgCredentialVault, PgPricingStore, PgStockStore, type PgPool } from '@repracer/pricing-store-pg';
import { createScheduler, jobSource, PgSchedulerState, pgJobDeps, runScheduler, type JobDeps } from '@repracer/scheduler';
import type { StandToken } from '../src/api-types.ts';
import { createIsolatedDatabase, type IsolatedDatabase } from '../../../packages/pricing-store-pg/test/isolated-db.ts';
import { createChannelConnectService, type ChannelConnectService } from '../server/connect.ts';
import { createStandApi, createStandServer } from '../server/stand-server.ts';

/**
 * Р-175…Р-177 (шаг 43): продавец подключает Amazon САМ — живым прогоном через консоль как браузер [Р-136, Р-142].
 *
 * Путь: экран подключений → «Connect Amazon» → страница согласия канала (МОДЕЛЬ поставщика LWA по снимку
 * `vendor/amazon/lwa-authorization`) → возврат на `/connect/callback` → обмен кода → аккаунт рождается в ТЕНИ [Р-176] →
 * планировщик сам запускает обнаружение офферов нового аккаунта → экран «нашли N офферов». Затем продавец ОТЗЫВАЕТ
 * авторизацию в кабинете канала: работа `channel-authorizations` обнаруживает это обменом refresh-токена, база переводит
 * аккаунт в REVOKED и поднимает CRITICAL, доставка отправляет владельцу письмо, экран показывает «доступ отозван», и
 * «Connect again» возвращает аккаунт тем же аккаунтом, новой версией токена.
 *
 * Отдельно утверждается Р-177: ни один выданный моделью токен и ни один код согласия не встречается ни в одном ответе
 * консоли, ни в письме, ни в журнале процессов, ни в ДАМПЕ ВСЕЙ БАЗЫ (шифротекст токена не содержит).
 *
 * Данные синтетические: мир Kaufland демо, модель поставщика OAuth и модель порта Amazon [Р-113].
 */

const WORLD = 'connect/amazon';
const SELLER = 'A3SYNCONNECT43';
const SELLER_OFFERS = 25;
const SCREEN_LIMIT_SECONDS = 10;

let db: IsolatedDatabase;
let world: KauflandLiveWorld;
let clock: VirtualClock;
let server: Server;
let origin = '';
let owner: { authorization: string; cookie: string };
let viewer: { authorization: string; cookie: string };
let observer: PgPool;
let deps: JobDeps;
let schedulerPool: PgPool;
let model: ModelOAuthProvider;
let connectService: ChannelConnectService;
let credentialsPool: PgPool;
const keyring = ephemeralKeyring('k-connect-43');
const mail = new FakeMail();
const platformAlerts: Array<{ code: string }> = [];
const logLines: string[] = [];
const responses: string[] = [];
const codes: string[] = [];
const measured: Array<{ step: string; seconds: number; status?: number }> = [];
const numbers: Record<string, unknown> = {};
let connectedAccountId = '';

const api = (screen: string, param?: string) => `/api/worlds/${encodeURIComponent(WORLD)}/${screen}${param ? `/${param}` : ''}`;
const log = (event: string, fields: Record<string, unknown>) => { logLines.push(JSON.stringify({ event, ...fields })); };

async function call<T>(step: string, who: typeof owner, method: 'GET' | 'POST', url: string, body?: unknown): Promise<{ status: number; body: T; seconds: number }> {
  const started = process.hrtime.bigint();
  const r = await fetch(`${origin}${url}`, {
    method,
    headers: { authorization: who.authorization, cookie: who.cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await r.text();
  responses.push(text);
  const seconds = Math.round(Number(process.hrtime.bigint() - started) / 1e6) / 1000;
  measured.push({ step, seconds, status: r.status });
  assert.ok(seconds < SCREEN_LIMIT_SECONDS, `${step}: ${seconds} с при пределе экрана ${SCREEN_LIMIT_SECONDS} с`);
  return { status: r.status, body: (text ? JSON.parse(text) : null) as T, seconds };
}

/** Шаг вне HTTP — согласие у канала, такты планировщика: время настоящее, чтобы отчёт назвал путь в секундах */
async function timed<T>(step: string, fn: () => Promise<T>): Promise<T> {
  const started = process.hrtime.bigint();
  const out = await fn();
  measured.push({ step, seconds: Math.round(Number(process.hrtime.bigint() - started) / 1e6) / 1000 });
  return out;
}

async function tokenFor(role: 'OWNER' | 'VIEWER'): Promise<{ authorization: string; cookie: string }> {
  const r = await fetch(`${origin}/api/stand-issuer/token?locale=en`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role }) });
  return { authorization: `Bearer ${((await r.json()) as StandToken).accessToken}`, cookie: 'repracer_locale=en' };
}

/** Такты планировщика на виртуальных часах: между тактами — работа диспетчера и приёмника мира */
async function schedulerFor(minutes: number): Promise<void> {
  const endMs = clock.nowMs() + minutes * 60_000;
  const scheduler = createScheduler({
    state: new PgSchedulerState(schedulerPool), source: jobSource(deps), owner: 'connect-43', now: () => clock.iso(),
    alerts: { raise: async (a) => { platformAlerts.push(a); } },
  });
  const running = runScheduler(scheduler, {
    tickMs: 30_000, clockMs: () => clock.nowMs(), logger: { log: (entry) => log('scheduler', entry as unknown as Record<string, unknown>) },
    sleep: async (ms) => { await clock.sleep(ms); await world.betweenTicks(); },
    shouldStop: () => clock.nowMs() >= endMs,
  });
  await running.finished;
}

const lwaApprove = (url: string) => model.approve(url, SELLER);

/** Браузер продавца: страница согласия канала → «Allow» → адрес возврата. Параметры возврата SPA шлёт серверу как есть */
function consent(consentUrl: string): Record<string, string> {
  const back = new URL(model.approve(consentUrl, SELLER));
  assert.equal(back.origin + back.pathname, `${origin}/connect/callback`, 'канал возвращает браузер на адрес возврата консоли');
  const params = Object.fromEntries(back.searchParams);
  codes.push(params.spapi_oauth_code!);
  return params;
}

before(async () => {
  db = await createIsolatedDatabase('connect43');
  const appPool: PgPool = db.pool('svc_app', 4);
  const adminPool: PgPool = db.pool('svc_admin', 4);
  schedulerPool = db.pool('svc_scheduler', 3);
  credentialsPool = db.pool('svc_credentials', 2);
  clock = new VirtualClock(new Date(Date.now() - 3_600_000).toISOString());
  world = await kauflandLiveWorld({
    tag: 4300, clock, products: demoProducts({ bare: false }).slice(0, 10), seed: 4300, writeMode: 'SHADOW',
    appPool, adminPool, provisioningPool: db.pool('svc_provisioning', 1), dispatcherPool: db.pool('svc_dispatcher', 2),
  });
  const seeded = world.seeded;

  // Порт Amazon ПРОДАВЦА, который подключится: 25 SKU на amazon.de; аккаунт он принимает только подключённый
  const amazonPort = new SimulatedAmazonPort({
    seed: 4301, competitors: [],
    skus: Array.from({ length: SELLER_OFFERS }, (_, i) => ({ sku: `SYN-CONNECT-${i}`, asin: `B0CONN${String(i).padStart(4, '0')}`, marketplaces: [AMAZON_DE], priceMinor: 2400, quantity: 3 })),
  }, {
    accounts: { async verify(tenantId, channelAccountId) {
      if (channelAccountId !== connectedAccountId) return { ok: false, reason: 'NOT_FOUND' };
      if (tenantId !== seeded.tenantId) return { ok: false, reason: 'TENANT_MISMATCH' };
      return { ok: true, account: { tenantId, channelAccountId, channel: 'AMAZON', region: 'EU', externalAccountId: SELLER, marketplaces: [AMAZON_DE], credentialsRef: `db:${channelAccountId}` } };
    } },
    credentials: { async get() { return {}; } },
    alerts: { async raise() { /* алерты порта прогон не утверждает */ } },
    logger: { log(entry) { log('amazon-port', entry as unknown as Record<string, unknown>); } },
    now: () => clock.iso(),
  });
  const amazonPipeline = createPricingPipeline({
    store: new PgPricingStore(appPool, { adminPool }), adapter: amazonPort, alerts: { async raise() {} },
    logger: { log(entry) { log('amazon-pipeline', entry as unknown as Record<string, unknown>); } }, now: () => clock.iso(),
  });

  const base = pgJobDeps({
    schedulerPool, exporterPool: db.pool('svc_exporter', 1), ingest: null as never, verifier: null as never,
    descriptorOf: (channel) => (channel === 'KAUFLAND' ? world.adapter.descriptor : channel === 'AMAZON' ? amazonPort.descriptor : null),
    pipelineFor: (a) => (a.channel === 'AMAZON' ? amazonPipeline : world.pipelineForDbIds()),
    reconcileEnabled: () => false,
  });
  const provider = () => amazonLwa({ applicationId: 'amzn1.sellerapps.app.synthetic-43', clientId: 'amzn1.application-oa2-client.synthetic-43', clientSecret: 'synthetic-client-secret-43', redirectUri: `${origin}/connect/callback`, draft: true });
  deps = {
    ...base,
    // Планировщик платформенный; прогон ведёт только свой тенант — иначе соседние миры базы получили бы наши адаптеры
    accounts: async () => (await base.accounts()).filter((a) => a.tenantId === seeded.tenantId),
    exportDay: async () => { throw new Error('CLICKHOUSE_NOT_IN_RUN'); },
    alertDelivery: createAlertDelivery({
      store: new PgAlertDeliveryStore(db.pool('svc_alert_delivery', 1)), mail,
      // Время события ставит база: доставка сравнивает с настоящими часами, а не с виртуальными часами мира
      now: () => new Date().toISOString() as never, operatorEmail: 'betrieb@example.invalid',
    }),
    channelAuthorizations: createAuthorizationChecker({
      vault: new PgCredentialVault(credentialsPool) as never, keyring,
      provider: (c) => (c.channel === 'AMAZON' ? provider() : null), http: (url, init) => model.fetch(url, init),
      // Прогон сжимает часы: проверять каждый действующий токен каждым запуском работы (в процессе — не чаще периода)
      olderThanSeconds: 0, limit: 100, log,
    }),
  };

  const store = new PgPricingStore(appPool, { adminPool, bulkWorkerPool: db.pool('svc_bulk_worker', 1) });
  const nowIso = () => clock.iso();
  const accounts = [{ channelAccountId: seeded.channelAccountId, channel: 'KAUFLAND', marketplaces: ['de'], haltRelease: 'SAMPLE' as const }];
  const live: LiveWorld = {
    id: WORLD, title: 'Подключение Amazon', description: 'Kaufland в тени, Amazon подключается продавцом', tenantId: seeded.tenantId,
    accounts, identityTenantId: seeded.tenantId, membershipAlias: (id) => id, failures: [],
    store: store as never, stock: new PgStockStore({ adminPool, stockPool: db.pool('svc_stock', 1) }),
    pipeline: world.pipelineForDbIds() as never, clock: { iso: nowIso, nowMs: () => clock.nowMs() } as never,
    callContext: (channelAccountId) => ({ tenantId: seeded.tenantId as never, channelAccountId: channelAccountId as never, correlationId: 'connect-43', deadline: nowIso() }),
    view: async (v) => ({ id: WORLD, title: 'Подключение Amazon', description: '', tenantId: seeded.tenantId, now: nowIso(), accounts, viewer: { ...v },
      state: await store.readConsoleState(seeded.tenantId, nowIso() as never) }) as never,
  };
  const directory = new MemoryIdentityDirectory();
  directory.link({ issuer: STAND_ISSUER, subject: 'connect-owner' }, seeded.userId);
  directory.addMembership(seeded.userId, { tenantId: seeded.tenantId, membershipId: seeded.ownerMembershipId, role: 'OWNER' });
  // Наблюдатель: 403 у консоли, до базы; синтетический пользователь стенда
  const viewerUser = '1d000000-0000-4000-8000-000000000043';
  directory.link({ issuer: STAND_ISSUER, subject: 'connect-viewer' }, viewerUser);
  directory.addMembership(viewerUser, { tenantId: seeded.tenantId, membershipId: '1e000000-0000-4000-8000-000000000043', role: 'VIEWER' });
  const issuer = createTestIssuer({ issuer: STAND_ISSUER, audience: STAND_AUDIENCE });
  server = createStandServer(createStandApi([live], {
    authenticator: createAuthenticator({ issuer: STAND_ISSUER, audience: STAND_AUDIENCE, jwks: staticJwks(issuer.jwks), directory }),
    simulator: {
      token: (account) => issuer.token(account.role === 'VIEWER' ? 'connect-viewer' : 'connect-owner', { email: 'owner@example.invalid', amr: ['pwd', 'otp'] }),
      expiresInSeconds: 3600,
    },
  }, { connect: (worldId) => (worldId === WORLD ? connectService : null) }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  model = new ModelOAuthProvider({
    channel: 'AMAZON', clientId: 'amzn1.application-oa2-client.synthetic-43', clientSecret: 'synthetic-client-secret-43',
    redirectUri: `${origin}/connect/callback`, now: () => Date.now(),
  });
  connectService = createChannelConnectService({
    store: new PgChannelConnectStore(adminPool), keyring, http: (url, init) => model.fetch(url, init), log,
    providers: [
      { channel: 'AMAZON', marketplaces: [{ id: AMAZON_DE, region: 'EU' }], platformMissing: [], provider: provider() },
      // Ключей разработчика eBay нет (E-01): канал честно «ожидает доступа платформы» [Р-150], кнопки нет
      { channel: 'EBAY', marketplaces: [{ id: 'EBAY_DE', region: null }], platformMissing: ['EBAY_DEVELOPER_KEYS'], provider: null },
    ],
  });
  owner = await tokenFor('OWNER');
  viewer = await tokenFor('VIEWER');
  const observerUrl = new URL(process.env.REPRACER_PG_ADMIN_URL!); observerUrl.pathname = `/${db.name}`;
  observer = createPool(observerUrl.toString(), { max: 1, applicationName: 'repracer-connect-observer' });
  await observer.query(`UPDATE tenant_data.tenant SET locale = 'en' WHERE tenant_id = $1`, [seeded.tenantId]);
});

after(async () => {
  console.log(JSON.stringify({ connect: { numbers, steps: measured, platformAlerts: platformAlerts.map((a) => a.code) } }, null, 1));
  server?.close();
  await observer?.end();
  await db?.drop();
});

const amazonOf = (v: ConnectionsView) => v.channels.find((c) => c.channel === 'AMAZON')!;
const accountOf = (v: ConnectionsView) => v.accounts.find((a) => a.channelAccountId === connectedAccountId);

test('Р-175, Р-176: от «Connect Amazon» до тени — продавец сам, аккаунт рождается в тени, обнаружение стартует само', async () => {
  const before0 = await call<ConnectionsView>('экран подключений', owner, 'GET', api('connections'));
  assert.equal(before0.status, 200);
  assert.equal(amazonOf(before0.body).state, 'NOT_CONNECTED', 'Amazon ещё не подключён');
  assert.equal(amazonOf(before0.body).canConnect, true);
  const ebay = before0.body.channels.find((c) => c.channel === 'EBAY')!;
  assert.deepEqual([ebay.state, ebay.canConnect], ['AWAITING_PLATFORM', false], 'eBay без ключей разработчика — ожидает доступа платформы, кнопки нет [Р-150]');
  assert.match(ebay.missingText ?? '', /developer keys/);

  // Наблюдатель подключать не может — 403 консоли, а не 500 базы
  const refused = await call<{ error: { code: string } }>('наблюдатель жмёт Connect', viewer, 'POST', api('connections', 'start'), { channel: 'AMAZON', marketplaces: [AMAZON_DE] });
  assert.deepEqual([refused.status, refused.body.error.code], [403, 'FORBIDDEN']);

  const started = await call<{ consentUrl: string }>('Connect Amazon', owner, 'POST', api('connections', 'start'), { channel: 'AMAZON', marketplaces: [AMAZON_DE] });
  assert.equal(started.status, 200);
  const consentUrl = new URL(started.body.consentUrl);
  assert.equal(consentUrl.origin + consentUrl.pathname, 'https://sellercentral-europe.amazon.com/apps/authorize/consent', 'amazon.de — европейский Seller Central');
  const waiting = await call<ConnectionsView>('экран: ждём согласия', owner, 'GET', api('connections'));
  assert.equal(amazonOf(waiting.body).state, 'AWAITING_CONSENT');
  // Находка 17 ревью шага 43: продавец закрыл страницу канала — отменяет попытку сам, а не ждёт десять минут
  const cancelled = await call<{ cancelled: boolean }>('отменить попытку', owner, 'POST', api('connections', 'cancel'), { authorizationRequestId: amazonOf(waiting.body).pendingRequestId });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  const afterCancel = await call<ConnectionsView>('экран после отмены', owner, 'GET', api('connections'));
  assert.deepEqual([amazonOf(afterCancel.body).state, amazonOf(afterCancel.body).canConnect, amazonOf(afterCancel.body).pendingText], ['NOT_CONNECTED', true, null], 'отмена — снова «не подключён», без «последняя попытка не удалась»');
  const cancelledUrl = started.body.consentUrl;
  const late = await call<{ error: { code: string } }>('возврат отменённой попытки', owner, 'POST', api('connections', 'callback'), { params: Object.fromEntries(new URL(lwaApprove(cancelledUrl)).searchParams) });
  assert.equal(late.status, 409, 'возврат отменённой попытки ничего не подключает');
  const restarted = await call<{ consentUrl: string }>('Connect Amazon ещё раз', owner, 'POST', api('connections', 'start'), { channel: 'AMAZON', marketplaces: [AMAZON_DE] });
  started.body.consentUrl = restarted.body.consentUrl;

  const params = await timed('согласие на странице канала', async () => consent(started.body.consentUrl));
  const back = await call<{ channelAccountId: string; reconnected: boolean }>('возврат с кодом', owner, 'POST', api('connections', 'callback'), { params });
  assert.equal(back.status, 200, JSON.stringify(back.body));
  assert.equal(back.body.reconnected, false);
  connectedAccountId = back.body.channelAccountId;

  // Р-176: аккаунт рождается в ТЕНИ, и это решает база (умолчание столбца), а не консоль
  const { rows: [acc] } = await observer.query(
    `SELECT write_mode, auth_status, credentials_ref, external_account_id FROM tenant_data.channel_account WHERE channel_account_id = $1`, [connectedAccountId]);
  assert.deepEqual([acc.write_mode, acc.auth_status, acc.credentials_ref, acc.external_account_id], ['SHADOW', 'ACTIVE', `db:${connectedAccountId}`, SELLER]);

  // Повтор того же возврата — не второе подключение
  const again = await call<{ error: { code: string } }>('повтор возврата', owner, 'POST', api('connections', 'callback'), { params });
  assert.deepEqual([again.status, again.body.error.code], [409, 'ALREADY_DONE']);

  const discovering = await call<ConnectionsView>('экран сразу после возврата', owner, 'GET', api('connections'));
  assert.equal(accountOf(discovering.body)?.state, 'SHADOW');
  assert.match(accountOf(discovering.body)?.progressText ?? '', /Looking for your offers/, 'офферов ещё нет — экран говорит, что поиск идёт');

  // Планировщик берёт новый аккаунт на ближайшем такте: `offer-discovery` у аккаунта — «сразу» [Р-176]
  await timed('планировщик: первый такт с новым аккаунтом', () => schedulerFor(1));
  const { rows: [run] } = await observer.query(
    `SELECT outcome, items, error_code FROM maintenance.scheduled_job_run WHERE job_name = 'offer-discovery' AND job_key LIKE '%' || $1 || '%' ORDER BY finished_at DESC LIMIT 1`, [connectedAccountId]);
  assert.deepEqual([run?.outcome, run?.items], ['SUCCEEDED', SELLER_OFFERS], `обнаружение офферов нового аккаунта прошло само, без действия человека (${run?.error_code ?? ''} ${logLines.filter((l) => l.includes('offer-discovery')).slice(-2).join(' ').slice(0, 600)})`);

  // Шаг 44 [Р-179]: обнаружение записало КАТАЛОГ — товар, предложение, единица записи цены в режиме OFF на каждый оффер
  const { rows: [cat] } = await observer.query(
    `SELECT count(DISTINCT om.offer_mapping_id)::int AS offers, count(DISTINCT ws.write_scope_id) FILTER (WHERE ws.pricing_mode = 'OFF' AND ws.currency = 'EUR')::int AS scopes
       FROM tenant_data.offer_mapping om JOIN tenant_data.write_scope ws ON ws.tenant_id = om.tenant_id AND ws.write_scope_id = om.price_write_scope_id
      WHERE om.channel_account_id = $1`, [connectedAccountId]);
  assert.deepEqual([cat.offers, cat.scopes], [SELLER_OFFERS, SELLER_OFFERS], 'каталог из обнаружения: предложения и единицы записи цены (движок выключен)');
  const found = await call<ConnectionsView>('экран: нашли офферы', owner, 'GET', api('connections'));
  const a = accountOf(found.body)!;
  assert.equal(a.offers, SELLER_OFFERS, `нашли ${a.offers} офферов`);
  assert.match(a.progressText ?? '', new RegExp(`Found ${SELLER_OFFERS} offers`));
  numbers.connectedAccount = { state: a.state, progress: a.progressText, authorization: a.authorizationText };
  // Первая проверка авторизации прошла тем же тактом: токен действующий, отметку поставила база
  assert.match(a.authorizationText, /last confirmed by the channel/);

  /**
   * Находки 2 и 4 ревью шага 43: адаптер получает токен ТЕМ ЖЕ путём, что в диспетчере и планировщике, — по ссылке
   * учётных данных аккаунта через роль адаптеров и кольцо ключей процесса. Чужая ссылка `db:` токена не даёт.
   */
  const credentials = channelCredentialsProvider({
    files: { async get() { throw new Error('NO_FILES_IN_RUN'); } }, vault: { pool: credentialsPool, keyring }, amazonApplication: null,
  });
  const got = await credentials.get(`db:${connectedAccountId}`);
  assert.ok(model.issuedTokens.includes(got.refreshToken ?? ''), 'адаптер по ссылке db: получает действующий refresh-токен');
  await assert.rejects(credentials.get(`db:${world.seeded.channelAccountId}`), /CREDENTIALS_UNREADABLE/, 'ссылка на аккаунт без токена OAuth токена не даёт');
});

test('Р-177: отзыв продавцом в кабинете канала — аккаунт REVOKED, письмо владельцу, экран, «Connect again»', async () => {
  model.revoke(SELLER);
  // Работа проверки — раз в час: виртуальный час и такт
  await timed('планировщик: час после отзыва', () => schedulerFor(61));
  const { rows: [acc] } = await observer.query(`SELECT auth_status FROM tenant_data.channel_account WHERE channel_account_id = $1`, [connectedAccountId]);
  assert.equal(acc.auth_status, 'REVOKED', 'отзыв обнаружен обменом refresh-токена');
  const { rows: alerts } = await observer.query(
    `SELECT severity, delivered_at IS NOT NULL AS delivered FROM tenant_data.alert WHERE channel_account_id = $1 AND code = 'CHANNEL_AUTHORIZATION_REVOKED'`, [connectedAccountId]);
  assert.deepEqual(alerts, [{ severity: 'CRITICAL', delivered: true }], 'один CRITICAL-алерт, и он доставлен');
  const letter = mail.sent.find((l) => l.text.includes('withdrawn'));
  assert.ok(letter, `письмо владельцу об отзыве: ${mail.sent.map((l) => l.subject).join(' | ')}`);
  const { rows: [ownerRow] } = await observer.query(`SELECT email FROM platform.app_user WHERE user_id = $1`, [world.seeded.userId]);
  assert.equal(letter!.to, ownerRow.email, 'письмо ушло владельцу тенанта');
  numbers.revokedLetter = { to: letter!.to, subject: letter!.subject };
  // Отозванный аккаунт планировщик больше не берёт: работ по нему нет, значит нет и «тихих ошибок» каждого такта
  const { rows: [after] } = await observer.query(
    `SELECT count(*) FILTER (WHERE outcome = 'FAILED')::int AS failed FROM maintenance.scheduled_job_run WHERE job_key LIKE '%' || $1 || '%'`, [connectedAccountId]);
  assert.equal(after.failed, 0, 'ни одного провала работ отозванного аккаунта');
  assert.deepEqual(platformAlerts.filter((p) => p.code === 'CHANNEL_APP_CREDENTIALS_REJECTED'), [], 'отзыв продавцом — не поломка платформы');

  const screen = await call<ConnectionsView>('экран: доступ отозван', owner, 'GET', api('connections'));
  const a = accountOf(screen.body)!;
  assert.deepEqual([a.state, a.canReconnect], ['REVOKED', true]);

  const restart = await call<{ consentUrl: string }>('Connect again', owner, 'POST', api('connections', 'start'), { channel: 'AMAZON', marketplaces: a.marketplaces });
  const params = await timed('согласие заново', async () => consent(restart.body.consentUrl));
  const back = await call<{ channelAccountId: string; reconnected: boolean }>('возврат после повторного согласия', owner, 'POST', api('connections', 'callback'), { params });
  assert.deepEqual([back.status, back.body.channelAccountId, back.body.reconnected], [200, connectedAccountId, true], 'тот же аккаунт, а не второй');
  const { rows } = await observer.query(
    `SELECT version, superseded_at IS NULL AS current FROM tenant_data.channel_credential WHERE channel_account_id = $1 ORDER BY version`, [connectedAccountId]);
  assert.deepEqual(rows, [{ version: 1, current: false }, { version: 2, current: true }], 'новая версия токена, прежняя вытеснена');
  const { rows: [again] } = await observer.query(`SELECT auth_status, write_mode FROM tenant_data.channel_account WHERE channel_account_id = $1`, [connectedAccountId]);
  assert.deepEqual([again.auth_status, again.write_mode], ['ACTIVE', 'SHADOW'], 'доступ снова действует, режим — прежний (тень)');
});

test('Р-177: токены и коды согласия не встречаются ни в ответах, ни в письмах, ни в журналах, ни в дампе базы', async () => {
  const secrets = [...model.issuedTokens, ...codes];
  assert.ok(model.issuedTokens.length >= 4 && codes.length === 2, `модель выдала ${model.issuedTokens.length} токенов и ${codes.length} кода`);
  const places: Array<[string, string]> = [
    ['ответы консоли', responses.join('\n')],
    ['письма', mail.sent.map((l) => `${l.subject}\n${l.text}`).join('\n')],
    ['журналы процессов', logLines.join('\n')],
  ];
  const url = new URL(process.env.REPRACER_PG_ADMIN_URL!); url.pathname = `/${db.name}`;
  const dump = execFileSync('pg_dump', ['--data-only', '--no-owner', url.toString()], { maxBuffer: 512 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8');
  places.push(['дамп всей базы', dump]);
  // Положительный контроль поиска: у отозванного аккаунта в дампе есть идентификатор продавца — искать есть где
  assert.ok(dump.includes(SELLER), 'дамп содержит данные прогона');
  for (const [where, text] of places) {
    // Находка 20 ревью шага 43: bytea в дампе — шестнадцатеричный; токен, попавший байтами в чужую таблицу, ищется и так
    const leaked = secrets.filter((s) => text.includes(s) || text.includes(Buffer.from(s, 'utf8').toString('hex')));
    assert.deepEqual(leaked.map((s) => `${s.slice(0, 5)}…`), [], `${where}: найден секрет`);
    assert.doesNotMatch(text, /Atzr\||Atza\|/, `${where}: нет ни одной строки формы токена Amazon`);
  }
  numbers.leakScan = { secrets: secrets.length, dumpBytes: dump.length, places: places.map(([w]) => w) };
});
