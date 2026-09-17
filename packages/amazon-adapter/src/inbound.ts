import type { CompetitorOffer, CompetitorSnapshot, InboundDelivery, InboundResult, Money, PriceBasis, PricingHealthObservation } from '@repracer/channel-port';
import { logConservative } from './conservative.ts';
import { marketplaceInfo, SOURCE_ANY_OFFER_CHANGED } from './descriptor.ts';
import { channelError } from './errors.ts';
import { decimalToMinor } from './mapping.ts';
import { openSession, type AmazonAdapterOptions } from './session.ts';

/**
 * Уведомления ANY_OFFER_CHANGED (схема schemas/notifications/AnyOfferChangedNotification.json снимка, ключи с заглавной) и PRICING_HEALTH
 * (PricingHealthNotification.json, ключи со строчной; шаг 23). Доставка — очередь, без подписи [AMZ_C08]: подлинность — совпадение SellerId
 * уведомления с аккаунтом из сообщения [Р-31]. Повтор — тот же NotificationId: журнал приёмника (packages/amazon-notifications) и правило
 * «новее — побеждает» ядра. Данные предложений — Amazon Information ≤ 18 мес [Р-3]; идентификаторы продавцов не агрегируются [Р-10].
 */

interface Price { Amount?: unknown; CurrencyCode?: unknown }
interface HealthMoney { amount?: unknown; currencyCode?: unknown }
interface PricingHealth {
  notificationType?: unknown;
  eventTime?: unknown;
  notificationMetadata?: { notificationId?: unknown };
  payload?: {
    sellerId?: unknown; issueType?: unknown;
    offerChangeTrigger?: { marketplaceId?: unknown; asin?: unknown; itemCondition?: unknown; timeOfOfferChange?: unknown };
    summary?: { referencePrice?: { competitivePriceThreshold?: HealthMoney } };
  };
}
interface AocOffer { SellerId?: unknown; SubCondition?: unknown; ListingPrice?: Price; Shipping?: Price; IsBuyBoxWinner?: unknown; IsFulfilledByAmazon?: unknown; ShippingTime?: { MinimumHours?: unknown; MaximumHours?: unknown } }
interface Notification {
  NotificationType?: unknown;
  NotificationMetadata?: { NotificationId?: unknown };
  Payload?: { AnyOfferChangedNotification?: { SellerId?: unknown; OfferChangeTrigger?: { MarketplaceId?: unknown; ASIN?: unknown; ItemCondition?: unknown; TimeOfOfferChange?: unknown }; Offers?: AocOffer[] } };
}

function money(p: Price | undefined, basis: PriceBasis): Money | null {
  const minor = decimalToMinor(p?.Amount);
  return minor === null || typeof p?.CurrencyCode !== 'string' || !/^[A-Z]{3}$/.test(p.CurrencyCode) ? null : { amountMinor: minor, currency: p.CurrencyCode, basis };
}

function days(hours: unknown): number | null {
  return typeof hours === 'number' && Number.isFinite(hours) && hours >= 0 ? Math.ceil(hours / 24) : null;
}

export async function handleInboundAmazon(options: AmazonAdapterOptions, delivery: InboundDelivery): Promise<InboundResult> {
  const ctx = { tenantId: delivery.claimed.tenantId, channelAccountId: delivery.claimed.channelAccountId, correlationId: `amz-inbound:${delivery.receivedAt}` };
  const opened = await openSession(options, ctx);
  if (!opened.ok) return { kind: 'REJECTED', error: opened.error, responseStatus: 404 };
  const { session } = opened;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(delivery.rawBody) as Record<string, unknown>;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('not an object');
  } catch {
    return { kind: 'REJECTED', error: channelError('VALIDATION', 'BATCH', 'notification body is not a JSON object'), responseStatus: 400 };
  }
  const aoc = raw as Notification;
  const ph = raw as PricingHealth;
  const type = aoc.NotificationType === 'ANY_OFFER_CHANGED' ? 'ANY_OFFER_CHANGED' : ph.notificationType === 'PRICING_HEALTH' ? 'PRICING_HEALTH' : null;
  const id = type === 'ANY_OFFER_CHANGED' ? aoc.NotificationMetadata?.NotificationId : ph.notificationMetadata?.notificationId;
  if (!type || typeof id !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(id)) {
    return { kind: 'REJECTED', error: channelError('VALIDATION', 'BATCH', 'only ANY_OFFER_CHANGED or PRICING_HEALTH with a NotificationId is accepted'), responseStatus: 400 };
  }
  logConservative(options.deps.logger, ctx, 'AMZ_C08_NOTIFICATION_NOT_SIGNED', {});
  const sellerId = type === 'ANY_OFFER_CHANGED' ? aoc.Payload?.AnyOfferChangedNotification?.SellerId : ph.payload?.sellerId;
  if (sellerId === undefined || sellerId !== session.sellerId) {
    await options.deps.alerts.raise({ code: 'AMAZON_NOTIFICATION_SELLER_MISMATCH', severity: 'CRITICAL', tenantId: ctx.tenantId, channelAccountId: ctx.channelAccountId,
      correlationId: ctx.correlationId, details: { notificationId: id } });
    return { kind: 'REJECTED', error: channelError('TENANT_MISMATCH', 'ACCOUNT', 'notification SellerId does not match the channel account', { raiseAlert: true }), responseStatus: 200 };
  }
  const marketplaceRaw = type === 'ANY_OFFER_CHANGED' ? aoc.Payload?.AnyOfferChangedNotification?.OfferChangeTrigger?.MarketplaceId : ph.payload?.offerChangeTrigger?.marketplaceId;
  const marketplace = typeof marketplaceRaw === 'string' ? marketplaceRaw : '';
  const info = marketplaceInfo(marketplace);
  const deliveryId = `amazon:${id}`;
  if (!info || !session.account.marketplaces.includes(marketplace)) {
    options.deps.logger.log({ level: 'WARN', code: 'AMZ_INBOUND_MARKETPLACE_NOT_ENABLED', message: 'notification for a store not enabled on the account is ignored',
      correlationId: ctx.correlationId, tenantId: ctx.tenantId, channelAccountId: ctx.channelAccountId, details: { marketplace } });
    return { kind: 'EVENTS', deliveryId, events: [], acknowledgeStatus: 200 };
  }
  const basis = info.basis as PriceBasis;
  return type === 'ANY_OFFER_CHANGED' ? anyOfferChanged(aoc, id, marketplace, basis, session.sellerId, deliveryId) : pricingHealth(ph, id, marketplace, basis, deliveryId);
}

