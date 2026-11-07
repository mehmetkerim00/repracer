import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { AdapterCallContext, ChannelAdapter, CompetitorSnapshot, FieldWrite } from '@repracer/channel-port';
import { createPricingPipeline, type MemorySeedScope } from '@repracer/pricing-pipeline';
import type { CostInputs } from '@repracer/pricing-model';
import { createWriteDispatcher, DEFAULT_RETRY_POLICY } from '@repracer/write-dispatcher';
import { inTenant, PgPricingStore, PgWriteQueueStore, seedPricingWorld, type PgPool, type SeededPricingWorld } from '../src/index.ts';
import { approved, commit, contextOf } from './drafts.ts';
import { createIsolatedDatabase, type IsolatedDatabase } from './isolated-db.ts';

/**
 * Шаг 118 на PostgreSQL (0222): выключение автоцены одного предложения — «вот этот SKU не трогай».
 *  - выключение и включение — строка журнала той же транзакцией, что смена режима; человек сессии, записка по желанию, событие аудита (кто и когда);
 *  - журнал держит база: выключить можно только включённое, включить — только выключенное, членство — того человека; каждая причина — своя [Р-94];
 *  - выключить можно и с записью в полёте (Р-12 держит только переходы Smart Pricing); запись, ждавшая в очереди, в канал не уходит —
 *    прежний страж отправки отклоняет её, диспетчер завершает причиной WRITE_PRICING_MODE_CHANGED;
 *  - выключенное предложение движок не оценивает вовсе: ни решения, ни живой строки повторов (Р-241).
 * Данные синтетические
 */

const ACCOUNT = '20000000-0000-4000-8000-000000000118';
const now = () => new Date().toISOString();
const COST: CostInputs = { currency: 'EUR', costProfileId: 'cp-118', unitCostMinor: 700, fixedFeeMinor: 0, feeRateBp: 1000, tax: { regime: 'VAT_INCLUDED', vatRateBp: 1900 } };
const FIXED = { strategyId: 'st-fixed', version: 1, params: { type: 'FIXED', priceMinor: 1600 }, deadbandMinor: 0 } as const;
const BEAT = { strategyId: 'st-beat', version: 1, params: { type: 'BEAT_LOWEST', undercutMinor: 1, scope: 'VISIBLE_TOP_N', compareLanded: false, atBound: 'CAP' }, deadbandMinor: 0 } as const;

function scope(n: number, strategy: MemorySeedScope['strategy'], over: Partial<MemorySeedScope> = {}): MemorySeedScope {
  return {
    writeScopeId: `ws-${n}`, productId: `prod-${n}`, channelAccountId: ACCOUNT, marketplace: 'de', externalUnitId: String(11800 + n),
    channelProductRef: `11801${n}`, condition: 'new', currency: 'EUR', basis: 'GROSS', pricingMode: 'ENGINE', strategy, cost: COST,
    currentPriceMinor: 1500, minPrice: { amountMinor: 1200, id: `min-${n}` }, maxPrice: { amountMinor: 5000, id: `max-${n}` }, ...over,
  };
}

let db: IsolatedDatabase;
let pool: PgPool;
let admin: PgPool;
let world: SeededPricingWorld;
let store: PgPricingStore;

before(async () => {
  db = await createIsolatedDatabase('step118');
  pool = db.pool('svc_app');
  admin = db.pool('svc_admin', 2);
  world = await seedPricingWorld(pool, { provisioningPool: db.pool('svc_provisioning', 1), adminPool: admin,
    fixtureTenantId: '10000000-0000-4000-8000-000000000118', fixtureChannelAccountId: ACCOUNT, marketplaces: ['de'], clock: now(),
    seed: { scopes: [
      scope(1, FIXED), // журнал и аудит
      scope(2, FIXED), // стражи журнала
      scope(3, FIXED), // запись в очереди после выключения
      scope(4, FIXED, { currentPriceMinor: 1600 }), // контроль: включённое на цели — «без изменения» и повторы
      scope(5, FIXED, { currentPriceMinor: 1600 }), // выключенное на цели — не оценивается
      scope(6, BEAT), // выключенное с конкурентом — снимок не даёт решения
      scope(7, BEAT), // контроль: включённое с конкурентом — снимок даёт решение
      scope(8, FIXED, { pricingMode: 'OFF' }), // первое включение (онбординг) — без строки журнала
    ] } });
  store = new PgPricingStore(pool, { adminPool: admin });
});
after(async () => { await db?.drop(); });

