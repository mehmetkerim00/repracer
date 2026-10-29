import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { AdapterCallContext, ChannelAdapter, CompetitorOffer, CompetitorSnapshot, FieldWrite } from '@repracer/channel-port';
import { createPricingPipeline, type MemorySeedScope } from '@repracer/pricing-pipeline';
import { inTenant, PgPricingStore, seedPricingWorld, type PgPool, type SeededPricingWorld } from '../src/index.ts';
import { approved, contextOf, engineCost, explained } from './drafts.ts';
import { createIsolatedDatabase, type IsolatedDatabase } from './isolated-db.ts';

/**
 * Шаг 109 [Р-234, Р-235] на PostgreSQL. Данные синтетические.
 * - Р-235: снимок сверки, называющий предложения в Buy Box по сегментам с долей просмотров, — держатель большинства просмотров (сумма долей
 *   продавца > 50 %) пишет отрезок держателя `buybox_span`, как снимок, называющий держателя; большинства нет — отрезка нет. Последняя сводка
 *   товара читается для страницы Competition.
 * - Р-234: купон предложения в снимке решения доходит до картины рынка квитанции (`couponMinor`), база его принимает; цена решения считается
 *   по базовой цене, а не по купонной.
 */

const ACCOUNT = '20000000-0000-4000-8000-000000000109';
const MINUTE_MS = 60_000;
let skewMs = 0;
const now = () => new Date(Date.now() + skewMs).toISOString();
const WIN = { strategyId: 'st-win-109', version: 1, params: { type: 'WIN_BUYBOX', undercutMinor: 5, fulfillmentHandicapMinor: 0, creepUp: false, creepStepBp: 100, atBound: 'CAP' }, deadbandMinor: 0 } as const;

function scope(n: number, over: Partial<MemorySeedScope> = {}): MemorySeedScope {
  return {
    writeScopeId: `ws-${n}`, productId: `prod-${n}`, channelAccountId: ACCOUNT, marketplace: 'de', externalUnitId: String(10900 + n),
    channelProductRef: `310910${n}`, condition: 'new', currency: 'EUR', basis: 'GROSS', pricingMode: 'ENGINE', strategy: WIN, cost: engineCost(),
    currentPriceMinor: 1900, minPrice: { amountMinor: 1000, id: `min-${n}` }, maxPrice: { amountMinor: 3000, id: `max-${n}` }, ...over,
  };
}

let db: IsolatedDatabase;
let pool: PgPool;
let admin: PgPool;
let world: SeededPricingWorld;
let store: PgPricingStore;
let summaries: CompetitorSnapshot[] = [];

before(async () => {
  db = await createIsolatedDatabase('step109');
  pool = db.pool('svc_app');
  admin = db.pool('svc_admin', 2);
  world = await seedPricingWorld(pool, { provisioningPool: db.pool('svc_provisioning', 1), adminPool: admin,
    fixtureTenantId: '10000000-0000-4000-8000-000000000109', fixtureChannelAccountId: ACCOUNT, marketplaces: ['de'], clock: now(),
    seed: { scopes: [scope(1), scope(2)] } });
  store = new PgPricingStore(pool);
});
after(async () => { await db?.drop(); });

const source = { kind: 'PULL', completeness: { kind: 'TOP_N', n: 10 }, conditions: ['new'], hasBuyboxPrice: true, hasFulfilment: false, hasOwnRank: true, hasShipping: true,
  typicalStalenessSeconds: null, availability: 'AVAILABLE' };
// Основной источник называет держателя (как Kaufland /buybox); источник сверки — держателя по долям просмотров (как Amazon getCompetitiveSummary)
const adapter = {
  descriptor: { channel: 'KAUFLAND', scheduledRecomputeSeconds: 900, competitorSources: [
    { ...source, source: 'KAUFLAND_BUYBOX', hasBuyboxWinner: true, role: 'PRIMARY' },
    { ...source, source: 'SYN_SUMMARY', hasBuyboxWinner: false, hasBuyboxPrice: false, role: 'RECONCILIATION', holderByViewShare: true },
  ] },
  async planDispatch(_ctx: unknown, writes: readonly FieldWrite[]) {
    return { batches: writes.map((w) => ({ batchId: `b:${w.channelWriteId}`, operation: 'TEST', items: [w], budgetCharges: [], requestCount: 1 })), rejected: [] };
  },
  async dispatch(_ctx: unknown, batch: { batchId: string; items: FieldWrite[] }) {
    return { batchId: batch.batchId, outcomes: batch.items.map((w) => ({ channelWriteId: w.channelWriteId, status: 'ACCEPTED', appliedImmediately: true })), attemptsMade: 1 };
  },
  async readBack() { return { observations: [], failures: [] }; },
  async readCompetitors() { return { snapshots: summaries, failures: [] }; },
} as unknown as ChannelAdapter;
const pipeline = () => createPricingPipeline({ store, adapter, alerts: { raise: async () => undefined }, logger: { log: () => undefined }, now: () => now() as never });
const ctx: () => AdapterCallContext = () => ({ tenantId: world.tenantId as never, channelAccountId: world.ids.dbId(ACCOUNT) as never, correlationId: 'step109', deadline: new Date(Date.now() + skewMs + 60_000).toISOString() as never });
const eur = (amountMinor: number) => ({ amountMinor, currency: 'EUR', basis: 'GROSS' as const });

