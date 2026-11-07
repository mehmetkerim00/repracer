import type { AdapterCallContext, BuyboxSegment, CompetitorOffer, CompetitorQuery, CompetitorReadResult, CompetitorSnapshot, DiscoveredOffer, Instant, Money, OrderLine, Page, PageRequest, PriceBasis } from '@repracer/channel-port';
import type { CompetitiveSummaryBatchRequest, CompetitiveSummaryBatchResponse, CompetitiveSummaryResponseBody, InventorySummariesResponse, ItemSearchResults, MoneyType, OrderItemRecord, OrderRecord, PricingOffer, SearchOrdersResponse } from '@repracer/amazon-client';
import { holderByViewShare } from '@repracer/pricing-model';
import { logConservative } from './conservative.ts';
import { AMAZON_MARKETPLACES, COMPETITIVE_SUMMARY_BATCH_MAX, COMPETITIVE_SUMMARY_PATH, FBA_SUMMARIES_PATH, FBA_SUMMARIES_SKUS_MAX, marketplaceInfo, ORDERS_PAGE_MAX, ORDERS_PATH, SEARCH_PAGE_MAX, SOURCE_COMPETITIVE_SUMMARY } from './descriptor.ts';
import { ChannelCallError, channelError, classifyFailure } from './errors.ts';
import { channelOwnedPricing, decimalToMinor, fulfillmentOf, merchantQuantity, offerTitle, purchasePrice } from './mapping.ts';
import { acquire, deadlinePassed, nowMs, observeRateLimit, openSession, type AmazonAdapterOptions, type Session } from './session.ts';

/**
 * Шаг 117: одна страница searchListingsItems — по витринам (`pageToken` — курсор канала) или по SKU (`identifiers`, до 20, тип SKU; отчёт листингов назвал SKU,
 * подробности — этим же запросом и этим же разбором). Записи обнаружения одинаковы на обоих путях: наборы summaries, attributes (Р-120), offers,
 * fulfillmentAvailability
 */
