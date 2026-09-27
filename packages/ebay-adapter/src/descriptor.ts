import type { ChannelDescriptor, PriceBasis } from '@repracer/channel-port';

/**
 * Шаг 39 [Р-162…Р-164]. Снимка спецификации eBay нет (E-01): документация отвечает 403 без ключей разработчика. Всё, что ниже
 * названо фактом, — **[песочница]**: получено вызовами `api.sandbox.ebay.com` 27.09.2026 (docs/evidence/step39-ebay-sandbox.md).
 * Р-162: песочница не доказывает поведения боевого канала — лимиты, тайминги и Best Offer не считаются подтверждёнными, поэтому
 * verification у полей — TO_VERIFY, а каждое поведение, выбранное из-за неподтверждённого факта, — правило EBAY_Cnn (conservative.ts).
 */

/**
 * Витрины eBay Release 1.0 [Р-56] — как строки platform.marketplace (0034, 0040). Граница суток EBAY_US не установлена (Р-65, OQ-112):
 * null, а не пустая строка. siteId — заголовок X-EBAY-API-SITEID Trading API: 77 — Германия, 0 — США [песочница: GetItem с 77 отвечает
 * Site=Germany].
 */
export const EBAY_MARKETPLACES = {
  EBAY_DE: { currency: 'EUR', basis: 'GROSS' as PriceBasis, timeZone: 'Europe/Berlin' as string | null, tradingSiteId: 77 },
  EBAY_US: { currency: 'USD', basis: 'NET' as PriceBasis, timeZone: null as string | null, tradingSiteId: 0 },
} as const;
export type EbayMarketplaceId = keyof typeof EBAY_MARKETPLACES;

export function marketplaceInfo(id: string | undefined) {
  return id && Object.prototype.hasOwnProperty.call(EBAY_MARKETPLACES, id) ? EBAY_MARKETPLACES[id as EbayMarketplaceId] : null;
}

export type EbayEnvironment = 'SANDBOX' | 'PRODUCTION';

/**
 * Хосты. `api.` — Sell Inventory, Buy Browse, Trading (`/ws/api.dll`) и сервер токенов; `apiz.` — Commerce Identity (E-11: на `api.`
 * тот же путь отвечает 404) [песочница]. Хосты боя — по аналогии с песочницей (проверить при первом боевом подключении).
 */
export const EBAY_HOSTS: Readonly<Record<EbayEnvironment, { api: string; apiz: string }>> = {
  SANDBOX: { api: 'https://api.sandbox.ebay.com', apiz: 'https://apiz.sandbox.ebay.com' },
  PRODUCTION: { api: 'https://api.ebay.com', apiz: 'https://apiz.ebay.com' },
};

export const INVENTORY_PATH = '/sell/inventory/v1';
export const BULK_UPDATE_PATH = `${INVENTORY_PATH}/bulk_update_price_quantity`;
export const BULK_MIGRATE_PATH = `${INVENTORY_PATH}/bulk_migrate_listing`;
export const TOKEN_PATH = '/identity/v1/oauth2/token';
export const TRADING_PATH = '/ws/api.dll';
/** Browse API: идентификатор предмета `v1|<listingId>|0`, fieldgroups=COMPACT — ровно так вызывала песочница */
export const browseItemPath = (listingId: string): string => `/buy/browse/v1/item/v1|${listingId}|0`;

/** [песочница] 26 запросов в одном вызове — 400 `25712` «The maximum size allowed is 25» [EBAY_C09] */
export const BULK_UPDATE_MAX = 25;
/** Р-2: `bulk_migrate_listing` — от 1 до 5 листингов за вызов; песочница проверила только 1 (Р-164) */
export const BULK_MIGRATE_MAX = 5;
/** Trading API: уровень совместимости, которым работала песочница */
export const TRADING_COMPATIBILITY_LEVEL = '1349';
/** Scope токена приложения (client_credentials) — src/constants.js официального клиента eBay (vendor/ebay/oauth-client) */
export const APPLICATION_SCOPE = 'https://api.ebay.com/oauth/api_scope';
/** Верхний предел количества не известен (E-03): наш предел, а не канала */
export const MAX_QUANTITY = 1_000_000;
/** Р-2, Р-19: 250 правок листинга в календарный день, все попытки */
export const LISTING_EDITS_PER_DAY = 250;
/**
 * Доля лимита, недоступная цене, — те же числа, что object_edit_limit правила eBay (tests/db/smoke_setup.sql) и tenant_data.edit_budget
 * (0008): резерв под остаток 50 и запас 10 на правки продавца мимо нас. Цена — не больше 250 − 50 − 10 = 190 попыток в сутки.
 */
