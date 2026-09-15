import type { ChannelError, InboundDelivery, InboundEvent, InboundResult, Instant } from '@repracer/channel-port';
import { verifyKauflandSignature } from '@repracer/kaufland-client';
import { buyBoxChangedSnapshot, type BuyBoxChangedPayload } from './competitors.ts';
import { logConservative } from './conservative.ts';
import { channelError } from './errors.ts';
import { hasActiveMinimumPrice, unitIdentity, unitObservations, type KauflandUnit } from './mapping.ts';
import { nowMs, openSession, type KauflandAdapterOptions } from './session.ts';

/** Повторы уведомлений идут ~12 ч; окно 13 ч [KFL_C12] */
const DEFAULT_MAX_AGE_MS = 13 * 3_600_000;
const MAX_FUTURE_SKEW_MS = 5 * 60_000;
const CHALLENGE_RE = /^[A-Za-z0-9]{8,512}$/;
const ID_MESSAGE_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** Событие с объектом unit в payload (документация push-notifications) */
const UNIT_OBSERVATION_EVENTS = new Set([
  'item_unit_new', 'item_unit_changed', 'item_unit_out_of_stock', 'item_unit_not_available',
  'item_unit_available', 'item_unit_live', 'item_unit_not_live',
]);
/** События без данных: ядро читает ресурс [KFL_C13 для заказов] */
const RESOURCE_EVENTS = new Set([
  'order_new', 'order_unit_new', 'order_unit_status_changed', 'item_changed', 'category_changed',
  'return_new', 'return_status_changed', 'return_unit_status_changed',
]);
const ORDER_EVENTS = new Set(['order_new', 'order_unit_new', 'order_unit_status_changed']);

interface NotificationBody {
  event_name?: unknown;
  id_message?: unknown;
  resource?: unknown;
  storefront?: unknown;
  payload?: unknown;
}

/**
 * Уведомление без данных: идентичность — из resource. /units/{id} — unit для обратного чтения;
 * /buybox?id_product=…&condition=… — запрос опроса конкурентов [Р-46].
 */
function resourceEvent(resource: string, fallback: string, storefront: string, occurredAt: Instant): InboundEvent {
  const path = resource || fallback;
  const unit = /^\/units\/([1-9][0-9]{0,18})\/?$/.exec(path);
  if (unit) return { kind: 'RESOURCE_CHANGED', resource: path, identity: { marketplace: storefront, externalUnitId: unit[1]! }, occurredAt };
  if (path.startsWith('/buybox')) {
    const query = new URL(path, 'https://resource.invalid').searchParams;
    const idProduct = query.get('id_product') ?? '';
    const condition = query.get('condition') ?? 'new';
    if (/^[1-9][0-9]{0,18}$/.test(idProduct) && /^[a-z -]{1,40}$/.test(condition)) {
      return {
        kind: 'RESOURCE_CHANGED', resource: path, identity: { marketplace: storefront, channelProductRef: idProduct },
        competitorQuery: { marketplace: storefront, channelProductRef: idProduct, condition }, occurredAt,
      };
    }
  }
  return { kind: 'RESOURCE_CHANGED', resource: path, occurredAt };
}

function rejected(error: ChannelError, responseStatus: number): InboundResult {
  return { kind: 'REJECTED', error, responseStatus };
}

function lowerCaseHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) out[k.toLowerCase()] = v;
  return out;
}

/**
 * Приём уведомления Kaufland. Порядок проверок важен:
 * 1) аккаунт и тенант из адреса вебхука [Р-31, Р-40] — токен в пути лишь маршрутизирует, не аутентифицирует;
 * 2) подпись секретом продавца [KFL_C07]; 3) окно Shop-Timestamp [KFL_C12]; 4) разбор тела.
 * Адаптер без состояния: повторная доставка даёт тот же deliveryId (id_message) и те же sourceEventId,
 * дедупликацию делает ядро.
 */