export async function searchListingsPage(options: AmazonAdapterOptions, ctx: AdapterCallContext, session: Session, request: {
  marketplaces: readonly string[]; pageSize: number; pageToken?: string | null; skus?: readonly string[];
}): Promise<{ items: DiscoveredOffer[]; nextToken: string | null; numberOfResults: number | null; returnedSkus: Set<string> }> {
  const budget = acquire(options, ctx, session, 'searchListingsItems');
  if (budget) throw new ChannelCallError(budget);
  const result = await session.client.request<ItemSearchResults>('GET', `/listings/2021-08-01/items/${encodeURIComponent(session.sellerId)}`, {
    // Р-120: attributes — чтобы продавец видел правило автоматического ценообразования до назначения стратегии
    query: { marketplaceIds: request.marketplaces, includedData: ['summaries', 'attributes', 'offers', 'fulfillmentAvailability'],
      pageSize: Math.max(1, Math.min(request.pageSize, SEARCH_PAGE_MAX)),
      ...(request.skus ? { identifiers: request.skus, identifiersType: 'SKU' } : {}),
      ...(request.pageToken ? { pageToken: request.pageToken } : {}) },
  });
  if (!result.ok) throw new ChannelCallError(classifyFailure(result, 'BATCH', nowMs(options)));
  observeRateLimit(options, ctx, session, 'searchListingsItems', result.headers);
  const marketplaces = request.marketplaces;
  /**
   * Шаг 70 [Р-205, AMZ_C15]: предмет без sku и сводки витрин вне запроса в каталог не попадают — каталог не получит предложения витрины,
   * которой у аккаунта нет. Ревью шага 70, находка 3: пропускаются поштучно с журналом, а не страницей целиком — отказ страницы на одном
   * предмете остановил бы обход навсегда (первая страница — каталога нет вовсе, N-я — круг не закрывается). Шаг 117: у поиска по SKU предмет
   * с SKU вне запроса — тоже чужой ответ, пропускается так же
   */
  const skipped = { noSku: 0, foreignSummaries: 0, foreignSku: 0 };
  const foreignSeen = new Set<string>();
  const asked = request.skus ? new Set(request.skus) : null;
  const pageItems = (result.data.items ?? []).filter((item) => {
    if (typeof item.sku !== 'string' || item.sku === '') { skipped.noSku += 1; return false; }
    if (asked && !asked.has(item.sku)) { skipped.foreignSku += 1; return false; }
    return true;
  });
  const items: DiscoveredOffer[] = [];
  // Шаг 51 [AMZ_C13]: FBA — по коду сети исполнения; SKU сети Amazon по витринам — для чтения количества FBA
  const fbaByMarketplace = new Map<string, string[]>();
  let unknownFulfillment = 0;
  for (const item of pageItems) {
    const quantity = merchantQuantity(item);
    const fulfillment = fulfillmentOf(item);
    if (fulfillment.kind === 'UNKNOWN') unknownFulfillment += 1;
    for (const s of item.summaries ?? []) {
      if (!marketplaces.includes(s.marketplaceId)) {
        skipped.foreignSummaries += 1;
        foreignSeen.add(String(s.marketplaceId).slice(0, 20));
        continue;
      }
      const price = purchasePrice(item, s.marketplaceId);
      const owned = channelOwnedPricing(item, s.marketplaceId);
      /**
       * Шаг 69 (OQ-249): название — `itemName` сводки витрины (набор summaries уже запрошен): vendor/amazon/sp-api-models/2026-09-29/models/
       * listings-items-api-model/listingsItems_2021-08-01.json, definitions.ItemSummaryByMarketplace.properties.itemName — «Name, or title,
       * associated with an Amazon catalog item», необязательное. В типе клиента поля нет — читается защитно
       */
      const title = offerTitle((s as { itemName?: unknown }).itemName);
      if (fulfillment.kind === 'AMAZON') fbaByMarketplace.set(s.marketplaceId, [...(fbaByMarketplace.get(s.marketplaceId) ?? []), item.sku]);
      items.push({
        identity: { region: session.region, marketplace: s.marketplaceId, externalSku: item.sku, ...(s.asin ? { channelProductRef: s.asin } : {}) },
        gtins: [], condition: (s as { conditionType?: string }).conditionType?.split('_')[0] ?? 'new',
        ...(title !== undefined ? { title } : {}),
        // Неизвестный способ — CHANNEL: количество по нему не пишется (fail-closed)
        fulfillment: fulfillment.kind === 'MERCHANT' ? 'MERCHANT' : 'CHANNEL',
        ...(price ? { currentPrice: price } : {}), ...(quantity !== null ? { currentQuantity: quantity } : {}),
        ...(s.status ? { isLive: s.status.includes('BUYABLE') } : {}),
        // Шаг 114: статус сводки витрины — наблюдение «статус листинга»; проблемы обнаружение не запрашивает
        ...(s.status ? { listingStatus: { status: { buyable: s.status.includes('BUYABLE'), discoverable: s.status.includes('DISCOVERABLE'), deleted: false }, issues: null } } : {}),
        channelPricing: { automatedPricing: owned.repricer, channelBounds: owned.bounds },
      });
    }
  }
  if (fbaByMarketplace.size > 0 || unknownFulfillment > 0) {
    const fba = await readFbaQuantities(options, ctx, session, fbaByMarketplace);
    for (const offer of items) {
      const q = offer.fulfillment === 'CHANNEL' && offer.identity.marketplace ? fba.get(`${offer.identity.marketplace}|${offer.identity.externalSku}`) : undefined;
      if (q !== undefined) offer.currentQuantity = q;
    }
    logConservative(options.deps.logger, ctx, 'AMZ_C13_FBA_BY_CHANNEL_CODE', {
      fba: [...fbaByMarketplace.values()].reduce((a, b) => a + b.length, 0), unknown: unknownFulfillment, fbaQuantitiesRead: fba.size });
  }
  if (skipped.noSku > 0 || skipped.foreignSummaries > 0 || skipped.foreignSku > 0) {
    logConservative(options.deps.logger, ctx, 'AMZ_C15_RESPONSE_IDENTITY', { stage: 'DISCOVERY', itemsWithoutSku: skipped.noSku, foreignSummaries: skipped.foreignSummaries,
      foreignSkus: skipped.foreignSku, storefronts: [...foreignSeen].sort().join(',') });
  }
  const numberOfResults = typeof result.data.numberOfResults === 'number' && Number.isSafeInteger(result.data.numberOfResults) ? result.data.numberOfResults : null;
  return { items, nextToken: result.data.pagination?.nextToken ?? null, numberOfResults, returnedSkus: new Set(pageItems.map((i) => i.sku)) };
}

