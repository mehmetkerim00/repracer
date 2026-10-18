import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { AdapterCallContext, ChannelAdapter, CompetitorOffer, CompetitorSnapshot, FieldWrite } from '@repracer/channel-port';
import { createPricingPipeline, type MemorySeedScope } from '@repracer/pricing-pipeline';
import { inTenant, PgPricingStore, seedPricingWorld, type PgPool, type SeededPricingWorld } from '../src/index.ts';
import { approved, contextOf, engineCost, explained } from './drafts.ts';
import { createIsolatedDatabase, type IsolatedDatabase } from './isolated-db.ts';

/**
 * Шаг 101 [Р-226] на PostgreSQL: ориентир и фильтр «Compete with» живут рядом с подрезом (0195) — путь решения пишет картину рынка с
 * пометками фильтра и причину победившего ориентира, «никого после фильтра» — «без изменения» своим кодом; защиты отказывают своей
 * причиной: настройки вне вечной версии, известные значения, неизменяемость, ориентир только у своих типов, фильтр только там, где канал
 * называет исполнение (и страж назначения это видит), форма картины. Данные синтетические.
 */

const ACCOUNT = '20000000-0000-4000-8000-000000000101';
const AMAZON_ACCOUNT = '20000000-0000-4000-8000-000000000102';
const now = () => new Date().toISOString();
const beat = (id: string, extra: Record<string, string>) => ({ strategyId: id, version: 1, params: { type: 'BEAT_LOWEST', undercutMinor: 1, scope: 'VISIBLE_TOP_N', compareLanded: false, atBound: 'CAP', ...extra }, deadbandMinor: 0 }) as never;
const LOWER_FBA = beat('st-lower-fba', { anchor: 'LOWER_OF_TWO', competeWith: 'CHANNEL' });
const LOWER_ALL = beat('st-lower-all', { anchor: 'LOWER_OF_TWO' });
const FBM_ONLY = beat('st-fbm', { competeWith: 'MERCHANT' });

function scope(n: number, strategy: MemorySeedScope['strategy'], account = ACCOUNT, over: Partial<MemorySeedScope> = {}): MemorySeedScope {
  return {
    writeScopeId: `ws-${n}`, productId: `prod-${n}`, channelAccountId: account, marketplace: 'de', externalUnitId: String(10100 + n),
    channelProductRef: `10101${n}`, condition: 'new', currency: 'EUR', basis: 'GROSS', pricingMode: 'ENGINE', strategy, cost: engineCost(),
    currentPriceMinor: 1950, minPrice: { amountMinor: 1000, id: `min-${n}` }, maxPrice: { amountMinor: 3000, id: `max-${n}` }, ...over,
  };
}

let db: IsolatedDatabase;
let pool: PgPool;
let admin: PgPool;
let world: SeededPricingWorld;
let store: PgPricingStore;

before(async () => {
  db = await createIsolatedDatabase('step101');
  pool = db.pool('svc_app');
  admin = db.pool('svc_admin', 2);
  world = await seedPricingWorld(pool, { provisioningPool: db.pool('svc_provisioning', 1), adminPool: admin,
    fixtureTenantId: '10000000-0000-4000-8000-000000000101', fixtureChannelAccountId: ACCOUNT, marketplaces: ['de'], clock: now(),
    seed: { scopes: [scope(1, LOWER_FBA), scope(2, LOWER_ALL), scope(3, FBM_ONLY)] } });
  store = new PgPricingStore(pool);
});
after(async () => { await db?.drop(); });

