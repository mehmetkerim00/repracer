import type { AdapterCallContext, CompetitorOffer, CompetitorQuery, CompetitorReadResult, DiscoveredOffer, Instant, Money, OrderLine, Page, PageRequest, PriceBasis } from '@repracer/channel-port';
import type { CompetitiveSummaryBatchRequest, CompetitiveSummaryBatchResponse, InventorySummariesResponse, ItemSearchResults, MoneyType, OrderItemRecord, OrderRecord, SearchOrdersResponse } from '@repracer/amazon-client';
import { logConservative } from './conservative.ts';
import { AMAZON_MARKETPLACES, COMPETITIVE_SUMMARY_BATCH_MAX, COMPETITIVE_SUMMARY_PATH, FBA_SUMMARIES_PATH, FBA_SUMMARIES_SKUS_MAX, marketplaceInfo, ORDERS_PAGE_MAX, ORDERS_PATH, SEARCH_PAGE_MAX, SOURCE_COMPETITIVE_SUMMARY } from './descriptor.ts';
import { ChannelCallError, channelError, classifyFailure } from './errors.ts';
import { channelOwnedPricing, decimalToMinor, fulfillmentOf, merchantQuantity, purchasePrice } from './mapping.ts';
import { acquire, deadlinePassed, nowMs, observeRateLimit, openSession, type AmazonAdapterOptions, type Session } from './session.ts';