/**
 * Шаг 51: количество FBA — getInventorySummaries (FBA Inventory v1, снимок 2026-09-29): одна витрина на вызов, до 50 SKU. ТОЛЬКО чтение —
 * количеством FBA управляет Amazon [Р-6, AMZ_C14]; значение — fulfillableQuantity (можно отгрузить), не totalQuantity (с поставками в пути).
 * Сбой или бюджет — количество не показывается (обнаружение не падает: оффер найден, его количество неизвестно, а не 0)
 */
async function readFbaQuantities(options: AmazonAdapterOptions, ctx: AdapterCallContext, session: Session, byMarketplace: ReadonlyMap<string, readonly string[]>): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const [marketplace, skus] of byMarketplace) {
    for (let i = 0; i < skus.length; i += FBA_SUMMARIES_SKUS_MAX) {
      const part = skus.slice(i, i + FBA_SUMMARIES_SKUS_MAX);
      if (deadlinePassed(options, ctx) ?? acquire(options, ctx, session, 'getInventorySummaries')) return out;
      const r = await session.client.request<InventorySummariesResponse>('GET', FBA_SUMMARIES_PATH, {
        query: { details: 'true', granularityType: 'Marketplace', granularityId: marketplace, marketplaceIds: [marketplace], sellerSkus: part }, idempotent: true,
      });
      if (!r.ok) continue;
      observeRateLimit(options, ctx, session, 'getInventorySummaries', r.headers);
      const read = fbaQuantitiesOf(r.data, marketplace, part);
      if (read.mismatch || read.withoutSku > 0) {
        logConservative(options.deps.logger, ctx, 'AMZ_C15_RESPONSE_IDENTITY', { stage: 'FBA_SUMMARIES', kind: read.mismatch ?? 'NO_SKU', withoutSku: read.withoutSku });
      }
      // Шаг 70 [Р-205, AMZ_C15]: ответ не о той витрине или с чужим SKU — fbaQuantitiesOf не отдаёт из него НИ ОДНОГО количества (на экране
      // остаётся прежнее значение со своим временем, Р-196), а не чужое. Отдельный `continue` здесь был дублем — снят (мутация шага 70)
      for (const [sku, q] of read.quantities) out.set(`${marketplace}|${sku}`, q);
    }
  }
  return out;
}

/**
 * Разбор ответа getInventorySummaries (одна витрина, SKU части): количество — fulfillableQuantity. Шаг 70 [Р-205, AMZ_C15]: `granularityId`
 * (в модели снимка необязателен) — запрошенная витрина, `sellerSku` сводки — из запроса; ответ другой витрины или о чужом SKU не используется
 * целиком. Сводка без `sellerSku` (в модели необязателен) пропускается поштучно (ревью шага 70, находка 10). Вынесено ради проверки живьём
 * (динамическая песочница FBA Inventory) и юнит-теста
 */
