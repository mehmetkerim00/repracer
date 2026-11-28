import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { messagesFor, type ConnectionsView, type ShadowView, type StopView } from '@repracer/console-model';
import { pgStandJoinAs, pgStandJoinMember, pgStandUsers, STAND_ACCOUNTS, STAND_AUDIENCE, STAND_EMAILS, STAND_ISSUER, STAND_PEOPLE } from '@repracer/contract-tests/stand';
import { createAuthenticator, staticJwks } from '@repracer/identity';
import { PgIdentityDirectory } from '@repracer/identity/pg';
import { createTestIssuer } from '@repracer/identity/test-issuer';
import { inTenant, PgChannelConnectStore, PgPricingStore, PgStockStore } from '@repracer/pricing-store-pg';
import type { SessionView, StandToken, WorldSummary } from '../src/api-types.ts';
import { createIsolatedDatabase, type IsolatedDatabase } from '../../../packages/pricing-store-pg/test/isolated-db.ts';
import { readOnlyConnections } from '../server/connect.ts';
import { startDemoWorld, type RunningDemoWorld } from '../server/demo-world.ts';
import { DEMO_CLIENT_VIEW_SELLER, DEMO_SELLERS, startDemoSellers, type RunningDemoSellers } from '../server/demo-sellers.ts';
import { createStandApi, createStandServer } from '../server/stand-server.ts';

