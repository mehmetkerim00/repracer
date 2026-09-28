import { createHash, createVerify } from 'node:crypto';

/**
 * Шаг 49 [Р-192]: проверка подлинности уведомления eBay Marketplace Account Deletion.
 *
 * Страница снимка (`vendor/ebay/2026-09-28/marketplace-user-account-deletion.html`) описывает проверку в три шага — base64
 * заголовка `x-ebay-signature`, открытый ключ по `keyId` из Notification API `getPublicKey`, проверка подписи — и отсылает за
 * деталями к Notification API, которой в снимке нет. Детали — из ОФИЦИАЛЬНОГО SDK eBay, закреплённого коммитом
 * (`vendor/ebay/event-notification-sdk/feaf3378…/lib/validator.js`, `constants.js`, `client.js`):
 *   * заголовок — base64 от JSON `{alg, kid, signature, digest}`;
 *   * ключ — `GET <api>/commerce/notification/v1/public_key/<kid>` токеном приложения, ответ `{key, algorithm, digest}`,
 *     `key` — PEM без переводов строк;
 *   * подпись — ECDSA с SHA-1 над `JSON.stringify(message)` разобранного тела, base64.
 * Тестовые векторы SDK (`test/test.json`) проходят этой проверкой: VALID — да, INVALID и SIGNATURE_MISMATCH — нет.
 * Ключ кэшируется: страница советует «one-hour is recommended» и запрещает запрашивать его на каждое уведомление.
 */

export interface PublicKeyResponse {
  key: string;
  algorithm?: string;
  digest?: string;
}

export interface PublicKeySource {
  /** Ключ по идентификатору; null — eBay такого ключа не знает; исключение — ключ сейчас не получить (повторит eBay) */
  get(kid: string): Promise<PublicKeyResponse | null>;
}

export type SignatureVerdict =
  | { ok: true; kid: string }
  | { ok: false; reason: 'HEADER_MISSING' | 'HEADER_MALFORMED' | 'ALGORITHM_UNSUPPORTED' | 'KEY_UNKNOWN' | 'SIGNATURE_INVALID' };

const KID_RE = /^[A-Za-z0-9-]{1,64}$/;

/** Заголовок подписи: base64 от JSON. Всё, что не так, — отказ, а не догадка */
export function parseSignatureHeader(header: string | undefined): { alg: string; kid: string; signature: string; digest: string } | null {
  if (!header || header.length > 4096) return null;
  try {
    const parsed = JSON.parse(Buffer.from(header, 'base64').toString('ascii')) as Record<string, unknown>;
    const { alg, kid, signature, digest } = parsed;
    if (typeof alg !== 'string' || typeof kid !== 'string' || typeof signature !== 'string' || typeof digest !== 'string') return null;
    if (!KID_RE.test(kid)) return null;
    return { alg, kid, signature, digest };
  } catch {
    return null;
  }
}

/** PEM из ответа Notification API: SDK вставляет переводы строк после начала и перед концом ключа */
export function pemOf(key: string): string {
  return key.replace(/-----BEGIN PUBLIC KEY-----\s*/, '-----BEGIN PUBLIC KEY-----\n').replace(/\s*-----END PUBLIC KEY-----/, '\n-----END PUBLIC KEY-----');
}

/**
 * Проверка уведомления. Алгоритм — только тот, что показывает SDK (ECDSA, SHA1): другой алгоритм в заголовке — отказ, а не
 * попытка подобрать. Исключение источника ключа пробрасывается: это «сейчас не проверить», а не «подделка».
 */
export async function verifyNotification(message: unknown, header: string | undefined, keys: PublicKeySource): Promise<SignatureVerdict> {
  if (!header) return { ok: false, reason: 'HEADER_MISSING' };
  const h = parseSignatureHeader(header);
  if (!h) return { ok: false, reason: 'HEADER_MALFORMED' };
  if (h.alg.toUpperCase() !== 'ECDSA' || h.digest.toUpperCase() !== 'SHA1') return { ok: false, reason: 'ALGORITHM_UNSUPPORTED' };
  const key = await keys.get(h.kid);
  if (!key || typeof key.key !== 'string') return { ok: false, reason: 'KEY_UNKNOWN' };
  if ((key.algorithm && key.algorithm.toUpperCase() !== 'ECDSA') || (key.digest && key.digest.toUpperCase() !== 'SHA1')) {
    return { ok: false, reason: 'ALGORITHM_UNSUPPORTED' };
  }
  let valid = false;
  try {
    valid = createVerify('sha1').update(JSON.stringify(message)).verify(pemOf(key.key), h.signature, 'base64');
  } catch {
    valid = false;
  }
  return valid ? { ok: true, kid: h.kid } : { ok: false, reason: 'SIGNATURE_INVALID' };
}

