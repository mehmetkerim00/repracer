import assert from 'node:assert/strict';
import { test } from 'node:test';
import { memoryStandDirectory, STAND_AUDIENCE, STAND_ISSUER, type LiveWorld } from '@repracer/contract-tests/stand';
import { createAuthenticator, staticJwks } from '@repracer/identity';
import { createTestIssuer } from '@repracer/identity/test-issuer';
import { createStandApi } from '../server/stand-server.ts';
import { EMPTY_WORLD_ID, emptyWorld, emptyWorldConnect } from './empty-world.ts';

/**
 * Шаг 186 (письмо Мердана 28.11, §1): Мердан видит только трёхканальное демо — его оставили ради перепроверок, — и клиентский режим
 * шага 176 (только Amazon US) ему не виден: стенд QA-A идёт с каталогом «все каналы». Четвёртый демо-мир «Demo store — Amazon US» —
 * в виде клиента: признак мира `clientView` даёт ему каталог каналов клиента тем же правилом шага 176 (`tenantMarketScope`), хотя тенант
 * демо (симулятор, синтетика, страж боевых записей его не держит). Остальные миры стенда — как были.
 *
 * Данные синтетические, без базы.
 */
const OTHER_CHANNELS = /EBAY|ebay\.com|WALMART|walmart\.com|KAUFLAND|kaufland/i;

const clock = {
  iso: (offsetMs = 0) => new Date(Date.parse('2026-11-28T12:00:00.000Z') + offsetMs).toISOString(),
  nowMs: () => Date.parse('2026-11-28T12:00:00.000Z'),
} as unknown as LiveWorld['clock'];

async function connectionsOf(world: LiveWorld): Promise<string> {
  const issuer = createTestIssuer({ issuer: STAND_ISSUER, audience: STAND_AUDIENCE });
  const api = createStandApi([world], {
    authenticator: createAuthenticator({ issuer: STAND_ISSUER, audience: STAND_AUDIENCE, jwks: staticJwks(issuer.jwks), directory: memoryStandDirectory([world]) }),
    simulator: { token: (a) => issuer.token(a.subject, { email: a.email }), expiresInSeconds: 900 },
  }, { defaultLocale: 'en', market: 'us', connect: (worldId) => (worldId === EMPTY_WORLD_ID ? emptyWorldConnect : null) });
  const token = await api({ method: 'POST', url: '/api/stand-issuer/token?locale=en', body: { role: 'OWNER' } });
  const r = await api({ method: 'GET', url: `/api/worlds/${encodeURIComponent(world.id)}/connections?locale=en`,
    authorization: `Bearer ${(token.body as { accessToken: string }).accessToken}`, body: null });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return JSON.stringify(r.body);
}

test('step 186 (Merdan 28.11, §1): a demo workspace in the client view offers Amazon US only — the step 176 rule on a stand that shows every channel', async () => {
  const body = await connectionsOf({ ...emptyWorld(clock), clientView: true } as LiveWorld);
  const other = OTHER_CHANNELS.exec(body);
  assert.equal(other ? `«${other[0]}» in …${body.slice(Math.max(0, other.index - 80), other.index + 40)}…` : null, null, 'no other channel is offered or named');
  assert.match(body, /AMAZON/, 'Amazon is offered');
  assert.match(body, /ATVPDKIKX0DER/, 'amazon.com is offered');
});

test('step 186 (control): the same workspace without the client view offers every channel of the us profile', async () => {
  const body = await connectionsOf(emptyWorld(clock));
  assert.match(body, /EBAY/, 'eBay is offered');
  assert.match(body, /WALMART/, 'Walmart is named');
});
