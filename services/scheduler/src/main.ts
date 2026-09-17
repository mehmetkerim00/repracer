import { ClickHouseHttp } from '@repracer/analytics-export';
import { createAmazonAdapter, TwoLevelBudget } from '@repracer/amazon-adapter';
import type { AdapterDependencies, ChannelAdapter } from '@repracer/channel-port';
import { conservativeBudget, createKauflandAdapter } from '@repracer/kaufland-adapter';
import { createPricingPipeline } from '@repracer/pricing-pipeline';
import { createPool, PgPricingStore, type PgPool } from '@repracer/pricing-store-pg';
import { loadConfig, type SchedulerConfig } from './config.ts';
import { createHeartbeat } from './heartbeat.ts';
import { jobSource, type SchedulerAccount } from './jobs.ts';
import { SchedulerMetrics, serveMetrics } from './metrics.ts';
import { pgJobDeps } from './pg-deps.ts';
import { PgSchedulerState } from './pg-state.ts';
import { runScheduler, type RunningScheduler } from './process.ts';
import { createScheduler } from './scheduler.ts';
import { credentialsFromFiles, jsonSink, pgAccountDirectory } from './runtime.ts';

/**
 * Р-129 (шаг 26): точка входа процесса планировщика — сборка из конфигурации развёртывания. Один экземпляр на работу держит аренда в
 * базе [Р-126], поэтому экземпляров процесса может быть несколько; перезапуск при падении — задача развёртывания (deploy/scheduler).
 * Сроки работ сравниваются с часами БАЗЫ, а не процесса (риск 31): разошедшиеся часы процесса не запускают работу раньше срока.
 * Работоспособность видна снаружи: отметка во внешнем сервисе каждый такт (Р-127), метрики и /healthz — на порту метрик.
 */
export interface SchedulerProcess {
  running: RunningScheduler;
  metrics: SchedulerMetrics;
  stop(): Promise<void>;
}

/**
 * Такт считается благополучным, если он завершился и хотя бы одна работа такта не провалилась: планировщик, у которого падают ВСЕ работы,
 * снаружи здоровым выглядеть не должен (ревью шага 26, находка 12)
 */
export function tickIsHealthy(ok: boolean, report: { runs: Array<{ outcome: string }> } | null): boolean {
  if (!ok || !report) return false;
  return report.runs.length === 0 || report.runs.some((r) => r.outcome === 'SUCCEEDED');
}

/**
 * Часы сроков процесса — часы БАЗЫ (риск 31): собирается здесь, чтобы подмена на часы процесса ловилась тестом сборки, а не только
 * ревью (ревью шага 26, находка 13.5)
 */
export function dueClockOf(state: Pick<PgSchedulerState, 'databaseNow'>): () => Promise<string> {
  return () => state.databaseNow();
}

/** Столько подряд неудавшихся тактов — процесс завершается: перезапуском занимается развёртывание */
const FATAL_TICK_FAILURES = 10;

