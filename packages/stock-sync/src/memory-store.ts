import { randomUUID, createHash } from 'node:crypto';
import type { Instant, OrderLine } from '@repracer/channel-port';
import { availableOf, publishedQuantity, type StockAllocation } from './published.ts';
import type {
  ConfirmOrdersOutcome, CreateStockSourceResult, EnableStockSyncInput, EnableStockSyncResult, InboundStockOutcome, InboundStockRow, OrderLinesOutcome, RecalculationOutcome,
  StockActor, StockChannelRow, StockDivergenceRow, StockImportOutcome, StockImportRow, StockPage, StockRow, StockSourceMode, StockSourceRow, StockStore,
} from './store.ts';

/** Запись «в полёте»: ещё не завершена. Тот же список, что у `PgStockStore`: PENDING, DISPATCHED, ACCEPTED */
const IN_FLIGHT = ['PENDING', 'DISPATCHED', 'ACCEPTED'];

/** Предложение продавца, остаток которого ведём мы: то, что в базе — активная строка offer_mapping с MERCHANT */
export interface MemoryStockOffer {
  productId: string;
  sku: string;
  gtin?: string | null;
  channelAccountId: string;
  channel: string;
  marketplaces: string[];
  externalOfferId: string;
  /** Побочный эффект записи остатка у канала — по возможности канала (Amazon EU: регион) */
  requiresSideEffectsAck?: boolean;
  sideEffectsText?: string | null;
}

interface Pool { stockSourceId: string; mode: StockSourceMode; productId: string; onHand: number; asOf: Instant | null }
interface Scope { writeScopeId: string; offer: MemoryStockOffer; enabled: boolean; acknowledged: boolean; lastSent: number | null; version: number }
interface Write { writeScopeId: string; quantity: number; version: number; status: string; at: Instant; errorCode: string | null }
interface Reservation {
  key: string; productId: string; quantity: number; status: 'OPEN' | 'CONSUMED' | 'RELEASED';
  /** Р-25: у внутреннего пула источник — мы сами, резервация подтверждена сразу; у Inbound API её подтверждает источник [Р-157] */
  orderRef: string; stockSourceId: string | null; confirmed: boolean; shippedReported?: boolean;
}

/**
 * Хранилище остатков в памяти — те же правила, что у базы, для стенда без PostgreSQL и юнит-тестов. Записи здесь никто
 * не отправляет (диспетчера в памяти нет): они остаются ждущими, и экран так и говорит.
 */
export class InMemoryStockStore implements StockStore {
  private readonly sources = new Map<string, { row: StockSourceRow; keyPrefix?: string; keySha256?: string }>();
  private readonly pools: Pool[] = [];
  private readonly allocations = new Map<string, StockAllocation>();
  private readonly scopes = new Map<string, Scope>();
  private readonly writes: Write[] = [];
  private readonly reservations = new Map<string, Reservation>();
  private readonly canManage: (actor: StockActor) => boolean;

  private readonly offers: readonly MemoryStockOffer[];
  /** Тенант мира: ключ Inbound API принадлежит ему, и Р-31 требует сверки */
  private readonly tenantId: string;
  constructor(offers: readonly MemoryStockOffer[], options: { canManage?: (actor: StockActor) => boolean; tenantId?: string } = {}) {
    this.offers = offers;
    this.tenantId = options.tenantId ?? 'memory';
    this.canManage = options.canManage ?? (() => true);
  }

  async stockSources(): Promise<StockSourceRow[]> {
    return [...this.sources.values()].map(({ row }) => ({ ...row, products: this.pools.filter((p) => p.stockSourceId === row.stockSourceId && (p.onHand > 0 || p.asOf !== null)).length }));
  }

  async createStockSource(_tenantId: string, input: { mode: StockSourceMode; name: string }, actor: StockActor): Promise<CreateStockSourceResult> {
    if (!this.canManage(actor)) return { status: 'FORBIDDEN' };
    const stockSourceId = randomUUID();
    const apiKey = input.mode === 'INBOUND_API' ? `rpk_${randomUUID().replace(/-/g, '')}` : null;
    this.sources.set(stockSourceId, {
      row: { stockSourceId, mode: input.mode, name: input.name, status: 'ACTIVE', createdAt: new Date().toISOString(), products: 0, hasKey: apiKey !== null },
      ...(apiKey ? { keyPrefix: apiKey.slice(0, 12), keySha256: createHash('sha256').update(apiKey).digest('hex') } : {}),
    });
    return { status: 'CREATED', stockSourceId, apiKey };
  }

