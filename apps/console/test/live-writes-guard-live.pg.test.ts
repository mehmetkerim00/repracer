import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { PriceFeedView, ShadowView } from '@repracer/console-model';
import type { StandToken } from '../src/api-types.ts';
import { STAND_AUDIENCE, STAND_ISSUER, type LiveWorld } from '@repracer/contract-tests/stand';
import { demoWorld, nextNineUtc, DEMO_OFFERS, type DemoWorld } from '@repracer/contract-tests/live';
import { createAuthenticator, MemoryIdentityDirectory, staticJwks } from '@repracer/identity';
import { createTestIssuer } from '@repracer/identity/test-issuer';
import { PgPricingStore, PgShadowStore, PgStockStore, type PgPool } from '@repracer/pricing-store-pg';
import { createIsolatedDatabase, type IsolatedDatabase } from '../../../packages/pricing-store-pg/test/isolated-db.ts';
import { createStandApi, createStandServer } from '../server/stand-server.ts';

/**
 * Шаг 119 (P0-09): QA не отправляет в канал ничего от клиентского тенанта — живым прогоном через консоль как браузер [Р-136, Р-142].
 *
 * Мир — клиентский тенант (не демо) на симуляторе Kaufland, аккаунт БОЕВОЙ. Базу закрывают настройкой уровня базы уже ПОСЛЕ посева —
 * так выглядит QA, куда восстановили копию с боевыми аккаунтами, или QA, где аккаунт перевели в бой до того, как появился страж:
 *  1) движок решает, а к каналу не уходит ни одного изменяющего запроса; журнал цен называет причину словами;
 *  2) владелец со вторым фактором и набранным именем аккаунта уходит в тень, а обратно в бой — 409 со своей причиной;
 *  3) контроль: база без настройки — тот же перевод в бой проходит.
 * Данные синтетические.
 */

const WORLD = 'qa/kaufland';
/** Предел ожидания первой отказанной цены: мир на 200 предложениях на старом коде отправлял цены в первый же час (15 PATCH и 8 пакетов) */
const MAX_VIRTUAL_HOURS = 1;
const PHRASE = /live writes are switched off on its database/;

let db: IsolatedDatabase;
let demo: DemoWorld;
let server: Server;
let origin = '';
let owner: { authorization: string; cookie: string };
const numbers: Record<string, unknown> = {};

const api = (screen: string, param?: string) => `/api/worlds/${encodeURIComponent(WORLD)}/${screen}${param ? `/${param}` : ''}`;

async function call<T>(method: 'GET' | 'POST', url: string, body?: unknown): Promise<{ status: number; body: T }> {
  const r = await fetch(`${origin}${url}`, {
    method,
    headers: { authorization: owner.authorization, cookie: owner.cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await r.text();
  return { status: r.status, body: (text ? JSON.parse(text) : null) as T };
}

async function signIn(): Promise<void> {
  const token = await fetch(`${origin}/api/stand-issuer/token?locale=en`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: 'OWNER' }) });
  owner = { authorization: `Bearer ${((await token.json()) as StandToken).accessToken}`, cookie: 'repracer_locale=en' };
}

/** Запросы симулятора, меняющие данные канала: на закрытой базе их не должно быть ни одного */
const writeRequests = (): Array<[string, number]> => [...demo.live.requests.entries()].filter(([route]) => !route.startsWith('GET '));

/** Настройку уровня базы ставит владелец базы — так её ставит развёртывание QA */
const liveWrites = (value: 'forbidden' | null) => db.superuser(value === null
  ? `ALTER DATABASE ${db.name} RESET repracer.live_writes`
  : `ALTER DATABASE ${db.name} SET repracer.live_writes = '${value}'`);

/** Журнал цен показывает записи ЦЕНЫ: прогон ждёт первую цену, завершённую стражем, — записи количества идут раньше */
const ended = async (): Promise<{ guarded: number; guardedPrices: number; applied: number }> => {
  const [r] = await db.rows<{ guarded: number; guarded_prices: number; applied: number }>(
    `SELECT count(*) FILTER (WHERE end_reason = 'WRITE_LIVE_WRITES_FORBIDDEN')::int AS guarded,
            count(*) FILTER (WHERE end_reason = 'WRITE_LIVE_WRITES_FORBIDDEN' AND field = 'PRICE')::int AS guarded_prices,
            count(*) FILTER (WHERE final_status = 'APPLIED')::int AS applied
       FROM tenant_data.channel_write_history WHERE tenant_id = $1`, [demo.live.seeded.tenantId]);
  return { guarded: Number(r!.guarded), guardedPrices: Number(r!.guarded_prices), applied: Number(r!.applied) };
};

