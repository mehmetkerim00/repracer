import type {
  AdapterCallContext,
  AdapterDependencies,
  ChannelAdapter,
  ChannelDescriptor,
  ChannelError,
  CompetitorQuery,
  CompetitorReadResult,
  CompetitorSnapshot,
  ConfirmationRequest,
  ConfirmationResult,
  DiscoveredOffer,
  DispatchBatch,
  DispatchPlan,
  DispatchResult,
  FieldWrite,
  IdentifiedObservation,
  InboundDelivery,
  InboundResult,
  OrderLine,
  Page,
  ReadBackRequest,
  ReadBackResult,
  WriteOutcome,
} from '@repracer/channel-port';
import { DEFAULT_ERROR_CLASS, isNeverWritten } from '@repracer/channel-port';
import { defaultAmazonParams, type AmazonModelParams } from './params.ts';
import { SeededRandom } from './random.ts';

/**
 * Модель Amazon SP-API на уровне порта [Р-113]. Адаптера Amazon в репозитории нет, поэтому HTTP-модель было бы нечем вызывать;
 * симулятор реализует ChannelAdapter сам и даёт пути решения и диспетчеру поведение Amazon, заданное параметрами A-nn:
 * - запись асинхронна (patchListingsItem ACCEPTED), применяется через applyDelayMs, часть принятого не применяется (A-06);
 * - два уровня лимита записи: продавец 5 rps / burst 5 и приложение 500 rps с нагрузкой других продавцов (снимок моделей);
 * - обратное чтение getListingsItem 5 rps, burst — A-07; getCompetitiveSummary 0.033 rps, burst 1 (CLAUDE.md, снимок моделей);
 * - остаток MFN на регион или на витрину (A-01); лимит изменений SKU (A-04);
 * - ANY_OFFER_CHANGED — снимки конкурентов с задержкой и потерями (A-08), отдаются drainSnapshots, не через handleInbound;
 * - собственный пол цены канала (minimum_seller_allowed_price) не пишется никогда [Р-111]: планирование отказывает без вызова.
 * Коды ошибок Amazon не моделируются: ответы канала при превышении лимита правок неизвестны (A-04) — модель отдаёт ACTION_NOT_ALLOWED
 * как предположение. Все данные синтетические.
 */

export const AMAZON_DE = 'A1PA6795UKMFR9';
export const AMAZON_SIM_SOURCE = 'AMAZON_ANY_OFFER_CHANGED';

export interface AmazonSkuSpec { sku: string; asin: string; marketplaces: string[]; priceMinor: number; quantity: number }
export interface AmazonCompetitorSpec { sellerRef: string; marketplace: string; asin: string; priceMinor: number; schedule?: Array<{ atOffsetMs: number; priceMinor: number }> }
export interface AmazonPortModelSpec { seed: number; params?: Partial<AmazonModelParams>; skus: AmazonSkuSpec[]; competitors: AmazonCompetitorSpec[] }

interface Listing { sku: string; asin: string; marketplace: string; priceMinor: number; quantity: number; pendingPrice: { minor: number; at: number } | null; pendingQuantity: { value: number; at: number } | null; edits: number[] }

class Bucket {
  private tokens: number;
  private updated: number;
  private readonly rate: number;
  private readonly burst: number;
  constructor(rate: number, burst: number, now: number) { this.rate = rate; this.burst = burst; this.tokens = burst; this.updated = now; }
  take(now: number): { ok: true } | { ok: false; retryAtMs: number } {
    this.tokens = Math.min(this.burst, this.tokens + (Math.max(0, now - this.updated) / 1000) * this.rate);
    this.updated = now;
    if (this.tokens >= 1) { this.tokens -= 1; return { ok: true }; }
    return { ok: false, retryAtMs: now + (this.rate > 0 ? Math.ceil(((1 - this.tokens) / this.rate) * 1000) : 3_600_000) };
  }
}

