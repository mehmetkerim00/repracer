/**
 * Параметры модели канала [Р-113]. Каждое неподтверждённое поведение канала — не догадка в коде, а параметр с кодом открытого
 * вопроса (channel-capabilities §7, §9). Значение по умолчанию — консервативное или документированное; альтернативы — ответы,
 * которые поддержка может дать. Сценарий симулятора прогоняется при разных значениях, и видно, что ломается.
 * Данные синтетические.
 */

export type QuestionStatus =
  /** Значение из снимка спецификации или страницы документации со ссылкой */
  | 'DOCUMENTED'
  /** Вопрос открыт: значение по умолчанию — предположение (проверить) */
  | 'OPEN';

export interface ParameterSpec<T> {
  /** Код вопроса в channel-capabilities.md; null — документированное значение */
  question: string | null;
  status: QuestionStatus;
  meaning: string;
  default: T;
  /** Значения, которые стоит прогнать: возможные ответы поддержки */
  alternatives: readonly T[];
}

// ---------------------------------------------------------------------------
// Kaufland Seller API v2 (2.44.0)
// ---------------------------------------------------------------------------

export interface KauflandModelParams {
  /** K-04: на что считается лимит 111 rps при технологическом партнёре */
  rateLimitScope: 'SELLER' | 'PARTNER' | 'SELLER_AND_PARTNER';
  /** Документировано 111 rps на продавца; burst не документирован (проверить) */
  rateLimit: { ratePerSecond: number; burst: number };
  /** K-04: нагрузка других продавцов того же партнёра, rps — имеет значение только при лимите на партнёра */
  otherSellersLoadRps: number;
  /** K-05: лимит правок одного unit; null — лимита нет */
  unitEditLimit: { maxEdits: number; windowMs: number } | null;
  /** K-05: HTTP-статус отказа при превышении лимита правок (проверить) */
  unitEditLimitStatus: number;
  /** K-06: задержка распространения amount на unit той же id_offer на другой витрине; 0 — в той же транзакции */
  quantityPropagationMs: number;
  /** K-11: уменьшает ли канал amount при заказе */
  orderDecrementsAmount: boolean;
  /** K-12: listing_price — брутто или нетто (цена покупателя = listing_price × (1 + НДС) при NET) */
  listingPriceBasis: 'GROSS' | 'NET';
  /** K-13: запись только amount без listing_price отклоняется */
  quantityWriteRequiresListingPrice: boolean;
  /** K-14: повтор идентичного PATCH после тайм-аута — одна правка или вторая (списывается в лимит K-05) */
  identicalRetry: 'SAME_EDIT' | 'SECOND_EDIT';
  /** K-15: меняется ли date_lastchange_iso при изменении listing_price */
  lastChangeOnPriceEdit: boolean;
  /** K-17: единицы price и shipping_rate в GET /buybox */
  buyboxPriceUnits: 'MAJOR' | 'MINOR';
  /** K-10, Р-45: доступ к buy_box_changed, debounce и доля потерянных уведомлений */
  buyBoxChanged: { delivered: boolean; debounceMs: number; lossShare: number };
  /** K-15, K-08: через сколько записанная цена видна в GET /units; до этого ответ PATCH и чтение показывают старую */
  applyDelayMs: number;
  /** Сбои: тайм-аут записи (и доля применённых при тайм-ауте), частичный успех bulk */
  faults: { writeTimeoutShare: number; timeoutAppliedShare: number; bulkItemMissingShare: number; bulkItemServerErrorShare: number };
}

