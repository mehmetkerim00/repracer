import type {
  AdapterCallContext,
  ReportHandle,
  ReportStatus,
  SubscriptionSpec,
  SubscriptionState,
} from '@repracer/channel-port';
import { logConservative } from './conservative.ts';
import { KAUFLAND_STOREFRONTS } from './descriptor.ts';
import { ChannelCallError, channelError, classifyTransportFailure } from './errors.ts';
import { acquireBudget, nowMs, openSession, type KauflandAdapterOptions } from './session.ts';

/** Перечень event_name подписок в спецификации 2.44.0; остальные события — только в документации [KFL_C17, K-18] */
const SPEC_EVENTS = new Set(['order_new', 'order_unit_new', 'order_unit_status_changed', 'item_changed', 'category_changed', 'return_new']);

interface ChannelSubscription {
  id_subscription?: number;
  callback_url?: string;
  fallback_email?: string;
  event_name?: string;
  is_active?: boolean;
  storefront?: string;
}

/** GET /subscriptions: limit не больше 30 (спецификация 2.44.0) */
const PAGE = 30;

/**
 * Привести подписки к желаемым: одна подписка на (событие, витрина). Совпадающая — оставить; отличающаяся адресом
 * или выключенная — PATCH (канал заново проверит адрес); отсутствующая — POST. Лишние подписки не удаляются.
 * Адрес вебхука содержит токен аккаунта [Р-40] и в журнал не пишется.
 */
export async function ensureSubscriptionsKaufland(
  options: KauflandAdapterOptions, ctx: AdapterCallContext, desired: readonly SubscriptionSpec[],
): Promise<SubscriptionState[]> {
  const opened = await openSession(options, ctx);
  if (!opened.ok) return desired.map((spec) => ({ spec, channelSubscriptionId: '', active: false, error: opened.error }));
  const { session } = opened;
  const states: SubscriptionState[] = [];

  const existingByStorefront = new Map<string, ChannelSubscription[] | { error: ReturnType<typeof channelError> }>();
  const listStorefront = async (storefront: string) => {
    const all: ChannelSubscription[] = [];
    for (let offset = 0; ; offset += PAGE) {
      const budgetError = acquireBudget(options, ctx, session, 1);
      if (budgetError) return { error: budgetError };
      const result = await session.client.request('get', '/subscriptions', { query: { storefront, limit: PAGE, offset } as never });
      if (!result.ok) return { error: classifyTransportFailure(result, 'ACCOUNT', nowMs(options)) };
      const data = result.data as unknown;
      const rows = (Array.isArray(data) ? data : (data as { data?: ChannelSubscription[] } | undefined)?.data ?? []) as ChannelSubscription[];
      all.push(...rows);
      if (rows.length < PAGE) return all;
    }
  };

  for (const spec of desired) {
    const storefront = spec.marketplace ?? '';
    const fail = (error: ReturnType<typeof channelError>, id = ''): void => {
      states.push({ spec, channelSubscriptionId: id, active: false, error });
    };
    if (!(KAUFLAND_STOREFRONTS as readonly string[]).includes(storefront) || !session.account.marketplaces.includes(storefront)) {
      fail(channelError('PRECONDITION_FAILED', 'ITEM', `subscription storefront ${storefront || '(none)'} is not enabled`));
      continue;
    }
    if (!/^https:\/\//.test(spec.callbackUrl) || spec.callbackUrl.length > 255) {
      fail(channelError('VALIDATION', 'ITEM', 'callback_url must be https and at most 255 characters'));
      continue;
    }
    if (spec.event === 'buy_box_changed' && (options.buyBoxChangedAccess ?? 'NOT_GRANTED') !== 'GRANTED') {
      options.deps.logger.log({
        level: 'INFO', code: 'KFL_BUYBOX_EARLY_ACCESS_NOT_GRANTED', message: 'buy_box_changed is early access; subscription is not attempted (Р-45)',
        correlationId: ctx.correlationId, tenantId: ctx.tenantId, channelAccountId: ctx.channelAccountId, details: { storefront },
      });
      fail(channelError('PRECONDITION_FAILED', 'ITEM', 'buy_box_changed early access is not granted by the account manager (Р-45)', { raiseAlert: false }));
      continue;
    }
    if (!existingByStorefront.has(storefront)) existingByStorefront.set(storefront, await listStorefront(storefront));
    const existing = existingByStorefront.get(storefront)!;
    if (!Array.isArray(existing)) { fail(existing.error); continue; }

    const match = existing.find((s) => s.event_name === spec.event && (s.storefront ?? storefront) === storefront);
    if (match && match.callback_url === spec.callbackUrl && match.is_active === true) {
      states.push({ spec, channelSubscriptionId: String(match.id_subscription ?? ''), active: true });
      continue;
    }
    if (!SPEC_EVENTS.has(spec.event)) logConservative(options.deps.logger, ctx, 'KFL_C17_SUBSCRIPTION_EVENT_NOT_IN_SPEC', { event: spec.event, storefront });

    const budgetError = acquireBudget(options, ctx, session, 1);
    if (budgetError) { fail(budgetError, String(match?.id_subscription ?? '')); continue; }
    const body = { callback_url: spec.callbackUrl, fallback_email: options.subscriptionFallbackEmail, event_name: spec.event };
    const result = match && typeof match.id_subscription === 'number'
      ? await session.client.request('patch', '/subscriptions/{id_subscription}', {
          path: { id_subscription: match.id_subscription } as never,
          body: { ...body, is_active: true, storefront } as never,
        })
      : await session.client.request('post', '/subscriptions', { query: { storefront } as never, body: body as never, idempotent: false });

    if (!result.ok) {
      const error = classifyTransportFailure(result, 'ITEM', nowMs(options));
      if (!SPEC_EVENTS.has(spec.event) && error.code === 'VALIDATION') {
        await options.deps.alerts.raise({
          code: 'KAUFLAND_SUBSCRIPTION_EVENT_REJECTED', severity: 'WARNING', tenantId: ctx.tenantId, channelAccountId: ctx.channelAccountId,
          correlationId: ctx.correlationId, details: { event: spec.event, storefront },
        });
      }
      fail(error, String(match?.id_subscription ?? ''));
      continue;
    }
    const saved = (result.data as { data?: ChannelSubscription } | undefined)?.data;
    states.push({
      spec,
      channelSubscriptionId: String(saved?.id_subscription ?? match?.id_subscription ?? ''),
      active: saved?.is_active ?? true,
    });
  }
  return states;
}

