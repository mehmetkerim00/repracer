import type { Money, PriceBasis } from '@repracer/channel-port';
import type { ListingsItem } from '@repracer/amazon-client';
import { marketplaceInfo } from './descriptor.ts';

/**
 * Разбор атрибутов оффера. Форма purchasable_offer и fulfillment_availability — страницы manage-purchasable-offer и merge-a-listing
 * (SHA-256 в SOURCE.md): purchasable_offer — массив офферов с селекторами marketplace_id, currency, audience; our_price —
 * [{schedule: [{value_with_tax}]}]; fulfillment_availability — [{fulfillment_channel_code: 'DEFAULT', quantity}].
 */

/** Десятичное число (строка модели Decimal или число JSON) → целые минимальные единицы; дробь мельче цента — null */
export function decimalToMinor(value: unknown): number | null {
  const text = typeof value === 'number' ? (Number.isFinite(value) ? String(value) : '') : typeof value === 'string' ? value.trim() : '';
  const m = /^(\d{1,15})(?:\.(\d+))?$/.exec(text);
  if (!m) return null;
  const frac = (m[2] ?? '').padEnd(2, '0');
  if (/[1-9]/.test(frac.slice(2))) return null;
  const minor = Number(m[1]) * 100 + Number(frac.slice(0, 2));
  return Number.isSafeInteger(minor) ? minor : null;
}

/** Целые центы → число JSON без потери точности (сериализация 17.75, а не 17.749999) */
export function minorToDecimal(minor: number): number {
  return Number(`${Math.trunc(minor / 100)}.${String(Math.abs(minor % 100)).padStart(2, '0')}`);
}

type Offer = Record<string, unknown>;

function offersOf(item: ListingsItem): Offer[] {
  const po = item.attributes?.purchasable_offer;
  return Array.isArray(po) ? po.filter((o): o is Offer => Boolean(o) && typeof o === 'object') : [];
}

/** Оффер витрины для аудитории ALL (аудитория по умолчанию — ALL, страница manage-purchasable-offer) */
export function purchasableOffer(item: ListingsItem, marketplaceId: string): Offer | null {
  return offersOf(item).find((o) => o.marketplace_id === marketplaceId && (o.audience === undefined || o.audience === 'ALL')) ?? null;
}

function present(value: unknown): boolean {
  return value !== undefined && value !== null && !(Array.isArray(value) && value.length === 0);
}

/** Р-115: привязка к правилу автоматического ценообразования; Р-114: границы цены, заданные в канале */
export function channelOwnedPricing(item: ListingsItem, marketplaceId: string): { repricer: boolean; bounds: boolean } {
  const o = purchasableOffer(item, marketplaceId);
  if (!o) return { repricer: false, bounds: false };
  return {
    repricer: present(o.automated_pricing_merchandising_rule_plan),
    bounds: present(o.minimum_seller_allowed_price) || present(o.maximum_seller_allowed_price),
  };
}

/** Записанная базовая цена: our_price[0].schedule[0].value_with_tax [AMZ_C04] */
export function ourPrice(item: ListingsItem, marketplaceId: string): Money | null {
  const o = purchasableOffer(item, marketplaceId);
  const info = marketplaceInfo(marketplaceId);
  const schedule = Array.isArray(o?.our_price) ? ((o!.our_price as Array<{ schedule?: Array<{ value_with_tax?: unknown }> }>)[0]?.schedule ?? []) : [];
  const minor = decimalToMinor(schedule[0]?.value_with_tax);
  const currency = typeof o?.currency === 'string' ? o.currency : info?.currency;
  return minor === null || !currency || !info ? null : { amountMinor: minor, currency, basis: info.basis as PriceBasis };
}

/** Цена покупателя: offers[] (B2C) — definitions.ItemOfferByMarketplace.price, «Purchase price» */
export function purchasePrice(item: ListingsItem, marketplaceId: string): Money | null {
  const offer = (item.offers ?? []).find((o) => o.marketplaceId === marketplaceId && o.offerType === 'B2C');
  const info = marketplaceInfo(marketplaceId);
  const minor = offer ? decimalToMinor(offer.price?.amount) : null;
  return minor === null || !info ? null : { amountMinor: minor, currency: offer!.price.currencyCode, basis: info.basis as PriceBasis };
}

/** Действующая скидочная цена меняет цену покупателя: сверка базы цены по ней невозможна [Р-116] */
export function hasDiscountedPrice(item: ListingsItem, marketplaceId: string): boolean {
  return present(purchasableOffer(item, marketplaceId)?.discounted_price);
}

/** Остаток MFN: fulfillmentAvailability с кодом DEFAULT (одно значение на SKU в регионе, A-01) */
export function merchantQuantity(item: ListingsItem): number | null {
  const fa = (item.fulfillmentAvailability ?? []).find((f) => f.fulfillmentChannelCode === 'DEFAULT');
  return fa && Number.isSafeInteger(fa.quantity) && (fa.quantity as number) >= 0 ? (fa.quantity as number) : null;
}

export function productTypeOf(item: ListingsItem, marketplaceId: string): string | null {
  return (item.summaries ?? []).find((s) => s.marketplaceId === marketplaceId)?.productType ?? item.summaries?.[0]?.productType ?? null;
}

export function listingPath(sellerId: string, sku: string): string {
  return `/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}`;
}
