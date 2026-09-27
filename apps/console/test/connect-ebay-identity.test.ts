import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ebayOAuth, ephemeralKeyring } from '@repracer/channel-oauth';
import { createChannelConnectService } from '../server/connect.ts';

/**
 * Находка 2 ревью шага 39: после обмена кода eBay продавца называет Commerce Identity API (E-11). Если назвать не удалось,
 * а у тенанта уже есть аккаунт eBay, второй аккаунт `pending-identity:` не создаётся — отказ IDENTITY_UNKNOWN. Хранилище —
 * подмена с теми же методами, что зовёт обратный вызов; данные синтетические.
 */
function world(identityStatus: number, hasEbay: boolean) {
  const completed: Array<{ externalAccountId: string | null }> = [];
  const failed: string[] = [];
  const store = {
    claim: async () => ({ status: 'CLAIMED', channel: 'EBAY' }),
    fail: async (_t: string, _d: string, _s: string, code: string) => { failed.push(code); },
    hasAccount: async () => hasEbay,
    complete: async (_t: string, c: { externalAccountId: string | null }) => {
      completed.push({ externalAccountId: c.externalAccountId });
      return { status: 'CONNECTED', channelAccountId: '00000000-0000-4000-8000-000000000039', reconnected: false };
    },
  };
  const provider = ebayOAuth({
    environment: 'SANDBOX', clientId: 'Syn-App-SBX', clientSecret: 'syn-secret', redirectUri: 'Syn-RuName', scopes: ['https://api.ebay.com/oauth/api_scope'],
    endpoints: { authorize: 'https://auth.ebay.invalid/authorize', token: 'https://api.ebay.invalid/token', identity: 'https://apiz.ebay.invalid/user' },
  });
  const http = async (url: string) => url.endsWith('/token')
    ? { status: 200, text: async () => JSON.stringify({ access_token: 'syn-access', expires_in: 7200, refresh_token: 'syn-refresh', refresh_token_expires_in: 47304000 }) }
    : { status: identityStatus, text: async () => (identityStatus === 200 ? '{"userId":"syn-ebay-user-39"}' : '{"errors":[]}') };
  const service = createChannelConnectService({
    store: store as never, keyring: ephemeralKeyring(), http: http as never,
    providers: [{ channel: 'EBAY', marketplaces: [{ id: 'EBAY_DE', region: null }], platformMissing: [], provider }],
  });
  return { service, completed, failed };
}
const actor = { membershipId: 'syn-m', userId: 'syn-u', mfa: true };
const params = { state: 'syn-state-0123456789abcdef', code: 'syn-code' };

test('E-11: продавец назван — аккаунт получает его userId', async () => {
  const w = world(200, true);
  const out = await w.service.callback('syn-tenant', params, actor);
  assert.equal(out.status, 'CONNECTED');
  assert.deepEqual(w.completed, [{ externalAccountId: 'syn-ebay-user-39' }]);
});

test('находка 2 ревью шага 39: продавец не назван и аккаунт eBay уже есть — отказ, второго аккаунта нет', async () => {
  const w = world(500, true);
  const out = await w.service.callback('syn-tenant', params, actor);
  assert.equal(out.status, 'IDENTITY_UNKNOWN');
  assert.deepEqual(w.completed, [], 'второй аккаунт pending-identity не создан');
  assert.deepEqual(w.failed, ['IDENTITY_UNKNOWN']);
});

test('шаг 43 сохраняется: продавец не назван, но аккаунта eBay ещё нет — первый аккаунт с временным идентификатором', async () => {
  const w = world(500, false);
  const out = await w.service.callback('syn-tenant', params, actor);
  assert.equal(out.status, 'CONNECTED');
  assert.deepEqual(w.completed, [{ externalAccountId: null }]);
});
