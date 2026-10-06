import type { AdapterCallContext, AdapterDependencies } from '@repracer/channel-port';
import { createPricingPipeline, type MemorySeedScope } from '@repracer/pricing-pipeline';
import { createPool, PgPricingStore, PgShadowStore, seedPricingWorld, translateStore, type PgPool, type SeededPricingWorld } from '@repracer/pricing-store-pg';
import { createIsolatedDatabase, requireEnv, type IsolatedDatabase } from '../../../../packages/pricing-store-pg/test/isolated-db.ts';
import { VirtualClock } from '../harness/world.ts';
import { AMAZON_SIM_DESCRIPTOR_US, AMAZON_US, SimulatedAmazonPort } from '../simulator/amazon-port.ts';
import type { Catalog, CatalogRow } from './catalog.ts';

/**
 * Шаг 71: одноразовый мир kill-test — витрина amazon.com в ТЕНИ [Р-169] на отдельной базе из шаблона, каталог клиента вместо
 * синтетического. Путь решения настоящий: те же стражи, проверка входов, движок стратегий, Price Gate и границы, что у продавца; в
 * канал не уходит ничего — запись рождается удержанной тенью.
 *
 * Чего в файле клиента нет и что поэтому ПРИНЯТО (отчёт называет каждое допущение словами):
 *  - границы — от нынешней цены: `min_price` на minPct ниже, `max_price` на maxPct выше [Р-43: без обеих движок не включается];
 *  - пол маржи — себестоимость + комиссия Amazon (feePct) + маржа marginPct; без себестоимости движок не стартует вовсе [Р-131] —
 *    такие товары остаются выключенными (или идут с допущенной себестоимостью assumeCostPct, если её попросили явно);
 *  - конкуренты — модель порта Amazon [Р-113]: у каждого товара один конкурент около его цены, который сползает ниже пола и
 *    возвращается ступенями не круче 20 % (иначе снимок честно отвергает проверка входов [Р-42]); фаза у каждого своя — рынок не
 *    движется единым сдвигом [Р-50]. Конкурентов клиента мы не видим, пока он не подключит аккаунт;
 *  - стратегия — «на цент ниже самого дешёвого конкурента», в пределах границ.
 */

export interface KilltestOptions {
  /** Виртуальных часов тени */
  hours: number;
  /** Конкурент меняет цену раз в столько минут */
  competitorEveryMinutes: number;
  minPct: number;
  maxPct: number;
  marginPct: number;
  feePct: number;
  /** null — товары без себестоимости не идут в движок [Р-131]; число — допущенная себестоимость, доля цены в процентах */
  assumeCostPct: number | null;
  /** Больше товаров — дольше прогон: берутся самые продаваемые (или первые по файлу) */
  maxProducts: number;
  /** Р-208 (шаг 73): предел шага цены в процентах — подъём к полу больше предела идёт лестницей; null — предела нет */
  stepPct: number | null;
}

export const DEFAULT_OPTIONS: KilltestOptions = { hours: 12, competitorEveryMinutes: 60, minPct: 15, maxPct: 30, marginPct: 10, feePct: 15, assumeCostPct: null, maxProducts: 2000, stepPct: null };

/** Ступени конкурента относительно цены клиента: спуск ниже пола (−15 % по умолчанию) и возврат; каждая ступень не круче 20 % */
export const COMPETITOR_RAMP = [0.99, 0.94, 0.88, 0.82, 0.76, 0.82, 0.88, 0.94, 0.99, 1.04, 1.09, 1.04] as const;

export interface KilltestProduct {
  row: CatalogRow;
  /** Идентификаторы посева (переводятся в базу через seeded.ids) */
  writeScopeId: string;
  /** Как вошёл в прогон: своя себестоимость, допущенная, или не вошёл в движок — без себестоимости */
  costSource: 'FILE' | 'ASSUMED' | 'NONE';
  costMinor: number | null;
  minMinor: number;
  maxMinor: number;
}