const ws = (n: number) => world.ids.dbId(`ws-${n}`);
const outcome = async (p: Promise<unknown>) => { try { await p; return 'accepted'; } catch (e) { return (e as Error).message; } };
const journal = (n: number) => db.rows<{ action: string; note: string | null; membership: string }>(
  `SELECT action, note, created_by_membership_id::text AS membership FROM tenant_data.offer_pricing_switch WHERE tenant_id = $1 AND write_scope_id = $2 ORDER BY seq`,
  [world.tenantId, ws(n)]);
const modeOf = async (n: number) => (await db.rows<{ pricing_mode: string }>('SELECT pricing_mode FROM tenant_data.write_scope WHERE tenant_id = $1 AND write_scope_id = $2', [world.tenantId, ws(n)]))[0]!.pricing_mode;

test('step 118: turning automatic pricing off and on — a journal row each, the audit names who and when, the screen reads it back', async () => {
  // Без второго фактора: сессия административного сервиса — человек, но mfa нет (Р-225)
  await store.setPricingMode(world.tenantId, ws(1), 'OFF', world.userId, 'Supplier price talks');
  assert.equal(await modeOf(1), 'OFF');
  await store.setPricingMode(world.tenantId, ws(1), 'ENGINE', world.userId);
  assert.deepEqual(await journal(1), [
    { action: 'OFF', note: 'Supplier price talks', membership: world.ownerMembershipId },
    { action: 'ON', note: null, membership: world.ownerMembershipId },
  ]);
  const audit = await db.rows<{ action: string; actor: string; second: boolean }>(
    `SELECT action, actor_user_id::text AS actor, (changes ->> 'secondFactor')::boolean AS second FROM audit.audit_event
      WHERE tenant_id = $1 AND entity_type = 'tenant_data.offer_pricing_switch' ORDER BY occurred_at`, [world.tenantId]);
  assert.deepEqual(audit.map((a) => [a.action, a.actor, a.second]), [['admin_change.insert', world.userId, false], ['admin_change.insert', world.userId, false]],
    'each switch is an audit event of the person, without a second factor');
  await store.setPricingMode(world.tenantId, ws(1), 'OFF', world.userId, null);
  const state = await store.readConsoleState(world.tenantId, now() as never, { scopeIds: [ws(1)] });
  const sw = state.scopes.find((s) => s.writeScopeId === ws(1))?.pricingSwitch;
  assert.deepEqual(sw && [sw.action, sw.note, sw.membershipId], ['OFF', null, world.ownerMembershipId], 'the screen reads the latest switch');
  assert.ok(sw && Date.now() - Date.parse(sw.at) < 60_000, 'the time of the switch is the database time');
  // Первое включение — не «включили обратно»: строки журнала нет, кто и когда — общим аудитом смены режима единицы
  await store.setPricingMode(world.tenantId, ws(8), 'ENGINE', world.userId);
  assert.deepEqual([await modeOf(8), await journal(8)], ['ENGINE', []], 'the first enable writes no journal row');
  const modeAudit = await db.rows<{ n: string }>(`SELECT count(*) AS n FROM audit.audit_event WHERE tenant_id = $1 AND entity_type = 'tenant_data.write_scope' AND entity_id = $2
     AND actor_user_id = $3 AND changes -> 'columns' ? 'pricing_mode'`, [world.tenantId, ws(8), world.userId]);
  assert.equal(Number(modeAudit[0]!.n), 1, 'the first enable is an audit event of the person');
});

