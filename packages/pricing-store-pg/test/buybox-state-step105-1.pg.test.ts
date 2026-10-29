import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { AdapterCallContext, ChannelAdapter, CompetitorOffer, CompetitorSnapshot, FieldWrite } from '@repracer/channel-port';
import { createPricingPipeline, type MemorySeedScope } from '@repracer/pricing-pipeline';
import { inTenant, PgPricingStore, seedPricingWorld, type PgPool, type SeededPricingWorld } from '../src/index.ts';
import { engineCost } from './drafts.ts';
import { createIsolatedDatabase, type IsolatedDatabase } from './isolated-db.ts';

/**
 * Шаг 105.1 [Р-230, решение владельца]: проекция снимка `competitor_state` хранит доставку и продавца Buy Box, которые назвал канал
 * (0203). До шага база хранила только цену и «наш / не наш», и на PostgreSQL снимок терял то, что в памяти было: цена Buy Box Amazon
 * была вечно «shipping not named», разрыв к держателю, у которого канал назвал доставку только в Buy Box, не считался, а «Beat the
 * lowest» с ориентиром Buy Box и сравнением с доставкой решал на базе иначе, чем в памяти. Где канал не назвал — честное отсутствие.
 * Данные синтетические.
 */

const KAUFLAND = '20000000-0000-4000-8000-000000001051';
const AMAZON = '20000000-0000-4000-8000-000000001052';
const AMAZON_DE = 'A1PA6795UKMFR9';
const now = () => new Date().toISOString();
const eur = (amountMinor: number) => ({ amountMinor, currency: 'EUR', basis: 'GROSS' as const });
const FIXED = { strategyId: 'st-fixed', version: 1, params: { type: 'FIXED', priceMinor: 1950 }, deadbandMinor: 0 } as const;
const BEAT_BB_LANDED = { strategyId: 'st-beat-bb', version: 1,
  params: { type: 'BEAT_LOWEST', undercutMinor: 1, scope: 'VISIBLE_TOP_N', compareLanded: true, atBound: 'CAP', anchor: 'BUYBOX' }, deadbandMinor: 0 } as const;

function scope(n: number, strategy: MemorySeedScope['strategy'], account: string, over: Partial<MemorySeedScope> = {}): MemorySeedScope {
  return {
    writeScopeId: `ws-${n}`, productId: `prod-${n}`, channelAccountId: account, marketplace: 'de', externalUnitId: String(10510 + n),
    channelProductRef: `105100${n}`, condition: 'new', currency: 'EUR', basis: 'GROSS', pricingMode: 'ENGINE', strategy, cost: engineCost(),
    currentPriceMinor: 1950, minPrice: { amountMinor: 1000, id: `min-${n}` }, maxPrice: { amountMinor: 3000, id: `max-${n}` }, ...over,
  };
}

let db: IsolatedDatabase;
let pool: PgPool;
let admin: PgPool;
let kaufland: SeededPricingWorld;
let amazon: SeededPricingWorld;
let store: PgPricingStore;

before(async () => {
  db = await createIsolatedDatabase('step105_1');
  pool = db.pool('svc_app');
  admin = db.pool('svc_admin', 2);
  kaufland = await seedPricingWorld(pool, { provisioningPool: db.pool('svc_provisioning', 1), adminPool: admin,
    fixtureTenantId: '10000000-0000-4000-8000-000000001051', fixtureChannelAccountId: KAUFLAND, marketplaces: ['de'], clock: now(),
    seed: { scopes: [scope(1, FIXED, KAUFLAND), scope(2, FIXED, KAUFLAND), scope(4, FIXED, KAUFLAND)] } });
  amazon = await seedPricingWorld(pool, { provisioningPool: db.pool('svc_provisioning', 1), adminPool: admin,
    fixtureTenantId: '10000000-0000-4000-8000-000000001052', fixtureChannelAccountId: AMAZON, fixtureChannel: 'AMAZON', fixtureRegion: 'EU',
    fixtureExternalAccountId: 'A1SYN1051', marketplaces: [AMAZON_DE], clock: now(),
    seed: { scopes: [scope(3, BEAT_BB_LANDED, AMAZON, { marketplace: AMAZON_DE, channelProductRef: 'B000105103', externalUnitId: 'SYN-SKU-1051' })] } });
  store = new PgPricingStore(pool, { adminPool: admin });
});
after(async () => { await db?.drop(); });

