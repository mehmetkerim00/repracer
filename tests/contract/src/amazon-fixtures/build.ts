import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Exchange, Scenario, Step, World } from '../harness/scenario.ts';
import { SCENARIO_FORMAT } from '../harness/scenario.ts';

/**
 * Построитель сценариев Amazon (шаг 22). Сценарии пути решения — те же обязательные сценарии Kaufland, преобразованные: витрина
 * de → amazon.de, unit → SKU, товар → ASIN, buy_box_changed и опрос /buybox → уведомления ANY_OFFER_CHANGED, запись PATCH /units →
 * чтение оффера и patchListingsItem. Поправки, которых требует асинхронная запись Amazon, — явные функции patch у сценария.
 * Сценарии адаптера — вручную. Все данные синтетические; формы — снимок моделей и страницы документации из vendor/amazon/.../SOURCE.md.
 *
 * Фикстуры в fixtures/amazon — результат этого построителя; тест сверяет, что они не разошлись.
 */

export const DE = 'A1PA6795UKMFR9';
export const US = 'ATVPDKIKX0DER';
export const SELLER = 'A1SYNSELLER0001';
export const ACCESS_TOKEN = 'Atza|syn-access-token-0001';
const REFRESH_TOKEN = 'Atzr|syn-refresh-token-0001';
const CLIENT_ID = 'amzn1.application-oa2-client.syn0001';
const CLIENT_SECRET = 'syn-lwa-client-secret-0001';

const KAUFLAND = fileURLToPath(new URL('../../fixtures/kaufland/', import.meta.url));

const SOURCES = [
  'vendor/amazon/sp-api-models/2026-09-16/models/listings-items-api-model/listingsItems_2021-08-01.json',
  'vendor/amazon/sp-api-models/2026-09-16/schemas/notifications/AnyOfferChangedNotification.json',
  'https://developer-docs.amazon/sp-api/docs/manage-purchasable-offer.md',
  'https://developer-docs.amazon/sp-api/docs/connecting-to-the-selling-partner-api.md',
  'https://developer-docs.amazon/sp-api/docs/listings-items-api-rate-limits.md',
];

export function asin(ref: string): string {
  return `B0${ref.slice(-8).padStart(8, '0')}`;
}
export function sku(unit: string | number): string {
  return `SYN-SKU-${unit}`;
}
const SELLER_IDS: Record<string, string> = {};
export function sellerIdOf(pseudonym: string): string {
  if (!SELLER_IDS[pseudonym]) SELLER_IDS[pseudonym] = `A2SYNCOMP${String(Object.keys(SELLER_IDS).length + 1).padStart(5, '0')}`;
  return SELLER_IDS[pseudonym]!;
}
const major = (minor: number) => Number(`${Math.trunc(minor / 100)}.${String(Math.abs(minor % 100)).padStart(2, '0')}`);

