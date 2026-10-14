import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AdapterCallContext, AdapterDependencies, FieldWrite } from '@repracer/channel-port';
import { TOKEN_COUNT_HEADER, WalmartAdapter, WalmartClient, WalmartHttpError, WALMART_US } from '@repracer/walmart-adapter';
import { SimulatedWalmartChannel, type WalmartItemSpec } from './simulator/index.ts';

/**
 * Шаг 89: адаптер Walmart против модели канала по правилам настоящего Walmart (docs/channels/walmart.md). Проверяется то, что
 * владелец назвал рисками: квоты — корзина токенов с заголовками (писатель их читает и не упирается в 429), слишком большой фид — 413,
 * правило неконкурентной цены — листинг снимается с публикации с причиной, и это видно обратным чтением. Данные синтетические.
 */

const T0 = Date.parse('2026-10-14T14:00:00Z');
function world(items: WalmartItemSpec[], params?: ConstructorParameters<typeof SimulatedWalmartChannel>[0]['params']) {
  let now = T0;
  const clock = { nowMs: () => now, sleep: async (ms: number) => { now += ms; } };
  const channel = new SimulatedWalmartChannel({ seed: 89, clientId: 'syn-client', clientSecret: 'syn-secret', items, nowMs: clock.nowMs, ...(params ? { params } : {}) });
  const deps: AdapterDependencies = {
    accounts: { verify: async (tenantId, channelAccountId) => ({ ok: true, account: { tenantId, channelAccountId, channel: 'WALMART', externalAccountId: 'syn-walmart', marketplaces: [WALMART_US], credentialsRef: 'secret-ref:synthetic' } }) },
    credentials: { get: async () => ({ clientId: 'syn-client', clientSecret: 'syn-secret' }) },
    alerts: { raise: async () => undefined },
    logger: { log: () => undefined },
    now: () => new Date(now).toISOString() as never,
  };
  const adapter = new WalmartAdapter(deps, { baseUrl: 'https://sandbox.walmartapis.com', fetch: channel.fetch, clock });
  const ctx: AdapterCallContext = { tenantId: 't-1' as never, channelAccountId: 'acc-walmart' as never, correlationId: 'step89', deadline: new Date(T0 + 3_600_000).toISOString() as never };
  return { channel, adapter, ctx, clock };
}

const item = (n: number, extra: Partial<WalmartItemSpec> = {}): WalmartItemSpec => ({
  sku: `SYN-WMT-${String(n).padStart(2, '0')}`, productName: `Synthetic product ${n}`, priceMinor: 1999, quantity: 10,
  otherMarketplacePriceMinor: null, competitorBaseMinor: 1900, ...extra,
});
const priceWrite = (sku: string, minor: number, n: number): FieldWrite => ({
  channelWriteId: `w-${n}` as never, version: n, idempotencyKey: `k-${n}`, attemptNo: 1, value: { field: 'PRICE', price: { amountMinor: minor, currency: 'USD', basis: 'NET' } },
  writeScope: { writeScopeId: `ws-${sku}` as never, field: 'PRICE', scopeKey: sku, identity: { marketplace: WALMART_US, externalSku: sku, channelProductRef: sku } },
});

test('step 89: the writer reads the token bucket headers and never runs into 429 — 40 price writes through a bucket of 5', async () => {
  const w = world([item(1)], { buckets: { price: { capacity: 5, perMinute: 10 } } as never });
  const writes = Array.from({ length: 40 }, (_, i) => priceWrite('SYN-WMT-01', 2000 + i, i + 1));
  const plan = await w.adapter.planDispatch(w.ctx, writes);
  assert.equal(plan.batches.length, 40, 'one write per call');
  for (const batch of plan.batches) {
    const r = await w.adapter.dispatch(w.ctx, batch);
    assert.equal(r.outcomes[0]!.status, 'ACCEPTED', JSON.stringify(r.outcomes[0]));
  }
  const pacer = w.adapter.pacerOf('acc-walmart')!;
  assert.equal(w.channel.stats.throttled, 0, 'the channel never answered 429');
  assert.equal(pacer.stats.throttled, 0);
  assert.ok(pacer.stats.waits > 0 && pacer.stats.waitedMs > 0, `the writer waited for replenishment instead (${pacer.stats.waits} waits, ${pacer.stats.waitedMs} ms)`);
  assert.equal(w.channel.item('SYN-WMT-01')!.priceMinor, 2039, 'the last write is applied');
});

