import type {
  AdapterCallContext,
  AdapterDependencies,
  ChannelError,
  VerifiedChannelAccount,
} from '@repracer/channel-port';
import { createKauflandClient, type KauflandClient, type RetryPolicy } from '@repracer/kaufland-client';
import { budgetKeys, conservativeBudget, type RequestBudget } from './budget.ts';
import { logConservative } from './conservative.ts';
import { channelError } from './errors.ts';

export interface KauflandAdapterOptions {
  deps: AdapterDependencies;
  /** Имя программного решения — обязательный заголовок User-Agent */
  userAgent: string;
  /** Ссылка на ключи технологического партнёра; для SaaS обязательна */
  partnerCredentialsRef?: string;
  /** Адрес для отключённых подписок (Kaufland fallback_email): операционный ящик платформы, не PII покупателя */
  subscriptionFallbackEmail: string;
  fetch?: typeof fetch;
  budget?: RequestBudget;
  baseUrl?: string;
  timeoutMs?: number;
  readRetry?: Partial<RetryPolicy>;
  sleep?: (ms: number) => Promise<void>;
  /** Сколько ждать применения записи, прежде чем считать её не применённой [KFL_C08] */
  confirmationWindowMs?: number;
  /** Максимальный возраст Shop-Timestamp входящего уведомления [KFL_C12] */
  webhookMaxAgeMs?: number;
  /** buy_box_changed — ранний доступ у аккаунт-менеджера; без него подписка не пробуется (Р-45) */
  buyBoxChangedAccess?: 'GRANTED' | 'NOT_GRANTED';
}

export interface Session {
  account: VerifiedChannelAccount;
  client: KauflandClient;
  sellerSecretKey: string;
  budgetKeys: string[];
}

export function nowMs(options: KauflandAdapterOptions): number {
  return Date.parse(options.deps.now());
}

/**
 * Р-31: тенант и аккаунт приходят из сообщения и проверяются по каталогу до любого обращения к Kaufland.
 */
export async function openSession(
  options: KauflandAdapterOptions,
  ctx: Pick<AdapterCallContext, 'tenantId' | 'channelAccountId' | 'correlationId'>,
): Promise<{ ok: true; session: Session } | { ok: false; error: ChannelError }> {
  const { deps } = options;
  const verified = await deps.accounts.verify(ctx.tenantId, ctx.channelAccountId);
  if (!verified.ok) {
    const error = verified.reason === 'TENANT_MISMATCH'
      ? channelError('TENANT_MISMATCH', 'ACCOUNT', 'channel account does not belong to the tenant in the message', { raiseAlert: true })
      : channelError('PRECONDITION_FAILED', 'ACCOUNT', `channel account is ${verified.reason}`);
    await deps.alerts.raise({
      code: verified.reason === 'TENANT_MISMATCH' ? 'KAUFLAND_TENANT_MISMATCH' : 'KAUFLAND_ACCOUNT_UNAVAILABLE',
      severity: verified.reason === 'TENANT_MISMATCH' ? 'CRITICAL' : 'WARNING',
      tenantId: ctx.tenantId,
      channelAccountId: ctx.channelAccountId,
      correlationId: ctx.correlationId,
      details: { reason: verified.reason },
    });
    return { ok: false, error };
  }
  const account = verified.account;
  if (account.channel !== 'KAUFLAND') {
    return { ok: false, error: channelError('PRECONDITION_FAILED', 'ACCOUNT', `account channel ${account.channel} is not KAUFLAND`) };
  }

  const seller = await deps.credentials.get(account.credentialsRef);
  if (!seller.clientKey || !seller.secretKey) {
    return { ok: false, error: channelError('AUTH_INVALID', 'ACCOUNT', 'Kaufland seller credentials are incomplete') };
  }
  const partnerRef = options.partnerCredentialsRef;

  const client = createKauflandClient({
    userAgent: options.userAgent,
    sellerCredentials: async () => ({ clientKey: seller.clientKey!, secretKey: seller.secretKey! }),
    ...(partnerRef
      ? {
          partnerCredentials: async () => {
            const partner = await deps.credentials.get(partnerRef);
            return { clientKey: partner.clientKey ?? '', secretKey: partner.secretKey ?? '' };
          },
        }
      : {}),
    ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.readRetry ? { retry: options.readRetry } : {}),
    ...(options.sleep ? { sleep: options.sleep } : {}),
    now: () => nowMs(options),
  });

  return {
    ok: true,
    session: { account, client, sellerSecretKey: seller.secretKey, budgetKeys: budgetKeys(account.externalAccountId, Boolean(partnerRef)) },
  };
}

const defaultBudgets = new WeakMap<KauflandAdapterOptions, RequestBudget>();

/** Бюджет запросов [KFL_C01]: при нехватке запрос не отправляется, ошибка RATE_LIMITED с retryAt */
export function acquireBudget(
  options: KauflandAdapterOptions,
  ctx: AdapterCallContext,
  session: Session,
  cost: number,
): ChannelError | null {
  let budget = options.budget ?? defaultBudgets.get(options);
  if (!budget) {
    budget = conservativeBudget();
    defaultBudgets.set(options, budget);
  }
  const now = nowMs(options);
  const result = budget.tryAcquire(session.budgetKeys, cost, now);
  if (result.ok) return null;
  logConservative(options.deps.logger, ctx, 'KFL_C01_REQUEST_BUDGET', { exhaustedKey: result.exhaustedKey, cost });
  return channelError('RATE_LIMITED', 'BATCH', `client-side Kaufland request budget exhausted (${result.exhaustedKey})`, {
    retryAt: new Date(result.retryAtMs).toISOString(),
  });
}

export function deadlinePassed(options: KauflandAdapterOptions, ctx: AdapterCallContext): ChannelError | null {
  return Date.parse(ctx.deadline) <= nowMs(options)
    ? channelError('TIMEOUT', 'BATCH', 'call deadline passed before the request to Kaufland was sent')
    : null;
}
