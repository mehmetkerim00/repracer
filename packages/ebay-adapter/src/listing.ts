import type { AdapterCallContext, CompetitorQuery, CompetitorReadResult, DiscoveredOffer, InboundDelivery, InboundResult, Instant, OrderLine, Page, PageRequest } from '@repracer/channel-port';
import { logConservative } from './conservative.ts';
import { FULFILLMENT_ORDER_PATH, INVENTORY_PATH, marketplaceInfo } from './descriptor.ts';
import { ChannelCallError, channelError, classifyHttpFailure, firstRestError } from './errors.ts';
import { LISTING_ID_RE, moneyOf } from './mapping.ts';
import type { EbayOffer } from './readback.ts';
import { call, nowMs, openSession, type ResolvedOptions, type Session } from './session.ts';

/** Страница inventory_item: limit до 100 — наш предел; offset — курсор [песочница: ответ offer?sku= несёт limit 20 по умолчанию] */
const INVENTORY_PAGE_MAX = 100;
/** Страница GetMyeBaySelling: EntriesPerPage — наш предел (предел канала не проверялся, E-19) */
const TRADING_PAGE_MAX = 100;

interface InventoryItem { sku?: string; condition?: string; product?: { ean?: unknown; upc?: unknown } }

const XMLNS = 'urn:ebay:apis:eBLBaseComponents';

/** Запрос активных листингов продавца Trading API — ровно так вызывала песочница 27.09.2026 */
export function getMyeBaySellingRequest(pageNumber: number, entriesPerPage: number): string {
  return `<?xml version="1.0" encoding="utf-8"?><GetMyeBaySellingRequest xmlns="${XMLNS}"><ActiveList><Include>true</Include>`
    + `<Pagination><EntriesPerPage>${entriesPerPage}</EntriesPerPage><PageNumber>${pageNumber}</PageNumber></Pagination></ActiveList>`
    + '<DetailLevel>ReturnAll</DetailLevel></GetMyeBaySellingRequest>';
}

function tag(xml: string, name: string): string | null {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? m[1]! : null;
}
function attr(xml: string, name: string, attribute: string): string | null {
  return new RegExp(`<${name}\\s[^>]*${attribute}="([^"]*)"`).exec(xml)?.[1] ?? null;
}

/**
 * Курсор обнаружения — две фазы подряд: `<offset>` — страницы Inventory API (писать можно), `trd:<витрина>:<страница>` — активные
 * листинги Trading API (GetMyeBaySelling) по каждой витрине аккаунта: там и старые листинги, которые Inventory API не видит.
 */
/**
 * Ревью шага 47, находка 7: номера листингов, отданных фазой Inventory, едут в курсоре (`~id,id,…`) — фаза Trading исключает их
 * без `offer?sku=` на каждый предмет. Набор ограничен: больше MAX_CARRIED номеров — курсор несёт `~*`, и фаза Trading проверяет
 * каждый предмет с SKU прежним способом. `known: null` — набор неизвестен (переполнение или курсор без набора).
 */
type Known = ReadonlySet<string> | null;
type DiscoveryCursor = { phase: 'INVENTORY'; offset: number; known: Known } | { phase: 'TRADING'; marketplace: number; page: number; known: Known };
export const MAX_CARRIED_LISTINGS = 500;

function parseKnown(tail: string | undefined, fresh: boolean): Known {
  if (tail === undefined) return fresh ? new Set() : null;
  if (tail === '*') return null;
  return new Set(tail.split(',').filter((x) => LISTING_ID_RE.test(x)));
}
function knownTail(known: Known): string {
  return known === null || known.size > MAX_CARRIED_LISTINGS ? '~*' : known.size === 0 ? '~' : `~${[...known].join(',')}`;
}

/**
 * Шаг 55 (OQ-240): квота приложения, которую расходует страница обхода. Фаза Trading (`trd:…`) — суточная квота Trading API на приложение
 * (5 000 по умолчанию, vendor/ebay/2026-09-28/api-call-limits.html); фаза Inventory — 2 млн в сутки, её бюджетом ядро не ограничивает
 */
export const EBAY_TRADING_QUOTA = 'EBAY_TRADING';
export function discoveryQuotaOfEbay(cursor: string | undefined): string | null {
  return cursor !== undefined && parseCursor(cursor).phase === 'TRADING' ? EBAY_TRADING_QUOTA : null;
}

