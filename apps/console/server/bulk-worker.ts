import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { bulkJobHandlers } from '@repracer/bulk-jobs/handlers';
import { bulkWorldReader, runBulkWorker, type BulkWorldDescriptor } from '@repracer/bulk-jobs/worker';
import type { Instant } from '@repracer/channel-port';
import { createPool, IdMap, PgPricingStore, translateStore } from '@repracer/pricing-store-pg';
import type { PricingStore } from '@repracer/pricing-pipeline';

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
  /** Момент, на который исполнитель читает состояние мира: у миров стенда часы виртуальные */
  now: Instant;
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

export async function runConfiguredWorker(config: BulkWorkerConfig, stopped: () => boolean = () => false): Promise<void> {
  const owner = config.owner ?? `bulk-worker-${process.pid}`;
  await Promise.all(config.worlds.map(async (world) => {
    const store = storeFor(config.pgUrl, world);
    const handlers = bulkJobHandlers({ world: bulkWorldReader(store, world.descriptor, () => world.now) });
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
