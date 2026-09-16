import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { createPool, inTenant, seedPricingWorld } from '@repracer/pricing-store-pg';
import { createAuthenticator, staticJwks } from '../src/index.ts';
import { inviteMember, inviteRelink, issueSignupInvitation, PgIdentityDirectory } from '../src/pg.ts';
import { createTestIssuer } from '../src/test-issuer.ts';

/**
 * Р-78, Р-88, Р-90 на PostgreSQL: пользователь сопоставляется по (издатель, subject) ролью входа; привязка создаётся только
 * приёмом приглашения на адрес, подтверждённый поставщиком; приглашает владелец или администратор со вторым фактором из
 * административного сервиса; роль меняется со вторым фактором и применяется сразу; пользователь состоит в нескольких тенантах (Р-9).
 * Данные синтетические.
 */

const PG_URL = process.env.REPRACER_PG_URL;
if (!PG_URL) throw new Error('REPRACER_PG_URL is required: database tests do not skip (Р-84)');
const login = (name: string, max = 1) => createPool(PG_URL.replace('svc_app@', `${name}@`), { max, applicationName: `repracer-identity-${name}` });
// Р-90: путь решения, административный сервис, вход, онбординг, создание тенанта — разные роли подключения
const pool = createPool(PG_URL, { max: 4, applicationName: 'repracer-identity-test' });
const admin = login('svc_admin', 2);
const authenticator = login('svc_authenticator', 2);
const onboarding = login('svc_onboarding');
const provisioning = login('svc_provisioning');
after(async () => {
  for (const p of [pool, admin, authenticator, onboarding, provisioning]) await p.end();
});

const ISSUER = 'https://idp.stand.repracer.test';
const email = (tag: string) => `${tag}-${randomUUID().slice(0, 8)}@stand.repracer.test`;
const directory = new PgIdentityDirectory(authenticator as never);

async function signUp(address: string) {
  const subject = { issuer: ISSUER, subject: `sub-${randomUUID()}` };
  const { token } = await issueSignupInvitation(onboarding as never, address);
  return { subject, address, userId: await directory.acceptInvitation(token, subject, address, true) };
}

// Находка 5 ревью шага 16: существующий пользователь становится владельцем нового тенанта только своим адресом
function worldOf(owner: { userId: string; address: string }, n: number) {
  return seedPricingWorld(pool, {
    fixtureTenantId: `10000000-0000-4000-8000-00000000031${n}`, fixtureChannelAccountId: `20000000-0000-4000-8000-00000000031${n}`, marketplaces: ['de'],
    clock: new Date().toISOString(), seed: { scopes: [] }, memberUsers: { 'membership-owner': owner.userId },
    memberEmails: { 'membership-owner': owner.address }, provisioningPool: provisioning, adminPool: admin,
  });
}

const invite = (tenantId: string, userId: string, address: string, role: 'PRICING_MANAGER' | 'VIEWER' = 'PRICING_MANAGER') =>
  inTenant(admin, tenantId, (tx) => inviteMember(tx, { tenantId, email: address, role }), userId, { mfa: true });

test('Р-88, findings 11 and 13: a provider subject is linked only by accepting an invitation for its own verified email; the decision path neither links nor resolves', async () => {
  const subject = { issuer: ISSUER, subject: `sub-${randomUUID()}` };
  const address = email('owner');

  await assert.rejects(pool.query('INSERT INTO platform.external_identity (issuer, subject, user_id) VALUES ($1, $2, gen_random_uuid())', [ISSUER, subject.subject]),
    /permission denied/, 'the application has no insert on external identities');
  await assert.rejects(pool.query(`SELECT security.issue_signup_invitation('x@stand.repracer.test', '\\x00'::bytea, interval '1 day')`), /permission denied/,
    'only the onboarding role issues signup invitations');
  await assert.rejects(pool.query('SELECT * FROM security.resolve_external_identity($1, $2)', [ISSUER, subject.subject]), /permission denied/,
    'finding 13: the decision path does not read memberships by external identity');

  const { token } = await issueSignupInvitation(onboarding as never, address);
  await assert.rejects(directory.acceptInvitation(token, subject, email('someone-else'), true), /another email/);
  await assert.rejects(directory.acceptInvitation('not-the-token', subject, address, true), /unknown, used or expired/);
  await assert.rejects(directory.acceptInvitation(token, subject, address, false), /has not verified the email/, 'finding 11: an unverified email does not link');
  const userId = await directory.acceptInvitation(token, subject, address.toUpperCase(), true);
  assert.equal((await directory.resolve(subject))?.userId, userId);
  await assert.rejects(directory.acceptInvitation(token, { issuer: ISSUER, subject: `sub-${randomUUID()}` }, address, true), /unknown, used or expired/, 'a token links once');

  // Р-96: у пути решения чтения сопоставлений нет вовсе — отказ по правам, а не пустой ответ политики
  await assert.rejects(inTenant(pool, '00000000-0000-0000-0000-000000000000', (tx) => tx.query('SELECT count(*)::int AS n FROM platform.external_identity'), randomUUID()),
    /permission denied for table external_identity$/);
});

