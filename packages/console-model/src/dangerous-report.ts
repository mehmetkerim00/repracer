import { DANGEROUS_DEVIATION_BP } from '@repracer/pricing-model';
import type { InterventionSlice } from '@repracer/pricing-pipeline';
import type { Messages } from './i18n/index.ts';
import { explanationOf, isDangerous } from './trace.ts';
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
}

export interface FloorHoldsView {
  /** Удержания расчётного пола; удержания пола распродажи — отдельно (`clearanceCount`) */
  count: number;
  clearanceCount: number;
  /** По валютам: сумма (удержанная цена − цель) удержаний с известной целью */
  withoutFloor: Array<{ currency: string; amount: string; minor: number }>;
  /** Удержания без суммы: цель старше горячего буфера intent */
  unknownAmount: number;
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
  /** Р-117: «пол удержал цену N раз, без него вы продали бы на X дешевле» — без удержаний пола распродажи [Р-227] */
  headline: string;
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

const inPeriod = (at: string, from: number, to: number) => Date.parse(at) > from && Date.parse(at) <= to;

function floorHolds(world: StandWorld, slice: InterventionSlice, from: number, to: number, m: Messages): FloorHoldsView {
  const below = new Map<string, number>();
  const items: Array<FloorHoldItem & { sortAt: string }> = [];
  const seenIntents = new Set<string>();
  let clearanceCount = 0;
  const push = (at: string, writeScopeId: string, kind: 'CAPPED' | 'HELD', target: number | null, floor: number, kept: number, currency: string, reason: Parameters<typeof describe>[0], decisionId: string | null, clearance = false) => {
    const scope = scopeById(world, writeScopeId);
    // Шаг 102 [Р-227]: пол распродажи держит намеренный убыток — не то, от чего пол «спас»; считается отдельно
    if (clearance) clearanceCount += 1;
    else if (target !== null) below.set(currency, (below.get(currency) ?? 0) + (kept - target));
    items.push({
      sortAt: at, at: m.when(at), unit: scope ? unitOf(world, scope, m) : null, kind, target: target === null ? null : m.money(target, currency), floor: m.money(floor, currency),
      below: target === null ? null : m.money(kept - target, currency), reason: describe(reason, m), decisionId, clearance: clearance ? m.ui.products.clearancePill : null,
    });
  };
  // Горячие intent (3 дня): цель стратегии известна. Удержание — эпизод: подряд идущие оценки одной единицы, в которых пол держит
  // цену, — одно удержание; сумма эпизода — наибольшая за эпизод (ревью шага 22, находка 4: цена на полу давала удержание на каждой
  // оценке, и сумма росла с их числом)
  const byScope = new Map<string, InterventionSlice['intents']>();
  const decisionsByIntent = new Map(slice.decisions.map((d) => [d.intentId, d]));
  for (const i of slice.intents) {
    if (!inPeriod(i.createdAt, from, to)) continue;
    byScope.set(i.writeScopeId, [...(byScope.get(i.writeScopeId) ?? []), i]);
  }
  for (const intents of byScope.values()) {
    intents.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    type Episode = { at: string; writeScopeId: string; kind: 'CAPPED' | 'HELD'; target: number; floor: number; kept: number; currency: string; reason: Parameters<typeof describe>[0]; decisionId: string | null; clearance: boolean };
    let episode = null as Episode | null;
    const close = () => {
      const e = episode as Episode | null;
      if (e) push(e.at, e.writeScopeId, e.kind, e.target, e.floor, e.kept, e.currency, e.reason, e.decisionId, e.clearance);
      episode = null;
    };
    for (const i of intents) {
      seenIntents.add(i.intentId);
      // Р-154: оценка без удержания между двумя удержаниями в срез не входит, но закрывает эпизод — это говорит флаг из базы
      if (i.episodeStart) close();
      // Р-207: пол — min_price или пол маржи; у удержания полом маржи граница — floorMinor
      const capped = i.explanation.find((x) => x.code === 'CAPPED_AT_MIN_PRICE' || x.code === 'CAPPED_AT_MARGIN_FLOOR' || x.code === 'CAPPED_AT_CLEARANCE_FLOOR');
      const held = i.reason.code === 'TARGET_OUTSIDE_BOUNDS_HOLD' ? i.reason : null;
      const hit = capped ?? held;
      const target = Number(hit?.params.targetMinor);
      const floor = Number(hit?.code === 'CAPPED_AT_MARGIN_FLOOR' || hit?.code === 'CAPPED_AT_CLEARANCE_FLOOR' ? hit.params.floorMinor : hit?.params.minMinor);
      const clearance = i.explanation.some((x) => x.code === 'CLEARANCE_FLOOR');
      // Удержание у потолка — не работа пола
      if (!hit || !Number.isSafeInteger(target) || !Number.isSafeInteger(floor) || target >= floor) { close(); continue; }
      // kept — цена, которую удержал пол: сам пол (поставлена на пол) или текущая цена (оставлена без изменения)
      const kept = capped ? floor : Math.max(floor, i.currentMinor ?? floor);
      const decision = decisionsByIntent.get(i.intentId) ?? null;
      if (!episode) {
        episode = { at: i.createdAt, writeScopeId: i.writeScopeId, kind: capped ? 'CAPPED' : 'HELD', target, floor, kept, currency: i.currency, reason: hit, decisionId: decision?.decisionId ?? null, clearance };
      } else if (kept - target > (episode as Episode).kept - (episode as Episode).target) {
        episode = { ...(episode as Episode), target, floor, kept, reason: hit, kind: capped ? 'CAPPED' : 'HELD', decisionId: decision?.decisionId ?? (episode as Episode).decisionId, clearance };
      }
    }
    close();
  }
  // Решения старше горячего intent (до 30 дней): видны только удержания, которые сдвинули цену на пол (CHANGED с шагом слепка),
  // без цели [Р-85]. Удержания без изменения цены (NO_OP) решения не создают и после 3 дней не видны вовсе (ревью шага 22, находка 7)
  for (const d of slice.decisions) {
    if (seenIntents.has(d.intentId) || !inPeriod(d.decidedAt, from, to)) continue;
    const steps = explanationOf(world, d)?.value.strategy.steps ?? [];
    const step = steps.find((x) => x.code === 'CAPPED_AT_MIN_PRICE' || x.code === 'CAPPED_AT_MARGIN_FLOOR' || x.code === 'CAPPED_AT_CLEARANCE_FLOOR');
    const bound = step?.code === 'CAPPED_AT_MARGIN_FLOOR' || step?.code === 'CAPPED_AT_CLEARANCE_FLOOR' ? step.params.floorMinor : step?.params.minMinor;
    if (!step || !Number.isSafeInteger(bound)) continue;
    push(d.decidedAt, d.writeScopeId, 'CAPPED', null, bound as number, bound as number, d.currency, step, d.decisionId, steps.some((x) => x.code === 'CLEARANCE_FLOOR'));
  }
  items.sort((a, b) => Date.parse(b.sortAt) - Date.parse(a.sortAt));
  return {
    count: items.length - clearanceCount,
    clearanceCount,
    withoutFloor: [...below].map(([currency, minor]) => ({ currency, minor, amount: m.money(minor, currency) })),
    unknownAmount: items.filter((i) => i.target === null && i.clearance === null).length,
    items: items.map(({ sortAt: _sortAt, ...rest }) => rest),
  };
}

/** Р-154: отчёт строится по срезу вмешательств окна — «без изменения» в него не попадают ещё в базе */
export function dangerousReport(world: StandWorld, slice: InterventionSlice, range: PeriodRange, phrase: string, m: Messages): DangerousReportView {
  const r = m.ui.dangerous;
  const to = Date.parse(range.until);
  const from = Date.parse(range.since);
  const floor = floorHolds(world, slice, from, to, m);
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
    };
  });
  return {
    worldId: world.id, phrase, from: m.when(range.since), to: m.when(range.until), clipped: range.clipped,
    headline: r.floorHeadline(floor.count, phrase, floor.withoutFloor.map((x) => x.amount), floor.unknownAmount), floorHolds: floor,
    clearanceHeadline: floor.clearanceCount > 0 ? r.clearanceHeld(floor.clearanceCount, phrase) : null,
    gateHeadline: r.headline(items.length, phrase), count: items.length,
    prevented: [...prevented].map(([currency, minor]) => ({ currency, minor, amount: m.money(minor, currency) })),
    worst: items[0] ?? null,
    byUnit: [...units.values()].sort((a, b) => b.count - a.count),
    byBound: [...bounds].map(([code, count]) => ({ code, title: (m.titles as Record<string, string | undefined>)[code] ?? code, count })),
    // `truncated` был про глубину буфера решений; теперь ещё и про предел среза — обе причины неполноты названы
    items, truncated: slice.truncated,
    gaps: [gap(m, 'FLOOR_HOLD_TARGET_WINDOW'), gap(m, 'DANGEROUS_REPORT_WINDOW'), gap(m, 'DANGEROUS_THRESHOLD'), ...(slice.truncated ? [gap(m, 'INTERVENTIONS_TRUNCATED')] : [])],
  };
}

export { DANGEROUS_DEVIATION_BP };
