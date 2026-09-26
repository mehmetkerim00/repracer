import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ShadowView } from '@repracer/console-model';
import type { StandToken } from '../src/api-types.ts';
import { STAND_AUDIENCE, STAND_ISSUER, type LiveWorld } from '@repracer/contract-tests/stand';
import { demoWorld, nextNineUtc, DEMO_OFFERS, type DemoWorld } from '@repracer/contract-tests/live';
import { createAuthenticator, MemoryIdentityDirectory, staticJwks } from '@repracer/identity';
import { createTestIssuer } from '@repracer/identity/test-issuer';
import { createShadowDigest } from '@repracer/alert-delivery/shadow-digest';
import { FakeMail } from '@repracer/alert-delivery/testing';
import { PgPricingStore, PgShadowDigestStore, PgShadowStore, PgStockStore, type PgPool } from '@repracer/pricing-store-pg';
import { createIsolatedDatabase, type IsolatedDatabase } from '../../../packages/pricing-store-pg/test/isolated-db.ts';
import { createStandApi, createStandServer } from '../server/stand-server.ts';

/**
 * Р-169…Р-171 (шаг 41): ТЕНЕВОЙ РЕЖИМ живым прогоном. Демо-мир на симуляторе Kaufland подключён, движок работает целиком
 * виртуальные сутки — и к каналу не уходит НИ ОДНОГО изменяющего запроса. Это утверждается числом: у симулятора считаются
 * все запросы по маршрутам, и среди них нет ни одного не-GET.
 *
 * Потом продавец включает бой ЧЕРЕЗ КОНСОЛЬ [Р-136, Р-142] — со вторым фактором и набранным именем аккаунта — записи
 * идут; возврат в тень одним нажатием — останавливаются. Данные синтетические.
 */

const DEMO_WORLD = 'demo/kaufland';
const VIRTUAL_HOURS = Number(process.env.REPRACER_SHADOW_HOURS ?? 24);
/**
 * Нижняя граница объёма: прогон нельзя «пройти» пустым миром (замер шага 35 — 143 900 решений за сутки). Короткое окно
 * (`REPRACER_SHADOW_HOURS`) существует для отладки самого прогона; в сборке и CI он идёт сутками, и граница — суточная.
 */
const MIN_DECISIONS = VIRTUAL_HOURS >= 24 ? 50_000 : 2_000;
const SCREEN_LIMIT_SECONDS = 10;

let db: IsolatedDatabase;
let demo: DemoWorld;
let server: Server;
let origin = '';
let owner: { authorization: string; cookie: string };
let observer: PgPool;
let deliveryPool: PgPool;
const mail = new FakeMail();
const measured: Array<{ operation: string; seconds: number; status: number }> = [];
/** Числа прогона — в журнал: отчёт шага берёт их отсюда */
const numbers: Record<string, unknown> = {};

const api = (screen: string, param?: string) => `/api/worlds/${encodeURIComponent(DEMO_WORLD)}/${screen}${param ? `/${param}` : ''}`;

async function call<T>(operation: string, method: 'GET' | 'POST', url: string, body?: unknown): Promise<{ status: number; body: T; seconds: number }> {
  const started = process.hrtime.bigint();
  const r = await fetch(`${origin}${url}`, {
    method,
    headers: { authorization: owner.authorization, cookie: owner.cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await r.text();
  const seconds = Math.round(Number(process.hrtime.bigint() - started) / 1e6) / 1000;
  measured.push({ operation, seconds, status: r.status });
  return { status: r.status, body: (text ? JSON.parse(text) : null) as T, seconds };
}

async function signIn(): Promise<void> {
  const token = await fetch(`${origin}/api/stand-issuer/token?locale=de`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: 'OWNER' }) });
  owner = { authorization: `Bearer ${((await token.json()) as StandToken).accessToken}`, cookie: 'repracer_locale=de' };
}

/** Запросы симулятора, меняющие данные канала: их не должно быть ни одного, пока аккаунт в тени */
function writeRequests(): Array<[string, number]> {
  return [...demo.live.requests.entries()].filter(([route]) => !route.startsWith('GET '));
}

const appliedWrites = async (): Promise<number> => {
  const { rows: [r] } = await observer.query(
    `SELECT count(*)::int AS n FROM tenant_data.channel_write_history WHERE tenant_id = $1 AND final_status = 'APPLIED'`,
    [demo.live.seeded.tenantId]);
  return Number(r!.n);
};