test('Р-88, Р-90: an owner with a second factor invites a member from the administrative service; without it, as an operator or from the decision path the invitation is refused; a role change needs the factor and applies at once', async () => {
  const idp = createTestIssuer({ issuer: ISSUER, audience: 'repracer-console' });
  const owner = await signUp(email('owner'));
  const ownerId = owner.userId;
  const world = await worldOf(owner, 4);
  const operatorUser = world.ids.dbId('user-operator');

  const memberEmail = email('pricing');
  const inviteAs = (userId: string, mfa: boolean, role: 'PRICING_MANAGER' | 'OWNER' = 'PRICING_MANAGER', viaPool = admin) =>
    inTenant(viaPool, world.tenantId, (tx) => inviteMember(tx, { tenantId: world.tenantId, email: memberEmail, role: role as never }), userId, { mfa });
  await assert.rejects(inviteAs(ownerId, true, 'PRICING_MANAGER', pool), /permission denied/, 'Р-90: not from the decision path');
  await assert.rejects(inviteAs(ownerId, false), /second factor/);
  await assert.rejects(inviteAs(operatorUser, true), /owner or admin/);
  await assert.rejects(inviteAs(ownerId, true, 'OWNER'), /cannot be granted/);
  const invited = await inviteAs(ownerId, true);

  const memberSubject = { issuer: ISSUER, subject: `sub-${randomUUID()}` };
  const auth = createAuthenticator({ issuer: ISSUER, audience: 'repracer-console', jwks: staticJwks(idp.jwks), directory });
  assert.equal(await auth.authenticate(`Bearer ${idp.token(memberSubject.subject)}`), null, 'not linked before the invitation is accepted');
  await directory.acceptInvitation(invited.token, memberSubject, memberEmail, true);
  const member = (await auth.authenticate(`Bearer ${idp.token(memberSubject.subject)}`))!.memberships.find((m) => m.tenantId === world.tenantId)!;
  assert.deepEqual([member.membershipId, member.role], [invited.membershipId, 'PRICING_MANAGER']);

  const setRole = (userId: string | undefined, mfa: boolean, viaPool = admin) => inTenant(viaPool, world.tenantId, (tx) => tx.query(
    `UPDATE tenant_data.membership SET role = 'VIEWER' WHERE membership_id = $1`, [invited.membershipId]), userId, { mfa });
  await assert.rejects(setRole(ownerId, true, pool), /permission denied/, 'Р-90: the decision path does not change roles');
  await assert.rejects(setRole(ownerId, false), /second factor/);
  // Р-97 (0066): смена роли без пользователя сессии — отказ стража административной записи
  await assert.rejects(setRole(undefined, true), /without a person/);
  await assert.rejects(setRole(invited.userId, true), /another active owner or admin/, 'nobody changes their own role');
  await setRole(ownerId, true);
  assert.equal((await auth.authenticate(`Bearer ${idp.token(memberSubject.subject)}`))!.memberships.find((m) => m.tenantId === world.tenantId)!.role, 'VIEWER');
});

test('finding 10, Р-9: a linked user accepts an invitation to a second tenant with the same sign-in; a second sign-in of the same provider and a sign-in of another user are refused', async () => {
  const addressA = email('agency');
  const a = await signUp(addressA);
  const b = await signUp(email('owner-b'));
  const worldA = await worldOf(a, 5);
  const worldB = await worldOf(b, 6);

  const toB = await invite(worldB.tenantId, b.userId, addressA);
  assert.equal(toB.userId, a.userId, 'the invitation is for the existing user');
  assert.equal(await directory.acceptInvitation(toB.token, a.subject, addressA, true), a.userId);
  const tenants = (await directory.resolve(a.subject))!.memberships.map((m) => m.tenantId).sort();
  assert.deepEqual(tenants, [worldA.tenantId, worldB.tenantId].sort(), 'one sign-in, two tenants');

  const worldC = await worldOf(b, 7);
  const toC = await invite(worldC.tenantId, b.userId, addressA, 'VIEWER');
  await assert.rejects(directory.acceptInvitation(toC.token, { issuer: ISSUER, subject: `sub-${randomUUID()}` }, addressA, true),
    /already linked to another sign-in/, 'relinking a user to another subject of the same provider is not supported (OQ-148)');

  const addressD = email('someone');
  const toD = await invite(worldC.tenantId, b.userId, addressD, 'VIEWER');
  await assert.rejects(directory.acceptInvitation(toD.token, a.subject, addressD, true), /linked to another user/, 'a sign-in linked to another user does not accept an invitation of someone else');
});

test('the password and session objects of step 13 no longer exist', async () => {
  const { rows } = await pool.query(`SELECT to_regclass('platform.user_credential') AS credential, to_regclass('platform.user_session') AS session,
                                            to_regprocedure('security.open_session(uuid, bytea, interval)') AS open_session`);
  assert.deepEqual(rows[0], { credential: null, session: null, open_session: null });
});