function parseCursor(cursor: string | undefined): DiscoveryCursor {
  const [head, tail] = (cursor ?? '').split('~', 2) as [string, string | undefined];
  const t = /^trd:(\d{1,2}):(\d{1,6})$/.exec(head);
  if (t) return { phase: 'TRADING', marketplace: Number(t[1]), page: Math.max(1, Number(t[2])), known: parseKnown(tail, false) };
  // Первая страница — набор пуст и известен; старый курсор без набора (до шага 47) — набор неизвестен, фаза Trading проверит сама
  return { phase: 'INVENTORY', offset: /^\d{1,9}$/.test(head) ? Number(head) : 0, known: parseKnown(tail, cursor === undefined || cursor === '') };
}

/**
 * Офферы аккаунта — ВСЕ активные листинги [Р-164, шаг 47]. Фаза 1: страница товаров Inventory API, затем предложения каждого SKU
 * (`offer?sku=`) — опубликованные предложения с фиксированной ценой, `writable: true`. Фаза 2: GetMyeBaySelling Trading API по витринам
 * аккаунта — листинги, которых Inventory API не знает: старая фиксированная цена (`writable: false`, её пишет только миграция владельцем)
 * и аукционы (`AUCTION`, не управляются никогда, Р-2). Листинг, у SKU которого есть предложение Inventory API с тем же номером, уже отдан
 * фазой 1 и здесь пропускается: курсор без состояния, поэтому это проверяется тем же `offer?sku=`, а не памятью процесса.
 */
export async function discoverOffersEbay(options: ResolvedOptions, ctx: AdapterCallContext, page: PageRequest): Promise<Page<DiscoveredOffer>> {
  const opened = await openSession(options, ctx);
  if (!opened.ok) throw new ChannelCallError(opened.error);
  const { session } = opened;
  const cursor = parseCursor(page.cursor);
  return cursor.phase === 'INVENTORY'
    ? discoverInventory(options, ctx, session, cursor.offset, Math.max(1, Math.min(page.limit, INVENTORY_PAGE_MAX)), cursor.known)
    : discoverTrading(options, ctx, session, cursor.marketplace, cursor.page, Math.max(1, Math.min(page.limit, TRADING_PAGE_MAX)), cursor.known);
}

/** Предложения Inventory API одного SKU; null — у SKU предложений нет (404 25713, песочница) */
async function offersOfSku(options: ResolvedOptions, ctx: AdapterCallContext, session: Session, sku: string): Promise<EbayOffer[] | null> {
  const offersRead = await call(options, ctx, session, { auth: 'USER', method: 'GET', path: `${INVENTORY_PATH}/offer`, query: { sku }, operation: 'getOffers' });
  if (offersRead.kind === 'REFUSED') throw new ChannelCallError(offersRead.error);
  const r = offersRead.result;
  if (r.status === 404 && firstRestError(r.body)?.errorId === 25713) return null;
  if (!r.ok) throw new ChannelCallError(classifyHttpFailure(r.status, r.body, 'BATCH', nowMs(options)));
  return ((r.body ?? {}) as { offers?: EbayOffer[] }).offers ?? [];
}

/** Витрины eBay аккаунта в порядке аккаунта — порядок фаз Trading в курсоре */
const ebayMarketplacesOf = (session: Session): string[] => session.account.marketplaces.filter((m) => marketplaceInfo(m));

/**
 * Шаг 52 (Growth Check: «не ломаться, если eBay изменит число элементов на странице»): следующее смещение страниц limit/offset.
 * Прежде бралось `offset + limit`: страница КОРОЧЕ запрошенной (канал урезал limit) при `total` больше — перепрыгивала через
 * `limit − пришедшее` записей, и они терялись. Теперь:
 * - есть `next` (адрес следующей страницы) со смещением впереди текущего — смещение из него;
 * - иначе пришли записи — `offset + пришедшее`, пока не достигнут `total` (без `total` — пока страница полная);
 * - пустая страница без `next` — конец: продвинуться нечем, повтор того же смещения зациклил бы обход.
 */
export function nextOffsetOf(offset: number, returned: number, limit: number, next: unknown, total: unknown): number | null {
  if (typeof next === 'string' && next.length > 0) {
    const m = /[?&]offset=(\d{1,9})(?:&|$)/.exec(next);
    const fromNext = m ? Number(m[1]) : null;
    if (fromNext !== null && fromNext > offset) return fromNext;
    if (returned > 0) return offset + returned;
    return null;
  }
  if (returned === 0) return null;
  const after = offset + returned;
  if (typeof total === 'number') return after < total ? after : null;
  return returned >= limit ? after : null;
}