test('step 118: the database keeps the journal honest — own membership, only what is on can be turned off, only what is off can be turned on', async () => {
  const insert = (over: { action?: string; note?: string | null; membership?: string }) => outcome(inTenant(admin, world.tenantId, (tx) => tx.query(
    `INSERT INTO tenant_data.offer_pricing_switch (tenant_id, write_scope_id, action, note, created_by_membership_id) VALUES ($1, $2, $3, $4, $5)`,
    [world.tenantId, ws(2), over.action ?? 'OFF', over.note === undefined ? null : over.note, over.membership ?? world.ownerMembershipId]), world.userId));
  assert.match(await insert({ action: 'ON' }), /is not off \(mode ENGINE\): nothing to turn on/, 'turning on an offer that is on is refused');
  assert.match(await insert({ membership: '30000000-0000-4000-8000-000000000118' }), /not the membership of the session user/, 'turned off in the name of another membership');
  assert.match(await insert({ note: '   ' }), /offer_pricing_switch_note_form/, 'an empty note is refused');
  assert.match(await insert({ note: 'x'.repeat(501) }), /offer_pricing_switch_note_form/, 'a note longer than 500 characters is refused');
  assert.match(await insert({ action: 'PAUSE' }), /offer_pricing_switch_action_known/, 'an unknown action is refused');
  assert.equal(await insert({}), 'accepted', 'control: turning off what is on is accepted');
  // Страж читает режим единицы: строку вставили мимо хранилища, режим остался ENGINE — выключенным его делает смена режима
  await inTenant(admin, world.tenantId, (tx) => tx.query(`UPDATE tenant_data.write_scope SET pricing_mode = 'OFF' WHERE tenant_id = $1 AND write_scope_id = $2`, [world.tenantId, ws(2)]), world.userId);
  assert.match(await insert({}), /is not on \(mode OFF\): nothing to turn off/, 'turning off an offer that is off is refused');
  // Без человека сессии — общий страж административной записи
  assert.match(await outcome(inTenant(admin, world.tenantId, (tx) => tx.query(
    `INSERT INTO tenant_data.offer_pricing_switch (tenant_id, write_scope_id, action, created_by_membership_id) VALUES ($1, $2, 'ON', $3)`,
    [world.tenantId, ws(2), world.ownerMembershipId]))), /session user|person/);
});

const sent: FieldWrite[] = [];
const adapter = {
  descriptor: { channel: 'KAUFLAND', scheduledRecomputeSeconds: 900, competitorSources: [{ source: 'KAUFLAND_BUYBOX', kind: 'PULL', completeness: { kind: 'TOP_N', n: 10 },
    conditions: ['new'], hasBuyboxWinner: true, hasBuyboxPrice: true, hasFulfilment: true, hasOwnRank: true, hasShipping: true, typicalStalenessSeconds: null, availability: 'AVAILABLE', role: 'PRIMARY' }] },
  async planDispatch(_ctx: unknown, writes: readonly FieldWrite[]) {
    return { batches: writes.map((w) => ({ batchId: `b:${w.channelWriteId}`, operation: 'TEST', items: [w], budgetCharges: [], requestCount: 1 })), rejected: [] };
  },
  async dispatch(_ctx: unknown, batch: { batchId: string; items: FieldWrite[] }) {
    sent.push(...batch.items);
    return { batchId: batch.batchId, outcomes: batch.items.map((w) => ({ channelWriteId: w.channelWriteId, status: 'ACCEPTED', appliedImmediately: true })), attemptsMade: 1 };
  },
  async readBack() { return { observations: [], failures: [] }; },
} as unknown as ChannelAdapter;

