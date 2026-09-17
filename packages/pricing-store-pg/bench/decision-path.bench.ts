import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';
import pg from 'pg';
import type { AdapterCallContext, ChannelAdapter, CompetitorSnapshot, FieldWrite } from '@repracer/channel-port';
import { NO_GUARDRAILS } from '@repracer/price-gate';
import { createPricingPipeline, type EvaluationCommit, type PricingStore, type ScopeEvaluationContext } from '@repracer/pricing-pipeline';
import type { PriceDecisionDraft, PriceIntentDraft } from '@repracer/pricing-model';
import { createPool, inTenant, PgPricingStore, type PgPool } from '../src/index.ts';
import { explained } from '../test/drafts.ts';

/**
 * Нагрузочный замер пути решения на реальной схеме (шаг 9, задача G; методика шага 8). Только синтетические данные, одноразовая база.
 *
 * Мир: 10 000 SKU × 2 витрины = 20 000 единиц записи цены, стратегия MATCH_BUYBOX, границы 15.00–25.00.
 * Второй канал смоделирован второй витриной Kaufland: для замера пути решения схема та же.
 * Базовая интенсивность — из ярусов опроса Р-47 (доли — допущение замера): горячий 10 % — раз в 2 минуты, тёплый 30 % — раз в час,
 * холодный 60 % — раз в сутки. Пик — ×10. Одна оценка — не больше трёх транзакций [Р-59].
 *
 * Запуск:
 *   REPRACER_PG_URL=postgres://svc_app@127.0.0.1:55432/repracer_eu npm run bench -w @repracer/pricing-store-pg -- --out=result.json
 *   --shift-window=move_log — окно сдвига из журнала движений, как в шаге 8 (вклад проекции OQ-93)
 */

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k!, v ?? 'true'];
})) as Record<string, string>;
const APP_URL = process.env.REPRACER_PG_URL;
if (!APP_URL) {
  console.error('REPRACER_PG_URL is required');
  process.exit(2);
}
const SKUS = Number(args.skus ?? 10_000);
const SECONDS = Number(args.seconds ?? 15);
const PHASES = new Set((args.phases ?? 'seed,commit,sweep,path').split(','));
const SHIFT_WINDOW = args['shift-window'] === 'move_log' ? 'move_log' : 'projection';
const CHANGED_SHARE = 0.1;
const APP = 'repracer-bench';

/** Оценок в секунду при ярусах Р-47 */
const baseRate = (scopes: number) => scopes * (0.10 / 120 + 0.30 / 3600 + 0.60 / 86_400);

interface RunResult {
  phase: string;
  name: string;
  params: Record<string, unknown>;
  seconds: number;
  ops: number;
  throughput: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  errors: Record<string, number>;
  eventLoopUtilization: number;
  waits: Record<string, number>;
  extra?: Record<string, unknown>;
}

const results: RunResult[] = [];
const timings: Record<string, unknown> = {};
const round = (x: number) => Math.round(x * 100) / 100;
const pct = (sorted: number[], p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]! : NaN);
const pick = <T>(xs: readonly T[]) => xs[Math.floor(Math.random() * xs.length)]!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function appPool(max: number): PgPool {
  return createPool(APP_URL!, { max, applicationName: APP });
}

/** Доли состояний сессий замера: CPU — выполняется, Client:ClientRead — ждёт приложение, LWLock/IO:WAL* — фиксация, Lock:* — блокировки */
async function withWaitSampling<T>(fn: () => Promise<T>): Promise<{ value: T; waits: Record<string, number> }> {
  const client = new pg.Client({ connectionString: APP_URL, application_name: 'repracer-bench-sampler' });
  client.on('error', () => undefined);
  await client.connect();
  const counts: Record<string, number> = {};
  let samples = 0;
  let stop = false;
  const loop = (async () => {
    while (!stop) {
      const { rows } = await client.query(
        `SELECT coalesce(wait_event_type || ':' || wait_event, CASE WHEN state = 'active' THEN 'CPU' ELSE state END) AS w, count(*)::int AS n
           FROM pg_stat_activity WHERE application_name = $1 GROUP BY 1`,
        [APP],
      );
      samples++;
      for (const r of rows) counts[r.w] = (counts[r.w] ?? 0) + r.n;
      await sleep(50);
    }
  })();
  try {
    const value = await fn();
    const averaged = Object.entries(counts).map(([k, v]): [string, number] => [k, round(v / Math.max(samples, 1))]);
    return { value, waits: Object.fromEntries(averaged.sort((a, b) => b[1] - a[1])) };
  } finally {
    stop = true;
    await loop;
    await client.end();
  }
}

