import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { AdapterCallContext, ChannelAdapter, CompetitorSnapshot, FieldWrite } from '@repracer/channel-port';
import { createPricingPipeline, type MemorySeedScope } from '@repracer/pricing-pipeline';
import { createPool, PgPricingStore, PgShadowStore, seedPricingWorld, type PgPool, type SeededPricingWorld } from '../src/index.ts';
import { engineCost } from './drafts.ts';
import { createIsolatedDatabase, requireEnv, type IsolatedDatabase } from './isolated-db.ts';

/**
 * Шаг 144 (внешний аудит UX, корзина 1.2–1.3): «удержание пола» — одно определение у экрана тени, недельного письма и Protections.
 * Событие — эпизод: подряд идущие оценки одного предложения, в которых пол держал цену выше того, что хотела стратегия; сумма эпизода —
 * наибольшая разница за эпизод. Было: экран тени и письмо складывали строку `floor_hold` КАЖДОГО записанного намерения, а одно удержание
 * в тени пишет два: одобренное решение на полу и следующий повтор «уже предложено в тени» с тем же шагом пола. На QA-A за 7 суток —
 * 359 строк = 179 одобренных + 180 повторов, сумма ровно вдвое больше, чем у Protections. Данные синтетические
 */
const ACCOUNT = '20000000-0000-4000-8000-000000000144';
const HOUR = 3_600_000;
const START = Date.now() - 30 * HOUR;
let clock = START;
const iso = (ms: number) => new Date(ms).toISOString();
const now = () => iso(clock);

// Подрез на цент; цель ниже пола ставится на пол (atBound CAP — умолчание), в тени цена не меняется, и повтор — «уже предложено»
const BEAT = { strategyId: 'st-beat', version: 1, params: { type: 'BEAT_LOWEST', undercutMinor: 1, scope: 'VISIBLE_TOP_N', compareLanded: false, atBound: 'CAP' }, deadbandMinor: 0 } as const;

function scope(n: number): MemorySeedScope {
  return {
    writeScopeId: `ws-${n}`, productId: `prod-${n}`, channelAccountId: ACCOUNT, marketplace: 'de', externalUnitId: String(14400 + n),
    channelProductRef: `14401${n}`, condition: 'new', currency: 'EUR', basis: 'GROSS', pricingMode: 'ENGINE', strategy: BEAT, cost: engineCost(),
    currentPriceMinor: 1950, minPrice: { amountMinor: 1000, id: `min-${n}` }, maxPrice: { amountMinor: 3000, id: `max-${n}` },
  };
}

let db: IsolatedDatabase;
let pool: PgPool;
let admin: PgPool;
let observer: PgPool;
let world: SeededPricingWorld;
let store: PgPricingStore;

before(async () => {
  requireEnv('REPRACER_PG_ADMIN_URL');
  db = await createIsolatedDatabase('step144');
  pool = db.pool('svc_app');
  admin = db.pool('svc_admin', 2);
  const url = new URL(process.env.REPRACER_PG_ADMIN_URL!); url.pathname = `/${db.name}`;
  observer = createPool(url.toString(), { max: 1, applicationName: 'repracer-step144-observer' });
  const scheduler = db.pool('svc_scheduler', 1);
  for (let ms = START - 24 * HOUR; ms <= Date.now() + 24 * HOUR; ms += 24 * HOUR) await scheduler.query('SELECT maintenance.ensure_partitions($1::timestamptz)', [iso(ms)]);
  world = await seedPricingWorld(pool, { provisioningPool: db.pool('svc_provisioning', 1), adminPool: admin, writeMode: 'SHADOW',
    fixtureTenantId: '10000000-0000-4000-8000-000000000144', fixtureChannelAccountId: ACCOUNT, marketplaces: ['de'], clock: iso(START - HOUR),
    seed: { scopes: [scope(1), scope(2)] } });
  store = new PgPricingStore(pool, { adminPool: admin });
});
after(async () => {
  await observer?.end();
  await db?.drop();
});

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
const ctx = (): AdapterCallContext => ({ tenantId: world.tenantId as never, channelAccountId: world.ids.dbId(ACCOUNT) as never, correlationId: 'step144', deadline: iso(Date.now() + 60_000) as never });
const eur = (amountMinor: number) => ({ amountMinor, currency: 'EUR', basis: 'GROSS' as const });
const market = (n: number, competitor: number): CompetitorSnapshot => ({
  marketplace: 'de', channelProductRef: `14401${n}`, condition: 'new', source: 'KAUFLAND_BUYBOX', observedAt: now() as never, completeness: { kind: 'TOP_N', n: 10 },
  buybox: { price: eur(competitor), isSelf: false, shipping: eur(0), sellerRef: 'Harbor Goods' },
  offers: [{ rank: 1, sellerRef: 'Harbor Goods', isSelf: false, price: eur(competitor), shipping: eur(0), totalPrice: eur(competitor), holdsBuyBox: true },
    { rank: 2, isSelf: true, price: eur(1950), shipping: eur(0), totalPrice: eur(1950) }],
});
const outcomes = async (n: number) => (await observer.query(
  `SELECT d.outcome, d.no_change_reason FROM channel_data.price_decision d WHERE d.tenant_id = $1 AND d.write_scope_id = $2 ORDER BY d.decided_at, d.price_decision_id`,
  [world.tenantId, world.ids.dbId(`ws-${n}`)])).rows.map((r) => `${r.outcome}${r.no_change_reason ? `/${r.no_change_reason}` : ''}`);

