import type { ChannelError, Instant, WriteOutcome, WriteValue } from '@repracer/channel-port';
import { sellerActionFor, type Reason } from '@repracer/pricing-model';

/**
 * Правила перехода записи по итогу канала и по сверке [Р-64]. Чистые функции: одно и то же решение принимают хранилище
 * на PostgreSQL и двойник в памяти. Класс ошибки определяет реакцию ядра, а не адаптера (channel-port/errors.ts).
 */

export interface RetryPolicy {
  /** Попыток отправки одной версии, включая первую */
  maxAttempts: number;
  /** Пауза перед повтором после временной ошибки: удваивается с каждой попыткой, не больше maxBackoffMs */
  backoffMs: number;
  maxBackoffMs: number;
  /** Через сколько сверять запись с неизвестным итогом обратным чтением */
  reconcileAfterMs: number;
  /** Запись в полёте без итога и без срока сверки дольше этого — сверка (процесс упал между захватом и итогом) */
  inFlightTimeoutMs: number;
  /** Асинхронный канал принял запись, но не применил её дольше этого — NOT_APPLIED */
  confirmationTimeoutMs: number;
  /**
   * Итог записи неизвестен (обратное чтение не отвечает) дольше этого — сверка прекращается, единица записи блокируется до
   * разбора человеком, поднимается один CRITICAL-алерт (D1 ретроспективного ревью шага 14). Значение — допущение (проверить).
   */
  unresolvedOutcomeLimitMs: number;
}

/** Значения по умолчанию — допущение до замеров задержек каналов (Р-8: p95 Kaufland < 2 мин) */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 5,
  backoffMs: 2_000,
  maxBackoffMs: 300_000,
  reconcileAfterMs: 30_000,
  inFlightTimeoutMs: 120_000,
  confirmationTimeoutMs: 3_600_000,
  unresolvedOutcomeLimitMs: 3_600_000,
};

export type WriteReason = Reason<string>;

export type OutcomeTransition =
  /** ACCEPTED; applied — сразу APPLIED */
  | { to: 'ACCEPTED'; applied: boolean; reason: WriteReason | null }
  /** FAILED со сроком следующей попытки той же версии */
  | { to: 'RETRY'; errorCode: string; nextAttemptAt: Instant; reason: WriteReason }
  /** Остаётся в полёте, сверка обратным чтением к сроку */
  | { to: 'RECONCILE'; errorCode: string; nextAttemptAt: Instant }
  /** FAILED → DISCARDED_STALE с причиной */
  | { to: 'DISCARD'; errorCode: string; reason: WriteReason }
  | { to: 'BUDGET_EXHAUSTED'; errorCode: string; reason: WriteReason }
  /** FAILED без срока, единица записи BLOCKED до разбора человеком (INV-14) */
  | { to: 'BLOCK_SCOPE'; errorCode: string; reason: WriteReason }
  /** Асинхронный канал так и не применил принятую запись */
  | { to: 'NOT_APPLIED'; reason: WriteReason }
  /** Итог так и не узнан: сверка прекращается, единица BLOCKED; запись остаётся в своём статусе (DISPATCHED → FAILED без срока) */
  | { to: 'UNRESOLVED'; errorCode: string; reason: WriteReason };

const at = (now: Instant, ms: number): Instant => new Date(Date.parse(now) + ms).toISOString();

export function backoffMs(policy: RetryPolicy, attemptNo: number): number {
  return Math.min(policy.maxBackoffMs, policy.backoffMs * 2 ** Math.max(0, attemptNo - 1));
}

export function planOutcomeTransition(outcome: WriteOutcome, attemptNo: number, now: Instant, policy: RetryPolicy): OutcomeTransition {
  if (outcome.status === 'ACCEPTED') return { to: 'ACCEPTED', applied: outcome.appliedImmediately, reason: null };
  // Запрос мог дойти до канала: повтор вслепую запрещён, сначала обратное чтение
  if (outcome.status === 'OUTCOME_UNKNOWN') return { to: 'RECONCILE', errorCode: outcome.error.code, nextAttemptAt: at(now, policy.reconcileAfterMs) };
  return planFailure(outcome.error, attemptNo, now, policy);
}

function planFailure(error: ChannelError, attemptNo: number, now: Instant, policy: RetryPolicy): OutcomeTransition {
  if (error.code === 'EDIT_BUDGET_EXHAUSTED') {
    // Канал сообщил об исчерпании; когда бюджет обновится — из ответа канала, если он его дал (Р-19, Р-65)
    return { to: 'BUDGET_EXHAUSTED', errorCode: error.code, reason: { code: 'WRITE_EDIT_BUDGET_EXHAUSTED', params: { source: 'CHANNEL', resetsAt: error.retryAt ?? null } } };
  }
  if (error.class === 'REQUIRES_HUMAN') {
    return { to: 'BLOCK_SCOPE', errorCode: error.code, reason: { code: 'WRITE_SCOPE_BLOCKED', params: { code: error.code, action: sellerActionFor(error.code) } } };
  }
  if (error.class === 'PERMANENT') return { to: 'DISCARD', errorCode: error.code, reason: channelRefusal(error) };
  if (attemptNo >= policy.maxAttempts) {
    return { to: 'DISCARD', errorCode: error.code, reason: { code: 'WRITE_RETRIES_EXHAUSTED', params: { attempts: attemptNo, code: error.code } } };
  }
  const earliest = Date.parse(at(now, backoffMs(policy, attemptNo)));
  const retryAt = error.retryAt && Date.parse(error.retryAt) > earliest ? error.retryAt : new Date(earliest).toISOString();
  return { to: 'RETRY', errorCode: error.code, nextAttemptAt: retryAt, reason: { code: 'WRITE_RETRY_SCHEDULED', params: { code: error.code, attempt: attemptNo + 1, at: retryAt } } };
}

