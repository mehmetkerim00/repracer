import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { MemorySeedScope } from '@repracer/pricing-pipeline';
import { decide, NO_GUARDRAILS } from '@repracer/price-gate';
import type { CostInputs } from '@repracer/pricing-model';
import { inTenant, PgPricingStore, seedPricingWorld, type PgPool, type SeededPricingWorld } from '../src/index.ts';
import { createIsolatedDatabase, type IsolatedDatabase } from './isolated-db.ts';

/**
 * Шаг 103 [Р-228] на PostgreSQL, красное сначала (задание E):
 *  (1) новичок из канала получает стратегию умолчания аккаунта — последнюю активную версию, закреплённую за ним, — и строку журнала
 *      «по умолчанию аккаунта X»; ЛЮБОЕ автоназначение прослеживается до живого человека, задавшего умолчание (решение владельца);
 *  (2) новичок со стратегией цен не шлёт: умолчание назначает, но не включает; без себестоимости и границ движок не включается (Р-131,
 *      Р-43), а Gate без границ отказывает;
 *  (3) смена и снятие умолчания действуют только на будущих новичков, существующие предложения не трогаются;
 *  (4) стратегия, которой канал не даёт данных, умолчанием не выбирается — отказывает база с причиной [Р-39];
 *  (5) «None» — поведение до шага: новичок без стратегии и без строк журнала.
 * Плюс честные «не назначено»: предложение с ценообразованием канала [Р-120] и листинги eBay, в которые писать нельзя (аукцион, не
 * мигрирован). Данные синтетические
 */

const KAUFLAND = '20000000-0000-4000-8000-000000000103';
const AMAZON = '20000000-0000-4000-8000-000000000113';
const EBAY = '20000000-0000-4000-8000-000000000123';
const AMAZON_DE = 'A1PA6795UKMFR9';
const now = () => new Date().toISOString();
const COST: CostInputs = { currency: 'EUR', costProfileId: 'cp-103', unitCostMinor: 1100, fixedFeeMinor: 0, feeRateBp: 1500, tax: { regime: 'VAT_INCLUDED', vatRateBp: 1900 } };
const FIXED = { strategyId: 'st-fixed', version: 1, params: { type: 'FIXED', priceMinor: 2400 }, deadbandMinor: 0 } as const;
const BEAT = { strategyId: 'st-beat', version: 1, params: { type: 'BEAT_LOWEST', undercutMinor: 1, scope: 'VISIBLE_TOP_N', compareLanded: false, atBound: 'CAP' }, deadbandMinor: 0 } as const;

function scope(n: number, strategy: MemorySeedScope['strategy'], account: string, marketplace: string): MemorySeedScope {
  return {
    writeScopeId: `ws-${n}`, productId: `prod-${n}`, channelAccountId: account, marketplace, externalUnitId: String(10300 + n),
    channelProductRef: `10301${n}`, condition: 'new', currency: 'EUR', basis: 'GROSS', pricingMode: 'ENGINE', strategy, cost: COST,
    currentPriceMinor: 2400, minPrice: { amountMinor: 1800, id: `min-${n}` }, maxPrice: { amountMinor: 5000, id: `max-${n}` },
  };
}

let db: IsolatedDatabase;
let pool: PgPool;
let admin: PgPool;
let kaufland: SeededPricingWorld;
let amazon: SeededPricingWorld;
let ebay: SeededPricingWorld;
let store: PgPricingStore;