/**
 * Шаг 88 [Р-213], шаг 98 [Р-222] живым прогоном как браузер [Р-136, Р-142]: американское демо на PostgreSQL — тот же посев, что у стенда
 * показа, — и вход стенда синтетическими людьми по ролям. Проверяется то, что увидит зритель, и то, что держит база:
 *  - вход предлагает две роли для людей — владельца и менеджера; наблюдателя нет;
 *  - менеджер делает всё, что владелец: стоп-кран, остатки, аккаунты каналов, ответ о других инструментах, перевод в бой,
 *    подтверждение записи количества, язык и пояс пространства — консоль предлагает, база пропускает;
 *  - роль владельца менеджер не трогает: обойти консоль нечем, база отказывает своей причиной.
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
   * Шаг 91 (вид преп-центра): тот же посев, что у стенда показа (`REPRACER_DEMO_SELLERS=on`), — два лёгких продавца; владелец стенда —
   * менеджер у обоих (шаг 98)
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
    // Шаг 186: и четвёртый мир — «Demo store — Amazon US» в виде клиента (стенд QA-A: REPRACER_DEMO_CLIENT_VIEW=on)
    specs: [...DEMO_SELLERS, DEMO_CLIENT_VIEW_SELLER],
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

test('step 98 (Р-222): sign-in offers two roles — owner and manager; the demo manager is a manager from the start', async () => {
  const session = (await (await fetch(`${origin}/api/session?locale=en`)).json()) as SessionView;
  assert.deepEqual(session.simulator?.map((a) => a.label), ['Owner', 'Manager']);
  const owner = await signIn('OWNER');
  const manager = await signIn('MANAGER');
  // Одна роль в пространстве [Р-213]; приходит менеджером — повышать некого, смены роли в журнале демо нет
  assert.deepEqual((await call<WorldSummary[]>('GET', '/api/worlds', manager)).body.map((w) => w.role), ['Manager']);
  assert.deepEqual((await call<StopView>('GET', api('stop'), owner)).body.audit.filter((a) => a.action === 'Role changed'), []);
  const signedIn = (await (await fetch(`${origin}/api/session?locale=en`, { headers: { authorization: `Bearer ${owner}` } })).json()) as SessionView;
  assert.deepEqual([signedIn.user?.name, signedIn.user?.email], ['Alex Porter', 'owner@stand.repracer.test'], 'the header names the person; the address is the hint');
});

test('step 98 (Р-222): the manager does everything the owner does — stop crane, stock, channel accounts, live writes, quantity writes, workspace settings', async () => {
  const manager = await signIn('MANAGER');
  assert.equal((await call('POST', api('stop'), manager, { target: { kind: 'TENANT' }, note: 'Manager stops to check the floor', confirmed: true })).status, 200);
  const stopId = (await call<StopView>('GET', api('stop'), manager)).body.stops.active[0]!.stopId;
  assert.equal((await call('POST', api('stops', stopId, 'resume'), manager, { note: 'Manager checked the floor and resumes', confirmed: true })).status, 200);
  assert.equal((await call('POST', api('stock', 'sources'), manager, { mode: 'INTERNAL_POOL', name: 'Back room, Newark' })).status, 200);

  // Консоль предлагает менеджеру то же, что владельцу: перевод в бой и аккаунты каналов
  const shadow = (await call<ShadowView>('GET', api('shadow'), manager)).body;
  assert.ok(shadow.accounts.length > 0 && shadow.accounts.some((a) => a.writeMode === 'SHADOW'), JSON.stringify(shadow.accounts.map((a) => a.writeMode)));
  const connections = (await call<ConnectionsView>('GET', api('connections'), manager)).body;
  assert.equal(connections.canManage, true, 'the manager manages channel accounts');
  assert.ok(connections.accounts.every((a) => a.otherTools.options.length > 0), 'the manager answers about other tools');

  // И база пропускает — настоящим путём, в обход консоли (роли консоли и роли базы не разъехались)
  const tenantId = demo.tenantId;
  const adminPool = db.pool('svc_admin', 2);
  const member = await memberOf(tenantId, 'MANAGER');
  const actor = { membershipId: member.membershipId, userId: member.userId, mfa: true };
  const stock = new PgStockStore({ adminPool, stockPool: db.pool('svc_stock', 1) });
  // Аккаунт без подтверждения записи количества: у демо США amazon.com подтверждён посевом — берётся eBay
  const unconfirmed = connections.accounts.find((a) => !a.quantityWrites.confirmed)!;
  assert.ok(unconfirmed, 'the demo has an account without quantity writes');
  const typed = (await stock.quantityWritesState(tenantId, unconfirmed.channelAccountId))!.externalAccountId;
  assert.equal((await stock.answerOtherTools(tenantId, unconfirmed.channelAccountId, 'NONE', actor)).status, 'ANSWERED', 'the manager answers about other tools');
  assert.deepEqual(await stock.confirmQuantityWrites(tenantId, unconfirmed.channelAccountId, typed, actor), { status: 'CONFIRMED' }, 'Р-202: the manager confirms stock writes');
  assert.equal((await stock.revokeQuantityWrites(tenantId, unconfirmed.channelAccountId, typed, actor)).status, 'REVOKED', 'Р-202: the manager revokes stock writes');
  const store = new PgPricingStore(db.pool('svc_app', 1), { adminPool });
  assert.equal((await store.setTenantDisplay(tenantId, { locale: 'en' }, { userId: member.userId, mfa: true })).status, 'SAVED', 'workspace settings are the manager’s too');

  // Роль владельца — только владельцем: менеджер её не снимает, база отказывает в обход консоли
  const owner = await memberOf(tenantId, 'OWNER');
  assert.deepEqual(await store.changeMemberRole(tenantId, owner.membershipId, 'MANAGER', { userId: member.userId, mfa: true }), { status: 'FORBIDDEN' }, 'the owner role stays with the owner');
});

/**
 * Шаг 91 (вид преп-центра): на вопрос «как я увижу своих продавцов?» отвечает экран — «Your workspaces» владельца стенда показывает
 * три пространства, у лёгких продавцов — живые показатели и свои имена; пометка демо остаётся [Р-151]. Шаг 98: у лёгких продавцов он менеджер
 */
