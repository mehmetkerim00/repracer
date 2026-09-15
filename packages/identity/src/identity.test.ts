import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { test } from 'node:test';
import { createAuthenticator, MemoryIdentityDirectory, staticJwks, TokenError, verifyToken, type Jwk } from './index.ts';
import { createTestIssuer } from './test-issuer.ts';

/** Р-78: токен внешнего поставщика и сопоставление с членствами; паролей и сессий у нас нет */

const ISSUER = 'https://idp.stand.repracer.test';
const AUDIENCE = 'repracer-console';
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');

function world() {
  const idp = createTestIssuer({ issuer: ISSUER, audience: AUDIENCE });
  const directory = new MemoryIdentityDirectory();
  directory.link({ issuer: ISSUER, subject: 'sub-operator' }, 'user-operator');
  directory.addMembership('user-operator', { tenantId: 'tenant-1', membershipId: 'membership-operator', role: 'OPERATOR' });
  const auth = createAuthenticator({ issuer: ISSUER, audience: AUDIENCE, jwks: staticJwks(idp.jwks), directory });
  return { idp, directory, auth };
}

const rejected = async (token: string, jwks: readonly Jwk[], reason: string, options: { audience?: string; issuer?: string } = {}) =>
  assert.rejects(verifyToken(token, { issuer: options.issuer ?? ISSUER, audience: options.audience ?? AUDIENCE, jwks: staticJwks(jwks) }),
    (e: unknown) => e instanceof TokenError && e.reason === reason, reason);

test('a valid provider token resolves to our user and memberships; roles are read on every request', async () => {
  const { idp, directory, auth } = world();
  const principal = await auth.authenticate(`Bearer ${idp.token('sub-operator', { email: 'operator@stand.repracer.test' })}`);
  assert.deepEqual([principal?.userId, principal?.memberships.map((m) => m.role), principal?.amr], ['user-operator', ['OPERATOR'], ['pwd', 'otp']]);
  directory.setRole('user-operator', 'tenant-1', 'VIEWER');
  assert.equal((await auth.authenticate(`Bearer ${idp.token('sub-operator')}`))?.memberships[0]?.role, 'VIEWER');
  assert.equal(await auth.authenticate(`Bearer ${idp.token('sub-unlinked')}`), null, 'a subject without a link is not our user');
  assert.equal(await auth.authenticate(undefined), null);
  assert.equal(await auth.authenticate('Basic abc'), null);
});

test('forged, foreign, expired and algorithm-confused tokens are rejected', async () => {
  const { idp } = world();
  const good = idp.token('sub-operator');
  const [h, p, s] = good.split('.');
  // Подменённое содержимое
  await rejected(`${h}.${b64({ ...JSON.parse(Buffer.from(p!, 'base64url').toString()), sub: 'sub-owner' })}.${s}`, idp.jwks, 'SIGNATURE');
  // Чужой издатель и аудитория
  await rejected(good, idp.jwks, 'ISSUER', { issuer: 'https://other.example.test' });
  await rejected(good, idp.jwks, 'AUDIENCE', { audience: 'other-app' });
  // Истёкший
  await rejected(idp.token('sub-operator', { expiresInSeconds: -3600 }), idp.jwks, 'EXPIRED');
  // alg none и HMAC с публичным ключом в роли секрета
  await rejected(`${b64({ alg: 'none', kid: idp.jwks[0]!.kid })}.${p}.`, idp.jwks, 'MALFORMED');
  await rejected(`${b64({ alg: 'HS256', kid: idp.jwks[0]!.kid })}.${p}.${s}`, idp.jwks, 'ALGORITHM');
  // Подпись другим ключом с тем же kid
  const other = createTestIssuer({ issuer: ISSUER, audience: AUDIENCE });
  const forged = other.token('sub-operator').split('.');
  await rejected(`${b64({ alg: 'ES256', kid: idp.jwks[0]!.kid })}.${forged[1]}.${forged[2]}`, idp.jwks, 'SIGNATURE');
  // Неизвестный kid
  await rejected(other.token('sub-operator'), idp.jwks, 'KEY_NOT_FOUND');
});

test('RS256 needs a key of at least 2048 bits', async () => {
  const token = (bits: number) => {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: bits });
    const jwk = { ...(publicKey.export({ format: 'jwk' }) as Jwk), kid: `k${bits}`, alg: 'RS256' };
    const now = Math.floor(Date.now() / 1000);
    const body = `${b64({ alg: 'RS256', kid: jwk.kid })}.${b64({ iss: ISSUER, aud: [AUDIENCE, 'x'], sub: 's', exp: now + 60 })}`;
    return { jwk, token: `${body}.${sign('sha256', Buffer.from(body), privateKey).toString('base64url')}` };
  };
  const strong = token(2048);
  assert.equal((await verifyToken(strong.token, { issuer: ISSUER, audience: AUDIENCE, jwks: staticJwks([strong.jwk]) })).subject, 's');
  const weak = token(1024);
  await rejected(weak.token, [weak.jwk], 'ALGORITHM');
});