function summary(n: number, segments: Array<[string | null, string, number]>, offers: Array<[string, number, number?]> = []): CompetitorSnapshot {
  return {
    marketplace: 'de', channelProductRef: `310910${n}`, condition: 'new', source: 'SYN_SUMMARY', observedAt: now() as never, completeness: { kind: 'TOP_N', n: 10 },
    offers: offers.map(([seller, price, coupon]): CompetitorOffer => ({ isSelf: false, sellerRef: seller, price: eur(price), shipping: eur(0), totalPrice: eur(price),
      ...(coupon !== undefined ? { couponPrice: eur(coupon) } : {}) })),
    buyboxSegments: segments.map(([seller, membership, viewSharePct]) => ({ ...(seller ? { sellerRef: seller } : {}), isSelf: seller === null, membership, viewSharePct })),
  };
}
const poll = async (...s: CompetitorSnapshot[]) => {
  summaries = s;
  return pipeline().pollCompetitors(ctx(), s.map((x) => ({ marketplace: 'de', channelProductRef: x.channelProductRef, condition: 'new' })));
};
const spans = (n: number) => inTenant(pool, world.tenantId, async (tx) => (await tx.query(
  `SELECT b.holder, b.winner_seller_ref, b.snapshots FROM channel_data.buybox_span b WHERE b.tenant_id = $1 AND b.channel_product_ref = $2 ORDER BY b.started_at`,
  [world.tenantId, `310910${n}`])).rows.map((r: { holder: string; winner_seller_ref: string | null; snapshots: number }) => [r.holder, r.winner_seller_ref, r.snapshots]));

test('step 109 (D) [Р-235]: a summary naming the featured offer by view share writes the Buy Box span of the majority holder; no majority — no span', async () => {
  // Cedar Lane: 72 % без Prime и 10 % с Prime — 82 % просмотров; Pine & Co — 18 %
  await poll(summary(1, [['Cedar Lane', 'NON_PRIME', 72], ['Cedar Lane', 'PRIME', 10], ['Pine & Co', 'NON_PRIME', 18]]));
  assert.deepEqual(await spans(1), [['OTHER', 'Cedar Lane', 1]], 'the seller with most of the views holds the span');
  skewMs += MINUTE_MS;
  await poll(summary(1, [['Cedar Lane', 'NON_PRIME', 60], ['Pine & Co', 'PRIME', 40]]));
  skewMs += MINUTE_MS;
  await poll(summary(1, [[null, 'NON_PRIME', 55], ['Cedar Lane', 'PRIME', 45]]));
  assert.deepEqual(await spans(1), [['OTHER', 'Cedar Lane', 2], ['SELF', null, 1]], 'the same holder extends the span; our majority opens our span');
  // Ровно половина и раздробленные сегменты — держатель неизвестен: отрезок не открывается и не продлевается
  skewMs += MINUTE_MS;
  await poll(summary(2, [['Cedar Lane', 'NON_PRIME', 50], ['Pine & Co', 'PRIME', 50]]), summary(1, [['Harbor Goods', 'NON_PRIME', 40], ['Cedar Lane', 'PRIME', 35], [null, 'DEFAULT', 25]]));
  assert.deepEqual(await spans(2), [], 'exactly half is not a majority');
  assert.deepEqual(await spans(1), [['OTHER', 'Cedar Lane', 2], ['SELF', null, 1]], 'no majority — no span');
  // Доля Buy Box читает эти отрезки тем же методом, что для источника, называющего держателя
  const read = await new PgPricingStore(pool, { adminPool: admin }).buyboxSpans(world.tenantId, world.ids.dbId('ws-1'), new Date(Date.now() - 3_600_000).toISOString(), now());
  assert.deepEqual(read.map((s) => [s.holder, s.sellerRef]), [['OTHER', 'Cedar Lane'], ['SELF', null]]);
});

