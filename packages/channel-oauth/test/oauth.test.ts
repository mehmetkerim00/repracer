import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  amazonLwa, classifyTokenError, ebayOAuth, ephemeralKeyring, exchangeCode, loadKeyring, newState, openToken,
  redactSecrets, refreshAccess, sealToken, stateDigest,
} from '../src/index.ts';
import { ModelOAuthProvider } from '../src/model.ts';

/**
 * Р-175…Р-177 (шаг 43): OAuth каналов на модели поставщика. Проверяется поведение: адрес согласия собран по снимку,
 * код одноразовый и живёт пять минут, отзыв продавцом становится классом REVOKED, сломанные ключи приложения — PLATFORM,
 * а шифротекст не открывается чужим аккаунтом. Данные синтетические.
 */

const REDIRECT = 'https://console.example.invalid/connect/callback';
const clock = { ms: Date.parse('2026-09-26T10:00:00Z') };
const now = () => clock.ms;

const amazonModel = () => new ModelOAuthProvider({ channel: 'AMAZON', clientId: 'amzn1.application-oa2-client.synthetic', clientSecret: 'synthetic-secret', redirectUri: REDIRECT, now });
const amazon = (draft = true) => amazonLwa({ applicationId: 'amzn1.sellerapps.app.synthetic', clientId: 'amzn1.application-oa2-client.synthetic', clientSecret: 'synthetic-secret', redirectUri: REDIRECT, draft });

test('Р-175: адрес согласия Amazon — Seller Central витрины, application_id, state и version=beta для черновика', () => {
  const de = new URL(amazon(true).consentUrl({ state: 's1', marketplaces: ['A1PA6795UKMFR9'] }));
  assert.equal(de.origin, 'https://sellercentral-europe.amazon.com', 'Германия — европейский Seller Central (seller-central-urls)');
  assert.equal(de.pathname, '/apps/authorize/consent');
  assert.equal(de.searchParams.get('application_id'), 'amzn1.sellerapps.app.synthetic');
  assert.equal(de.searchParams.get('state'), 's1');
  assert.equal(de.searchParams.get('version'), 'beta', 'приложение в состоянии Draft согласуется с version=beta');
  const us = new URL(amazon(false).consentUrl({ state: 's2', marketplaces: ['ATVPDKIKX0DER'] }));
  assert.equal(us.origin, 'https://sellercentral.amazon.com');
  assert.equal(us.searchParams.get('version'), null, 'опубликованное приложение — без version=beta');
  assert.throws(() => amazon().consentUrl({ state: 's', marketplaces: ['A1PA6795UKMFR9', 'ATVPDKIKX0DER'] }), /MARKETPLACES_UNSUPPORTED/,
    'витрины двух регионов одним согласием не авторизовать');
  assert.throws(() => amazon().consentUrl({ state: 's', marketplaces: ['UNKNOWN'] }), /MARKETPLACES_UNSUPPORTED/);
});

test('Р-175: поток Amazon на модели — согласие, обмен кода, refresh; код одноразовый', async () => {
  const model = amazonModel();
  const { state } = newState();
  const back = new URL(model.approve(amazon().consentUrl({ state, marketplaces: ['A1PA6795UKMFR9'] }), 'A3SYNTHSELLER'));
  const cb = amazon().parseCallback(Object.fromEntries(back.searchParams));
  assert.equal(cb.kind, 'CODE');
  assert.ok(cb.kind === 'CODE');
  assert.equal(cb.state, state, 'state вернулся тот же — его сверит база по отпечатку');
  assert.equal(cb.sellerId, 'A3SYNTHSELLER', 'selling_partner_id приходит с кодом');
  const tokens = await exchangeCode(amazon(), cb.code, model.fetch);
  assert.ok(tokens.ok && tokens.refreshToken?.startsWith('Atzr|'), 'refresh-токен получен');
  const again = await exchangeCode(amazon(), cb.code, model.fetch);
  assert.deepEqual(again.ok ? 'ok' : [again.failure, again.code], ['REVOKED', 'invalid_grant'], 'второй обмен того же кода — отказ');
  assert.ok(tokens.ok);
  const fresh = await refreshAccess(amazon(), tokens.refreshToken!, model.fetch);
  assert.ok(fresh.ok && fresh.accessToken.startsWith('Atza|'), 'refresh даёт новый access-токен');
});