/** Офферы аккаунта: searchListingsItems по витринам региона аккаунта, курсор — pageToken ответа */
export async function discoverOffersAmazon(options: AmazonAdapterOptions, ctx: AdapterCallContext, page: PageRequest): Promise<Page<DiscoveredOffer>> {
  const opened = await openSession(options, ctx);
  if (!opened.ok) throw new ChannelCallError(opened.error);
  const { session } = opened;
  const late = deadlinePassed(options, ctx);
  if (late) throw new ChannelCallError(late);
  const marketplaces = session.account.marketplaces.filter((m) => (AMAZON_MARKETPLACES as Record<string, { region: string }>)[m]?.region === session.region);
  if (marketplaces.length === 0) return { items: [] };
  const budget = acquire(options, ctx, session, 'searchListingsItems');
  if (budget) throw new ChannelCallError(budget);
  const result = await session.client.request<ItemSearchResults>('GET', `/listings/2021-08-01/items/${encodeURIComponent(session.sellerId)}`, {
    // Р-120: attributes — чтобы продавец видел правило автоматического ценообразования до назначения стратегии
    query: { marketplaceIds: marketplaces, includedData: ['summaries', 'attributes', 'offers', 'fulfillmentAvailability'], pageSize: Math.max(1, Math.min(page.limit, SEARCH_PAGE_MAX)),
      ...(page.cursor ? { pageToken: page.cursor } : {}) },
  });
  if (!result.ok) throw new ChannelCallError(classifyFailure(result, 'BATCH', nowMs(options)));
  observeRateLimit(options, ctx, session, 'searchListingsItems', result.headers);
  const items: DiscoveredOffer[] = [];
  // Шаг 51 [AMZ_C13]: FBA — по коду сети исполнения; SKU сети Amazon по витринам — для чтения количества FBA
  const fbaByMarketplace = new Map<string, string[]>();
  let unknownFulfillment = 0;
  for (const item of result.data.items ?? []) {
    const quantity = merchantQuantity(item);
    const fulfillment = fulfillmentOf(item);
    if (fulfillment.kind === 'UNKNOWN') unknownFulfillment += 1;
    for (const s of item.summaries ?? []) {
      const price = purchasePrice(item, s.marketplaceId);
      const owned = channelOwnedPricing(item, s.marketplaceId);
      if (fulfillment.kind === 'AMAZON') fbaByMarketplace.set(s.marketplaceId, [...(fbaByMarketplace.get(s.marketplaceId) ?? []), item.sku]);
      items.push({
        identity: { region: session.region, marketplace: s.marketplaceId, externalSku: item.sku, ...(s.asin ? { channelProductRef: s.asin } : {}) },
        gtins: [], condition: (s as { conditionType?: string }).conditionType?.split('_')[0] ?? 'new',
        // Неизвестный способ — CHANNEL: количество по нему не пишется (fail-closed)
        fulfillment: fulfillment.kind === 'MERCHANT' ? 'MERCHANT' : 'CHANNEL',
        ...(price ? { currentPrice: price } : {}), ...(quantity !== null ? { currentQuantity: quantity } : {}),
        ...(s.status ? { isLive: s.status.includes('BUYABLE') } : {}),
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
  const next = result.data.pagination?.nextToken;
  return { items, ...(next ? { nextCursor: next } : {}) };
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
      for (const summary of r.data.payload?.inventorySummaries ?? []) {
        const q = summary.inventoryDetails?.fulfillableQuantity;
        if (typeof summary.sellerSku === 'string' && part.includes(summary.sellerSku) && Number.isSafeInteger(q) && (q as number) >= 0) out.set(`${marketplace}|${summary.sellerSku}`, q as number);
      }
    }
  }
  return out;
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
 * Р-121 (шаг 24): getCompetitiveSummary — только сверка потерь ANY_OFFER_CHANGED [AMZ_C11]. Снимок источника AMAZON_COMPETITIVE_SUMMARY
 * (роль RECONCILIATION): предложения — lowestPricedOffers New/Consumer, без победителя Buy Box; момент наблюдения — время ответа.
 * Пакет — до 20 товаров одного региона сессии; ограничитель — операция getCompetitiveSummary (0.033 rps, burst 1)
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
      failures.push({ query, error: channelError('UNSUPPORTED', 'ITEM', 'competitive summary reconciliation reads the new condition only (AMZ_C11)') });
    } else if (!m || m.region !== session.region || !/^[A-Z0-9]{10}$/.test(query.channelProductRef)) {
      failures.push({ query, error: channelError('VALIDATION', 'ITEM', 'competitive summary query needs an ASIN of a storefront in the region of the account') });
    } else supported.push(query);
  }
  if (supported.length > 0) {
    // Снимок опроса — только сверка: решение о цене его не получает (роль RECONCILIATION) [AMZ_C07]
    logConservative(options.deps.logger, ctx, 'AMZ_C07_COMPETITOR_PULL_UNAVAILABLE', { queries: supported.length });
    logConservative(options.deps.logger, ctx, 'AMZ_C11_COMPETITIVE_SUMMARY_RECONCILIATION', { queries: supported.length });
  }
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
        asin: q.channelProductRef, marketplaceId: q.marketplace, includedData: ['lowestPricedOffers'], lowestPricedOffersInputs: [{ itemCondition: 'New', offerType: 'Consumer' }],
        method: 'GET', uri: '/products/pricing/2022-05-01/items/competitiveSummary',
      })),
    };
    // Чтение: повтор безопасен
    const result = await session.client.request<CompetitiveSummaryBatchResponse>('POST', COMPETITIVE_SUMMARY_PATH, { body, idempotent: true });
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
        const price = summaryMoney(o.listingPrice, basis);
        if (!price || price.amountMinor === 0) continue;
        const shippingOption = (o.shippingOptions ?? []).find((x) => x.shippingOptionType === 'DEFAULT');
        const shipping = shippingOption ? summaryMoney(shippingOption.price, basis) : null;
        const isSelf = o.sellerId === session.sellerId;
        offers.push({
          isSelf, ...(typeof o.sellerId === 'string' && !isSelf ? { sellerRef: o.sellerId } : {}), price,
          ...(shipping ? { shipping, totalPrice: { ...price, amountMinor: price.amountMinor + shipping.amountMinor } } : {}),
          ...(typeof o.subCondition === 'string' ? { condition: o.subCondition.toLowerCase() } : {}),
          fulfillment: o.fulfillmentType === 'AFN' ? 'AFN' : 'MFN',
        });
      }
      snapshots.push({
        marketplace: query.marketplace, channelProductRef: query.channelProductRef, condition: 'new', source: SOURCE_COMPETITIVE_SUMMARY, observedAt,
        completeness: { kind: 'TOP_N', n: Math.max(1, offers.length) }, offers,
      });
    }
  }
  return { snapshots, failures };
}

function summaryMoney(p: MoneyType | undefined, basis: PriceBasis): Money | null {
  const minor = decimalToMinor(p?.amount);
  return minor === null || typeof p?.currencyCode !== 'string' || !/^[A-Z]{3}$/.test(p.currencyCode) ? null : { amountMinor: minor, currency: p.currencyCode, basis };
}
