import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { AdapterCallContext, ChannelAdapter, CompetitorOffer, CompetitorSnapshot, FieldWrite } from '@repracer/channel-port';
import { createPricingPipeline, type MemorySeedScope } from '@repracer/pricing-pipeline';
import { inTenant, PgPricingStore, seedPricingWorld, type PgPool, type SeededPricingWorld } from '../src/index.ts';
import { approved, contextOf, engineCost, explained } from './drafts.ts';
import { createIsolatedDatabase, type IsolatedDatabase } from './isolated-db.ts';

/**
 * Шаг 97 [Р-218…Р-221] на PostgreSQL: квитанция решения несёт картину рынка и «кто подвинул цену» (дифф против предыдущего принятого
 * снимка), держатель Buy Box копится отрезками для доли за период; защиты 0187–0189 отказывают своей причиной. Данные синтетические.
 */

const ACCOUNT = '20000000-0000-4000-8000-000000000097';
const MINUTE_MS = 60_000;
let skewMs = 0;
const now = () => new Date(Date.now() + skewMs).toISOString();
const WIN = { strategyId: 'st-win', version: 1, params: { type: 'WIN_BUYBOX', undercutMinor: 5, fulfillmentHandicapMinor: 0, creepUp: true, creepStepBp: 100, atBound: 'CAP' }, deadbandMinor: 0 } as const;
const FIXED = { strategyId: 'st-fixed', version: 1, params: { type: 'FIXED', priceMinor: 1900 }, deadbandMinor: 0 } as const;

function scope(n: number, over: Partial<MemorySeedScope> = {}): MemorySeedScope {
  return {
    writeScopeId: `ws-${n}`, productId: `prod-${n}`, channelAccountId: ACCOUNT, marketplace: 'de', externalUnitId: String(9700 + n),
    channelProductRef: `39797${n}`, condition: 'new', currency: 'EUR', basis: 'GROSS', pricingMode: 'ENGINE', strategy: WIN, cost: engineCost(),
    currentPriceMinor: 1900, minPrice: { amountMinor: 1000, id: `min-${n}` }, maxPrice: { amountMinor: 3000, id: `max-${n}` }, ...over,
  };
}

let db: IsolatedDatabase;
let pool: PgPool;
let admin: PgPool;
let world: SeededPricingWorld;
let store: PgPricingStore;
const sent: FieldWrite[] = [];

before(async () => {
  db = await createIsolatedDatabase('step97');
  pool = db.pool('svc_app');
  admin = db.pool('svc_admin', 2);
  world = await seedPricingWorld(pool, { provisioningPool: db.pool('svc_provisioning', 1), adminPool: admin,
    fixtureTenantId: '10000000-0000-4000-8000-000000000097', fixtureChannelAccountId: ACCOUNT, marketplaces: ['de'], clock: now(),
    seed: { scopes: [scope(1), scope(2, { strategy: FIXED })] } });
  store = new PgPricingStore(pool);
});
after(async () => { await db?.drop(); });

// Источник называет держателя Buy Box — как Kaufland /buybox (ранг 1)
const adapter = {
  descriptor: { channel: 'KAUFLAND', scheduledRecomputeSeconds: 900, competitorSources: [{ source: 'KAUFLAND_BUYBOX', kind: 'PULL', completeness: { kind: 'TOP_N', n: 10 },
    conditions: ['new'], hasBuyboxWinner: true, hasBuyboxPrice: true, hasOwnRank: true, hasShipping: true, typicalStalenessSeconds: null, availability: 'AVAILABLE', role: 'PRIMARY' }] },
  async planDispatch(_ctx: unknown, writes: readonly FieldWrite[]) {
    return { batches: writes.map((w) => ({ batchId: `b:${w.channelWriteId}`, operation: 'TEST', items: [w], budgetCharges: [], requestCount: 1 })), rejected: [] };
  },
  async dispatch(_ctx: unknown, batch: { batchId: string; items: FieldWrite[] }) {
    sent.push(...batch.items);
    return { batchId: batch.batchId, outcomes: batch.items.map((w) => ({ channelWriteId: w.channelWriteId, status: 'ACCEPTED', appliedImmediately: true })), attemptsMade: 1 };
  },
  async readBack() { return { observations: [], failures: [] }; },
} as unknown as ChannelAdapter;
const pipeline = () => createPricingPipeline({ store, adapter, alerts: { raise: async () => undefined }, logger: { log: () => undefined }, now: () => now() as never });
const ctx: () => AdapterCallContext = () => ({ tenantId: world.tenantId as never, channelAccountId: world.ids.dbId(ACCOUNT) as never, correlationId: 'step97', deadline: new Date(Date.now() + 60_000).toISOString() as never });
const eur = (amountMinor: number) => ({ amountMinor, currency: 'EUR', basis: 'GROSS' as const });

