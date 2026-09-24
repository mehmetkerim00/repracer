import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import { createLocalIssuer, IssuerKeyError } from '../src/test-issuer.ts';
import { createAuthenticator, MemoryIdentityDirectory, staticJwks } from '../src/index.ts';

/**
 * Шаг 38 (находка 1 ревью шага 37): ключ локального издателя приходит ИЗВНЕ. Пока он рождался в памяти процесса, две
 * реплики консоли за прокси подписывали гостевые токены разными ключами — гость получал 401 на каждом втором запросе и
 * видел это как «демо сломалось». Здесь это проверяется буквально: ДВА издателя с одним ключом.
 *
 * Данные синтетические, ключи генерируются в прогоне.
 */

const ISSUER = 'https://guest.repracer.invalid';
const AUDIENCE = 'repracer-console';
const pem = () => generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();

const directory = new MemoryIdentityDirectory();
directory.link({ issuer: ISSUER, subject: 'guest-1' }, 'u-1');
directory.addMembership('u-1', { tenantId: 't-demo', membershipId: 'm-1', role: 'VIEWER' });

test('шаг 38: два процесса с ОДНИМ ключом принимают токены друг друга', async () => {
  const key = pem();
  const first = createLocalIssuer({ issuer: ISSUER, audience: AUDIENCE, privateKeyPem: key });
  const second = createLocalIssuer({ issuer: ISSUER, audience: AUDIENCE, privateKeyPem: key });

  assert.equal(first.kid, second.kid, 'идентификатор ключа выводится из ключа, а не случайный: иначе проверка по kid разойдётся');

  // Токен выдан ПЕРВЫМ процессом, проверяет его ВТОРОЙ — ровно то, что происходит за прокси с двумя репликами
  const token = first.token('guest-1', { email: 'guest-1@demo.invalid', amr: [] });
  const authenticator = createAuthenticator({ issuer: ISSUER, audience: AUDIENCE, jwks: staticJwks(second.jwks), directory });
  const principal = await authenticator.authenticate(`Bearer ${token}`);
  assert.ok(principal, 'вторая реплика приняла токен первой');
  assert.equal(principal!.memberships[0]?.role, 'VIEWER', 'роль берётся из членства, как у продавца');
});

test('шаг 38: РАЗНЫЕ ключи не принимают токены друг друга — и это то, что ломало гостя', async () => {
  const first = createLocalIssuer({ issuer: ISSUER, audience: AUDIENCE, privateKeyPem: pem() });
  const second = createLocalIssuer({ issuer: ISSUER, audience: AUDIENCE, privateKeyPem: pem() });
  assert.notEqual(first.kid, second.kid);

  const authenticator = createAuthenticator({ issuer: ISSUER, audience: AUDIENCE, jwks: staticJwks(second.jwks), directory });
  assert.equal(await authenticator.authenticate(`Bearer ${first.token('guest-1')}`), null,
    'токен чужого ключа не принимается — положительный контроль к проверке выше [Р-94]');
});

test('шаг 38: ключ не того вида отвергается при старте, а не при первом госте', () => {
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  assert.throws(() => createLocalIssuer({ issuer: ISSUER, audience: AUDIENCE, privateKeyPem: rsa }),
    (e: Error) => e instanceof IssuerKeyError && /ISSUER_KEY_UNSUPPORTED/.test(e.message));
  // Содержимое ключа в сообщение не попадает: испорченный ключ не печатается целиком в журнал
  const broken = (() => {
    try {
      createLocalIssuer({ issuer: ISSUER, audience: AUDIENCE, privateKeyPem: '-----BEGIN PRIVATE KEY-----\nSEKRET\n-----END PRIVATE KEY-----' });
      return null;
    } catch (e) {
      return e as Error;
    }
  })();
  assert.match(broken?.message ?? '', /ISSUER_KEY_UNREADABLE/);
  assert.doesNotMatch(broken?.message ?? '', /SEKRET/, 'содержимое ключа в ошибку не попадает');
});