/** Ответ на challenge: SHA-256 от challengeCode + verificationToken + endpoint, hex (страница снимка, тот же порядок в SDK) */
export function challengeResponse(challengeCode: string, verificationToken: string, endpoint: string): string {
  return createHash('sha256').update(challengeCode).update(verificationToken).update(endpoint).digest('hex');
}

/**
 * Источник ключа Notification API с кэшем. Токен приложения — client credentials (страница «Authorization» снимка:
 * `grant_type=client_credentials`, scope `https://api.ebay.com/oauth/api_scope`, `expires_in` 7200); ключ — на час.
 *
 * Находка 4 ревью шага 49: адрес приёма публичный, и `kid` в заголовке задаёт кто угодно. Без защиты каждый POST с новым
 * `kid` — обращение к eBay из общего лимита приложения (страница снимка прямо предупреждает о лимитах), а исчерпанный лимит
 * отдаёт 500 и подлинным уведомлениям: через сутки eBay помечает адрес неработающим. Поэтому:
 *   * неизвестный eBay `kid` (404) помнится отрицательно — повтор к eBay не идёт;
 *   * обращений за ключом не больше `maxFetchesPerMinute` — сверх него «ключ сейчас не получить» (500, eBay повторит);
 *   * одинаковые запросы в полёте склеиваются;
 *   * при сбое обновления просроченного ключа отдаётся прежний: ключ eBay меняется редко, а 500 на известный `kid` — хуже.
 */
export function notificationApiKeys(options: {
  apiBase: string;
  clientId: string;
  clientSecret: string;
  fetchFn?: typeof fetch;
  now?: () => number;
  keyTtlMs?: number;
  unknownTtlMs?: number;
  maxFetchesPerMinute?: number;
}): PublicKeySource {
  const fetchFn = options.fetchFn ?? fetch;
  const now = options.now ?? Date.now;
  const ttl = options.keyTtlMs ?? 3_600_000;
  const unknownTtl = options.unknownTtlMs ?? 600_000;
  const maxPerMinute = options.maxFetchesPerMinute ?? 10;
  const keys = new Map<string, { value: PublicKeyResponse; until: number }>();
  const unknown = new Map<string, number>();
  const inFlight = new Map<string, Promise<PublicKeyResponse | null>>();
  const fetchedAt: number[] = [];
  let token: { value: string; until: number } | null = null;
  const appToken = async (): Promise<string> => {
    if (token && token.until > now()) return token.value;
    const r = await fetchFn(`${options.apiBase}/identity/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${options.clientId}:${options.clientSecret}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'https://api.ebay.com/oauth/api_scope' }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) throw new Error(`application token: HTTP ${r.status}`);
    const body = (await r.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== 'string') throw new Error('application token: no access_token');
    const seconds = typeof body.expires_in === 'number' && body.expires_in > 120 ? body.expires_in : 600;
    token = { value: body.access_token, until: now() + (seconds - 60) * 1000 };
    return token.value;
  };
  const load = async (kid: string): Promise<PublicKeyResponse | null> => {
    const t = now();
    while (fetchedAt.length > 0 && fetchedAt[0]! <= t - 60_000) fetchedAt.shift();
    if (fetchedAt.length >= maxPerMinute) throw new Error(`public key ${kid}: fetch limit ${maxPerMinute}/min reached`);
    fetchedAt.push(t);
    const r = await fetchFn(`${options.apiBase}/commerce/notification/v1/public_key/${kid}`, {
      headers: { authorization: `Bearer ${await appToken()}`, 'content-type': 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (r.status === 404) {
      unknown.set(kid, now() + unknownTtl);
      return null;
    }
    if (!r.ok) throw new Error(`public key ${kid}: HTTP ${r.status}`);
    const value = (await r.json()) as PublicKeyResponse;
    if (typeof value?.key !== 'string') throw new Error(`public key ${kid}: no key`);
    keys.set(kid, { value, until: now() + ttl });
    return value;
  };
  return {
    async get(kid) {
      if (!KID_RE.test(kid)) return null;
      const cached = keys.get(kid);
      if (cached && cached.until > now()) return cached.value;
      if ((unknown.get(kid) ?? 0) > now()) return null;
      let pending = inFlight.get(kid);
      if (!pending) {
        pending = load(kid).finally(() => inFlight.delete(kid));
        inFlight.set(kid, pending);
      }
      try {
        return await pending;
      } catch (error) {
        // Просроченный, но известный ключ лучше, чем 500 на подлинное уведомление
        if (cached) return cached.value;
        throw error;
      }
    },
  };
}
