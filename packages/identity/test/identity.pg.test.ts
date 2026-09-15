import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { createPool, inTenant, seedPricingWorld } from '@repracer/pricing-store-pg';
import { createAuthenticator, staticJwks } from '../src/index.ts';
import { inviteMember, issueSignupInvitation, PgIdentityDirectory } from '../src/pg.ts';
import { createTestIssuer } from '../src/test-issuer.ts';

/**
 * Р-78, Р-88 на PostgreSQL: пользователь сопоставляется по (издатель, subject); привязка создаётся только приёмом приглашения;
 * приглашает владелец или администратор со вторым фактором; роль меняется со вторым фактором и применяется сразу.
 * Данные синтетические.
 */

const PG_URL = process.env.REPRACER_PG_URL;
if (!PG_URL) throw new Error('REPRACER_PG_URL is required: database tests do not skip (Р-84)');
const pool = createPool(PG_URL, { max: 4, applicationName: 'repracer-identity-test' });
const onboarding = createPool(PG_URL.replace('svc_app@', 'svc_onboarding@'), { max: 1, applicationName: 'repracer-identity-onboarding' });
after(async () => {
  await pool.end();
  await onboarding.end();
});

const ISSUER = 'https://idp.stand.repracer.test';
const email = (tag: string) => `${tag}-${randomUUID().slice(0, 8)}@stand.repracer.test`;

test('Р-88: a provider subject is linked only by accepting an invitation for its own email; the application cannot link directly', async () => {
  const directory = new PgIdentityDirectory(pool as never);
  const subject = { issuer: ISSUER, subject: `sub-${randomUUID()}` };
  const address = email('owner');

  await assert.rejects(pool.query('INSERT INTO platform.external_identity (issuer, subject, user_id) VALUES ($1, $2, gen_random_uuid())', [ISSUER, subject.subject]),
    /permission denied/, 'the application has no insert on external identities');
  await assert.rejects(pool.query(`SELECT security.issue_signup_invitation('x@stand.repracer.test', '\\x00'::bytea, interval '1 day')`), /permission denied/,
    'only the onboarding role issues signup invitations');

  const { token } = await issueSignupInvitation(onboarding as never, address);
  await assert.rejects(directory.acceptInvitation(token, subject, email('someone-else')), /another email/);
  await assert.rejects(directory.acceptInvitation('not-the-token', subject, address), /unknown, used or expired/);
  const userId = await directory.acceptInvitation(token, subject, address.toUpperCase());
  assert.equal((await directory.resolve(subject))?.userId, userId);
  await assert.rejects(directory.acceptInvitation(token, { issuer: ISSUER, subject: `sub-${randomUUID()}` }, address), /unknown, used or expired/, 'a token links once');

  const seenByOther = await inTenant(pool, '00000000-0000-0000-0000-000000000000', async (tx) => (await tx.query('SELECT count(*)::int AS n FROM platform.external_identity')).rows[0].n, randomUUID());
  assert.equal(seenByOther, 0);
});

test('Р-88: an owner with a second factor invites a member; without it, or as an operator, the invitation is refused; a role change needs the factor and applies at once', async () => {
  const directory = new PgIdentityDirectory(pool as never);
  const idp = createTestIssuer({ issuer: ISSUER, audience: 'repracer-console' });
  const ownerSubject = { issuer: ISSUER, subject: `sub-${randomUUID()}` };
  const ownerEmail = email('owner');
  const { token: ownerToken } = await issueSignupInvitation(onboarding as never, ownerEmail);
  const ownerId = await directory.acceptInvitation(ownerToken, ownerSubject, ownerEmail);
  const world = await seedPricingWorld(pool, {
    fixtureTenantId: '10000000-0000-4000-8000-000000000314', fixtureChannelAccountId: '20000000-0000-4000-8000-000000000314', marketplaces: ['de'],
    clock: new Date().toISOString(), seed: { scopes: [] }, memberUsers: { 'membership-owner': ownerId },
  });
  const operatorUser = world.ids.dbId('user-operator');

  const memberEmail = email('pricing');
  await assert.rejects(inTenant(pool, world.tenantId, (tx) => inviteMember(tx, { tenantId: world.tenantId, email: memberEmail, role: 'PRICING_MANAGER' }), ownerId),
    /second factor/);
  await assert.rejects(inTenant(pool, world.tenantId, (tx) => inviteMember(tx, { tenantId: world.tenantId, email: memberEmail, role: 'PRICING_MANAGER' }), operatorUser, { mfa: true }),
    /owner or admin/);
  await assert.rejects(inTenant(pool, world.tenantId, (tx) => inviteMember(tx, { tenantId: world.tenantId, email: memberEmail, role: 'OWNER' }), ownerId, { mfa: true }),
    /cannot be granted/);
  const invited = await inTenant(pool, world.tenantId, (tx) => inviteMember(tx, { tenantId: world.tenantId, email: memberEmail, role: 'PRICING_MANAGER' }), ownerId, { mfa: true });

  const memberSubject = { issuer: ISSUER, subject: `sub-${randomUUID()}` };
  const auth = createAuthenticator({ issuer: ISSUER, audience: 'repracer-console', jwks: staticJwks(idp.jwks), directory });
  assert.equal(await auth.authenticate(`Bearer ${idp.token(memberSubject.subject)}`), null, 'not linked before the invitation is accepted');
  await directory.acceptInvitation(invited.token, memberSubject, memberEmail);
  const member = (await auth.authenticate(`Bearer ${idp.token(memberSubject.subject)}`))!.memberships.find((m) => m.tenantId === world.tenantId)!;
  assert.deepEqual([member.membershipId, member.role], [invited.membershipId, 'PRICING_MANAGER']);

  const setRole = (userId: string | undefined, mfa: boolean) => inTenant(pool, world.tenantId, (tx) => tx.query(
    `UPDATE tenant_data.membership SET role = 'VIEWER' WHERE membership_id = $1`, [invited.membershipId]), userId, { mfa });
  await assert.rejects(setRole(ownerId, false), /second factor/);
  await assert.rejects(setRole(undefined, true), /another active owner or admin/);
  await assert.rejects(setRole(invited.userId, true), /another active owner or admin/, 'nobody changes their own role');
  await setRole(ownerId, true);
  assert.equal((await auth.authenticate(`Bearer ${idp.token(memberSubject.subject)}`))!.memberships.find((m) => m.tenantId === world.tenantId)!.role, 'VIEWER');
});

test('the password and session objects of step 13 no longer exist', async () => {
  const { rows } = await pool.query(`SELECT to_regclass('platform.user_credential') AS credential, to_regclass('platform.user_session') AS session,
                                            to_regprocedure('security.open_session(uuid, bytea, interval)') AS open_session`);
  assert.deepEqual(rows[0], { credential: null, session: null, open_session: null });
});