test('step 109 (C, D) [Р-234, Р-235]: the latest summary of the offer is read for the Competition page — segments with view shares and coupon prices', async () => {
  skewMs += MINUTE_MS;
  await poll(summary(1, [['Cedar Lane', 'NON_PRIME', 72], ['Cedar Lane', 'PRIME', 10], ['Pine & Co', 'NON_PRIME', 18]], [['Pine & Co', 1715, 1629], ['Cedar Lane', 1811]]));
  const latest = await new PgPricingStore(pool, { adminPool: admin }).competitionSummary(world.tenantId, world.ids.dbId('ws-1'));
  assert.ok(latest, 'the summary of the offer is found');
  assert.equal(latest.observedAt, summaries[0]!.observedAt);
  assert.deepEqual(latest.snapshot.buyboxSegments?.map((s) => [s.sellerRef ?? null, s.membership, s.viewSharePct]), [['Cedar Lane', 'NON_PRIME', 72], ['Cedar Lane', 'PRIME', 10], ['Pine & Co', 'NON_PRIME', 18]]);
  assert.deepEqual(latest.snapshot.offers.map((o) => [o.sellerRef, o.price.amountMinor, o.couponPrice?.amountMinor ?? null]), [['Pine & Co', 1715, 1629], ['Cedar Lane', 1811, null]]);
  assert.equal(await new PgPricingStore(pool, { adminPool: admin }).competitionSummary(world.tenantId, world.ids.dbId('ws-2')).then((x) => x?.snapshot.buyboxSegments?.length ?? null), 2,
    'another offer reads its own summary');
});

test('step 109 (C) [Р-234]: a coupon in the snapshot of the decision reaches the receipt; the price is decided on the base price', async () => {
  skewMs += MINUTE_MS;
  // Buy Box у Harbor Goods за 18,00 € (с купоном — 16,50 €): «Win the Buy Box» с подрезом 5 центов целится от 18,00 €, а не от купонной
  const offers: CompetitorOffer[] = [
    { rank: 1, isSelf: false, sellerRef: 'Harbor Goods', price: eur(1800), shipping: eur(0), totalPrice: eur(1800), holdsBuyBox: true, couponPrice: eur(1650) },
    { rank: 2, isSelf: true, price: eur(1900), shipping: eur(0), totalPrice: eur(1900) },
  ];
  await pipeline().processSnapshot(ctx(), { marketplace: 'de', channelProductRef: '3109102', condition: 'new', source: 'KAUFLAND_BUYBOX', observedAt: now() as never,
    completeness: { kind: 'TOP_N', n: 10 }, buybox: { price: eur(1800), isSelf: false, shipping: eur(0), sellerRef: 'Harbor Goods' }, offers });
  const [d] = await inTenant(pool, world.tenantId, async (tx) => (await tx.query(
    `SELECT outcome, final_amount_minor, competitor_view FROM channel_data.price_decision WHERE tenant_id = $1 AND write_scope_id = $2 ORDER BY decided_at DESC LIMIT 1`,
    [world.tenantId, world.ids.dbId('ws-2')])).rows);
  assert.ok(d, 'the decision is committed — the database accepts a coupon in the competitor view');
  assert.equal(d.outcome, 'APPROVED');
  assert.equal(Number(d.final_amount_minor), 1795, 'the target is cut from the base price 18.00, not from the coupon price 16.50');
  assert.deepEqual(d.competitor_view.offers.map((o: { seller: string | null; priceMinor: number; couponMinor?: number }) => [o.seller, o.priceMinor, o.couponMinor ?? null]),
    [['Harbor Goods', 1800, 1650], [null, 1900, null]]);
});

test('step 109 [Р-234]: the database refuses a coupon that is not a whole number of cents or not below the price of its row', async () => {
  const ctxWin = await contextOf(store, world.tenantId, world.ids.dbId('ws-1'));
  const base = approved(ctxWin, 1730);
  const draft = { ...base, intent: { ...base.intent, ruleCode: 'WIN_BUYBOX' as const } };
  const ref = { competitorSnapshotId: '00000000-0000-4000-8000-000000010901', source: 'KAUFLAND_BUYBOX', observedAt: now() };
  const commit = (couponMinor: unknown) => store.commitEvaluation(world.tenantId, {
    key: { channelAccountId: ctxWin.scope.channelAccountId, marketplace: 'de', channelProductRef: ctxWin.scope.channelProductRef, condition: 'new' }, now: now(),
    decisions: [{ ...explained(draft, ref), competitorView: { currency: 'EUR', trigger: null, offers: [{ seller: 'Harbor Goods', self: false, priceMinor: 1800, couponMinor }] } } as never] });
  await assert.rejects(commit('16.50'), /price_decision_competitor_view_shape/, 'a coupon as text is refused');
  await assert.rejects(commit(1650.5), /price_decision_competitor_view_shape/, 'a coupon with a fraction of a cent is refused');
  await assert.rejects(commit(1800), /price_decision_competitor_view_shape/, 'a coupon not below the price is refused');
  await assert.rejects(commit(1900), /price_decision_competitor_view_shape/, 'a coupon above the price is refused');
});