export function amazonWorld(extra: Partial<World> = {}, region: 'EU' | 'NA' = 'EU'): World {
  return {
    clock: '2026-09-14T10:00:00.000Z',
    tenantId: '10000000-0000-4000-8000-000000000001',
    channelAccountId: '20000000-0000-4000-8000-000000000001',
    account: { externalAccountId: SELLER, marketplaces: region === 'EU' ? [DE] : [US], channel: 'AMAZON', region },
    credentials: { seller: { refreshToken: REFRESH_TOKEN }, application: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }, accessToken: ACCESS_TOKEN },
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Обмены
// ---------------------------------------------------------------------------

export function tokenExchange(): Exchange {
  return {
    id: 'lwa-token', note: 'Токен LWA по refresh_token (connecting-to-the-selling-partner-api); тело формы проверяет стенд',
    request: { method: 'POST', path: '/auth/o2/token', body: { $type: 'string' } },
    response: { status: 200, body: { access_token: ACCESS_TOKEN, token_type: 'bearer', expires_in: 3600, refresh_token: REFRESH_TOKEN } },
  };
}

const listingPath = (s: string) => `/listings/2021-08-01/items/${SELLER}/${encodeURIComponent(s)}`;

export interface OfferState {
  marketplace?: string;
  priceMinor: number;
  currency?: string;
  purchaseMinor?: number;
  quantity?: number;
  rulePlan?: boolean;
  bounds?: boolean;
  discounted?: boolean;
  asin?: string;
}

function attributes(offers: readonly OfferState[]) {
  return {
    purchasable_offer: offers.map((o) => ({
      marketplace_id: o.marketplace ?? DE, currency: o.currency ?? 'EUR', audience: 'ALL',
      our_price: [{ schedule: [{ value_with_tax: major(o.priceMinor) }] }],
      ...(o.rulePlan ? { automated_pricing_merchandising_rule_plan: [{ rule_id: 'syn-automated-pricing-rule-0001' }] } : {}),
      ...(o.bounds ? { minimum_seller_allowed_price: [{ schedule: [{ value_with_tax: 3.0 }] }], maximum_seller_allowed_price: [{ schedule: [{ value_with_tax: 50.0 }] }] } : {}),
      ...(o.discounted ? { discounted_price: [{ schedule: [{ start_at: '2026-01-01', end_at: '2027-01-01', value_with_tax: major(Math.round(o.priceMinor * 0.9)) }] }] } : {}),
    })),
    ...(offers.some((o) => o.quantity !== undefined) ? { fulfillment_availability: [{ fulfillment_channel_code: 'DEFAULT', quantity: offers.find((o) => o.quantity !== undefined)!.quantity }] } : {}),
  };
}

function summaries(skuValue: string, offers: readonly OfferState[]) {
  return offers.map((o) => ({ marketplaceId: o.marketplace ?? DE, asin: o.asin ?? `B0${skuValue.replace(/\D/g, '').slice(-8).padStart(8, '0')}`, productType: 'SYNTHETIC_PRODUCT_TYPE', status: ['BUYABLE', 'DISCOVERABLE'] }));
}

export function preReadExchange(id: string, skuValue: string, offers: readonly OfferState[]): Exchange {
  return {
    id, note: 'Чтение оффера перед записью: тип товара и собственное ценообразование канала [AMZ_C03, AMZ_C09]',
    request: { method: 'GET', path: listingPath(skuValue), query: { marketplaceIds: offers.map((o) => o.marketplace ?? DE).join(','), includedData: 'summaries,attributes' } },
    response: { status: 200, body: { sku: skuValue, summaries: summaries(skuValue, offers), attributes: attributes(offers) } },
  };
}

export function readBackExchange(id: string, skuValue: string, offers: readonly OfferState[]): Exchange {
  return {
    id,
    request: { method: 'GET', path: listingPath(skuValue), query: { marketplaceIds: offers.map((o) => o.marketplace ?? DE).join(','), includedData: 'summaries,attributes,offers,fulfillmentAvailability,issues' } },
    response: { status: 200, body: {
      sku: skuValue, summaries: summaries(skuValue, offers), attributes: attributes(offers), issues: [],
      offers: offers.map((o) => ({ marketplaceId: o.marketplace ?? DE, offerType: 'B2C', price: { currencyCode: o.currency ?? 'EUR', amount: String(major(o.purchaseMinor ?? o.priceMinor)) } })),
      fulfillmentAvailability: offers.some((o) => o.quantity !== undefined) ? [{ fulfillmentChannelCode: 'DEFAULT', quantity: offers.find((o) => o.quantity !== undefined)!.quantity }] : [],
    } },
  };
}

export function patchPriceExchange(id: string, skuValue: string, prices: ReadonlyArray<{ marketplace?: string; minor: number; currency?: string }>,
  response: Exchange['response'] | 'TIMEOUT' = 'ACCEPTED' as never): Exchange {
  const request = {
    method: 'PATCH', path: listingPath(skuValue), query: { marketplaceIds: prices.map((p) => p.marketplace ?? DE).join(','), includedData: 'issues' },
    body: { productType: 'SYNTHETIC_PRODUCT_TYPE', patches: [{ op: 'merge', path: '/attributes/purchasable_offer',
      value: prices.map((p) => ({ marketplace_id: p.marketplace ?? DE, currency: p.currency ?? 'EUR', audience: 'ALL', our_price: [{ schedule: [{ value_with_tax: major(p.minor) }] }] })) }] },
  };
  if (response === 'TIMEOUT') return { id, request, fault: 'TIMEOUT', note: 'Amazon получил запрос, ответа нет до тайм-аута клиента: итог неизвестен' };
  return { id, request, response: (response as unknown) === 'ACCEPTED' ? accepted(skuValue) : response! };
}

export function accepted(skuValue: string, issues: unknown[] = []): Exchange['response'] {
  return { status: 200, body: { sku: skuValue, status: 'ACCEPTED', submissionId: `syn-submission-${skuValue}`, issues } };
}

// ---------------------------------------------------------------------------
// Уведомления
// ---------------------------------------------------------------------------

export interface AocOffer { seller: string; minor: number; shippingMinor?: number; buyBoxWinner?: boolean; minDays?: number; maxDays?: number; currency?: string }

export function anyOfferChanged(notificationId: string, marketplace: string, asinValue: string, time: unknown, offers: readonly AocOffer[], sellerId = SELLER): Record<string, unknown> {
  const money = (minor: number, currency: string) => ({ Amount: major(minor), CurrencyCode: currency });
  const winner = offers.find((o) => o.buyBoxWinner);
  return {
    NotificationVersion: '1.0', NotificationType: 'ANY_OFFER_CHANGED', PayloadVersion: '1.0', EventTime: time,
    NotificationMetadata: { ApplicationId: 'amzn1.sellerapps.app.syn0001', SubscriptionId: 'syn-subscription-0001', PublishTime: time, NotificationId: notificationId },
    Payload: { AnyOfferChangedNotification: {
      SellerId: sellerId,
      OfferChangeTrigger: { MarketplaceId: marketplace, ASIN: asinValue, ItemCondition: 'new', TimeOfOfferChange: time, OfferChangeType: 'External' },
      Summary: {
        NumberOfOffers: [{ Condition: 'new', FulfillmentChannel: 'Merchant', OfferCount: offers.length }],
        LowestPrices: [], BuyBoxPrices: winner ? [{ Condition: 'new', LandedPrice: money(winner.minor + (winner.shippingMinor ?? 0), winner.currency ?? 'EUR'), ListingPrice: money(winner.minor, winner.currency ?? 'EUR'), Shipping: money(winner.shippingMinor ?? 0, winner.currency ?? 'EUR') }] : [],
        TotalBuyBoxEligibleOffers: offers.length, SalesRankings: [], NumberOfBuyBoxEligibleOffers: [],
      },
      Offers: offers.map((o) => ({
        SellerId: o.seller === 'self' ? sellerId : sellerIdOf(o.seller), SubCondition: 'new', SellerFeedbackRating: { FeedbackCount: 120, SellerPositiveFeedbackRating: 98 },
        ShippingTime: { MinimumHours: (o.minDays ?? 1) * 24, MaximumHours: (o.maxDays ?? 3) * 24, AvailabilityType: 'NOW' },
        ListingPrice: money(o.minor, o.currency ?? 'EUR'), Shipping: money(o.shippingMinor ?? 0, o.currency ?? 'EUR'), ShipsFrom: { Country: 'DE' },
        IsFulfilledByAmazon: false, IsBuyBoxWinner: Boolean(o.buyBoxWinner), PrimeInformation: { IsOfferPrime: false, IsOfferNationalPrime: false },
        IsExpeditedShippingAvailable: false, IsFeaturedMerchant: true, ShipsDomestically: true, ShipsInternationally: false,
      })),
    } },
  };
}

export function delivery(body: unknown, claimed?: { tenantId?: string; channelAccountId?: string }) {
  return { method: 'POST', url: 'https://sqs.eu-west-1.amazonaws.com.invalid/000000000000/repracer-syn-notifications', headers: {}, body, ...(claimed ? { claimed } : {}) };
}

// ---------------------------------------------------------------------------
// Преобразование сценариев Kaufland
// ---------------------------------------------------------------------------

interface KauflandOffer { rank?: number; id_unit?: number; seller?: { pseudonym?: string }; prices?: { sales_price?: { amount?: number }; shipping_cost?: { amount?: number } }; delivery_time?: { min?: number; max?: number } }

function mapIds(value: unknown, refs: ReadonlySet<string>, key = ''): unknown {
  if (typeof value === 'string') {
    if (key === 'marketplace' && value === 'de') return DE;
    if ((key === 'channelProductRef' || key === 'productRef') && refs.has(value)) return asin(value);
    if (key === 'externalUnitId') return sku(value);
    if (key === 'source' && value.startsWith('KAUFLAND_')) return 'AMAZON_ANY_OFFER_CHANGED';
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => mapIds(v, refs, key));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => {
      const m = /^de\|(\d+)\|(.+)$/.exec(k);
      return [m ? `${DE}|${asin(m[1]!)}|${m[2]}` : k, mapIds(v, refs, k)];
    }));
  }
  return value;
}

