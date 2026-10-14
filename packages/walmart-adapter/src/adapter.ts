import {
  DEFAULT_ERROR_CLASS, type AdapterCallContext, type AdapterDependencies, type ChannelAdapter, type ChannelError, type ChannelErrorCode, type CompetitorQuery,
  type CompetitorReadResult, type CompetitorSnapshot, type ConfirmationRequest, type ConfirmationResult, type DiscoveredOffer, type DispatchBatch,
  type DispatchPlan, type DispatchResult, type ErrorScope, type FieldWrite, type IdentifiedObservation, type InboundDelivery, type InboundResult, type Instant,
  type Money, type OrderLine, type Page, type PageRequest, type ReadBackRequest, type ReadBackResult, type WriteOutcome,
} from '@repracer/channel-port';
import { WalmartClient, WalmartHttpError, type WalmartClientOptions } from './client.ts';
import { SOURCE_WALMART_BUY_BOX, WALMART_DESCRIPTOR, WALMART_PATHS, WALMART_US } from './descriptor.ts';

/**
 * Шаг 89: адаптер Walmart Marketplace на симуляторе. Запись — одна на вызов (одиночное обновление цены или инвентаря); подтверждение —
 * обратным чтением товара; конкуренты — опрос Buy Box; статус публикации товара (Walmart снимает с публикации листинг с неконкурентной
 * ценой) — наблюдение `liveness` и отдельный метод `listingStatuses`. Заказы и входящие уведомления в этом шаге не читаются (W-09):
 * отказ «не поддерживается», а не пустой ответ, — пустой ответ выглядел бы как «заказов нет».
 */
const RANK = { TRANSIENT: 0, PERMANENT: 1, REQUIRES_HUMAN: 2 } as const;

export function channelError(code: ChannelErrorCode, scope: ErrorScope, message: string, extra: Partial<ChannelError> = {}): ChannelError {
  const base = DEFAULT_ERROR_CLASS[code];
  const cls = extra.class && RANK[extra.class] > RANK[base] ? extra.class : base;
  return { class: cls, code, scope, message: message.slice(0, 300), raiseAlert: extra.raiseAlert ?? cls === 'REQUIRES_HUMAN',
    ...(extra.retryAt ? { retryAt: extra.retryAt } : {}), ...(extra.httpStatus !== undefined ? { httpStatus: extra.httpStatus } : {}) };
}

export class ChannelCallError extends Error {
  readonly error: ChannelError;
  constructor(error: ChannelError) {
    super(`${error.code}: ${error.message}`);
    this.name = 'ChannelCallError';
    this.error = error;
  }
}

/** Ответ канала целиком — по статусу; 429 после повтора клиента — повтор не раньше минуты (W-07) */
export function classifyStatus(status: number, operation: string, nowMs: number): ChannelError {
  const message = `Walmart ${operation}: HTTP ${status}`;
  if (status === 400) return channelError('VALIDATION', 'ITEM', message, { httpStatus: status });
  if (status === 401) return channelError('AUTH_EXPIRED', 'ACCOUNT', message, { httpStatus: status });
  if (status === 403) return channelError('FORBIDDEN', 'ACCOUNT', message, { httpStatus: status });
  if (status === 404) return channelError('NOT_FOUND', 'ITEM', message, { httpStatus: status });
  if (status === 413) return channelError('VALIDATION', 'BATCH', `${message}: the feed is too large`, { httpStatus: status });
  if (status === 429) return channelError('RATE_LIMITED', 'BATCH', message, { httpStatus: status, retryAt: new Date(nowMs + 60_000).toISOString() as Instant });
  if (status >= 500) return channelError('CHANNEL_UNAVAILABLE', 'BATCH', message, { httpStatus: status });
  return channelError('UNKNOWN', 'ITEM', message, { httpStatus: status, raiseAlert: true });
}

interface WalmartMoney { currency?: string; amount?: number }
interface WalmartItem {
  sku?: string;
  gtin?: string;
  productName?: string;
  price?: WalmartMoney;
  publishedStatus?: string;
  unpublishedReasons?: { reason?: string[] };
  /** Цена того же товара на другой площадке, по которой Walmart снял листинг, — если канал её называет (W-10) */
  referencePrice?: WalmartMoney;
}

const toMinor = (amount: number | undefined) => (typeof amount === 'number' && Number.isFinite(amount) ? Math.round(amount * 100) : null);
const toAmount = (minor: number) => Number((minor / 100).toFixed(2));
const usd = (minor: number): Money => ({ amountMinor: minor, currency: 'USD', basis: 'NET' });

