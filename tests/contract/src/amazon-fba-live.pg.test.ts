import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createPool, PgStockStore } from '@repracer/pricing-store-pg';
import { amazonUnderTest } from './adapters.ts';
import { amazonWorld, SELLER } from './amazon-fixtures/build.ts';
import { pgStoreFactory } from './harness/pg-store.ts';
import { runScenario } from './harness/runner.ts';
import { SCENARIO_FORMAT, type Scenario, type Step } from './harness/scenario.ts';
import type { AmazonChannelModelSpec } from './simulator/amazon-channel.ts';

/**
 * Шаг 53 (ревью шага 52, находка 8): путь «Amazon FBA → экран остатков» одним прогоном стенда. HTTP-модель SP-API (снимок 2026-09-29), НАСТОЯЩИЙ
 * адаптер Amazon, путь решения на PostgreSQL: обнаружение находит FBM и FBA, читает количество FBA (`getInventorySummaries`), база хранит его
 * текущим значением предложения CHANNEL [Р-196], экран остатков показывает его только для чтения. Записей в канал нет. Данные синтетические.
 */

const PG_URL = process.env.REPRACER_PG_URL;
if (!PG_URL) throw new Error('REPRACER_PG_URL is required: database tests do not skip (Р-84)');
const pool = createPool(PG_URL, { max: 4, applicationName: 'repracer-contract-fba' });
const role = (r: string) => createPool(PG_URL.replace('svc_app@', `svc_${r}@`), { max: 2, applicationName: `repracer-contract-fba-${r}` });
const scanPool = role('dispatcher');
const fxLoaderPool = role('fx_loader');
const adminPool = role('admin');
const provisioningPool = role('provisioning');
const stockPool = role('stock');
after(async () => { for (const p of [pool, scanPool, fxLoaderPool, adminPool, provisioningPool, stockPool]) await p.end(); });

const DE = 'A1PA6795UKMFR9';
const model: AmazonChannelModelSpec = {
  seed: 53, sellerId: SELLER, region: 'EU',
  offers: [
    { sku: 'SYN-FBM-5301', asin: 'B0SYN53001', marketplaces: [DE], priceMinor: 1999, quantity: 4 },
    { sku: 'SYN-FBA-5302', asin: 'B0SYN53002', marketplaces: [DE], priceMinor: 2499, quantity: 12, fulfillmentCode: 'SYN_AMAZON_NETWORK_CODE' },
  ],
};

test('step 53: Amazon FBA quantity goes from discovery through the database to the stock screen, read-only, with no write to the channel', async () => {
  const scenario: Scenario = {
    format: SCENARIO_FORMAT, id: 'amazon-sim/fba-to-stock-screen', channel: 'AMAZON', apiVersion: 'sp-api models snapshot 2026-09-29 (model)',
    title: 'FBA → экран остатков', description: 'Сквозной путь количества FBA на PostgreSQL', tags: ['simulator', 'amazon', 'pg'],
    provenance: { kind: 'SYNTHETIC_FROM_DOCS', sources: ['vendor/amazon/sp-api-models/2026-09-29/SOURCE.md'] },
    world: { ...amazonWorld(), clock: '2026-09-29T10:00:00.000Z', channelModel: model, pricing: { scopes: [] } },
    steps: [{ id: 'discover', kind: 'pipelineDiscoverOffers', expect: { offers: 2, catalogued: 2 } } as Step],
    exchanges: [], expect: { noAlerts: true, channel: { stats: { requests: { patchListingsItem: { $absent: true }, getInventorySummaries: 1 } } } },
  };
  let tenantId = '';
  const report = await runScenario(scenario, amazonUnderTest, undefined, pgStoreFactory(pool, scanPool, fxLoaderPool, { adminPool, provisioningPool }),
    { onFinish: ({ store }) => { tenantId = (store as unknown as { identity: { tenantId: string } }).identity.tenantId; } });
  assert.deepEqual(report.failures, [], report.failures.join('\n'));
  const page = await new PgStockStore({ adminPool, stockPool }).stockPage(tenantId, { offset: 0, limit: 50 });
  const fba = page.items.find((r) => r.sku === 'SYN-FBA-5302');
  const fbm = page.items.find((r) => r.sku === 'SYN-FBM-5301');
  assert.deepEqual(fba?.channelManaged?.map((c) => [c.channel, c.marketplace, c.quantity]), [['AMAZON', DE, 12]], 'FBA: managed by Amazon, 12');
  assert.equal(fbm?.channelManaged, undefined, 'FBM: our quantity, nothing managed by the channel');
  assert.deepEqual([fba?.onHand, fba?.available, fba?.channels.length], [0, 0, 0], 'not our stock, no quantity write scope');
});
