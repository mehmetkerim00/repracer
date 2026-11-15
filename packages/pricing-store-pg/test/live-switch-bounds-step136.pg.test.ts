import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { AdapterCallContext, ChannelAdapter, FieldWrite } from '@repracer/channel-port';
import { createPricingPipeline, standUserOf, type MemorySeedScope } from '@repracer/pricing-pipeline';
import { inTenant, PgPricingStore, PgShadowStore, seedPricingWorld, type PgPool, type SeededPricingWorld } from '../src/index.ts';
import { engineCost } from './drafts.ts';
import { createIsolatedDatabase, type IsolatedDatabase } from './isolated-db.ts';

/**
 * Шаг 136 (отложенное «128», решение владельца 2026-11-15 — вариант (а); release gate из отчёта Мердана): перевод аккаунта из тени в бой
 * ОТКАЗЫВАЕТ, пока у аккаунта есть включённые предложения с рамками Amazon Min/Max без прочитанных значений (или прочитанными не в валюте
 * предложения), и перечисляет их. Без скрытых изменений: автоцена сама не выключается. Шаг 127 разрешил такие предложения в тени, шаг 128 — не
 * включать их в бою; без этого шага перевод в бой оставлял их включёнными, и первая боевая запись упиралась бы в адаптер (BLOCKED и CRITICAL).
 *
 * Тест пути: защита срабатывает ДО первой реальной записи цены — тень решает, в адаптер не уходит ничего, перевод в бой отказывает, и первая
 * запись уходит только после того, как продавец выключил такие предложения [Р-242] и перевёл аккаунт сам. Данные синтетические.
 */
const AMAZON = '20000000-0000-4000-8000-000000001361';
const DE = 'A1PA6795UKMFR9';
const EXTERNAL = 'A1SYN1361';
const now = () => new Date().toISOString();
const fixed = (priceMinor: number) => ({ strategyId: `st-fixed-${priceMinor}`, version: 1, params: { type: 'FIXED', priceMinor }, deadbandMinor: 0 }) as MemorySeedScope['strategy'];
const sku = (n: number) => `SYN-SKU-136${n}`;
const scope = (n: number): MemorySeedScope => ({
  writeScopeId: `ws-${n}`, productId: `prod-${n}`, channelAccountId: AMAZON, marketplace: DE, externalUnitId: sku(n), channelProductRef: `B00013610${n}`,
  condition: 'new', currency: 'EUR', basis: 'GROSS', pricingMode: 'OFF', strategy: fixed(2100 + n), cost: engineCost(),
  currentPriceMinor: 1950, minPrice: { amountMinor: 1000, id: `min-${n}` }, maxPrice: { amountMinor: 3000, id: `max-${n}` },
});

let db: IsolatedDatabase;
let pool: PgPool;
let admin: PgPool;
let world: SeededPricingWorld;
let store: PgPricingStore;
let shadow: PgShadowStore;

before(async () => {
  db = await createIsolatedDatabase('step136');
  pool = db.pool('svc_app');
  admin = db.pool('svc_admin', 2);
  // Аккаунт в тени — как у пилота [Р-169, Р-247]; витрина amazon.de — её свойства известны (Р-172), и бой держит только этот шаг
  world = await seedPricingWorld(pool, { provisioningPool: db.pool('svc_provisioning', 1), adminPool: admin,
    fixtureTenantId: '10000000-0000-4000-8000-000000001361', fixtureChannelAccountId: AMAZON, fixtureChannel: 'AMAZON', fixtureRegion: 'EU',
    fixtureExternalAccountId: EXTERNAL, marketplaces: [DE], clock: now(), writeMode: 'SHADOW',
    seed: { scopes: [scope(1), scope(2), scope(3), scope(4)] } });
  store = new PgPricingStore(pool, { adminPool: admin });
  shadow = new PgShadowStore({ adminPool: admin });
});
after(async () => { await db?.drop(); });

const observe = (n: number, o: { automatedPricing: boolean; channelBounds: boolean; boundValues?: { minMinor: number | null; maxMinor: number | null; currency: string } }) =>
  store.recordOfferChannelPricing(world.tenantId, world.ids.dbId(AMAZON), [{ marketplace: DE, externalSku: sku(n), ...o, source: 'DISCOVERY', observedAt: now() as never }]);
const ws = (n: number) => world.ids.dbId(`ws-${n}`);
const owner = () => world.ids.dbId(standUserOf('membership-owner'));
const ctx = (): AdapterCallContext => ({ tenantId: world.tenantId as never, channelAccountId: world.ids.dbId(AMAZON) as never, correlationId: 'step136',
  deadline: new Date(Date.now() + 60_000).toISOString() as never });