function kauflandOffersToAoc(offers: readonly KauflandOffer[]): AocOffer[] {
  return offers.map((o) => ({
    seller: typeof o.id_unit === 'number' ? 'self' : o.seller?.pseudonym ?? 'Synthetic Competitor', minor: o.prices?.sales_price?.amount ?? 0,
    shippingMinor: o.prices?.shipping_cost?.amount ?? 0, buyBoxWinner: o.rank === 1, minDays: o.delivery_time?.min ?? 1, maxDays: o.delivery_time?.max ?? 3,
  }));
}

/** Единицы /buybox (основные единицы, K-17 = MAJOR; в сценарии ×100 — центы) → предложения уведомления */
function buyboxUnitsToAoc(units: ReadonlyArray<{ buybox_rank?: number; seller?: string; price?: number; shipping_rate?: number; id_unit?: number; delivery_time_min?: number; delivery_time_max?: number }>): AocOffer[] {
  return units.map((u) => ({
    seller: typeof u.id_unit === 'number' ? 'self' : u.seller ?? 'Synthetic Competitor', minor: Math.round((u.price ?? 0) * 100),
    shippingMinor: Math.round((u.shipping_rate ?? 0) * 100), buyBoxWinner: u.buybox_rank === 1, minDays: u.delivery_time_min ?? 1, maxDays: u.delivery_time_max ?? 2,
  }));
}

