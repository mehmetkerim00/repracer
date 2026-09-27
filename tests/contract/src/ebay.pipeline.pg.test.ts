import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { InMemoryPricingStore, standUserOf, type MemorySeedScope } from '@repracer/pricing-pipeline';
import { inTenant, seedPricingWorld, type PgPool } from '@repracer/pricing-store-pg';
import { createIsolatedDatabase, type IsolatedDatabase } from '../../../packages/pricing-store-pg/test/isolated-db.ts';
import { ebayUnderTest } from './adapters.ts';
import { EBAY_FIXTURES_DIR } from './ebay-fixtures/index.ts';
import { pids } from './ebay-fixtures/pipeline.ts';
import { pgStoreFactory } from './harness/pg-store.ts';
import { runScenario } from './harness/runner.ts';
import { loadScenarios, type Scenario } from './harness/scenario.ts';

/**
 * Шаг 47: путь решения eBay на настоящей PostgreSQL — те же сценарии pipeline-*, что на памяти (ebay.contract.test.ts), и то, что может
 * проверить только база: единица записи цены у немигрированного листинга (0005, Р-2), первый слой бюджета правок edit_budget [Р-19, Р-163],
 * теневой режим аккаунта eBay [Р-169] и недоступность стратегии по данным конкурентов на канале без них [Р-39].
 *
 * База — отдельная (копия шаблона): граница суток EBAY_DE — данные платформы, которые подтверждает стенд. Режим обработки PRICE в
 * шаблоне — ASYNC: адаптер eBay не сообщает «применено сразу» (подтверждение — Browse), и при SYNC запись осталась бы ACCEPTED без
 * сверки навсегда. Данные синтетические.
 */

let db: IsolatedDatabase;
let pools: { app: PgPool; scan: PgPool; fx: PgPool; admin: PgPool; provisioning: PgPool };

/**
 * Строки возможностей eBay (PRICE и QUANTITY, ASYNC, бюджет по листингу) — в шаблоне (packages/pricing-store-pg/test/setup.sql),
 * строка channel_behaviour — в миграции 0140. Граница суток EBAY_DE в миграциях — TO_VERIFY (Р-65): стенд подтверждает её в своей
 * базе, как tests/db/smoke_setup.sql, иначе база отказывает любой записи с бюджетом правок.
 */
const EBAY_PLATFORM_ROWS = `
SET ROLE repracer_owner;
UPDATE platform.marketplace SET time_zone_status = 'CONFIRMED' WHERE channel = 'EBAY' AND marketplace = 'EBAY_DE';
RESET ROLE;`;

before(async () => {
  db = await createIsolatedDatabase('ebaypipeline');
  await db.superuser(EBAY_PLATFORM_ROWS);
  pools = {
    app: db.pool('svc_app', 4), scan: db.pool('svc_dispatcher', 2), fx: db.pool('svc_fx_loader', 1),
    admin: db.pool('svc_admin', 2), provisioning: db.pool('svc_provisioning', 1),
  };
});
after(async () => { await db?.drop(); });

const factory = (writeMode?: 'SHADOW' | 'LIVE') => pgStoreFactory(pools.app, pools.scan, pools.fx, {
  adminPool: pools.admin, provisioningPool: pools.provisioning, ...(writeMode ? { writeMode } : {}),
});

async function run(scenario: Scenario, writeMode?: 'SHADOW' | 'LIVE') {
  const report = await runScenario(scenario, ebayUnderTest, undefined, factory(writeMode));
  const trace = report.trace.map((t) => `  ${t.method} ${t.path} → ${t.exchangeId ?? '-'} ${t.outcome}`).join('\n');
  assert.deepEqual(report.failures, [], `${report.failures.join('\n')}\ntrace:\n${trace}`);
  return report;
}

const loaded = loadScenarios(fileURLToPath(EBAY_FIXTURES_DIR)).filter(({ scenario }) => scenario.world.pricing && !scenario.tags.includes('memory-only'));

test('every eBay pipeline scenario of the memory stand also runs here', () => {
  assert.ok(loaded.length >= 10, `${loaded.length} eBay pipeline scenarios`);
});

for (const { file, scenario } of loaded) {
  test(`[pg ebay] ${scenario.id} [${file}]`, async () => { await run(scenario); });
}

// ------------------------------------------------------------------------------------------------ то, что проверяет только база

const ACCOUNT = '20000000-0000-4000-8000-000000000001';
const scopeOf = (n: number, extra: Partial<MemorySeedScope> = {}): MemorySeedScope => ({
  writeScopeId: `ws-ebay-db-${n}`, productId: `prod-ebay-db-${n}`, channelAccountId: ACCOUNT, marketplace: 'EBAY_DE',
  externalUnitId: pids(n).sku, externalOfferId: pids(n).offerId, externalListingId: pids(n).listingId, channelProductRef: pids(n).listingId,
  condition: 'new', currency: 'EUR', basis: 'GROSS', pricingMode: 'ENGINE',
  strategy: { strategyId: `st-db-${n}`, version: 1, params: { type: 'FIXED', priceMinor: 1299 }, deadbandMinor: 0 },
  currentPriceMinor: 1149, minPrice: { amountMinor: 1000, id: `min-db-${n}` }, maxPrice: { amountMinor: 5000, id: `max-db-${n}` },
  cost: { currency: 'EUR', costProfileId: `cp-db-${n}`, unitCostMinor: 500, fixedFeeMinor: 0, feeRateBp: 1100, tax: { regime: 'VAT_INCLUDED', vatRateBp: 1900 } },
  ...extra,
});

