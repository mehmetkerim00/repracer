import { DEFAULT_ERROR_CLASS, type ChannelError, type ChannelErrorCode, type ErrorClass, type ErrorScope } from '@repracer/channel-port';
import type { ListingsIssue, SpApiResult } from '@repracer/amazon-client';

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

/** Сбой HTTP по статусам модели patchListingsItem/getListingsItem: 400, 403, 404, 413, 415, 429, 500, 503 */
export function classifyFailure(result: Extract<SpApiResult<unknown>, { ok: false }>, defaultScope: ErrorScope, nowMs: number): ChannelError {
  const first = result.errors[0];
  // Шаг 70 [Р-205]: `details` — в тексте ошибки (у 403 SP-API причина только в нём). Текст ошибки — журнал разработчика; у отказов обнаружения
  // и чтения заказов (ChannelCallError) он ложится и в `maintenance.scheduled_job.last_error` — экран работ панели оператора (ревью шага 70,
  // находка 8). В песочнице `details` называл только причину (нет токена, токен недействителен, витрина не того региона); значения продавца
  // в нём — (проверить) в бою: текст обрезается до 160 знаков, токенов и секретов в запросах SP-API нет — в адресе и теле их нечему отражать
  // Сообщение укорачивается до деталей: текст ошибки обрезается на 300 знаках, и длинное сообщение не должно вытеснить причину
  // Повтор сообщения в деталях (у образцов песочницы «Invalid Input» дважды) не дописывается
  const details = first?.details && first.details !== first.message ? first.details : null;
  const message = first ? `${first.code}: ${details ? `${first.message.slice(0, 120)} — ${details.slice(0, 160)}` : first.message}` : `HTTP ${String(result.status)}`;
  const extra = { ...(first?.code ? { channelCode: first.code } : {}), ...(typeof result.status === 'number' ? { httpStatus: result.status } : {}) };
  if (result.tokenFailure) {
    // Токен LWA не получен: к SP-API запрос не отправлялся. Отказ сервера токенов — отозванное согласие или ключи приложения
    // 429 сервера токенов — перегрузка, а не отказ согласия (ревью шага 22, находка 2)
    if (result.status === 429) return channelError('RATE_LIMITED', 'BATCH', 'LWA token endpoint throttled', extra);
    return typeof result.status === 'number' && result.status >= 400 && result.status < 500
      ? channelError('AUTH_INVALID', 'ACCOUNT', 'LWA refused the refresh token', extra)
      : channelError('CHANNEL_UNAVAILABLE', 'BATCH', 'LWA token endpoint unavailable', extra);
  }
  if (result.status === 'TIMEOUT') return channelError('TIMEOUT', 'BATCH', 'SP-API request timed out; outcome unknown');
  if (result.status === 'NETWORK_ERROR') return channelError('NETWORK', 'BATCH', 'SP-API request failed at transport level');
  switch (result.status) {
    case 400: return channelError('VALIDATION', defaultScope, message, extra);
    case 403: return channelError('FORBIDDEN', 'ACCOUNT', message, extra);
    case 404: return channelError('NOT_FOUND', defaultScope, message, extra);
    case 413: case 415: return channelError('VALIDATION', 'BATCH', message, { ...extra, raiseAlert: true });
    case 429: return channelError('RATE_LIMITED', 'BATCH', message, { ...extra, retryAt: new Date(nowMs + 1_000).toISOString() });
    default:
      if (result.status >= 500) return channelError('CHANNEL_UNAVAILABLE', 'BATCH', message, extra);
      return channelError('UNKNOWN', defaultScope, message, { ...extra, raiseAlert: true });
  }
}

const BOUND_ATTRIBUTES = new Set(['minimum_seller_allowed_price', 'maximum_seller_allowed_price']);

/** Ошибка отправки по issues: цена вне границ, заданных в канале, — вторые границы [Р-114], нужен человек */
export function classifyIssue(issue: ListingsIssue): ChannelError {
  if ((issue.attributeNames ?? []).some((a) => BOUND_ATTRIBUTES.has(a))) {
    return channelError('CHANNEL_BOUNDS_PRESENT', 'ITEM', `${issue.code}: ${issue.message}`, { channelCode: issue.code });
  }
  if ((issue.attributeNames ?? []).includes('automated_pricing_merchandising_rule_plan')) {
    return channelError('CHANNEL_REPRICER_ACTIVE', 'ITEM', `${issue.code}: ${issue.message}`, { channelCode: issue.code });
  }
  return channelError('VALIDATION', 'ITEM', `${issue.code}: ${issue.message}`, { channelCode: issue.code });
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
