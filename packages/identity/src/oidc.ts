import { createPublicKey, verify as verifySignature, type JsonWebKey } from 'node:crypto';

/**
 * Проверка токена внешнего поставщика identity (Р-78, ADR-0013): подпись по JWKS поставщика, издатель, аудитория, сроки.
 * Вход, MFA, сброс пароля и приглашения — у поставщика; у нас только проверка токена и сопоставление с членствами.
 * Поддерживаются только асимметричные подписи RS256 (ключ ≥ 2048 бит) и ES256 (P-256); `none` и HMAC отклоняются.
 */

export type JwtAlgorithm = 'RS256' | 'ES256';

export interface Jwk extends JsonWebKey {
  kty: string;
  kid?: string;
  alg?: string;
  use?: string;
}

export interface JwksSource {
  keys(): Promise<readonly Jwk[]>;
  /** Перечитать ключи (ротация у поставщика); источник сам ограничивает частоту */
  refresh?(): Promise<readonly Jwk[]>;
}

export type TokenRejection =
  | 'MALFORMED' | 'ALGORITHM' | 'KEY_NOT_FOUND' | 'SIGNATURE' | 'ISSUER' | 'AUDIENCE' | 'EXPIRED' | 'NOT_YET_VALID' | 'ISSUED_IN_FUTURE' | 'SUBJECT';

export class TokenError extends Error {
  readonly reason: TokenRejection;
  constructor(reason: TokenRejection) {
    super(`token rejected: ${reason}`);
    this.reason = reason;
  }
}

export interface VerifiedToken {
  issuer: string;
  subject: string;
  audience: string[];
  expiresAt: number;
  /** Методы аутентификации (RFC 8176), например `pwd`, `otp`, `hwk` — по ним будет проверяться MFA для опасных действий (OQ-132) */
  amr: string[];
  email: string | null;
}

export interface VerifyOptions {
  issuer: string;
  audience: string;
  jwks: JwksSource;
  now?: () => number;
  leewaySeconds?: number;
  algorithms?: readonly JwtAlgorithm[];
}

const SEGMENT = /^[A-Za-z0-9_-]+$/;
const reject = (reason: TokenRejection): never => {
  throw new TokenError(reason);
};