function report(r: RunResult): RunResult {
  results.push(r);
  const errors = Object.values(r.errors).reduce((a, b) => a + b, 0);
  console.log(`${r.phase.padEnd(8)} ${r.name.padEnd(56)} ${String(round(r.throughput)).padStart(9)}/s  p50 ${String(round(r.p50)).padStart(8)}  p95 ${String(round(r.p95)).padStart(8)}  p99 ${String(round(r.p99)).padStart(8)} ms  err ${errors}  elu ${r.eventLoopUtilization}  ${JSON.stringify(r.waits)}`);
  return r;
}

function errorKey(e: unknown) {
  return String((e as Error).message ?? e).replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, '<uuid>').slice(0, 100);
}

async function closedLoop(phase: string, name: string, params: Record<string, unknown>, workers: number, seconds: number, op: () => Promise<void>): Promise<RunResult> {
  const latencies: number[] = [];
  const errors: Record<string, number> = {};
  const elu0 = performance.eventLoopUtilization();
  const started = performance.now();
  const end = started + seconds * 1000;
  const { waits } = await withWaitSampling(() => Promise.all(Array.from({ length: workers }, async () => {
    while (performance.now() < end) {
      const t = performance.now();
      try {
        await op();
        latencies.push(performance.now() - t);
      } catch (e) {
        const k = errorKey(e);
        errors[k] = (errors[k] ?? 0) + 1;
      }
    }
  })));
  const elapsed = (performance.now() - started) / 1000;
  latencies.sort((a, b) => a - b);
  return report({
    phase, name, params: { ...params, workers }, seconds: round(elapsed), ops: latencies.length, throughput: latencies.length / elapsed,
    p50: pct(latencies, 0.5), p95: pct(latencies, 0.95), p99: pct(latencies, 0.99), max: latencies[latencies.length - 1] ?? NaN,
    errors, eventLoopUtilization: round(performance.eventLoopUtilization(elu0).utilization), waits,
  });
}

/** Открытый цикл: поступления по расписанию, задержка — от запланированного момента (очередь входит в задержку) */
async function openLoop(phase: string, name: string, params: Record<string, unknown>, rate: number, seconds: number, op: () => Promise<void>): Promise<RunResult> {
  const total = Math.max(1, Math.round(rate * seconds));
  const interval = 1000 / rate;
  const latencies: number[] = [];
  const errors: Record<string, number> = {};
  let inFlight = 0;
  let maxInFlight = 0;
  let lastDone = 0;
  const elu0 = performance.eventLoopUtilization();
  const start = performance.now();
  const { waits } = await withWaitSampling(async () => {
    const tasks: Promise<void>[] = [];
    for (let i = 0; i < total; i++) {
      const scheduled = start + i * interval;
      const delay = scheduled - performance.now();
      if (delay > 1) await sleep(delay);
      else if (i % 64 === 0) await new Promise((r) => setImmediate(r));
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      tasks.push(op().then(
        () => { latencies.push(performance.now() - scheduled); },
        (e) => { const k = errorKey(e); errors[k] = (errors[k] ?? 0) + 1; },
      ).finally(() => { inFlight--; lastDone = performance.now(); }));
    }
    await Promise.all(tasks);
  });
  const elapsed = (lastDone - start) / 1000;
  latencies.sort((a, b) => a - b);
  return report({
    phase, name, params: { ...params, targetRate: round(rate) }, seconds: round(elapsed), ops: latencies.length, throughput: latencies.length / elapsed,
    p50: pct(latencies, 0.5), p95: pct(latencies, 0.95), p99: pct(latencies, 0.99), max: latencies[latencies.length - 1] ?? NaN,
    errors, eventLoopUtilization: round(performance.eventLoopUtilization(elu0).utilization), waits, extra: { maxInFlight },
  });
}

// ---------------------------------------------------------------------------
// Мир замера
// ---------------------------------------------------------------------------

interface BenchScope {
  writeScopeId: string;
  productId: string;
  marketplace: string;
  ref: string;
  unit: string;
  scopeKey: string;
  minIds: string[];
  maxIds: string[];
  version: string;
}

interface BenchWorld {
  tenantId: string;
  membershipId: string;
  accountId: string;
  strategyId: string;
  scopes: BenchScope[];
}

