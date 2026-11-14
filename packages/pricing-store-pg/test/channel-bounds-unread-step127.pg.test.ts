import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { AdapterCallContext, ChannelAdapter, FieldWrite } from '@repracer/channel-port';
import { createPricingPipeline, standUserOf, type MemorySeedScope } from '@repracer/pricing-pipeline';
import { inTenant, PgPricingStore, seedPricingWorld, type PgPool, type SeededPricingWorld } from '../src/index.ts';
import { engineCost } from './drafts.ts';
import { createIsolatedDatabase, type IsolatedDatabase } from './isolated-db.ts';

/**
 * Шаг 127 [Р-250] (П1 аудита авторизации Amazon, решение владельца): рамки Amazon Min/Max на SKU, чьи значения мы не прочитали (так читает
 * настоящий адаптер до живого аккаунта, A-30), больше НЕ блокируют предложение целиком. Стратегия назначается, движок включается, и тень
 * считает решения — продавец видит их с честной пометкой «запись будет удержана». Блок самой записи прежний: адаптер Amazon перед каждой
 * отправкой читает листинг и с рамками запись не отправляет (AMZ_C03, шаг 22). Automate Pricing — по-прежнему блок предложения целиком
 * [Р-115, Р-120]: это чужой репрайсер, а не рамки. Данные синтетические.
 */
const AMAZON = '20000000-0000-4000-8000-000000001271';
const DE = 'A1PA6795UKMFR9';
const now = () => new Date().toISOString();
const fixed = (priceMinor: number) => ({ strategyId: `st-fixed-${priceMinor}`, version: 1, params: { type: 'FIXED', priceMinor }, deadbandMinor: 0 }) as MemorySeedScope['strategy'];
const sku = (n: number) => `SYN-SKU-127${n}`;
const scope = (n: number): MemorySeedScope => ({
  writeScopeId: `ws-${n}`, productId: `prod-${n}`, channelAccountId: AMAZON, marketplace: DE, externalUnitId: sku(n), channelProductRef: `B00012710${n}`,
  condition: 'new', currency: 'EUR', basis: 'GROSS', pricingMode: 'OFF', strategy: fixed(2100), cost: engineCost(),
  currentPriceMinor: 1950, minPrice: { amountMinor: 1000, id: `min-${n}` }, maxPrice: { amountMinor: 3000, id: `max-${n}` },
});

let db: IsolatedDatabase;
let pool: PgPool;
let admin: PgPool;
let world: SeededPricingWorld;
let store: PgPricingStore;

before(async () => {
  db = await createIsolatedDatabase('step127');
  pool = db.pool('svc_app');
  admin = db.pool('svc_admin', 2);
  // Аккаунт в тени — как у пилота [Р-169, Р-247]
  world = await seedPricingWorld(pool, { provisioningPool: db.pool('svc_provisioning', 1), adminPool: admin,
    fixtureTenantId: '10000000-0000-4000-8000-000000001271', fixtureChannelAccountId: AMAZON, fixtureChannel: 'AMAZON', fixtureRegion: 'EU',
    fixtureExternalAccountId: 'A1SYN1271', marketplaces: [DE], clock: now(), writeMode: 'SHADOW',
    seed: { scopes: [scope(1), scope(2), scope(3)] } });
  store = new PgPricingStore(pool, { adminPool: admin });
});
after(async () => { await db?.drop(); });

const observe = (n: number, o: { automatedPricing: boolean; channelBounds: boolean; boundValues?: { minMinor: number | null; maxMinor: number | null; currency: string } }) =>
  store.recordOfferChannelPricing(world.tenantId, world.ids.dbId(AMAZON), [{ marketplace: DE, externalSku: sku(n), ...o, source: 'DISCOVERY', observedAt: now() as never }]);
const outcome = async (p: Promise<unknown>) => { try { await p; return 'OK'; } catch (e) { return String((e as Error).message); } };
const ws = (n: number) => world.ids.dbId(`ws-${n}`);
const ctx = (): AdapterCallContext => ({ tenantId: world.tenantId as never, channelAccountId: world.ids.dbId(AMAZON) as never, correlationId: 'step127',
  deadline: new Date(Date.now() + 60_000).toISOString() as never });
