import type { AdapterCallContext, ChannelAdapter, InboundDelivery } from '@repracer/channel-port';
import { createPricingPipeline, type MemorySeed, type MemorySeedScope, type PricingPipeline } from '@repracer/pricing-pipeline';
import { PgPricingStore, PgStockStore, PgWriteQueueStore, seedPricingWorld, translateStore, type PgPool, type SeededPricingWorld } from '@repracer/pricing-store-pg';
import { createStockPipeline, type StockPipeline } from '@repracer/stock-sync';
import { createWriteDispatcher, type WriteDispatcher, type WriteQueueStore } from '@repracer/write-dispatcher';
import { kauflandUnderTest } from '../adapters.ts';
import { channelFetch, kauflandAuthChecker, type ChannelBehaviour, type ObservedRequest, type TraceEntry } from '../harness/channel.ts';
import { buildDelivery } from '../harness/runner.ts';
import type { World } from '../harness/scenario.ts';
import { VirtualClock, worldDependencies, type Sink } from '../harness/world.ts';
import { SimulatedKauflandChannel, type CompetitorBehaviour, type KauflandChannelModelSpec } from '../simulator/kaufland-channel.ts';
import { dbIdPipeline, stamped, type StampedEvent } from './common.ts';

/**
 * Р-128 (шаг 26): мир Kaufland для проверки в живом режиме — настоящая PostgreSQL (отдельная база), адаптер Kaufland поверх симулятора
 * канала с состоянием, путь решения и диспетчер записей. Время — виртуальные часы, которые двигает цикл процесса планировщика.
 * Наблюдение — запросы, дошедшие до канала: сколько раз опрошен каждый товар и когда. Данные синтетические.
 */

export type ProductClass = 'HOT' | 'WARM' | 'STATIC' | 'NEW_VOLATILE' | 'NEW_STATIC' | 'NEW_NO_ANCHOR' | 'NEW_SELF_WINS' | 'SHIFT';

export interface LiveProduct {
  cls: ProductClass;
  idProduct: number;
  marketplace: string;
  behaviour: CompetitorBehaviour;
  /** Цена конкурента в начале, по умолчанию 18,00 */
  competitorStartMinor?: number;
  /** Наблюдения товара за прошлые 48 часов (товар уже работал до начала проверки); у новых — ни истории, ни состояния */
  pastMovesEveryMinutes: number | null;
  /** Коэффициент прошлых наблюдений, б. п.: 10 000 — цена не менялась */
  pastMoveBp?: number;
  pricingMode?: 'OFF' | 'ENGINE';
  /** Себестоимость единицы — якорь проверки входов [Р-49] для товара без истории */
  costMinor?: number;
  /** Продавец включил Smart Pricing в кабинете канала [Р-12] */
  channelMinimumPriceMinor?: number;
  /**
   * Шаг 34 [Р-149, Р-151]: «голое» предложение — как оно приходит с канала до онбординга: без границ, себестоимости и
   * стратегии, движок выключен. Путь онбординга сам даёт ему всё это.
   */
  bare?: boolean;
  /** Шаг 34 [Р-151]: конкурентов у товара может быть несколько — демо ставит трёх с разным поведением */
  moreCompetitors?: Array<{ sellerRef: string; behaviour: CompetitorBehaviour; startMinor: number }>;
}

