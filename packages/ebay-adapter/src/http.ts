/**
 * Тонкий транспорт eBay: один запрос с тайм-аутом и, для чтений, повтор после неизвестного исхода. Никакой доменной логики, токены
 * подставляет сессия. Секреты не попадают в URL, журнал и результат.
 */

export type HttpStatus = number | 'NETWORK_ERROR' | 'TIMEOUT';

export interface HttpResult {
  ok: boolean;
  status: HttpStatus;
  /** Разобранный JSON; для XML (Trading API) — строка */
  body: unknown;
  headers: Headers | null;
  /** Запрос мог дойти до канала: тайм-аут, обрыв, 5xx */
  outcomeUnknown: boolean;
  /** Сколько HTTP-попыток сделано */
  attempts: number;
}

export interface RetryPolicy { maxAttempts: number; baseDelayMs: number; maxDelayMs: number }
export const DEFAULT_READ_RETRY: RetryPolicy = { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 20_000 };

export interface HttpOptions {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  timeoutMs: number;
  retry: RetryPolicy;
}

export interface HttpRequest {
  method: 'GET' | 'POST';
  url: string;
  headers: Record<string, string>;
  body?: string;
  /** Повтор после неизвестного исхода и 429; по умолчанию — только GET. Записи не повторяются никогда [EBAY_C02] */
  idempotent?: boolean;
  signal?: AbortSignal;
}

async function parseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === '') return undefined;
  if ((response.headers.get('content-type') ?? '').includes('xml') || text.trimStart().startsWith('<')) return text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function send(options: HttpOptions, request: HttpRequest): Promise<HttpResult> {
  const idempotent = request.idempotent ?? request.method === 'GET';
  for (let attempt = 1; ; attempt++) {
    const timeout = AbortSignal.timeout(options.timeoutMs);
    const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
    let response: Response | null = null;
    let body: unknown;
    let transport: 'NETWORK_ERROR' | 'TIMEOUT' | null = null;
    try {
      response = await options.fetch(request.url, {
        method: request.method, headers: request.headers, ...(request.body === undefined ? {} : { body: request.body }), signal,
      });
      // Тело читается под тем же сроком: обрыв посреди тела — транспортный сбой (исход неизвестен), а не исключение наружу
      body = await parseBody(response);
    } catch (error) {
      if (request.signal?.aborted) throw error;
      transport = timeout.aborted ? 'TIMEOUT' : 'NETWORK_ERROR';
      response = null;
    }
    const status: HttpStatus = response ? response.status : transport!;
    const unknown = transport !== null || (response !== null && response.status >= 500);
    if ((response?.status === 429 || unknown) && idempotent && attempt < options.retry.maxAttempts) {
      await options.sleep(Math.min(options.retry.maxDelayMs, options.retry.baseDelayMs * 2 ** (attempt - 1)));
      continue;
    }
    return { ok: response !== null && response.ok, status, body, headers: response?.headers ?? null, outcomeUnknown: unknown, attempts: attempt };
  }
}