export const KAUFLAND_PARAMETERS: { readonly [K in keyof KauflandModelParams]: ParameterSpec<KauflandModelParams[K]> } = {
  rateLimitScope: {
    question: 'K-04', status: 'OPEN', meaning: 'лимит 111 rps — на продавца, на партнёра или на пару', default: 'SELLER_AND_PARTNER',
    alternatives: ['SELLER', 'PARTNER', 'SELLER_AND_PARTNER'],
  },
  rateLimit: {
    question: null, status: 'DOCUMENTED', meaning: '111 запросов в секунду на продавца на все эндпоинты; burst не документирован (проверить)',
    default: { ratePerSecond: 111, burst: 111 }, alternatives: [{ ratePerSecond: 111, burst: 111 }, { ratePerSecond: 111, burst: 1 }],
  },
  otherSellersLoadRps: {
    question: 'K-04', status: 'OPEN', meaning: 'нагрузка других продавцов партнёра в общем лимите', default: 0, alternatives: [0, 60, 110],
  },
  unitEditLimit: {
    question: 'K-05', status: 'OPEN', meaning: 'лимит правок одного unit', default: null,
    alternatives: [null, { maxEdits: 250, windowMs: 86_400_000 }, { maxEdits: 20, windowMs: 3_600_000 }],
  },
  unitEditLimitStatus: {
    question: 'K-05', status: 'OPEN', meaning: 'ответ при превышении лимита правок', default: 422, alternatives: [422, 429, 400],
  },
  quantityPropagationMs: {
    question: 'K-06', status: 'OPEN', meaning: 'распространение amount между витринами id_offer', default: 0, alternatives: [0, 30_000, 600_000],
  },
  orderDecrementsAmount: {
    question: 'K-11', status: 'OPEN', meaning: 'канал уменьшает amount при заказе', default: true, alternatives: [true, false],
  },
  listingPriceBasis: {
    question: 'K-12', status: 'OPEN', meaning: 'listing_price брутто или нетто', default: 'GROSS', alternatives: ['GROSS', 'NET'],
  },
  quantityWriteRequiresListingPrice: {
    question: 'K-13', status: 'OPEN', meaning: 'запись amount требует listing_price', default: false, alternatives: [false, true],
  },
  identicalRetry: {
    question: 'K-14', status: 'OPEN', meaning: 'повтор идентичного PATCH', default: 'SECOND_EDIT', alternatives: ['SAME_EDIT', 'SECOND_EDIT'],
  },
  lastChangeOnPriceEdit: {
    question: 'K-15', status: 'OPEN', meaning: 'date_lastchange_iso отражает изменение цены', default: true, alternatives: [true, false],
  },
  buyboxPriceUnits: {
    question: 'K-17', status: 'OPEN', meaning: 'единицы цены в GET /buybox (спецификация: number «в валюте витрины»)', default: 'MAJOR',
    alternatives: ['MAJOR', 'MINOR'],
  },
  buyBoxChanged: {
    question: 'K-10', status: 'OPEN', meaning: 'доступ к buy_box_changed (Р-45), debounce и потери', default: { delivered: true, debounceMs: 60_000, lossShare: 0 },
    alternatives: [{ delivered: true, debounceMs: 60_000, lossShare: 0 }, { delivered: true, debounceMs: 300_000, lossShare: 0.3 }, { delivered: false, debounceMs: 0, lossShare: 1 }],
  },
  applyDelayMs: {
    question: 'K-15', status: 'OPEN', meaning: 'задержка видимости записанной цены', default: 0, alternatives: [0, 30_000, 900_000],
  },
  faults: {
    question: 'K-14', status: 'OPEN', meaning: 'тайм-ауты записи и частичный успех bulk', default: { writeTimeoutShare: 0, timeoutAppliedShare: 0.5, bulkItemMissingShare: 0, bulkItemServerErrorShare: 0 },
    alternatives: [{ writeTimeoutShare: 0, timeoutAppliedShare: 0.5, bulkItemMissingShare: 0, bulkItemServerErrorShare: 0 }, { writeTimeoutShare: 0.05, timeoutAppliedShare: 0.5, bulkItemMissingShare: 0.01, bulkItemServerErrorShare: 0.02 }],
  },
};

