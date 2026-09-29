import type { AdapterCallContext, ChannelError } from '@repracer/channel-port';
import { classifyHttpFailure } from './errors.ts';
import { call, nowMs, openSession, type ResolvedOptions } from './session.ts';

/**
 * Шаг 55 (OQ-240): фактические квоты eBay — Developer Analytics API, снимок vendor/ebay/2026-09-28/developer_analytics_v1_beta_oas3.json
 * [док]: `GET /developer/analytics/v1_beta/rate_limit/` — квоты ПРИЛОЖЕНИЯ (токен приложения, scope api_scope), `…/user_rate_limit/` —
 * квоты ПОЛЬЗОВАТЕЛЯ (токен продавца). Ответ — `rateLimits[]` с `apiContext`, `apiName`, `apiVersion` и `resources[].rates[]`
 * (`count`, `limit`, `remaining`, `reset`, `timeWindow`). Этим вызовом область суточной квоты Trading (приложение или пользователь, E-04)
 * и её величина ЗАМЕРЯЮТСЯ, а не угадываются. **Живьём не проверено** — боевых ключей нет; в песочнице — (проверить)
 */
export const RATE_LIMIT_PATH = '/developer/analytics/v1_beta/rate_limit/';
export const USER_RATE_LIMIT_PATH = '/developer/analytics/v1_beta/user_rate_limit/';

export interface EbayRate { count: number | null; limit: number | null; remaining: number | null; reset: string | null; timeWindow: number | null }
export interface EbayRateLimit { apiContext: string | null; apiName: string | null; apiVersion: string | null; resources: Array<{ name: string | null; rates: EbayRate[] }> }

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

export async function readRateLimitsEbay(options: ResolvedOptions, ctx: AdapterCallContext, scope: 'APPLICATION' | 'USER',
  filter: { apiContext?: string; apiName?: string } = {}): Promise<{ ok: true; limits: EbayRateLimit[] } | { ok: false; error: ChannelError }> {
  const opened = await openSession(options, ctx);
  if (!opened.ok) return opened;
  const r = await call(options, ctx, opened.session, {
    auth: scope === 'APPLICATION' ? 'APPLICATION' : 'USER', method: 'GET', path: scope === 'APPLICATION' ? RATE_LIMIT_PATH : USER_RATE_LIMIT_PATH,
    query: { ...(filter.apiContext ? { api_context: filter.apiContext } : {}), ...(filter.apiName ? { api_name: filter.apiName } : {}) },
    idempotent: true, operation: scope === 'APPLICATION' ? 'getRateLimits' : 'getUserRateLimits',
  });
  if (r.kind === 'REFUSED') return { ok: false, error: r.error };
  if (!r.result.ok) return { ok: false, error: classifyHttpFailure(r.result.status, r.result.body, 'BATCH', nowMs(options)) };
  const body = (r.result.body ?? {}) as { rateLimits?: unknown };
  const limits = (Array.isArray(body.rateLimits) ? body.rateLimits : []).map((x: Record<string, unknown>) => ({
    apiContext: str(x.apiContext), apiName: str(x.apiName), apiVersion: str(x.apiVersion),
    resources: (Array.isArray(x.resources) ? x.resources : []).map((res: Record<string, unknown>) => ({
      name: str(res.name),
      rates: (Array.isArray(res.rates) ? res.rates : []).map((rate: Record<string, unknown>) => ({
        count: num(rate.count), limit: num(rate.limit), remaining: num(rate.remaining), reset: str(rate.reset), timeWindow: num(rate.timeWindow),
      })),
    })),
  }));
  return { ok: true, limits };
}