before(async () => {
  db = await createIsolatedDatabase('shadowday');
  const appPool: PgPool = db.pool('svc_app', 4);
  const adminPool: PgPool = db.pool('svc_admin', 4);
  deliveryPool = db.pool('svc_alert_delivery', 1);
  // Мир подключён в ТЕНИ: так его получает продавец, подключивший канал [Р-170]
  demo = await demoWorld({
    tag: 4100, startIso: nextNineUtc(), bare: false, writeMode: 'SHADOW',
    appPool, adminPool, provisioningPool: db.pool('svc_provisioning', 1), dispatcherPool: db.pool('svc_dispatcher', 2),
    schedulerPool: db.pool('svc_scheduler', 3), exporterPool: db.pool('svc_exporter', 2), stockPool: db.pool('svc_stock', 2),
  });
  const seeded = demo.live.seeded;
  const store = new PgPricingStore(appPool, { adminPool, bulkWorkerPool: db.pool('svc_bulk_worker', 2) });
  const nowIso = () => demo.clock.iso();
  const accounts = [{ channelAccountId: seeded.channelAccountId, channel: 'KAUFLAND', marketplaces: ['de'], haltRelease: 'SAMPLE' as const }];
  const live: LiveWorld = {
    id: DEMO_WORLD, title: 'Демо: Kaufland в тени', description: `${DEMO_OFFERS} предложений`, tenantId: seeded.tenantId,
    accounts, identityTenantId: seeded.tenantId, membershipAlias: (id) => id, failures: [],
    store: store as never, stock: new PgStockStore({ adminPool, stockPool: db.pool('svc_stock', 2) }),
    shadow: new PgShadowStore({ adminPool }),
    pipeline: demo.live.pipelineForDbIds() as never, clock: { iso: nowIso, nowMs: () => demo.clock.nowMs() } as never,
    callContext: (channelAccountId) => ({ tenantId: seeded.tenantId as never, channelAccountId: channelAccountId as never, correlationId: 'shadow-day', deadline: nowIso() }),
    view: async (viewer) => ({
      id: DEMO_WORLD, title: 'Демо: Kaufland в тени', description: `${DEMO_OFFERS} предложений`, tenantId: seeded.tenantId, now: nowIso(),
      accounts, viewer: { ...viewer }, state: await store.readConsoleState(seeded.tenantId, nowIso() as never),
    }) as never,
  };
  const directory = new MemoryIdentityDirectory();
  directory.link({ issuer: STAND_ISSUER, subject: 'demo-owner' }, seeded.userId);
  directory.addMembership(seeded.userId, { tenantId: seeded.tenantId, membershipId: seeded.ownerMembershipId, role: 'OWNER' });
  const issuer = createTestIssuer({ issuer: STAND_ISSUER, audience: STAND_AUDIENCE });
  server = createStandServer(createStandApi([live], {
    authenticator: createAuthenticator({ issuer: STAND_ISSUER, audience: STAND_AUDIENCE, jwks: staticJwks(issuer.jwks), directory }),
    // amr со вторым фактором: включение боя без него отклонит база, и это проверяется отдельно
    simulator: { token: () => issuer.token('demo-owner', { email: 'owner@example.invalid', amr: ['pwd', 'otp'] }), expiresInSeconds: 3600 },
  }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await signIn();
  const observerUrl = new URL(process.env.REPRACER_PG_ADMIN_URL!); observerUrl.pathname = `/${db.name}`;
  const { createPool } = await import('@repracer/pricing-store-pg');
  observer = createPool(observerUrl.toString(), { max: 1, applicationName: 'repracer-shadow-day-observer' });
});

after(async () => {
  console.log(JSON.stringify({ shadow: { virtualHours: VIRTUAL_HOURS, numbers, operations: measured } }, null, 1));
  server?.close();
  await observer?.end();
  await db?.drop();
});

test('Р-169: сутки демо в тени — движок работает целиком, к каналу не уходит ни одного изменяющего запроса', async () => {
  const started = Date.now();
  await demo.advance(VIRTUAL_HOURS);
  const seconds = Math.round((Date.now() - started) / 100) / 10;
  measured.push({ operation: `demo.advance (${VIRTUAL_HOURS} виртуальных часа в тени)`, seconds, status: 200 });

  const { rows: [d] } = await observer.query(
    `SELECT count(*)::int AS n, count(*) FILTER (WHERE shadow)::int AS shadowed,
            count(*) FILTER (WHERE outcome <> 'NO_CHANGE')::int AS interventions
       FROM channel_data.price_decision WHERE tenant_id = $1`, [demo.live.seeded.tenantId]);
  const { rows: [h] } = await observer.query(
    `SELECT count(*) FILTER (WHERE final_status = 'SHADOW_HELD')::int AS held,
            count(*) FILTER (WHERE final_status = 'APPLIED')::int AS applied,
            count(*) FILTER (WHERE would_spend_budget)::int AS would_spend
       FROM tenant_data.channel_write_history WHERE tenant_id = $1`, [demo.live.seeded.tenantId]);
  const { rows: failures } = await observer.query(
    `SELECT job_name, error_code, count(*)::int AS n FROM maintenance.scheduled_job_run WHERE outcome = 'FAILED' GROUP BY 1, 2 ORDER BY 1`);
  Object.assign(numbers, {
    decisions: Number(d!.n), shadowDecisions: Number(d!.shadowed), interventions: Number(d!.interventions),
    heldWrites: Number(h!.held), appliedWrites: Number(h!.applied), wouldSpendBudget: Number(h!.would_spend),
    channelRequests: Object.fromEntries(demo.live.requests), seconds,
  });

  // Движок РАБОТАЛ: решений столько же, сколько у боевого мира тех же суток
  assert.ok(Number(d!.n) >= MIN_DECISIONS, `решений за сутки: ${d!.n} (не меньше ${MIN_DECISIONS})`);
  // И каждое из них помечено тенью базой [Р-171]
  assert.equal(Number(d!.shadowed), Number(d!.n), 'все решения суток помечены тенью');
  // Записи СОЗДАВАЛИСЬ и удерживались: ноль здесь значил бы, что тень проверена пустотой
  assert.ok(Number(h!.held) > 0, `записей удержано тенью: ${h!.held}`);
  assert.equal(Number(h!.applied), 0, 'ни одна запись не применена каналом: их туда не отправляли');

  // ГЛАВНОЕ УТВЕРЖДЕНИЕ [Р-169]: ни одного изменяющего запроса к каналу за сутки
  assert.deepEqual(writeRequests(), [], `запросы записи к симулятору за сутки в тени: ${JSON.stringify(writeRequests())}`);
  // Чтение канала при этом шло по-настоящему [Р-171]: тень читает, не пишет
  const reads = [...demo.live.requests.entries()].filter(([route]) => route.startsWith('GET ')).reduce((sum, [, n]) => sum + n, 0);
  assert.ok(reads > 0, `запросов чтения к каналу за сутки: ${reads} — тень читает по-настоящему`);
  Object.assign(numbers, { channelReads: reads });

  assert.deepEqual(failures.filter((f) => !(f.job_name === 'analytics-export-day' && f.error_code === 'CLICKHOUSE_NOT_IN_DEMO')), [],
    `провалы работ планировщика: ${JSON.stringify(failures)}`);
});

test('Р-168, Р-171: экран тени и недельный дайджест наполнены теми же числами', async () => {
  await signIn();
  const screen = await call<ShadowView>('экран тени', 'GET', `${api('shadow')}?offset=0&limit=50`);
  assert.equal(screen.status, 200);
  assert.ok(screen.seconds < SCREEN_LIMIT_SECONDS, `экран тени ответил за ${screen.seconds} с при пределе ${SCREEN_LIMIT_SECONDS} с`);
  assert.equal(screen.body.anyShadow, true, 'экран знает, что аккаунт в тени');
  assert.ok(screen.body.summary.decisions > 0 && screen.body.rows.length > 0, 'сводка и список would-be изменений не пусты');
  assert.equal(screen.body.summary.heldWrites, Number(numbers.heldWrites), 'сводка экрана совпадает с базой');
  /**
   * Находка 3 ревью шага 41: «пол удержал N раз» считался исходом `CLAMPED_FLOOR`, которого не производит ни одна строка
   * кода, — число было структурным нулём. Теперь оно считается столбцами, и прогон сверяет его НЕЗАВИСИМЫМ запросом.
   */
  const { rows: [floors] } = await observer.query(
    `SELECT count(*)::int AS n FROM channel_data.price_decision
      WHERE tenant_id = $1 AND shadow AND final_amount_minor IS NOT NULL AND final_amount_minor = effective_floor_minor`,
    [demo.live.seeded.tenantId]);
  assert.equal(screen.body.summary.floorHeld, Number(floors!.n), 'число «цена пришла ровно на пол» совпадает с независимым запросом');
  // Каждая строка ведёт к объяснению «почему эта цена» [Р-68]
  assert.ok(screen.body.rows.some((r) => r.priceDecisionId !== null), 'у удержанных записей цены есть решение с объяснением');
  Object.assign(numbers, { screenSummary: screen.body.summary, screenSeconds: screen.seconds });

  const digest = createShadowDigest({ store: new PgShadowDigestStore(deliveryPool), mail, now: () => new Date().toISOString(), log: () => undefined });
  const outcome = await digest.send();
  assert.equal(outcome.letters, 1, `дайджест: ${JSON.stringify(outcome)}`);
  const letter = mail.sent.at(-1)!;
  // Письмо несёт ТЕ ЖЕ числа, что экран: сверяется удержанными записями
  assert.ok(letter.text.includes(String(screen.body.summary.heldWrites)), 'в письме то же число удержанных записей, что на экране');
  assert.match(letter.subject, /Schattenmodus|getan hätte/, 'письмо на языке тенанта (de)');
  Object.assign(numbers, { digest: outcome, digestSubject: letter.subject });
});

test('Р-170: включение боя через консоль — со вторым фактором и набранным именем аккаунта; записи пошли', async () => {
  await signIn();
  const accountId = demo.live.seeded.channelAccountId;
  // Чужой текст подтверждения не включает бой: отказ приходит от базы
  const wrong = await call<{ code: string }>('включить бой с чужим подтверждением', 'POST', api('shadow', 'mode'),
    { channelAccountId: accountId, toMode: 'LIVE', typedConfirmation: 'ja' });
  assert.equal(wrong.status, 400, 'подтверждение, не называющее аккаунт, отклонено');

  const { rows: [acc] } = await observer.query(`SELECT external_account_id FROM tenant_data.channel_account WHERE channel_account_id = $1`, [accountId]);
  const live = await call<{ mode: string }>('включить боевой режим', 'POST', api('shadow', 'mode'),
    { channelAccountId: accountId, toMode: 'LIVE', typedConfirmation: acc!.external_account_id });
  assert.equal(live.status, 200, `включение боя: ${JSON.stringify(live.body)}`);
  assert.equal(live.body.mode, 'LIVE');

  const before = await appliedWrites();
  await demo.advance(1);
  const after = await appliedWrites();
  const writes = writeRequests();
  Object.assign(numbers, { appliedAfterGoingLive: after, writeRequestsAfterGoingLive: Object.fromEntries(writes) });
  assert.ok(after > before, `после включения боя записи, подтверждённые каналом: ${after} (было ${before})`);
  assert.ok(writes.length > 0, 'к каналу пошли изменяющие запросы — тень выключена не словом, а поведением');
});

test('Р-170: возврат в тень одним нажатием — записи остановились', async () => {
  await signIn();
  const accountId = demo.live.seeded.channelAccountId;
  const back = await call<{ mode: string }>('вернуть в тень', 'POST', api('shadow', 'mode'), { channelAccountId: accountId, toMode: 'SHADOW' });
  assert.equal(back.status, 200, `возврат в тень: ${JSON.stringify(back.body)}`);
  assert.equal(back.body.mode, 'SHADOW');

  const applied = await appliedWrites();
  const requestsBefore = writeRequests().reduce((sum, [, n]) => sum + n, 0);
  await demo.advance(1);
  const appliedAfter = await appliedWrites();
  const requestsAfter = writeRequests().reduce((sum, [, n]) => sum + n, 0);
  Object.assign(numbers, { appliedAfterBackToShadow: appliedAfter, writeRequestsAfterBackToShadow: requestsAfter });
  assert.equal(appliedAfter, applied, `после возврата в тень подтверждённых записей столько же: ${appliedAfter}`);
  assert.equal(requestsAfter, requestsBefore, 'к каналу не ушло ни одного нового изменяющего запроса');

  // Решения при этом идут дальше и снова помечены тенью
  const { rows: [d] } = await observer.query(
    `SELECT count(*) FILTER (WHERE shadow)::int AS shadowed, count(*) FILTER (WHERE NOT shadow)::int AS liveDecisions
       FROM channel_data.price_decision WHERE tenant_id = $1`, [demo.live.seeded.tenantId]);
  assert.ok(Number(d!.livedecisions) > 0, 'решения боевого часа помечены боевыми');
  Object.assign(numbers, { shadowDecisionsTotal: Number(d!.shadowed), liveDecisions: Number(d!.livedecisions) });
});
