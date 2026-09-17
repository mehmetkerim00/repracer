import type { CompetitorSnapshot } from '@repracer/channel-port';
import type { MemorySeedScope } from '@repracer/pricing-pipeline';
import { LIES, runBacktest, type BacktestInput, type BacktestReport, type ScopeMetrics } from './backtest.ts';

/**
 * Р-125 (шаг 25): бэктест по умолчанию считает ВЫБОРКУ — товары, дающие основную выручку; полный каталог — отдельное фоновое задание
 * по партиям с контрольной точкой. 6,5 часа на стратегию для 10 000 товаров в одном вызове — неработающая функция, а не медленная.
 *
 * Выручка — оценка вызывающего: строки заказов канала, где они есть (ORDER_LINES), иначе допущение «цена × одинаковый спрос»
 * (PRICE_ASSUMPTION) — источник оценки пишется в отчёт. Выборка — товары по убыванию выручки, пока их доля не достигнет revenueShare,
 * но не больше maxProducts и не меньше minProducts.
 */

export type RevenueSource = 'ORDER_LINES' | 'PRICE_ASSUMPTION';

export interface RevenueEstimate { writeScopeId: string; channelProductRef: string; revenueMinor: number }

export interface SampleOptions { revenueShare: number; maxProducts: number; minProducts: number }

export const DEFAULT_SAMPLE: SampleOptions = { revenueShare: 0.8, maxProducts: 200, minProducts: 10 };

export interface BacktestSample {
  writeScopeIds: string[];
  channelProductRefs: string[];
  total: number;
  /** Доля оценённой выручки каталога, которую покрывает выборка, б. п. */
  revenueCoverageBp: number;
  source: RevenueSource;
  /** Выборку ограничил maxProducts раньше, чем набралась доля выручки */
  cappedBeforeShare: boolean;
}

export function selectBacktestSample(revenue: readonly RevenueEstimate[], source: RevenueSource, options: SampleOptions = DEFAULT_SAMPLE): BacktestSample {
  const sorted = [...revenue].sort((a, b) => b.revenueMinor - a.revenueMinor || (a.writeScopeId < b.writeScopeId ? -1 : 1));
  const total = sorted.reduce((s, r) => s + Math.max(0, r.revenueMinor), 0);
  const picked: RevenueEstimate[] = [];
  let covered = 0;
  for (const r of sorted) {
    const reached = total > 0 && covered / total >= options.revenueShare;
    if (picked.length >= options.maxProducts || (reached && picked.length >= options.minProducts)) break;
    picked.push(r);
    covered += Math.max(0, r.revenueMinor);
  }
  return {
    writeScopeIds: picked.map((r) => r.writeScopeId), channelProductRefs: [...new Set(picked.map((r) => r.channelProductRef))], total: sorted.length,
    revenueCoverageBp: total > 0 ? Math.round((covered * 10_000) / total) : 0, source,
    cappedBeforeShare: picked.length >= options.maxProducts && (total === 0 || covered / total < options.revenueShare),
  };
}

export interface CatalogBacktestInput extends Omit<BacktestInput, 'scopes' | 'history'> {
  scopes: MemorySeedScope[];
  /** История потоком по товарам выборки или партии (чтение истории ClickHouse отбирает товары запросом); лишние товары отбрасываются */
  history: (channelProductRefs: ReadonlySet<string>) => Iterable<CompetitorSnapshot>;
}

/** Р-125: бэктест выборки — режим по умолчанию */
export async function runSampleBacktest(input: CatalogBacktestInput, revenue: readonly RevenueEstimate[], source: RevenueSource, options: SampleOptions = DEFAULT_SAMPLE):
  Promise<{ mode: 'SAMPLE'; sample: BacktestSample; report: BacktestReport }> {
  const sample = selectBacktestSample(revenue, source, options);
  const ids = new Set(sample.writeScopeIds);
  const refs = new Set(sample.channelProductRefs);
  const report = await runBacktest({ ...input, scopes: input.scopes.filter((s) => ids.has(s.writeScopeId)), history: only(input.history(refs), refs) });
  return { mode: 'SAMPLE', sample, report };
}