test('step 118: turning off with a write in flight is accepted — the queued write never reaches the channel, the dispatcher ends it with the mode change', async () => {
  const draft = async (amountMinor: number) => approved(await contextOf(store, world.tenantId, ws(3)), amountMinor);
  const r1 = await commit(store, world.tenantId, await draft(1600));
  assert.ok(r1.status === 'COMMITTED' && r1.decisions[0]!.write, `the first write is in flight: ${JSON.stringify(r1)}`);
  const r2 = await commit(store, world.tenantId, await draft(1610));
  const pendingWriteId = r2.status === 'COMMITTED' ? r2.decisions[0]!.pendingWriteId : undefined;
  assert.ok(pendingWriteId, `the second write waits in the queue: ${JSON.stringify(r2)}`);
  // Р-12 до шага: «write_scope has unfinished writes; pricing_mode cannot change» — «не трогай» ждало бы очереди
  assert.equal(await outcome(store.setPricingMode(world.tenantId, ws(3), 'OFF', world.userId, null)), 'accepted', 'turning off with a write in flight is accepted');
  const queue = new PgWriteQueueStore(pool);
  const inFlight = r1.decisions[0]!.write!;
  await queue.recordOutcome(world.tenantId, inFlight, { channelWriteId: inFlight.channelWriteId, status: 'ACCEPTED', appliedImmediately: true }, now(), DEFAULT_RETRY_POLICY);
  const alerts: string[] = [];
  const report = await createWriteDispatcher({ store: queue, adapterFor: () => adapter, alerts: { raise: async (a) => { alerts.push(a.code); } }, now }).dispatchScope(world.tenantId, ws(3));
  assert.equal(sent.some((w) => w.channelWriteId === pendingWriteId), false, `the write of a turned-off offer reached the channel: ${JSON.stringify(report.steps)}`);
  const ended = report.steps.find((s) => s.action === 'ENDED' && s.channelWriteId === pendingWriteId);
  assert.deepEqual(ended && ended.action === 'ENDED' ? [ended.reason.code, ended.reason.params] : null, ['WRITE_PRICING_MODE_CHANGED', { mode: 'OFF' }],
    `the dispatcher ends the queued write with the mode change: ${JSON.stringify(report.steps)}`);
});

const eur = (amountMinor: number) => ({ amountMinor, currency: 'EUR', basis: 'GROSS' as const });
const market = (n: number, competitor: number): CompetitorSnapshot => ({
  marketplace: 'de', channelProductRef: `11801${n}`, condition: 'new', source: 'KAUFLAND_BUYBOX', observedAt: now() as never, completeness: { kind: 'TOP_N', n: 10 },
  buybox: { price: eur(competitor), isSelf: false, shipping: eur(0), sellerRef: 'Harbor Goods' },
  offers: [{ rank: 1, sellerRef: 'Harbor Goods', isSelf: false, price: eur(competitor), shipping: eur(0), totalPrice: eur(competitor), holdsBuyBox: true },
    { rank: 2, isSelf: true, price: eur(1500), shipping: eur(0), totalPrice: eur(1500) }],
});
const ctx = (): AdapterCallContext => ({ tenantId: world.tenantId as never, channelAccountId: world.ids.dbId(ACCOUNT) as never, correlationId: 'step118', deadline: new Date(Date.now() + 60_000).toISOString() as never });
const decisions = async (n: number) => Number((await db.rows<{ n: string }>('SELECT count(*) AS n FROM channel_data.price_decision WHERE tenant_id = $1 AND write_scope_id = $2', [world.tenantId, ws(n)]))[0]!.n);
const repeats = async (n: number) => (await db.rows<{ repeats: number }>('SELECT repeats FROM tenant_data.price_no_change_state WHERE tenant_id = $1 AND write_scope_id = $2', [world.tenantId, ws(n)]))[0]?.repeats ?? null;

test('step 118: a turned-off offer is not evaluated at all — no decision and no repeats, while the offers that are on are', async () => {
  await store.setPricingMode(world.tenantId, ws(5), 'OFF', world.userId, null);
  await store.setPricingMode(world.tenantId, ws(6), 'OFF', world.userId, 'Hand-priced for the launch');
  const p = createPricingPipeline({ store, adapter, alerts: { raise: async () => undefined }, logger: { log: () => undefined }, now: () => now() as never });
  for (let i = 0; i < 3; i++) {
    for (const n of [4, 5]) await p.recompute(ctx(), ws(n), { type: 'SCHEDULE' });
    for (const n of [6, 7]) await p.processSnapshot(ctx(), market(n, 1400 + i));
  }
  // Контроль: включённые оцениваются — на цели одна строка и повторы, с конкурентом — решения
  assert.equal(await decisions(4), 1, 'control: the offer that is on writes one no-change row');
  assert.ok((await repeats(4) ?? 0) >= 2, `control: the offer that is on counts its repeats: ${await repeats(4)}`);
  assert.ok(await decisions(7) >= 1, 'control: a snapshot gives the offer that is on a decision');
  // Выключенные — ничего
  assert.deepEqual([await decisions(5), await repeats(5), await decisions(6), await repeats(6)], [0, null, 0, null], 'a turned-off offer gets no decision and no repeats');
});
