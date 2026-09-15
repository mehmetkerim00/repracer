import type { AdapterCallContext, DiscoveredOffer, Instant, OrderLine, Page, PageRequest } from '@repracer/channel-port';
import { logConservative } from './conservative.ts';
import { KAUFLAND_LIMITS, KAUFLAND_STOREFRONTS } from './descriptor.ts';
import { ChannelCallError, channelError, classifyTransportFailure } from './errors.ts';
import { hasActiveMinimumPrice, unitIdentity, type KauflandUnit } from './mapping.ts';
import { acquireBudget, deadlinePassed, nowMs, openSession, type KauflandAdapterOptions, type Session } from './session.ts';

interface Cursor { s: number; o: number }

function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

function decodeCursor(raw: string | undefined): Cursor {
  if (!raw) return { s: 0, o: 0 };
  try {
    const c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Cursor;
    if (Number.isSafeInteger(c.s) && c.s >= 0 && Number.isSafeInteger(c.o) && c.o >= 0) return c;
  } catch { /* неверный курсор — ниже */ }
  throw new ChannelCallError(channelError('VALIDATION', 'BATCH', 'invalid page cursor'));
}

async function sessionOrThrow(options: KauflandAdapterOptions, ctx: AdapterCallContext): Promise<Session> {
  const opened = await openSession(options, ctx);
  if (!opened.ok) throw new ChannelCallError(opened.error);
  const late = deadlinePassed(options, ctx);
  if (late) throw new ChannelCallError(late);
  return opened.session;
}

function budgetOrThrow(options: KauflandAdapterOptions, ctx: AdapterCallContext, session: Session): void {
  const error = acquireBudget(options, ctx, session, 1);
  if (error) throw new ChannelCallError(error);
}

// ---------------------------------------------------------------------------
// Офферы: GET /units по витринам аккаунта, курсор = (витрина, offset)
// ---------------------------------------------------------------------------

export async function discoverOffersKaufland(
  options: KauflandAdapterOptions, ctx: AdapterCallContext, page: PageRequest,
): Promise<Page<DiscoveredOffer>> {
  const session = await sessionOrThrow(options, ctx);
  const storefronts = KAUFLAND_STOREFRONTS.filter((s) => session.account.marketplaces.includes(s));
  const cursor = decodeCursor(page.cursor);
  const storefront = storefronts[cursor.s];
  if (!storefront) return { items: [] };
  const limit = Math.max(1, Math.min(page.limit, KAUFLAND_LIMITS.unitsPageMax));

  budgetOrThrow(options, ctx, session);
  const result = await session.client.request('get', '/units', {
    query: { storefront, limit, offset: cursor.o, embedded: ['products'] } as never,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });
  if (!result.ok) throw new ChannelCallError(classifyTransportFailure(result, 'BATCH', nowMs(options)));
  const units = (result.data as { data?: KauflandUnit[] } | undefined)?.data ?? [];

  const items: DiscoveredOffer[] = [];
  for (const unit of units) {
    if (!Number.isSafeInteger(unit.id_unit)) continue;
    if (hasActiveMinimumPrice(unit)) {
      logConservative(options.deps.logger, ctx, 'KFL_C05_MINIMUM_PRICE_OBSERVED', { idUnit: unit.id_unit ?? null });
      await options.deps.alerts.raise({
        code: 'KAUFLAND_SMART_PRICING_ACTIVE', severity: 'CRITICAL', tenantId: ctx.tenantId, channelAccountId: ctx.channelAccountId,
        correlationId: ctx.correlationId, details: { idUnit: unit.id_unit ?? 0, storefront },
      });
    }
    items.push({
      identity: unitIdentity(unit, storefront),
      gtins: unit.product?.eans ?? [],
      condition: unit.condition ?? 'unknown',
      fulfillment: unit.fulfillment_type === 'fulfilled_by_kaufland' ? 'CHANNEL' : 'MERCHANT',
      ...(Number.isSafeInteger(unit.listing_price) && (unit.listing_price as number) > 0
        ? { currentPrice: { amountMinor: unit.listing_price as number, currency: unit.currency ?? 'EUR', basis: 'GROSS' as const } }
        : {}),
      ...(Number.isSafeInteger(unit.amount) ? { currentQuantity: unit.amount as number } : {}),
      ...(typeof unit.is_live === 'boolean' ? { isLive: unit.is_live } : {}),
    });
  }

  const next: Cursor | null = units.length === limit ? { s: cursor.s, o: cursor.o + limit }
    : cursor.s + 1 < storefronts.length ? { s: cursor.s + 1, o: 0 } : null;
  return { items, ...(next ? { nextCursor: encodeCursor(next) } : {}) };
}

