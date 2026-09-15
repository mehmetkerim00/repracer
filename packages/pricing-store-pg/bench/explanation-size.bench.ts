import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import type { AdapterCallContext, ChannelAdapter, CompetitorSnapshot, FieldWrite } from '@repracer/channel-port';
import { createPricingPipeline, type MemorySeedScope } from '@repracer/pricing-pipeline';
import { createPool, inTenant, PgPricingStore, seedPricingWorld, type PgPool } from '../src/index.ts';

/**
 * Замер размера слепка объяснения (шаги 13–14): реальный путь решения на PostgreSQL в темпе пика шага 9 (185 оценок/с).
 * Генератор с разбросом (шаг 14, находка ревьюера 7): детерминированный PRNG с зерном; себестоимость, комиссии, НДС, границы,
 * стратегии и их параметры, минимальная маржа, число конкурентов и глубина истории — разные у каждого предложения; цены
 * конкурентов — случайное блуждание с ярусами волатильности [Р-47], выбросы ±30 %. Доли классов intent не задаются,
 * а получаются из процесса и измеряются. Итог — байты на строку по классам, прирост таблиц с индексами, gzip и brotli ядра.
 * Данные синтетические. REPRACER_PG_URL — роль приложения; BENCH_EVALUATIONS (12000), BENCH_RATE (185), BENCH_SEED (14), BENCH_OUT.
 */

const APP_URL = process.env.REPRACER_PG_URL;
if (!APP_URL) throw new Error('REPRACER_PG_URL is required');
const EVALUATIONS = Number(process.env.BENCH_EVALUATIONS ?? 12_000);
const RATE = Number(process.env.BENCH_RATE ?? 185);
const SEED = Number(process.env.BENCH_SEED ?? 14);
const SCOPES = 400;
const WORKERS = 8;
const ACCOUNT = '20000000-0000-4000-8000-000000000141';

/** mulberry32: воспроизводимая последовательность при том же зерне */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = prng(SEED);
const between = (lo: number, hi: number) => lo + rnd() * (hi - lo);
const int = (lo: number, hi: number) => Math.floor(between(lo, hi + 1));
const pick = <T,>(items: readonly T[]) => items[Math.floor(rnd() * items.length)]!;
const gauss = () => Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());
const day = (offset: number) => new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);

type Tier = 'HOT' | 'WARM' | 'COLD';
/**
 * Ярусы опроса [Р-47]. move — вероятность, что рынок сдвинулся между двумя наблюдениями (предположение: опрос и уведомления
 * чаще приносят тот же рынок, особенно в холодном ярусе); sigma — размер сдвига; weight — частота опроса.
 */
const TIERS: Record<Tier, { share: number; move: number; sigma: number; weight: number }> = {
  HOT: { share: 0.2, move: 0.6, sigma: 0.02, weight: 6 },
  WARM: { share: 0.5, move: 0.25, sigma: 0.005, weight: 2 },
  COLD: { share: 0.3, move: 0.1, sigma: 0.001, weight: 1 },
};

interface Offer {
  scope: MemorySeedScope;
  tier: Tier;
  cost: number;
  market: number;
  offers: number;
  selfWins: number;
}

