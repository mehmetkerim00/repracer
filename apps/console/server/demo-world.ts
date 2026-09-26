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
  /** Шаг 41 [Р-169]: режим записи аккаунта демо; `SHADOW` — ни одной записи в канал */
  writeMode?: 'SHADOW' | 'LIVE';
  log?: (message: string) => void;
}

export async function startDemoWorld(options: DemoWorldOptions): Promise<RunningDemoWorld> {
  const { pools, tag } = options;
  const log = options.log ?? ((m: string) => console.log(m));
  const { demoWorld, DEMO_OFFERS, DEMO_COMPETITORS_PER_OFFER } = await import('@repracer/contract-tests/live');
  const { PgPricingStore, PgStockStore, PgShadowStore } = await import('@repracer/pricing-store-pg');
  const { createStockPipeline } = await import('@repracer/stock-sync');
  const { runConfiguredWorker } = await import('./bulk-worker.ts');

  const demo = await demoWorld({
    tag, startIso: new Date().toISOString(), bare: false, appPool: pools.app, adminPool: pools.admin,
    provisioningPool: pools.provisioning, dispatcherPool: pools.dispatcher, schedulerPool: pools.scheduler,
    exporterPool: pools.exporter, stockPool: pools.stock,
    memberUsers: options.memberUsers, memberEmails: options.memberEmails, joinMember: options.joinMember,
    ...(options.writeMode ? { writeMode: options.writeMode } : {}),
    wallClock: true,
  });
  const seeded = demo.live.seeded;
  const store = new PgPricingStore(pools.app, { adminPool: pools.admin, bulkWorkerPool: pools.bulkWorker });
  const stock = new PgStockStore({ adminPool: pools.admin, stockPool: pools.stock });
  const stockPipeline = createStockPipeline({
    store: stock, now: () => demo.clock.iso() as never, sleep: demo.clock.sleep,
    dispatchScope: (t, ws) => demo.live.dispatchScope(t, ws),
  });
  const accounts = [{ channelAccountId: seeded.channelAccountId, channel: 'KAUFLAND', marketplaces: ['de'], haltRelease: 'SAMPLE' as const }];
  const nowIso = () => demo.clock.iso();
  const descriptor = {
    id: 'demo/kaufland', title: 'Demo · Kaufland (Simulator)', tenantId: seeded.tenantId, accounts,
    description: `${DEMO_OFFERS} Angebote, je ${DEMO_COMPETITORS_PER_OFFER} Wettbewerber: Drift, Unterbieter, Preiswellen`,
  };
  const world = {
    id: descriptor.id, title: descriptor.title, description: descriptor.description,
    tenantId: seeded.tenantId, accounts, identityTenantId: seeded.tenantId, membershipAlias: (id: string) => id, failures: [],
    store: store as never, stock, stockPipeline,
    // Шаг 41 [Р-169]: теневой режим читается у живого мира — режим лежит в базе у аккаунта
    shadow: new PgShadowStore({ adminPool: pools.admin }),
    pipeline: demo.live.pipelineForDbIds() as never,
    clock: { iso: nowIso, nowMs: () => demo.clock.nowMs() } as never,
    callContext: (channelAccountId: string) => ({ tenantId: seeded.tenantId as never, channelAccountId: channelAccountId as never, correlationId: 'console-demo', deadline: nowIso() }),
    view: async (viewer: unknown) => ({
      ...descriptor, now: nowIso(), viewer: { ...(viewer as object) }, state: await store.readConsoleState(seeded.tenantId, nowIso() as never),
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
      stopWorker = true;
    },
  };
}
