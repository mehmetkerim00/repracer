import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChannelAdapter, CompetitorQuery, CompetitorSnapshot, CompetitorSourceDescriptor } from '@repracer/channel-port';
import { InMemoryPricingStore, type MemorySeedScope } from './memory-store.ts';
import { createPricingPipeline } from './pipeline.ts';
import { comparedValue } from './reconciliation.ts';

/**
 * Шаг 115 [Р-240]: опрос сводки по кругу — источник решений. Снимок идёт настоящим путём решения; окно, которое канал отклонил целиком, не
 * отмечается и повторяется, а отказ по одному товару отмечается — он не занимает окно; проверка потери уведомлений — только по просьбе
 * вызывающего. Хранилище в памяти, данные синтетические
 */
const ACCOUNT = 'acc-amazon';
const US = 'ATVPDKIKX0DER';
const NOW = '2026-11-06T10:00:00.000Z';
const usd = (amountMinor: number) => ({ amountMinor, currency: 'USD', basis: 'NET' as const });
const PUSH: CompetitorSourceDescriptor = {
  source: 'AMAZON_ANY_OFFER_CHANGED', kind: 'PUSH', completeness: { kind: 'TOP_N', n: 20 }, conditions: ['new'], hasBuyboxWinner: false, hasBuyboxPrice: true, hasFulfilment: true,
  hasOwnRank: false, hasShipping: true, typicalStalenessSeconds: null, availability: 'AVAILABLE', role: 'PRIMARY',
};
const POLL: CompetitorSourceDescriptor = {
  ...PUSH, source: 'AMAZON_COMPETITIVE_SUMMARY', kind: 'PULL', hasBuyboxWinner: true, holderByViewShare: true, rotation: true,
};
const scope = (n: number): MemorySeedScope => ({
  writeScopeId: `ws-${n}`, productId: `prod-${n}`, channelAccountId: ACCOUNT, marketplace: US, externalUnitId: `SYN-SKU-${n}`, channelProductRef: `B0SYN0000${n}`,
  condition: 'new', currency: 'USD', basis: 'NET', pricingMode: 'ENGINE',
  strategy: { strategyId: 'st', version: 1, params: { type: 'BEAT_LOWEST', undercutMinor: 1, scope: 'VISIBLE_TOP_N', compareLanded: false, atBound: 'CAP' }, deadbandMinor: 0 } as never,
  currentPriceMinor: 1900, minPrice: { amountMinor: 1000, id: `min-${n}` }, maxPrice: { amountMinor: 5000, id: `max-${n}` },
  cost: { currency: 'USD', costProfileId: `cp-${n}`, unitCostMinor: 500, fixedFeeMinor: 0, feeRateBp: 1500, tax: { regime: 'SALES_TAX_EXCLUDED' } } as never,
});

function harness(read: (queries: readonly CompetitorQuery[]) => { snapshots: CompetitorSnapshot[]; failures: unknown[] }, n = 3) {
  const store = new InMemoryPricingStore({ channel: 'AMAZON', region: 'NA', marketplaces: { [US]: { currency: 'USD', basis: 'NET' } }, scopes: Array.from({ length: n }, (_, i) => scope(i + 1)) } as never);
  const asked: string[][] = [];
  const adapter = {
    descriptor: { channel: 'AMAZON', competitorSources: [PUSH, POLL], marketplaces: [{ code: US, currency: 'USD', priceBasis: 'NET', timeZone: null }] },
    async readCompetitors(_ctx: unknown, queries: readonly CompetitorQuery[]) { asked.push(queries.map((q) => q.channelProductRef)); return read(queries); },
    // Тест — о решении, а не об отправке: записи никуда не уходят
    planDispatch: () => ({ batches: [], rejected: [] }),
  } as unknown as ChannelAdapter;
  let at = NOW;
  const pipeline = createPricingPipeline({ store, adapter, alerts: { raise: async () => undefined }, logger: { log: () => undefined }, now: () => at as never });
  const ctx = { tenantId: 't' as never, channelAccountId: ACCOUNT as never, correlationId: 'step115', deadline: '2026-11-06T11:00:00.000Z' as never };
  return { store, pipeline, ctx, asked, setNow: (iso: string) => { at = iso; } };
}

const snapshot = (q: CompetitorQuery, lowest: number): CompetitorSnapshot => ({
  marketplace: q.marketplace, channelProductRef: q.channelProductRef, condition: 'new', source: POLL.source, observedAt: NOW, completeness: { kind: 'TOP_N', n: 1 },
  offers: [{ isSelf: false, sellerRef: 'SYN_OTHER', price: usd(lowest), shipping: usd(0), fulfillment: 'MFN' }],
});

test('step 115 [Р-240]: a polled summary decides the price on the decision path — it is no longer only logged', async () => {
  const { pipeline, ctx } = harness((queries) => ({ snapshots: queries.map((q) => snapshot(q, 1800)), failures: [] }), 1);
  const r = await pipeline.pollRotation(ctx, { size: 20, cycle: 0, reconcile: false });
  assert.deepEqual([r.queries, r.total, r.windowFailure], [1, 1, null]);
  assert.equal(r.snapshots.length, 1, 'the snapshot went through the decision path');
  assert.equal(r.snapshots[0]!.verdict, 'ACCEPT');
  assert.equal(r.snapshots[0]!.engineInvocations, 1, 'the engine evaluated the offer');
  assert.equal(r.snapshots[0]!.scopes[0]!.intent?.proposedMinor, 1799);
});

