import type { AdapterCallContext, CompetitorOffer, CompetitorQuery, CompetitorReadResult, DiscoveredOffer, Instant, Money, OrderLine, Page, PageRequest, PriceBasis } from '@repracer/channel-port';
import type { CompetitiveSummaryBatchRequest, CompetitiveSummaryBatchResponse, ItemSearchResults, MoneyType } from '@repracer/amazon-client';
import { logConservative } from './conservative.ts';
import { AMAZON_MARKETPLACES, COMPETITIVE_SUMMARY_BATCH_MAX, COMPETITIVE_SUMMARY_PATH, marketplaceInfo, SEARCH_PAGE_MAX, SOURCE_COMPETITIVE_SUMMARY } from './descriptor.ts';
import { ChannelCallError, channelError, classifyFailure } from './errors.ts';
import { channelOwnedPricing, decimalToMinor, merchantQuantity, purchasePrice } from './mapping.ts';
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
    // Р-120: attributes — чтобы продавец видел правило автоматического ценообразования до назначения стратегии
    query: { marketplaceIds: marketplaces, includedData: ['summaries', 'attributes', 'offers', 'fulfillmentAvailability'], pageSize: Math.max(1, Math.min(page.limit, SEARCH_PAGE_MAX)),
      ...(page.cursor ? { pageToken: page.cursor } : {}) },
  });
  if (!result.ok) throw new ChannelCallError(classifyFailure(result, 'BATCH', nowMs(options)));
  observeRateLimit(options, ctx, session, 'searchListingsItems', result.headers);
  const items: DiscoveredOffer[] = [];
  for (const item of result.data.items ?? []) {
    const quantity = merchantQuantity(item);
    for (const s of item.summaries ?? []) {
      const price = purchasePrice(item, s.marketplaceId);
      const owned = channelOwnedPricing(item, s.marketplaceId);
      items.push({
        identity: { region: session.region, marketplace: s.marketplaceId, externalSku: item.sku, ...(s.asin ? { channelProductRef: s.asin } : {}) },
        gtins: [], condition: (s as { conditionType?: string }).conditionType?.split('_')[0] ?? 'new',
        fulfillment: quantity === null ? 'CHANNEL' : 'MERCHANT',
        ...(price ? { currentPrice: price } : {}), ...(quantity !== null ? { currentQuantity: quantity } : {}),
        ...(s.status ? { isLive: s.status.includes('BUYABLE') } : {}),
        channelPricing: { automatedPricing: owned.repricer, channelBounds: owned.bounds },
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
