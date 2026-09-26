import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import pg from 'pg';
import { ClickHouseHttp, competitorSnapshotRow, completedWriteRow, priceDecisionRow, priceIntentRow, type PgRow } from '../src/index.ts';

/**
 * Замер сжатия аналитического слоя (шаг 10, пункт C) против оценки шага 4 (ADR-0004: «5–15-кратное сжатие» без замера).
 * Одни и те же синтетические строки пишутся в ClickHouse (копии таблиц repracer_analytics в repracer_bench — те же движок,
 * кодеки и ключи) и в копии таблиц PostgreSQL с индексами (LIKE … INCLUDING INDEXES). Размер JSON-полей — по строкам,
 * которые путь решения записал на стенде: 10 проверок Gate ≈ 560 байт, входы intent ≈ 220, обоснование ≈ 280.
 * Распределения (допущение замера): 20 тенантов, 2 500 единиц записи на тенанта, 30 дней; решения — 80 % APPROVED,
 * 20 % REJECTED; 10 % решений — с курсом ЕЦБ; записи — 85 % APPLIED, 13 % SUPERSEDED, 2 % DISCARDED_STALE.
 *
 *   REPRACER_CH_URL=http://127.0.0.1:18123 REPRACER_CH_USER=repracer_local_admin REPRACER_CH_PASSWORD=... \
 *   REPRACER_PG_ADMIN_URL=postgres://postgres@127.0.0.1:55432/repracer_eu \
 *   npm run bench -w @repracer/analytics-export -- --rows=1000000 --pg-rows=200000 --out=compression.json
 */

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k!, v ?? 'true'];
})) as Record<string, string>;
const CH_URL = process.env.REPRACER_CH_URL;
const CH_USER = process.env.REPRACER_CH_USER ?? 'repracer_local_admin';
const CH_PASSWORD = process.env.REPRACER_CH_PASSWORD;
const PG_ADMIN = process.env.REPRACER_PG_ADMIN_URL;
if (!CH_URL || !CH_PASSWORD || !PG_ADMIN) {
  console.error('REPRACER_CH_URL, REPRACER_CH_PASSWORD and REPRACER_PG_ADMIN_URL are required');
  process.exit(2);
}
const ROWS = Number(args.rows ?? 1_000_000);
const PG_ROWS = Number(args['pg-rows'] ?? 200_000);
const TENANTS = 20;
const SCOPES_PER_TENANT = 2_500;
const DAYS = 30;
const CHUNK = 50_000;

/** Строк на клиента за 18 месяцев — ADR-0004, раздел «ClickHouse» (оценка шага 4) */
const ADR_0004_ROWS: Record<string, { rows: number; estimateGb: [number, number] }> = {
  channel_observation: { rows: 255e6, estimateGb: [6, 13] },
  competitor_snapshot: { rows: 106e6, estimateGb: [8, 16] },
  channel_write_completed: { rows: 186e6, estimateGb: [5, 11] },
  price_intent: { rows: 245e6, estimateGb: [11, 22] },
  price_decision: { rows: 245e6, estimateGb: [11, 22] },
};
const EUR_PER_GB_MONTH = 0.12;