export const EDIT_BUDGET = {
  budgetScope: 'external_listing_id' as const, limit: LISTING_EDITS_PER_DAY, period: 'CALENDAR_DAY' as const,
  // Граница дня не подтверждена ни для одной витрины (E-02): адаптер считает худший случай — любые 24 часа [EBAY_C08]
  dayBoundaryTimeZone: null, countsFailedAttempts: true, sharedAcrossFields: true, quantityReserve: 50, unaccountedMargin: 10,
};

export const OPERATION_BULK_UPDATE = 'bulkUpdatePriceQuantity';

export const EBAY_DESCRIPTOR: ChannelDescriptor = {
  channel: 'EBAY',
  apiMode: 'EBAY_INVENTORY_API',
  apiVersion: 'sell-inventory-v1 (no specification snapshot, E-01; sandbox run 2026-09-27, Р-162)',
  marketplaces: Object.entries(EBAY_MARKETPLACES).map(([code, m]) => ({ code, currency: m.currency, priceBasis: m.basis, timeZone: m.timeZone })),
  fields: [
    {
      field: 'PRICE',
      // Цена — предложение (offer) витрины: у SKU на EBAY_DE и EBAY_US разные предложения и разные листинги
      writeScope: { kind: 'ACCOUNT_MARKETPLACE_SKU', keyTemplate: ['channel_account', 'marketplace', 'external_sku'] },
      batch: { maxItems: BULK_UPDATE_MAX, sameAcrossBatch: ['channel_account', 'marketplace'] },
      processing: 'SYNC',
      // Живую цену листинга показывает Browse API, а не GET offer [EBAY_C05]
      confirmation: [{ kind: 'SYNC_RESPONSE' }, { kind: 'READBACK', operation: 'getItem (Browse API)' }],
      editBudget: EDIT_BUDGET,
      sideEffects: [],
      preconditions: [{ kind: 'LISTING_MANAGED_BY_WRITE_API' }, { kind: 'PRICING_MODE', mode: 'ENGINE' }, { kind: 'OFFER_EXISTS_IN_CHANNEL' }],
      reversibility: { kind: 'REVERSIBLE' },
      valueLimits: { minAmountMinor: 1 },
      verification: 'TO_VERIFY',
    },
    {
      field: 'QUANTITY',
      // Запись идёт в предложение (offers[].availableQuantity — количество ЛИСТИНГА, а не товара) [песочница, EBAY_C07, E-03], а
      // предложение у SKU своё на каждой витрине: единица остатка — аккаунт + витрина + SKU. Ключ «аккаунт + SKU» сливал бы
      // предложения EBAY_DE и EBAY_US одного SKU в одну единицу, и одно из них не обновлялось бы никогда (перепродажа, Р-6)
      writeScope: { kind: 'ACCOUNT_MARKETPLACE_SKU', keyTemplate: ['channel_account', 'marketplace', 'external_sku'] },
      batch: { maxItems: BULK_UPDATE_MAX, sameAcrossBatch: ['channel_account', 'marketplace'] },
      processing: 'SYNC',
      confirmation: [{ kind: 'SYNC_RESPONSE' }, { kind: 'READBACK', operation: 'getOffer' }],
      editBudget: EDIT_BUDGET,
      // [песочница] количество 0: ответ 400 `25004`, но значение применено и листинг стал OUT_OF_STOCK, а не завершён (E-06)
      sideEffects: [{ kind: 'MAY_END_LISTING', condition: 'availableQuantity = 0: sandbox set the listing OUT_OF_STOCK (not ended) while answering 25004; production behaviour without out-of-stock control is E-06' }],
      preconditions: [{ kind: 'LISTING_MANAGED_BY_WRITE_API' }, { kind: 'OFFER_EXISTS_IN_CHANNEL' }],
      reversibility: { kind: 'REVERSIBLE' },
      valueLimits: { maxQuantity: MAX_QUANTITY },
      verification: 'TO_VERIFY',
    },
  ],
  // Лимиты песочницы ничего не доказывают (Р-162): чисел нет, клиентский бюджет выбран нами [EBAY_C01, E-04]
  rateLimits: [
    { owner: 'SELLER', source: 'UNKNOWN' },
    { owner: 'APPLICATION', source: 'UNKNOWN' },
  ],
  capabilities: ['LISTING_MIGRATION'],
  // Опроса конкурентов у адаптера нет — выборку для Р-52 взять неоткуда
  haltRelease: { kind: 'MANUAL_ONLY', basis: 'Р-119: the eBay adapter reads no competitor data, a fresh independent sample cannot be taken' },
  priceHistory: { kind: 'UNAVAILABLE', basis: 'no specification snapshot (E-01); the sandbox run found no offer price history operation' },
  competitorSources: [],
};
