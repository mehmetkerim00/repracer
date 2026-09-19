import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { BoundsDiffView, ComplianceView, DecisionListItem, DiscountCheckView, DecisionTrace, PriceFeedView, StopView, StrategyListView, StrategyPreviewView } from '@repracer/console-model';
import { buildStandWorlds, pgStandJoinMember, pgStandUsers, STAND_ACCOUNTS, STAND_AUDIENCE, STAND_EMAILS, STAND_ISSUER, type LiveWorld } from '@repracer/contract-tests/stand';
import { pgStoreFactory } from '@repracer/contract-tests/pg-store';
import { createAuthenticator, staticJwks } from '@repracer/identity';
import { PgIdentityDirectory } from '@repracer/identity/pg';
import { createTestIssuer } from '@repracer/identity/test-issuer';
import { createPool, inTenant } from '@repracer/pricing-store-pg';
import type { DiscountAnnounceResponse, JobCreatedResponse, StandToken } from '../src/api-types.ts';
import { createStandApi } from '../server/stand-server.ts';
import { runJob } from './run-jobs.ts';

/**
 * Интерфейс на PostgreSQL: сопоставление внешнего пользователя — platform.external_identity [Р-78], роли — из
 * tenant_data.membership при каждом запросе, остановка и возобновление — в audit.audit_event с автором — пользователем токена,
 * ролью, заметкой и областью [Р-76, находка 4], NO_OP без слепка [Р-74]. REPRACER_PG_URL — роль приложения в одноразовой базе.
 */

const PG_URL = process.env.REPRACER_PG_URL;
// Р-84: без базы тест не пропускается, а падает
if (!PG_URL) throw new Error('REPRACER_PG_URL is required: database tests do not skip (Р-84)');
const pool = createPool(PG_URL, { max: 6, applicationName: 'repracer-console-pg' });
const scanPool = createPool(PG_URL.replace('svc_app@', 'svc_dispatcher@'), { max: 2 });
const fxPool = createPool(PG_URL.replace('svc_app@', 'svc_fx_loader@'), { max: 1 });
const onboardingPool = createPool(PG_URL.replace('svc_app@', 'svc_onboarding@'), { max: 1 });
// Р-90: консоль — административный сервис (остановки, роли); вход — роль входа; тенанты стенда — роль создания тенанта
const adminPool = createPool(PG_URL.replace('svc_app@', 'svc_admin@'), { max: 4 });
// Р-139 (шаг 30): ход задания ведёт роль исполнителя, а не административная — иначе каждый тик был бы строкой аудита
const bulkWorkerPool = createPool(PG_URL.replace('svc_app@', 'svc_bulk_worker@'), { max: 2 });
const authenticatorPool = createPool(PG_URL.replace('svc_app@', 'svc_authenticator@'), { max: 2 });
const provisioningPool = createPool(PG_URL.replace('svc_app@', 'svc_provisioning@'), { max: 1 });
let memberUsers: Record<string, string> = {};
const WORLD = 'kaufland/pipeline/happy-path';
/**
 * Р-139 (шаг 30): массовая операция отвечает заданием. Здесь оно выполняется тем же обработчиком, что и в фоновом процессе, —
 * на настоящей базе: именно так проверяется, что стражи массового изменения принимают второй фактор, предъявленный при СОЗДАНИИ.
 */
const finishJob = async (response: { status: number; body: unknown }, world?: LiveWorld) => {
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const done = await runJob(world ?? worlds.find((w) => w.id === WORLD)!, (response.body as JobCreatedResponse).jobId, 'en');
  assert.notEqual(done.status, 'FAILED', `задание ${done.kind} не выполнено: ${done.error ?? ''}`);
  return done;
};
/** Шаг 23: мир Amazon — недоверие каналу и Automate Pricing в базе */
const TRUST_WORLD = 'amazon/pipeline/console-channel-trust';

