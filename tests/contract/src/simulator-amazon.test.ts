import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AdapterCallContext, AdapterDependencies, FieldWrite } from '@repracer/channel-port';
import { createPricingPipeline, InMemoryPricingStore, type MemorySeedScope } from '@repracer/pricing-pipeline';
import { createWriteDispatcher } from '@repracer/write-dispatcher';
import { VirtualClock, type Sink } from './harness/world.ts';
import { AMAZON_DE, SimulatedAmazonPort, type AmazonPortModelSpec } from './simulator/amazon-port.ts';
import type { AmazonModelParams } from './simulator/params.ts';

/**
 * Модель Amazon на уровне порта [Р-113]: путь решения и диспетчер с поведением, заданным вопросами A-nn.
 * Формат JSON-сценариев стенда привязан к HTTP Kaufland (exchanges /v2/…), поэтому варианты Amazon — в коде теста.
 * Данные синтетические.
 */
const TENANT = '10000000-0000-4000-8000-000000000002';
const ACCOUNT = '20000000-0000-4000-8000-000000000002';
const AMAZON_FR = 'A13V1IB3VIYZZH';

function world(params: Partial<AmazonModelParams> = {}) {
  const clock = new VirtualClock('2026-09-14T10:00:00.000Z');
  const sink: Sink = { logs: [], alerts: [] };
  const deps: AdapterDependencies = {
    accounts: { async verify(tenantId, channelAccountId) {
      if (channelAccountId !== ACCOUNT) return { ok: false, reason: 'NOT_FOUND' };
      if (tenantId !== TENANT) return { ok: false, reason: 'TENANT_MISMATCH' };
      return { ok: true, account: { tenantId, channelAccountId, channel: 'AMAZON', region: 'EU', externalAccountId: 'syn-amz-0001', marketplaces: [AMAZON_DE, AMAZON_FR], credentialsRef: 'cred:amazon' } };
    } },
    credentials: { async get() { return {}; } },
    alerts: { async raise(alert) { sink.alerts.push(alert); } },
    logger: { log(entry) { sink.logs.push(entry); } },
    now: () => clock.iso(),
  };
  const spec: AmazonPortModelSpec = {
    seed: 111, params,
    skus: [{ sku: 'SYN-SKU-0001', asin: 'B0SYN00001', marketplaces: [AMAZON_DE, AMAZON_FR], priceMinor: 1850, quantity: 5 }],
    competitors: [{ sellerRef: 'Synthetic Amazon Competitor', marketplace: AMAZON_DE, asin: 'B0SYN00001', priceMinor: 1990, schedule: [{ atOffsetMs: 60_000, priceMinor: 1800 }] }],
  };
  const port = new SimulatedAmazonPort(spec, deps);
  const ctx: AdapterCallContext = { tenantId: TENANT as AdapterCallContext['tenantId'], channelAccountId: ACCOUNT as AdapterCallContext['channelAccountId'], correlationId: 'sim-amazon', deadline: clock.iso(60_000) };
  return { clock, sink, port, ctx };
}

const scope: MemorySeedScope = {
  writeScopeId: 'ws-amz-price-de-0001', productId: 'prod-amz-0001', channelAccountId: ACCOUNT, marketplace: AMAZON_DE, externalUnitId: 'SYN-SKU-0001',
  channelProductRef: 'B0SYN00001', condition: 'new', currency: 'EUR', basis: 'GROSS', pricingMode: 'ENGINE',
  strategy: { strategyId: 'st-amz-buybox', version: 1, params: { type: 'MATCH_BUYBOX', undercutMinor: 5, holdWhenWinning: true, atBound: 'CAP' }, deadbandMinor: 0 },
  currentPriceMinor: 1850, minPrice: { amountMinor: 1500, id: 'min-amz-0001' }, maxPrice: { amountMinor: 2500, id: 'max-amz-0001' },
};