// Kaufland /buybox: держатель Buy Box — ранг 1 ответа, исполнение — fulfillment_type предложения (необязательное)
const adapter = {
  descriptor: { channel: 'KAUFLAND', scheduledRecomputeSeconds: 900, competitorSources: [{ source: 'KAUFLAND_BUYBOX', kind: 'PULL', completeness: { kind: 'TOP_N', n: 10 },
    conditions: ['new'], hasBuyboxWinner: true, hasBuyboxPrice: true, hasFulfilment: true, hasOwnRank: true, hasShipping: true, typicalStalenessSeconds: null, availability: 'AVAILABLE', role: 'PRIMARY' }] },
  async planDispatch(_ctx: unknown, writes: readonly FieldWrite[]) {
    return { batches: writes.map((w) => ({ batchId: `b:${w.channelWriteId}`, operation: 'TEST', items: [w], budgetCharges: [], requestCount: 1 })), rejected: [] };
  },
  async dispatch(_ctx: unknown, batch: { batchId: string; items: FieldWrite[] }) {
    return { batchId: batch.batchId, outcomes: batch.items.map((w) => ({ channelWriteId: w.channelWriteId, status: 'ACCEPTED', appliedImmediately: true })), attemptsMade: 1 };
  },
  async readBack() { return { observations: [], failures: [] }; },
} as unknown as ChannelAdapter;
const pipeline = () => createPricingPipeline({ store, adapter, alerts: { raise: async () => undefined }, logger: { log: () => undefined }, now: () => now() as never });
const ctx: () => AdapterCallContext = () => ({ tenantId: world.tenantId as never, channelAccountId: world.ids.dbId(ACCOUNT) as never, correlationId: 'step101', deadline: new Date(Date.now() + 60_000).toISOString() as never });
const eur = (amountMinor: number) => ({ amountMinor, currency: 'EUR', basis: 'GROSS' as const });
const FBA = 'fulfilled_by_kaufland';
const FBM = 'fulfilled_by_merchant';

/** Лоукостер FBM €16.99, держатель Buy Box FBA €18.41, ещё FBA €18.99, исполнение не названо €17.50; мы — €19.50 */
function demoMarket(n: number, offers: Array<[string, number, string | null]> = [['Budget Bin', 1699, FBM], ['Quiet Lane', 1750, null], ['Prime Shelf', 1841, FBA], ['North Ridge', 1899, FBA]],
  holder = 'Prime Shelf'): CompetitorSnapshot {
  // Ранг 1 ответа /buybox — держатель Buy Box (проверка входов сверяет цену Buy Box с рангом 1), дальше — как назвал канал
  const ordered = [...offers.filter(([seller]) => seller === holder), ...offers.filter(([seller]) => seller !== holder)];
  const list: CompetitorOffer[] = [...ordered.map(([seller, price, fulfillment], i): CompetitorOffer => ({
    rank: i + 1, sellerRef: seller, isSelf: false, price: eur(price), shipping: eur(0), totalPrice: eur(price),
    ...(fulfillment ? { fulfillment } : {}), ...(seller === holder ? { holdsBuyBox: true } : {}),
  })), { rank: offers.length + 1, isSelf: true, price: eur(1950), shipping: eur(0), totalPrice: eur(1950), fulfillment: FBM }];
  const top = list.find((o) => o.holdsBuyBox)!;
  return {
    marketplace: 'de', channelProductRef: `10101${n}`, condition: 'new', source: 'KAUFLAND_BUYBOX', observedAt: now() as never, completeness: { kind: 'TOP_N', n: 10 },
    buybox: { price: top.price, isSelf: false, shipping: eur(0), sellerRef: top.sellerRef! }, offers: list,
  };
}

const decisions = (n: number) => inTenant(pool, world.tenantId, async (tx) => (await tx.query(
  `SELECT price_decision_id, outcome, final_amount_minor::int AS final, no_change_reason, competitor_view FROM channel_data.price_decision
    WHERE tenant_id = $1 AND write_scope_id = $2 ORDER BY decided_at, price_decision_id`, [world.tenantId, world.ids.dbId(`ws-${n}`)])).rows);

