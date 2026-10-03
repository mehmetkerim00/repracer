import type { ChannelBehaviour, ChannelReply, ObservedRequest } from '../harness/channel.ts';
import { defaultAmazonParams, type AmazonModelParams } from './params.ts';
import { SeededRandom } from './random.ts';

/**
 * Шаг 51: модель Amazon SP-API на уровне HTTP — по образцу модели eBay [Р-187]: канал с состоянием вместо записанных обменов, тот же
 * ChannelBehaviour, поэтому через неё идёт НАСТОЯЩИЙ адаптер Amazon (модель порта `amazon-port.ts` остаётся для живых прогонов, где нужен
 * поток конкурентов). Поведение — ТОЛЬКО из снимка моделей (vendor/amazon/sp-api-models/2026-09-29 и 2026-09-16) и страниц документации
 * из SOURCE.md; где снимок молчит — параметр с вопросом A-nn (params.ts), а не выдуманный ответ:
 * - LWA: POST /auth/o2/token по refresh_token (connecting-to-the-selling-partner-api);
 * - searchListingsItems / getListingsItem: summaries, attributes (purchasable_offer, fulfillment_availability), offers, fulfillmentAvailability —
 *   наборы по includedData;
 * - patchListingsItem: ответ ACCEPTED, применение — через applyDelayMs, часть принятого не применяется (A-06); количество DEFAULT — на регион или
 *   на витрину (A-01); запись DEFAULT по SKU сети Amazon — нарушение стенда (адаптер обязан не слать, Р-6), исход неизвестен (A-21);
 * - searchOrders (Orders 2026-01-01): ровно одно из createdAfter и lastUpdatedAfter, фильтры marketplaceIds и fulfilledBy, наборы includedData,
 *   страницы maxResultsPerPage 1…100 с paginationToken; данные покупателя — только по набору BUYER, если не велит иное параметр A-20;
 * - getInventorySummaries (FBA Inventory v1): granularityType=Marketplace, одна витрина, sellerSkus ≤ 50; только SKU сети Amazon;
 * - лимиты запросов — token bucket по таблице Usage Plan каждой операции снимка; превышение — 429 (ответ из перечня ответов операции).
 * Коды ошибок SP-API в моделях не перечислены — тела ошибок модели синтетические (код с приставкой SYN_). Все данные синтетические.
 */

export interface SimAmazonOfferSpec {
  sku: string;
  asin: string;
  /** Витрины региона аккаунта, где оффер есть */
  marketplaces: string[];
  priceMinor: number;
  /** Сеть исполнения: DEFAULT — наша (FBM), иначе — код сети Amazon (коды в снимке не перечислены, A-21; в сценариях — синтетический); null — кодов нет */
  fulfillmentCode?: string | null;
  quantity: number;
  productType?: string;
  /**
   * Шаг 69 (OQ-249): название товара — `itemName` сводки витрины (definitions.ItemSummaryByMarketplace снимка, поле необязательное).
   * По умолчанию синтетическое «Synthetic product <sku>»; null — сводка без названия
   */
  title?: string | null;
}

export interface SimAmazonOrderSpec {
  orderId: string;
  marketplace: string;
  fulfilledBy: 'MERCHANT' | 'AMAZON';
  channelName?: 'AMAZON' | 'NON_AMAZON';
  status: 'PENDING_AVAILABILITY' | 'PENDING' | 'UNSHIPPED' | 'PARTIALLY_SHIPPED' | 'SHIPPED' | 'CANCELLED' | 'UNFULFILLABLE';
  /** Смещение от начала мира: создан и последний раз изменён */
  createdOffsetMs: number;
  updatedOffsetMs: number;
  items: Array<{ orderItemId: string; sku: string; quantity: number; quantityFulfilled?: number; cancelledBy?: 'BUYER' | 'MERCHANT' | 'AMAZON' }>;
}

/** world.channelModel сценария Amazon (HTTP): ключ `offers` отличает его от модели eBay (`listings`) и Kaufland (`competitors`) */
export interface AmazonChannelModelSpec {
  seed: number;
  params?: Partial<AmazonModelParams>;
  sellerId: string;
  region: 'EU' | 'NA';
  offers: SimAmazonOfferSpec[];
  orders?: SimAmazonOrderSpec[];
}

