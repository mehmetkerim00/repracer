import { gunzipSync } from 'node:zlib';
import type { AdapterCallContext, DiscoveryCatalogNote, DiscoveryFallbackReason, DiscoveryPage, Instant, PageRequest } from '@repracer/channel-port';
import type { CreateReportResponse, Report, ReportDocument } from '@repracer/amazon-client';
import { logConservative } from './conservative.ts';
import { AMAZON_MARKETPLACES, SEARCH_PAGE_MAX } from './descriptor.ts';
import { ChannelCallError, channelError, classifyFailure } from './errors.ts';
import { searchListingsPage } from './listing.ts';
import { acquire, deadlinePassed, nowMs, observeRateLimit, openSession, type AmazonAdapterOptions, type Session } from './session.ts';

/**
 * Шаг 117 (P0-16 аудита, A-31, решение владельца 2026-11-07): каталог аккаунта — отчётом GET_MERCHANT_LISTINGS_ALL_DATA. Поиск searchListingsItems отдаёт
 * не больше 1 000 SKU на все страницы (A-31 [док]), а размер каталога пилота неизвестен. Отчёт называет SKU витрины целиком; подробности по ним — тот же
 * searchListingsItems, но по SKU (`identifiers`, до 20 — модель снимка 2026-10-29), и тот же разбор, что у поиска по витрине: записи обнаружения
 * одинаковы на обоих путях (правило ценообразования канала, рамки, статус листинга, FBA). Поиск по витрине — резерв: отчёт недоступен — круг идёт
 * поиском, и упёршийся в предел поиск говорит это словами (`mayBeIncomplete`).
 *
 * Факты — модель Reports 2021-06-30 (vendor/amazon/sp-api-models/2026-09-16, SHA256SUMS) и страницы vendor/amazon/reports/2026-11-07/SOURCE.md:
 * createReport → reportId (202); getReport — processingStatus IN_QUEUE / IN_PROGRESS / DONE / CANCELLED / FATAL, у DONE — reportDocumentId; getReportDocument —
 * подписанный адрес на 5 минут и, если сжато, compressionAlgorithm GZIP; у отчёта листингов принимается только первая витрина запроса, документ —
 * табуляция с UTF-8 BOM, заголовки — на языке `preferredReportDocumentLocale`, но из кэша отчётов могут прийти на другом (A-37). Неясное — A-35…A-40
 */
export const LISTINGS_REPORT_TYPE = 'GET_MERCHANT_LISTINGS_ALL_DATA';
export const REPORTS_PATH = '/reports/2021-06-30/reports';
export const REPORT_DOCUMENTS_PATH = '/reports/2021-06-30/documents';
/** Отчёт в обработке: следующий вопрос о нём — не раньше чем через столько (getReport 2 rps — лимит не мешает, мешал бы шум в журнале) */
export const REPORT_POLL_MS = 30_000;
/** Отчёт, не готовый за столько от запроса, недоступен: круг идёт поиском (A-38) */
export const REPORT_WAIT_LIMIT_MS = 2 * 3_600_000;
/** Документ больше этого — не каталог, а ошибка или бомба сжатия: отказ, круг идёт поиском (у 100 000 предложений строки отчёта — десятки мегабайт) */
export const REPORT_DOCUMENT_MAX_BYTES = 256 * 1024 * 1024;
/** Колонки отчёта, без которых разбор невозможен: SKU продавца — ключ поиска подробностей */
export const REPORT_REQUIRED_COLUMNS = ['seller-sku'] as const;
/** Колонки страницы report-type-values-inventory (2026-11-07) — заголовок вне их называется в журнале, но не мешает */
export const REPORT_DOCUMENTED_COLUMNS: readonly string[] = [
  'item-name', 'item-description', 'listing-id', 'seller-sku', 'price', 'quantity', 'open-date', 'image-url', 'item-is-marketplace', 'product-id-type',
  'zshop-shipping-fee', 'item-note', 'item-condition', 'zshop-category1', 'zshop-browse-path', 'zshop-storefront-feature', 'asin1', 'asin2', 'asin3',
  'will-ship-internationally', 'expedited-shipping', 'zshop-boldface', 'product-id', 'bid-for-featured-placement', 'add-delete', 'pending-quantity',
  'fulfillment-channel', 'merchant-shipping-group', 'status',
];
/** Предел поиска по витрине (A-31): «limited to 1000 listings total across all pages» — каталог, где найдено столько и больше, может быть неполным */
export const SEARCH_TOTAL_MAX = 1000;
const SKU_MAX = 200;
const DOCUMENT_TIMEOUT_MS = 120_000;
/** Шагов курсора за один вызов, где ждать нечего: запрос отчёта, вопрос о нём, документ, первая страница */
const TRANSITIONS_PER_CALL = 6;

