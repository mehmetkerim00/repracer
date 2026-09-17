import type { ChannelDescriptor, PriceBasis } from '@repracer/channel-port';

/**
 * Витрины Amazon Release 1.0 [Р-56] — как строки platform.marketplace (0075): идентификаторы подтверждены страницей marketplace-ids,
 * валюта — справочник; база цены и налоговый режим — (проверить, A-02, OQ-102). Регион — по странице sp-api-endpoints.
 */
export const AMAZON_MARKETPLACES = {
  A1PA6795UKMFR9: { region: 'EU', country: 'DE', currency: 'EUR', basis: 'GROSS' as PriceBasis, timeZone: 'Europe/Berlin' },
  // Граница суток amazon.com не установлена [Р-65]: пояс не подставляется
  ATVPDKIKX0DER: { region: 'NA', country: 'US', currency: 'USD', basis: 'NET' as PriceBasis, timeZone: '' },
} as const;
export type AmazonMarketplaceId = keyof typeof AMAZON_MARKETPLACES;

export function marketplaceInfo(id: string | undefined) {
  return id && Object.prototype.hasOwnProperty.call(AMAZON_MARKETPLACES, id) ? AMAZON_MARKETPLACES[id as AmazonMarketplaceId] : null;
}

/** Страница listings-items-api-rate-limits (SHA-256 в SOURCE.md): «пара аккаунт–приложение» и «приложение»; срабатывает порог, достигнутый первым */
export const AMAZON_RATE_LIMITS = {
  patchListingsItem: { pair: { ratePerSecond: 5, burst: 5 }, application: { ratePerSecond: 500 } },
  getListingsItem: { pair: { ratePerSecond: 5, burst: 5 }, application: { ratePerSecond: 100 } },
  searchListingsItems: { pair: { ratePerSecond: 5, burst: 5 }, application: { ratePerSecond: 100 } },
  // Модель productPricing_2022-05-01 (Usage Plan): 0.033 rps, burst 1. Лимит уровня приложения не документирован — равен лимиту пары [AMZ_C11, A-15]
  getCompetitiveSummary: { pair: { ratePerSecond: 0.033, burst: 1 }, application: { ratePerSecond: 0.033, documented: false } },
} as const;
export type AmazonOperation = keyof typeof AMAZON_RATE_LIMITS;

export const LISTINGS_BASE_PATH = '/listings/2021-08-01/items';
export const SOURCE_ANY_OFFER_CHANGED = 'AMAZON_ANY_OFFER_CHANGED';
export const SOURCE_COMPETITIVE_SUMMARY = 'AMAZON_COMPETITIVE_SUMMARY';
/** getCompetitiveSummary: до 20 запросов в пакете (CompetitiveSummaryRequestList.maxItems), lowestPricedOffers — до 20 предложений */
export const COMPETITIVE_SUMMARY_BATCH_MAX = 20;
export const COMPETITIVE_SUMMARY_PATH = '/batches/products/pricing/2022-05-01/items/competitiveSummary';
/** Параметр pageSize searchListingsItems: максимум 20 (модель) */
export const SEARCH_PAGE_MAX = 20;
/** Модель: quantity — integer, minimum 0; верхний предел не задан — (проверить) */
export const MAX_QUANTITY = 1_000_000;