  async importStock(_tenantId: string, stockSourceId: string, rows: readonly StockImportRow[], actor: StockActor): Promise<StockImportOutcome | { status: 'FORBIDDEN' | 'NOT_INTERNAL_POOL' }> {
    if (!this.canManage(actor)) return { status: 'FORBIDDEN' };
    const source = this.sources.get(stockSourceId);
    if (!source || source.row.mode !== 'INTERNAL_POOL') return { status: 'NOT_INTERNAL_POOL' };
    const out: StockImportOutcome = { status: 'APPLIED', matched: 0, changed: 0, unmatched: [], productIds: [] };
    const seen = new Set<string>();
    for (const r of rows) {
      if (seen.has(r.sku)) { out.unmatched.push({ sku: r.sku, reason: 'DUPLICATE_SKU' }); continue; }
      seen.add(r.sku);
      if (!Number.isSafeInteger(r.quantity) || r.quantity < 0) { out.unmatched.push({ sku: r.sku, reason: 'BAD_QUANTITY' }); continue; }
      const offer = this.offers.find((o) => o.sku === r.sku);
      if (!offer) { out.unmatched.push({ sku: r.sku, reason: 'UNKNOWN_SKU' }); continue; }
      out.matched += 1;
      let pool = this.pools.find((p) => p.stockSourceId === stockSourceId && p.productId === offer.productId);
      if (!pool) { pool = { stockSourceId, mode: 'INTERNAL_POOL', productId: offer.productId, onHand: 0, asOf: null }; this.pools.push(pool); }
      if (pool.onHand !== r.quantity) { pool.onHand = r.quantity; out.changed += 1; out.productIds.push(offer.productId); }
    }
    return out;
  }

  async inboundStock(_tenantId: string, stockSourceId: string, rows: readonly InboundStockRow[]): Promise<InboundStockOutcome> {
    const out: InboundStockOutcome = { applied: 0, stale: 0, unknownSkus: [], productIds: [] };
    for (const r of rows) {
      const offer = this.offers.find((o) => o.sku === r.sku);
      if (!offer) { out.unknownSkus.push(r.sku); continue; }
      let pool = this.pools.find((p) => p.stockSourceId === stockSourceId && p.productId === offer.productId);
      if (!pool) { pool = { stockSourceId, mode: 'INBOUND_API', productId: offer.productId, onHand: 0, asOf: null }; this.pools.push(pool); }
      if (pool.asOf !== null && Date.parse(r.asOf) <= Date.parse(pool.asOf)) { out.stale += 1; continue; }
      pool.onHand = r.quantity; pool.asOf = r.asOf; out.applied += 1; out.productIds.push(offer.productId);
    }
    return out;
  }

  async resolveInboundKey(keyPrefix: string, keySha256Hex: string): Promise<{ tenantId: string; stockSourceId: string } | null> {
    for (const [stockSourceId, s] of this.sources) if (s.keyPrefix === keyPrefix && s.keySha256 === keySha256Hex && s.row.status === 'ACTIVE') return { tenantId: this.tenantId, stockSourceId };
    return null;
  }

  /** Р-157: источник сообщает «заказ учтён» — резервации этого заказа подтверждены; то же правило, что в базе */
  async confirmInboundOrders(_tenantId: string, stockSourceId: string, orderRefs: readonly string[]): Promise<ConfirmOrdersOutcome> {
    const out: ConfirmOrdersOutcome = { confirmed: 0, alreadyConfirmed: [], releasedOrders: [], unknownOrders: [] };
    for (const ref of [...new Set(orderRefs)]) {
      const mine = [...this.reservations.values()].filter((r) => r.orderRef === ref && r.stockSourceId === stockSourceId);
      if (mine.length === 0) { out.unknownOrders.push(ref); continue; }
      const open = mine.filter((r) => r.status === 'OPEN' && !r.confirmed);
      if (open.length === 0) {
        // Те же три случая, что в базе: подтверждён, снят или неизвестен [находка 8 ревью шага 36]
        if (mine.some((r) => r.confirmed || r.status === 'CONSUMED')) out.alreadyConfirmed.push(ref);
        else out.releasedOrders.push(ref);
        continue;
      }
      for (const r of open) {
        r.confirmed = true;
        out.confirmed += 1;
        // Отгрузка была до подтверждения — закрывается тем же вызовом
        if (r.shippedReported) { r.status = 'CONSUMED'; const pool = this.pools.find((p) => p.productId === r.productId && p.mode === 'INTERNAL_POOL'); if (pool) pool.onHand = Math.max(0, pool.onHand - r.quantity); }
      }
    }
    return out;
  }

