import type { CompetitorOffer, CompetitorSnapshot, InboundDelivery, InboundResult, Money, PriceBasis } from '@repracer/channel-port';
import { logConservative } from './conservative.ts';
import { marketplaceInfo, SOURCE_ANY_OFFER_CHANGED } from './descriptor.ts';
import { channelError } from './errors.ts';
import { decimalToMinor } from './mapping.ts';
import { openSession, type AmazonAdapterOptions } from './session.ts';

/**
 * Уведомление ANY_OFFER_CHANGED (схема schemas/notifications/AnyOfferChangedNotification.json снимка). Доставка — очередь, без подписи
 * [AMZ_C08]: подлинность — совпадение SellerId уведомления с аккаунтом из сообщения [Р-31]. Повтор — тот же NotificationId,
 * дедупликацию делает ядро. Данные предложений — Amazon Information ≤ 18 мес [Р-3]; идентификаторы продавцов не агрегируются [Р-10].
 */

interface Price { Amount?: unknown; CurrencyCode?: unknown }
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
  let body: Notification;
  try {
    body = JSON.parse(delivery.rawBody) as Notification;
    if (!body || typeof body !== 'object') throw new Error('not an object');
  } catch {
    return { kind: 'REJECTED', error: channelError('VALIDATION', 'BATCH', 'notification body is not a JSON object'), responseStatus: 400 };
  }
  const id = body.NotificationMetadata?.NotificationId;
  if (body.NotificationType !== 'ANY_OFFER_CHANGED' || typeof id !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(id)) {
    return { kind: 'REJECTED', error: channelError('VALIDATION', 'BATCH', 'only ANY_OFFER_CHANGED with a NotificationId is accepted'), responseStatus: 400 };
  }
  const n = body.Payload?.AnyOfferChangedNotification;
  logConservative(options.deps.logger, ctx, 'AMZ_C08_NOTIFICATION_NOT_SIGNED', {});
  if (!n || n.SellerId !== session.sellerId) {
    await options.deps.alerts.raise({ code: 'AMAZON_NOTIFICATION_SELLER_MISMATCH', severity: 'CRITICAL', tenantId: ctx.tenantId, channelAccountId: ctx.channelAccountId,
      correlationId: ctx.correlationId, details: { notificationId: id } });
    return { kind: 'REJECTED', error: channelError('TENANT_MISMATCH', 'ACCOUNT', 'notification SellerId does not match the channel account', { raiseAlert: true }), responseStatus: 200 };
  }
  const trigger = n.OfferChangeTrigger;
  const marketplace = typeof trigger?.MarketplaceId === 'string' ? trigger.MarketplaceId : '';
  const info = marketplaceInfo(marketplace);
  const deliveryId = `amazon:${id}`;
  if (!info || !session.account.marketplaces.includes(marketplace)) {
    options.deps.logger.log({ level: 'WARN', code: 'AMZ_INBOUND_MARKETPLACE_NOT_ENABLED', message: 'notification for a store not enabled on the account is ignored',
      correlationId: ctx.correlationId, tenantId: ctx.tenantId, channelAccountId: ctx.channelAccountId, details: { marketplace } });
    return { kind: 'EVENTS', deliveryId, events: [], acknowledgeStatus: 200 };
  }
  const asin = typeof trigger?.ASIN === 'string' && /^[A-Z0-9]{10}$/.test(trigger.ASIN) ? trigger.ASIN : null;
  const observed = typeof trigger?.TimeOfOfferChange === 'string' && !Number.isNaN(Date.parse(trigger.TimeOfOfferChange)) ? new Date(trigger.TimeOfOfferChange).toISOString() : null;
  if (!asin || !observed) return { kind: 'REJECTED', error: channelError('VALIDATION', 'BATCH', 'notification lacks ASIN or TimeOfOfferChange', { raiseAlert: true }), responseStatus: 400 };
  const basis = info.basis as PriceBasis;
  const offers: CompetitorOffer[] = [];
  let buybox: CompetitorSnapshot['buybox'];
  for (const o of Array.isArray(n.Offers) ? n.Offers : []) {
    const price = money(o.ListingPrice, basis);
    if (!price || price.amountMinor === 0) continue;
    const shipping = money(o.Shipping, basis);
    const isSelf = o.SellerId === session.sellerId;
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
