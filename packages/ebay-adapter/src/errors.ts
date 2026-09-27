import { DEFAULT_ERROR_CLASS, type ChannelError, type ChannelErrorCode, type ErrorClass, type ErrorScope } from '@repracer/channel-port';

const RANK: Record<ErrorClass, number> = { TRANSIENT: 0, PERMANENT: 1, REQUIRES_HUMAN: 2 };

export function channelError(code: ChannelErrorCode, scope: ErrorScope, message: string,
  extra: Partial<Pick<ChannelError, 'class' | 'retryAt' | 'channelCode' | 'httpStatus' | 'raiseAlert'>> = {}): ChannelError {
  const base = DEFAULT_ERROR_CLASS[code];
  const cls = extra.class && RANK[extra.class] > RANK[base] ? extra.class : base;
  return {
    class: cls, code, scope, message: message.slice(0, 300), raiseAlert: extra.raiseAlert ?? cls === 'REQUIRES_HUMAN',
    ...(extra.retryAt ? { retryAt: extra.retryAt } : {}), ...(extra.channelCode ? { channelCode: extra.channelCode } : {}),
    ...(extra.httpStatus !== undefined ? { httpStatus: extra.httpStatus } : {}),
  };
}

/** Ошибка вызова, у которого в порту нет места для ChannelError в результате (Page) */
export class ChannelCallError extends Error {
  readonly error: ChannelError;
  constructor(error: ChannelError) {
    super(`${error.code}: ${error.message}`);
    this.name = 'ChannelCallError';
    this.error = error;
  }
}

/** Ошибка REST eBay: `{errors: [{errorId, domain, category, message, parameters: [{name, value}]}]}` [песочница] */
export interface EbayRestError {
  errorId?: number;
  domain?: string;
  category?: string;
  message?: string;
  parameters?: Array<{ name?: string; value?: string }>;
}

export function firstRestError(body: unknown): EbayRestError | null {
  const errors = (body as { errors?: unknown } | null)?.errors;
  return Array.isArray(errors) && errors.length > 0 && errors[0] && typeof errors[0] === 'object' ? errors[0] as EbayRestError : null;
}

/** Текст для журнала: только идентификатор и сообщение канала; параметры — лишь безопасные имена (MinValue) */
export function describeRestError(e: EbayRestError | null, fallback: string): string {
  if (!e) return fallback;
  const min = e.parameters?.find((p) => p.name === 'MinValue')?.value;
  return `${e.errorId ?? '?'}: ${String(e.message ?? '').slice(0, 200)}${min ? ` (MinValue ${min})` : ''}`;
}

/** Сбой получения токена: к API запрос не отправлялся. Класс — по классификации channel-oauth (REVOKED/PLATFORM/TRANSIENT) */
export function tokenFailureError(failure: 'REVOKED' | 'PLATFORM' | 'TRANSIENT', code: string): ChannelError {
  if (failure === 'REVOKED') return channelError('AUTH_INVALID', 'ACCOUNT', `eBay refused the refresh token (${code}): the seller authorization is gone`, { channelCode: code });
  if (failure === 'PLATFORM') return channelError('AUTH_INVALID', 'ACCOUNT', `eBay refused our application credentials (${code})`, { channelCode: code, raiseAlert: true });
  return channelError('CHANNEL_UNAVAILABLE', 'BATCH', `eBay token endpoint unavailable (${code})`, { channelCode: code });
}

/** Отказ HTTP целиком (без ответа по элементам) — по статусу; retryAt 429 — консервативно 60 с [EBAY_C01] */
export function classifyHttpFailure(status: number | 'NETWORK_ERROR' | 'TIMEOUT', body: unknown, defaultScope: ErrorScope, nowMs: number): ChannelError {
  if (status === 'TIMEOUT') return channelError('TIMEOUT', 'BATCH', 'eBay request timed out; outcome unknown');
  if (status === 'NETWORK_ERROR') return channelError('NETWORK', 'BATCH', 'eBay request failed at transport level (connection closed)');
  const e = firstRestError(body);
  const extra = { ...(e?.errorId !== undefined ? { channelCode: String(e.errorId) } : {}), httpStatus: status };
  const message = describeRestError(e, `HTTP ${status}`);
  if (status === 400) return channelError('VALIDATION', defaultScope, message, extra);
  if (status === 401) return channelError('AUTH_EXPIRED', 'ACCOUNT', message, extra);
  if (status === 403) return channelError('FORBIDDEN', 'ACCOUNT', message, extra);
  if (status === 404) return channelError('NOT_FOUND', defaultScope, message, extra);
  if (status === 429) return channelError('RATE_LIMITED', 'BATCH', message, { ...extra, retryAt: new Date(nowMs + 60_000).toISOString() });
  if (status >= 500) return channelError('CHANNEL_UNAVAILABLE', 'BATCH', message, extra);
  return channelError('UNKNOWN', defaultScope, message, { ...extra, raiseAlert: true });
}