function decodeJson(segment: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch {
    return reject('MALFORMED');
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : reject('MALFORMED');
}

export async function verifyToken(token: string, options: VerifyOptions): Promise<VerifiedToken> {
  const parts = typeof token === 'string' ? token.split('.') : [];
  if (parts.length !== 3 || !parts.every((p) => SEGMENT.test(p))) reject('MALFORMED');
  const header = decodeJson(parts[0]!);
  const claims = decodeJson(parts[1]!);
  const algorithms = options.algorithms ?? ['RS256', 'ES256'];
  const alg = header.alg;
  if (typeof alg !== 'string' || !(algorithms as readonly string[]).includes(alg)) reject('ALGORITHM');
  if (header.crit !== undefined) reject('MALFORMED');
  const kid = typeof header.kid === 'string' ? header.kid : undefined;

  const kty = alg === 'RS256' ? 'RSA' : 'EC';
  const matching = (keys: readonly Jwk[]) => keys.filter((k) =>
    k.kty === kty && (kid === undefined || k.kid === kid) && (k.use === undefined || k.use === 'sig') && (k.alg === undefined || k.alg === alg));
  let candidates = matching(await options.jwks.keys());
  if (candidates.length === 0 && options.jwks.refresh) candidates = matching(await options.jwks.refresh());
  // Без kid ключ должен быть однозначным: иначе подпись проверялась бы перебором ключей
  if (candidates.length === 0 || (kid === undefined && candidates.length > 1)) reject('KEY_NOT_FOUND');

  let key;
  try {
    key = createPublicKey({ key: candidates[0]!, format: 'jwk' });
  } catch {
    return reject('KEY_NOT_FOUND');
  }
  const details = key.asymmetricKeyDetails;
  if (alg === 'RS256' && (key.asymmetricKeyType !== 'rsa' || (details?.modulusLength ?? 0) < 2048)) reject('ALGORITHM');
  if (alg === 'ES256' && (key.asymmetricKeyType !== 'ec' || details?.namedCurve !== 'prime256v1')) reject('ALGORITHM');
  const data = Buffer.from(`${parts[0]}.${parts[1]}`);
  const signature = Buffer.from(parts[2]!, 'base64url');
  const valid = alg === 'RS256'
    ? verifySignature('sha256', data, key, signature)
    : verifySignature('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, signature);
  if (!valid) reject('SIGNATURE');

  const now = Math.floor((options.now ?? Date.now)() / 1000);
  const leeway = options.leewaySeconds ?? 60;
  if (claims.iss !== options.issuer) reject('ISSUER');
  const audience = typeof claims.aud === 'string' ? [claims.aud]
    : Array.isArray(claims.aud) && claims.aud.every((a) => typeof a === 'string') ? (claims.aud as string[]) : reject('AUDIENCE');
  if (!audience.includes(options.audience)) reject('AUDIENCE');
  if (typeof claims.exp !== 'number' || now > claims.exp + leeway) reject('EXPIRED');
  if (claims.nbf !== undefined && (typeof claims.nbf !== 'number' || now + leeway < claims.nbf)) reject('NOT_YET_VALID');
  if (claims.iat !== undefined && (typeof claims.iat !== 'number' || claims.iat > now + leeway)) reject('ISSUED_IN_FUTURE');
  if (typeof claims.sub !== 'string' || claims.sub.length === 0 || claims.sub.length > 255) reject('SUBJECT');
  return {
    issuer: claims.iss as string,
    subject: claims.sub as string,
    audience,
    expiresAt: claims.exp as number,
    amr: Array.isArray(claims.amr) ? claims.amr.filter((x): x is string => typeof x === 'string') : [],
    email: typeof claims.email === 'string' ? claims.email : null,
  };
}

export function staticJwks(keys: readonly Jwk[]): JwksSource {
  const copy = keys.map((k) => ({ ...k }));
  return { keys: async () => copy };
}

export interface RemoteJwksOptions {
  fetch?: typeof fetch;
  /** Ключи свежие столько секунд; потом — перечитывание */
  ttlSeconds?: number;
  /** Перечитывание при неизвестном kid и повторная попытка после сбоя — не чаще, чем раз в столько секунд */
  minRefreshSeconds?: number;
  /** Сбой поставщика: последние загруженные ключи служат столько секунд от загрузки; дальше — отказ (fail-closed) */
  maxStaleSeconds?: number;
  /** Тайм-аут одного запроса JWKS */
  timeoutMs?: number;
  /** Предел размера ответа */
  maxBytes?: number;
  now?: () => number;
}

/**
 * JWKS поставщика по адресу из его OIDC-конфигурации (находка 5 ревью шага 14):
 *  - одновременные запросы ждут одну загрузку, а не устраивают лавину к поставщику;
 *  - сбой или тайм-аут поставщика при недавних ключах — работа на них (до maxStaleSeconds), без ошибки входа;
 *  - неизвестный kid (ротация или подделка) перечитывает ключи не чаще minRefreshSeconds, даже после истечения кэша;
 *  - тайм-аут запроса и предел размера ответа.
 */
export function remoteJwks(url: string, options: RemoteJwksOptions = {}): JwksSource {
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const ttl = (options.ttlSeconds ?? 600) * 1000;
  const minRefresh = (options.minRefreshSeconds ?? 30) * 1000;
  const maxStale = (options.maxStaleSeconds ?? 86_400) * 1000;
  const timeoutMs = options.timeoutMs ?? 3000;
  const maxBytes = options.maxBytes ?? 256 * 1024;
  let cached: { keys: readonly Jwk[]; at: number } | null = null;
  let inFlight: Promise<readonly Jwk[]> | null = null;
  let lastAttempt = Number.NEGATIVE_INFINITY;

  const usable = () => (cached && now() - cached.at < maxStale ? cached.keys : null);

  async function fetchKeys(): Promise<readonly Jwk[]> {
    const response = await doFetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`JWKS ${url} answered ${response.status}`);
    if (Number(response.headers.get('content-length') ?? 0) > maxBytes) throw new Error(`JWKS ${url} is larger than ${maxBytes} bytes`);
    const text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) throw new Error(`JWKS ${url} is larger than ${maxBytes} bytes`);
    const body = JSON.parse(text) as { keys?: unknown };
    if (!Array.isArray(body.keys) || body.keys.length === 0) throw new Error(`JWKS ${url} has no keys`);
    return body.keys as Jwk[];
  }

  function load(): Promise<readonly Jwk[]> {
    if (inFlight) return inFlight;
    lastAttempt = now();
    inFlight = fetchKeys().then(
      (keys) => {
        cached = { keys, at: now() };
        return keys;
      },
      (error: unknown) => {
        const stale = usable();
        if (stale) return stale;
        throw error;
      },
    ).finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  return {
    async keys() {
      if (cached && now() - cached.at < ttl) return cached.keys;
      // Недавняя попытка не удалась: не долбим поставщика на каждый запрос, пока есть пригодные ключи
      const stale = usable();
      if (stale && now() - lastAttempt < minRefresh) return stale;
      return load();
    },
    async refresh() {
      if (inFlight) return inFlight;
      // Поток токенов с чужим kid не превращается в поток запросов к поставщику: вне окна — прежние ключи (kid не найдётся — 401)
      if (now() - lastAttempt < minRefresh) return usable() ?? [];
      return load();
    },
  };
}
