import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import type { Jwk } from './oidc.ts';

/**
 * Локальный имитатор поставщика identity — только для стенда и тестов, как имитаторы каналов. В работе токены выпускает
 * внешний поставщик (ADR-0013); этот модуль не подключается к серверу, если стенд не запущен явно в режиме имитатора.
 */
export function createTestIssuer(options: { issuer: string; audience: string; now?: () => number }) {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const kid = randomUUID();
  const jwk = { ...(publicKey.export({ format: 'jwk' }) as Jwk), kid, alg: 'ES256', use: 'sig' };
  const now = options.now ?? Date.now;
  const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  return {
    issuer: options.issuer,
    audience: options.audience,
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