function adapterOf(channel: 'KAUFLAND' | 'AMAZON'): ChannelAdapter {
  // Kaufland /buybox называет держателя (ранг 1); Amazon ANY_OFFER_CHANGED — цену и доставку Buy Box без держателя (A-29)
  const source = channel === 'KAUFLAND'
    ? { source: 'KAUFLAND_BUYBOX', kind: 'PULL', completeness: { kind: 'TOP_N', n: 10 }, hasBuyboxWinner: true, hasOwnRank: true, hasFulfilment: false }
    : { source: 'AMAZON_ANY_OFFER_CHANGED', kind: 'PUSH', completeness: { kind: 'TOP_N', n: 20 }, hasBuyboxWinner: false, hasOwnRank: false, hasFulfilment: true };
  return {
    descriptor: { channel, scheduledRecomputeSeconds: 900, competitorSources: [{ ...source, conditions: ['new'], hasBuyboxPrice: true, hasShipping: true,
      typicalStalenessSeconds: null, availability: 'AVAILABLE', role: 'PRIMARY' }] },
    async planDispatch(_ctx: unknown, writes: readonly FieldWrite[]) {
      return { batches: writes.map((w) => ({ batchId: `b:${w.channelWriteId}`, operation: 'TEST', items: [w], budgetCharges: [], requestCount: 1 })), rejected: [] };
    },
    async dispatch(_ctx: unknown, batch: { batchId: string; items: FieldWrite[] }) {
      return { batchId: batch.batchId, outcomes: batch.items.map((w) => ({ channelWriteId: w.channelWriteId, status: 'ACCEPTED', appliedImmediately: true })), attemptsMade: 1 };
    },
    async readBack() { return { observations: [], failures: [] }; },
  } as unknown as ChannelAdapter;
}
const pipelineOf = (channel: 'KAUFLAND' | 'AMAZON') =>
  createPricingPipeline({ store: new PgPricingStore(pool), adapter: adapterOf(channel), alerts: { raise: async () => undefined }, logger: { log: () => undefined }, now: () => now() as never });
const ctxOf = (world: SeededPricingWorld, account: string): AdapterCallContext => ({ tenantId: world.tenantId as never, channelAccountId: world.ids.dbId(account) as never,
  correlationId: 'step105.1', deadline: new Date(Date.now() + 60_000).toISOString() as never });

/**
 * Kaufland /buybox: держатель — ранг 1, продавец Buy Box назван; доставку предложения-держателя или Buy Box канал может не назвать, а
 * признак держателя у строки — не поставить (тогда держатель находится по продавцу Buy Box, как в правиле экрана)
 */
function kauflandMarket(n: number, holderPrice: number, holderShipping: number | null, buyboxShipping: number | null, flagHolder = true): CompetitorSnapshot {
  const offers: CompetitorOffer[] = [
    { rank: 1, sellerRef: 'Prime Shelf', isSelf: false, price: eur(holderPrice), ...(holderShipping === null ? {} : { shipping: eur(holderShipping), totalPrice: eur(holderPrice + holderShipping) }),
      ...(flagHolder ? { holdsBuyBox: true } : {}) },
    { rank: 2, sellerRef: 'North Ridge', isSelf: false, price: eur(1899), shipping: eur(0), totalPrice: eur(1899) },
    { rank: 3, isSelf: true, price: eur(1950), shipping: eur(0), totalPrice: eur(1950) },
  ];
  return {
    marketplace: 'de', channelProductRef: `105100${n}`, condition: 'new', source: 'KAUFLAND_BUYBOX', observedAt: now() as never, completeness: { kind: 'TOP_N', n: 10 },
    buybox: { price: eur(holderPrice), isSelf: false, ...(buyboxShipping === null ? {} : { shipping: eur(buyboxShipping) }), sellerRef: 'Prime Shelf' }, offers,
  };
}

