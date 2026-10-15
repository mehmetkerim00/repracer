import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { messagesFor, type ConnectionsView, type ShadowView, type StopView } from '@repracer/console-model';
import { pgStandJoinAs, pgStandJoinMember, pgStandUsers, STAND_ACCOUNTS, STAND_AUDIENCE, STAND_EMAILS, STAND_ISSUER, STAND_PEOPLE } from '@repracer/contract-tests/stand';
import { createAuthenticator, staticJwks } from '@repracer/identity';
import { PgIdentityDirectory } from '@repracer/identity/pg';
import { createTestIssuer } from '@repracer/identity/test-issuer';
import { inTenant, PgChannelConnectStore, PgPricingStore, PgShadowStore, PgStockStore } from '@repracer/pricing-store-pg';
import type { SessionView, StandToken, WorldSummary } from '../src/api-types.ts';
import { createIsolatedDatabase, type IsolatedDatabase } from '../../../packages/pricing-store-pg/test/isolated-db.ts';
import { readOnlyConnections } from '../server/connect.ts';
import { startDemoWorld, type RunningDemoWorld } from '../server/demo-world.ts';
import { startDemoSellers, type RunningDemoSellers } from '../server/demo-sellers.ts';
import { createStandApi, createStandServer } from '../server/stand-server.ts';

/**
 * Шаг 88 [Р-213] живым прогоном как браузер [Р-136, Р-142]: американское демо на PostgreSQL — тот же посев, что у стенда показа, —
 * и вход стенда синтетическими людьми по ролям. Проверяется то, что увидит зритель, и то, что держит база:
 *  - вход предлагает три роли (владелец, менеджер, наблюдатель);
 *  - в журнале демо — смена роли «наблюдатель → менеджер», которую владелец сделал при посеве настоящим путём базы;
 *  - менеджер ведёт ежедневную работу (стоп-кран, источник остатков), но не людей, не аккаунты каналов и не бой: консоль не
 *    предлагает, и база отказывает сама, если обойти консоль (перевод в бой, подтверждение записи количества, ответ о других
 *    инструментах, смена роли);
 *  - наблюдатель не меняет ничего.
 * Данные синтетические.
 */

let db: IsolatedDatabase;
let demo: RunningDemoWorld;
let sellers: RunningDemoSellers;
let server: Server;
let origin = '';
let worldId = '';

async function call<T>(method: 'GET' | 'POST', path: string, token: string, body?: unknown): Promise<{ status: number; body: T }> {
  const r = await fetch(`${origin}${path}`, {
    method, headers: { authorization: `Bearer ${token}`, cookie: 'repracer_locale=en', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await r.text();
  return { status: r.status, body: (text ? JSON.parse(text) : null) as T };
}
async function signIn(role: string): Promise<string> {
  const r = await fetch(`${origin}/api/stand-issuer/token?locale=en`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role }) });
  assert.equal(r.status, 200, role);
  return ((await r.json()) as StandToken).accessToken;
}
const api = (...parts: string[]) => `/api/worlds/${[worldId, ...parts].map(encodeURIComponent).join('/')}`;

