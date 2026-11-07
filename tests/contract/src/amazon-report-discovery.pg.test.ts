import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { neverWrittenAttributes } from '@repracer/channel-port';
import { createPricingPipeline } from '@repracer/pricing-pipeline';
import { createPool, PgPricingStore, seedPricingWorld, type PgPool } from '@repracer/pricing-store-pg';
import { createScheduler, jobSource, PgSchedulerState, pgJobDeps, runScheduler, type JobDeps } from '@repracer/scheduler';
import { createIsolatedDatabase, requireEnv, type IsolatedDatabase } from '../../../packages/pricing-store-pg/test/isolated-db.ts';
import { amazonUnderTest } from './adapters.ts';
import { amazonWorld, SELLER } from './amazon-fixtures/build.ts';
import { amazonRequestChecker, channelFetch, type TraceEntry } from './harness/channel.ts';
import { VirtualClock, worldDependencies, type Sink } from './harness/world.ts';
import { SimulatedAmazonChannel, SEARCH_LISTINGS_ITEMS_CAP } from './simulator/amazon-channel.ts';
import type { AmazonModelParams } from './simulator/params.ts';

/**
 * Шаг 117 (P0-16 аудита, A-31) [Р-128]: живой прогон — каталог Amazon больше предела поиска обнаруживается ЦЕЛИКОМ. Настоящий планировщик и его работа
 * `offer-discovery`, НАСТОЯЩИЙ адаптер Amazon через HTTP-модель SP-API (отчёт GET_MERCHANT_LISTINGS_ALL_DATA, документ на подписанном адресе, поиск по SKU),
 * путь решения и PostgreSQL. Каталог модели — 2 500 предложений amazon.com: поиск отдаёт не больше 1 000 (A-31), отчёт — все. Резерв: отчёт недоступен —
 * обнаружение идёт поиском и честно говорит, что каталог может быть виден не полностью. Утверждается наблюдаемое: каталог в базе, источник витрины,
 * запросы модели, алерты. Данные синтетические
 */
const N = 2_500;
const US = 'ATVPDKIKX0DER';
const MINUTE = 60_000;
const TENANT = '10000000-0000-4000-8000-000000001170';
const ACCOUNT = '20000000-0000-4000-8000-000000001170';

interface Run {
  catalog: number;
  sources: Array<{ marketplace: string; source: string; listed: number | null; fallback_reason: string | null; may_be_incomplete: boolean }>;
  requests: Record<string, number>;
  rateLimited: number;
  violations: string[];
  alerts: Array<{ code: string; severity: string; details: Record<string, unknown> }>;
  virtualMinutes: number;
  seconds: number;
}

const databases: IsolatedDatabase[] = [];
const pools: PgPool[] = [];
after(async () => {
  for (const p of pools) await p.end();
  for (const db of databases) await db.drop();
});

async function run(tag: string, params: Partial<AmazonModelParams>, virtualMs: number): Promise<Run> {
  requireEnv('REPRACER_PG_ADMIN_URL');
  const startedReal = Date.now();
  const db = await createIsolatedDatabase(`amzrpt${tag}`);
  databases.push(db);
  const url = new URL(process.env.REPRACER_PG_ADMIN_URL!); url.pathname = `/${db.name}`;
  const observer = createPool(url.toString(), { max: 1, applicationName: 'repracer-amazon-report-observer' });
  pools.push(observer);
  const clock = new VirtualClock(new Date(Date.now() - 3 * 3_600_000).toISOString());
  const app = db.pool('svc_app', 4);
  const admin = db.pool('svc_admin', 2);
  const seeded = await seedPricingWorld(app, {
    provisioningPool: db.pool('svc_provisioning', 1), adminPool: admin, fixtureTenantId: TENANT, fixtureChannelAccountId: ACCOUNT, fixtureChannel: 'AMAZON',
    fixtureRegion: 'NA', fixtureExternalAccountId: SELLER, marketplaces: [US], clock: clock.iso(), writeMode: 'SHADOW',
    seed: { scopes: [], marketplaces: { [US]: { currency: 'USD', basis: 'NET' } } } as never,
  });
  const world = amazonWorld({ tenantId: seeded.tenantId, channelAccountId: seeded.ids.dbId(ACCOUNT) }, 'NA');
  const offers = Array.from({ length: N }, (_, i) => ({ sku: `SYN-RPT-${String(i).padStart(5, '0')}`, asin: `B0RPT${String(i).padStart(5, '0')}`, marketplaces: [US],
    priceMinor: 1500 + (i % 500), quantity: 3 }));
  const model = new SimulatedAmazonChannel({ seed: 117, sellerId: SELLER, region: 'NA', offers, params }, clock.iso(), world.credentials.accessToken!);
  const violations: string[] = [];
  const trace: TraceEntry[] = [];
  const fetch = channelFetch(model, amazonRequestChecker(world, clock, neverWrittenAttributes('AMAZON')), clock, violations, trace);
  const sink: Sink = { logs: [], alerts: [] };
  const deps = worldDependencies(world, clock, sink);
  const adapter = amazonUnderTest({ deps, world, clock, fetch } as never);
  const alerts: Run['alerts'] = [];
  const pipeline = createPricingPipeline({
    store: new PgPricingStore(app, { adminPool: admin }), adapter,
    alerts: { raise: async (a) => { alerts.push({ code: a.code, severity: a.severity, details: a.details as Record<string, unknown> }); } },
    logger: deps.logger, now: () => clock.iso(), sleep: clock.sleep,
  });
  const schedulerPool = db.pool('svc_scheduler', 2);
  const base = pgJobDeps({
    schedulerPool, exporterPool: db.pool('svc_exporter', 1), ingest: null as never, verifier: null as never,
    descriptorOf: (channel) => (channel === 'AMAZON' ? adapter.descriptor : null), pipelineFor: () => pipeline,
  });
  const jobDeps: JobDeps = { ...base, exportDay: async (range) => ({ range, exports: [], unverified: [], missing: [] }), exportBacklog: async () => [] };
  const scheduler = createScheduler({ state: new PgSchedulerState(schedulerPool), source: jobSource(jobDeps), owner: `amazon-report-${tag}`, now: () => clock.iso(),
    alerts: { raise: async (a) => { alerts.push({ code: a.code, severity: a.severity, details: (a.details ?? {}) as Record<string, unknown> }); } } });
  const startMs = clock.nowMs();
  const endMs = startMs + virtualMs;
  await runScheduler(scheduler, {
    tickMs: 5_000, clockMs: () => clock.nowMs(), logger: { log: () => {} },
    sleep: async (d) => { clock.advance(d); }, shouldStop: () => clock.nowMs() > endMs,
  }).finished;
  const { rows: [catalog] } = await observer.query(
    `SELECT count(*)::int AS n FROM tenant_data.offer_mapping WHERE tenant_id = $1 AND channel_account_id = $2 AND status <> 'ENDED'`, [seeded.tenantId, seeded.ids.dbId(ACCOUNT)]);
  const sources = await observer.query(
    `SELECT marketplace, source, listed, fallback_reason, may_be_incomplete FROM tenant_data.discovery_catalog_source WHERE tenant_id = $1 ORDER BY marketplace`, [seeded.tenantId])
    .then((r) => r.rows).catch(() => []);
  return { catalog: Number(catalog.n), sources, requests: { ...model.stats.requests }, rateLimited: model.stats.rateLimited, violations, alerts,
    virtualMinutes: Math.round((clock.nowMs() - startMs) / MINUTE), seconds: Math.round((Date.now() - startedReal) / 100) / 10 };
}