async function discoverInventory(options: ResolvedOptions, ctx: AdapterCallContext, session: Session, offset: number, limit: number, carried: Known): Promise<Page<DiscoveredOffer>> {
  const known: Set<string> | null = carried === null ? null : new Set(carried);
  const itemsRead = await call(options, ctx, session, { auth: 'USER', method: 'GET', path: `${INVENTORY_PATH}/inventory_item`, query: { limit, offset }, operation: 'getInventoryItems' });
  if (itemsRead.kind === 'REFUSED') throw new ChannelCallError(itemsRead.error);
  if (!itemsRead.result.ok) throw new ChannelCallError(classifyHttpFailure(itemsRead.result.status, itemsRead.result.body, 'BATCH', nowMs(options)));
  const body = (itemsRead.result.body ?? {}) as { total?: number; next?: unknown; inventoryItems?: InventoryItem[] };
  const items: DiscoveredOffer[] = [];
  for (const item of body.inventoryItems ?? []) {
    if (typeof item.sku !== 'string' || item.sku.length === 0) continue;
    const offers = await offersOfSku(options, ctx, session, item.sku);
    if (offers === null) continue;
    const gtins = [item.product?.ean, item.product?.upc].flatMap((g) => (Array.isArray(g) ? g.filter((x): x is string => typeof x === 'string') : []));
    for (const o of offers) {
      const marketplace = o.marketplaceId;
      const listingId = o.listing?.listingId;
      if (!marketplace || !marketplaceInfo(marketplace) || !session.account.marketplaces.includes(marketplace)) continue;
      if (o.format !== 'FIXED_PRICE' || !listingId || typeof o.offerId !== 'string') continue;
      const price = moneyOf(o.pricingSummary?.price, marketplace);
      known?.add(listingId);
      items.push({
        identity: { marketplace, externalSku: item.sku, externalOfferId: o.offerId, externalListingId: listingId },
        gtins, condition: (item.condition ?? 'NEW').toLowerCase(), fulfillment: 'MERCHANT',
        ...(price ? { currentPrice: price } : {}),
        ...(Number.isSafeInteger(o.availableQuantity) ? { currentQuantity: o.availableQuantity! } : {}),
        ...(o.listing?.listingStatus ? { isLive: o.listing.listingStatus === 'ACTIVE' } : {}),
        // Под Inventory API: запись идёт по offerId (Р-164)
        listing: { format: 'FIXED_PRICE', writable: true },
        // Собственного ценообразования канала у eBay этот адаптер не видит — поля нет, а не «нет» [Р-120]
      });
    }
  }
  const next = nextOffsetOf(offset, (body.inventoryItems ?? []).length, limit, body.next, body.total);
  if (next !== null) return { items, nextCursor: `${next}${knownTail(known)}` };
  // Фаза Inventory окончена — дальше старые листинги и аукционы Trading API, начиная с первой витрины аккаунта
  return { items, ...(ebayMarketplacesOf(session).length > 0 ? { nextCursor: `trd:0:1${knownTail(known)}` } : {}) };
}

