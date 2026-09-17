import type { CompetitorQuery, CompetitorSnapshot, CompetitorSourceDescriptor, Instant } from '@repracer/channel-port';
import type { ReconciliationCompared } from './store.ts';

/**
 * Р-121 (шаг 24): ярусный опрос — обязательный дублирующий контур уведомлений. Пропуск уведомления канал не выдаёт (номеров
 * последовательности нет, риск 21), поэтому опрос сравнивается с последним принятым состоянием товара: расхождение — проверка потери
 * со сроком, вердикт ставит база (0088).
 *
 * Сверяется то, о чём канал обязан уведомить, и только если это есть в обоих источниках: Buy Box — когда его дают и уведомление, и опрос
 * (Kaufland buy_box_changed и GET /buybox), иначе наименьшая цена конкурента (Amazon: ANY_OFFER_CHANGED — изменения топ-20 предложений,
 * getCompetitiveSummary — наименьшие предложения без победителя Buy Box, AMZ_C11).
 */

/** Срок уведомления после опроса по умолчанию. Задержка buy_box_changed (K-10) и ANY_OFFER_CHANGED (A-08) не документирована — консервативно */
export const DEFAULT_LOSS_GRACE_SECONDS = 900;

export interface HeldState { observedAt: Instant; buyboxMinor: number | null; lowestMinor: number | null }

export function comparedValue(push: CompetitorSourceDescriptor | undefined, poll: CompetitorSourceDescriptor | undefined): ReconciliationCompared {
  return push?.hasBuyboxWinner && poll?.hasBuyboxWinner ? 'BUYBOX' : 'LOWEST_COMPETITOR';
}

/** Те же значения, что у последнего принятого состояния (competitor_state): Buy Box — со своим, наименьшая — без своих предложений */
export function snapshotDigest(snapshot: CompetitorSnapshot): { buyboxMinor: number | null; lowestMinor: number | null } {
  const competitors = snapshot.offers.filter((o) => !o.isSelf).map((o) => o.price.amountMinor);
  return { buyboxMinor: snapshot.buybox?.price.amountMinor ?? null, lowestMinor: competitors.length ? Math.min(...competitors) : null };
}

export type ReconciliationOutcome =
  | { kind: 'MATCH' }
  /** Прежнего состояния нет: сравнивать не с чем */
  | { kind: 'NO_BASELINE' }
  /** Опрос не новее прежнего состояния: уведомление пришло во время опроса */
  | { kind: 'NOT_NEWER' }
  | { kind: 'DIVERGED'; heldMinor: number | null; pollMinor: number | null };

export function reconcile(held: HeldState | null, snapshot: CompetitorSnapshot, compared: ReconciliationCompared): ReconciliationOutcome {
  if (!held) return { kind: 'NO_BASELINE' };
  if (Date.parse(snapshot.observedAt) <= Date.parse(held.observedAt)) return { kind: 'NOT_NEWER' };
  const poll = snapshotDigest(snapshot);
  const heldMinor = compared === 'BUYBOX' ? held.buyboxMinor : held.lowestMinor;
  const pollMinor = compared === 'BUYBOX' ? poll.buyboxMinor : poll.lowestMinor;
  return heldMinor === pollMinor ? { kind: 'MATCH' } : { kind: 'DIVERGED', heldMinor, pollMinor };
}

/**
 * Сверка по кругу: товары в постоянном порядке, окно из size со сдвигом на номер вызова, который ведёт вызывающий (по часам окно
 * зависело от частоты вызова и пропускало товары — ревью шага 24, находка 9). Все товары проходят за ceil(n / size) вызовов подряд;
 * одинаково в памяти и на PostgreSQL
 */
export function rotation(items: readonly CompetitorQuery[], size: number, cycle: number): CompetitorQuery[] {
  const sorted = [...items].sort((a, b) => cmp(a.marketplace, b.marketplace) || cmp(a.channelProductRef, b.channelProductRef) || cmp(a.condition, b.condition));
  const n = sorted.length;
  if (n === 0 || size <= 0) return [];
  const start = ((Math.floor(cycle) % n) * Math.min(size, n)) % n;
  return Array.from({ length: Math.min(size, n) }, (_, i) => sorted[(start + i) % n]!);
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