before(async () => {
  db = await createIsolatedDatabase('step103');
  pool = db.pool('svc_app');
  admin = db.pool('svc_admin', 2);
  const provisioningPool = db.pool('svc_provisioning', 1);
  kaufland = await seedPricingWorld(pool, { provisioningPool, adminPool: admin, fixtureTenantId: '10000000-0000-4000-8000-000000000103',
    fixtureChannelAccountId: KAUFLAND, marketplaces: ['de'], clock: now(), seed: { scopes: [scope(1, FIXED, KAUFLAND, 'de'), scope(2, BEAT, KAUFLAND, 'de')] } });
  amazon = await seedPricingWorld(pool, { provisioningPool, adminPool: admin, fixtureTenantId: '10000000-0000-4000-8000-000000000113',
    fixtureChannelAccountId: AMAZON, fixtureChannel: 'AMAZON', fixtureRegion: 'EU', fixtureExternalAccountId: 'A1SYN103', marketplaces: [AMAZON_DE], clock: now(),
    seed: { scopes: [{ ...scope(3, FIXED, AMAZON, AMAZON_DE), externalUnitId: 'SYN-103-AMZ-3', channelProductRef: 'B000103003' }] } });
  ebay = await seedPricingWorld(pool, { provisioningPool, adminPool: admin, fixtureTenantId: '10000000-0000-4000-8000-000000000123',
    fixtureChannelAccountId: EBAY, fixtureChannel: 'EBAY', marketplaces: ['EBAY_DE'], clock: now(), seed: { scopes: [] }, writeMode: 'SHADOW' });
  store = new PgPricingStore(pool, { adminPool: admin });
});
after(async () => { await db?.drop(); });

const actor = (w: SeededPricingWorld) => ({ membershipId: w.ownerMembershipId, userId: w.userId, mfa: false });
const kauflandOffer = (sku: string, unit: string) => ({ marketplace: 'de', externalSku: sku, externalUnitId: unit, externalOfferId: null, channelProductRef: null,
  gtin: null, condition: 'new', fulfillment: 'MERCHANT' as const });
const scopeOf = async (w: SeededPricingWorld, sku: string) => (await inTenant(admin, w.tenantId, (tx) => tx.query(
  `SELECT s.write_scope_id, s.pricing_strategy_id, s.pricing_strategy_version, s.pricing_mode FROM tenant_data.write_scope s
     JOIN tenant_data.offer_mapping m ON m.tenant_id = s.tenant_id AND m.price_write_scope_id = s.write_scope_id
    WHERE s.tenant_id = $1 AND m.external_sku = $2 AND m.status <> 'ENDED'`, [w.tenantId, sku]), w.userId)).rows[0];
const journal = async (w: SeededPricingWorld) => (await inTenant(admin, w.tenantId, (tx) => tx.query(
  `SELECT a.write_scope_id, a.offer_mapping_id, a.outcome, a.source, a.reason, a.pricing_strategy_id, a.pricing_strategy_version, a.default_strategy_change_id
     FROM tenant_data.strategy_assignment a WHERE a.tenant_id = $1 ORDER BY a.seq`, [w.tenantId]), w.userId)).rows;
const outcome = async (p: Promise<unknown>) => { try { await p; return 'accepted'; } catch (e) { return (e as Error).message; } };