export function fbaQuantitiesOf(response: InventorySummariesResponse | undefined, marketplace: string, skus: readonly string[]):
  { quantities: Map<string, number>; mismatch: 'STOREFRONT' | 'SKU' | null; withoutSku: number } {
  const quantities = new Map<string, number>();
  const granularityId = response?.payload?.granularity?.granularityId;
  if (granularityId !== undefined && granularityId !== marketplace) return { quantities, mismatch: 'STOREFRONT', withoutSku: 0 };
  let withoutSku = 0;
  for (const summary of response?.payload?.inventorySummaries ?? []) {
    if (summary.sellerSku === undefined) { withoutSku += 1; continue; }
    if (!skus.includes(summary.sellerSku)) return { quantities: new Map(), mismatch: 'SKU', withoutSku };
    const q = summary.inventoryDetails?.fulfillableQuantity;
    if (Number.isSafeInteger(q) && (q as number) >= 0) quantities.set(summary.sellerSku, q as number);
  }
  return { quantities, mismatch: null, withoutSku };
}

/**
 * Шаг 51 [AMZ_C12, A-20]: строки заказов — searchOrders (Orders 2026-01-01). Окно — по времени ИЗМЕНЕНИЯ заказа (lastUpdatedAfter), как у eBay
 * после ревью шага 47: отгрузка или отмена заказа, созданного до окна, иначе не читалась бы. Только заказы продавца (fulfilledBy=MERCHANT):
 * заказы FBA исполняет Amazon из своего остатка, наш пул они не трогают [Р-6]. Наборы — FULFILLMENT и CANCELLATION, без BUYER и RECIPIENT [Р-4];
 * из ответа берётся белый список, в журнал — только числа. Курсор — paginationToken ответа.
 */
export async function readOrderLinesAmazon(options: AmazonAdapterOptions, ctx: AdapterCallContext, window: { since: Instant } & PageRequest): Promise<Page<OrderLine>> {
  const opened = await openSession(options, ctx);
  if (!opened.ok) throw new ChannelCallError(opened.error);
  const { session } = opened;
  const marketplaces = session.account.marketplaces.filter((m) => marketplaceInfo(m)?.region === session.region);
  if (marketplaces.length === 0) return { items: [] };
  const refused = deadlinePassed(options, ctx) ?? acquire(options, ctx, session, 'searchOrders');
  if (refused) throw new ChannelCallError(refused);
  /**
   * Ревью шага 51, находка 1: со страницей — ВСЕ параметры первого запроса. Модель: «All other parameters must be provided with the same values
   * that were provided with the request that generated this token, with the exception of maxResultsPerPage and includedData». Окно `since`
   * вызывающий передаёт на каждой странице тем же (конвейер остатков), поэтому курсор — только токен канала
   */
  const result = await session.client.request<SearchOrdersResponse>('GET', ORDERS_PATH, {
    query: { lastUpdatedAfter: new Date(Date.parse(window.since)).toISOString(), marketplaceIds: marketplaces, fulfilledBy: ['MERCHANT'],
      includedData: ['FULFILLMENT', 'CANCELLATION'], maxResultsPerPage: Math.max(1, Math.min(window.limit, ORDERS_PAGE_MAX)),
      ...(window.cursor ? { paginationToken: window.cursor } : {}) },
    idempotent: true,
  });
  if (!result.ok) throw new ChannelCallError(classifyFailure(result, 'BATCH', nowMs(options)));
  observeRateLimit(options, ctx, session, 'searchOrders', result.headers);
  const items: OrderLine[] = [];
  const skipped: Record<string, number> = {};
  const skip = (why: string) => { skipped[why] = (skipped[why] ?? 0) + 1; };
  for (const order of result.data.orders ?? []) {
    const head = orderHead(order, marketplaces, session.region);
    if ('skip' in head) { skip(head.skip); continue; }
    for (const item of order.orderItems ?? []) {
      const line = orderLine(item, head);
      if ('skip' in line) skip(line.skip);
      else items.push(line.line);
    }
  }
  // Только коды и числа — ни номера заказа, ни данных покупателя [Р-4]
  logConservative(options.deps.logger, ctx, 'AMZ_C12_ORDERS_MERCHANT_WHITELIST', { lines: items.length, skipped: Object.values(skipped).reduce((a, b) => a + b, 0),
    ...Object.fromEntries(Object.entries(skipped).map(([k, v]) => [`skipped_${k}`, v])) });
  const next = result.data.pagination?.nextToken;
  return { items, ...(next ? { nextCursor: next } : {}) };
}

