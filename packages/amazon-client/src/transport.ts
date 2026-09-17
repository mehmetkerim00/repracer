import { createHash } from 'node:crypto';
import type { SpApiError } from './types.ts';

/**
 * Тонкий транспорт Selling Partner API. Факты — со страниц документации (адреса и SHA-256 — vendor/amazon/.../SOURCE.md):
 * - connecting-to-the-selling-partner-api: токен LWA — POST https://api.amazon.com/auth/o2/token, grant_type=refresh_token,
 *   refresh_token, client_id, client_secret; ответ access_token и expires_in; заголовки запроса x-amz-access-token, x-amz-date,
 *   user-agent (обязателен, до 500 символов). Подписи запроса в инструкции нет;
 * - sp-api-endpoints: адреса регионов NA, EU, FE;
 * - модель: параметры-массивы запроса — список через запятую; заголовки ответа x-amzn-RateLimit-Limit, x-amzn-RequestId.
 * Никакой доменной логики и классов ошибок домена — только HTTP-факты. Секреты не попадают в URL, журнал и результат.
 */

export const SP_API_ENDPOINTS = {
  NA: 'https://sellingpartnerapi-na.amazon.com',
  EU: 'https://sellingpartnerapi-eu.amazon.com',
  FE: 'https://sellingpartnerapi-fe.amazon.com',
} as const;
export type SpApiRegion = keyof typeof SP_API_ENDPOINTS;

export const LWA_TOKEN_URL = 'https://api.amazon.com/auth/o2/token';

export interface LwaCredentials { clientId: string; clientSecret: string; refreshToken: string }

export interface AttemptRecord { attempt: number; status: number | 'NETWORK_ERROR' | 'TIMEOUT'; startedAt: string; durationMs: number }

export type SpApiResult<T> =
  | { ok: true; status: number; data: T; headers: Headers; attempts: AttemptRecord[] }
  | {
      ok: false;
      status: number | 'NETWORK_ERROR' | 'TIMEOUT';
      errors: SpApiError[];
      /** Запрос мог дойти до Amazon: тайм-аут, обрыв, 5xx */
      outcomeUnknown: boolean;
      /** Сбой получения токена LWA: к SP-API запрос не отправлялся */
      tokenFailure: boolean;
      headers: Headers | null;
      attempts: AttemptRecord[];
    };

export interface RetryPolicy { maxAttempts: number; baseDelayMs: number; maxDelayMs: number }

export interface SpApiClientOptions {
  region: SpApiRegion;
  credentials: () => Promise<LwaCredentials>;
  /** Имя и версия приложения, язык и платформа — обязательный заголовок user-agent */
  userAgent: string;
  endpoint?: string;
  lwaUrl?: string;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  retry?: Partial<RetryPolicy>;
  tokens?: AccessTokenCache;
}

export interface RequestInit {
  query?: Record<string, string | number | readonly string[] | undefined>;
  body?: unknown;
  /** Повтор после неопределённого исхода; по умолчанию — только GET */
  idempotent?: boolean;
  signal?: AbortSignal;
}

export interface SpApiClient {
  request<T>(method: 'GET' | 'PATCH' | 'PUT' | 'DELETE', path: string, init?: RequestInit): Promise<SpApiResult<T>>;
}

/** Кэш токенов LWA: ключ — хеш учётных данных, не сами секреты; срок — expires_in минус запас */
export class AccessTokenCache {
  private readonly tokens = new Map<string, { token: string; expiresAtMs: number }>();
  get(key: string, nowMs: number): string | null {
    const t = this.tokens.get(key);
    return t && t.expiresAtMs > nowMs ? t.token : null;
  }
  set(key: string, token: string, expiresAtMs: number): void { this.tokens.set(key, { token, expiresAtMs }); }
  drop(key: string): void { this.tokens.delete(key); }
}

const DEFAULT_RETRY: RetryPolicy = { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 20_000 };
const TOKEN_EARLY_REFRESH_MS = 60_000;

export function amzDate(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function tokenKey(c: LwaCredentials): string {
  return createHash('sha256').update(`${c.clientId}\n${c.refreshToken}`).digest('hex');
}

function backoff(attempt: number, p: RetryPolicy): number {
  return Math.min(p.maxDelayMs, p.baseDelayMs * 2 ** (attempt - 1));
}

async function readErrors(response: Response): Promise<SpApiError[]> {
  try {
    const body = (await response.json()) as { errors?: SpApiError[] };
    return Array.isArray(body?.errors) ? body.errors.map((e) => ({ code: String(e.code ?? ''), message: String(e.message ?? '').slice(0, 500) })) : [];
  } catch {
    return [];
  }
}

export function buildQuery(query: RequestInit['query']): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v === undefined) continue;
    const value = Array.isArray(v) ? v.join(',') : String(v);
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(value)}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