function market(n: number, offers: Array<[string | null, number]>, holder: string | null): CompetitorSnapshot {
  const list: CompetitorOffer[] = offers.map(([seller, price], i) => ({
    rank: i + 1, isSelf: seller === null, ...(seller ? { sellerRef: seller } : {}), price: eur(price), shipping: eur(0), totalPrice: eur(price),
    ...((seller ?? 'self') === (holder ?? 'self') ? { holdsBuyBox: true } : {}),
  }));
  const top = list.find((o) => o.holdsBuyBox)!;
  return {
    marketplace: 'de', channelProductRef: `39797${n}`, condition: 'new', source: 'KAUFLAND_BUYBOX', observedAt: now() as never, completeness: { kind: 'TOP_N', n: 10 },
    buybox: { price: top.price, isSelf: top.isSelf, shipping: eur(0), ...(top.isSelf ? {} : { sellerRef: top.sellerRef! }) }, offers: list,
  };
}

const decisions = (n: number) => inTenant(pool, world.tenantId, async (tx) => (await tx.query(
  `SELECT price_decision_id, outcome, competitor_view FROM channel_data.price_decision WHERE tenant_id = $1 AND write_scope_id = $2 ORDER BY decided_at, price_decision_id`,
  [world.tenantId, world.ids.dbId(`ws-${n}`)])).rows);
const spans = (n: number) => inTenant(pool, world.tenantId, async (tx) => (await tx.query(
  `SELECT b.holder, b.winner_seller_ref, b.snapshots FROM channel_data.buybox_span b WHERE b.tenant_id = $1 AND b.channel_product_ref = $2 ORDER BY b.started_at`,
  [world.tenantId, `39797${n}`])).rows);

test('step 97 (I1) [Р-218]: the receipt of a competitor-derived decision names who moved the price; the diff is against the previous accepted snapshot', async () => {
  const p = pipeline();
  // Первый снимок: Buy Box у Harbor Goods за 18,00 € — сравнивать не с чем, «кто подвинул» нет
  await p.processSnapshot(ctx(), market(1, [['Harbor Goods', 1800], ['Pine & Co', 1840], [null, 1900]], 'Harbor Goods'));
  const [first] = await decisions(1);
  assert.equal(first.outcome, 'APPROVED');
  assert.equal(first.competitor_view.trigger, null, 'the first accepted snapshot has nothing to compare with');
  assert.deepEqual(first.competitor_view.offers.map((o: { seller: string | null; holdsBuyBox?: boolean }) => [o.seller, o.holdsBuyBox ?? null]),
    [['Harbor Goods', true], ['Pine & Co', null], [null, null]]);
  skewMs += MINUTE_MS;
  // Второй: Harbor Goods снизил цену до 17,50 €, Pine & Co ушёл, появился North Ridge
  await p.processSnapshot(ctx(), market(1, [['Harbor Goods', 1750], ['North Ridge', 1790], [null, 1795]], 'Harbor Goods'));
  const second = (await decisions(1)).at(-1)!;
  assert.deepEqual(second.competitor_view.trigger, { seller: 'Harbor Goods', move: 'DOWN', wasMinor: 1800, nowMinor: 1750 }, 'the receipt says who moved the price');
  assert.deepEqual(second.competitor_view.offers.map((o: { seller: string | null; move?: string }) => [o.seller, o.move ?? null]),
    [['Harbor Goods', 'DOWN'], ['North Ridge', 'APPEARED'], [null, null], ['Pine & Co', 'GONE']]);
  // То же решение — в квитанции, которую читает консоль
  const detail = await new PgPricingStore(pool, { adminPool: admin }).decisionDetail(world.tenantId, second.price_decision_id);
  assert.deepEqual(detail?.decision.competitorView?.trigger, second.competitor_view.trigger);
  // У фиксированной цены картины рынка нет: рынок её не двигает
  await p.recompute(ctx(), world.ids.dbId('ws-2'), { type: 'MANUAL' });
  assert.ok((await decisions(2)).every((d: { competitor_view: unknown }) => d.competitor_view === null), 'a fixed price keeps no competitor view');
});

