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
  PageRequest,
  ReadBackRequest,
  ReadBackResult,
  WriteOutcome,
} from '@repracer/channel-port';
import { AMAZON_DESCRIPTOR } from '@repracer/amazon-adapter';
import { DEFAULT_ERROR_CLASS, isNeverWritten } from '@repracer/channel-port';
import { SEARCH_LISTINGS_ITEMS_CAP } from './amazon-channel.ts';
import { rankForBuyBox, type BuyBoxRuleSpec } from './buybox-rule.ts';
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
/** amazon.com: USD, цена НЕТТО (sales tax при покупке [Р-58]); граница суток не установлена [Р-65, Р-172] */
export const AMAZON_US = 'ATVPDKIKX0DER';
export const AMAZON_SIM_SOURCE = 'AMAZON_ANY_OFFER_CHANGED';

/**
 * Шаг 69 (OQ-249): `title` — название товара, которое адаптер берёт из `itemName` сводки searchListingsItems; по умолчанию синтетическое
 * «Synthetic product <sku>», null — канал названия не отдал
 */
export interface AmazonSkuSpec {
  sku: string; asin: string; marketplaces: string[]; priceMinor: number; quantity: number; title?: string | null;
  /** Шаг 103 [Р-120, Р-228]: у листинга правило автоматического ценообразования Amazon — обнаружение называет его, движок не назначается */
  automatedPricing?: boolean;
  /**
   * Шаг 107 [Р-233]: рамки цены, заданные продавцом на SKU (Min/Max), — синтетические значения в валюте витрины, без доставки; обнаружение
   * называет их со значениями, как будет читать живой адаптер (A-30). Деактивацию листинга вне рамок модель не воспроизводит — в отложенном
   */
  channelBounds?: { minMinor: number | null; maxMinor: number | null };
}
/**
 * Шаг 97 [H]: `channelFulfilled` — предложение исполняет Amazon (FBA), `rating` — SellerFeedbackRating продавца (синтетический),
 * `shippingMinor` — доставка продавца
 */
export interface AmazonCompetitorSpec {
  sellerRef: string; marketplace: string; asin: string; priceMinor: number; schedule?: Array<{ atOffsetMs: number; priceMinor: number }>;
  channelFulfilled?: boolean; shippingMinor?: number; rating?: { positivePct: number; count: number };
}
export interface AmazonPortModelSpec {
  seed: number; params?: Partial<AmazonModelParams>; skus: AmazonSkuSpec[]; competitors: AmazonCompetitorSpec[];
  /** Витрина модели: по умолчанию amazon.de (EUR, брутто), для витрины США — `AMAZON_SIM_DESCRIPTOR_US` */
  descriptor?: ChannelDescriptor;
  /** Шаг 97 [H]: формула победителя Buy Box; без поля — прежнее правило (минимальная цена товара) */
  buyBox?: BuyBoxRuleSpec;
  /** Шаг 97 [H]: наши предложения исполняет Amazon (FBA) */
  selfChannelFulfilled?: boolean;
}

interface Listing { sku: string; asin: string; marketplace: string; title: string | null; automatedPricing: boolean; channelBounds: AmazonSkuSpec['channelBounds'] | null; priceMinor: number; quantity: number; pendingPrice: { minor: number; at: number } | null; pendingQuantity: { value: number; at: number } | null; edits: number[] }

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
  priceHistory: { kind: 'UNAVAILABLE', basis: 'SP-API models snapshot 2026-09-16 has no offer price history operation' },
  // Граница суток amazon.de не подтверждена (A-03, Р-65): значение нужно типу, бюджетов правок модель не ведёт
  marketplaces: [{ code: AMAZON_DE, currency: 'EUR', priceBasis: 'GROSS', timeZone: 'Europe/Berlin' }],
  fields: [],
  rateLimits: [
    { owner: 'SELLER_APPLICATION_OPERATION', operation: 'patchListingsItem', requestsPerSecond: 5, burst: 5, source: 'DOCUMENTED' },
    { owner: 'APPLICATION', operation: 'patchListingsItem', requestsPerSecond: 500, source: 'DOCUMENTED' },
  ],
  capabilities: [],
  // Р-128 (шаг 26): источники конкурентов — как у адаптера Amazon; без них планировщик не ставил сверку по кругу аккаунту модели
  competitorSources: AMAZON_DESCRIPTOR.competitorSources,
};

/**
 * Шаг 42 [Р-172]: витрина США той же модели. Отличается ровно тем, чем отличается настоящая: регион NA, доллары, цена
 * НЕТТО и НЕТ границы суток — `timeZone: null` вместо подставленного значения.
 */