test('Р-175: код согласия живёт пять минут (website-authorization-workflow)', async () => {
  const model = amazonModel();
  const back = new URL(model.approve(amazon().consentUrl({ state: 'late', marketplaces: ['A1PA6795UKMFR9'] }), 'A3LATE'));
  clock.ms += 5 * 60_000 + 1000;
  const r = await exchangeCode(amazon(), back.searchParams.get('spapi_oauth_code')!, model.fetch);
  assert.deepEqual(r.ok ? 'ok' : r.code, 'invalid_grant', 'код старше пяти минут не меняется на токены');
});

test('Р-177: отзыв продавцом — класс REVOKED; сломанные ключи приложения — PLATFORM, а не «продавец отозвал»', async () => {
  const model = amazonModel();
  const back = new URL(model.approve(amazon().consentUrl({ state: 'r', marketplaces: ['A1PA6795UKMFR9'] }), 'A3REVOKER'));
  const tokens = await exchangeCode(amazon(), back.searchParams.get('spapi_oauth_code')!, model.fetch);
  assert.ok(tokens.ok);
  model.breakPlatformCredentials();
  const platform = await refreshAccess(amazon(), tokens.refreshToken!, model.fetch);
  assert.deepEqual(platform.ok ? 'ok' : platform.failure, 'PLATFORM', 'наши ключи сломаны — это не отзыв продавцом');
  model.breakPlatformCredentials(false);
  model.revoke('A3REVOKER');
  const revoked = await refreshAccess(amazon(), tokens.refreshToken!, model.fetch);
  assert.deepEqual(revoked.ok ? 'ok' : [revoked.failure, revoked.code], ['REVOKED', 'invalid_grant']);
  const network = await refreshAccess(amazon(), tokens.refreshToken!, async () => { throw new Error('ECONNRESET'); });
  assert.deepEqual(network.ok ? 'ok' : [network.failure, network.code], ['TRANSIENT', 'NETWORK'], 'сеть — не отзыв');
  assert.equal(classifyTokenError(400, 'something_new'), 'TRANSIENT', 'непонятный отказ — не отзыв: остановить продавцу канал из-за нашей неосведомлённости нельзя');
});

test('Р-175: поток eBay по официальному клиенту — Basic, scope, redirect_uri; готов к песочнице', async () => {
  const cfg = { environment: 'SANDBOX' as const, clientId: 'Synthetic-App-SBX', clientSecret: 'SBX-secret', redirectUri: REDIRECT, scopes: ['https://api.ebay.com/oauth/api_scope/sell.inventory'] };
  const consent = new URL(ebayOAuth(cfg).consentUrl({ state: 'e1', marketplaces: ['EBAY_DE'] }));
  assert.equal(consent.origin + consent.pathname, 'https://auth.sandbox.ebay.com/oauth2/authorize', 'песочница — auth.sandbox.ebay.com (src/constants.js)');
  assert.equal(consent.searchParams.get('response_type'), 'code');
  assert.equal(consent.searchParams.get('scope'), 'https://api.ebay.com/oauth/api_scope/sell.inventory');
  const req = ebayOAuth(cfg).tokenRequest({ kind: 'CODE', code: 'c' });
  assert.equal(req.url, 'https://api.sandbox.ebay.com/identity/v1/oauth2/token');
  assert.equal(req.headers.authorization, `Basic ${Buffer.from('Synthetic-App-SBX:SBX-secret').toString('base64')}`);
  assert.ok(!req.body.includes('SBX-secret'), 'секрет приложения eBay идёт заголовком, а не телом');
  assert.throws(() => ebayOAuth({ ...cfg, scopes: [] }), /EBAY_SCOPES_REQUIRED/, 'без scope eBay согласия не спросит (E-08)');

  const model = new ModelOAuthProvider({ channel: 'EBAY', clientId: cfg.clientId, clientSecret: cfg.clientSecret, redirectUri: REDIRECT, now });
  const provider = ebayOAuth({ ...cfg, endpoints: { authorize: 'https://auth.sandbox.ebay.com/oauth2/authorize', token: 'model://token' } });
  const back = new URL(model.approve(provider.consentUrl({ state: 'e2', marketplaces: [] }), 'ebay-seller'));
  const cb = provider.parseCallback(Object.fromEntries(back.searchParams));
  assert.ok(cb.kind === 'CODE');
  const tokens = await exchangeCode(provider, cb.code, model.fetch);
  assert.ok(tokens.ok && tokens.refreshToken?.startsWith('v^1.1#'), 'refresh-токен eBay получен');
  model.revoke('ebay-seller');
  const revoked = await refreshAccess(provider, tokens.refreshToken!, model.fetch);
  assert.deepEqual(revoked.ok ? 'ok' : revoked.failure, 'REVOKED');
  const denied = provider.parseCallback(Object.fromEntries(new URL(model.deny(provider.consentUrl({ state: 'e3', marketplaces: [] }))).searchParams));
  assert.deepEqual(denied, { kind: 'DENIED', state: 'e3', error: 'access_denied' }, 'отказ продавца на странице согласия назван');
});

