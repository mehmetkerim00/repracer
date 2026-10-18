import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { AdapterCallContext, ChannelAdapter, CompetitorSnapshot, FieldWrite } from '@repracer/channel-port';
import { createPricingPipeline, type MemorySeedScope } from '@repracer/pricing-pipeline';
import { storefrontPriceForMarginBp, type CostInputs } from '@repracer/pricing-model';
import { inTenant, PgPricingStore, seedPricingWorld, type PgPool, type SeededPricingWorld } from '../src/index.ts';
import { createIsolatedDatabase, type IsolatedDatabase } from './isolated-db.ts';

/**
 * Шаг 102 [Р-227] на PostgreSQL, красное сначала (задание D):
 *  (1) режим распродажи не включается без подтверждения, записки и второго фактора — отказывает база, а не экран;
 *  (2) никакой путь — правка одного предложения, массовая правка, импорт границ, рост себестоимости — не ставит действующий пол ниже
 *      безубыточности вне режима распродажи (пол считает база перед каждой отправкой, Р-83);
 *  (3) после выключения режима первый же пересчёт начинает подъём к полу лестницей и цену не опускает;
 *  (5) удержания распродажного пола помечены и в «без пола вы продали бы на $X дешевле» не входят.
 * Данные синтетические
 */

const ACCOUNT = '20000000-0000-4000-8000-000000000102';
const SHADOW_ACCOUNT = '20000000-0000-4000-8000-000000000112';
const now = () => new Date().toISOString();
// Себестоимость €11.00, комиссия 15 %, НДС 19 % внутри цены: безубыточность — тем же расчётом, что у Gate и базы
const COST: CostInputs = { currency: 'EUR', costProfileId: 'cp-102', unitCostMinor: 1100, fixedFeeMinor: 0, feeRateBp: 1500, tax: { regime: 'VAT_INCLUDED', vatRateBp: 1900 } };
const BREAK_EVEN = (storefrontPriceForMarginBp(COST, 0) as { priceMinor: number }).priceMinor;
const FIXED = { strategyId: 'st-fixed', version: 1, params: { type: 'FIXED', priceMinor: 2400 }, deadbandMinor: 0 } as const;
const BEAT = { strategyId: 'st-beat', version: 1, params: { type: 'BEAT_LOWEST', undercutMinor: 1, scope: 'VISIBLE_TOP_N', compareLanded: false, atBound: 'CAP' }, deadbandMinor: 0 } as const;

function scope(n: number, strategy: MemorySeedScope['strategy'], over: Partial<MemorySeedScope> = {}, account = ACCOUNT): MemorySeedScope {
  return {
    writeScopeId: `ws-${n}`, productId: `prod-${n}`, channelAccountId: account, marketplace: 'de', externalUnitId: String(10200 + n),
    channelProductRef: `10201${n}`, condition: 'new', currency: 'EUR', basis: 'GROSS', pricingMode: 'ENGINE', strategy, cost: COST,
    currentPriceMinor: 2400, minPrice: { amountMinor: 1800, id: `min-${n}` }, maxPrice: { amountMinor: 5000, id: `max-${n}` }, ...over,
  };
}

let db: IsolatedDatabase;
let pool: PgPool;
let admin: PgPool;
let world: SeededPricingWorld;
let shadow: SeededPricingWorld;
let store: PgPricingStore;

before(async () => {
  db = await createIsolatedDatabase('step102');
  pool = db.pool('svc_app');
  admin = db.pool('svc_admin', 2);
  world = await seedPricingWorld(pool, { provisioningPool: db.pool('svc_provisioning', 1), adminPool: admin,
    fixtureTenantId: '10000000-0000-4000-8000-000000000102', fixtureChannelAccountId: ACCOUNT, marketplaces: ['de'], clock: now(),
    seed: { scopes: [scope(1, FIXED), scope(2, BEAT, { guardrails: { maxStepChangeBp: 1000 }, currentPriceMinor: 1050 }), scope(3, FIXED), scope(4, FIXED)] } });
  shadow = await seedPricingWorld(pool, { provisioningPool: db.pool('svc_provisioning', 1), adminPool: admin, writeMode: 'SHADOW',
    fixtureTenantId: '10000000-0000-4000-8000-000000000112', fixtureChannelAccountId: SHADOW_ACCOUNT, marketplaces: ['de'], clock: now(),
    seed: { scopes: [scope(5, BEAT, {}, SHADOW_ACCOUNT), scope(6, BEAT, {}, SHADOW_ACCOUNT)] } });
  store = new PgPricingStore(pool, { adminPool: admin });
});
after(async () => { await db?.drop(); });

