import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { verifyKauflandSignature } from '@repracer/kaufland-client';
import type { ObservedRequest } from '../harness/channel.ts';
import type { SimulatedKauflandChannel } from '../simulator/kaufland-channel.ts';

/**
 * Шаг 58 (ревью шага 56, находка 15): модель Kaufland за НАСТОЯЩИМ HTTP. Живые прогоны до этого подключали симулятор к адаптеру подменой
 * `fetch`, а процесс планировщика подмену не принимает — он ходит в сеть по адресу из конфигурации (`REPRACER_KAUFLAND_BASE_URL`, только
 * стенд). Здесь — node:http на 127.0.0.1 и случайном порту; тело ответа — ответ симулятора.
 *
 * Часы модели — НАСТОЯЩИЕ: процесс подписывает запрос временем `systemClock`, поэтому проверка подписи берёт `Shop-Timestamp` из
 * заголовка и сверяет его с настоящим временем с допуском, а не с виртуальными часами, как `kauflandAuthChecker` стенда. Подпись
 * проверяется ключами продавца из ТОГО ЖЕ файла секрета, что читает процесс. Запрос с неверной подписью получает 401 и записывается
 * нарушением. Данные синтетические.
 */
export interface KauflandHttpModel {
  /** Адрес для `REPRACER_KAUFLAND_BASE_URL` — с `/v2`, как у умолчания клиента */
  baseUrl: string;
  /** Запросы по маршруту (`GET /v2/order-units`, …) — все дошедшие, включая отвергнутые */
  requests: Map<string, number>;
  /** Нарушения: подпись, ключ, время, секрет в запросе, немоделируемый маршрут */
  violations: string[];
  close(): Promise<void>;
}

export interface KauflandHttpModelOptions {
  simulator: SimulatedKauflandChannel;
  seller: { clientKey: string; secretKey: string };
  /** Допуск `Shop-Timestamp` относительно настоящих часов, с */
  timestampSkewSeconds?: number;
  now?: () => number;
  /**
   * Шаг 65 (хаос): порча канала НА ТРАНСПОРТЕ, поверх ответа симулятора — объект меняется прогоном между раундами. Всё — после того, как
   * симулятор запрос уже обработал: запись применена, а клиент этого не узнаёт
   */
  chaos?: KauflandChaos;
  /** Шаг 65: журнал запросов записи — что пришло в канал по каждой единице (цена, количество) и чем кончилось для клиента */
  journal?: KauflandWriteJournalEntry[];
  /** Шаг 65: запись применена каналом, ответ ещё не ушёл — прогон хаоса может убить отправителя именно здесь */
  onWriteApplied?: () => void;
}

export interface KauflandChaos {
  /** Случайное число [0, 1) — у прогона хаоса из его семени */
  random(): number;
  /** Обрыв соединения посреди ответа: заголовок и половина тела ушли, сокет закрыт */
  dropMidResponseShare: number;
  /** Пакет `units/bulk` применён, а клиент получил 500 на весь запрос */
  bulk500AfterApplyShare: number;
  /** Строка заказа повторена в той же странице `order-units` — повторная доставка */
  duplicateOrderLineShare: number;
}

export interface KauflandWriteJournalEntry {
  atMs: number;
  route: string;
  units: Array<{ idUnit: number; storefront: string; priceMinor: number | null; amount: number | null }>;
  /** Что увидел клиент: ответ, обрыв посреди ответа, 500 после применения, обрыв симулятора (тайм-аут) */
  delivered: 'REPLY' | 'DROPPED_MID_RESPONSE' | 'BULK_500_AFTER_APPLY' | 'FAULT';
  status: number | null;
}

const readBody = (req: IncomingMessage) => new Promise<string>((resolve, reject) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  req.on('error', reject);
});

