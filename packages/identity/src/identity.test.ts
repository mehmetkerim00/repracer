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

/**
 * Шаг 45 (находки 1–3 ревью): второй фактор из ID-токена и ID-токен как пропуск. Каждое правило — своим отказом:
 * чужой субъект, чужой издатель, чужая аудитория, просроченный, испорченный, другой обмен кода, не-ID-токен.
 */
test('шаг 45: ID-токен даёт второй фактор только тому же входу; как Bearer ID-токен не принимается', async () => {
  const { generateKeyPairSync: keys } = await import('node:crypto');
  const { createLocalIssuer } = await import('./test-issuer.ts');
  const pem = keys('ec', { namedCurve: 'prime256v1' }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const CLIENT = 'console-spa';
  let clock = Date.parse('2026-09-27T10:00:00Z');
  const at = (ms: number) => () => ms;
  const access = createLocalIssuer({ issuer: ISSUER, audience: AUDIENCE, privateKeyPem: pem, now: () => clock });
  const idFor = (o: { issuer?: string; aud?: unknown; sub?: string; at?: number; exp?: number; shaped?: boolean } = {}) =>
    createLocalIssuer({ issuer: o.issuer ?? ISSUER, audience: CLIENT, privateKeyPem: pem, now: at(o.at ?? clock) }).token(o.sub ?? 'sub-operator', {
      amr: ['pwd', 'otp'], expiresInSeconds: o.exp ?? 3600,
      extra: { aud: o.aud ?? [CLIENT, AUDIENCE], ...(o.shaped === false ? {} : { auth_time: Math.floor((o.at ?? clock) / 1000) }) },
    });
  const directory = new MemoryIdentityDirectory();
  directory.link({ issuer: ISSUER, subject: 'sub-operator' }, 'user-operator');
  const jwks = staticJwks(createLocalIssuer({ issuer: ISSUER, audience: AUDIENCE, privateKeyPem: pem }).jwks);
  const auth = createAuthenticator({ issuer: ISSUER, audience: AUDIENCE, jwks, directory, idTokenAudience: CLIENT, now: () => clock });
  const bearer = `Bearer ${access.token('sub-operator', { amr: [], extra: { amr: undefined } })}`;
  const amr = async (idToken: string) => (await auth.authenticate(bearer, idToken))?.amr ?? null;

  assert.deepEqual(await amr(idFor()), ['pwd', 'otp'], 'тот же вход — второй фактор есть');
  assert.deepEqual(await amr(idFor({ sub: 'sub-someone-else' })), [], 'чужой субъект');
  assert.deepEqual(await amr(idFor({ issuer: 'https://other.stand.repracer.test' })), [], 'чужой издатель');
  assert.deepEqual(await amr(idFor({ aud: ['another-client'] })), [], 'выдан другому клиенту');
  assert.deepEqual(await amr(idFor({ shaped: false })), [], 'без формы ID-токена (auth_time)');
  assert.deepEqual(await amr(idFor({ at: clock - 3 * 3600_000, exp: 4 * 3600 })), [], 'утренний вход к токену доступа позднего входа');
  assert.deepEqual(await amr(`${idFor().slice(0, -4)}AAAA`), [], 'испорченная подпись');
  const early = idFor({ at: clock - 2 * 3600_000, exp: 3600 });
  assert.deepEqual(await amr(early), [], 'просроченный');

  // Находка 1: ID-токен (аудитория включает проект, как у ZITADEL) как Authorization: Bearer — не пропуск
  assert.equal(await auth.authenticate(`Bearer ${idFor()}`), null, 'ID-токен не входит как токен доступа');
  assert.equal(await auth.identify(`Bearer ${idFor()}`), null, 'и не принимает приглашения');
});