before(async () => {
  db = await createIsolatedDatabase('roles88');
  const admin = db.pool('svc_admin', 4);
  const directory = new PgIdentityDirectory(db.pool('svc_authenticator', 2) as never);
  const memberUsers = await pgStandUsers(directory, db.pool('svc_onboarding', 1));
  demo = await startDemoWorld({
    pools: {
      app: db.pool('svc_app', 6), admin, provisioning: db.pool('svc_provisioning', 1), dispatcher: db.pool('svc_dispatcher', 2),
      scheduler: db.pool('svc_scheduler', 3), exporter: db.pool('svc_exporter', 2), stock: db.pool('svc_stock', 2), bulkWorker: db.pool('svc_bulk_worker', 2),
    },
    pgUrl: db.url('svc_app'), pgUrlsByRole: { admin: db.url('svc_admin'), bulk_worker: db.url('svc_bulk_worker'), stock: db.url('svc_stock') },
    tag: 3880, memberUsers, memberEmails: STAND_EMAILS, market: 'us', usPressDays: 0,
    joinMember: pgStandJoinMember(admin, directory), log: () => undefined,
  });
  worldId = demo.world.id;
  /**
   * Шаг 91 (вид преп-центра): тот же посев, что у стенда показа (`REPRACER_DEMO_SELLERS=on`), — два лёгких продавца; владелец стенда
   * менеджер у одного и наблюдатель у другого
   */
  const owner = STAND_ACCOUNTS.find((a) => a.role === 'OWNER')!;
  sellers = await startDemoSellers({
    pools: {
      app: db.pool('svc_app', 4), admin, provisioning: db.pool('svc_provisioning', 1), dispatcher: db.pool('svc_dispatcher', 1),
      scheduler: db.pool('svc_scheduler', 2), exporter: db.pool('svc_exporter', 1), stock: db.pool('svc_stock', 1), bulkWorker: db.pool('svc_bulk_worker', 1),
    },
    pgUrl: db.url('svc_app'), pgUrlsByRole: { admin: db.url('svc_admin'), bulk_worker: db.url('svc_bulk_worker'), stock: db.url('svc_stock') },
    tag: 3891, standOwnerUserId: memberUsers[owner.membershipAlias]!, standOwnerEmail: owner.email,
    // Прогон — двое суток тени: живые показатели карточек есть и так, а прогон короче
    joinAs: pgStandJoinAs(admin, directory, owner.membershipAlias), pressDays: 2, locale: 'en', log: () => undefined,
  });
  const issuer = createTestIssuer({ issuer: STAND_ISSUER, audience: STAND_AUDIENCE });
  const handle = createStandApi([demo.world, ...sellers.worlds], {
    authenticator: createAuthenticator({ issuer: STAND_ISSUER, audience: STAND_AUDIENCE, jwks: staticJwks(issuer.jwks), directory }),
    simulator: { token: (a: (typeof STAND_ACCOUNTS)[number]) => issuer.token(a.subject, { email: a.email, amr: ['pwd', 'otp'], extra: { name: a.displayName } }), expiresInSeconds: 3600 },
  }, { connect: () => readOnlyConnections(new PgChannelConnectStore(admin)), market: 'us', people: { ...STAND_PEOPLE, ...sellers.people } });
  server = createStandServer(handle);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  demo?.stop();
  sellers?.stop();
  server?.close();
  await db?.drop();
});

test('step 88 (Р-213): sign-in offers three roles; the demo log shows the owner promoting a viewer to manager — who, when, old → new', async () => {
  const session = (await (await fetch(`${origin}/api/session?locale=en`)).json()) as SessionView;
  assert.deepEqual(session.simulator?.map((a) => a.label), ['Owner', 'Manager', 'Viewer']);

  const owner = await signIn('OWNER');
  const manager = await signIn('MANAGER');
  // Одна роль в пространстве: после повышения менеджер в демо — менеджер, а не наблюдатель
  assert.deepEqual((await call<WorldSummary[]>('GET', '/api/worlds', manager)).body.map((w) => w.role), ['Manager']);
  const audit = (await call<StopView>('GET', api('stop'), owner)).body.audit.filter((a) => a.action === 'Role changed');
  assert.equal(audit.length, 1, JSON.stringify(audit));
  assert.equal(audit[0]!.actor, 'Owner (you)');
  // Шаг 93: участник назван по имени, адрес — подсказкой; журнал хранит то же, что прежде
  assert.equal(audit[0]!.scope, 'Jamie Lee: Viewer → Manager', 'whose role, old → new — by name');
  assert.equal(audit[0]!.scopeHint, 'manager@stand.repracer.test', 'the address stays as a hint');
  const signedIn = (await (await fetch(`${origin}/api/session?locale=en`, { headers: { authorization: `Bearer ${owner}` } })).json()) as SessionView;
  assert.deepEqual([signedIn.user?.name, signedIn.user?.email], ['Alex Porter', 'owner@stand.repracer.test'], 'the header names the person; the address is the hint');
  // Когда — в поясе продавца (New York: летом UTC−4, зимой UTC−5); само время события держит тест базы (identity.pg, шаг 88)
  assert.match(audit[0]!.at, /UTC−[45]$/, 'when — in the seller time zone');
});

