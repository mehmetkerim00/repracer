import { can, COMPETITOR_DERIVED_RULES, type BoundResolution, type StrategyDefinition } from '@repracer/pricing-model';
import { effectiveFloor } from './bounds.ts';
import type { Messages } from './i18n/index.ts';
import { gap, unitOf, type ConsoleScope, type ConsoleWrite, type Gap, type StandWorld, type StatusCell, type UnitRef } from './world.ts';

/** Экран A: товары с явными статусами; действующий пол — главный, min_price — его составляющая (шаг 12, F) */

export interface StrategyLabel {
  label: string;
  detail: string;
  /** Цена из данных конкурентов: её останавливает системная остановка канала [Р-51] */
  competitorDerived: boolean;
}

export interface FloorCell {
  amount: string;
  minor: number | null;
  /** Из чего складывается: min_price и цена минимальной маржи */
  parts: string;
}

export interface ProductRow {
  unit: UnitRef;
  currentPrice: string;
  floor: FloorCell;
  minPrice: string;
  maxPrice: string;
  strategy: StrategyLabel;
  enabled: StatusCell;
  applying: StatusCell;
  lastChange: StatusCell;
  nextCheck: StatusCell;
  latestDecisionId: string | null;
  decisions: number;
  /** Можно ли включить репрайсинг (режим OFF и роль с правом включения) */
  canEnable: boolean;
  /** Шаг 23: что канал делает с оффером сам — правило автоматического ценообразования [Р-120], выбытие из Featured Offer (PRICING_HEALTH) */
  channelNotes: ChannelNote[];
}

/** AUTOMATED_PRICING и CHANNEL_BOUNDS — стратегию не назначит база (0082, Р-120); PRICING_HEALTH — только предупреждение */
export type ChannelNote = StatusCell & { code: 'AUTOMATED_PRICING' | 'CHANNEL_BOUNDS' | 'PRICING_HEALTH' };

export interface ProductListView {
  worldId: string;
  now: string;
  totals: { total: number; enabled: number; applying: number; stopped: number; off: number };
  rows: ProductRow[];
  gaps: Gap[];
}

export function strategyLabel(def: StrategyDefinition | null, currency: string, m: Messages): StrategyLabel {
  const s = m.ui.strategy;
  if (!def) return { label: s.none, detail: s.noneDetail, competitorDerived: false };
  const p = def.params;
  const money = (v: number) => m.money(v, currency);
  const tail = `${def.deadbandMinor > 0 ? `; ${s.deadband(money(def.deadbandMinor))}` : ''} (${s.version(def.version)})`;
  const atBound = (v: 'CAP' | 'HOLD') => (v === 'CAP' ? s.capAtBound : s.holdAtBound);
  // Р-91: подрез хранится 18 месяцев после замены версии стратегии; без него — «не хранится», а не «сравняться»
  const undercut = (u: number | undefined) => (u === undefined ? s.undercutNotKept : u > 0 ? s.undercut(money(u)) : s.match);
  const competitorDerived = COMPETITOR_DERIVED_RULES.has(p.type);
  switch (p.type) {
    case 'FIXED':
      return { label: s.fixed, detail: `${money(p.priceMinor)}${tail}`, competitorDerived };
    case 'TARGET_MARGIN':
      return { label: s.targetMargin, detail: `${s.marginOfNet(m.percentBp(p.targetMarginBp))}${tail}`, competitorDerived };
    case 'MATCH_BUYBOX':
      return {
        label: s.buybox,
        detail: `${undercut((p as { undercutMinor?: number }).undercutMinor)}${p.holdWhenWinning ? `; ${s.holdWhenWinning}` : ''}; ${atBound(p.atBound)}${tail}`,
        competitorDerived,
      };
    case 'BEAT_LOWEST':
      return {
        label: s.lowest,
        detail: `${undercut((p as { undercutMinor?: number }).undercutMinor)}, ${p.scope === 'MARKET' ? s.marketScope : s.visibleScope}${p.compareLanded ? `, ${s.landed}` : ''}; ${atBound(p.atBound)}${tail}`,
        competitorDerived,
      };
  }
}

export function boundText(b: BoundResolution, currency: string, m: Messages): string {
  return b.status === 'RESOLVED' ? m.money(b.amountMinor, currency) : m.ui.common.boundUnresolved(m.values[b.cause]);
}

