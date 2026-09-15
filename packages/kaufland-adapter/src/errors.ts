import { DEFAULT_ERROR_CLASS, type ChannelError, type ChannelErrorCode, type ErrorClass, type ErrorScope } from '@repracer/channel-port';
import type { KauflandProblem } from '@repracer/kaufland-client';

/** Сбой транспорта клиента Kaufland (KauflandResult с ok = false) */
export interface TransportFailure {
  status: number | 'NETWORK_ERROR' | 'TIMEOUT';
  problem: KauflandProblem | null;
  outcomeUnknown: boolean;
}

const CLASS_RANK: Record<ErrorClass, number> = { TRANSIENT: 0, PERMANENT: 1, REQUIRES_HUMAN: 2 };

export function channelError(
  code: ChannelErrorCode,
  scope: ErrorScope,
  message: string,
  extra: Partial<Pick<ChannelError, 'class' | 'retryAt' | 'channelCode' | 'httpStatus' | 'raiseAlert'>> = {},
): ChannelError {
  const base = DEFAULT_ERROR_CLASS[code];
  // Адаптер может сделать класс строже, но не мягче (errors.ts порта)
  const cls = extra.class && CLASS_RANK[extra.class] > CLASS_RANK[base] ? extra.class : base;
  return {
    class: cls,
    code,
    scope,
    message: message.slice(0, 300),
    raiseAlert: extra.raiseAlert ?? cls === 'REQUIRES_HUMAN',
    ...(extra.retryAt ? { retryAt: extra.retryAt } : {}),
    ...(extra.channelCode ? { channelCode: extra.channelCode } : {}),
    ...(extra.httpStatus !== undefined ? { httpStatus: extra.httpStatus } : {}),
  };
}

/** Проблемные типы Kaufland (https://sellerapi.kaufland.com/?page=error-responses) → коды порта */
const PROBLEM_TYPE_CODES: Readonly<Record<string, { code: ChannelErrorCode; scope?: ErrorScope }>> = {
  '/problems/validation-error': { code: 'VALIDATION' },
  '/problems/bad-request': { code: 'VALIDATION' },
  '/problems/missing-or-invalid-request-header': { code: 'VALIDATION', scope: 'BATCH' },
  '/problems/unauthorized': { code: 'AUTH_INVALID', scope: 'ACCOUNT' },
  '/problems/invalid-credentials': { code: 'AUTH_INVALID', scope: 'ACCOUNT' },
  '/problems/corrupted-signature': { code: 'AUTH_INVALID', scope: 'ACCOUNT' },
  '/problems/forbidden': { code: 'FORBIDDEN', scope: 'ACCOUNT' },
  '/problems/inactive-account': { code: 'ACCOUNT_INACTIVE', scope: 'ACCOUNT' },
  '/problems/not-found': { code: 'NOT_FOUND' },
  '/problems/duplicate-action': { code: 'DUPLICATE_ACTION' },
  '/problems/action-not-allowed': { code: 'ACTION_NOT_ALLOWED' },
  '/problems/storefront-not-configured': { code: 'PRECONDITION_FAILED', scope: 'ACCOUNT' },
  '/problems/server-error': { code: 'CHANNEL_UNAVAILABLE', scope: 'BATCH' },
  '/problems/service-unavailable': { code: 'CHANNEL_UNAVAILABLE', scope: 'BATCH' },
};

function codeForStatus(status: number): { code: ChannelErrorCode; scope?: ErrorScope } {
  if (status === 429) return { code: 'RATE_LIMITED', scope: 'BATCH' };
  if (status === 401) return { code: 'AUTH_INVALID', scope: 'ACCOUNT' };
  if (status === 403) return { code: 'FORBIDDEN', scope: 'ACCOUNT' };
  if (status === 404) return { code: 'NOT_FOUND' };
  if (status === 409) return { code: 'DUPLICATE_ACTION' };
  if (status === 422) return { code: 'ACTION_NOT_ALLOWED' };
  if (status === 400) return { code: 'VALIDATION' };
  if (status >= 500) return { code: 'CHANNEL_UNAVAILABLE', scope: 'BATCH' };
  return { code: 'UNKNOWN' };
}

/**
 * Классификация сбоя. Правило документации: действовать по известным problem type, для остальных — по HTTP-статусу.
 * `defaultScope` — область по умолчанию для ошибок, не относящихся ко всему аккаунту или пакету.
 */
export function classifyTransportFailure(failure: TransportFailure, defaultScope: ErrorScope, nowMs: number): ChannelError {
  if (failure.status === 'TIMEOUT') {
    return channelError('TIMEOUT', 'BATCH', 'Kaufland request timed out; outcome unknown');
  }
  if (failure.status === 'NETWORK_ERROR') {
    return channelError('NETWORK', 'BATCH', 'Kaufland request failed at transport level');
  }
  const byType = failure.problem ? PROBLEM_TYPE_CODES[failure.problem.type] : undefined;
  const mapped = byType ?? codeForStatus(failure.status);
  const scope = mapped.scope ?? defaultScope;
  const message = failure.problem?.message || `HTTP ${failure.status}`;
  const extra: Parameters<typeof channelError>[3] = { httpStatus: failure.status };
  if (failure.problem && failure.problem.type !== 'about:blank') extra.channelCode = failure.problem.type;
  if (mapped.code === 'RATE_LIMITED') extra.retryAt = new Date(nowMs + 2_000).toISOString();
  if (mapped.code === 'UNKNOWN') extra.raiseAlert = true;
  // Ошибка заголовков запроса — дефект интеграции, не данных
  if (failure.problem?.type === '/problems/missing-or-invalid-request-header') extra.raiseAlert = true;
  return channelError(mapped.code, scope, message, extra);
}

/** Строка ответа 207 (POST /units/bulk) без problem type */
export function classifyBulkItem(statusCode: number, message: string | undefined, errors: ReadonlyArray<{ field: string; message: string }>): ChannelError {
  const mapped = codeForStatus(statusCode);
  const detail = errors.length > 0 ? `${message ?? ''} ${errors.map((e) => `${e.field}: ${e.message}`).join('; ')}` : message ?? '';
  return channelError(mapped.code, mapped.scope === 'ACCOUNT' ? 'ACCOUNT' : 'ITEM', detail.trim() || `HTTP ${statusCode}`, {
    httpStatus: statusCode,
    ...(mapped.code === 'UNKNOWN' ? { raiseAlert: true } : {}),
  });
}

/** Ошибка вызова, у которого в порту нет места для ChannelError в результате (Page, ReportHandle) */
export class ChannelCallError extends Error {
  readonly error: ChannelError;
  constructor(error: ChannelError) {
    super(`${error.code}: ${error.message}`);
    this.name = 'ChannelCallError';
    this.error = error;
  }
}