const actor = (w: SeededPricingWorld, mfa: boolean) => ({ membershipId: w.ownerMembershipId, userId: w.userId, mfa });
const floorOf = async (w: SeededPricingWorld, ws: string) => Number((await inTenant(pool, w.tenantId, (tx) => tx.query(
  'SELECT floor_minor FROM tenant_data.effective_price_floor($1, $2, now())', [w.tenantId, w.ids.dbId(ws)]))).rows[0].floor_minor);
const outcome = async (p: Promise<unknown>) => { try { await p; return 'accepted'; } catch (e) { return (e as Error).message; } };
const assertFloor = (w: SeededPricingWorld, ws: string, amount: number) => outcome(inTenant(pool, w.tenantId, (tx) => tx.query(
  'SELECT tenant_data.assert_price_floor($1, $2, $3, $4)', [w.tenantId, w.ids.dbId(ws), amount, 'test'])));

test('step 102 (D1) [Р-227]: the database refuses clearance without the acknowledgement, the note or the second factor', async () => {
  const ws = world.ids.dbId('ws-4');
  const insert = (ack: boolean, note: string, mfa: boolean) => outcome(inTenant(admin, world.tenantId, (tx) => tx.query(
    `INSERT INTO tenant_data.clearance_change (tenant_id, write_scope_id, action, floor_minor, currency, note, acknowledged, created_by_membership_id)
     VALUES ($1, $2, 'ENABLE', 900, 'EUR', $3, $4, $5)`, [world.tenantId, ws, note, ack, world.ownerMembershipId]), world.userId, { mfa }));
  assert.match(await insert(false, 'Clearing summer stock', true), /acknowledg/, 'no acknowledgement — refused by the database');
  assert.match(await insert(true, '   ', true), /note is required/, 'no note — refused by the database');
  assert.match(await insert(true, 'Clearing summer stock', false), /second factor/, 'no second factor — refused by the database');
  // Через хранилище — те же отказы своими причинами, а не исключением
  const input = { writeScopeId: ws, floorMinor: 900, currency: 'EUR', endsAt: null, note: 'Clearing summer stock', acknowledged: true };
  assert.deepEqual(await store.enableClearance(world.tenantId, { ...input, acknowledged: false }, actor(world, true)), { status: 'INVALID', cause: 'ACK_REQUIRED' });
  assert.deepEqual(await store.enableClearance(world.tenantId, { ...input, note: '' }, actor(world, true)), { status: 'INVALID', cause: 'NOTE_REQUIRED' });
  assert.deepEqual(await store.enableClearance(world.tenantId, input, actor(world, false)), { status: 'MFA_REQUIRED' });
  assert.equal((await store.clearanceOf(world.tenantId, ws)).active, null, 'nothing was enabled');
  // Положительный контроль: всё на месте — включено, история хранит записку и автора, выключение — одним действием без второго фактора
  const on = await store.enableClearance(world.tenantId, input, actor(world, true));
  assert.equal(on.status, 'ENABLED');
  const state = await store.clearanceOf(world.tenantId, ws);
  assert.deepEqual([state.active?.floorMinor, state.active?.note, state.active?.enabledByMembershipId], [900, 'Clearing summer stock', world.ownerMembershipId]);
  // Журнал только на добавление: у административного сервиса права переписать строку нет (триггер неизменяемости — смоук Р-103)
  assert.match(await outcome(inTenant(admin, world.tenantId, (tx) => tx.query(
    `UPDATE tenant_data.clearance_change SET note = 'rewritten' WHERE tenant_id = $1`, [world.tenantId]), world.userId, { mfa: true })), /permission denied/, 'the journal is append-only');
  assert.deepEqual((await store.disableClearance(world.tenantId, { writeScopeId: ws, note: null }, actor(world, false))).status, 'DISABLED');
  assert.equal(JSON.stringify(await store.disableClearance(world.tenantId, { writeScopeId: ws, note: null }, actor(world, false))), JSON.stringify({ status: 'NOT_ACTIVE' }),
    'nothing to disable — refused by the database');
  assert.deepEqual((await store.clearanceOf(world.tenantId, ws)).history.map((h) => h.action), ['DISABLE', 'ENABLE']);
});

