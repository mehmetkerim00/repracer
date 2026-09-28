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
 * tradingSiteName — значение `Site` в ответе GetItem у листинга этой витрины (шаг 48, E-19): у EBAY_DE — `Germany` [песочница], у
 * EBAY_US — не проверено (null, а не догадка «US»): предполётная проверка такой листинг не опознаёт и предупреждает.
 * acceptLanguage — заголовок `Accept-Language` REST-вызовов (шаг 50): живая песочница отвечает на `GET inventory_item` без него
 * 400 `25709` «Invalid value for header Accept-Language.», а спецификация снимка заголовка не объявляет (расхождение [док]
 * против [песочница], E-23). `de-DE` принят песочницей; `en-US` для EBAY_US — (проверить), E-23.
 */
export const EBAY_MARKETPLACES = {
  EBAY_DE: { currency: 'EUR', basis: 'GROSS' as PriceBasis, timeZone: 'Europe/Berlin' as string | null, tradingSiteId: 77, tradingSiteName: 'Germany' as string | null, acceptLanguage: 'de-DE' },
  EBAY_US: { currency: 'USD', basis: 'NET' as PriceBasis, timeZone: null as string | null, tradingSiteId: 0, tradingSiteName: null as string | null, acceptLanguage: 'en-US' },
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
/** Шаг 49 [Р-191]: Account API — платёжная бизнес-политика, `GET /payment_policy/{payment_policy_id}` (снимок sell_account_v1_oas3.json, scope sell.account) */
export const ACCOUNT_PATH = '/sell/account/v1';
export const paymentPolicyPath = (paymentPolicyId: string): string => `${ACCOUNT_PATH}/payment_policy/${encodeURIComponent(paymentPolicyId)}`;
export const TOKEN_PATH = '/identity/v1/oauth2/token';
/** Fulfillment API — заказы; путь и поля (проверить): не из снимка и не из песочницы (E-20), scope sell.fulfillment.readonly */
export const FULFILLMENT_ORDER_PATH = '/sell/fulfillment/v1/order';
export const TRADING_PATH = '/ws/api.dll';
/** Browse API: идентификатор предмета `v1|<listingId>|0`, fieldgroups=COMPACT — ровно так вызывала песочница */
export const browseItemPath = (listingId: string): string => `/buy/browse/v1/item/v1|${listingId}|0`;

/** [песочница] 26 запросов в одном вызове — 400 `25712` «The maximum size allowed is 25» [EBAY_C09] */
export const BULK_UPDATE_MAX = 25;
/** Р-2: `bulk_migrate_listing` — от 1 до 5 листингов за вызов; песочница проверила только 1 (Р-164) */
export const BULK_MIGRATE_MAX = 5;
/**
 * Trading API. Шаг 53: уровень совместимости Trading — текущий 1477 (выпуск 2026-08-24, заметки к выпускам — devzone/xml/docs/releasenotes.html, загружены
 * 2026-09-29). 1349 был ниже ориентира поддержки eBay («18 months old»). Между 1349 и 1477 для НАШИХ вызовов (GetItem, GetUserPreferences,
 * GetMyeBaySelling): 1375 — из GetMyeBaySelling сняты DeletedFromUnsoldList/DeletedFromSoldList (мы берём только ActiveList); 1371 — поля
 * GPSR в GetItem (разбор чекера их не читает); 1423 — новое значение BestOfferStatusCodeType (читаем только BestOfferEnabled). Живьём уровень
 * 1477 не проверен — следующая сессия песочницы
 */
export const TRADING_COMPATIBILITY_LEVEL = '1477';
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
  // Текст основания — как строка platform.channel_behaviour (0140); совпадение проверяет channel-reference.pg.test.ts
  haltRelease: { kind: 'MANUAL_ONLY', basis: 'Р-119: no competitor data on eBay, a fresh independent sample cannot be taken' },
  priceHistory: { kind: 'UNAVAILABLE', basis: 'no specification snapshot (E-01); the sandbox run found no offer price history operation' },
  competitorSources: [],
  /**
   * Шаг 51, Growth Check («retries for a maximum of two times for infrastructure errors», get-started-with-ebay-apis.html снимка
   * 2026-09-28): запись — не больше трёх попыток (два повтора) и только после сбоя инфраструктуры: 5xx и недоступный сервер токенов
   * (CHANNEL_UNAVAILABLE), таймаут, обрыв соединения. Ответ eBay 4xx на значение (включая 429) не повторяется. Отказ НАШЕГО клиентского
   * бюджета или режима пакетов до отправки повторяем: запрос в eBay не уходил (у ошибки нет httpStatus). Исключение — отказ ФОРМЫ пакета
   * EBAY_C18 (Р-189, ACTION_NOT_ALLOWED класса TRANSIENT; ревью шага 51, находка 2): значение eBay не оценивал, и то же значение уходит ДРУГИМ
   * вызовом — по одному SKU; это приспособление к названному ограничению, а не повтор после сбоя, и оно в пределах тех же трёх попыток.
   * Без него записи количества пробы не пересоздавались бы, пока не изменится остаток.
   * Итог неизвестен (запрос мог дойти) — не повтор, а сверка обратным чтением; повтор после неё тоже считается попыткой.
   */
  writeRetry: {
    maxAttempts: 3,
    // Ответы канала, после которых повтор допустим: 5xx и отказ формы пакета (EBAY_C18). Таймаут, обрыв и отказ до отправки ответа канала не
    // имеют — они повторяются в пределах трёх попыток по правилу ядра (шаг 52)
    retryOn: [{ code: 'CHANNEL_UNAVAILABLE' }, { code: 'ACTION_NOT_ALLOWED' }],
    basis: 'eBay Application Growth Check: retries for a maximum of two times for infrastructure errors (vendor/ebay/2026-09-28/get-started-with-ebay-apis.html)',
  },
};
