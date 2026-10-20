import { systemClock } from '@repracer/channel-port';
import { US_STOREFRONTS, type MarketProfile } from '@repracer/console-model';
import type { PgPool } from '@repracer/pricing-store-pg';
import type { LiveWorld } from '@repracer/contract-tests/stand';

/**
 * Демо-мир [Р-151, Р-160]: клиентский тенант с признаком демо на симуляторе Kaufland. Данные синтетические, путь
 * настоящий — те же роли базы, тот же путь решения, тот же исполнитель заданий.
 *
 * Этот модуль вынесен из сервера стенда шагом 37: демо понадобилось ДВУМ процессам — стенду разработчика и
 * разворачиваемой консоли [Р-159]. Копия во втором месте разошлась бы с первой в первый же шаг.
 *
 * Время демо — НАСТОЯЩЕЕ, секунда в секунду (ревью шага 34, находка 9): у базы часы свои, и всё, что она считает по
 * `now()` — действие себестоимости, сроки, закрытие суток, — разошлось бы с миром, убежавшим вперёд.
 */

export interface DemoWorldPools {
  app: PgPool;
  admin: PgPool;
  provisioning: PgPool;
  dispatcher: PgPool;
  scheduler: PgPool;
  exporter: PgPool;
  stock: PgPool;
  bulkWorker: PgPool;
}

export interface RunningDemoWorld {
  world: LiveWorld;
  tenantId: string;
  /** Остановить время демо и исполнителя заданий: мир больше не двигается, но остаётся читаемым */
  stop(): void;
}

export interface DemoWorldOptions {
  pools: DemoWorldPools;
  pgUrl: string;
  /** Строки подключения ролей исполнителя заданий: без них он выводил бы их подстановкой (находка 1 ревью шага 37) */
  pgUrlsByRole?: Readonly<Record<'admin' | 'bulk_worker' | 'stock', string>>;
  /** Номер мира: у каждого посева свой тенант, поэтому пересев — это новый номер, а не правка старого */
  tag: number;
  memberUsers: Readonly<Record<string, string>>;
  memberEmails: Readonly<Record<string, string>>;
  joinMember: Parameters<typeof import('@repracer/contract-tests/live').demoWorld>[0]['joinMember'];
  /** Сколько виртуальных часов гонять мир вперёд (на настоящих часах — столько же настоящих) */
  hours?: number;
  /**
   * Шаг 87 [Р-214]: профиль рынка развёртывания. `us` — американский продавец: amazon.com и ebay.com, доллары, склад в Делавэре, без
   * Kaufland и без витрин ЕС; `eu` и `global` — прежнее демо на симуляторе Kaufland (и витрины США рядом при `usAccounts`). Обязателен:
   * какое демо сеять, решает тот, кто поднимает процесс, а не умолчание библиотеки
   */
  market: MarketProfile;
  /** Шаг 41 [Р-169]: режим записи аккаунта демо; `SHADOW` — ни одной записи в канал */
  writeMode?: 'SHADOW' | 'LIVE';
  /**
   * Шаг 64: профиль США — в демо-тенанте ещё два аккаунта: eBay EBAY_US и Amazon amazon.com (регион NA), валюта USD. Оба рождаются
   * в ТЕНИ [Р-176], каталог пишет та же функция базы, что обнаружение офферов [Р-179]; себестоимости у них нет, поэтому тень считать
   * ещё не начала [Р-131], а вопрос о других инструментах [Р-202] не отвечен — ровно то, что видит продавец после «Connect»
   */
  usAccounts?: boolean;
  /**
   * Шаг 68 (K7): сколько суток тени США «прожать» до настоящего момента при подъёме — чтобы недельный отчёт тени был показуем сразу,
   * а не через неделю. 0 (по умолчанию) — тень США считает с запуска. Только вместе с `usAccounts`
   */
  usPressDays?: number;
  /**
   * Шаг 69 [Р-204]: только прогоны — тот же мир симулятора у КЛИЕНТСКОГО тенанта, а не демо. Доказательством процедуры границы
   * суток демо-тенант не бывает (его данные синтетические, Р-151), поэтому прогон процедуры оператора сеет мир без признака демо.
   * Консоль публичного демо этот параметр не передаёт
   */
  customerTenant?: boolean;
  /**
   * Шаг 69 (K1, K4): язык и пояс показа демо-тенанта — как у любого тенанта, в базе. Язык — язык развёртывания (умолчание тенанта),
   * пояс — заданный для показа (демо для клиента из США — его пояс); без пояса — пояс первой витрины демо
   */
  locale?: 'de' | 'en' | 'es' | 'fr';
  timeZone?: string | null;
  log?: (message: string) => void;
}