test('step 89: control — a client that ignores the headers runs into 429 on the same bucket; every answer carries the bucket headers', async () => {
  const w = world([item(1)], { buckets: { items: { capacity: 3, perMinute: 6 } } as never });
  const token = await w.channel.fetch('https://sandbox.walmartapis.com/v3/token', { method: 'POST', headers: { authorization: `Basic ${Buffer.from('syn-client:syn-secret').toString('base64')}` }, body: '{}' });
  const access = (JSON.parse(await token.text()) as { access_token: string }).access_token;
  const statuses: number[] = [];
  for (let i = 0; i < 6; i++) {
    const r = await w.channel.fetch('https://sandbox.walmartapis.com/v3/items/SYN-WMT-01', { method: 'GET', headers: { 'WM_SEC.ACCESS_TOKEN': access } });
    assert.notEqual(r.headers.get(TOKEN_COUNT_HEADER), null, 'the token count header is on every answer');
    statuses.push(r.status);
  }
  assert.deepEqual(statuses, [200, 200, 200, 429, 429, 429]);
});

test('step 89: a feed larger than the limit — 413 from the channel; our client refuses to send it at all', async () => {
  const w = world([item(1)], { maxFeedBytes: 200 });
  const client = new WalmartClient({ baseUrl: 'https://sandbox.walmartapis.com', fetch: w.channel.fetch, clientId: 'syn-client', clientSecret: 'syn-secret', clock: w.clock });
  const big = Array.from({ length: 20 }, (_, i) => ({ sku: `SYN-WMT-${i}`, amount: 19.99, currency: 'USD' }));
  // Предел клиента выше предела канала — фид уходит и получает 413
  const r = await client.submitPriceFeed(big, 1_000_000);
  assert.deepEqual([r.status, w.channel.stats.payloadTooLarge], [413, 1]);
  // Предел клиента — фид больше него не уходит вовсе
  await assert.rejects(client.submitPriceFeed(big, 200), (e: unknown) => e instanceof WalmartHttpError && e.status === 413);
  assert.equal(w.channel.stats.payloadTooLarge, 1, 'the refused feed never reached the channel');
});

test('step 89: a price well above the other marketplace unpublishes the listing with its reason; back within the threshold — published again', async () => {
  const w = world([item(1, { otherMarketplacePriceMinor: 2000 }), item(2)]);
  const scope = (sku: string) => priceWrite(sku, 0, 0).writeScope;
  const status = async (sku: string) => (await w.adapter.listingStatuses(w.ctx, [sku]))[0]!;
  assert.equal((await status('SYN-WMT-01')).published, true, '$19.99 against $20.00 elsewhere is competitive');

  const [up] = (await w.adapter.planDispatch(w.ctx, [priceWrite('SYN-WMT-01', 2500, 1)])).batches;
  await w.adapter.dispatch(w.ctx, up!);
  const down = await status('SYN-WMT-01');
  assert.deepEqual([down.published, down.reasons, down.referencePrice?.amountMinor], [false, ['UNCOMPETITIVE_PRICE'], 2000]);
  const read = await w.adapter.readBack(w.ctx, [{ writeScope: scope('SYN-WMT-01'), fields: ['PRICE'] }]);
  assert.deepEqual(read.observations[0]!.liveness, { isLive: false, reasons: ['UNCOMPETITIVE_PRICE'] }, 'read-back sees the listing is not live');
  // Товар без цены другой площадки правило не трогает при любой цене
  const [other] = (await w.adapter.planDispatch(w.ctx, [priceWrite('SYN-WMT-02', 9900, 2)])).batches;
  await w.adapter.dispatch(w.ctx, other!);
  assert.equal((await status('SYN-WMT-02')).published, true);

  const [back] = (await w.adapter.planDispatch(w.ctx, [priceWrite('SYN-WMT-01', 2150, 3)])).batches;
  await w.adapter.dispatch(w.ctx, back!);
  assert.equal((await status('SYN-WMT-01')).published, true, '$21.50 is within 10 % of $20.00 — published again');
  assert.deepEqual([w.channel.stats.unpublished, w.channel.stats.republished], [1, 1]);
});

test('step 89: the Buy Box has three competitors that move differently — drifting, undercutting, waving', async () => {
  const w = world([item(1)]);
  const read = async () => (await w.adapter.readCompetitors(w.ctx, [{ marketplace: WALMART_US, channelProductRef: 'SYN-WMT-01', condition: 'new' }])).snapshots[0]!;
  const first = await read();
  assert.equal(first.source, 'WALMART_BUY_BOX');
  assert.equal(first.offers.filter((o) => !o.isSelf).length, 3);
  assert.ok(first.buybox, 'the Buy Box winner is named');
  const prices = (minutes: number) => { w.clock.sleep(minutes * 60_000); return w.channel.competitorsOf('SYN-WMT-01'); };
  const a = w.channel.competitorsOf('SYN-WMT-01');
  const b = prices(45);
  const byBehaviour = (xs: typeof a) => Object.fromEntries(xs.map((x) => [x.behaviour, x.priceMinor]));
  assert.deepEqual(Object.keys(byBehaviour(a)).sort(), ['DRIFT', 'UNDERCUT', 'WAVE']);
  assert.equal(byBehaviour(a).UNDERCUT, 1998, 'the undercutter sits a cent below our $19.99');
  assert.notEqual(byBehaviour(a).WAVE, byBehaviour(b).WAVE, 'the wave moves within 45 minutes');
});
