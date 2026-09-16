import { DANGEROUS_DEVIATION_BP } from '@repracer/pricing-model';
import type { Messages } from './i18n/index.ts';
import { isDangerous } from './trace.ts';
import { describe, type HumanReason } from './explain.ts';
import { gap, scopeById, unitOf, type Gap, type StandWorld, type UnitRef } from './world.ts';

/**
 * Отчёт «границы остановили N опасных изменений» [Р-73] за период: опасное — отклонённое Gate по границе с отклонением больше 10 %.
 * Сумма «сколько не ушло» — расстояние от предложенной цены до нарушенной границы, по валютам отдельно [Р-71]; между тенантами
 * ничего не суммируется. Период ограничен горячим буфером решений (30 дней, Р-28): старше — нет данных, а не ноль.
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

export interface DangerousReportView {
  worldId: string;
  days: number;
  from: string;
  to: string;
  headline: string;
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

export function dangerousReport(world: StandWorld, days: number, m: Messages): DangerousReportView {
  const r = m.ui.dangerous;
  const to = Date.parse(world.now);
  const from = to - days * 86_400_000;
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
    headline: r.headline(items.length, days), count: items.length,
    prevented: [...prevented].map(([currency, minor]) => ({ currency, minor, amount: m.money(minor, currency) })),
    worst: items[0] ?? null,
    byUnit: [...units.values()].sort((a, b) => b.count - a.count),
    byBound: [...bounds].map(([code, count]) => ({ code, title: (m.titles as Record<string, string | undefined>)[code] ?? code, count })),
    items, truncated: days > HOT_DECISIONS_DAYS,
    gaps: [gap(m, 'DANGEROUS_REPORT_WINDOW'), gap(m, 'DANGEROUS_THRESHOLD')],
  };
}

export { DANGEROUS_DEVIATION_BP };