test('step 88 (Р-213): the manager runs the daily work and the stop crane, but not people, channel accounts or live writes — the console does not offer it and the database refuses it', async () => {
  const manager = await signIn('MANAGER');
  // Ежедневная работа: стоп-кран целиком и остатки (источник остатков — право каталога, которого у прежнего менеджера цен не было)
  assert.equal((await call('POST', api('stop'), manager, { target: { kind: 'TENANT' }, note: 'Manager stops to check the floor', confirmed: true })).status, 200);
  const stopId = (await call<StopView>('GET', api('stop'), manager)).body.stops.active[0]!.stopId;
  assert.equal((await call('POST', api('stops', stopId, 'resume'), manager, { note: 'Manager checked the floor and resumes', confirmed: true })).status, 200);
  assert.equal((await call('POST', api('stock', 'sources'), manager, { mode: 'INTERNAL_POOL', name: 'Back room, Newark' })).status, 200);

  // Не его: аккаунты каналов, бой, люди — консоль не предлагает и отвечает 403
  const shadow = (await call<ShadowView>('GET', api('shadow'), manager)).body;
  assert.ok(shadow.accounts.length > 0 && shadow.accounts.every((a) => !a.canGoLive && !a.canGoShadow), 'no live or shadow switch for the manager');
  const connections = (await call<ConnectionsView>('GET', api('connections'), manager)).body;
  assert.equal(connections.canManage, false);
  assert.ok(connections.accounts.every((a) => !a.quantityWrites.canConfirm && !a.quantityWrites.canRevoke && a.otherTools.options.length === 0));
  const account = shadow.accounts[0]!.channelAccountId;
  assert.equal((await call('POST', api('shadow', 'mode'), manager, { channelAccountId: account, toMode: 'LIVE', typedConfirmation: 'x' })).status, 403);

  // В обход консоли отказывает база — её причиной (консольные роли и роли базы не разъехались)
  const tenantId = demo.tenantId;
  const adminPool = db.pool('svc_admin', 2);
  const member = await memberOf(tenantId, 'MANAGER');
  const shadowStore = new PgShadowStore({ adminPool });
  assert.deepEqual(await shadowStore.switchWriteMode(tenantId, { channelAccountId: account, toMode: 'LIVE', membershipId: member.membershipId, userId: member.userId, mfa: true, typedConfirmation: 'x' }),
    { status: 'NOT_OWNER' }, 'Р-170: only the owner switches to live writes');
  const stock = new PgStockStore({ adminPool, stockPool: db.pool('svc_stock', 1) });
  assert.equal((await stock.confirmQuantityWrites(tenantId, account, 'x', { membershipId: member.membershipId, userId: member.userId, mfa: true })).status, 'NOT_OWNER',
    'Р-202: only the owner confirms stock writes');
  assert.equal((await stock.answerOtherTools(tenantId, account, 'NONE', { membershipId: member.membershipId, userId: member.userId, mfa: true })).status, 'FORBIDDEN',
    'channel accounts stay with the owner');
  const store = new PgPricingStore(db.pool('svc_app', 1), { adminPool });
  const viewer = await memberOf(tenantId, 'VIEWER');
  assert.deepEqual(await store.changeMemberRole(tenantId, viewer.membershipId, 'MANAGER', { userId: member.userId, mfa: true }), { status: 'FORBIDDEN' }, 'people stay with the owner');
  assert.equal((await store.setTenantDisplay(tenantId, { locale: 'en' }, { userId: member.userId, mfa: true })).status, 'FORBIDDEN', 'workspace settings stay with the owner');
});

test('step 88 (Р-213): the viewer changes nothing', async () => {
  const viewer = await signIn('VIEWER');
  const stop = (await call<StopView>('GET', api('stop'), viewer)).body;
  assert.deepEqual(Object.values(stop.permissions), [false, false, false, false, false]);
  assert.equal((await call('POST', api('stop'), viewer, { target: { kind: 'TENANT' }, note: 'Viewer tries the stop crane', confirmed: true })).status, 403);
  assert.equal((await call('POST', api('stock', 'sources'), viewer, { mode: 'INTERNAL_POOL', name: 'Viewer source' })).status, 403);
  assert.equal((await call('POST', api('bounds', 'plan'), viewer, { request: { all: true, min: { mode: 'SET', amountMinor: 100 } } })).status, 403);
  const account = (await call<ShadowView>('GET', api('shadow'), viewer)).body.accounts[0]!.channelAccountId;
  assert.equal((await call('POST', api('shadow', 'mode'), viewer, { channelAccountId: account, toMode: 'SHADOW' })).status, 403);
});

/**
 * Шаг 91 (вид преп-центра): на вопрос «как я увижу своих продавцов?» отвечает экран — «Your workspaces» владельца стенда показывает
 * три пространства с тремя ролями, у лёгких продавцов — живые показатели и свои имена; пометка демо остаётся [Р-151]
 */
