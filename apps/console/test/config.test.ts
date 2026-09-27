import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConsoleConfig, CONSOLE_ROLES } from '../server/config.ts';

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