const asinOf = (v: unknown) => (typeof v === 'string' && /^[A-Z0-9]{10}$/.test(v) ? v : null);
const instantOf = (v: unknown) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);

function anyOfferChanged(body: Notification, id: string, marketplace: string, basis: PriceBasis, self: string, deliveryId: string): InboundResult {
  const n = body.Payload!.AnyOfferChangedNotification!;
  const trigger = n.OfferChangeTrigger;
  const asin = asinOf(trigger?.ASIN);
  const observed = instantOf(trigger?.TimeOfOfferChange);
  if (!asin || !observed) return { kind: 'REJECTED', error: channelError('VALIDATION', 'BATCH', 'notification lacks ASIN or TimeOfOfferChange', { raiseAlert: true }), responseStatus: 400 };
  const offers: CompetitorOffer[] = [];
  let buybox: CompetitorSnapshot['buybox'];
  for (const o of Array.isArray(n.Offers) ? n.Offers : []) {
    const price = money(o.ListingPrice, basis);
    if (!price || price.amountMinor === 0) continue;
    const shipping = money(o.Shipping, basis);
    const isSelf = o.SellerId === self;
    const offer: CompetitorOffer = {
      isSelf, ...(typeof o.SellerId === 'string' && !isSelf ? { sellerRef: o.SellerId } : {}), price,
      ...(shipping ? { shipping, totalPrice: { ...price, amountMinor: price.amountMinor + shipping.amountMinor } } : {}),
      ...(typeof o.SubCondition === 'string' ? { condition: o.SubCondition.toLowerCase() } : {}),
      fulfillment: o.IsFulfilledByAmazon === true ? 'AFN' : 'MFN',
      deliveryDays: { min: days(o.ShippingTime?.MinimumHours), max: days(o.ShippingTime?.MaximumHours) },
    };
    offers.push(offer);
    if (o.IsBuyBoxWinner === true) buybox = { price, isSelf };
  }
  const snapshot: CompetitorSnapshot = {
    marketplace, channelProductRef: asin, condition: typeof trigger?.ItemCondition === 'string' ? trigger.ItemCondition.toLowerCase() : 'new',
    source: SOURCE_ANY_OFFER_CHANGED, sourceEventId: id, observedAt: observed,
    completeness: { kind: 'TOP_N', n: Math.max(1, offers.length) }, ...(buybox ? { buybox } : {}), offers,
  };
  return { kind: 'EVENTS', deliveryId, events: [{ kind: 'COMPETITOR_SNAPSHOT', snapshot }], acknowledgeStatus: 200 };
}

/**
 * PRICING_HEALTH: оффер продавца не может быть Featured Offer из-за неконкурентной цены (notification-type-values). В решение о цене не
 * входит: состояние оффера для экрана товаров. issueType — строка без перечня значений в схеме; порог — summary.referencePrice.competitivePriceThreshold.
 */
function pricingHealth(body: PricingHealth, id: string, marketplace: string, basis: PriceBasis, deliveryId: string): InboundResult {
  const p = body.payload!;
  const asin = asinOf(p.offerChangeTrigger?.asin);
  const occurredAt = instantOf(p.offerChangeTrigger?.timeOfOfferChange) ?? instantOf(body.eventTime);
  const issueType = typeof p.issueType === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(p.issueType) ? p.issueType : null;
  if (!asin || !occurredAt || !issueType) {
    return { kind: 'REJECTED', error: channelError('VALIDATION', 'BATCH', 'PRICING_HEALTH lacks asin, timeOfOfferChange or issueType', { raiseAlert: true }), responseStatus: 400 };
  }
  const t = p.summary?.referencePrice?.competitivePriceThreshold;
  const health: PricingHealthObservation = {
    marketplace, channelProductRef: asin, condition: typeof p.offerChangeTrigger?.itemCondition === 'string' ? p.offerChangeTrigger.itemCondition.toLowerCase() : 'new',
    issueType, occurredAt, competitivePriceThreshold: money(t ? { Amount: t.amount, CurrencyCode: t.currencyCode } : undefined, basis), sourceEventId: id,
  };
  return { kind: 'EVENTS', deliveryId, events: [{ kind: 'PRICING_HEALTH', health }], acknowledgeStatus: 200 };
}