export type DiscoveryCursor =
  | { kind: 'CREATE'; i: number }
  | { kind: 'WAIT'; i: number; reportId: string }
  /** `token` — продолжение страниц поиска по той же порции SKU: канал может отдать страницу короче запрошенной (модель: токен — единственный признак) */
  | { kind: 'DOCUMENT'; i: number; documentId: string; offset: number; token?: string | null }
  | { kind: 'SEARCH'; i: number; reason: DiscoveryFallbackReason; token: string | null }
  /** Круг, начатый поиском до шага 117: курсор — pageToken канала; дочитывается поиском по всем витринам, как прежде */
  | { kind: 'LEGACY'; token: string };

const PREFIX = 'amz2:';
export function encodeDiscoveryCursor(c: DiscoveryCursor): string {
  return PREFIX + Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

export function decodeDiscoveryCursor(raw: string | undefined): DiscoveryCursor {
  if (raw === undefined || raw === '') return { kind: 'CREATE', i: 0 };
  if (!raw.startsWith(PREFIX)) return { kind: 'LEGACY', token: raw };
  try {
    const c = JSON.parse(Buffer.from(raw.slice(PREFIX.length), 'base64url').toString('utf8')) as DiscoveryCursor;
    const index = (c as { i?: unknown }).i;
    if (c.kind === 'CREATE' && Number.isSafeInteger(index)) return c;
    if (c.kind === 'WAIT' && Number.isSafeInteger(index) && typeof c.reportId === 'string') return c;
    if (c.kind === 'DOCUMENT' && Number.isSafeInteger(index) && typeof c.documentId === 'string' && Number.isSafeInteger(c.offset) && c.offset >= 0
        && (c.token === undefined || c.token === null || typeof c.token === 'string')) return c;
    if (c.kind === 'SEARCH' && Number.isSafeInteger(index) && typeof c.reason === 'string' && (c.token === null || typeof c.token === 'string')) return c;
  } catch { /* испорченный курсор — круг с начала: курсор пишем только мы */ }
  return { kind: 'CREATE', i: 0 };
}

export type ListingsReportParse =
  | { ok: true; skus: string[]; rows: number; badRows: number; duplicates: number; unknownColumns: string[] }
  | { ok: false; reason: 'REPORT_HEADER' };

/**
 * Строгий разбор документа отчёта листингов: первая строка — заголовок (без BOM), колонка `seller-sku` обязательна — без неё (другой язык заголовков, A-37)
 * отчёт не годится целиком. Строка с полями больше, чем в заголовке, и строка с пустым или непечатным SKU пропускаются поштучно и считаются; повтор SKU —
 * один раз. Короче заголовка строка допустима: хвостовые пустые колонки мы не читаем
 */
export function parseListingsReport(text: string): ListingsReportParse {
  const body = text.startsWith('﻿') ? text.slice(1) : text;
  const lines = body.split(/\r?\n/);
  const header = (lines[0] ?? '').split('\t');
  const skuAt = header.indexOf('seller-sku');
  if (skuAt < 0) return { ok: false, reason: 'REPORT_HEADER' };
  const seen = new Set<string>();
  const skus: string[] = [];
  let rows = 0;
  let badRows = 0;
  let duplicates = 0;
  for (const line of lines.slice(1)) {
    if (line === '') continue;
    rows += 1;
    const cells = line.split('\t');
    const sku = cells[skuAt];
    // eslint-disable-next-line no-control-regex
    if (cells.length > header.length || sku === undefined || sku === '' || sku.length > SKU_MAX || /[\u0000-\u001f\u007f]/.test(sku)) { badRows += 1; continue; }
    if (seen.has(sku)) { duplicates += 1; continue; }
    seen.add(sku);
    skus.push(sku);
  }
  return { ok: true, skus, rows, badRows, duplicates, unknownColumns: header.filter((c) => !REPORT_DOCUMENTED_COLUMNS.includes(c)).map((c) => c.slice(0, 40)) };
}

/** Байты документа → текст: GZIP по compressionAlgorithm, кодировка — только UTF-8 (страница отчёта; иное — A-36), разбор UTF-8 строгий */
export function decodeReportDocument(bytes: Uint8Array, compression: string | undefined, contentType: string | null):
  { ok: true; text: string } | { ok: false; reason: 'REPORT_DOCUMENT' | 'REPORT_ENCODING' } {
  let raw: Uint8Array = bytes;
  if (compression !== undefined) {
    if (compression !== 'GZIP') return { ok: false, reason: 'REPORT_DOCUMENT' };
    try {
      raw = gunzipSync(bytes, { maxOutputLength: REPORT_DOCUMENT_MAX_BYTES });
    } catch {
      return { ok: false, reason: 'REPORT_DOCUMENT' };
    }
  }
  const charset = /charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType ?? '')?.[1]?.toLowerCase() ?? null;
  if (charset !== null && charset !== 'utf-8' && charset !== 'utf8') return { ok: false, reason: 'REPORT_ENCODING' };
  try {
    return { ok: true, text: new TextDecoder('utf-8', { fatal: true }).decode(raw) };
  } catch {
    return { ok: false, reason: 'REPORT_ENCODING' };
  }
}