/**
 * Шаг 88 показывал в журнале демо смену роли «наблюдатель → менеджер» (менеджер приходил наблюдателем, владелец его повышал). Шаг 98
 * [Р-222]: наблюдателя нет, ролей для людей две — менеджер приходит менеджером, повышать некого
 */

export async function startDemoWorld(options: DemoWorldOptions): Promise<RunningDemoWorld> {
  if (options.market === 'us') return startUsDemoWorld(options);
  const { pools, tag } = options;
  const log = options.log ?? ((m: string) => console.log(m));
  const { demoWorld, DEMO_OFFERS, DEMO_COMPETITORS_PER_OFFER } = await import('@repracer/contract-tests/live');
  const { PgPricingStore, PgStockStore, PgShadowStore } = await import('@repracer/pricing-store-pg');
  const { createStockPipeline } = await import('@repracer/stock-sync');
  const { runConfiguredWorker } = await import('./bulk-worker.ts');

  const demo = await demoWorld({
    tag, startIso: systemClock.now(), bare: false, appPool: pools.app, adminPool: pools.admin,
    provisioningPool: pools.provisioning, dispatcherPool: pools.dispatcher, schedulerPool: pools.scheduler,
    exporterPool: pools.exporter, stockPool: pools.stock,
    memberUsers: options.memberUsers, memberEmails: options.memberEmails, joinMember: options.joinMember,
    ...(options.writeMode ? { writeMode: options.writeMode } : {}),
    wallClock: true,
    ...(options.customerTenant ? { demo: false } : {}),
  });
  const seeded = demo.live.seeded;
  const store = new PgPricingStore(pools.app, { adminPool: pools.admin, bulkWorkerPool: pools.bulkWorker });
  if (options.locale || options.timeZone) {
    const saved = await store.setTenantDisplay(seeded.tenantId, { ...(options.locale ? { locale: options.locale } : {}), ...(options.timeZone ? { timeZone: options.timeZone } : {}) },
      { userId: seeded.userId, mfa: true });
    if (saved.status !== 'SAVED') throw new Error(`demo tenant display settings refused: ${saved.status}`);
  }
  // Шаг 79: демо настроено целиком — путь онбординга «остатки и цены» выбран, как его выбрал бы продавец; иначе экран Setup
  // спрашивал «что сделать сначала», когда цены уже работают, и выбранный путь нечем было показать
  const pathSaved = await store.saveOnboardingProgress(seeded.tenantId, { path: 'STOCK_AND_PRICING' },
    { membershipId: seeded.ownerMembershipId, userId: seeded.userId, mfa: true });
  if (pathSaved !== 'SAVED') throw new Error(`demo onboarding path refused: ${pathSaved}`);
  const stock = new PgStockStore({ adminPool: pools.admin, stockPool: pools.stock });
  const stockPipeline = createStockPipeline({
    store: stock, now: () => demo.clock.iso() as never, sleep: demo.clock.sleep,
    dispatchScope: (t, ws) => demo.live.dispatchScope(t, ws),
  });
  const accounts: Array<{ channelAccountId: string; channel: string; marketplaces: string[]; haltRelease: 'SAMPLE' | 'MANUAL_ONLY' }> =
    [{ channelAccountId: seeded.channelAccountId, channel: 'KAUFLAND', marketplaces: ['de'], haltRelease: 'SAMPLE' as const }];
  let usMarket: { stop(): void } | null = null;
  if (options.usAccounts) {
    const us = await addUsAccounts(pools, seeded, store);
    accounts.push(...us.accounts);
    // Шаг 68 (K6): тень США считает — себестоимость, границы и стратегии в долларах, конкуренты amazon.com — модель порта Amazon
    const { startDemoUsMarket } = await import('./demo-us.ts');
    usMarket = await startDemoUsMarket({
      pools: { admin: pools.admin, scheduler: pools.scheduler }, store,
      accounts: { tenantId: seeded.tenantId, userId: seeded.userId, ownerMembershipId: seeded.ownerMembershipId, ebayAccountId: us.ebay, amazonAccountId: us.amazon, walmartAccountId: us.walmart },
      pressDays: options.usPressDays ?? 0, log,
    });
  }
  const nowIso = () => demo.clock.iso();
  const descriptor = {
    id: 'demo/kaufland', title: 'Demo · Kaufland (Simulator)', tenantId: seeded.tenantId, accounts,
    description: `${DEMO_OFFERS} Angebote, je ${DEMO_COMPETITORS_PER_OFFER} Wettbewerber: Drift, Unterbieter, Preiswellen`,
  };
  const world = {
    id: descriptor.id, title: descriptor.title, description: descriptor.description,
    tenantId: seeded.tenantId, accounts, identityTenantId: seeded.tenantId, membershipAlias: (id: string) => id, failures: [],
    ...(options.writeMode === 'SHADOW' ? { landing: 'shadow' as const } : {}),
    store: store as never, stock, stockPipeline,
    // Шаг 41 [Р-169]: теневой режим читается у живого мира — режим лежит в базе у аккаунта
    shadow: new PgShadowStore({ adminPool: pools.admin }),
    // Ревью шага 69, находка 5: демо — один тенант на всех гостей, и язык у него — язык гостя; клиентский тенант прогонов — свой язык
    display: async () => {
      const d = await store.tenantDisplay(seeded.tenantId);
      return { locale: d.locale, timeZone: d.timeZone, timeZoneSet: d.timeZoneSet, ...(options.customerTenant ? {} : { followsRequestLocale: true }) };
    },
    /**
     * Шаг 68: путь решения мира — по каналу аккаунта вызова. Kaufland — путь живого мира симулятора; витрины США — свой путь со своим
     * описанием канала (доступность стратегии [Р-39] у eBay и Amazon своя), каналу консоль не звонит
     */
    pipeline: channelPipeline(demo.live.pipelineForDbIds(), accounts, store, nowIso) as never,
    clock: { iso: nowIso, nowMs: () => demo.clock.nowMs() } as never,
    callContext: (channelAccountId: string) => ({ tenantId: seeded.tenantId as never, channelAccountId: channelAccountId as never, correlationId: 'console-demo', deadline: nowIso() }),
    view: async (viewer: unknown, options?: { scopeIds?: readonly string[] }) => ({
      ...descriptor, now: nowIso(), viewer: { ...(viewer as object) }, state: await store.readConsoleState(seeded.tenantId, nowIso() as never, options),
    }) as never,
  } as unknown as LiveWorld;

  /**
   * Массовые операции демо выполняет исполнитель — иначе импорт, границы, стратегия и включение остались бы «в очереди»
   * навсегда, и показать путь онбординга было бы нельзя.
   */
  let stopped = false;
  let stopWorker = false;
  const worker = runConfiguredWorker({
    pgUrl: options.pgUrl, idleMs: 500, worlds: [{ descriptor, now: 'WALL_CLOCK' }],
    ...(options.pgUrlsByRole ? { pgUrlsByRole: options.pgUrlsByRole } : {}),
  }, () => stopWorker)
    .catch((error: unknown) => { if (!stopped) log(`demo bulk worker stopped: ${error instanceof Error ? error.message : String(error)}`); });
  // Время демо идёт, пока жив процесс. Конец прогона — тоже событие: молча остановившееся время выглядит как поломка цен
  const clockRun = demo.advance(options.hours ?? 24 * 365)
    .then(() => { if (!stopped) log('demo world reached the end of its run: prices no longer move — restart the console'); })
    .catch((error: unknown) => { if (!stopped) log(`demo world stopped: ${error instanceof Error ? error.message : String(error)}`); });
  void worker; void clockRun;

  log(`demo tenant ready: ${DEMO_OFFERS} offers, ${DEMO_COMPETITORS_PER_OFFER} competitors each`);
  return {
    world, tenantId: seeded.tenantId,
    stop() {
      stopped = true;
      // Останавливаются оба хода мира: планировщик (такт демо) и исполнитель заданий
      demo.stop();
      usMarket?.stop();
      stopWorker = true;
    },
  };
}