function error(code: ChannelError['code'], message: string, extra: Partial<ChannelError> = {}): ChannelError {
  const cls = extra.class ?? DEFAULT_ERROR_CLASS[code];
  return { class: cls, code, scope: 'ITEM', message, raiseAlert: cls === 'REQUIRES_HUMAN', ...extra };
}

export const AMAZON_SIM_DESCRIPTOR: ChannelDescriptor = {
  channel: 'AMAZON',
  apiMode: 'AMAZON_LISTINGS_ITEMS',
  region: 'EU',
  apiVersion: 'listings-items-2021-08-01 (simulated)',
  haltRelease: { kind: 'MANUAL_ONLY', basis: 'Р-119: no competitor polling on Amazon' },
  // Граница суток amazon.de не подтверждена (A-03, Р-65): значение нужно типу, бюджетов правок модель не ведёт
  marketplaces: [{ code: AMAZON_DE, currency: 'EUR', priceBasis: 'GROSS', timeZone: 'Europe/Berlin' }],
  fields: [],
  rateLimits: [
    { owner: 'SELLER_APPLICATION_OPERATION', operation: 'patchListingsItem', requestsPerSecond: 5, burst: 5, source: 'DOCUMENTED' },
    { owner: 'APPLICATION', operation: 'patchListingsItem', requestsPerSecond: 500, source: 'DOCUMENTED' },
  ],
  capabilities: [],
};

export class SimulatedAmazonPort implements ChannelAdapter {
  readonly descriptor = AMAZON_SIM_DESCRIPTOR;
  readonly params: AmazonModelParams;
  readonly stats = { patchCalls: 0, patchRateLimited: 0, readCalls: 0, readRateLimited: 0, editLimited: 0, acceptedNeverApplied: 0, summaryCalls: 0, summaryRateLimited: 0, eventsLost: 0, eventsDelivered: 0 };
  private readonly deps: AdapterDependencies;
  private readonly startMs: number;
  private readonly rng: SeededRandom;
  private readonly listings = new Map<string, Listing>();
  private readonly competitors: Array<AmazonCompetitorSpec & { index: number }>;
  private readonly seller: Bucket;
  private readonly application: Bucket;
  private readonly read: Bucket;
  private readonly summary: Bucket;
  private readonly events: Array<{ dueMs: number; marketplace: string; asin: string }> = [];
  private nowMs: number;

  constructor(spec: AmazonPortModelSpec, deps: AdapterDependencies) {
    this.deps = deps;
    this.params = { ...defaultAmazonParams(), ...structuredClone(spec.params ?? {}) };
    this.startMs = Date.parse(deps.now());
    this.nowMs = this.startMs;
    this.rng = new SeededRandom(spec.seed);
    for (const s of spec.skus) {
      for (const m of s.marketplaces) this.listings.set(`${m}|${s.sku}`, { sku: s.sku, asin: s.asin, marketplace: m, priceMinor: s.priceMinor, quantity: s.quantity, pendingPrice: null, pendingQuantity: null, edits: [] });
    }
    this.competitors = spec.competitors.map((c) => ({ ...c, index: 0 }));
    const p = this.params.patchRate;
    this.seller = new Bucket(p.seller.ratePerSecond, p.seller.burst, this.startMs);
    const appRate = Math.max(0, p.application.ratePerSecond - this.params.otherSellersLoadRps);
    this.application = new Bucket(appRate, Math.max(1, Math.round(p.application.burst * (appRate / p.application.ratePerSecond))), this.startMs);
    this.read = new Bucket(5, this.params.readBurst, this.startMs);
    this.summary = new Bucket(0.033, 1, this.startMs);
  }

  private now(): number {
    const now = Date.parse(this.deps.now());
    this.advance(now);
    return now;
  }

