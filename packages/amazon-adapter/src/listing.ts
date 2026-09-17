import type { AdapterCallContext, CompetitorQuery, CompetitorReadResult, DiscoveredOffer, Instant, OrderLine, Page, PageRequest } from '@repracer/channel-port';
import type { ItemSearchResults } from '@repracer/amazon-client';
import { logConservative } from './conservative.ts';
import { AMAZON_MARKETPLACES, SEARCH_PAGE_MAX } from './descriptor.ts';
import { ChannelCallError, channelError, classifyFailure } from './errors.ts';
import { merchantQuantity, purchasePrice } from './mapping.ts';
import { acquire, deadlinePassed, nowMs, observeRateLimit, openSession, type AmazonAdapterOptions } from './session.ts';

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
    query: { marketplaceIds: marketplaces, includedData: ['summaries', 'offers', 'fulfillmentAvailability'], pageSize: Math.max(1, Math.min(page.limit, SEARCH_PAGE_MAX)),
      ...(page.cursor ? { pageToken: page.cursor } : {}) },
  });
  if (!result.ok) throw new ChannelCallError(classifyFailure(result, 'BATCH', nowMs(options)));
  observeRateLimit(options, ctx, session, 'searchListingsItems', result.headers);
  const items: DiscoveredOffer[] = [];
  for (const item of result.data.items ?? []) {
    const quantity = merchantQuantity(item);
    for (const s of item.summaries ?? []) {
      const price = purchasePrice(item, s.marketplaceId);
      items.push({
        identity: { region: session.region, marketplace: s.marketplaceId, externalSku: item.sku, ...(s.asin ? { channelProductRef: s.asin } : {}) },
        gtins: [], condition: (s as { conditionType?: string }).conditionType?.split('_')[0] ?? 'new',
        fulfillment: quantity === null ? 'CHANNEL' : 'MERCHANT',
        ...(price ? { currentPrice: price } : {}), ...(quantity !== null ? { currentQuantity: quantity } : {}),
        ...(s.status ? { isLive: s.status.includes('BUYABLE') } : {}),
      });
    }
  }
  const next = result.data.pagination?.nextToken;
  return { items, ...(next ? { nextCursor: next } : {}) };
}

/** Заказы — Orders API: в снимке нет, данные с PII [Р-4]; порт отвечает отказом, а не пустым списком */
export async function readOrderLinesAmazon(_options: AmazonAdapterOptions, _ctx: AdapterCallContext, _window: { since: Instant } & PageRequest): Promise<Page<OrderLine>> {
  throw new ChannelCallError(channelError('UNSUPPORTED', 'BATCH', 'Amazon order lines are not read: Orders API is not in the specification snapshot and carries PII (Р-4)'));
}

/** Опрос конкурентов не выполняется [AMZ_C07] */
export async function readCompetitorsAmazon(options: AmazonAdapterOptions, ctx: AdapterCallContext, queries: readonly CompetitorQuery[]): Promise<CompetitorReadResult> {
  if (queries.length > 0) logConservative(options.deps.logger, ctx, 'AMZ_C07_COMPETITOR_PULL_UNAVAILABLE', { queries: queries.length });
  return { snapshots: [], failures: queries.map((query) => ({ query,
    error: channelError('UNSUPPORTED', 'ITEM', 'Amazon competitors come only from ANY_OFFER_CHANGED: getCompetitiveSummary allows 0.033 requests per second') })) };
}