function offer(i: number): Offer {
  const marketplace = rnd() < 0.8 ? 'de' : 'at';
  const cost = Math.round(Math.exp(between(Math.log(300), Math.log(20_000))));
  const feeRateBp = int(700, 1500);
  const fixedFeeMinor = pick([0, 0, 0, 25, 50]);
  const vatRateBp = marketplace === 'at' ? 2000 : rnd() < 0.15 ? 700 : 1900;
  const minMinor = Math.round(cost * between(1.15, 1.5));
  const maxMinor = Math.round(minMinor * between(2, 4));
  const market = Math.round(between(minMinor * 1.05, maxMinor * 0.7));
  const r = rnd();
  const kind = r < 0.45 ? 'MATCH_BUYBOX' : r < 0.75 ? 'BEAT_LOWEST' : r < 0.9 ? 'TARGET_MARGIN' : 'FIXED';
  const atBound = rnd() < 0.8 ? 'CAP' as const : 'HOLD' as const;
  const params = kind === 'MATCH_BUYBOX' ? { type: kind, undercutMinor: pick([0, 1, 5, 10, 25]), holdWhenWinning: rnd() < 0.6, atBound }
    : kind === 'BEAT_LOWEST' ? { type: kind, undercutMinor: pick([1, 5, 10, 20]), scope: 'VISIBLE_TOP_N' as const, compareLanded: false, atBound }
      : kind === 'TARGET_MARGIN' ? { type: kind, targetMarginBp: int(1500, 3500) } : { type: kind, priceMinor: Math.round(between(minMinor, maxMinor * 0.8)) };
  const tierRoll = rnd();
  const tier: Tier = tierRoll < TIERS.HOT.share ? 'HOT' : tierRoll < TIERS.HOT.share + TIERS.WARM.share ? 'WARM' : 'COLD';
  const minMarginBp = rnd() < 0.4 ? null : int(500, 1500);
  return {
    tier, cost, market, offers: int(1, 6), selfWins: rnd() < 0.25 ? 0.5 : 0.05,
    scope: {
      writeScopeId: `ws-${i}`, productId: `prod-${i}`, channelAccountId: ACCOUNT, marketplace, externalUnitId: String(14_000 + i),
      channelProductRef: `3614${String(i).padStart(5, '0')}`, condition: 'new', gtin: null, currency: 'EUR', basis: 'GROSS', pricingMode: 'ENGINE',
      strategy: { strategyId: `st-${i % 60}`, version: 1, params, deadbandMinor: pick([0, 0, 5, 10, 25]) } as MemorySeedScope['strategy'],
      currentPriceMinor: Math.round(between(minMinor, maxMinor * 0.8)), minPrice: { amountMinor: minMinor, id: `min-${i}` }, maxPrice: { amountMinor: maxMinor, id: `max-${i}` },
      cost: { currency: 'EUR', costProfileId: `cp-${i}`, unitCostMinor: cost, fixedFeeMinor, feeRateBp, tax: { regime: 'VAT_INCLUDED', vatRateBp } },
      guardrails: minMarginBp === null ? {} : { guardrailIds: [`g-${i}`], minMarginBp },
    },
  };
}

function snapshot(o: Offer, current: number): CompetitorSnapshot {
  const money = (amountMinor: number) => ({ amountMinor, currency: 'EUR', basis: 'GROSS' as const });
  const selfWins = rnd() < o.selfWins;
  const competitors = Array.from({ length: o.offers }, (_, k) => Math.max(1, Math.round(o.market * (1 + k * between(0.005, 0.04)))));
  const all = [...competitors.map((p, k) => ({ p, self: false, seller: `synthetic-${o.scope.productId}-${k}` })), { p: current, self: true, seller: '' }]
    .sort((a, b) => a.p - b.p);
  const winner = selfWins ? all.find((x) => x.self)! : all.find((x) => !x.self)!;
  const ordered = [winner, ...all.filter((x) => x !== winner)];
  return {
    marketplace: o.scope.marketplace, channelProductRef: o.scope.channelProductRef, condition: 'new', source: pick(['KAUFLAND_BUYBOX', 'KAUFLAND_BUY_BOX_CHANGED']),
    observedAt: new Date().toISOString(), completeness: { kind: 'TOP_N', n: 10 }, buybox: { price: money(winner.p), isSelf: winner.self },
    offers: ordered.map((x, k) => (x.self ? { rank: k + 1, isSelf: true, price: money(x.p) } : { rank: k + 1, sellerRef: x.seller, isSelf: false, price: money(x.p) })),
  };
}

async function partitionBytes(pool: PgPool, table: string): Promise<number> {
  const { rows: [r] } = await pool.query(`SELECT coalesce(sum(pg_total_relation_size(relid)), 0)::bigint AS bytes FROM pg_partition_tree($1::regclass) WHERE isleaf`, [table]);
  return Number(r.bytes);
}