interface OfferState {
  sku: string;
  asin: string;
  marketplace: string;
  priceMinor: number;
  productType: string;
  fulfillmentCode: string | null;
  quantity: number;
  title: string | null;
  pending: Array<{ atMs: number; priceMinor?: number; quantity?: number }>;
}

export interface AmazonSimulatorStats {
  requests: Record<string, number>;
  rateLimited: number;
  accepted: number;
  applied: number;
  acceptedNeverApplied: number;
  /** Записи количества DEFAULT по SKU сети Amazon — адаптер не должен их слать (Р-6, AMZ_C14) */
  fbaQuantityWrites: number;
}

/** Usage Plan операций снимка (rate / burst); уровень приложения моделью не описан — модель держит лимит пары */
const USAGE_PLAN: Readonly<Record<string, { rate: number; burst: number }>> = {
  searchListingsItems: { rate: 5, burst: 5 },
  getListingsItem: { rate: 5, burst: 5 },
  patchListingsItem: { rate: 5, burst: 5 },
  searchOrders: { rate: 0.0056, burst: 20 },
  getInventorySummaries: { rate: 2, burst: 2 },
};

const CURRENCY: Readonly<Record<string, { currency: string; region: 'EU' | 'NA' }>> = {
  A1PA6795UKMFR9: { currency: 'EUR', region: 'EU' }, ATVPDKIKX0DER: { currency: 'USD', region: 'NA' },
};

const major = (minor: number) => Number(`${Math.trunc(minor / 100)}.${String(Math.abs(minor % 100)).padStart(2, '0')}`);
const listOf = (v: string | undefined) => (v ? v.split(',').map((x) => x.trim()).filter(Boolean) : []);
const synError = (code: string, message: string) => ({ errors: [{ code: `SYN_${code}`, message: `${message} (model)` }] });