test('step 117 (P0-16, A-31): a catalog of 2 500 offers — over the search limit of 1 000 — is discovered in full from the listings report', async () => {
  const r = await run('full', {}, 40 * MINUTE);
  console.log(JSON.stringify({ step117: { offers: N, catalog: r.catalog, sources: r.sources, requests: r.requests, rateLimited: r.rateLimited, seconds: r.seconds } }));
  assert.deepEqual(r.violations, [], 'every request the adapter sent was valid for the model and the presigned document URL got no token');
  assert.equal(r.catalog, N, `the catalog in the database: ${r.catalog} of ${N} (the search alone stops at ${SEARCH_LISTINGS_ITEMS_CAP})`);
  assert.deepEqual(r.sources.map((s) => [s.marketplace, s.source, s.listed, s.fallback_reason, s.may_be_incomplete]), [[US, 'REPORT', N, null, false]],
    'amazon.com: the catalog came from the report, complete');
  // Один отчёт на витрину, один документ; подробности — поиском по 20 SKU, тот же разбор, что у поиска по витрине
  assert.deepEqual([r.requests.createReport, r.requests.getReportDocument, r.requests.downloadReportDocument], [1, 1, 1]);
  assert.equal(r.requests.searchListingsItems, Math.ceil(N / 20), 'details by SKU, 20 per request');
  assert.ok((r.requests.getReport ?? 0) >= 2, `the report was polled until done: ${r.requests.getReport}`);
  assert.equal(r.rateLimited, 0, 'the usage plans of the report operations were kept');
  assert.deepEqual(r.alerts.filter((a) => a.code === 'AMAZON_CATALOG_MAY_BE_INCOMPLETE'), [], 'a complete catalog raises no warning');
});

test('step 117 (P0-16): the report is not available — discovery goes by search and says, as a WARNING, that the catalog may be visible only in part', async () => {
  const r = await run('fallback', { reportAccess: 'DENIED' }, 20 * MINUTE);
  console.log(JSON.stringify({ step117fallback: { offers: N, catalog: r.catalog, sources: r.sources, requests: r.requests } }));
  assert.deepEqual(r.violations, []);
  assert.equal(r.catalog, SEARCH_LISTINGS_ITEMS_CAP, 'search: up to its limit');
  assert.deepEqual(r.sources.map((s) => [s.marketplace, s.source, s.listed, s.fallback_reason, s.may_be_incomplete]), [[US, 'SEARCH', N, 'REPORT_REFUSED', true]],
    'amazon.com: by search, the report was refused, the catalog may be incomplete');
  const warned = r.alerts.filter((a) => a.code === 'AMAZON_CATALOG_MAY_BE_INCOMPLETE');
  assert.deepEqual(warned.map((a) => [a.severity, a.details.marketplace, a.details.found, a.details.reason]), [['WARNING', US, N, 'REPORT_REFUSED']], 'one warning per circle, with the numbers');
});