test('step 91, step 98, step 186: the stand owner sees four workspaces — Owner in his own, Manager at the sellers — and live figures on each seller card', async () => {
  const owner = await signIn('OWNER');
  const worlds = (await call<WorldSummary[]>('GET', '/api/worlds', owner)).body;
  assert.deepEqual(worlds.map((w) => [w.title, w.role]),
    [['Demo store (simulator)', 'Owner'], ['Blue Ridge Trading', 'Manager'], ['Lakeside Home Goods', 'Manager'], ['Demo store — Amazon US', 'Manager']]);
  for (const w of worlds.slice(1)) {
    assert.equal(w.demo, true, 'Р-151: a light seller is synthetic and marked as demo');
    assert.equal(w.description, messagesFor('en').ui.app.demoSellerDescription);
    assert.equal(w.landing, 'shadow');
    assert.ok(w.scopes > 0 && w.decisionsLastDay > 0 && w.interventionsLastWeek > 0, `live figures on the card: ${JSON.stringify(w)}`);
  }
  // У одного человека в пространстве одна роль [Р-213]: у менеджера стенда своих лёгких продавцов нет
  assert.deepEqual((await call<WorldSummary[]>('GET', '/api/worlds', await signIn('MANAGER'))).body.map((w) => w.title), ['Demo store (simulator)']);

  // Менеджер у Blue Ridge: Shadow mode его продавца — оба аккаунта в тени; перевести в бой менеджер может (шаг 98), если витрина это позволяет
  const blueRidge = `/api/worlds/${encodeURIComponent(worlds[1]!.id)}`;
  const shadow = (await call<ShadowView>('GET', `${blueRidge}/shadow`, owner)).body;
  assert.equal(shadow.accounts.length, 2);
  assert.ok(shadow.accounts.every((a) => a.writeMode === 'SHADOW'), JSON.stringify(shadow.accounts));
  assert.ok(shadow.digestPreview && shadow.digestPreview.subject.includes('Blue Ridge Trading'), `the weekly email names the seller: ${shadow.digestPreview?.subject}`);
  // Lakeside Home Goods: прежде наблюдатель — теперь менеджер, и стоп-кран у него есть
  const lakeside = worlds.find((w) => w.title === 'Lakeside Home Goods')!;
  const stop = (await call<StopView>('GET', `/api/worlds/${encodeURIComponent(lakeside.id)}/stop`, owner)).body;
  assert.equal(stop.permissions.canStop, true, 'the stand owner is a manager at Lakeside Home Goods');
});

/**
 * Шаг 186 (письмо Мердана 28.11, §1): мир «Demo store — Amazon US» — то, что увидит пилот: аккаунт только amazon.com (в тени), предложения
 * только amazon.com, подключение предлагает только Amazon. Ни eBay, ни Walmart, ни Kaufland в ответах экранов мира нет; контроль — у
 * трёхканального демо рядом eBay есть
 */