async function seedWorld(n: number, scopes: MemorySeedScope[]) {
  return seedPricingWorld(pools.app, {
    provisioningPool: pools.provisioning, adminPool: pools.admin, fixtureTenantId: `10000000-0000-4000-8000-0000000047${String(n).padStart(2, '0')}`,
    fixtureChannelAccountId: ACCOUNT, fixtureChannel: 'EBAY', marketplaces: ['EBAY_DE'], clock: new Date().toISOString(), seed: { scopes },
  });
}

/** Сценарий пути решения, собранный из фикстуры с другим миром (тень, бюджет в базе) */
function variantOf(id: string, change: (s: Scenario) => Scenario): Scenario {
  const base = loaded.find((l) => l.scenario.id === id)!.scenario;
  return change(structuredClone(base));
}

test('Р-2, Р-164: the database refuses a PRICE write scope on an eBay listing that is not under Inventory API (offer_mapping_check5)', async () => {
  const w = await seedWorld(1, [scopeOf(40)]);
  const scopeId = w.ids.dbId('ws-ebay-db-40');
  const productId = w.ids.dbId('prod-ebay-db-40');
  const insert = (status: string, withScope: boolean) => inTenant(pools.admin, w.tenantId, (tx) => tx.query(
    `INSERT INTO tenant_data.offer_mapping (tenant_id, product_id, channel_account_id, channel, marketplace, channel_offer_key, external_sku, external_listing_id,
                                            ebay_listing_format, ebay_migration_status, condition, status, price_write_scope_id)
     VALUES ($1, $2, $3, 'EBAY', 'EBAY_DE', $4, $7, $8, 'FIXED_PRICE', $5, 'NEW', 'MIGRATION_REQUIRED', $6)`,
    // Те же SKU и листинг, что у единицы записи: ключ единицы и ключ бюджета совпадают, и отказ может быть только о миграции
    [w.tenantId, productId, w.channelAccountId, `offer:legacy-${status}-${withScope}`, status, withScope ? scopeId : null, pids(40).sku, pids(40).listingId]),
    // Р-97: административная запись — только от пользователя сессии (владелец мира)
    w.userId, { mfa: true });
  await assert.rejects(insert('REQUIRED', true), (e: { code?: string; constraint?: string; message?: string }) => {
    assert.equal(e.code, '23514', e.message);
    assert.equal(e.constraint, 'offer_mapping_check5', 'Р-2: writes only to listings under Inventory API');
    return true;
  });
  // Положительный контроль: тот же немигрированный листинг без единицы записи база принимает — отказ был именно из-за цены
  await insert('REQUIRED', false);
});

test('Р-19, Р-163: the first layer — edit_budget in the database — ends the write BUDGET_EXHAUSTED when the listing has used its 190 price attempts', async () => {
  // Бюджет листинга исчерпан ДРУГИМ процессом (второй слой адаптера пуст): эта проверка — у базы, по часам витрины EBAY_DE
  const scenario = variantOf('ebay/pipeline/fixed-price-confirmed', (s) => ({
    ...s, id: 'ebay/pipeline/db-edit-budget-exhausted', exchanges: [],
    steps: [{ id: 'fixed-price-budget-used', kind: 'pipelineRecompute', writeScopeId: 'ws-ebay-price-1', trigger: { type: 'COST_CHANGE' },
      expect: { decision: { outcome: 'APPROVED', finalMinor: 1299 } } }],
    expect: { pipeline: { writes: [{ amountMinor: 1299, status: 'BUDGET_EXHAUSTED', endReason: 'WRITE_EDIT_BUDGET_EXHAUSTED' }] },
      alerts: [{ code: 'PRICE_WRITE_NOT_SENT', count: 1, details: { status: 'BUDGET_EXHAUSTED' } }] },
  }));
  const inner = factory();
  const report = await runScenario(scenario, ebayUnderTest, undefined, async (seed, world) => {
    const store = await inner(seed, world);
    const tenantId = store.identity!.tenantId;
    // Строку бюджета ведёт только триггер записи (edit_budget_only_from_trigger): суперпользователь стенда кладёт её мимо триггеров
    assert.match(tenantId, /^[0-9a-f-]{36}$/);
    await db.superuser(`SET session_replication_role = replica;
      INSERT INTO tenant_data.edit_budget (tenant_id, channel_account_id, budget_scope_key, budget_day, edit_limit, quantity_reserve, unaccounted_margin, attempts_price)
      SELECT a.tenant_id, a.channel_account_id, '${pids(1).listingId}', (now() AT TIME ZONE 'Europe/Berlin')::date, 250, 50, 10, 190
        FROM tenant_data.channel_account a WHERE a.tenant_id = '${tenantId}';
      SET session_replication_role = origin;`);
    return store;
  });
  assert.deepEqual(report.failures, [], report.failures.join('\n'));
  assert.equal(report.trace.length, 0, 'the refused attempt never reached eBay');
});

