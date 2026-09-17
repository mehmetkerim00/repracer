import assert from 'node:assert/strict';
import { test } from 'node:test';
import { amzDate, buildQuery, createSpApiClient } from '../src/index.ts';

/** Транспорт SP-API без сети: токен LWA кэшируется, запись после тайм-аута не повторяется, 429 повторяется. Данные синтетические */
function world() {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: string }> = [];
  let now = Date.parse('2026-09-14T10:00:00.000Z');
  const replies: Array<(url: string) => Response | 'TIMEOUT'> = [];
  const fetchStub = (async (url: string, init: RequestInit) => {
    calls.push({ url, method: String(init.method), headers: init.headers as Record<string, string>, body: String(init.body ?? '') });
    const reply = replies.shift();
    if (!reply) throw new Error('no reply');
    const r = reply(url);
    if (r === 'TIMEOUT') {
      // Таймер AbortSignal.timeout не удерживает цикл событий: без удержания процесс завершится раньше отмены
      const keepAlive = setInterval(() => {}, 5);
      return new Promise((_, reject) => init.signal!.addEventListener('abort', () => { clearInterval(keepAlive); reject(init.signal!.reason); }));
    }
    return r;
  }) as unknown as typeof fetch;
  const token = () => new Response(JSON.stringify({ access_token: 'Atza|syn-a', token_type: 'bearer', expires_in: 3600 }), { status: 200 });
  const client = createSpApiClient({ region: 'EU', userAgent: 'syn/1.0 (Language=TypeScript)', fetch: fetchStub, now: () => now, sleep: async (ms) => { now += ms; },
    credentials: async () => ({ clientId: 'syn-client', clientSecret: 'syn-secret', refreshToken: 'Atzr|syn-r' }), timeoutMs: 20 });
  return { calls, replies, token, client, advance: (ms: number) => { now += ms; } };
}

test('LWA token is requested once, cached until expiry, and sent only in x-amz-access-token; secrets never reach the SP-API URL', async () => {
  const w = world();
  w.replies.push(w.token, () => new Response('{}', { status: 200 }), () => new Response('{}', { status: 200 }));
  assert.equal((await w.client.request('GET', '/listings/2021-08-01/items/S/K', { query: { marketplaceIds: ['A1PA6795UKMFR9'], includedData: ['summaries', 'attributes'] } })).ok, true);
  assert.equal((await w.client.request('GET', '/listings/2021-08-01/items/S/K')).ok, true);
  assert.equal(w.calls.length, 3, 'one token request for two API calls');
  assert.equal(w.calls[0]!.url, 'https://api.amazon.com/auth/o2/token');
  assert.match(w.calls[0]!.body, /grant_type=refresh_token/);
  assert.equal(w.calls[1]!.url, 'https://sellingpartnerapi-eu.amazon.com/listings/2021-08-01/items/S/K?marketplaceIds=A1PA6795UKMFR9&includedData=summaries%2Cattributes');
  assert.equal(w.calls[1]!.headers['x-amz-access-token'], 'Atza|syn-a');
  assert.equal(w.calls[1]!.headers['x-amz-date'], '20260914T100000Z');
  for (const c of w.calls.slice(1)) assert.ok(!c.url.includes('syn-secret') && !c.body.includes('syn-secret') && !c.url.includes('Atzr'));
  w.advance(3_600_000);
  w.replies.push(w.token, () => new Response('{}', { status: 200 }));
  await w.client.request('GET', '/x');
  assert.equal(w.calls.at(-2)!.url, 'https://api.amazon.com/auth/o2/token', 'expired token is refreshed');
});

test('a PATCH is not repeated after a timeout (outcome unknown), a GET is; 429 is repeated for both', async () => {
  const w = world();
  w.replies.push(w.token, () => 'TIMEOUT');
  const patched = await w.client.request('PATCH', '/p', { body: { a: 1 } });
  assert.deepEqual([patched.ok, !patched.ok && patched.outcomeUnknown, patched.attempts.length], [false, true, 1]);
  w.replies.push(() => 'TIMEOUT', () => new Response('{}', { status: 200 }));
  const read = await w.client.request('GET', '/g');
  assert.deepEqual([read.ok, read.attempts.length], [true, 2]);
  w.replies.push(() => new Response('{"errors":[{"code":"QuotaExceeded","message":"m"}]}', { status: 429 }), () => new Response('{}', { status: 200 }));
  const retried = await w.client.request('PATCH', '/p', { body: { a: 1 } });
  assert.deepEqual([retried.ok, retried.attempts.length], [true, 2]);
  assert.equal(amzDate(Date.parse('2026-01-02T03:04:05.678Z')), '20260102T030405Z');
  assert.equal(buildQuery({ a: ['x', 'y'], b: undefined, c: 3 }), '?a=x%2Cy&c=3');
});

test('an LWA refusal is a token failure: nothing is sent to SP-API', async () => {
  const w = world();
  w.replies.push(() => new Response('{"error":"invalid_grant"}', { status: 400 }));
  const r = await w.client.request('GET', '/g');
  assert.ok(!r.ok && r.tokenFailure && r.errors[0]!.code === 'LWA_TOKEN_REFUSED');
  assert.equal(w.calls.length, 1);
});
