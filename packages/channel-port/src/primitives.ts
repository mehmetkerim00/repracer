/**
 * Базовые типы порта. Совпадают по смыслу со схемой PostgreSQL (migrations/) — порт не вводит новых понятий.
 */

type Brand<T, B extends string> = T & { readonly __brand: B };

export type TenantId = Brand<string, 'TenantId'>;
export type ChannelAccountId = Brand<string, 'ChannelAccountId'>;
export type WriteScopeId = Brand<string, 'WriteScopeId'>;
export type ChannelWriteId = Brand<string, 'ChannelWriteId'>;

/** Момент времени, ISO-8601 в UTC. Строка — чтобы типы порта без потерь проходили через брокер. */
export type Instant = string;

export type Channel = 'AMAZON' | 'EBAY' | 'KAUFLAND' | 'OTTO';

/** Поле единицы записи (tenant_data.write_scope.field) */
export type ScopeField = 'PRICE' | 'QUANTITY';

/** Поле записи в канал (tenant_data.channel_write.field). CHANNEL_MIN_PRICE — только Kaufland Smart Pricing [Р-12] */
export type WriteField = ScopeField | 'CHANNEL_MIN_PRICE';

export type PriceBasis = 'GROSS' | 'NET';

/** Деньги: целые минимальные единицы + валюта + база. Float запрещён (INV-06). */
export interface Money {
  /** Безопасное целое (Number.isSafeInteger) */
  amountMinor: number;
  /** ISO 4217 */
  currency: string;
  basis: PriceBasis;
}

/**
 * Атрибуты идентичности оффера в канале. Имена совпадают с элементами
 * platform.channel_capability.write_scope_key_template и столбцами tenant_data.offer_mapping.
 */
export type IdentityAttribute =
  | 'channel_account'
  | 'region'
  | 'marketplace'
  | 'external_sku'
  | 'external_offer_id'
  | 'external_listing_id'
  | 'external_unit_id';

export interface OfferIdentity {
  region?: string;
  /** Код маркетплейса или витрины: A1PA6795UKMFR9, EBAY_DE, de/at (Kaufland), otto.de */
  marketplace?: string;
  externalSku?: string;
  externalOfferId?: string;
  externalListingId?: string;
  externalUnitId?: string;
  /** ASIN / ePID / EAN / id_product — для конкурентов, не для ключа записи */
  channelProductRef?: string;
}

/**
 * Контекст каждого вызова адаптера. Тенант приходит извне и проверяется адаптером
 * по каталогу аккаунтов до любого обращения к каналу [Р-31].
 */
export interface AdapterCallContext {
  tenantId: TenantId;
  channelAccountId: ChannelAccountId;
  correlationId: string;
  /** Крайний срок вызова; адаптер не начинает запрос к каналу, если не успеет */
  deadline: Instant;
  signal?: AbortSignal;
}

export interface PageRequest {
  cursor?: string;
  limit: number;
}

export interface Page<T> {
  items: T[];
  nextCursor?: string;
}