before(async () => {
  db = await createIsolatedDatabase('qaguard');
  const appPool: PgPool = db.pool('svc_app', 4);
  const adminPool: PgPool = db.pool('svc_admin', 4);
  // Клиентский тенант, боевой аккаунт: демо-тенант стражем не держится (его путь на симуляторе QA проверяет), поэтому мир — не демо
  demo = await demoWorld({
    tag: 1190, startIso: nextNineUtc(), bare: false, writeMode: 'LIVE', demo: false,
    appPool, adminPool, provisioningPool: db.pool('svc_provisioning', 1), dispatcherPool: db.pool('svc_dispatcher', 2),
    schedulerPool: db.pool('svc_scheduler', 3), exporterPool: db.pool('svc_exporter', 2), stockPool: db.pool('svc_stock', 2),
  });
  const seeded = demo.live.seeded;
  const store = new PgPricingStore(appPool, { adminPool, bulkWorkerPool: db.pool('svc_bulk_worker', 2) });
  const nowIso = () => demo.clock.iso();
  const accounts = [{ channelAccountId: seeded.channelAccountId, channel: 'KAUFLAND', marketplaces: ['de'], haltRelease: 'SAMPLE' as const }];
  const live: LiveWorld = {
    id: WORLD, title: 'QA: Kaufland', description: `${DEMO_OFFERS} offers`, tenantId: seeded.tenantId,
    accounts, identityTenantId: seeded.tenantId, membershipAlias: (id) => id, failures: [],
    store: store as never, stock: new PgStockStore({ adminPool, stockPool: db.pool('svc_stock', 2) }),
    shadow: new PgShadowStore({ adminPool }),
    pipeline: demo.live.pipelineForDbIds() as never, clock: { iso: nowIso, nowMs: () => demo.clock.nowMs() } as never,
    callContext: (channelAccountId) => ({ tenantId: seeded.tenantId as never, channelAccountId: channelAccountId as never, correlationId: 'qa-guard', deadline: nowIso() }),
    view: async (viewer, options) => ({
      id: WORLD, title: 'QA: Kaufland', description: `${DEMO_OFFERS} offers`, tenantId: seeded.tenantId, now: nowIso(),
      accounts, viewer: { ...viewer }, state: await store.readConsoleState(seeded.tenantId, nowIso() as never, options),
    }) as never,
  };
  const directory = new MemoryIdentityDirectory();
  directory.link({ issuer: STAND_ISSUER, subject: 'qa-owner' }, seeded.userId);
  directory.addMembership(seeded.userId, { tenantId: seeded.tenantId, membershipId: seeded.ownerMembershipId, role: 'OWNER' });
  const issuer = createTestIssuer({ issuer: STAND_ISSUER, audience: STAND_AUDIENCE });
  server = createStandServer(createStandApi([live], {
    authenticator: createAuthenticator({ issuer: STAND_ISSUER, audience: STAND_AUDIENCE, jwks: staticJwks(issuer.jwks), directory }),
    // Второй фактор есть: всё, что требует перевод в бой [Р-170], у владельца есть — отказывать должна настройка базы
    simulator: { token: () => issuer.token('qa-owner', { email: 'owner@example.invalid', amr: ['pwd', 'otp'] }), expiresInSeconds: 3600 },
  }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await signIn();
  // База закрывается ПОСЛЕ посева: аккаунт уже боевой
  await liveWrites('forbidden');
});

after(async () => {
  console.log(JSON.stringify({ qaGuard: numbers }, null, 1));
  server?.close();
  await db?.drop();
});

test('P0-09: on a guarded database a LIVE non-demo world decides, sends nothing to the channel, and Price changes says why', async () => {
  let hours = 0;
  let state = await ended();
  while (state.guardedPrices === 0 && hours < MAX_VIRTUAL_HOURS) {
    await demo.advance(0.25);
    hours += 0.25;
    state = await ended();
  }
  const [d] = await db.rows<{ n: number }>(`SELECT count(*)::int AS n FROM channel_data.price_decision WHERE tenant_id = $1`, [demo.live.seeded.tenantId]);
  Object.assign(numbers, { virtualHours: hours, decisions: Number(d!.n), ...state, channelRequests: Object.fromEntries(demo.live.requests) });
  assert.ok(Number(d!.n) > 0, 'the engine decided');
  assert.ok(state.guardedPrices > 0, `prices ended by the guard within ${hours} virtual hours: ${state.guardedPrices} (all writes: ${state.guarded})`);
  assert.equal(state.applied, 0, 'no write was applied by the channel');
  // ГЛАВНОЕ: ни одного изменяющего запроса к каналу — цены и количества
  assert.deepEqual(writeRequests(), [], `write requests to the simulator on a guarded database: ${JSON.stringify(writeRequests())}`);
  assert.ok([...demo.live.requests.keys()].some((route) => route.startsWith('GET ')), 'the channel is still read');
  const failures = await db.rows<{ job_name: string; error_code: string }>(
    `SELECT job_name, error_code FROM maintenance.scheduled_job_run WHERE outcome = 'FAILED' AND error_code IS DISTINCT FROM 'CLICKHOUSE_NOT_IN_DEMO'`);
  assert.deepEqual(failures, [], 'the guard ends writes with a reason and does not fail the background jobs');

  const feed = await call<PriceFeedView>('GET', `${api('feed')}?status=NOT_SENT&limit=50`);
  assert.equal(feed.status, 200, JSON.stringify(feed.body));
  // Видимое продавцу — заголовок и текст причины; код в объекте причины — для экрана, не для чтения
  const named = feed.body.items.filter((i) => i.reason?.code === 'WRITE_LIVE_WRITES_FORBIDDEN');
  assert.ok(named.length > 0, `Price changes lists writes ended by the guard: ${JSON.stringify(feed.body.items.slice(0, 2))}`);
  for (const i of named) {
    assert.match(i.reason!.text, PHRASE, 'the reason is named in words');
    assert.equal(/[A-Z]{3,}_[A-Z_]+/.test(`${i.reason!.title} ${i.reason!.text}`), false, `no code in the visible words: ${i.reason!.title} | ${i.reason!.text}`);
    assert.deepEqual(i.reason!.problems, [], 'the reason explains itself without problems');
  }
});

test('P0-09: the owner goes back to shadow, and the switch back to LIVE is refused with a named reason; without the guard it passes', async () => {
  await signIn();
  const accountId = demo.live.seeded.channelAccountId;
  const shadow = await call<{ mode: string }>('POST', api('shadow', 'mode'), { channelAccountId: accountId, toMode: 'SHADOW' });
  assert.equal(shadow.status, 200, `going back to shadow on a guarded database: ${JSON.stringify(shadow.body)}`);

  /**
   * Шаг 120 (отложенное шага 119): экран тени говорит, что бой закрыт, ДО попытки — и поля перевода в бой у аккаунта нет. Иначе
   * тестировщик набирает имя аккаунта, получает 409 и решает, что сломано
   */
  const screen = await call<ShadowView>('GET', `${api('shadow')}?offset=0&limit=10`);
  assert.equal(screen.status, 200, JSON.stringify(screen.body));
  assert.match(screen.body.liveBlockedText ?? '', PHRASE, `the shadow screen says before any attempt that live writes are off: ${screen.body.liveBlockedText}`);
  assert.equal(screen.body.accounts.find((a) => a.channelAccountId === accountId)?.canGoLive, false, 'no switch to LIVE is offered on a guarded database');

  const [acc] = await db.rows<{ external_account_id: string }>(`SELECT external_account_id FROM tenant_data.channel_account WHERE channel_account_id = $1`, [accountId]);
  const live = await call<{ error: { code: string; message: string } }>('POST', api('shadow', 'mode'),
    { channelAccountId: accountId, toMode: 'LIVE', typedConfirmation: acc!.external_account_id });
  assert.deepEqual([live.status, live.body.error?.code], [409, 'LIVE_WRITES_FORBIDDEN'], `switching to LIVE on a guarded database: ${JSON.stringify(live.body)}`);
  assert.match(live.body.error.message, PHRASE, 'the refusal names the guard in words');
  numbers.refusal = live.body.error.message;

  // Контроль [Р-94]: тот же человек, тот же аккаунт и то же подтверждение — без настройки базы бой включается
  await liveWrites(null);
  const open = await call<ShadowView>('GET', `${api('shadow')}?offset=0&limit=10`);
  assert.equal(PHRASE.test(open.body.liveBlockedText ?? ''), false, `control: without the guard the screen does not say it: ${open.body.liveBlockedText}`);
  assert.equal(open.body.accounts.find((a) => a.channelAccountId === accountId)?.canGoLive, true, 'control: without the guard the switch is offered');
  const control = await call<{ mode: string }>('POST', api('shadow', 'mode'), { channelAccountId: accountId, toMode: 'LIVE', typedConfirmation: acc!.external_account_id });
  assert.deepEqual([control.status, control.body.mode], [200, 'LIVE'], `control: the same switch without the guard: ${JSON.stringify(control.body)}`);
});
