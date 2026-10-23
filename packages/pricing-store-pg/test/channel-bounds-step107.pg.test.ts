import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { AdapterCallContext, ChannelAdapter, FieldWrite } from '@repracer/channel-port';
import { createPricingPipeline, standUserOf, type MemorySeedScope } from '@repracer/pricing-pipeline';
import { inTenant, PgPricingStore, seedPricingWorld, type PgPool, type SeededPricingWorld } from '../src/index.ts';
import { engineCost } from './drafts.ts';
import { createIsolatedDatabase, type IsolatedDatabase } from './isolated-db.ts';

/**
 * Шаг 107 [Р-233, Р-231] на PostgreSQL: рамки цены, заданные продавцом в канале (Amazon Min/Max на SKU), — со значениями, которые назвал
 * канал (0205). Рамки с прочитанными значениями в валюте предложения больше не блокируют предложение целиком (Р-231 построено): стратегия
 * назначается, а цена вне рамок не уходит — «без изменения» CHANNEL_BOUNDS_HOLD с обеими суммами. Рамки без значений или в чужой валюте —
 * прежний блок CHANNEL_BOUNDS_PRESENT (fail-closed). Распродажа ниже Min канала — цена уходит, конфликт записан в квитанции, а в вечном
 * объяснении — без суммы канала [Р-3, Р-85]. Данные синтетические.
 */

const AMAZON = '20000000-0000-4000-8000-000000001071';
const DE = 'A1PA6795UKMFR9';
const now = () => new Date().toISOString();
const fixed = (priceMinor: number) => ({ strategyId: `st-fixed-${priceMinor}`, version: 1, params: { type: 'FIXED', priceMinor }, deadbandMinor: 0 }) as MemorySeedScope['strategy'];
const sku = (n: number) => `SYN-SKU-107${n}`;

function scope(n: number, strategy: MemorySeedScope['strategy']): MemorySeedScope {
  return {
    writeScopeId: `ws-${n}`, productId: `prod-${n}`, channelAccountId: AMAZON, marketplace: DE, externalUnitId: sku(n), channelProductRef: `B00010710${n}`,
    condition: 'new', currency: 'EUR', basis: 'GROSS', pricingMode: 'ENGINE', strategy, cost: engineCost(),
    currentPriceMinor: 1950, minPrice: { amountMinor: 1000, id: `min-${n}` }, maxPrice: { amountMinor: 3000, id: `max-${n}` },
  };
}

let db: IsolatedDatabase;
let pool: PgPool;
let admin: PgPool;
let world: SeededPricingWorld;
let store: PgPricingStore;

before(async () => {
  db = await createIsolatedDatabase('step107');
  pool = db.pool('svc_app');
  admin = db.pool('svc_admin', 2);
  world = await seedPricingWorld(pool, { provisioningPool: db.pool('svc_provisioning', 1), adminPool: admin,
    fixtureTenantId: '10000000-0000-4000-8000-000000001071', fixtureChannelAccountId: AMAZON, fixtureChannel: 'AMAZON', fixtureRegion: 'EU',
    fixtureExternalAccountId: 'A1SYN1071', marketplaces: [DE], clock: now(),
    seed: { scopes: [scope(1, fixed(2000)), scope(2, fixed(1100)), scope(3, fixed(1100)), scope(4, fixed(2000))] } });
  store = new PgPricingStore(pool, { adminPool: admin });
});
after(async () => { await db?.drop(); });

const adapter = {
  descriptor: { channel: 'AMAZON', scheduledRecomputeSeconds: 900, competitorSources: [] },
  async planDispatch(_ctx: unknown, writes: readonly FieldWrite[]) {
    return { batches: writes.map((w) => ({ batchId: `b:${w.channelWriteId}`, operation: 'TEST', items: [w], budgetCharges: [], requestCount: 1 })), rejected: [] };
  },
  async dispatch(_ctx: unknown, batch: { batchId: string; items: FieldWrite[] }) {
    return { batchId: batch.batchId, outcomes: batch.items.map((w) => ({ channelWriteId: w.channelWriteId, status: 'ACCEPTED', appliedImmediately: true })), attemptsMade: 1 };
  },
  async readBack() { return { observations: [], failures: [] }; },
} as unknown as ChannelAdapter;
const pipeline = () => createPricingPipeline({ store: new PgPricingStore(pool), adapter, alerts: { raise: async () => undefined }, logger: { log: () => undefined }, now: () => now() as never });
const ctx = (): AdapterCallContext => ({ tenantId: world.tenantId as never, channelAccountId: world.ids.dbId(AMAZON) as never, correlationId: 'step107',
  deadline: new Date(Date.now() + 60_000).toISOString() as never });