async function discoverTrading(options: ResolvedOptions, ctx: AdapterCallContext, session: Session, mpIndex: number, pageNumber: number, perPage: number, known: Known): Promise<Page<DiscoveredOffer>> {
  const marketplaces = ebayMarketplacesOf(session);
  const marketplace = marketplaces[mpIndex];
  if (!marketplace) return { items: [] };
  const info = marketplaceInfo(marketplace)!;
  const r = await call(options, ctx, session, {
    auth: 'USER', method: 'POST', path: '', body: getMyeBaySellingRequest(pageNumber, perPage),
    trading: { callName: 'GetMyeBaySelling', siteId: info.tradingSiteId }, idempotent: true, operation: 'GetMyeBaySelling',
  });
  if (r.kind === 'REFUSED') throw new ChannelCallError(r.error);
  if (!r.result.ok || typeof r.result.body !== 'string') throw new ChannelCallError(classifyHttpFailure(r.result.status, r.result.body, 'BATCH', nowMs(options)));
  const xml = r.result.body;
  const ack = tag(xml, 'Ack');
  if (ack !== 'Success' && ack !== 'Warning') {
    throw new ChannelCallError(channelError('UNKNOWN', 'BATCH', `GetMyeBaySelling: ${tag(xml, 'ErrorCode') ?? '?'} ${(tag(xml, 'ShortMessage') ?? `Ack ${ack ?? 'missing'}`).slice(0, 200)}`, { raiseAlert: true }));
  }
  const active = tag(xml, 'ActiveList') ?? '';
  const items: DiscoveredOffer[] = [];
  let byCurrency = 0;
  let skippedSite = 0;
  let unknownType = 0;
  let checkedBySku = 0;
  for (const m of active.matchAll(/<Item>([\s\S]*?)<\/Item>/g)) {
    const item = m[1]!;
    const listingId = tag(item, 'ItemID');
    if (!listingId || !LISTING_ID_RE.test(listingId)) continue;
    const type = tag(item, 'ListingType');
    // Ревью шага 47, находка 3: другой формат (объявление, вариант, которого песочница не показала) не угадывается — считается в журнале
    if (type !== 'Chinese' && type !== 'FixedPriceItem') { unknownType += 1; continue; }
    /**
     * [EBAY_C16, E-19] У предметов GetMyeBaySelling нет поля витрины (песочница): витрина — та, для которой сделан вызов (сайт
     * Trading), и только если валюта цены совпадает с валютой витрины; вызов для второй витрины аккаунта отдаёт те же листинги, и
     * валюта не даёт отнести листинг EBAY_DE к EBAY_US. Без валюты у аккаунта с несколькими витринами листинг пропускается, а не угадывается.
     */
    const currency = attr(item, 'CurrentPrice', 'currencyID') ?? attr(item, 'BuyItNowPrice', 'currencyID');
    if (currency ? currency !== info.currency : marketplaces.length > 1) { skippedSite += 1; continue; }
    if (currency) byCurrency += 1;
    const sku = tag(item, 'SKU');
    // Листинг под Inventory API уже отдан фазой 1 (там — с offerId и правом записи): по набору из курсора, без него — по offer?sku=
    if (known !== null) {
      if (known.has(listingId)) continue;
    } else if (sku) {
      checkedBySku += 1;
      const offers = await offersOfSku(options, ctx, session, sku);
      if (offers?.some((o) => o.listing?.listingId === listingId)) continue;
    }
    // Листинг без SKU (старые листинги Trading его не обязаны иметь) отдаётся с одним номером листинга: писать в него нельзя
    const auction = type === 'Chinese';
    const priceText = tag(item, 'CurrentPrice') ?? tag(item, 'BuyItNowPrice');
    const price = auction ? null : moneyOf({ value: priceText ?? undefined, currency: currency ?? info.currency }, marketplace);
    const available = Number(tag(item, 'QuantityAvailable') ?? tag(item, 'Quantity'));
    items.push({
      identity: { marketplace, externalListingId: listingId, ...(sku ? { externalSku: sku } : {}) },
      gtins: [], condition: 'new', fulfillment: 'MERCHANT', isLive: true,
      ...(price ? { currentPrice: price } : {}),
      ...(Number.isSafeInteger(available) && available >= 0 ? { currentQuantity: available } : {}),
      listing: { format: auction ? 'AUCTION' : 'FIXED_PRICE', writable: false },
    });
  }
  logConservative(options.deps.logger, ctx, 'EBAY_C16_TRADING_LISTING_SITE', { marketplace, page: pageNumber, byCurrency, skippedSite, unknownType, checkedBySku, legacy: items.length });
  const pagination = tag(active, 'PaginationResult') ?? '';
  const pages = Number(tag(pagination, 'TotalNumberOfPages') ?? NaN);
  const entries = Number(tag(pagination, 'TotalNumberOfEntries') ?? NaN);
  const totalPages = Number.isSafeInteger(pages) ? pages : Number.isSafeInteger(entries) ? Math.ceil(entries / perPage) : pageNumber;
  const tail = known === null ? '' : knownTail(known);
  if (pageNumber < totalPages) return { items, nextCursor: `trd:${mpIndex}:${pageNumber + 1}${tail}` };
  return { items, ...(mpIndex + 1 < marketplaces.length ? { nextCursor: `trd:${mpIndex + 1}:1${tail}` } : {}) };
}

// ------------------------------------------------------------------------------------------------ заказы (Fulfillment API)