export interface KauflandLiveWorld {
  channel: 'KAUFLAND';
  clock: VirtualClock;
  world: World;
  seeded: SeededPricingWorld;
  adapter: ChannelAdapter;
  simulator: SimulatedKauflandChannel;
  pipeline: PricingPipeline;
  products: LiveProduct[];
  events: StampedEvent[];
  violations: string[];
  /** GET /v2/buybox по товару: моменты запросов (мс виртуальных часов) */
  buyboxCalls: Map<number, number[]>;
  /** Запросы по маршруту */
  requests: Map<string, number>;
  /** Работа других процессов между тактами планировщика: приёмник уведомлений и обход диспетчера */
  betweenTicks(): Promise<void>;
  /** Путь решения, вызываемый планировщиком с идентификаторами базы */
  pipelineForDbIds(): PricingPipeline;
  /** Отправка ждущих записей единицы — как делает путь решения за брокером, по идентификаторам базы */
  dispatchScope(tenantId: string, writeScopeId: string): Promise<void>;
  /** Шаг 35: остатки мира (null — мир без остатков) */
  stock: PgStockStore | null;
  stockPipeline: StockPipeline | null;
  /**
   * Заказы канала → резервации → пересчёт → записи, по идентификаторам БАЗЫ (как зовёт планировщик). Хранилище остатков
   * работает в идентификаторах базы, а адаптер мира — в идентификаторах сценария: перевод здесь, как у `pipelineForDbIds`.
   */
  syncOrdersForDbIds(ctx: AdapterCallContext, since: string): Promise<{ lines: number; created: number; consumed: number; released: number; unknownOffers: number; writes: number }>;
}

function scopeOf(p: LiveProduct, account: string): MemorySeedScope {
  const id = String(p.idProduct);
  if (p.bare) {
    return {
      writeScopeId: `ws-${p.marketplace}-${id}`, productId: `prod-${p.marketplace}-${id}`, channelAccountId: account, marketplace: p.marketplace,
      // Шаг 35: id_offer — ключ единицы ОСТАТКА у Kaufland [Р-35]; тот же, что у единицы симулятора
      externalUnitId: id.slice(-6), externalOfferId: `SYN-OFFER-${id}`, channelProductRef: id, condition: 'new', currency: 'EUR', basis: 'GROSS', pricingMode: 'OFF', strategy: null,
      currentPriceMinor: 1850, minPrice: null, maxPrice: null,
    } as MemorySeedScope;
  }
  return {
    writeScopeId: `ws-${p.marketplace}-${id}`, productId: `prod-${p.marketplace}-${id}`, channelAccountId: account, marketplace: p.marketplace,
    externalUnitId: id.slice(-6), externalOfferId: `SYN-OFFER-${id}`, channelProductRef: id, condition: 'new', currency: 'EUR', basis: 'GROSS', pricingMode: p.pricingMode ?? 'OFF',
    strategy: p.pricingMode === 'ENGINE' ? { strategyId: 'st-buybox', version: 1, params: { type: 'MATCH_BUYBOX', undercutMinor: 5, holdWhenWinning: true, atBound: 'CAP' }, deadbandMinor: 0 } : null,
    ...(p.costMinor ? { cost: { currency: 'EUR', costProfileId: `cp-${id}`, unitCostMinor: p.costMinor, fixedFeeMinor: 0, feeRateBp: 1500, tax: { regime: 'VAT_INCLUDED', vatRateBp: p.marketplace === 'at' ? 2000 : 1900 } } } : {}),
    currentPriceMinor: 1850, minPrice: { amountMinor: 1200, id: `min-${p.marketplace}-${id}` }, maxPrice: { amountMinor: 3000, id: `max-${p.marketplace}-${id}` },
  } as MemorySeedScope;
}

