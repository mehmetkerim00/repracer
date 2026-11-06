import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChannelAccountId, TenantId } from '@repracer/channel-port';
import { createAmazonAdapter } from '../src/index.ts';

/**
 * Шаг 115 [Р-240]: getCompetitiveSummary — источник решений. Снимок несёт цену и держателя Buy Box, которые называет `featuredBuyingOptions`:
 * держатель — продавец большинства просмотров [Р-235], цена — его предложения в группах; большинства нет — цена самой большой группы и
 * держатель неизвестен. Форма тел — настоящий ответ песочницы (docs/evidence/step108-sp-api-recon-exchanges.json), идентификаторы синтетические
 */
const US = 'ATVPDKIKX0DER';
const NOW = '2026-11-06T10:00:00.000Z';
const SELLER = 'SYN_SELLER';
const OTHER = 'SYN_OTHER_A';
const THIRD = 'SYN_OTHER_B';
const ASIN = 'B0SYN00115';
const ctx = { tenantId: '10000000-0000-4000-8000-000000000001' as TenantId, channelAccountId: '20000000-0000-4000-8000-000000000001' as ChannelAccountId, correlationId: 'unit', deadline: '2026-11-06T11:00:00.000Z' };
const query = { marketplace: US, channelProductRef: ASIN, condition: 'new' };

const usd = (amount: number) => ({ amount, currencyCode: 'USD' });
const offer = (sellerId: string, amount: number, over: Record<string, unknown> = {}) => ({
  sellerId, condition: 'New', subCondition: 'New', fulfillmentType: 'MFN', listingPrice: usd(amount), shippingOptions: [{ shippingOptionType: 'DEFAULT', price: usd(2.5) }], ...over,
});
const featured = (sellerId: string, amount: number, shares: Array<[string, number]>, over: Record<string, unknown> = {}) => ({
  ...offer(sellerId, amount, over),
  featuredOfferSegments: shares.map(([customerMembership, glanceViewWeightPercentage]) => ({ customerMembership, segmentDetails: { glanceViewWeightPercentage } })),
});
const summary = (body: Record<string, unknown>) => ({
  responses: [{ status: { statusCode: 200, reasonPhrase: 'Success' }, body: { asin: ASIN, marketplaceId: US, ...body } }],
});
const lowest = (...offers: unknown[]) => [{ lowestPricedOffersInput: { itemCondition: 'New', offerType: 'Consumer' }, offers }];
const options = (...segmentedFeaturedOffers: unknown[]) => [{ buyingOptionType: 'New', segmentedFeaturedOffers }];

function harness(reply: () => { status: number; body: unknown }) {
  const calls: string[] = [];
  let ticks = 0;
  const fetchFn = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname === '/auth/o2/token') return new Response(JSON.stringify({ access_token: 'syn-lwa-access-token', expires_in: 3600 }), { status: 200 });
    calls.push(url.pathname);
    const r = reply();
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const adapter = createAmazonAdapter({
    deps: {
      accounts: { verify: async (tenantId, channelAccountId) => ({ ok: true, account: { tenantId, channelAccountId, channel: 'AMAZON', externalAccountId: SELLER, region: 'NA', marketplaces: [US], credentialsRef: 'cred:seller' } }) },
      credentials: { get: async (ref): Promise<Record<string, string>> => (ref === 'cred:seller' ? { refreshToken: 'syn-refresh' } : { clientId: 'syn-client', clientSecret: 'syn-secret' }) },
      alerts: { raise: async () => {} },
      logger: { log: () => {} },
      now: () => new Date(Date.parse(NOW) + (ticks += 1_000)).toISOString(),
    },
    userAgent: 'repracer-test/1.0', applicationCredentialsRef: 'cred:app', fetch: fetchFn, endpoints: { NA: 'https://sp-api.invalid' }, timeoutMs: 1000,
    sleep: async () => {},
  });
  return { adapter, calls };
}

async function read(body: Record<string, unknown>) {
  const { adapter } = harness(() => ({ status: 200, body: summary(body) }));
  const r = await adapter.readCompetitors(ctx, [query]);
  assert.deepEqual(r.failures, []);
  return r.snapshots[0]!;
}

test('step 115 [Р-240]: the seller with most of the views holds the Buy Box — its price and shipping, by name, and its offer is marked', async () => {
  const s = await read({
    featuredBuyingOptions: options(featured(OTHER, 18.11, [['NON_PRIME', 72], ['PRIME', 10]]), featured(THIRD, 17.15, [['NON_PRIME', 18]])),
    lowestPricedOffers: lowest(offer(THIRD, 17.15), offer(OTHER, 18.11)),
  });
  assert.deepEqual(s.buybox, { price: { amountMinor: 1811, currency: 'USD', basis: 'NET' }, shipping: { amountMinor: 250, currency: 'USD', basis: 'NET' }, isSelf: false, sellerRef: OTHER });
  assert.deepEqual(s.offers.map((o) => [o.sellerRef, o.holdsBuyBox ?? false]), [[THIRD, false], [OTHER, true]]);
  assert.equal(s.source, 'AMAZON_COMPETITIVE_SUMMARY');
});