const ACTIVE_WRITE = new Set(['PENDING', 'DISPATCHED', 'FAILED', 'ACCEPTED', 'BLOCKED']);

export function enabledCell(scope: ConsoleScope, m: Messages): StatusCell {
  const e = m.ui.enabled;
  if (scope.pricingMode === 'OFF') return { tone: 'off', label: e.off, detail: e.offDetail };
  if (scope.pricingMode === 'KAUFLAND_SMART_PRICING') return { tone: 'off', label: e.smart, detail: e.smartDetail };
  // Р-69: остановка человеком — все цены, включая фиксированные и маржинальные
  if (scope.priceStop) return { tone: 'stop', label: e.stopped, detail: e.stoppedDetail(m.values[scope.priceStop.scope], m.when(scope.priceStop.stoppedAt)) };
  // Р-118: недоверие каналу — все цены, включая фиксированные и маржинальные, до снятия человеком
  if (scope.channelDistrust) return { tone: 'stop', label: e.distrusted, detail: e.distrustedDetail(m.when(scope.channelDistrust.detectedAt)) };
  if (scope.status !== 'ACTIVE') return { tone: 'stop', label: e.inactive(m.values[scope.status]), detail: e.inactiveDetail };
  if (scope.channelHalt && scope.strategy && COMPETITOR_DERIVED_RULES.has(scope.strategy.params.type)) {
    return { tone: 'stop', label: e.halted, detail: e.haltedDetail(m.when(scope.channelHalt.haltedAt)) };
  }
  if (scope.channelHalt) return { tone: 'ok', label: e.on, detail: e.haltedButWorks };
  return { tone: 'ok', label: e.on, detail: e.onDetail };
}

export function applyingCell(scope: ConsoleScope, writes: readonly ConsoleWrite[], m: Messages): StatusCell {
  const a = m.ui.applying;
  const w = writes.filter((x) => x.writeScopeId === scope.writeScopeId && ACTIVE_WRITE.has(x.status)).sort((x, y) => y.version - x.version)[0];
  const money = (v: number) => m.money(v, scope.currency);
  const error = (code: string | null) => (code ? (m.values as Record<string, string | undefined>)[code] ?? code : a.noErrorCode);
  if (!w) return { tone: 'ok', label: a.idle, detail: a.idleDetail };
  switch (w.status) {
    case 'PENDING': return { tone: 'progress', label: a.queued(money(w.amountMinor)), detail: a.queuedDetail(m.when(w.createdAt)) };
    case 'DISPATCHED': return { tone: 'progress', label: a.dispatching(money(w.amountMinor)), detail: a.dispatchingDetail(m.when(w.dispatchedAt)) };
    case 'ACCEPTED': return { tone: 'progress', label: a.accepted(money(w.amountMinor)), detail: a.acceptedDetail(m.when(w.acceptedAt)) };
    case 'FAILED':
      return w.nextAttemptAt
        ? { tone: 'warn', label: a.retry(money(w.amountMinor)), detail: a.retryDetail(error(w.lastErrorCode), w.attemptCount + 1, m.when(w.nextAttemptAt)) }
        : { tone: 'stop', label: a.blocked(money(w.amountMinor)), detail: a.blockedDetail(error(w.lastErrorCode)) };
    default: return { tone: 'stop', label: a.blocked(money(w.amountMinor)), detail: m.ui.writeStatus[w.status as keyof typeof m.ui.writeStatus] ?? w.status };
  }
}

export function lastChangeCell(scope: ConsoleScope, writes: readonly ConsoleWrite[], m: Messages): StatusCell {
  const l = m.ui.lastChange;
  const w = writes
    .filter((x) => x.writeScopeId === scope.writeScopeId && (x.status === 'APPLIED' || x.status === 'ACCEPTED') && x.acceptedAt)
    .sort((x, y) => Date.parse(y.acceptedAt!) - Date.parse(x.acceptedAt!))[0];
  if (!w) return { tone: 'unknown', label: l.none, detail: l.noneDetail };
  return {
    tone: w.status === 'APPLIED' ? 'ok' : 'progress',
    label: m.money(w.amountMinor, scope.currency),
    detail: w.status === 'APPLIED' ? l.applied(m.when(w.acceptedAt)) : l.acceptedOnly(m.when(w.acceptedAt)),
  };
}

