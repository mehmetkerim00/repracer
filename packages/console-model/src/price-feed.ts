import type { FeedPage, FeedPageItem, FeedPageQuery } from '@repracer/pricing-pipeline';
import type { Messages } from './i18n/index.ts';
import { OFFER_CHOICES } from './compliance.ts';
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

export const FEED_STATUS_GROUPS = ['APPLIED', 'IN_FLIGHT', 'NOT_SENT', 'SUPERSEDED'] as const;
export type FeedStatusGroup = (typeof FEED_STATUS_GROUPS)[number];
export const FEED_PERIODS_DAYS = [1, 7, 30] as const;
/** Страница ленты — не больше 200 записей за запрос */
export const FEED_PAGE_MAX = 200;

/** Шаг 23: фильтры и страница ленты — на сервере, по всему окну ленты, а не по уже отданным записям */
export interface FeedQuery {
  writeScopeId?: string;
  status?: FeedStatusGroup;
  days?: (typeof FEED_PERIODS_DAYS)[number];
  offset?: number;
  limit?: number;
}

export interface PriceFeedView {
  worldId: string;
  items: FeedItem[];
  counts: { applied: number; inFlight: number; notSent: number; superseded: number };
  query: { writeScopeId: string | null; status: FeedStatusGroup | null; days: number | null; offset: number; limit: number };
  page: { from: number; to: number; total: number; text: string; hasPrevious: boolean; hasNext: boolean };
  /** Офферы для фильтра: первые OFFER_CHOICES [Р-136] */
  offers: UnitRef[];
  offersTotal: number;
  gaps: Gap[];
}

/** Разбор параметров адреса; неверный параметр — null (ответ 400), а не молчаливое «все» */
export function parseFeedQuery(params: URLSearchParams): FeedQuery | null {
  const q: FeedQuery = {};
  const ws = params.get('writeScopeId');
  if (ws) q.writeScopeId = ws;
  const status = params.get('status');
  if (status) {
    if (!(FEED_STATUS_GROUPS as readonly string[]).includes(status)) return null;
    q.status = status as FeedStatusGroup;
  }
  const days = params.get('days');
  if (days) {
    if (!(FEED_PERIODS_DAYS as readonly number[]).includes(Number(days))) return null;
    q.days = Number(days) as FeedQuery['days'] & number;
  }
  for (const key of ['offset', 'limit'] as const) {
    const v = params.get(key);
    if (v === null) continue;
    if (!/^\d{1,6}$/.test(v)) return null;
    q[key] = Number(v);
  }
  if (q.limit !== undefined && (q.limit < 1 || q.limit > FEED_PAGE_MAX)) return null;
  return q;
}

const STATUS_TONE: Readonly<Record<string, Tone>> = {
  APPLIED: 'ok', ACCEPTED: 'progress', DISPATCHED: 'progress', PENDING: 'progress', BLOCKED: 'warn', FAILED: 'stop', NOT_APPLIED: 'stop',
  SUPERSEDED: 'off', DISCARDED_STALE: 'stop', BUDGET_EXHAUSTED: 'stop',
};
// Группы статусов — одно определение на базу и память: `feedGroupOf` из порта хранилища [Р-154]

/** Запрос ленты — в форму запроса хранилища; смещение за концом подтягивается к последней странице [Р-154] */
export function feedPageQuery(filter: FeedQuery, total?: number): FeedPageQuery {
  const limit = Math.min(filter.limit ?? 50, FEED_PAGE_MAX);
  const raw = filter.offset ?? 0;
  const offset = total === undefined ? raw : Math.min(raw, Math.max(0, total - 1));
  return { offset, limit, ...(filter.writeScopeId ? { writeScopeId: filter.writeScopeId } : {}), ...(filter.status ? { status: filter.status } : {}),
    ...(filter.days ? { sinceDays: filter.days } : {}) };
}

/** Одна строка ленты из записи и того, что база нашла к ней: решение и «было» из горячего намерения */
export function feedItemOf(world: StandWorld, m: Messages, item: FeedPageItem): FeedItem {
  const f = m.ui.feed;
  const { write: w, decision } = item;
  const scope = scopeById(world, w.writeScopeId);
  // «Было»: горячий intent (3 дня) или слепок объяснения решения [Р-68]; у NO_OP слепка нет, но NO_OP не пишет в канал
  const from = item.intentCurrentMinor ?? (decision ? explanationOf(world, decision)?.value.strategy.currentMinor ?? null : null);
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
}

/**
 * Р-154: страницу, итог и счётчики групп отдаёт база (`feedPage`); здесь — только строки показанного. До шага 35 лента
 * фильтровала и сортировала все записи тенанта в памяти на каждый запрос.
 */
export function priceFeed(world: StandWorld, m: Messages, filter: FeedQuery, page: FeedPage, query: FeedPageQuery): PriceFeedView {
  const f = m.ui.feed;
  const items = page.items.map((i) => feedItemOf(world, m, i));
  const from = page.total === 0 ? 0 : query.offset + 1;
  const to = query.offset + items.length;
  return {
    worldId: world.id, items,
    // Счётчики — по офферу и периоду без фильтра статуса: сколько в каждой группе
    counts: { applied: page.counts.APPLIED, inFlight: page.counts.IN_FLIGHT, notSent: page.counts.NOT_SENT, superseded: page.counts.SUPERSEDED },
    query: { writeScopeId: filter.writeScopeId ?? null, status: filter.status ?? null, days: filter.days ?? null, offset: query.offset, limit: query.limit },
    page: { from, to, total: page.total, text: f.page(from, to, page.total), hasPrevious: query.offset > 0, hasNext: to < page.total },
    // Р-136: фильтр по офферу показывает первые N — на каталоге целевого клиента список фильтра сам весил мегабайты
    offers: world.state.scopes.slice(0, OFFER_CHOICES).map((s) => unitOf(world, s, m)),
    offersTotal: world.state.scopes.length,
    gaps: [gap(m, 'FEED_WINDOW'), gap(m, 'PRICE_HISTORY_NOT_READ')],
  };
}
