import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { AdapterCallContext, ChannelAdapter, CompetitorSnapshot, FieldWrite } from '@repracer/channel-port';
import { createPricingPipeline, type MemorySeedScope } from '@repracer/pricing-pipeline';
import { createPool, inTenant, PgPricingStore, PgShadowStore, seedPricingWorld, type PgPool, type SeededPricingWorld } from '../src/index.ts';
import { engineCost } from './drafts.ts';
import { createIsolatedDatabase, requireEnv, type IsolatedDatabase } from './isolated-db.ts';

/**
 * Шаг 116 [Р-241] на PostgreSQL: повтор «без изменения» не пишет ни намерения, ни решения, ни удержания пола; счётчик живёт в своей строке и попадает в следующую
 * запись; суточный пульс держит доказательство границы суток [Р-204] на спокойном рынке; «не рассчитано» — строка со своим кодом, база её принимает; смена режима
 * аккаунта забывает состояние; таймер подъёма считает от последней проверки; плитка считает оценки, а цифра пола — только записанное. Данные синтетические
 */
const SHADOW_ACCOUNT = '20000000-0000-4000-8000-000000000116';
const LIVE_ACCOUNT = '20000000-0000-4000-8000-000000000117';
const HOUR = 3_600_000;
const START = Date.now() - 60 * HOUR;
let clock = START;
const iso = (ms: number) => new Date(ms).toISOString();
const now = () => iso(clock);

const HOLD = { strategyId: 'st-hold', version: 1, params: { type: 'BEAT_LOWEST', undercutMinor: 1, scope: 'VISIBLE_TOP_N', compareLanded: false, atBound: 'HOLD' }, deadbandMinor: 0 } as const;
const WIN = { strategyId: 'st-win', version: 1, params: { type: 'WIN_BUYBOX', undercutMinor: 5, fulfillmentHandicapMinor: 0, creepUp: true, creepStepBp: 100, atBound: 'CAP' }, deadbandMinor: 0 } as const;

function scope(n: number, strategy: MemorySeedScope['strategy'], account: string): MemorySeedScope {
  return {
    writeScopeId: `ws-${n}`, productId: `prod-${n}`, channelAccountId: account, marketplace: 'de', externalUnitId: String(11600 + n),
    channelProductRef: `11601${n}`, condition: 'new', currency: 'EUR', basis: 'GROSS', pricingMode: 'ENGINE', strategy, cost: engineCost(),
    currentPriceMinor: 1950, minPrice: { amountMinor: 1000, id: `min-${n}` }, maxPrice: { amountMinor: 3000, id: `max-${n}` },
  };
}

let db: IsolatedDatabase;
let pool: PgPool;
let admin: PgPool;
let observer: PgPool;
let shadow: SeededPricingWorld;
let live: SeededPricingWorld;
let store: PgPricingStore;