/** Отказ канала: код, класс и идентификатор ошибки канала; текст ответа не хранится [Р-17] */
export function channelRefusal(error: ChannelError): WriteReason {
  return {
    code: 'WRITE_NOT_ACCEPTED_BY_CHANNEL',
    params: {
      status: error.code, errorClass: error.class,
      ...(error.httpStatus !== undefined ? { httpStatus: error.httpStatus } : {}),
      ...(error.channelCode ? { channelCode: error.channelCode.slice(0, 200) } : {}),
    },
  };
}

export type Reconciliation =
  | { kind: 'APPLIED' }
  | { kind: 'NOT_APPLIED'; observedMinor: number | null }
  | { kind: 'UNKNOWN'; error: ChannelError | null };

export function planReconciliationTransition(
  status: 'DISPATCHED' | 'ACCEPTED', result: Reconciliation, attemptNo: number, inFlightSince: Instant, now: Instant, policy: RetryPolicy,
): OutcomeTransition {
  if (result.kind === 'APPLIED') return { to: 'ACCEPTED', applied: true, reason: { code: 'WRITE_OUTCOME_RECONCILED', params: { result: 'APPLIED' } } };
  if (result.kind === 'NOT_APPLIED') {
    if (status === 'DISPATCHED') {
      // Канал значение не получил: та же версия отправляется снова (попытка расходует бюджет правок, Р-19)
      if (attemptNo >= policy.maxAttempts) {
        return { to: 'DISCARD', errorCode: 'NOT_APPLIED', reason: { code: 'WRITE_RETRIES_EXHAUSTED', params: { attempts: attemptNo, code: 'NOT_APPLIED' } } };
      }
      return { to: 'RETRY', errorCode: 'NOT_APPLIED', nextAttemptAt: now, reason: { code: 'WRITE_OUTCOME_RECONCILED', params: { result: 'NOT_APPLIED' } } };
    }
    // Асинхронный канал принял запись и применяет её сам — ждём до предела подтверждения
    if (Date.parse(now) - Date.parse(inFlightSince) > policy.confirmationTimeoutMs) {
      return { to: 'NOT_APPLIED', reason: { code: 'WRITE_OUTCOME_RECONCILED', params: { result: 'NOT_APPLIED' } } };
    }
  }
  // Р-115 (шаг 22): обратное чтение отказало ошибкой «нужен человек» (у оффера правило автоматического ценообразования канала или
  // границы канала) — сверку не повторять час, единица блокируется сразу с кодом канала; принятая запись остаётся принятой
  if (result.kind === 'UNKNOWN' && result.error?.class === 'REQUIRES_HUMAN') {
    const code = result.error.code;
    return { to: 'UNRESOLVED', errorCode: code, reason: { code: 'WRITE_SCOPE_BLOCKED', params: { code, action: sellerActionFor(code) } } };
  }
  // D1: неизвестный итог не сверяется бесконечно и молча — после предела единица блокируется, человек разбирает
  if (result.kind === 'UNKNOWN' && Date.parse(now) - Date.parse(inFlightSince) > policy.unresolvedOutcomeLimitMs) {
    return { to: 'UNRESOLVED', errorCode: 'OUTCOME_UNRESOLVED', reason: { code: 'WRITE_SCOPE_BLOCKED', params: { code: 'OUTCOME_UNRESOLVED', action: sellerActionFor('OUTCOME_UNRESOLVED') } } };
  }
  const errorCode = result.kind === 'UNKNOWN' ? (result.error?.code ?? 'UNKNOWN') : 'NOT_APPLIED_YET';
  return { to: 'RECONCILE', errorCode, nextAttemptAt: at(now, Math.max(policy.reconcileAfterMs, backoffMs(policy, attemptNo))) };
}

/** Совпадает ли наблюдаемое значение с отправленным (сверка неизвестного итога) */
export function sameWriteValue(observed: WriteValue, written: WriteValue): boolean {
  if (observed.field !== written.field) return false;
  if (observed.field === 'PRICE' && written.field === 'PRICE') {
    return observed.price.amountMinor === written.price.amountMinor && observed.price.currency === written.price.currency;
  }
  if (observed.field === 'QUANTITY' && written.field === 'QUANTITY') return observed.quantity === written.quantity;
  if (observed.field === 'CHANNEL_MIN_PRICE' && written.field === 'CHANNEL_MIN_PRICE') {
    return observed.minPrice.amountMinor === written.minPrice.amountMinor && observed.minPrice.currency === written.minPrice.currency;
  }
  return false;
}

/** Ошибка, которую ядро назначает само, когда адаптер не дал ответа по записи */
export function coreError(code: ChannelError['code'], klass: ChannelError['class'], message: string): ChannelError {
  return { class: klass, code, scope: 'ITEM', message, raiseAlert: false };
}