export interface Conversion {
  steps: Step[];
  exchanges: Exchange[];
  scenario: Scenario;
  refs: Set<string>;
}

/** Сценарий Kaufland → черновик Amazon: мир, шаги, обмены и ожидания с переведёнными идентификаторами */
export function convertKauflandScenario(file: string, id: string, title: string): Conversion {
  const k = JSON.parse(readFileSync(`${KAUFLAND}${file}`, 'utf8')) as Scenario;
  const refs = new Set<string>();
  for (const s of k.world.pricing?.scopes ?? []) refs.add(s.channelProductRef);
  const exchanges: Exchange[] = [];
  const kex = [...k.exchanges];
  const scopes = k.world.pricing?.scopes ?? [];
  const currentPrice = new Map(scopes.map((s) => [s.externalUnitId, s.currentPriceMinor ?? 1000]));
  const steps: Step[] = [];
  let n = 0;
  for (const step of k.steps) {
    if (step.kind === 'pipelineInbound') {
      const body = step.delivery.body as { id_message: string; payload: { id_product: number; timestamp: unknown; offers?: KauflandOffer[] } };
      refs.add(String(body.payload.id_product));
      steps.push({ ...step, delivery: delivery(anyOfferChanged(`syn-${body.id_message}`, DE, asin(String(body.payload.id_product)), body.payload.timestamp,
        kauflandOffersToAoc(body.payload.offers ?? [])), step.delivery.claimed) } as Step);
    } else if (step.kind === 'pipelinePoll') {
      // Опроса у Amazon нет [AMZ_C07]: тот же ответ /buybox приходит уведомлением
      const expected = (step.expect as { snapshots?: unknown[] } | undefined)?.snapshots ?? [];
      (step.queries as Array<{ channelProductRef: string }>).forEach((q, i) => {
        const at = kex.findIndex((e) => e.request.path === '/v2/buybox' && (e.request.query as Record<string, string>)?.id_product === q.channelProductRef);
        const ex = kex.splice(at, 1)[0]!;
        const units = ((ex.response!.body as { data: { units: Parameters<typeof buyboxUnitsToAoc>[0] } }).data.units);
        refs.add(q.channelProductRef);
        steps.push({ id: `${step.id}-${i + 1}`, kind: 'pipelineInbound',
          delivery: delivery(anyOfferChanged(`syn-poll-${q.channelProductRef}-${++n}`, DE, asin(q.channelProductRef), { $clockIso: 0 }, buyboxUnitsToAoc(units))),
          ...(expected[i] ? { expect: { inbound: { kind: 'EVENTS' }, snapshots: [expected[i]] } } : {}) } as Step);
      });
    } else {
      steps.push(step);
    }
  }
  // Оставшиеся обмены записи: PATCH /units → чтение оффера и patchListingsItem; GET /units → обратное чтение
  for (const e of kex) {
    const unit = /^\/v2\/units\/(\d+)$/.exec(e.request.path)?.[1];
    if (e.request.method === 'PATCH' && unit) {
      const price = (e.request.body as { listing_price: number }).listing_price;
      exchanges.push(preReadExchange(`${e.id}-read`, sku(unit), [{ priceMinor: currentPrice.get(unit) ?? price }]));
      exchanges.push(patchPriceExchange(`${e.id}-patch`, sku(unit), [{ minor: price }], e.fault === 'TIMEOUT' ? 'TIMEOUT' : ('ACCEPTED' as never)));
      currentPrice.set(unit, price);
    } else if (e.request.method === 'GET' && unit) {
      const data = (e.response!.body as { data: { listing_price: number; price: number } }).data;
      exchanges.push(readBackExchange(e.id, sku(unit), [{ priceMinor: data.listing_price, purchaseMinor: data.price }]));
    } else if (e.request.path !== '/v2/buybox') {
      throw new Error(`${file}: exchange ${e.id} ${e.request.method} ${e.request.path} has no Amazon counterpart`);
    }
  }
  if (exchanges.length > 0) exchanges.unshift(tokenExchange());

  const pricing = k.world.pricing ? mapIds(k.world.pricing, refs) as NonNullable<World['pricing']> : undefined;
  if (pricing) pricing.marketplaces = { ...(pricing.marketplaces ?? {}), [DE]: { currency: 'EUR', basis: 'GROSS' } };
  const scenario: Scenario = {
    format: SCENARIO_FORMAT, id, channel: 'AMAZON', apiVersion: 'listings-items-2021-08-01', title,
    description: `Преобразован из kaufland/${file}: ${k.description}`,
    tags: [...k.tags],
    provenance: { kind: 'SYNTHETIC_FROM_DOCS', sources: [...SOURCES, `tests/contract/fixtures/kaufland/${file}`] },
    world: amazonWorld({ clock: k.world.clock, ...(pricing ? { pricing } : {}), ...(k.world.adapter?.confirmationWindowMs !== undefined ? { adapter: { confirmationWindowMs: k.world.adapter.confirmationWindowMs } } : {}), ...(k.world.client ? { client: k.world.client } : {}) }),
    steps: mapIds(steps, refs) as Step[],
    exchanges,
    ...(k.expect ? { expect: mapIds(k.expect, refs) as Scenario['expect'] } : {}),
  };
  return { steps: scenario.steps, exchanges, scenario, refs };
}
