import type { AdapterCallContext, AdapterDependencies, ChannelError, VerifiedChannelAccount } from '@repracer/channel-port';
import { AccessTokenCache, createSpApiClient, type RetryPolicy, type SpApiClient, type SpApiRegion, SP_API_ENDPOINTS } from '@repracer/amazon-client';
import { type AmazonRequestBudget, TwoLevelBudget } from './budget.ts';
import { logConservative } from './conservative.ts';
import type { AmazonOperation } from './descriptor.ts';
import { channelError } from './errors.ts';

export interface AmazonAdapterOptions {
  deps: AdapterDependencies;
  /** Имя и версия приложения — обязательный user-agent */
  userAgent: string;
  /** Ссылка на ключи приложения LWA (client_id, client_secret) — платформенные, общие для тенантов */
  applicationCredentialsRef: string;
  fetch?: typeof fetch;
  /** Адрес SP-API на регион (стенд подменяет); по умолчанию — страница sp-api-endpoints */
  endpoints?: Partial<Record<SpApiRegion, string>>;
  lwaUrl?: string;
  budget?: AmazonRequestBudget;
  timeoutMs?: number;
  readRetry?: Partial<RetryPolicy>;
  sleep?: (ms: number) => Promise<void>;
  /** Окно подтверждения применения [AMZ_C05, A-06] */
  confirmationWindowMs?: number;
  tokens?: AccessTokenCache;
}

export interface Session {
  account: VerifiedChannelAccount;
  region: SpApiRegion;
  sellerId: string;
  client: SpApiClient;
}

export function nowMs(options: AmazonAdapterOptions): number {
  return Date.parse(options.deps.now());
}

const tokenCaches = new WeakMap<AmazonAdapterOptions, AccessTokenCache>();
const budgets = new WeakMap<AmazonAdapterOptions, AmazonRequestBudget>();

/** Р-31: тенант и аккаунт из сообщения сверяются по каталогу до любого обращения к Amazon */
export async function openSession(options: AmazonAdapterOptions, ctx: Pick<AdapterCallContext, 'tenantId' | 'channelAccountId' | 'correlationId'>):
  Promise<{ ok: true; session: Session } | { ok: false; error: ChannelError }> {
  const { deps } = options;
  const verified = await deps.accounts.verify(ctx.tenantId, ctx.channelAccountId);
  if (!verified.ok) {
    const mismatch = verified.reason === 'TENANT_MISMATCH';
    await deps.alerts.raise({
      code: mismatch ? 'AMAZON_TENANT_MISMATCH' : 'AMAZON_ACCOUNT_UNAVAILABLE', severity: mismatch ? 'CRITICAL' : 'WARNING',
      tenantId: ctx.tenantId, channelAccountId: ctx.channelAccountId, correlationId: ctx.correlationId, details: { reason: verified.reason },
    });
    return { ok: false, error: mismatch
      ? channelError('TENANT_MISMATCH', 'ACCOUNT', 'channel account does not belong to the tenant in the message', { raiseAlert: true })
      : channelError('PRECONDITION_FAILED', 'ACCOUNT', `channel account is ${verified.reason}`) };
  }
  const account = verified.account;
  if (account.channel !== 'AMAZON') return { ok: false, error: channelError('PRECONDITION_FAILED', 'ACCOUNT', `account channel ${account.channel} is not AMAZON`) };
  const region = account.region as SpApiRegion | undefined;
  if (!region || !(region in SP_API_ENDPOINTS)) return { ok: false, error: channelError('PRECONDITION_FAILED', 'ACCOUNT', 'Amazon account has no SP-API region') };
  const seller = await deps.credentials.get(account.credentialsRef);
  const app = await deps.credentials.get(options.applicationCredentialsRef);
  if (!seller.refreshToken || !app.clientId || !app.clientSecret) {
    return { ok: false, error: channelError('AUTH_INVALID', 'ACCOUNT', 'Amazon LWA credentials are incomplete') };
  }
  let tokens = options.tokens ?? tokenCaches.get(options);
  if (!tokens) { tokens = new AccessTokenCache(); tokenCaches.set(options, tokens); }
  const client = createSpApiClient({
    region,
    // Секреты читаются при каждом получении токена: ротация без пересоздания адаптера
    credentials: async () => {
      const s = await deps.credentials.get(account.credentialsRef);
      const a = await deps.credentials.get(options.applicationCredentialsRef);
      return { refreshToken: s.refreshToken ?? '', clientId: a.clientId ?? '', clientSecret: a.clientSecret ?? '' };
    },
    userAgent: options.userAgent,
    tokens,
    ...(options.endpoints?.[region] ? { endpoint: options.endpoints[region] } : {}),
    ...(options.lwaUrl ? { lwaUrl: options.lwaUrl } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.readRetry ? { retry: options.readRetry } : {}),
    ...(options.sleep ? { sleep: options.sleep } : {}),
    now: () => nowMs(options),
  });
  return { ok: true, session: { account, region, sellerId: account.externalAccountId, client } };
}

/** Бюджет на двух уровнях [AMZ_C01]: при нехватке запрос не отправляется, RATE_LIMITED с retryAt */
export function acquire(options: AmazonAdapterOptions, ctx: AdapterCallContext, session: Session, operation: AmazonOperation): ChannelError | null {
  let budget = options.budget ?? budgets.get(options);
  if (!budget) { budget = new TwoLevelBudget(); budgets.set(options, budget); }
  const result = budget.tryAcquire(session.sellerId, operation, nowMs(options));
  if (result.ok) return null;
  logConservative(options.deps.logger, ctx, 'AMZ_C01_TWO_LEVEL_BUDGET', { operation, level: result.level });
  return channelError('RATE_LIMITED', 'BATCH', `client-side SP-API budget exhausted at the ${result.level.toLowerCase()} level for ${operation}`, {
    retryAt: new Date(result.retryAtMs).toISOString(),
  });
}

/** x-amzn-RateLimit-Limit — лимит пары аккаунт–приложение для операции [AMZ_C10] */
export function observeRateLimit(options: AmazonAdapterOptions, ctx: AdapterCallContext, session: Session, operation: AmazonOperation, headers: Headers | null): void {
  const raw = headers?.get('x-amzn-RateLimit-Limit');
  if (!raw) return;
  const rate = Number(raw);
  if (!Number.isFinite(rate) || rate <= 0) return;
  const budget = options.budget ?? budgets.get(options);
  budget?.observePairLimit(session.sellerId, operation, rate);
  logConservative(options.deps.logger, ctx, 'AMZ_C10_RATE_LIMIT_HEADER', { operation, rate });
}

export function deadlinePassed(options: AmazonAdapterOptions, ctx: AdapterCallContext): ChannelError | null {
  return Date.parse(ctx.deadline) <= nowMs(options) ? channelError('TIMEOUT', 'BATCH', 'call deadline passed before the request to Amazon was sent') : null;
}
