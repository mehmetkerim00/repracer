import assert from 'node:assert/strict';
import { test } from 'node:test';
import { channelApps, loadChannelAppsConfig } from '../src/index.ts';

/**
 * Р-175…Р-177 (шаг 43): конфигурация приложений каналов. Приложение — целиком или никак, кольцо ключей обязательно при
 * любом настроенном канале, адрес возврата — только https. Секреты — файлами. Данные синтетические.
 */

const files: Record<string, string> = {
  '/s/amazon': 'syn-lwa-client-secret',
  '/s/ebay': 'syn-ebay-client-secret',
  '/s/keyring': JSON.stringify({ current: 'k1', keys: { k1: Buffer.alloc(32, 3).toString('base64') } }),
};
const read = (p: string) => {
  const v = files[p];
  if (v === undefined) throw new Error('ENOENT');
  return v;
};
const amazonEnv = {
  REPRACER_AMAZON_APP_ID: 'amzn1.sellerapps.app.syn', REPRACER_AMAZON_LWA_CLIENT_ID: 'amzn1.application-oa2-client.syn',
  REPRACER_AMAZON_LWA_CLIENT_SECRET_FILE: '/s/amazon', REPRACER_CHANNEL_KEYRING_FILE: '/s/keyring',
  REPRACER_CONNECT_REDIRECT_URL: 'https://console.example.invalid/connect/callback',
  REPRACER_AMAZON_APP_DRAFT: 'on',
};

test('Р-150: ничего не настроено — процесс стартует, оба канала «ожидают доступа платформы» с причиной', () => {
  const c = loadChannelAppsConfig({}, read);
  assert.deepEqual([c.amazon, c.ebay, c.keyring], [null, null, null]);
  assert.deepEqual(channelApps(c).map((a) => [a.channel, a.platformMissing, a.provider]), [
    ['AMAZON', ['AMAZON_APPLICATION'], null], ['EBAY', ['EBAY_DEVELOPER_KEYS'], null],
  ]);
});

test('Р-175: приложение Amazon целиком — канал подключаем, адрес согласия по витрине', () => {
  const [amazon] = channelApps(loadChannelAppsConfig(amazonEnv, read));
  assert.deepEqual(amazon!.platformMissing, []);
  const url = new URL(amazon!.provider!.consentUrl({ state: 's', marketplaces: ['A1PA6795UKMFR9'] }));
  assert.equal(url.origin, 'https://sellercentral-europe.amazon.com');
  assert.equal(url.searchParams.get('version'), 'beta', 'по умолчанию приложение — черновик');
});

test('Р-175, Р-177: половина настройки, приложение без кольца ключей и адрес возврата не https — отказ на старте', () => {
  assert.throws(() => loadChannelAppsConfig({ REPRACER_AMAZON_APP_ID: 'x' }, read), /CONFIG_MISSING: REPRACER_AMAZON_LWA_CLIENT_ID, REPRACER_AMAZON_LWA_CLIENT_SECRET_FILE/);
  const { REPRACER_CHANNEL_KEYRING_FILE: _k, ...noKeyring } = amazonEnv;
  assert.throws(() => loadChannelAppsConfig(noKeyring, read), /CONFIG_MISSING: REPRACER_CHANNEL_KEYRING_FILE/);
  assert.throws(() => loadChannelAppsConfig({ ...amazonEnv, REPRACER_CONNECT_REDIRECT_URL: 'http://console.example.invalid/connect/callback' }, read), /CONFIG_INVALID/);
  // Секрет значением переменной — только в режиме стенда [шаг 28, E]
  const { REPRACER_AMAZON_LWA_CLIENT_SECRET_FILE: _f, ...inEnv } = amazonEnv;
  assert.throws(() => loadChannelAppsConfig({ ...inEnv, REPRACER_AMAZON_LWA_CLIENT_SECRET: 'syn-in-env' }, read), /CONFIG_SECRET_IN_ENV/);
});

test('находка 14 ревью шага 43: состояние приложения Amazon и окружение eBay называются явно — умолчаний-ловушек нет', () => {
  const { REPRACER_AMAZON_APP_DRAFT: _d, ...noDraft } = amazonEnv;
  assert.throws(() => loadChannelAppsConfig(noDraft, read), /CONFIG_MISSING: REPRACER_AMAZON_APP_DRAFT=on\|off/);
  assert.equal(loadChannelAppsConfig({ ...amazonEnv, REPRACER_AMAZON_APP_DRAFT: 'off' }, read).amazon?.draft, false);
  assert.throws(() => loadChannelAppsConfig({ REPRACER_EBAY_CLIENT_ID: 'x', REPRACER_EBAY_RUNAME: 'y', REPRACER_EBAY_SCOPES: 'z', REPRACER_EBAY_CLIENT_SECRET_FILE: '/s/ebay', REPRACER_CHANNEL_KEYRING_FILE: '/s/keyring' }, read),
    /CONFIG_MISSING: REPRACER_EBAY_ENVIRONMENT/);
});

