import type {
  AdapterCallContext,
  ChannelAdapter,
  CompetitorQuery,
  CompetitorReadResult,
  CompetitorSnapshot,
  ConfirmationRequest,
  ConfirmationResult,
  DispatchBatch,
  DispatchPlan,
  DispatchResult,
  FieldWrite,
  ReadBackRequest,
  ReadBackResult,
} from '@repracer/channel-port';
import { assertBacktestWindow, type HistoryWindow } from '@repracer/analytics-export';
import { createPricingPipeline, InMemoryPricingStore, type MemorySeedScope, type SnapshotReport } from '@repracer/pricing-pipeline';
import { DANGEROUS_DEVIATION_BP, marginBpAtPrice, type CostInputs } from '@repracer/pricing-model';
import { KAUFLAND_DESCRIPTOR } from '@repracer/kaufland-adapter';

/**
 * Бэктест стратегии на записанной истории [Р-38, Р-113]: каждый снимок истории проходит настоящий путь решения (проверка входов,
 * стратегия, Price Gate, запись) в хранилище в памяти. Канал — мгновенный: записанная цена сразу становится нашей ценой в следующем
 * снимке. Снимок контрфактический: предложения конкурентов — как в истории, наше предложение — с ценой, которую поставил бы бэктест,
 * ранги и Buy Box пересчитаны упрощённым правилом.
 *
 * Где бэктест врёт — список LIES и калибровка правила Buy Box по истории (сколько раз правило не совпало с записанным победителем при
 * исторической цене). Данные синтетические; объединения тенантов нет — один прогон, один тенант.
 */

export const LIES: readonly string[] = [
  'Конкуренты не отвечают на нашу цену: история записана при другой нашей цене, реакция репрайсеров конкурентов не моделируется.',
  'Buy Box — упрощённое правило: минимальная цена с доставкой, при равенстве выигрывает конкурент. Площадки учитывают срок доставки, рейтинг, остаток; расхождение правила с записанным победителем — калибровка отчёта.',
  'Спроса нет: маржа — на единицу при нашей цене, взвешенная по времени; «прибыль» — только при явном допущении числа продаж в час владения Buy Box.',
  'Между снимками рынок считается неизменным; запись применяется мгновенно, без лимитов и задержек канала (их даёт симулятор, не бэктест).',
  'Себестоимость, комиссия, НДС и границы — текущие на весь период: история себестоимости и границ в системе не хранится для бэктеста.',
  'Проверка входов начинает период без 30-дневной истории цен (холодный старт) и копит её из тех же снимков.',
];

export interface BacktestInput {
  tenantId: string;
  channelAccountId: string;
  /** Единицы записи с текущими стратегией, границами и себестоимостью (cost обязателен — иначе маржу не посчитать) */
  scopes: MemorySeedScope[];
  /**
   * Снимки истории. Массив сортируется; поток (генератор) обязан идти по времени — иначе ошибка (шаг 24: история каталога за 18 месяцев
   * не держится в памяти целиком)
   */
  history: CompetitorSnapshot[] | Iterable<CompetitorSnapshot>;
  window: HistoryWindow;
  now: string;
  /** Допущение спроса: продаж в час, пока наше предложение выигрывает Buy Box. Без него прибыль не считается */
  demand?: { unitsPerBuyBoxHour: number };
  /** Как часто проверять системные остановки [Р-52] по часам истории */
  haltReviewEveryMs?: number;
}

export interface ScopeMetrics {
  writeScopeId: string;
  currency: string;
  hours: number;
  /** Доля времени владения Buy Box по упрощённому правилу, б. п. */
  buyBoxShareBp: number;
  /** Средняя маржа, взвешенная по времени, б. п.; null — себестоимости нет */
  avgMarginBp: number | null;
  minMarginBp: number | null;
  priceChanges: number;
  gateRejected: number;
  /** Р-73: отклонённые Gate с отклонением от границы > 10 % */
  dangerousStopped: number;
  sanityRejected: number;
  finalPriceMinor: number | null;
  /** Самая низкая цена, ушедшая в канал за период (граница min_price должна её держать) */
  lowestWrittenMinor: number | null;
  estimatedUnits: number | null;
  estimatedProfitMinor: number | null;
}