async function runPricing(params: Partial<AmazonModelParams>, minutes: number) {
  const w = world(params);
  const days = Array.from({ length: 20 }, (_, i) => ({ day: new Date(Date.parse('2026-09-13T00:00:00Z') - i * 86_400_000).toISOString().slice(0, 10), minMinor: 1700, maxMinor: 1950 }));
  const store = new InMemoryPricingStore({
    scopes: [scope], marketplaces: { [AMAZON_DE]: { currency: 'EUR', basis: 'GROSS' } },
    accounts: [{ channelAccountId: ACCOUNT, channel: 'AMAZON', region: 'EU', marketplaces: [AMAZON_DE, AMAZON_FR] }],
    competitorDaily: { [`${AMAZON_DE}|B0SYN00001|new`]: days },
  }, { tenantId: TENANT });
  const alerts = { raise: async (a: Sink['alerts'][number]) => { w.sink.alerts.push(a); } };
  const dispatcher = createWriteDispatcher({ store, adapterFor: () => w.port, alerts, now: () => w.clock.iso() });
  const pipeline = createPricingPipeline({ store, adapter: w.port, alerts, logger: { log: (e) => w.sink.logs.push(e) }, now: () => w.clock.iso(), dispatcher });
  let snapshots = 0;
  for (let m = 0; m < minutes; m++) {
    w.clock.advance(60_000);
    for (const snapshot of w.port.drainSnapshots()) {
      snapshots += 1;
      await pipeline.processSnapshot({ ...w.ctx, deadline: w.clock.iso(60_000) }, snapshot);
    }
    await dispatcher.sweep({ pendingMinAgeMs: 0 });
  }
  return { ...w, store, snapshots, dump: await store.dump() };
}

test('Р-111: the Amazon model refuses the channel repricer floor before any call', async () => {
  const { port, ctx } = world();
  const write: FieldWrite = {
    channelWriteId: 'cw-amz-floor' as FieldWrite['channelWriteId'], version: 1, idempotencyKey: 'cw-amz-floor:1', attemptNo: 1,
    writeScope: { writeScopeId: 'ws-amz-price-de-0001' as FieldWrite['writeScope']['writeScopeId'], field: 'PRICE', scopeKey: 'amz', identity: { marketplace: AMAZON_DE, externalSku: 'SYN-SKU-0001' } },
    value: { field: 'CHANNEL_MIN_PRICE', minPrice: { amountMinor: 1500, currency: 'EUR', basis: 'GROSS' } },
  };
  const plan = await port.planDispatch(ctx, [write]);
  assert.equal(plan.batches.length, 0);
  assert.equal(plan.rejected[0]?.error.code, 'UNSUPPORTED');
  assert.equal(port.stats.patchCalls, 0);
});

test('A-06 default: asynchronous write is confirmed by read-back after the apply delay', async () => {
  const r = await runPricing({}, 20);
  assert.equal(r.port.listing(AMAZON_DE, 'SYN-SKU-0001')?.priceMinor, 1795);
  assert.deepEqual(r.dump.writes.map((x) => [x.amountMinor, x.status]), [[1795, 'APPLIED']]);
  assert.deepEqual(r.sink.alerts, []);
});

test('A-06 variant: accepted but never applied — NOT_APPLIED after the confirmation window, with an alert', async () => {
  // Предел подтверждения диспетчера — 1 ч (confirmationTimeoutMs): до него запись держит единицу, цена в канале старая
  const before = await runPricing({ acceptedNotAppliedShare: 1 }, 55);
  assert.deepEqual(before.dump.writes.map((x) => [x.amountMinor, x.status]), [[1795, 'ACCEPTED']]);
  const r = await runPricing({ acceptedNotAppliedShare: 1 }, 75);
  assert.deepEqual(r.dump.writes.map((x) => [x.amountMinor, x.status]), [[1795, 'NOT_APPLIED']]);
  assert.equal(r.port.listing(AMAZON_DE, 'SYN-SKU-0001')?.priceMinor, 1850);
  assert.ok(r.sink.alerts.some((a) => a.code === 'PRICE_WRITE_NOT_SENT'), JSON.stringify(r.sink.alerts));
  // Сверка — обратным чтением с нарастающей паузой; число чтений на одну запись фиксирует тест
  assert.ok(r.port.stats.readCalls >= 5, `readCalls ${r.port.stats.readCalls}`);
});