interface OrderHead { orderId: string; orderedAt: Instant; region: string; marketplace: string; status: string }

function orderHead(order: OrderRecord, marketplaces: readonly string[], region: string): OrderHead | { skip: string } {
  if (typeof order.orderId !== 'string' || order.orderId.length === 0) return { skip: 'orderId' };
  if (typeof order.createdTime !== 'string' || !Number.isFinite(Date.parse(order.createdTime))) return { skip: 'createdTime' };
  // Заказы вне Amazon (NON_AMAZON — например, исполнение для другого канала) — не заказы этой витрины
  if (order.salesChannel?.channelName !== 'AMAZON') return { skip: 'salesChannel' };
  const marketplace = order.salesChannel.marketplaceId;
  if (!marketplace || !marketplaces.includes(marketplace)) return { skip: 'marketplace' };
  // Запрос просил только MERCHANT; заказ, объявленный исполненным Amazon, пропускается и здесь
  if (order.fulfillment?.fulfilledBy !== undefined && order.fulfillment.fulfilledBy !== 'MERCHANT') return { skip: 'fulfilledBy' };
  const status = order.fulfillment?.fulfillmentStatus;
  if (typeof status !== 'string') return { skip: 'fulfillmentStatus' };
  return { orderId: order.orderId, orderedAt: new Date(Date.parse(order.createdTime)).toISOString() as Instant, region, marketplace, status };
}

const OPEN_ORDER_STATUSES: ReadonlySet<string> = new Set(['PENDING', 'PENDING_AVAILABILITY', 'UNSHIPPED', 'PARTIALLY_SHIPPED']);

function orderLine(item: OrderItemRecord, head: OrderHead): { line: OrderLine } | { skip: string } {
  if (typeof item.orderItemId !== 'string' || item.orderItemId.length === 0) return { skip: 'orderItemId' };
  const quantity = item.quantityOrdered;
  if (!Number.isSafeInteger(quantity) || (quantity as number) <= 0) return { skip: 'quantityOrdered' };
  const sku = item.product?.sellerSku;
  if (typeof sku !== 'string' || sku.length === 0) return { skip: 'sellerSku' };
  const fulfilled = item.fulfillment?.quantityFulfilled;
  let status: OrderLine['status'];
  if (head.status === 'CANCELLED' || item.cancellation?.cancellationExecution !== undefined) status = 'CANCELLED';
  else if (head.status === 'SHIPPED' || (Number.isSafeInteger(fulfilled) && (fulfilled as number) >= (quantity as number))) status = 'SHIPPED';
  // Частичная отгрузка строки — OPEN: резервация держится на всё количество до полной отгрузки (перепродажи нет)
  else if (OPEN_ORDER_STATUSES.has(head.status)) status = 'OPEN';
  else return { skip: `fulfillmentStatus_${head.status.replace(/[^A-Z_]/g, '').slice(0, 30) || 'OTHER'}` };
  return { line: {
    externalOrderRef: head.orderId, externalOrderLineRef: item.orderItemId, quantity: quantity as number, orderedAt: head.orderedAt, status,
    identity: { region: head.region, marketplace: head.marketplace, externalSku: sku, ...(item.product?.asin ? { channelProductRef: item.product.asin } : {}) },
  } };
}

/**
 * Шаг 115 [Р-240]: getCompetitiveSummary — источник решений [AMZ_C11]. Снимок источника AMAZON_COMPETITIVE_SUMMARY: предложения — lowestPricedOffers
 * New/Consumer; Buy Box — из `featuredBuyingOptions`: предложения по сегментам покупателей с долей просмотров [Р-235], цена и держатель — `buyboxOf`;
 * момент наблюдения — время ответа. Пакет — до 20 товаров одного региона сессии; ограничитель — операция getCompetitiveSummary (0.033 rps, burst 1,
 * на пару продавец-приложение). У предложения — цена с купоном, если канал её назвал [Р-234]. Набор шире — запросов не больше: лимит считается на вызов
 */