/** Шаг 23: наблюдения канала по офферу — последнее наблюдение ценообразования канала и последнее состояние PRICING_HEALTH */
export function channelNotes(world: StandWorld, scope: ConsoleScope, m: Messages): ChannelNote[] {
  const n = m.ui.channelNotes;
  const notes: ChannelNote[] = [];
  const pricing = world.state.offerChannelPricing.find((o) => o.channelAccountId === scope.channelAccountId && o.marketplace === scope.marketplace && o.externalSku === scope.externalUnitId);
  if (pricing?.automatedPricing) notes.push({ code: 'AUTOMATED_PRICING', tone: 'stop', label: n.automatedPricing, detail: n.automatedPricingDetail(m.when(pricing.observedAt)) });
  if (pricing?.channelBounds) notes.push({ code: 'CHANNEL_BOUNDS', tone: 'warn', label: n.channelBounds, detail: n.channelBoundsDetail(m.when(pricing.observedAt)) });
  const health = world.state.pricingHealth.find((h) => h.channelAccountId === scope.channelAccountId && h.marketplace === scope.marketplace
    && h.channelProductRef === scope.channelProductRef && h.condition === scope.condition);
  if (health) {
    notes.push({
      code: 'PRICING_HEALTH', tone: 'warn', label: n.pricingHealth(health.issueType),
      detail: n.pricingHealthDetail(m.when(health.occurredAt), health.competitivePriceThreshold ? m.money(health.competitivePriceThreshold.amountMinor, health.competitivePriceThreshold.currency) : null),
    });
  }
  return notes;
}

export function productList(world: StandWorld, m: Messages): ProductListView {
  const { state } = world;
  const p = m.ui.products;
  const rows = state.scopes.map((scope): ProductRow => {
    const decisions = state.decisions.filter((d) => d.writeScopeId === scope.writeScopeId).sort((a, b) => Date.parse(b.decidedAt) - Date.parse(a.decidedAt));
    const floor = effectiveFloor(scope, world);
    const money = (v: number | null) => m.money(v, scope.currency);
    const parts = floor.minMinor === null ? p.floorNoMin
      : floor.marginFloorMinor !== null && floor.marginFloorMinor > floor.minMinor ? p.floorFromMargin(m.percentBp(floor.minMarginBp!), money(floor.marginFloorMinor), money(floor.minMinor))
        : floor.marginUnavailableCause ? p.floorMarginUnavailable(money(floor.minMinor), m.values[floor.marginUnavailableCause as keyof typeof m.values] ?? floor.marginUnavailableCause)
          : p.floorFromMin(money(floor.minMinor));
    return {
      unit: unitOf(world, scope, m),
      currentPrice: money(scope.currentPriceMinor),
      floor: { amount: money(floor.minor), minor: floor.minor, parts },
      minPrice: boundText(scope.bounds.min, scope.currency, m),
      maxPrice: boundText(scope.bounds.max, scope.currency, m),
      strategy: strategyLabel(scope.strategy, scope.currency, m),
      enabled: enabledCell(scope, m),
      applying: applyingCell(scope, state.writes, m),
      lastChange: lastChangeCell(scope, state.writes, m),
      nextCheck: { tone: 'unknown', label: m.ui.nextCheck.label, detail: m.ui.nextCheck.detail },
      latestDecisionId: decisions[0]?.decisionId ?? null,
      decisions: decisions.length,
      canEnable: scope.pricingMode === 'OFF' && can(world.viewer.role, 'ENABLE_REPRICING'),
      channelNotes: channelNotes(world, scope, m),
    };
  });
  return {
    worldId: world.id,
    now: m.when(world.now),
    totals: {
      total: rows.length,
      enabled: rows.filter((r) => r.enabled.tone === 'ok').length,
      applying: rows.filter((r) => r.applying.tone === 'progress' || r.applying.tone === 'warn').length,
      stopped: rows.filter((r) => r.enabled.tone === 'stop').length,
      off: rows.filter((r) => r.enabled.tone === 'off').length,
    },
    rows,
    gaps: [gap(m, 'PRODUCT_TITLE'), gap(m, 'NEXT_CHECK'), gap(m, 'USER_TIME_ZONE'), ...(state.pricingHealth.length > 0 ? [gap(m, 'PRICING_HEALTH_ISSUES')] : [])],
  };
}