class Bucket {
  private tokens: number;
  private updated: number;
  private readonly rate: number;
  private readonly burst: number;
  constructor(rate: number, burst: number, now: number) { this.rate = rate; this.burst = burst; this.tokens = burst; this.updated = now; }
  take(now: number): boolean {
    this.tokens = Math.min(this.burst, this.tokens + (Math.max(0, now - this.updated) / 1000) * this.rate);
    this.updated = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

export class SimulatedAmazonChannel implements ChannelBehaviour {
  readonly params: AmazonModelParams;
  readonly stats: AmazonSimulatorStats = { requests: {}, rateLimited: 0, accepted: 0, applied: 0, acceptedNeverApplied: 0, fbaQuantityWrites: 0 };
  private readonly spec: AmazonChannelModelSpec;
  private readonly accessToken: string;
  private readonly offers = new Map<string, OfferState>();
  private readonly buckets = new Map<string, Bucket>();
  private readonly startMs: number;
  private readonly rng: SeededRandom;
  private submissions = 0;
  /** Страницы searchOrders: токен → запрос и смещение (токен модели — синтетический и предсказуемый) */
  private readonly orderPages = new Map<string, { q: Record<string, string>; start: number }>();
  private nowMs: number;

  constructor(spec: AmazonChannelModelSpec, startIso: string, accessToken: string) {
    this.spec = spec;
    this.params = { ...defaultAmazonParams(), ...structuredClone(spec.params ?? {}) };
    this.accessToken = accessToken;
    this.startMs = Date.parse(startIso);
    this.nowMs = this.startMs;
    this.rng = new SeededRandom(spec.seed);
    for (const o of spec.offers) {
      for (const m of o.marketplaces) {
        this.offers.set(`${m}|${o.sku}`, {
          sku: o.sku, asin: o.asin, marketplace: m, priceMinor: o.priceMinor, productType: o.productType ?? 'SYNTHETIC_PRODUCT_TYPE',
          fulfillmentCode: o.fulfillmentCode === undefined ? 'DEFAULT' : o.fulfillmentCode, quantity: o.quantity, pending: [],
          title: o.title === undefined ? `Synthetic product ${o.sku}` : o.title,
        });
      }
    }
    for (const [op, p] of Object.entries(USAGE_PLAN)) {
      this.buckets.set(op, new Bucket(p.rate, op === 'getListingsItem' ? this.params.readBurst : p.burst, this.startMs));
    }
  }

  /** Применение принятых записей, чьё время пришло (A-06) */
  private settle(): void {
    for (const o of this.offers.values()) {
      const due = o.pending.filter((p) => p.atMs <= this.nowMs);
      if (due.length === 0) continue;
      o.pending = o.pending.filter((p) => p.atMs > this.nowMs);
      for (const p of due) {
        if (p.priceMinor !== undefined) o.priceMinor = p.priceMinor;
        if (p.quantity !== undefined) o.quantity = p.quantity;
        this.stats.applied += 1;
      }
    }
  }

  private offersOfSku(sku: string, marketplaces: readonly string[]): OfferState[] {
    return marketplaces.map((m) => this.offers.get(`${m}|${sku}`)).filter((o): o is OfferState => Boolean(o));
  }

  private listingBody(sku: string, list: readonly OfferState[], included: readonly string[]) {
    const has = (x: string) => included.length === 0 ? x === 'summaries' : included.includes(x);
    const first = list[0]!;
    const fa = first.fulfillmentCode === null ? [] : [{ fulfillmentChannelCode: first.fulfillmentCode, quantity: first.quantity }];
    return {
      sku,
      ...(has('summaries') ? { summaries: list.map((o) => ({ marketplaceId: o.marketplace, asin: o.asin, productType: o.productType, conditionType: 'new_new', status: ['BUYABLE', 'DISCOVERABLE'],
        ...(o.title !== null ? { itemName: o.title } : {}), createdDate: new Date(this.startMs - 86_400_000).toISOString(), lastUpdatedDate: new Date(this.nowMs).toISOString() })) } : {}),
      ...(has('attributes') ? { attributes: {
        purchasable_offer: list.map((o) => ({ marketplace_id: o.marketplace, currency: CURRENCY[o.marketplace]?.currency ?? 'EUR', audience: 'ALL', our_price: [{ schedule: [{ value_with_tax: major(o.priceMinor) }] }] })),
        ...(first.fulfillmentCode === null ? {} : { fulfillment_availability: [{ fulfillment_channel_code: first.fulfillmentCode, quantity: first.quantity }] }),
      } } : {}),
      ...(has('offers') ? { offers: list.map((o) => ({ marketplaceId: o.marketplace, offerType: 'B2C', price: { currencyCode: CURRENCY[o.marketplace]?.currency ?? 'EUR', amount: String(major(o.priceMinor)) } })) } : {}),
      ...(has('fulfillmentAvailability') ? { fulfillmentAvailability: fa } : {}),
      ...(has('issues') ? { issues: [] } : {}),
    };
  }

  reply(request: ObservedRequest, nowMs: number): { exchangeId: string; reply: ChannelReply } | { violation: string } {
    this.nowMs = Math.max(this.nowMs, nowMs);
    this.settle();
    const { method, path } = request;
    const listing = /^\/listings\/2021-08-01\/items\/([^/]+)(?:\/([^/]+))?$/.exec(path);
    const operation = path === '/auth/o2/token' ? 'lwaToken'
      : listing ? (listing[2] ? (method === 'PATCH' ? 'patchListingsItem' : 'getListingsItem') : 'searchListingsItems')
        : path === '/orders/2026-01-01/orders' ? 'searchOrders' : path === '/fba/inventory/v1/summaries' ? 'getInventorySummaries' : `${method} ${path}`;
    this.stats.requests[operation] = (this.stats.requests[operation] ?? 0) + 1;
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
      ({ exchangeId: `sim:${operation}`, reply: { kind: 'response' as const, status, headers: { 'content-type': 'application/json', ...headers }, body } });

    if (operation === 'lwaToken') return json(200, { access_token: this.accessToken, token_type: 'bearer', expires_in: 3600 });
    const plan = USAGE_PLAN[operation];
    if (!plan) return { violation: `${method} ${path}: the Amazon model has no such operation` };
    if (!this.buckets.get(operation)!.take(this.nowMs)) {
      this.stats.rateLimited += 1;
      return json(429, synError('QUOTA_EXCEEDED', `usage plan of ${operation} exceeded`), { 'x-amzn-RateLimit-Limit': String(plan.rate) });
    }
    const limitHeader = { 'x-amzn-RateLimit-Limit': String(plan.rate) };

    if (listing) {
      if (decodeURIComponent(listing[1]!) !== this.spec.sellerId) return json(403, synError('FORBIDDEN', 'seller of the token does not match the path'));
      const marketplaces = listOf(request.query.marketplaceIds);
      if (marketplaces.length === 0) return json(400, synError('INVALID_INPUT', 'marketplaceIds is required'));
      const included = listOf(request.query.includedData);
      if (operation === 'searchListingsItems') {
        const skus = [...new Set([...this.offers.values()].filter((o) => marketplaces.includes(o.marketplace)).map((o) => o.sku))].sort();
        // Шаг 52: страница может быть короче pageSize, а первая — пустой с токеном (параметр paging)
        const size = Math.min(Math.max(1, Math.min(20, Number(request.query.pageSize ?? 10))), this.params.paging.pageSizeCap ?? 20);
        if (!request.query.pageToken && this.params.paging.emptyPageFirst) return json(200, { numberOfResults: skus.length, pagination: { nextToken: 'syn-page-0' }, items: [] }, limitHeader);
        const start = request.query.pageToken ? Number(/^syn-page-(\d+)$/.exec(request.query.pageToken)?.[1] ?? Number.NaN) : 0;
        if (!Number.isSafeInteger(start)) return json(400, synError('INVALID_INPUT', 'pageToken is not a token of this model'));
        const page = skus.slice(start, start + size);
        return json(200, { numberOfResults: skus.length, pagination: start + size < skus.length ? { nextToken: `syn-page-${start + size}` } : {},
          items: page.map((sku) => this.listingBody(sku, this.offersOfSku(sku, marketplaces), included)) }, limitHeader);
      }
      const sku = decodeURIComponent(listing[2]!);
      const list = this.offersOfSku(sku, marketplaces);
      if (list.length === 0) return json(404, synError('NOT_FOUND', 'listing not found'));
      if (operation === 'getListingsItem') return json(200, this.listingBody(sku, list, included), limitHeader);
      return this.patch(request, sku, list, marketplaces, json, limitHeader);
    }
    if (operation === 'searchOrders') return this.searchOrders(request, json, limitHeader);
    return this.inventorySummaries(request, json, limitHeader);
  }

  private patch(request: ObservedRequest, sku: string, list: readonly OfferState[], marketplaces: readonly string[],
    json: (status: number, body: unknown, headers?: Record<string, string>) => { exchangeId: string; reply: ChannelReply }, headers: Record<string, string>) {
    const body = request.body as { productType?: unknown; patches?: Array<{ op?: string; path?: string; value?: Array<Record<string, unknown>> }> } | null;
    if (!body || typeof body.productType !== 'string' || !Array.isArray(body.patches) || body.patches.length === 0) return json(400, synError('INVALID_INPUT', 'productType and patches are required'));
    const applyAt = this.nowMs + this.params.applyDelayMs;
    const neverApplied = this.rng.next() < this.params.acceptedNotAppliedShare;
    for (const p of body.patches) {
      if (p.op !== 'merge' && p.op !== 'replace') return json(400, synError('INVALID_INPUT', `op ${String(p.op)} is not modelled`));
      if (p.path === '/attributes/purchasable_offer') {
        for (const v of p.value ?? []) {
          const target = list.find((o) => o.marketplace === v.marketplace_id);
          const value = (v.our_price as Array<{ schedule?: Array<{ value_with_tax?: number }> }> | undefined)?.[0]?.schedule?.[0]?.value_with_tax;
          if (!target || typeof value !== 'number') return json(400, synError('INVALID_INPUT', 'purchasable_offer needs marketplace_id of the request and our_price'));
          if (!neverApplied) target.pending.push({ atMs: applyAt, priceMinor: Math.round(value * 100) });
        }
      } else if (p.path === '/attributes/fulfillment_availability') {
        const v = p.value?.[0] as { fulfillment_channel_code?: string; quantity?: number } | undefined;
        if (!v || v.fulfillment_channel_code !== 'DEFAULT' || !Number.isSafeInteger(v.quantity) || (v.quantity as number) < 0) return json(400, synError('INVALID_INPUT', 'fulfillment_availability needs DEFAULT and a quantity ≥ 0'));
        // A-21: что делает Amazon с DEFAULT по SKU сети Amazon, снимок не говорит — модель не применяет и считает (адаптер не должен слать)
        if (list[0]!.fulfillmentCode !== null && list[0]!.fulfillmentCode !== 'DEFAULT') {
          this.stats.fbaQuantityWrites += 1;
          // Гипотеза варианта A-21: запись DEFAULT переводит листинг в исполнение продавцом
          if (this.params.fbaDefaultWrite === 'SWITCHES_TO_MERCHANT') for (const o of list) o.fulfillmentCode = 'DEFAULT';
          continue;
        }
        // A-01: количество DEFAULT — одно на регион (все витрины SKU) или только витрина запроса
        const targets = this.params.quantityScope === 'REGION' ? [...this.offers.values()].filter((o) => o.sku === sku) : list.filter((o) => o.marketplace === marketplaces[0]);
        if (!neverApplied) for (const t of targets) t.pending.push({ atMs: applyAt, quantity: v.quantity as number });
      } else {
        return json(400, synError('INVALID_INPUT', `patch path ${String(p.path)} is not modelled`));
      }
    }
    this.stats.accepted += 1;
    if (neverApplied) this.stats.acceptedNeverApplied += 1;
    this.submissions += 1;
    return json(200, { sku, status: 'ACCEPTED', submissionId: `syn-submission-${this.submissions}`, issues: [] }, headers);
  }

  private searchOrders(request: ObservedRequest, json: (status: number, body: unknown, headers?: Record<string, string>) => { exchangeId: string; reply: ChannelReply }, headers: Record<string, string>) {
    const q = request.query;
    let start = 0;
    if (q.paginationToken) {
      // Модель: прочие параметры — те же, что у запроса, выдавшего токен, кроме maxResultsPerPage и includedData
      const page = this.orderPages.get(q.paginationToken);
      if (!page) return json(400, synError('INVALID_INPUT', 'paginationToken is not a token of this model'));
      const changed = ['createdAfter', 'createdBefore', 'lastUpdatedAfter', 'lastUpdatedBefore', 'fulfillmentStatuses', 'marketplaceIds', 'fulfilledBy']
        .filter((k) => (q[k] ?? '') !== (page.q[k] ?? ''));
      if (changed.length > 0) return json(400, synError('INVALID_INPUT', `paginationToken with other parameters: ${changed.join(', ')}`));
      start = page.start;
    }
    // Модель: «You must provide exactly one of createdAfter and lastUpdatedAfter»
    if (Boolean(q.createdAfter) === Boolean(q.lastUpdatedAfter)) return json(400, synError('INVALID_INPUT', 'exactly one of createdAfter and lastUpdatedAfter'));
    const asked = Number(q.maxResultsPerPage ?? 100);
    if (!Number.isSafeInteger(asked) || asked < 1 || asked > 100) return json(400, synError('INVALID_INPUT', 'maxResultsPerPage must be 1…100'));
    // Шаг 52: страница может быть короче запрошенной, а первая — пустой с токеном (параметр paging)
    const size = Math.min(asked, this.params.paging.pageSizeCap ?? asked);
    if (!q.paginationToken && this.params.paging.emptyPageFirst) {
      const token = `syn-orders-page-${this.orderPages.size + 1}`;
      const { paginationToken: _t, ...first } = q;
      this.orderPages.set(token, { q: first, start: 0 });
      return json(200, { orders: [], pagination: { nextToken: token } }, headers);
    }
    const sinceMs = Date.parse(q.createdAfter ?? q.lastUpdatedAfter!);
    const marketplaces = listOf(q.marketplaceIds);
    const fulfilledBy = listOf(q.fulfilledBy);
    const included = listOf(q.includedData);
    const matching = (this.spec.orders ?? [])
      .filter((o) => this.startMs + (q.createdAfter ? o.createdOffsetMs : o.updatedOffsetMs) >= sinceMs && this.startMs + o.createdOffsetMs <= this.nowMs)
      .filter((o) => marketplaces.length === 0 || marketplaces.includes(o.marketplace))
      .filter((o) => fulfilledBy.length === 0 || fulfilledBy.includes(o.fulfilledBy))
      .sort((a, b) => a.updatedOffsetMs - b.updatedOffsetMs || a.orderId.localeCompare(b.orderId));
    const page = matching.slice(start, start + size);
    // A-20: данные покупателя — только по набору BUYER (модель); параметр может отдавать их всегда, проверяя белый список адаптера
    const buyer = included.includes('BUYER') || this.params.ordersBuyerWithoutDataset;
    const orders = page.map((o) => ({
      orderId: o.orderId, createdTime: new Date(this.startMs + o.createdOffsetMs).toISOString(), lastUpdatedTime: new Date(this.startMs + o.updatedOffsetMs).toISOString(),
      salesChannel: { channelName: o.channelName ?? 'AMAZON', marketplaceId: o.marketplace },
      ...(included.includes('FULFILLMENT') ? { fulfillment: { fulfillmentStatus: o.status, fulfilledBy: o.fulfilledBy } } : {}),
      ...(buyer ? { buyer: { buyerCompanyName: 'syn-model-buyer-company' } } : {}),
      orderItems: o.items.map((i) => ({
        orderItemId: i.orderItemId, quantityOrdered: i.quantity,
        product: { sellerSku: i.sku, asin: this.offersOfSku(i.sku, [o.marketplace])[0]?.asin ?? 'B0SYNUNKNOWN' },
        // A-22: у частично отгруженного заказа канал может не сообщать отгрузку строк (вариант)
        ...(included.includes('FULFILLMENT') && (o.status !== 'PARTIALLY_SHIPPED' || this.params.partialShipmentReported)
          ? { fulfillment: { quantityFulfilled: i.quantityFulfilled ?? 0, quantityUnfulfilled: i.quantity - (i.quantityFulfilled ?? 0) } } : {}),
        ...(included.includes('CANCELLATION') && i.cancelledBy ? { cancellation: { cancellationExecution: { cancelledBy: i.cancelledBy } } } : {}),
      })),
    }));
    let next: string | null = null;
    if (start + size < matching.length) {
      next = `syn-orders-page-${this.orderPages.size + 1}`;
      const { paginationToken: _token, ...first } = q;
      this.orderPages.set(next, { q: first, start: start + size });
    }
    return json(200, { orders, ...(next ? { pagination: { nextToken: next } } : {}) }, headers);
  }

  private inventorySummaries(request: ObservedRequest, json: (status: number, body: unknown, headers?: Record<string, string>) => { exchangeId: string; reply: ChannelReply }, headers: Record<string, string>) {
    const q = request.query;
    const marketplaces = listOf(q.marketplaceIds);
    const skus = listOf(q.sellerSkus);
    if (q.granularityType !== 'Marketplace' || !q.granularityId || marketplaces.length !== 1) return json(400, synError('INVALID_INPUT', 'granularityType=Marketplace, granularityId and exactly one marketplaceIds'));
    if (skus.length > 50) return json(400, synError('INVALID_INPUT', 'sellerSkus: up to 50'));
    const fba = [...this.offers.values()].filter((o) => o.marketplace === marketplaces[0] && o.fulfillmentCode !== null && o.fulfillmentCode !== 'DEFAULT'
      && (skus.length === 0 || skus.includes(o.sku)));
    return json(200, { payload: { granularity: { granularityType: 'Marketplace', granularityId: q.granularityId },
      inventorySummaries: fba.map((o) => ({ asin: o.asin, sellerSku: o.sku, condition: 'NewItem', totalQuantity: o.quantity,
        lastUpdatedTime: new Date(this.nowMs).toISOString(), ...(q.details === 'true' ? { inventoryDetails: { fulfillableQuantity: o.quantity, inboundWorkingQuantity: 0, inboundShippedQuantity: 0, inboundReceivingQuantity: 0 } } : {}) })) } }, headers);
  }

  finish(): string[] {
    return [];
  }

  /** Состояние модели для expect.channel (как у моделей Kaufland и eBay) */
  dump() {
    this.settle();
    return {
      offers: [...this.offers.values()].map((o) => ({ sku: o.sku, marketplace: o.marketplace, priceMinor: o.priceMinor, quantity: o.quantity, fulfillmentCode: o.fulfillmentCode, pending: o.pending.length })),
      stats: structuredClone(this.stats),
    };
  }
}