test('step 103 (E1) [Р-228]: a new offer gets the default strategy of its account — its latest active version, pinned — and a journal row traced to the person who set it', async () => {
  const fixed = kaufland.ids.dbId('st-fixed');
  // Вторая версия стратегии: новичок получает ПОСЛЕДНЮЮ активную, как импорт стратегий по имени
  const v2 = await store.saveStrategy(kaufland.tenantId, { strategyId: fixed, name: 'st-fixed', params: { type: 'FIXED', priceMinor: 2500 } as never, deadbandMinor: 0, assignTo: [] }, actor(kaufland));
  assert.equal(v2.status, 'SAVED');
  const set = await store.setDefaultStrategy(kaufland.tenantId, kaufland.ids.dbId(KAUFLAND), fixed, actor(kaufland));
  assert.equal(set.status, 'SET');
  const created = await store.recordDiscoveredOffers(kaufland.tenantId, kaufland.ids.dbId(KAUFLAND), [kauflandOffer('SYN-103-NEW-1', '31031'), kauflandOffer('SYN-103-NEW-2', '31032')]);
  assert.equal(created, 2);
  for (const sku of ['SYN-103-NEW-1', 'SYN-103-NEW-2']) {
    const s = await scopeOf(kaufland, sku);
    assert.equal(JSON.stringify([s.pricing_strategy_id, s.pricing_strategy_version, s.pricing_mode]), JSON.stringify([fixed, 2, 'OFF']), `${sku}: default strategy v2, engine off`);
  }
  const rows = (await journal(kaufland)).filter((r) => r.source === 'DEFAULT_RULE');
  assert.equal(JSON.stringify(rows.map((r) => [r.outcome, r.pricing_strategy_version, r.default_strategy_change_id === (set as { changeId: string }).changeId])),
    JSON.stringify([['ASSIGNED', 2, true], ['ASSIGNED', 2, true]]));
  // Одна строка на назначение: правило пишет свою ДО назначения, журнал ручных назначений её не повторяет
  const perScope = (await journal(kaufland)).filter((r) => rows.some((x) => x.write_scope_id === r.write_scope_id));
  assert.equal(perScope.length, 2, 'one journal row per automatic assignment');
  // Прослеживаемость: каждая строка «по умолчанию» → строка умолчания → членство → человек, задавший умолчание
  const traced = (await inTenant(admin, kaufland.tenantId, (tx) => tx.query(
    `SELECT u.user_id FROM tenant_data.strategy_assignment a
       JOIN tenant_data.default_strategy_change c ON c.tenant_id = a.tenant_id AND c.default_strategy_change_id = a.default_strategy_change_id
       JOIN tenant_data.membership mb ON mb.tenant_id = c.tenant_id AND mb.membership_id = c.created_by_membership_id
       JOIN platform.app_user u ON u.user_id = mb.user_id
      WHERE a.tenant_id = $1 AND a.source = 'DEFAULT_RULE'`, [kaufland.tenantId]), kaufland.userId)).rows;
  assert.equal(JSON.stringify(traced.map((r) => r.user_id)), JSON.stringify([kaufland.userId, kaufland.userId]), 'every automatic assignment leads to a living person');
  // Событие системы в аудите — у каждого автоназначения
  const audit = (await inTenant(admin, kaufland.tenantId, (tx) => tx.query(
    `SELECT count(*)::int AS n FROM audit.audit_event WHERE tenant_id = $1 AND actor_type = 'SYSTEM' AND action = 'pricing.strategy_assigned_by_default'`, [kaufland.tenantId]), kaufland.userId)).rows[0].n;
  assert.equal(audit, 2, 'each automatic assignment is a system event in the audit log');
});

test('step 103 (E2) [Р-228, Р-131, Р-43]: a new offer with a default strategy sends no price — the default assigns, it does not switch on; without cost or bounds the engine stays off and the Gate refuses', async () => {
  const s = await scopeOf(kaufland, 'SYN-103-NEW-1');
  const writes = (await inTenant(admin, kaufland.tenantId, (tx) => tx.query(
    `SELECT count(*)::int AS n FROM tenant_data.channel_write WHERE tenant_id = $1 AND write_scope_id = $2`, [kaufland.tenantId, s.write_scope_id]), kaufland.userId)).rows[0].n;
  assert.equal(JSON.stringify([s.pricing_mode, writes]), JSON.stringify(['OFF', 0]), 'no engine, no write');
  // Включение обычным путём без границ и себестоимости отказывает база
  assert.match(await outcome(store.setPricingMode(kaufland.tenantId, s.write_scope_id, 'ENGINE', kaufland.userId)), /no active min_price|declared unit cost/);
  // И Gate без границ цену не пропустит
  const gate = decide({ intent: { writeScopeId: s.write_scope_id, strategyId: 'st', strategyVersion: 2, trigger: { type: 'SCHEDULE' }, ruleCode: 'FIXED', intentClass: 'CHANGED',
    proposedMinor: 2500, currentMinor: null, referenceMinor: null, currency: 'EUR', basis: 'GROSS', reason: { code: 'FIXED_PRICE', params: {} }, explanation: [], inputs: {},
    createdAt: now(), expiresAt: new Date(Date.now() + 600_000).toISOString() } as never,
    scope: { writeScopeId: s.write_scope_id, currency: 'EUR', basis: 'GROSS', pricingMode: 'ENGINE', status: 'ACTIVE', channelHalt: null, priceStop: null } as never,
    bounds: { currency: 'EUR', basis: 'GROSS', min: { status: 'UNRESOLVABLE', cause: 'MISSING' }, max: { status: 'UNRESOLVABLE', cause: 'MISSING' } },
    guardrails: NO_GUARDRAILS, cost: null, changesInLastHour: 0, now: now() });
  assert.equal(JSON.stringify([gate.outcome, gate.rejectionReason]), JSON.stringify(['REJECTED', 'BOUND_UNRESOLVABLE']));
});

