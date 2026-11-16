import { DANGEROUS_DEVIATION_BP } from '@repracer/pricing-model';
import type { ExportRef } from './export-ref.ts';
import type { InterventionSlice } from '@repracer/pricing-pipeline';
import type { Messages } from './i18n/index.ts';
import { isDangerous } from './trace.ts';
import { describe, type HumanReason } from './explain.ts';
import { gap, scopeById, unitOf, type Gap, type StandWorld, type UnitRef } from './world.ts';
import type { PeriodRange } from './period.ts';

/**
 * Отчёт о работе границ за период.
 *
 * Главное число — Р-117 (шаг 22): сколько раз ПОЛ удержал цену, то есть стратегия хотела уйти ниже min_price или пола маржи и была
 * удержана — поставлена на пол (CAPPED_AT_MIN_PRICE) или оставлена без изменения (TARGET_OUTSIDE_BOUNDS_HOLD с целью ниже пола).
 * Удержание — эпизод подряд идущих оценок одной единицы, а не каждая оценка. «Без него вы продали бы на X дешевле» — сумма по
 * эпизодам (удержанная цена − цель стратегии; удержанная цена — пол или текущая цена, оставленная без изменения) по валютам отдельно [Р-71]. Отклонения Gate в норме равны
 * нулю: стратегия не предлагает цену за границей, её держит сам движок, поэтому считать их главным числом — считать ноль.
 * Цель стратегии выведена из цены конкурента и в вечный слепок не попадает [Р-85]: она есть только в горячем intent (3 дня, Р-28);
 * старше видны только удержания, сдвинувшие цену на пол (решение со слепком), — в счёте без суммы (unknownAmount); удержания без
 * изменения цены старше 3 дней не видны вовсе — пробел экрана, а не ноль.
 *
 * Второй раздел — прежний отчёт [Р-73]: отклонения Gate с отклонением от границы больше 10 %. Между тенантами ничего не
 * суммируется; период ограничен горячим буфером решений (30 дней): старше — нет данных, а не ноль.
 */

export const REPORT_PERIODS_DAYS = [1, 7, 30] as const;
/** Шаг 96: глубже горячего буфера решений [Р-28] окно отчёта не уходит — период отрезается (`PeriodRange.clipped`) */
export const HOT_DECISIONS_DAYS = 30;

export interface DangerousItem {
  at: string;
  unit: UnitRef | null;
  proposed: string;
  bound: string;
  deviation: string;
  reason: HumanReason;
  decisionId: string;
  /** Шаг 104 [Р-229]: сырьё строки — только для выгрузки */
  ref?: ExportRef;
}

/** Р-117: стратегия хотела ниже пола и была удержана */
export interface FloorHoldItem {
  at: string;
  unit: UnitRef | null;
  kind: 'CAPPED' | 'HELD';
  /** Цель стратегии; null — горячий intent уже удалён */
  target: string | null;
  floor: string;
  /** Сколько дешевле ушла бы цена без пола */
  below: string | null;
  reason: HumanReason;
  decisionId: string | null;
  /** Шаг 102 [Р-227]: держал пол распродажи — намеренный убыток; пилюля строки, в счёт «пол удержал» не входит */
  clearance: string | null;
  /** Шаг 104 [Р-229]: сырьё строки — только для выгрузки */
  ref?: ExportRef;
}

export interface FloorHoldsView {
  /** Удержания расчётного пола; удержания пола распродажи — отдельно (`clearanceCount`) */
  count: number;
  clearanceCount: number;
  /** Шаг 144: уникальных SKU продавца среди удержаний (без распродажи) */
  skus: number;
  /** По валютам: сумма наибольших разниц удержаний (удержанная цена − цель) — разница предложенных цен, не прибыль */
  withoutFloor: Array<{ currency: string; amount: string; minor: number }>;
  items: FloorHoldItem[];
}

