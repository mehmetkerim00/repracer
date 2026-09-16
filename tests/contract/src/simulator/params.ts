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
};

export function defaultAmazonParams(): AmazonModelParams {
  return Object.fromEntries(Object.entries(AMAZON_PARAMETERS).map(([k, spec]) => [k, structuredClone(spec.default)])) as unknown as AmazonModelParams;
}