/** Разобранные документы: подробности идут страницами по 20 SKU, документ скачивается один раз за круг; после перезапуска процесса — заново */
const documents = new WeakMap<AmazonAdapterOptions, Map<string, string[]>>();
const DOCUMENTS_KEPT = 4;

type Step = { page: DiscoveryPage } | { next: DiscoveryCursor };

/** Офферы аккаунта: по витрине региона — отчёт листингов и подробности поиском по SKU; отчёт недоступен — поиск по витрине (резерв) */
export async function discoverOffersAmazon(options: AmazonAdapterOptions, ctx: AdapterCallContext, page: PageRequest): Promise<DiscoveryPage> {
  const opened = await openSession(options, ctx);
  if (!opened.ok) throw new ChannelCallError(opened.error);
  const { session } = opened;
  const late = deadlinePassed(options, ctx);
  if (late) throw new ChannelCallError(late);
  const marketplaces = session.account.marketplaces.filter((m) => (AMAZON_MARKETPLACES as Record<string, { region: string }>)[m]?.region === session.region);
  if (marketplaces.length === 0) return { items: [] };
  let cursor = decodeDiscoveryCursor(page.cursor);
  const notes: DiscoveryCatalogNote[] = [];
  for (let n = 0; n < TRANSITIONS_PER_CALL; n++) {
    const step = await advance(options, ctx, session, marketplaces, page.limit, cursor, notes);
    if ('page' in step) return notes.length > 0 ? { ...step.page, catalogs: notes } : step.page;
    cursor = step.next;
  }
  return { items: [], nextCursor: encodeDiscoveryCursor(cursor), ...(notes.length > 0 ? { catalogs: notes } : {}) };
}

function after(i: number, marketplaces: readonly string[]): { next: DiscoveryCursor } | { page: DiscoveryPage } {
  return i + 1 < marketplaces.length ? { next: { kind: 'CREATE', i: i + 1 } } : { page: { items: [] } };
}

function fallback(options: AmazonAdapterOptions, ctx: AdapterCallContext, i: number, reason: DiscoveryFallbackReason, details: Record<string, string | number | boolean | null>): Step {
  logConservative(options.deps.logger, ctx, 'AMZ_C16_LISTINGS_REPORT', { outcome: reason, ...details });
  return { next: { kind: 'SEARCH', i, reason, token: null } };
}