export interface DangerousReportView {
  worldId: string;
  /** Шаг 96: фраза периода для заголовков («in the last 7 days», «from … to …») */
  phrase: string;
  from: string;
  to: string;
  /** Начало периода отрезано глубиной буфера решений */
  clipped: boolean;
  /** Р-117, шаг 144: «N снижений цены предотвратил пол; $X — сумма разниц предложенных цен» — без удержаний пола распродажи [Р-227] */
  headline: string;
  /** Шаг 144: «не полученная прибыль; несколько событий могут быть одним SKU»; удержаний нет — null */
  floorNote: string | null;
  /** Шаг 145: удержания пола только аккаунтов в тени — выборка денежной плитки экрана тени (переход по клику) */
  floorShadowOnly: boolean;
  /** Шаг 102 [Р-227]: «пол распродажи удержал цену N раз — намеренный убыток, выше не учтён»; удержаний нет — null */
  clearanceHeadline: string | null;
  floorHolds: FloorHoldsView;
  /** Р-73: отклонения Gate больше 10 % за границей — в норме ноль */
  gateHeadline: string;
  count: number;
  /** Сумма расстояний до границы по валютам: сколько цена ушла бы за границу */
  prevented: Array<{ currency: string; amount: string; minor: number }>;
  worst: DangerousItem | null;
  byUnit: Array<{ unit: UnitRef | null; count: number }>;
  byBound: Array<{ code: string; title: string; count: number }>;
  items: DangerousItem[];
  /** Период длиннее горячего буфера решений — отчёт неполон */
  truncated: boolean;
  gaps: Gap[];
}

function boundOf(code: string, params: Record<string, unknown>): number | null {
  const v = code === 'BELOW_MIN_PRICE' ? params.minMinor : code === 'BELOW_MARGIN_FLOOR' ? params.floorMinor : code === 'ABOVE_MAX_PRICE' ? params.maxMinor : null;
  return Number.isSafeInteger(v) ? (v as number) : null;
}


/**
 * Шаг 144 (аудит UX, 1.2–1.3): удержания пола — эпизоды хранилища (`InterventionSlice.floorHolds`), то же определение, что у экрана тени
 * и недельного письма (`platform.floor_hold_episodes`): строка таблицы — одно удержание с наибольшей разницей, итог — та же функция
 * (`floorTotals`). Прежде отчёт склеивал эпизоды сам из горячих намерений (3 суток): старше — «сумма неизвестна», а экран тени
 * считал каждую строку удержания, и одно удержание в тени давало ему двойную сумму
 */
function floorHolds(world: StandWorld, slice: InterventionSlice, m: Messages, refs = false): FloorHoldsView {
  const items = slice.floorHolds.map((e): FloorHoldItem => {
    const scope = scopeById(world, e.writeScopeId);
    const code = e.holdReason?.code ?? null;
    const params = e.holdReason?.params ?? {};
    const boundRaw = code === 'CAPPED_AT_MARGIN_FLOOR' || code === 'CAPPED_AT_CLEARANCE_FLOOR' ? params.floorMinor : params.minMinor;
    const bound = Number.isSafeInteger(boundRaw) ? (boundRaw as number) : null;
    const target = e.keptMinor === null ? null : e.keptMinor - e.belowMinor;
    return {
      at: m.when(e.startedAt), unit: scope ? unitOf(world, scope, m) : null, kind: code === 'TARGET_OUTSIDE_BOUNDS_HOLD' ? 'HELD' : 'CAPPED',
      target: target === null ? null : m.money(target, e.currency), floor: bound === null ? m.ui.common.noValue : m.money(bound, e.currency),
      below: m.money(e.belowMinor, e.currency),
      // Строка до шага 144 без шага причины: удержание и сумма известны, подробности — нет
      reason: e.holdReason ? describe(e.holdReason as Parameters<typeof describe>[0], m) : { ...describe({ code: 'CAPPED_AT_MIN_PRICE', params: {} }, m), text: m.ui.dangerous.floorDetailsGone },
      decisionId: e.decisionId, clearance: e.clearance ? m.ui.products.clearancePill : null,
      ...(refs ? { ref: { at: e.startedAt, currency: e.currency, was: null, wanted: target, set: e.keptMinor, bound, deviationBp: null } } : {}),
    };
  });
  const t = slice.floorTotals;
  return {
    count: t.events,
    skus: t.skus,
    clearanceCount: t.clearanceEvents,
    withoutFloor: t.savings.map((x) => ({ currency: x.currency, minor: x.minor, amount: m.money(x.minor, x.currency) })),
    items,
  };
}

