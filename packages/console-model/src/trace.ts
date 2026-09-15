import type { ExpandedExplanation, ExpandedReason, ExplanationGap, Reason, StrategyDefinition, StrategyParams } from '@repracer/pricing-model';
import { classifyBoundIntervention, expandExplanation, explanationRowOf } from '@repracer/pricing-model';
import { describe, type HumanReason } from './explain.ts';
import type { Messages } from './i18n/index.ts';
import { strategyLabel } from './products.ts';
import { gap, scopeById, unitOf, uniqueGaps, type ConsoleDecision, type ConsoleWrite, type Gap, type StandWorld, type Tone, type UnitRef } from './world.ts';

/**
 * Экран B «почему эта цена» из неизменяемого слепка решения [Р-68]: снимок, проверка входов, якоря, стратегия, Gate,
 * запись, подтверждение канала. Работает одинаково на памяти и на PostgreSQL: отчёты прогона не нужны.
 * Слепок разворачивается справочниками [Р-75]; чего нет в справочнике — пробел, а не пустой шаг.
 * У решения NO_OP слепка нет [Р-74]: экран показывает код причины и называет, чего нет и почему.
 * Значения из данных канала в слепке не хранятся — шаг показывает пометку и срок ссылки на полный снимок.
 */

export type StepStatus = 'OK' | 'STOP' | 'WARN' | 'SKIPPED' | 'UNKNOWN';
export type ItemOutcome = 'PASS' | 'FAIL' | 'SKIPPED' | 'NOT_RUN' | 'INFO';
export type TraceStepKey = 'SNAPSHOT' | 'SANITY' | 'ANCHORS' | 'STRATEGY' | 'GATE' | 'WRITE' | 'CHANNEL';

export interface TraceItem {
  label: string;
  value?: string;
  outcome?: ItemOutcome;
  reason?: HumanReason;
}

export interface TraceStep {
  key: TraceStepKey;
  title: string;
  status: StepStatus;
  summary: string;
  items: TraceItem[];
  gaps: Gap[];
}

export interface DecisionTrace {
  worldId: string;
  decisionId: string;
  unit: UnitRef | null;
  decidedAt: string;
  headline: string;
  tone: Tone;
  /** Р-73: опасное изменение, остановленное границей */
  dangerous: boolean;
  steps: TraceStep[];
  gaps: Gap[];
}

export interface DecisionListItem {
  decisionId: string;
  unit: UnitRef | null;
  decidedAt: string;
  outcome: string;
  tone: Tone;
  price: string;
  reason: string;
  dangerous: boolean;
}

const OUTCOME_TONE: Readonly<Record<string, Tone>> = { APPROVED: 'ok', NO_CHANGE: 'off', REJECTED: 'stop', HELD: 'warn' };

const ANCHORS: ReadonlyArray<{ name: string; rule: string; failCodes: string[] }> = [
  { name: 'COST', rule: 'COST_ANCHOR', failCodes: ['PRICE_BELOW_COST_ANCHOR', 'PRICE_ABOVE_COST_ANCHOR'] },
  { name: 'INTERNAL', rule: 'INTERNAL_ANCHOR', failCodes: ['SNAPSHOT_INTERNAL_OUTLIER'] },
  { name: 'CROSS_CHANNEL', rule: 'CROSS_CHANNEL_ANCHOR', failCodes: ['CROSS_CHANNEL_MISMATCH'] },
  { name: 'HISTORY', rule: 'HISTORY_ANCHOR', failCodes: ['OUTSIDE_HISTORY_BAND'] },
];

const BOUND_STOPS = new Set(['BELOW_MIN_PRICE', 'BELOW_MARGIN_FLOOR', 'ABOVE_MAX_PRICE']);

/** Срок ссылки на полный снимок — 18 месяцев от решения [Р-38] */
function snapshotRefUntil(decidedAt: string): string {
  const d = new Date(decidedAt);
  d.setUTCMonth(d.getUTCMonth() + 18);
  return d.toISOString();
}

/** Слепок решения со справочниками мира; null — у решения слепка нет (NO_OP) */
export function explanationOf(world: StandWorld, d: ConsoleDecision): { value: ExpandedExplanation; gaps: ExplanationGap[] } | null {
  // Р-80: итог Gate, ссылки и столбцы intent — из строки решения, остальное — из слепка и справочников
  return d.explanation ? expandExplanation(d.explanation, explanationRowOf(d, d), { rulesets: world.state.explanationRulesets, strategies: world.state.strategies }) : null;
}