const ws = (n: number) => world.ids.dbId(`ws-${n}`);

/** Наблюдение канала у предложения: рамки есть; значения — те, что назвал канал (нет — не прочитаны) */
const observe = (n: number, values: { minMinor: number | null; maxMinor: number | null; currency: string } | null) =>
  store.recordOfferChannelPricing(world.tenantId, world.ids.dbId(AMAZON), [{ marketplace: DE, externalSku: sku(n), automatedPricing: false, channelBounds: true,
    ...(values ? { boundValues: values } : {}), source: 'DISCOVERY', observedAt: now() as never }]);
const outcome = async (p: Promise<unknown>) => { try { await p; return 'OK'; } catch (e) { return String((e as Error).message); } };
const decisions = (n: number) => inTenant(pool, world.tenantId, async (tx) => (await tx.query(
  `SELECT price_decision_id, outcome, final_amount_minor::int AS final, no_change_reason FROM channel_data.price_decision
    WHERE tenant_id = $1 AND write_scope_id = $2 ORDER BY decided_at, price_decision_id`, [world.tenantId, ws(n)])).rows);
const writes = (n: number) => inTenant(pool, world.tenantId, async (tx) => Number((await tx.query(
  `SELECT count(*) AS n FROM tenant_data.channel_write WHERE tenant_id = $1 AND write_scope_id = $2 AND field = 'PRICE'`, [world.tenantId, ws(n)])).rows[0].n));

test('step 107 [Р-231]: channel bounds with values the channel named no longer block the offer; unread values or another currency still do', async () => {
  const owner = world.ids.dbId(standUserOf('membership-owner'));
  assert.equal(await outcome(store.setPricingMode(world.tenantId, ws(4), 'OFF', owner)), 'OK');
  // Значения не прочитаны (так читает настоящий адаптер Amazon до живого аккаунта, A-30): прежний блок
  await observe(4, null);
  assert.match(await outcome(store.setPricingMode(world.tenantId, ws(4), 'ENGINE', owner)), /channel-owned pricing \(CHANNEL_BOUNDS_PRESENT\)/,
    'values not read: the whole offer stays blocked (fail-closed)');
  // Значения в чужой валюте — сравнивать не с чем: блок
  await observe(4, { minMinor: 900, maxMinor: 3500, currency: 'USD' });
  assert.match(await outcome(store.setPricingMode(world.tenantId, ws(4), 'ENGINE', owner)), /channel-owned pricing \(CHANNEL_BOUNDS_PRESENT\)/,
    'values in another currency: blocked');
  // Значения в валюте предложения: Р-231 — рамки не блокируют, цену вне них держит путь решения
  await observe(4, { minMinor: 900, maxMinor: 3500, currency: 'EUR' });
  assert.equal(await outcome(store.setPricingMode(world.tenantId, ws(4), 'ENGINE', owner)), 'OK', 'Р-231: bounds with known values do not block the offer');
});

test('step 107 [Р-233]: the observation keeps values only next to bounds, with the currency, positive and ordered', async () => {
  const insert = (bounds: boolean, min: number | null, max: number | null, currency: string | null) => outcome(inTenant(pool, world.tenantId, (tx) => tx.query(
    `INSERT INTO channel_data.offer_channel_pricing (tenant_id, channel_account_id, channel, marketplace, external_sku, automated_pricing, channel_bounds,
                                                     channel_min_minor, channel_max_minor, bounds_currency, source, observed_at)
     VALUES ($1, $2, 'AMAZON', $3, 'SYN-SKU-107X', false, $4, $5, $6, $7, 'DISCOVERY', now())`, [world.tenantId, world.ids.dbId(AMAZON), DE, bounds, min, max, currency])));
  assert.match(await insert(false, 1200, null, 'EUR'), /offer_channel_pricing_bound_values_shape/, 'values without bounds');
  assert.match(await insert(true, 1200, null, null), /offer_channel_pricing_bound_values_shape/, 'an amount without its currency');
  assert.match(await insert(true, null, null, 'EUR'), /offer_channel_pricing_bound_values_shape/, 'a currency without an amount');
  assert.match(await insert(true, 2000, 1900, 'EUR'), /offer_channel_pricing_bound_values_range/, 'the minimum above the maximum');
  assert.match(await insert(true, 0, 1900, 'EUR'), /offer_channel_pricing_bound_values_range/, 'a zero bound');
  assert.equal(await insert(true, 1200, null, 'EUR'), 'OK', 'one side is enough');
});