// Адаптер канала: всё, что дошло до отправки, записывается — это и есть «реальная запись цены»
const sent: FieldWrite[] = [];
const adapter = {
  descriptor: { channel: 'AMAZON', scheduledRecomputeSeconds: 900, competitorSources: [] },
  async planDispatch(_ctx: unknown, writes: readonly FieldWrite[]) {
    sent.push(...writes);
    return { batches: writes.map((w) => ({ batchId: `b:${w.channelWriteId}`, operation: 'TEST', items: [w], budgetCharges: [], requestCount: 1 })), rejected: [] };
  },
  async dispatch(_ctx: unknown, batch: { batchId: string; items: FieldWrite[] }) {
    return { batchId: batch.batchId, outcomes: batch.items.map((w) => ({ channelWriteId: w.channelWriteId, status: 'ACCEPTED', appliedImmediately: true })), attemptsMade: 1 };
  },
  async readBack() { return { observations: [], failures: [] }; },
} as unknown as ChannelAdapter;
const pipeline = () => createPricingPipeline({ store, adapter, alerts: { async raise() {} }, logger: { log() {} }, now });
const goLive = () => shadow.switchWriteMode(world.tenantId, {
  channelAccountId: world.ids.dbId(AMAZON), toMode: 'LIVE', typedConfirmation: EXTERNAL,
  membershipId: world.ownerMembershipId, userId: world.userId, mfa: true,
});
const writeMode = async () => inTenant(admin, world.tenantId, async (tx) => (await tx.query(
  'SELECT write_mode FROM tenant_data.channel_account WHERE tenant_id = $1 AND channel_account_id = $2', [world.tenantId, world.ids.dbId(AMAZON)])).rows[0].write_mode);

test('step 136 (deferred 128): going live is refused while enabled offers have Amazon Min/Max we cannot read — before the first real price write', async () => {
  // 1 — рамки без значений; 2 — значения не в валюте предложения; 3 — значения известны в валюте предложения; 4 — рамки без значений, но выключено
  await observe(1, { automatedPricing: false, channelBounds: true });
  await observe(2, { automatedPricing: false, channelBounds: true, boundValues: { minMinor: 900, maxMinor: 3500, currency: 'USD' } });
  await observe(3, { automatedPricing: false, channelBounds: true, boundValues: { minMinor: 900, maxMinor: 3500, currency: 'EUR' } });
  await observe(4, { automatedPricing: false, channelBounds: true });
  for (const n of [1, 2, 3]) await store.setPricingMode(world.tenantId, ws(n), 'ENGINE', owner());
  // Тень решает по всем трём включённым — и в адаптер не уходит ничего [Р-169]
  for (const n of [1, 2, 3]) await pipeline().recompute(ctx(), ws(n), { type: 'SCHEDULE' });
  assert.deepEqual(sent, [], 'the shadow decides and sends nothing');

  const refused = await goLive();
  assert.equal(refused.status, 'CHANNEL_BOUNDS_UNREAD', 'going live is refused while such offers are enabled');
  const listed = refused.status === 'CHANNEL_BOUNDS_UNREAD' ? refused : { total: -1, offers: [] };
  assert.equal(listed.total, 2, 'two enabled offers block: limits without values and limits in another currency');
  assert.deepEqual(listed.offers, [{ externalSku: sku(1), marketplace: DE }, { externalSku: sku(2), marketplace: DE }],
    'the refusal names them — not the offer with known values, not the one turned off');
  assert.equal(await writeMode(), 'SHADOW', 'the account stays in shadow');
  assert.deepEqual(sent, [], 'no real price write before the switch');

  // Без скрытых изменений: автоцена у этих предложений не выключилась сама
  const modes = await inTenant(admin, world.tenantId, async (tx) => (await tx.query(
    'SELECT pricing_mode FROM tenant_data.write_scope WHERE tenant_id = $1 AND write_scope_id = ANY($2::uuid[]) ORDER BY write_scope_id', [world.tenantId, [ws(1), ws(2)]])).rows);
  assert.deepEqual(modes.map((r) => r.pricing_mode), ['ENGINE', 'ENGINE'], 'the refusal changes nothing by itself');

  // Продавец выключает эти предложения сам [Р-242] — и только тогда перевод проходит, а первая боевая запись уходит
  for (const n of [1, 2]) await store.setPricingMode(world.tenantId, ws(n), 'OFF', owner(), 'step 136: Amazon limits we cannot read');
  const switched = await goLive();
  assert.equal(switched.status, 'SWITCHED', JSON.stringify(switched));
  assert.equal(await writeMode(), 'LIVE');
  await pipeline().recompute(ctx(), ws(3), { type: 'SCHEDULE' });
  assert.deepEqual((sent as FieldWrite[]).map((w) => w.writeScope.writeScopeId), [ws(3)], 'the first real price write is the offer with known limits, after the switch');
});

test('step 136: the rule is one database function — the guard and the console read the same list; once the seller turned the offers off it is empty', async () => {
  const listed = await inTenant(admin, world.tenantId, async (tx) => (await tx.query(
    'SELECT external_sku, marketplace, total FROM tenant_data.live_switch_blocking_offers($1, $2)', [world.tenantId, world.ids.dbId(AMAZON)])).rows);
  assert.deepEqual(listed, [], 'after the seller turned them off nothing blocks');
});