/** Причина решения без изменения цены — только код [Р-74] */
export function noChangeTitle(d: ConsoleDecision, m: Messages): string | null {
  return d.noChangeReason ? (m.titles as Record<string, string | undefined>)[d.noChangeReason] ?? d.noChangeReason : null;
}

function strategyOf(e: ExpandedExplanation): StrategyDefinition | null {
  const p = e.strategy.params as Record<string, unknown>;
  if (!e.strategy.type || e.strategy.version === null || e.strategy.strategyId === null) return null;
  const { deadbandMinor, currency: _currency, ...params } = p;
  return { strategyId: e.strategy.strategyId, version: e.strategy.version, params: params as unknown as StrategyParams, deadbandMinor: Number(deadbandMinor ?? 0) };
}

export function isDangerous(d: ConsoleDecision): boolean {
  return d.rejectionReason !== null && BOUND_STOPS.has(d.rejectionReason) && d.boundDeviationBp !== null && classifyBoundIntervention(d.boundDeviationBp) === 'DANGEROUS';
}

export function decisionTrace(world: StandWorld, decisionId: string, m: Messages): DecisionTrace | null {
  const d = world.state.decisions.find((x) => x.decisionId === decisionId);
  if (!d) return null;
  const t = m.ui.trace;
  const scope = scopeById(world, d.writeScopeId);
  const currency = d.currency;
  const money = (v: number | null) => m.money(v, currency);
  const say = (r: ExpandedReason | Reason) => describe(r, m);
  const expanded = explanationOf(world, d);
  const e = expanded?.value ?? null;
  const steps: TraceStep[] = [];
  const gaps: Gap[] = [];
  const withheldSomewhere = (reasons: Array<ExpandedReason | null | undefined>) => reasons.some((r) => (r?.withheld.length ?? 0) > 0);
  if (expanded && expanded.gaps.length > 0) gaps.push(gap(m, 'EXPLANATION_DICTIONARY_MISSING'));
  const kept = noChangeTitle(d, m);

  if (!e && d.decisionClass === 'NO_OP' && kept) {
    // Р-74: только код причины; остальные шаги называют, почему их нет
    gaps.push(gap(m, 'NO_OP_NOT_EXPLAINED'));
    for (const key of ['SNAPSHOT', 'SANITY', 'ANCHORS'] as const) steps.push({ key, title: t.titles[key], status: 'UNKNOWN', summary: t.noOpNotExplained, items: [], gaps: [] });
    steps.push({ key: 'STRATEGY', title: t.titles.STRATEGY, status: 'OK', summary: t.keep(kept), items: [], gaps: [] });
    steps.push({ key: 'GATE', title: t.titles.GATE, status: 'UNKNOWN', summary: t.noOpNotExplained, items: [], gaps: [] });
  } else if (!e) {
    gaps.push(gap(m, 'NO_EXPLANATION'));
    steps.push({ key: 'SNAPSHOT', title: t.titles.SNAPSHOT, status: 'UNKNOWN', summary: t.noExplanation, items: [], gaps: [] });
  } else {
    // 1. Снимок
    if (!e.snapshot) {
      steps.push({ key: 'SNAPSHOT', title: t.titles.SNAPSHOT, status: 'SKIPPED', summary: t.snapshotNotUsed, items: [], gaps: [] });
    } else {
      const source = (m.ui.sources as Record<string, string | undefined>)[e.snapshot.source];
      const ref = d.snapshotRef;
      const stepGaps: Gap[] = [gap(m, 'SNAPSHOT_CONTENT')];
      if (!source) stepGaps.push(gap(m, 'SOURCE_NAME'));
      if (!ref) stepGaps.push(gap(m, 'SNAPSHOT_REF_EXPIRED'));
      steps.push({
        key: 'SNAPSHOT', title: t.titles.SNAPSHOT, status: 'OK',
        summary: t.snapshotSummary(source ?? e.snapshot.source, ref ? m.when(ref.observedAt) : t.refExpired),
        items: [
          { label: t.source, value: source ?? e.snapshot.source },
          { label: t.observed, value: ref ? m.when(ref.observedAt) : t.refExpired },
          ...(ref ? [{ label: t.snapshotRef, value: t.refUntil(m.when(snapshotRefUntil(d.decidedAt))) }] : []),
        ],
        gaps: stepGaps,
      });
    }

    // 2–3. Проверка входов и якоря — только для цены из данных снимка
    if (e.snapshot) {
      const s = e.sanity;
      if (!s) {
        steps.push({ key: 'SANITY', title: t.titles.SANITY, status: 'UNKNOWN', summary: t.sanityMissing, items: [], gaps: [] });
        steps.push({ key: 'ANCHORS', title: t.titles.ANCHORS, status: 'UNKNOWN', summary: t.sanityMissing, items: [], gaps: [] });
      } else {
        const items: TraceItem[] = s.checks.map((c) => ({
          label: (m.ui.rules as Record<string, string | undefined>)[c.rule] ?? (m.titles as Record<string, string | undefined>)[c.rule] ?? c.rule,
          outcome: c.outcome,
          ...(c.detail ? { reason: say(c.detail) } : {}),
        }));
        for (const w of s.warnings) items.push({ label: t.warning, outcome: 'INFO', reason: say(w) });
        const sanityGaps = withheldSomewhere([...s.checks.map((c) => c.detail), ...s.warnings]) ? [gap(m, 'CHANNEL_VALUES_WITHHELD')] : [];
        steps.push({
          key: 'SANITY', title: t.sanityTitle(s.ruleset), status: s.warnings.length > 0 ? 'WARN' : 'OK',
          summary: t.sanityAccepted(s.checks.length, s.warnings.length), items, gaps: sanityGaps,
        });
        const anchorItems: TraceItem[] = ANCHORS.map((a) => {
          const label = (m.ui.rules as Record<string, string>)[a.rule]!;
          const failed = s.checks.find((c) => a.failCodes.includes(c.rule));
          if (failed) return { label, outcome: 'FAIL', ...(failed.detail ? { reason: say(failed.detail) } : {}) };
          const check = s.checks.find((c) => c.rule === a.rule);
          if (!check) return { label, outcome: 'NOT_RUN', value: t.anchorNotRun };
          if (check.outcome === 'SKIPPED') return { label, outcome: 'SKIPPED', ...(check.detail ? { reason: say(check.detail) } : {}) };
          return { label, outcome: s.anchorsUsed.includes(a.name) ? 'PASS' : 'INFO', ...(check.detail ? { reason: say(check.detail) } : { value: t.anchorPassed }) };
        });
        const used = s.anchorsUsed.map((a) => (m.values as Record<string, string | undefined>)[a] ?? a);
        steps.push({
          key: 'ANCHORS', title: t.titles.ANCHORS, status: used.length > 0 ? 'OK' : 'WARN',
          summary: used.length > 0 ? t.anchorsUsed(used.join(', ')) : t.noAnchor, items: anchorItems, gaps: [],
        });
      }
    }

    // 4. Стратегия — версия и параметры из слепка
    const st = e.strategy;
    const def = strategyOf(e);
    const label = strategyLabel(def, currency, m);
    const reason = say(st.reason);
    steps.push({
      key: 'STRATEGY', title: t.titles.STRATEGY, status: 'OK',
      summary: st.intentClass === 'CHANGED' ? t.proposed(money(st.proposedMinor), m.change(st.currentMinor, st.proposedMinor), reason.text) : t.keep(reason.text),
      items: [
        { label: t.strategy, value: `${label.label}: ${label.detail}` },
        { label: t.trigger, value: (m.ui.triggers as Record<string, string | undefined>)[st.trigger] ?? st.trigger },
        { label: t.before, value: money(st.currentMinor) },
        { label: t.boundsAtStrategy, value: `${money(st.boundsAtStrategy.minMinor)} – ${money(st.boundsAtStrategy.maxMinor)}` },
        ...st.steps.map((r): TraceItem => ({ label: t.step, outcome: 'INFO', reason: say(r) })),
      ],
      gaps: withheldSomewhere([st.reason, ...st.steps]) ? [gap(m, 'CHANNEL_VALUES_WITHHELD')] : [],
    });

    // 5. Price Gate
    const g = e.gate;
    // Находка 8: порядок проверок — из профиля Gate справочника; нет профиля — порядок неизвестен, а не подставлен из кода
    const checkLabel = (c: string) => (m.ui.gateChecks as Record<string, string | undefined>)[c] ?? c;
    const gateItems: TraceItem[] = [
      ...g.checks.map((c): TraceItem => ({ label: checkLabel(c.check), outcome: c.passed ? 'PASS' : 'FAIL', ...(c.detail ? { reason: say(c.detail) } : {}) })),
      ...g.notRun.map((c): TraceItem => ({ label: checkLabel(c), outcome: 'NOT_RUN', value: t.notRun })),
      ...(g.profileKnown ? [] : [{ label: t.gateOrderUnknown, value: g.profile ?? '—' }]),
      { label: t.floor, value: money(g.floorMinor) },
      { label: t.ceiling, value: money(g.ceilingMinor) },
    ];
    if (g.minMarginBp !== null) gateItems.push({ label: t.minMargin, value: m.percentBp(g.minMarginBp) });
    if (g.fx) gateItems.push({ label: t.fx, value: m.ui.bounds.fxText(m.rate(g.fx.rateMicros), g.fx.quote, g.fx.rateDate, m.money(g.fx.sourceAmountMinor, g.fx.from), m.money(g.fx.convertedAmountMinor, g.fx.to), g.fx.rounding === 'UP') });
    if (g.boundDeviationBp !== null) {
      gateItems.push({ label: t.deviation, value: t.deviationValue(m.percentBp(g.boundDeviationBp), classifyBoundIntervention(g.boundDeviationBp) === 'DANGEROUS') });
    }
    if (e.context.priceStop) gateItems.push({ label: t.priceStop, value: t.priceStopValue(m.values[e.context.priceStop.scope], m.when(e.context.priceStop.stoppedAt)) });
    if (e.context.channelHalt) gateItems.push({ label: t.channelHalt, value: t.channelHaltValue(m.when(e.context.channelHalt.haltedAt)) });
    steps.push({
      key: 'GATE', title: t.titles.GATE,
      status: !g.profileKnown ? 'UNKNOWN' : g.outcome === 'APPROVED' || g.outcome === 'NO_CHANGE' ? 'OK' : g.outcome === 'HELD' ? 'WARN' : 'STOP',
      summary: say(g.reason).text, items: gateItems, gaps: [],
    });
  }

  // 6–7. Запись и подтверждение канала
  const writes = world.state.writes.filter((w) => w.decisionId === d.decisionId).sort((a, b) => a.version - b.version);
  steps.push(writeStep(d, writes, m));
  steps.push(channelStep(world, d, writes, m));

  const last = writes[writes.length - 1];
  const status = (s: string) => (m.ui.writeStatus as Record<string, string | undefined>)[s] ?? s;
  const headline = d.outcome === 'APPROVED'
    ? last?.status === 'APPLIED' ? t.headlineApplied(money(d.finalMinor)) : last ? t.headlineApproved(money(d.finalMinor), status(last.status)) : t.headlineNoWrite(money(d.finalMinor))
    : d.outcome === 'NO_CHANGE' ? t.headlineNoChange(e ? say(e.strategy.reason).text : kept ?? say(d.reason).text)
      : say(e?.gate.reason ?? d.reason).text;
  return {
    worldId: world.id, decisionId: d.decisionId, unit: scope ? unitOf(world, scope, m) : null, decidedAt: m.when(d.decidedAt), headline,
    tone: last?.status === 'APPLIED' ? 'ok' : OUTCOME_TONE[d.outcome] ?? 'unknown', dangerous: isDangerous(d), steps,
    gaps: uniqueGaps([...gaps, ...steps.flatMap((s) => s.gaps)]),
  };
}

