import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConsoleConfig, CONSOLE_ROLES, slowRequestMsOf } from '../server/config.ts';

/**
 * Р-180 (шаг 44): промышленный профиль консоли поднимается ТОЛЬКО с настоящим поставщиком identity — отказ при старте
 * своей причиной, а не 500 при первом входе. Данные синтетические.
 */

const files: Record<string, string> = Object.fromEntries(CONSOLE_ROLES.map((r) => [`/s/${r}`, `postgres://svc_${r}@db.invalid/repracer`]));
const read = (p: string) => {
  const v = files[p];
  if (v === undefined) throw new Error('ENOENT');
  return v;
};
const base = {
  REPRACER_CONSOLE_DIST: '/app/dist', REPRACER_CONSOLE_HEARTBEAT: 'off', REPRACER_CONSOLE_PUBLIC_DEMO: 'on', REPRACER_CONSOLE_GUEST_KEY: 'ephemeral',
  ...Object.fromEntries(CONSOLE_ROLES.map((r) => [`REPRACER_CONSOLE_${r.toUpperCase()}_PG_URL_FILE`, `/s/${r}`])),
};
const zitadel = {
  REPRACER_CONSOLE_OIDC_ISSUER: 'https://pilot.zitadel.example.invalid', REPRACER_CONSOLE_OIDC_AUDIENCE: '000000000000000001',
  REPRACER_CONSOLE_OIDC_JWKS_URL: 'https://pilot.zitadel.example.invalid/oauth/v2/keys', REPRACER_CONSOLE_OIDC_CLIENT_ID: '000000000000000002@repracer',
};

test('Р-180: промышленный профиль без поставщика identity не поднимается — только гость демо в работе не годится', () => {
  assert.equal(loadConsoleConfig(base, read).profile, 'default', 'вне промышленного профиля гость демо — законный единственный вход');
  assert.throws(() => loadConsoleConfig({ ...base, REPRACER_PROFILE: 'production' }, read), /CONFIG_MISSING: REPRACER_CONSOLE_OIDC_\* .*Р-180/);
  const ok = loadConsoleConfig({ ...base, ...zitadel, REPRACER_PROFILE: 'production' }, read);
  assert.deepEqual([ok.profile, ok.oidc?.clientId, ok.oidc?.scope], ['production', '000000000000000002@repracer', 'openid email profile']);
});

test('Р-180: имитатор стенда и локальный издатель — не поставщик; режим стенда в промышленном профиле запрещён', () => {
  for (const issuer of ['https://identity.stand.repracer.test', 'https://localhost:8443', 'https://127.0.0.1:9000']) {
    assert.throws(() => loadConsoleConfig({ ...base, ...zitadel, REPRACER_CONSOLE_OIDC_ISSUER: issuer, REPRACER_PROFILE: 'production' }, read),
      /имитатор или локальный адрес/, `издатель ${issuer} отклонён`);
  }
  assert.throws(() => loadConsoleConfig({ ...base, ...zitadel, REPRACER_PROFILE: 'production', REPRACER_MODE: 'stand' }, read), /REPRACER_MODE=stand в промышленном профиле/);
  // Вход настраивается целиком: без идентификатора клиента страница не знает, от чьего имени входить
  const { REPRACER_CONSOLE_OIDC_CLIENT_ID: _c, ...noClient } = zitadel;
  assert.throws(() => loadConsoleConfig({ ...base, ...noClient }, read), /CONFIG_MISSING: REPRACER_CONSOLE_OIDC_CLIENT_ID/);
});

test('шаг 54: больше одной реплики консоли — отказ при старте: нужен общий счётчик частоты', () => {
  assert.equal(loadConsoleConfig({ ...base, REPRACER_CONSOLE_REPLICAS: '1' }, read).profile, 'default', 'одна реплика — законно');
  assert.throws(() => loadConsoleConfig({ ...base, REPRACER_CONSOLE_REPLICAS: '2' }, read), /REPRACER_CONSOLE_REPLICAS=2 — нужен общий счётчик частоты/);
});

