import type {
  AdapterCallContext,
  ChannelError,
  CompetitorOffer,
  CompetitorQuery,
  CompetitorReadResult,
  CompetitorSnapshot,
  Instant,
  Money,
} from '@repracer/channel-port';
import { logConservative } from './conservative.ts';
import { KAUFLAND_LIMITS } from './descriptor.ts';
import { channelError, classifyTransportFailure } from './errors.ts';
import { acquireBudget, deadlinePassed, nowMs, openSession, type KauflandAdapterOptions } from './session.ts';

/** Источники совпадают с channel_data.competitor_state.source (миграция 0027, Р-36) */
export const SOURCE_BUYBOX = 'KAUFLAND_BUYBOX';
export const SOURCE_BUY_BOX_CHANGED = 'KAUFLAND_BUY_BOX_CHANGED';

/** Параметр condition GET /buybox (спецификация 2.44.0); used и refurbished — групповые */
const CONDITIONS = [
  'new', 'used', 'used - as new', 'used - very good', 'used - good', 'used - acceptable',
  'refurbished', 'refurbished - as new', 'refurbished - very good', 'refurbished - good', 'refurbished - acceptable',
] as const;

// ---------------------------------------------------------------------------
// GET /buybox — цены number (double) «в валюте витрины» [KFL_C06, K-17]
// ---------------------------------------------------------------------------

interface BuyboxUnit {
  buybox_rank?: number;
  seller?: string;
  price?: number;
  delivery_time_min?: number | null;
  delivery_time_max?: number | null;
  shipping_rate?: number;
  fulfillment_type?: string;
  condition?: string;
  id_unit?: number;
  id_offer?: string | null;
}

interface BuyboxData {
  id_product?: number;
  condition?: string;
  storefront?: string;
  num_units?: number;
  units?: BuyboxUnit[];
}

/** Основные единицы валюты (double) → целые центы. null — значение нельзя принять. */
export function majorToMinor(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  const minor = Math.round(value * 100);
  return Number.isSafeInteger(minor) ? minor : null;
}

function gross(amountMinor: number, currency: string): Money {
  return { amountMinor, currency, basis: 'GROSS' };
}

const STOREFRONT_CURRENCY: Readonly<Record<string, string>> = { de: 'EUR', at: 'EUR' };

export function buyboxSnapshot(data: BuyboxData, query: CompetitorQuery, observedAt: Instant): CompetitorSnapshot {
  const currency = STOREFRONT_CURRENCY[query.marketplace] ?? 'EUR';
  const offers: CompetitorOffer[] = [];
  for (const unit of [...(data.units ?? [])].sort((a, b) => (a.buybox_rank ?? Infinity) - (b.buybox_rank ?? Infinity))) {
    const priceMinor = majorToMinor(unit.price);
    if (priceMinor === null || priceMinor === 0) continue;
    const shippingMinor = majorToMinor(unit.shipping_rate);
    offers.push({
      ...(typeof unit.buybox_rank === 'number' ? { rank: unit.buybox_rank } : {}),
      ...(unit.seller ? { sellerRef: unit.seller } : {}),
      isSelf: typeof unit.id_unit === 'number',
      price: gross(priceMinor, currency),
      ...(shippingMinor !== null ? { shipping: gross(shippingMinor, currency), totalPrice: gross(priceMinor + shippingMinor, currency) } : {}),
      ...(unit.condition ? { condition: unit.condition } : {}),
      ...(unit.fulfillment_type ? { fulfillment: unit.fulfillment_type } : {}),
      deliveryDays: { min: unit.delivery_time_min ?? null, max: unit.delivery_time_max ?? null },
    });
  }
  const winner = offers.find((o) => o.rank === 1);
  return {
    marketplace: query.marketplace,
    channelProductRef: query.channelProductRef,
    condition: query.condition,
    source: SOURCE_BUYBOX,
    observedAt,
    completeness: { kind: 'TOP_N', n: KAUFLAND_LIMITS.buyboxMaxOffers },
    ...(winner ? { buybox: { price: winner.price, isSelf: winner.isSelf } } : {}),
    offers,
  };
}

