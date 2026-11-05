import type { Instant, ListingStatusFacts, ListingStatusObservation } from '@repracer/channel-port';

/**
 * Шаг 114: одно правило наблюдения «статус и проблемы листинга» у хранилища в памяти и на PostgreSQL — что записать и когда включённое
 * предложение «перестало продаваться». Источники три: уведомление, обратное чтение после записи, обнаружение каталога.
 *  - Уведомление — событие канала: записывается всегда (повтор того же уведомления отсекает журнал обработанных и уникальность базы).
 *  - Чтение и обнаружение — опрос: строка пишется, только когда состояние названной части изменилось. Иначе круг обнаружения писал бы
 *    строку на каждое предложение каждые сутки, а 18 месяцев истории [Р-3] — это сотни строк неизменного состояния на предложение.
 *  - «Перестало продаваться» — новое наблюдение статуса не позже прежнего по времени события говорит «не покупается», а прежний известный
 *    статус — «покупается» или его не было. Опоздавшее уведомление (старше записанного) в журнал ложится, перехода не даёт.
 */
export interface LatestPart<T> { value: T; observedAt: Instant }
export interface LatestListingState {
  status: LatestPart<NonNullable<ListingStatusFacts['status']>> | null;
  issues: LatestPart<NonNullable<ListingStatusFacts['issues']>> | null;
}

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);
const sameStatus = (a: NonNullable<ListingStatusFacts['status']>, b: NonNullable<ListingStatusFacts['status']>) =>
  a.buyable === b.buyable && a.discoverable === b.discoverable && a.deleted === b.deleted;
const sameIssues = (a: NonNullable<ListingStatusFacts['issues']>, b: NonNullable<ListingStatusFacts['issues']>) =>
  sameList(a.severities, b.severities) && sameList(a.enforcementActions, b.enforcementActions);

export function listingStatusStep(o: ListingStatusObservation, latest: LatestListingState): { write: boolean; lostBuyable: boolean } {
  const unchanged = (o.status === null || (latest.status !== null && sameStatus(o.status, latest.status.value)))
    && (o.issues === null || (latest.issues !== null && sameIssues(o.issues, latest.issues.value)));
  const write = o.source === 'NOTIFICATION' || !unchanged;
  const lostBuyable = write && o.status !== null && !o.status.buyable
    && (latest.status === null || (Date.parse(o.observedAt) >= Date.parse(latest.status.observedAt) && latest.status.value.buyable));
  return { write, lostBuyable };
}

/** Шаг 114: CRITICAL владельцу — включённое предложение перестало продаваться в канале (часть A-30: листинг деактивирован) */
export function listingNotBuyableAlerts(lost: ReadonlyArray<{ marketplace: string; externalSku: string }>) {
  return lost.map((l) => ({ kind: 'alert' as const, code: 'LISTING_NOT_BUYABLE', severity: 'CRITICAL' as const, details: { marketplace: l.marketplace, externalSku: l.externalSku } }));
}