test('step 115 [Р-240]: most of the views are ours — the Buy Box is ours, with no seller name', async () => {
  const s = await read({
    featuredBuyingOptions: options(featured(SELLER, 16.5, [['NON_PRIME', 60], ['DEFAULT', 5]]), featured(OTHER, 18, [['PRIME', 35]])),
    lowestPricedOffers: lowest(offer(SELLER, 16.5), offer(OTHER, 18)),
  });
  assert.deepEqual(s.buybox, { price: { amountMinor: 1650, currency: 'USD', basis: 'NET' }, shipping: { amountMinor: 250, currency: 'USD', basis: 'NET' }, isSelf: true });
  assert.equal(s.offers.find((o) => o.isSelf)?.holdsBuyBox, true);
});

test('step 115 [Р-235, Р-240]: nobody has most of the views — the price of the largest group, the holder unknown, no offer marked', async () => {
  const s = await read({
    featuredBuyingOptions: options(featured(OTHER, 18, [['NON_PRIME', 45]]), featured(THIRD, 19, [['PRIME', 40]]), featured(SELLER, 20, [['DEFAULT', 15]])),
    lowestPricedOffers: lowest(offer(OTHER, 18), offer(THIRD, 19), offer(SELLER, 20)),
  });
  assert.deepEqual(s.buybox, { price: { amountMinor: 1800, currency: 'USD', basis: 'NET' }, shipping: { amountMinor: 250, currency: 'USD', basis: 'NET' }, isSelf: null });
  assert.deepEqual(s.offers.filter((o) => o.holdsBuyBox).length, 0);
});

test('step 115 [Р-240]: no featured offer in the answer — no Buy Box in the snapshot; a featured group without a share never names a holder', async () => {
  const none = await read({ lowestPricedOffers: lowest(offer(OTHER, 18)) });
  assert.equal(none.buybox, undefined);
  const noShare = await read({
    featuredBuyingOptions: options({ ...offer(OTHER, 18), featuredOfferSegments: [{ customerMembership: 'NON_PRIME', segmentDetails: {} }] }),
    lowestPricedOffers: lowest(offer(OTHER, 18)),
  });
  assert.deepEqual(noShare.buybox, { price: { amountMinor: 1800, currency: 'USD', basis: 'NET' }, shipping: { amountMinor: 250, currency: 'USD', basis: 'NET' }, isSelf: null });
});

test('step 115 [Р-240]: the holder outside the lowest offers is added to the offers — the strategy compares with it by shipping and fulfilment', async () => {
  const s = await read({
    featuredBuyingOptions: options(featured(OTHER, 21, [['NON_PRIME', 90]], { fulfillmentType: 'AFN' })),
    lowestPricedOffers: lowest(offer(THIRD, 17)),
  });
  assert.deepEqual(s.offers.map((o) => [o.sellerRef, o.price.amountMinor, o.fulfillment, o.holdsBuyBox ?? false]), [[THIRD, 1700, 'MFN', false], [OTHER, 2100, 'AFN', true]]);
  assert.deepEqual(s.completeness, { kind: 'TOP_N', n: 2 });
});

test('step 115 [Р-226]: fulfilment is what the channel named — an unknown value stays unknown instead of becoming MFN', async () => {
  const s = await read({ lowestPricedOffers: lowest(offer(OTHER, 18, { fulfillmentType: 'AFN' }), offer(THIRD, 19, { fulfillmentType: 'SOMETHING_NEW' }), offer('SYN_OTHER_C', 20)) });
  assert.deepEqual(s.offers.map((o) => o.fulfillment), ['AFN', undefined, 'MFN']);
});

test('step 115 [Р-240]: 429 is not retried within the call — one request, the whole batch answers RATE_LIMITED: at 0.033 rps a retry only spends the next window', async () => {
  const { adapter, calls } = harness(() => ({ status: 429, body: { errors: [{ code: 'QuotaExceeded', message: 'You exceeded your quota for the requested resource.' }] } }));
  const r = await adapter.readCompetitors(ctx, [query]);
  assert.equal(calls.length, 1);
  assert.deepEqual(r.snapshots, []);
  assert.equal(r.failures[0]?.error.code, 'RATE_LIMITED');
  assert.equal(r.failures[0]?.error.scope, 'BATCH');
});