test('step 103 (E3) [Р-228]: changing or clearing the default acts on future new offers only — existing offers keep their strategy', async () => {
  const account = kaufland.ids.dbId(KAUFLAND);
  const beat = kaufland.ids.dbId('st-beat');
  const before1 = await scopeOf(kaufland, 'SYN-103-NEW-1');
  const seededStrategy = async () => (await inTenant(admin, kaufland.tenantId, (tx) => tx.query(
    'SELECT pricing_strategy_id FROM tenant_data.write_scope WHERE tenant_id = $1 AND write_scope_id = $2', [kaufland.tenantId, kaufland.ids.dbId('ws-1')]), kaufland.userId)).rows[0].pricing_strategy_id;
  const seeded = await seededStrategy();
  assert.equal((await store.setDefaultStrategy(kaufland.tenantId, account, beat, actor(kaufland))).status, 'SET');
  await store.recordDiscoveredOffers(kaufland.tenantId, account, [kauflandOffer('SYN-103-NEW-3', '31033')]);
  const after1 = await scopeOf(kaufland, 'SYN-103-NEW-1');
  assert.equal(JSON.stringify([after1.pricing_strategy_id, after1.pricing_strategy_version]), JSON.stringify([before1.pricing_strategy_id, before1.pricing_strategy_version]),
    'an offer assigned by the earlier default keeps it');
  assert.equal(await seededStrategy(), seeded, 'a seeded offer is not touched');
  assert.equal((await scopeOf(kaufland, 'SYN-103-NEW-3')).pricing_strategy_id, beat, 'the next new offer gets the new default');
  // Снятие умолчания: следующий новичок — без стратегии и без строки журнала
  assert.equal((await store.setDefaultStrategy(kaufland.tenantId, account, null, actor(kaufland))).status, 'SET');
  const rowsBefore = (await journal(kaufland)).length;
  await store.recordDiscoveredOffers(kaufland.tenantId, account, [kauflandOffer('SYN-103-NEW-4', '31034')]);
  assert.equal(JSON.stringify([(await scopeOf(kaufland, 'SYN-103-NEW-4')).pricing_strategy_id, (await journal(kaufland)).length]), JSON.stringify([null, rowsBefore]));
  assert.equal((await scopeOf(kaufland, 'SYN-103-NEW-3')).pricing_strategy_id, beat, 'clearing the default leaves assigned offers as they are');
});

test('step 103 (E4) [Р-228, Р-39]: a strategy the channel gives no data for cannot become the default — the database refuses with the reason', async () => {
  const win = await store.saveStrategy(amazon.tenantId, { strategyId: null, name: 'Win the Buy Box', deadbandMinor: 0, assignTo: [],
    params: { type: 'WIN_BUYBOX', undercutMinor: 1, fulfillmentHandicapMinor: 0, creepUp: false, creepStepBp: 100, atBound: 'CAP' } as never }, actor(amazon));
  assert.equal(win.status, 'SAVED');
  const refused = await store.setDefaultStrategy(amazon.tenantId, amazon.ids.dbId(AMAZON), (win as { strategy: { strategyId: string } }).strategy.strategyId, actor(amazon));
  assert.equal(JSON.stringify([refused.status, (refused as { cause?: string }).cause]), JSON.stringify(['INVALID', 'STRATEGY_UNAVAILABLE']), 'refused: the channel gives no data for the strategy');
  assert.match(JSON.stringify((refused as { unmet?: unknown }).unmet), /BUYBOX_WINNER/, 'the reason names what the channel does not give');
  assert.equal((await store.defaultStrategies(amazon.tenantId)).find((d) => d.channelAccountId === amazon.ids.dbId(AMAZON))?.strategyId ?? null, null, 'nothing was saved');
});

