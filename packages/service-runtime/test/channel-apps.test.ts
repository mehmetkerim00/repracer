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
    REPRACER_EBAY_CLIENT_ID: 'Syn-App-SBX', REPRACER_EBAY_RUNAME: 'Syn-RuName', REPRACER_EBAY_SCOPES: 'https://api.ebay.com/oauth/api_scope/sell.inventory https://api.ebay.com/oauth/api_scope/commerce.identity.readonly',
    REPRACER_EBAY_CLIENT_SECRET_FILE: '/s/ebay', REPRACER_CHANNEL_KEYRING_FILE: '/s/keyring', REPRACER_EBAY_ENVIRONMENT: 'SANDBOX',
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