test('A-08 variant: a lost ANY_OFFER_CHANGED leaves the price unchanged and nothing notices', async () => {
  const r = await runPricing({ anyOfferChanged: { delayMs: 60_000, lossShare: 1 } }, 30);
  assert.equal(r.snapshots, 0);
  assert.equal(r.port.listing(AMAZON_DE, 'SYN-SKU-0001')?.priceMinor, 1850);
  assert.deepEqual(r.sink.alerts, []);
});

test('A-01: MFN quantity written for amazon.de changes amazon.fr only when the quantity is regional', async () => {
  for (const [quantityScope, expectedFr] of [['REGION', 9], ['MARKETPLACE', 5]] as const) {
    const { port, ctx, clock } = world({ quantityScope, applyDelayMs: 0 });
    const write: FieldWrite = {
      channelWriteId: 'cw-amz-qty' as FieldWrite['channelWriteId'], version: 1, idempotencyKey: 'cw-amz-qty:1', attemptNo: 1,
      writeScope: { writeScopeId: 'ws-amz-qty' as FieldWrite['writeScope']['writeScopeId'], field: 'QUANTITY', scopeKey: 'amz-qty', identity: { marketplace: AMAZON_DE, externalSku: 'SYN-SKU-0001' } },
      value: { field: 'QUANTITY', quantity: 9 },
    };
    const plan = await port.planDispatch(ctx, [write]);
    await port.dispatch(ctx, plan.batches[0]!);
    clock.advance(1);
    assert.equal(port.listing(AMAZON_DE, 'SYN-SKU-0001')?.quantity, 9);
    assert.equal(port.listing(AMAZON_FR, 'SYN-SKU-0001')?.quantity, expectedFr, quantityScope);
  }
});

test('two-level write limit: seller 5 rps burst 5, and the application limit shared with other sellers', async () => {
  for (const [load, accepted] of [[0, 5], [499.5, 1]] as const) {
    const { port, ctx } = world({ otherSellersLoadRps: load });
    let ok = 0;
    for (let i = 0; i < 12; i++) {
      const write: FieldWrite = {
        channelWriteId: `cw-amz-${i}` as FieldWrite['channelWriteId'], version: i + 1, idempotencyKey: `k${i}`, attemptNo: 1,
        writeScope: { writeScopeId: 'ws-amz-price-de-0001' as FieldWrite['writeScope']['writeScopeId'], field: 'PRICE', scopeKey: 'amz', identity: { marketplace: AMAZON_DE, externalSku: 'SYN-SKU-0001' } },
        value: { field: 'PRICE', price: { amountMinor: 1800 + i, currency: 'EUR', basis: 'GROSS' } },
      };
      const res = await port.dispatch(ctx, { batchId: `b${i}`, operation: 'patchListingsItem', items: [write], budgetCharges: [], requestCount: 1 });
      if (res.outcomes[0]?.status === 'ACCEPTED') ok += 1;
      else assert.equal((res.outcomes[0] as { error: { code: string } }).error.code, 'RATE_LIMITED');
    }
    assert.equal(ok, accepted, `load ${load}`);
  }
});

test('getCompetitiveSummary at 0.033 rps: polling competitors is not a pricing input', async () => {
  const { port, ctx, clock } = world();
  let snapshots = 0;
  for (let i = 0; i < 10; i++) {
    clock.advance(6_000);
    snapshots += (await port.readCompetitors(ctx, [{ marketplace: AMAZON_DE, channelProductRef: 'B0SYN00001', condition: 'new' }])).snapshots.length;
  }
  // Минута опроса: один снимок в начале, второй — не раньше чем через 30 секунд
  assert.equal(snapshots, 2);
  assert.equal(port.stats.summaryRateLimited, 8);
});