export async function startKauflandHttpModel(options: KauflandHttpModelOptions): Promise<KauflandHttpModel> {
  const now = options.now ?? (() => Date.now());
  const skew = options.timestampSkewSeconds ?? 30;
  const requests = new Map<string, number>();
  const violations: string[] = [];
  let origin = '';
  const server: Server = createServer((req, res) => {
    void (async () => {
      const rawBody = await readBody(req);
      const rawUrl = `${origin}${req.url ?? '/'}`;
      const url = new URL(rawUrl);
      const method = (req.method ?? 'GET').toUpperCase();
      const route = `${method} ${url.pathname.replace(/\/[0-9]+$/, '/{id}')}`;
      requests.set(route, (requests.get(route) ?? 0) + 1);
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers[k.toLowerCase()] = v;
      let body: unknown;
      try { body = rawBody === '' ? undefined : JSON.parse(rawBody); } catch { body = rawBody; }
      const where = `${method} ${url.pathname}`;
      const problems: string[] = [];
      const ts = Number(headers['shop-timestamp']);
      if (headers['shop-client-key'] !== options.seller.clientKey) problems.push(`${where}: Shop-Client-Key is not the seller key`);
      if (!Number.isSafeInteger(ts) || Math.abs(ts - Math.floor(now() / 1000)) > skew) problems.push(`${where}: Shop-Timestamp ${headers['shop-timestamp']} is not within ${skew} s of the real clock`);
      else if (!verifyKauflandSignature({ method, uri: rawUrl, body: rawBody, timestamp: ts, secretKey: options.seller.secretKey }, headers['shop-signature'] ?? '')) {
        problems.push(`${where}: Shop-Signature does not verify with the seller secret`);
      }
      if (!headers['user-agent']) problems.push(`${where}: User-Agent header is missing`);
      if (rawUrl.includes(options.seller.secretKey) || rawBody.includes(options.seller.secretKey) || Object.values(headers).includes(options.seller.secretKey)) {
        problems.push(`${where}: secret key leaked into the request`);
      }
      if (problems.length > 0) {
        violations.push(...problems);
        res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ type: 'about:blank', message: 'Unauthorized', errors: [] }));
        return;
      }
      const request: ObservedRequest = { method, rawUrl, path: url.pathname, query: Object.fromEntries(url.searchParams.entries()), rawBody, body, headers };
      const result = options.simulator.reply(request, now());
      if ('violation' in result) {
        violations.push(result.violation);
        res.writeHead(418, { 'content-type': 'application/json' }).end(JSON.stringify({ type: '/problems/contract-harness', message: 'not modelled', errors: [] }));
        return;
      }
      const { reply } = result;
      const write = journalUnits(method, url.pathname, request.query, body);
      if (write) options.onWriteApplied?.();
      const chaos = options.chaos;
      if (reply.kind === 'fault') {
        if (write) options.journal?.push({ atMs: now(), route, units: write, delivered: 'FAULT', status: null });
        // Обрыв соединения — сетевой сбой для клиента; таймаут модели здесь тоже обрыв: ждать настоящие 30 с прогону незачем
        req.socket.destroy();
        return;
      }
      if (chaos && route === 'POST /v2/units/bulk' && chaos.random() < chaos.bulk500AfterApplyShare) {
        if (write) options.journal?.push({ atMs: now(), route, units: write, delivered: 'BULK_500_AFTER_APPLY', status: 500 });
        res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ type: 'about:blank', message: 'Internal Server Error', errors: [] }));
        return;
      }
      let replyBody = reply.body;
      if (chaos && route === 'GET /v2/order-units' && chaos.duplicateOrderLineShare > 0 && replyBody && typeof replyBody === 'object') {
        const page = replyBody as { data?: unknown[] };
        // Только на последней странице (короче предела): страница длиннее `limit` оборвала бы листание у адаптера — так канал не отвечает
        const lastPage = Array.isArray(page.data) && page.data.length < Number(url.searchParams.get('limit') ?? 100);
        if (Array.isArray(page.data) && lastPage) {
          const doubled: unknown[] = [];
          for (const line of page.data) {
            doubled.push(line);
            if (chaos.random() < chaos.duplicateOrderLineShare) doubled.push(line);
          }
          replyBody = { ...page, data: doubled };
        }
      }
      const noBody = reply.status === 204 || replyBody === undefined;
      const text = noBody ? '' : JSON.stringify(replyBody);
      if (chaos && !noBody && chaos.random() < chaos.dropMidResponseShare) {
        if (write) options.journal?.push({ atMs: now(), route, units: write, delivered: 'DROPPED_MID_RESPONSE', status: reply.status });
        res.writeHead(reply.status, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)), ...reply.headers });
        res.write(text.slice(0, Math.floor(text.length / 2)));
        setImmediate(() => req.socket.destroy());
        return;
      }
      if (write) options.journal?.push({ atMs: now(), route, units: write, delivered: 'REPLY', status: reply.status });
      res.writeHead(reply.status, { 'content-type': 'application/json', ...reply.headers }).end(noBody ? undefined : text);
    })().catch((error: unknown) => {
      violations.push(`model failed: ${String((error as Error)?.message ?? error).slice(0, 200)}`);
      if (!res.headersSent) res.writeHead(500).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    baseUrl: `${origin}/v2`, requests, violations,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

/** Шаг 65: единицы и значения записи из запроса — для журнала хаоса; чтение не записывается */
function journalUnits(method: string, path: string, query: Record<string, string>, body: unknown): KauflandWriteJournalEntry['units'] | null {
  const value = (data: Record<string, unknown> | undefined) => ({
    priceMinor: typeof data?.listing_price === 'number' ? data.listing_price : null, amount: typeof data?.amount === 'number' ? data.amount : null,
  });
  const unitPath = /^\/v2\/units\/([0-9]+)$/.exec(path);
  if (method === 'PATCH' && unitPath) return [{ idUnit: Number(unitPath[1]), storefront: query.storefront ?? '', ...value(body as Record<string, unknown>) }];
  if (method === 'POST' && path === '/v2/units/bulk' && Array.isArray(body)) {
    return (body as Array<{ id_unit?: number; unit_data?: Record<string, unknown> }>).map((item) => ({ idUnit: Number(item.id_unit), storefront: query.storefront ?? '', ...value(item.unit_data) }));
  }
  return null;
}
