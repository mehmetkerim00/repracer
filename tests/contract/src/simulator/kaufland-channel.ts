import type { ChannelBehaviour, ChannelReply, ObservedRequest } from '../harness/channel.ts';
import type { InboundDeliverySpec } from '../harness/scenario.ts';
import { defaultKauflandParams, type KauflandModelParams } from './params.ts';
import { SeededRandom } from './random.ts';

/**
 * Симулятор Kaufland Seller API v2 [Р-113]: канал с состоянием вместо записанных ответов. Реализует тот же ChannelBehaviour,
 * что и ScriptedChannel, поэтому сценарий, адаптер и путь решения не меняются. Что моделируется:
 * - unit (цена, остаток, id_offer, витрина), запись PATCH и POST /units/bulk с частичным успехом (207);
 * - лимит запросов (K-04) и лимит правок unit (K-05), задержка применения (K-15), распространение остатка (K-06);
 * - конкуренты с дрейфом цены и победитель Buy Box, GET /buybox (K-17), уведомления buy_box_changed с debounce и потерями (K-10);
 * - сбои: тайм-аут записи с применением или без (K-14), пропуск и 5xx элемента пакета.
 * Не моделируется (ответы канала неизвестны или шагу не нужны): подписки, отчёты, заказы как ресурс, item_unit_*,
 * реальный алгоритм Buy Box (у нас — минимальная цена с доставкой, при равенстве — прежний победитель).
 * Все данные синтетические.
 */

export type CompetitorBehaviour =
  | { kind: 'STATIC' }
  /** Случайное блуждание: шаг каждые everyMs, стандартное отклонение volatilityBp, в пределах [minMinor, maxMinor] */
  | { kind: 'RANDOM_WALK'; everyMs: number; volatilityBp: number; minMinor: number; maxMinor: number }
  /** Конкурент-репрайсер: через reactionMs после изменения нашей цены встаёт на undercutMinor дешевле, не ниже floorMinor */
  | { kind: 'UNDERCUT_SELF'; undercutMinor: number; reactionMs: number; floorMinor: number; ceilingMinor: number }
  /** Цена по расписанию: смещение от начала мира → цена */
  | { kind: 'SCHEDULE'; points: Array<{ atOffsetMs: number; priceMinor: number }> };

export interface SimUnitSpec {
  idUnit: number;
  storefront: string;
  idOffer: string;
  idProduct: number;
  condition?: string;
  listingPriceMinor: number;
  amount: number;
  isLive?: boolean;
  /** Ставка НДС витрины, б. п. — нужна при K-12 = NET */
  vatBp?: number;
  shippingMinor?: number;
  deliveryDays?: { min: number; max: number };
  /** Продавец включил Smart Pricing в кабинете канала (Р-12): minimum_price unit в ответе GET /units */
  minimumPriceMinor?: number;
}

export interface SimCompetitorSpec {
  sellerRef: string;
  storefront: string;
  idProduct: number;
  condition?: string;
  priceMinor: number;
  shippingMinor?: number;
  deliveryDays?: { min: number; max: number };
  behaviour: CompetitorBehaviour;
}

/** world.channelModel сценария */
export interface KauflandChannelModelSpec {
  seed: number;
  params?: Partial<KauflandModelParams>;
  /** Адрес вебхука аккаунта (Р-40), на который модель доставляет уведомления */
  webhookUrl: string;
  sellerPseudonym?: string;
  units: SimUnitSpec[];
  competitors: SimCompetitorSpec[];
  /**
   * Шаг 35: спрос. Модель сама создаёт заказы (`order-units`): раз в `orderEveryMs` — одна единица случайного оффера с остатком;
   * через `shipAfterMs` заказ отгружается (`sent`), доля `cancelShare` — отменяется. Заказ уменьшает amount по K-11.
   * Без `demand` заказов нет — как у сценариев до шага 35.
   */
  demand?: { orderEveryMs: number; shipAfterMs: number; cancelShare: number };
}

/** Строка заказа канала — только те поля, что отдаёт `GET /order-units` и берёт адаптер по белому списку [Р-4] */
interface SimOrderUnit {
  idOrderUnit: number;
  idOrder: string;
  idOffer: string;
  storefront: string;
  status: 'open' | 'sent' | 'cancelled';
  tsCreatedMs: number;
  tsUpdatedMs: number;
  /** Когда заказ закроется (отгрузкой или отменой) */
  closesAtMs: number;
  willCancel: boolean;
}