export async function handleInboundKaufland(options: KauflandAdapterOptions, delivery: InboundDelivery): Promise<InboundResult> {
  const ctx = {
    tenantId: delivery.claimed.tenantId,
    channelAccountId: delivery.claimed.channelAccountId,
    correlationId: `kfl-inbound:${delivery.receivedAt}`,
  };
  const { logger, alerts } = options.deps;
  const method = delivery.method.toUpperCase();

  let url: URL;
  try {
    url = new URL(delivery.url);
  } catch {
    return rejected(channelError('VALIDATION', 'BATCH', 'inbound URL is not absolute'), 400);
  }

  if (method === 'GET') {
    // Проверка адреса при подписке: запрос не подписан, отвечаем только для существующего аккаунта тенанта
    const challenge = url.searchParams.get('challenge') ?? '';
    if (url.searchParams.get('mode') !== 'subscribe' || !CHALLENGE_RE.test(challenge)) {
      return rejected(channelError('VALIDATION', 'BATCH', 'GET without a valid subscribe challenge'), 400);
    }
    const opened = await openSession(options, ctx);
    if (!opened.ok) return rejected(opened.error, 404);
    return { kind: 'VERIFICATION', responseStatus: 200, responseBody: challenge };
  }
  if (method !== 'POST') {
    return rejected(channelError('VALIDATION', 'BATCH', `method ${method} is not accepted`), 405);
  }

  const opened = await openSession(options, ctx);
  if (!opened.ok) return rejected(opened.error, 404);
  const { session } = opened;

  const headers = lowerCaseHeaders(delivery.headers);
  const signature = headers['shop-signature'] ?? '';
  const timestampRaw = headers['shop-timestamp'] ?? '';
  if (!/^[0-9a-fA-F]{64}$/.test(signature.trim()) || !/^[0-9]{9,11}$/.test(timestampRaw.trim())) {
    return rejected(channelError('SIGNATURE_INVALID', 'BATCH', 'Shop-Signature or Shop-Timestamp header is missing or malformed', { raiseAlert: false }), 401);
  }
  const timestamp = Number(timestampRaw.trim());

  const valid = verifyKauflandSignature({
    method: 'POST',
    uri: delivery.url,
    body: delivery.rawBody,
    timestamp,
    secretKey: session.sellerSecretKey,
  }, signature);
  if (!valid) {
    logConservative(logger, ctx, 'KFL_C07_WEBHOOK_SIGNATURE_VARIANT', { bodyBytes: Buffer.byteLength(delivery.rawBody, 'utf8') });
    await alerts.raise({
      code: 'KAUFLAND_WEBHOOK_SIGNATURE_INVALID',
      severity: 'WARNING',
      tenantId: ctx.tenantId,
      channelAccountId: ctx.channelAccountId,
      correlationId: ctx.correlationId,
      details: { timestamp },
    });
    return rejected(channelError('SIGNATURE_INVALID', 'BATCH', 'Shop-Signature does not match'), 401);
  }

  const ageMs = nowMs(options) - timestamp * 1000;
  if (ageMs > (options.webhookMaxAgeMs ?? DEFAULT_MAX_AGE_MS) || ageMs < -MAX_FUTURE_SKEW_MS) {
    logConservative(logger, ctx, 'KFL_C12_WEBHOOK_TIMESTAMP_WINDOW', { ageSeconds: Math.round(ageMs / 1000) });
    return rejected(channelError('SIGNATURE_INVALID', 'BATCH', 'Shop-Timestamp is outside the accepted window', { raiseAlert: false }), 401);
  }
  const occurredAt: Instant = new Date(timestamp * 1000).toISOString();

  let body: NotificationBody;
  try {
    const parsed: unknown = JSON.parse(delivery.rawBody);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    body = parsed as NotificationBody;
  } catch {
    return rejected(channelError('VALIDATION', 'BATCH', 'signed notification body is not a JSON object', { raiseAlert: true }), 400);
  }

  const eventName = typeof body.event_name === 'string' ? body.event_name : '';
  const idMessage = typeof body.id_message === 'string' ? body.id_message : '';
  const storefront = typeof body.storefront === 'string' ? body.storefront.toLowerCase() : '';
  if (!eventName || !ID_MESSAGE_RE.test(idMessage) || !storefront) {
    return rejected(channelError('VALIDATION', 'BATCH', 'notification lacks event_name, id_message or storefront', { raiseAlert: true }), 400);
  }
  const deliveryId = `kaufland:${idMessage}`;

  if (!session.account.marketplaces.includes(storefront)) {
    // Подтверждаем, чтобы канал не повторял 12 ч, но данные витрины, не подключённой к аккаунту, не принимаем
    logger.log({
      level: 'WARN', code: 'KFL_INBOUND_STOREFRONT_NOT_ENABLED', message: 'notification for a storefront not enabled on the account is ignored',
      correlationId: ctx.correlationId, tenantId: ctx.tenantId, channelAccountId: ctx.channelAccountId, details: { storefront, eventName },
    });
    return { kind: 'EVENTS', deliveryId, events: [], acknowledgeStatus: 200 };
  }

  const resource = typeof body.resource === 'string' && body.resource.startsWith('/') && body.resource.length <= 255 ? body.resource : '';
  const events: InboundEvent[] = [];
  const payload = body.payload && typeof body.payload === 'object' && !Array.isArray(body.payload) ? body.payload : null;

  if (UNIT_OBSERVATION_EVENTS.has(eventName) || eventName === 'item_unit_deleted') {
    const unit = payload as KauflandUnit | null;
    if (!unit || !Number.isSafeInteger(unit.id_unit)) {
      logConservative(logger, ctx, 'KFL_C19_NOTIFICATION_WITHOUT_PAYLOAD', { eventName });
      events.push(resourceEvent(resource, '/units', storefront, occurredAt));
    } else if (eventName === 'item_unit_deleted') {
      events.push({ kind: 'OFFER_REMOVED', identity: unitIdentity(unit, storefront), occurredAt });
    } else {
      if (hasActiveMinimumPrice(unit)) {
        logConservative(logger, ctx, 'KFL_C05_MINIMUM_PRICE_OBSERVED', { idUnit: unit.id_unit ?? null });
        await alerts.raise({
          code: 'KAUFLAND_SMART_PRICING_ACTIVE', severity: 'CRITICAL', tenantId: ctx.tenantId, channelAccountId: ctx.channelAccountId,
          correlationId: ctx.correlationId, details: { idUnit: unit.id_unit ?? 0, storefront },
        });
      }
      for (const observation of unitObservations(unit, 'PUSH_EVENT', occurredAt, { storefront, sourceEventId: deliveryId })) {
        events.push({ kind: 'OBSERVATION', observation });
      }
    }
  } else if (eventName === 'buy_box_changed') {
    const snapshot = payload ? buyBoxChangedSnapshot(storefront, deliveryId, payload as BuyBoxChangedPayload, occurredAt) : null;
    if (snapshot) {
      logConservative(logger, ctx, 'KFL_C18_BUYBOX_IS_SELF_BY_ID_UNIT', { offers: snapshot.offers.length });
      events.push({ kind: 'COMPETITOR_SNAPSHOT', snapshot });
    } else {
      logConservative(logger, ctx, 'KFL_C19_NOTIFICATION_WITHOUT_PAYLOAD', { eventName });
      events.push(resourceEvent(resource, '/buybox', storefront, occurredAt));
    }
  } else if (RESOURCE_EVENTS.has(eventName)) {
    if (ORDER_EVENTS.has(eventName)) logConservative(logger, ctx, 'KFL_C13_ORDER_DECREMENT_UNKNOWN', { eventName });
    events.push({ kind: 'RESOURCE_CHANGED', resource: resource || `/${eventName}`, occurredAt });
  } else {
    logConservative(logger, ctx, 'KFL_C15_UNKNOWN_EVENT', { eventName: eventName.slice(0, 64) });
    events.push({ kind: 'RESOURCE_CHANGED', resource: resource || '/', occurredAt });
  }

  return { kind: 'EVENTS', deliveryId, events, acknowledgeStatus: 200 };
}
