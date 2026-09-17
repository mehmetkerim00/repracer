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
