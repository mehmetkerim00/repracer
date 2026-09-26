import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigError } from '@repracer/service-runtime';
import { loadOperatorConfig } from '../server/config.ts';

/**
 * Р-165 (шаг 40): конфигурация панели оператора. Проверяется не «читается ли переменная», а то, при чём процесс
 * ОТКАЗЫВАЕТСЯ стартовать: панель без входа, панель с ключом стенда в работе и половина настроек почты — это
 * развёртывания, которые выглядят работающими и не работают.
 *
 * Данные синтетические.
 */

const BASE: Record<string, string> = {
  REPRACER_OPERATOR_PG_URL_FILE: '/run/secrets/operator_pg_url',
  REPRACER_OPERATOR_OIDC_ISSUER: 'https://identity.example.invalid',
  REPRACER_OPERATOR_OIDC_AUDIENCE: 'repracer-operator',
  REPRACER_OPERATOR_OIDC_JWKS_URL: 'https://identity.example.invalid/keys',
  REPRACER_OPERATOR_INVITATION_URL: 'https://app.example.invalid/invitation',
  REPRACER_OPERATOR_HEARTBEAT: 'off',
};
const read = (path: string): string => (path.endsWith('operator_pg_url') ? 'postgres://svc_operator:secret@db/repracer' : 'https://hc.example.invalid/ping/abc');

test('шаг 40: без поставщика входа панель не стартует — и отказ называет все три переменные', () => {
  const { REPRACER_OPERATOR_OIDC_ISSUER: _i, REPRACER_OPERATOR_OIDC_JWKS_URL: _j, ...withoutIdp } = BASE;
  assert.throws(() => loadOperatorConfig(withoutIdp, read),
    (e: Error) => e instanceof ConfigError
      && /REPRACER_OPERATOR_OIDC_ISSUER, REPRACER_OPERATOR_OIDC_JWKS_URL/.test(e.message)
      && /гостя и стендового входа в ней нет/.test(e.message));
});

test('шаг 40: ключ входа стенда в работе не принимается вовсе', () => {
  assert.throws(() => loadOperatorConfig({ ...BASE, REPRACER_OPERATOR_STAND_KEY: '-----BEGIN PRIVATE KEY-----' }, read),
    (e: Error) => e instanceof ConfigError && /only with REPRACER_MODE=stand/.test(e.message));
  // А в режиме стенда — принимается: именно им живой прогон поднимает ТОТ ЖЕ процесс [Р-136]
  const stand = loadOperatorConfig({ ...BASE, REPRACER_MODE: 'stand', REPRACER_OPERATOR_STAND_KEY: 'pem' }, read);
  assert.equal(stand.standIssuerKeyPem, 'pem');
});

test('шаг 40: секрет приходит файлом, значение переменной в работе отвергается [шаг 28, E]', () => {
  const { REPRACER_OPERATOR_PG_URL_FILE: _f, ...withValue } = BASE;
  assert.throws(() => loadOperatorConfig({ ...withValue, REPRACER_OPERATOR_PG_URL: 'postgres://svc_operator:secret@db/repracer' }, read),
    (e: Error) => e instanceof ConfigError && /CONFIG_SECRET_IN_ENV: REPRACER_OPERATOR_PG_URL/.test(e.message));
  const config = loadOperatorConfig(BASE, read);
  assert.match(config.pgUrl, /^postgres:\/\/svc_operator/, 'строка подключения прочитана из файла');
});

test('шаг 40: почта настраивается целиком; по умолчанию — сухой режим [OQ-224]', () => {
  assert.equal(loadOperatorConfig(BASE, read).mail, null, 'без переменных провайдера письмо собирается и не уходит');
  assert.throws(() => loadOperatorConfig({ ...BASE, REPRACER_MAIL_API_URL: 'https://mail.example.invalid/send' }, read),
    (e: Error) => e instanceof ConfigError && /REPRACER_MAIL_FROM \(почта настраивается целиком/.test(e.message));
  assert.throws(() => loadOperatorConfig({ ...BASE, REPRACER_MAIL_API_URL: 'http://mail.example.invalid/send', REPRACER_MAIL_FROM: 'no-reply@example.invalid', REPRACER_MAIL_API_KEY_FILE: '/run/secrets/mail' }, read),
    (e: Error) => e instanceof ConfigError && /REPRACER_MAIL_API_URL must be https/.test(e.message));
});

test('шаг 40: ссылка приглашения и отметка внешнего контроля — только https', () => {
  assert.throws(() => loadOperatorConfig({ ...BASE, REPRACER_OPERATOR_INVITATION_URL: 'http://app.example.invalid/invitation' }, read),
    (e: Error) => e instanceof ConfigError && /REPRACER_OPERATOR_INVITATION_URL must be https/.test(e.message));
  // Р-127: отметка выключается ЯВНО, молчаливого умолчания «без контроля» нет
  const { REPRACER_OPERATOR_HEARTBEAT: _h, ...watched } = BASE;
  assert.throws(() => loadOperatorConfig(watched, (path) => { if (path.includes('heartbeat')) throw new Error('no file'); return read(path); }),
    (e: Error) => e instanceof ConfigError && /REPRACER_OPERATOR_HEARTBEAT_URL/.test(e.message));
  const beating = loadOperatorConfig({ ...watched, REPRACER_OPERATOR_HEARTBEAT_URL_FILE: '/run/secrets/heartbeat' }, read);
  assert.equal(beating.heartbeatUrl, 'https://hc.example.invalid/ping/abc');
});