async function seedWorld(pool: PgPool): Promise<Omit<BenchWorld, 'scopes'>> {
  const tenantId: string = randomUUID();
  const userId: string = randomUUID();
  const membershipId: string = randomUUID();
  const accountId: string = randomUUID();
  const strategyId: string = randomUUID();
  const now = new Date().toISOString();
  const steps: Record<string, number> = {};
  const started = performance.now();
  // Р-90: тенант и владельца создаёт роль создания тенанта — у роли пути решения этих прав нет
  const provisioning = createPool(APP_URL!.replace('svc_app@', 'svc_provisioning@'), { max: 1, applicationName: `${APP}-provisioning` });
  const t0 = performance.now();
  await provisioning.query('SELECT security.provision_tenant($1, $2, $3, $4::jsonb)', [tenantId, 'Synthetic bench tenant', 'EU',
    JSON.stringify([{ membershipId, userId, email: `bench-${tenantId.slice(0, 8)}@example.test`, role: 'OWNER' }])]);
  await provisioning.end();
  steps.tenant = round((performance.now() - t0) / 1000);
  await inTenant(pool, tenantId, async (tx) => {
    const step = async (label: string, sql: string, params: unknown[]) => {
      const t = performance.now();
      await tx.query(sql, params);
      steps[label] = round((performance.now() - t) / 1000);
    };
    await step('account',
      `INSERT INTO tenant_data.channel_account (tenant_id, channel_account_id, channel, external_account_id, marketplaces, credentials_ref, connected_by_membership_id)
       VALUES ($1, $2, 'KAUFLAND', $3, '{de,at}', 'secret-ref:synthetic', $4)`, [tenantId, accountId, `syn-bench-${tenantId.slice(0, 8)}`, membershipId]);
    const { rows: [cap] } = await tx.query(`SELECT capability_id, version FROM platform.channel_capability WHERE channel = 'KAUFLAND' AND field = 'PRICE' AND status = 'ACTIVE' LIMIT 1`);
    if (!cap) throw new Error('no ACTIVE Kaufland PRICE capability: run packages/pricing-store-pg/test/setup.sql');
    await step('strategy',
      `INSERT INTO tenant_data.pricing_strategy (tenant_id, pricing_strategy_id, version, name, type, params, triggers, status, created_by_membership_id)
       VALUES ($1, $2, 1, 'bench-buybox', 'MATCH_BUYBOX', $3, '{COMPETITOR_CHANGE,SCHEDULE}', 'ACTIVE', $4)`,
      [tenantId, strategyId, JSON.stringify({ type: 'MATCH_BUYBOX', holdWhenWinning: true, atBound: 'CAP', deadbandMinor: 0 }), membershipId]);
    // Р-91: подрез — не в вечной версии стратегии, а в таблице с 18-месячным сроком
    await tx.query(`INSERT INTO channel_data.pricing_strategy_undercut (tenant_id, pricing_strategy_id, version, undercut_minor) VALUES ($1, $2, 1, 5)`, [tenantId, strategyId]);
    await step('products',
      `INSERT INTO tenant_data.product (tenant_id, product_id, sku, kind, gtin)
       SELECT $1, gen_random_uuid(), 'bench-' || g, 'SIMPLE', lpad(g::text, 13, '4') FROM generate_series(1, $2::int) g`, [tenantId, SKUS]);
    await tx.query(`CREATE TEMP TABLE bench_scope (product_id uuid, marketplace text, write_scope_id uuid, unit text, ref text, gtin text) ON COMMIT DROP`);
    await step('scopePlan',
      `INSERT INTO bench_scope
       SELECT p.product_id, m.marketplace, gen_random_uuid(), (substr(p.sku, 7)::int * 10 + m.k)::text, '37' || lpad(substr(p.sku, 7), 8, '0'), p.gtin
         FROM tenant_data.product p CROSS JOIN (VALUES ('de', 1), ('at', 2)) AS m(marketplace, k)
        WHERE p.tenant_id = $1`, [tenantId]);
    await step('writeScopes',
      `INSERT INTO tenant_data.write_scope (tenant_id, write_scope_id, channel_account_id, channel, field, product_id, capability_id, capability_version,
                                            scope_kind, scope_key, currency, price_basis, tax_regime, pricing_mode)
       SELECT $1, b.write_scope_id, $2, 'KAUFLAND', 'PRICE', b.product_id, $3, $4, 'ACCOUNT_STOREFRONT_UNIT',
              tenant_data.derive_scope_key(jsonb_build_object('marketplace', b.marketplace, 'external_unit_id', b.unit), ARRAY['channel_account', 'marketplace', 'external_unit_id']),
              'EUR', 'GROSS', 'VAT_INCLUDED', 'OFF'
         FROM bench_scope b`, [tenantId, accountId, cap.capability_id, cap.version]);
    await step('offerMappings',
      `INSERT INTO tenant_data.offer_mapping (tenant_id, product_id, channel_account_id, channel, marketplace, channel_offer_key, external_unit_id, channel_product_ref, condition, status, price_write_scope_id)
       SELECT $1, b.product_id, $2, 'KAUFLAND', b.marketplace, 'unit:' || b.unit, b.unit, b.ref, 'NEW', 'ACTIVE', b.write_scope_id FROM bench_scope b`, [tenantId, accountId]);
    await step('minPrices',
      `INSERT INTO tenant_data.min_price (tenant_id, scope_type, write_scope_id, currency, price_basis, amount_minor, version, created_by_membership_id)
       SELECT $1, 'WRITE_SCOPE', b.write_scope_id, 'EUR', 'GROSS', 1500, 1, $2 FROM bench_scope b`, [tenantId, membershipId]);
    await step('maxPrices',
      `INSERT INTO tenant_data.max_price (tenant_id, scope_type, write_scope_id, currency, price_basis, amount_minor, version, created_by_membership_id)
       SELECT $1, 'WRITE_SCOPE', b.write_scope_id, 'EUR', 'GROSS', 2500, 1, $2 FROM bench_scope b`, [tenantId, membershipId]);
    await step('costProfiles',
      `INSERT INTO tenant_data.cost_profile (tenant_id, product_id, version, valid_from, currency, purchase_cost_minor, source, created_by_membership_id)
       SELECT $1, p.product_id, 1, $2::timestamptz - interval '1 day', 'EUR', 1000, 'MANUAL', $3 FROM tenant_data.product p WHERE p.tenant_id = $1`, [tenantId, now, membershipId]);
    await step('feeEstimates',
      `INSERT INTO channel_data.fee_estimate (tenant_id, write_scope_id, source, fee_model, fee_schedule_version, computed_at, valid_until)
       SELECT $1, b.write_scope_id, 'FEE_SCHEDULE', '{"feeRateBp": 1500, "fixedFeeMinor": 0}', 'synthetic', $2::timestamptz - interval '1 day', $2::timestamptz + interval '365 days' FROM bench_scope b`, [tenantId, now]);
    await step('observedState',
      `INSERT INTO channel_data.observed_channel_state (tenant_id, write_scope_id, field, observed_amount_minor, observed_at, received_at, source, sync_status)
       SELECT $1, b.write_scope_id, 'PRICE', 2000, $2::timestamptz - interval '1 hour', $2::timestamptz - interval '1 hour', 'READBACK', 'IN_SYNC' FROM bench_scope b`, [tenantId, now]);
    await step('competitorState',
      `INSERT INTO channel_data.competitor_state (tenant_id, channel_account_id, channel, marketplace, channel_product_ref, condition, source, competitor_snapshot_id,
                                                  observed_at, received_at, buybox_amount_minor, buybox_is_self, lowest_landed_minor, offer_count, offers, completeness, completeness_n, gtin, currency, price_basis)
       SELECT $1, $2, 'KAUFLAND', b.marketplace, b.ref, 'NEW', 'KAUFLAND_BUYBOX', gen_random_uuid(), $3::timestamptz - interval '1 hour', $3::timestamptz - interval '1 hour',
              2005, false, 2005, 2,
              '[{"rank":1,"sellerRef":"bench-competitor","isSelf":false,"price":{"amountMinor":2005,"currency":"EUR","basis":"GROSS"}},{"rank":2,"isSelf":true,"price":{"amountMinor":2000,"currency":"EUR","basis":"GROSS"}}]'::jsonb,
              'TOP_N', 10, b.gtin, 'EUR', 'GROSS'
         FROM bench_scope b`, [tenantId, accountId, now]);
    await step('competitorDaily20d',
      `INSERT INTO channel_data.competitor_price_daily (tenant_id, channel_account_id, channel, marketplace, channel_product_ref, condition, price_day,
                                                        buybox_min_minor, buybox_max_minor, buybox_last_minor, samples, updated_at)
       SELECT $1, $2, 'KAUFLAND', b.marketplace, b.ref, 'NEW', ($3::timestamptz AT TIME ZONE 'UTC')::date - d, 1900, 2100, 2005, 24, $3::timestamptz
         FROM bench_scope b CROSS JOIN generate_series(1, 20) d`, [tenantId, accountId, now]);
  }, userId);
  timings.seed = { totalSeconds: round((performance.now() - started) / 1000), steps };

  const client = await pool.connect();
  try {
    await client.query(`BEGIN; SELECT set_config('app.tenant_id', '${tenantId}', true)`);
    let t = performance.now();
    const updated = await client.query(
      `UPDATE tenant_data.write_scope SET pricing_mode = 'ENGINE', pricing_strategy_id = $2, pricing_strategy_version = 1 WHERE tenant_id = $1`, [tenantId, strategyId]);
    const updateSeconds = (performance.now() - t) / 1000;
    t = performance.now();
    await client.query('COMMIT');
    timings.enableEngine = { scopes: updated.rowCount, updateSeconds: round(updateSeconds), commitSecondsDeferredChecks: round((performance.now() - t) / 1000) };
  } finally {
    client.release();
  }
  return { tenantId, membershipId, accountId, strategyId };
}