let handle: ReturnType<typeof createStandApi>;
let worlds: LiveWorld[] = [];
before(async () => {
  const directory = new PgIdentityDirectory(authenticatorPool as never);
  memberUsers = await pgStandUsers(directory, onboardingPool);
  worlds = await buildStandWorlds({ filter: (s) => s.id === WORLD || s.id === TRUST_WORLD, storeFactory: pgStoreFactory(pool, scanPool!, fxPool!, { memberUsers, memberEmails: STAND_EMAILS, joinMember: pgStandJoinMember(adminPool, directory), adminPool, provisioningPool, bulkWorkerPool }) });
  const issuer = createTestIssuer({ issuer: STAND_ISSUER, audience: STAND_AUDIENCE });
  handle = createStandApi(worlds, {
    authenticator: createAuthenticator({ issuer: STAND_ISSUER, audience: STAND_AUDIENCE, jwks: staticJwks(issuer.jwks), directory }),
    simulator: { token: (a) => issuer.token(a.subject, { email: a.email }), expiresInSeconds: 900 },
  });
});
after(async () => {
  await pool.end();
  await scanPool.end();
  await fxPool.end();
  await onboardingPool.end();
  await adminPool.end();
  await authenticatorPool.end();
  await provisioningPool.end();
  await bulkWorkerPool.end();
});

/** Токен имитатора поставщика в заголовке и язык в cookie */
async function login(role: string): Promise<{ authorization: string; cookie: string }> {
  const r = await handle({ method: 'POST', url: '/api/stand-issuer/token', body: { role } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { authorization: `Bearer ${(r.body as StandToken).accessToken}`, cookie: 'repracer_locale=en' };
}
const api = (...parts: string[]) => `/api/worlds/${[WORLD, ...parts].map(encodeURIComponent).join('/')}`;

test('Р-78, Р-76, finding 4 on PostgreSQL: the stop and the resume are audited with the token user as author, role, note and scope; a role changed in the database applies at once', async () => {
  const world = worlds[0]!;
  const operator = await login('OPERATOR');
  const stopped = await handle({ method: 'POST', url: api('stop'), body: { target: { kind: 'TENANT' }, note: 'Synthetic kill switch on PostgreSQL', confirmed: true }, ...operator });
  assert.equal(stopped.status, 200, JSON.stringify(stopped.body));

  // Р-96: журнал аудита читает административный сервис
  const rows = await inTenant(adminPool, world.identityTenantId, async (tx) => (await tx.query(
    `SELECT e.action, e.actor_type, m.role AS member_role, u.email, e.changes FROM audit.audit_event e
       JOIN tenant_data.membership m ON m.tenant_id = e.tenant_id AND m.membership_id = e.actor_membership_id
       JOIN platform.app_user u ON u.user_id = e.actor_user_id
      WHERE e.entity_type = 'price_stop' ORDER BY e.recorded_at`)).rows);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].action, rows[0].actor_type, rows[0].email, rows[0].changes.role, rows[0].changes.scope, rows[0].changes.note],
    ['pricing.stop_created', 'USER', STAND_ACCOUNTS.find((a) => a.role === 'OPERATOR')!.email, 'OPERATOR', 'TENANT', 'Synthetic kill switch on PostgreSQL']);

  // Роль меняется в базе — владелец в своей сессии со вторым фактором [Р-88]; следующий запрос с тем же токеном уже с новой ролью
  await inTenant(adminPool, world.identityTenantId, (tx) => tx.query(
    `UPDATE tenant_data.membership SET role = 'VIEWER' WHERE membership_id = (SELECT actor_membership_id FROM audit.audit_event WHERE entity_type = 'price_stop' LIMIT 1)`),
    memberUsers['membership-owner'], { mfa: true });
  const asViewer = (await handle({ method: 'GET', url: api('stop'), body: undefined, ...operator })).body as StopView;
  assert.equal(asViewer.permissions.canStop, false);
  const stopId = asViewer.stops.active[0]!.stopId;

  const admin = await login('ADMIN');
  const resumed = await handle({ method: 'POST', url: api('stops', stopId, 'resume'), body: { note: 'Admin resumes after the check', confirmed: true }, ...admin });
  assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
  const audit = (resumed.body as { stop: StopView }).stop.audit;
  assert.deepEqual(audit.slice(0, 2).map((a) => [a.action, a.actor, a.note]), [
    ['Pricing resumed', 'Admin (you)', 'Admin resumes after the check'],
    ['Pricing stopped', 'Operator', 'Synthetic kill switch on PostgreSQL'],
  ]);
});

