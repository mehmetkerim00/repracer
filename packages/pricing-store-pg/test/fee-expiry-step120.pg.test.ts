import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { AdapterCallContext, ChannelAdapter } from '@repracer/channel-port';
import { createPricingPipeline, type MemorySeedScope } from '@repracer/pricing-pipeline';
import type { CostInputs } from '@repracer/pricing-model';
import { inTenant, PgPricingStore, seedPricingWorld, type PgPool, type SeededPricingWorld } from '../src/index.ts';
import { createIsolatedDatabase, type IsolatedDatabase } from './isolated-db.ts';

/**
 * Шаг 120 на PostgreSQL (P1-04): оценка комиссии предложения живёт 90 суток, а без действующей оценки пол не считается и цена замерзает
 * (fail-closed). Владелец узнаёт об этом ЗАРАНЕЕ:
 *  - за 14 суток до конца последней действующей оценки — WARNING `FEE_ESTIMATE_EXPIRING`, одно письмо на аккаунт с числом предложений и
 *    ближайшим сроком;
 *  - в момент истечения — CRITICAL `FEE_ESTIMATE_EXPIRED`;
 *  - каждое — один раз на срок: повторный заход молчит, новая оценка (новый срок) начинает цикл заново;
 *  - выключенное предложение и предложение с другой действующей оценкой не замерзают — о них не пишется.
 * Журнал уведомлений держит база: вид из списка, вид согласован со временем. Данные синтетические
 */

const ACCOUNT = '20000000-0000-4000-8000-000000000120';
const now = () => new Date().toISOString();
const COST: CostInputs = { currency: 'EUR', costProfileId: 'cp-120', unitCostMinor: 700, fixedFeeMinor: 0, feeRateBp: 1000, tax: { regime: 'VAT_INCLUDED', vatRateBp: 1900 } };
const FIXED = { strategyId: 'st-fixed', version: 1, params: { type: 'FIXED', priceMinor: 1500 }, deadbandMinor: 0 } as const;

function scope(n: number, over: Partial<MemorySeedScope> = {}): MemorySeedScope {
  return {
    writeScopeId: `ws-${n}`, productId: `prod-${n}`, channelAccountId: ACCOUNT, marketplace: 'de', externalUnitId: String(12000 + n),
    channelProductRef: `12001${n}`, condition: 'new', currency: 'EUR', basis: 'GROSS', pricingMode: 'ENGINE', strategy: FIXED, cost: COST,
    currentPriceMinor: 1500, minPrice: { amountMinor: 1200, id: `min-${n}` }, maxPrice: { amountMinor: 5000, id: `max-${n}` }, ...over,
  };
}

let db: IsolatedDatabase;
let pool: PgPool;
let admin: PgPool;
let world: SeededPricingWorld;
let store: PgPricingStore;

before(async () => {
  db = await createIsolatedDatabase('step120');
  pool = db.pool('svc_app');
  admin = db.pool('svc_admin', 2);
  world = await seedPricingWorld(pool, { provisioningPool: db.pool('svc_provisioning', 1), adminPool: admin,
    fixtureTenantId: '10000000-0000-4000-8000-000000000120', fixtureChannelAccountId: ACCOUNT, marketplaces: ['de'], clock: now(),
    seed: { scopes: [
      scope(1), // кончается через 10 суток — WARNING
      scope(2), // через 20 суток — ещё рано
      scope(3), // уже кончилась — CRITICAL
      scope(4, { pricingMode: 'OFF' }), // выключенное — не замерзает, о нём не пишется
      scope(5), // тарифная кончилась, но действует оценка продавца — цена не замерзает
      scope(6), // кончается через 3 суток — первая в письме WARNING
    ] } });
  store = new PgPricingStore(pool, { adminPool: admin });
  // Сроки оценок — прямо в базе: оценка мира посева живёт год
  const set = (n: number, until: string) => db.superuser(
    `UPDATE channel_data.fee_estimate SET computed_at = now() - interval '91 days', valid_until = ${until} WHERE tenant_id = $1 AND write_scope_id = $2`,
    [world.tenantId, ws(n)]);
  await set(1, `now() + interval '10 days'`);
  await set(2, `now() + interval '20 days'`);
  await set(3, `now() - interval '1 hour'`);
  await set(4, `now() + interval '5 days'`);
  await set(5, `now() - interval '2 days'`);
  await set(6, `now() + interval '3 days'`);
  await db.superuser(
    `INSERT INTO channel_data.fee_estimate (tenant_id, write_scope_id, source, fee_model, computed_at, valid_until)
     VALUES ($1, $2, 'SELLER_DECLARED', '{"feeRateBp": 1200, "fixedFeeMinor": 0}', now(), now() + interval '60 days')`, [world.tenantId, ws(5)]);
});
after(async () => { await db?.drop(); });

