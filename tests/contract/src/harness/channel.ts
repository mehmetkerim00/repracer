import { signKauflandRequest } from '@repracer/kaufland-client';
import { match } from './matchers.ts';
import type { Exchange, World } from './scenario.ts';
import type { VirtualClock } from './world.ts';

/** Запрос адаптера к каналу, как его увидел стенд */
export interface ObservedRequest {
  method: string;
  /** URL ровно как передан в fetch — по нему считается подпись */
  rawUrl: string;
  path: string;
  query: Record<string, string>;
  rawBody: string;
  body: unknown;
  headers: Record<string, string>;
}

export type ChannelReply =
  | { kind: 'response'; status: number; headers: Record<string, string>; body: unknown }
  | { kind: 'fault'; fault: 'TIMEOUT' | 'NETWORK_ERROR' };

/**
 * Поведение канала. ScriptedChannel воспроизводит обмены фикстуры строго по порядку; симулятор реализует тот же
 * интерфейс моделью с состоянием (unit, подписки, бюджет канала) и отвечает на произвольную последовательность.
 */
export interface ChannelBehaviour {
  reply(request: ObservedRequest, nowMs: number): { exchangeId: string; reply: ChannelReply } | { violation: string };
  /** Нарушения по окончании сценария (например, неиспользованные обмены) */
  finish(): string[];
}

export class ScriptedChannel implements ChannelBehaviour {
  private readonly exchanges: readonly Exchange[];
  private readonly requireAllUsed: boolean;
  private cursor = 0;

  constructor(exchanges: readonly Exchange[], requireAllUsed: boolean) {
    this.exchanges = exchanges;
    this.requireAllUsed = requireAllUsed;
  }

  reply(request: ObservedRequest): { exchangeId: string; reply: ChannelReply } | { violation: string } {
    const exchange = this.exchanges[this.cursor];
    const label = `${request.method} ${request.path}${Object.keys(request.query).length ? `?${new URLSearchParams(request.query)}` : ''}`;
    if (!exchange) return { violation: `unexpected request #${this.cursor + 1}: ${label} (no more scripted exchanges)` };
    this.cursor += 1;

    const problems: string[] = [];
    if (request.method !== exchange.request.method.toUpperCase()) problems.push(`method ${request.method} != ${exchange.request.method}`);
    if (request.path !== exchange.request.path) problems.push(`path ${request.path} != ${exchange.request.path}`);
    problems.push(...match(request.query, exchange.request.query ?? {}, 'exact', 'query'));
    if (exchange.request.body === undefined) {
      if (request.rawBody !== '') problems.push('request has a body, exchange expects none');
    } else {
      problems.push(...match(request.body, exchange.request.body, 'exact', 'body'));
    }
    if (problems.length > 0) return { violation: `exchange ${exchange.id} does not match ${label}: ${problems.join('; ')}` };

    if (exchange.fault) return { exchangeId: exchange.id, reply: { kind: 'fault', fault: exchange.fault } };
    const response = exchange.response!;
    return { exchangeId: exchange.id, reply: { kind: 'response', status: response.status, headers: response.headers ?? {}, body: response.body } };
  }

  finish(): string[] {
    if (!this.requireAllUsed || this.cursor >= this.exchanges.length) return [];
    return [`unused exchanges: ${this.exchanges.slice(this.cursor).map((e) => e.id).join(', ')}`];
  }
}

/** Проверка подписи и заголовков Kaufland на каждом запросе: подпись, время виртуальных часов, ключи, утечки секретов */
export function kauflandAuthChecker(world: World, clock: VirtualClock): (request: ObservedRequest) => string[] {
  return (request) => {
    const v: string[] = [];
    const h = request.headers;
    const where = `${request.method} ${request.path}`;
    const seller = world.credentials.seller;
    const ts = Math.floor(clock.nowMs() / 1000);
    if (h['shop-client-key'] !== seller.clientKey) v.push(`${where}: Shop-Client-Key is not the seller key`);
    if (h['shop-timestamp'] !== String(ts)) v.push(`${where}: Shop-Timestamp ${h['shop-timestamp']} != virtual clock ${ts}`);
    const expectSeller = signKauflandRequest({ method: request.method, uri: request.rawUrl, body: request.rawBody, timestamp: ts, secretKey: seller.secretKey ?? "" });
    if (h['shop-signature'] !== expectSeller) v.push(`${where}: Shop-Signature does not verify with the seller secret`);
    if (!h['user-agent']) v.push(`${where}: User-Agent header is missing`);
    const partner = world.credentials.partner;
    if (world.partner && partner) {
      if (h['shop-partner-client-key'] !== partner.clientKey) v.push(`${where}: Shop-Partner-Client-Key is not the partner key`);
      const expectPartner = signKauflandRequest({ method: request.method, uri: request.rawUrl, body: request.rawBody, timestamp: ts, secretKey: partner.secretKey ?? "" });
      if (h['shop-partner-signature'] !== expectPartner) v.push(`${where}: Shop-Partner-Signature does not verify with the partner secret`);
    } else if (h['shop-partner-client-key'] || h['shop-partner-signature']) {
      v.push(`${where}: partner headers sent without partner configuration`);
    }
    for (const secret of [seller.secretKey, partner?.secretKey]) {
      if (secret && (request.rawUrl.includes(secret) || request.rawBody.includes(secret) || Object.values(h).includes(secret))) {
        v.push(`${where}: secret key leaked into the request`);
      }
    }
    return v;
  };
}