test('step 186 (Merdan 28.11, §1): «Demo store — Amazon US» is the client view — amazon.com only on every screen it serves, next to the three-channel demo', async () => {
  const owner = await signIn('OWNER');
  const worlds = (await call<WorldSummary[]>('GET', '/api/worlds', owner)).body;
  const client = worlds.find((w) => w.title === 'Demo store — Amazon US');
  assert.ok(client, 'the client-view workspace is listed');
  assert.equal(client.demo, true, 'Р-151: synthetic and marked as demo');
  assert.ok(client.scopes > 0 && client.decisionsLastDay > 0, `live figures on the card: ${JSON.stringify(client)}`);
  const base = `/api/worlds/${encodeURIComponent(client.id)}`;
  const shadow = (await call<ShadowView>('GET', `${base}/shadow`, owner)).body;
  assert.equal(shadow.accounts.length, 1, 'one channel account');
  assert.ok(shadow.accounts.every((a) => a.writeMode === 'SHADOW'), JSON.stringify(shadow.accounts));
  // Значения, а не ключи: признак модели экрана `"walmart":false` — не текст для человека
  const OTHER = /(?:EBAY|ebay\.com|WALMART|walmart\.com|KAUFLAND|kaufland)(?![A-Za-z]*":)/i;
  for (const screen of ['products', 'shadow', 'connections', 'bounds', 'strategies', 'stock', 'feed', 'stop', 'status', 'overview', 'decisions', 'dangerous']) {
    const r = await call<unknown>('GET', `${base}/${screen}`, owner);
    assert.equal(r.status, 200, `${screen}: ${JSON.stringify(r.body).slice(0, 200)}`);
    const text = JSON.stringify(r.body);
    const found = OTHER.exec(text);
    assert.equal(found ? `«${found[0]}» in …${text.slice(Math.max(0, found.index - 80), found.index + 40)}…` : null, null, `${screen}: no other channel`);
  }
  assert.match(JSON.stringify((await call<unknown>('GET', `${base}/products`, owner)).body), /ATVPDKIKX0DER|amazon\.com/, 'the offers are on amazon.com');
  // Контроль: трёхканальное демо рядом показывает eBay — правило смотрит туда, где другие каналы есть
  const main = worlds.find((w) => w.title === 'Demo store (simulator)')!;
  assert.match(JSON.stringify((await call<unknown>('GET', `/api/worlds/${encodeURIComponent(main.id)}/products`, owner)).body), /EBAY/, 'the three-channel demo still has eBay');
});

/**
 * Шаг 187 (письмо Мердана 28.11, §5) через консоль на PostgreSQL [Р-136]: себестоимость и комиссии ОДНОГО предложения — запросом страницы пола,
 * как браузер; сохранённое страница отдаёт сразу (поля и расчёт пола), неверная сумма — отказ своей причиной
 */
test('step 187 (Merdan 28.11, §5): the unit cost and fees of one offer are saved from its floor page on PostgreSQL — the page shows them at once', async () => {
  const owner = await signIn('OWNER');
  const client = (await call<WorldSummary[]>('GET', '/api/worlds', owner)).body.find((w) => w.title === 'Demo store — Amazon US')!;
  const base = `/api/worlds/${encodeURIComponent(client.id)}`;
  const index = (await call<{ items: Array<{ writeScopeId: string }> }>('GET', `${base}/bounds?offset=0&limit=1`, owner)).body;
  const id = index.items[0]!.writeScopeId;
  // Комиссия выше тарифной (15 % у демо): пол считается по самой дорогой оценке [Р-141], и введённая становится действующей
  const saved = await call<{ message: string; bounds: { costEntry: { unitCost: string; feePercent: string; fixedFee: string }; cost: { lines: Array<{ key: string; amount: string }> };
    feeEstimates: Array<{ text: string; used: boolean }> } }>(
    'POST', `${base}/bounds/${encodeURIComponent(id)}/cost`, owner, { unitCost: '6.25', feePercent: '17.5', fixedFee: '0.30' });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.message, messagesFor('en').ui.bounds.costEntry.saved);
  assert.deepEqual(saved.body.bounds.costEntry, { ...saved.body.bounds.costEntry, unitCost: '6.25', feePercent: '17.5', fixedFee: '0.30' });
  assert.deepEqual(saved.body.bounds.cost.lines.map((l) => [l.key, l.amount]), [['COST', '$6.25'], ['FEE', '17.5%'], ['FIXED_FEE', '$0.30']]);
  // Р-138: оценка продавца и тарифная — рядом, действующая помечена
  const estimates = saved.body.bounds.feeEstimates;
  assert.equal(estimates.length, 2, JSON.stringify(estimates));
  assert.ok(estimates.some((e) => e.used && e.text.includes('17.5%')) && estimates.some((e) => !e.used && e.text.includes('15%')), JSON.stringify(estimates));
  // Неверная сумма — отказ своей причиной, ничего не сохранено
  const bad = await call<{ error: { code: string } }>('POST', `${base}/bounds/${encodeURIComponent(id)}/cost`, owner, { unitCost: '6.255' });
  assert.deepEqual([bad.status, bad.body.error.code], [400, 'AMOUNT_INVALID']);
  const again = (await call<{ costEntry: { unitCost: string } }>('GET', `${base}/bounds/${encodeURIComponent(id)}`, owner)).body;
  assert.equal(again.costEntry.unitCost, '6.25', 'the refused amount changed nothing');
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