export function defaultKauflandParams(): KauflandModelParams {
  return Object.fromEntries(Object.entries(KAUFLAND_PARAMETERS).map(([k, spec]) => [k, structuredClone(spec.default)])) as unknown as KauflandModelParams;
}

// ---------------------------------------------------------------------------
// Amazon SP-API (снимок vendor/amazon/sp-api-models/2026-09-16)
// ---------------------------------------------------------------------------

export interface AmazonModelParams {
  /** Документировано моделью patchListingsItem: 5 rps, burst 5 на продавца; 500 rps на приложение — страница лимитов */
  patchRate: { seller: { ratePerSecond: number; burst: number }; application: { ratePerSecond: number; burst: number } };
  /** A-07: burst getListingsItem — модель 2021-08-01 даёт 10, страница лимитов — 5 */
  readBurst: number;
  /** Нагрузка других продавцов приложения, rps (общий лимит приложения) */
  otherSellersLoadRps: number;
  /** A-01: количество MFN — одно значение на регион EU или на витрину */
  quantityScope: 'REGION' | 'MARKETPLACE';
  /** A-04: лимит изменений одного SKU; null — только лимит запросов */
  skuEditLimit: { maxEdits: number; windowMs: number } | null;
  /** A-06: время от приёма patchListingsItem до видимости в getListingsItem */
  applyDelayMs: number;
  /** A-06: доля записей, принятых (ACCEPTED), но так и не применённых */
  acceptedNotAppliedShare: number;
  /** A-08: задержка и потери ANY_OFFER_CHANGED */
  anyOfferChanged: { delayMs: number; lossShare: number };
  /**
   * A-20 (шаг 51, HTTP-модель): отдаёт ли searchOrders данные покупателя без набора BUYER. Модель Orders 2026-01-01 описывает их набором
   * includedData — по умолчанию нет; вариант проверяет, что белый список адаптера не пропускает их дальше
   */
  ordersBuyerWithoutDataset: boolean;
}

export const AMAZON_PARAMETERS: { readonly [K in keyof AmazonModelParams]: ParameterSpec<AmazonModelParams[K]> } = {
  patchRate: {
    question: null, status: 'DOCUMENTED', meaning: 'patchListingsItem 5 rps / burst 5 (модель); 500 rps на приложение (страница лимитов)',
    default: { seller: { ratePerSecond: 5, burst: 5 }, application: { ratePerSecond: 500, burst: 500 } },
    alternatives: [{ seller: { ratePerSecond: 5, burst: 5 }, application: { ratePerSecond: 500, burst: 500 } }],
  },
  readBurst: { question: 'A-07', status: 'OPEN', meaning: 'burst getListingsItem', default: 5, alternatives: [5, 10] },
  otherSellersLoadRps: { question: null, status: 'OPEN', meaning: 'нагрузка других продавцов приложения', default: 0, alternatives: [0, 450] },
  quantityScope: { question: 'A-01', status: 'OPEN', meaning: 'остаток MFN на регион или на витрину', default: 'REGION', alternatives: ['REGION', 'MARKETPLACE'] },
  skuEditLimit: {
    question: 'A-04', status: 'OPEN', meaning: 'лимит изменений SKU', default: null, alternatives: [null, { maxEdits: 50, windowMs: 3_600_000 }],
  },
  applyDelayMs: { question: 'A-06', status: 'OPEN', meaning: 'время применения записи', default: 120_000, alternatives: [5_000, 120_000, 900_000] },
  acceptedNotAppliedShare: { question: 'A-06', status: 'OPEN', meaning: 'принято, но не применено', default: 0, alternatives: [0, 0.02] },
  anyOfferChanged: {
    question: 'A-08', status: 'OPEN', meaning: 'задержка и потери ANY_OFFER_CHANGED', default: { delayMs: 60_000, lossShare: 0 },
    alternatives: [{ delayMs: 60_000, lossShare: 0 }, { delayMs: 600_000, lossShare: 0.2 }],
  },
  ordersBuyerWithoutDataset: { question: 'A-20', status: 'OPEN', meaning: 'данные покупателя в searchOrders без набора BUYER', default: false, alternatives: [false, true] },
};