async function advance(options: AmazonAdapterOptions, ctx: AdapterCallContext, session: Session, marketplaces: readonly string[], limit: number,
  cursor: DiscoveryCursor, notes: DiscoveryCatalogNote[]): Promise<Step> {
  const late = deadlinePassed(options, ctx);
  if (late) throw new ChannelCallError(late);
  if (cursor.kind === 'LEGACY') {
    const r = await searchListingsPage(options, ctx, session, { marketplaces, pageSize: limit, pageToken: cursor.token });
    return { page: { items: r.items, ...(r.nextToken ? { nextCursor: r.nextToken } : {}) } };
  }
  if (cursor.i >= marketplaces.length) return { page: { items: [] } };
  const marketplace = marketplaces[cursor.i]!;
  if (cursor.kind === 'CREATE') return createReport(options, ctx, session, cursor.i, marketplace);
  if (cursor.kind === 'WAIT') return pollReport(options, ctx, session, cursor.i, marketplace, cursor.reportId);
  if (cursor.kind === 'DOCUMENT') {
    const skus = await documentSkus(options, ctx, session, cursor.documentId);
    if (!Array.isArray(skus)) return fallback(options, ctx, cursor.i, skus.reason, { stage: 'DOCUMENT' });
    const token = cursor.token ?? null;
    if (cursor.offset === 0 && token === null) notes.push({ marketplace, source: 'REPORT', listed: skus.length, fallbackReason: null, mayBeIncomplete: false });
    const part = skus.slice(cursor.offset, cursor.offset + SEARCH_PAGE_MAX);
    if (part.length === 0) return after(cursor.i, marketplaces);
    const r = await searchListingsPage(options, ctx, session, { marketplaces: [marketplace], pageSize: SEARCH_PAGE_MAX, skus: part, pageToken: token });
    /**
     * SKU отчёта, которого поиск не вернул (снят между отчётом и поиском, A-39), — не предложение этого круга (порция одной страницей). Шаг 122 (П7): не только
     * число в журнале процесса — SKU уходят со страницей, и ядро записывает их у источника витрины для экрана Channels
     */
    const missing = token === null && r.nextToken === null ? part.filter((s) => !r.returnedSkus.has(s)) : [];
    if (missing.length > 0) logConservative(options.deps.logger, ctx, 'AMZ_C16_LISTINGS_REPORT', { outcome: 'SKU_NOT_FOUND', missing: missing.length, asked: part.length });
    const next = r.nextToken ? { kind: 'DOCUMENT' as const, i: cursor.i, documentId: cursor.documentId, offset: cursor.offset, token: r.nextToken }
      : cursor.offset + part.length < skus.length ? { kind: 'DOCUMENT' as const, i: cursor.i, documentId: cursor.documentId, offset: cursor.offset + part.length }
        : cursor.i + 1 < marketplaces.length ? { kind: 'CREATE' as const, i: cursor.i + 1 } : null;
    return { page: { items: r.items, ...(next ? { nextCursor: encodeDiscoveryCursor(next) } : {}), ...(missing.length > 0 ? { reportSkusNotFound: { marketplace, skus: missing } } : {}) } };
  }
  // Резерв — поиск по витрине: первая страница называет, сколько найдено; найдено не меньше предела — каталог может быть неполным (A-31)
  const r = await searchListingsPage(options, ctx, session, { marketplaces: [marketplace], pageSize: limit, pageToken: cursor.token });
  if (cursor.token === null) {
    notes.push({ marketplace, source: 'SEARCH', listed: r.numberOfResults, fallbackReason: cursor.reason,
      mayBeIncomplete: r.numberOfResults === null || r.numberOfResults >= SEARCH_TOTAL_MAX });
  }
  const next = r.nextToken ? { kind: 'SEARCH' as const, i: cursor.i, reason: cursor.reason, token: r.nextToken }
    : cursor.i + 1 < marketplaces.length ? { kind: 'CREATE' as const, i: cursor.i + 1 } : null;
  return { page: { items: r.items, ...(next ? { nextCursor: encodeDiscoveryCursor(next) } : {}) } };
}