test('step 102 (D2) [Р-227]: no path puts the effective floor below break-even outside clearance — single edit, bulk edit, import, cost growth', async () => {
  const ws1 = world.ids.dbId('ws-1');
  const ws3 = world.ids.dbId('ws-3');
  assert.ok(BREAK_EVEN > 1300 && BREAK_EVEN < 1800, `break-even ${BREAK_EVEN}`);
  // Правка одного предложения: min_price ниже безубыточности принят, но действующий пол — безубыточность
  assert.equal((await store.editBounds(world.tenantId, [{ writeScopeId: ws1, minMinor: 1000, expected: { minMinor: 1800, maxMinor: 5000 } }], actor(world, false), 'APPLY')).status, 'APPLIED');
  assert.equal(await floorOf(world, 'ws-1'), BREAK_EVEN, 'single edit: the floor stays at break-even');
  assert.match(await assertFloor(world, 'ws-1', BREAK_EVEN - 1), /below effective price floor/, 'a price below break-even does not leave (Р-83)');
  // Массовая правка (со вторым фактором): то же
  assert.equal((await store.editBounds(world.tenantId, [
    { writeScopeId: ws1, minMinor: 900, expected: { minMinor: 1000, maxMinor: 5000 } },
    { writeScopeId: ws3, minMinor: 900, expected: { minMinor: 1800, maxMinor: 5000 } },
  ], actor(world, true), 'APPLY')).status, 'APPLIED');
  assert.deepEqual([await floorOf(world, 'ws-1'), await floorOf(world, 'ws-3')], [BREAK_EVEN, BREAK_EVEN], 'bulk edit: both floors stay at break-even');
  // Импорт границ: строка с min price ниже безубыточности применяется, пол — безубыточность
  const imported = await store.importBounds(world.tenantId, { rows: [{ writeScopeId: ws3, minMinor: 800, expected: { minMinor: 900, maxMinor: 5000, minMarginBp: null } }] }, actor(world, true));
  assert.equal(imported.status, 'APPLIED');
  assert.equal(await floorOf(world, 'ws-3'), BREAK_EVEN, 'import: the floor stays at break-even');
  // Рост себестоимости: пол поднимается вместе с безубыточностью, и база ставит запрос на переоценку
  await inTenant(admin, world.tenantId, (tx) => tx.query(
    `INSERT INTO tenant_data.cost_profile (tenant_id, product_id, channel_account_id, marketplace, version, valid_from, currency, purchase_cost_minor, source, created_by_membership_id)
     SELECT tenant_id, product_id, channel_account_id, marketplace, version + 1, now(), currency, 1400, 'MANUAL', created_by_membership_id
       FROM tenant_data.cost_profile WHERE tenant_id = $1 AND product_id = $2 ORDER BY version DESC LIMIT 1`, [world.tenantId, world.ids.dbId('prod-1')]), world.userId);
  const grown = (storefrontPriceForMarginBp({ ...COST, unitCostMinor: 1400 }, 0) as { priceMinor: number }).priceMinor;
  assert.equal(await floorOf(world, 'ws-1'), grown, 'cost growth: the floor moved up with break-even');
  const requests = (await inTenant(pool, world.tenantId, (tx) => tx.query(
    `SELECT reason FROM tenant_data.floor_raise_request WHERE tenant_id = $1 AND write_scope_id = $2`, [world.tenantId, ws1]))).rows.map((r) => r.reason);
  assert.ok(requests.includes('COST_UPDATE'), 'the cost growth asks for a re-evaluation');
  // В режиме распродажи — и только в нём — цена ниже безубыточности проходит до пола распродажи
  assert.equal((await store.enableClearance(world.tenantId, { writeScopeId: ws3, floorMinor: 1000, currency: 'EUR', endsAt: null, note: 'Clearing summer stock', acknowledged: true }, actor(world, true))).status, 'ENABLED');
  assert.equal(await floorOf(world, 'ws-3'), 1000, 'clearance: the floor is the clearance floor');
  assert.equal(await assertFloor(world, 'ws-3', 1100), 'accepted', 'clearance: a sale below break-even on purpose');
  assert.match(await assertFloor(world, 'ws-3', 999), /below effective price floor/, 'the clearance floor is still a floor');
  // Выключение — пол мгновенно расчётный
  await store.disableClearance(world.tenantId, { writeScopeId: ws3, note: null }, actor(world, false));
  assert.equal(await floorOf(world, 'ws-3'), BREAK_EVEN, 'after disabling the computed floor is back at once');
});

