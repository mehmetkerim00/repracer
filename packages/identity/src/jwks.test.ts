import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAuthenticator, MemoryIdentityDirectory, remoteJwks } from './index.ts';
import { createTestIssuer } from './test-issuer.ts';

/**
 * Находка 5 ревью шага 14: JWKS поставщика не должен превращать сбой или поток токенов в отказ входа или в лавину запросов.
 * Поставщик — поддельный fetch с часами теста; токены — локальный имитатор. Данные синтетические.
 */

const ISSUER = 'https://idp.jwks.test';
const AUDIENCE = 'console';

function provider(issuer: ReturnType<typeof createTestIssuer>) {
  const state = { calls: 0, status: 200, hang: false, body: null as string | null };
  const fetchFn = (async (_url: string, init?: { signal?: AbortSignal }) => {
    state.calls++;
    if (state.hang) {
      return new Promise((_resolve, reject) => {
        // Таймер держит цикл событий: иначе тест завершится раньше тайм-аута запроса
        const hung = setTimeout(() => reject(new Error('fake provider hung past the test')), 10_000);
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(hung);
          reject(new DOMException('timeout', 'TimeoutError'));
        });
      });
    }
    await new Promise((r) => setTimeout(r, 5));
    const text = state.body ?? JSON.stringify({ keys: issuer.jwks });
    return new Response(text, { status: state.status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { state, fetchFn };
}

function setup(options: { ttlSeconds?: number; minRefreshSeconds?: number; maxStaleSeconds?: number; timeoutMs?: number; maxBytes?: number } = {}) {
  const clock = { t: Date.parse('2026-09-15T10:00:00Z') };
  const issuer = createTestIssuer({ issuer: ISSUER, audience: AUDIENCE, now: () => clock.t });
  const { state, fetchFn } = provider(issuer);
  const jwks = remoteJwks('https://idp.jwks.test/keys', { fetch: fetchFn, now: () => clock.t, ...options });
  const directory = new MemoryIdentityDirectory();
  directory.link({ issuer: ISSUER, subject: 'user-1' }, 'u1');
  const auth = createAuthenticator({ issuer: ISSUER, audience: AUDIENCE, jwks, directory, now: () => clock.t });
  const token = () => `Bearer ${issuer.token('user-1')}`;
  return { issuer, clock, state, jwks, auth, token, stranger: () => createTestIssuer({ issuer: ISSUER, audience: AUDIENCE, now: () => clock.t }) };
}

test('finding 5: fifty concurrent requests on a cold cache make one request to the provider', async () => {
  const { state, auth, token } = setup();
  const results = await Promise.all(Array.from({ length: 50 }, () => auth.authenticate(token())));
  assert.ok(results.every((p) => p?.userId === 'u1'));
  assert.equal(state.calls, 1);
});

test('finding 5: a provider outage after the cache expired keeps sign-in working on the last keys, with one request per refresh window', async () => {
  const { state, clock, auth, token } = setup({ ttlSeconds: 600, minRefreshSeconds: 30 });
  assert.ok(await auth.authenticate(token()));
  state.status = 503;
  clock.t += 700_000;
  const results = await Promise.all(Array.from({ length: 50 }, () => auth.authenticate(token())));
  assert.ok(results.every((p) => p?.userId === 'u1'), 'valid tokens are accepted on the stale keys');
  assert.equal(state.calls, 2, 'one failed refresh for fifty requests');
  clock.t += 10_000;
  await auth.authenticate(token());
  assert.equal(state.calls, 2, 'no new attempt inside the refresh window');
  clock.t += 30_000;
  await auth.authenticate(token());
  assert.equal(state.calls, 3);
});

test('finding 5: a flood of tokens with unknown key ids does not become a flood of provider requests — even after the cache expired', async () => {
  const { state, clock, auth, token, stranger: other } = setup({ ttlSeconds: 60, minRefreshSeconds: 30 });
  assert.ok(await auth.authenticate(token()));
  clock.t += 120_000;
  const stranger = other();
  const results = await Promise.all(Array.from({ length: 100 }, () => auth.authenticate(`Bearer ${stranger.token('user-1')}`)));
  assert.ok(results.every((p) => p === null), 'unknown keys are rejected as 401');
  assert.ok(state.calls <= 2, `requests to the provider: ${state.calls}`);
});

test('finding 5: a hanging provider times out; without usable keys sign-in fails closed, beyond the stale limit too', async () => {
  const cold = setup({ timeoutMs: 50 });
  cold.state.hang = true;
  const started = Date.now();
  await assert.rejects(cold.auth.authenticate(cold.token()), /timeout|abort/i);
  assert.ok(Date.now() - started < 2000, 'the request is bounded by the timeout');

  const stale = setup({ ttlSeconds: 60, minRefreshSeconds: 1, maxStaleSeconds: 3600, timeoutMs: 50 });
  assert.ok(await stale.auth.authenticate(stale.token()));
  stale.state.hang = true;
  stale.clock.t += 120_000;
  assert.ok(await stale.auth.authenticate(stale.token()), 'a hanging provider within the stale limit: last keys');
  stale.clock.t += 3_700_000;
  await assert.rejects(stale.auth.authenticate(stale.token()), /timeout|abort/i, 'beyond the stale limit: no keys, no sign-in');
});

test('finding 5: an oversized or empty key set is refused', async () => {
  const big = setup({ maxBytes: 1024 });
  big.state.body = JSON.stringify({ keys: big.issuer.jwks, padding: 'x'.repeat(4096) });
  await assert.rejects(big.auth.authenticate(big.token()), /larger than 1024 bytes/);
  const empty = setup();
  empty.state.body = JSON.stringify({ keys: [] });
  await assert.rejects(empty.auth.authenticate(empty.token()), /has no keys/);
});