/** Р-154: отчёт строится по срезу вмешательств окна — «без изменения» в него не попадают ещё в базе */
export function dangerousReport(world: StandWorld, slice: InterventionSlice, range: PeriodRange, phrase: string, m: Messages, opts: { refs?: boolean; floorShadowOnly?: boolean } = {}): DangerousReportView {
  const r = m.ui.dangerous;
  const to = Date.parse(range.until);
  const from = Date.parse(range.since);
  const floor = floorHolds(world, slice, m, opts.refs === true);
  const decisions = slice.decisions
    .filter((d) => isDangerous(d) && Date.parse(d.decidedAt) > from && Date.parse(d.decidedAt) <= to)
    .sort((a, b) => (b.boundDeviationBp ?? 0) - (a.boundDeviationBp ?? 0) || Date.parse(b.decidedAt) - Date.parse(a.decidedAt));
  const prevented = new Map<string, number>();
  const units = new Map<string, { unit: UnitRef | null; count: number }>();
  const bounds = new Map<string, number>();
  const items = decisions.map((d): DangerousItem => {
    const code = d.rejectionReason ?? d.reason.code;
    const bound = boundOf(code, d.reason.params);
    if (bound !== null) prevented.set(d.currency, (prevented.get(d.currency) ?? 0) + Math.abs(d.proposedMinor - bound));
    const scope = scopeById(world, d.writeScopeId);
    const unit = scope ? unitOf(world, scope, m) : null;
    const u = units.get(d.writeScopeId) ?? { unit, count: 0 };
    u.count += 1;
    units.set(d.writeScopeId, u);
    bounds.set(code, (bounds.get(code) ?? 0) + 1);
    return {
      at: m.when(d.decidedAt), unit, proposed: m.money(d.proposedMinor, d.currency), bound: m.money(bound, d.currency),
      deviation: m.percentBp(d.boundDeviationBp), reason: describe(d.reason, m), decisionId: d.decisionId,
      ...(opts.refs ? { ref: { at: d.decidedAt, currency: d.currency, was: null, wanted: d.proposedMinor, set: null, bound, deviationBp: d.boundDeviationBp } } : {}),
    };
  });
  return {
    worldId: world.id, phrase, from: m.when(range.since), to: m.when(range.until), clipped: range.clipped,
    headline: r.floorHeadline(floor.count, phrase, floor.withoutFloor.map((x) => x.amount)), floorNote: floor.count > 0 ? r.floorNote : null, floorHolds: floor,
    floorShadowOnly: opts.floorShadowOnly === true,
    clearanceHeadline: floor.clearanceCount > 0 ? r.clearanceHeld(floor.clearanceCount, phrase) : null,
    gateHeadline: r.headline(items.length, phrase), count: items.length,
    prevented: [...prevented].map(([currency, minor]) => ({ currency, minor, amount: m.money(minor, currency) })),
    worst: items[0] ?? null,
    byUnit: [...units.values()].sort((a, b) => b.count - a.count),
    byBound: [...bounds].map(([code, count]) => ({ code, title: (m.titles as Record<string, string | undefined>)[code] ?? code, count })),
    // `truncated` был про глубину буфера решений; теперь ещё и про предел среза — обе причины неполноты названы
    items, truncated: slice.truncated,
    gaps: [gap(m, 'DANGEROUS_REPORT_WINDOW'), gap(m, 'DANGEROUS_THRESHOLD'), ...(slice.truncated ? [gap(m, 'INTERVENTIONS_TRUNCATED')] : [])],
  };
}

export { DANGEROUS_DEVIATION_BP };
