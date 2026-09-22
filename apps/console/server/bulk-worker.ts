import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { bulkJobHandlers } from '@repracer/bulk-jobs/handlers';
import { bulkWorldReader, runBulkWorker, type BulkWorldDescriptor } from '@repracer/bulk-jobs/worker';
import type { Instant } from '@repracer/channel-port';
import { createPool, IdMap, PgPricingStore, PgStockStore, translateStore } from '@repracer/pricing-store-pg';
import { createPricingPipeline, type PricingStore } from '@repracer/pricing-pipeline';
import { AMAZON_DESCRIPTOR } from '@repracer/amazon-adapter';
import { KAUFLAND_DESCRIPTOR } from '@repracer/kaufland-adapter';

/**
 * Р-139 (шаг 30): фоновый исполнитель массовых операций стенда — ОТДЕЛЬНЫЙ процесс. Так и в работе: сервер экранов отвечает
 * продавцу, пока задание применяется, а падение применения не роняет консоль. Отдельный процесс нужен и для проверки: «процесс
 * убит посреди применения» проверяется настоящим убийством процесса, а не имитацией.
 *
 * Что процесс получает снаружи (файл JSON, путь — в `BULK_WORKER_CONFIG`):
 * - миры стенда: тенант, аккаунты и МОМЕНТ, на который читается состояние;
 * - карта псевдонимов сценария: на стенде идентификаторы мира — псевдонимы, а в базе UUID. В работе карты нет вовсе.
 *
 * Данные продавца сюда не попадают: миры стенда синтетические.
 */

export interface BulkWorkerWorldConfig {
  descriptor: BulkWorldDescriptor;
  /**
   * Момент, на который исполнитель читает состояние мира: у миров стенда часы виртуальные и стоят. `WALL_CLOCK` — настоящее
   * время: так живёт демо-тенант [Р-151], у которого данные, внесённые через консоль, действуют с настоящего момента.
   */
  now: Instant | 'WALL_CLOCK';
  /** Пары «псевдоним → UUID»; пусто — идентификаторы мира и базы совпадают (так будет в работе) */
  idAliases?: Array<[string, string]>;
}

export interface BulkWorkerConfig {
  pgUrl: string;
  worlds: BulkWorkerWorldConfig[];
  owner?: string;
  leaseSeconds?: number;
  progressEverySeconds?: number;
  idleMs?: number;
}

/** Хранилище мира: та же роль, что у консоли (svc_admin для административной записи, svc_app для чтения) [Р-90] */
function storeFor(pgUrl: string, world: BulkWorkerWorldConfig): PricingStore {
  const role = (login: string, max: number) => createPool(pgUrl.replace('svc_app@', `${login}@`), { max, applicationName: `repracer-bulk-${login}` });
  /**
   * Три роли [Р-90]: чтение состояния — svc_app; сама работа — svc_admin от имени человека, создавшего задание; аренда и ход —
   * svc_bulk_worker, потому что это записи машины, а не административная запись человека.
   */
  const inner = new PgPricingStore(createPool(pgUrl, { max: 2, applicationName: 'repracer-bulk' }),
    { adminPool: role('svc_admin', 3), bulkWorkerPool: role('svc_bulk_worker', 2) });
  return world.idAliases && world.idAliases.length > 0 ? translateStore(inner, IdMap.of(world.idAliases)) : inner;
}

/** Шаг 35 [Р-152]: остатки — административная роль (человеком) и роль остатков [Р-102] */
function stockStoreFor(pgUrl: string): PgStockStore {
  const role = (login: string, max: number) => createPool(pgUrl.replace('svc_app@', `${login}@`), { max, applicationName: `repracer-bulk-${login}` });
  return new PgStockStore({ adminPool: role('svc_admin', 2), stockPool: role('svc_stock', 2) });
}

/**
 * OQ-201: предпросмотр стратегии считает путь решения. Канал при этом НЕ опрашивается — считается по последнему принятому
 * снимку, — поэтому адаптер здесь заглушка, у которой есть только описание канала: по нему определяется доступность стратегии
 * [Р-39]. Любое обращение к каналу из предпросмотра — ошибка, и она падает громко, а не проходит тишиной.
 */