const ORDER_PAGE_MAX = 200;

/**
 * [EBAY_C17, E-20] Поля заказа Fulfillment API — НЕ из снимка спецификации (E-01) и не из песочницы: (проверить) по документации.
 * Читается ТОЛЬКО белый список (Р-4): orderId, creationDate, orderFulfillmentStatus, cancelStatus.cancelState, lineItems[].lineItemId,
 * sku, legacyItemId, quantity, lineItemFulfillmentStatus, listingMarketplaceId. Покупатель, адрес доставки, почта в структуру не
 * копируются вовсе. Нет нужного поля или непонятное значение — строка пропускается с кодом журнала, а не угадывается.
 */
interface WhitelistedLine { lineItemId: string; sku: string | null; listingId: string | null; quantity: number; status: string | null; marketplace: string | null }
interface WhitelistedOrder { orderId: string; creationDate: string; cancelState: string | null; lines: WhitelistedLine[] }

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 && v.length <= 200 ? v : null);

function whitelistOrder(raw: unknown): { order: WhitelistedOrder | null; missing: string | null } {
  const o = (raw ?? {}) as Record<string, unknown>;
  const orderId = str(o.orderId);
  const creationDate = str(o.creationDate);
  if (!orderId) return { order: null, missing: 'orderId' };
  if (!creationDate || Number.isNaN(Date.parse(creationDate))) return { order: null, missing: 'creationDate' };
  const cancel = (o.cancelStatus ?? {}) as Record<string, unknown>;
  const lines: WhitelistedLine[] = [];
  for (const l of Array.isArray(o.lineItems) ? o.lineItems : []) {
    const x = (l ?? {}) as Record<string, unknown>;
    lines.push({
      lineItemId: str(x.lineItemId) ?? '', sku: str(x.sku), listingId: str(x.legacyItemId),
      quantity: typeof x.quantity === 'number' ? x.quantity : Number.NaN, status: str(x.lineItemFulfillmentStatus), marketplace: str(x.listingMarketplaceId),
    });
  }
  return { order: { orderId, creationDate, cancelState: str(cancel.cancelState), lines }, missing: null };
}

/**
 * Заказы, ИЗМЕНЁННЫЕ с `since`: страницы Fulfillment API по limit/offset, остановка по `next`/`total`; курсор — смещение.
 * Ревью шага 47, находка 1: окно — по времени изменения заказа (`lastmodifieddate`, (проверить), E-20), а не создания: отгрузка
 * или отмена заказа, созданного до окна, иначе не читалась бы никогда — резервация не списывалась, остаток завышался (перепродажа).
 * Строка, пропущенная из-за незнакомого статуса, читается снова при СЛЕДУЮЩЕМ изменении заказа (оно двигает lastmodifieddate);
 * до того пропуск виден числом в журнале EBAY_C17 (skipped_lineItemFulfillmentStatus).
 */