export function defaultAmazonParams(): AmazonModelParams {
  return Object.fromEntries(Object.entries(AMAZON_PARAMETERS).map(([k, spec]) => [k, structuredClone(spec.default)])) as unknown as AmazonModelParams;
}

// ---------------------------------------------------------------------------
// eBay Sell Inventory API — шаг 47 [Р-187]. Снимка спецификации нет (E-01): умолчание каждого параметра — ПОВЕДЕНИЕ ПЕСОЧНИЦЫ
// 27.09.2026 (docs/evidence/step39-ebay-sandbox.md), статус OPEN — песочница не доказывает поведения боевого канала (Р-162).
// ---------------------------------------------------------------------------

export interface EbayModelParams {
  /** E-04: лимит запросов продавца; null — не применяется (песочница отдаёт заглушку «100 вызовов на 15 с» и не отказывала) */
  requestLimit: { calls: number; windowMs: number } | null;
  /**
   * E-02: 250 правок листинга в календарный день (Р-2). null — канал не отказывает (песочница: 260 правок подряд — все 200).
   * countsFailed — отказ по элементу тоже списывает правку; status — ответ по элементу сверх лимита (код ошибки неизвестен)
   */
  listingEditLimit: { perDay: number; countsFailed: boolean; status: number } | null;
  /** E-06: количество 0 — песочница ответила 400 25004, но применила: availableQuantity 0, листинг OUT_OF_STOCK (не завершён) */
  quantityZero: 'ERROR_25004_APPLIED_OUT_OF_STOCK' | 'ERROR_25004_NOT_APPLIED' | 'APPLIED_LISTING_ENDED';
  /** E-06: снимает ли запись количества > 0 статус OUT_OF_STOCK (песочница: нет — после количества 5 листинг остался OUT_OF_STOCK) */
  restockClearsOutOfStock: boolean;
  /** E-12: цена в валюте не витрины — песочница приняла (200) и сохранила её у предложения молча */
  foreignCurrency: 'STORED_SILENTLY' | 'REJECTED_25709';
  /** E-12: цена с тремя знаками — песочница молча округлила ВВЕРХ (11.999 → 12.0) */
  subCentPrice: 'ROUNDED_UP_SILENTLY' | 'REJECTED_25709';
  /** E-13: через сколько Browse видит правку живого листинга (песочница задержку не измеряла) */
  browseLagMs: number;
  /** E-15: Best Offer после bulk_migrate_listing — песочница его СОХРАНИЛА (вопреки документации, которую пересказывает Р-2) */
  bestOfferOnMigration: 'KEPT' | 'LOST';
  /** E-16: правка через Trading API после миграции — песочница: ReviseFixedPriceItem прошёл и изменил живую цену мимо предложения */
  tradingReviseAfterMigration: 'APPLIES_TO_LISTING_NOT_OFFER' | 'REFUSED';
  /**
   * E-17: цена покупателя в Browse у EBAY_DE. Песочница (частный продавец): через ~25 минут после первых записей — цена продавца × 1,19
   * с taxes[VAT, includedInPrice, ebayCollectAndRemitTax] без новой ревизии. NONE — цена покупателя равна цене продавца (брутто, Р-58)
   */
  buyerPriceTax: { mode: 'VAT_ON_TOP'; rateBp: number; afterFirstWriteMs: number } | { mode: 'NONE' };
  /**
   * E-22 (шаг 49, Р-189): пакет РАЗНЫХ SKU в bulk_update_price_quantity. Песочница приняла до 25 предложений разных SKU; описание операции
   * в снимке — «Only one SKU (one product) can be updated per call». REFUSED_WHOLE_REQUEST — отказ всего вызова 400 без ответов по
   * элементам; код и текст ошибки синтетические (настоящий неизвестен)
   */
  multiSkuPerCall: 'ACCEPTED' | 'REFUSED_WHOLE_REQUEST';
}