test('шаг 87 [Р-214]: профиль рынка развёртывания — по умолчанию us и английский; неверное значение и немецкий в us — отказ при старте', () => {
  const us = loadConsoleConfig(base, read);
  assert.deepEqual([us.market, us.locale], ['us', 'en'], 'не задан — профиль us, язык профиля');
  const eu = loadConsoleConfig({ ...base, REPRACER_MARKET_PROFILE: 'eu' }, read);
  assert.deepEqual([eu.market, eu.locale], ['eu', 'de'], 'Европа открывается одним значением — с прежним языком по умолчанию');
  assert.equal(loadConsoleConfig({ ...base, REPRACER_MARKET_PROFILE: 'global', REPRACER_CONSOLE_LOCALE: 'en' }, read).locale, 'en');
  assert.throws(() => loadConsoleConfig({ ...base, REPRACER_MARKET_PROFILE: 'europe' }, read), /CONFIG_INVALID: REPRACER_MARKET_PROFILE must be one of us, eu, global, got europe/);
  assert.throws(() => loadConsoleConfig({ ...base, REPRACER_CONSOLE_LOCALE: 'de' }, read), /CONFIG_INVALID: REPRACER_CONSOLE_LOCALE=de is not a language of the market profile us/);
});

/**
 * Шаг 176 [Р-256]: каталог каналов клиентского тенанта — свойство развёртывания. В профиле us по умолчанию клиент видит только amazon.com:
 * забытая переменная не открывает ему других каналов; eu и global — все витрины профиля. amazon.com в профиле eu нет — противоречие, отказ
 */
test('step 176 [Р-256]: client channels — amazon_us by default in the us profile, all in eu and global; a crooked value or amazon_us in eu refuses to start', () => {
  assert.equal(loadConsoleConfig(base, read).clientChannels, 'AMAZON_US', 'us by default: Amazon US only for clients');
  assert.equal(loadConsoleConfig({ ...base, REPRACER_MARKET_PROFILE: 'eu' }, read).clientChannels, 'ALL');
  assert.equal(loadConsoleConfig({ ...base, REPRACER_MARKET_PROFILE: 'global', REPRACER_CONSOLE_LOCALE: 'en' }, read).clientChannels, 'ALL');
  assert.equal(loadConsoleConfig({ ...base, REPRACER_CLIENT_CHANNELS: 'all' }, read).clientChannels, 'ALL', 'explicitly all — the frozen integrations');
  assert.equal(loadConsoleConfig({ ...base, REPRACER_MARKET_PROFILE: 'global', REPRACER_CONSOLE_LOCALE: 'en', REPRACER_CLIENT_CHANNELS: 'amazon_us' }, read).clientChannels, 'AMAZON_US');
  assert.throws(() => loadConsoleConfig({ ...base, REPRACER_CLIENT_CHANNELS: 'amazon' }, read), /CONFIG_INVALID: REPRACER_CLIENT_CHANNELS must be amazon_us or all, got amazon/);
  assert.throws(() => loadConsoleConfig({ ...base, REPRACER_MARKET_PROFILE: 'eu', REPRACER_CLIENT_CHANNELS: 'amazon_us' }, read), /CONFIG_INVALID: REPRACER_CLIENT_CHANNELS=amazon_us needs a market profile with amazon\.com/);
});

test('step 164: the slow request threshold — 2 s by default, off only explicitly, a crooked value refuses to start', () => {
  assert.equal(slowRequestMsOf(undefined), 2000);
  assert.equal(slowRequestMsOf(''), 2000);
  assert.equal(slowRequestMsOf('off'), null);
  assert.equal(slowRequestMsOf('500'), 500);
  for (const bad of ['2s', '50', '0', '-1', '1.5', '700000']) assert.throws(() => slowRequestMsOf(bad), /REPRACER_SLOW_REQUEST_MS/, bad);
});