export interface BacktestReport {
  window: HistoryWindow;
  snapshots: number;
  /** Системные остановки витрины [Р-51], поднятые проверкой входов за период */
  halts: number;
  strategy: MetricsBundle;
  /** Историческая цена продавца на том же рынке и по тому же правилу Buy Box */
  baseline: MetricsBundle;
  /** Калибровка правила Buy Box: доля снимков, где правило при исторической цене не совпало с записанным победителем, б. п. */
  buyBoxRuleMismatchBp: number;
  lies: readonly string[];
  elapsedMs: number;
}

export interface MetricsBundle { perScope: ScopeMetrics[] }

interface Accumulator { ms: number; winMs: number; marginMsBp: number; marginKnownMs: number; minMarginBp: number | null; profitMinor: number; units: number }

const emptyAcc = (): Accumulator => ({ ms: 0, winMs: 0, marginMsBp: 0, marginKnownMs: 0, minMarginBp: null, profitMinor: 0, units: 0 });

function profitPerUnitMinor(cost: CostInputs, priceMinor: number): number | null {
  const marginBp = marginBpAtPrice(cost, priceMinor);
  if (marginBp === null) return null;
  const vat = cost.tax.regime === 'VAT_INCLUDED' ? (cost.tax.vatRateBp ?? 0) : 0;
  const net = (priceMinor * 10_000) / (10_000 + vat);
  return Math.round((net * marginBp) / 10_000);
}

function productKey(s: { marketplace: string; channelProductRef: string; condition: string }): string {
  return `${s.marketplace}|${s.channelProductRef}|${s.condition}`;
}

/** Контрфактический снимок: конкуренты из истории, наша цена — из бэктеста; ранги и Buy Box по упрощённому правилу */
export function counterfactual(recorded: CompetitorSnapshot, selfPriceMinor: number | null): CompetitorSnapshot {
  const competitors = recorded.offers.filter((o) => !o.isSelf);
  const self = recorded.offers.find((o) => o.isSelf);
  const offers = [...competitors];
  if (self && selfPriceMinor !== null) {
    const price = { ...self.price, amountMinor: selfPriceMinor };
    offers.push({ ...self, price, totalPrice: { ...price, amountMinor: selfPriceMinor + (self.shipping?.amountMinor ?? 0) } });
  }
  const total = (o: (typeof offers)[number]) => o.totalPrice?.amountMinor ?? o.price.amountMinor;
  offers.sort((a, b) => total(a) - total(b) || Number(a.isSelf) - Number(b.isSelf));
  const ranked = offers.map((o, i) => ({ ...o, rank: i + 1 }));
  const { buybox: _recordedBuybox, ...rest } = recorded;
  return { ...rest, ...(ranked[0] ? { buybox: { price: ranked[0].price, isSelf: ranked[0].isSelf } } : {}), offers: ranked };
}

/**
 * Упрощённое правило Buy Box — то же, что counterfactual: сравниваются цены с доставкой, при равенстве выигрывает конкурент.
 * Находка 2 ревью шага 21: наша цена сравнивалась без нашей доставки, а цены конкурентов — с доставкой.
 */
export function wins(recorded: CompetitorSnapshot, selfPriceMinor: number): boolean {
  const best = Math.min(...recorded.offers.filter((o) => !o.isSelf).map((o) => o.totalPrice?.amountMinor ?? o.price.amountMinor));
  const selfShipping = recorded.offers.find((o) => o.isSelf)?.shipping?.amountMinor ?? 0;
  return selfPriceMinor + selfShipping < best;
}