test('Р-177: шифротекст не открывается чужим аккаунтом, другим ключом и после подмены', () => {
  const keyring = ephemeralKeyring('k1');
  const owner = { tenantId: 't1', channelAccountId: 'a1' };
  const sealed = sealToken(keyring, 'Atzr|synthetic-refresh', owner);
  assert.equal(openToken(keyring, sealed, owner), 'Atzr|synthetic-refresh');
  assert.ok(!sealed.ciphertext.toString('utf8').includes('Atzr'), 'в шифротексте нет открытого текста');
  assert.throws(() => openToken(keyring, sealed, { tenantId: 't1', channelAccountId: 'a2' }), /TAMPERED_OR_WRONG_ACCOUNT/,
    'токен одного аккаунта, переложенный в строку другого, не открывается (AAD)');
  const tampered = { ...sealed, ciphertext: Buffer.from(sealed.ciphertext.map((b, i) => (i === 0 ? b ^ 1 : b))) };
  assert.throws(() => openToken(keyring, tampered, owner), /TAMPERED/, 'подменённый шифротекст не открывается (метка GCM)');
  assert.throws(() => openToken(ephemeralKeyring('k1'), sealed, owner), /TAMPERED/, 'другой ключ с тем же именем — отказ');
  const rotated = loadKeyring(JSON.stringify({ current: 'k2', keys: { k1: keyring.keys.get('k1')!.toString('base64'), k2: Buffer.alloc(32, 7).toString('base64') } }));
  assert.equal(openToken(rotated, sealed, owner), 'Atzr|synthetic-refresh', 'после смены ключа старые токены открываются своим key_id');
  assert.equal(sealToken(rotated, 'x', owner).keyId, 'k2', 'новые шифруются текущим ключом');
  assert.throws(() => loadKeyring('{"current":"k1","keys":{"k1":"c2hvcnQ="}}'), /KEY_LENGTH/);
  assert.throws(() => loadKeyring('not json'), (e: Error) => e.message === 'CREDENTIALS_KEYRING_UNREADABLE', 'ошибка не повторяет содержимое файла');
});

test('Р-177: state — случайный, в базу уходит только отпечаток', () => {
  const a = newState();
  const b = newState();
  assert.notEqual(a.state, b.state);
  assert.equal(a.stateSha256.length, 32);
  assert.deepEqual(stateDigest(a.state), a.stateSha256);
});

test('Р-177: маскирование журналов знает формы токенов и параметров', () => {
  const line = 'GET /connect/callback?state=x&spapi_oauth_code=ANCODE123&selling_partner_id=A3 token Atzr|syn-IQEBLzAtAhexample and v^1.1#i^1#r#abc';
  const out = redactSecrets(line);
  assert.ok(!out.includes('ANCODE123') && !out.includes('syn-IQEBLzAtAhexample') && !out.includes('#abc'), out);
  assert.ok(out.includes('selling_partner_id=A3'), 'идентификатор продавца не секрет и остаётся');
});

test('Р-177: проверка авторизаций — отзыв, поломка приложения и чужой ключ записываются своими исходами, токен наружу не уходит', async () => {
  const model = amazonModel();
  const keyring = ephemeralKeyring('k-check');
  const issue = async (seller: string) => {
    const back = new URL(model.approve(amazon().consentUrl({ state: seller, marketplaces: ['A1PA6795UKMFR9'] }), seller));
    const t = await exchangeCode(amazon(), back.searchParams.get('spapi_oauth_code')!, model.fetch);
    assert.ok(t.ok);
    return t.refreshToken!;
  };
  const rows = await Promise.all(['A3OK', 'A3GONE'].map(async (seller, i) => ({
    tenantId: 't1', channelAccountId: `a${i}`, channel: 'AMAZON', region: 'EU', credentialId: `c${i}`,
    sealed: sealToken(keyring, await issue(seller), { tenantId: 't1', channelAccountId: `a${i}` }),
  })));
  // Третья строка зашифрована ЧУЖИМ ключом: это наша поломка, а не отзыв продавцом
  rows.push({ ...rows[0]!, channelAccountId: 'a2', credentialId: 'c2', sealed: sealToken(ephemeralKeyring('k-check'), 'Atzr|syn-other', { tenantId: 't1', channelAccountId: 'a2' }) });
  model.revoke('A3GONE');
  const recorded: Array<[string, string, string | null]> = [];
  const logs: string[] = [];
  const { createAuthorizationChecker } = await import('../src/index.ts');
  const checker = createAuthorizationChecker({
    vault: { due: async () => rows, purgeSuperseded: async () => 0, recordCheck: async (_t, id, outcome, code) => { recorded.push([id, outcome, code]); return outcome; } },
    keyring, provider: () => amazon(), http: model.fetch, olderThanSeconds: 0, limit: 10, log: (e, f) => logs.push(JSON.stringify({ e, ...f })),
  });
  const out = await checker.check();
  // Отзыв записывается после прохода: сперва видно, не отказывают ли всем сразу (находка 7 ревью шага 43)
  assert.deepEqual(recorded, [['c0', 'OK', null], ['c2', 'PLATFORM', 'KEYRING'], ['c1', 'REVOKED', 'invalid_grant']]);
  assert.deepEqual([out.checked, out.ok, out.revoked, out.platform, out.keyringFailures], [3, 1, 1, 0, 1], 'чужой ключ — своя причина, не «ключи приложения»');
  const leaked = model.issuedTokens.filter((t) => logs.join('\n').includes(t) || JSON.stringify(out).includes(t));
  assert.deepEqual(leaked, [], 'токен не попадает ни в журнал, ни в итог проверки');
});

