import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { AdapterCallContext, AdapterDependencies } from '@repracer/channel-port';
import { createPricingPipeline } from '@repracer/pricing-pipeline';
import { inTenant, PgPricingStore, seedPricingWorld, type PgPool, type SeededPricingWorld } from '@repracer/pricing-store-pg';
import { createIsolatedDatabase, type IsolatedDatabase } from '../../../packages/pricing-store-pg/test/isolated-db.ts';
import { AMAZON_DE, SimulatedAmazonPort } from './simulator/amazon-port.ts';

/**
 * Шаг 103 [Р-228], сценарий симулятора «на аккаунте появились 2 новых предложения»: модель порта Amazon получает два листинга, обход каталога
 * (настоящий путь `discoverOffers` → `record_discovered_offers`) заводит их — и правило умолчания аккаунта назначает им стратегию в той же
 * транзакции. Утверждается наблюдаемое: стратегия и версия у новичков, строки журнала «по правилу», режим цены выключен, ни одного запроса
 * записи у модели канала после пересчёта; существующее предложение не тронуто; листинг с правилом автоматического ценообразования
 * Amazon [Р-120] — честное «не назначено». Данные синтетические
 */

const ACCOUNT = '20000000-0000-4000-8000-0000000013a1';
const START = new Date().toISOString();

let db: IsolatedDatabase;
let pool: PgPool;
let admin: PgPool;
let world: SeededPricingWorld;
let store: PgPricingStore;

before(async () => {
  db = await createIsolatedDatabase('step103sim');
  pool = db.pool('svc_app');
  admin = db.pool('svc_admin', 2);
  world = await seedPricingWorld(pool, {
    provisioningPool: db.pool('svc_provisioning', 1), adminPool: admin, fixtureTenantId: '10000000-0000-4000-8000-0000000013a1', fixtureChannelAccountId: ACCOUNT,
    fixtureChannel: 'AMAZON', fixtureRegion: 'EU', fixtureExternalAccountId: 'A1SYN103SIM', marketplaces: [AMAZON_DE], clock: START,
    seed: {
      scopes: [{
        writeScopeId: 'ws-1', productId: 'p-1', channelAccountId: ACCOUNT, marketplace: AMAZON_DE, externalUnitId: 'SYN-103-SIM-1', channelProductRef: 'B000103001',
        condition: 'new', currency: 'EUR', basis: 'GROSS', pricingMode: 'OFF',
        strategy: { strategyId: 'st-fixed', version: 1, params: { type: 'FIXED', priceMinor: 2400 }, deadbandMinor: 0 },
        currentPriceMinor: 1850, minPrice: { amountMinor: 1500, id: 'min-1' }, maxPrice: { amountMinor: 3000, id: 'max-1' },
      }],
    },
  });
  store = new PgPricingStore(pool, { adminPool: admin });
});
after(async () => { await db?.drop(); });