// Kaufland /buybox: держатель — ранг 1
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
const eur = (amountMinor: number) => ({ amountMinor, currency: 'EUR', basis: 'GROSS' as const });
const market = (n: number, competitor: number, self: number): CompetitorSnapshot => ({
  marketplace: 'de', channelProductRef: `10201${n}`, condition: 'new', source: 'KAUFLAND_BUYBOX', observedAt: now() as never, completeness: { kind: 'TOP_N', n: 10 },
  buybox: { price: eur(competitor), isSelf: false, shipping: eur(0), sellerRef: 'Harbor Goods' },
  offers: [{ rank: 1, sellerRef: 'Harbor Goods', isSelf: false, price: eur(competitor), shipping: eur(0), totalPrice: eur(competitor), holdsBuyBox: true },
    { rank: 2, isSelf: true, price: eur(self), shipping: eur(0), totalPrice: eur(self) }],
});
const ctxOf = (w: SeededPricingWorld, account: string): AdapterCallContext => ({ tenantId: w.tenantId as never, channelAccountId: w.ids.dbId(account) as never,
  correlationId: 'step102', deadline: new Date(Date.now() + 60_000).toISOString() as never });
const decisionsOf = (w: SeededPricingWorld, ws: string) => inTenant(pool, w.tenantId, async (tx) => (await tx.query(
  `SELECT d.outcome, d.final_amount_minor::int AS final, d.clearance_change_id, i.rationale -> 'reason' ->> 'code' AS reason_code, i.rationale -> 'explanation' AS chain
     FROM channel_data.price_decision d JOIN channel_data.price_intent i ON i.tenant_id = d.tenant_id AND i.price_intent_id = d.price_intent_id AND i.created_at = d.intent_created_at
    WHERE d.tenant_id = $1 AND d.write_scope_id = $2 ORDER BY d.decided_at, d.price_decision_id`, [w.tenantId, w.ids.dbId(ws)])).rows);