/** Amazon ANY_OFFER_CHANGED: Summary.BuyBoxPrices — цена и доставка Buy Box, держатель не назван; у предложений признака держателя нет */
function amazonMarket(): CompetitorSnapshot {
  return {
    marketplace: AMAZON_DE, channelProductRef: 'B000105103', condition: 'new', source: 'AMAZON_ANY_OFFER_CHANGED', observedAt: now() as never,
    completeness: { kind: 'TOP_N', n: 20 },
    buybox: { price: eur(1800), shipping: eur(150), isSelf: null },
    offers: [
      { isSelf: false, sellerRef: 'A2SYNHOLDER1051', price: eur(1800), shipping: eur(150), fulfillment: 'MFN' },
      // Самая низкая с доставкой — 18,50 €, ниже Buy Box с доставкой (19,50 €): ориентиры «Buy Box» и «самая низкая» дают разные цены
      { isSelf: false, sellerRef: 'A2SYNPINE1051', price: eur(1850), shipping: eur(0), fulfillment: 'MFN' },
      { isSelf: true, price: eur(1950), shipping: eur(0), fulfillment: 'MFN' },
    ],
  };
}

test('step 105.1 [Р-230]: the snapshot projection keeps the Buy Box shipping and seller the channel named — and nothing it did not name', async () => {
  await pipelineOf('KAUFLAND').processSnapshot(ctxOf(kaufland, KAUFLAND), kauflandMarket(2, 1800, null, 100));
  await pipelineOf('AMAZON').processSnapshot(ctxOf(amazon, AMAZON), amazonMarket());
  const k = await store.competitionSnapshot(kaufland.tenantId, kaufland.ids.dbId('ws-2'));
  assert.deepEqual(k?.snapshot.buybox, { price: eur(1800), isSelf: false, shipping: eur(100), sellerRef: 'Prime Shelf' }, 'Kaufland: Buy Box shipping and seller as named');
  const a = await store.competitionSnapshot(amazon.tenantId, amazon.ids.dbId('ws-3'));
  assert.deepEqual(a?.snapshot.buybox, { price: eur(1800), isSelf: null, shipping: eur(150) }, 'Amazon: Buy Box shipping named, the holder is not');
  // Канал не назвал доставку Buy Box — её нет и в проекции (не ноль)
  await pipelineOf('KAUFLAND').processSnapshot(ctxOf(kaufland, KAUFLAND), { ...kauflandMarket(1, 1840, 0, 0), buybox: { price: eur(1840), isSelf: false, sellerRef: 'Prime Shelf' } });
  const plain = await store.competitionSnapshot(kaufland.tenantId, kaufland.ids.dbId('ws-1'));
  assert.equal(JSON.stringify(plain?.snapshot.buybox), JSON.stringify({ price: eur(1840), isSelf: false, sellerRef: 'Prime Shelf' }), 'shipping the channel did not name stays absent');
});

test('step 105.1 [Р-230]: a recompute from the stored snapshot decides the Amazon Buy Box anchor on the landed Buy Box price, as the incoming snapshot does', async () => {
  /**
   * Путь снимка решает по ПРИШЕДШЕМУ снимку — в нём доставка Buy Box есть и без шага. Пересчёт без снимка (плановый, лестница, переоценка
   * после входов пола) читает ПРОЕКЦИЮ — до шага в ней доставки не было, и ориентир Buy Box с доставкой выпадал «нет доставки», хотя в памяти
   * тот же пересчёт её видел. Ориентир: 18,00 € + 1,50 € = 19,50 €, подрез 0,01 €, своя доставка 0 — 19,49 € (ориентир «самая низкая»
   * дал бы 18,49 €)
   */
  const p = pipelineOf('AMAZON');
  await p.processSnapshot(ctxOf(amazon, AMAZON), { ...amazonMarket(), observedAt: now() as never });
  // Плановый пересчёт — тем же триггером, что у работы планировщика: ручное намерение путь решения не создаёт [Р-107]
  const report = await p.recompute(ctxOf(amazon, AMAZON), amazon.ids.dbId('ws-3'), { type: 'SCHEDULE' }) as unknown as {
    stages: Array<{ stage: string; outcome: string; reason?: { code: string; params?: Record<string, unknown> } }>;
    intent?: { proposedMinor: number | null; explanation: Array<{ code: string; params: Record<string, unknown> }> };
  };
  const strategy = report.stages.find((s) => s.stage === 'STRATEGY');
  const anchor = report.intent?.explanation.find((e) => e.code === 'ANCHOR_UNDERCUT')?.params;
  assert.equal(JSON.stringify([strategy?.outcome === 'NOT_EVALUATED' ? strategy.reason?.code : 'EVALUATED', report.intent?.proposedMinor ?? null, anchor?.anchorUsed ?? null]),
    JSON.stringify(['EVALUATED', 1949, 'BUYBOX']), `the recompute from the stored snapshot: ${JSON.stringify(report.stages)}`);
  assert.ok(report.stages.every((s) => s.outcome !== 'ERROR'), `the recompute commits: ${JSON.stringify(report.stages)}`);
});