test('step 103 (E5) [Р-228]: «None» is the behaviour before the step — a new offer stays without a strategy and without journal rows', async () => {
  // Аккаунт Amazon умолчания не задавал никогда
  await store.recordDiscoveredOffers(amazon.tenantId, amazon.ids.dbId(AMAZON), [{ marketplace: AMAZON_DE, externalSku: 'SYN-103-AMZ-NEW', externalUnitId: null,
    externalOfferId: null, channelProductRef: 'B0SYN103', gtin: null, condition: 'new', fulfillment: 'MERCHANT' }]);
  const s = await scopeOf(amazon, 'SYN-103-AMZ-NEW');
  assert.equal(JSON.stringify([s.pricing_strategy_id, s.pricing_mode]), JSON.stringify([null, 'OFF']));
  assert.equal((await journal(amazon)).filter((r) => r.source === 'DEFAULT_RULE').length, 0);
});

test('step 103 [Р-228, Р-120]: an offer the channel prices itself is not assigned — an honest «not assigned» row with the reason', async () => {
  const account = amazon.ids.dbId(AMAZON);
  const fixed = amazon.ids.dbId('st-fixed');
  assert.equal((await store.setDefaultStrategy(amazon.tenantId, account, fixed, actor(amazon))).status, 'SET');
  await store.recordOfferChannelPricing(amazon.tenantId, account, [{ marketplace: AMAZON_DE, externalSku: 'SYN-103-AMZ-AUTO', automatedPricing: true, channelBounds: false,
    source: 'DISCOVERY', observedAt: now() as never }]);
  await store.recordDiscoveredOffers(amazon.tenantId, account, [
    { marketplace: AMAZON_DE, externalSku: 'SYN-103-AMZ-AUTO', externalUnitId: null, externalOfferId: null, channelProductRef: 'B0SYN1031', gtin: null, condition: 'new', fulfillment: 'MERCHANT' },
    { marketplace: AMAZON_DE, externalSku: 'SYN-103-AMZ-FREE', externalUnitId: null, externalOfferId: null, channelProductRef: 'B0SYN1032', gtin: null, condition: 'new', fulfillment: 'MERCHANT' },
  ]);
  assert.equal((await scopeOf(amazon, 'SYN-103-AMZ-AUTO')).pricing_strategy_id, null, 'the channel prices this offer');
  assert.equal((await scopeOf(amazon, 'SYN-103-AMZ-FREE')).pricing_strategy_id, fixed);
  const rows = (await journal(amazon)).filter((r) => r.source === 'DEFAULT_RULE');
  assert.equal(JSON.stringify(rows.map((r) => [r.outcome, r.reason])), JSON.stringify([['NOT_ASSIGNED', 'CHANNEL_PRICING'], ['ASSIGNED', null]]));
});

test('step 103 [Р-228, Р-164]: eBay listings we may not write to — an auction and a listing not migrated — are honestly «not assigned»; a migrated one gets the default', async () => {
  const account = ebay.ids.dbId(EBAY);
  const saved = await store.saveStrategy(ebay.tenantId, { strategyId: null, name: 'Fixed 24', deadbandMinor: 0, assignTo: [], params: { type: 'FIXED', priceMinor: 2400 } as never }, actor(ebay));
  assert.equal(saved.status, 'SAVED');
  const strategyId = (saved as { strategy: { strategyId: string } }).strategy.strategyId;
  assert.equal((await store.setDefaultStrategy(ebay.tenantId, account, strategyId, actor(ebay))).status, 'SET');
  const listing = (sku: string | null, id: string, format: 'FIXED_PRICE' | 'AUCTION', writable: boolean) => ({ marketplace: 'EBAY_DE', externalSku: sku, externalUnitId: null,
    externalOfferId: null, channelProductRef: null, gtin: null, condition: 'new', fulfillment: 'MERCHANT' as const, externalListingId: id, listingFormat: format, writable });
  await store.recordDiscoveredOffers(ebay.tenantId, account, [listing('SYN-103-EB-OK', '110000103001', 'FIXED_PRICE', true),
    listing('SYN-103-EB-OLD', '110000103002', 'FIXED_PRICE', false), listing(null, '110000103003', 'AUCTION', false)]);
  assert.equal((await scopeOf(ebay, 'SYN-103-EB-OK')).pricing_strategy_id, strategyId);
  const rows = (await journal(ebay)).filter((r) => r.source === 'DEFAULT_RULE');
  assert.equal(JSON.stringify(rows.map((r) => [r.outcome, r.reason, r.write_scope_id === null, r.offer_mapping_id !== null]).sort()),
    JSON.stringify([['ASSIGNED', null, false, true], ['NOT_ASSIGNED', 'NOT_WRITABLE', true, true], ['NOT_ASSIGNED', 'NOT_WRITABLE', true, true]].sort()), 'not assigned: listings we may not write to');
});