/** Сколько предложений у каждого аккаунта США в демо */
export const DEMO_US_OFFERS = 12;

/**
 * Шаг 64: аккаунты США демо-тенанта — путём продукта, а не посевом цен: аккаунт (в тени по умолчанию, Р-170), затем каталог функцией
 * обнаружения (`record_discovered_offers`). Строки — синтетические: номера листингов и SKU с приставкой SYN-DEMO-US
 */
export async function addUsAccounts(pools: DemoWorldPools, seeded: { tenantId: string; userId: string; ownerMembershipId: string },
  store: { recordDiscoveredOffers(tenantId: string, channelAccountId: string, offers: never[]): Promise<number> },
  /** Шаг 87: аккаунт amazon.com уже заведён посевом американского демо — заводится только eBay */
  existingAmazon: string | null = null,
  /** Шаг 89: американское демо — и walmart.com (на симуляторе) */
  withWalmart = false,
  /** Шаг 91: сколько предложений у каждого аккаунта — у лёгких продавцов вида преп-центра меньше */
  offers = DEMO_US_OFFERS):
  Promise<{ ebay: string; amazon: string; walmart: string | null; accounts: Array<{ channelAccountId: string; channel: string; marketplaces: string[]; haltRelease: 'SAMPLE' | 'MANUAL_ONLY' }> }> {
  const { randomUUID } = await import('node:crypto');
  const { inTenant } = await import('@repracer/pricing-store-pg');
  const ebay = randomUUID();
  const amazon = existingAmazon ?? randomUUID();
  const walmart = withWalmart ? randomUUID() : null;
  /**
   * Ревью шага 64, находка 2: внешний идентификатор аккаунта уникален по всей платформе среди неотключённых, а прежний демо-тенант
   * остаётся в базе. Постоянный идентификатор ронял каждый пересев (23505) и старт консоли на той же базе — у каждого посева свой
   */
  const suffix = seeded.tenantId.replace(/-/g, '').slice(0, 8);
  await inTenant(pools.admin, seeded.tenantId, async (tx) => {
    const rows = [[ebay, 'EBAY', null, `syn_demo_ebay_us_${suffix}`, 'EBAY_US'], [amazon, 'AMAZON', 'NA', `A1SYNDEMOUS${suffix.toUpperCase()}`, 'ATVPDKIKX0DER'],
      ...(walmart ? [[walmart, 'WALMART', null, `syn-demo-walmart-${suffix}`, 'WALMART_US']] : [])] as const;
    for (const [id, channel, region, external, marketplace] of rows.filter((r) => !(existingAmazon && r[1] === 'AMAZON'))) {
      await tx.query(
        `INSERT INTO tenant_data.channel_account (tenant_id, channel_account_id, channel, region, external_account_id, marketplaces, credentials_ref, connected_by_membership_id)
         VALUES ($1, $2, $3, $4, $5, $6, 'secret-ref:synthetic', $7)`, [seeded.tenantId, id, channel, region, external, [marketplace], seeded.ownerMembershipId]);
    }
  }, seeded.userId);
  const n = (i: number) => String(i + 1).padStart(2, '0');
  await store.recordDiscoveredOffers(seeded.tenantId, ebay, Array.from({ length: offers }, (_, i) => ({
    marketplace: 'EBAY_US', externalSku: `SYN-DEMO-US-EBAY-${n(i)}`, externalUnitId: null, externalOfferId: `9640${n(i)}0000`, channelProductRef: null,
    gtin: null, condition: 'new', fulfillment: 'MERCHANT', externalListingId: `16400000${n(i)}00`, listingFormat: 'FIXED_PRICE', writable: true,
  })) as never[]);
  await store.recordDiscoveredOffers(seeded.tenantId, amazon, Array.from({ length: offers }, (_, i) => ({
    marketplace: 'ATVPDKIKX0DER', externalSku: `SYN-DEMO-US-AMZ-${n(i)}`, externalUnitId: null, externalOfferId: null, channelProductRef: `B0DEMOUS${n(i)}`,
    gtin: null, condition: 'new', fulfillment: 'MERCHANT',
  })) as never[]);
  // Шаг 89: walmart.com — 12 предложений; ссылка на товар у Walmart — SKU продавца (опрос Buy Box спрашивает по нему, W-05)
  if (walmart) {
    await store.recordDiscoveredOffers(seeded.tenantId, walmart, Array.from({ length: offers }, (_, i) => ({
      marketplace: 'WALMART_US', externalSku: `SYN-DEMO-US-WMT-${n(i)}`, externalUnitId: null, externalOfferId: null, channelProductRef: `SYN-DEMO-US-WMT-${n(i)}`,
      gtin: null, condition: 'new', fulfillment: 'MERCHANT',
    })) as never[]);
  }
  return {
    ebay, amazon, walmart,
    accounts: [
      { channelAccountId: ebay, channel: 'EBAY', marketplaces: ['EBAY_US'], haltRelease: 'MANUAL_ONLY' },
      { channelAccountId: amazon, channel: 'AMAZON', marketplaces: ['ATVPDKIKX0DER'], haltRelease: 'MANUAL_ONLY' },
      ...(walmart ? [{ channelAccountId: walmart, channel: 'WALMART', marketplaces: ['WALMART_US'], haltRelease: 'MANUAL_ONLY' as const }] : []),
    ],
  };
}