// Адаптер-заглушка отправки: в тени до неё не доходит ничего — запись рождается удержанной [Р-169]
const sent: FieldWrite[] = [];
const adapter = {
  descriptor: { channel: 'AMAZON', scheduledRecomputeSeconds: 900, competitorSources: [] },
  async planDispatch(_ctx: unknown, writes: readonly FieldWrite[]) {
    sent.push(...writes);
    return { batches: writes.map((w) => ({ batchId: `b:${w.channelWriteId}`, operation: 'TEST', items: [w], budgetCharges: [], requestCount: 1 })), rejected: [] };
  },
  async dispatch() { throw new Error('nothing is dispatched in the shadow'); },
  async readBack() { return { observations: [], failures: [] }; },
} as unknown as ChannelAdapter;
const pipeline = () => createPricingPipeline({ store, adapter, alerts: { async raise() {} }, logger: { log() {} }, now });

test('step 127 [Р-250]: Amazon Min/Max on a SKU with values we did not read — the offer takes a strategy and the engine, the shadow decides, the write is held', async () => {
  const owner = world.ids.dbId(standUserOf('membership-owner'));
  await observe(1, { automatedPricing: false, channelBounds: true });
  await observe(2, { automatedPricing: false, channelBounds: true, boundValues: { minMinor: 900, maxMinor: 3500, currency: 'USD' } });
  for (const n of [1, 2]) {
    assert.equal(await outcome(store.setPricingMode(world.tenantId, ws(n), 'ENGINE', owner)), 'OK',
      `offer ${n}: bounds whose values we cannot compare no longer block the whole offer (П1)`);
  }
  await pipeline().recompute(ctx(), ws(1), { type: 'SCHEDULE' });
  const rows = await inTenant(pool, world.tenantId, async (tx) => (await tx.query(
    // Удержанная тенью запись в очереди не живёт ни мгновения — её сразу уносит в историю записей (0128)
    `SELECT d.outcome, d.final_amount_minor::int AS final, h.final_status AS status FROM channel_data.price_decision d
       LEFT JOIN tenant_data.channel_write_history h ON h.tenant_id = d.tenant_id AND h.write_scope_id = d.write_scope_id AND h.field = 'PRICE'
      WHERE d.tenant_id = $1 AND d.write_scope_id = $2`, [world.tenantId, ws(1)])).rows);
  assert.deepEqual(rows.map((r) => [r.outcome, r.final, r.status]), [['APPROVED', 2100, 'SHADOW_HELD']], 'the shadow decision is there, and its write is held');
  assert.deepEqual(sent, [], 'nothing reached the adapter');
});

test('step 127 [Р-250]: the rule of the guards — unread bounds are not channel-owned pricing, Automate Pricing is', async () => {
  const owner = world.ids.dbId(standUserOf('membership-owner'));
  await observe(3, { automatedPricing: true, channelBounds: false });
  assert.match(await outcome(store.setPricingMode(world.tenantId, ws(3), 'ENGINE', owner)), /channel-owned pricing \(CHANNEL_REPRICER_ACTIVE\)/,
    'Automate Pricing is the channel repricer — the whole offer stays blocked [Р-115]');
  // Одна функция у трёх стражей (назначение стратегии, включение движка, стратегия по умолчанию — 0085, 0199); страж привязки — тем же правилом
  // (channel-pricing-guard.pg.test.ts)
  const verdict = await inTenant(pool, world.tenantId, async (tx) => (await tx.query(
    'SELECT channel_data.offer_channel_pricing_active($1, $2) AS one, channel_data.offer_channel_pricing_active($1, $3) AS three', [world.tenantId, ws(1), ws(3)])).rows[0]);
  assert.deepEqual([verdict.one, verdict.three], [null, 'CHANNEL_REPRICER_ACTIVE']);
});
