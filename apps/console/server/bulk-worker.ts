import { systemClock } from '@repracer/channel-port';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { bulkJobHandlers } from '@repracer/bulk-jobs/handlers';
import { bulkWorldReader, runBulkWorker, type BulkWorldDescriptor } from '@repracer/bulk-jobs/worker';
import type { Instant } from '@repracer/channel-port';
import { createPool, IdMap, PgPricingStore, PgStockStore, translateStore } from '@repracer/pricing-store-pg';
import { createPricingPipeline, type PricingStore } from '@repracer/pricing-pipeline';
import { descriptorOf, haltReleaseOf } from './channel-descriptors.ts';
import { ConfigError, createHeartbeat, intFromEnv, ProcessHealth, requiredValue, secretFromEnv, serveHealth, type Env } from '@repracer/service-runtime';

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
  /**
   * Строки подключения по ролям (шаг 37, находка 1 ревью): БЕЗ них роли выводились подстановкой `svc_app@` → `svc_admin@`,
   * а в работе строка несёт пароль (`postgres://svc_app:ПАРОЛЬ@…`) — подстроки `svc_app@` в ней нет, замена молча ничего
   * не меняет, и все три пула подключаются ОДНОЙ ролью. Зелено в прогонах (там строки без пароля) и сломано в работе.
   * Разворачиваемый процесс обязан передавать роли явно; стенд разработчика их по-прежнему выводит и говорит это вслух.
   */
  pgUrlsByRole?: Readonly<Record<'admin' | 'bulk_worker' | 'stock', string>>;
  worlds: BulkWorkerWorldConfig[];
  /**
   * Шаг 44 [Р-178]: задания ВСЕХ тенантов — тех, у кого есть ждущее задание (`security.bulk_job_waiting_tenants`).
   * Так работает процесс в работе: тенанта, заведённого после запуска, в конфигурации нет и быть не может.
   */
  /** lingerMs — сколько цикл тенанта живёт после его последнего ждущего задания (по умолчанию 30 с) */
  allTenants?: { pollMs: number; lingerMs?: number };
  owner?: string;
  leaseSeconds?: number;
  progressEverySeconds?: number;
  idleMs?: number;
}

/**
 * Строка подключения роли. Явно заданная — берётся как есть; иначе выводится подстановкой из строки пути решения, и это
 * допустимо ТОЛЬКО там, где строки без пароля (стенд разработчика, прогоны). Подстановка, не изменившая строку, —
 * молчаливый уход под чужой ролью, поэтому здесь она падает вслух (находка 1 ревью шага 37).
 */
function roleUrl(config: { pgUrl: string; pgUrlsByRole?: Readonly<Record<string, string>> }, login: string): string {
  const explicit = config.pgUrlsByRole?.[login.replace(/^svc_/, '')];
  if (explicit) return explicit;
  const derived = config.pgUrl.replace('svc_app@', `${login}@`);
  if (derived === config.pgUrl) {
    throw new Error(`BULK_WORKER_ROLE_URL_MISSING: ${login} — строка подключения роли не задана, а вывести её из строки пути решения нельзя [Р-90]`);
  }
  return derived;
}

/**
 * Находка 17 ревью шага 44: пулы исполнителя закрываются при остановке. Каждый пул регистрируется у своей конфигурации,
 * и `runConfiguredWorker` закрывает их, когда все циклы вышли: иначе процесс после SIGTERM висел на открытых подключениях.
 */
const poolsOf = new WeakMap<BulkWorkerConfig, ReturnType<typeof createPool>[]>();
function poolFor(config: BulkWorkerConfig, url: string, options: Parameters<typeof createPool>[1]) {
  const created = createPool(url, options);
  const list = poolsOf.get(config) ?? [];
  list.push(created);
  poolsOf.set(config, list);
  return created;
}