  private advance(now: number): void {
    if (now < this.nowMs) return;
    this.nowMs = now;
    for (const l of this.listings.values()) {
      if (l.pendingPrice && l.pendingPrice.at <= now) { l.priceMinor = l.pendingPrice.minor; l.pendingPrice = null; this.priceChanged(l.marketplace, l.asin, now); }
      if (l.pendingQuantity && l.pendingQuantity.at <= now) { l.quantity = l.pendingQuantity.value; l.pendingQuantity = null; }
    }
    for (const c of this.competitors) {
      while (c.schedule?.[c.index] && this.startMs + c.schedule[c.index]!.atOffsetMs <= now) {
        c.priceMinor = c.schedule[c.index]!.priceMinor;
        c.index += 1;
        this.priceChanged(c.marketplace, c.asin, this.startMs + c.schedule[c.index - 1]!.atOffsetMs);
      }
    }
  }

  private priceChanged(marketplace: string, asin: string, at: number): void {
    const { delayMs, lossShare } = this.params.anyOfferChanged;
    if (this.rng.chance(lossShare)) { this.stats.eventsLost += 1; return; }
    this.events.push({ dueMs: at + delayMs, marketplace, asin });
  }

  private async verified(ctx: AdapterCallContext): Promise<ChannelError | null> {
    const v = await this.deps.accounts.verify(ctx.tenantId, ctx.channelAccountId);
    if (!v.ok) return error(v.reason === 'TENANT_MISMATCH' ? 'TENANT_MISMATCH' : 'PRECONDITION_FAILED', `account ${v.reason}`, { scope: 'ACCOUNT', raiseAlert: v.reason === 'TENANT_MISMATCH' });
    return null;
  }

  private skuOf(write: { writeScope: { identity: { externalSku?: string; externalUnitId?: string } } }): string {
    return write.writeScope.identity.externalSku ?? write.writeScope.identity.externalUnitId ?? '';
  }

  async planDispatch(_ctx: AdapterCallContext, writes: readonly FieldWrite[]): Promise<DispatchPlan> {
    const plan: DispatchPlan = { batches: [], rejected: [] };
    for (const w of writes) {
      if (isNeverWritten('AMAZON', w.value.field)) {
        // Р-111: minimum_seller_allowed_price не пишется никогда — отказ без обращения к каналу
        plan.rejected.push({ channelWriteId: w.channelWriteId, error: error('UNSUPPORTED', 'minimum_seller_allowed_price is never written (Р-111)') });
        continue;
      }
      plan.batches.push({ batchId: `amz:${w.channelWriteId}`, operation: 'patchListingsItem', items: [w], budgetCharges: [], requestCount: 1 });
    }
    return plan;
  }

  async dispatch(ctx: AdapterCallContext, batch: DispatchBatch): Promise<DispatchResult> {
    const denied = await this.verified(ctx);
    const outcomes: WriteOutcome[] = [];
    for (const w of batch.items) {
      if (denied) { outcomes.push({ channelWriteId: w.channelWriteId, status: 'REJECTED', error: denied }); continue; }
      const now = this.now();
      this.stats.patchCalls += 1;
      const seller = this.seller.take(now);
      const app = seller.ok ? this.application.take(now) : seller;
      if (!seller.ok || !app.ok) {
        this.stats.patchRateLimited += 1;
        const retryAtMs = !seller.ok ? seller.retryAtMs : (app as { retryAtMs: number }).retryAtMs;
        outcomes.push({ channelWriteId: w.channelWriteId, status: 'REJECTED', error: error('RATE_LIMITED', 'patchListingsItem throttled', { scope: 'BATCH', retryAt: new Date(retryAtMs).toISOString() }) });
        continue;
      }
      const marketplace = w.writeScope.identity.marketplace ?? AMAZON_DE;
      const target = this.listings.get(`${marketplace}|${this.skuOf(w)}`);
      if (!target) { outcomes.push({ channelWriteId: w.channelWriteId, status: 'REJECTED', error: error('NOT_FOUND', 'listing not found') }); continue; }
      const limit = this.params.skuEditLimit;
      if (limit) {
        target.edits = target.edits.filter((t) => now - t < limit.windowMs);
        if (target.edits.length >= limit.maxEdits) {
          this.stats.editLimited += 1;
          outcomes.push({ channelWriteId: w.channelWriteId, status: 'REJECTED', error: error('ACTION_NOT_ALLOWED', 'SKU edit limit (A-04, simulated)', { class: 'REQUIRES_HUMAN' }) });
          continue;
        }
        target.edits.push(now);
      }
      const neverApplies = this.rng.chance(this.params.acceptedNotAppliedShare);
      if (neverApplies) this.stats.acceptedNeverApplied += 1;
      const at = now + this.params.applyDelayMs;
      if (!neverApplies && w.value.field === 'PRICE') target.pendingPrice = { minor: w.value.price.amountMinor, at };
      if (!neverApplies && w.value.field === 'QUANTITY') {
        // A-01: остаток MFN — одно значение на регион (все витрины SKU) или на витрину
        const affected = this.params.quantityScope === 'REGION' ? [...this.listings.values()].filter((l) => l.sku === target.sku) : [target];
        for (const l of affected) l.pendingQuantity = { value: w.value.quantity, at };
      }
      outcomes.push({ channelWriteId: w.channelWriteId, status: 'ACCEPTED', appliedImmediately: false, submissionRef: `sim-submission-${w.channelWriteId}` });
    }
    return { batchId: batch.batchId, outcomes, attemptsMade: batch.items.length };
  }