/** Статус публикации товара Walmart словами ядра: опубликован ли и почему нет */
export interface WalmartListingStatus {
  sku: string;
  published: boolean;
  reasons: string[];
  referencePrice: Money | null;
  price: Money | null;
}

export function listingStatusOf(item: WalmartItem): WalmartListingStatus | null {
  if (!item.sku) return null;
  const ref = toMinor(item.referencePrice?.amount);
  const price = toMinor(item.price?.amount);
  return {
    sku: item.sku, published: item.publishedStatus !== 'UNPUBLISHED', reasons: item.unpublishedReasons?.reason ?? [],
    referencePrice: ref === null ? null : usd(ref), price: price === null ? null : usd(price),
  };
}

export interface WalmartAdapterOptions extends Omit<WalmartClientOptions, 'clientId' | 'clientSecret'> {
  /** Ключи из секретов аккаунта (credentials_ref) — по умолчанию; тест может дать свои */
  credentials?: { clientId: string; clientSecret: string };
}

export class WalmartAdapter implements ChannelAdapter {
  readonly descriptor = WALMART_DESCRIPTOR;
  private readonly clients = new Map<string, WalmartClient>();
  private readonly deps: AdapterDependencies;
  private readonly options: WalmartAdapterOptions;

  constructor(deps: AdapterDependencies, options: WalmartAdapterOptions) {
    this.deps = deps;
    this.options = options;
  }

  /** Клиент аккаунта — после сверки тенанта [Р-31]; ключи — по ссылке на секреты аккаунта */
  private async client(ctx: AdapterCallContext): Promise<WalmartClient> {
    const verified = await this.deps.accounts.verify(ctx.tenantId, ctx.channelAccountId);
    if (!verified.ok) {
      const error = channelError(verified.reason === 'TENANT_MISMATCH' ? 'TENANT_MISMATCH' : 'ACCOUNT_INACTIVE', 'ACCOUNT', `channel account ${verified.reason}`, { raiseAlert: true });
      if (verified.reason === 'TENANT_MISMATCH') {
        await this.deps.alerts.raise({ code: 'WALMART_TENANT_MISMATCH', severity: 'CRITICAL', tenantId: ctx.tenantId, channelAccountId: ctx.channelAccountId, details: { channel: 'WALMART' } });
      }
      throw new ChannelCallError(error);
    }
    const known = this.clients.get(ctx.channelAccountId);
    if (known) return known;
    const secrets = this.options.credentials ?? await (async () => {
      const s = await this.deps.credentials.get(verified.account.credentialsRef);
      return { clientId: s.clientId ?? '', clientSecret: s.clientSecret ?? '' };
    })();
    const created = new WalmartClient({ ...this.options, ...secrets });
    this.clients.set(ctx.channelAccountId, created);
    return created;
  }

  /** Корзина токенов клиента аккаунта — для проверки «писатель не упирается в 429» */
  pacerOf(channelAccountId: string) {
    return this.clients.get(channelAccountId)?.pacer ?? null;
  }

  async planDispatch(_ctx: AdapterCallContext, writes: readonly FieldWrite[]): Promise<DispatchPlan> {
    const plan: DispatchPlan = { batches: [], rejected: [] };
    for (const w of writes) {
      if (w.value.field === 'CHANNEL_MIN_PRICE') {
        plan.rejected.push({ channelWriteId: w.channelWriteId, error: channelError('UNSUPPORTED', 'ITEM', 'Walmart has no channel minimum price field') });
        continue;
      }
      if (w.value.field === 'PRICE' && (w.value.price.currency !== 'USD' || w.value.price.amountMinor < 1)) {
        plan.rejected.push({ channelWriteId: w.channelWriteId, error: channelError('VALIDATION', 'ITEM', 'walmart.com prices are in USD and positive') });
        continue;
      }
      plan.batches.push({ batchId: `wmt-${w.channelWriteId}`, operation: w.value.field === 'PRICE' ? 'updatePrice' : 'updateInventory', items: [w], budgetCharges: [], requestCount: 1 });
    }
    return plan;
  }