test('Р-74 on PostgreSQL: a NO_OP decision has no explanation in the database and the trace names the gap', async () => {
  const owner = await login('OWNER');
  const decisions = (await handle({ method: 'GET', url: api('decisions'), body: undefined, ...owner })).body as DecisionListItem[];
  const noChange = decisions.find((d) => d.outcome === 'No change')!;
  const trace = (await handle({ method: 'GET', url: api('decisions', noChange.decisionId), body: undefined, ...owner })).body as DecisionTrace;
  assert.ok(trace.gaps.some((g) => g.code === 'NO_OP_NOT_EXPLAINED'));
  const [row] = await inTenant(pool, worlds[0]!.identityTenantId, async (tx) => (await tx.query(
    `SELECT count(*) FILTER (WHERE explanation IS NULL AND no_change_reason IS NOT NULL)::int AS reason_only, count(*)::int AS total
       FROM channel_data.price_decision WHERE intent_class = 'NO_OP'`)).rows);
  assert.ok(row.total > 0 && row.reason_only === row.total, JSON.stringify(row));
});

test('step 21 on PostgreSQL: preview and save of a strategy, difference screen and bounds edit go through the database roles; the feed reads the write history', async () => {
  const owner = await login('OWNER');
  const operator = await login('OPERATOR');
  const url = (...parts: string[]) => `/api/worlds/${[WORLD, ...parts].map(encodeURIComponent).join('/')}`;
  const post = (auth: { authorization: string; cookie: string }, path: string, body: unknown) => handle({ method: 'POST', url: path, body, ...auth });
  const draft = { name: 'Synthetic PG undercut', params: { type: 'MATCH_BUYBOX', undercutMinor: 3, holdWhenWinning: false, atBound: 'CAP' }, deadbandMinor: 0 };
  // OQ-201 (шаг 30): предпросмотр — тоже задание, и считает он ВСЕ выбранные предложения, а не выборку
  const previewJob = await finishJob(await post(owner, url('strategies', 'preview'), { draft, writeScopeIds: ['ws-price-de-4101'] }));
  assert.equal(previewJob.status, 'SUCCEEDED', previewJob.error ?? '');
  const token = (previewJob.result as { view: StrategyPreviewView }).view.previewToken;
  // Р-139 (шаг 30): сохранение с назначением — фоновое задание; на PostgreSQL оно предъявляет базе себя, а не второй фактор сессии
  const savedJob = await finishJob(await post(owner, url('strategies'), { draft, writeScopeIds: ['ws-price-de-4101'], strategyId: null, previewJobId: previewJob.jobId, previewToken: token, confirmed: true }));
  assert.equal(savedJob.status, 'SUCCEEDED', savedJob.error ?? '');
  const list = (await handle({ method: 'GET', url: url('strategies'), body: undefined, ...owner })).body as StrategyListView;
  assert.ok(list.strategies.some((x) => x.version === 1 && x.scopes.some((u) => u.unit.writeScopeId === 'ws-price-de-4101' && u.version === 1) && x.name === 'Synthetic PG undercut'), JSON.stringify(list.strategies));

  const request = { writeScopeIds: ['ws-price-de-4101'], max: { kind: 'SET', minor: 2600 } };
  assert.equal((await post(operator, url('bounds', 'plan'), { request })).status, 403);
  // Задача D шага 31: экран различий — задание, применение ссылается на него, и считается набор один раз
  const planJob = await finishJob(await post(owner, url('bounds', 'plan'), { request }));
  const diff = (planJob.result as { view: BoundsDiffView }).view;
  assert.deepEqual([diff.rows[0]!.maxBefore, diff.rows[0]!.maxAfter], ['€25.00', '€26.00']);
  const applied = await finishJob(await post(owner, url('bounds', 'apply'), { planJobId: planJob.jobId, planToken: diff.planToken, confirmed: true }));
  assert.equal(applied.status, 'SUCCEEDED', applied.error ?? '');
  const again = await finishJob(await post(owner, url('bounds', 'plan'), { request: { ...request, max: { kind: 'SET', minor: 2700 } } }));
  assert.equal((again.result as { view: BoundsDiffView }).view.rows[0]!.maxBefore, '€26.00', 'the database now holds the new version');

  const feed = await handle({ method: 'GET', url: url('feed'), body: undefined, ...owner });
  assert.equal(feed.status, 200);
  assert.ok((feed.body as PriceFeedView).items.some((i) => i.to === '€17.75' && i.from === '€18.50'), JSON.stringify((feed.body as PriceFeedView).items));
});