test('step 144: one floor hold in shadow is ONE event — the repeat «already proposed» does not double the money', async () => {
  const p = pipeline();
  // Конкурент ниже пола: одобрено на полу 10.00 (хотели 8.99), затем повтор «уже предложено» (хотели 8.89) и схлопнутые повторы
  for (const [i, competitor] of [900, 890, 880, 870].entries()) {
    clock = START + i * 60_000;
    await p.processSnapshot(ctx(), market(1, competitor));
  }
  assert.deepEqual(await outcomes(1), ['APPROVED', 'NO_CHANGE/SHADOW_ALREADY_PROPOSED'], 'the hold of the step: an approved decision on the floor and one written repeat');
  const since = iso(START - HOUR);
  const { rows: [s] } = await observer.query(`SELECT savings, priced FROM platform.shadow_floor_savings_between($1, $2::timestamptz, now() + interval '1 hour')`, [world.tenantId, since]);
  // Одно удержание: сумма — наибольшая разница эпизода (10.00 − 8.89 = 1.11), а не 1.01 + 1.11
  const sums = (s.savings as Array<{ currency: string; minor: number }>).map((x) => `${x.currency} ${x.minor}`).join(', ');
  assert.equal(`${Number(s.priced)}: ${sums}`, '1: EUR 111', 'one hold, priced once');
});

test('step 144: a price that left the floor ends the episode; a second offer is a second SKU — one definition on Shadow and Protections', async () => {
  const p = pipeline();
  // Конкурент поднялся — цена ушла с пола (эпизод кончился); снова ниже пола — новое удержание (10.00 − 9.49 = 0.51)
  clock = START + 10 * 60_000;
  await p.processSnapshot(ctx(), market(1, 1500));
  clock = START + 20 * 60_000;
  await p.processSnapshot(ctx(), market(1, 950));
  // Второе предложение: удержание 10.00 − 7.99 = 2.01
  clock = START + 30 * 60_000;
  await p.processSnapshot(ctx(), market(2, 800));
  const since = iso(START - HOUR);
  const until = iso(Date.now() + HOUR);
  const { rows: [t] } = await observer.query(`SELECT savings, events, skus, clearance_events FROM platform.floor_hold_totals($1, $2::timestamptz, $3::timestamptz, true)`,
    [world.tenantId, since, until]);
  assert.deepEqual({ savings: t.savings, events: Number(t.events), skus: Number(t.skus), clearance: Number(t.clearance_events) },
    { savings: [{ currency: 'EUR', minor: 111 + 51 + 201 }], events: 3, skus: 2, clearance: 0 }, 'three holds of two SKUs');
  // Экран тени — те же числа
  const page = await new PgShadowStore({ adminPool: admin }).shadowPage(world.tenantId, iso(START + 40 * 60_000) as never, { offset: 0, limit: 5, sinceDays: 2 });
  assert.deepEqual({ savings: page.summary.floorSavings, events: page.summary.floorSavingsHolds, skus: page.summary.floorHoldSkus },
    { savings: [{ currency: 'EUR', minor: 363 }], events: 3, skus: 2 }, 'the Shadow tile');
  // Protections — та же выборка: строка таблицы на эпизод, итог — те же три числа
  const slice = await store.interventions(world.tenantId, since as never, until as never);
  assert.deepEqual(slice.floorHolds.map((e) => [e.writeScopeId === world.ids.dbId('ws-1') ? 'ws-1' : 'ws-2', e.belowMinor]).sort(),
    [['ws-1', 111], ['ws-1', 51], ['ws-2', 201]].sort(), 'one row per hold, each with its largest difference');
  assert.deepEqual({ savings: slice.floorTotals.savings, events: slice.floorTotals.events, skus: slice.floorTotals.skus },
    { savings: [{ currency: 'EUR', minor: 363 }], events: 3, skus: 2 }, 'Protections totals = the Shadow tile (both modes here — all accounts are in shadow)');
});

test('step 144: the in-memory store — the stand worlds and the browser smoke — counts the same holds the same way as the database', async () => {
  const { InMemoryPricingStore } = await import('@repracer/pricing-pipeline');
  const mem = new InMemoryPricingStore({ scopes: [scope(1), scope(2)], competitorSources: adapter.descriptor.competitorSources,
    accounts: [{ channelAccountId: ACCOUNT, channel: 'KAUFLAND', marketplaces: ['de'], writeMode: 'SHADOW' }] });
  const p = createPricingPipeline({ store: mem, adapter, alerts: { raise: async () => undefined }, logger: { log: () => undefined }, now: () => now() as never });
  // Те же снимки, что в двух тестах выше
  for (const [n, at, competitor] of [[1, 0, 900], [1, 1, 890], [1, 2, 880], [1, 3, 870], [1, 10, 1500], [1, 20, 950], [2, 30, 800]] as const) {
    clock = START + at * 60_000;
    // В памяти аккаунт — сам синтетический идентификатор, без отображения в идентификаторы базы
    await p.processSnapshot({ ...ctx(), channelAccountId: ACCOUNT as never }, market(n, competitor));
  }
  const slice = await mem.interventions(world.tenantId, iso(START - HOUR) as never, iso(Date.now() + HOUR) as never);
  assert.equal(JSON.stringify([slice.floorTotals.events, slice.floorTotals.skus, slice.floorTotals.savings.map((x) => `${x.currency} ${x.minor}`)]),
    JSON.stringify([3, 2, ['EUR 363']]), 'the same three holds of two SKUs as on PostgreSQL');
});
