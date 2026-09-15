import { classifyBoundIntervention, type BoundIntervention } from '@repracer/pricing-model';
import { describe, type HumanReason } from './explain.ts';
import type { Messages } from './i18n/index.ts';
import { explanationOf } from './trace.ts';
import { gap, scopeById, unitOf, type Gap, type StandWorld, type Tone, type UnitRef } from './world.ts';

/**
 * Экран C: что остановили границы и другие рубежи. Р-73: «опасное» — отклонённое Gate с отклонением от границы больше 10 %;
 * остальное вмешательство границы — «скорректировано» (отказ Gate до 10 % и цель стратегии, поставленная на границу).
 */

export type RejectedKind = 'GATE' | 'STRATEGY_CAP' | 'WRITE_RECHECK' | 'STOP' | 'INPUT' | 'HALT';

export interface RejectedItem {
  kind: RejectedKind;
  tone: Tone;
  at: string;
  unit: UnitRef | null;
  productRef: string | null;
  proposed: string | null;
  current: string | null;
  change: string | null;
  limit: string | null;
  deviation: string | null;
  intervention: BoundIntervention | null;
  reason: HumanReason;
  decisionId: string | null;
}

export interface RejectedView {
  worldId: string;
  headline: string;
  summary: { dangerous: number; corrected: number; unresolvable: number; limiterHolds: number; stops: number; inputRejects: number; halts: number };
  groups: Array<{ code: string; title: string; count: number }>;
  items: RejectedItem[];
  gaps: Gap[];
}

const BOUND_REJECTIONS = new Set(['BELOW_MIN_PRICE', 'BELOW_MARGIN_FLOOR', 'ABOVE_MAX_PRICE']);
const LIMITERS = new Set(['STEP_LIMIT', 'CHANGE_RATE_LIMIT']);