test('Р-175: eBay — песочница по явному значению, scope называет конфигурация (E-08)', () => {
  const c = loadChannelAppsConfig({
    REPRACER_EBAY_CLIENT_ID: 'Syn-App-SBX', REPRACER_EBAY_RUNAME: 'Syn-RuName', REPRACER_EBAY_SCOPES: 'https://api.ebay.com/oauth/api_scope/sell.inventory https://api.ebay.com/oauth/api_scope/sell.account https://api.ebay.com/oauth/api_scope/commerce.identity.readonly',
    REPRACER_EBAY_CLIENT_SECRET_FILE: '/s/ebay', REPRACER_CHANNEL_KEYRING_FILE: '/s/keyring', REPRACER_EBAY_ENVIRONMENT: 'SANDBOX', REPRACER_EBAY_ACCOUNT_DELETION: 'registered',
  }, read);
  assert.equal(c.ebay?.environment, 'SANDBOX');
  const ebay = channelApps(c)[1]!;
  assert.match(ebay.provider!.consentUrl({ state: 's', marketplaces: [] }), /^https:\/\/auth\.sandbox\.ebay\.com\/oauth2\/authorize\?/);
});

test('находка 2 ревью шага 39: без scope commerce.identity.readonly приложение eBay не настраивается — продавца не назвать (E-11)', () => {
  const env = {
    REPRACER_EBAY_CLIENT_ID: 'Syn-App-SBX', REPRACER_EBAY_RUNAME: 'Syn-RuName', REPRACER_EBAY_SCOPES: 'https://api.ebay.com/oauth/api_scope/sell.inventory',
    REPRACER_EBAY_CLIENT_SECRET_FILE: '/s/ebay', REPRACER_CHANNEL_KEYRING_FILE: '/s/keyring', REPRACER_EBAY_ENVIRONMENT: 'SANDBOX',
  };
  assert.throws(() => loadChannelAppsConfig(env, read), /CONFIG_INVALID: REPRACER_EBAY_SCOPES must include https:\/\/api\.ebay\.com\/oauth\/api_scope\/commerce\.identity\.readonly/);
});

test('шаг 47: модель поставщика eBay (REPRACER_EBAY_OAUTH_BASE) — только в режиме стенда; вне его — отказ при старте с причиной', () => {
  const ebayEnv = {
    REPRACER_EBAY_ENVIRONMENT: 'SANDBOX', REPRACER_EBAY_CLIENT_ID: 'Syn-App-SBX', REPRACER_EBAY_RUNAME: 'Syn-RuName', REPRACER_EBAY_CLIENT_SECRET_FILE: '/s/ebay',
    REPRACER_EBAY_SCOPES: 'https://api.ebay.com/oauth/api_scope https://api.ebay.com/oauth/api_scope/sell.account https://api.ebay.com/oauth/api_scope/commerce.identity.readonly', REPRACER_CHANNEL_KEYRING_FILE: '/s/keyring',
    REPRACER_EBAY_OAUTH_BASE: 'http://127.0.0.1:4711',
  };
  assert.throws(() => loadChannelAppsConfig(ebayEnv, read), /REPRACER_EBAY_OAUTH_BASE is accepted only with REPRACER_MODE=stand/);
  assert.throws(() => loadChannelAppsConfig({ ...ebayEnv, REPRACER_MODE: 'production' }, read), /only with REPRACER_MODE=stand/);
  const stand = loadChannelAppsConfig({ ...ebayEnv, REPRACER_MODE: 'stand' }, read);
  assert.deepEqual(stand.ebay!.endpoints, { authorize: 'http://127.0.0.1:4711/oauth2/authorize', token: 'http://127.0.0.1:4711/identity/v1/oauth2/token', identity: 'http://127.0.0.1:4711/commerce/identity/v1/user/' });
  const ebay = channelApps(stand).find((a) => a.channel === 'EBAY')!;
  assert.equal(new URL(ebay.provider!.consentUrl({ state: 's', marketplaces: ['EBAY_DE'] })).origin, 'http://127.0.0.1:4711', 'согласие — у модели');
  assert.equal(ebay.provider!.tokenRequest({ kind: 'CODE', code: 'c' }).url, 'http://127.0.0.1:4711/identity/v1/oauth2/token');
  // Контроль: без переменной — настоящие конечные точки песочницы и в режиме стенда
  const { REPRACER_EBAY_OAUTH_BASE: _omit, ...plain } = ebayEnv;
  const real = channelApps(loadChannelAppsConfig({ ...plain, REPRACER_MODE: 'stand' }, read)).find((a) => a.channel === 'EBAY')!;
  assert.equal(real.provider!.tokenRequest({ kind: 'CODE', code: 'c' }).url, 'https://api.sandbox.ebay.com/identity/v1/oauth2/token');
  assert.throws(() => loadChannelAppsConfig({ REPRACER_MODE: 'stand', REPRACER_EBAY_OAUTH_BASE: 'http://127.0.0.1:1' }, read), /без приложения eBay/);
});

