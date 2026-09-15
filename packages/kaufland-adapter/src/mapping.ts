import type { IdentifiedObservation, Instant, Money, OfferIdentity } from '@repracer/channel-port';

/**
 * Unit в ответах Kaufland (GET /units, PATCH /units/{id_unit}, 207 bulk, payload item_unit_*).
 * Поля — из спецификации 2.44.0 и примера уведомления; все необязательны, разбор защитный.
 */
export interface KauflandUnit {
  id_unit?: number;
  storefront?: string;
  currency?: string;
  listing_price?: number;
  minimum_price?: number;
  price?: number;
  amount?: number;
  id_offer?: string | null;
  id_product?: number;
  id_item?: number;
  condition?: string;
  status?: string;
  fulfillment_type?: string;
  is_live?: boolean;
  date_lastchange_iso?: string;
  date_lastchange?: string;
  product?: { eans?: string[] };
  item?: { eans?: string[] };
}

export function unitIdentity(unit: KauflandUnit, storefrontFallback?: string): OfferIdentity {
  const storefront = unit.storefront ?? storefrontFallback;
  // Только id_product: связь id_item (payload item_unit_*) с id_product в /buybox документацией не подтверждена
  const productRef = unit.id_product;
  return {
    ...(storefront ? { marketplace: storefront.toLowerCase() } : {}),
    ...(unit.id_unit !== undefined ? { externalUnitId: String(unit.id_unit) } : {}),
    ...(unit.id_offer ? { externalOfferId: unit.id_offer } : {}),
    ...(productRef !== undefined ? { channelProductRef: String(productRef) } : {}),
  };
}

function eur(amountMinor: number, currency: string | undefined): Money {
  // Базa брутто — допущение KFL_C10 (K-12)
  return { amountMinor, currency: currency ?? 'EUR', basis: 'GROSS' };
}

export function lastChangeOf(unit: KauflandUnit): Instant | undefined {
  const raw = unit.date_lastchange_iso ?? unit.date_lastchange;
  if (!raw) return undefined;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

/**
 * Наблюдения по unit: цена (listing_price; цена покупателя — effectivePrice), остаток (amount), и minimum_price,
 * если он задан (признак Smart Pricing, KFL_C05).
 */
export function unitObservations(
  unit: KauflandUnit,
  source: IdentifiedObservation['source'],
  fallbackObservedAt: Instant,
  options: { storefront?: string; sourceEventId?: string; fields?: ReadonlyArray<'PRICE' | 'QUANTITY' | 'CHANNEL_MIN_PRICE'> } = {},
): IdentifiedObservation[] {
  const identity = unitIdentity(unit, options.storefront);
  const observedAt = lastChangeOf(unit) ?? fallbackObservedAt;
  const wanted = options.fields ?? ['PRICE', 'QUANTITY', 'CHANNEL_MIN_PRICE'];
  const liveness = unit.is_live === undefined ? undefined : { isLive: unit.is_live, reasons: [] as string[] };
  const common = {
    identity,
    observedAt,
    source,
    ...(liveness ? { liveness } : {}),
  };
  const out: IdentifiedObservation[] = [];

  if (wanted.includes('PRICE') && Number.isSafeInteger(unit.listing_price) && (unit.listing_price as number) > 0) {
    out.push({
      ...common,
      field: 'PRICE',
      value: { field: 'PRICE', price: eur(unit.listing_price as number, unit.currency) },
      ...(Number.isSafeInteger(unit.price) && (unit.price as number) > 0 ? { effectivePrice: eur(unit.price as number, unit.currency) } : {}),
      ...(options.sourceEventId ? { sourceEventId: `${options.sourceEventId}:PRICE` } : {}),
    });
  }
  if (wanted.includes('QUANTITY') && Number.isSafeInteger(unit.amount) && (unit.amount as number) >= 0) {
    out.push({
      ...common,
      field: 'QUANTITY',
      value: { field: 'QUANTITY', quantity: unit.amount as number },
      ...(options.sourceEventId ? { sourceEventId: `${options.sourceEventId}:QUANTITY` } : {}),
    });
  }
  if (wanted.includes('CHANNEL_MIN_PRICE') && Number.isSafeInteger(unit.minimum_price) && (unit.minimum_price as number) > 0) {
    out.push({
      ...common,
      field: 'CHANNEL_MIN_PRICE',
      value: { field: 'CHANNEL_MIN_PRICE', minPrice: eur(unit.minimum_price as number, unit.currency) },
      ...(options.sourceEventId ? { sourceEventId: `${options.sourceEventId}:CHANNEL_MIN_PRICE` } : {}),
    });
  }
  return out;
}

export function hasActiveMinimumPrice(unit: KauflandUnit): boolean {
  return Number.isSafeInteger(unit.minimum_price) && (unit.minimum_price as number) > 0;
}