test('step 102 (D3) [Р-208, Р-227]: after clearance is switched off the first recompute starts the climb to the floor and never lowers the price', async () => {
  const p = createPricingPipeline({ store, adapter, alerts: { raise: async () => undefined }, logger: { log: () => undefined }, now: () => now() as never });
  const ws2 = world.ids.dbId('ws-2');
  assert.equal((await store.enableClearance(world.tenantId, { writeScopeId: ws2, floorMinor: 1000, currency: 'EUR', endsAt: null, note: 'Clearing summer stock', acknowledged: true }, actor(world, true))).status, 'ENABLED');
  // Конкурент €9.00: цена с €10.50 — на пол распродажи €10.00 (ниже безубыточности намеренно), в пределах шага 10 %
  for (let i = 0; i < 2; i++) await p.processSnapshot(ctxOf(world, ACCOUNT), market(2, 900, 1050));
  const during = await decisionsOf(world, 'ws-2');
  // Последнее одобренное: следующее за ним — «уже на цели» (NO_OP, без цены)
  const last = during.filter((d: { outcome: string }) => d.outcome === 'APPROVED').at(-1) ?? { final: null };
  assert.ok(during.length > 0 && during.every((d: { clearance_change_id: string | null }) => d.clearance_change_id !== null), 'every decision in clearance names its clearance');
  assert.equal(last.final, 1000, 'the price reached the clearance floor');
  // Выключение: база ставит запрос на переоценку, первый же пересчёт начинает подъём к полу €18.00 лестницей
  assert.equal((await store.disableClearance(world.tenantId, { writeScopeId: ws2, note: null }, actor(world, false))).status, 'DISABLED');
  const requested = (await inTenant(pool, world.tenantId, (tx) => tx.query(`SELECT reason FROM tenant_data.floor_raise_request WHERE tenant_id = $1 AND write_scope_id = $2`,
    [world.tenantId, ws2]))).rows.map((r) => r.reason);
  assert.equal(JSON.stringify(requested), JSON.stringify(['CLEARANCE_ENDED']), 'switching off asks for a re-evaluation');
  await p.recomputeScheduled(ctxOf(world, ACCOUNT));
  const first = (await decisionsOf(world, 'ws-2')).at(-1) ?? { reason_code: null, final: null, clearance_change_id: null };
  assert.equal(first.reason_code, 'RAISED_TOWARD_FLOOR', 'the first recompute after switching off starts the climb');
  assert.equal(first.final, 1100, 'one step of 10 % — not a jump past the step limit, and not lower');
  assert.equal(first.clearance_change_id, null);
});

test('step 102 (D5) [Р-117, Р-227]: holds of the clearance floor are marked and never counted as «your floor saved you»', async () => {
  const p = createPricingPipeline({ store, adapter, alerts: { raise: async () => undefined }, logger: { log: () => undefined }, now: () => now() as never });
  const since = new Date(Date.now() - 60_000).toISOString();
  // ws-5 — распродажа на €10.00, ws-6 — обычный пол €18.00; конкурент €9.00 у обоих: оба удержания пола
  assert.equal((await store.enableClearance(shadow.tenantId, { writeScopeId: shadow.ids.dbId('ws-5'), floorMinor: 1000, currency: 'EUR', endsAt: null, note: 'Clearing summer stock', acknowledged: true }, actor(shadow, true))).status, 'ENABLED');
  await p.processSnapshot(ctxOf(shadow, SHADOW_ACCOUNT), market(5, 900, 2400));
  await p.processSnapshot(ctxOf(shadow, SHADOW_ACCOUNT), market(6, 900, 2400));
  // Удержания пола и деньги дайджеста читает административный сервис (экран тени) — у пути решения права на них нет
  const holds = (await inTenant(admin, shadow.tenantId, (tx) => tx.query(
    `SELECT write_scope_id, below_minor::int AS below, clearance FROM channel_data.floor_hold WHERE tenant_id = $1 ORDER BY clearance`, [shadow.tenantId]))).rows;
  assert.equal(JSON.stringify(holds.map((h) => [h.write_scope_id, h.clearance])), JSON.stringify([[shadow.ids.dbId('ws-6'), false], [shadow.ids.dbId('ws-5'), true]]),
    'the clearance hold is marked');
  const { rows: [savings] } = await inTenant(admin, shadow.tenantId, (tx) => tx.query(
    'SELECT savings, priced FROM platform.shadow_floor_savings_between($1, $2::timestamptz, now() + interval \'1 minute\')', [shadow.tenantId, since]));
  const regular = holds.find((h) => !h.clearance)!;
  const sums = (savings.savings as Array<{ currency: string; minor: number }>).map((x) => [x.currency, x.minor]);
  assert.equal(JSON.stringify([Number(savings.priced), sums]), JSON.stringify([1, [['EUR', regular.below]]]), '«saved you» counts only the regular floor');
});