  async enableStockSync(_tenantId: string, channelAccountId: string, input: EnableStockSyncInput, actor: StockActor): Promise<EnableStockSyncResult> {
    if (!this.canManage(actor)) return { status: 'FORBIDDEN' };
    const offers = this.offers.filter((o) => o.channelAccountId === channelAccountId);
    if (offers.length === 0) return { status: 'NO_OFFERS' };
    this.allocations.set(channelAccountId, { bufferUnits: input.bufferUnits, maxQuantity: input.maxQuantity, minQuantityToList: input.minQuantityToList });
    let created = 0; let awaitingAck = 0;
    for (const offer of offers) {
      let scope = [...this.scopes.values()].find((s) => s.offer.externalOfferId === offer.externalOfferId && s.offer.channelAccountId === channelAccountId);
      if (!scope) { scope = { writeScopeId: randomUUID(), offer, enabled: false, acknowledged: false, lastSent: null, version: 0 }; this.scopes.set(scope.writeScopeId, scope); created += 1; }
      const needsAck = offer.requiresSideEffectsAck === true;
      if (needsAck && !input.acknowledgeSideEffects) { awaitingAck += 1; continue; }
      scope.acknowledged = needsAck;
      scope.enabled = true;
    }
    return { status: 'ENABLED', scopes: offers.length, created, awaitingAck };
  }

  private availableOfProduct(productId: string): { onHand: number; reserved: number; available: number } {
    const onHand = this.pools.filter((p) => p.productId === productId).reduce((a, p) => a + p.onHand, 0);
    const reserved = [...this.reservations.values()].filter((r) => r.productId === productId && r.status === 'OPEN').reduce((a, r) => a + r.quantity, 0);
    return { onHand, reserved, available: availableOf(onHand, reserved) };
  }

  async recalculate(_tenantId: string, productIds: readonly string[] | null, now: Instant): Promise<RecalculationOutcome> {
    const out: RecalculationOutcome = { writes: [], unchanged: 0 };
    for (const scope of this.scopes.values()) {
      if (!scope.enabled || (productIds && !productIds.includes(scope.offer.productId))) continue;
      const allocation = this.allocations.get(scope.offer.channelAccountId);
      if (!allocation) continue;
      const q = publishedQuantity(this.availableOfProduct(scope.offer.productId).available, allocation);
      if (scope.lastSent === q) { out.unchanged += 1; continue; }
      scope.version += 1; scope.lastSent = q;
      this.writes.push({ writeScopeId: scope.writeScopeId, quantity: q, version: scope.version, status: 'PENDING', at: now, errorCode: null });
      out.writes.push({ writeScopeId: scope.writeScopeId, quantity: q, version: scope.version });
    }
    return out;
  }

  async recordOrderLines(_tenantId: string, channelAccountId: string, lines: readonly OrderLine[], _now: Instant): Promise<OrderLinesOutcome> {
    const out: OrderLinesOutcome = { created: 0, consumed: 0, released: 0, unknownOffers: 0, awaitingConfirmation: 0, productIds: [] };
    for (const line of lines) {
      const offer = this.offers.find((o) => o.channelAccountId === channelAccountId && o.externalOfferId === line.identity.externalOfferId);
      if (!offer) { out.unknownOffers += 1; continue; }
      const key = `${channelAccountId}|${line.externalOrderLineRef}|${offer.productId}`;
      const existing = this.reservations.get(key);
      if (!existing) {
        if (line.status === 'CANCELLED' || line.status === 'RETURNED') continue;
        // Пул товара с наибольшим остатком — как в базе; от его источника зависит, кто подтверждает резервацию
        const pool = [...this.pools].filter((x) => x.productId === offer.productId).sort((a, b) => b.onHand - a.onHand)[0];
        this.reservations.set(key, {
          key, productId: offer.productId, quantity: line.quantity, status: 'OPEN', orderRef: line.externalOrderRef,
          stockSourceId: pool?.stockSourceId ?? null, confirmed: (pool?.mode ?? 'INTERNAL_POOL') === 'INTERNAL_POOL',
        });
        out.created += 1; out.productIds.push(offer.productId);
        if (line.status === 'SHIPPED') this.ship(key, out);
        continue;
      }
      if (existing.status !== 'OPEN') continue;
      if (line.status === 'SHIPPED') this.ship(key, out);
      else if (line.status === 'CANCELLED') { existing.status = 'RELEASED'; out.released += 1; out.productIds.push(existing.productId); }
    }
    out.productIds = [...new Set(out.productIds)];
    return out;
  }