export async function readCompetitorsKaufland(
  options: KauflandAdapterOptions, ctx: AdapterCallContext, queries: readonly CompetitorQuery[],
): Promise<CompetitorReadResult> {
  const opened = await openSession(options, ctx);
  if (!opened.ok) return { snapshots: [], failures: queries.map((query) => ({ query, error: opened.error })) };
  const { session } = opened;
  const snapshots: CompetitorSnapshot[] = [];
  const failures: Array<{ query: CompetitorQuery; error: ChannelError }> = [];

  for (const query of queries) {
    if (!session.account.marketplaces.includes(query.marketplace) || !(query.marketplace in STOREFRONT_CURRENCY)) {
      failures.push({ query, error: channelError('PRECONDITION_FAILED', 'ITEM', `storefront ${query.marketplace} is not enabled for the account`) });
      continue;
    }
    if (!/^[1-9][0-9]{0,18}$/.test(query.channelProductRef) || !(CONDITIONS as readonly string[]).includes(query.condition)) {
      failures.push({ query, error: channelError('VALIDATION', 'ITEM', 'buybox query needs numeric id_product and a Kaufland condition') });
      continue;
    }
    const late = deadlinePassed(options, ctx);
    if (late) { failures.push({ query, error: late }); continue; }
    const budgetError = acquireBudget(options, ctx, session, 1);
    if (budgetError) { failures.push({ query, error: budgetError }); continue; }

    const result = await session.client.request('get', '/buybox', {
      query: {
        id_product: Number(query.channelProductRef),
        storefront: query.marketplace as 'de',
        condition: query.condition as 'new',
        limit: KAUFLAND_LIMITS.buyboxMaxOffers,
      } as never,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    if (!result.ok) { failures.push({ query, error: classifyTransportFailure(result, 'ITEM', nowMs(options)) }); continue; }
    const data = (result.data as { data?: BuyboxData } | undefined)?.data;
    if (!data) { failures.push({ query, error: channelError('UNKNOWN', 'ITEM', 'GET /buybox returned no data') }); continue; }
    snapshots.push(buyboxSnapshot(data, query, new Date(nowMs(options)).toISOString()));
  }

  if (snapshots.length > 0) {
    logConservative(options.deps.logger, ctx, 'KFL_C06_BUYBOX_PRICE_UNITS', { snapshots: snapshots.length });
    logConservative(options.deps.logger, ctx, 'KFL_C18_BUYBOX_IS_SELF_BY_ID_UNIT', { snapshots: snapshots.length });
  }
  return { snapshots, failures };
}

// ---------------------------------------------------------------------------
// buy_box_changed — суммы целыми в минимальных единицах (документировано)
// ---------------------------------------------------------------------------

interface BbcPrice { amount?: number; currency_code?: string }
interface BbcOffer {
  rank?: number;
  id_unit?: number;
  id_offer?: string;
  seller?: { pseudonym?: string };
  prices?: { total_price?: BbcPrice; sales_price?: BbcPrice; shipping_cost?: BbcPrice; target_price?: BbcPrice };
  delivery_time?: { min?: number | null; max?: number | null };
}
export interface BuyBoxChangedPayload {
  buy_box_change?: string;
  id_product?: number;
  condition?: string;
  timestamp?: string;
  eans?: string[];
  winner_offer?: BbcOffer;
  seller_offer?: BbcOffer;
  offers?: BbcOffer[];
}

function minorMoney(price: BbcPrice | undefined): Money | undefined {
  if (!price || !Number.isSafeInteger(price.amount) || (price.amount as number) < 0) return undefined;
  if (typeof price.currency_code !== 'string' || !/^[A-Z]{3}$/.test(price.currency_code)) return undefined;
  return gross(price.amount as number, price.currency_code);
}

function bbcOffer(offer: BbcOffer): CompetitorOffer | null {
  const price = minorMoney(offer.prices?.sales_price);
  if (!price || price.amountMinor === 0) return null;
  const shipping = minorMoney(offer.prices?.shipping_cost);
  const total = minorMoney(offer.prices?.total_price);
  return {
    ...(typeof offer.rank === 'number' ? { rank: offer.rank } : {}),
    ...(offer.seller?.pseudonym ? { sellerRef: offer.seller.pseudonym } : {}),
    isSelf: typeof offer.id_unit === 'number',
    price,
    ...(shipping ? { shipping } : {}),
    ...(total ? { totalPrice: total } : {}),
    deliveryDays: { min: offer.delivery_time?.min ?? null, max: offer.delivery_time?.max ?? null },
  };
}

export function buyBoxChangedSnapshot(
  storefront: string, idMessage: string, payload: BuyBoxChangedPayload, fallbackObservedAt: Instant,
): CompetitorSnapshot | null {
  if (!Number.isSafeInteger(payload.id_product) || (payload.id_product as number) <= 0) return null;
  const ts = payload.timestamp ? Date.parse(payload.timestamp) : Number.NaN;
  const offers = (payload.offers ?? []).map(bbcOffer).filter((o): o is CompetitorOffer => o !== null)
    .sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity));
  const winnerPrice = minorMoney(payload.winner_offer?.prices?.sales_price);
  const selfIsWinner = payload.buy_box_change === 'won' || payload.seller_offer?.rank === 1;
  const target = minorMoney(payload.seller_offer?.prices?.target_price);
  return {
    marketplace: storefront,
    channelProductRef: String(payload.id_product),
    condition: payload.condition ?? 'new',
    source: SOURCE_BUY_BOX_CHANGED,
    sourceEventId: idMessage,
    observedAt: Number.isNaN(ts) ? fallbackObservedAt : new Date(ts).toISOString(),
    completeness: { kind: 'TOP_N', n: KAUFLAND_LIMITS.buyboxMaxOffers },
    ...(winnerPrice ? { buybox: { price: winnerPrice, isSelf: selfIsWinner } } : {}),
    offers,
    ...(target ? { channelSuggestedPrice: target } : {}),
  };
}