export async function readCompetitorsAmazon(options: AmazonAdapterOptions, ctx: AdapterCallContext, queries: readonly CompetitorQuery[]): Promise<CompetitorReadResult> {
  const failures: CompetitorReadResult['failures'] = [];
  const snapshots: CompetitorReadResult['snapshots'] = [];
  if (queries.length === 0) return { snapshots, failures };
  const opened = await openSession(options, ctx);
  if (!opened.ok) return { snapshots, failures: queries.map((query) => ({ query, error: opened.error })) };
  const { session } = opened;
  const supported: CompetitorQuery[] = [];
  for (const query of queries) {
    const m = marketplaceInfo(query.marketplace);
    if (query.condition !== 'new') {
      failures.push({ query, error: channelError('UNSUPPORTED', 'ITEM', 'the competitive summary poll reads the new condition only (AMZ_C11)') });
    } else if (!m || m.region !== session.region || !/^[A-Z0-9]{10}$/.test(query.channelProductRef)) {
      failures.push({ query, error: channelError('VALIDATION', 'ITEM', 'competitive summary query needs an ASIN of a storefront in the region of the account') });
    } else supported.push(query);
  }
  if (supported.length > 0) logConservative(options.deps.logger, ctx, 'AMZ_C11_COMPETITIVE_SUMMARY_POLL', { queries: supported.length });
  for (let i = 0; i < supported.length; i += COMPETITIVE_SUMMARY_BATCH_MAX) {
    const batch = supported.slice(i, i + COMPETITIVE_SUMMARY_BATCH_MAX);
    const rest = supported.slice(i);
    const refused = deadlinePassed(options, ctx) ?? acquire(options, ctx, session, 'getCompetitiveSummary');
    if (refused) {
      failures.push(...rest.map((query) => ({ query, error: refused })));
      break;
    }
    const body: CompetitiveSummaryBatchRequest = {
      requests: batch.map((q) => ({
        asin: q.channelProductRef, marketplaceId: q.marketplace, includedData: ['featuredBuyingOptions', 'lowestPricedOffers'], lowestPricedOffersInputs: [{ itemCondition: 'New', offerType: 'Consumer' }],
        method: 'GET', uri: '/products/pricing/2022-05-01/items/competitiveSummary',
      })),
    };
    // Чтение: повтор после сбоя безопасен; 429 не повторяется внутри вызова [Р-240]: у квоты раз в 30 секунд повтором станет следующий запуск работы
    const result = await session.client.request<CompetitiveSummaryBatchResponse>('POST', COMPETITIVE_SUMMARY_PATH, { body, idempotent: true, noThrottleRetry: true });
    if (!result.ok) {
      const error = classifyFailure(result, 'BATCH', nowMs(options));
      failures.push(...batch.map((query) => ({ query, error })));
      continue;
    }
    observeRateLimit(options, ctx, session, 'getCompetitiveSummary', result.headers);
    const observedAt = new Date(nowMs(options)).toISOString();
    for (const query of batch) {
      const r = (result.data.responses ?? []).find((x) => x.body?.asin === query.channelProductRef && x.body?.marketplaceId === query.marketplace);
      const status = r?.status?.statusCode ?? 0;
      if (!r || status !== 200) {
        const code = status === 404 ? 'NOT_FOUND' : status === 429 ? 'RATE_LIMITED' : status === 400 ? 'VALIDATION' : 'UNKNOWN';
        failures.push({ query, error: channelError(code, 'ITEM', `competitive summary answered ${status || 'nothing'} for the item: ${r?.body?.errors?.[0]?.code ?? 'no error code'}`) });
        continue;
      }
      const basis = marketplaceInfo(query.marketplace)!.basis;
      const lowest = (r.body.lowestPricedOffers ?? []).find((l) => l.lowestPricedOffersInput?.itemCondition === 'New' && l.lowestPricedOffersInput?.offerType === 'Consumer');
      const offers: CompetitorOffer[] = [];
      for (const o of lowest?.offers ?? []) {
        const offer = summaryOffer(o, session.sellerId, basis);
        if (offer) offers.push(offer);
      }
      const segments = buyboxSegmentsOf(r.body, session.sellerId);
      const buybox = buyboxOf(r.body, segments, session.sellerId, basis);
      // Держатель — в строках снимка: стратегия берёт у него доставку и исполнение. Вне наименьших предложений — добавляется: это настоящее предложение канала
      if (buybox?.holder) {
        const own = offers.filter((o) => (buybox.snapshot.isSelf ? o.isSelf : o.sellerRef === buybox.snapshot.sellerRef));
        if (own.length === 0) {
          const added = summaryOffer(buybox.holder, session.sellerId, basis);
          if (added) own.push(added), offers.push(added);
        }
        for (const o of own) o.holdsBuyBox = true;
      }
      snapshots.push({
        marketplace: query.marketplace, channelProductRef: query.channelProductRef, condition: 'new', source: SOURCE_COMPETITIVE_SUMMARY, observedAt,
        completeness: { kind: 'TOP_N', n: Math.max(1, offers.length) }, ...(buybox ? { buybox: buybox.snapshot } : {}), offers, ...(segments.length > 0 ? { buyboxSegments: segments } : {}),
      });
    }
  }
  return { snapshots, failures };
}