test('step 103 [Р-228]: the default and the assignments are readable for the screens — the current default with its author and the counts', async () => {
  const d = (await store.defaultStrategies(amazon.tenantId)).find((x) => x.channelAccountId === amazon.ids.dbId(AMAZON))!;
  assert.equal(JSON.stringify([d.strategyId, d.setByMembershipId, d.assigned, d.notAssigned]),
    JSON.stringify([amazon.ids.dbId('st-fixed'), amazon.ownerMembershipId, 1, [{ reason: 'CHANNEL_PRICING', count: 1 }]]));
  // Источник стратегии на экранах — только у единиц, о которых решало правило: у новичка — строка правила с человеком, у единицы посева
  // (строка человека, правило о ней не решало) — нет; полное состояние консоли журнал по всему каталогу не читает
  const state = await store.readConsoleState(kaufland.tenantId, now() as never);
  const ref = (id: string) => state.scopes.find((x) => x.writeScopeId === id)?.assignment ?? null;
  const fresh = ref((await scopeOf(kaufland, 'SYN-103-NEW-1')).write_scope_id);
  assert.equal(JSON.stringify([fresh?.source, fresh?.outcome, fresh?.rule?.setByMembershipId, ref(kaufland.ids.dbId('ws-2'))]),
    JSON.stringify(['DEFAULT_RULE', 'ASSIGNED', kaufland.ownerMembershipId, null]), 'the source of a strategy — only where the default rule decided');
});

/** Строка журнала назначений от узкой роли правила — как её писала бы функция правила (проверки стража журнала) */
const asRule = (tenantId: string, sql: string) => outcome(db.superuser(
  `DO $do$ BEGIN PERFORM set_config('app.tenant_id', '${tenantId}', true); SET LOCAL ROLE repracer_default_strategy; ${sql}; END $do$`));

