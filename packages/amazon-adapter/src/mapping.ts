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

/** Шаг 69 (OQ-249): предел длины названия товара из канала — столбец без предела, но название не должно быть книгой */
export const OFFER_TITLE_MAX = 200;

/**
 * Шаг 69 (OQ-249): название товара из ответа канала. Пробелы и управляющие символы схлопываются в один пробел (NUL PostgreSQL в text не
 * примет), края обрезаются, длина — не больше OFFER_TITLE_MAX символов (по кодовым точкам: суррогатная пара не режется пополам).
 * Не строка или пусто — undefined: канал названия не отдал
 */
export function offerTitle(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const flat = raw.replace(/[\s\u0000-\u001f\u007f]+/g, ' ').trim();
  if (flat.length === 0) return undefined;
  const points = Array.from(flat);
  return points.length <= OFFER_TITLE_MAX ? flat : points.slice(0, OFFER_TITLE_MAX).join('').trimEnd();
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

/**
 * Шаг 51 [AMZ_C13, A-21]: способ исполнения по fulfillmentAvailability. DEFAULT — наша сеть (FBM); только иные коды — сеть Amazon (FBA);
 * кодов нет — неизвестно. Коды сети Amazon снимок не перечисляет, поэтому «не DEFAULT» и есть признак FBA
 */
export function fulfillmentOf(item: ListingsItem): { kind: 'MERCHANT' | 'AMAZON' | 'UNKNOWN'; codes: string[] } {
  const codes = [...new Set((item.fulfillmentAvailability ?? []).map((f) => f.fulfillmentChannelCode).filter((c): c is string => typeof c === 'string' && c.length > 0))];
  if (codes.includes('DEFAULT')) return { kind: 'MERCHANT', codes };
  return { kind: codes.length > 0 ? 'AMAZON' : 'UNKNOWN', codes };
}

export function productTypeOf(item: ListingsItem, marketplaceId: string): string | null {
  return (item.summaries ?? []).find((s) => s.marketplaceId === marketplaceId)?.productType ?? item.summaries?.[0]?.productType ?? null;
}

export function listingPath(sellerId: string, sku: string): string {
  return `/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}`;
}

/**
 * Шаг 70 [Р-205, AMZ_C15]: ответ о том ли, что спрошено. Модель снимка (listingsItems_2021-08-01): `sku` обязателен у Item и у
 * ListingsItemSubmissionResponse, `marketplaceId` — у ItemSummaryByMarketplace и ItemOfferByMarketplace. Сверяется: sku ответа равен
 * запрошенному (`sku` null — запроса по SKU не было, у поиска); витрины сводок и офферов — только из marketplaceIds запроса (что SP-API их
 * так ограничивает, снимок прямо не говорит — A-28, отсюда консервативное правило). Песочница отдала образец о чужом SKU с витриной вне
 * запроса, и до шага адаптер его принял. Текст несовпадения не называет чужой SKU — только вид и витрины
 */
export type ResponseMismatch = { kind: 'SKU' | 'STOREFRONT'; message: string };

export function responseIdentityMismatch(item: unknown, sku: string | null, marketplaces: readonly string[]): ResponseMismatch | null {
  const body = (item && typeof item === 'object' ? item : {}) as { sku?: unknown; summaries?: unknown; offers?: unknown };
  if (sku !== null && body.sku !== sku) return { kind: 'SKU', message: body.sku === undefined ? 'the response carries no sku' : 'the response is about another SKU than requested' };
  const foreign = new Set<string>();
  for (const list of [body.summaries, body.offers]) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      const marketplace = (entry as { marketplaceId?: unknown } | null)?.marketplaceId;
      if (typeof marketplace !== 'string' || !marketplaces.includes(marketplace)) foreign.add(typeof marketplace === 'string' ? marketplace : '(none)');
    }
  }
  return foreign.size > 0
    ? { kind: 'STOREFRONT', message: `the response holds storefronts outside the request: ${[...foreign].sort().join(', ').slice(0, 120)}` }
    : null;
}
