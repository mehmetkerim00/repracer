import type { ChannelDescriptor } from '@repracer/channel-port';

/** Витрины Kaufland в Release 1.0 [Р-26 — ограничение только этого канала, Р-56]; коды — из спецификации 2.44.0 */
export const KAUFLAND_STOREFRONTS = ['de', 'at'] as const;
export type KauflandStorefront = (typeof KAUFLAND_STOREFRONTS)[number];

export const KAUFLAND_LIMITS = {
  bulkMaxUnits: 150,
  unitsStatusMaxIds: 20,
  buyboxMaxOffers: 10,
  unitsPageMax: 100,
  maxListingPriceMinorEur: 100_000_000,
  maxAmount: 99_999,
  documentedRequestsPerSecond: 111,
} as const;

/**
 * Описание канала Kaufland (данные channel_capability, ADR-0002, ADR-0006).
 * Цена — аккаунт + витрина + unit; остаток — аккаунт + id_offer, общий для витрин [Р-35].
 */
export const KAUFLAND_DESCRIPTOR: ChannelDescriptor = {
  channel: 'KAUFLAND',
  apiMode: 'KAUFLAND_SELLER_API_V2',
  apiVersion: '2.44.0',
  marketplaces: [
    // Цены брутто — допущение до ответа K-12; граница суток — часовой пояс страны витрины, как в platform.marketplace [Р-62]
    { code: 'de', currency: 'EUR', priceBasis: 'GROSS', timeZone: 'Europe/Berlin' },
    { code: 'at', currency: 'EUR', priceBasis: 'GROSS', timeZone: 'Europe/Vienna' },
  ],
  fields: [
    {
      field: 'PRICE',
      writeScope: { kind: 'ACCOUNT_STOREFRONT_UNIT', keyTemplate: ['channel_account', 'marketplace', 'external_unit_id'] },
      batch: { maxItems: KAUFLAND_LIMITS.bulkMaxUnits, sameAcrossBatch: ['marketplace'] },
      processing: 'SYNC',
      confirmation: [
        { kind: 'SYNC_RESPONSE' },
        { kind: 'PUSH_EVENT', event: 'item_unit_changed', reliability: 'GUARANTEED_WITH_RETRIES' },
        { kind: 'READBACK', operation: 'GET /units/{id_unit}' },
      ],
      sideEffects: [],
      preconditions: [{ kind: 'PRICING_MODE', mode: 'ENGINE' }, { kind: 'OFFER_EXISTS_IN_CHANNEL' }],
      reversibility: { kind: 'REVERSIBLE' },
      valueLimits: { minAmountMinor: 1, maxAmountMinor: KAUFLAND_LIMITS.maxListingPriceMinorEur },
      verification: 'DOCUMENTED',
    },
    {
      field: 'QUANTITY',
      writeScope: { kind: 'ACCOUNT_OFFER', keyTemplate: ['channel_account', 'external_offer_id'] },
      batch: { maxItems: KAUFLAND_LIMITS.bulkMaxUnits, sameAcrossBatch: ['marketplace'] },
      processing: 'SYNC',
      confirmation: [
        { kind: 'SYNC_RESPONSE' },
        { kind: 'PUSH_EVENT', event: 'item_unit_changed', reliability: 'GUARANTEED_WITH_RETRIES' },
        { kind: 'READBACK', operation: 'GET /units?id_offer=' },
      ],
      sideEffects: [
        {
          kind: 'SHARED_ACROSS_MARKETPLACES',
          linkedBy: 'CHANNEL_OFFER_LINK',
          note: 'unit с одинаковым id_offer на разных витринах имеют общие количество и склад (документация 2.44.0)',
        },
      ],
      preconditions: [{ kind: 'OFFER_EXISTS_IN_CHANNEL' }],
      reversibility: { kind: 'REVERSIBLE' },
      valueLimits: { maxQuantity: KAUFLAND_LIMITS.maxAmount },
      verification: 'DOCUMENTED',
    },
    {
      field: 'CHANNEL_MIN_PRICE',
      writeScope: { kind: 'ACCOUNT_STOREFRONT_UNIT', keyTemplate: ['channel_account', 'marketplace', 'external_unit_id'] },
      batch: { maxItems: KAUFLAND_LIMITS.bulkMaxUnits, sameAcrossBatch: ['marketplace'] },
      processing: 'SYNC',
      confirmation: [{ kind: 'SYNC_RESPONSE' }],
      sideEffects: [{ kind: 'ACTIVATES_CHANNEL_REPRICER', note: 'minimum_price включает Smart Pricing (Р-12); запись запрещена Р-41' }],
      preconditions: [{ kind: 'PRICING_MODE', mode: 'KAUFLAND_SMART_PRICING' }],
      reversibility: { kind: 'IRREVERSIBLE', what: 'Способ выключить Smart Pricing не документирован (K-07)' },
      verification: 'TO_VERIFY',
    },
  ],
  rateLimits: [{ owner: 'SELLER', requestsPerSecond: KAUFLAND_LIMITS.documentedRequestsPerSecond, source: 'DOCUMENTED' }],
  capabilities: ['PUSH_SUBSCRIPTIONS', 'COMPETITOR_PULL', 'ASYNC_REPORTS'],
  // Р-52: выборка — опрос GET /buybox
  haltRelease: { kind: 'SAMPLE', basis: 'Р-52: fresh sample by polling GET /buybox' },
  // Р-124: в openapi.json 2.44.0 (vendor/kaufland/seller-api-v2) нет пути и схемы истории цен unit — полнота с подключения
  priceHistory: { kind: 'UNAVAILABLE', basis: 'Seller API 2.44.0 snapshot has no price history resource for units' },
  competitorSources: [
    {
      // Ранний доступ у аккаунт-менеджера; до получения Р-36 не активна (Р-45)
      source: 'KAUFLAND_BUY_BOX_CHANGED',
      kind: 'PUSH',
      completeness: { kind: 'TOP_N', n: KAUFLAND_LIMITS.buyboxMaxOffers },
      conditions: ['new'],
      hasBuyboxWinner: true,
      hasOwnRank: true,
      hasShipping: true,
      typicalStalenessSeconds: null,
      availability: 'EARLY_ACCESS',
      role: 'PRIMARY',
    },
    {
      source: 'KAUFLAND_BUYBOX',
      kind: 'PULL',
      completeness: { kind: 'TOP_N', n: KAUFLAND_LIMITS.buyboxMaxOffers },
      conditions: ['new', 'used', 'used - as new', 'used - very good', 'used - good', 'used - acceptable',
        'refurbished', 'refurbished - as new', 'refurbished - very good', 'refurbished - good', 'refurbished - acceptable'],
      hasBuyboxWinner: true,
      hasOwnRank: true,
      hasShipping: true,
      // Свежесть задаёт ярус опроса (Р-47)
      typicalStalenessSeconds: null,
      availability: 'AVAILABLE',
      role: 'PRIMARY',
    },
    {
      source: 'KAUFLAND_COMPETITORS_COMPARER',
      kind: 'REPORT',
      completeness: { kind: 'CHEAPEST_ONLY' },
      conditions: ['new', 'used'],
      hasBuyboxWinner: false,
      hasOwnRank: false,
      hasShipping: false,
      typicalStalenessSeconds: null,
      availability: 'AVAILABLE',
      role: 'RECONCILIATION',
    },
  ],
};