/** Канал бэктеста: запись применяется сразу; конкуренты для проверки остановок — последний контрфактический снимок */
class InstantChannel implements ChannelAdapter {
  readonly descriptor = KAUFLAND_DESCRIPTOR;
  readonly prices = new Map<string, number>();
  /** Применённые записи цены по единице — «изменений» отчёта; канал бэктеста применяет каждую отправленную запись */
  readonly applied = new Map<string, number>();
  readonly lowest = new Map<string, number>();
  readonly latest = new Map<string, CompetitorSnapshot>();

  async planDispatch(_ctx: AdapterCallContext, writes: readonly FieldWrite[]): Promise<DispatchPlan> {
    return { batches: writes.map((w) => ({ batchId: `bt:${w.channelWriteId}`, operation: 'backtest', items: [w], budgetCharges: [], requestCount: 1 })), rejected: [] };
  }

  async dispatch(_ctx: AdapterCallContext, batch: DispatchBatch): Promise<DispatchResult> {
    for (const w of batch.items) {
      if (w.value.field !== 'PRICE') continue;
      const id = w.writeScope.writeScopeId;
      this.prices.set(id, w.value.price.amountMinor);
      this.applied.set(id, (this.applied.get(id) ?? 0) + 1);
      this.lowest.set(id, Math.min(this.lowest.get(id) ?? Number.POSITIVE_INFINITY, w.value.price.amountMinor));
    }
    return { batchId: batch.batchId, outcomes: batch.items.map((w) => ({ channelWriteId: w.channelWriteId, status: 'ACCEPTED', appliedImmediately: true })), attemptsMade: 1 };
  }

  async readBack(_ctx: AdapterCallContext, requests: readonly ReadBackRequest[]): Promise<ReadBackResult> {
    return { observations: [], failures: requests.map((r) => ({ writeScopeId: r.writeScope.writeScopeId, error: { class: 'TRANSIENT', code: 'UNKNOWN', scope: 'ITEM', message: 'backtest has no read-back', raiseAlert: false } })) };
  }

  async confirm(_ctx: AdapterCallContext, requests: readonly ConfirmationRequest[]): Promise<ConfirmationResult[]> {
    return requests.map((r) => ({ channelWriteId: r.channelWriteId, status: 'UNKNOWN', error: { class: 'TRANSIENT', code: 'UNKNOWN', scope: 'ITEM', message: 'backtest', raiseAlert: false } }));
  }

  async readCompetitors(_ctx: AdapterCallContext, queries: readonly CompetitorQuery[]): Promise<CompetitorReadResult> {
    const snapshots = queries.map((q) => this.latest.get(productKey(q))).filter((s): s is CompetitorSnapshot => s !== undefined);
    return { snapshots, failures: [] };
  }

  async discoverOffers() { return { items: [] }; }
  async readOrderLines() { return { items: [] }; }
  async handleInbound(): Promise<never> { throw new Error('backtest has no inbound deliveries'); }
}