function writeStep(d: ConsoleDecision, writes: readonly ConsoleWrite[], m: Messages): TraceStep {
  const t = m.ui.trace;
  const money = (v: number) => m.money(v, d.currency);
  const status = (s: string) => (m.ui.writeStatus as Record<string, string | undefined>)[s] ?? s;
  if (writes.length === 0) {
    if (d.outcome !== 'APPROVED') return { key: 'WRITE', title: t.titles.WRITE, status: 'SKIPPED', summary: t.nothingSent, items: [], gaps: [] };
    return { key: 'WRITE', title: t.titles.WRITE, status: 'UNKNOWN', summary: t.writeMissing, items: [], gaps: [gap(m, 'DB_COMMIT_REJECTIONS')] };
  }
  const items: TraceItem[] = [];
  for (const w of writes) {
    items.push({ label: t.writeVersion(w.version, money(w.amountMinor)), value: t.writeDetail(status(w.status), w.attemptCount, w.dispatchedAt ? m.when(w.dispatchedAt) : null) });
    if (w.endReason) items.push({ label: t.endReason, outcome: 'INFO', reason: describe({ code: w.endReason, params: w.endParams }, m) });
  }
  const last = writes[writes.length - 1]!;
  const st: StepStatus = last.status === 'APPLIED' || last.status === 'ACCEPTED' ? 'OK' : ['PENDING', 'DISPATCHED', 'FAILED', 'SUPERSEDED'].includes(last.status) ? 'WARN' : 'STOP';
  return { key: 'WRITE', title: t.titles.WRITE, status: st, summary: `${money(last.amountMinor)}: ${status(last.status)}`, items, gaps: [] };
}