  /** Отгрузка: резервация списана, остаток внутреннего пула уменьшен движением ORDER_SHIPPED — как триггер базы */
  private ship(key: string, out: OrderLinesOutcome): void {
    const r = this.reservations.get(key)!;
    // Р-157: пул списывает только ПОДТВЕРЖДЁННАЯ резервация; неподтверждённая — названное число, а не тишина
    if (!r.confirmed) { r.shippedReported = true; out.awaitingConfirmation += 1; return; }
    r.status = 'CONSUMED';
    const pool = this.pools.find((p) => p.productId === r.productId && p.mode === 'INTERNAL_POOL');
    if (pool) pool.onHand = Math.max(0, pool.onHand - r.quantity);
    out.consumed += 1; out.productIds.push(r.productId);
  }

  private channelRow(scope: Scope): StockChannelRow {
    const own = this.writes.filter((w) => w.writeScopeId === scope.writeScopeId).sort((a, b) => b.version - a.version);
    const last = own[0] ?? null;
    const confirmed = own.find((w) => w.status === 'APPLIED') ?? null;
    const allocation = this.allocations.get(scope.offer.channelAccountId) ?? { bufferUnits: 0, maxQuantity: null, minQuantityToList: 0 };
    // Расхождение — ОДНО правило на все три места, где оно показывается (строка, список, счётчик); в PostgreSQL то же
    // правило записано один раз в `PgStockStore.DIVERGED_SQL`: ПОСЛЕДНЯЯ запись завершена не применением и повтора нет
    const inFlight = own.some((w) => IN_FLIGHT.includes(w.status));
    const diverged = !inFlight && last !== null && !IN_FLIGHT.includes(last.status) && last.status !== 'APPLIED' && last.status !== 'SUPERSEDED' ? last : null;
    return {
      writeScopeId: scope.writeScopeId, channelAccountId: scope.offer.channelAccountId, channel: scope.offer.channel, marketplaces: scope.offer.marketplaces,
      syncEnabled: scope.enabled, published: publishedQuantity(this.availableOfProduct(scope.offer.productId).available, allocation),
      sent: last ? { quantity: last.quantity, status: last.status, at: last.at, version: last.version } : null,
      confirmed: confirmed ? { quantity: confirmed.quantity, at: confirmed.at } : null,
      divergence: diverged ? { status: diverged.status, since: diverged.at, errorCode: diverged.errorCode } : null,
      sideEffects: { requiresAck: scope.offer.requiresSideEffectsAck === true, acknowledged: scope.acknowledged, text: scope.offer.sideEffectsText ?? null },
    };
  }

  async stockPage(_tenantId: string, query: { offset: number; limit: number }): Promise<StockPage> {
    const products = [...new Map(this.offers.map((o) => [o.productId, o])).values()].sort((a, b) => a.sku.localeCompare(b.sku));
    const rows: StockRow[] = products.map((o) => ({
      productId: o.productId, sku: o.sku, gtin: o.gtin ?? null, ...this.availableOfProduct(o.productId),
      channels: [...this.scopes.values()].filter((s) => s.offer.productId === o.productId).map((s) => this.channelRow(s)),
    }));
    const channelRows = rows.flatMap((r) => r.channels);
    return {
      items: rows.slice(query.offset, query.offset + query.limit), total: rows.length,
      summary: {
        products: rows.length, withStock: rows.filter((r) => r.onHand > 0).length, synced: channelRows.filter((c) => c.syncEnabled).length,
        pendingWrites: this.writes.filter((w) => IN_FLIGHT.includes(w.status)).length,
        diverged: channelRows.filter((c) => c.divergence !== null).length,
        openReservations: [...this.reservations.values()].filter((r) => r.status === 'OPEN').length,
      },
    };
  }

  async stockDivergences(_tenantId: string, limit: number): Promise<StockDivergenceRow[]> {
    const rows: StockDivergenceRow[] = [];
    for (const scope of this.scopes.values()) {
      const c = this.channelRow(scope);
      if (!c.divergence) continue;
      rows.push({ writeScopeId: scope.writeScopeId, productId: scope.offer.productId, sku: scope.offer.sku, channel: scope.offer.channel, marketplaces: scope.offer.marketplaces,
        sent: c.sent!.quantity, confirmed: c.confirmed?.quantity ?? null, status: c.divergence.status, errorCode: c.divergence.errorCode, since: c.divergence.since });
    }
    return rows.slice(0, limit);
  }
}