interface UnitState extends Required<Omit<SimUnitSpec, 'deliveryDays' | 'minimumPriceMinor'>> {
  deliveryDays: { min: number; max: number };
  pending: { priceMinor: number; visibleAtMs: number } | null;
  pendingAmount: { amount: number; visibleAtMs: number } | null;
  lastChangeMs: number;
  edits: number[];
  /** Р-12, Р-111: запись minimum_price фиксируется как нарушение, канал включил бы своё ценообразование */
  minimumPriceMinor: number | null;
}

interface CompetitorState extends SimCompetitorSpec {
  condition: string;
  shippingMinor: number;
  deliveryDays: { min: number; max: number };
  nextStepMs: number;
  scheduleIndex: number;
  reactToChangeAtMs: number | null;
}

interface Offer { self: boolean; sellerRef: string; priceMinor: number; shippingMinor: number; unit?: UnitState; deliveryDays: { min: number; max: number } }

export interface SimulatorStats {
  requests: Record<string, number>;
  rateLimited: number;
  editLimited: number;
  timeouts: number;
  timeoutsApplied: number;
  bulkItemsMissing: number;
  bulkItemsFailed: number;
  priceEditsApplied: number;
  buyBoxChanges: number;
  notificationsScheduled: number;
  notificationsLost: number;
  notificationsDelivered: number;
  /** Шаг 35: спрос модели */
  ordersPlaced: number;
  ordersShipped: number;
  ordersCancelled: number;
}

const PROBLEM = {
  429: { type: 'about:blank', message: 'Too Many Requests', errors: [] },
  422: { type: '/problems/action-not-allowed', message: 'Action not allowed', errors: [] },
  400: { type: '/problems/validation-error', message: 'Validation failed', errors: [] as Array<{ field: string; message: string }> },
  404: { type: '/problems/not-found', message: 'Not found', errors: [] },
  500: { type: '/problems/server-error', message: 'Server error', errors: [] },
} as const;

function problemFor(status: number): unknown {
  return (PROBLEM as Record<number, unknown>)[status] ?? { type: 'about:blank', message: `status ${status}`, errors: [] };
}

class Bucket {
  private tokens: number;
  private updatedMs: number;
  private readonly rate: number;
  private readonly burst: number;

  constructor(rate: number, burst: number, nowMs: number) {
    this.rate = rate;
    this.burst = burst;
    this.tokens = burst;
    this.updatedMs = nowMs;
  }