export async function runBacktest(input: BacktestInput): Promise<BacktestReport> {
  const started = Date.now();
  assertBacktestWindow(input.window, input.now);
  const from = Date.parse(input.window.from);
  const to = Date.parse(input.window.to);
  const history: Iterable<CompetitorSnapshot> = Array.isArray(input.history)
    ? [...input.history].sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt))
    : input.history;
  let snapshots = 0;
  let previousAt = Number.NEGATIVE_INFINITY;
  // Шаг 24 (OQ-161): удаление по сроку каждые 6 часов истории — хранилище держит последние 2 суток. Путь решения старые решения и intent
  // не читает; окно сдвига — 15 минут, лимит изменений — час, история цен конкурентов для якоря хранится отдельно и не удаляется
  const PRUNE_EVERY_MS = 6 * 3_600_000;
  const KEEP_MS = 2 * 86_400_000;
  let nextPrune = from + PRUNE_EVERY_MS;

  let nowMs = from;
  const store = new InMemoryPricingStore({ scopes: input.scopes }, { tenantId: input.tenantId });
  const channel = new InstantChannel();
  for (const s of input.scopes) if (s.currentPriceMinor !== null) channel.prices.set(s.writeScopeId, s.currentPriceMinor);
  const noop = { raise: async () => {} };
  const pipeline = createPricingPipeline({ store, adapter: channel, alerts: noop, logger: { log: () => {} }, now: () => new Date(nowMs).toISOString() });
  const ctx = (): AdapterCallContext => ({
    tenantId: input.tenantId as AdapterCallContext['tenantId'], channelAccountId: input.channelAccountId as AdapterCallContext['channelAccountId'],
    correlationId: 'backtest', deadline: new Date(nowMs + 60_000).toISOString(),
  });

  const scopesByProduct = new Map<string, MemorySeedScope[]>();
  for (const s of input.scopes) scopesByProduct.set(productKey(s), [...(scopesByProduct.get(productKey(s)) ?? []), s]);
  const strategyAcc = new Map(input.scopes.map((s) => [s.writeScopeId, emptyAcc()]));
  const baselineAcc = new Map(input.scopes.map((s) => [s.writeScopeId, emptyAcc()]));
  const last = new Map<string, { at: number; recorded: CompetitorSnapshot; prices: Map<string, number> }>();
  const counts = new Map(input.scopes.map((s) => [s.writeScopeId, { sanityRejected: 0, gateRejected: 0, dangerousStopped: 0 }]));
  // Итоги решений считаются по отчётам сразу: старые решения удаляются из хранилища по сроку
  const countDecisions = (r: SnapshotReport) => {
    for (const s of r.scopes) {
      const c = counts.get(s.writeScopeId);
      if (!c || s.decision?.decisionClass !== 'REJECTED_BY_GATE') continue;
      c.gateRejected += 1;
      if ((s.decision.boundDeviationBp ?? 0) > DANGEROUS_DEVIATION_BP) c.dangerousStopped += 1;
    }
  };
  let mismatches = 0;
  let calibrated = 0;
  let nextHaltReview = from + (input.haltReviewEveryMs ?? 3_600_000);

  const accumulate = (acc: Accumulator, scope: MemorySeedScope, recorded: CompetitorSnapshot, priceMinor: number, ms: number) => {
    acc.ms += ms;
    const winning = wins(recorded, priceMinor);
    if (winning) acc.winMs += ms;
    if (scope.cost) {
      const m = marginBpAtPrice(scope.cost, priceMinor);
      if (m !== null) {
        acc.marginMsBp += m * ms;
        acc.marginKnownMs += ms;
        acc.minMarginBp = acc.minMarginBp === null ? m : Math.min(acc.minMarginBp, m);
        if (winning && input.demand) {
          const units = (input.demand.unitsPerBuyBoxHour * ms) / 3_600_000;
          acc.units += units;
          acc.profitMinor += units * (profitPerUnitMinor(scope.cost, priceMinor) ?? 0);
        }
      }
    }
  };

  for (const recorded of history) {
    const at = Date.parse(recorded.observedAt);
    if (at < previousAt) throw new Error('backtest history stream must be ordered by observedAt');
    previousAt = at;
    if (at < from || at >= to) continue;
    snapshots += 1;
    const key = productKey(recorded);
    const scopes = scopesByProduct.get(key) ?? [];
    const previous = last.get(key);
    if (previous) {
      for (const scope of scopes) {
        const ms = at - previous.at;
        accumulate(strategyAcc.get(scope.writeScopeId)!, scope, previous.recorded, previous.prices.get(scope.writeScopeId) ?? scope.currentPriceMinor ?? 0, ms);
        const historical = previous.recorded.offers.find((o) => o.isSelf)?.price.amountMinor;
        if (historical !== undefined) accumulate(baselineAcc.get(scope.writeScopeId)!, scope, previous.recorded, historical, ms);
      }
    }
    // Калибровка правила: победитель по правилу при исторической цене против записанного
    const historicalSelf = recorded.offers.find((o) => o.isSelf)?.price.amountMinor;
    if (historicalSelf !== undefined && recorded.buybox) {
      calibrated += 1;
      if (wins(recorded, historicalSelf) !== recorded.buybox.isSelf) mismatches += 1;
    }

    // Снимок чуть позже момента наблюдения — как доставка уведомления
    nowMs = Math.max(nowMs, at + 1_000);
    while (nowMs >= nextHaltReview) {
      for (const review of await pipeline.reviewHalts(ctx(), 5)) for (const r of review.snapshots) countDecisions(r);
      nextHaltReview += input.haltReviewEveryMs ?? 3_600_000;
    }
    if (nowMs >= nextPrune) {
      store.pruneBefore(new Date(nowMs - KEEP_MS).toISOString());
      nextPrune = nowMs + PRUNE_EVERY_MS;
    }
    const selfPrice = scopes[0] ? channel.prices.get(scopes[0].writeScopeId) ?? null : null;
    const cf = counterfactual(recorded, selfPrice);
    channel.latest.set(key, cf);
    const report = await pipeline.processSnapshot(ctx(), cf);
    countDecisions(report);
    if (report.verdict !== 'ACCEPT') for (const scope of scopes) counts.get(scope.writeScopeId)!.sanityRejected += 1;
    // Отклонённый проверкой входов снимок (испорченная цена) не считается рынком интервала: остаётся предыдущий принятый
    const market = report.verdict === 'ACCEPT' || !previous ? recorded : previous.recorded;
    last.set(key, { at, recorded: market, prices: new Map(scopes.map((s) => [s.writeScopeId, channel.prices.get(s.writeScopeId) ?? s.currentPriceMinor ?? 0])) });
  }
  // Последний интервал — до конца окна
  for (const [key, previous] of last) {
    for (const scope of scopesByProduct.get(key) ?? []) {
      accumulate(strategyAcc.get(scope.writeScopeId)!, scope, previous.recorded, previous.prices.get(scope.writeScopeId) ?? 0, to - previous.at);
      const historical = previous.recorded.offers.find((o) => o.isSelf)?.price.amountMinor;
      if (historical !== undefined) accumulate(baselineAcc.get(scope.writeScopeId)!, scope, previous.recorded, historical, to - previous.at);
    }
  }

  const dump = await store.dump();
  const metrics = (acc: Accumulator, scope: MemorySeedScope, strategy: boolean): ScopeMetrics => {
    const c = counts.get(scope.writeScopeId)!;
    return {
      writeScopeId: scope.writeScopeId,
      currency: scope.currency,
      hours: Math.round(acc.ms / 3_600_000),
      buyBoxShareBp: acc.ms > 0 ? Math.round((acc.winMs * 10_000) / acc.ms) : 0,
      avgMarginBp: acc.marginKnownMs > 0 ? Math.round(acc.marginMsBp / acc.marginKnownMs) : null,
      minMarginBp: acc.minMarginBp,
      priceChanges: strategy ? channel.applied.get(scope.writeScopeId) ?? 0 : 0,
      gateRejected: strategy ? c.gateRejected : 0,
      dangerousStopped: strategy ? c.dangerousStopped : 0,
      sanityRejected: strategy ? c.sanityRejected : 0,
      finalPriceMinor: strategy ? channel.prices.get(scope.writeScopeId) ?? null : null,
      lowestWrittenMinor: strategy ? channel.lowest.get(scope.writeScopeId) ?? null : null,
      estimatedUnits: input.demand ? Math.round(acc.units) : null,
      estimatedProfitMinor: input.demand ? Math.round(acc.profitMinor) : null,
    };
  };

  return {
    window: input.window,
    snapshots,
    halts: dump.halts.length,
    strategy: { perScope: input.scopes.map((s) => metrics(strategyAcc.get(s.writeScopeId)!, s, true)) },
    baseline: { perScope: input.scopes.map((s) => metrics(baselineAcc.get(s.writeScopeId)!, s, false)) },
    buyBoxRuleMismatchBp: calibrated > 0 ? Math.round((mismatches * 10_000) / calibrated) : 0,
    lies: LIES,
    elapsedMs: Date.now() - started,
  };
}
