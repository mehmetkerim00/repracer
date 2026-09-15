import type { paths } from './generated/schema.ts';
import { signKauflandRequest } from './signing.ts';

/**
 * Тонкий транспорт Kaufland Seller API v2: адрес, заголовки, подпись, тайм-аут, повторы.
 * Никакой доменной логики: не знает о тенантах, ценах, остатках и классах ошибок домена — только HTTP-факты.
 */

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

type Defined<T> = Exclude<T, undefined>;

/** Методы, существующие у пути в спецификации */
export type MethodOf<P extends keyof paths> = {
  [M in HttpMethod]: [Defined<paths[P][M]>] extends [never] ? never : M;
}[HttpMethod];

type Operation<P extends keyof paths, M extends MethodOf<P>> = Defined<paths[P][M]>;

type ParamsOf<O, K extends 'path' | 'query'> = O extends { parameters: infer Params }
  ? Params extends { [key in K]?: infer X }
    ? [Defined<X>] extends [never] ? undefined : Defined<X>
    : undefined
  : undefined;

type JsonBodyOf<O> = O extends { requestBody?: infer RB }
  ? Defined<RB> extends { content: { 'application/json': infer B } } ? B : undefined
  : undefined;

type SuccessStatus = 200 | 201 | 202 | 204 | 207;

type SuccessJsonOf<O> = O extends { responses: infer R }
  ? { [S in keyof R]: S extends SuccessStatus
        ? R[S] extends { content: { 'application/json': infer J } } ? J : undefined
        : never }[keyof R]
  : unknown;

export interface RequestInit<P extends keyof paths, M extends MethodOf<P>> {
  path?: ParamsOf<Operation<P, M>, 'path'>;
  query?: ParamsOf<Operation<P, M>, 'query'>;
  body?: JsonBodyOf<Operation<P, M>>;
  /**
   * Можно ли повторять запрос после неопределённого исхода (тайм-аут, 5xx, обрыв).
   * По умолчанию: GET, PUT, PATCH, DELETE — да; POST — нет (создание может выполниться дважды).
   */
  idempotent?: boolean;
  signal?: AbortSignal;
}

/** Тело ошибки Kaufland (https://sellerapi.kaufland.com/?page=error-responses) */
export interface KauflandProblem {
  type: string;
  message: string;
  errors: Array<{ field: string; message: string }>;
}

export interface AttemptRecord {
  attempt: number;
  status: number | 'NETWORK_ERROR' | 'TIMEOUT';
  startedAt: string;
  durationMs: number;
}

export type KauflandResult<T> =
  | { ok: true; status: number; data: T; headers: Headers; attempts: AttemptRecord[] }
  | {
      ok: false;
      /** HTTP-статус последней попытки или признак транспортной ошибки */
      status: number | 'NETWORK_ERROR' | 'TIMEOUT';
      problem: KauflandProblem | null;
      /** Исход неизвестен: запрос мог дойти до Kaufland (тайм-аут или обрыв после отправки) */
      outcomeUnknown: boolean;
      headers: Headers | null;
      attempts: AttemptRecord[];
    };