// Детерминированный генератор: один и тот же мир при каждом запуске
let seed = 0x9e3779b9;
function rand(): number {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
}
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
function uuid(...parts: Array<string | number>): string {
  const h = createHash('sha1').update(parts.join('|')).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const base = Date.now() - DAYS * 86_400_000;
const scopeCount = TENANTS * SCOPES_PER_TENANT;
const prices = Array.from({ length: scopeCount }, () => 1_500 + Math.floor(rand() * 3_500));
const GATE_CHECKS = ['SCOPE', 'CHANNEL_HALT', 'INTENT', 'BOUNDS_RESOLVED', 'MARGIN_FLOOR', 'LOWER_BOUND', 'UPPER_BOUND', 'STEP', 'RATE', 'FINAL_RECHECK'];

interface World {
  tenantId: string;
  scopeId: string;
  scopeIndex: number;
  at: Date;
}

function worldRow(i: number): World {
  const scopeIndex = Math.floor(rand() * scopeCount);
  const tenant = scopeIndex % TENANTS;
  return { tenantId: uuid('tenant', tenant), scopeId: uuid('scope', scopeIndex), scopeIndex, at: new Date(base + (i / ROWS) * DAYS * 86_400_000 + Math.floor(rand() * 1_000)) };
}

function decisionPair(i: number): { intent: PgRow; decision: PgRow } {
  const w = worldRow(i);
  const current = prices[w.scopeIndex]!;
  const floor = 1_000 + (w.scopeIndex % 400);
  const ceiling = 6_000 + (w.scopeIndex % 900);
  // Шаг 20: случайное блуждание цены держится внутри границ — одобренное решение ниже пола отклоняет ограничение ClickHouse
  // floor_respected (первый прогон замера в CI упал на нём: генератор до шага 20 ни разу не запускался)
  const buybox = Math.min(ceiling - 10, Math.max(floor + 10, current + Math.round((rand() - 0.5) * 120)));
  const target = buybox - 5;
  prices[w.scopeIndex] = target;
  const rejected = rand() < 0.2;
  const withFx = rand() < 0.1;
  const intentId = uuid('intent', i);
  const intent: PgRow = {
    tenant_id: w.tenantId, price_intent_id: intentId, created_at: w.at, write_scope_id: w.scopeId, pricing_strategy_id: uuid('strategy', w.scopeIndex % 50),
    pricing_strategy_version: 1 + (w.scopeIndex % 3), trigger_type: 'COMPETITOR_CHANGE', rule_code: 'MATCH_BUYBOX', source_event_id: `kaufland:${createHash('md5').update(String(i)).digest('hex')}`,
    competitor_snapshot_id: null, proposed_amount_minor: target, reference_amount_minor: buybox, currency: withFx ? 'USD' : 'EUR', price_basis: withFx ? 'NET' : 'GROSS',
    inputs: { snapshotSource: 'KAUFLAND_BUY_BOX_CHANGED', boundsAtStrategy: { minMinor: floor, maxMinor: ceiling }, snapshotObservedAt: new Date(w.at.getTime() - 4_000).toISOString(), snapshotSourceEventId: `kaufland:${createHash('md5').update(String(i)).digest('hex')}` },
    rationale: { reason: { code: 'BUYBOX_UNDERCUT', params: { buyboxMinor: buybox, targetMinor: target, undercutMinor: 5 } }, explanation: [{ code: 'BUYBOX_UNDERCUT', params: { buyboxMinor: buybox, targetMinor: target, undercutMinor: 5 } }], intentClass: rejected ? 'REJECTED_BY_GATE' : 'CHANGED', currentMinor: current },
    expires_at: new Date(w.at.getTime() + 600_000),
  };
  const failing = rejected ? pick(['MARGIN_FLOOR', 'STEP', 'LOWER_BOUND']) : null;
  const checks = GATE_CHECKS.map((check) => (check === failing
    ? { check, detail: { code: check === 'MARGIN_FLOOR' ? 'BELOW_MARGIN_FLOOR' : check === 'STEP' ? 'STEP_LIMIT' : 'BELOW_MIN_PRICE', params: { proposedMinor: target, floorMinor: target + 40 } }, passed: false }
    : { check, detail: null, passed: true }));
  const rejectionReason = failing === 'MARGIN_FLOOR' ? 'BELOW_MARGIN_FLOOR' : failing === 'STEP' ? 'STEP_LIMIT' : failing ? 'BELOW_MIN_PRICE' : null;
  const decision: PgRow = {
    tenant_id: w.tenantId, price_decision_id: uuid('decision', i), intent_created_at: w.at, price_intent_id: intentId, write_scope_id: w.scopeId,
    decided_at: new Date(w.at.getTime() + 3), outcome: rejected ? 'REJECTED' : 'APPROVED', intent_class: rejected ? 'REJECTED_BY_GATE' : 'CHANGED',
    rejection_reason: rejectionReason, reason_params: rejected ? { proposedMinor: target, floorMinor: target + 40 } : { finalMinor: target, floorMinor: floor, ceilingMinor: ceiling },
    final_amount_minor: rejected ? null : target, currency: intent.currency, price_basis: intent.price_basis, effective_floor_minor: floor, effective_ceiling_minor: ceiling,
    min_price_ids: [uuid('min', w.scopeIndex)], max_price_ids: [uuid('max', w.scopeIndex)], guardrail_ids: rand() < 0.3 ? [uuid('guardrail', w.scopeIndex % 97)] : [],
    cost_profile_id: withFx ? uuid('cost', w.scopeIndex) : null,
    fee_inputs: withFx ? { tax: { regime: 'SALES_TAX_EXCLUDED' }, feeRateBp: 1500, unitCostMinor: 1156, fixedFeeMinor: 0 } : null,
    fx: withFx ? { to: 'USD', base: 'EUR', from: 'EUR', quote: 'USD', source: 'ECB', rateDate: w.at.toISOString().slice(0, 10), rounding: 'UP', rateMicros: 1_155_100, sourceAmountMinor: 1000, convertedAmountMinor: 1156 } : null,
    violations: failing ? [failing] : [], checks, competitor_derived: true,
    // Шаг 20: столбцы решения шагов 12–14 (NOT NULL с 0049) — первый прогон в CI упал на них: генератор был старше схемы.
    // Слепок r80.1 — в PostgreSQL; в ClickHouse решение уходит без слепка (rows.ts), вечная копия — ядро и архив [Р-79]
    rule_code: intent.rule_code, trigger_type: intent.trigger_type, proposed_amount_minor: target, pricing_strategy_version: intent.pricing_strategy_version,
    explanation: { format: 'r80.1', snapshot: { source: 'KAUFLAND_BUYBOX', observedAt: intent.inputs.snapshotObservedAt },
      sanity: { anchorsUsed: ['COST', 'HISTORY'], checks: [{ code: 'WITHIN_HISTORY', params: {} }] },
      strategy: { currentMinor: current, currency: intent.currency, reason: { code: 'FIXED_PRICE', params: { targetMinor: target, currency: intent.currency } } } },
    sanity_ruleset: 'r49.1', gate_profile: 'g74.1',
  };
  return { intent, decision };
}

function completedWrite(i: number): PgRow {
  const w = worldRow(i);
  const r = rand();
  const status = r < 0.85 ? 'APPLIED' : r < 0.98 ? 'SUPERSEDED' : 'DISCARDED_STALE';
  const version = 1 + Math.floor(rand() * 400);
  const amount = prices[w.scopeIndex]!;
  return {
    tenant_id: w.tenantId, channel_write_id: uuid('write', i), finished_at: new Date(w.at.getTime() + 900), write_scope_id: w.scopeId, field: 'PRICE', amount_minor: amount,
    currency: 'EUR', price_basis: 'GROSS', quantity: null, version, origin: 'PRICE_DECISION', price_decision_id: uuid('decision', i), direction: null, final_status: status,
    end_reason: status === 'APPLIED' ? null : status === 'SUPERSEDED' ? 'WRITE_SUPERSEDED_BY_NEWER_VERSION' : 'WRITE_BLOCKED_BY_BOUND_RECHECK',
    end_params: status === 'SUPERSEDED' ? { newerVersion: version + 1, newerWriteId: uuid('write', i + 1) } : status === 'DISCARDED_STALE' ? { amountMinor: amount, floorMinor: amount + 10, ceilingMinor: null } : null,
    superseded_by_write_id: status === 'SUPERSEDED' ? uuid('write', i + 1) : null, last_error_code: null, attempt_count: status === 'APPLIED' ? 1 : 0,
    budget_scope_key: null, budget_day: null, floor_at_dispatch_minor: status === 'APPLIED' ? 1_000 + (w.scopeIndex % 400) : null, trigger_received_at: w.at,
    created_at: new Date(w.at.getTime() + 3), dispatched_at: status === 'APPLIED' ? new Date(w.at.getTime() + 10) : null, accepted_at: status === 'APPLIED' ? new Date(w.at.getTime() + 800) : null,
    applied_at: status === 'APPLIED' ? new Date(w.at.getTime() + 800) : null,
  };
}

function competitorSnapshot(i: number): PgRow {
  const w = worldRow(i);
  const buybox = prices[w.scopeIndex]!;
  const n = 1 + Math.floor(rand() * 10);
  const sellers = Array.from({ length: n }, (_, k) => `seller-${String((w.scopeIndex * 7 + k * 13) % 5_000).padStart(5, '0')}`);
  return {
    tenant_id: w.tenantId, competitor_snapshot_id: uuid('snapshot', i), received_at: w.at.toISOString(), observed_at: new Date(w.at.getTime() - 2_000).toISOString(),
    channel_account_id: uuid('account', w.scopeIndex % TENANTS), channel: 'KAUFLAND', marketplace: pick(['de', 'at']), channel_product_ref: String(362_000_000 + w.scopeIndex),
    condition: 'new', currency: 'EUR', price_basis: 'GROSS', source: 'KAUFLAND_BUYBOX', source_event_id: null, completeness: 'TOP_N', completeness_n: 10,
    buybox_amount_minor: buybox, buybox_shipping_minor: 0, buybox_is_self: rand() < 0.3, channel_suggested_amount_minor: rand() < 0.5 ? buybox - 1 : null,
    'offers.seller_ref': sellers, 'offers.amount_minor': sellers.map((_, k) => buybox + k * (5 + Math.floor(rand() * 40))), 'offers.shipping_minor': sellers.map(() => (rand() < 0.8 ? 0 : 499)),
    'offers.condition': sellers.map(() => 'new'), 'offers.fulfillment': sellers.map(() => (rand() < 0.9 ? 'MERCHANT' : 'CHANNEL')), 'offers.is_self': sellers.map((_, k) => k === 1),
    'offers.feedback_count': sellers.map(() => null), 'offers.feedback_pct': sellers.map(() => null), 'offers.rank': sellers.map((_, k) => k + 1),
    'offers.delivery_min_days': sellers.map(() => 1), 'offers.delivery_max_days': sellers.map(() => 2 + Math.floor(rand() * 3)),
    offer_counts: { new: n }, data_class: 'CHANNEL_INFO',
  };
}

/**
 * Шаг 24 [Р-122]: снимки конкурентов в форме, которую пишет писатель (competitorSnapshotRow из снимка порта), — ряды во времени по
 * товару: между соседними снимками одного товара меняется одно-два предложения, как у настоящего рынка (у генератора шага 20 каждый
 * снимок был случайным). Kaufland — ответ Buy Box с 1–10 предложениями (число предложений /buybox документация не ограничивает —
 * допущение); Amazon — ANY_OFFER_CHANGED с первыми 20 предложениями (notification-type-values, «top 20 offers»), продавцы по 14 символов.
 */
const SNAPSHOT_PRODUCTS = 20_000;
interface ProductSeries { at: number; offers: Array<{ seller: string; minor: number; shipping: number; minDays: number; maxDays: number; fba: boolean }>; }
const series = new Map<string, ProductSeries>();

function snapshotSeries(channel: 'KAUFLAND' | 'AMAZON', i: number): PgRow {
  const product = Math.floor(rand() * SNAPSHOT_PRODUCTS);
  const key = `${channel}|${product}`;
  const basePrice = 1_000 + (product % 9_000);
  let s = series.get(key);
  if (!s) {
    const n = channel === 'AMAZON' ? 3 + Math.floor(rand() * 18) : 1 + Math.floor(rand() * 10);
    s = {
      // Начало ряда — от базы замера (последние 30 суток), а не от эпохи: строки старше 18 месяцев удаляет TTL таблицы при OPTIMIZE FINAL
      // (первый прогон CI шага 24 измерил 0 строк)
      at: base + product * 1_000,
      offers: Array.from({ length: n }, (_, k) => ({
        seller: channel === 'AMAZON' ? `A${createHash('sha1').update(`s${(product * 31 + k * 7) % 40_000}`).digest('hex').slice(0, 13).toUpperCase()}` : `Synthetic Seller ${(product * 31 + k * 7) % 40_000}`,
        minor: basePrice + k * (10 + Math.floor(rand() * 60)), shipping: rand() < 0.7 ? 0 : 399 + Math.floor(rand() * 3) * 100,
        minDays: 1 + Math.floor(rand() * 2), maxDays: 3 + Math.floor(rand() * 4), fba: rand() < 0.4,
      })),
    };
    series.set(key, s);
  }
  // Следующий снимок товара: через 2–120 минут, одно-два предложения меняют цену на ±1–3 %
  s.at += (2 + Math.floor(rand() * 118)) * 60_000;
  for (let c = 0; c < 1 + Math.floor(rand() * 2); c++) {
    const o = s.offers[Math.floor(rand() * s.offers.length)]!;
    o.minor = Math.max(100, Math.round(o.minor * (1 + ((rand() - 0.5) * 6) / 100)));
  }
  const offers = [...s.offers].sort((a, b) => a.minor + a.shipping - (b.minor + b.shipping));
  const currency = channel === 'AMAZON' && product % 4 === 0 ? 'USD' : 'EUR';
  const basis = currency === 'USD' ? 'NET' as const : 'GROSS' as const;
  const money = (amountMinor: number) => ({ amountMinor, currency, basis });
  const selfIndex = product % offers.length;
  const tenant = uuid('tenant', product % TENANTS);
  const observed = new Date(s.at);
  return competitorSnapshotRow(tenant, uuid('account', channel, product % TENANTS), channel, uuid('snapshot', channel, i), {
    marketplace: channel === 'AMAZON' ? (currency === 'USD' ? 'ATVPDKIKX0DER' : 'A1PA6795UKMFR9') : product % 5 === 0 ? 'at' : 'de',
    channelProductRef: channel === 'AMAZON' ? `B0${String(product).padStart(8, '0')}` : String(362_000_000 + product), condition: 'new',
    source: channel === 'AMAZON' ? 'AMAZON_ANY_OFFER_CHANGED' : rand() < 0.5 ? 'KAUFLAND_BUYBOX' : 'KAUFLAND_BUY_BOX_CHANGED',
    ...(channel === 'AMAZON' || rand() < 0.5 ? { sourceEventId: createHash('md5').update(`${channel}${i}`).digest('hex') } : {}),
    observedAt: observed.toISOString(), completeness: { kind: 'TOP_N', n: channel === 'AMAZON' ? 20 : 10 },
    buybox: { price: money(offers[0]!.minor), isSelf: selfIndex === 0 },
    offers: offers.map((o, k) => ({
      rank: k + 1, isSelf: k === selfIndex, ...(k === selfIndex ? {} : { sellerRef: o.seller }), price: money(o.minor), shipping: money(o.shipping),
      totalPrice: money(o.minor + o.shipping), condition: 'new', fulfillment: o.fba ? 'AFN' : 'MFN', deliveryDays: { min: o.minDays, max: o.maxDays },
    })),
  }, new Date(observed.getTime() + 1_500 + Math.floor(rand() * 3_000)).toISOString(), rand() < 0.002 ? 'REJECT' : 'ACCEPT') as unknown as PgRow;
}

/**
 * Модель объёма снимков на клиента в год (допущения, не замер). Каталог — 10 000 предложений на витрину (OQ-01: оценки объёма опираются
 * на 10 000 SKU). Снимки в сутки на предложение: опрос по ярусам Р-47 (DEFAULT_TIERS: горячий раз в 120 с, тёплый — в час, холодный — в
 * сутки) плюс уведомления об изменениях. Доли ярусов и число уведомлений не измерены — три варианта.
 */
/** Интервалы опроса ярусов — как DEFAULT_TIERS (packages/pricing-pipeline/src/polling.ts); равенство проверяет tests/contract (volume-tiers) */
export const BENCH_TIER_INTERVALS_SECONDS = { hot: 120, warm: 3600, cold: 86_400 } as const;
const DEFAULT_TIERS = { hot: { intervalSeconds: BENCH_TIER_INTERVALS_SECONDS.hot }, warm: { intervalSeconds: BENCH_TIER_INTERVALS_SECONDS.warm }, cold: { intervalSeconds: BENCH_TIER_INTERVALS_SECONDS.cold } };
const VOLUME_SCENARIOS = [
  { name: 'спокойный', offers: 10_000, hot: 0.01, warm: 0.1, notificationsPerOfferDay: 2 },
  { name: 'типичный (допущение)', offers: 10_000, hot: 0.05, warm: 0.25, notificationsPerOfferDay: 6 },
  { name: 'волатильный', offers: 10_000, hot: 0.15, warm: 0.4, notificationsPerOfferDay: 24 },
];
function snapshotsPerYear(v: (typeof VOLUME_SCENARIOS)[number]): number {
  const perDay = (s: number) => 86_400 / s;
  const polls = v.offers * (v.hot * perDay(DEFAULT_TIERS.hot.intervalSeconds) + v.warm * perDay(DEFAULT_TIERS.warm.intervalSeconds) + (1 - v.hot - v.warm) * perDay(DEFAULT_TIERS.cold.intervalSeconds));
  return Math.round((polls + v.offers * v.notificationsPerOfferDay) * 365);
}

function observation(i: number): PgRow {
  const w = worldRow(i);
  return {
    tenant_id: w.tenantId, channel_observation_id: uuid('observation', i), received_at: w.at.toISOString(), observed_at: new Date(w.at.getTime() - 1_000).toISOString(),
    write_scope_id: w.scopeId, channel_account_id: uuid('account', w.scopeIndex % TENANTS), channel: 'KAUFLAND', marketplace: pick(['de', 'at']), field: 'PRICE',
    amount_minor: prices[w.scopeIndex]!, currency: 'EUR', price_basis: 'GROSS', quantity: null, source: pick(['READBACK', 'PUSH_EVENT']), source_event_id: null, data_class: 'CHANNEL_INFO',
  };
}

const ch = new ClickHouseHttp({ url: CH_URL, user: CH_USER, password: CH_PASSWORD });
const pgAdmin = new pg.Pool({ connectionString: PG_ADMIN, max: 2 });

interface TableResult {
  table: string;
  rows: number;
  clickhouse: { bytesOnDisk: number; compressed: number; uncompressed: number; bytesPerRow: number; compressionRatio: number; topColumns: Array<{ column: string; compressed: number; uncompressed: number }> };
  postgres: { rows: number; totalBytes: number; heapBytes: number; indexBytes: number; toastBytes: number; bytesPerRow: number } | null;
  pgToClickHouse: number | null;
  perClient18Months: { rows: number; gb: number; eurPerMonth: number; step4EstimateGb: [number, number] } | null;
}

async function loadClickHouse(table: string, make: (i: number) => PgRow, source = table): Promise<void> {
  await ch.query(`DROP TABLE IF EXISTS repracer_bench.${table} SYNC`);
  await ch.query(`CREATE TABLE repracer_bench.${table} AS repracer_analytics.${source}`);
  for (let i = 0; i < ROWS; i += CHUNK) {
    const rows = Array.from({ length: Math.min(CHUNK, ROWS - i) }, (_, k) => make(i + k));
    await ch.insert(`repracer_bench.${table}`, rows);
  }
  await ch.query(`OPTIMIZE TABLE repracer_bench.${table} FINAL`);
}

async function measureClickHouse(table: string): Promise<TableResult['clickhouse'] & { rows: number }> {
  const [p] = await ch.rows<{ rows: number; on_disk: number; compressed: number; uncompressed: number }>(
    `SELECT sum(rows) AS rows, sum(bytes_on_disk) AS on_disk, sum(data_compressed_bytes) AS compressed, sum(data_uncompressed_bytes) AS uncompressed
       FROM system.parts WHERE database = 'repracer_bench' AND table = '${table}' AND active`);
  const columns = await ch.rows<{ name: string; compressed: number; uncompressed: number }>(
    `SELECT name, data_compressed_bytes AS compressed, data_uncompressed_bytes AS uncompressed FROM system.columns
      WHERE database = 'repracer_bench' AND table = '${table}' ORDER BY data_compressed_bytes DESC LIMIT 6`);
  const rows = Number(p!.rows);
  return {
    rows, bytesOnDisk: Number(p!.on_disk), compressed: Number(p!.compressed), uncompressed: Number(p!.uncompressed),
    bytesPerRow: Math.round((Number(p!.on_disk) / rows) * 10) / 10, compressionRatio: Math.round((Number(p!.uncompressed) / Number(p!.compressed)) * 10) / 10,
    topColumns: columns.map((c) => ({ column: c.name, compressed: Number(c.compressed), uncompressed: Number(c.uncompressed) })),
  };
}

async function measurePostgres(source: string, target: string, make: (i: number) => PgRow): Promise<NonNullable<TableResult['postgres']>> {
  await pgAdmin.query(`CREATE SCHEMA IF NOT EXISTS bench_size`);
  await pgAdmin.query(`DROP TABLE IF EXISTS bench_size.${target}`);
  await pgAdmin.query(`CREATE TABLE bench_size.${target} (LIKE ${source} INCLUDING DEFAULTS INCLUDING INDEXES INCLUDING GENERATED INCLUDING STORAGE INCLUDING COMPRESSION)`);
  const { rows: cols } = await pgAdmin.query(
    `SELECT column_name, column_default FROM information_schema.columns
       WHERE table_schema = 'bench_size' AND table_name = $1 AND is_generated = 'NEVER' ORDER BY ordinal_position`, [target]);
  /**
   * Замер называет ТОЛЬКО те столбцы, которые генератор действительно заполняет. Перечислять все — значит подставлять в
   * новый NOT NULL столбец NULL вместо его умолчания: шаг 41 добавил `price_decision.shadow` со значением по умолчанию, и
   * замер сжатия упал строкой «null value in column "shadow"», хотя сама таблица такую вставку принимает. Столбец, которого
   * генератор не знает, берёт своё умолчание; столбец БЕЗ умолчания замер по-прежнему назовёт — и вставка честно откажет,
   * потому что тогда генератор обязан его заполнять.
   */
  let names = '';
  for (let i = 0; i < PG_ROWS; i += 5_000) {
    const batch = Array.from({ length: Math.min(5_000, PG_ROWS - i) }, (_, k) => make(i + k));
    if (names === '') {
      // Ключи берутся у ПЕРВОЙ строки партии, а не у отдельного вызова генератора: генератор держит состояние (seed, series),
      // и лишний вызов сдвинул бы данные замера.
      const filled = new Set(Object.keys(batch[0]!));
      const skipped = cols.filter((c) => !filled.has(c.column_name) && c.column_default !== null).map((c) => c.column_name);
      names = cols.filter((c) => filled.has(c.column_name) || c.column_default === null).map((c) => `"${c.column_name}"`).join(', ');
      if (skipped.length > 0) console.log(`  ${target}: столбцы со своим умолчанием, не заполняемые генератором: ${skipped.join(', ')}`);
    }
    await pgAdmin.query(`INSERT INTO bench_size.${target} (${names}) SELECT ${names} FROM json_populate_recordset(NULL::bench_size.${target}, $1::json)`, [JSON.stringify(batch)]);
  }
  await pgAdmin.query(`VACUUM ANALYZE bench_size.${target}`);
  const { rows: [s] } = await pgAdmin.query(
    `SELECT pg_total_relation_size($1::regclass) AS total, pg_relation_size($1::regclass) AS heap, pg_indexes_size($1::regclass) AS idx,
            coalesce(pg_total_relation_size(nullif(reltoastrelid, 0)), 0) AS toast
       FROM pg_class WHERE oid = $1::regclass`, [`bench_size.${target}`]);
  return {
    rows: PG_ROWS, totalBytes: Number(s.total), heapBytes: Number(s.heap), indexBytes: Number(s.idx), toastBytes: Number(s.toast),
    bytesPerRow: Math.round((Number(s.total) / PG_ROWS) * 10) / 10,
  };
}

async function main() {
  const version = (await ch.query('SELECT version()')).trim();
  await ch.query('CREATE DATABASE IF NOT EXISTS repracer_bench');
  const pairs = (i: number) => decisionPair(i);
  const only = args.only ? new Set(args.only.split(',')) : null;
  const plan: Array<{ table: string; source?: string; make: (i: number) => PgRow; pg?: { source: string; make: (i: number) => PgRow } }> = [
    { table: 'competitor_snapshot_kaufland', source: 'competitor_snapshot', make: (i) => snapshotSeries('KAUFLAND', i) },
    { table: 'competitor_snapshot_amazon', source: 'competitor_snapshot', make: (i) => snapshotSeries('AMAZON', i) },
    { table: 'price_decision', make: (i) => priceDecisionRow(pairs(i).decision), pg: { source: 'channel_data.price_decision', make: (i) => pairs(i).decision } },
    { table: 'price_intent', make: (i) => { const p = pairs(i); return priceIntentRow(p.intent, p.decision.intent_class); }, pg: { source: 'channel_data.price_intent', make: (i) => pairs(i).intent } },
    { table: 'channel_write_completed', make: (i) => completedWriteRow(completedWrite(i)), pg: { source: 'tenant_data.channel_write_history', make: completedWrite } },
    { table: 'competitor_snapshot', make: competitorSnapshot },
    { table: 'channel_observation', make: observation },
  ];
  const results: TableResult[] = [];
  for (const step of plan.filter((p) => !only || only.has(p.table))) {
    seed = 0x9e3779b9;
    series.clear();
    const started = Date.now();
    await loadClickHouse(step.table, step.make, step.source);
    const measured = await measureClickHouse(step.table);
    // Замер по неполной таблице не выдаётся за результат: TTL или отказ вставки — провал замера
    if (measured.rows !== ROWS) throw new Error(`${step.table}: ${measured.rows} rows in ClickHouse after loading ${ROWS}`);
    seed = 0x9e3779b9;
    const postgres = step.pg ? await measurePostgres(step.pg.source, step.table, step.pg.make) : null;
    const adr = ADR_0004_ROWS[step.table];
    const gb = adr ? (adr.rows * measured.bytesPerRow) / 1e9 : 0;
    const { rows, ...clickhouse } = measured;
    const result: TableResult = {
      table: step.table, rows, clickhouse, postgres,
      pgToClickHouse: postgres ? Math.round((postgres.bytesPerRow / measured.bytesPerRow) * 10) / 10 : null,
      perClient18Months: adr ? { rows: adr.rows, gb: Math.round(gb * 10) / 10, eurPerMonth: Math.round(gb * EUR_PER_GB_MONTH * 100) / 100, step4EstimateGb: adr.estimateGb } : null,
    };
    results.push(result);
    console.log(`${step.table.padEnd(26)} CH ${String(result.clickhouse.bytesPerRow).padStart(7)} B/row (×${result.clickhouse.compressionRatio})  PG ${String(postgres?.bytesPerRow ?? '-').padStart(7)} B/row  PG/CH ×${result.pgToClickHouse ?? '-'}  18 мес ${result.perClient18Months?.gb ?? '-'} ГБ (оценка ${adr?.estimateGb.join('–') ?? '-'})  ${Math.round((Date.now() - started) / 1000)} с`);
  }
  // Шаг 24 [Р-122]: объём снимков на клиента в год по измеренному размеру строки и модели снимков (допущения — VOLUME_SCENARIOS)
  const snapshotVolume = results.filter((r) => r.table.startsWith('competitor_snapshot_')).map((r) => ({
    table: r.table, bytesPerRow: r.clickhouse.bytesPerRow, compressionRatio: r.clickhouse.compressionRatio,
    scenarios: VOLUME_SCENARIOS.map((v) => {
      const rows = snapshotsPerYear(v);
      const gb = (rows * r.clickhouse.bytesPerRow) / 1e9;
      return { ...v, snapshotsPerYear: rows, gbPerYear: Math.round(gb * 10) / 10, gbAt18Months: Math.round(gb * 1.5 * 10) / 10, eurPerMonthAt18Months: Math.round(gb * 1.5 * EUR_PER_GB_MONTH * 100) / 100 };
    }),
  }));
  for (const v of snapshotVolume) console.log(`${v.table}: ${v.scenarios.map((s) => `${s.name} ${s.snapshotsPerYear} снимков/год → ${s.gbPerYear} ГБ/год`).join('; ')}`);
  const totalGb = results.reduce((a, r) => a + (r.perClient18Months?.gb ?? 0), 0);
  const output = {
    format: 'repracer.bench/clickhouse-compression/v1', clickhouse: version, rowsPerTable: ROWS, pgRowsPerTable: PG_ROWS, tenants: TENANTS, scopesPerTenant: SCOPES_PER_TENANT, days: DAYS,
    eurPerGbMonth: EUR_PER_GB_MONTH, results, snapshotVolume,
    perClient18Months: { measuredTablesGb: Math.round(totalGb * 10) / 10, eurPerMonth: Math.round(totalGb * EUR_PER_GB_MONTH * 100) / 100, notMeasured: ['channel_write_response (оценка шага 4: 8–15 ГБ)', 'fee_actual (< 1 ГБ)'] },
  };
  console.log(JSON.stringify(output.perClient18Months));
  if (args.out) writeFileSync(args.out, JSON.stringify(output, null, 2));
  await pgAdmin.end();
}

main().catch(async (error) => {
  console.error(error);
  await pgAdmin.end().catch(() => undefined);
  process.exit(1);
});