test('step 115 [Р-240]: a window the channel refused as a whole stays first and repeats; a refused item is marked and does not take the window again', async () => {
  let refuse = true;
  const { pipeline, ctx, asked, setNow } = harness((queries) => {
    if (refuse) return { snapshots: [], failures: queries.map((query) => ({ query, error: { code: 'RATE_LIMITED', scope: 'BATCH', class: 'TRANSIENT' } })) };
    return {
      snapshots: queries.filter((q) => !q.channelProductRef.endsWith('1')).map((q) => snapshot(q, 1800)),
      failures: queries.filter((q) => q.channelProductRef.endsWith('1')).map((query) => ({ query, error: { code: 'NOT_FOUND', scope: 'ITEM', class: 'PERMANENT' } })),
    };
  });
  const refused = await pipeline.pollRotation(ctx, { size: 2, cycle: 0, reconcile: false });
  assert.equal(refused.windowFailure?.code, 'RATE_LIMITED');
  setNow('2026-11-06T10:00:31.000Z');
  await pipeline.pollRotation(ctx, { size: 2, cycle: 0, reconcile: false });
  assert.deepEqual(asked[1], asked[0], 'nothing was read: the same two offers go first again, they do not wait a whole round');
  refuse = false;
  setNow('2026-11-06T10:01:02.000Z');
  const partial = await pipeline.pollRotation(ctx, { size: 2, cycle: 0, reconcile: false });
  assert.equal(partial.windowFailure, null, 'a refused item is not a refused window');
  setNow('2026-11-06T10:01:33.000Z');
  await pipeline.pollRotation(ctx, { size: 2, cycle: 0, reconcile: false });
  assert.equal(asked[3]![0], 'B0SYN00003', 'the third offer, unread so far, goes first; the refused item waits its turn');
});

test('step 115 [Р-240]: 429 on one line of the batch is the same refusal of the quota — not a property of the offer: the window repeats', async () => {
  const { pipeline, ctx, asked } = harness((queries) => ({ snapshots: [], failures: queries.map((query) => ({ query, error: { code: 'RATE_LIMITED', scope: 'ITEM', class: 'TRANSIENT' } })) }), 2);
  assert.equal((await pipeline.pollRotation(ctx, { size: 2, cycle: 0, reconcile: false })).windowFailure?.code, 'RATE_LIMITED');
  await pipeline.pollRotation(ctx, { size: 2, cycle: 0, reconcile: false });
  assert.deepEqual(asked[1], asked[0]);
});

test('step 115 [Р-121]: the poll opens a loss check only when asked to — without a subscription every market move would be a «lost notification»', async () => {
  let price = 1800;
  const { pipeline, ctx, setNow } = harness((queries) => ({ snapshots: queries.map((q) => ({ ...snapshot(q, price), observedAt: '2026-11-06T10:00:01.000Z' })), failures: [] }), 1);
  await pipeline.pollRotation(ctx, { size: 20, cycle: 0, reconcile: false });
  price = 1750;
  setNow('2026-11-06T10:00:31.000Z');
  const off = await pipeline.pollRotation(ctx, { size: 20, cycle: 1, reconcile: false });
  assert.equal(off.reconciliation, undefined);
  assert.equal(off.snapshots[0]!.reconciliation, undefined);
});

test('step 115 [Р-121]: what the poll compares with a notification — the lowest competitor: the Buy Box of a view-share source is another kind of number', () => {
  assert.equal(comparedValue(PUSH, POLL), 'LOWEST_COMPETITOR');
  assert.equal(comparedValue({ ...PUSH, hasBuyboxPrice: true }, { ...POLL, holderByViewShare: false }), 'BUYBOX', 'a source naming one Buy Box compares it, as before (Kaufland)');
});

test('step 115 [Р-121]: notifications flow when an ANY_OFFER_CHANGED reached the raw journal in the last seven days — listing notifications through EventBridge say nothing about it', async () => {
  const { store, pipeline, ctx, setNow } = harness(() => ({ snapshots: [], failures: [] }), 1);
  assert.equal(await pipeline.notificationsFlowing(ctx), false);
  const entry = (notificationId: string, notificationType: string, receivedAt: string) => ({
    channelAccountId: ACCOUNT, notificationId, notificationType, envelope: 'SQS', eventTime: receivedAt, receivedAt, rawBody: '{}',
  });
  await store.recordInboundNotification('t', entry('n-1', 'LISTINGS_ITEM_STATUS_CHANGE', NOW) as never);
  assert.equal(await pipeline.notificationsFlowing(ctx), false, 'the EventBridge half alone does not arm the check');
  await store.recordInboundNotification('t', entry('n-2', 'ANY_OFFER_CHANGED', NOW) as never);
  assert.equal(await pipeline.notificationsFlowing(ctx), true);
  setNow('2026-11-13T10:00:01.000Z');
  assert.equal(await pipeline.notificationsFlowing(ctx), false, 'a week of silence — the CRITICAL has been raised for days; the account is polling only');
});