  async dispatch(ctx: AdapterCallContext, batch: DispatchBatch): Promise<DispatchResult> {
    const client = await this.client(ctx);
    const outcomes: WriteOutcome[] = [];
    for (const w of batch.items) {
      const sku = w.writeScope.identity.externalSku;
      if (!sku) {
        outcomes.push({ channelWriteId: w.channelWriteId, status: 'REJECTED', error: channelError('VALIDATION', 'ITEM', 'a Walmart write needs the seller SKU') });
        continue;
      }
      try {
        const r = w.value.field === 'PRICE'
          ? await client.request('PUT', WALMART_PATHS.price, { sku, pricing: [{ currentPrice: { currency: 'USD', amount: toAmount(w.value.price.amountMinor) } }] })
          : await client.request('PUT', `${WALMART_PATHS.inventory}?sku=${encodeURIComponent(sku)}`,
            { sku, quantity: { unit: 'EACH', amount: (w.value as { quantity: number }).quantity } });
        if (r.status >= 200 && r.status < 300) outcomes.push({ channelWriteId: w.channelWriteId, status: 'ACCEPTED', appliedImmediately: false });
        else {
          const error = classifyStatus(r.status, batch.operation, Date.parse(this.deps.now()));
          // 5xx: запрос мог дойти — исход неизвестен, ядро сверит обратным чтением
          outcomes.push(error.code === 'CHANNEL_UNAVAILABLE' ? { channelWriteId: w.channelWriteId, status: 'OUTCOME_UNKNOWN', error } : { channelWriteId: w.channelWriteId, status: 'REJECTED', error });
        }
      } catch (e) {
        outcomes.push({ channelWriteId: w.channelWriteId, status: 'OUTCOME_UNKNOWN', error: channelError('NETWORK', 'BATCH', e instanceof Error ? e.message : String(e)) });
      }
    }
    return { batchId: batch.batchId, outcomes, attemptsMade: batch.items.length };
  }

  private async item(client: WalmartClient, sku: string): Promise<WalmartItem | null> {
    const r = await client.request('GET', `${WALMART_PATHS.items}/${encodeURIComponent(sku)}`);
    if (r.status === 404) return null;
    if (r.status !== 200) throw new ChannelCallError(classifyStatus(r.status, 'getItem', Date.parse(this.deps.now())));
    return r.body as WalmartItem;
  }

  async readBack(ctx: AdapterCallContext, requests: readonly ReadBackRequest[]): Promise<ReadBackResult> {
    const client = await this.client(ctx);
    const result: ReadBackResult = { observations: [], failures: [] };
    for (const req of requests) {
      const sku = req.writeScope.identity.externalSku;
      if (!sku) { result.failures.push({ writeScopeId: req.writeScope.writeScopeId, error: channelError('VALIDATION', 'ITEM', 'no seller SKU') }); continue; }
      try {
        const observedAt = this.deps.now();
        if (req.fields.includes('PRICE')) {
          const it = await this.item(client, sku);
          const status = it ? listingStatusOf(it) : null;
          if (!it || !status?.price) { result.failures.push({ writeScopeId: req.writeScope.writeScopeId, error: channelError('NOT_FOUND', 'ITEM', 'Walmart item not found') }); continue; }
          result.observations.push({ identity: req.writeScope.identity, field: 'PRICE', value: { field: 'PRICE', price: status.price }, observedAt, source: 'READBACK',
            liveness: { isLive: status.published, reasons: status.reasons } });
        }
        if (req.fields.includes('QUANTITY')) {
          const r = await client.request('GET', `${WALMART_PATHS.inventory}?sku=${encodeURIComponent(sku)}`);
          const amount = (r.body as { quantity?: { amount?: number } } | null)?.quantity?.amount;
          if (r.status !== 200 || typeof amount !== 'number') { result.failures.push({ writeScopeId: req.writeScope.writeScopeId, error: classifyStatus(r.status === 200 ? 404 : r.status, 'getInventory', Date.parse(observedAt)) }); continue; }
          result.observations.push({ identity: req.writeScope.identity, field: 'QUANTITY', value: { field: 'QUANTITY', quantity: amount }, observedAt, source: 'READBACK' });
        }
      } catch (e) {
        result.failures.push({ writeScopeId: req.writeScope.writeScopeId, error: e instanceof ChannelCallError ? e.error : channelError('NETWORK', 'ITEM', String(e)) });
      }
    }
    return result;
  }

  async confirm(ctx: AdapterCallContext, requests: readonly ConfirmationRequest[]): Promise<ConfirmationResult[]> {
    const read = await this.readBack(ctx, requests.map((r) => ({ writeScope: r.writeScope, fields: [r.expected.field] })));
    return requests.map((r): ConfirmationResult => {
      const obs = read.observations.find((o) => o.identity.externalSku === r.writeScope.identity.externalSku && o.field === r.expected.field) as IdentifiedObservation | undefined;
      if (!obs) return { channelWriteId: r.channelWriteId, status: 'UNKNOWN', error: read.failures.find((f) => f.writeScopeId === r.writeScope.writeScopeId)?.error ?? channelError('NOT_FOUND', 'ITEM', 'not read back') };
      const same = r.expected.field === 'PRICE' && obs.value.field === 'PRICE' ? obs.value.price.amountMinor === r.expected.price.amountMinor
        : r.expected.field === 'QUANTITY' && obs.value.field === 'QUANTITY' ? obs.value.quantity === r.expected.quantity : false;
      return { channelWriteId: r.channelWriteId, status: same ? 'APPLIED' : 'NOT_APPLIED', observation: obs };
    });
  }