export function createSpApiClient(options: SpApiClientOptions): SpApiClient {
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const retry = { ...DEFAULT_RETRY, ...options.retry };
  const timeoutMs = options.timeoutMs ?? 30_000;
  const endpoint = (options.endpoint ?? SP_API_ENDPOINTS[options.region]).replace(/\/+$/, '');
  const tokens = options.tokens ?? new AccessTokenCache();

  async function accessToken(signal?: AbortSignal): Promise<{ ok: true; token: string; key: string } | { ok: false; status: number | 'NETWORK_ERROR' | 'TIMEOUT'; errors: SpApiError[] }> {
    const creds = await options.credentials();
    const key = tokenKey(creds);
    const cached = tokens.get(key, now());
    if (cached) return { ok: true, token: cached, key };
    const form = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: creds.refreshToken, client_id: creds.clientId, client_secret: creds.clientSecret });
    const timeout = AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
      response = await doFetch(options.lwaUrl ?? LWA_TOKEN_URL, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' }, body: form.toString(),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch {
      return { ok: false, status: timeout.aborted ? 'TIMEOUT' : 'NETWORK_ERROR', errors: [] };
    }
    if (!response.ok) {
      // Тело ошибки LWA не пишется: может содержать отражённые параметры запроса
      return { ok: false, status: response.status, errors: [{ code: 'LWA_TOKEN_REFUSED', message: `LWA token endpoint answered ${response.status}` }] };
    }
    const body = (await response.json().catch(() => null)) as { access_token?: unknown; expires_in?: unknown } | null;
    if (typeof body?.access_token !== 'string' || typeof body.expires_in !== 'number') {
      return { ok: false, status: response.status, errors: [{ code: 'LWA_TOKEN_MALFORMED', message: 'LWA token response lacks access_token or expires_in' }] };
    }
    tokens.set(key, body.access_token, now() + body.expires_in * 1000 - TOKEN_EARLY_REFRESH_MS);
    return { ok: true, token: body.access_token, key };
  }

  return {
    async request<T>(method: 'GET' | 'PATCH' | 'PUT' | 'DELETE', path: string, init: RequestInit = {}): Promise<SpApiResult<T>> {
      const url = `${endpoint}${path}${buildQuery(init.query)}`;
      const body = init.body === undefined ? undefined : JSON.stringify(init.body);
      const idempotent = init.idempotent ?? method === 'GET';
      const attempts: AttemptRecord[] = [];
      let tokenRefreshed = false;
      for (let attempt = 1; ; attempt++) {
        const token = await accessToken(init.signal);
        if (!token.ok) {
          return { ok: false, status: token.status, errors: token.errors, outcomeUnknown: false, tokenFailure: true, headers: null, attempts };
        }
        const started = now();
        const timeout = AbortSignal.timeout(timeoutMs);
        const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
        let response: Response | null = null;
        let transport: 'NETWORK_ERROR' | 'TIMEOUT' | null = null;
        try {
          response = await doFetch(url, {
            method,
            headers: {
              accept: 'application/json', 'x-amz-access-token': token.token, 'x-amz-date': amzDate(started), 'user-agent': options.userAgent,
              ...(body === undefined ? {} : { 'content-type': 'application/json' }),
            },
            ...(body === undefined ? {} : { body }),
            signal,
          });
        } catch (error) {
          if (init.signal?.aborted) throw error;
          transport = timeout.aborted ? 'TIMEOUT' : 'NETWORK_ERROR';
        }
        const status = response ? response.status : transport!;
        attempts.push({ attempt, status, startedAt: new Date(started).toISOString(), durationMs: now() - started });
        if (response?.ok) {
          const text = await response.text();
          return { ok: true, status: response.status, data: (text === '' ? undefined : JSON.parse(text)) as T, headers: response.headers, attempts };
        }
        // Токен мог истечь раньше срока: один повтор с новым токеном, запрос не обработан
        if (response && (response.status === 401 || response.status === 403) && !tokenRefreshed) {
          const errors = await readErrors(response.clone());
          if (errors.some((e) => /token|unauthori[sz]ed/i.test(`${e.code} ${e.message}`))) {
            tokens.drop(token.key);
            tokenRefreshed = true;
            continue;
          }
        }
        // 429 — запрос не принят; 5xx и транспорт — исход неизвестен, повтор только идемпотентного запроса
        const unknown = transport !== null || (response !== null && response.status >= 500);
        if ((response?.status === 429 || (unknown && idempotent)) && attempt < retry.maxAttempts) {
          await sleep(backoff(attempt, retry));
          continue;
        }
        return {
          ok: false, status, errors: response ? await readErrors(response) : [], outcomeUnknown: unknown, tokenFailure: false,
          headers: response?.headers ?? null, attempts,
        };
      }
    },
  };
}