async function loadWorld(pool: PgPool, base: Omit<BenchWorld, 'scopes'>): Promise<BenchWorld> {
  const rows = await inTenant(pool, base.tenantId, async (tx) => (await tx.query(
    `SELECT s.write_scope_id, s.product_id, s.scope_key, m.marketplace, m.channel_product_ref, m.external_unit_id,
       (SELECT x.min_price_id FROM tenant_data.min_price x WHERE x.tenant_id = s.tenant_id AND x.scope_type = 'WRITE_SCOPE' AND x.write_scope_id = s.write_scope_id ORDER BY x.version DESC LIMIT 1) AS min_ws,
       (SELECT x.max_price_id FROM tenant_data.max_price x WHERE x.tenant_id = s.tenant_id AND x.scope_type = 'WRITE_SCOPE' AND x.write_scope_id = s.write_scope_id ORDER BY x.version DESC LIMIT 1) AS max_ws
       FROM tenant_data.write_scope s
       JOIN tenant_data.offer_mapping m ON m.tenant_id = s.tenant_id AND m.price_write_scope_id = s.write_scope_id
      WHERE s.tenant_id = $1`, [base.tenantId])).rows);
  const scopes = rows.map((r): BenchScope => ({
    writeScopeId: r.write_scope_id, productId: r.product_id, marketplace: r.marketplace, ref: r.channel_product_ref, unit: r.external_unit_id,
    scopeKey: r.scope_key, minIds: [r.min_ws], maxIds: [r.max_ws],
    // Та же строка версии контекста, что строит PgPricingStore: границы на уровне единицы и отсутствие остановки
    version: `${[`max:WRITE_SCOPE:${r.max_ws}`, `min:WRITE_SCOPE:${r.min_ws}`].sort().join('|')}|halt:-|stop:-`,
  }));
  return { ...base, scopes };
}