const ws = (n: number) => world.ids.dbId(`ws-${n}`);
const adapter = {
  descriptor: { channel: 'KAUFLAND', scheduledRecomputeSeconds: 900, competitorSources: [] },
  async planDispatch() { return { batches: [], rejected: [] }; },
  async dispatch() { throw new Error('nothing is dispatched in this test'); },
  async readBack() { return { observations: [], failures: [] }; },
} as unknown as ChannelAdapter;
const ctx = (): AdapterCallContext => ({ tenantId: world.tenantId as never, channelAccountId: world.ids.dbId(ACCOUNT) as never, correlationId: 'step120', deadline: new Date(Date.now() + 60_000).toISOString() as never });

type Raised = { code: string; severity: string; details: Record<string, unknown> };
async function scheduledRun(): Promise<Raised[]> {
  const raised: Raised[] = [];
  const p = createPricingPipeline({ store, adapter, alerts: { raise: async (a) => { raised.push({ code: a.code, severity: a.severity, details: a.details as Record<string, unknown> }); } },
    logger: { log: () => undefined }, now: () => now() as never });
  await p.recomputeScheduled(ctx());
  return raised.filter((a) => a.code.startsWith('FEE_ESTIMATE_'));
}

test('step 120 (P1-04): 14 days ahead the owner gets one WARNING per account with the count and the nearest date; at expiry — one CRITICAL', async () => {
  const fees = await scheduledRun();
  const warning = fees.filter((a) => a.code === 'FEE_ESTIMATE_EXPIRING');
  const critical = fees.filter((a) => a.code === 'FEE_ESTIMATE_EXPIRED');
  assert.equal(warning.length, 1, `one WARNING for the account: ${JSON.stringify(fees)}`);
  assert.equal(warning[0]!.severity, 'WARNING');
  // Две единицы (1 и 6); первая по сроку — шестая, через 3 суток. Выключенная (4), поздняя (2) и с живой оценкой (5) — не считаются
  assert.deepEqual([warning[0]!.details.offers, warning[0]!.details.writeScopeId, warning[0]!.details.days], [2, ws(6), 3],
    `the warning names two offers, the nearest first: ${JSON.stringify(warning[0]!.details)}`);
  assert.equal(critical.length, 1, `one CRITICAL at expiry: ${JSON.stringify(fees)}`);
  assert.deepEqual([critical[0]!.severity, critical[0]!.details.offers, critical[0]!.details.writeScopeId], ['CRITICAL', 1, ws(3)]);
});

test('step 120 (P1-04): the next run says nothing — no second warning for the same expiry', async () => {
  assert.deepEqual(await scheduledRun(), [], 'no second warning for the same expiry');
});

test('step 120 (P1-04): a renewed estimate starts a new cycle — its own warning when the new date comes near', async () => {
  // Продавец снова загрузил файл с комиссией — новая оценка с новым сроком; и этот срок тоже скоро
  await db.superuser(`UPDATE channel_data.fee_estimate SET computed_at = now(), valid_until = now() + interval '12 days' WHERE tenant_id = $1 AND write_scope_id = $2`,
    [world.tenantId, ws(1)]);
  const fees = await scheduledRun();
  assert.deepEqual(fees.map((a) => [a.code, a.details.offers, a.details.writeScopeId]), [['FEE_ESTIMATE_EXPIRING', 1, ws(1)]],
    `the new date has its own warning: ${JSON.stringify(fees)}`);
});

test('step 120 (P1-04): the database keeps the notice journal honest — a known kind that matches the time', async () => {
  const insert = (kind: string, until: string) => inTenant(pool, world.tenantId, (tx) => tx.query(
    `INSERT INTO channel_data.fee_expiry_notice (tenant_id, write_scope_id, valid_until, kind) VALUES ($1, $2, ${until}, $3)`, [world.tenantId, ws(2), kind]))
    .then(() => 'accepted', (e: Error) => e.message);
  assert.match(await insert('SOON', `now() + interval '1 day'`), /fee_expiry_notice_kind_known/, 'an unknown kind is refused');
  assert.match(await insert('EXPIRED', `now() + interval '1 day'`), /fee_expiry_notice_kind_matches_time/, 'an expiry announced before its moment is refused');
  assert.match(await insert('EXPIRING', `now() - interval '1 day'`), /fee_expiry_notice_kind_matches_time/, 'a warning about a moment already past is refused');
  assert.equal(await insert('EXPIRING', `now() + interval '19 days'`), 'accepted', 'control: a warning about a coming moment is accepted');
});
