import { createAmazonAdapter, TwoLevelBudget } from '@repracer/amazon-adapter';
import { createEbayAdapter, RollingDayLedger, TokenBucket } from '@repracer/ebay-adapter';
import { conservativeBudget, createKauflandAdapter, TokenBucketBudget } from '@repracer/kaufland-adapter';
import type { AdapterUnderTest } from './harness/runner.ts';
import { APPLICATION_CREDENTIALS_REF, PARTNER_CREDENTIALS_REF } from './harness/world.ts';

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

/** Адаптер Amazon в мире сценария: сеть — через стенд, время и паузы — виртуальные; бюджет — на двух уровнях */
export const amazonUnderTest: AdapterUnderTest = ({ deps, world, clock, fetch }) => createAmazonAdapter({
  deps,
  userAgent: 'repracer-contract-tests/0.1 (Language=TypeScript; Platform=Node)',
  applicationCredentialsRef: APPLICATION_CREDENTIALS_REF,
  fetch,
  sleep: clock.sleep,
  timeoutMs: world.client?.timeoutMs ?? 40,
  readRetry: { maxAttempts: world.client?.maxAttempts ?? 3, baseDelayMs: 500, maxDelayMs: 20_000 },
  budget: new TwoLevelBudget({ applicationLoadRps: () => world.adapter?.amazonApplicationLoadRps ?? 0 }),
  ...(world.adapter?.confirmationWindowMs !== undefined ? { confirmationWindowMs: world.adapter.confirmationWindowMs } : {}),
});

/** Scope песочницы шага 39, при которых работает всё (E-08) */
export const EBAY_STAND_SCOPES = [
  'https://api.ebay.com/oauth/api_scope', 'https://api.ebay.com/oauth/api_scope/sell.inventory',
  'https://api.ebay.com/oauth/api_scope/sell.account', 'https://api.ebay.com/oauth/api_scope/commerce.identity.readonly',
];

/**
 * Адаптер eBay в мире сценария (шаг 39): хост — песочница, сеть — через стенд, время и паузы — виртуальные. Бюджет запросов — из мира
 * (world.budget.seller) или консервативный [EBAY_C01]; второй слой бюджета правок — с попытками, уже сделанными за сутки [EBAY_C08].
 */
export const ebayUnderTest: AdapterUnderTest = ({ deps, world, clock, fetch }) => {
  const ledger = new RollingDayLedger();
  for (const x of world.adapter?.ebayEditAttempts ?? []) ledger.preload(`ebay:${world.channelAccountId}|${x.listingId}`, x.attempts, clock.nowMs() - x.agoMs, x.field ?? 'PRICE');
  return createEbayAdapter({
    deps, environment: world.adapter?.ebayEnvironment ?? 'SANDBOX', applicationCredentialsRef: APPLICATION_CREDENTIALS_REF, scopes: EBAY_STAND_SCOPES,
    fetch, sleep: clock.sleep, timeoutMs: world.client?.timeoutMs ?? 40,
    readRetry: { maxAttempts: world.client?.maxAttempts ?? 3, baseDelayMs: 500, maxDelayMs: 20_000 },
    ...(world.budget ? { requestBudget: new TokenBucket(world.budget.seller) } : {}),
    editLedger: ledger,
    ...(world.adapter?.confirmationWindowMs !== undefined ? { confirmationWindowMs: world.adapter.confirmationWindowMs } : {}),
  });
};