test('step 101 (1, 4) [Р-226]: the decision path stores the filter on the competitor view and names the anchor that won; nobody left — no change', async () => {
  const p = pipeline();
  // Только FBA, меньшая из двух: Buy Box €18.41 (держатель — FBA) и самая низкая среди FBA €18.41 — ориентир Buy Box, €18.40
  await p.processSnapshot(ctx(), demoMarket(1));
  const [fba] = await decisions(1);
  assert.deepEqual([fba.outcome, fba.final], ['APPROVED', 1840], 'the filter moves the price predictably: FBA only, not the FBM low-cost seller');
  assert.deepEqual(fba.competitor_view.filter, { competeWith: 'CHANNEL', total: 4, considered: 2, unknown: 1 }, 'the filter head counts the whole snapshot');
  const marks = Object.fromEntries(fba.competitor_view.offers.map((o: { seller: string | null; excluded?: string }) => [o.seller ?? 'self', o.excluded ?? null]));
  assert.deepEqual(marks, { 'Budget Bin': 'FILTER', 'Quiet Lane': 'UNKNOWN', 'Prime Shelf': null, 'North Ridge': null, self: null }, 'excluded offers stay in the view, marked');
  const detail = (await new PgPricingStore(pool, { adminPool: admin }).decisionDetail(world.tenantId, fba.price_decision_id))!;
  assert.deepEqual(detail.intent!.explanation.map((r) => r.code), ['COMPETITORS_FILTERED', 'ANCHOR_UNDERCUT']);
  assert.deepEqual([detail.intent!.reason.params.anchorUsed, detail.intent!.reason.params.otherAnchorMinor], ['BUYBOX', 1841]);

  // Без фильтра та же настройка: лоукостер €16.99 дешевле Buy Box — победила самая низкая, Buy Box назван рядом; картина без пометок
  await p.processSnapshot(ctx(), demoMarket(2));
  const [all] = await decisions(2);
  assert.deepEqual([all.outcome, all.final, all.competitor_view.filter ?? null], ['APPROVED', 1698, null]);
  assert.ok(all.competitor_view.offers.every((o: { excluded?: string }) => o.excluded === undefined));

  // Только FBM, а все конкуренты — FBA или без исполнения: «без изменения» своим кодом, к «всем» фильтр не откатывается
  await p.processSnapshot(ctx(), demoMarket(3, [['Prime Shelf', 1841, FBA], ['Quiet Lane', 1750, null]]));
  const [none] = await decisions(3);
  assert.deepEqual([none.outcome, none.no_change_reason, none.competitor_view], ['NO_CHANGE', 'NO_ELIGIBLE_COMPETITORS', null]);
});

test('step 101 [Р-226, Р-91]: the anchor and the filter live with the undercut — never eternal, known values only, immutable, the anchor only where it means something', async () => {
  const id = (alias: string) => world.ids.dbId(alias);
  const q = (fn: (tx: { query: (sql: string, params?: unknown[]) => Promise<unknown> }) => Promise<unknown>) => inTenant(admin, world.tenantId, fn as never, world.userId);
  const version = (strategy: string, v: number, type: string, params: object) => `INSERT INTO tenant_data.pricing_strategy (tenant_id, pricing_strategy_id, version, name, type, params, triggers, status, created_by_membership_id)
    VALUES ($1, '${strategy}', ${v}, 'step101', '${type}', '${JSON.stringify(params)}', '{COMPETITOR_CHANGE}', 'ACTIVE', '${world.ownerMembershipId}')`;
  const undercut = (strategy: string, v: number, anchor: string | null, competeWith: string | null) =>
    `INSERT INTO channel_data.pricing_strategy_undercut (tenant_id, pricing_strategy_id, version, undercut_minor, anchor, compete_with)
     VALUES ($1, '${strategy}', ${v}, 1, ${anchor ? `'${anchor}'` : 'NULL'}, ${competeWith ? `'${competeWith}'` : 'NULL'})`;
  const st = id('st-lower-all');
  const beatParams = { type: 'BEAT_LOWEST', scope: 'VISIBLE_TOP_N', compareLanded: false, atBound: 'CAP', deadbandMinor: 0 };
  const [stored] = (await inTenant(admin, world.tenantId, async (tx) => (await tx.query(
    `SELECT s.params, u.anchor, u.compete_with FROM tenant_data.pricing_strategy s JOIN channel_data.pricing_strategy_undercut u USING (tenant_id, pricing_strategy_id, version)
      WHERE s.tenant_id = $1 AND s.pricing_strategy_id = $2`, [world.tenantId, id('st-lower-fba')])).rows, world.userId));
  assert.deepEqual([('anchor' in stored.params) || ('competeWith' in stored.params), stored.anchor, stored.compete_with], [false, 'LOWER_OF_TWO', 'CHANNEL'], 'the seed keeps both next to the undercut');

  await assert.rejects(q(async (tx) => { await tx.query(version(st, 2, 'BEAT_LOWEST', { ...beatParams, anchor: 'BUYBOX' }), [world.tenantId]); await tx.query(undercut(st, 2, 'BUYBOX', null), [world.tenantId]); }),
    /pricing_strategy_choice_not_eternal/, 'the anchor and the filter are not kept in the eternal strategy version');
  await assert.rejects(q(async (tx) => { await tx.query(version(st, 2, 'BEAT_LOWEST', beatParams), [world.tenantId]); await tx.query(undercut(st, 2, 'MIDDLE', null), [world.tenantId]); }),
    /pricing_strategy_undercut_anchor_known/, 'an unknown anchor is refused');
  await assert.rejects(q(async (tx) => { await tx.query(version(st, 2, 'BEAT_LOWEST', beatParams), [world.tenantId]); await tx.query(undercut(st, 2, null, 'FBA'), [world.tenantId]); }),
    /pricing_strategy_undercut_compete_with_known/, 'an unknown compete-with value is refused');
  const matchParams = { type: 'MATCH_BUYBOX', holdWhenWinning: true, atBound: 'CAP', deadbandMinor: 0 };
  await assert.rejects(q(async (tx) => { await tx.query(version(st, 2, 'MATCH_BUYBOX', matchParams), [world.tenantId]); await tx.query(undercut(st, 2, 'BUYBOX', null), [world.tenantId]); }),
    /takes no anchor/, 'Match the Buy Box takes no anchor');
  // Положительный контроль: фильтр у «Match the Buy Box» — законная настройка
  await q(async (tx) => { await tx.query(version(st, 2, 'MATCH_BUYBOX', matchParams), [world.tenantId]); await tx.query(undercut(st, 2, null, 'CHANNEL'), [world.tenantId]); });

  // Версия 1 заменена версией 2, но ещё закреплена единицей: подмена ориентира вместе с отметкой замены отказывает именно неизменяемостью
  // (без неё строку держал бы уже следующий страж — «версия ещё закреплена», другой причиной)
  const old = id('st-lower-fba');
  await q(async (tx) => { await tx.query(version(old, 2, 'BEAT_LOWEST', beatParams), [world.tenantId]); await tx.query(undercut(old, 2, null, null), [world.tenantId]); });
  const supersede = (set: string) => q((tx) => tx.query(`UPDATE channel_data.pricing_strategy_undercut SET ${set}superseded_at = now() WHERE tenant_id = $1 AND pricing_strategy_id = '${old}' AND version = 1`, [world.tenantId]));
  // Строкой: фактический результат «без защиты» — отказ следующего стража («still pinned»), его и видит мутационная проверка
  const outcome = async (p: Promise<unknown>) => { try { await p; return 'accepted'; } catch (e) { return (e as Error).message; } };
  assert.match(await outcome(supersede(`anchor = 'BUYBOX', `)), /undercut of a strategy version is immutable/, 'the anchor of a version is not rewritten');
  assert.match(await outcome(supersede(`compete_with = 'MERCHANT', `)), /undercut of a strategy version is immutable/, 'the filter of a version is not rewritten');
  assert.match(await outcome(supersede('')), /still pinned by a write scope/, 'control: without a rewrite the next guard speaks');
});

