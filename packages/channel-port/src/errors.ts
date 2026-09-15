import type { Instant } from './primitives.ts';

/**
 * Класс ошибки определяет реакцию ядра, а не адаптера:
 *  - TRANSIENT       — повторить ту же версию записи позже (retryAt, если известно);
 *  - PERMANENT       — повтор бессмыслен: запись FAILED/DISCARDED, без повторов;
 *  - REQUIRES_HUMAN  — единица записи переводится в BLOCKED (INV-14), открывается кейс, поднимается алерт.
 */
export type ErrorClass = 'TRANSIENT' | 'PERMANENT' | 'REQUIRES_HUMAN';

export type ChannelErrorCode =
  | 'RATE_LIMITED'
  | 'CHANNEL_UNAVAILABLE'
  | 'TIMEOUT'
  | 'NETWORK'
  | 'AUTH_INVALID'
  | 'AUTH_EXPIRED'
  | 'ACCOUNT_INACTIVE'
  | 'FORBIDDEN'
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'DUPLICATE_ACTION'
  /** Запись с версией ниже другой записи той же единицы в том же плане — старое значение не отправляется (INV-03) */
  | 'STALE_VERSION'
  | 'ACTION_NOT_ALLOWED'
  | 'PRECONDITION_FAILED'
  | 'EDIT_BUDGET_EXHAUSTED'
  | 'OFFER_NOT_LIVE'
  | 'POLICY_VIOLATION'
  | 'TENANT_MISMATCH'
  | 'SIGNATURE_INVALID'
  | 'UNSUPPORTED'
  | 'UNKNOWN';

/** На что распространяется ошибка: один элемент, весь пакет или весь аккаунт (например, отозванные ключи) */
export type ErrorScope = 'ITEM' | 'BATCH' | 'ACCOUNT';

export interface ChannelError {
  class: ErrorClass;
  code: ChannelErrorCode;
  scope: ErrorScope;
  /** Не раньше этого момента повтор имеет смысл (429, бюджет правок до следующего дня, окно обслуживания) */
  retryAt?: Instant;
  /** Идентификатор ошибки канала (problem type Kaufland, код SP-API, errorId eBay) — для логов и сопоставления */
  channelCode?: string;
  httpStatus?: number;
  /** Текст для разработчика. Без PII, секретов и тел запросов. */
  message: string;
  /** Нужен ли алерт независимо от класса (Р-31: несовпадение тенанта — всегда) */
  raiseAlert: boolean;
}

/**
 * Класс по умолчанию для кода. Адаптер может отнести конкретный случай к более строгому классу
 * (TRANSIENT → PERMANENT → REQUIRES_HUMAN), но не к более мягкому.
 */
export const DEFAULT_ERROR_CLASS: Readonly<Record<ChannelErrorCode, ErrorClass>> = {
  RATE_LIMITED: 'TRANSIENT',
  CHANNEL_UNAVAILABLE: 'TRANSIENT',
  TIMEOUT: 'TRANSIENT',
  NETWORK: 'TRANSIENT',
  EDIT_BUDGET_EXHAUSTED: 'TRANSIENT',
  DUPLICATE_ACTION: 'PERMANENT',
  STALE_VERSION: 'PERMANENT',
  VALIDATION: 'PERMANENT',
  NOT_FOUND: 'PERMANENT',
  ACTION_NOT_ALLOWED: 'PERMANENT',
  UNSUPPORTED: 'PERMANENT',
  UNKNOWN: 'PERMANENT',
  AUTH_INVALID: 'REQUIRES_HUMAN',
  AUTH_EXPIRED: 'REQUIRES_HUMAN',
  ACCOUNT_INACTIVE: 'REQUIRES_HUMAN',
  FORBIDDEN: 'REQUIRES_HUMAN',
  PRECONDITION_FAILED: 'REQUIRES_HUMAN',
  OFFER_NOT_LIVE: 'REQUIRES_HUMAN',
  POLICY_VIOLATION: 'REQUIRES_HUMAN',
  TENANT_MISMATCH: 'REQUIRES_HUMAN',
  SIGNATURE_INVALID: 'REQUIRES_HUMAN',
};