/**
 * Проверка запросов Amazon на каждом обмене: токен LWA — только в заголовке x-amz-access-token и только выданный обменом сценария;
 * x-amz-date — время виртуальных часов; user-agent обязателен; ключи приложения и refresh token — только в теле запроса токена LWA;
 * атрибуты, которые не пишутся никогда (Р-114), не появляются ни в одном теле запроса.
 */
export function amazonRequestChecker(world: World, clock: VirtualClock, forbiddenAttributes: readonly string[]): (request: ObservedRequest) => string[] {
  return (request) => {
    const v: string[] = [];
    const where = `${request.method} ${request.path}`;
    const secrets = [world.credentials.seller.refreshToken, world.credentials.application?.clientSecret].filter((x): x is string => Boolean(x));
    if (request.path === '/auth/o2/token') {
      const form = new URLSearchParams(request.rawBody);
      if (request.method !== 'POST') v.push(`${where}: LWA token request must be POST`);
      if (form.get('grant_type') !== 'refresh_token') v.push(`${where}: grant_type must be refresh_token`);
      if (form.get('refresh_token') !== world.credentials.seller.refreshToken) v.push(`${where}: refresh_token is not the seller refresh token`);
      if (form.get('client_id') !== world.credentials.application?.clientId || form.get('client_secret') !== world.credentials.application?.clientSecret) {
        v.push(`${where}: client credentials are not the application keys`);
      }
      for (const s of secrets) if (request.rawUrl.includes(s)) v.push(`${where}: secret in the URL`);
      return v;
    }
    const h = request.headers;
    if (h['x-amz-access-token'] !== world.credentials.accessToken) v.push(`${where}: x-amz-access-token is not the token issued by LWA`);
    const expectedDate = new Date(clock.nowMs()).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    if (h['x-amz-date'] !== expectedDate) v.push(`${where}: x-amz-date ${h['x-amz-date']} != virtual clock ${expectedDate}`);
    if (!h['user-agent']) v.push(`${where}: user-agent header is missing`);
    for (const s of secrets) {
      if (request.rawUrl.includes(s) || request.rawBody.includes(s) || Object.values(h).includes(s)) v.push(`${where}: secret leaked into the request`);
    }
    for (const attribute of forbiddenAttributes) {
      // Ключ значения или путь операции PATCH (`/attributes/<атрибут>`): ревью шага 22, находка 8
      if (request.rawBody.includes(`"${attribute}"`) || request.rawBody.includes(`/attributes/${attribute}`)) v.push(`${where}: body writes ${attribute}, which is never written (Р-114)`);
    }
    return v;
  };
}

/**
 * Шаг 39: проверка запросов eBay на каждом обмене. Хост — песочница или бой по миру сценария; токен сервера токенов — Basic из ключей
 * приложения, обновление refresh-токена продавца или client_credentials; Inventory — Bearer токена пользователя; Browse — Bearer токена
 * приложения и витрина в X-EBAY-C-MARKETPLACE-ID; Trading — токен пользователя в X-EBAY-API-IAF-TOKEN. Ключ приложения и refresh-токен
 * не появляются нигде, кроме запроса токена; запроса миграции без согласия стенд не видит — его отвергает тип (Р-164).
 */