test('step 101 [Р-39, Р-226]: the filter needs a source that names fulfilment — unavailable on Walmart; the assignment guard sees the filter of the version', async () => {
  const unmet = async (channel: string, params: object) => (await pool.query('SELECT channel_data.strategy_unmet($1, $2) AS u', [channel, JSON.stringify(params)])).rows[0].u;
  const win = { type: 'WIN_BUYBOX', creepUp: false, creepStepBp: 100, atBound: 'CAP' };
  // Строкой: фактический результат «без защиты» — `{}` (доступна)
  assert.equal(JSON.stringify(await unmet('WALMART', { ...win, competeWith: 'CHANNEL' })), JSON.stringify({ WALMART_BUY_BOX: ['FULFILMENT'] }),
    'a filter is unavailable where the channel does not name fulfilment');
  assert.deepEqual(await unmet('WALMART', win), {}, 'without a filter Win the Buy Box stays available on Walmart');
  assert.deepEqual(await unmet('KAUFLAND', { ...win, competeWith: 'MERCHANT' }), {}, 'Kaufland /buybox names fulfilment');
  const beatBb = { type: 'BEAT_LOWEST', scope: 'VISIBLE_TOP_N', compareLanded: false, atBound: 'CAP', anchor: 'BUYBOX' };
  assert.deepEqual(await unmet('AMAZON', beatBb), {}, 'a Buy Box anchor needs only the Buy Box price');
  assert.equal(JSON.stringify((await unmet('AMAZON', { ...beatBb, competeWith: 'CHANNEL' })).AMAZON_ANY_OFFER_CHANGED ?? null), JSON.stringify(['BUYBOX_WINNER']),
    'under a filter a Buy Box anchor needs the holder');
  assert.deepEqual(await unmet('AMAZON', { ...beatBb, anchor: 'LOWER_OF_TWO', competeWith: 'CHANNEL' }), {}, 'the lower of the two works without the holder');

  // Страж назначения [Р-39] читает фильтр версии из таблицы подреза: «Match the Buy Box» только с FBA — не на Amazon (держатель не назван)
  const amazon = await seedPricingWorld(pool, { provisioningPool: db.pool('svc_provisioning', 1), adminPool: admin,
    fixtureTenantId: '10000000-0000-4000-8000-000000000102', fixtureChannelAccountId: AMAZON_ACCOUNT, fixtureChannel: 'AMAZON', fixtureRegion: 'EU',
    fixtureExternalAccountId: 'A1SYN101', marketplaces: ['A1PA6795UKMFR9'], clock: now(),
    seed: { scopes: [scope(9, { strategyId: 'st-fixed', version: 1, params: { type: 'FIXED', priceMinor: 2000 }, deadbandMinor: 0 } as never, AMAZON_ACCOUNT,
      { marketplace: 'A1PA6795UKMFR9', channelProductRef: 'B000101009', externalUnitId: 'SYN-SKU-101' })] } });
  const assign = (competeWith: string | null) => inTenant(admin, amazon.tenantId, async (tx) => {
    const { rows: [s] } = await tx.query(`INSERT INTO tenant_data.pricing_strategy (tenant_id, pricing_strategy_id, version, name, type, params, triggers, status, created_by_membership_id)
      VALUES ($1, gen_random_uuid(), 1, 'match', 'MATCH_BUYBOX', '{"holdWhenWinning": true, "atBound": "CAP", "deadbandMinor": 0}', '{COMPETITOR_CHANGE}', 'ACTIVE', $2) RETURNING pricing_strategy_id`,
    [amazon.tenantId, amazon.ownerMembershipId]);
    await tx.query(`INSERT INTO channel_data.pricing_strategy_undercut (tenant_id, pricing_strategy_id, version, undercut_minor, compete_with) VALUES ($1, $2, 1, 5, $3)`,
      [amazon.tenantId, s.pricing_strategy_id, competeWith]);
    await tx.query(`UPDATE tenant_data.write_scope SET pricing_strategy_id = $2, pricing_strategy_version = 1 WHERE tenant_id = $1 AND write_scope_id = $3`,
      [amazon.tenantId, s.pricing_strategy_id, amazon.ids.dbId('ws-9')]);
  }, amazon.userId);
  await assert.rejects(assign('CHANNEL'), /is not available on channel AMAZON.*BUYBOX_WINNER/, 'a filtered Match the Buy Box is not assigned where the holder is not named');
  await assign(null);
});