export const AMAZON_DESCRIPTOR: ChannelDescriptor = {
  channel: 'AMAZON',
  apiMode: 'AMAZON_LISTINGS_ITEMS',
  apiVersion: 'listings-items-2021-08-01 (snapshot 2026-09-16, commit 3659f968)',
  marketplaces: Object.entries(AMAZON_MARKETPLACES).map(([code, m]) => ({ code, currency: m.currency, priceBasis: m.basis, timeZone: m.timeZone })),
  fields: [
    {
      field: 'PRICE',
      writeScope: { kind: 'ACCOUNT_REGION_MARKETPLACE_SKU', keyTemplate: ['channel_account', 'region', 'marketplace', 'external_sku'] },
      // Один PATCH на SKU с несколькими витринами одного региона (marketplaceIds — массив в модели patchListingsItem)
      batch: { maxItems: Object.keys(AMAZON_MARKETPLACES).length, sameAcrossBatch: ['region', 'external_sku'] },
      processing: 'ASYNC',
      confirmation: [
        { kind: 'READBACK', operation: 'getListingsItem' },
        { kind: 'PUSH_EVENT', event: 'LISTINGS_ITEM_STATUS_CHANGE', reliability: 'BEST_EFFORT' },
      ],
      sideEffects: [],
      preconditions: [{ kind: 'PRICING_MODE', mode: 'ENGINE' }, { kind: 'OFFER_EXISTS_IN_CHANNEL' }],
      reversibility: { kind: 'REVERSIBLE' },
      valueLimits: { minAmountMinor: 1 },
      verification: 'DOCUMENTED',
    },
    {
      field: 'QUANTITY',
      writeScope: { kind: 'ACCOUNT_REGION_SKU', keyTemplate: ['channel_account', 'region', 'external_sku'] },
      batch: { maxItems: 1, sameAcrossBatch: ['region', 'external_sku'] },
      processing: 'ASYNC',
      confirmation: [{ kind: 'READBACK', operation: 'getListingsItem' }],
      sideEffects: [{ kind: 'SHARED_ACROSS_MARKETPLACES', linkedBy: 'REGION', note: 'Остаток MFN — одно значение на SKU в регионе [Р-1, A-01]' }],
      preconditions: [{ kind: 'OFFER_EXISTS_IN_CHANNEL' }],
      reversibility: { kind: 'REVERSIBLE' },
      valueLimits: { maxQuantity: MAX_QUANTITY },
      verification: 'DOCUMENTED',
    },
  ],
  rateLimits: Object.entries(AMAZON_RATE_LIMITS).flatMap(([operation, r]) => [
    { owner: 'SELLER_APPLICATION_OPERATION' as const, operation, requestsPerSecond: r.pair.ratePerSecond, burst: r.pair.burst, source: 'DOCUMENTED' as const },
    { owner: 'APPLICATION' as const, operation, requestsPerSecond: r.application.ratePerSecond,
      source: 'documented' in r.application && r.application.documented === false ? 'UNKNOWN' as const : 'DOCUMENTED' as const },
  ]),
  capabilities: [],
  // Р-119: опроса конкурентов нет (getCompetitiveSummary 0.033 rps, AMZ_C07) — выборку для Р-52 взять неоткуда
  haltRelease: { kind: 'MANUAL_ONLY', basis: 'Р-119: no competitor polling on Amazon, a fresh independent sample cannot be taken' },
  // Р-124: модели SP-API 2026-09-16 (vendor/amazon/sp-api-models) не описывают истории цен оффера — полнота с подключения
  priceHistory: { kind: 'UNAVAILABLE', basis: 'SP-API models snapshot 2026-09-16 has no offer price history operation' },
  competitorSources: [
    {
      source: SOURCE_ANY_OFFER_CHANGED,
      kind: 'PUSH',
      // «Any of the top 20 offers» — страница notification-type-values (ANY_OFFER_CHANGED); схема maxItems не задаёт
      completeness: { kind: 'TOP_N', n: 20 },
      conditions: ['new', 'used', 'collectible', 'refurbished', 'club'],
      hasBuyboxWinner: true,
      hasOwnRank: false,
      hasShipping: true,
      typicalStalenessSeconds: null,
      availability: 'AVAILABLE',
      role: 'PRIMARY',
    },
    {
      // Р-121: только сверка потерь ANY_OFFER_CHANGED по кругу — 0.033 rps не позволяют опрашивать все товары для решения (AMZ_C07, AMZ_C11)
      source: SOURCE_COMPETITIVE_SUMMARY,
      kind: 'PULL',
      completeness: { kind: 'TOP_N', n: 20 },
      conditions: ['new'],
      // featuredBuyingOptions — сегменты по членству Prime и месту покупателя, единого победителя нет [AMZ_C11]
      hasBuyboxWinner: false,
      hasOwnRank: false,
      hasShipping: true,
      typicalStalenessSeconds: null,
      availability: 'AVAILABLE',
      role: 'RECONCILIATION',
    },
  ],
};