/** Предложение сводки как предложение снимка: цена нулевая или непонятная — строки нет; исполнение — только названное каналом [Р-226] */
function summaryOffer(o: PricingOffer, sellerId: string, basis: PriceBasis): CompetitorOffer | null {
  const price = summaryMoney(o.listingPrice, basis);
  if (!price || price.amountMinor === 0) return null;
  const shippingOption = (o.shippingOptions ?? []).find((x) => x.shippingOptionType === 'DEFAULT');
  const shipping = shippingOption ? summaryMoney(shippingOption.price, basis) : null;
  const isSelf = o.sellerId === sellerId;
  const coupon = couponPrice(o, price, basis);
  return {
    isSelf, ...(typeof o.sellerId === 'string' && !isSelf ? { sellerRef: o.sellerId } : {}), price,
    ...(shipping ? { shipping, totalPrice: { ...price, amountMinor: price.amountMinor + shipping.amountMinor } } : {}),
    ...(typeof o.subCondition === 'string' ? { condition: o.subCondition.toLowerCase() } : {}),
    ...(o.fulfillmentType === 'AFN' || o.fulfillmentType === 'MFN' ? { fulfillment: o.fulfillmentType } : {}),
    ...(coupon ? { couponPrice: coupon } : {}),
  };
}

/**
 * Шаг 115 [Р-240]: цена и держатель Buy Box сводки. Единого победителя канал не называет: предложения идут по сегментам покупателей с долей просмотров.
 * Большинство просмотров у одного продавца [Р-235] — он держатель, цена и доставка — его предложения с наибольшей долей. Большинства нет — цена
 * предложения с наибольшей долей, держатель неизвестен (`isSelf: null`, как цена Buy Box без продавца у ANY_OFFER_CHANGED): стратегии, которой нужен
 * держатель, это не годится, и отрезка доли нет. Предложений в Buy Box нет вовсе — Buy Box в снимке нет
 */