function channelStep(world: StandWorld, d: ConsoleDecision, writes: readonly ConsoleWrite[], m: Messages): TraceStep {
  const t = m.ui.trace;
  const last = writes[writes.length - 1];
  const money = (v: number) => m.money(v, d.currency);
  const items: TraceItem[] = world.state.divergenceCases
    .filter((c) => c.writeScopeId === d.writeScopeId && c.status === 'OPEN')
    .map((c) => ({ label: t.divergence, outcome: 'INFO' as const, reason: describe({ code: 'DIVERGENCE_CASE_OPENED', params: { observedMinor: c.observedMinor, expectedMinor: c.expectedMinor, currency: d.currency } }, m) }));
  const confirmation = [gap(m, 'CONFIRMATION_SOURCE')];
  if (!last) return { key: 'CHANNEL', title: t.titles.CHANNEL, status: 'SKIPPED', summary: t.nothingSent, items, gaps: [] };
  switch (last.status) {
    case 'APPLIED': return { key: 'CHANNEL', title: t.titles.CHANNEL, status: items.length ? 'WARN' : 'OK', summary: t.channelApplied(money(last.amountMinor), m.when(last.acceptedAt)), items, gaps: confirmation };
    case 'ACCEPTED': return { key: 'CHANNEL', title: t.titles.CHANNEL, status: 'WARN', summary: t.channelAccepted(money(last.amountMinor), m.when(last.acceptedAt)), items, gaps: confirmation };
    case 'DISPATCHED': return { key: 'CHANNEL', title: t.titles.CHANNEL, status: 'WARN', summary: t.channelWaiting(m.when(last.dispatchedAt)), items, gaps: [] };
    case 'NOT_APPLIED': return { key: 'CHANNEL', title: t.titles.CHANNEL, status: 'STOP', summary: t.channelNotApplied, items, gaps: [] };
    default: return { key: 'CHANNEL', title: t.titles.CHANNEL, status: 'SKIPPED', summary: t.channelNotConfirmed((m.ui.writeStatus as Record<string, string | undefined>)[last.status] ?? last.status), items, gaps: [] };
  }
}

export function decisionList(world: StandWorld, m: Messages): DecisionListItem[] {
  return [...world.state.decisions].sort((a, b) => Date.parse(b.decidedAt) - Date.parse(a.decidedAt) || b.decisionId.localeCompare(a.decisionId)).map((d) => {
    const scope = scopeById(world, d.writeScopeId);
    const e = explanationOf(world, d)?.value ?? null;
    const reason = d.outcome === 'NO_CHANGE' && e ? e.strategy.reason : e?.gate.reason ?? d.reason;
    const kept = !e ? noChangeTitle(d, m) : null;
    return {
      decisionId: d.decisionId, unit: scope ? unitOf(world, scope, m) : null, decidedAt: m.when(d.decidedAt),
      outcome: (m.ui.outcomes as Record<string, string | undefined>)[d.outcome] ?? d.outcome, tone: OUTCOME_TONE[d.outcome] ?? 'unknown',
      // Находка 15: у NO_OP нет слепка — цена из столбца решения (предложенная цена intent) [Р-80]
      price: m.money(d.finalMinor ?? d.proposedMinor, d.currency), reason: kept ?? describe(reason, m).text, dangerous: isDangerous(d),
    };
  });
}