export interface KauflandCredentials {
  clientKey: string;
  secretKey: string;
}

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export interface KauflandClientOptions {
  /** Ключи продавца; вызывается перед каждой попыткой (ротация без пересоздания клиента) */
  sellerCredentials: () => Promise<KauflandCredentials>;
  /** Ключи технологического партнёра: обязательны для SaaS (заголовки Shop-Partner-*) */
  partnerCredentials?: () => Promise<KauflandCredentials>;
  /** Значение User-Agent: имя программного решения (обязательный заголовок) */
  userAgent: string;
  baseUrl?: string;
  timeoutMs?: number;
  retry?: Partial<RetryPolicy>;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_BASE_URL = 'https://sellerapi.kaufland.com/v2';
const DEFAULT_RETRY: RetryPolicy = { maxAttempts: 4, baseDelayMs: 500, maxDelayMs: 30_000 };
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

export interface KauflandClient {
  request<P extends keyof paths, M extends MethodOf<P>>(
    method: M,
    path: P,
    init?: RequestInit<P, M>,
  ): Promise<KauflandResult<SuccessJsonOf<Operation<P, M>>>>;
}

export function createKauflandClient(options: KauflandClientOptions): KauflandClient {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const retry: RetryPolicy = { ...DEFAULT_RETRY, ...options.retry };
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = options.timeoutMs ?? 30_000;

  return {
    async request(method, path, init = {}) {
      const uri = buildUri(baseUrl, String(path), init.path as Record<string, unknown> | undefined,
                           init.query as Record<string, unknown> | undefined);
      const body = init.body === undefined ? '' : JSON.stringify(init.body);
      const idempotent = init.idempotent ?? method !== 'post';
      const attempts: AttemptRecord[] = [];

      for (let attempt = 1; ; attempt++) {
        const started = now();
        const timestamp = Math.floor(started / 1000);
        const seller = await options.sellerCredentials();
        const headers: Record<string, string> = {
          Accept: 'application/json',
          'Shop-Client-Key': seller.clientKey,
          'Shop-Timestamp': String(timestamp),
          'Shop-Signature': signKauflandRequest({ method, uri, body, timestamp, secretKey: seller.secretKey }),
          'User-Agent': options.userAgent,
        };
        if (body !== '') headers['Content-Type'] = 'application/json';
        if (options.partnerCredentials) {
          const partner = await options.partnerCredentials();
          headers['Shop-Partner-Client-Key'] = partner.clientKey;
          headers['Shop-Partner-Signature'] =
            signKauflandRequest({ method, uri, body, timestamp, secretKey: partner.secretKey });
        }

        const timeout = AbortSignal.timeout(timeoutMs);
        const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
        let response: Response | null = null;
        let transport: 'NETWORK_ERROR' | 'TIMEOUT' | null = null;
        try {
          response = await doFetch(uri, { method: method.toUpperCase(), headers, body: body === '' ? undefined : body, signal });
        } catch (error) {
          if (init.signal?.aborted) throw error;
          transport = timeout.aborted ? 'TIMEOUT' : 'NETWORK_ERROR';
        }

        const status = response ? response.status : (transport as 'NETWORK_ERROR' | 'TIMEOUT');
        attempts.push({ attempt, status, startedAt: new Date(started).toISOString(), durationMs: now() - started });

        if (response && response.ok) {
          const text = await response.text();
          return { ok: true, status: response.status, data: (text === '' ? undefined : JSON.parse(text)) as never,
                   headers: response.headers, attempts };
        }

        // 429 и 5xx: запрос не обработан или исход неизвестен; транспортная ошибка — исход неизвестен
        const retryableStatus = response !== null && RETRYABLE_STATUS.has(response.status);
        const safeToRetry = response?.status === 429 || ((retryableStatus || transport !== null) && idempotent);
        if (safeToRetry && attempt < retry.maxAttempts) {
          await sleep(backoffWithJitter(attempt, retry));
          continue;
        }

        const problem = response ? await readProblem(response) : null;
        return {
          ok: false,
          status,
          problem,
          outcomeUnknown: transport !== null || (response !== null && response.status >= 500),
          headers: response ? response.headers : null,
          attempts,
        };
      }
    },
  };
}

function buildUri(baseUrl: string, template: string, pathParams?: Record<string, unknown>,
                  query?: Record<string, unknown>): string {
  const pathPart = template.replace(/\{([^}]+)\}/g, (_, name: string) => {
    const value = pathParams?.[name];
    if (value === undefined || value === null) throw new Error(`missing path parameter ${name}`);
    return encodeURIComponent(String(value));
  });
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null) continue;
    // Списки (например, embedded) передаются через запятую — https://sellerapi.kaufland.com/?page=rest-api
    search.append(key, Array.isArray(value) ? value.map(String).join(',') : String(value));
  }
  const qs = search.toString();
  return `${baseUrl}${pathPart}${qs === '' ? '' : `?${qs}`}`;
}

function backoffWithJitter(attempt: number, policy: RetryPolicy): number {
  const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
  return Math.floor(Math.random() * ceiling);
}

async function readProblem(response: Response): Promise<KauflandProblem | null> {
  try {
    const parsed = (await response.json()) as Partial<KauflandProblem>;
    return {
      type: typeof parsed.type === 'string' ? parsed.type : 'about:blank',
      message: typeof parsed.message === 'string' ? parsed.message : '',
      errors: Array.isArray(parsed.errors) ? parsed.errors : [],
    };
  } catch {
    return null;
  }
}