/** Хранилище мира: та же роль, что у консоли (svc_admin для административной записи, svc_app для чтения) [Р-90] */
const sharedStores = new WeakMap<BulkWorkerConfig, PgPricingStore>();
function storeFor(config: BulkWorkerConfig, world: BulkWorkerWorldConfig): PricingStore {
  /**
   * Шаг 44: хранилище (и его пулы) — ОДНО на процесс, а не на мир: у исполнителя «все тенанты» миров столько, сколько
   * тенантов с заданиями, и пулы на каждый исчерпали бы подключения базы. Контекст тенанта задаёт каждый вызов сам.
   */
  const shared = sharedStores.get(config);
  if (shared && !(world.idAliases && world.idAliases.length > 0)) return shared;
  const pgUrl = config.pgUrl;
  const role = (login: string, max: number) => poolFor(config, roleUrl(config, login), { max, applicationName: `repracer-bulk-${login}` });
  /**
   * Три роли [Р-90]: чтение состояния — svc_app; сама работа — svc_admin от имени человека, создавшего задание; аренда и ход —
   * svc_bulk_worker, потому что это записи машины, а не административная запись человека.
   */
  const inner = new PgPricingStore(poolFor(config, pgUrl, { max: 2, applicationName: 'repracer-bulk' }),
    { adminPool: role('svc_admin', 3), bulkWorkerPool: role('svc_bulk_worker', 2) });
  if (world.idAliases && world.idAliases.length > 0) return translateStore(inner, IdMap.of(world.idAliases));
  sharedStores.set(config, inner);
  return inner;
}

/** Шаг 35 [Р-152]: остатки — административная роль (человеком) и роль остатков [Р-102] */
const sharedStock = new WeakMap<BulkWorkerConfig, PgStockStore>();
function stockStoreFor(config: BulkWorkerConfig): PgStockStore {
  const cached = sharedStock.get(config);
  if (cached) return cached;
  const role = (login: string, max: number) => poolFor(config, roleUrl(config, login), { max, applicationName: `repracer-bulk-${login}` });
  const created = new PgStockStore({ adminPool: role('svc_admin', 2), stockPool: role('svc_stock', 2) });
  sharedStock.set(config, created);
  return created;
}

/**
 * OQ-201: предпросмотр стратегии считает путь решения. Канал при этом НЕ опрашивается — считается по последнему принятому
 * снимку, — поэтому адаптер здесь заглушка, у которой есть только описание канала: по нему определяется доступность стратегии
 * [Р-39]. Любое обращение к каналу из предпросмотра — ошибка, и она падает громко, а не проходит тишиной.
 */
function previewPipelineFor(store: PricingStore, channel: string, now: () => Instant) {
  const descriptor = descriptorOf(channel);
  const adapter = new Proxy({ descriptor } as Record<string, unknown>, {
    get: (target, key) => (key in target ? target[key as string] : () => { throw new Error(`предпросмотр стратегии обратился к каналу: ${String(key)}`); }),
  }) as never;
  return createPricingPipeline({ store: store as never, adapter, alerts: { raise: async () => undefined }, logger: { log: () => undefined }, now: now as never });
}

