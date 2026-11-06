import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAmazonAdapter } from '@repracer/amazon-adapter';
import type { ChannelAccountId, CompetitorQuery, TenantId } from '@repracer/channel-port';
import { SimulatedAmazonChannel, type AmazonChannelModelSpec, type SimAmazonCompetitorSpec } from './simulator/amazon-channel.ts';

/**
 * Шаг 115 [Р-240]: НАСТОЯЩИЙ адаптер и его ограничитель против HTTP-модели SP-API (лимит пары 0.033 rps, burst 1 — Usage Plan снимка; пакет до 20). Бюджет считается запросами, а не
 * товарами; лимит приложения не документирован — вариант модели (A-15) показывает, как он выглядел бы для опроса. Данные синтетические, живых ключей здесь нет: это модель, а не канал
 */
const US = 'ATVPDKIKX0DER';
const SELLER = 'SYN_SELLER_115';
const START = '2026-11-06T10:00:00.000Z';
const ctx = { tenantId: '10000000-0000-4000-8000-000000000115' as TenantId, channelAccountId: '20000000-0000-4000-8000-000000000115' as ChannelAccountId, correlationId: 'step115-http', deadline: '2026-11-06T23:00:00.000Z' };
const asinOf = (i: number) => `B0HTTP${String(i).padStart(4, '0')}`;

function harness(offers: number, rivalsOf: (i: number) => SimAmazonCompetitorSpec[], params: AmazonChannelModelSpec['params'] = {}) {
  const spec: AmazonChannelModelSpec = {
    seed: 115, sellerId: SELLER, region: 'NA', params,
    offers: Array.from({ length: offers }, (_, i) => ({ sku: `SYN-SKU-${i}`, asin: asinOf(i), marketplaces: [US], priceMinor: 1999, quantity: 3 })),
    rivals: Array.from({ length: offers }, (_, i) => rivalsOf(i)).flat(),
  };
  const model = new SimulatedAmazonChannel(spec, START, 'syn-lwa-access-token');
  let nowMs = Date.parse(START);
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const rawBody = typeof init?.body === 'string' ? init.body : '';
    const r = model.reply({ method: init?.method ?? 'GET', rawUrl: url.href, path: url.pathname, query: Object.fromEntries(url.searchParams), rawBody,
      body: rawBody.startsWith('{') ? JSON.parse(rawBody) : null, headers: {} }, nowMs);
    if ('violation' in r) throw new Error(r.violation);
    if (r.reply.kind !== 'response') throw new Error(`unexpected reply ${r.reply.kind}`);
    return new Response(JSON.stringify(r.reply.body), { status: r.reply.status, headers: r.reply.headers });
  }) as typeof fetch;
  const adapter = createAmazonAdapter({
    deps: {
      accounts: { verify: async (tenantId, channelAccountId) => ({ ok: true, account: { tenantId, channelAccountId, channel: 'AMAZON', externalAccountId: SELLER, region: 'NA', marketplaces: [US], credentialsRef: 'cred:seller' } }) },
      credentials: { get: async (ref): Promise<Record<string, string>> => (ref === 'cred:seller' ? { refreshToken: 'syn-refresh' } : { clientId: 'syn-client', clientSecret: 'syn-secret' }) },
      alerts: { raise: async () => {} }, logger: { log: () => {} }, now: () => new Date(nowMs).toISOString(),
    },
    userAgent: 'repracer-test/1.0', applicationCredentialsRef: 'cred:app', fetch: fetchFn, endpoints: { NA: 'https://sp-api.invalid' }, lwaUrl: 'https://sp-api.invalid/auth/o2/token', timeoutMs: 1000, sleep: async () => {},
  });
  const window = (from: number, size = 20): CompetitorQuery[] => Array.from({ length: size }, (_, k) => ({ marketplace: US, channelProductRef: asinOf(from + k), condition: 'new' }));
  return { adapter, model, window, advance: (ms: number) => { nowMs += ms; } };
}

const rival = (i: number, views: SimAmazonCompetitorSpec['views'] = []): SimAmazonCompetitorSpec[] => [{ asin: asinOf(i), marketplace: US, sellerId: `SYN_RIVAL_${i}`, priceMinor: 1800, shippingMinor: 250, fulfillmentType: 'AFN', views }];

test('step 115 [Р-240]: the budget counts requests, not offers — a catalog of 40 is read by two requests 31 seconds apart, the model refuses nothing', async () => {
  const { adapter, model, window, advance } = harness(40, (i) => rival(i, [{ membership: 'NON_PRIME', pct: 70 }]));
  const first = await adapter.readCompetitors(ctx, window(0));
  assert.deepEqual([first.snapshots.length, first.failures.length], [20, 0]);
  advance(31_000);
  const second = await adapter.readCompetitors(ctx, window(20));
  assert.deepEqual([second.snapshots.length, second.failures.length], [20, 0]);
  assert.deepEqual([model.stats.requests.getCompetitiveSummary, model.stats.rateLimited], [2, 0]);
  const s = first.snapshots[0]!;
  assert.deepEqual([s.buybox?.price.amountMinor, s.buybox?.isSelf, s.buybox?.sellerRef, s.offers.find((o) => o.holdsBuyBox)?.fulfillment], [1800, false, 'SYN_RIVAL_0', 'AFN']);
});

test('step 115 [Р-240]: two calls inside 30.3 seconds — the limiter of the adapter holds the second one: no request reaches the channel', async () => {
  const { adapter, model, window, advance } = harness(40, (i) => rival(i));
  await adapter.readCompetitors(ctx, window(0));
  advance(20_000);
  const r = await adapter.readCompetitors(ctx, window(20));
  assert.deepEqual([r.snapshots.length, r.failures.length, r.failures[0]?.error.code, r.failures[0]?.error.scope], [0, 20, 'RATE_LIMITED', 'BATCH']);
  assert.equal(model.stats.requests.getCompetitiveSummary, 1);
});

test('step 115 (A-15): an application limit that gets in the way — at our pair pace the channel answers 429, by its own code and with one request; it never passes unnoticed', async () => {
  const { adapter, model, window, advance } = harness(40, (i) => rival(i), { summaryApplicationRps: 0.01 });
  await adapter.readCompetitors(ctx, window(0));
  advance(31_000);
  const r = await adapter.readCompetitors(ctx, window(20));
  assert.deepEqual([r.failures.length, r.failures[0]?.error.code, r.failures[0]?.error.scope, r.failures[0]?.error.class], [20, 'RATE_LIMITED', 'BATCH', 'TRANSIENT']);
  assert.deepEqual([model.stats.requests.getCompetitiveSummary, model.stats.rateLimited], [2, 1], 'one request per window, no retry inside the call');
});

test('step 115: a batch of 21 is what the model refuses — the adapter never sends one', async () => {
  const { adapter, model, window, advance } = harness(21, (i) => rival(i));
  const r = await adapter.readCompetitors(ctx, window(0, 21));
  // 20 в первом запросе; 21-й ждёт следующего токена: отказ своего ограничителя, а не 400 канала
  assert.deepEqual([r.snapshots.length, r.failures.length, r.failures[0]?.error.code], [20, 1, 'RATE_LIMITED']);
  advance(31_000);
  assert.equal(model.stats.requests.getCompetitiveSummary, 1);
});