// ---------------------------------------------------------------------------
// Фиксация решения: транзакция 2 (+ итог отправки — транзакция 3)
// ---------------------------------------------------------------------------

function commitInput(world: BenchWorld, s: BenchScope, changed: boolean, amount: number, current: number): EvaluationCommit {
  const now = new Date().toISOString();
  const context: ScopeEvaluationContext = {
    scope: {
      writeScopeId: s.writeScopeId, productId: s.productId, channelAccountId: world.accountId, marketplace: s.marketplace, externalUnitId: s.unit, identity: { marketplace: s.marketplace, externalUnitId: s.unit },
      channelProductRef: s.ref, condition: 'new', scopeKey: s.scopeKey, gtin: null, currency: 'EUR', basis: 'GROSS', taxRegime: 'VAT_INCLUDED',
      pricingMode: 'ENGINE', status: 'ACTIVE', strategy: null, currentPriceMinor: current, knownPricesMinor: [current],
    },
    bounds: { currency: 'EUR', basis: 'GROSS', min: { status: 'RESOLVED', amountMinor: 1500, sourceIds: s.minIds }, max: { status: 'RESOLVED', amountMinor: 2500, sourceIds: s.maxIds } },
    contextVersion: s.version, cost: null, unitCostMinor: 1000, guardrails: NO_GUARDRAILS, channelHalt: null, channelDistrust: null, priceStop: null, blocking: null, changesInLastHour: 0,
  };
  const intent: PriceIntentDraft = {
    writeScopeId: s.writeScopeId, strategyId: world.strategyId, strategyVersion: 1, trigger: { type: 'COMPETITOR_CHANGE' }, ruleCode: 'MATCH_BUYBOX',
    intentClass: changed ? 'CHANGED' : 'NO_OP', proposedMinor: changed ? amount : current, currentMinor: current, referenceMinor: amount + 5,
    currency: 'EUR', basis: 'GROSS', reason: { code: changed ? 'BUYBOX_UNDERCUT' : 'ALREADY_AT_TARGET', params: {} }, explanation: [],
    inputs: { boundsAtStrategy: { minMinor: 1500, maxMinor: 2500 } }, createdAt: now, expiresAt: new Date(Date.now() + 600_000).toISOString(),
  };
  const decision: PriceDecisionDraft = {
    writeScopeId: s.writeScopeId, outcome: changed ? 'APPROVED' : 'NO_CHANGE', decisionClass: changed ? 'CHANGED' : 'NO_OP', finalMinor: changed ? amount : null,
    currency: 'EUR', basis: 'GROSS', effectiveFloorMinor: 1500, effectiveCeilingMinor: 2500, minPriceIds: s.minIds, maxPriceIds: s.maxIds, guardrailIds: [],
    rejectionReason: null, reason: { code: changed ? 'APPROVED' : 'NO_CHANGE', params: changed ? { finalMinor: amount } : {} }, checks: [], alert: null, decidedAt: now, boundDeviationBp: null,
  };
  return { key: { channelAccountId: world.accountId, marketplace: s.marketplace, channelProductRef: s.ref, condition: 'new' }, now, decisions: [explained({ context, intent, decision }, { competitorSnapshotId: crypto.randomUUID(), source: 'KAUFLAND_BUYBOX', observedAt: now })] };
}