export const AMAZON_SIM_DESCRIPTOR_US: ChannelDescriptor = {
  ...AMAZON_SIM_DESCRIPTOR,
  region: 'NA',
  marketplaces: [{ code: AMAZON_US, currency: 'USD', priceBasis: 'NET', timeZone: null }],
};

export class SimulatedAmazonPort implements ChannelAdapter {
  readonly descriptor: ChannelDescriptor;
  readonly params: AmazonModelParams;
  readonly stats = { patchCalls: 0, patchRateLimited: 0, readCalls: 0, readRateLimited: 0, editLimited: 0, acceptedNeverApplied: 0, summaryCalls: 0, summaryRateLimited: 0, eventsLost: 0, eventsDelivered: 0, discoveryCalls: 0 };
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
  private readonly spec: AmazonPortModelSpec;

  constructor(spec: AmazonPortModelSpec, deps: AdapterDependencies) {
    this.spec = spec;
    // Шаг 42: витрина модели объявляется спецификацией — витрина США отличается регионом, валютой, базой и отсутствием пояса
    this.descriptor = spec.descriptor ?? AMAZON_SIM_DESCRIPTOR;
    this.deps = deps;
    this.params = { ...defaultAmazonParams(), ...structuredClone(spec.params ?? {}) };
    this.startMs = Date.parse(deps.now());
    this.nowMs = this.startMs;
    this.rng = new SeededRandom(spec.seed);
    for (const s of spec.skus) this.addListing(s);
    this.competitors = spec.competitors.map((c) => ({ ...c, index: 0 }));
    const p = this.params.patchRate;
    this.seller = new Bucket(p.seller.ratePerSecond, p.seller.burst, this.startMs);
    const appRate = Math.max(0, p.application.ratePerSecond - this.params.otherSellersLoadRps);
    this.application = new Bucket(appRate, Math.max(1, Math.round(p.application.burst * (appRate / p.application.ratePerSecond))), this.startMs);
    this.read = new Bucket(5, this.params.readBurst, this.startMs);
    this.summary = new Bucket(0.033, 1, this.startMs);
  }