test('step 103 [Р-228]: the default is the rule of a person — set in the name of another member, for a disconnected account or with no active version, it is refused', async () => {
  const account = kaufland.ids.dbId(KAUFLAND);
  const fixed = kaufland.ids.dbId('st-fixed');
  const other = (await inTenant(admin, kaufland.tenantId, (tx) => tx.query(
    `SELECT membership_id FROM tenant_data.membership WHERE tenant_id = $1 AND membership_id <> $2 AND status = 'ACTIVE' LIMIT 1`, [kaufland.tenantId, kaufland.ownerMembershipId]), kaufland.userId)).rows[0].membership_id;
  assert.match(await outcome(inTenant(admin, kaufland.tenantId, (tx) => tx.query(
    `INSERT INTO tenant_data.default_strategy_change (tenant_id, channel_account_id, pricing_strategy_id, created_by_membership_id) VALUES ($1, $2, $3, $4)`,
    [kaufland.tenantId, account, fixed, other]), kaufland.userId)), /is not the membership of the session user/, 'set in the name of another member');
  // Отключённый аккаунт новичков не получает — умолчание ему не задаётся
  const off = '20000000-0000-4000-8000-0000000001f3';
  await db.superuser(`INSERT INTO tenant_data.channel_account (tenant_id, channel_account_id, channel, external_account_id, marketplaces, credentials_ref, connected_by_membership_id, write_mode, auth_status, disconnected_at)
    VALUES ($1, $2, 'KAUFLAND', 'seller-103-off', ARRAY['de'], NULL, $3, 'SHADOW', 'DISCONNECTED', now())`, [kaufland.tenantId, off, kaufland.ownerMembershipId]);
  assert.equal(JSON.stringify(await store.setDefaultStrategy(kaufland.tenantId, off, fixed, actor(kaufland))), JSON.stringify({ status: 'INVALID', cause: 'ACCOUNT_DISCONNECTED' }),
    'a disconnected account');
  // Стратегия только с черновиком: умолчанием выбирается только активная версия (OQ-169)
  const draft = '30000000-0000-4000-8000-0000000001d3';
  await db.superuser(`INSERT INTO tenant_data.pricing_strategy (tenant_id, pricing_strategy_id, version, name, type, params, triggers, status, created_by_membership_id)
    VALUES ($1, $2, 1, 'Draft only', 'FIXED', '{"priceMinor": 2400}', ARRAY['SCHEDULE'], 'DRAFT', $3)`, [kaufland.tenantId, draft, kaufland.ownerMembershipId]);
  assert.equal(JSON.stringify(await store.setDefaultStrategy(kaufland.tenantId, account, draft, actor(kaufland))), JSON.stringify({ status: 'INVALID', cause: 'VERSION_NOT_ACTIVE' }),
    'a strategy without an active version');
});

test('step 103 [Р-228]: a «default rule» row is only what the current rule entails — the current default, its latest active version, a new offer of the account; the shape is one constraint', async () => {
  const account = kaufland.ids.dbId(KAUFLAND);
  const fixed = kaufland.ids.dbId('st-fixed');
  const oldRule = (await inTenant(admin, kaufland.tenantId, (tx) => tx.query(
    `SELECT default_strategy_change_id FROM tenant_data.default_strategy_change WHERE tenant_id = $1 AND channel_account_id = $2 ORDER BY seq LIMIT 1`, [kaufland.tenantId, account]), kaufland.userId)).rows[0].default_strategy_change_id;
  const current = await store.setDefaultStrategy(kaufland.tenantId, account, fixed, actor(kaufland));
  assert.equal(current.status, 'SET');
  const rule = (current as { changeId: string }).changeId;
  const scope = kaufland.ids.dbId('ws-1');
  const mapping = (await inTenant(admin, kaufland.tenantId, (tx) => tx.query(
    `SELECT offer_mapping_id FROM tenant_data.offer_mapping WHERE tenant_id = $1 AND price_write_scope_id = $2 LIMIT 1`, [kaufland.tenantId, scope]), kaufland.userId)).rows[0].offer_mapping_id;
  const row = (rule: string, version: number) => `INSERT INTO tenant_data.strategy_assignment (tenant_id, channel_account_id, write_scope_id, pricing_strategy_id, pricing_strategy_version, outcome, source, default_strategy_change_id)
    VALUES ('${kaufland.tenantId}', '${account}', '${scope}', '${fixed}', ${version}, 'ASSIGNED', 'DEFAULT_RULE', '${rule}')`;
  assert.match(await asRule(kaufland.tenantId, row(oldRule, 2)), /is not the current default strategy of channel account/, 'a rule that is no longer current');
  assert.match(await asRule(kaufland.tenantId, row(rule, 1)), /does not follow default rule/, 'not the latest active version');
  assert.match(await asRule(kaufland.tenantId, row(rule, 2)), /is not a new offer of channel account/, 'an existing offer');
  assert.match(await asRule(kaufland.tenantId, `INSERT INTO tenant_data.strategy_assignment (tenant_id, channel_account_id, offer_mapping_id, outcome, source, reason, default_strategy_change_id)
    VALUES ('${kaufland.tenantId}', '${account}', '${mapping}', 'NOT_ASSIGNED', 'DEFAULT_RULE', 'NOT_WRITABLE', '${rule}')`), /offer \S+ is not a new offer of channel account/, 'an existing listing');
  assert.match(await asRule(kaufland.tenantId, `INSERT INTO tenant_data.strategy_assignment (tenant_id, channel_account_id, write_scope_id, outcome, source, reason)
    VALUES ('${kaufland.tenantId}', '${account}', '${scope}', 'NOT_ASSIGNED', 'PERSON', 'CHANNEL_PRICING')`), /strategy_assignment_shape/, 'a «not assigned» row of a person');
  // «None» — не правило: строк «по умолчанию» по нему не бывает
  const none = await store.setDefaultStrategy(kaufland.tenantId, account, null, actor(kaufland));
  assert.equal(none.status, 'SET');
  assert.match(await asRule(kaufland.tenantId, row((none as { changeId: string }).changeId, 2)), /is not the current default strategy of channel account/, 'a «None» rule');
});