/** Путь решения демо-мира по каналу аккаунта вызова: Kaufland — путь симулятора, остальные каналы — путь со своим описанием */
export function channelPipeline(kaufland: object | null, accounts: ReadonlyArray<{ channelAccountId: string; channel: string }>, store: object, now: () => string): object {
  const others = new Map<string, object>();
  const pipelineOf = async (channel: string): Promise<object> => {
    if (channel === 'KAUFLAND' && kaufland) return kaufland;
    let p = others.get(channel);
    if (!p) {
      const [{ createPricingPipeline }, { consoleAdapter }] = await Promise.all([import('@repracer/pricing-pipeline'), import('./channel-descriptors.ts')]);
      p = createPricingPipeline({ store: store as never, adapter: consoleAdapter(channel), alerts: { raise: async () => undefined }, logger: { log: () => undefined }, now: now as never });
      others.set(channel, p);
    }
    return p;
  };
  return new Proxy({}, {
    get: (_t, method) => async (ctx: { channelAccountId: string }, ...rest: unknown[]) => {
      const channel = accounts.find((a) => a.channelAccountId === ctx.channelAccountId)?.channel ?? (kaufland ? 'KAUFLAND' : 'AMAZON');
      return ((await pipelineOf(channel)) as Record<string, (...a: unknown[]) => unknown>)[method as string]!(ctx, ...rest);
    },
  });
}