async function createReport(options: AmazonAdapterOptions, ctx: AdapterCallContext, session: Session, i: number, marketplace: string): Promise<Step> {
  const budget = acquire(options, ctx, session, 'createReport');
  if (budget) throw new ChannelCallError(budget);
  const result = await session.client.request<CreateReportResponse>('POST', REPORTS_PATH, {
    // Только первая витрина запроса принимается у этого отчёта (страница отчёта) — одна витрина на отчёт; заголовки — en_US (A-37)
    body: { reportType: LISTINGS_REPORT_TYPE, marketplaceIds: [marketplace], reportOptions: { preferredReportDocumentLocale: 'en_US' } },
  });
  if (!result.ok) {
    const error = classifyFailure(result, 'BATCH', nowMs(options));
    // Сбой инфраструктуры и лимит — повтор следующим заходом с того же места; отказ (роль, витрина, тип) — отчёта нет, круг идёт поиском (A-40)
    if (error.class === 'TRANSIENT' || error.code === 'RATE_LIMITED') throw new ChannelCallError(error);
    return fallback(options, ctx, i, 'REPORT_REFUSED', { stage: 'CREATE', status: typeof result.status === 'number' ? result.status : null });
  }
  observeRateLimit(options, ctx, session, 'createReport', result.headers);
  const reportId = (result.data as { reportId?: unknown } | undefined)?.reportId;
  if (typeof reportId !== 'string' || reportId === '' || reportId.length > 200) return fallback(options, ctx, i, 'REPORT_MISMATCH', { stage: 'CREATE' });
  return { next: { kind: 'WAIT', i, reportId } };
}

async function pollReport(options: AmazonAdapterOptions, ctx: AdapterCallContext, session: Session, i: number, marketplace: string, reportId: string): Promise<Step> {
  const budget = acquire(options, ctx, session, 'getReport');
  if (budget) throw new ChannelCallError(budget);
  const result = await session.client.request<Report>('GET', `${REPORTS_PATH}/${encodeURIComponent(reportId)}`, {});
  if (!result.ok) {
    const error = classifyFailure(result, 'BATCH', nowMs(options));
    if (error.class === 'TRANSIENT' || error.code === 'RATE_LIMITED') throw new ChannelCallError(error);
    return fallback(options, ctx, i, 'REPORT_REFUSED', { stage: 'POLL', status: typeof result.status === 'number' ? result.status : null });
  }
  observeRateLimit(options, ctx, session, 'getReport', result.headers);
  const report = result.data as Partial<Report> | undefined;
  /**
   * Р-205: ответ — о нашем отчёте и нашей витрине. Модель снимка отдаёт `Report` без обёртки; пример страницы — в `payload` (A-35): такой ответ — не отчёт
   * по модели, круг идёт поиском, а чеклист первого дня проверяет форму
   */
  if (!report || report.reportId !== reportId || report.reportType !== LISTINGS_REPORT_TYPE
      || (Array.isArray(report.marketplaceIds) && !report.marketplaceIds.includes(marketplace))) {
    return fallback(options, ctx, i, 'REPORT_MISMATCH', { stage: 'POLL', wrapped: Boolean((result.data as { payload?: unknown } | undefined)?.payload) });
  }
  const status = report.processingStatus;
  if (status === 'DONE') {
    if (typeof report.reportDocumentId !== 'string' || report.reportDocumentId === '' || report.reportDocumentId.length > 200) {
      return fallback(options, ctx, i, 'REPORT_MISMATCH', { stage: 'POLL', status });
    }
    return { next: { kind: 'DOCUMENT', i, documentId: report.reportDocumentId, offset: 0 } };
  }
  if (status === 'CANCELLED') return fallback(options, ctx, i, 'REPORT_CANCELLED', { stage: 'POLL' });
  if (status === 'FATAL') return fallback(options, ctx, i, 'REPORT_FATAL', { stage: 'POLL' });
  if (status !== 'IN_QUEUE' && status !== 'IN_PROGRESS') return fallback(options, ctx, i, 'REPORT_MISMATCH', { stage: 'POLL', status: String(status).slice(0, 20) });
  const created = Date.parse(String(report.createdTime));
  if (!Number.isFinite(created)) return fallback(options, ctx, i, 'REPORT_MISMATCH', { stage: 'POLL' });
  if (nowMs(options) - created > REPORT_WAIT_LIMIT_MS) return fallback(options, ctx, i, 'REPORT_TIMEOUT', { stage: 'POLL', status });
  return { page: { items: [], nextCursor: encodeDiscoveryCursor({ kind: 'WAIT', i, reportId }), notBefore: new Date(nowMs(options) + REPORT_POLL_MS).toISOString() as Instant } };
}