/**
 * Шаг 49, находка 16 ревью: без scope sell.account платёжную политику листинга не прочитать — предполётная проверка C14 (Р-191) была бы
 * UNKNOWN у каждого листинга. Отказ — при старте процесса.
 */
test('review 49 #16: without the sell.account scope the eBay application is not configured — immediate payment could never be read (Р-191)', () => {
  const env = {
    REPRACER_EBAY_CLIENT_ID: 'Syn-App-SBX', REPRACER_EBAY_RUNAME: 'Syn-RuName', REPRACER_EBAY_SCOPES: 'https://api.ebay.com/oauth/api_scope/sell.inventory https://api.ebay.com/oauth/api_scope/commerce.identity.readonly',
    REPRACER_EBAY_CLIENT_SECRET_FILE: '/s/ebay', REPRACER_CHANNEL_KEYRING_FILE: '/s/keyring', REPRACER_EBAY_ENVIRONMENT: 'SANDBOX',
  };
  assert.throws(() => loadChannelAppsConfig(env, read), /CONFIG_INVALID: REPRACER_EBAY_SCOPES must include https:\/\/api\.ebay\.com\/oauth\/api_scope\/sell\.account/);
  assert.equal(loadChannelAppsConfig({ ...env, REPRACER_EBAY_SCOPES: `${env.REPRACER_EBAY_SCOPES} https://api.ebay.com/oauth/api_scope/sell.account` }, read).ebay?.scopes.length, 3);
});

/**
 * Шаг 49 [Р-192], находка 11 ревью: до регистрации приёмника уведомлений eBay Marketplace Account Deletion подключать продавцов eBay нельзя —
 * канал «ожидает доступа платформы» с названной причиной; поставщик остаётся, чтобы уже подключённые аккаунты проверялись.
 */
test('review 49 #11: eBay is not connectable until the account deletion endpoint is registered; the value is named exactly', () => {
  const env = {
    REPRACER_EBAY_CLIENT_ID: 'Syn-App-SBX', REPRACER_EBAY_RUNAME: 'Syn-RuName', REPRACER_EBAY_CLIENT_SECRET_FILE: '/s/ebay', REPRACER_CHANNEL_KEYRING_FILE: '/s/keyring', REPRACER_EBAY_ENVIRONMENT: 'SANDBOX',
    REPRACER_EBAY_SCOPES: 'https://api.ebay.com/oauth/api_scope/sell.inventory https://api.ebay.com/oauth/api_scope/sell.account https://api.ebay.com/oauth/api_scope/commerce.identity.readonly',
  };
  const without = channelApps(loadChannelAppsConfig(env, read)).find((a) => a.channel === 'EBAY')!;
  assert.deepEqual(without.platformMissing, ['EBAY_ACCOUNT_DELETION_ENDPOINT']);
  assert.ok(without.provider, 'the provider stays: already connected accounts keep being checked');
  const registered = channelApps(loadChannelAppsConfig({ ...env, REPRACER_EBAY_ACCOUNT_DELETION: 'registered' }, read)).find((a) => a.channel === 'EBAY')!;
  assert.deepEqual(registered.platformMissing, []);
  assert.throws(() => loadChannelAppsConfig({ ...env, REPRACER_EBAY_ACCOUNT_DELETION: 'yes' }, read), /CONFIG_INVALID: REPRACER_EBAY_ACCOUNT_DELETION=registered/);
});