test('Р-169: an eBay account in the shadow computes the price and holds the write — nothing reaches eBay', async () => {
  const scenario = variantOf('ebay/pipeline/fixed-price-confirmed', (s) => ({
    ...s, id: 'ebay/pipeline/shadow-held', exchanges: [],
    steps: [{ id: 'fixed-price-in-shadow', kind: 'pipelineRecompute', writeScopeId: 'ws-ebay-price-1', trigger: { type: 'COST_CHANGE' },
      expect: { decision: { outcome: 'APPROVED', finalMinor: 1299 } } }],
    expect: { noAlerts: true, pipeline: { decisions: [{ outcome: 'APPROVED', finalMinor: 1299 }] } },
  }));
  const report = await run(scenario, 'SHADOW');
  assert.equal(report.trace.length, 0, 'no request to eBay from the shadow');
  const [held] = await db.rows<{ n: number }>(`SELECT count(*)::int AS n FROM tenant_data.channel_write_history WHERE final_status = 'SHADOW_HELD'`);
  assert.equal(held!.n, 1, 'the write is born finished: SHADOW_HELD');
});

test('Р-39: a strategy that needs competitor data is refused on eBay by the database and by the memory stand; fixed and margin strategies are accepted', async () => {
  const buybox = { type: 'MATCH_BUYBOX' as const, undercutMinor: 5, holdWhenWinning: true, atBound: 'CAP' as const };
  await assert.rejects(seedWorld(2, [scopeOf(42, { strategy: { strategyId: 'st-db-buybox', version: 1, params: buybox, deadbandMinor: 0 } })]),
    (e: Error) => { assert.match(e.message, /is not available on channel EBAY/); return true; });
  const w = await seedWorld(3, [scopeOf(43, { strategy: { strategyId: 'st-db-margin', version: 1, params: { type: 'TARGET_MARGIN', targetMarginBp: 1500 }, deadbandMinor: 0 } })]);
  assert.ok(w.tenantId, 'a margin strategy is available on a channel without competitor data');
  const memory = new InMemoryPricingStore({ scopes: [scopeOf(44, { pricingMode: 'OFF', strategy: null })], channel: 'EBAY', competitorSources: [] });
  const actor = { membershipId: 'membership-owner', userId: standUserOf('membership-owner'), mfa: true };
  assert.deepEqual(await memory.saveStrategy('t', { strategyId: null, name: 'Buy Box', params: buybox, deadbandMinor: 0, assignTo: ['ws-ebay-db-44'] }, actor),
    { status: 'INVALID', cause: 'STRATEGY_UNAVAILABLE', writeScopeId: 'ws-ebay-db-44' });
  assert.equal((await memory.saveStrategy('t', { strategyId: null, name: 'Fixed', params: { type: 'FIXED', priceMinor: 1299 }, deadbandMinor: 0, assignTo: ['ws-ebay-db-44'] }, actor)).status, 'SAVED');
});

test('Р-164, 0140: discovery through the pricing path puts every eBay listing into the catalog with its own right to be written', async () => {
  const scenario = loaded.find((l) => l.scenario.id === 'ebay/pipeline/discovery-catalog')!.scenario;
  let tenantId = '';
  const report = await runScenario(scenario, ebayUnderTest, undefined, factory(), { async onFinish(f) { tenantId = f.store!.identity!.tenantId; } });
  assert.deepEqual(report.failures, [], report.failures.join('\n'));
  const rows = await db.rows<{ listing: string; status: string; migration: string; format: string; scope: string | null }>(
    `SELECT m.external_listing_id AS listing, m.status, m.ebay_migration_status AS migration, m.ebay_listing_format AS format, s.pricing_mode AS scope
       FROM tenant_data.offer_mapping m LEFT JOIN tenant_data.write_scope s ON s.tenant_id = m.tenant_id AND s.write_scope_id = m.price_write_scope_id
      WHERE m.tenant_id = $1 ORDER BY m.external_listing_id`, [tenantId]);
  assert.deepEqual(rows, [
    { listing: pids(30).listingId, status: 'ACTIVE', migration: 'NOT_REQUIRED', format: 'FIXED_PRICE', scope: 'OFF' },
    { listing: pids(31).listingId, status: 'MIGRATION_REQUIRED', migration: 'REQUIRED', format: 'FIXED_PRICE', scope: null },
    { listing: pids(32).listingId, status: 'INELIGIBLE', migration: 'INELIGIBLE', format: 'AUCTION', scope: null },
  ], 'only the listing under Inventory API gets a price write scope; the legacy one waits for the owner, the auction is never managed');
});