  async readCompetitors(ctx: AdapterCallContext, queries: readonly CompetitorQuery[]): Promise<CompetitorReadResult> {
    const client = await this.client(ctx);
    const result: CompetitorReadResult = { snapshots: [], failures: [] };
    for (const q of queries) {
      try {
        const r = await client.request('GET', `${WALMART_PATHS.buybox}?sku=${encodeURIComponent(q.channelProductRef)}`);
        if (r.status !== 200) { result.failures.push({ query: q, error: classifyStatus(r.status, 'getBuyBox', Date.parse(this.deps.now())) }); continue; }
        const b = r.body as { buyBox?: { price?: WalmartMoney; isSelf?: boolean }; offers?: Array<{ sellerRef?: string; isSelf?: boolean; price?: WalmartMoney; shipping?: WalmartMoney }>; observedAt?: string };
        const offers = (b.offers ?? []).flatMap((o, i) => {
          const minor = toMinor(o.price?.amount);
          if (minor === null) return [];
          const ship = toMinor(o.shipping?.amount);
          return [{ rank: i + 1, isSelf: o.isSelf === true, price: usd(minor), ...(o.sellerRef ? { sellerRef: o.sellerRef } : {}), ...(ship !== null ? { shipping: usd(ship) } : {}) }];
        });
        const bb = toMinor(b.buyBox?.price?.amount);
        const snapshot: CompetitorSnapshot = {
          marketplace: q.marketplace, channelProductRef: q.channelProductRef, condition: q.condition, source: SOURCE_WALMART_BUY_BOX,
          observedAt: (b.observedAt ?? this.deps.now()) as Instant, completeness: { kind: 'TOP_N', n: 10 }, offers,
          ...(bb !== null ? { buybox: { price: usd(bb), isSelf: b.buyBox?.isSelf === true } } : {}),
        };
        result.snapshots.push(snapshot);
      } catch (e) {
        result.failures.push({ query: q, error: channelError('NETWORK', 'ITEM', String(e)) });
      }
    }
    return result;
  }

  async discoverOffers(ctx: AdapterCallContext, page: PageRequest): Promise<Page<DiscoveredOffer>> {
    const client = await this.client(ctx);
    const query = `?limit=${Math.min(page.limit ?? 50, 200)}${page.cursor ? `&nextCursor=${encodeURIComponent(page.cursor)}` : ''}`;
    const r = await client.request('GET', `${WALMART_PATHS.items}${query}`);
    if (r.status !== 200) throw new ChannelCallError(classifyStatus(r.status, 'getAllItems', Date.parse(this.deps.now())));
    const b = r.body as { ItemResponse?: WalmartItem[]; nextCursor?: string | null };
    const items = (b.ItemResponse ?? []).flatMap((it): DiscoveredOffer[] => {
      const status = listingStatusOf(it);
      if (!status) return [];
      return [{
        identity: { marketplace: WALMART_US, externalSku: status.sku, channelProductRef: status.sku }, gtins: it.gtin ? [it.gtin] : [], condition: 'new',
        fulfillment: 'MERCHANT', ...(status.price ? { currentPrice: status.price } : {}), isLive: status.published,
      }];
    });
    return { items, ...(b.nextCursor ? { nextCursor: b.nextCursor } : {}) } as Page<DiscoveredOffer>;
  }

  /** Статус публикации товаров: Walmart снимает с публикации листинг с неконкурентной ценой — его видно здесь, причиной */
  async listingStatuses(ctx: AdapterCallContext, skus: readonly string[]): Promise<WalmartListingStatus[]> {
    const client = await this.client(ctx);
    const out: WalmartListingStatus[] = [];
    for (const sku of skus) {
      const it = await this.item(client, sku);
      const s = it ? listingStatusOf(it) : null;
      if (s) out.push(s);
    }
    return out;
  }

  async readOrderLines(_ctx: AdapterCallContext, _window: { since: Instant } & PageRequest): Promise<Page<OrderLine>> {
    throw new ChannelCallError(channelError('UNSUPPORTED', 'ACCOUNT', 'Walmart orders are not read in step 89 (W-09)'));
  }

  async handleInbound(_delivery: InboundDelivery): Promise<InboundResult> {
    throw new ChannelCallError(channelError('UNSUPPORTED', 'ACCOUNT', 'Walmart notifications are not received in step 89 (W-09)'));
  }
}

export { WalmartHttpError };
