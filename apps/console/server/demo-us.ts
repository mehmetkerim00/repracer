import type { AdapterCallContext, AdapterDependencies } from '@repracer/channel-port';
import { systemClock } from '@repracer/channel-port';
import { createPricingPipeline } from '@repracer/pricing-pipeline';
import { inTenant, type PgPool, type PgPricingStore } from '@repracer/pricing-store-pg';
import { consoleAdapter } from './channel-descriptors.ts';

/**
 * Шаг 68 (K6): витрины США демо-тенанта СЧИТАЮТ тень — решения в долларах на EBAY_US и amazon.com, а не только на Kaufland в евро.
 * До шага 68 аккаунты США были «новорождёнными» после Connect: без себестоимости [Р-131], стратегии и границ, и тень по ним молчала.
 *
 * Что здесь настоящее, а что модель (данные синтетические [Р-151]):
 *  - конфигурация предложений — те же таблицы и стражи, что у продавца: себестоимость в USD, оценка комиссии, `min_price`/`max_price`,
 *    минимальная маржа, стратегия, режим ENGINE; аккаунты остаются в ТЕНИ [Р-169] — в канал не уходит ничего;
 *  - amazon.com: конкуренты — модель порта Amazon [Р-113] с уведомлениями ANY_OFFER_CHANGED; конкурент сползает ниже пола и возвращается
 *    (ступени не круче 20 %, иначе снимок честно отвергает проверка входов [Р-42]) — пол удерживает цену, и тень говорит деньгами [Р-173];
 *  - EBAY_US: конкурентов у eBay в бою мы не видим (Browse недоступен, Р-190), поэтому стратегия — от себестоимости (целевая маржа), и
 *    решение приносит пересчёт по расписанию, как у продавца [шаг 47].
 *
 * K7: «прожать» неделю — те же события, но на виртуальных часах с прошлого момента до сейчас, быстрее настоящего времени. Решения
 * ложатся в прошлые сутки, поэтому их секции создаёт та же функция базы, что планировщик (`maintenance.ensure_partitions`) с моментом в
 * прошлом; горячие намерения старше трёх суток [Р-28] затем удалит удаление по сроку — как у настоящего продавца через неделю тени.
 */

export interface DemoUsAccounts {
  tenantId: string;
  userId: string;
  ownerMembershipId: string;
  ebayAccountId: string;
  amazonAccountId: string;
}