function buyboxOf(body: CompetitiveSummaryResponseBody, segments: readonly BuyboxSegment[], sellerId: string, basis: PriceBasis):
  { snapshot: NonNullable<CompetitorSnapshot['buybox']>; holder: PricingOffer | null } | null {
  const featured = (body.featuredBuyingOptions ?? []).filter((option) => option?.buyingOptionType === 'New').flatMap((option) => option.segmentedFeaturedOffers ?? []);
  const shareOf = (o: (typeof featured)[number]) => (o.featuredOfferSegments ?? []).reduce((sum, x) => {
    const pct = x?.segmentDetails?.glanceViewWeightPercentage;
    return typeof pct === 'number' && Number.isFinite(pct) && pct >= 0 && pct <= 100 ? sum + pct : sum;
  }, 0);
  const majority = holderByViewShare(segments);
  const candidates = majority ? featured.filter((o) => (majority.holder === 'SELF' ? o.sellerId === sellerId : o.sellerId === majority.sellerRef)) : featured;
  const top = [...candidates].sort((a, b) => shareOf(b) - shareOf(a))[0];
  const price = top ? summaryMoney(top.listingPrice, basis) : null;
  if (!top || !price || price.amountMinor === 0) return null;
  const shippingOption = (top.shippingOptions ?? []).find((x) => x.shippingOptionType === 'DEFAULT');
  const shipping = shippingOption ? summaryMoney(shippingOption.price, basis) : null;
  return {
    snapshot: { price, ...(shipping ? { shipping } : {}), isSelf: majority ? majority.holder === 'SELF' : null, ...(majority?.holder === 'OTHER' && majority.sellerRef ? { sellerRef: majority.sellerRef } : {}) },
    holder: majority ? top : null,
  };
}

/**
 * Шаг 109 [Р-234]: цена с купоном — акция `COUPON` (definitions.PromotionType: «a live coupon that customers can clip and apply at checkout»),
 * её `promotionSavings.discountedPrice`. DEAL (скидка применяется сама) и BASKET_BUILDING (скидка за несколько штук) — не купон. Цена в чужой
 * валюте или не ниже базовой — не купон; купонов несколько — самая низкая цена
 */
function couponPrice(o: PricingOffer, price: Money, basis: PriceBasis): Money | null {
  let best: Money | null = null;
  for (const p of o.promotions ?? []) {
    if (p?.promotionType !== 'COUPON') continue;
    const m = summaryMoney(p.promotionSavings?.discountedPrice, basis);
    if (m && m.currency === price.currency && m.amountMinor > 0 && m.amountMinor < price.amountMinor && (!best || m.amountMinor < best.amountMinor)) best = m;
  }
  return best;
}

/**
 * Шаг 109 [Р-235]: предложения в Buy Box по сегментам — `featuredBuyingOptions` с `buyingOptionType` New (опрос читает новое состояние).
 * Доля просмотров сегмента — `segmentDetails.glanceViewWeightPercentage` (число, в модели необязательное: сегмента без доли нет в снимке)
 */
function buyboxSegmentsOf(body: CompetitiveSummaryResponseBody, sellerId: string): BuyboxSegment[] {
  const out: BuyboxSegment[] = [];
  for (const option of body.featuredBuyingOptions ?? []) {
    if (option?.buyingOptionType !== 'New') continue;
    for (const offer of option.segmentedFeaturedOffers ?? []) {
      const isSelf = offer?.sellerId === sellerId;
      for (const segment of offer?.featuredOfferSegments ?? []) {
        const pct = segment?.segmentDetails?.glanceViewWeightPercentage;
        if (typeof pct !== 'number' || !Number.isFinite(pct) || pct < 0 || pct > 100 || typeof segment.customerMembership !== 'string') continue;
        out.push({ ...(typeof offer.sellerId === 'string' && !isSelf ? { sellerRef: offer.sellerId } : {}), isSelf, membership: segment.customerMembership.slice(0, 20), viewSharePct: pct });
      }
    }
  }
  return out;
}

function summaryMoney(p: MoneyType | undefined, basis: PriceBasis): Money | null {
  const minor = decimalToMinor(p?.amount);
  return minor === null || typeof p?.currencyCode !== 'string' || !/^[A-Z]{3}$/.test(p.currencyCode) ? null : { amountMinor: minor, currency: p.currencyCode, basis };
}