// ---------------------------------------------------------------------------
// Отчёты: competitors-comparer — только для сверки [Р-36]
// ---------------------------------------------------------------------------

export const REPORT_COMPETITORS_COMPARER = 'competitors-comparer';
const REPORT_POLL_INTERVAL_MS = 5 * 60_000;

export async function requestReportKaufland(
  options: KauflandAdapterOptions, ctx: AdapterCallContext, reportType: string, marketplace?: string,
): Promise<ReportHandle> {
  if (reportType !== REPORT_COMPETITORS_COMPARER) {
    throw new ChannelCallError(channelError('UNSUPPORTED', 'BATCH', `report ${reportType} is not supported by the Kaufland adapter`));
  }
  const opened = await openSession(options, ctx);
  if (!opened.ok) throw new ChannelCallError(opened.error);
  const { session } = opened;
  if (!marketplace || !session.account.marketplaces.includes(marketplace)) {
    throw new ChannelCallError(channelError('PRECONDITION_FAILED', 'BATCH', 'report storefront is not enabled'));
  }
  const budgetError = acquireBudget(options, ctx, session, 1);
  if (budgetError) throw new ChannelCallError(budgetError);
  const result = await session.client.request('post', '/reports/competitors-comparer', {
    query: { storefront: marketplace } as never,
    idempotent: false,
  });
  if (!result.ok) throw new ChannelCallError(classifyTransportFailure(result, 'BATCH', nowMs(options)));
  const id = (result.data as { data?: { id_report?: number } } | undefined)?.data?.id_report;
  if (!Number.isSafeInteger(id)) throw new ChannelCallError(channelError('UNKNOWN', 'BATCH', 'report request returned no id_report', { raiseAlert: true }));
  return { reportType, channelReportId: String(id), requestedAt: new Date(nowMs(options)).toISOString() };
}

export async function pollReportKaufland(
  options: KauflandAdapterOptions, ctx: AdapterCallContext, handle: ReportHandle,
): Promise<ReportStatus> {
  const opened = await openSession(options, ctx);
  if (!opened.ok) return { status: 'FAILED', error: opened.error };
  const { session } = opened;
  const checkAfter = new Date(nowMs(options) + REPORT_POLL_INTERVAL_MS).toISOString();
  if (acquireBudget(options, ctx, session, 1)) return { status: 'PENDING', checkAfter };
  const result = await session.client.request('get', '/reports/{id_report}', { path: { id_report: Number(handle.channelReportId) } as never });
  if (!result.ok) {
    const error = classifyTransportFailure(result, 'BATCH', nowMs(options));
    return error.class === 'TRANSIENT' ? { status: 'PENDING', checkAfter } : { status: 'FAILED', error };
  }
  const report = (result.data as { data?: { status?: string; url?: string } } | undefined)?.data;
  // Значения status в спецификации не перечислены: готовность определяется наличием ссылки
  if (report?.url && /^https:\/\//.test(report.url)) return { status: 'DONE', downloadUrl: report.url };
  if (report?.status && /fail|error/i.test(report.status)) {
    return { status: 'FAILED', error: channelError('UNKNOWN', 'BATCH', `report status ${report.status.slice(0, 40)}`) };
  }
  return { status: 'PENDING', checkAfter };
}