test('Р-98: a sign-in is relinked only by a new invitation of the tenant owner with a second factor; the old sign-in resolves nobody and both steps are audited', async () => {
  const address = email('relink');
  const owner = await signUp(address);
  const world = await worldOf(owner, 8);
  const relinkAs = (userId: string | undefined, mfa: boolean, viaPool = admin) =>
    inTenant(viaPool, world.tenantId, (tx) => inviteRelink(tx, { tenantId: world.tenantId, userId: owner.userId }), userId, { mfa });

  await assert.rejects(relinkAs(owner.userId, true, pool), /permission denied/, 'Р-90: the decision path does not relink');
  await assert.rejects(relinkAs(owner.userId, false), /second factor/, 'Р-98: a relink invitation without a second factor');
  await assert.rejects(relinkAs(world.ids.dbId('user-operator'), true), /only an active owner/, 'Р-98: only an active owner relinks');
  const stranger = await signUp(email('stranger'));
  await assert.rejects(inTenant(admin, world.tenantId, (tx) => inviteRelink(tx, { tenantId: world.tenantId, userId: stranger.userId }), owner.userId, { mfa: true }),
    /is not an active member/, 'Р-98: a relink is issued only to a member of the tenant');

  const moved = { issuer: ISSUER, subject: `sub-${randomUUID()}` };
  const plain = await issueSignupInvitation(onboarding as never, address);
  await assert.rejects(directory.acceptInvitation(plain.token, moved, address, true), /a relink needs a relink invitation/, 'an ordinary invitation does not relink');

  const invitation = await relinkAs(owner.userId, true);
  assert.equal(await directory.acceptInvitation(invitation.token, moved, address, true), owner.userId);
  assert.equal((await directory.resolve(moved))!.userId, owner.userId, 'the new sign-in is the user');
  assert.equal(await directory.resolve(owner.subject), null, 'the revoked sign-in resolves nobody');

  const again = await relinkAs(owner.userId, true);
  await assert.rejects(directory.acceptInvitation(again.token, owner.subject, address, true), /was unlinked/, 'the revoked sign-in accepts nothing');

  const actions = await inTenant(admin, world.tenantId, async (tx) => (await tx.query(
    `SELECT action FROM audit.audit_event WHERE tenant_id = $1 AND entity_type = 'identity_invitation' ORDER BY recorded_at, audit_event_id`,
    [world.tenantId])).rows.map((r) => r.action as string), owner.userId);
  assert.deepEqual(actions.slice(0, 2), ['identity.relink_invited', 'identity.relinked'], 'Р-98: the invitation and the relink are audited');
});

test('Р-98, step 17 finding 3: two invitations accepted at the same time link one sign-in of the provider, not two', async () => {
  const ownerB = await signUp(email('race-owner-b'));
  const ownerC = await signUp(email('race-owner-c'));
  const worldB = await worldOf(ownerB, 1);
  const worldC = await worldOf(ownerC, 2);
  const address = email('race');
  const toB = await invite(worldB.tenantId, ownerB.userId, address);
  const toC = await invite(worldC.tenantId, ownerC.userId, address, 'VIEWER');
  const sha256 = (token: string) => createHash('sha256').update(token, 'utf8').digest();

  const first = await authenticator.connect();
  try {
    await first.query('BEGIN');
    await first.query('SELECT security.accept_identity_invitation($1, $2, $3, $4, true)', [sha256(toB.token), ISSUER, `sub-${randomUUID()}`, address]);
    let settled = false;
    const second = directory.acceptInvitation(toC.token, { issuer: ISSUER, subject: `sub-${randomUUID()}` }, address, true)
      .then((userId) => userId, (error: Error) => error).finally(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(settled, false, 'Р-98: the second acceptance waits for the first');
    await first.query('COMMIT');
    const outcome = await second;
    assert.ok(outcome instanceof Error && /already has an active sign-in/.test(outcome.message), `Р-98: two active sign-ins of one provider for one user: ${String(outcome)}`);
  } finally {
    first.release();
  }
});

test('Р-98, step 18 finding 6: a sign-in is linked only in READ COMMITTED — a stricter snapshot does not see a link committed after it began', async () => {
  const owner = await signUp(email('iso-owner'));
  const world = await worldOf(owner, 3);
  const address = email('iso');
  const invitation = await invite(world.tenantId, owner.userId, address);
  const sha256 = (token: string) => createHash('sha256').update(token, 'utf8').digest();
  const client = await authenticator.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    const outcome = await client.query('SELECT security.accept_identity_invitation($1, $2, $3, $4, true)', [sha256(invitation.token), ISSUER, `sub-${randomUUID()}`, address])
      .then(() => 'linked', (error: Error) => error.message);
    await client.query('ROLLBACK');
    assert.match(outcome, /linked only in READ COMMITTED/, 'step 18 finding 6: a link in REPEATABLE READ is refused');
  } finally {
    client.release();
  }
});

