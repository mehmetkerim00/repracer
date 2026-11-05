/**
 * Конверт уведомления SP-API. Страница set-up-notifications-with-amazon-sqs (раздел «Notification structure») описывает ключи с заглавной
 * буквы — NotificationType, NotificationMetadata.NotificationId, так приходит ANY_OFFER_CHANGED (схема AnyOfferChangedNotification.json).
 * У PRICING_HEALTH ключи со строчной — notificationType, notificationMetadata.notificationId (схема PricingHealthNotification.json и пример
 * на странице notification-type-values). Разбор принимает оба написания, каждое — только целиком для своего уровня.
 *
 * Шаг 114: одна очередь — два конверта. Уведомления листингов (LISTINGS_ITEM_STATUS_CHANGE, LISTINGS_ITEM_ISSUES_CHANGE) SP-API отдаёт
 * только через EventBridge (страница set-up-notifications-with-amazon-eventbridge), и правило с целью-очередью кладёт в ту же очередь
 * событие EventBridge (AWS Events Reference, «Event structure»: version, id, detail-type, source, account, time, region, resources, detail).
 * Что SP-API кладёт в `detail`, снимок не говорит (A-33): разбор считает `detail` уведомлением SP-API и принимает его, только если
 * `detail-type` равен его NotificationType, а `source` — источник партнёра SP-API (префикс правила со страницы). Иначе — отказ с
 * алертом и списком ключей `detail` для разбора на живой очереди, без догадок.
 */
export type EnvelopeWrapper = 'SQS' | 'EVENTBRIDGE';

export interface NotificationEnvelope {
  notificationType: string;
  notificationId: string;
  applicationId: string;
  subscriptionId: string | null;
  publishTime: string | null;
  eventTime: string | null;
  sellerId: string | null;
  marketplaceId: string | null;
  /** Шаг 114: как сообщение пришло в очередь — уведомлением SP-API или событием EventBridge */
  wrapper: EnvelopeWrapper;
}

export type EnvelopeProblem = 'NOT_JSON' | 'NO_TYPE' | 'NO_METADATA' | 'NO_NOTIFICATION_ID' | 'NO_APPLICATION_ID'
  | 'EVENTBRIDGE_NO_DETAIL' | 'EVENTBRIDGE_FOREIGN_SOURCE' | 'EVENTBRIDGE_TYPE_MISMATCH';

/** Источник событий партнёра SP-API — префикс шаблона правила на странице set-up-notifications-with-amazon-eventbridge (шаг 3) */
export const SP_API_EVENT_SOURCE_PREFIX = 'aws.partner/sellingpartnerapi.amazon.com';

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 && v.length <= 256 ? v : null);
const instant = (v: unknown): string | null => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);
/** Ключ в написании уровня: Pascal (ANY_OFFER_CHANGED) или camel (PRICING_HEALTH) */
const pick = (o: Obj, pascal: string) => (pascal in o ? o[pascal] : o[pascal[0]!.toLowerCase() + pascal.slice(1)]);
/** Ключи объекта для алерта — только имена, не значения, и не больше дюжины */
const keysOf = (o: Obj | null) => (o ? Object.keys(o).slice(0, 12).map((k) => k.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40)).sort().join(',') : '');

/** Событие EventBridge: обязательные поля конверта события; `detail` — то, что положил источник */
function isEventBridge(raw: Obj): boolean {
  return typeof raw['detail-type'] === 'string' && typeof raw.source === 'string' && 'detail' in raw;
}

export type ParsedEnvelope =
  | { ok: true; envelope: NotificationEnvelope; raw: Obj; notification: Obj }
  | { ok: false; problem: EnvelopeProblem; detailKeys?: string };

export function parseEnvelope(body: string): ParsedEnvelope {
  let raw: Obj | null;
  try {
    raw = obj(JSON.parse(body));
  } catch {
    return { ok: false, problem: 'NOT_JSON' };
  }
  if (!raw) return { ok: false, problem: 'NOT_JSON' };
  let notification = raw;
  let wrapper: EnvelopeWrapper = 'SQS';
  if (isEventBridge(raw)) {
    const source = raw.source as string;
    if (source !== SP_API_EVENT_SOURCE_PREFIX && !source.startsWith(`${SP_API_EVENT_SOURCE_PREFIX}/`)) return { ok: false, problem: 'EVENTBRIDGE_FOREIGN_SOURCE' };
    const detail = obj(raw.detail);
    if (!detail) return { ok: false, problem: 'EVENTBRIDGE_NO_DETAIL' };
    const detailType = str(pick(detail, 'NotificationType'));
    if (!detailType) return { ok: false, problem: 'NO_TYPE', detailKeys: keysOf(detail) };
    if (detailType !== raw['detail-type']) return { ok: false, problem: 'EVENTBRIDGE_TYPE_MISMATCH', detailKeys: keysOf(detail) };
    notification = detail;
    wrapper = 'EVENTBRIDGE';
  }
  const type = str(pick(notification, 'NotificationType'));
  if (!type) return { ok: false, problem: 'NO_TYPE' };
  const meta = obj(pick(notification, 'NotificationMetadata'));
  if (!meta) return { ok: false, problem: 'NO_METADATA', ...(wrapper === 'EVENTBRIDGE' ? { detailKeys: keysOf(notification) } : {}) };
  const notificationId = str(pick(meta, 'NotificationId'));
  if (!notificationId || !/^[A-Za-z0-9._:-]{1,128}$/.test(notificationId)) return { ok: false, problem: 'NO_NOTIFICATION_ID' };
  const applicationId = str(pick(meta, 'ApplicationId'));
  if (!applicationId) return { ok: false, problem: 'NO_APPLICATION_ID' };
  const payload = obj(pick(notification, 'Payload'));
  // ANY_OFFER_CHANGED: Payload.AnyOfferChangedNotification.{SellerId, OfferChangeTrigger.MarketplaceId}; PRICING_HEALTH: payload.{sellerId, offerChangeTrigger.marketplaceId};
  // уведомления листингов (шаг 114): Payload.{SellerId, MarketplaceId} — у LISTINGS_ITEM_STATUS_CHANGE таблица страницы пишет «SellerID», схема и пример — «SellerId»
  const inner = obj(payload?.AnyOfferChangedNotification) ?? payload;
  const trigger = inner ? obj(pick(inner, 'OfferChangeTrigger')) : null;
  const seller = inner ? str(pick(inner, 'SellerId')) ?? str(inner.SellerID) : null;
  const marketplace = trigger ? str(pick(trigger, 'MarketplaceId')) : inner ? str(pick(inner, 'MarketplaceId')) : null;
  return {
    ok: true, raw, notification,
    envelope: {
      notificationType: type, notificationId, applicationId,
      subscriptionId: str(pick(meta, 'SubscriptionId')), publishTime: instant(pick(meta, 'PublishTime')), eventTime: instant(pick(notification, 'EventTime')),
      sellerId: seller, marketplaceId: marketplace, wrapper,
    },
  };
}
