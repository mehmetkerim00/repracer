import { DANGEROUS_DEVIATION_BP } from '@repracer/pricing-model';
import type { Messages } from './i18n/index.ts';
import { explanationOf, isDangerous } from './trace.ts';
import { describe, type HumanReason } from './explain.ts';
import { gap, scopeById, unitOf, type Gap, type StandWorld, type UnitRef } from './world.ts';

/**
 * Отчёт о работе границ за период.
 *
 * Главное число — Р-117 (шаг 22): сколько раз ПОЛ удержал цену, то есть стратегия хотела уйти ниже min_price или пола маржи и была
 * удержана — поставлена на пол (CAPPED_AT_MIN_PRICE) или оставлена без изменения (TARGET_OUTSIDE_BOUNDS_HOLD с целью ниже пола).
 * «Без него вы продали бы на X дешевле» — сумма (пол − цель стратегии) по валютам отдельно [Р-71]. Отклонения Gate в норме равны
 * нулю: стратегия не предлагает цену за границей, её держит сам движок, поэтому считать их главным числом — считать ноль.
 * Цель стратегии выведена из цены конкурента и в вечный слепок не попадает [Р-85]: она есть только в горячем intent (3 дня, Р-28);
 * удержание старше — в счёте, но без суммы (unknownAmount), экран это показывает.
 *
 * Второй раздел — прежний отчёт [Р-73]: отклонения Gate с отклонением от границы больше 10 %. Между тенантами ничего не
 * суммируется; период ограничен горячим буфером решений (30 дней): старше — нет данных, а не ноль.
 */

export const REPORT_PERIODS_DAYS = [1, 7, 30] as const;
const HOT_DECISIONS_DAYS = 30;

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
}

export interface FloorHoldsView {
  count: number;
  /** По валютам: сумма (пол − цель) удержаний с известной целью */
  withoutFloor: Array<{ currency: string; amount: string; minor: number }>;
  /** Удержания без суммы: цель старше горячего буфера intent */
  unknownAmount: number;
  items: FloorHoldItem[];
}

export interface DangerousReportView {
  worldId: string;
  days: number;
  from: string;
  to: string;
  /** Р-117: «пол удержал цену N раз, без него вы продали бы на X дешевле» */
  headline: string;
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

function floorHolds(world: StandWorld, from: number, to: number, m: Messages): FloorHoldsView {
  const below = new Map<string, number>();
  const items: Array<FloorHoldItem & { sortAt: string }> = [];
  const seenIntents = new Set<string>();
  // kept — цена, которую удержал пол: сам пол (поставлена на пол) или текущая цена (оставлена без изменения)
  const push = (at: string, writeScopeId: string, kind: 'CAPPED' | 'HELD', target: number | null, floor: number, kept: number, currency: string, reason: Parameters<typeof describe>[0], decisionId: string | null) => {
    const scope = scopeById(world, writeScopeId);
    if (target !== null) below.set(currency, (below.get(currency) ?? 0) + (kept - target));
    items.push({
      sortAt: at, at: m.when(at), unit: scope ? unitOf(world, scope, m) : null, kind, target: target === null ? null : m.money(target, currency), floor: m.money(floor, currency),
      below: target === null ? null : m.money(kept - target, currency), reason: describe(reason, m), decisionId,
    });
  };
  // Горячие intent (3 дня): цель стратегии известна
  for (const i of world.state.intents) {
    if (!inPeriod(i.createdAt, from, to)) continue;
    const capped = i.explanation.find((x) => x.code === 'CAPPED_AT_MIN_PRICE');
    const held = i.reason.code === 'TARGET_OUTSIDE_BOUNDS_HOLD' ? i.reason : null;
    const hit = capped ?? held;
    if (!hit) continue;
    const target = Number(hit.params.targetMinor);
    const floor = Number(hit.params.minMinor);
    // Удержание у потолка — не работа пола
    if (!Number.isSafeInteger(target) || !Number.isSafeInteger(floor) || target >= floor) continue;
    seenIntents.add(i.intentId);
    const decision = world.state.decisions.find((d) => d.intentId === i.intentId) ?? null;
    const kept = capped ? floor : Math.max(floor, i.currentMinor ?? floor);
    push(i.createdAt, i.writeScopeId, capped ? 'CAPPED' : 'HELD', target, floor, kept, i.currency, hit, decision?.decisionId ?? null);
  }
  // Решения старше горячего intent (до 30 дней): удержание видно по шагу слепка, цели нет [Р-85]
  for (const d of world.state.decisions) {
    if (seenIntents.has(d.intentId) || !inPeriod(d.decidedAt, from, to)) continue;
    const step = explanationOf(world, d)?.value.strategy.steps?.find((x) => x.code === 'CAPPED_AT_MIN_PRICE');
    if (!step || !Number.isSafeInteger(step.params.minMinor)) continue;
    push(d.decidedAt, d.writeScopeId, 'CAPPED', null, step.params.minMinor as number, step.params.minMinor as number, d.currency, step, d.decisionId);
  }
  items.sort((a, b) => Date.parse(b.sortAt) - Date.parse(a.sortAt));
  return {
    count: items.length,
    withoutFloor: [...below].map(([currency, minor]) => ({ currency, minor, amount: m.money(minor, currency) })),
    unknownAmount: items.filter((i) => i.target === null).length,
    items: items.map(({ sortAt: _sortAt, ...rest }) => rest),
  };
}

export function dangerousReport(world: StandWorld, days: number, m: Messages): DangerousReportView {
  const r = m.ui.dangerous;
  const to = Date.parse(world.now);
  const from = to - days * 86_400_000;
  const floor = floorHolds(world, from, to, m);
  const decisions = world.state.decisions
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
    worldId: world.id, days, from: m.when(new Date(from).toISOString()), to: m.when(world.now),
    headline: r.floorHeadline(floor.count, days, floor.withoutFloor.map((x) => x.amount), floor.unknownAmount), floorHolds: floor,
    gateHeadline: r.headline(items.length, days), count: items.length,
    prevented: [...prevented].map(([currency, minor]) => ({ currency, minor, amount: m.money(minor, currency) })),
    worst: items[0] ?? null,
    byUnit: [...units.values()].sort((a, b) => b.count - a.count),
    byBound: [...bounds].map(([code, count]) => ({ code, title: (m.titles as Record<string, string | undefined>)[code] ?? code, count })),
    items, truncated: days > HOT_DECISIONS_DAYS,
    gaps: [gap(m, 'FLOOR_HOLD_TARGET_WINDOW'), gap(m, 'DANGEROUS_REPORT_WINDOW'), gap(m, 'DANGEROUS_THRESHOLD')],
  };
}

export { DANGEROUS_DEVIATION_BP };