function previewPipelineFor(store: PricingStore, channel: string, now: () => Instant) {
  const descriptor = channel === 'AMAZON' ? AMAZON_DESCRIPTOR : KAUFLAND_DESCRIPTOR;
  const adapter = new Proxy({ descriptor } as Record<string, unknown>, {
    get: (target, key) => (key in target ? target[key as string] : () => { throw new Error(`предпросмотр стратегии обратился к каналу: ${String(key)}`); }),
  }) as never;
  return createPricingPipeline({ store: store as never, adapter, alerts: { raise: async () => undefined }, logger: { log: () => undefined }, now: now as never });
}

export async function runConfiguredWorker(config: BulkWorkerConfig, stopped: () => boolean = () => false): Promise<void> {
  const owner = config.owner ?? `bulk-worker-${process.pid}`;
  await Promise.all(config.worlds.map(async (world) => {
    const store = storeFor(config.pgUrl, world);
    const now = (): Instant => (world.now === 'WALL_CLOCK' ? new Date().toISOString() as Instant : world.now);
    // Свой путь решения на канал: доступность стратегии — свойство канала, и один пайплайн на все каналы дал бы чужой ответ
    const pipelines = new Map(world.descriptor.accounts.map((a) => [a.channelAccountId, previewPipelineFor(store, a.channel, now)]));
    const handlers = bulkJobHandlers({
      world: bulkWorldReader(store, world.descriptor, now),
      stock: stockStoreFor(config.pgUrl),
      // Шаг 34 [Р-149]: включение движка — тем же путём решения, что предпросмотр: канал не опрашивается
      enableRepricing: async (ctx, scope) => {
        const pipeline = pipelines.get(scope.channelAccountId);
        if (!pipeline) throw new Error(`аккаунт ${scope.channelAccountId} не описан в настройках исполнителя`);
        const result = await pipeline.enableRepricing({
          tenantId: world.descriptor.tenantId as never, channelAccountId: scope.channelAccountId as never,
          correlationId: `bulk-enable:${scope.writeScopeId}`, deadline: now(),
        }, scope.writeScopeId, { userId: ctx.userId });
        /**
         * Массовое включение предупреждений не подтверждает: подтвердить их может только человек, глядя на само предложение.
         * Но отказ по предупреждению не должен остаться без причины (ревью шага 34, находка 13) — она и называется итогу.
         */
        const reasons = result.problems.length > 0 ? result.problems : result.warnings;
        return { enabled: result.enabled, problems: reasons.map((x) => ({ code: x.code, params: x.params as Record<string, unknown> })) };
      },
      previewStrategy: async (_ctx, scope, strategy) => {
        const pipeline = pipelines.get(scope.channelAccountId);
        if (!pipeline) throw new Error(`аккаунт ${scope.channelAccountId} не описан в настройках исполнителя`);
        return pipeline.previewStrategy({
          tenantId: world.descriptor.tenantId as never, channelAccountId: scope.channelAccountId as never,
          correlationId: `bulk-preview:${scope.writeScopeId}`, deadline: now(),
        }, scope.writeScopeId, strategy);
      },
    });
    await runBulkWorker({
      store, tenantId: world.descriptor.tenantId, owner, handlers, stopped,
      ...(config.leaseSeconds === undefined ? {} : { leaseSeconds: config.leaseSeconds }),
      ...(config.progressEverySeconds === undefined ? {} : { progressEverySeconds: config.progressEverySeconds }),
      ...(config.idleMs === undefined ? {} : { idleMs: config.idleMs }),
      // Процесс сообщает о готовности задания в поток вывода: по этой строке видно, чем он занят, без данных продавца
      onFinished: ({ jobId, kind, status }) => console.log(JSON.stringify({ event: 'bulk-job', jobId, kind, status })),
    });
  }));
}

async function main(): Promise<void> {
  const path = process.env.BULK_WORKER_CONFIG;
  if (!path) throw new Error('BULK_WORKER_CONFIG must point to the worker configuration file');
  const config = JSON.parse(readFileSync(path, 'utf8')) as BulkWorkerConfig;
  let stop = false;
  // Остановка по сигналу — между заданиями: прерывать применение посередине незачем, оно и так целиком или никак [Р-134]
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { stop = true; });
  console.log(JSON.stringify({ event: 'bulk-worker-ready', worlds: config.worlds.length }));
  await runConfiguredWorker(config, () => stop);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
