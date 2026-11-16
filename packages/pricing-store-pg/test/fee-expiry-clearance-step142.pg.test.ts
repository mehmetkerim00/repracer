import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { AdapterCallContext, ChannelAdapter, FieldWrite } from '@repracer/channel-port';
import { createPricingPipeline, type MemorySeedScope } from '@repracer/pricing-pipeline';
import type { CostInputs } from '@repracer/pricing-model';
import { inTenant, PgPricingStore, seedPricingWorld, type PgPool, type SeededPricingWorld } from '../src/index.ts';
import { createIsolatedDatabase, type IsolatedDatabase } from './isolated-db.ts';

/**
 * Шаг 142 (решение владельца по строке отложенного «140»): оценка комиссии истекла при ВКЛЮЧЁННОЙ распродаже — цену НЕ замораживать.
 * Вне распродажи пол выводится из себестоимости и комиссии, без действующей оценки его не посчитать — заморозка вынужденная. Пол
 * распродажи — абсолютное число, которое продавец назначил и подписал; он считается без комиссии, ниже него цена не уйдёт.
 * Но честность обязательна: владелец узнаёт об истечении и в распродаже — WARNING со своим текстом («продажа идёт на ваш пол
 * распродажи, подтверждённый убыток мог устареть»). Письма о заморозке (шаг 120) таких предложений не называют: их цена не замерзает,
 * и «prices no longer change» о них было бы неправдой. Данные синтетические
 */

const ACCOUNT = '20000000-0000-4000-8000-000000000142';
const now = () => new Date().toISOString();
const COST: CostInputs = { currency: 'EUR', costProfileId: 'cp-142', unitCostMinor: 700, fixedFeeMinor: 0, feeRateBp: 1000, tax: { regime: 'VAT_INCLUDED', vatRateBp: 1900 } };
const FIXED = { strategyId: 'st-fixed', version: 1, params: { type: 'FIXED', priceMinor: 1100 }, deadbandMinor: 0 } as const;

function scope(n: number, over: Partial<MemorySeedScope> = {}): MemorySeedScope {
  return {
    writeScopeId: `ws-${n}`, productId: `prod-${n}`, channelAccountId: ACCOUNT, marketplace: 'de', externalUnitId: String(14200 + n),
    channelProductRef: `14201${n}`, condition: 'new', currency: 'EUR', basis: 'GROSS', pricingMode: 'ENGINE', strategy: FIXED, cost: COST,
    currentPriceMinor: 1150, minPrice: { amountMinor: 1200, id: `min-${n}` }, maxPrice: { amountMinor: 5000, id: `max-${n}` }, ...over,
  };
}

let db: IsolatedDatabase;
let pool: PgPool;
let admin: PgPool;
let world: SeededPricingWorld;
let store: PgPricingStore;
const ws = (n: number) => world.ids.dbId(`ws-${n}`);

before(async () => {
  db = await createIsolatedDatabase('step142');
  pool = db.pool('svc_app');
  admin = db.pool('svc_admin', 2);
  world = await seedPricingWorld(pool, { provisioningPool: db.pool('svc_provisioning', 1), adminPool: admin,
    fixtureTenantId: '10000000-0000-4000-8000-000000000142', fixtureChannelAccountId: ACCOUNT, marketplaces: ['de'], clock: now(),
    seed: { scopes: [
      scope(1), // без распродажи, оценка кончилась — цена замерзает, CRITICAL, как в шаге 120
      scope(2), // в распродаже, оценка кончилась — цена идёт на пол распродажи, WARNING распродажи
      scope(3), // в распродаже, оценка кончится через 5 суток — в том же WARNING распродажи
      scope(4), // без распродажи, оценка кончится через 10 суток — WARNING «цены перестанут меняться», как в шаге 120
    ] } });
  store = new PgPricingStore(pool, { adminPool: admin });
  // Распродажа включается при посчитанной безубыточности (шаг 140) — до истечения оценки
  for (const n of [2, 3]) {
    const on = await store.enableClearance(world.tenantId, { writeScopeId: ws(n), floorMinor: 900, currency: 'EUR', endsAt: null, note: 'Clearing old stock', acknowledged: true },
      { membershipId: world.ownerMembershipId, userId: world.userId, mfa: true });
    assert.equal(on.status, 'ENABLED');
  }
  const set = (n: number, until: string) => db.superuser(
    `UPDATE channel_data.fee_estimate SET computed_at = now() - interval '91 days', valid_until = ${until} WHERE tenant_id = $1 AND write_scope_id = $2`,
    [world.tenantId, ws(n)]);
  await set(1, `now() - interval '1 hour'`);
  await set(2, `now() - interval '2 hours'`);
  await set(3, `now() + interval '5 days'`);
  await set(4, `now() + interval '10 days'`);
});
after(async () => { await db?.drop(); });