export async function readOrderLinesEbay(options: ResolvedOptions, ctx: AdapterCallContext, window: { since: Instant } & PageRequest): Promise<Page<OrderLine>> {
  const opened = await openSession(options, ctx);
  if (!opened.ok) throw new ChannelCallError(opened.error);
  const { session } = opened;
  const offset = window.cursor && /^\d{1,9}$/.test(window.cursor) ? Number(window.cursor) : 0;
  const limit = Math.max(1, Math.min(window.limit, ORDER_PAGE_MAX));
  const since = new Date(Date.parse(window.since)).toISOString();
  const r = await call(options, ctx, session, {
    auth: 'USER', method: 'GET', path: FULFILLMENT_ORDER_PATH, query: { filter: `lastmodifieddate:[${since}..]`, limit, offset }, operation: 'getOrders',
  });
  if (r.kind === 'REFUSED') throw new ChannelCallError(r.error);
  if (!r.result.ok) throw new ChannelCallError(classifyHttpFailure(r.result.status, r.result.body, 'BATCH', nowMs(options)));
  const body = (r.result.body ?? {}) as { total?: unknown; next?: unknown; orders?: unknown };
  const marketplaces = ebayMarketplacesOf(session);
  const items: OrderLine[] = [];
  const skipped: Record<string, number> = {};
  const skip = (why: string) => { skipped[why] = (skipped[why] ?? 0) + 1; };
  for (const raw of Array.isArray(body.orders) ? body.orders : []) {
    const { order, missing } = whitelistOrder(raw);
    if (!order) { skip(`order.${missing}`); continue; }
    for (const line of order.lines) {
      if (!line.lineItemId) { skip('lineItemId'); continue; }
      if (!Number.isSafeInteger(line.quantity) || line.quantity <= 0) { skip('quantity'); continue; }
      if (!line.sku && !line.listingId) { skip('sku_and_legacyItemId'); continue; }
      // Витрина: у строки — listingMarketplaceId (проверить), иначе единственная витрина аккаунта; при нескольких — не угадываем
      const marketplace = line.marketplace ?? (marketplaces.length === 1 ? marketplaces[0]! : null);
      if (!marketplace || !marketplaces.includes(marketplace)) { skip('marketplace'); continue; }
      let status: OrderLine['status'];
      if (order.cancelState === 'CANCELED') status = 'CANCELLED';
      else if (line.status === 'FULFILLED') status = 'SHIPPED';
      // Возвраты не читаются (E-20): не отменённая и не отгруженная строка — OPEN
      else if (line.status === 'NOT_STARTED' || line.status === 'IN_PROGRESS' || line.status === null) status = 'OPEN';
      else { skip('lineItemFulfillmentStatus'); continue; }
      items.push({
        externalOrderRef: order.orderId, externalOrderLineRef: line.lineItemId, quantity: line.quantity, orderedAt: new Date(Date.parse(order.creationDate)).toISOString() as Instant, status,
        identity: { marketplace, ...(line.sku ? { externalSku: line.sku } : {}), ...(line.listingId ? { externalListingId: line.listingId } : {}) },
      });
    }
  }
  // Только коды и числа — ни номера заказа, ни данных покупателя (Р-4)
  logConservative(options.deps.logger, ctx, 'EBAY_C17_ORDER_FIELDS_UNVERIFIED', { lines: items.length, skipped: Object.values(skipped).reduce((a, b) => a + b, 0),
    ...Object.fromEntries(Object.entries(skipped).map(([k, v]) => [`skipped_${k}`, v])) });
  const next = nextOffsetOf(offset, Array.isArray(body.orders) ? body.orders.length : 0, limit, body.next, body.total);
  return { items, ...(next !== null ? { nextCursor: String(next) } : {}) };
}

const UNSUPPORTED_WHY = {
  competitors: 'eBay competitors are not read in step 39: no specification snapshot of a competitor source (E-01); the eBay descriptor declares no competitor source and MANUAL_ONLY halt release',
  inbound: 'eBay notifications are not received in step 39: no notification topic was verified in the sandbox (Notification API, Platform Notifications)',
} as const;

function logUnsupported(options: ResolvedOptions, ctx: Pick<AdapterCallContext, 'correlationId' | 'tenantId' | 'channelAccountId'> | null, what: keyof typeof UNSUPPORTED_WHY): void {
  options.deps.logger.log({
    level: 'INFO', code: 'EBAY_UNSUPPORTED', message: UNSUPPORTED_WHY[what],
    ...(ctx ? { correlationId: ctx.correlationId, tenantId: ctx.tenantId, channelAccountId: ctx.channelAccountId } : {}), details: { operation: what },
  });
}

/** Конкуренты: отказ по каждому запросу, а не пустой снимок — пустота выглядела бы как «конкурентов нет» */
export async function readCompetitorsEbay(options: ResolvedOptions, ctx: AdapterCallContext, queries: readonly CompetitorQuery[]): Promise<CompetitorReadResult> {
  if (queries.length > 0) logUnsupported(options, ctx, 'competitors');
  return { snapshots: [], failures: queries.map((query) => ({ query, error: channelError('UNSUPPORTED', 'ITEM', UNSUPPORTED_WHY.competitors) })) };
}

/** Входящие: ни один адрес eBay в этом шаге не заведён — любая доставка отклоняется, тело не разбирается */
export async function handleInboundEbay(options: ResolvedOptions, delivery: InboundDelivery): Promise<InboundResult> {
  logUnsupported(options, { correlationId: `inbound:${delivery.receivedAt}`, tenantId: delivery.claimed.tenantId, channelAccountId: delivery.claimed.channelAccountId }, 'inbound');
  return { kind: 'REJECTED', error: channelError('UNSUPPORTED', 'BATCH', UNSUPPORTED_WHY.inbound), responseStatus: 501 };
}
