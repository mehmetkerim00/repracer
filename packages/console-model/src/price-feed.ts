import type { Messages } from './i18n/index.ts';
import { strategyLabel } from './products.ts';
import { describe, type HumanReason } from './explain.ts';
import { explanationOf } from './trace.ts';
import { gap, scopeById, unitOf, type Gap, type StandWorld, type Tone, type UnitRef } from './world.ts';

/**
 * Лента изменений цен (шаг 21): каждая запись цены в канал — от решения до итога канала, новые сверху. Источник — записи и решения
 * состояния консоли; «было» — цена, от которой считало решение. Итоговая история цен канала (price_history, 90 дней) и суточная
 * свёртка [Р-21] консолью не читаются — пробел на экране.
 */

export interface FeedItem {
  at: string;
  unit: UnitRef | null;
  from: string | null;
  to: string;
  change: string | null;
  status: string;
  tone: Tone;
  source: string;
  reason: HumanReason | null;
  decisionId: string | null;
}

export interface PriceFeedView {
  worldId: string;
  items: FeedItem[];
  counts: { applied: number; inFlight: number; notSent: number };
  gaps: Gap[];
}

const STATUS_TONE: Readonly<Record<string, Tone>> = {
  APPLIED: 'ok', ACCEPTED: 'progress', DISPATCHED: 'progress', PENDING: 'progress', BLOCKED: 'warn', FAILED: 'stop', NOT_APPLIED: 'stop',
  SUPERSEDED: 'off', DISCARDED_STALE: 'stop', BUDGET_EXHAUSTED: 'stop',
};
const IN_FLIGHT = new Set(['PENDING', 'DISPATCHED', 'ACCEPTED', 'BLOCKED']);

export function priceFeed(world: StandWorld, m: Messages, filter: { writeScopeId?: string; limit?: number } = {}): PriceFeedView {
  const f = m.ui.feed;
  const writes = world.state.writes.filter((w) => !filter.writeScopeId || w.writeScopeId === filter.writeScopeId)
    .sort((a, b) => Date.parse(b.acceptedAt ?? b.dispatchedAt ?? b.createdAt) - Date.parse(a.acceptedAt ?? a.dispatchedAt ?? a.createdAt) || b.version - a.version);
  const items = writes.slice(0, filter.limit ?? 200).map((w): FeedItem => {
    const scope = scopeById(world, w.writeScopeId);
    const decision = w.decisionId ? world.state.decisions.find((d) => d.decisionId === w.decisionId) ?? null : null;
    const intent = decision ? world.state.intents.find((i) => i.intentId === decision.intentId) ?? null : null;
    // «Было»: горячий intent (3 дня) или слепок объяснения решения [Р-68]; у NO_OP слепка нет, но NO_OP не пишет в канал
    const from = intent?.currentMinor ?? (decision ? explanationOf(world, decision)?.value.strategy.currentMinor ?? null : null);
    const strategy = decision?.strategyId ? world.state.strategies.find((s) => s.strategyId === decision.strategyId && s.version === decision.strategyVersion) ?? null : null;
    const source = !decision ? f.sourceUnknown
      : decision.ruleCode === 'MANUAL' ? f.sourceManual
        : strategy ? strategyLabel(strategy, w.currency, m).label : f.sourceRule(decision.ruleCode);
    const ended = w.endReason ? describe({ code: w.endReason, params: w.endParams }, m) : null;
    return {
      at: m.when(w.acceptedAt ?? w.dispatchedAt ?? w.createdAt), unit: scope ? unitOf(world, scope, m) : null,
      from: from === null ? null : m.money(from, w.currency), to: m.money(w.amountMinor, w.currency), change: m.change(from, w.amountMinor),
      status: f.statuses[w.status as keyof typeof f.statuses] ?? w.status, tone: STATUS_TONE[w.status] ?? 'unknown', source,
      reason: ended ?? (decision ? describe(decision.reason, m) : null), decisionId: w.decisionId,
    };
  });
  return {
    worldId: world.id, items,
    counts: {
      applied: writes.filter((w) => w.status === 'APPLIED').length,
      inFlight: writes.filter((w) => IN_FLIGHT.has(w.status)).length,
      notSent: writes.filter((w) => ['FAILED', 'NOT_APPLIED', 'DISCARDED_STALE', 'BUDGET_EXHAUSTED'].includes(w.status)).length,
    },
    gaps: [gap(m, 'FEED_WINDOW'), gap(m, 'PRICE_HISTORY_NOT_READ')],
  };
}