test('step 97 (I2) [Р-220]: the Buy Box holder is kept as spans — extended by the same holder, a new span on a change', async () => {
  const p = pipeline();
  skewMs += MINUTE_MS;
  await p.processSnapshot(ctx(), market(1, [['Harbor Goods', 1740], [null, 1745]], 'Harbor Goods'));
  skewMs += MINUTE_MS;
  await p.processSnapshot(ctx(), market(1, [[null, 1735], ['Harbor Goods', 1740]], null));
  const rows = await spans(1);
  assert.deepEqual(rows.map((r: { holder: string; winner_seller_ref: string | null }) => [r.holder, r.winner_seller_ref]), [['OTHER', 'Harbor Goods'], ['SELF', null]]);
  assert.equal(rows[0].snapshots, 3, 'the same holder extends its span');
  const read = await new PgPricingStore(pool, { adminPool: admin }).buyboxSpans(world.tenantId, world.ids.dbId('ws-1'), new Date(Date.now() - 3_600_000).toISOString(), now());
  assert.deepEqual(read.map((s) => s.holder), ['OTHER', 'SELF']);
});

test('step 97 [Р-218, Р-220]: the database refuses a malformed competitor view, a view outside a competitor decision and a rewritten Buy Box span', async () => {
  const ctxWin = await contextOf(store, world.tenantId, world.ids.dbId('ws-1'));
  const base = approved(ctxWin, 1730);
  const draft = { ...base, intent: { ...base.intent, ruleCode: 'WIN_BUYBOX' as const } };
  const ref = { competitorSnapshotId: '00000000-0000-4000-8000-000000009701', source: 'KAUFLAND_BUYBOX', observedAt: now() };
  const commit = (d: ReturnType<typeof explained>) => store.commitEvaluation(world.tenantId, {
    key: { channelAccountId: ctxWin.scope.channelAccountId, marketplace: 'de', channelProductRef: ctxWin.scope.channelProductRef, condition: 'new' }, now: now(), decisions: [d] });
  const bad = { ...explained(draft, ref), competitorView: { currency: 'EUR', trigger: null, offers: [{ seller: 'A', self: false, priceMinor: '17.30', note: 'free text' }] } } as never;
  await assert.rejects(commit(bad), /price_decision_competitor_view_shape/, 'a competitor view with a field outside the list is refused');
  const ctxFixed = await contextOf(store, world.tenantId, world.ids.dbId('ws-2'));
  const fixed = { ...explained(approved(ctxFixed, 1910)), competitorView: { currency: 'EUR', trigger: null, offers: [{ seller: 'A', self: false, priceMinor: 1800 }] } };
  await assert.rejects(store.commitEvaluation(world.tenantId, {
    key: { channelAccountId: ctxFixed.scope.channelAccountId, marketplace: 'de', channelProductRef: ctxFixed.scope.channelProductRef, condition: 'new' }, now: now(), decisions: [fixed] }),
  /price_decision_competitor_view_scope/, 'a fixed price carries no competitor view');

  const span = (sql: string, params: unknown[] = []) => inTenant(pool, world.tenantId, async (tx) => tx.query(sql, [world.tenantId, world.ids.dbId(ACCOUNT), ...params]));
  const insert = (holder: string, seller: string | null, started: string, seen: string, snapshots = 1) => span(
    `INSERT INTO channel_data.buybox_span (tenant_id, channel_account_id, marketplace, channel_product_ref, condition, holder, winner_seller_ref, started_at, last_seen_at, snapshots)
     VALUES ($1, $2, 'de', '397979', 'new', $3, $4, $5, $6, $7)`, [holder, seller, started, seen, snapshots]);
  const t0 = new Date(Date.now() - 600_000).toISOString();
  await assert.rejects(insert('MAYBE', null, t0, t0), /buybox_span_holder_known/, 'a holder outside SELF, OTHER, NONE is refused');
  await assert.rejects(insert('SELF', 'Harbor Goods', t0, t0), /buybox_span_winner_only_other/, 'a seller is named only for another holder');
  await assert.rejects(insert('NONE', null, now(), t0), /buybox_span_seen_after_start/, 'a span is not seen before it starts');
  await assert.rejects(insert('NONE', null, t0, t0, 0), /buybox_span_snapshots_positive/, 'a span has at least one snapshot');
  // Отрезок длиной десять минут: укорочение на минуту не задевает «видим не раньше начала» — отказывает только страж продления
  await insert('OTHER', 'Harbor Goods', new Date(Date.parse(t0) - 600_000).toISOString(), t0);
  await assert.rejects(span(`UPDATE channel_data.buybox_span SET holder = 'SELF', winner_seller_ref = NULL WHERE tenant_id = $1 AND channel_account_id = $2 AND channel_product_ref = '397979'`),
    /immutable except its extension/, 'the holder of a span is not rewritten');
  await assert.rejects(span(`UPDATE channel_data.buybox_span SET last_seen_at = last_seen_at - interval '1 minute' WHERE tenant_id = $1 AND channel_account_id = $2 AND channel_product_ref = '397979'`),
    /only extended forward/, 'a span is not shortened');
});