test('step 23 on PostgreSQL: the database refuses a strategy for an offer the channel prices itself; a channel distrust is released with a second factor and audited', async () => {
  const owner = await login('OWNER');
  const url = (...parts: string[]) => `/api/worlds/${[TRUST_WORLD, ...parts].map(encodeURIComponent).join('/')}`;
  const list = (await handle({ method: 'GET', url: url('strategies'), body: undefined, ...owner })).body as StrategyListView;
  assert.deepEqual(list.channelPricingOffers.map((o) => o.label), ['Amazon A1PA6795UKMFR9 · unit SYN-SKU-8502']);
  const ws = list.scopes.find((x) => x.unit.externalUnitId === 'SYN-SKU-8502')!.unit.writeScopeId;
  const draft = { name: 'Synthetic PG fixed', params: { type: 'FIXED', priceMinor: 2050 }, deadbandMinor: 0 };
  const trustWorld = worlds.find((w) => w.id === TRUST_WORLD)!;
  const previewJob = await finishJob(await handle({ method: 'POST', url: url('strategies', 'preview'), body: { draft, writeScopeIds: [ws] }, ...owner }), trustWorld);
  const preview = (previewJob.result as { view: StrategyPreviewView }).view;
  const refused = await handle({ method: 'POST', url: url('strategies'), body: { draft, writeScopeIds: [ws], strategyId: null, previewJobId: previewJob.jobId, previewToken: preview.previewToken, confirmed: true }, ...owner });
  assert.deepEqual([refused.status, (refused.body as { error: { code: string } }).error.code], [400, 'CHANNEL_PRICING_ACTIVE'], JSON.stringify(refused.body));

  const stop = (await handle({ method: 'GET', url: url('stop'), body: undefined, ...owner })).body as StopView;
  assert.equal(stop.distrusts.active.length, 1);
  const operator = await login('OPERATOR');
  const note = 'Price basis checked in the synthetic channel account';
  const byOperator = await handle({ method: 'POST', url: url('distrusts', stop.distrusts.active[0]!.distrustId, 'release'), body: { note, confirmed: true }, ...operator });
  assert.equal(byOperator.status, 403);
  const released = await handle({ method: 'POST', url: url('distrusts', stop.distrusts.active[0]!.distrustId, 'release'), body: { note, confirmed: true }, ...owner });
  assert.equal(released.status, 200, JSON.stringify(released.body));
  const trust = trustWorld;
  const rows = await inTenant(adminPool, trust.identityTenantId, async (tx) => (await tx.query(
    `SELECT e.action, e.actor_type, u.email, e.changes->>'note' AS note FROM audit.audit_event e LEFT JOIN platform.app_user u ON u.user_id = e.actor_user_id
      WHERE e.entity_type = 'channel_distrust' ORDER BY e.recorded_at`)).rows);
  assert.deepEqual(rows.map((r) => [r.action, r.actor_type, r.email, r.note]), [
    ['pricing.distrust_created', 'SYSTEM', null, null],
    ['pricing.distrust_released', 'USER', STAND_ACCOUNTS.find((a) => a.role === 'OWNER')!.email, note],
  ]);
});