export interface DemoUsMarket {
  /** Решения тени, принятые прожатой неделей: по каналу */
  pressed: { amazon: number; ebay: number; seconds: number } | null;
  stop(): void;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/** Цена конкурента меняется раз в два часа у каждого предложения; сдвиг по предложениям — 10 минут, фаза ступени — своя */
const COMPETITOR_STEP_MS = 2 * HOUR_MS;
/** Ступени конкурента amazon.com: спуск ниже пола (14,00) и возврат, каждая не круче 20 % [Р-42] */
const AMAZON_US_RAMP = [1800, 1500, 1250, 1050, 900, 1050, 1250, 1500] as const;
/** Сколько суток вперёд у модели расписание конкурентов: демо живёт, пока жив процесс */
const SCHEDULE_DAYS = 400;
/** Ход настоящего времени после прожатой недели */
const LIVE_TICK_MS = 30_000;
const EBAY_RECOMPUTE_EVERY_MS = 15 * MINUTE_MS;

interface UsScope { writeScopeId: string; productId: string; channelAccountId: string; marketplace: string; channelProductRef: string | null; sku: string }

/**
 * Себестоимость, комиссия, границы, маржа и стратегия — одной административной транзакцией владельца демо. Второй фактор — потому
 * что это массовая правка (окно Р-135: больше пяти предложений за десять минут): в демо её «сделал» владелец со вторым фактором.
 * `validFrom` — до начала прожатой недели: себестоимость действует на момент каждого решения [Р-131]
 */
async function configure(admin: PgPool, a: DemoUsAccounts, validFrom: string): Promise<UsScope[]> {
  const { demoTitle } = await import('@repracer/contract-tests/live');
  return inTenant(admin, a.tenantId, async (tx) => {
    const { rows } = await tx.query(
      `SELECT ws.write_scope_id, ws.product_id, ws.channel_account_id, om.marketplace, om.channel_product_ref, om.external_sku
         FROM tenant_data.write_scope ws
         JOIN tenant_data.offer_mapping om ON om.tenant_id = ws.tenant_id AND om.price_write_scope_id = ws.write_scope_id
        WHERE ws.tenant_id = $1 AND ws.channel_account_id = ANY ($2::uuid[]) AND ws.field = 'PRICE'
        ORDER BY om.external_sku`, [a.tenantId, [a.ebayAccountId, a.amazonAccountId]]);
    const scopes: UsScope[] = rows.map((r) => ({
      writeScopeId: r.write_scope_id, productId: r.product_id, channelAccountId: r.channel_account_id, marketplace: r.marketplace,
      channelProductRef: r.channel_product_ref, sku: r.external_sku,
    }));
    const strategy = async (name: string, type: string, params: Record<string, unknown>, undercutMinor: number | null) => {
      const { rows: [s] } = await tx.query(
        `INSERT INTO tenant_data.pricing_strategy (tenant_id, pricing_strategy_id, version, name, type, params, triggers, status, created_by_membership_id)
         VALUES ($1, gen_random_uuid(), 1, $2, $3, $4, $5, 'ACTIVE', $6) RETURNING pricing_strategy_id`,
        [a.tenantId, name, type, JSON.stringify({ ...params, deadbandMinor: 0 }), ['COMPETITOR_CHANGE', 'COST_CHANGE', 'SCHEDULE'], a.ownerMembershipId]);
      // Р-91: подрез — в таблице с 18-месячным сроком, а не в вечной версии стратегии
      if (undercutMinor !== null) {
        await tx.query(`INSERT INTO channel_data.pricing_strategy_undercut (tenant_id, pricing_strategy_id, version, undercut_minor) VALUES ($1, $2, 1, $3)`,
          [a.tenantId, s!.pricing_strategy_id, undercutMinor]);
      }
      return s!.pricing_strategy_id as string;
    };
    const margin = await strategy('Target margin 30%', 'TARGET_MARGIN', { type: 'TARGET_MARGIN', targetMarginBp: 3000 }, null);
    const beat = await strategy('Beat the lowest by 1 cent', 'BEAT_LOWEST',
      { type: 'BEAT_LOWEST', scope: 'VISIBLE_TOP_N', compareLanded: false, atBound: 'CAP' }, 1);
    for (const s of scopes) {
      const ebay = s.channelAccountId === a.ebayAccountId;
      const k = scopes.filter((x) => x.channelAccountId === s.channelAccountId).indexOf(s);
      /**
       * eBay: себестоимость от $6.00 до $11.50 — цена целевой маржи у дешёвых ниже `min_price` (пол держит $12.00), у дорогих выше нынешних
       * $19.99, и пол маржи ($8.43…$15.79) ниже нынешней цены у всех. amazon.com — $5.00: пол — `min_price` $14.00
       */
      const costMinor = ebay ? 600 + k * 50 : 500;
      const fee = ebay ? { feeRateBp: 1325, fixedFeeMinor: 30 } : { feeRateBp: 1500, fixedFeeMinor: 0 };
      await tx.query(
        `INSERT INTO tenant_data.cost_profile (tenant_id, product_id, channel_account_id, marketplace, version, valid_from, currency, purchase_cost_minor, source, created_by_membership_id)
         VALUES ($1, $2, $3, $4, 1, $5, 'USD', $6, 'MANUAL', $7)`,
        [a.tenantId, s.productId, s.channelAccountId, s.marketplace, validFrom, costMinor, a.ownerMembershipId]);
      await tx.query(
        `INSERT INTO channel_data.fee_estimate (tenant_id, write_scope_id, source, fee_model, fee_schedule_version, computed_at, valid_until)
         VALUES ($1, $2, 'FEE_SCHEDULE', $3, 'synthetic', $4, $4::timestamptz + interval '400 days')`,
        [a.tenantId, s.writeScopeId, JSON.stringify(fee), validFrom]);
      for (const [table, amount] of [['min_price', ebay ? 1200 : 1400], ['max_price', 5000]] as const) {
        await tx.query(
          `INSERT INTO tenant_data.${table} (tenant_id, scope_type, write_scope_id, currency, price_basis, amount_minor, is_active, version, created_by_membership_id)
           VALUES ($1, 'WRITE_SCOPE', $2, 'USD', 'NET', $3, true, 1, $4)`, [a.tenantId, s.writeScopeId, amount, a.ownerMembershipId]);
      }
      await tx.query(
        `INSERT INTO tenant_data.guardrail (tenant_id, scope_type, write_scope_id, min_margin_bp, on_violation, version, created_by_membership_id)
         VALUES ($1, 'WRITE_SCOPE', $2, 1200, 'HOLD', 1, $3)`, [a.tenantId, s.writeScopeId, a.ownerMembershipId]);
      // Шаг 68 (K10): название товара — синтетическое, как у Kaufland демо; обнаружение каталога названий не пишет
      await tx.query(`UPDATE tenant_data.product SET title = $3 WHERE tenant_id = $1 AND product_id = $2`, [a.tenantId, s.productId, demoTitle(ebay ? 20 + k : 40 + k)]);
      // Нынешняя цена на витрине — как прочитало бы обнаружение: $19.99 у eBay, $18.50 у amazon.com
      await tx.query(
        `INSERT INTO channel_data.observed_channel_state (tenant_id, write_scope_id, field, observed_amount_minor, observed_at, received_at, source, sync_status)
         VALUES ($1, $2, 'PRICE', $3, $4, $4, 'READBACK', 'IN_SYNC')`, [a.tenantId, s.writeScopeId, ebay ? 1999 : 1850, validFrom]);
      await tx.query(
        `UPDATE tenant_data.write_scope SET pricing_mode = 'ENGINE', pricing_strategy_id = $3, pricing_strategy_version = 1
          WHERE tenant_id = $1 AND write_scope_id = $2`, [a.tenantId, s.writeScopeId, ebay ? margin : beat]);
    }
    return scopes;
  }, a.userId, { mfa: true });
}

export async function startDemoUsMarket(input: {
  pools: { admin: PgPool; scheduler: PgPool };
  store: PgPricingStore;
  accounts: DemoUsAccounts;
  /** Сколько суток прожать до настоящего момента; 0 — тень США считает с запуска */
  pressDays: number;
  log: (message: string) => void;
}): Promise<DemoUsMarket> {
  const { pools, store, accounts: a, log } = input;
  const { SimulatedAmazonPort, AMAZON_SIM_DESCRIPTOR_US, AMAZON_US } = await import('@repracer/contract-tests/simulator');
  const realStart = systemClock.nowMs();
  const begin = realStart - input.pressDays * DAY_MS;
  /** Часы мира США: виртуальные, пока идёт прожатая неделя, затем настоящие */
  let virtualMs: number | null = input.pressDays > 0 ? begin : null;
  const nowIso = () => (virtualMs === null ? systemClock.now() : new Date(virtualMs).toISOString());

  if (input.pressDays > 0) {
    // Секции прошлых суток — функцией планировщика с моментом каждых суток недели (до неё секций старше вчерашних нет)
    for (let d = input.pressDays; d >= 0; d--) {
      await pools.scheduler.query('SELECT maintenance.ensure_partitions($1::timestamptz)', [new Date(realStart - d * DAY_MS).toISOString()]);
    }
  }
  const scopes = await configure(pools.admin, a, new Date(begin - DAY_MS).toISOString());
  const amazonScopes = scopes.filter((s) => s.channelAccountId === a.amazonAccountId);

  /**
   * Алерты демо США — в памяти процесса, как у Kaufland демо: строка алерта в базе ушла бы доставкой письмом на синтетический адрес
   * владельца демо [Р-156]. Сколько их было — в журнал строкой прожатой недели
   */
  let alertCount = 0;
  const alerts = { raise: async () => { alertCount += 1; } };
  const deps: AdapterDependencies = {
    accounts: { async verify(tenantId, channelAccountId) {
      if (channelAccountId !== a.amazonAccountId) return { ok: false, reason: 'NOT_FOUND' };
      if (tenantId !== a.tenantId) return { ok: false, reason: 'TENANT_MISMATCH' };
      return { ok: true, account: { tenantId, channelAccountId, channel: 'AMAZON', region: 'NA', externalAccountId: 'synthetic', marketplaces: [AMAZON_US], credentialsRef: 'secret-ref:synthetic' } };
    } },
    credentials: { async get() { return {}; } },
    alerts,
    logger: { log: () => undefined },
    now: nowIso,
  };
  const steps = Math.floor(SCHEDULE_DAYS * DAY_MS / COMPETITOR_STEP_MS);
  const port = new SimulatedAmazonPort({
    seed: 68, params: { anyOfferChanged: { delayMs: 30_000, lossShare: 0 } }, descriptor: AMAZON_SIM_DESCRIPTOR_US,
    skus: amazonScopes.map((s) => ({ sku: s.sku, asin: s.channelProductRef!, marketplaces: [AMAZON_US], priceMinor: 1850, quantity: 5 })),
    competitors: amazonScopes.map((s, i) => ({
      sellerRef: `Synthetic US competitor ${i + 1}`, marketplace: AMAZON_US, asin: s.channelProductRef!, priceMinor: 1800,
      // Фаза ступени — своя у каждого предложения: в один момент рынок движется вразброс, а не единым сдвигом [Р-50]
      schedule: Array.from({ length: steps }, (_, k) => ({ atOffsetMs: (k + 1) * COMPETITOR_STEP_MS + i * 10 * MINUTE_MS, priceMinor: AMAZON_US_RAMP[(k + i) % AMAZON_US_RAMP.length]! })),
    })),
  }, deps);
  const amazon = createPricingPipeline({ store: store as never, adapter: port, alerts, logger: deps.logger, now: nowIso as never });
  const ebay = createPricingPipeline({ store: store as never, adapter: consoleAdapter('EBAY'), alerts, logger: deps.logger, now: nowIso as never });
  const ctx = (channelAccountId: string): AdapterCallContext => ({
    tenantId: a.tenantId as never, channelAccountId: channelAccountId as never, correlationId: 'console-demo-us', deadline: new Date(Date.parse(nowIso()) + MINUTE_MS).toISOString() as never,
  });
  const counts = { amazon: 0, ebay: 0 };
  const deliver = async () => {
    for (const snapshot of port.drainSnapshots()) {
      await amazon.processSnapshot(ctx(a.amazonAccountId), snapshot);
      counts.amazon += 1;
    }
  };
  const recomputeEbay = async () => { counts.ebay += (await ebay.recomputeScheduled(ctx(a.ebayAccountId), { limit: 100 })).scopes; };

  let pressed: DemoUsMarket['pressed'] = null;
  if (virtualMs !== null) {
    // Ревью шага 68, находка 8: сбой одного шага прожатия не роняет посев демо (и старт консоли) — считается и называется числом
    let failures = 0;
    for (let t = begin; t <= realStart; t += MINUTE_MS) {
      virtualMs = t;
      try {
        await deliver();
        if ((t - begin) % HOUR_MS === 0) await recomputeEbay();
      } catch (error) {
        failures += 1;
        if (failures === 1) log(`demo US press step failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (failures > 0) log(`demo US press: ${failures} failed steps`);
    virtualMs = null;
    pressed = { amazon: counts.amazon, ebay: counts.ebay, seconds: Math.round((systemClock.nowMs() - realStart) / 100) / 10 };
    log(`demo US week pressed: ${input.pressDays} days, amazon.com snapshots ${pressed.amazon}, eBay US recomputed ${pressed.ebay}, alerts kept in memory ${alertCount}, ${pressed.seconds} s`);
  }

  // Дальше — настоящее время: снимки по сроку доставки, пересчёт eBay по расписанию (должные — без решения за сутки)
  let stopped = false;
  let lastEbay = 0;
  let wake: (() => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const loop = (async () => {
    while (!stopped) {
      try {
        await deliver();
        if (systemClock.nowMs() - lastEbay >= EBAY_RECOMPUTE_EVERY_MS) { lastEbay = systemClock.nowMs(); await recomputeEbay(); }
      } catch (error) {
        if (!stopped) log(`demo US market tick failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (stopped) break;
      await new Promise<void>((resolve) => { wake = resolve; timer = setTimeout(resolve, LIVE_TICK_MS); });
    }
  })();
  void loop;
  return {
    pressed,
    stop() {
      // Остановка не ждёт такта: закрытие консоли (и прогона) не висит на полминуты
      stopped = true;
      if (timer) clearTimeout(timer);
      wake?.();
    },
  };
}