test('step 97 [Р-91, Р-219]: the fulfilment handicap lives with the undercut — never in the eternal version, never negative, never missing', async () => {
  const strategyId = world.ids.dbId('st-win');
  const qa = (sql: string, params: unknown[] = []) => inTenant(admin, world.tenantId, async (tx) => (await tx.query(sql, [world.tenantId, strategyId, ...params])).rows, world.userId);
  const [stored] = await qa('SELECT s.params, u.fulfillment_handicap_minor::int AS handicap FROM tenant_data.pricing_strategy s JOIN channel_data.pricing_strategy_undercut u USING (tenant_id, pricing_strategy_id, version) WHERE s.tenant_id = $1 AND s.pricing_strategy_id = $2');
  assert.equal('fulfillmentHandicapMinor' in stored.params, false);
  assert.equal(stored.handicap, 0);
  const version = (v: number, params: object) => `INSERT INTO tenant_data.pricing_strategy (tenant_id, pricing_strategy_id, version, name, type, params, triggers, status, created_by_membership_id)
    VALUES ($1, $2, ${v}, 'st-win', 'WIN_BUYBOX', '${JSON.stringify(params)}', '{COMPETITOR_CHANGE}', 'ACTIVE', '${world.ownerMembershipId}')`;
  const params = { type: 'WIN_BUYBOX', creepUp: false, creepStepBp: 100, atBound: 'CAP', deadbandMinor: 0 };
  // Версия с гандикапом в параметрах — вместе с подрезом и гандикапом в своей таблице: отказывает только ограничение вечной версии
  await assert.rejects(inTenant(admin, world.tenantId, async (tx) => {
    await tx.query(version(2, { ...params, fulfillmentHandicapMinor: 20 }), [world.tenantId, strategyId]);
    await tx.query('INSERT INTO channel_data.pricing_strategy_undercut (tenant_id, pricing_strategy_id, version, undercut_minor, fulfillment_handicap_minor) VALUES ($1, $2, 2, 5, 20)', [world.tenantId, strategyId]);
  }, world.userId), /pricing_strategy_handicap_not_eternal/, 'the handicap is not kept in the eternal strategy version');
  await assert.rejects(inTenant(admin, world.tenantId, async (tx) => {
    await tx.query(version(2, params), [world.tenantId, strategyId]);
    await tx.query('INSERT INTO channel_data.pricing_strategy_undercut (tenant_id, pricing_strategy_id, version, undercut_minor, fulfillment_handicap_minor) VALUES ($1, $2, 2, 5, -1)', [world.tenantId, strategyId]);
  }, world.userId), /pricing_strategy_undercut_handicap_non_negative/, 'a negative handicap is refused');
  await assert.rejects(inTenant(admin, world.tenantId, async (tx) => {
    await tx.query(version(2, params), [world.tenantId, strategyId]);
    await tx.query('INSERT INTO channel_data.pricing_strategy_undercut (tenant_id, pricing_strategy_id, version, undercut_minor) VALUES ($1, $2, 2, 5)', [world.tenantId, strategyId]);
  }, world.userId), /needs its fulfilment handicap/, 'Win the Buy Box without a handicap is refused');
});

test('step 97 [Р-39, Р-221]: Win the Buy Box needs a named holder — unavailable on Amazon, available on Kaufland and Walmart; Match the Buy Box needs only the price', async () => {
  const unmet = async (channel: string, params: object) => (await pool.query('SELECT channel_data.strategy_unmet($1, $2) AS u', [channel, JSON.stringify(params)])).rows[0].u;
  const win = { type: 'WIN_BUYBOX', creepUp: false, creepStepBp: 100, atBound: 'CAP' };
  // Строкой: фактический результат «без защиты» — `{}` (доступна), а не дифф двух объектов
  assert.equal(JSON.stringify(await unmet('AMAZON', win)),
    JSON.stringify({ AMAZON_ANY_OFFER_CHANGED: ['BUYBOX_WINNER'], AMAZON_COMPETITIVE_SUMMARY: ['RECONCILIATION_ONLY', 'BUYBOX_PRICE', 'BUYBOX_WINNER'] }),
    'Win the Buy Box is unavailable where the channel does not name the holder');
  assert.deepEqual(await unmet('KAUFLAND', win), {}, 'Win the Buy Box is available on Kaufland');
  assert.deepEqual(await unmet('WALMART', win), {}, 'Win the Buy Box is available on Walmart');
  assert.deepEqual(await unmet('AMAZON', { type: 'MATCH_BUYBOX', holdWhenWinning: true, atBound: 'CAP' }), {}, 'Match the Buy Box needs only the Buy Box price');
});