test('step 103 [Р-228]: every manual assignment and removal is a journal row of the person — the source of the strategy of an offer', async () => {
  const fixed = kaufland.ids.dbId('st-fixed');
  const s = await scopeOf(kaufland, 'SYN-103-NEW-4');
  assert.equal((await store.assignStrategyVersion(kaufland.tenantId, { strategyId: fixed, version: 2, assignTo: [s.write_scope_id] }, actor(kaufland))).status, 'SAVED');
  assert.equal((await store.unassignStrategy(kaufland.tenantId, { writeScopeIds: [s.write_scope_id] }, actor(kaufland))).status, 'UNASSIGNED');
  const rows = (await journal(kaufland)).filter((r) => r.write_scope_id === s.write_scope_id);
  assert.equal(JSON.stringify(rows.map((r) => [r.outcome, r.source, r.pricing_strategy_version])), JSON.stringify([['ASSIGNED', 'PERSON', 2], ['UNASSIGNED', 'PERSON', null]]), 'manual assign and removal — rows of the person');
});

test('step 103 [Р-228, Р-39]: the latest version of the default became unavailable on the channel — the new offer is honestly «not assigned»', async () => {
  const account = amazon.ids.dbId(AMAZON);
  const beat = await store.saveStrategy(amazon.tenantId, { strategyId: null, name: 'Beat the lowest', deadbandMinor: 0, assignTo: [],
    params: { type: 'BEAT_LOWEST', undercutMinor: 1, scope: 'VISIBLE_TOP_N', compareLanded: false, atBound: 'CAP', anchor: 'LOWEST' } as never }, actor(amazon));
  assert.equal(beat.status, 'SAVED');
  const strategyId = (beat as { strategy: { strategyId: string } }).strategy.strategyId;
  assert.equal((await store.setDefaultStrategy(amazon.tenantId, account, strategyId, actor(amazon))).status, 'SET');
  // Вторая версия — «Buy Box, только FBA»: на Amazon держатель Buy Box не назван (A-29) — канал этой версии данных не даёт
  const v2 = await store.saveStrategy(amazon.tenantId, { strategyId, name: 'Beat the lowest', deadbandMinor: 0, assignTo: [],
    params: { type: 'BEAT_LOWEST', undercutMinor: 1, scope: 'VISIBLE_TOP_N', compareLanded: false, atBound: 'CAP', anchor: 'BUYBOX', competeWith: 'CHANNEL' } as never }, actor(amazon));
  assert.equal(v2.status, 'SAVED');
  await store.recordDiscoveredOffers(amazon.tenantId, account, [{ marketplace: AMAZON_DE, externalSku: 'SYN-103-AMZ-V2', externalUnitId: null, externalOfferId: null,
    channelProductRef: 'B0SYN1033', gtin: null, condition: 'new', fulfillment: 'MERCHANT' }]);
  const s = await scopeOf(amazon, 'SYN-103-AMZ-V2');
  const row = (await journal(amazon)).filter((r) => r.write_scope_id === s.write_scope_id);
  assert.equal(JSON.stringify([s.pricing_strategy_id, row.map((r) => [r.outcome, r.reason])]), JSON.stringify([null, [['NOT_ASSIGNED', 'STRATEGY_UNAVAILABLE']]]));
});