test('step 91: the stand owner sees three workspaces with three roles — Owner, Manager, Viewer — and live figures on each seller card', async () => {
  const owner = await signIn('OWNER');
  const worlds = (await call<WorldSummary[]>('GET', '/api/worlds', owner)).body;
  assert.deepEqual(worlds.map((w) => [w.title, w.role]), [['Demo store (simulator)', 'Owner'], ['Blue Ridge Trading', 'Manager'], ['Lakeside Home Goods', 'Viewer']]);
  for (const w of worlds.slice(1)) {
    assert.equal(w.demo, true, 'Р-151: a light seller is synthetic and marked as demo');
    assert.equal(w.description, messagesFor('en').ui.app.demoSellerDescription);
    assert.equal(w.landing, 'shadow');
    assert.ok(w.scopes > 0 && w.decisionsLastDay > 0 && w.interventionsLastWeek > 0, `live figures on the card: ${JSON.stringify(w)}`);
  }
  // У одного человека в пространстве одна роль [Р-213]: у менеджера стенда своих лёгких продавцов нет
  assert.deepEqual((await call<WorldSummary[]>('GET', '/api/worlds', await signIn('MANAGER'))).body.map((w) => w.title), ['Demo store (simulator)']);

  // Менеджер у Blue Ridge: Shadow mode его продавца — оба аккаунта в тени, в бой переводит только владелец пространства (Р-170)
  const blueRidge = `/api/worlds/${encodeURIComponent(worlds[1]!.id)}`;
  const shadow = (await call<ShadowView>('GET', `${blueRidge}/shadow`, owner)).body;
  assert.equal(shadow.accounts.length, 2);
  assert.ok(shadow.accounts.every((a) => a.writeMode === 'SHADOW' && !a.canGoLive), JSON.stringify(shadow.accounts));
  assert.ok(shadow.digestPreview && shadow.digestPreview.subject.includes('Blue Ridge Trading'), `the weekly email names the seller: ${shadow.digestPreview?.subject}`);
});

test('step 91: where the stand owner is a Viewer (Lakeside Home Goods), a change is refused — by the console and, around it, by the database', async () => {
  const owner = await signIn('OWNER');
  const worlds = (await call<WorldSummary[]>('GET', '/api/worlds', owner)).body;
  const lakeside = worlds.find((w) => w.title === 'Lakeside Home Goods')!;
  const at = (...p: string[]) => `/api/worlds/${[lakeside.id, ...p].map(encodeURIComponent).join('/')}`;
  const stop = (await call<StopView>('GET', at('stop'), owner)).body;
  assert.deepEqual(Object.values(stop.permissions), [false, false, false, false, false]);
  assert.equal((await call('POST', at('stop'), owner, { target: { kind: 'TENANT' }, note: 'Owner of the stand tries a stop here', confirmed: true })).status, 403);
  assert.equal((await call('POST', at('bounds', 'plan'), owner, { request: { all: true, min: { mode: 'SET', amountMinor: 100 } } })).status, 403);
  // Та же роль у владельца стенда в ЕГО пространстве — владелец: отказ выше — роль этого пространства, а не человека
  assert.equal(worlds.find((w) => w.title === 'Demo store (simulator)')!.role, 'Owner');

  // В обход консоли: остановку цен пространства наблюдателем отклоняет база (роль — из членства в этом тенанте)
  const tenantId = sellers.worlds.find((w) => w.title === 'Lakeside Home Goods')!.tenantId;
  const viewer = await memberOf(tenantId, 'OWNER');
  const store = new PgPricingStore(db.pool('svc_app', 1), { adminPool: db.pool('svc_admin', 1) });
  const refused = await store.stopPricing(tenantId, {
    scope: 'TENANT', channelAccountId: null, marketplace: null, stoppedAt: new Date().toISOString() as never,
    stoppedByMembershipId: viewer.membershipId, stoppedByUserId: viewer.userId, note: 'Viewer stops around the console',
  } as never);
  assert.equal(refused.status, 'FORBIDDEN', 'the database refuses a stop by a viewer');
});

/** Членство синтетического участника стенда в демо по его роли — из базы, как его увидит страж */
async function memberOf(tenantId: string, role: string): Promise<{ membershipId: string; userId: string }> {
  const account = STAND_ACCOUNTS.find((a) => a.role === role)!;
  const { rows: [r] } = await inTenant(db.pool('svc_admin', 1), tenantId, (tx) => tx.query(
    `SELECT m.membership_id, m.user_id FROM tenant_data.membership m JOIN platform.app_user u ON u.user_id = m.user_id
      WHERE m.tenant_id = $1 AND u.email = $2`, [tenantId, account.email]));
  assert.ok(r, `${role} is a member of the demo`);
  return { membershipId: r.membership_id as string, userId: r.user_id as string };
}