export interface KilltestWorld {
  db: IsolatedDatabase;
  seeded: SeededPricingWorld;
  store: PgPricingStore;
  shadow: PgShadowStore;
  products: KilltestProduct[];
  /** Товары файла, не вошедшие в прогон из-за предела maxProducts */
  skippedByLimit: CatalogRow[];
  clock: VirtualClock;
  alerts: Array<{ code: string; severity: string }>;
  snapshots: number;
  /** Вызовы записи у модели порта: в тени их быть не должно ни одного (отчёт с ненулём не пишется) */
  portWriteCalls(): number;
  dbScopeId(p: KilltestProduct): string;
  close(keep: boolean): Promise<void>;
}

const TENANT = '10000000-0000-4000-8000-00000000a071';
const ACCOUNT = '20000000-0000-4000-8000-00000000a071';
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/**
 * Ревью шага 71, находка 10: база прогона несёт каталог клиента, поэтому её имя несёт время создания (`killtest_<время base36>_<hex>`),
 * а каждый запуск удаляет базы прогонов старше суток — прерванный прогон, упавший процесс или забытый `--keep` не оставляют данных
 * клиента дольше суток. Прерывание (SIGINT, SIGTERM) удаляет базу сразу — это делает main.ts через `onDatabase`
 */
export const KILLTEST_DB_PATTERN = /^killtest_([0-9a-z]+)_[0-9a-f]{8}$/;
export const KILLTEST_DB_STALE_MS = 24 * HOUR_MS;

export async function dropStaleKilltestDatabases(nowMs: number = Date.now()): Promise<string[]> {
  const admin = createPool(requireEnv('REPRACER_PG_ADMIN_URL'), { max: 1, applicationName: 'repracer-killtest-cleanup' });
  const dropped: string[] = [];
  try {
    const { rows } = await admin.query<{ datname: string }>(`SELECT datname FROM pg_database WHERE datname LIKE 'killtest\\_%'`);
    for (const { datname } of rows) {
      const m = KILLTEST_DB_PATTERN.exec(datname);
      if (!m || nowMs - parseInt(m[1]!, 36) <= KILLTEST_DB_STALE_MS) continue;
      // Имя проверено шаблоном выше — только [a-z0-9_]
      await admin.query(`DROP DATABASE IF EXISTS ${datname} WITH (FORCE)`);
      dropped.push(datname);
    }
  } finally {
    await admin.end();
  }
  return dropped;
}

/** Товары прогона: самые продаваемые за 30 дней, а без продаж — по порядку файла */
export function selectProducts(catalog: Catalog, options: KilltestOptions): { chosen: CatalogRow[]; skipped: CatalogRow[] } {
  const ordered = [...catalog.rows].sort((a, b) => (b.sales30d ?? -1) - (a.sales30d ?? -1) || a.line - b.line);
  return { chosen: ordered.slice(0, options.maxProducts), skipped: ordered.slice(options.maxProducts) };
}

export function productOf(row: CatalogRow, i: number, options: KilltestOptions): KilltestProduct {
  const costSource = row.costMinor !== null ? 'FILE' : options.assumeCostPct !== null ? 'ASSUMED' : 'NONE';
  const costMinor = row.costMinor ?? (options.assumeCostPct !== null ? Math.max(1, Math.round(row.priceMinor * options.assumeCostPct / 100)) : null);
  return {
    row, writeScopeId: `ws-kt-${i}`, costSource, costMinor,
    minMinor: Math.max(1, Math.floor(row.priceMinor * (100 - options.minPct) / 100)),
    maxMinor: Math.ceil(row.priceMinor * (100 + options.maxPct) / 100),
  };
}