test('step 24, Р-123 on PostgreSQL: the check before announcing, the refusal of a violation and the evidence come from the database; the announcement is audited', async () => {
  const owner = await login('OWNER');
  const live = worlds.find((w) => w.id === WORLD)!;
  const post = (path: string, body: unknown) => handle({ method: 'POST', url: path, body, ...owner });
  const scope = (await handle({ method: 'GET', url: api('compliance'), body: undefined, ...owner })).body as ComplianceView;
  const writeScopeId = scope.offers.find((o) => o.writeScopeId === 'ws-price-de-4101')!.writeScopeId;
  const startsAt = new Date(Date.parse(live.clock.iso()) + 86_400_000).toISOString();
  const prior = await live.store.omnibusCheck(live.tenantId, writeScopeId, startsAt);
  assert.ok(prior.lowestMinor !== null && prior.timeZone === 'Europe/Berlin', JSON.stringify(prior));
  const discount = { writeScopeId, referencePriceMinor: prior.lowestMinor! + 1, salePriceMinor: prior.lowestMinor! - 100, startsAt, endsAt: null };
  const check = (await post(api('compliance', 'check'), discount)).body as DiscountCheckView;
  assert.equal(check.verdict, 'VIOLATION');
  const refused = await post(api('compliance', 'announce'), { ...discount, confirmed: true });
  assert.deepEqual([refused.status, (refused.body as { error: { code: string } }).error.code], [400, 'OMNIBUS_VIOLATION'], JSON.stringify(refused.body));
  const announced = await post(api('compliance', 'announce'), { ...discount, referencePriceMinor: prior.lowestMinor!, confirmed: true });
  assert.equal(announced.status, 200, JSON.stringify(announced.body));
  assert.equal((announced.body as DiscountAnnounceResponse).compliance.rows.length, 1);

  const tenant = await inTenant(adminPool, live.identityTenantId, async (tx) => (await tx.query(
    `SELECT count(*)::int AS n FROM audit.audit_event WHERE tenant_id = $1 AND action = 'admin_change.insert' AND entity_type = 'tenant_data.discount_announcement'`, [live.identityTenantId])).rows[0].n as number);
  assert.equal(tenant, 1, 'the announcement is in the audit log');

  const day = (iso: string) => iso.slice(0, 10);
  const from = day(new Date(Date.parse(startsAt) - 40 * 86_400_000).toISOString());
  // OQ-202 (шаг 30): файл готовит фоновое задание и кладёт в базу; экран его скачивает, а не получает в ответе
  const evidenceJob = await finishJob(await post(api('compliance', 'evidence'), { from, to: day(startsAt), writeScopeId }), live);
  assert.equal(evidenceJob.status, 'SUCCEEDED', evidenceJob.error ?? '');
  const file = await handle({ method: 'GET', url: api('jobs', evidenceJob.jobId, 'artifact'), body: undefined, ...owner });
  assert.equal(file.status, 200, JSON.stringify(file.body));
  const csv = (file.file as { content: string }).content.trim().split('\n');
  assert.ok(csv.length > 1 && csv.slice(1).every((l: string) => l.startsWith('KAUFLAND,de,') && l.includes(',Europe/Berlin,EUR,GROSS,')), csv.join('\n'));
});