test('Р-177, находка 7 ревью шага 43: массовый invalid_grant — не отзыв продавцами, а подозрение на нашу поломку', async () => {
  const model = amazonModel();
  const keyring = ephemeralKeyring('k-mass');
  const rows: Array<{ tenantId: string; channelAccountId: string; channel: string; region: string; credentialId: string; sealed: ReturnType<typeof sealToken> }> = [];
  for (const seller of ['A3M1', 'A3M2', 'A3M3', 'A3M4']) {
    const back = new URL(model.approve(amazon().consentUrl({ state: seller, marketplaces: ['A1PA6795UKMFR9'] }), seller));
    const t = await exchangeCode(amazon(), back.searchParams.get('spapi_oauth_code')!, model.fetch);
    assert.ok(t.ok);
    rows.push({ tenantId: 't1', channelAccountId: seller, channel: 'AMAZON', region: 'EU', credentialId: seller, sealed: sealToken(keyring, t.refreshToken!, { tenantId: 't1', channelAccountId: seller }) });
    model.revoke(seller);
  }
  const recorded: string[] = [];
  const { createAuthorizationChecker } = await import('../src/index.ts');
  const out = await createAuthorizationChecker({
    vault: { due: async () => rows, purgeSuperseded: async () => 0, recordCheck: async (_t, id, outcome, code) => { recorded.push(`${id}:${outcome}:${code}`); return outcome; } },
    keyring, provider: () => amazon(), http: model.fetch, olderThanSeconds: 0, limit: 10,
  }).check();
  assert.deepEqual([out.revoked, out.suspiciousRevocations], [0, 4], 'четыре отзыва из четырёх за проход — не отзыв');
  assert.ok(recorded.every((r) => r.endsWith(':TRANSIENT:SUSPICIOUS_MASS_INVALID_GRANT')), recorded.join(' '));
});

test('шаг 39, E-11 [песочница]: продавца eBay называет Commerce Identity API; сбой — «не знаем», а не чужой', async () => {
  const { ebayOAuth, EBAY_IDENTITY_URL } = await import('../src/providers.ts');
  const provider = ebayOAuth({ environment: 'SANDBOX', clientId: 'Syn-App-SBX', clientSecret: 'syn-secret', redirectUri: 'Syn-RuName', scopes: ['https://api.ebay.com/oauth/api_scope'] });
  const calls: string[] = [];
  const answer = (status: number, body: string) => async (url: string, init: { method: string; headers: Record<string, string> }) => {
    calls.push(`${init.method} ${url} ${init.headers.authorization}`);
    return { status, text: async () => body };
  };
  assert.equal(await provider.identifySeller!('syn-access', answer(200, '{"userId":"syn-ebay-user-1","username":"syn_seller"}')), 'syn-ebay-user-1');
  assert.deepEqual(calls, [`GET ${EBAY_IDENTITY_URL.SANDBOX} Bearer syn-access`], 'хост apiz., токен продавца');
  assert.equal(await provider.identifySeller!('syn-access', answer(404, '{"errors":[]}')), null);
  assert.equal(await provider.identifySeller!('syn-access', answer(200, 'not json')), null);
  assert.equal(await provider.identifySeller!('syn-access', answer(200, '{"username":"no-id"}')), null);
});
