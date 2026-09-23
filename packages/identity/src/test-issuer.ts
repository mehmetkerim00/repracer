import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import type { Jwk } from './oidc.ts';

/**
 * Локальный издатель токенов: подписываем МЫ, а не внешний поставщик (ADR-0013). Таких случаев ровно два, и оба
 * названы: имитатор поставщика на стенде и гостевой вход публичного демо [Р-160] — у гостя нет учётной записи, и
 * заводить её у поставщика ради «посмотреть демо» значит просить человека зарегистрироваться, чтобы посмотреть демо
 * без регистрации.
 *
 * Ключ приходит ИЗВНЕ (шаг 38, находка 1 ревью шага 37). Пока он рождался в памяти процесса, две реплики консоли за
 * прокси подписывали разными ключами: токен, выданный одной, вторая не проверяла — гость получал 401 на каждом втором
 * запросе и видел это как «демо сломалось». Идентификатор ключа (`kid`) выводится ИЗ САМОГО КЛЮЧА, а не случайный:
 * иначе один и тот же ключ у двух реплик давал бы разные `kid`, и проверка по `kid` снова расходилась бы.
 */
export interface LocalIssuerOptions {
  issuer: string;
  audience: string;
  /** Закрытый ключ ES256 (P-256) в PEM; без него генерируется временный — годится только для ОДНОГО экземпляра */
  privateKeyPem?: string;
  now?: () => number;
}

export class IssuerKeyError extends Error {}

function keysOf(pem: string | undefined): { privateKey: KeyObject; publicKey: KeyObject } {
  if (!pem) {
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    return { privateKey, publicKey };
  }
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(pem);
  } catch (error) {
    // Содержимое ключа в сообщение не попадает — только то, что с ним не так
    throw new IssuerKeyError(`ISSUER_KEY_UNREADABLE: ключ не разбирается как PEM (${(error as Error).name})`);
  }
  const jwk = privateKey.export({ format: 'jwk' }) as { kty?: string; crv?: string };
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256') {
    throw new IssuerKeyError(`ISSUER_KEY_UNSUPPORTED: нужен ключ EC P-256 (ES256), получен ${jwk.kty ?? '?'} ${jwk.crv ?? ''}`.trim());
  }
  return { privateKey, publicKey: createPublicKey(privateKey) };
}

export function createLocalIssuer(options: LocalIssuerOptions) {
  const { privateKey, publicKey } = keysOf(options.privateKeyPem);
  // `kid` — отпечаток открытого ключа: один ключ у двух процессов даёт один и тот же `kid`
  const kid = createHash('sha256').update(publicKey.export({ format: 'der', type: 'spki' })).digest('base64url').slice(0, 22);
  const jwk = { ...(publicKey.export({ format: 'jwk' }) as Jwk), kid, alg: 'ES256', use: 'sig' };
  const now = options.now ?? Date.now;
  const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  return {
    issuer: options.issuer,
    audience: options.audience,
    kid,
    jwks: [jwk] as Jwk[],
    token(subject: string, claims: { email?: string; amr?: string[]; expiresInSeconds?: number; extra?: Record<string, unknown> } = {}): string {
      const iat = Math.floor(now() / 1000);
      const header = encode({ alg: 'ES256', typ: 'JWT', kid });
      const payload = encode({
        iss: options.issuer, aud: options.audience, sub: subject, iat, exp: iat + (claims.expiresInSeconds ?? 900),
        ...(claims.email ? { email: claims.email } : {}), amr: claims.amr ?? ['pwd', 'otp'], ...claims.extra,
      });
      const signature = sign('sha256', Buffer.from(`${header}.${payload}`), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
      return `${header}.${payload}.${signature}`;
    },
  };
}

/** Имитатор поставщика identity — только для стенда и тестов, как имитаторы каналов: ключ временный и живёт в памяти */
export function createTestIssuer(options: { issuer: string; audience: string; now?: () => number }) {
  return createLocalIssuer(options);
}
