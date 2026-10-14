import { FEED_MAX_BYTES, WALMART_PATHS } from './descriptor.ts';
import { WalmartTokenPacer } from './pacer.ts';

/**
 * Шаг 89: HTTP-клиент Walmart Marketplace. Учётные данные — по Token API (OAuth 2.0, факт владельца): ключ клиента и секрет обмениваются
 * на токен доступа, токен живёт до истечения; всё остальное идёт с ним. Каждый запрос проходит корзину токенов (pacer.ts): пустая корзина
 * — ждём пополнения, а не отправляем за 429. Пришёл 429 всё же (корзину опустошил кто-то ещё) — ждём названного пополнения и повторяем
 * один раз. 413 — фид слишком большой: ошибка нашего пакета, без повтора. Тела ошибок канала в журнал не идут — только статус.
 */
export interface WalmartFetch {
  (url: string, init: { method: string; headers: Record<string, string>; body?: string }): Promise<{
    status: number;
    headers: { get(name: string): string | null };
    text(): Promise<string>;
  }>;
}

export interface WalmartClientOptions {
  baseUrl: string;
  fetch: WalmartFetch;
  clientId: string;
  clientSecret: string;
  clock: { nowMs(): number; sleep(ms: number): Promise<void> };
  pacer?: WalmartTokenPacer;
}

export interface WalmartResponse {
  status: number;
  body: unknown;
}

export class WalmartHttpError extends Error {
  readonly status: number;
  readonly operation: string;
  constructor(status: number, operation: string) {
    super(`Walmart ${operation}: HTTP ${status}`);
    this.name = 'WalmartHttpError';
    this.status = status;
    this.operation = operation;
  }
}

/** Семейство операции — корзина токенов: у инвентаря своя квота (факт владельца), у остальных — по ресурсу (W-07) */
export function bucketOf(path: string): string {
  if (path.startsWith(WALMART_PATHS.inventory)) return 'inventory';
  if (path.startsWith(WALMART_PATHS.price)) return 'price';
  if (path.startsWith(WALMART_PATHS.buybox)) return 'buybox';
  if (path.startsWith(WALMART_PATHS.feeds)) return 'feeds';
  if (path.startsWith(WALMART_PATHS.token)) return 'token';
  return 'items';
}

export class WalmartClient {
  readonly pacer: WalmartTokenPacer;
  private token: { value: string; expiresAtMs: number } | null = null;
  private readonly o: WalmartClientOptions;

  constructor(o: WalmartClientOptions) {
    this.o = o;
    this.pacer = o.pacer ?? new WalmartTokenPacer(o.clock);
  }

  private async send(method: string, path: string, body: unknown, auth: Record<string, string>): Promise<WalmartResponse> {
    const bucket = bucketOf(path);
    for (let attempt = 1; ; attempt++) {
      await this.pacer.beforeRequest(bucket);
      const r = await this.o.fetch(`${this.o.baseUrl}${path}`, {
        method,
        headers: { accept: 'application/json', 'content-type': 'application/json', 'WM_SVC.NAME': 'repracer', 'WM_QOS.CORRELATION_ID': `rp-${this.o.clock.nowMs()}`, ...auth },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      this.pacer.afterResponse(bucket, r.status, r.headers);
      const text = await r.text();
      // 429: корзина пуста — один повтор после названного пополнения (pacer ждёт его сам)
      if (r.status === 429 && attempt === 1) continue;
      let parsed: unknown = null;
      try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
      return { status: r.status, body: parsed };
    }
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAtMs - 60_000 > this.o.clock.nowMs()) return this.token.value;
    const basic = Buffer.from(`${this.o.clientId}:${this.o.clientSecret}`).toString('base64');
    const r = await this.send('POST', WALMART_PATHS.token, { grant_type: 'client_credentials' }, { authorization: `Basic ${basic}` });
    const b = r.body as { access_token?: string; expires_in?: number } | null;
    if (r.status !== 200 || !b?.access_token) throw new WalmartHttpError(r.status, 'token');
    this.token = { value: b.access_token, expiresAtMs: this.o.clock.nowMs() + (b.expires_in ?? 900) * 1000 };
    return this.token.value;
  }

  async request(method: 'GET' | 'PUT' | 'POST', path: string, body?: unknown): Promise<WalmartResponse> {
    const token = await this.accessToken();
    return this.send(method, path, body, { 'WM_SEC.ACCESS_TOKEN': token });
  }

  /** Фид цен: тело больше предела не уходит вовсе — 413 был бы ошибкой нашего пакета (W-08) */
  async submitPriceFeed(items: ReadonlyArray<{ sku: string; amount: number; currency: string }>, maxBytes = FEED_MAX_BYTES): Promise<WalmartResponse> {
    const body = { PriceHeader: { version: '1.7' }, Price: items.map((i) => ({ sku: i.sku, pricing: [{ currentPrice: { currency: i.currency, amount: i.amount } }] })) };
    if (Buffer.byteLength(JSON.stringify(body), 'utf8') > maxBytes) throw new WalmartHttpError(413, 'priceFeed (refused before sending)');
    return this.request('POST', `${WALMART_PATHS.feeds}?feedType=price`, body);
  }
}