/** Мир одного тенанта: аккаунты описания обновляются на ходу — канал, подключённый после запуска, получает свой путь решения */
async function runWorld(config: BulkWorkerConfig, world: BulkWorkerWorldConfig, owner: string, stopped: () => boolean): Promise<void> {
  const store = storeFor(config, world);
  const now = (): Instant => (world.now === 'WALL_CLOCK' ? systemClock.now() : world.now);
  // Свой путь решения на канал: доступность стратегии — свойство канала, и один пайплайн на все каналы дал бы чужой ответ
  const pipelines = new Map<string, ReturnType<typeof previewPipelineFor>>();
  const pipelineOf = (channelAccountId: string) => {
    const account = world.descriptor.accounts.find((a) => a.channelAccountId === channelAccountId);
    if (!account) throw new Error(`аккаунт ${channelAccountId} не описан в мире исполнителя`);
    let pipeline = pipelines.get(channelAccountId);
    if (!pipeline) {
      pipeline = previewPipelineFor(store, account.channel, now);
      pipelines.set(channelAccountId, pipeline);
    }
    return pipeline;
  };
  const handlers = bulkJobHandlers({
    world: bulkWorldReader(store, world.descriptor, now),
    stock: stockStoreFor(config),
    // Шаг 34 [Р-149]: включение движка — тем же путём решения, что предпросмотр: канал не опрашивается
    enableRepricing: async (ctx, scope) => {
      const result = await pipelineOf(scope.channelAccountId).enableRepricing({
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
    previewStrategy: async (_ctx, scope, strategy) => pipelineOf(scope.channelAccountId).previewStrategy({
      tenantId: world.descriptor.tenantId as never, channelAccountId: scope.channelAccountId as never,
      correlationId: `bulk-preview:${scope.writeScopeId}`, deadline: now(),
    }, scope.writeScopeId, strategy),
  });
  await runBulkWorker({
    store, tenantId: world.descriptor.tenantId, owner, handlers, stopped,
    ...(config.leaseSeconds === undefined ? {} : { leaseSeconds: config.leaseSeconds }),
    ...(config.progressEverySeconds === undefined ? {} : { progressEverySeconds: config.progressEverySeconds }),
    ...(config.idleMs === undefined ? {} : { idleMs: config.idleMs }),
    // Процесс сообщает о готовности задания в поток вывода: по этой строке видно, чем он занят, без данных продавца
    onFinished: ({ jobId, kind, status }) => console.log(JSON.stringify({ event: 'bulk-job', jobId, kind, status })),
  });
}

export async function runConfiguredWorker(config: BulkWorkerConfig, stopped: () => boolean = () => false): Promise<void> {
  const owner = config.owner ?? `bulk-worker-${process.pid}`;
  const running: Array<Promise<void>> = config.worlds.map((world) => runWorld(config, world, owner, stopped));
  if (config.allTenants) {
    const poll = config.allTenants.pollMs;
    const workerPool = poolFor(config, roleUrl(config, 'svc_bulk_worker'), { max: 1, applicationName: 'repracer-bulk-tenants' });
    const admin = new PgPricingStore(poolFor(config, config.pgUrl, { max: 1, applicationName: 'repracer-bulk-accounts' }), { adminPool: poolFor(config, roleUrl(config, 'svc_admin'), { max: 1, applicationName: 'repracer-bulk-accounts-admin' }) });
    const tenantLoops = new Set<Promise<void>>();
    /**
     * Находки 6 и 7 ревью шага 44: цикл тенанта живёт, пока у тенанта есть ЖДУЩИЕ задания, — не вечно; сбой базы в цикле
     * одного тенанта не роняет процесс (консоль с публичным демо), а убирает цикл, и следующий обход заведёт его снова.
     */
    const worlds = new Map<string, BulkWorkerWorldConfig>();
    let waiting = new Set<string>();
    /**
     * Шаг 45 [Р-181]: цикл тенанта живёт ещё `lingerMs` после его последнего ждущего задания. Продавец создаёт задания
     * подряд (себестоимость → границы → стратегия → включение), и цикл, уходящий после каждого, заставлял следующее
     * ждать обхода тенантов: в прогоне пилота это было до +0,2 с на каждый шаг.
     */
    const lingerMs = config.allTenants.lingerMs ?? 30_000;
    const lastWaiting = new Map<string, number>();
    const log = (code: string, details: Record<string, unknown>) => console.error(JSON.stringify({ level: 'ERROR', code, details }));
    running.push((async () => {
      while (!stopped()) {
        try {
          const { rows } = await workerPool.query('SELECT t AS tenant_id FROM security.bulk_job_waiting_tenants() t');
          waiting = new Set(rows.map((r) => r.tenant_id as string));
          const seen = systemClock.nowMs();
          for (const tenantId of waiting) lastWaiting.set(tenantId, seen);
          for (const tenantId of waiting) {
            if (worlds.has(tenantId)) continue;
            const world: BulkWorkerWorldConfig = { descriptor: { id: `tenant-${tenantId}`, title: '', description: '', tenantId, accounts: [] }, now: 'WALL_CLOCK' };
            // Аккаунты мира — до первого задания: канал мог быть подключён минуту назад
            const accounts = await admin.channelAccounts(tenantId);
            (world.descriptor.accounts as unknown as Array<(typeof world.descriptor.accounts)[number]>).push(...accounts.map((a) => ({
              channelAccountId: a.channelAccountId, channel: a.channel, marketplaces: [...a.marketplaces],
              haltRelease: haltReleaseOf(a.channel),
            })));
            worlds.set(tenantId, world);
            // Цикл уходит, когда ждущих заданий у тенанта не осталось (задание, которое уже идёт, он доделывает)
            const loop = runWorld(config, world, owner, () => stopped() || (!waiting.has(tenantId) && systemClock.nowMs() - (lastWaiting.get(tenantId) ?? 0) > lingerMs))
              .catch((error: unknown) => log('BULK_TENANT_WORKER_FAILED', { tenantId, message: error instanceof Error ? error.message : String(error) }))
              .finally(() => { worlds.delete(tenantId); lastWaiting.delete(tenantId); tenantLoops.delete(loop); });
            tenantLoops.add(loop);
          }
        } catch (error) {
          log('BULK_TENANT_POLL_FAILED', { message: error instanceof Error ? error.message : String(error) });
        }
        await new Promise((resolve) => setTimeout(resolve, poll));
      }
      // Задание, которое уже идёт, доделывается [Р-134]: пулы закрываются только после выхода циклов тенантов
      await Promise.all([...tenantLoops]);
    })());
  }
  await Promise.all(running);
  await Promise.all((poolsOf.get(config) ?? []).map((p) => p.end().catch(() => undefined)));
}

/**
 * Шаг 44 (находка 8 ревью): задания тенантов продавцов ведёт ОТДЕЛЬНЫЙ процесс промышленного профиля, а не процесс
 * консоли: предпросмотр стратегии на 10 000 предложений и сборка файла в 27 МБ занимают цикл событий [Р-139], и в процессе
 * консоли это были бы задержки ответов всем продавцам. Настройка — окружением и файлами секретов по ролям [Р-90].
 */
export function bulkWorkerFromEnv(env: Env, read: (path: string) => string = (p) => readFileSync(p, 'utf8')): { config: BulkWorkerConfig; heartbeatUrl: string | null; metricsPort: number } {
  const url = (role: string) => requiredValue(secretFromEnv(env, `REPRACER_BULK_${role}_PG_URL`, read), `REPRACER_BULK_${role}_PG_URL`);
  const heartbeatOff = env.REPRACER_BULK_HEARTBEAT === 'off';
  const heartbeatUrl = heartbeatOff ? null : requiredValue(secretFromEnv(env, 'REPRACER_BULK_HEARTBEAT_URL', read), 'REPRACER_BULK_HEARTBEAT_URL (or REPRACER_BULK_HEARTBEAT=off)');
  if (heartbeatUrl && !heartbeatUrl.startsWith('https://')) throw new ConfigError('CONFIG_INVALID: REPRACER_BULK_HEARTBEAT_URL must be https');
  return {
    config: {
      pgUrl: url('APP'), pgUrlsByRole: { admin: url('ADMIN'), bulk_worker: url('BULK_WORKER'), stock: url('STOCK') },
      worlds: [], allTenants: { pollMs: intFromEnv(env, 'REPRACER_BULK_POLL_MS', 2000, 100, 60_000) }, owner: `bulk-${process.pid}`,
      // Пауза цикла тенанта без готового задания: у прогона пилота — короче, чтобы время шага мерило работу, а не ожидание
      idleMs: intFromEnv(env, 'REPRACER_BULK_IDLE_MS', 200, 50, 60_000),
    },
    heartbeatUrl, metricsPort: intFromEnv(env, 'REPRACER_BULK_METRICS_PORT', 9473, 0, 65_535),
  };
}

async function main(): Promise<void> {
  let stop = false;
  // Остановка по сигналу — между заданиями: прерывать применение посередине незачем, оно и так целиком или никак [Р-134]
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { stop = true; });
  const path = process.env.BULK_WORKER_CONFIG;
  if (path) {
    const config = JSON.parse(readFileSync(path, 'utf8')) as BulkWorkerConfig;
    console.log(JSON.stringify({ event: 'bulk-worker-ready', worlds: config.worlds.length }));
    await runConfiguredWorker(config, () => stop);
    return;
  }
  const { config, heartbeatUrl, metricsPort } = bulkWorkerFromEnv(process.env);
  const health = new ProcessHealth();
  const healthServer = await serveHealth(health, { port: metricsPort, prefix: 'repracer_bulk', staleAfterMs: 120_000, host: '0.0.0.0' });
  // Р-127: процесс отмечается во внешнем сервисе — остановившийся исполнитель иначе не заметит никто
  const heartbeat = heartbeatUrl ? createHeartbeat({ url: heartbeatUrl }) : null;
  const beat = async () => {
    health.alive();
    if (heartbeat) await heartbeat.beat(health.healthy(120_000)).catch(() => undefined);
  };
  await beat();
  setInterval(() => { void beat(); }, 60_000).unref();
  console.log(JSON.stringify({ event: 'bulk-worker-ready', mode: 'all-tenants' }));
  await runConfiguredWorker(config, () => stop);
  await healthServer.close();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
