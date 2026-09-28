import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { challengeResponse, notificationApiKeys, parseSignatureHeader, verifyNotification, type PublicKeySource } from '../src/verify.ts';
import { checkEndpoint, loadDeletionConfig } from '../src/config.ts';
import { parseNotice } from '../src/handler.ts';

/**
 * Шаг 49 [Р-192]: проверка подлинности — на ОФИЦИАЛЬНЫХ тестовых векторах eBay из SDK, закреплённого коммитом
 * (vendor/ebay/event-notification-sdk/feaf3378…/test/test.json): подпись eBay, ключ Notification API, сообщение.
 */
const SDK = new URL('../../../vendor/ebay/event-notification-sdk/feaf3378ca263a81432cf5b8c8a6fd8cb3d3e2f3/', import.meta.url);
const vectors = JSON.parse(readFileSync(new URL('test/test.json', SDK), 'utf8')) as Record<string, { signature: string; message: unknown; public_key: string; response: { key: string; algorithm: string; digest: string } | null }>;
const keysOf = (response: { key: string; algorithm: string; digest: string } | null, kid: string): PublicKeySource => ({
  async get(k) { assert.equal(k, kid, 'ключ запрошен по kid из заголовка'); return response; },
});

test('Р-192: official eBay SDK vectors — VALID is authentic, INVALID and SIGNATURE_MISMATCH are not', async () => {
  const kid = vectors.VALID!.public_key;
  assert.deepEqual(await verifyNotification(vectors.VALID!.message, vectors.VALID!.signature, keysOf(vectors.VALID!.response, kid)), { ok: true, kid });
  assert.deepEqual(await verifyNotification(vectors.INVALID!.message, vectors.INVALID!.signature, keysOf(vectors.INVALID!.response, kid)), { ok: false, reason: 'SIGNATURE_INVALID' });
  assert.deepEqual(await verifyNotification(vectors.SIGNATURE_MISMATCH!.message, vectors.SIGNATURE_MISMATCH!.signature, keysOf(vectors.SIGNATURE_MISMATCH!.response, kid)), { ok: false, reason: 'SIGNATURE_INVALID' });
});

test('Р-192: a header that is missing, malformed or names another algorithm is refused, never guessed', async () => {
  const never: PublicKeySource = { async get() { throw new Error('the key must not be fetched'); } };
  assert.deepEqual(await verifyNotification({}, undefined, never), { ok: false, reason: 'HEADER_MISSING' });
  assert.deepEqual(await verifyNotification({}, 'not-base64-json', never), { ok: false, reason: 'HEADER_MALFORMED' });
  const header = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64');
  assert.deepEqual(await verifyNotification({}, header({ alg: 'rsa', kid: 'k1', signature: 'x', digest: 'SHA1' }), never), { ok: false, reason: 'ALGORITHM_UNSUPPORTED' });
  assert.equal(parseSignatureHeader(header({ alg: 'ecdsa', kid: '../../x', signature: 's', digest: 'SHA1' })), null, 'kid идёт в путь запроса — только буквы, цифры и дефис');
  assert.deepEqual(await verifyNotification({}, header({ alg: 'ecdsa', kid: 'k1', signature: 'x', digest: 'SHA1' }), { async get() { return null; } }), { ok: false, reason: 'KEY_UNKNOWN' });
});

test('Р-192: a message signed by another key is not authentic', async () => {
  const ours = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const theirs = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const message = { metadata: { topic: 'MARKETPLACE_ACCOUNT_DELETION' }, notification: { notificationId: 'syn-0001-forged' } };
  const signature = createSign('sha1').update(JSON.stringify(message)).sign(theirs.privateKey, 'base64');
  const header = Buffer.from(JSON.stringify({ alg: 'ecdsa', kid: 'k-ours', signature, digest: 'SHA1' })).toString('base64');
  const key = (ours.publicKey.export({ type: 'spki', format: 'pem' }) as string).replace(/\n/g, '');
  assert.deepEqual(await verifyNotification(message, header, { async get() { return { key, algorithm: 'ECDSA', digest: 'SHA1' }; } }), { ok: false, reason: 'SIGNATURE_INVALID' });
});

test('Р-192: the challenge response is SHA-256 of challengeCode + verificationToken + endpoint, hex — as the page and the SDK compute it', () => {
  const endpoint = 'https://deletion.repracer.test/ebay/account-deletion';
  const token = 'syn-verification-token-0123456789abcdef';
  const expected = createHash('sha256').update('syn-code-1' + token + endpoint).digest('hex');
  assert.equal(challengeResponse('syn-code-1', token, endpoint), expected);
  assert.match(expected, /^[0-9a-f]{64}$/);
});

