import type { AdapterCallContext, CompetitorQuery, CompetitorReadResult, DiscoveredOffer, InboundDelivery, InboundResult, Instant, OrderLine, Page, PageRequest } from '@repracer/channel-port';
import { INVENTORY_PATH, marketplaceInfo } from './descriptor.ts';
import { ChannelCallError, channelError, classifyHttpFailure, firstRestError } from './errors.ts';
import { moneyOf } from './mapping.ts';
import type { EbayOffer } from './readback.ts';
import { call, nowMs, openSession, type ResolvedOptions } from './session.ts';

/** Страница inventory_item: limit до 100 — наш предел; offset — курсор [песочница: ответ offer?sku= несёт limit 20 по умолчанию] */
const INVENTORY_PAGE_MAX = 100;

interface InventoryItem { sku?: string; condition?: string; product?: { ean?: unknown; upc?: unknown } }

/**
 * Офферы аккаунта: страница товаров Inventory API, затем предложения каждого SKU (`offer?sku=`). В порт попадают только
 * опубликованные предложения с фиксированной ценой на витринах аккаунта: аукционы не управляются (Р-2), у неопубликованного нет листинга.
 * Листинги, ещё не мигрированные в Inventory API, здесь не видны вовсе (`offer?sku=` → 404 25713) — их находит предполётная проверка.
 */
export async function discoverOffersEbay(options: ResolvedOptions, ctx: AdapterCallContext, page: PageRequest): Promise<Page<DiscoveredOffer>> {
  const opened = await openSession(options, ctx);
  if (!opened.ok) throw new ChannelCallError(opened.error);
  const { session } = opened;
  const offset = page.cursor && /^\d{1,9}$/.test(page.cursor) ? Number(page.cursor) : 0;
  const limit = Math.max(1, Math.min(page.limit, INVENTORY_PAGE_MAX));
  const itemsRead = await call(options, ctx, session, { auth: 'USER', method: 'GET', path: `${INVENTORY_PATH}/inventory_item`, query: { limit, offset }, operation: 'getInventoryItems' });
  if (itemsRead.kind === 'REFUSED') throw new ChannelCallError(itemsRead.error);
  if (!itemsRead.result.ok) throw new ChannelCallError(classifyHttpFailure(itemsRead.result.status, itemsRead.result.body, 'BATCH', nowMs(options)));
  const body = (itemsRead.result.body ?? {}) as { total?: number; inventoryItems?: InventoryItem[] };
  const items: DiscoveredOffer[] = [];
  for (const item of body.inventoryItems ?? []) {
    if (typeof item.sku !== 'string' || item.sku.length === 0) continue;
    const offersRead = await call(options, ctx, session, { auth: 'USER', method: 'GET', path: `${INVENTORY_PATH}/offer`, query: { sku: item.sku }, operation: 'getOffers' });
    if (offersRead.kind === 'REFUSED') throw new ChannelCallError(offersRead.error);
    const r = offersRead.result;
    // 404 25713 «This Offer is not available» — у товара нет предложений [песочница]
    if (r.status === 404 && firstRestError(r.body)?.errorId === 25713) continue;
    if (!r.ok) throw new ChannelCallError(classifyHttpFailure(r.status, r.body, 'BATCH', nowMs(options)));
    const gtins = [item.product?.ean, item.product?.upc].flatMap((g) => (Array.isArray(g) ? g.filter((x): x is string => typeof x === 'string') : []));
    for (const o of ((r.body ?? {}) as { offers?: EbayOffer[] }).offers ?? []) {
      const marketplace = o.marketplaceId;
      const listingId = o.listing?.listingId;
      if (!marketplace || !marketplaceInfo(marketplace) || !session.account.marketplaces.includes(marketplace)) continue;
      if (o.format !== 'FIXED_PRICE' || !listingId || typeof o.offerId !== 'string') continue;
      const price = moneyOf(o.pricingSummary?.price, marketplace);
      items.push({
        identity: { marketplace, externalSku: item.sku, externalOfferId: o.offerId, externalListingId: listingId },
        gtins, condition: (item.condition ?? 'NEW').toLowerCase(), fulfillment: 'MERCHANT',
        ...(price ? { currentPrice: price } : {}),
        ...(Number.isSafeInteger(o.availableQuantity) ? { currentQuantity: o.availableQuantity! } : {}),
        ...(o.listing?.listingStatus ? { isLive: o.listing.listingStatus === 'ACTIVE' } : {}),
        // Собственного ценообразования канала у eBay этот адаптер не видит — поля нет, а не «нет» [Р-120]
      });
    }
  }
  const next = offset + limit;
  return { items, ...(typeof body.total === 'number' && next < body.total ? { nextCursor: String(next) } : {}) };
}

const UNSUPPORTED_WHY = {
  competitors: 'eBay competitors are not read in step 39: no specification snapshot of a competitor source (E-01); the eBay descriptor declares no competitor source and MANUAL_ONLY halt release',
  orders: 'eBay order lines are not read in step 39: the Fulfillment API is outside the sandbox run and carries buyer PII (Р-4)',
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

/** Заказы: отказ, а не пустой список, — как у адаптера Amazon */
export async function readOrderLinesEbay(options: ResolvedOptions, ctx: AdapterCallContext, _window: { since: Instant } & PageRequest): Promise<Page<OrderLine>> {
  logUnsupported(options, ctx, 'orders');
  throw new ChannelCallError(channelError('UNSUPPORTED', 'BATCH', UNSUPPORTED_WHY.orders));
}

/** Входящие: ни один адрес eBay в этом шаге не заведён — любая доставка отклоняется, тело не разбирается */
export async function handleInboundEbay(options: ResolvedOptions, delivery: InboundDelivery): Promise<InboundResult> {
  logUnsupported(options, { correlationId: `inbound:${delivery.receivedAt}`, tenantId: delivery.claimed.tenantId, channelAccountId: delivery.claimed.channelAccountId }, 'inbound');
  return { kind: 'REJECTED', error: channelError('UNSUPPORTED', 'BATCH', UNSUPPORTED_WHY.inbound), responseStatus: 501 };
}