before(async () => {
  requireEnv('REPRACER_PG_ADMIN_URL');
  db = await createIsolatedDatabase('step116');
  pool = db.pool('svc_app');
  admin = db.pool('svc_admin', 2);
  const url = new URL(process.env.REPRACER_PG_ADMIN_URL!); url.pathname = `/${db.name}`;
  observer = createPool(url.toString(), { max: 1, applicationName: 'repracer-step116-observer' });
  const scheduler = db.pool('svc_scheduler', 1);
  // Решения ложатся в прошлые сутки: их секции создаёт та же функция, что у планировщика
  for (let ms = START - 24 * HOUR; ms <= Date.now() + 24 * HOUR; ms += 24 * HOUR) await scheduler.query('SELECT maintenance.ensure_partitions($1::timestamptz)', [iso(ms)]);
  shadow = await seedPricingWorld(pool, { provisioningPool: db.pool('svc_provisioning', 1), adminPool: admin, writeMode: 'SHADOW',
    fixtureTenantId: '10000000-0000-4000-8000-000000000116', fixtureChannelAccountId: SHADOW_ACCOUNT, marketplaces: ['de'], clock: iso(START - HOUR),
    seed: { scopes: [scope(1, HOLD, SHADOW_ACCOUNT)] } });
  live = await seedPricingWorld(pool, { provisioningPool: db.pool('svc_provisioning', 1), adminPool: admin,
    fixtureTenantId: '10000000-0000-4000-8000-000000000117', fixtureChannelAccountId: LIVE_ACCOUNT, marketplaces: ['de'], clock: iso(START - HOUR),
    seed: { scopes: [scope(3, HOLD, LIVE_ACCOUNT), scope(4, WIN, LIVE_ACCOUNT)] } });
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
const ctxOf = (w: SeededPricingWorld, account: string): AdapterCallContext => ({ tenantId: w.tenantId as never, channelAccountId: w.ids.dbId(account) as never, correlationId: 'step116', deadline: iso(Date.now() + 60_000) as never });
const eur = (amountMinor: number) => ({ amountMinor, currency: 'EUR', basis: 'GROSS' as const });
/** Конкурент дешевле пола: цель ниже пола, стратегия с удержанием держит цену */
const market = (n: number, competitor: number, ours: number | null = null): CompetitorSnapshot => ({
  marketplace: 'de', channelProductRef: `11601${n}`, condition: 'new', source: 'KAUFLAND_BUYBOX', observedAt: now() as never, completeness: { kind: 'TOP_N', n: 10 },
  buybox: ours !== null ? { price: eur(ours), isSelf: true, shipping: eur(0) } : { price: eur(competitor), isSelf: false, shipping: eur(0), sellerRef: 'Harbor Goods' },
  offers: ours !== null
    ? [{ rank: 1, isSelf: true, price: eur(ours), shipping: eur(0), totalPrice: eur(ours), holdsBuyBox: true }, { rank: 2, sellerRef: 'Harbor Goods', isSelf: false, price: eur(competitor), shipping: eur(0), totalPrice: eur(competitor) }]
    : [{ rank: 1, sellerRef: 'Harbor Goods', isSelf: false, price: eur(competitor), shipping: eur(0), totalPrice: eur(competitor), holdsBuyBox: true }, { rank: 2, isSelf: true, price: eur(1950), shipping: eur(0), totalPrice: eur(1950) }],
});
const rowsOf = async (w: SeededPricingWorld, ws: string) => (await observer.query(
  `SELECT d.outcome, d.no_change_reason, d.repeats_before, d.shadow FROM channel_data.price_decision d WHERE d.tenant_id = $1 AND d.write_scope_id = $2 ORDER BY d.decided_at, d.price_decision_id`,
  [w.tenantId, w.ids.dbId(ws)])).rows;
const liveOf = async (w: SeededPricingWorld, ws: string) => (await observer.query(
  `SELECT state, repeats, last_evaluated_at FROM tenant_data.price_no_change_state WHERE tenant_id = $1 AND write_scope_id = $2`, [w.tenantId, w.ids.dbId(ws)])).rows[0];
const count = async (table: string, w: SeededPricingWorld, ws: string) => Number((await observer.query(`SELECT count(*) AS n FROM ${table} WHERE tenant_id = $1 AND write_scope_id = $2`, [w.tenantId, w.ids.dbId(ws)])).rows[0].n);

test('step 116 [Р-241]: repeats write no intent, no decision and no floor hold; the tile counts evaluations, the floor figure only what was written', async () => {
  const p = pipeline();
  for (let i = 0; i < 4; i++) {
    clock = START + i * 60_000;
    await p.processSnapshot(ctxOf(shadow, SHADOW_ACCOUNT), market(1, 900 - i * 10));
  }
  const rows = await rowsOf(shadow, 'ws-1');
  assert.deepEqual(rows.map((r) => [r.outcome, r.no_change_reason, r.repeats_before]), [['NO_CHANGE', 'TARGET_OUTSIDE_BOUNDS_HOLD', 0]], 'one row: the competitor moved, the reason did not');
  // Счётчик предложения считает оценки, как плитки (красный прогон суток демо: 29 вместо 720); последнее решение — по-прежнему строка
  const [stats] = await store.scopeDecisionStats(shadow.tenantId, [shadow.ids.dbId('ws-1')]);
  assert.equal(stats!.decisions, 4, 'one row and three repeats are four evaluations of this offer');
  assert.equal(await count('channel_data.price_intent', shadow, 'ws-1'), 1, 'no intent for a repeat');
  assert.equal(await count('channel_data.floor_hold', shadow, 'ws-1'), 1, 'one hold per state: the floor figure no longer grows with the reading rate');
  const state = await liveOf(shadow, 'ws-1');
  assert.equal(state.repeats, 3);
  assert.equal(new Date(state.last_evaluated_at).toISOString(), iso(START + 3 * 60_000));
  assert.match(state.state, /^TARGET_OUTSIDE_BOUNDS_HOLD\|/);

  const page = await new PgShadowStore({ adminPool: admin }).shadowPage(shadow.tenantId, iso(START + 10 * 60_000) as never, { offset: 0, limit: 5, sinceDays: 1 });
  assert.equal(page.summary.decisions, 4, 'the Decisions tile counts evaluations: one row and three repeats');
  assert.equal(page.summary.floorSavingsHolds, 1, 'the money figure counts what was written [Р-241]');
  assert.equal(page.decisionsByHour.reduce((sum, h) => sum + h.decisions, 0), 1, 'the chart is by rows until the repeats are carried by the next row');
});

test('step 116 [Р-241, Р-204]: the daily pulse carries the repeats and keeps the day-boundary evidence alive on a calm market', async () => {
  const p = pipeline();
  // Спокойный рынок: те же сутки — повторы, затем пульс
  clock = START + 25 * HOUR;
  await p.processSnapshot(ctxOf(shadow, SHADOW_ACCOUNT), market(1, 850));
  clock = START + 50 * HOUR;
  await p.processSnapshot(ctxOf(shadow, SHADOW_ACCOUNT), market(1, 850));
  const rows = await rowsOf(shadow, 'ws-1');
  assert.deepEqual(rows.map((r) => r.repeats_before), [0, 3, 0], 'the first pulse carries the three repeats of the previous test');
  const { rows: [e] } = await observer.query(`SELECT shadow_days, longest_gap_hours, decisions FROM platform.day_boundary_shadow_evidence($1, $2, 'de', 30)`, [shadow.tenantId, shadow.ids.dbId(SHADOW_ACCOUNT)]);
  assert.ok(Number(e.longest_gap_hours) <= 36, `the gap stays under 36 hours: ${JSON.stringify(e)}`);
  assert.equal(Number(e.decisions), 3);
});

test('step 116 [Р-241]: "not evaluated" is a row the database accepts, with a reason the receipt can read', async () => {
  clock = START + 50 * HOUR + 20 * 60_000;
  const r = await pipeline().recompute(ctxOf(shadow, SHADOW_ACCOUNT), shadow.ids.dbId('ws-1'), { type: 'SCHEDULE' });
  assert.ok(r.decisionId, JSON.stringify(r.stages));
  assert.equal((await rowsOf(shadow, 'ws-1')).at(-1).no_change_reason, 'COMPETITOR_REQUIREMENT_NOT_MET');
  const detail = (await store.decisionDetail(shadow.tenantId, r.decisionId))!;
  assert.equal(detail.intent!.reason.params.unmet, 'STALENESS');
  assert.equal(detail.decision.noChangeReason, 'COMPETITOR_REQUIREMENT_NOT_MET');
});

test('step 116 [Р-241]: going back to shadow forgets the state: the first evaluation in the new mode is a row with the new mode', async () => {
  const p = pipeline();
  clock = START + 60_000;
  await p.processSnapshot(ctxOf(live, LIVE_ACCOUNT), market(3, 900));
  clock = START + 2 * 60_000;
  await p.processSnapshot(ctxOf(live, LIVE_ACCOUNT), market(3, 900));
  assert.equal((await rowsOf(live, 'ws-3')).length, 1);
  const switched = await new PgShadowStore({ adminPool: admin }).switchWriteMode(live.tenantId, { channelAccountId: live.ids.dbId(LIVE_ACCOUNT), toMode: 'SHADOW', membershipId: live.ownerMembershipId, userId: live.userId, mfa: true });
  assert.equal(switched.status, 'SWITCHED');
  clock = START + 3 * 60_000;
  await p.processSnapshot(ctxOf(live, LIVE_ACCOUNT), market(3, 900));
  const rows = await rowsOf(live, 'ws-3');
  assert.deepEqual(rows.map((r) => r.shadow), [false, true], 'a decision made in shadow must not hide behind a live row');
  assert.equal(rows[1].repeats_before, 1);
  const back = await inTenant(admin, live.tenantId, async (tx) => (await tx.query(`SELECT external_account_id FROM tenant_data.channel_account WHERE tenant_id = $1 AND channel_account_id = $2`, [live.tenantId, live.ids.dbId(LIVE_ACCOUNT)])).rows[0].external_account_id);
  await new PgShadowStore({ adminPool: admin }).switchWriteMode(live.tenantId, { channelAccountId: live.ids.dbId(LIVE_ACCOUNT), toMode: 'LIVE', typedConfirmation: back, membershipId: live.ownerMembershipId, userId: live.userId, mfa: true });
});

test('step 116 [Р-241, Р-219]: the raise timer counts from the last check, not from the last row', async () => {
  const p = pipeline();
  const t0 = START + 10 * HOUR;
  const at = (minutes: number) => t0 + minutes * 60_000;
  // Взятие Buy Box, затем Buy Box наш внутри периода: «темп подъёма» — строка, дальше повтор
  clock = at(0);
  await p.processSnapshot(ctxOf(live, LIVE_ACCOUNT), market(4, 1900));
  clock = at(5);
  const second = await p.processSnapshot(ctxOf(live, LIVE_ACCOUNT), market(4, 1900, 1895));
  assert.equal(second.verdict, 'ACCEPT', JSON.stringify({ ...second, snapshot: undefined }));
  const reasons = (await observer.query(`SELECT i.rationale -> 'reason' ->> 'code' AS code, d.outcome FROM channel_data.price_decision d JOIN channel_data.price_intent i ON i.tenant_id = d.tenant_id AND i.price_intent_id = d.price_intent_id AND i.created_at = d.intent_created_at WHERE d.tenant_id = $1 AND d.write_scope_id = $2 ORDER BY d.decided_at`, [live.tenantId, live.ids.dbId('ws-4')])).rows;
  assert.equal((await rowsOf(live, 'ws-4')).at(-1).no_change_reason, 'CREEP_PACED', JSON.stringify(reasons));
  const written = (await rowsOf(live, 'ws-4')).length;
  clock = at(10);
  await p.processSnapshot(ctxOf(live, LIVE_ACCOUNT), market(4, 1900, 1895));
  assert.equal((await rowsOf(live, 'ws-4')).length, written, 'the same state: a repeat');
  const due = (minutes: number) => store.listScheduledScopes(live.tenantId, live.ids.dbId(LIVE_ACCOUNT), iso(at(minutes)) as never, 100, 900);
  assert.ok(!(await due(20)).includes(live.ids.dbId('ws-4')), 'checked ten minutes ago: the period has not passed since the check');
  assert.ok((await due(26)).includes(live.ids.dbId('ws-4')), 'positive control: a period after the last check the timer is due');
});
