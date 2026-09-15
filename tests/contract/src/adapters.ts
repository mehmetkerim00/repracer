import { conservativeBudget, createKauflandAdapter, TokenBucketBudget } from '@repracer/kaufland-adapter';
import type { AdapterUnderTest } from './harness/runner.ts';
import { PARTNER_CREDENTIALS_REF } from './harness/world.ts';

export const KAUFLAND_BASE_URL = 'https://sellerapi.kaufland.com/v2';
export const CONTRACT_USER_AGENT = 'repracer-contract-tests/0.1';

/** Адаптер Kaufland в мире сценария: сеть — через стенд, время и паузы — виртуальные */
export const kauflandUnderTest: AdapterUnderTest = ({ deps, world, clock, fetch }) => {
  const budget = world.budget;
  return createKauflandAdapter({
    deps,
    userAgent: CONTRACT_USER_AGENT,
    subscriptionFallbackEmail: 'ops@example.invalid',
    ...(world.partner ? { partnerCredentialsRef: PARTNER_CREDENTIALS_REF } : {}),
    fetch,
    baseUrl: KAUFLAND_BASE_URL,
    sleep: clock.sleep,
    // Реальный тайм-аут короткий: сценарий TIMEOUT ждёт отмены запроса клиентом
    timeoutMs: world.client?.timeoutMs ?? 40,
    readRetry: { maxAttempts: world.client?.maxAttempts ?? 4, baseDelayMs: 500, maxDelayMs: 30_000 },
    budget: budget
      ? new TokenBucketBudget((key) => (key === 'kaufland:partner' ? budget.partner ?? { ratePerSecond: 100, burst: 100 } : budget.seller))
      : conservativeBudget(),
    ...(world.adapter?.confirmationWindowMs !== undefined ? { confirmationWindowMs: world.adapter.confirmationWindowMs } : {}),
    ...(world.adapter?.webhookMaxAgeMs !== undefined ? { webhookMaxAgeMs: world.adapter.webhookMaxAgeMs } : {}),
    ...(world.adapter?.buyBoxChangedAccess ? { buyBoxChangedAccess: world.adapter.buyBoxChangedAccess } : {}),
  });
};