function* only(history: Iterable<CompetitorSnapshot>, refs: ReadonlySet<string>): Generator<CompetitorSnapshot> {
  for (const s of history) if (refs.has(s.channelProductRef)) yield s;
}

/**
 * Р-125: полный каталог — фоновое задание по партиям товаров. Контрольная точка — отчёт каждой завершённой партии: прерванное задание
 * продолжается с первой незавершённой партии, завершённые не пересчитываются. Разбиение по партиям обедняет окно массового сдвига [Р-42]:
 * он оценивается внутри партии, а не всей витрины (ложь бэктеста, в отчёте).
 */
export interface CatalogJobState {
  jobId: string;
  batches: string[][];
  done: Record<number, { perScope: ScopeMetrics[]; baseline: ScopeMetrics[]; snapshots: number; halts: number; elapsedMs: number }>;
}

export interface CatalogJobStore {
  load(jobId: string): Promise<CatalogJobState | null>;
  save(state: CatalogJobState): Promise<void>;
}

export class MemoryCatalogJobStore implements CatalogJobStore {
  readonly states = new Map<string, CatalogJobState>();
  async load(jobId: string) { const s = this.states.get(jobId); return s ? structuredClone(s) : null; }
  async save(state: CatalogJobState) { this.states.set(state.jobId, structuredClone(state)); }
}

export const BATCH_LIE = 'Полный каталог считается партиями товаров: массовый сдвиг [Р-42] оценивается внутри партии, а не по всей витрине — остановка витрины может не сработать там, где сработала бы в работе.';

export async function runCatalogJob(jobId: string, input: CatalogBacktestInput, store: CatalogJobStore, options: { batchProducts: number; maxBatches?: number }):
  Promise<{ mode: 'FULL'; completed: boolean; batchesDone: number; batchesTotal: number; perScope: ScopeMetrics[]; baseline: ScopeMetrics[]; snapshots: number; halts: number; lies: readonly string[] }> {
  let state = await store.load(jobId);
  if (!state) {
    const byProduct = new Map<string, string[]>();
    for (const s of [...input.scopes].sort((a, b) => (a.channelProductRef < b.channelProductRef ? -1 : 1))) {
      byProduct.set(s.channelProductRef, [...(byProduct.get(s.channelProductRef) ?? []), s.writeScopeId]);
    }
    const products = [...byProduct.values()];
    const batches: string[][] = [];
    for (let i = 0; i < products.length; i += options.batchProducts) batches.push(products.slice(i, i + options.batchProducts).flat());
    state = { jobId, batches, done: {} };
    await store.save(state);
  }
  let ran = 0;
  for (let b = 0; b < state.batches.length; b++) {
    if (state.done[b]) continue;
    if (options.maxBatches !== undefined && ran >= options.maxBatches) break;
    const ids = new Set(state.batches[b]);
    const scopes = input.scopes.filter((s) => ids.has(s.writeScopeId));
    const refs = new Set(scopes.map((s) => s.channelProductRef));
    const r = await runBacktest({ ...input, scopes, history: only(input.history(refs), refs) });
    state.done[b] = { perScope: r.strategy.perScope, baseline: r.baseline.perScope, snapshots: r.snapshots, halts: r.halts, elapsedMs: r.elapsedMs };
    await store.save(state);
    ran++;
  }
  const done = Object.values(state.done);
  return {
    mode: 'FULL', completed: done.length === state.batches.length, batchesDone: done.length, batchesTotal: state.batches.length,
    perScope: done.flatMap((d) => d.perScope), baseline: done.flatMap((d) => d.baseline), snapshots: done.reduce((s, d) => s + d.snapshots, 0),
    halts: done.reduce((s, d) => s + d.halts, 0), lies: [...LIES, BATCH_LIE],
  };
}