// ---------------------------------------------------------------------------
// Строки заказов: GET /order-units, только белый список полей (Р-4, без PII покупателя)
// ---------------------------------------------------------------------------

interface OrderUnitWhitelisted {
  id_order_unit?: number;
  id_order?: string;
  id_offer?: string;
  storefront?: string;
  status?: string;
  ts_created_iso?: string;
}

const ORDER_STATUS: Readonly<Record<string, OrderLine['status']>> = {
  open: 'OPEN',
  need_to_be_sent: 'OPEN',
  sent: 'SHIPPED',
  received: 'SHIPPED',
  returned: 'RETURNED',
  returned_paid: 'RETURNED',
  cancelled: 'CANCELLED',
};

/** Выбирает поля по белому списку; адрес, имя, e-mail, телефон покупателя не копируются даже во временный объект */
function whitelist(raw: unknown): OrderUnitWhitelisted {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    ...(typeof r.id_order_unit === 'number' ? { id_order_unit: r.id_order_unit } : {}),
    ...(typeof r.id_order === 'string' ? { id_order: r.id_order } : {}),
    ...(typeof r.id_offer === 'string' ? { id_offer: r.id_offer } : {}),
    ...(typeof r.storefront === 'string' ? { storefront: r.storefront } : {}),
    ...(typeof r.status === 'string' ? { status: r.status } : {}),
    ...(typeof r.ts_created_iso === 'string' ? { ts_created_iso: r.ts_created_iso } : {}),
  };
}

export async function readOrderLinesKaufland(
  options: KauflandAdapterOptions, ctx: AdapterCallContext, window: { since: Instant } & PageRequest,
): Promise<Page<OrderLine>> {
  const session = await sessionOrThrow(options, ctx);
  const cursor = decodeCursor(window.cursor);
  const limit = Math.max(1, Math.min(window.limit, KAUFLAND_LIMITS.unitsPageMax));
  const since = Date.parse(window.since);
  if (Number.isNaN(since)) throw new ChannelCallError(channelError('VALIDATION', 'BATCH', 'window.since is not an ISO instant'));

  budgetOrThrow(options, ctx, session);
  const result = await session.client.request('get', '/order-units', {
    // Пагинация offset по ts_updated:desc: строка, обновлённая во время обхода, может выпасть из этого прохода,
    // но попадёт в следующий (её ts_updated ≥ since); повторы строк безвредны — ядро идемпотентно по externalOrderLineRef
    query: { ts_updated_from_iso: new Date(since).toISOString(), sort: 'ts_updated:desc', limit, offset: cursor.o } as never,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });
  if (!result.ok) throw new ChannelCallError(classifyTransportFailure(result, 'BATCH', nowMs(options)));
  const rows = ((result.data as { data?: unknown[] } | undefined)?.data ?? []).map(whitelist);

  const items: OrderLine[] = [];
  for (const row of rows) {
    if (row.id_order_unit === undefined || !row.id_order || !row.storefront || !session.account.marketplaces.includes(row.storefront)) continue;
    let status = row.status ? ORDER_STATUS[row.status] : undefined;
    if (!status) {
      // Неизвестный статус держит резервацию: OPEN безопаснее, чем освободить остаток
      options.deps.logger.log({
        level: 'WARN', code: 'KFL_ORDER_STATUS_UNKNOWN', message: 'unknown order unit status treated as OPEN',
        correlationId: ctx.correlationId, tenantId: ctx.tenantId, channelAccountId: ctx.channelAccountId,
        details: { status: (row.status ?? '').slice(0, 64) },
      });
      status = 'OPEN';
    }
    const created = row.ts_created_iso ? Date.parse(row.ts_created_iso) : Number.NaN;
    items.push({
      externalOrderRef: row.id_order,
      externalOrderLineRef: String(row.id_order_unit),
      identity: { marketplace: row.storefront, ...(row.id_offer ? { externalOfferId: row.id_offer } : {}) },
      // Одна строка order-unit — один экземпляр товара (документация: 5 товаров — 5 order_unit_new)
      quantity: 1,
      orderedAt: Number.isNaN(created) ? new Date(since).toISOString() : new Date(created).toISOString(),
      status,
    });
  }
  const nextCursor = rows.length === limit ? encodeCursor({ s: 0, o: cursor.o + limit }) : undefined;
  return { items, ...(nextCursor ? { nextCursor } : {}) };
}