/** Шаг 87: сколько штук каждого товара на складе американского демо — спрос amazon.com съедает их не раньше, чем через несколько суток */
export const DEMO_US_ON_HAND = 60;
/** Шаг 87: склад американского продавца — первый клиент в Делавэре [Р-214] */
export const DEMO_US_WAREHOUSE = 'Warehouse Newark, DE';

/**
 * Шаг 87 [Р-214]: демо профиля us — американский продавец на симуляторе. Тенант рождается с аккаунтом amazon.com (регион NA, доллары),
 * рядом — eBay US; Kaufland и витрин ЕС нет вовсе. Каталог — функцией обнаружения, цены, себестоимость, комиссия (версия тарифа — месяц
 * действия), границы и стратегии — тем же модулем, что тень США до шага 87 (`demo-us.ts`), с прожатой неделей. Остатки — склад
 * «Warehouse Newark, DE», синхронизация количества amazon.com включена (в тени запись удерживается), спрос — синтетические заказы
 * amazon.com: продажа становится резервацией. Регион тенанта — регион базы: подготовка демо ставит базе US [Р-60], прогоны — как есть
 */
async function startUsDemoWorld(options: DemoWorldOptions): Promise<RunningDemoWorld> {
  const { pools, tag } = options;
  const log = options.log ?? ((m: string) => console.log(m));
  const { randomUUID } = await import('node:crypto');
  const { seedPricingWorld, PgPricingStore, PgStockStore, PgShadowStore, inTenant } = await import('@repracer/pricing-store-pg');
  const { createStockPipeline } = await import('@repracer/stock-sync');
  const { runConfiguredWorker } = await import('./bulk-worker.ts');
  const { startDemoUsMarket } = await import('./demo-us.ts');
  const AMAZON_US = US_STOREFRONTS.AMAZON![0]!;
  const { rows: [region] } = await pools.app.query(`SELECT current_setting('repracer.region', true) AS region`);
  const suffix = randomUUID().replace(/-/g, '').slice(0, 8);
  const seeded = await seedPricingWorld(pools.app, {
    fixtureTenantId: `10000000-0000-4000-8000-00000000${String(tag).padStart(4, '0')}`,
    fixtureChannelAccountId: `20000000-0000-4000-8000-00000000${String(tag).padStart(4, '0')}`,
    fixtureChannel: 'AMAZON', fixtureRegion: 'NA', fixtureExternalAccountId: `A1SYNDEMOUS${suffix.toUpperCase()}`,
    marketplaces: [AMAZON_US], clock: systemClock.now() as never, seed: { scopes: [], marketplaces: { [AMAZON_US]: { currency: 'USD', basis: 'NET' } } } as never,
    provisioningPool: pools.provisioning, adminPool: pools.admin, tenantRegion: region?.region === 'US' ? 'US' : 'EU',
    // Р-169: демо в тени — в канал не уходит ничего; бой на amazon.com база и не откроет, пока граница суток не подтверждена [Р-172]
    writeMode: options.writeMode ?? 'SHADOW', ...(options.customerTenant ? {} : { demo: true }),
    memberUsers: options.memberUsers, memberEmails: options.memberEmails, joinMember: options.joinMember,
  });
  const store = new PgPricingStore(pools.app, { adminPool: pools.admin, bulkWorkerPool: pools.bulkWorker });
  if (options.locale || options.timeZone) {
    const saved = await store.setTenantDisplay(seeded.tenantId, { ...(options.locale ? { locale: options.locale } : {}), ...(options.timeZone ? { timeZone: options.timeZone } : {}) },
      { userId: seeded.userId, mfa: true });
    if (saved.status !== 'SAVED') throw new Error(`demo tenant display settings refused: ${saved.status}`);
  }
  const actor = { membershipId: seeded.ownerMembershipId, userId: seeded.userId, mfa: true };
  const pathSaved = await store.saveOnboardingProgress(seeded.tenantId, { path: 'STOCK_AND_PRICING' }, actor);
  if (pathSaved !== 'SAVED') throw new Error(`demo onboarding path refused: ${pathSaved}`);
  const us = await addUsAccounts(pools, seeded, store as never, seeded.channelAccountId, true);

  // Остатки: склад, инвентаризация каждого товара, синхронизация количества amazon.com (вопрос о других инструментах — «нет»)
  const stock = new PgStockStore({ adminPool: pools.admin, stockPool: pools.stock });
  const source = await stock.createStockSource(seeded.tenantId, { mode: 'INTERNAL_POOL', name: DEMO_US_WAREHOUSE }, actor);
  if (source.status !== 'CREATED') throw new Error(`demo stock source: ${source.status}`);
  const skus = await inTenant(pools.admin, seeded.tenantId, async (tx) =>
    (await tx.query(`SELECT sku FROM tenant_data.product WHERE tenant_id = $1 ORDER BY sku`, [seeded.tenantId])).rows.map((r) => String(r.sku)), seeded.userId);
  const imported = await stock.importStock(seeded.tenantId, source.stockSourceId, skus.map((sku) => ({ sku, quantity: DEMO_US_ON_HAND })), actor);
  if (imported.status !== 'APPLIED') throw new Error(`demo stock import: ${imported.status}`);
  await stock.answerOtherTools(seeded.tenantId, us.amazon, 'NONE', actor);
  const confirmed = await stock.confirmQuantityWrites(seeded.tenantId, us.amazon, (await stock.quantityWritesState(seeded.tenantId, us.amazon))!.externalAccountId, actor);
  if (confirmed.status !== 'CONFIRMED') throw new Error(`demo quantity writes: ${confirmed.status}`);
  // Р-1: у amazon.com остаток MFN — одно значение на регион аккаунта (Северная Америка); ловушку продавец подтверждает до записи [Р-153]
  const enabled = await stock.enableStockSync(seeded.tenantId, us.amazon, { bufferUnits: 2, maxQuantity: null, minQuantityToList: 0, acknowledgeSideEffects: true }, actor);
  if (enabled.status !== 'ENABLED') throw new Error(`demo stock sync: ${enabled.status}`);
  await stock.recalculate(seeded.tenantId, null, systemClock.now() as never);
  const stockPipeline = createStockPipeline({ store: stock, now: () => systemClock.now() as never });

  const usMarket = await startDemoUsMarket({
    pools: { admin: pools.admin, scheduler: pools.scheduler }, store,
    accounts: { tenantId: seeded.tenantId, userId: seeded.userId, ownerMembershipId: seeded.ownerMembershipId, ebayAccountId: us.ebay, amazonAccountId: us.amazon, walmartAccountId: us.walmart },
    pressDays: options.usPressDays ?? 0, log,
    orders: { pipeline: stockPipeline, skus: skus.filter((sku) => sku.includes('-AMZ-')) },
    // Шаг 103 [Р-228]: умолчание amazon.com и два новых листинга — только у главного демо, не у лёгких продавцов
    newOffers: true,
  });
  const accounts = us.accounts;
  const nowIso = () => systemClock.now();
  const descriptor = {
    id: 'demo/us', title: 'Demo · amazon.com (Simulator)', tenantId: seeded.tenantId, accounts,
    description: `${DEMO_US_OFFERS} offers each on amazon.com, ebay.com and walmart.com, a warehouse in Newark, Delaware`,
  };
  const world = {
    id: descriptor.id, title: descriptor.title, description: descriptor.description,
    tenantId: seeded.tenantId, accounts, identityTenantId: seeded.tenantId, membershipAlias: (id: string) => id, failures: [],
    landing: 'shadow' as const,
    store: store as never, stock, stockPipeline,
    shadow: new PgShadowStore({ adminPool: pools.admin }),
    display: async () => {
      const d = await store.tenantDisplay(seeded.tenantId);
      return { locale: d.locale, timeZone: d.timeZone, timeZoneSet: d.timeZoneSet, ...(options.customerTenant ? {} : { followsRequestLocale: true }) };
    },
    pipeline: channelPipeline(null, accounts, store, nowIso) as never,
    clock: { iso: nowIso, nowMs: () => systemClock.nowMs() } as never,
    callContext: (channelAccountId: string) => ({ tenantId: seeded.tenantId as never, channelAccountId: channelAccountId as never, correlationId: 'console-demo', deadline: nowIso() }),
    view: async (viewer: unknown, viewOptions?: { scopeIds?: readonly string[] }) => ({
      ...descriptor, now: nowIso(), viewer: { ...(viewer as object) }, state: await store.readConsoleState(seeded.tenantId, nowIso() as never, viewOptions),
    }) as never,
  } as unknown as LiveWorld;

  let stopped = false;
  let stopWorker = false;
  const worker = runConfiguredWorker({
    pgUrl: options.pgUrl, idleMs: 500, worlds: [{ descriptor, now: 'WALL_CLOCK' }],
    ...(options.pgUrlsByRole ? { pgUrlsByRole: options.pgUrlsByRole } : {}),
  }, () => stopWorker)
    .catch((error: unknown) => { if (!stopped) log(`demo bulk worker stopped: ${error instanceof Error ? error.message : String(error)}`); });
  void worker;
  log(`demo tenant ready (market us): ${DEMO_US_OFFERS} offers each on amazon.com, ebay.com and walmart.com, warehouse ${DEMO_US_WAREHOUSE}`);
  return {
    world, tenantId: seeded.tenantId,
    stop() {
      stopped = true;
      usMarket.stop();
      stopWorker = true;
    },
  };
}