test('step 105.1 [Р-230]: the Offers gap counts from the landed Buy Box price where the holder is named — the database sorts by it', async () => {
  /**
   * ws-1: доставка держателя названа у его строки — 18,40 €, разрыв +1,10 €; ws-2: только в Buy Box — 18,00 € + 1,00 €, разрыв +0,50 €;
   * ws-4: доставка Buy Box не названа, признака держателя у строки нет — держатель по продавцу Buy Box, 18,20 € + 0,50 €, разрыв +0,80 €
   */
  await pipelineOf('KAUFLAND').processSnapshot(ctxOf(kaufland, KAUFLAND), kauflandMarket(1, 1840, 0, 0));
  await pipelineOf('KAUFLAND').processSnapshot(ctxOf(kaufland, KAUFLAND), kauflandMarket(2, 1800, null, 100));
  await pipelineOf('KAUFLAND').processSnapshot(ctxOf(kaufland, KAUFLAND), kauflandMarket(4, 1820, 50, null, false));
  const until = now() as never;
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString() as never;
  const page = async (dir: 'asc' | 'desc') => (await store.consoleCatalogPage(kaufland.tenantId, until, { offset: 0, limit: 10, offers: {
    sort: { key: 'gap', dir }, buybox: { since, until, noDataAccounts: [], namedAccounts: [kaufland.ids.dbId(KAUFLAND)], shareAccounts: [kaufland.ids.dbId(KAUFLAND)] } } })).scopeIds;
  const [ws1, ws2, ws4] = [kaufland.ids.dbId('ws-1'), kaufland.ids.dbId('ws-2'), kaufland.ids.dbId('ws-4')];
  assert.deepEqual(await page('asc'), [ws2, ws4, ws1], 'gap ascending: +0.50 (Buy Box shipping), +0.80 (holder by the Buy Box seller), +1.10');
  assert.deepEqual(await page('desc'), [ws1, ws4, ws2], 'gap descending');
});

test('step 105.1 [Р-230]: the database refuses a malformed Buy Box in the snapshot projection', async () => {
  await pipelineOf('KAUFLAND').processSnapshot(ctxOf(kaufland, KAUFLAND), kauflandMarket(2, 1800, null, 100));
  const update = (set: string, params: unknown[] = []) => inTenant(pool, kaufland.tenantId, async (tx) => tx.query(
    `UPDATE channel_data.competitor_state SET ${set} WHERE tenant_id = $1 AND channel_account_id = $2 AND channel_product_ref = '1051002'`,
    [kaufland.tenantId, kaufland.ids.dbId(KAUFLAND), ...params]));
  await assert.rejects(update('buybox_shipping_minor = -1'), /competitor_state_buybox_shipping_nonnegative/, 'a negative Buy Box shipping is refused');
  await assert.rejects(update('buybox_amount_minor = NULL, buybox_is_self = NULL, buybox_seller_ref = NULL'), /competitor_state_buybox_shipping_with_price/,
    'Buy Box shipping without a Buy Box price is refused');
  await assert.rejects(update('buybox_is_self = true'), /competitor_state_buybox_seller_other/, 'a seller is named only for another holder');
  await assert.rejects(update('buybox_is_self = NULL'), /competitor_state_buybox_seller_other/, 'an unknown holder has no seller');
  await assert.rejects(update('buybox_seller_ref = $3', ['x'.repeat(201)]), /competitor_state_buybox_seller_length/, 'a seller name is at most 200 characters');
  await assert.rejects(update(`buybox_seller_ref = ''`), /competitor_state_buybox_seller_length/, 'an empty seller name is refused');
  await update('buybox_shipping_minor = 0, buybox_seller_ref = $3', ['North Ridge']);
});