async function storeCommit(store: PgPricingStore, world: BenchWorld): Promise<void> {
  const s = pick(world.scopes);
  const changed = Math.random() < CHANGED_SHARE;
  const result = await store.commitEvaluation(world.tenantId, commitInput(world, s, changed, 1600 + Math.floor(Math.random() * 800), 2000));
  if (result.status !== 'COMMITTED') throw new Error(`context changed: ${result.reason.code}`);
  const write = result.decisions[0]?.write;
  if (write) await store.recordDispatch(world.tenantId, write, { channelWriteId: write.channelWriteId, status: 'ACCEPTED', appliedImmediately: true }, new Date().toISOString());
}

async function commitPhase(world: BenchWorld): Promise<void> {
  for (const workers of [1, 4, 8, 16]) {
    const pool = appPool(workers);
    const store = new PgPricingStore(pool);
    try {
      await closedLoop('commit', `decision commit (+10% write, dispatch) W=${workers}`, { changedShare: CHANGED_SHARE, pool: workers }, workers, SECONDS, () => storeCommit(store, world));
    } finally {
      await pool.end();
    }
  }
}

async function sweepPhase(world: BenchWorld): Promise<void> {
  const pool = appPool(32);
  const store = new PgPricingStore(pool);
  const base = baseRate(world.scopes.length);
  try {
    for (const rate of [base, base * 10, 400, 800, 1200, 1600, 2400, 3200]) {
      const r = await openLoop('sweep', `decision commit open rate=${round(rate)}`, { pool: 32, changedShare: CHANGED_SHARE }, rate, Math.min(SECONDS, 10), () => storeCommit(store, world));
      if (r.p95 > 1000 || r.throughput < rate * 0.9) break;
    }
  } finally {
    await pool.end();
  }
}

// ---------------------------------------------------------------------------
// Полный путь: адаптер-заглушка, путь решения, хранилище на PostgreSQL
// ---------------------------------------------------------------------------

function stubAdapter(current: Map<string, number>): ChannelAdapter {
  return {
    async planDispatch(_ctx: AdapterCallContext, writes: readonly FieldWrite[]) {
      return { batches: [{ batchId: randomUUID(), writes }], rejected: [] };
    },
    async dispatch(_ctx: AdapterCallContext, batch: { writes: FieldWrite[] }) {
      for (const w of batch.writes) if (w.value.field === 'PRICE') current.set(w.writeScope.writeScopeId, w.value.price.amountMinor);
      return { batchId: 'bench', outcomes: batch.writes.map((w) => ({ channelWriteId: w.channelWriteId, status: 'ACCEPTED', appliedImmediately: true })), attemptsMade: 1 };
    },
  } as unknown as ChannelAdapter;
}

function snapshotFor(s: BenchScope, current: number, changed: boolean): CompetitorSnapshot {
  const buybox = changed ? 1700 + Math.floor(Math.random() * 700) : current + 5;
  const money = (amountMinor: number) => ({ amountMinor, currency: 'EUR', basis: 'GROSS' as const });
  return {
    marketplace: s.marketplace, channelProductRef: s.ref, condition: 'new', source: 'KAUFLAND_BUYBOX', observedAt: new Date().toISOString(),
    completeness: { kind: 'TOP_N', n: 10 }, buybox: { price: money(buybox), isSelf: false },
    offers: [{ rank: 1, sellerRef: 'bench-competitor', isSelf: false, price: money(buybox) }, { rank: 2, isSelf: true, price: money(current) }],
  };
}

