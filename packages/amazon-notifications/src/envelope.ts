/**
 * Конверт уведомления SP-API. Страница set-up-notifications-with-amazon-sqs (раздел «Notification structure») описывает ключи с заглавной
 * буквы — NotificationType, NotificationMetadata.NotificationId, так приходит ANY_OFFER_CHANGED (схема AnyOfferChangedNotification.json).
 * У PRICING_HEALTH ключи со строчной — notificationType, notificationMetadata.notificationId (схема PricingHealthNotification.json и пример
 * на странице notification-type-values). Разбор принимает оба написания, каждое — только целиком для своего уровня.
 */
export interface NotificationEnvelope {
  notificationType: string;
  notificationId: string;
  applicationId: string;
  subscriptionId: string | null;
  publishTime: string | null;
  eventTime: string | null;
  sellerId: string | null;
  marketplaceId: string | null;
}

export type EnvelopeProblem = 'NOT_JSON' | 'NO_TYPE' | 'NO_METADATA' | 'NO_NOTIFICATION_ID' | 'NO_APPLICATION_ID';

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 && v.length <= 256 ? v : null);
const instant = (v: unknown): string | null => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);
/** Ключ в написании уровня: Pascal (ANY_OFFER_CHANGED) или camel (PRICING_HEALTH) */
const pick = (o: Obj, pascal: string) => (pascal in o ? o[pascal] : o[pascal[0]!.toLowerCase() + pascal.slice(1)]);

export function parseEnvelope(body: string): { ok: true; envelope: NotificationEnvelope; raw: Obj } | { ok: false; problem: EnvelopeProblem } {
  let raw: Obj | null;
  try {
    raw = obj(JSON.parse(body));
  } catch {
    return { ok: false, problem: 'NOT_JSON' };
  }
  if (!raw) return { ok: false, problem: 'NOT_JSON' };
  const type = str(pick(raw, 'NotificationType'));
  if (!type) return { ok: false, problem: 'NO_TYPE' };
  const meta = obj(pick(raw, 'NotificationMetadata'));
  if (!meta) return { ok: false, problem: 'NO_METADATA' };
  const notificationId = str(pick(meta, 'NotificationId'));
  if (!notificationId || !/^[A-Za-z0-9._:-]{1,128}$/.test(notificationId)) return { ok: false, problem: 'NO_NOTIFICATION_ID' };
  const applicationId = str(pick(meta, 'ApplicationId'));
  if (!applicationId) return { ok: false, problem: 'NO_APPLICATION_ID' };
  const payload = obj(pick(raw, 'Payload'));
  // ANY_OFFER_CHANGED: Payload.AnyOfferChangedNotification.{SellerId, OfferChangeTrigger.MarketplaceId}; PRICING_HEALTH: payload.{sellerId, offerChangeTrigger.marketplaceId}
  const inner = obj(payload?.AnyOfferChangedNotification) ?? payload;
  const trigger = inner ? obj(pick(inner, 'OfferChangeTrigger')) : null;
  return {
    ok: true, raw,
    envelope: {
      notificationType: type, notificationId, applicationId,
      subscriptionId: str(pick(meta, 'SubscriptionId')), publishTime: instant(pick(meta, 'PublishTime')), eventTime: instant(pick(raw, 'EventTime')),
      sellerId: inner ? str(pick(inner, 'SellerId')) : null, marketplaceId: trigger ? str(pick(trigger, 'MarketplaceId')) : null,
    },
  };
}