test('step 101 [Р-218, Р-226]: the database refuses a malformed filter on the competitor view', async () => {
  const ctxScope = await contextOf(store, world.tenantId, world.ids.dbId('ws-2'));
  const base = approved(ctxScope, 1730);
  const draft = { ...base, intent: { ...base.intent, ruleCode: 'BEAT_LOWEST' as const } };
  const ref = { competitorSnapshotId: '00000000-0000-4000-8000-000000010101', source: 'KAUFLAND_BUYBOX', observedAt: now() };
  const commit = (view: unknown) => store.commitEvaluation(world.tenantId, {
    key: { channelAccountId: ctxScope.scope.channelAccountId, marketplace: 'de', channelProductRef: ctxScope.scope.channelProductRef, condition: 'new' }, now: now(),
    decisions: [{ ...explained(draft, ref), competitorView: view } as never] });
  const offer = { seller: 'A', self: false, priceMinor: 1800 };
  const filter = { competeWith: 'CHANNEL', total: 3, considered: 1, unknown: 1 };
  await assert.rejects(commit({ currency: 'EUR', trigger: null, offers: [{ ...offer, excluded: 'HIDDEN' }], filter }), /price_decision_competitor_view_shape/,
    'an exclusion mark outside FILTER and UNKNOWN is refused');
  await assert.rejects(commit({ currency: 'EUR', trigger: null, offers: [offer], filter: { ...filter, considered: 3 } }), /price_decision_competitor_view_shape/,
    'a filter that considered more offers than the snapshot had is refused');
  await assert.rejects(commit({ currency: 'EUR', trigger: null, offers: [offer], filter: { ...filter, competeWith: 'ALL' } }), /price_decision_competitor_view_shape/,
    'a filter summary of all competitors is refused');
  await assert.rejects(commit({ currency: 'EUR', trigger: null, offers: [offer], filter: { ...filter, note: 'free text' } }), /price_decision_competitor_view_shape/,
    'a filter summary with a field outside the list is refused');
});