/**
 * Окно движений за час в объёме интенсивности, поровну по витринам: и в журнал движений (как в шаге 8), и в проекцию
 * последнего движения товара — оба варианта чтения окна работают с одними данными.
 */
async function seedMoveWindow(pool: PgPool, world: BenchWorld, count: number): Promise<number> {
  const t = performance.now();
  await inTenant(pool, world.tenantId, async (tx) => {
    await tx.query(
      `INSERT INTO channel_data.competitor_move (tenant_id, channel_account_id, marketplace, channel_product_ref, condition, observed_at, evaluated_at, move_bp, verdict, seller_ref)
       SELECT $1, $2, CASE WHEN g % 2 = 0 THEN 'de' ELSE 'at' END, '37' || lpad((1 + g % $4::int)::text, 8, '0'), 'NEW', ts, ts, 9900 + (g % 200), 'ACCEPT', 'bench-competitor'
         FROM generate_series(1, $3::int) g
         CROSS JOIN LATERAL (SELECT now() - (g::float8 / $3::float8) * interval '1 hour' AS ts) t`,
      [world.tenantId, world.accountId, count, SKUS]);
    await tx.query(
      `INSERT INTO channel_data.competitor_move_latest AS l (tenant_id, channel_account_id, marketplace, channel_product_ref, condition, observed_at, evaluated_at, move_bp, verdict, seller_ref)
       SELECT DISTINCT ON (marketplace, channel_product_ref) tenant_id, channel_account_id, marketplace, channel_product_ref, condition, observed_at, evaluated_at, move_bp, verdict, seller_ref
         FROM channel_data.competitor_move WHERE tenant_id = $1 AND channel_account_id = $2
        ORDER BY marketplace, channel_product_ref, evaluated_at DESC
       ON CONFLICT (tenant_id, channel_account_id, marketplace, channel_product_ref, condition) DO UPDATE SET
         observed_at = EXCLUDED.observed_at, evaluated_at = EXCLUDED.evaluated_at, move_bp = EXCLUDED.move_bp, verdict = EXCLUDED.verdict, seller_ref = EXCLUDED.seller_ref
       WHERE l.evaluated_at <= EXCLUDED.evaluated_at`,
      [world.tenantId, world.accountId]);
  });
  return round((performance.now() - t) / 1000);
}