/** SKU документа: из памяти процесса или getReportDocument и подписанный адрес (без токена: адрес живёт вне нас, его журнал — не наш) */
async function documentSkus(options: AmazonAdapterOptions, ctx: AdapterCallContext, session: Session, documentId: string):
  Promise<string[] | { reason: DiscoveryFallbackReason }> {
  const key = `${ctx.tenantId}|${ctx.channelAccountId}|${documentId}`;
  let kept = documents.get(options);
  if (!kept) { kept = new Map(); documents.set(options, kept); }
  const known = kept.get(key);
  if (known) return known;
  const budget = acquire(options, ctx, session, 'getReportDocument');
  if (budget) throw new ChannelCallError(budget);
  const result = await session.client.request<ReportDocument>('GET', `${REPORT_DOCUMENTS_PATH}/${encodeURIComponent(documentId)}`, {});
  if (!result.ok) {
    const error = classifyFailure(result, 'BATCH', nowMs(options));
    if (error.class === 'TRANSIENT' || error.code === 'RATE_LIMITED') throw new ChannelCallError(error);
    return { reason: 'REPORT_DOCUMENT' };
  }
  observeRateLimit(options, ctx, session, 'getReportDocument', result.headers);
  const doc = result.data as Partial<ReportDocument> | undefined;
  if (!doc || doc.reportDocumentId !== documentId || typeof doc.url !== 'string' || !doc.url.startsWith('https://')) return { reason: 'REPORT_MISMATCH' };
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(doc.url, { method: 'GET', signal: AbortSignal.timeout(DOCUMENT_TIMEOUT_MS) });
  } catch {
    // Обрыв и тайм-аут — повтор следующим заходом: курсор остаётся на документе, адрес возьмётся новый
    throw new ChannelCallError(channelError('NETWORK', 'BATCH', 'report document download failed'));
  }
  if (response.status >= 500) throw new ChannelCallError(channelError('CHANNEL_UNAVAILABLE', 'BATCH', `report document download: ${response.status}`, { httpStatus: response.status }));
  if (!response.ok) return { reason: 'REPORT_DOCUMENT' };
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > REPORT_DOCUMENT_MAX_BYTES) return { reason: 'REPORT_DOCUMENT' };
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > REPORT_DOCUMENT_MAX_BYTES) return { reason: 'REPORT_DOCUMENT' };
  const decoded = decodeReportDocument(bytes, doc.compressionAlgorithm, response.headers.get('content-type'));
  if (!decoded.ok) return { reason: decoded.reason };
  const parsed = parseListingsReport(decoded.text);
  if (!parsed.ok) return { reason: parsed.reason };
  logConservative(options.deps.logger, ctx, 'AMZ_C16_LISTINGS_REPORT', { outcome: 'PARSED', skus: parsed.skus.length, rows: parsed.rows, badRows: parsed.badRows,
    duplicates: parsed.duplicates, unknownColumns: parsed.unknownColumns.join(',').slice(0, 200) });
  if (kept.size >= DOCUMENTS_KEPT) kept.delete(kept.keys().next().value!);
  kept.set(key, parsed.skus);
  return parsed.skus;
}