  async readBack(ctx: AdapterCallContext, requests: readonly ReadBackRequest[]): Promise<ReadBackResult> {
    const denied = await this.verified(ctx);
    const result: ReadBackResult = { observations: [], failures: [] };
    for (const r of requests) {
      if (denied) { result.failures.push({ writeScopeId: r.writeScope.writeScopeId, error: denied }); continue; }
      const now = this.now();
      this.stats.readCalls += 1;
      const taken = this.read.take(now);
      if (!taken.ok) {
        this.stats.readRateLimited += 1;
        result.failures.push({ writeScopeId: r.writeScope.writeScopeId, error: error('RATE_LIMITED', 'getListingsItem throttled', { retryAt: new Date(taken.retryAtMs).toISOString() }) });
        continue;
      }
      const marketplace = r.writeScope.identity.marketplace ?? AMAZON_DE;
      const l = this.listings.get(`${marketplace}|${this.skuOf(r)}`);
      if (!l) { result.failures.push({ writeScopeId: r.writeScope.writeScopeId, error: error('NOT_FOUND', 'listing not found') }); continue; }
      const observedAt = new Date(now).toISOString();
      const identity = { marketplace, externalSku: l.sku, channelProductRef: l.asin };
      if (r.fields.includes('PRICE')) result.observations.push({ identity, field: 'PRICE', value: { field: 'PRICE', price: { amountMinor: l.priceMinor, currency: 'EUR', basis: 'GROSS' } }, observedAt, source: 'READBACK' });
      if (r.fields.includes('QUANTITY')) result.observations.push({ identity, field: 'QUANTITY', value: { field: 'QUANTITY', quantity: l.quantity }, observedAt, source: 'READBACK' });
    }
    return result;
  }

  async confirm(ctx: AdapterCallContext, requests: readonly ConfirmationRequest[]): Promise<ConfirmationResult[]> {
    const out: ConfirmationResult[] = [];
    // Окно подтверждения адаптера — предположение модели: срок применения Amazon не документирован (A-06)
    const windowMs = 30 * 60_000;
    for (const r of requests) {
      const read = await this.readBack(ctx, [{ writeScope: r.writeScope, fields: [r.expected.field] }]);
      const obs: IdentifiedObservation | undefined = read.observations[0];
      if (!obs) { out.push({ channelWriteId: r.channelWriteId, status: 'UNKNOWN', error: read.failures[0]?.error ?? error('UNKNOWN', 'no observation') }); continue; }
      const matches = r.expected.field === 'PRICE' && obs.value.field === 'PRICE' ? obs.value.price.amountMinor === r.expected.price.amountMinor
        : r.expected.field === 'QUANTITY' && obs.value.field === 'QUANTITY' ? obs.value.quantity === r.expected.quantity : false;
      if (matches) out.push({ channelWriteId: r.channelWriteId, status: 'APPLIED', observation: obs });
      else if (Date.parse(this.deps.now()) - Date.parse(r.dispatchedAt) < windowMs) out.push({ channelWriteId: r.channelWriteId, status: 'PENDING', checkAfter: new Date(Date.parse(this.deps.now()) + 60_000).toISOString() });
      else out.push({ channelWriteId: r.channelWriteId, status: 'NOT_APPLIED', observation: obs });
    }
    return out;
  }