test('step 103 [Р-228] simulator: 2 new offers appeared on the account — they get the default strategy, prices do not move, the old offer is untouched', async () => {
  const fixed = world.ids.dbId('st-fixed');
  const account = world.ids.dbId(ACCOUNT);
  const set = await store.setDefaultStrategy(world.tenantId, account, fixed, { membershipId: world.ownerMembershipId, userId: world.userId, mfa: false });
  assert.equal(set.status, 'SET');
  const deps: AdapterDependencies = {
    accounts: { async verify(tenantId, channelAccountId) {
      return { ok: true, account: { tenantId, channelAccountId, channel: 'AMAZON', region: 'EU', externalAccountId: 'A1SYN103SIM', marketplaces: [AMAZON_DE], credentialsRef: 'secret-ref:synthetic' } };
    } },
    credentials: { async get() { return {}; } },
    alerts: { raise: async () => undefined },
    logger: { log: () => undefined },
    now: () => new Date().toISOString(),
  };
  const port = new SimulatedAmazonPort({ seed: 103, skus: [{ sku: 'SYN-103-SIM-1', asin: 'B000103001', marketplaces: [AMAZON_DE], priceMinor: 1850, quantity: 3 }], competitors: [] }, deps);
  const pipeline = createPricingPipeline({ store: store as never, adapter: port, alerts: deps.alerts, logger: deps.logger, now: deps.now as never });
  const ctx = (): AdapterCallContext => ({ tenantId: world.tenantId as never, channelAccountId: account as never, correlationId: 'step103-sim',
    deadline: new Date(Date.now() + 120_000).toISOString() as never });

  // У продавца появились два листинга — следующий обход каталога их находит
  port.addListing({ sku: 'SYN-103-SIM-2', asin: 'B000103002', marketplaces: [AMAZON_DE], priceMinor: 2199, quantity: 4, title: 'Synthetic bamboo board' });
  port.addListing({ sku: 'SYN-103-SIM-3', asin: 'B000103003', marketplaces: [AMAZON_DE], priceMinor: 1599, quantity: 2, title: 'Synthetic pour-over dripper' });
  const found = await pipeline.discoverOffers(ctx(), {});
  assert.equal(found.catalogued, 2, 'two new offers in the catalog');

  const rows = (await inTenant(admin, world.tenantId, (tx) => tx.query(
    `SELECT m.external_sku, s.pricing_strategy_id, s.pricing_strategy_version, s.pricing_mode,
            (SELECT a.source || ':' || a.outcome FROM tenant_data.strategy_assignment a WHERE a.tenant_id = s.tenant_id AND a.write_scope_id = s.write_scope_id ORDER BY a.seq DESC LIMIT 1) AS journal
       FROM tenant_data.offer_mapping m JOIN tenant_data.write_scope s ON s.tenant_id = m.tenant_id AND s.write_scope_id = m.price_write_scope_id
      WHERE m.tenant_id = $1 ORDER BY m.external_sku`, [world.tenantId]), world.userId)).rows;
  assert.equal(JSON.stringify(rows.map((r) => [r.external_sku, r.pricing_strategy_id === fixed, r.pricing_strategy_version, r.pricing_mode, r.journal])), JSON.stringify([
    ['SYN-103-SIM-1', true, 1, 'OFF', 'PERSON:ASSIGNED'],
    ['SYN-103-SIM-2', true, 1, 'OFF', 'DEFAULT_RULE:ASSIGNED'],
    ['SYN-103-SIM-3', true, 1, 'OFF', 'DEFAULT_RULE:ASSIGNED'],
  ]), 'the new offers got the default strategy, the old offer is as it was, repricing stays off');

  // Умолчание назначает, но не включает: пересчёт по расписанию цен не шлёт — у модели канала ни одного запроса записи
  await pipeline.recomputeScheduled(ctx(), { limit: 100 });
  assert.equal(port.stats.patchCalls, 0, 'no price was sent to the channel');

  // Листинг, который Amazon прайсит сам (правило автоматического ценообразования), — честное «не назначено» [Р-120]
  port.addListing({ sku: 'SYN-103-SIM-4', asin: 'B000103004', marketplaces: [AMAZON_DE], priceMinor: 1299, quantity: 1, automatedPricing: true });
  // Обход без `circleEveryMs` идёт сразу, как заход планировщика после закрытого круга
  await pipeline.discoverOffers(ctx(), {});
  const auto = (await inTenant(admin, world.tenantId, (tx) => tx.query(
    `SELECT s.pricing_strategy_id, a.outcome, a.reason FROM tenant_data.offer_mapping m
       JOIN tenant_data.write_scope s ON s.tenant_id = m.tenant_id AND s.write_scope_id = m.price_write_scope_id
       JOIN tenant_data.strategy_assignment a ON a.tenant_id = s.tenant_id AND a.write_scope_id = s.write_scope_id
      WHERE m.tenant_id = $1 AND m.external_sku = 'SYN-103-SIM-4'`, [world.tenantId]), world.userId)).rows;
  assert.equal(JSON.stringify(auto.map((r) => [r.pricing_strategy_id, r.outcome, r.reason])), JSON.stringify([[null, 'NOT_ASSIGNED', 'CHANNEL_PRICING']]),
    'the channel prices it itself — not assigned, with the reason');
});