test('step 107 [Р-233]: a price outside the channel bounds is not sent — no change with its own code, both amounts in the receipt', async () => {
  await observe(1, { minMinor: 1200, maxMinor: 1900, currency: 'EUR' });
  await observe(2, { minMinor: 1200, maxMinor: 1900, currency: 'EUR' });
  const p = pipeline();
  const before = [await writes(1), await writes(2)];
  await p.recompute(ctx(), ws(1), { type: 'SCHEDULE' });
  await p.recompute(ctx(), ws(2), { type: 'SCHEDULE' });
  const [above] = await decisions(1);
  const [below] = await decisions(2);
  assert.deepEqual([above?.outcome, above?.no_change_reason, below?.outcome, below?.no_change_reason], ['NO_CHANGE', 'CHANNEL_BOUNDS_HOLD', 'NO_CHANGE', 'CHANNEL_BOUNDS_HOLD']);
  assert.deepEqual([await writes(1), await writes(2)], before, 'nothing goes to the channel');
  const detail = (await store.decisionDetail(world.tenantId, above.price_decision_id))!;
  assert.deepEqual(detail.intent!.reason.params, { targetMinor: 2000, side: 'MAX', channelMaxMinor: 1900, currency: 'EUR' });
  const low = (await store.decisionDetail(world.tenantId, below.price_decision_id))!;
  assert.deepEqual(low.intent!.reason.params, { targetMinor: 1100, side: 'MIN', channelMinMinor: 1200, currency: 'EUR' });
});

test('step 107 [Р-233, Р-227]: clearance below the channel minimum is sent, and the receipt records the conflict; the eternal explanation keeps no channel amount', async () => {
  await observe(3, { minMinor: 1200, maxMinor: 1900, currency: 'EUR' });
  assert.deepEqual((await store.enableClearance(world.tenantId, { writeScopeId: ws(3), floorMinor: 900, currency: 'EUR', endsAt: null, note: 'Clearing synthetic stock 107',
    acknowledged: true }, { membershipId: world.ownerMembershipId, userId: world.userId, mfa: true })).status, 'ENABLED');
  await pipeline().recompute(ctx(), ws(3), { type: 'SCHEDULE' });
  const [sent] = await decisions(3);
  assert.deepEqual([sent?.outcome, sent?.final], ['APPROVED', 1100], 'clearance: the price below the channel minimum goes');
  const detail = (await store.decisionDetail(world.tenantId, sent.price_decision_id))!;
  assert.deepEqual(detail.intent!.explanation.slice(0, 2).map((r) => [r.code, r.params]),
    [['CLEARANCE_FLOOR', detail.intent!.explanation[0]!.params], ['CLEARANCE_BELOW_CHANNEL_MIN', { floorMinor: 900, channelMinMinor: 1200, currency: 'EUR' }]]);
  // Р-96: вечное ядро путь решения только дописывает; читает его административный сервис
  const [core] = await inTenant(admin, world.tenantId, async (tx) => (await tx.query(
    `SELECT explanation FROM tenant_data.price_intent_core WHERE tenant_id = $1 AND price_decision_id = $2`, [world.tenantId, sent.price_decision_id])).rows);
  const eternal = JSON.stringify(core?.explanation ?? null);
  assert.ok(eternal.includes('CLEARANCE_BELOW_CHANNEL_MIN'), `the eternal explanation names the conflict: ${eternal}`);
  assert.ok(!eternal.includes('channelMinMinor'), 'the channel amount is not eternal [Р-3, Р-85]');
});

test('step 107 [Р-231]: the Strategies screen facts list only offers the channel pricing blocks — bounds with known values are not listed', async () => {
  await store.recordOfferChannelPricing(world.tenantId, world.ids.dbId(AMAZON), [{ marketplace: DE, externalSku: 'SYN-SKU-107U', automatedPricing: false, channelBounds: true,
    source: 'DISCOVERY', observedAt: now() as never }]);
  const facts = await store.consoleCatalogFacts(world.tenantId, { channelPricing: { limit: 50 } });
  // Известные значения в валюте витрины (предложения 1–4, строка 107X) — не блок; рамки без значений — блок
  assert.deepEqual(facts.channelPricing!.flatMap((a) => a.rows.map((r) => r.externalSku)).sort(), ['SYN-SKU-107U']);
});