export function rejectedView(world: StandWorld, m: Messages): RejectedView {
  const { state } = world;
  const r = m.ui.rejected;
  const rows: Array<RejectedItem & { sortAt: string }> = [];

  for (const d of state.decisions) {
    const scope = scopeById(world, d.writeScopeId);
    const unit = scope ? unitOf(world, scope, m) : null;
    const money = (v: number | null | undefined) => m.money(v ?? null, d.currency);
    const e = explanationOf(world, d)?.value ?? null;
    // Цель стратегии поставлена на границу — скорректировано границей [Р-73]. Цель выводит цену конкурента и в слепке не хранится
    // [Р-85]: берётся из горячего intent (3 дня, данные канала); intent уже удалён — цели нет, экран это показывает
    const hot = state.intents.find((i) => i.intentId === d.intentId) ?? null;
    for (const step of e?.strategy.steps ?? []) {
      if (step.code !== 'CAPPED_AT_MIN_PRICE' && step.code !== 'CAPPED_AT_MAX_PRICE') continue;
      const hotTarget = hot?.explanation.find((x) => x.code === step.code)?.params.targetMinor;
      const target = typeof hotTarget === 'number' ? hotTarget : null;
      const bound = Number(step.code === 'CAPPED_AT_MIN_PRICE' ? step.params.minMinor : step.params.maxMinor);
      rows.push({
        kind: 'STRATEGY_CAP', tone: 'progress', at: m.when(d.decidedAt), sortAt: d.decidedAt, unit, productRef: null,
        proposed: money(target), current: money(e!.strategy.currentMinor), change: target === null ? null : m.change(e!.strategy.currentMinor, target),
        limit: step.code === 'CAPPED_AT_MIN_PRICE' ? r.limitMin(money(bound)) : r.limitMax(money(bound)),
        deviation: null, intervention: 'CORRECTED', reason: describe(step, m), decisionId: d.decisionId,
      });
    }
    if (d.outcome !== 'REJECTED' && d.outcome !== 'HELD') continue;
    const code = d.rejectionReason ?? d.reason.code;
    // Предложенная цена — столбец горячего решения (30 дней); в развёрнутом слепке ядра у цены из данных конкурентов её нет [Р-85]
    const proposed = d.proposedMinor ?? e?.strategy.proposedMinor ?? null;
    const params = d.reason.params;
    const isBound = BOUND_REJECTIONS.has(code);
    const intervention = isBound && d.boundDeviationBp !== null ? classifyBoundIntervention(d.boundDeviationBp) : null;
    rows.push({
      kind: code === 'PRICING_STOPPED' ? 'STOP' : 'GATE',
      tone: intervention === 'DANGEROUS' ? 'stop' : d.outcome === 'HELD' ? 'warn' : isBound ? 'progress' : 'stop',
      at: m.when(d.decidedAt), sortAt: d.decidedAt, unit, productRef: null,
      proposed: proposed === null ? null : money(proposed), current: e ? money(e.strategy.currentMinor) : null,
      change: e && proposed !== null ? m.change(e.strategy.currentMinor, proposed) : null,
      limit: code === 'BELOW_MIN_PRICE' ? r.limitMin(money(params.minMinor as number))
        : code === 'BELOW_MARGIN_FLOOR' ? r.limitFloor(money(params.floorMinor as number))
          : code === 'ABOVE_MAX_PRICE' ? r.limitMax(money(params.maxMinor as number)) : null,
      deviation: d.boundDeviationBp === null ? null : m.percentBp(d.boundDeviationBp),
      intervention, reason: describe(e?.gate.reason ?? d.reason, m), decisionId: d.decisionId,
    });
  }

  for (const w of state.writes) {
    if (w.endReason !== 'WRITE_BLOCKED_BY_BOUND_RECHECK' && w.endReason !== 'PRICING_STOPPED') continue;
    const scope = scopeById(world, w.writeScopeId);
    rows.push({
      kind: w.endReason === 'PRICING_STOPPED' ? 'STOP' : 'WRITE_RECHECK', tone: 'stop', at: m.when(w.createdAt), sortAt: w.createdAt,
      unit: scope ? unitOf(world, scope, m) : null, productRef: null, proposed: m.money(w.amountMinor, w.currency),
      current: scope ? m.money(scope.currentPriceMinor, scope.currency) : null, change: scope ? m.change(scope.currentPriceMinor, w.amountMinor) : null,
      limit: null, deviation: null, intervention: null, reason: describe({ code: w.endReason, params: w.endParams }, m), decisionId: w.decisionId,
    });
  }

  for (const s of state.rejectedSnapshots) {
    const scope = state.scopes.find((x) => x.marketplace === s.key.marketplace && x.channelProductRef === s.key.channelProductRef && x.condition === s.key.condition);
    rows.push({
      kind: s.verdict === 'HALT_CHANNEL' ? 'HALT' : 'INPUT', tone: 'stop', at: m.when(s.receivedAt), sortAt: s.receivedAt,
      unit: scope ? unitOf(world, scope, m) : null, productRef: r.productRef(s.key.marketplace, s.key.channelProductRef),
      proposed: null, current: null, change: null, limit: null, deviation: null, intervention: null,
      reason: describe({ code: s.reasonCode, params: s.details }, m), decisionId: null,
    });
  }

  rows.sort((a, b) => Date.parse(b.sortAt) - Date.parse(a.sortAt));
  const items: RejectedItem[] = rows.map(({ sortAt: _sortAt, ...item }) => item);
  const dangerous = items.filter((i) => i.intervention === 'DANGEROUS').length;
  const corrected = items.filter((i) => i.intervention === 'CORRECTED').length;
  const counts = new Map<string, number>();
  for (const i of items) counts.set(i.reason.code, (counts.get(i.reason.code) ?? 0) + 1);

  return {
    worldId: world.id,
    headline: r.headline(dangerous, corrected),
    summary: {
      dangerous, corrected,
      unresolvable: items.filter((i) => i.reason.code === 'BOUND_UNRESOLVABLE').length,
      limiterHolds: items.filter((i) => LIMITERS.has(i.reason.code)).length,
      stops: items.filter((i) => i.kind === 'STOP').length,
      inputRejects: items.filter((i) => i.kind === 'INPUT').length,
      halts: state.halts.length,
    },
    groups: [...counts].map(([code, count]) => ({ code, title: (m.titles as Record<string, string | undefined>)[code] ?? code, count })).sort((a, b) => b.count - a.count),
    items,
    gaps: [gap(m, 'DB_COMMIT_REJECTIONS'), gap(m, 'REJECTED_SNAPSHOT_CONTENT')],
  };
}