export async function startScheduler(config: SchedulerConfig = loadConfig(), onFatal: () => void = () => process.exit(1)): Promise<SchedulerProcess> {
  const sink = jsonSink();
  const schedulerPool: PgPool = createPool(config.schedulerPgUrl, { max: 4, applicationName: `repracer-scheduler-${config.owner}` });
  const appPool: PgPool = createPool(config.appPgUrl, { max: 8, applicationName: `repracer-scheduler-app-${config.owner}` });
  const exporterPool: PgPool = createPool(config.exporterPgUrl, { max: 2, applicationName: `repracer-scheduler-export-${config.owner}` });
  const deps: AdapterDependencies = {
    accounts: pgAccountDirectory(appPool),
    credentials: credentialsFromFiles(config.channelSecretsDir),
    alerts: sink.alerts,
    logger: sink.logger,
    now: () => new Date().toISOString(),
  };
  const adapters = new Map<string, ChannelAdapter>();
  const adapterFor = (channel: string): ChannelAdapter | null => {
    const existing = adapters.get(channel);
    if (existing) return existing;
    const created = channel === 'KAUFLAND'
      ? createKauflandAdapter({
        deps, userAgent: config.userAgent, subscriptionFallbackEmail: config.kaufland.subscriptionFallbackEmail, budget: conservativeBudget(),
        ...(config.kaufland.partnerCredentialsRef ? { partnerCredentialsRef: config.kaufland.partnerCredentialsRef } : {}),
        buyBoxChangedAccess: config.kaufland.buyBoxChangedAccess,
      })
      : channel === 'AMAZON'
        ? createAmazonAdapter({ deps, userAgent: config.userAgent, applicationCredentialsRef: config.amazon.applicationCredentialsRef, budget: new TwoLevelBudget() })
        : null;
    // Канал без адаптера (eBay — снимка спецификации нет, Р-112): работ по аккаунту нет
    if (created) adapters.set(channel, created);
    return created;
  };
  const store = new PgPricingStore(appPool);
  const pipelines = new Map<string, ReturnType<typeof createPricingPipeline>>();
  const pipelineFor = (account: SchedulerAccount) => {
    const key = `${account.tenantId}:${account.channelAccountId}`;
    let pipeline = pipelines.get(key);
    if (!pipeline) {
      const adapter = adapterFor(account.channel);
      if (!adapter) throw new Error(`NO_ADAPTER: ${account.channel}`);
      // Диспетчер записей — отдельный процесс (services/pricing-worker): планировщик ставит записи в очередь, не отправляет их
      pipeline = createPricingPipeline({ store, adapter, alerts: sink.alerts, logger: sink.logger, now: () => new Date().toISOString() });
      pipelines.set(key, pipeline);
    }
    return pipeline;
  };
  const ch = (login: { user: string; password: string }) => new ClickHouseHttp({ url: config.clickHouse.url, user: login.user, password: login.password });
  const state = new PgSchedulerState(schedulerPool);
  const deps2 = pgJobDeps({
    schedulerPool, exporterPool, ingest: ch(config.clickHouse.ingest), verifier: ch(config.clickHouse.verifier),
    descriptorOf: (channel) => adapterFor(channel)?.descriptor ?? null, pipelineFor,
  });
  const metrics = new SchedulerMetrics();
  // Риск 31: часы сроков — часы базы
  const scheduler = createScheduler({ state, source: jobSource(deps2), owner: config.owner, now: dueClockOf(state), alerts: sink.alerts });
  const heartbeat = config.heartbeatUrl ? createHeartbeat({ url: config.heartbeatUrl }) : null;
  // Живость цикла, а не завершение такта: работы такта берут аренду до 2 часов
  const server = await serveMetrics(metrics, { port: config.metricsPort, staleAfterMs: Math.max(5 * config.tickMs, 300_000) });
  let healthy = true;
  let consecutiveTickFailures = 0;
  const beat = async () => {
    if (!heartbeat) return;
    try {
      await heartbeat.beat(healthy);
    } catch (error) {
      // Отметка не ушла: внешний сервис поднимет тревогу сам, если отметок не будет дольше периода и допуска
      metrics.heartbeatFailed();
      sink.logger.log({ level: 'WARN', code: 'SCHEDULER_HEARTBEAT_FAILED', message: 'SCHEDULER_HEARTBEAT_FAILED', details: { error: String((error as Error).message).slice(0, 120) } });
    }
  };
  const running = runScheduler(scheduler, {
    tickMs: config.tickMs, logger: sink.logger,
    onIterationStart: () => metrics.iterationStarted(),
    async onTick({ ok, report }) {
      metrics.tick(ok, report);
      healthy = tickIsHealthy(ok, report);
      consecutiveTickFailures = ok ? 0 : consecutiveTickFailures + 1;
      // Цикл ловит любое исключение и продолжает: процесс, у которого такты не проходят подряд, завершается — перезапуск делает
      // развёртывание (restart: unless-stopped), иначе зависший процесс живёт вечно (ревью шага 26, находка 6)
      if (consecutiveTickFailures >= FATAL_TICK_FAILURES) {
        sink.logger.log({ level: 'WARN', code: 'SCHEDULER_TICKS_FAILING', message: 'SCHEDULER_TICKS_FAILING', details: { failures: consecutiveTickFailures } });
        await beat();
        onFatal();
        return;
      }
      await beat();
    },
  });
  // Отметка идёт таймером, а не только по концу такта: долгая работа (выгрузка суток — аренда 2 часа) не выглядит смертью процесса
  const heartbeatTimer = setInterval(() => { void beat(); }, Math.max(30_000, Math.min(config.tickMs, 60_000)));
  heartbeatTimer.unref();
  const stop = async () => {
    clearInterval(heartbeatTimer);
    await running.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await Promise.all([schedulerPool.end(), appPool.end(), exporterPool.end()]);
  };
  return { running, metrics, stop };
}

// Запуск процесса: node --experimental-strip-types services/scheduler/src/main.ts
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const started = await startScheduler();
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      void started.stop().then(() => process.exit(0));
    });
  }
}