test('step 102 [Р-227]: the journal guard — own membership, the currency of the offer, a floor within the ceiling, an end in the future, a known action', async () => {
  const ws = world.ids.dbId('ws-4');
  const enable = (over: { action?: string; floor?: number; currency?: string; endsAt?: string; membership?: string }) => outcome(inTenant(admin, world.tenantId, (tx) => tx.query(
    `INSERT INTO tenant_data.clearance_change (tenant_id, write_scope_id, action, floor_minor, currency, ends_at, note, acknowledged, created_by_membership_id)
     VALUES ($1, $2, $3, $4, $5, $6, 'Clearing summer stock', true, $7)`,
    [world.tenantId, ws, over.action ?? 'ENABLE', over.floor ?? 900, over.currency ?? 'EUR', over.endsAt ?? null, over.membership ?? world.ownerMembershipId]),
  world.userId, { mfa: true }));
  assert.match(await enable({ membership: '30000000-0000-4000-8000-000000000102' }), /not the membership of the session user/, 'enabled in the name of another membership');
  assert.match(await enable({ currency: 'USD' }), /priced in EUR/, 'a clearance floor in another currency than the offer');
  assert.match(await enable({ floor: 6000 }), /positive and not above the max price/, 'a clearance floor above the max price');
  assert.match(await enable({ endsAt: new Date(Date.now() - 60_000).toISOString() }), /not in the future/, 'a clearance that ends in the past');
  assert.match(await enable({ action: 'PAUSE' }), /clearance_change_action_known/, 'an unknown clearance action');
  // Окончание по дате — правда о дате: без наступившей даты его не записать и административной ролью
  assert.match(await outcome(inTenant(admin, world.tenantId, (tx) => tx.query(
    `INSERT INTO tenant_data.clearance_change (tenant_id, write_scope_id, action) VALUES ($1, $2, 'EXPIRE')`, [world.tenantId, ws]), world.userId)),
  /has not ended by its date/, 'an expiry before the date');
});

test('step 102 [Р-227]: clearance ends by its date — the database writes EXPIRE, asks for a re-evaluation and audits it; the owner gets a letter', async () => {
  const ws = world.ids.dbId('ws-4');
  const endsAt = new Date(Date.now() + 1500).toISOString();
  assert.equal((await store.enableClearance(world.tenantId, { writeScopeId: ws, floorMinor: 900, currency: 'EUR', endsAt, note: 'Weekend sale', acknowledged: true }, actor(world, true))).status, 'ENABLED');
  assert.equal(await floorOf(world, 'ws-4'), 900);
  await new Promise((r) => setTimeout(r, Date.parse(endsAt) - Date.now() + 300));
  // Дата наступила — пол уже расчётный, ещё до строки EXPIRE: режим — состояние журнала на часах базы
  assert.equal(await floorOf(world, 'ws-4'), 1800, 'after the end date the floor is the computed one');
  const raised: Array<{ code: string; details: Record<string, unknown> }> = [];
  const p = createPricingPipeline({ store, adapter, alerts: { raise: async (a: { code: string; details: Record<string, unknown> }) => { raised.push(a); } }, logger: { log: () => undefined }, now: () => now() as never });
  await p.recomputeScheduled(ctxOf(world, ACCOUNT));
  const history = (await store.clearanceOf(world.tenantId, ws)).history.map((h) => h.action);
  assert.equal(history[0], 'EXPIRE', 'the database wrote the expiry');
  const letter = raised.find((a) => a.code === 'CLEARANCE_ENDED');
  assert.equal(JSON.stringify(letter ? [letter.details.writeScopeId, letter.details.clearanceFloorMinor, letter.details.currency] : null), JSON.stringify([ws, 900, 'EUR']),
    'the owner is told that clearance ended');
  const { rows: [audit] } = await inTenant(admin, world.tenantId, (tx) => tx.query(
    `SELECT count(*)::int AS n FROM audit.audit_event WHERE tenant_id = $1 AND action = 'pricing.clearance_expired' AND entity_id = $2`, [world.tenantId, ws]));
  assert.equal(audit.n, 1, 'the expiry is a system event in the audit log');
  // Второй заход ничего не пишет: режим уже закончен
  assert.equal(JSON.stringify(await store.expireClearances(world.tenantId, world.ids.dbId(ACCOUNT))), '[]', 'an expiry is written once');
});