const sent: Array<[string, number]> = [];
const adapter = {
  descriptor: { channel: 'KAUFLAND', scheduledRecomputeSeconds: 900, competitorSources: [] },
  async planDispatch(_ctx: unknown, writes: readonly FieldWrite[]) {
    return { batches: writes.map((w) => ({ batchId: `b:${w.channelWriteId}`, operation: 'TEST', items: [w], budgetCharges: [], requestCount: 1 })), rejected: [] };
  },
  async dispatch(_ctx: unknown, batch: { batchId: string; items: FieldWrite[] }) {
    for (const w of batch.items) if (w.value.field === 'PRICE') sent.push([w.writeScope.writeScopeId, w.value.price.amountMinor]);
    return { batchId: batch.batchId, outcomes: batch.items.map((w) => ({ channelWriteId: w.channelWriteId, status: 'ACCEPTED', appliedImmediately: true })), attemptsMade: 1 };
  },
  async readBack() { return { observations: [], failures: [] }; },
} as unknown as ChannelAdapter;
const ctx = (): AdapterCallContext => ({ tenantId: world.tenantId as never, channelAccountId: world.ids.dbId(ACCOUNT) as never, correlationId: 'step142', deadline: new Date(Date.now() + 60_000).toISOString() as never });

type Raised = { code: string; severity: string; details: Record<string, unknown> };
async function scheduledRun(): Promise<Raised[]> {
  const raised: Raised[] = [];
  const p = createPricingPipeline({ store, adapter, alerts: { raise: async (a) => { raised.push({ code: a.code, severity: a.severity, details: a.details as Record<string, unknown> }); } },
    logger: { log: () => undefined }, now: () => now() as never });
  await p.recomputeScheduled(ctx());
  return raised.filter((a) => a.code.startsWith('FEE_ESTIMATE_'));
}

test('step 142: an expired fee estimate on clearance — the owner gets its own WARNING; the freeze letters name only offers whose prices do freeze', async () => {
  const fees = await scheduledRun();
  const brief = fees.map((a) => [a.code, a.severity, a.details.offers, a.details.writeScopeId, a.details.days]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  assert.equal(JSON.stringify(brief), JSON.stringify([
    // Распродажа: два предложения, первое по сроку — уже кончившееся (0 суток)
    ['FEE_ESTIMATE_CLEARANCE', 'WARNING', 2, ws(2), 0],
    // Заморозка — только у предложений вне распродажи
    ['FEE_ESTIMATE_EXPIRED', 'CRITICAL', 1, ws(1), 0],
    ['FEE_ESTIMATE_EXPIRING', 'WARNING', 1, ws(4), 10],
  ]), `alerts of the run: ${JSON.stringify(fees)}`);
  // Повторный заход молчит — однократность держит журнал базы, и для распродажи тоже
  assert.deepEqual(await scheduledRun(), [], 'no second letter for the same expiry');
});

test('step 142 (owner decision): on clearance the price keeps going to the market after the fee estimate ended; outside clearance it freezes', async () => {
  const decided = async (n: number) => (await inTenant(pool, world.tenantId, (tx) => tx.query(
    `SELECT outcome, final_amount_minor::int AS final FROM channel_data.price_decision WHERE tenant_id = $1 AND write_scope_id = $2 ORDER BY decided_at DESC LIMIT 1`,
    [world.tenantId, ws(n)]))).rows[0] ?? null;
  // Первый заход (тест выше) уже решил: у ws-2 — цена 11.00 над полом распродажи 9.00, у ws-1 пол не посчитать
  assert.deepEqual(await decided(2), { outcome: 'APPROVED', final: 1100 }, 'clearance: the signed floor needs no fee estimate — the price goes');
  assert.ok(sent.some(([w, minor]) => w === ws(2) && minor === 1100), 'the price of the offer on clearance reached the channel');
  assert.ok(!sent.some(([w]) => w === ws(1)), 'outside clearance nothing is sent — the floor cannot be computed (fail-closed)');
});