test('Р-192: the notification is read by the AsyncAPI shape; anything else is refused', () => {
  const ok = parseNotice(vectors.VALID!.message);
  assert.deepEqual(ok && { id: ok.notificationId.length > 8, user: ok.userId, attempt: ok.publishAttemptCount }, { id: true, user: 'ma8vp1jySJC', attempt: 1 });
  assert.equal(parseNotice({ notification: { notificationId: 'syn-0002-no-user', eventDate: '2026-09-28T00:00:00Z', data: {} } }), null);
  assert.equal(parseNotice({ notification: { notificationId: 'x', eventDate: '2026-09-28T00:00:00Z', data: { userId: 'u' } } }), null, 'номер уведомления — короткий и странный');
});

test('Р-192: the endpoint given to eBay is public https; the verification token follows the eBay rules', () => {
  assert.equal(checkEndpoint('https://deletion.example.com/ebay/account-deletion'), 'https://deletion.example.com/ebay/account-deletion');
  for (const bad of ['http://deletion.example.com/x', 'https://localhost/x', 'https://127.0.0.1/x', 'https://10.0.0.5/x', 'https://192.168.1.2/x', 'https://example.com/x?a=1']) {
    assert.throws(() => checkEndpoint(bad), /must be a public https address/, bad);
  }
  const base = { REPRACER_EBAY_DELETION_ENDPOINT: 'https://deletion.example.com/ebay/account-deletion', REPRACER_EBAY_ENVIRONMENT: 'PRODUCTION', REPRACER_EBAY_CLIENT_ID: 'syn-client',
    REPRACER_EBAY_DELETION_HEARTBEAT: 'off', REPRACER_EBAY_DELETION_VERIFICATION_TOKEN_FILE: '/t', REPRACER_EBAY_DELETION_PG_URL_FILE: '/p', REPRACER_EBAY_CLIENT_SECRET_FILE: '/s' };
  const files = (token: string) => (path: string) => ({ '/t': token, '/p': 'postgres://svc_ebay_deletion@db/x', '/s': 'syn-secret' } as Record<string, string>)[path]!;
  assert.equal(loadDeletionConfig(base, files('syn_verification-token_0123456789abcdef')).apiBase, 'https://api.ebay.com');
  assert.throws(() => loadDeletionConfig(base, files('too-short')), /32–80 characters/);
  assert.throws(() => loadDeletionConfig(base, files('syn verification token with spaces 0123')), /32–80 characters/);
  assert.throws(() => loadDeletionConfig({ ...base, REPRACER_EBAY_DELETION_API_BASE: 'http://127.0.0.1:1' }, files('syn_verification-token_0123456789abcdef')), /only with REPRACER_MODE=stand/);
  assert.throws(() => loadDeletionConfig({ ...base, REPRACER_EBAY_DELETION_HEARTBEAT: '' }, files('syn_verification-token_0123456789abcdef')), /HEARTBEAT_URL/);
});

test('Р-192, находка 4 ревью: ключ Notification API — отрицательный кэш, склейка, предел обращений и прежний ключ при сбое обновления', async () => {
  let t = 0;
  const calls: string[] = [];
  let keyStatus = 200;
  const fetchFn = (async (url: string | URL) => {
    const u = String(url);
    calls.push(u.replace(/.*\/(oauth2\/token|public_key\/.*)$/, '$1'));
    if (u.endsWith('/oauth2/token')) return new Response(JSON.stringify({ access_token: 'syn-app-token', expires_in: 7200 }), { status: 200 });
    if (u.endsWith('/public_key/k-known')) return keyStatus === 200 ? new Response(JSON.stringify({ key: 'syn-pem', algorithm: 'ECDSA', digest: 'SHA1' }), { status: 200 }) : new Response('', { status: keyStatus });
    return new Response('', { status: 404 });
  }) as typeof fetch;
  const keys = notificationApiKeys({ apiBase: 'https://api.example.invalid', clientId: 'c', clientSecret: 's', fetchFn, now: () => t, maxFetchesPerMinute: 3 });
  // Неизвестный kid: к eBay один раз, дальше — из отрицательного кэша
  assert.equal(await keys.get('k-forged-1'), null);
  assert.equal(await keys.get('k-forged-1'), null);
  assert.equal(calls.filter((c) => c === 'public_key/k-forged-1').length, 1, 'неизвестный kid помнится');
  // Одинаковые запросы в полёте склеиваются
  const [a, b] = await Promise.all([keys.get('k-known'), keys.get('k-known')]);
  assert.equal(a?.key, 'syn-pem');
  assert.equal(b?.key, 'syn-pem');
  assert.equal(calls.filter((c) => c === 'public_key/k-known').length, 1, 'склеено в одно обращение');
  // Предел обращений в минуту: третий новый kid ещё проходит, четвёртый — «сейчас не получить» (eBay повторит), без обращения
  assert.equal(await keys.get('k-forged-2'), null);
  await assert.rejects(keys.get('k-forged-3'), /fetch limit 3\/min/);
  assert.equal(calls.filter((c) => c === 'public_key/k-forged-3').length, 0, 'сверх предела к eBay не ходили');
  // Через час ключ устарел, eBay отвечает 429 — отдаётся прежний ключ, а не 500 подлинному уведомлению
  t += 3_600_001;
  keyStatus = 429;
  assert.equal((await keys.get('k-known'))?.key, 'syn-pem');
});