async function main(): Promise<void> {
  const pool = createPool(APP_URL!, { max: WORKERS + 4, applicationName: 'repracer-bench-explanation' });
  const offers = Array.from({ length: SCOPES }, (_, i) => offer(i));
  const competitorDaily: Record<string, Array<{ day: string; minMinor: number; maxMinor: number }>> = {};
  const competitorState: Record<string, { observedAt: string; buyboxMinor: number; lowestMinor: number }> = {};
  for (const o of offers) {
    const key = `${o.scope.marketplace}|${o.scope.channelProductRef}|new`;
    const days = int(7, 30);
    competitorDaily[key] = Array.from({ length: days }, (_, d) => {
      const center = o.market * (1 + gauss() * TIERS[o.tier].sigma * 3);
      return { day: day(d + 1), minMinor: Math.max(1, Math.round(center * 0.92)), maxMinor: Math.round(center * 1.08) };
    });
    competitorState[key] = { observedAt: new Date(Date.now() - 3_600_000).toISOString(), buyboxMinor: o.market, lowestMinor: o.market };
  }
  const world = await seedPricingWorld(pool, {
    fixtureTenantId: '10000000-0000-4000-8000-000000000141', fixtureChannelAccountId: ACCOUNT, marketplaces: ['de', 'at'], clock: new Date().toISOString(),
    seed: { scopes: offers.map((o) => o.scope), competitorDaily, competitorState },
  });

  const current = new Map(offers.map((o) => [world.ids.dbId(o.scope.writeScopeId), o.scope.currentPriceMinor!]));
  const adapter = {
    async planDispatch(_ctx: AdapterCallContext, writes: readonly FieldWrite[]) {
      return { batches: [{ batchId: randomUUID(), writes }], rejected: [] };
    },
    async dispatch(_ctx: AdapterCallContext, batch: { writes: FieldWrite[] }) {
      for (const w of batch.writes) if (w.value.field === 'PRICE') current.set(w.writeScope.writeScopeId, w.value.price.amountMinor);
      return { batchId: 'bench', outcomes: batch.writes.map((w) => ({ channelWriteId: w.channelWriteId, status: 'ACCEPTED', appliedImmediately: true })), attemptsMade: 1 };
    },
  } as unknown as ChannelAdapter;
  const alerts: Record<string, number> = {};
  const pipeline = createPricingPipeline({
    store: new PgPricingStore(pool), adapter,
    alerts: { raise: async (a: { code: string }) => { alerts[a.code] = (alerts[a.code] ?? 0) + 1; } } as never,
    logger: { log: () => undefined }, now: () => new Date().toISOString(),
  });
  const ctx = { tenantId: world.tenantId, channelAccountId: world.channelAccountId, correlationId: 'bench-explanation', deadline: new Date(Date.now() + 86_400_000).toISOString() } as AdapterCallContext;

  const tables = ['channel_data.price_decision', 'tenant_data.price_intent_core', 'channel_data.price_intent'];
  const before = Object.fromEntries(await Promise.all(tables.map(async (t) => [t, await partitionBytes(pool, t)] as const)));

  // Опрос по ярусам [Р-47]: горячие товары оцениваются чаще
  const weighted = offers.flatMap((o, i) => Array.from({ length: TIERS[o.tier].weight }, () => i));
  const verdicts: Record<string, number> = {};
  let started = 0;
  const busy = new Set<number>();
  const t0 = Date.now();
  const worker = async () => {
    while (started < EVALUATIONS) {
      const n = started++;
      const wait = t0 + (n * 1000) / RATE - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      let i = pick(weighted);
      for (let tries = 0; busy.has(i) && tries < 20; tries++) i = pick(weighted);
      if (busy.has(i)) continue;
      busy.add(i);
      const o = offers[i]!;
      // Случайное блуждание рынка; изредка выброс ±30 %
      if (rnd() < 0.01) o.market = Math.max(1, Math.round(o.market * pick([0.7, 1.3])));
      else if (rnd() < TIERS[o.tier].move) o.market = Math.max(1, Math.round(o.market * (1 + gauss() * TIERS[o.tier].sigma)));
      const ws = world.ids.dbId(o.scope.writeScopeId);
      try {
        const r = await pipeline.processSnapshot(ctx, snapshot(o, current.get(ws) ?? o.scope.currentPriceMinor!));
        const key = r.verdict === 'ACCEPT' ? `ACCEPT:${r.scopes[0]?.decision?.outcome ?? r.scopes[0]?.stages.at(-1)?.outcome ?? 'none'}` : `${r.verdict}:${r.reason?.code}`;
        verdicts[key] = (verdicts[key] ?? 0) + 1;
      } finally {
        busy.delete(i);
      }
    }
  };
  await Promise.all(Array.from({ length: WORKERS }, () => worker()));
  const seconds = (Date.now() - t0) / 1000;

  const after = Object.fromEntries(await Promise.all(tables.map(async (t) => [t, await partitionBytes(pool, t)] as const)));
  const stats = await inTenant(pool, world.tenantId, async (tx) => {
    const byClass = (await tx.query(
      `SELECT intent_class, count(*)::int AS rows, round(avg(pg_column_size(d.*)))::int AS row_bytes,
              round(avg(coalesce(pg_column_size(d.explanation), 0)))::int AS explanation_bytes,
              round(avg(coalesce(length(d.explanation::text), 0)))::int AS explanation_text
         FROM channel_data.price_decision d WHERE tenant_id = $1 GROUP BY 1 ORDER BY 1`, [world.tenantId])).rows;
    const core = (await tx.query(
      `SELECT intent_class, count(*)::int AS rows, round(avg(pg_column_size(c.*)))::int AS row_bytes,
              round(avg(pg_column_size(c.explanation)))::int AS explanation_bytes,
              round(avg(pg_column_size(c.explanation || '{}'::jsonb)))::int AS explanation_raw_bytes
         FROM tenant_data.price_intent_core c WHERE tenant_id = $1 GROUP BY 1 ORDER BY 1`, [world.tenantId])).rows;
    const intents = (await tx.query(`SELECT count(*)::int AS rows FROM channel_data.price_intent WHERE tenant_id = $1`, [world.tenantId])).rows[0].rows as number;
    const coreJson = (await tx.query(`SELECT row_to_json(c.*)::text AS j, c.explanation::text AS e FROM tenant_data.price_intent_core c WHERE tenant_id = $1 ORDER BY decided_at`, [world.tenantId])).rows as Array<{ j: string; e: string }>;
    return { byClass, core, intents, coreJson };
  });
  const decisionRows = stats.byClass.reduce((a: number, r: { rows: number }) => a + r.rows, 0);
  const coreRows = stats.core.reduce((a: number, r: { rows: number }) => a + r.rows, 0);
  const text = (lines: string[]) => Buffer.from(lines.join('\n'));
  const perRow = (bytes: number) => Math.round(bytes / Math.max(coreRows, 1));
  const shares = Object.fromEntries(stats.byClass.map((r: { intent_class: string; rows: number }) => [r.intent_class, Math.round((r.rows / Math.max(decisionRows, 1)) * 1000) / 1000]));
  const result = {
    measuredAt: new Date().toISOString(), seed: SEED, scopes: SCOPES,
    rate: RATE, evaluations: EVALUATIONS, seconds: Math.round(seconds), achievedRate: Math.round((EVALUATIONS / seconds) * 10) / 10,
    verdicts, alerts, classShares: shares,
    decision: { byClass: stats.byClass, rows: decisionRows, tableBytesPerRow: Math.round((after['channel_data.price_decision']! - before['channel_data.price_decision']!) / Math.max(decisionRows, 1)) },
    intent: { rows: stats.intents, tableBytesPerRow: Math.round((after['channel_data.price_intent']! - before['channel_data.price_intent']!) / Math.max(stats.intents, 1)) },
    core: {
      byClass: stats.core, rows: coreRows,
      tableBytesPerRow: Math.round((after['tenant_data.price_intent_core']! - before['tenant_data.price_intent_core']!) / Math.max(coreRows, 1)),
      gzipBytesPerRow: perRow(gzipSync(text(stats.coreJson.map((r) => r.j)), { level: 6 }).length),
      brotliBytesPerRow: perRow(brotliCompressSync(text(stats.coreJson.map((r) => r.j))).length),
      gzipExplanationBytesPerRow: perRow(gzipSync(text(stats.coreJson.map((r) => r.e)), { level: 6 }).length),
    },
  };
  const out = JSON.stringify(result, null, 2);
  console.log(out);
  if (process.env.BENCH_OUT) writeFileSync(process.env.BENCH_OUT, `${out}\n`);
  await pool.end();
}

await main();
