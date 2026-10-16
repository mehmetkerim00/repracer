import type { AdapterCallContext, AdapterDependencies, ChannelAdapter, OrderLine } from '@repracer/channel-port';
import type { StockPipeline } from '@repracer/stock-sync';
import { systemClock } from '@repracer/channel-port';
import { createPricingPipeline } from '@repracer/pricing-pipeline';
import { inTenant, type PgPool, type PgPricingStore } from '@repracer/pricing-store-pg';
import { WALMART_PUBLISHED, WALMART_UNPUBLISHED } from '@repracer/console-model';
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
  /** Шаг 89: walmart.com — на симуляторе по правилам настоящего Walmart; нет — демо без Walmart */
  walmartAccountId?: string | null;
}

export interface DemoUsMarket {
  /** Решения тени, принятые прожатой неделей: по каналу */
  pressed: { amazon: number; ebay: number; walmart: number; seconds: number } | null;
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
/** Шаг 89: количество товара на walmart.com в модели канала — запись количества Walmart в демо выключена [Р-202], значение только читается */
const DEMO_WALMART_QUANTITY = 60;
/**
 * Шаг 87 [Р-214]: спрос amazon.com американского демо — синтетические заказы FBM, без данных покупателя [Р-4]: первый — через две
 * минуты после запуска, дальше раз в 10 минут по кругу предложений; отгрузка через час, каждый десятый отменяется через 20 минут.
 * Продажа становится резервацией [Р-25], отгрузка списывает склад, отмена освобождает — тем же конвейером остатков, что у продавца
 */
const ORDER_FIRST_MS = 2 * MINUTE_MS;
const ORDER_EVERY_MS = 10 * MINUTE_MS;
const ORDER_SHIP_AFTER_MS = HOUR_MS;
const ORDER_CANCEL_AFTER_MS = 20 * MINUTE_MS;

/**
 * Шаг 89: walmart.com американского демо. Цена на витрине — $18.99, у двух товаров (03 и 07) — $24.99, а тот же товар на другой
 * площадке стоит $19.99: правило неконкурентной цены Walmart снимает их с публикации (порог — 10 %, W-10). Демо в тени — наша цена в
 * Walmart не уходит, поэтому снятие держится и видно на экране; движок его не чинит — решение владельца (шаг 89). Ещё у двух товаров
 * (01 и 02) цена другой площадки есть, но наша в пределах порога — опубликованы. Конкуренты — три поведения модели Buy Box
 */
const WALMART_LISTING_MINOR = (k: number) => (k === 2 || k === 6 ? 2499 : 1899);
const WALMART_ELSEWHERE_MINOR = (k: number) => (k === 2 || k === 6 ? 1999 : k === 0 || k === 1 ? 1950 : null);
/** Опрос Buy Box: прожатая неделя — раз в два часа на товар (со сдвигом 10 минут), настоящее время — раз в 15 минут; статусы — раз в 10 минут */
const WALMART_PRESS_POLL_MS = 2 * HOUR_MS;
const WALMART_LIVE_POLL_MS = 15 * MINUTE_MS;
const WALMART_STATUS_EVERY_MS = 10 * MINUTE_MS;


/** Строки заказов, изменившиеся с `sinceMs`: открытые — по времени заказа, отгруженные и отменённые — по времени смены статуса */
export function demoOrderLines(skus: readonly string[], fromMs: number, nowMs: number, sinceMs: number, marketplace: string): OrderLine[] {
  const lines: OrderLine[] = [];
  if (skus.length === 0) return lines;
  for (let k = 0; fromMs + ORDER_FIRST_MS + k * ORDER_EVERY_MS <= nowMs; k++) {
    const at = fromMs + ORDER_FIRST_MS + k * ORDER_EVERY_MS;
    const cancelled = k % 10 === 9;
    const changeAt = at + (cancelled ? ORDER_CANCEL_AFTER_MS : ORDER_SHIP_AFTER_MS);
    const status: OrderLine['status'] = changeAt <= nowMs ? (cancelled ? 'CANCELLED' : 'SHIPPED') : 'OPEN';
    if ((status === 'OPEN' ? at : changeAt) < sinceMs) continue;
    // Номер заказа — вида Amazon (3-7-7), синтетический
    const ref = `114-${String(3_000_000 + k).padStart(7, '0')}-${String((k * 7_919) % 10_000_000).padStart(7, '0')}`;
    lines.push({ externalOrderRef: ref, externalOrderLineRef: `${ref}-1`, identity: { marketplace, externalSku: skus[k % skus.length]! }, quantity: 1,
      orderedAt: new Date(at).toISOString() as OrderLine['orderedAt'], status });
  }
  return lines;
}

interface UsScope { writeScopeId: string; productId: string; channelAccountId: string; marketplace: string; channelProductRef: string | null; sku: string }

/**
 * Себестоимость, комиссия, границы, маржа и стратегия — одной административной транзакцией владельца демо. Второй фактор — потому
 * что это массовая правка (окно Р-135: больше пяти предложений за десять минут): в демо её «сделал» владелец со вторым фактором.
 * `validFrom` — до начала прожатой недели: себестоимость действует на момент каждого решения [Р-131]
 */
/** Шаг 91: с какого номера синтетического названия товара (`demoTitle`) начинаются предложения каждого канала — у лёгких продавцов свои */
export interface DemoTitleOffsets { ebay: number; amazon: number; walmart: number }
const DEMO_TITLE_OFFSETS: DemoTitleOffsets = { ebay: 20, amazon: 40, walmart: 60 };

async function configure(admin: PgPool, a: DemoUsAccounts, validFrom: string, titles: DemoTitleOffsets = DEMO_TITLE_OFFSETS): Promise<UsScope[]> {
  const { demoTitle } = await import('@repracer/contract-tests/live');
  return inTenant(admin, a.tenantId, async (tx) => {
    const { rows } = await tx.query(
      `SELECT ws.write_scope_id, ws.product_id, ws.channel_account_id, om.marketplace, om.channel_product_ref, om.external_sku
         FROM tenant_data.write_scope ws
         JOIN tenant_data.offer_mapping om ON om.tenant_id = ws.tenant_id AND om.price_write_scope_id = ws.write_scope_id
        WHERE ws.tenant_id = $1 AND ws.channel_account_id = ANY ($2::uuid[]) AND ws.field = 'PRICE'
        ORDER BY om.external_sku`, [a.tenantId, [a.ebayAccountId, a.amazonAccountId, ...(a.walmartAccountId ? [a.walmartAccountId] : [])]]);
    const scopes: UsScope[] = rows.map((r) => ({
      writeScopeId: r.write_scope_id, productId: r.product_id, channelAccountId: r.channel_account_id, marketplace: r.marketplace,
      channelProductRef: r.channel_product_ref, sku: r.external_sku,
    }));
    const strategy = async (name: string, type: string, params: Record<string, unknown>, undercutMinor: number | null, handicapMinor: number | null = null) => {
      const { rows: [s] } = await tx.query(
        `INSERT INTO tenant_data.pricing_strategy (tenant_id, pricing_strategy_id, version, name, type, params, triggers, status, created_by_membership_id)
         VALUES ($1, gen_random_uuid(), 1, $2, $3, $4, $5, 'ACTIVE', $6) RETURNING pricing_strategy_id`,
        [a.tenantId, name, type, JSON.stringify({ ...params, deadbandMinor: 0 }), ['COMPETITOR_CHANGE', 'COST_CHANGE', 'SCHEDULE'], a.ownerMembershipId]);
      // Р-91: подрез — в таблице с 18-месячным сроком, а не в вечной версии стратегии
      if (undercutMinor !== null) {
        await tx.query(`INSERT INTO channel_data.pricing_strategy_undercut (tenant_id, pricing_strategy_id, version, undercut_minor, fulfillment_handicap_minor) VALUES ($1, $2, 1, $3, $4)`,
          [a.tenantId, s!.pricing_strategy_id, undercutMinor, handicapMinor]);
      }
      return s!.pricing_strategy_id as string;
    };
    const margin = await strategy('Target margin 30%', 'TARGET_MARGIN', { type: 'TARGET_MARGIN', targetMarginBp: 3000 }, null);
    const beat = await strategy('Beat the lowest by 1 cent', 'BEAT_LOWEST',
      { type: 'BEAT_LOWEST', scope: 'VISIBLE_TOP_N', compareLanded: false, atBound: 'CAP' }, 1);
    /**
     * Шаг 97 [Р-219]: walmart.com — «Win the Buy Box» с подъёмом при удержании (в демо включён, чтобы подъём был виден): цель от цены
     * победителя с доставкой минус цент; поправка на исполнение каналом — 0 (исполнения модель Walmart не называет, W-05). Подрез и
     * поправка — в таблице с 18-месячным сроком [Р-91], не в вечной версии
     */
    const winBuyBox = a.walmartAccountId ? await strategy('Win the Buy Box', 'WIN_BUYBOX', { type: 'WIN_BUYBOX', creepUp: true, creepStepBp: 100, atBound: 'CAP' }, 1, 0) : null;
    for (const s of scopes) {
      const ebay = s.channelAccountId === a.ebayAccountId;
      const walmart = s.channelAccountId === a.walmartAccountId;
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
         VALUES ($1, $2, 'FEE_SCHEDULE', $3, to_char($4::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM'), $4, $4::timestamptz + interval '400 days')`,
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
      await tx.query(`UPDATE tenant_data.product SET title = $3 WHERE tenant_id = $1 AND product_id = $2`, [a.tenantId, s.productId, demoTitle(ebay ? titles.ebay + k : walmart ? titles.walmart + k : titles.amazon + k)]);
      // Нынешняя цена на витрине — как прочитало бы обнаружение: $19.99 у eBay, $18.50 у amazon.com, у walmart.com — цена модели канала
      await tx.query(
        `INSERT INTO channel_data.observed_channel_state (tenant_id, write_scope_id, field, observed_amount_minor, observed_at, received_at, source, sync_status)
         VALUES ($1, $2, 'PRICE', $3, $4, $4, 'READBACK', 'IN_SYNC')`, [a.tenantId, s.writeScopeId, ebay ? 1999 : walmart ? WALMART_LISTING_MINOR(k) : 1850, validFrom]);
      await tx.query(
        `UPDATE tenant_data.write_scope SET pricing_mode = 'ENGINE', pricing_strategy_id = $3, pricing_strategy_version = 1
          WHERE tenant_id = $1 AND write_scope_id = $2`, [a.tenantId, s.writeScopeId, ebay ? margin : walmart && winBuyBox ? winBuyBox : beat]);
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
  /** Шаг 87: спрос amazon.com — конвейер остатков и SKU предложений amazon.com; без него заказов нет (демо рядом с Kaufland) */
  orders?: { pipeline: StockPipeline; skus: readonly string[] };
  /** Шаг 91: названия товаров лёгкого продавца — свой диапазон, чтобы его товары не повторяли товары главного демо */
  titleOffsets?: DemoTitleOffsets;
}): Promise<DemoUsMarket> {
  const { pools, store, accounts: a, log } = input;
  const { SimulatedAmazonPort, AMAZON_SIM_DESCRIPTOR_US, AMAZON_US, LANDED_CHANNEL_BONUS, sellersFor } = await import('@repracer/contract-tests/simulator');
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
  const scopes = await configure(pools.admin, a, new Date(begin - DAY_MS).toISOString(), input.titleOffsets);
  const amazonScopes = scopes.filter((s) => s.channelAccountId === a.amazonAccountId);
  const walmartScopes = scopes.filter((s) => s.channelAccountId === a.walmartAccountId);

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
    // Шаг 97 [H]: победитель — по формуле (FBA −0,50), а уведомление держателя не называет (A-29) — экран Competition говорит это прямо
    buyBox: LANDED_CHANNEL_BONUS,
    skus: amazonScopes.map((s) => ({ sku: s.sku, asin: s.channelProductRef!, marketplaces: [AMAZON_US], priceMinor: 1850, quantity: 5 })),
    competitors: amazonScopes.map((s, i) => ({
      // Шаг 97 [H]: продавец пула — вымышленное имя, исполнение каналом (FBA) и рейтинг, как SellerFeedbackRating
      sellerRef: sellersFor(i)[0]!.name, channelFulfilled: sellersFor(i)[0]!.channelFulfilled,
      rating: { positivePct: sellersFor(i)[0]!.ratingPct, count: sellersFor(i)[0]!.ratingCount }, marketplace: AMAZON_US, asin: s.channelProductRef!, priceMinor: 1800,
      // Фаза ступени — своя у каждого предложения: в один момент рынок движется вразброс, а не единым сдвигом [Р-50]
      schedule: Array.from({ length: steps }, (_, k) => ({ atOffsetMs: (k + 1) * COMPETITOR_STEP_MS + i * 10 * MINUTE_MS, priceMinor: AMAZON_US_RAMP[(k + i) % AMAZON_US_RAMP.length]! })),
    })),
  }, deps);
  const amazon = createPricingPipeline({ store: store as never, adapter: port, alerts, logger: deps.logger, now: nowIso as never });
  const ebay = createPricingPipeline({ store: store as never, adapter: consoleAdapter('EBAY'), alerts, logger: deps.logger, now: nowIso as never });
  const ctx = (channelAccountId: string): AdapterCallContext => ({
    tenantId: a.tenantId as never, channelAccountId: channelAccountId as never, correlationId: 'console-demo-us', deadline: new Date(Date.parse(nowIso()) + MINUTE_MS).toISOString() as never,
  });
  const counts = { amazon: 0, ebay: 0, walmart: 0 };
  const deliver = async () => {
    for (const snapshot of port.drainSnapshots()) {
      await amazon.processSnapshot(ctx(a.amazonAccountId), snapshot);
      counts.amazon += 1;
    }
  };
  const recomputeEbay = async () => { counts.ebay += (await ebay.recomputeScheduled(ctx(a.ebayAccountId), { limit: 100 })).scopes; };
  // Шаг 97 [Р-219]: плановый пересчёт walmart.com — таймер ступени подъёма «Win the Buy Box» (в тени предложения удерживаются)
  const recomputeWalmart = async () => { if (walmartSim) await walmartSim.pipeline.recomputeScheduled(ctx(walmartSim.account), { limit: 100 }); };

  /**
   * Шаг 89: walmart.com — модель канала по правилам настоящего Walmart (HTTP, корзины токенов с заголовками) и НАСТОЯЩИЙ адаптер Walmart
   * поверх неё: конкуренты — опрос Buy Box, решения — тем же путём, что у продавца (в тени — запись удерживается). Статус публикации
   * читается опросом: переход в «снят с публикации» (и обратно) — строка журнала наблюдений канала, её показывают Offers и журнал «Stop pricing»
   */
  const walmartSim = walmartScopes.length > 0 && a.walmartAccountId ? await (async () => {
    const [{ SimulatedWalmartChannel }, { WalmartAdapter, WALMART_US }] = await Promise.all([import('@repracer/contract-tests/simulator'), import('@repracer/walmart-adapter')]);
    const clock = {
      nowMs: () => Date.parse(nowIso()),
      // Корзина пуста — ждать пополнения: в прожатой неделе — виртуальным временем, дальше — настоящим
      sleep: (ms: number) => (virtualMs === null ? new Promise<void>((resolve) => setTimeout(resolve, ms)) : (virtualMs += ms, Promise.resolve())),
    };
    // Шаг 97 [H]: рынок — продавцы пула с волнами своей фазы и размаха у каждого товара (разброс против ложной остановки Р-50), победитель — формула
    const channel = new SimulatedWalmartChannel({
      seed: 89, clientId: 'syn-walmart-demo', clientSecret: 'syn-walmart-demo-secret', nowMs: clock.nowMs, market: 'NAMED_WAVES', buyBox: LANDED_CHANNEL_BONUS,
      items: walmartScopes.map((sc, k) => ({ sku: sc.sku, productName: `Synthetic product ${sc.sku}`, priceMinor: WALMART_LISTING_MINOR(k), shippingMinor: 0, quantity: DEMO_WALMART_QUANTITY,
        otherMarketplacePriceMinor: WALMART_ELSEWHERE_MINOR(k), competitorBaseMinor: 1850 + 10 * k })),
    });
    const walmartDeps: AdapterDependencies = {
      ...deps,
      accounts: { async verify(tenantId, channelAccountId) {
        if (channelAccountId !== a.walmartAccountId) return { ok: false, reason: 'NOT_FOUND' };
        if (tenantId !== a.tenantId) return { ok: false, reason: 'TENANT_MISMATCH' };
        return { ok: true, account: { tenantId, channelAccountId, channel: 'WALMART', externalAccountId: 'synthetic', marketplaces: [WALMART_US], credentialsRef: 'secret-ref:synthetic' } };
      } },
      credentials: { async get() { return { clientId: 'syn-walmart-demo', clientSecret: 'syn-walmart-demo-secret' }; } },
    };
    const adapter = new WalmartAdapter(walmartDeps, { baseUrl: 'https://sandbox.walmartapis.com', fetch: channel.fetch, clock });
    const pipeline = createPricingPipeline({ store: store as never, adapter, alerts, logger: deps.logger, now: nowIso as never });
    return { channel, adapter, pipeline, marketplace: WALMART_US, account: a.walmartAccountId as string };
  })() : null;
  const walmartKnown = new Map<string, boolean>();
  const pollWalmart = async (skus: readonly string[]) => {
    if (!walmartSim || skus.length === 0) return;
    const c = ctx(walmartSim.account);
    const read = await walmartSim.adapter.readCompetitors(c, skus.map((sku) => ({ marketplace: walmartSim.marketplace, channelProductRef: sku, condition: 'new' })));
    for (const snapshot of read.snapshots) {
      await walmartSim.pipeline.processSnapshot(c, snapshot);
      counts.walmart += 1;
    }
  };
  const syncWalmartStatuses = async () => {
    if (!walmartSim) return;
    const at = nowIso();
    for (const st of await walmartSim.adapter.listingStatuses(ctx(walmartSim.account), walmartScopes.map((sc) => sc.sku))) {
      const was = walmartKnown.get(st.sku);
      walmartKnown.set(st.sku, st.published);
      // Запись — только при переходе: первое наблюдение «снят» и смена состояния; опубликованный с самого начала строки не даёт
      if (was === st.published || (was === undefined && st.published)) continue;
      await store.recordPricingHealth(a.tenantId, walmartSim.account, {
        marketplace: walmartSim.marketplace, channelProductRef: st.sku, condition: 'new',
        issueType: st.published ? WALMART_PUBLISHED : WALMART_UNPUBLISHED, occurredAt: at as never,
        competitivePriceThreshold: st.published ? null : st.referencePrice, sourceEventId: `walmart-status:${st.sku}:${at}`,
      });
    }
  };
  // Шаг 87: заказы amazon.com — с настоящего момента запуска (прожатая неделя заказов не несёт); окно чтения с запасом в минуту
  const orders = input.orders;
  let ordersSince = realStart;
  const ordersAdapter = { readOrderLines: async (_c: AdapterCallContext, q: { since: string }) =>
    ({ items: demoOrderLines(orders?.skus ?? [], realStart, systemClock.nowMs(), Date.parse(q.since), AMAZON_US) }) } as unknown as ChannelAdapter;
  const syncOrders = async () => {
    if (!orders) return;
    const at = systemClock.nowMs();
    await orders.pipeline.syncOrders(ctx(a.amazonAccountId), ordersAdapter, new Date(ordersSince - MINUTE_MS).toISOString() as never);
    ordersSince = at;
  };

  let pressed: DemoUsMarket['pressed'] = null;
  if (virtualMs !== null) {
    // Ревью шага 68, находка 8: сбой одного шага прожатия не роняет посев демо (и старт консоли) — считается и называется числом
    let failures = 0;
    for (let t = begin; t <= realStart; t += MINUTE_MS) {
      virtualMs = t;
      try {
        await deliver();
        // Шаг 97: таймер подъёма walmart.com в прожатой неделе не зовётся — аккаунт в тени, а таймер тень не берёт (ревью шага 97, в1); ступени
        // подъёма в тени видны по снимкам Buy Box
        if ((t - begin) % HOUR_MS === 0) await recomputeEbay();
        if (t === begin) await syncWalmartStatuses();
        // Шаг 89: Buy Box Walmart — товар раз в два часа, товары со сдвигом в 10 минут
        await pollWalmart(walmartScopes.filter((_sc, i) => (t - begin - i * 10 * MINUTE_MS) >= 0 && (t - begin - i * 10 * MINUTE_MS) % WALMART_PRESS_POLL_MS === 0).map((sc) => sc.sku));
      } catch (error) {
        failures += 1;
        if (failures === 1) log(`demo US press step failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (failures > 0) log(`demo US press: ${failures} failed steps`);
    virtualMs = null;
    pressed = { amazon: counts.amazon, ebay: counts.ebay, walmart: counts.walmart, seconds: Math.round((systemClock.nowMs() - realStart) / 100) / 10 };
    log(`demo US week pressed: ${input.pressDays} days, amazon.com snapshots ${pressed.amazon}, eBay US recomputed ${pressed.ebay}, walmart.com snapshots ${pressed.walmart}, alerts kept in memory ${alertCount}, ${pressed.seconds} s`);
  }

  // Дальше — настоящее время: снимки по сроку доставки, пересчёт eBay по расписанию (должные — без решения за сутки)
  // Без прожатой недели статусы Walmart читаются сразу при старте
  if (input.pressDays === 0) await syncWalmartStatuses().catch((error: unknown) => log(`demo walmart.com statuses failed: ${error instanceof Error ? error.message : String(error)}`));
  let stopped = false;
  let lastEbay = 0;
  let lastWalmartPoll = 0;
  let lastWalmartStatus = systemClock.nowMs();
  let wake: (() => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const loop = (async () => {
    while (!stopped) {
      try {
        await deliver();
        if (systemClock.nowMs() - lastEbay >= EBAY_RECOMPUTE_EVERY_MS) { lastEbay = systemClock.nowMs(); await recomputeEbay(); }
        if (systemClock.nowMs() - lastWalmartPoll >= WALMART_LIVE_POLL_MS) { lastWalmartPoll = systemClock.nowMs(); await pollWalmart(walmartScopes.map((sc) => sc.sku)); await recomputeWalmart(); }
        if (systemClock.nowMs() - lastWalmartStatus >= WALMART_STATUS_EVERY_MS) { lastWalmartStatus = systemClock.nowMs(); await syncWalmartStatuses(); }
        await syncOrders();
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