  /** Валюта и база цены витрины модели: одна витрина на дескриптор (amazon.de — EUR брутто, amazon.com — USD нетто) */
  private money(): { currency: string; basis: 'GROSS' | 'NET' } {
    const mk = this.descriptor.marketplaces[0]!;
    return { currency: mk.currency, basis: mk.priceBasis };
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
      // Шаг 42: валюта и база — свойства ВИТРИНЫ модели, а не константа: у amazon.com это доллары и НЕТТО [Р-58]
      if (r.fields.includes('PRICE')) result.observations.push({ identity, field: 'PRICE', value: { field: 'PRICE', price: { amountMinor: l.priceMinor, currency: this.money().currency, basis: this.money().basis } }, observedAt, source: 'READBACK' });
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

  /** Предложения товара на рынке модели (по цене) и победитель Buy Box по правилу мира — общие у уведомления и у сводки */
  private marketOf(marketplace: string, asin: string) {
    const offers = [
      ...[...this.listings.values()].filter((l) => l.marketplace === marketplace && l.asin === asin)
        .map((l) => ({ isSelf: true, sellerRef: 'self', minor: l.priceMinor, shippingMinor: 0, channelFulfilled: this.spec.selfChannelFulfilled === true, rating: undefined as AmazonCompetitorSpec['rating'] })),
      ...this.competitors.filter((c) => c.marketplace === marketplace && c.asin === asin)
        .map((c) => ({ isSelf: false, sellerRef: c.sellerRef, minor: c.priceMinor, shippingMinor: c.shippingMinor ?? 0, channelFulfilled: c.channelFulfilled === true, rating: c.rating })),
    ].sort((a, b) => a.minor - b.minor);
    // Шаг 97 [H]: победитель — по формуле мира (landed минус бонус FBA) или прежнему правилу (минимальная цена товара)
    const order = new Map(this.competitors.map((c, i) => [c.sellerRef, i]));
    const winner = this.spec.buyBox
      ? rankForBuyBox(offers.map((o) => ({ ...o, key: o.isSelf ? '$self' : o.sellerRef, self: o.isSelf, landedMinor: o.minor + o.shippingMinor,
        order: o.isSelf ? Number.MAX_SAFE_INTEGER : order.get(o.sellerRef) ?? Number.MAX_SAFE_INTEGER })), null, this.spec.buyBox)[0]
      : offers[0];
    return { offers, winner };
  }

  private snapshotOf(marketplace: string, asin: string, observedAt: number): CompetitorSnapshot {
    const { offers, winner } = this.marketOf(marketplace, asin);
    const { currency, basis } = this.money();
    const money = (minor: number) => ({ amountMinor: minor, currency, basis });
    return {
      marketplace, channelProductRef: asin, condition: 'new', source: AMAZON_SIM_SOURCE, sourceEventId: `sim-aoc-${asin}-${observedAt}`,
      observedAt: new Date(observedAt).toISOString(),
      // Полнота ANY_OFFER_CHANGED — (проверить) по схеме уведомления; модель отдаёт топ-20
      completeness: { kind: 'TOP_N', n: 20 },
      /**
       * Шаг 97 [Р-221]: как разбор настоящего уведомления — цена и доставка Buy Box (Summary.BuyBoxPrices), держатель НЕ назван (A-29), ранга
       * у предложений нет; исполнение (IsFulfilledByAmazon) и рейтинг (SellerFeedbackRating) — у предложений
       */
      ...(winner ? { buybox: { price: money(winner.minor), shipping: money(winner.shippingMinor), isSelf: null } } : {}),
      offers: offers.map((o) => ({ isSelf: o.isSelf, ...(o.isSelf ? {} : { sellerRef: o.sellerRef }), price: money(o.minor), shipping: money(o.shippingMinor), totalPrice: money(o.minor + o.shippingMinor),
        fulfillment: o.channelFulfilled ? 'AFN' : 'MFN', ...(o.rating ? { rating: o.rating } : {}) })),
    };
  }

  /**
   * Р-128 (шаг 26): getCompetitiveSummary — источник сверки AMAZON_COMPETITIVE_SUMMARY, как адаптер Amazon (listing.ts): без победителя
   * Buy Box, полнота — число предложений, момент — время ответа. Модель отдавала снимок источника уведомлений ANY_OFFER_CHANGED:
   * сверка по кругу сравнивала уведомление с уведомлением
   */
  private summaryOf(marketplace: string, asin: string, observedAt: number): CompetitorSnapshot {
    const pushed = this.snapshotOf(marketplace, asin, observedAt);
    /**
     * Шаг 109 [Р-234]: купон — у части продавцов (по продавцу и товару) 5 % от цены, как акция COUPON сводки (`discountedPrice`). Шаг 109
     * [Р-235]: Buy Box по группам покупателей с долей просмотров (`featuredBuyingOptions`). Как канал делит группы, он не публикует — это
     * допущение модели: группы без Prime и с неизвестным статусом видят победителя по правилу мира, группа Prime — самое дешёвое предложение
     * с исполнением каналом (FBA); у каждого четвёртого товара просмотры делятся без большинства (45 / 40 / 15)
     */
    const offers = pushed.offers.map((o) => {
      const coupon = !o.isSelf && o.sellerRef && hashOf(`${o.sellerRef}|${asin}`) % 3 === 0 ? Math.round(o.price.amountMinor * 0.95) : null;
      return { isSelf: o.isSelf, ...(o.sellerRef ? { sellerRef: o.sellerRef } : {}), price: o.price, shipping: o.shipping, totalPrice: o.totalPrice,
        ...(coupon !== null && coupon > 0 && coupon < o.price.amountMinor ? { couponPrice: { ...o.price, amountMinor: coupon } } : {}) };
    }) as CompetitorSnapshot['offers'];
    const { offers: market, winner } = this.marketOf(marketplace, asin);
    const seg = (o: (typeof market)[number], membership: string, viewSharePct: number) => ({ ...(o.isSelf ? {} : { sellerRef: o.sellerRef }), isSelf: o.isSelf, membership, viewSharePct });
    const h = hashOf(asin);
    const landed = (o: (typeof market)[number]) => o.minor + o.shippingMinor;
    // Победитель правила мира — копия строки рынка: сравнение по продавцу, а не по ссылке
    const same = (a: { isSelf: boolean; sellerRef: string } | undefined, b: { isSelf: boolean; sellerRef: string } | undefined) => !!a && !!b && a.isSelf === b.isSelf && a.sellerRef === b.sellerRef;
    const fba = market.filter((o) => o.channelFulfilled).sort((a, b) => landed(a) - landed(b))[0];
    const others = market.filter((o) => !same(o, winner));
    const second = fba && !same(fba, winner) ? fba : others[0];
    const segments = !winner ? []
      : h % 4 === 3 && second
        ? [seg(winner, 'NON_PRIME', 45), seg(second, 'PRIME', 40), seg(others.find((o) => !same(o, second)) ?? second, 'DEFAULT', 15)]
        : [seg(winner, 'NON_PRIME', 50 + (h % 21)), seg(fba ?? winner, 'PRIME', 40 - (h % 21)), seg(winner, 'DEFAULT', 10)];
    return {
      marketplace, channelProductRef: asin, condition: 'new', source: 'AMAZON_COMPETITIVE_SUMMARY', observedAt: new Date(observedAt).toISOString(),
      completeness: { kind: 'TOP_N', n: Math.max(1, offers.length) }, offers, ...(segments.length > 0 ? { buyboxSegments: segments } : {}),
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
    // Р-128 (шаг 26): getCompetitiveSummary — пакет до 20 товаров одним вызовом, как адаптер Amazon (COMPETITIVE_SUMMARY_PATH): один
    // жетон ограничителя на пакет. Модель брала жетон на каждый товар и отклоняла 19 из 20 — сверка по кругу в модели не работала
    for (let i = 0; i < queries.length; i += 20) {
      const batch = queries.slice(i, i + 20);
      if (denied) { for (const q of batch) result.failures.push({ query: q, error: denied }); continue; }
      const now = this.now();
      this.stats.summaryCalls += 1;
      const taken = this.summary.take(now);
      if (!taken.ok) {
        this.stats.summaryRateLimited += 1;
        for (const q of batch) result.failures.push({ query: q, error: error('RATE_LIMITED', 'getCompetitiveSummary 0.033 rps', { retryAt: new Date(taken.retryAtMs).toISOString() }) });
        continue;
      }
      for (const q of batch) result.snapshots.push(this.summaryOf(q.marketplace, q.channelProductRef, now));
    }
    return result;
  }

  /**
   * Шаг 43 [Р-176]: обнаружение офферов нового аккаунта — `searchListingsItems` по снимку (адаптер, `listing.ts`): SKU продавца
   * страницами, с правилом автоматического ценообразования в атрибутах [Р-120]. Правило — у листинга, заданного `automatedPricing` (шаг 103).
   * Квота поиска в снимке не названа (проверить), поэтому модель её не расходует и не придумывает.
   */
  /**
   * Шаг 103 [Р-228]: у продавца появился новый листинг — сценарий «на аккаунте появились новые предложения». Следующий обход каталога
   * его найдёт; правило умолчания аккаунта решает о нём в той же транзакции, что заводит предложение
   */
  addListing(s: AmazonSkuSpec): void {
    const title = s.title === undefined ? `Synthetic product ${s.sku}` : s.title;
    for (const m of s.marketplaces) {
      this.listings.set(`${m}|${s.sku}`, { sku: s.sku, asin: s.asin, marketplace: m, title, automatedPricing: s.automatedPricing ?? false, channelBounds: s.channelBounds ?? null,
        priceMinor: s.priceMinor, quantity: s.quantity, pendingPrice: null, pendingQuantity: null, edits: [] });
    }
  }

  async discoverOffers(_ctx: AdapterCallContext, page: PageRequest): Promise<Page<DiscoveredOffer>> {
    this.now();
    this.stats.discoveryCalls += 1;
    const all = [...this.listings.values()].sort((a, b) => (a.sku === b.sku ? a.marketplace.localeCompare(b.marketplace) : a.sku.localeCompare(b.sku)));
    const from = page.cursor ? Number(page.cursor) : 0;
    // Шаг 106 (A-31): как searchListingsItems — не больше 1000 на все страницы; прогон, опирающийся на поиск, видит неполноту честно
    const reachable = Math.min(all.length, SEARCH_LISTINGS_ITEMS_CAP);
    const slice = all.slice(from, Math.min(from + Math.max(1, page.limit), reachable));
    const { currency, basis } = this.money();
    const items: DiscoveredOffer[] = slice.map((l) => ({
      identity: { ...(this.descriptor.region ? { region: this.descriptor.region } : {}), marketplace: l.marketplace, externalSku: l.sku, channelProductRef: l.asin },
      gtins: [], condition: 'new', fulfillment: 'MERCHANT', ...(l.title !== null ? { title: l.title } : {}), currentPrice: { amountMinor: l.priceMinor, currency, basis },
      currentQuantity: l.quantity, isLive: true,
      channelPricing: { automatedPricing: l.automatedPricing, channelBounds: l.channelBounds !== null, ...(l.channelBounds ? { boundValues: { ...l.channelBounds, currency } } : {}) },
    }));
    return { items, ...(from + slice.length < reachable ? { nextCursor: String(from + slice.length) } : {}) };
  }
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

/** Шаг 109: детерминированный хеш строки модели — какие продавцы дают купон и как делятся просмотры у товара */
function hashOf(text: string): number {
  let h = 7;
  for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
}