async function pathPhase(world: BenchWorld): Promise<void> {
  const base = baseRate(world.scopes.length);
  const current = new Map<string, number>();
  const pool = appPool(32);
  const store = new PgPricingStore(pool, { shiftWindowSource: SHIFT_WINDOW });
  const calls: Record<string, number> = {};
  const callMs: Record<string, number> = {};
  const counting = new Proxy(store, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (typeof v !== 'function') return v;
      return (...a: unknown[]) => {
        const name = String(prop);
        calls[name] = (calls[name] ?? 0) + 1;
        const t = performance.now();
        return (v.apply(target, a) as Promise<unknown>).finally(() => { callMs[name] = (callMs[name] ?? 0) + performance.now() - t; });
      };
    },
  }) as unknown as PricingStore;
  const verdicts: Record<string, number> = {};
  const alerts: Record<string, number> = {};
  const pipeline = createPricingPipeline({
    store: counting, adapter: stubAdapter(current),
    alerts: {
      raise: async (a: { code: string; details?: { error?: unknown } }) => {
        const key = a.details?.error ? `${a.code}: ${errorKey({ message: a.details.error })}` : a.code;
        alerts[key] = (alerts[key] ?? 0) + 1;
      },
    } as never,
    logger: { log: () => undefined },
    now: () => new Date().toISOString(),
  });
  const ctx = { tenantId: world.tenantId, channelAccountId: world.accountId, correlationId: 'bench', deadline: new Date(Date.now() + 86_400_000).toISOString() } as AdapterCallContext;
  const evaluate = async () => {
    const s = pick(world.scopes);
    const r = await pipeline.processSnapshot(ctx, snapshotFor(s, current.get(s.writeScopeId) ?? 2000, Math.random() < CHANGED_SHARE));
    const key = r.verdict === 'ACCEPT' ? `ACCEPT:${r.scopes[0]?.decision?.outcome ?? r.scopes[0]?.stages.at(-1)?.outcome ?? 'none'}` : `${r.verdict}:${r.reason?.code}`;
    verdicts[key] = (verdicts[key] ?? 0) + 1;
  };
  const contextOnly = async (label: string) => {
    const lat: number[] = [];
    for (let i = 0; i < 200; i++) {
      const s = pick(world.scopes);
      const t = performance.now();
      const c = await store.loadEvaluationContext(world.tenantId, { channelAccountId: world.accountId, marketplace: s.marketplace, channelProductRef: s.ref, condition: 'new' },
        new Date().toISOString(), { windowSeconds: 900, minFactor: 1.15 });
      lat.push(performance.now() - t);
      if (i === 0) timings[`${label}WindowProducts`] = c.sanity.channel.windowProducts ?? null;
    }
    lat.sort((a, b) => a - b);
    timings[`${label}EvaluationContextMs`] = { p50: round(pct(lat, 0.5)), p95: round(pct(lat, 0.95)) };
  };
  const snapshotCounters = (r: RunResult) => {
    const evaluations = Math.max(r.ops, 1);
    r.extra = {
      ...r.extra,
      transactionsPerEvaluation: round(Object.values(calls).reduce((a, b) => a + b, 0) / evaluations),
      storeCallsPerEvaluation: Object.fromEntries(Object.entries(calls).map(([k, v]) => [k, round(v / evaluations)])),
      storeMsPerEvaluation: Object.fromEntries(Object.entries(callMs).map(([k, v]) => [k, round(v / evaluations)]).sort((a, b) => Number(b[1]) - Number(a[1]))),
      verdicts: { ...verdicts }, alerts: { ...alerts },
    };
    for (const m of [calls, callMs, verdicts, alerts]) for (const k of Object.keys(m)) delete m[k];
  };
  const stage = async (label: string, rate: number, movesPerHour: number) => {
    await contextOnly(label);
    const closed = await closedLoop('path', `full evaluation closed W=16 (${label} window, ${SHIFT_WINDOW})`, { movesPerHour, shiftWindow: SHIFT_WINDOW }, 16, SECONDS, evaluate);
    snapshotCounters(closed);
    if (closed.throughput < rate * 1.2) {
      timings[`${label}OpenLoop`] = `not sustainable: closed-loop ${round(closed.throughput)}/s < 1.2 × ${round(rate)}/s`;
      return;
    }
    const open = await openLoop('path', `full evaluation open ${label}=${round(rate)}/s (${SHIFT_WINDOW})`, { movesPerHour, shiftWindow: SHIFT_WINDOW }, rate, SECONDS, evaluate);
    snapshotCounters(open);
  };
  try {
    timings.moveWindowBaseSeedSeconds = await seedMoveWindow(pool, world, Math.round(base * 3600));
    await stage('base', base, Math.round(base * 3600));
    timings.moveWindowPeakSeedSeconds = await seedMoveWindow(pool, world, Math.round(base * 9 * 3600));
    await stage('peak', base * 10, Math.round(base * 10 * 3600));
  } finally {
    await pool.end();
  }
}

async function main() {
  const info = new pg.Client({ connectionString: APP_URL, application_name: 'repracer-bench-info' });
  await info.connect();
  const { rows: [version] } = await info.query('SELECT version()');
  const { rows: settings } = await info.query(
    `SELECT name, setting, unit FROM pg_settings WHERE name IN ('shared_buffers', 'max_connections', 'synchronous_commit', 'fsync', 'work_mem', 'max_wal_size')`,
  );
  await info.end();
  const environment = { node: process.version, cpu: cpus()[0]?.model, cores: cpus().length, memoryGb: round(totalmem() / 2 ** 30), postgres: version.version, settings };
  console.log(JSON.stringify(environment));

  const setupPool = appPool(16);
  let world: BenchWorld;
  try {
    const base = args.tenant ? JSON.parse(args.tenant) : await seedWorld(setupPool);
    console.log('world', JSON.stringify(base), JSON.stringify(timings));
    world = await loadWorld(setupPool, base);
  } finally {
    await setupPool.end();
  }
  console.log(`scopes: ${world.scopes.length}; base rate ${round(baseRate(world.scopes.length))}/s, peak ${round(baseRate(world.scopes.length) * 10)}/s; shift window: ${SHIFT_WINDOW}`);
  if (PHASES.has('commit')) await commitPhase(world);
  if (PHASES.has('sweep')) await sweepPhase(world);
  if (PHASES.has('path')) await pathPhase(world);

  const output = {
    format: 'repracer.bench/decision-path/v2', startedFor: 'step-9', environment,
    workload: { skus: SKUS, storefronts: 2, scopes: world.scopes.length, changedShare: CHANGED_SHARE, baseRatePerSecond: round(baseRate(world.scopes.length)), peakRatePerSecond: round(baseRate(world.scopes.length) * 10), secondsPerRun: SECONDS, shiftWindow: SHIFT_WINDOW },
    timings, results,
  };
  if (args.out) writeFileSync(args.out, JSON.stringify(output, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