export async function buildKilltestWorld(catalog: Catalog, options: KilltestOptions, log: (line: string) => void = () => undefined,
  hooks: { onDatabase?: (db: IsolatedDatabase) => void } = {}): Promise<KilltestWorld> {
  // Регион базы и тенанта — US: клиент amazon.com, регион хранения — место клиента [Р-60] (шаг 72, находка 26 ревью шага 71). База
  // прогона одноразовая — данные клиента удаляются вместе с ней в конце прогона (если не попросили оставить)
  const db = await createIsolatedDatabase(`killtest_${Date.now().toString(36)}`, { region: 'US' });
  hooks.onDatabase?.(db);
  log(`temporary database ${db.name}`);
  // Пулы ведёт сама база прогона: drop() и endPools() закрывают их ровно один раз
  const pool = (role: Parameters<IsolatedDatabase['pool']>[0], max = 4): PgPool => db.pool(role, max);
  try {
    const appPool = pool('svc_app');
    const adminPool = pool('svc_admin');
    const { chosen, skipped } = selectProducts(catalog, options);
    const products = chosen.map((row, i) => productOf(row, i, options));
    const startMs = Date.now() - options.hours * HOUR_MS - 10 * MINUTE_MS;
    const clock = new VirtualClock(new Date(startMs).toISOString());
    // Решения ложатся в прошлые сутки: их секции создаёт та же функция базы, что планировщик (как прожатая неделя демо, K7)
    const scheduler = pool('svc_scheduler', 1);
    for (let at = startMs; at <= Date.now() + HOUR_MS; at += 12 * HOUR_MS) await scheduler.query('SELECT maintenance.ensure_partitions($1::timestamptz)', [new Date(at).toISOString()]);
    const asinOf = (p: KilltestProduct, i: number) => (p.row.asin && /^[A-Z0-9]{10}$/.test(p.row.asin) ? p.row.asin : `B0KT${String(i).padStart(6, '0')}`);
    const strategy = { strategyId: 'st-kt-beat-lowest', version: 1,
      params: { type: 'BEAT_LOWEST' as const, undercutMinor: 1, scope: 'VISIBLE_TOP_N' as const, compareLanded: false, atBound: 'CAP' as const }, deadbandMinor: 0 };
    const scopes: MemorySeedScope[] = products.map((p, i) => ({
      writeScopeId: p.writeScopeId, productId: `prod-kt-${i}`, ...(p.row.title ? { title: p.row.title.slice(0, 200) } : {}),
      channelAccountId: ACCOUNT, marketplace: AMAZON_US, externalUnitId: p.row.sku, channelProductRef: asinOf(p, i), condition: 'new',
      currency: 'USD', basis: 'NET', taxRegime: 'SALES_TAX_EXCLUDED',
      // Р-131: без себестоимости движок не включается — база отказала бы, и товар честно остаётся выключенным
      pricingMode: p.costMinor !== null ? 'ENGINE' : 'OFF', strategy: p.costMinor !== null ? strategy : null,
      currentPriceMinor: p.row.priceMinor,
      minPrice: { amountMinor: p.minMinor, id: `min-kt-${i}` }, maxPrice: { amountMinor: p.maxMinor, id: `max-kt-${i}` },
      cost: p.costMinor !== null
        ? { currency: 'USD', costProfileId: `cp-kt-${i}`, unitCostMinor: p.costMinor, fixedFeeMinor: 0, feeRateBp: Math.round(options.feePct * 100), tax: { regime: 'SALES_TAX_EXCLUDED' } }
        : null,
      ...(p.costMinor !== null ? { guardrails: { minMarginBp: Math.round(options.marginPct * 100),
        ...(options.stepPct !== null ? { maxStepChangeBp: Math.round(options.stepPct * 100) } : {}) } } : {}),
    }));
    const engine = products.map((p, i) => ({ p, i })).filter(({ p }) => p.costMinor !== null);
    const firstPrice = (p: KilltestProduct, i: number) => Math.round(p.row.priceMinor * COMPETITOR_RAMP[i % COMPETITOR_RAMP.length]!);
    const seeded = await seedPricingWorld(appPool, {
      fixtureTenantId: TENANT, fixtureChannelAccountId: ACCOUNT, fixtureChannel: 'AMAZON', fixtureRegion: 'NA', fixtureExternalAccountId: 'A1SYNKILLTEST',
      marketplaces: [AMAZON_US], clock: clock.iso(), provisioningPool: pool('svc_provisioning', 1), tenantRegion: 'US', adminPool, writeMode: 'SHADOW',
      seed: {
        scopes, channel: 'AMAZON', region: 'NA', marketplaces: { [AMAZON_US]: { currency: 'USD', basis: 'NET' } },
        competitorState: Object.fromEntries(engine.map(({ p, i }) => [`${AMAZON_US}|${asinOf(p, i)}|new`,
          { observedAt: new Date(startMs - 10 * MINUTE_MS).toISOString(), buyboxMinor: firstPrice(p, i), lowestMinor: firstPrice(p, i) }])),
      },
    });
    log(`world seeded: ${products.length} products, ${engine.length} in the engine`);
    const alerts: KilltestWorld['alerts'] = [];
    const deps: AdapterDependencies = {
      accounts: { async verify(tenantId, channelAccountId) {
        if (channelAccountId !== ACCOUNT) return { ok: false, reason: 'NOT_FOUND' };
        if (tenantId !== TENANT) return { ok: false, reason: 'TENANT_MISMATCH' };
        return { ok: true, account: { tenantId, channelAccountId, channel: 'AMAZON', region: 'NA', externalAccountId: 'A1SYNKILLTEST', marketplaces: [AMAZON_US], credentialsRef: 'cred:killtest' } };
      } },
      credentials: { async get() { return {}; } },
      alerts: { async raise(alert) { alerts.push({ code: alert.code, severity: alert.severity }); } },
      logger: { log: () => undefined },
      now: () => clock.iso(),
    };
    const every = options.competitorEveryMinutes * MINUTE_MS;
    const steps = Math.ceil(options.hours * HOUR_MS / every) + 1;
    const port = new SimulatedAmazonPort({
      seed: 71, params: { anyOfferChanged: { delayMs: 30_000, lossShare: 0 } }, descriptor: AMAZON_SIM_DESCRIPTOR_US,
      skus: products.map((p, i) => ({ sku: p.row.sku, asin: asinOf(p, i), marketplaces: [AMAZON_US], priceMinor: p.row.priceMinor, quantity: p.row.quantity ?? 0 })),
      competitors: engine.map(({ p, i }) => ({
        sellerRef: `Simulated competitor ${i + 1}`, marketplace: AMAZON_US, asin: asinOf(p, i), priceMinor: firstPrice(p, i),
        schedule: Array.from({ length: steps }, (_, k) => ({
          // Сдвиг по товарам внутри шага — минутами: рынок не движется одним мгновением
          atOffsetMs: (k + 1) * every + (i % 50) * MINUTE_MS,
          priceMinor: Math.round(p.row.priceMinor * COMPETITOR_RAMP[(k + 1 + i) % COMPETITOR_RAMP.length]!),
        })),
      })),
    }, deps);
    // Любой вызов записи модели порта считается, даже отклонённый ею самой: в тени путь решения не должен звать запись вовсе
    let portWrites = 0;
    const dispatch = port.dispatch.bind(port);
    port.dispatch = async (...a: Parameters<typeof dispatch>) => { portWrites += a[1].items.length; return dispatch(...a); };
    const store = new PgPricingStore(appPool, { adminPool });
    const pipeline = createPricingPipeline({ store: translateStore(store, seeded.ids) as never, adapter: port, alerts: deps.alerts, logger: deps.logger, now: () => clock.iso() as never });
    const ctx = (): AdapterCallContext => ({ tenantId: TENANT as never, channelAccountId: ACCOUNT as never, correlationId: 'killtest', deadline: clock.iso(60_000) as never });
    let snapshots = 0;
    const endMs = startMs + options.hours * HOUR_MS;
    let reported = startMs;
    while (clock.nowMs() < endMs) {
      clock.advance(5 * MINUTE_MS);
      for (const snapshot of port.drainSnapshots()) {
        await pipeline.processSnapshot(ctx(), snapshot);
        snapshots += 1;
      }
      if (clock.nowMs() - reported >= 2 * HOUR_MS) { reported = clock.nowMs(); log(`${Math.round((clock.nowMs() - startMs) / HOUR_MS)} of ${options.hours} simulated hours, ${snapshots} competitor updates`); }
    }
    return {
      db, seeded, store, shadow: new PgShadowStore({ adminPool }), products, skippedByLimit: skipped, clock, alerts, snapshots,
      portWriteCalls: () => portWrites,
      dbScopeId: (p) => seeded.ids.dbId(p.writeScopeId),
      async close(keep) {
        if (keep) await db.endPools(); else await db.drop();
      },
    };
  } catch (error) {
    await db.drop().catch(() => undefined);
    throw error;
  }
}
