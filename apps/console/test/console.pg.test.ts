import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { DecisionListItem, DecisionTrace, StopView } from '@repracer/console-model';
import { buildStandWorlds, pgStandUsers, STAND_ACCOUNTS, STAND_AUDIENCE, STAND_ISSUER, type LiveWorld } from '@repracer/contract-tests/stand';
import { pgStoreFactory } from '@repracer/contract-tests/pg-store';
import { createAuthenticator, staticJwks } from '@repracer/identity';
import { PgIdentityDirectory } from '@repracer/identity/pg';
import { createTestIssuer } from '@repracer/identity/test-issuer';
import { createPool, inTenant } from '@repracer/pricing-store-pg';
import type { StandToken } from '../src/api-types.ts';
import { createStandApi } from '../server/stand-server.ts';

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
let memberUsers: Record<string, string> = {};
const WORLD = 'kaufland/pipeline/happy-path';

let handle: ReturnType<typeof createStandApi>;
let worlds: LiveWorld[] = [];
before(async () => {
  const directory = new PgIdentityDirectory(pool as never);
  memberUsers = await pgStandUsers(directory, onboardingPool);
  worlds = await buildStandWorlds({ filter: (s) => s.id === WORLD, storeFactory: pgStoreFactory(pool, scanPool!, fxPool!, { memberUsers }) });
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

  const rows = await inTenant(pool, world.identityTenantId, async (tx) => (await tx.query(
    `SELECT e.action, e.actor_type, m.role AS member_role, u.email, e.changes FROM audit.audit_event e
       JOIN tenant_data.membership m ON m.tenant_id = e.tenant_id AND m.membership_id = e.actor_membership_id
       JOIN platform.app_user u ON u.user_id = e.actor_user_id
      WHERE e.entity_type = 'price_stop' ORDER BY e.recorded_at`)).rows);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].action, rows[0].actor_type, rows[0].email, rows[0].changes.role, rows[0].changes.scope, rows[0].changes.note],
    ['pricing.stop_created', 'USER', STAND_ACCOUNTS.find((a) => a.role === 'OPERATOR')!.email, 'OPERATOR', 'TENANT', 'Synthetic kill switch on PostgreSQL']);

  // Роль меняется в базе — владелец в своей сессии со вторым фактором [Р-88]; следующий запрос с тем же токеном уже с новой ролью
  await inTenant(pool, world.identityTenantId, (tx) => tx.query(
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