  private snapshotOf(marketplace: string, asin: string, observedAt: number): CompetitorSnapshot {
    const offers = [
      ...[...this.listings.values()].filter((l) => l.marketplace === marketplace && l.asin === asin).map((l) => ({ isSelf: true, sellerRef: 'self', minor: l.priceMinor })),
      ...this.competitors.filter((c) => c.marketplace === marketplace && c.asin === asin).map((c) => ({ isSelf: false, sellerRef: c.sellerRef, minor: c.priceMinor })),
    ].sort((a, b) => a.minor - b.minor);
    const money = (minor: number) => ({ amountMinor: minor, currency: 'EUR', basis: 'GROSS' as const });
    return {
      marketplace, channelProductRef: asin, condition: 'new', source: AMAZON_SIM_SOURCE, sourceEventId: `sim-aoc-${asin}-${observedAt}`,
      observedAt: new Date(observedAt).toISOString(),
      // Полнота ANY_OFFER_CHANGED — (проверить) по схеме уведомления; модель отдаёт топ-20
      completeness: { kind: 'TOP_N', n: 20 },
      ...(offers[0] ? { buybox: { price: money(offers[0].minor), isSelf: offers[0].isSelf } } : {}),
      offers: offers.map((o, i) => ({ rank: i + 1, isSelf: o.isSelf, sellerRef: o.sellerRef, price: money(o.minor), shipping: money(0), totalPrice: money(o.minor) })),
    };
  }

  /** ANY_OFFER_CHANGED с задержкой A-08: снимки, срок доставки которых наступил */
  drainSnapshots(): CompetitorSnapshot[] {
    const now = this.now();
    const due = this.events.filter((e) => e.dueMs <= now);
    this.events.splice(0, this.events.length, ...this.events.filter((e) => e.dueMs > now));
    this.stats.eventsDelivered += due.length;
    return due.map((e) => this.snapshotOf(e.marketplace, e.asin, e.dueMs));
  }

  async readCompetitors(ctx: AdapterCallContext, queries: readonly CompetitorQuery[]): Promise<CompetitorReadResult> {
    const denied = await this.verified(ctx);
    const result: CompetitorReadResult = { snapshots: [], failures: [] };
    for (const q of queries) {
      if (denied) { result.failures.push({ query: q, error: denied }); continue; }
      const now = this.now();
      this.stats.summaryCalls += 1;
      const taken = this.summary.take(now);
      if (!taken.ok) {
        this.stats.summaryRateLimited += 1;
        result.failures.push({ query: q, error: error('RATE_LIMITED', 'getCompetitiveSummary 0.033 rps', { retryAt: new Date(taken.retryAtMs).toISOString() }) });
        continue;
      }
      result.snapshots.push(this.snapshotOf(q.marketplace, q.channelProductRef, now));
    }
    return result;
  }

  async discoverOffers(): Promise<Page<DiscoveredOffer>> { return { items: [] }; }
  async readOrderLines(): Promise<Page<OrderLine>> { return { items: [] }; }
  async handleInbound(_delivery: InboundDelivery): Promise<InboundResult> {
    return { kind: 'REJECTED', error: error('UNSUPPORTED', 'Amazon notifications are not modelled over HTTP; use drainSnapshots', { scope: 'BATCH' }), responseStatus: 400 };
  }

  /** Состояние для проверок */
  listing(marketplace: string, sku: string): { priceMinor: number; quantity: number; pendingPriceMinor: number | null } | null {
    this.now();
    const l = this.listings.get(`${marketplace}|${sku}`);
    return l ? { priceMinor: l.priceMinor, quantity: l.quantity, pendingPriceMinor: l.pendingPrice?.minor ?? null } : null;
  }
}
