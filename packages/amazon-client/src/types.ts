/**
 * Типы Listings Items API v2021-08-01 — вручную по снимку моделей
 * (vendor/amazon/sp-api-models/2026-09-16/models/listings-items-api-model/listingsItems_2021-08-01.json).
 * Модель — Swagger 2.0, генератор типов проекта (openapi-typescript) его не читает. Перенесены только поля, которые использует адаптер;
 * атрибуты листинга (ItemAttributes) в модели — свободный объект, их форма — из схемы типа товара и страниц документации.
 */

/** definitions.Error */
export interface SpApiError { code: string; message: string; details?: string }

/** definitions.Issue */
export interface ListingsIssue {
  code: string;
  message: string;
  severity: 'ERROR' | 'WARNING' | 'INFO';
  attributeNames?: string[];
  categories?: string[];
  marketplaceIds?: string[];
}

/** definitions.ListingsItemSubmissionResponse */
export interface ListingsItemSubmissionResponse {
  sku: string;
  status: 'ACCEPTED' | 'INVALID' | 'VALID';
  submissionId: string;
  issues?: ListingsIssue[];
}

/** definitions.PatchOperation, ListingsItemPatchRequest */
export interface PatchOperation { op: 'add' | 'replace' | 'merge' | 'delete'; path: string; value?: Array<Record<string, unknown>> }
export interface ListingsItemPatchRequest { productType: string; patches: PatchOperation[] }

/** definitions.Money (amount — Decimal: строка) */
export interface Money { currencyCode: string; amount: string }

/** definitions.ItemSummaryByMarketplace (часть) */
export interface ItemSummaryByMarketplace { marketplaceId: string; asin?: string; productType: string; status?: Array<'BUYABLE' | 'DISCOVERABLE'>; lastUpdatedDate?: string }

/** definitions.ItemOfferByMarketplace */
export interface ItemOfferByMarketplace { marketplaceId: string; offerType: 'B2C' | 'B2B'; price: Money; audience?: { value?: string } }

/** definitions.FulfillmentAvailability */
export interface FulfillmentAvailability { fulfillmentChannelCode: string; quantity?: number }

/** definitions.Item */
export interface ListingsItem {
  sku: string;
  summaries?: ItemSummaryByMarketplace[];
  attributes?: Record<string, unknown>;
  issues?: ListingsIssue[];
  offers?: ItemOfferByMarketplace[];
  fulfillmentAvailability?: FulfillmentAvailability[];
}

/** definitions.ItemSearchResults (часть) */
export interface ItemSearchResults { numberOfResults: number; pagination?: { nextToken?: string }; items: ListingsItem[] }

/**
 * Product Pricing API v2022-05-01, getCompetitiveSummary — вручную по снимку моделей
 * (vendor/amazon/sp-api-models/2026-09-16/models/product-pricing-api-model/productPricing_2022-05-01.json, SHA-256 в SHA256SUMS).
 * Перенесены поля, которые использует сверка [Р-121]; суммы — MoneyType.amount (number в примере модели).
 */
export interface MoneyType { currencyCode?: string; amount?: number | string }
export interface CompetitiveSummaryRequest {
  asin: string; marketplaceId: string; includedData: Array<'featuredBuyingOptions' | 'referencePrices' | 'lowestPricedOffers' | 'similarItems'>;
  lowestPricedOffersInputs?: Array<{ itemCondition: 'New' | 'Used' | 'Collectible' | 'Refurbished' | 'Club'; offerType: 'Consumer' }>;
  method: 'GET'; uri: '/products/pricing/2022-05-01/items/competitiveSummary';
}
export interface CompetitiveSummaryBatchRequest { requests: CompetitiveSummaryRequest[] }
/** definitions.Offer */
export interface PricingOffer {
  sellerId: string; condition?: string; subCondition?: string; fulfillmentType: 'AFN' | 'MFN'; listingPrice: MoneyType;
  shippingOptions?: Array<{ shippingOptionType: 'DEFAULT'; price: MoneyType }>; primeDetails?: { eligibility: 'NATIONAL' | 'REGIONAL' | 'NONE' };
}
export interface LowestPricedOffer { lowestPricedOffersInput: { itemCondition: string; offerType: string }; offers: PricingOffer[] }
export interface CompetitiveSummaryResponseBody { asin: string; marketplaceId: string; lowestPricedOffers?: LowestPricedOffer[]; errors?: SpApiError[] }
export interface CompetitiveSummaryResponse { status: { statusCode?: number; reasonPhrase?: string }; body: CompetitiveSummaryResponseBody }
export interface CompetitiveSummaryBatchResponse { responses: CompetitiveSummaryResponse[] }