export async function kauflandLiveWorld(input: {
  tag: number; clock: VirtualClock; products: LiveProduct[]; seed: number; appPool: PgPool; adminPool: PgPool; provisioningPool: PgPool; dispatcherPool: PgPool;
  /** Доступ к buy_box_changed [Р-45] и модель доставки; без него уведомлений нет */
  buyBoxChanged?: { lossShare: number; debounceMs: number };
  /** Параметры модели канала: сбои записи (K-14), задержка применения (K-15) и прочее */
  params?: KauflandChannelModelSpec['params'];
  /** Р-151: тенант — демо; помечается в базе */
  demo?: boolean;
  /** Существующие пользователи, их адреса и приём приглашений — как у посева стенда: существующий человек входит в тенант
   *  владельцем только своим адресом, остальными ролями — приглашением (находка 5 ревью шага 16) */
  memberUsers?: Readonly<Record<string, string>>;
  memberEmails?: Readonly<Record<string, string>>;
  joinMember?: Parameters<typeof seedPricingWorld>[1]['joinMember'];
  /** Р-150: аккаунты других каналов, у которых нет доступа, — с перечнем того, чего не хватает */
  awaitingAccounts?: NonNullable<MemorySeed['accounts']>;
  /**
   * Шаг 35 [Р-152, Р-153]: остатки мира. Источник — внутренний пул с инвентаризацией `onHand` у каждого товара, буфер
   * аккаунта `bufferUnits`, синхронизация включена; записи остатка уходят через диспетчер мира. Нужна роль остатков.
   */
  stock?: { onHand: number; bufferUnits: number; stockPool: PgPool };
  /** Спрос модели канала: заказы, отгрузки, отмены (K-11 — заказ уменьшает amount у канала сам) */
  demand?: KauflandChannelModelSpec['demand'];
}): Promise<KauflandLiveWorld> {
  const tenantFixture = `10000000-0000-4000-8000-00000000${String(input.tag).padStart(4, '0')}`;
  const accountFixture = `20000000-0000-4000-8000-00000000${String(input.tag).padStart(4, '0')}`;
  const webhookToken = `wh_tok_synthetic_${input.tag}`;
  const clock = input.clock;
  const startIso = clock.iso();
  const start = clock.nowMs();
  const day = (offsetDays: number) => new Date(start + offsetDays * 86_400_000).toISOString().slice(0, 10);
  const pricing: MemorySeed = {
    scopes: input.products.map((p) => scopeOf(p, accountFixture)), competitorDaily: {}, competitorState: {}, moves: [],
    ...(input.awaitingAccounts && input.awaitingAccounts.length > 0 ? { accounts: input.awaitingAccounts } : {}),
  };
  for (const p of input.products) {
    if (p.cls.startsWith('NEW_')) continue;
    const key = `${p.marketplace}|${p.idProduct}|new`;
    const price = p.competitorStartMinor ?? 1800;
    pricing.competitorDaily![key] = Array.from({ length: 20 }, (_, i) => ({ day: day(-(i + 1)), minMinor: 1500, maxMinor: 2200 }));
    pricing.competitorState![key] = { observedAt: new Date(start - 600_000).toISOString(), buyboxMinor: price, lowestMinor: price };
    if (p.pastMovesEveryMinutes) {
      for (let t = start - 48 * 3_600_000 + p.pastMovesEveryMinutes * 60_000; t < start; t += p.pastMovesEveryMinutes * 60_000) {
        pricing.moves!.push({ marketplace: p.marketplace, productRef: `${p.idProduct}|new`, evaluatedAt: new Date(t).toISOString(), moveBp: p.pastMoveBp ?? 10_150 });
      }
    }
  }
  const marketplaces = [...new Set(input.products.map((p) => p.marketplace))].sort();
  const channelModel: KauflandChannelModelSpec = {
    seed: input.seed, webhookUrl: `https://hooks.example.invalid/kaufland/${webhookToken}`,
    ...(input.demand ? { demand: input.demand } : {}),
    units: input.products.map((p) => ({
      idUnit: Number(String(p.idProduct).slice(-6)), storefront: p.marketplace, idOffer: `SYN-OFFER-${p.idProduct}`, idProduct: p.idProduct, listingPriceMinor: 1850, amount: 5,
      ...(p.channelMinimumPriceMinor ? { minimumPriceMinor: p.channelMinimumPriceMinor } : {}),
    })),
    competitors: input.products.flatMap((p) => [{ sellerRef: `Synthetic Competitor ${p.idProduct}`, storefront: p.marketplace, idProduct: p.idProduct, priceMinor: p.competitorStartMinor ?? 1800, behaviour: p.behaviour },
      // Шаг 34: дополнительные конкуренты товара — у демо с ними выходит три с разным поведением [Р-151]
      ...(p.moreCompetitors ?? []).map((c) => ({ sellerRef: c.sellerRef, storefront: p.marketplace, idProduct: p.idProduct, priceMinor: c.startMinor, behaviour: c.behaviour })),
    ]),
    // Р-45: buy_box_changed — ранний доступ; без доступа уведомлений нет, конкуренты — только опрос. Доступ — явный параметр мира
    params: { ...input.params, buyBoxChanged: input.buyBoxChanged ? { delivered: true, debounceMs: input.buyBoxChanged.debounceMs, lossShare: input.buyBoxChanged.lossShare } : { delivered: false, debounceMs: 0, lossShare: 1 } },
  };
  const world: World = {
    clock: startIso, tenantId: tenantFixture, channelAccountId: accountFixture,
    account: { externalAccountId: `syn-seller-${input.tag}`, marketplaces },
    credentials: { seller: { clientKey: `syn-seller-client-key-${input.tag}`, secretKey: `syn-seller-secret-key-${input.tag}` } },
    secrets: [webhookToken], channelModel,
    ...(input.buyBoxChanged ? { adapter: { buyBoxChangedAccess: 'GRANTED' as const } } : {}),
    // Бюджет адаптера — ниже документированного лимита продавца 111 rps [док]; бюджет ярусов — отдельно (JobConfig.pollBudgetRps)
    budget: { seller: { ratePerSecond: 100, burst: 100 } },
  };
  const seeded = await seedPricingWorld(input.appPool, {
    fixtureTenantId: tenantFixture, fixtureChannelAccountId: accountFixture, marketplaces, clock: startIso, seed: pricing,
    provisioningPool: input.provisioningPool, adminPool: input.adminPool, ...(input.demo ? { demo: true } : {}),
    ...(input.memberUsers ? { memberUsers: input.memberUsers } : {}), ...(input.memberEmails ? { memberEmails: input.memberEmails } : {}),
    ...(input.joinMember ? { joinMember: input.joinMember } : {}),
  });
  const simulator = new SimulatedKauflandChannel(channelModel, startIso);
  const buyboxCalls = new Map<number, number[]>();
  const requests = new Map<string, number>();
  const observing: ChannelBehaviour = {
    reply(request: ObservedRequest, nowMs: number) {
      const route = `${request.method} ${request.path.replace(/\/[0-9]+$/, '/{id}')}`;
      requests.set(route, (requests.get(route) ?? 0) + 1);
      if (request.method === 'GET' && request.path === '/v2/buybox') {
        const id = Number(request.query.id_product);
        const calls = buyboxCalls.get(id) ?? [];
        calls.push(nowMs);
        buyboxCalls.set(id, calls);
      }
      return simulator.reply(request, nowMs);
    },
    finish: () => simulator.finish(),
  };
  const sink: Sink = { logs: [], alerts: [] };
  const violations: string[] = [];
  const trace: TraceEntry[] = [];
  const fetch = channelFetch(observing, kauflandAuthChecker(world, clock), clock, violations, trace);
  const deps = worldDependencies(world, clock, sink);
  const adapter = kauflandUnderTest({ deps, world, clock, fetch });
  const store = translateStore(new PgPricingStore(input.appPool, { adminPool: input.adminPool }), seeded.ids);
  const writeQueue = new PgWriteQueueStore(input.appPool, { scanPool: input.dispatcherPool });
  const queue = translateStore<WriteQueueStore>({
    claimNext: writeQueue.claimNext.bind(writeQueue), recordOutcome: writeQueue.recordOutcome.bind(writeQueue),
    recordReconciliation: writeQueue.recordReconciliation.bind(writeQueue), checkPriceBasis: writeQueue.checkPriceBasis.bind(writeQueue),
    dueScopes: async (at, options) => (await writeQueue.dueScopes(at, options)).filter((d) => d.tenantId === seeded.tenantId),
  }, seeded.ids);
  const dispatcher: WriteDispatcher = createWriteDispatcher({ store: queue, adapterFor: () => adapter, alerts: deps.alerts, now: () => clock.iso() });
  // Путь решения отправляет свою запись сам и передаёт диспетчеру следующую, ждущую за ней [Р-64]
  // OQ-216: пауза пути решения двигает ВИРТУАЛЬНЫЕ часы — по ним же считает бюджет адаптера
  const pipeline = createPricingPipeline({ store, adapter, alerts: deps.alerts, logger: deps.logger, now: () => clock.iso(), sleep: clock.sleep, dispatcher });
  const events = stamped(sink, clock);
  // Шаг 35: остатки мира — тем же путём, что у продавца: источник, инвентаризация, буфер, включение; записи создаёт пересчёт
  let stock: PgStockStore | null = null;
  let stockPipeline: StockPipeline | null = null;
  if (input.stock) {
    stock = new PgStockStore({ adminPool: input.adminPool, stockPool: input.stock.stockPool });
    stockPipeline = createStockPipeline({ store: stock, now: () => clock.iso() as never, dispatchScope: (t, ws) => dispatcher.dispatchScope(seeded.ids.fromDb(t), seeded.ids.fromDb(ws)) });
    const actor = { membershipId: seeded.ownerMembershipId, userId: seeded.userId, mfa: true };
    const source = await stock.createStockSource(seeded.tenantId, { mode: 'INTERNAL_POOL', name: 'Lager' }, actor);
    if (source.status !== 'CREATED') throw new Error(`stock source of the world: ${source.status}`);
    const imported = await stock.importStock(seeded.tenantId, source.stockSourceId, input.products.map((p) => ({ sku: String(p.idProduct).slice(-6), quantity: input.stock!.onHand })), actor);
    if (imported.status !== 'APPLIED') throw new Error(`stock import of the world: ${imported.status}`);
    const enabled = await stock.enableStockSync(seeded.tenantId, seeded.channelAccountId, { bufferUnits: input.stock.bufferUnits, maxQuantity: null, minQuantityToList: 0, acknowledgeSideEffects: false }, actor);
    if (enabled.status !== 'ENABLED') throw new Error(`stock sync of the world: ${enabled.status}`);
    await stock.recalculate(seeded.tenantId, null, clock.iso() as never);
  }
  return {
    channel: 'KAUFLAND', clock, world, seeded, adapter, simulator, pipeline, products: input.products, events: events.list, violations, buyboxCalls, requests,
    stock, stockPipeline,
    async betweenTicks() {
      // Трасса запросов проверке не нужна и за сутки растёт до сотен тысяч строк
      trace.length = 0;
      for (const d of simulator.drainDeliveries(clock.nowMs())) await pipeline.processInbound(buildDelivery(d, { world }, clock) as InboundDelivery);
      // Обход-страховка диспетчера: ждущая запись не остаётся незамеченной, даже если событие потерялось [Р-64]
      await dispatcher.sweep({ pendingMinAgeMs: 0 });
      events.stamp();
    },
    pipelineForDbIds: () => dbIdPipeline(pipeline, seeded),
    async syncOrdersForDbIds(ctx, since) {
      if (!stockPipeline) return { lines: 0, created: 0, consumed: 0, released: 0, unknownOffers: 0, writes: 0 };
      // Адаптеру — идентификаторы сценария (его каталог аккаунтов знает только их), хранилищу остатков — базы
      const forAdapter = seeded.ids.fromDb(ctx);
      const adapterForDbIds = new Proxy(adapter, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver);
          if (typeof value !== 'function') return value;
          return (_ctx: AdapterCallContext, ...rest: unknown[]) => (value as (...a: unknown[]) => unknown).call(target, forAdapter, ...rest);
        },
      }) as ChannelAdapter;
      return stockPipeline.syncOrders(ctx, adapterForDbIds, since as never);
    },
    async dispatchScope(tenantId, writeScopeId) {
      await dispatcher.dispatchScope(seeded.ids.fromDb(tenantId), seeded.ids.fromDb(writeScopeId));
    },
  };
}
