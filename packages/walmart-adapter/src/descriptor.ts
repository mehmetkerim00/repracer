import { DEFAULT_SCHEDULED_RECOMPUTE_SECONDS, type ChannelDescriptor } from '@repracer/channel-port';

/**
 * Шаг 89: Walmart Marketplace — на симуляторе, по правилам настоящего Walmart со слов владельца (docs/channels/walmart.md). Снимка
 * спецификации НЕТ (W-01): адреса операций и формы тел ниже — то, что ждёт симулятор, и их сверит живой адаптер по снимку после ключей.
 * Факты владельца: OAuth 2.0 (Token API); песочница sandbox.walmartapis.com, бой marketplace.walmartapis.com; лимиты — корзина токенов
 * (каждый запрос тратит токен, пополнение с фиксированной скоростью), превышение — 429, в ответах заголовки x-current-token-count и
 * x-next-replenishment-time, слишком большой фид — 413, инвентарь порядка 200 запросов в минуту (US); цены — одиночно и фидом, инвентарь —
 * одиночно, массово и по складам (ship nodes); правило неконкурентной цены — листинг снимается с публикации.
 */
export const WALMART_HOSTS = {
  SANDBOX: 'https://sandbox.walmartapis.com',
  PRODUCTION: 'https://marketplace.walmartapis.com',
} as const;
export type WalmartEnvironment = keyof typeof WALMART_HOSTS;

/** Витрина: код наш (W-01), на экранах — «walmart.com». Граница суток не установлена [Р-65, Р-172, W-02] */
export const WALMART_US = 'WALMART_US';
export const SOURCE_WALMART_BUY_BOX = 'WALMART_BUY_BOX';

/** Операции симулятора (W-01: проверить по снимку) */
export const WALMART_PATHS = {
  token: '/v3/token',
  items: '/v3/items',
  price: '/v3/price',
  inventory: '/v3/inventory',
  buybox: '/v3/buybox',
  feeds: '/v3/feeds',
} as const;

/** Заголовки корзины токенов — факт владельца; формат времени пополнения (мс эпохи или ISO) — W-07, клиент читает оба */
export const TOKEN_COUNT_HEADER = 'x-current-token-count';
export const NEXT_REPLENISHMENT_HEADER = 'x-next-replenishment-time';

/**
 * Предел тела фида — неизвестен (W-08). Клиент не отправляет фид больше этого числа байт сам: 413 канала — ошибка нашего пакета, а не
 * повод повторять тот же фид. Значение консервативное, решение проекта
 */
export const FEED_MAX_BYTES = 5 * 1024 * 1024;

/** Источник конкурентов: опрос Buy Box (W-05 — какой API на бою и как часто) */
export const WALMART_DESCRIPTOR: ChannelDescriptor = {
  channel: 'WALMART',
  apiMode: 'WALMART_MARKETPLACE_API',
  apiVersion: 'simulator step 89 (no specification snapshot, W-01)',
  marketplaces: [{ code: WALMART_US, currency: 'USD', priceBasis: 'NET', timeZone: null }],
  fields: [
    {
      field: 'PRICE',
      writeScope: { kind: 'ACCOUNT_MARKETPLACE_SKU', keyTemplate: ['channel_account', 'marketplace', 'external_sku'] },
      // Одиночное обновление цены; фид — для массовых правок, адаптер шага 89 пишет по одной записи на вызов
      batch: { maxItems: 1, sameAcrossBatch: ['marketplace', 'external_sku'] },
      processing: 'ASYNC',
      confirmation: [{ kind: 'READBACK', operation: 'getItem' }],
      sideEffects: [],
      preconditions: [{ kind: 'PRICING_MODE', mode: 'ENGINE' }, { kind: 'OFFER_EXISTS_IN_CHANNEL' }],
      reversibility: { kind: 'REVERSIBLE' },
      valueLimits: { minAmountMinor: 1 },
      verification: 'TO_VERIFY',
    },
    {
      field: 'QUANTITY',
      writeScope: { kind: 'ACCOUNT_MARKETPLACE_SKU', keyTemplate: ['channel_account', 'marketplace', 'external_sku'] },
      batch: { maxItems: 1, sameAcrossBatch: ['marketplace', 'external_sku'] },
      processing: 'ASYNC',
      confirmation: [{ kind: 'READBACK', operation: 'getInventory' }],
      // Склады с отдельным количеством (ship nodes) — W-04: пишется склад продавца по умолчанию
      sideEffects: [],
      preconditions: [{ kind: 'OFFER_EXISTS_IN_CHANNEL' }],
      reversibility: { kind: 'REVERSIBLE' },
      valueLimits: { maxQuantity: 1_000_000 },
      verification: 'TO_VERIFY',
    },
  ],
  // Квоты читаются из заголовков ответа (корзина токенов), чисел в описании нет — кроме инвентаря «порядка 200 в минуту» со слов владельца
  rateLimits: [
    { owner: 'SELLER', operation: 'inventory', requestsPerSecond: 200 / 60, source: 'OBSERVED_HEADER' },
    { owner: 'SELLER', source: 'OBSERVED_HEADER' },
  ],
  capabilities: ['COMPETITOR_PULL'],
  haltRelease: { kind: 'MANUAL_ONLY', basis: 'Шаг 89: опрос Buy Box Walmart не проверен на бою (W-05) — снятие системной остановки только человеком' },
  priceHistory: { kind: 'UNAVAILABLE', basis: 'Step 89: no specification snapshot, a price history operation is not known (W-01)' },
  scheduledRecomputeSeconds: DEFAULT_SCHEDULED_RECOMPUTE_SECONDS,
  competitorSources: [
    {
      source: SOURCE_WALMART_BUY_BOX,
      kind: 'PULL',
      completeness: { kind: 'TOP_N', n: 10 },
      conditions: ['new'],
      hasBuyboxWinner: true,
      hasBuyboxPrice: true,
      // Шаг 101 [Р-226]: исполнения предложений источник не называет (W-05) — фильтр «Compete with» на Walmart недоступен
      hasFulfilment: false,
      hasOwnRank: false,
      hasShipping: true,
      typicalStalenessSeconds: null,
      availability: 'AVAILABLE',
      role: 'PRIMARY',
    },
  ],
};