export function ebayRequestChecker(world: World, host: string): (request: ObservedRequest) => string[] {
  return (request) => {
    const v: string[] = [];
    const where = `${request.method} ${request.path}`;
    const h = request.headers;
    const app = world.credentials.application ?? {};
    const secrets = [world.credentials.seller.refreshToken, app.clientSecret].filter((x): x is string => Boolean(x));
    if (new URL(request.rawUrl).origin !== host) v.push(`${where}: request goes to ${new URL(request.rawUrl).origin}, not ${host}`);
    if (request.path === '/identity/v1/oauth2/token') {
      const form = new URLSearchParams(request.rawBody);
      if (request.method !== 'POST') v.push(`${where}: token request must be POST`);
      const basic = `Basic ${Buffer.from(`${app.clientId ?? ''}:${app.clientSecret ?? ''}`, 'utf8').toString('base64')}`;
      if (h.authorization !== basic) v.push(`${where}: token request is not authorised with the application keys`);
      const grant = form.get('grant_type');
      if (grant === 'refresh_token') {
        if (form.get('refresh_token') !== world.credentials.seller.refreshToken) v.push(`${where}: refresh_token is not the seller refresh token`);
        if (!form.get('scope')) v.push(`${where}: refresh without scope`);
      } else if (grant === 'client_credentials') {
        if (form.get('scope') !== 'https://api.ebay.com/oauth/api_scope') v.push(`${where}: application token scope is not api_scope`);
      } else {
        v.push(`${where}: unexpected grant_type ${grant}`);
      }
      for (const s of secrets) if (request.rawUrl.includes(s)) v.push(`${where}: secret in the URL`);
      return v;
    }
    if (request.path === '/ws/api.dll') {
      if (h['x-ebay-api-iaf-token'] !== world.credentials.accessToken) v.push(`${where}: X-EBAY-API-IAF-TOKEN is not the user token`);
      if (!h['x-ebay-api-call-name'] || !h['x-ebay-api-siteid'] || h['x-ebay-api-compatibility-level'] !== '1349') v.push(`${where}: Trading API headers are incomplete`);
      if (h.authorization) v.push(`${where}: Trading API call carries an Authorization header`);
    } else if (request.path.startsWith('/buy/browse/')) {
      if (h.authorization !== `Bearer ${world.credentials.applicationToken}`) v.push(`${where}: Browse API is not called with the application token`);
      if (!h['x-ebay-c-marketplace-id']) v.push(`${where}: X-EBAY-C-MARKETPLACE-ID is missing`);
    } else if (h.authorization !== `Bearer ${world.credentials.accessToken}`) {
      v.push(`${where}: Inventory API is not called with the user token`);
    }
    for (const s of secrets) {
      if (request.rawUrl.includes(s) || request.rawBody.includes(s) || Object.values(h).includes(s)) v.push(`${where}: secret leaked into the request`);
    }
    return v;
  };
}

export interface TraceEntry { method: string; path: string; exchangeId: string | null; outcome: string; atMs: number }

function headersToRecord(headers: RequestInit['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  const entries = headers instanceof Headers ? [...headers.entries()] : Array.isArray(headers) ? headers : Object.entries(headers);
  for (const [k, v] of entries) out[String(k).toLowerCase()] = String(v);
  return out;
}

/** fetch, который вместо сети отдаёт запрос поведению канала */
export function channelFetch(
  behaviour: ChannelBehaviour,
  check: (request: ObservedRequest) => string[],
  clock: VirtualClock,
  violations: string[],
  trace: TraceEntry[],
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(rawUrl);
    const rawBody = typeof init?.body === 'string' ? init.body : '';
    let body: unknown;
    try {
      body = rawBody === '' ? undefined : JSON.parse(rawBody);
    } catch {
      body = rawBody;
    }
    const request: ObservedRequest = {
      method: (init?.method ?? 'GET').toUpperCase(),
      rawUrl,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
      rawBody,
      body,
      headers: headersToRecord(init?.headers),
    };
    violations.push(...check(request));
    const result = behaviour.reply(request, clock.nowMs());
    if ('violation' in result) {
      violations.push(result.violation);
      trace.push({ method: request.method, path: request.path, exchangeId: null, outcome: 'VIOLATION', atMs: clock.nowMs() });
      return new Response(JSON.stringify({ type: '/problems/contract-harness', message: 'unscripted request', errors: [] }), { status: 418 });
    }
    const { reply } = result;
    trace.push({
      method: request.method, path: request.path, exchangeId: result.exchangeId,
      outcome: reply.kind === 'fault' ? reply.fault : String(reply.status), atMs: clock.nowMs(),
    });
    if (reply.kind === 'fault') {
      if (reply.fault === 'NETWORK_ERROR') throw new TypeError('fetch failed (scripted NETWORK_ERROR)');
      const signal = init?.signal;
      return new Promise<Response>((_, reject) => {
        if (!signal) { reject(new Error('scripted TIMEOUT needs an abort signal')); return; }
        if (signal.aborted) { reject(signal.reason); return; }
        // Таймер AbortSignal.timeout не удерживает цикл событий: без keepAlive процесс завершится раньше отмены
        const keepAlive = setInterval(() => {}, 5);
        signal.addEventListener('abort', () => { clearInterval(keepAlive); reject(signal.reason); }, { once: true });
      });
    }
    const noBody = reply.status === 204 || reply.body === undefined;
    // Ответ XML (Trading API eBay) отдаётся строкой как есть, остальное — JSON
    const xml = typeof reply.body === 'string' && (reply.headers['content-type'] ?? '').includes('xml');
    return new Response(noBody ? null : xml ? reply.body as string : JSON.stringify(reply.body), {
      status: reply.status,
      headers: { 'content-type': 'application/json', ...reply.headers },
    });
  }) as typeof fetch;
}