  take(nowMs: number): boolean {
    this.tokens = Math.min(this.burst, this.tokens + (Math.max(0, nowMs - this.updatedMs) / 1000) * this.rate);
    this.updatedMs = nowMs;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

export class SimulatedKauflandChannel implements ChannelBehaviour {
  readonly params: KauflandModelParams;
  private readonly orders: SimOrderUnit[] = [];
  private nextOrderMs: number | null = null;
  readonly stats: SimulatorStats = {
    requests: {}, rateLimited: 0, editLimited: 0, timeouts: 0, timeoutsApplied: 0, bulkItemsMissing: 0, bulkItemsFailed: 0,
    priceEditsApplied: 0, buyBoxChanges: 0, notificationsScheduled: 0, notificationsLost: 0, notificationsDelivered: 0, ordersPlaced: 0, ordersShipped: 0, ordersCancelled: 0,
  };
  private readonly spec: KauflandChannelModelSpec;
  private readonly startMs: number;
  private readonly rng: SeededRandom;
  private readonly units = new Map<string, UnitState>();
  private readonly competitors: CompetitorState[];
  private readonly buckets: Bucket[];
  private readonly violations: string[] = [];
  /** Победитель Buy Box по товару: ключ «витрина|товар|состояние» */
  private readonly winners = new Map<string, { sellerRef: string; priceMinor: number }>();
  private readonly pendingNotifications = new Map<string, { dueMs: number; lost: boolean }>();
  private readonly timedOutBodies = new Map<string, number>();
  private messageNo = 0;
  private nowMs: number;

  constructor(spec: KauflandChannelModelSpec, startIso: string) {
    this.spec = spec;
    this.params = { ...defaultKauflandParams(), ...structuredClone(spec.params ?? {}) };
    this.startMs = Date.parse(startIso);
    this.nowMs = this.startMs;
    this.rng = new SeededRandom(spec.seed);
    for (const u of spec.units) {
      this.units.set(`${u.storefront}|${u.idUnit}`, {
        ...u, condition: u.condition ?? 'new', isLive: u.isLive ?? true, vatBp: u.vatBp ?? 1900, shippingMinor: u.shippingMinor ?? 0,
        deliveryDays: u.deliveryDays ?? { min: 1, max: 3 }, pending: null, pendingAmount: null, lastChangeMs: this.startMs, edits: [], minimumPriceMinor: u.minimumPriceMinor ?? null,
      });
    }
    this.competitors = spec.competitors.map((c) => ({
      ...c, condition: c.condition ?? 'new', shippingMinor: c.shippingMinor ?? 0, deliveryDays: c.deliveryDays ?? { min: 1, max: 2 },
      nextStepMs: this.startMs + (c.behaviour.kind === 'RANDOM_WALK' ? c.behaviour.everyMs : 0), scheduleIndex: 0, reactToChangeAtMs: null,
    }));
    const { rateLimit, rateLimitScope, otherSellersLoadRps } = this.params;
    const partnerRate = Math.max(0, rateLimit.ratePerSecond - otherSellersLoadRps);
    this.buckets = [
      ...(rateLimitScope !== 'PARTNER' ? [new Bucket(rateLimit.ratePerSecond, rateLimit.burst, this.startMs)] : []),
      ...(rateLimitScope !== 'SELLER' ? [new Bucket(partnerRate, Math.max(1, Math.round(rateLimit.burst * (partnerRate / rateLimit.ratePerSecond))), this.startMs)] : []),
    ];
    for (const key of this.productKeys()) this.winners.set(key, this.winnerOf(key));
  }

  // -------------------------------------------------------------------------
  // Время мира
  // -------------------------------------------------------------------------

  /** Продвинуть модель до момента: применение отложенных записей, дрейф конкурентов, смена Buy Box, уведомления */
  advanceTo(nowMs: number): void {
    if (nowMs < this.nowMs) return;
    // Шагаем по событиям модели по порядку, чтобы реакция конкурента видела нашу цену в свой момент
    for (;;) {
      const next = this.nextEventMs(nowMs);
      if (next === null) break;
      this.nowMs = next;
      this.applyDue(next);
    }
    this.nowMs = nowMs;
    this.applyDue(nowMs);
  }

  private nextEventMs(limitMs: number): number | null {
    let next = Number.POSITIVE_INFINITY;
    for (const u of this.units.values()) {
      if (u.pending && u.pending.visibleAtMs > this.nowMs) next = Math.min(next, u.pending.visibleAtMs);
      if (u.pendingAmount && u.pendingAmount.visibleAtMs > this.nowMs) next = Math.min(next, u.pendingAmount.visibleAtMs);
    }
    if (this.nextOrderMs !== null && this.nextOrderMs > this.nowMs) next = Math.min(next, this.nextOrderMs);
    for (const o of this.orders) if (o.status === 'open' && o.closesAtMs > this.nowMs) next = Math.min(next, o.closesAtMs);
    for (const c of this.competitors) {
      if (c.behaviour.kind === 'RANDOM_WALK' && c.nextStepMs > this.nowMs) next = Math.min(next, c.nextStepMs);
      if (c.behaviour.kind === 'SCHEDULE') {
        const p = c.behaviour.points[c.scheduleIndex];
        if (p && this.startMs + p.atOffsetMs > this.nowMs) next = Math.min(next, this.startMs + p.atOffsetMs);
      }
      if (c.reactToChangeAtMs !== null && c.reactToChangeAtMs > this.nowMs) next = Math.min(next, c.reactToChangeAtMs);
    }
    return next <= limitMs && Number.isFinite(next) ? next : null;
  }

  private applyDue(at: number): void {
    this.applyDemand(at);
    for (const u of this.units.values()) {
      if (u.pending && u.pending.visibleAtMs <= at) {
        u.listingPriceMinor = u.pending.priceMinor;
        if (this.params.lastChangeOnPriceEdit) u.lastChangeMs = u.pending.visibleAtMs;
        u.pending = null;
        this.stats.priceEditsApplied += 1;
        this.onSelfPriceVisible(u, at);
      }
      if (u.pendingAmount && u.pendingAmount.visibleAtMs <= at) {
        u.amount = u.pendingAmount.amount;
        u.pendingAmount = null;
      }
    }
    for (const c of this.competitors) {
      const b = c.behaviour;
      if (b.kind === 'RANDOM_WALK') {
        while (c.nextStepMs <= at) {
          const moved = Math.round(c.priceMinor * (1 + (this.rng.normal() * b.volatilityBp) / 10_000));
          c.priceMinor = Math.min(b.maxMinor, Math.max(b.minMinor, moved));
          c.nextStepMs += b.everyMs;
        }
      } else if (b.kind === 'SCHEDULE') {
        while (b.points[c.scheduleIndex] && this.startMs + b.points[c.scheduleIndex]!.atOffsetMs <= at) {
          c.priceMinor = b.points[c.scheduleIndex]!.priceMinor;
          c.scheduleIndex += 1;
        }
      } else if (b.kind === 'UNDERCUT_SELF' && c.reactToChangeAtMs !== null && c.reactToChangeAtMs <= at) {
        c.reactToChangeAtMs = null;
        const self = [...this.units.values()].find((u) => u.storefront === c.storefront && u.idProduct === c.idProduct && u.condition === c.condition);
        if (self) {
          const target = this.buyerPrice(self) + self.shippingMinor - b.undercutMinor - c.shippingMinor;
          c.priceMinor = Math.min(b.ceilingMinor, Math.max(b.floorMinor, target));
        }
      }
    }
    for (const key of this.productKeys()) {
      const winner = this.winnerOf(key);
      const before = this.winners.get(key);
      if (!before || before.sellerRef !== winner.sellerRef || before.priceMinor !== winner.priceMinor) {
        this.winners.set(key, winner);
        this.stats.buyBoxChanges += 1;
        this.scheduleNotification(key, at);
      }
    }
  }

  private onSelfPriceVisible(u: UnitState, at: number): void {
    for (const c of this.competitors) {
      if (c.behaviour.kind === 'UNDERCUT_SELF' && c.storefront === u.storefront && c.idProduct === u.idProduct && c.condition === u.condition) {
        c.reactToChangeAtMs = at + c.behaviour.reactionMs;
      }
    }
  }

  private scheduleNotification(key: string, at: number): void {
    const { delivered, debounceMs, lossShare } = this.params.buyBoxChanged;
    if (!delivered) return;
    // Debounce: изменения в окне схлопываются в одно уведомление с состоянием на момент отправки
    if (this.pendingNotifications.has(key)) return;
    this.stats.notificationsScheduled += 1;
    this.pendingNotifications.set(key, { dueMs: at + debounceMs, lost: this.rng.chance(lossShare) });
  }

  /** Уведомления, срок которых наступил: в формате шага сценария, подпись — секретом продавца мира */
  drainDeliveries(nowMs: number): InboundDeliverySpec[] {
    this.advanceTo(nowMs);
    const out: InboundDeliverySpec[] = [];
    for (const [key, n] of [...this.pendingNotifications.entries()].sort((a, b) => a[1].dueMs - b[1].dueMs)) {
      if (n.dueMs > nowMs) continue;
      this.pendingNotifications.delete(key);
      if (n.lost) { this.stats.notificationsLost += 1; continue; }
      this.stats.notificationsDelivered += 1;
      out.push(this.buyBoxChangedDelivery(key, n.dueMs));
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Рынок
  // -------------------------------------------------------------------------

  private productKeys(): string[] {
    const keys = new Set<string>();
    for (const u of this.units.values()) keys.add(`${u.storefront}|${u.idProduct}|${u.condition}`);
    for (const c of this.competitors) keys.add(`${c.storefront}|${c.idProduct}|${c.condition}`);
    return [...keys];
  }

  /** Цена покупателя: при K-12 = NET канал прибавляет НДС к listing_price */
  private buyerPrice(u: UnitState): number {
    return this.params.listingPriceBasis === 'NET' ? Math.round(u.listingPriceMinor * (1 + u.vatBp / 10_000)) : u.listingPriceMinor;
  }

  offersOf(key: string): Offer[] {
    const [storefront, idProduct, condition] = key.split('|');
    const offers: Offer[] = [];
    for (const u of this.units.values()) {
      if (u.storefront === storefront && String(u.idProduct) === idProduct && u.condition === condition && u.isLive && u.amount > 0) {
        offers.push({ self: true, sellerRef: this.spec.sellerPseudonym ?? 'Synthetic Seller', priceMinor: this.buyerPrice(u), shippingMinor: u.shippingMinor, unit: u, deliveryDays: u.deliveryDays });
      }
    }
    for (const c of this.competitors) {
      if (c.storefront === storefront && String(c.idProduct) === idProduct && c.condition === condition) {
        offers.push({ self: false, sellerRef: c.sellerRef, priceMinor: c.priceMinor, shippingMinor: c.shippingMinor, deliveryDays: c.deliveryDays });
      }
    }
    const previous = this.winners.get(key)?.sellerRef;
    // Упрощение модели: Buy Box — минимальная цена с доставкой; при равенстве — прежний победитель
    return offers.sort((a, b) => (a.priceMinor + a.shippingMinor) - (b.priceMinor + b.shippingMinor)
      || Number(b.sellerRef === previous) - Number(a.sellerRef === previous));
  }

  private winnerOf(key: string): { sellerRef: string; priceMinor: number } {
    const top = this.offersOf(key)[0];
    return top ? { sellerRef: top.self ? '$self' : top.sellerRef, priceMinor: top.priceMinor } : { sellerRef: '$none', priceMinor: 0 };
  }

  /** Состояние рынка товара на момент: для бэктеста и проверок */
  market(storefront: string, idProduct: number, condition = 'new'): { selfWins: boolean; buyboxMinor: number | null; offers: Array<{ self: boolean; priceMinor: number }> } {
    const offers = this.offersOf(`${storefront}|${idProduct}|${condition}`);
    return { selfWins: offers[0]?.self ?? false, buyboxMinor: offers[0]?.priceMinor ?? null, offers: offers.map((o) => ({ self: o.self, priceMinor: o.priceMinor })) };
  }

  private buyBoxChangedDelivery(key: string, atMs: number): InboundDeliverySpec {
    const offers = this.offersOf(key).slice(0, 10);
    const [storefront, idProduct, condition] = key.split('|');
    const money = (amount: number) => ({ amount, currency_code: 'EUR' });
    const offer = (o: Offer, rank: number) => ({
      rank,
      ...(o.self && o.unit ? { id_unit: o.unit.idUnit, id_offer: o.unit.idOffer } : {}),
      seller: { pseudonym: o.sellerRef },
      prices: { total_price: money(o.priceMinor + o.shippingMinor), sales_price: money(o.priceMinor), shipping_cost: money(o.shippingMinor) },
      delivery_time: { min: o.deliveryDays.min, max: o.deliveryDays.max },
    });
    const selfIndex = offers.findIndex((o) => o.self);
    this.messageNo += 1;
    const body = {
      event_name: 'buy_box_changed',
      resource: `/buybox?id_product=${idProduct}&condition=${condition}`,
      id_message: `sim${String(this.spec.seed).padStart(8, '0')}${String(this.messageNo).padStart(21, '0')}`,
      storefront,
      payload: {
        buy_box_change: selfIndex === 0 ? 'won' : 'lost',
        id_product: Number(idProduct),
        condition,
        timestamp: new Date(Math.floor(atMs / 1000) * 1000).toISOString().replace('.000Z', 'Z'),
        eans: [],
        ...(offers[0] ? { winner_offer: offer(offers[0], 1) } : {}),
        ...(selfIndex >= 0 ? { seller_offer: offer(offers[selfIndex]!, selfIndex + 1) } : {}),
        offers: offers.map((o, i) => offer(o, i + 1)),
      },
    };
    return {
      method: 'POST',
      url: this.spec.webhookUrl,
      headers: { 'Shop-Timestamp': String(Math.floor(this.nowMs / 1000)), 'Shop-Signature': { $signWith: 'seller' } },
      body,
    };
  }

  // -------------------------------------------------------------------------
  // HTTP
  // -------------------------------------------------------------------------

  reply(request: ObservedRequest, nowMs: number): { exchangeId: string; reply: ChannelReply } | { violation: string } {
    this.advanceTo(nowMs);
    const route = this.route(request);
    this.stats.requests[route] = (this.stats.requests[route] ?? 0) + 1;
    const exchangeId = `sim:${route}`;
    const respond = (status: number, body: unknown) => ({ exchangeId, reply: { kind: 'response' as const, status, headers: {}, body } });

    if (JSON.stringify(request.body ?? null).includes('minimum_price')) {
      // Р-12, Р-111: запись собственного пола цены канала запрещена — нарушение, даже если канал её принял бы
      this.violations.push(`${request.method} ${request.path}: body writes minimum_price (Р-12, Р-111)`);
    }
    if (!this.buckets.every((b) => b.take(nowMs))) {
      this.stats.rateLimited += 1;
      return respond(429, PROBLEM[429]);
    }

    const storefront = request.query.storefront ?? '';
    const unitPath = /^\/v2\/units\/([0-9]+)$/.exec(request.path);
    if (request.method === 'GET' && unitPath) {
      const u = this.units.get(`${storefront}|${unitPath[1]}`);
      return u ? respond(200, { data: this.unitView(u) }) : respond(404, PROBLEM[404]);
    }
    if (request.method === 'PATCH' && unitPath) {
      const u = this.units.get(`${storefront}|${unitPath[1]}`);
      if (!u) return respond(404, PROBLEM[404]);
      const timeout = this.rng.chance(this.params.faults.writeTimeoutShare);
      const result = this.applyWrite(u, request.body as Record<string, unknown>, nowMs, `${request.path}|${request.rawBody}`, timeout);
      if (timeout) return { exchangeId, reply: { kind: 'fault', fault: 'TIMEOUT' } };
      return result.status === 200 ? respond(200, { data: this.unitView(u) }) : respond(result.status, result.problem);
    }
    if (request.method === 'POST' && request.path === '/v2/units/bulk') {
      const items = Array.isArray(request.body) ? request.body as Array<{ id_unit?: number; unit_data?: Record<string, unknown> }> : [];
      const data: unknown[] = [];
      for (const item of items) {
        if (this.rng.chance(this.params.faults.bulkItemMissingShare)) { this.stats.bulkItemsMissing += 1; continue; }
        const u = this.units.get(`${storefront}|${item.id_unit}`);
        if (!u) { data.push({ id_unit: item.id_unit, status_code: 404, message: 'Not found', errors: [] }); continue; }
        if (this.rng.chance(this.params.faults.bulkItemServerErrorShare)) {
          this.stats.bulkItemsFailed += 1;
          data.push({ id_unit: u.idUnit, status_code: 500, message: 'Server error', errors: [] });
          continue;
        }
        const result = this.applyWrite(u, item.unit_data ?? {}, nowMs, `bulk|${u.idUnit}|${JSON.stringify(item.unit_data)}`, false);
        data.push(result.status === 200
          ? { id_unit: u.idUnit, status_code: 200, unit: this.unitView(u) }
          : { id_unit: u.idUnit, status_code: result.status, message: (result.problem as { message: string }).message, errors: (result.problem as { errors: unknown[] }).errors });
      }
      return respond(207, { data });
    }
    if (request.method === 'GET' && request.path === '/v2/units') {
      const units = [...this.units.values()].filter((u) => u.storefront === storefront && (!request.query.id_offer || u.idOffer === request.query.id_offer));
      return respond(200, { data: units.map((u) => this.unitView(u)), pagination: { offset: 0, limit: Number(request.query.limit ?? 100), total: units.length } });
    }
    if (request.method === 'POST' && request.path === '/v2/units/status') {
      const ids = ((request.body as { unit_ids?: number[] } | undefined)?.unit_ids ?? []);
      return respond(200, { data: ids.map((id) => {
        const u = this.units.get(`${storefront}|${id}`);
        return u ? { id_unit: id, status_code: 200, is_live: u.isLive && u.amount > 0, reasons: u.amount > 0 ? [] : [{ reason: 'stock_update_needed' }] }
          : { id_unit: id, status_code: 404 };
      }) });
    }
    if (request.method === 'GET' && request.path === '/v2/order-units') {
      // Как у Kaufland: с момента ts_updated_from_iso, страница по offset, свежие обновления первыми
      const since = Date.parse(request.query.ts_updated_from_iso ?? '');
      const limit = Math.max(1, Math.min(Number(request.query.limit ?? 100), 100));
      const offset = Math.max(0, Number(request.query.offset ?? 0));
      const rows = this.orders.filter((o) => Number.isNaN(since) || o.tsUpdatedMs >= since).sort((a, b) => b.tsUpdatedMs - a.tsUpdatedMs || b.idOrderUnit - a.idOrderUnit);
      return respond(200, {
        data: rows.slice(offset, offset + limit).map((o) => ({
          id_order_unit: o.idOrderUnit, id_order: o.idOrder, id_offer: o.idOffer, storefront: o.storefront, status: o.status,
          ts_created_iso: new Date(o.tsCreatedMs).toISOString(), ts_updated_iso: new Date(o.tsUpdatedMs).toISOString(),
        })),
        pagination: { offset, limit, total: rows.length },
      });
    }
    if (request.method === 'GET' && request.path === '/v2/buybox') {
      const key = `${storefront}|${request.query.id_product}|${request.query.condition ?? 'new'}`;
      const offers = this.offersOf(key).slice(0, Number(request.query.limit ?? 10));
      const units = this.params.buyboxPriceUnits === 'MAJOR' ? (m: number) => m / 100 : (m: number) => m;
      return respond(200, { data: {
        id_product: Number(request.query.id_product), condition: request.query.condition ?? 'new', storefront, num_units: offers.length,
        units: offers.map((o, i) => ({
          buybox_rank: i + 1, seller: o.sellerRef, price: units(o.priceMinor), shipping_rate: units(o.shippingMinor),
          delivery_time_min: o.deliveryDays.min, delivery_time_max: o.deliveryDays.max, fulfillment_type: 'fulfilled_by_merchant', condition: request.query.condition ?? 'new',
          ...(o.self && o.unit ? { id_unit: o.unit.idUnit, id_offer: o.unit.idOffer } : {}),
        })),
      } });
    }
    return { violation: `simulator does not model ${request.method} ${request.path}` };
  }

  private route(request: ObservedRequest): string {
    return `${request.method} ${request.path.replace(/\/[0-9]+$/, '/{id}')}`;
  }

  private applyWrite(u: UnitState, data: Record<string, unknown>, nowMs: number, retryKey: string, timeout: boolean): { status: number; problem?: unknown } {
    const keys = Object.keys(data);
    if (keys.includes('amount') && !keys.includes('listing_price') && this.params.quantityWriteRequiresListingPrice) {
      return { status: 400, problem: { ...PROBLEM[400], errors: [{ field: 'listing_price', message: 'You have to specify a listing price greater than zero' }] } };
    }
    if (keys.includes('amount') && keys.includes('listing_price')) {
      this.violations.push(`unit ${u.idUnit}: quantity write carries listing_price (KFL_C03)`);
    }
    const known = keys.filter((k) => k === 'listing_price' || k === 'amount' || k === 'minimum_price');
    if (known.length !== keys.length || keys.length === 0) return { status: 400, problem: problemFor(400) };

    // K-14: идентичный повтор после тайм-аута — одна правка (SAME_EDIT) или новая (SECOND_EDIT)
    const retried = this.timedOutBodies.get(retryKey);
    const sameEdit = this.params.identicalRetry === 'SAME_EDIT' && retried !== undefined && nowMs - retried < 600_000;
    const limit = this.params.unitEditLimit;
    if (limit && !sameEdit) {
      u.edits = u.edits.filter((t) => nowMs - t < limit.windowMs);
      if (u.edits.length >= limit.maxEdits) {
        this.stats.editLimited += 1;
        return { status: this.params.unitEditLimitStatus, problem: problemFor(this.params.unitEditLimitStatus) };
      }
    }
    if (timeout) {
      this.stats.timeouts += 1;
      this.timedOutBodies.set(retryKey, nowMs);
      if (!this.rng.chance(this.params.faults.timeoutAppliedShare)) return { status: 200 };
      this.stats.timeoutsApplied += 1;
    }
    if (!sameEdit) u.edits.push(nowMs);

    if (typeof data.listing_price === 'number') {
      const visibleAtMs = nowMs + this.params.applyDelayMs;
      if (this.params.applyDelayMs === 0) {
        u.pending = { priceMinor: data.listing_price, visibleAtMs: nowMs };
        this.applyDue(nowMs);
      } else {
        u.pending = { priceMinor: data.listing_price, visibleAtMs };
      }
    }
    if (typeof data.amount === 'number') {
      u.amount = data.amount;
      u.lastChangeMs = nowMs;
      // K-06: остаток общий для unit id_offer на витринах [Р-35]
      for (const sibling of this.units.values()) {
        if (sibling !== u && sibling.idOffer === u.idOffer) {
          if (this.params.quantityPropagationMs === 0) sibling.amount = data.amount;
          else sibling.pendingAmount = { amount: data.amount, visibleAtMs: nowMs + this.params.quantityPropagationMs };
        }
      }
    }
    if (typeof data.minimum_price === 'number') u.minimumPriceMinor = data.minimum_price;
    return { status: 200 };
  }

  /** Спрос модели: новые заказы по расписанию, закрытие открытых по сроку */
  private applyDemand(at: number): void {
    const d = this.spec.demand;
    if (!d) return;
    if (this.nextOrderMs === null) this.nextOrderMs = this.startMs + d.orderEveryMs;
    while (this.nextOrderMs <= at) {
      const inStock = [...this.units.values()].filter((u) => u.isLive && u.amount > 0);
      if (inStock.length > 0) {
        const u = inStock[Math.floor(this.rng.next() * inStock.length)]!;
        const id = this.orders.length + 1;
        this.orders.push({
          idOrderUnit: 900_000 + id, idOrder: `SYN-ORDER-${id}`, idOffer: u.idOffer, storefront: u.storefront, status: 'open',
          tsCreatedMs: this.nextOrderMs, tsUpdatedMs: this.nextOrderMs, closesAtMs: this.nextOrderMs + d.shipAfterMs, willCancel: this.rng.chance(d.cancelShare),
        });
        this.stats.ordersPlaced += 1;
        // K-11: заказ уменьшает amount у всех unit этого id_offer — как placeOrder
        if (this.params.orderDecrementsAmount) for (const x of this.units.values()) if (x.idOffer === u.idOffer) x.amount = Math.max(0, x.amount - 1);
      }
      this.nextOrderMs += d.orderEveryMs;
    }
    for (const o of this.orders) {
      if (o.status === 'open' && o.closesAtMs <= at) {
        o.status = o.willCancel ? 'cancelled' : 'sent';
        o.tsUpdatedMs = o.closesAtMs;
        if (o.willCancel) this.stats.ordersCancelled += 1; else this.stats.ordersShipped += 1;
      }
    }
  }

  /** Заказ покупателя: K-11 — уменьшает ли канал amount сам */
  placeOrder(idOffer: string, quantity: number, nowMs: number): void {
    this.advanceTo(nowMs);
    if (!this.params.orderDecrementsAmount) return;
    for (const u of this.units.values()) if (u.idOffer === idOffer) u.amount = Math.max(0, u.amount - quantity);
  }

  private unitView(u: UnitState): Record<string, unknown> {
    return {
      id_unit: u.idUnit, storefront: u.storefront, currency: 'EUR', condition: u.condition, status: 'available',
      listing_price: u.listingPriceMinor, price: this.buyerPrice(u), amount: u.amount, id_offer: u.idOffer, id_product: u.idProduct,
      fulfillment_type: 'fulfilled_by_merchant', is_live: u.isLive && u.amount > 0,
      ...(u.minimumPriceMinor !== null ? { minimum_price: u.minimumPriceMinor } : {}),
      date_lastchange_iso: new Date(Math.floor(u.lastChangeMs / 1000) * 1000).toISOString().replace('.000Z', 'Z'),
    };
  }

  finish(): string[] {
    return [...this.violations];
  }

  /** Состояние для expect.channel сценария */
  dump(): unknown {
    return {
      units: [...this.units.values()].map((u) => ({
        idUnit: u.idUnit, storefront: u.storefront, listingPriceMinor: u.listingPriceMinor, buyerPriceMinor: this.buyerPrice(u), amount: u.amount,
        pendingPriceMinor: u.pending?.priceMinor ?? null, winsBuyBox: this.offersOf(`${u.storefront}|${u.idProduct}|${u.condition}`)[0]?.unit === u,
      })),
      competitors: this.competitors.map((c) => ({ sellerRef: c.sellerRef, storefront: c.storefront, idProduct: c.idProduct, priceMinor: c.priceMinor })),
      stats: this.stats,
      violations: this.violations,
    };
  }
}