export const EBAY_PARAMETERS: { readonly [K in keyof EbayModelParams]: ParameterSpec<EbayModelParams[K]> } = {
  requestLimit: {
    question: 'E-04', status: 'OPEN', meaning: 'лимит вызовов Inventory API продавца и приложения', default: null,
    alternatives: [null, { calls: 100, windowMs: 15_000 }, { calls: 3, windowMs: 15_000 }],
  },
  listingEditLimit: {
    question: 'E-02', status: 'OPEN', meaning: '250 правок листинга в день: применяет ли канал, учитывает ли отказы', default: null,
    alternatives: [null, { perDay: 250, countsFailed: true, status: 400 }, { perDay: 250, countsFailed: false, status: 400 }],
  },
  quantityZero: {
    question: 'E-06', status: 'OPEN', meaning: 'количество 0: ошибка 25004 при применённой записи, отказ без применения или завершение листинга',
    default: 'ERROR_25004_APPLIED_OUT_OF_STOCK', alternatives: ['ERROR_25004_APPLIED_OUT_OF_STOCK', 'ERROR_25004_NOT_APPLIED', 'APPLIED_LISTING_ENDED'],
  },
  restockClearsOutOfStock: {
    question: 'E-06', status: 'OPEN', meaning: 'запись количества > 0 снимает OUT_OF_STOCK', default: false, alternatives: [false, true],
  },
  foreignCurrency: {
    question: 'E-12', status: 'OPEN', meaning: 'цена в валюте не витрины', default: 'STORED_SILENTLY', alternatives: ['STORED_SILENTLY', 'REJECTED_25709'],
  },
  subCentPrice: {
    question: 'E-12', status: 'OPEN', meaning: 'цена с тремя знаками', default: 'ROUNDED_UP_SILENTLY', alternatives: ['ROUNDED_UP_SILENTLY', 'REJECTED_25709'],
  },
  browseLagMs: { question: 'E-13', status: 'OPEN', meaning: 'задержка Browse после правки листинга', default: 0, alternatives: [0, 120_000, 900_000] },
  bestOfferOnMigration: {
    question: 'E-15', status: 'OPEN', meaning: 'Best Offer после миграции листинга', default: 'KEPT', alternatives: ['KEPT', 'LOST'],
  },
  tradingReviseAfterMigration: {
    question: 'E-16', status: 'OPEN', meaning: 'правки Trading API другим инструментом после миграции', default: 'APPLIES_TO_LISTING_NOT_OFFER',
    alternatives: ['APPLIES_TO_LISTING_NOT_OFFER', 'REFUSED'],
  },
  buyerPriceTax: {
    question: 'E-17', status: 'OPEN', meaning: 'цена покупателя EBAY_DE: НДС сверху (частный продавец песочницы) или равна цене продавца',
    default: { mode: 'VAT_ON_TOP', rateBp: 1900, afterFirstWriteMs: 25 * 60_000 },
    alternatives: [{ mode: 'VAT_ON_TOP', rateBp: 1900, afterFirstWriteMs: 25 * 60_000 }, { mode: 'VAT_ON_TOP', rateBp: 1900, afterFirstWriteMs: 0 }, { mode: 'NONE' }],
  },
  multiSkuPerCall: {
    question: 'E-22', status: 'OPEN', meaning: 'пакет предложений разных SKU в одном вызове bulk_update_price_quantity: принимается (песочница) или отвергается целиком (описание операции)',
    default: 'ACCEPTED', alternatives: ['ACCEPTED', 'REFUSED_WHOLE_REQUEST'],
  },
};

export function defaultEbayParams(): EbayModelParams {
  return Object.fromEntries(Object.entries(EBAY_PARAMETERS).map(([k, spec]) => [k, structuredClone(spec.default)])) as unknown as EbayModelParams;
}
