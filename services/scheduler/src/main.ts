import { ClickHouseHttp } from '@repracer/analytics-export';
import { createAmazonAdapter, TwoLevelBudget } from '@repracer/amazon-adapter';
import { createEbayAdapter } from '@repracer/ebay-adapter';
import type { AdapterDependencies, ChannelAdapter } from '@repracer/channel-port';
import { conservativeBudget, createKauflandAdapter } from '@repracer/kaufland-adapter';
import { createPricingPipeline } from '@repracer/pricing-pipeline';
import { createPool, PgAlertDeliveryStore, PgAlertSink, PgCredentialVault, PgPricingStore, PgShadowDigestStore, PgStockStore, type PgPool } from '@repracer/pricing-store-pg';
import { createStockPipeline } from '@repracer/stock-sync';
import { loadConfig, type SchedulerConfig } from './config.ts';
import { createDryMailSender, createHeartbeat, createMailSender, EBAY_APPLICATION_REF } from '@repracer/service-runtime';
import { createAlertDelivery } from '@repracer/alert-delivery';
import { createShadowDigest } from '@repracer/alert-delivery/shadow-digest';
import { jobSource, type SchedulerAccount } from './jobs.ts';
import { SchedulerMetrics, serveMetrics } from './metrics.ts';
import { pgJobDeps } from './pg-deps.ts';
import { PgSchedulerState } from './pg-state.ts';
import { runScheduler, type RunningScheduler } from './process.ts';
import { createScheduler } from './scheduler.ts';
import { credentialsFromFiles, jsonSink, pgAccountDirectory } from './runtime.ts';
import { channelApps, channelCredentialsProvider } from '@repracer/service-runtime';
import { createAuthorizationChecker } from '@repracer/channel-oauth';

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
  // Шаг 56: роль остатков — работа order-lines (заказы канала → резервации → пересчёт публикуемого остатка) [Р-25, Р-102]
  const stockPool: PgPool = createPool(config.stockPgUrl, { max: 2, applicationName: `repracer-scheduler-stock-${config.owner}` });
  const exporterPool: PgPool = createPool(config.exporterPgUrl, { max: 2, applicationName: `repracer-scheduler-export-${config.owner}` });
  /**
   * Р-156: алерт идёт И в журнал эксплуатации, И в базу. Журнал — для того, кто смотрит за процессами; база — для
   * владельца: из неё работа `alerts-deliver` шлёт письмо. Алерт без строки в базе доставить было бы нечем.
   */
  const alerts = new PgAlertSink(appPool, sink.alerts);
  const credentialsPool: PgPool | null = config.credentialsPgUrl
    ? createPool(config.credentialsPgUrl, { max: 2, applicationName: `repracer-scheduler-credentials-${config.owner}` }) : null;
  const deps: AdapterDependencies = {
    accounts: pgAccountDirectory(appPool),
    // Шаг 43 [Р-177]: ссылка `db:` — токен, полученный OAuth: его читает роль адаптеров и открывает кольцо ключей процесса
    credentials: channelCredentialsProvider({
      files: credentialsFromFiles(config.channelSecretsDir),
      vault: credentialsPool && config.channelApps.keyring ? { pool: credentialsPool, keyring: config.channelApps.keyring } : null,
      amazonApplication: config.channelApps.amazon ? { ref: config.amazon.applicationCredentialsRef, ...config.channelApps.amazon } : null,
      // Шаг 47: ключи приложения eBay — из конфигурации приложений каналов (как у Amazon), refresh-токен продавца — из хранилища
      ebayApplication: config.channelApps.ebay ? { ref: EBAY_APPLICATION_REF, clientId: config.channelApps.ebay.clientId, clientSecret: config.channelApps.ebay.clientSecret } : null,
    }),
    alerts,
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
        // Шаг 47: адаптер eBay по песочнице [Р-162] — есть, когда приложение eBay настроено; иначе работ по аккаунту нет
        : channel === 'EBAY' && config.channelApps.ebay
          ? createEbayAdapter({ deps, environment: config.channelApps.ebay.environment, applicationCredentialsRef: EBAY_APPLICATION_REF, scopes: config.channelApps.ebay.scopes })
          : null;
    // Канал без адаптера: работ по аккаунту нет
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
  /**
   * Шаг 56: до этого шага планировщик процесса НЕ заводил работу order-lines вовсе — её зависимость `stock` передавали только живые
   * прогоны, и в работе заказы канала не становились резервациями, а доступный остаток после продажи не уменьшался. Административной роли
   * у планировщика нет и не будет [Р-90]: пути заказов она не нужна, и обращение к ней — громкий отказ, а не тихая подмена ролью остатков
   */
  const noAdminPool = new Proxy({}, { get: () => () => { throw new Error('the scheduler has no administrative role: this stock operation belongs to the console'); } }) as PgPool;
  const stockPipeline = createStockPipeline({ store: new PgStockStore({ adminPool: noAdminPool, stockPool }), now: () => new Date().toISOString() }); // real-clock: точка сборки процесса
  const stockDeps = {
    syncOrders: (account: SchedulerAccount, ctx: Parameters<typeof stockPipeline.syncOrders>[0], since: string, options?: { cursor?: string }) => {
      const adapter = adapterFor(account.channel);
      if (!adapter) throw new Error(`NO_ADAPTER: ${account.channel}`);
      return stockPipeline.syncOrders(ctx, adapter, since as never, options);
    },
    positions: {
      get: (account: SchedulerAccount) => store.orderReadPosition(account.tenantId, account.channelAccountId),
      save: (account: SchedulerAccount, position: { since: string; cursor: string } | null, at: string) =>
        store.saveOrderReadPosition(account.tenantId, account.channelAccountId, position as never, at as never),
    },
  };
  const ch = (login: { user: string; password: string }) => new ClickHouseHttp({ url: config.clickHouse.url, user: login.user, password: login.password });
  const state = new PgSchedulerState(schedulerPool);
  const deliveryPool: PgPool | null = config.alertDeliveryPgUrl
    ? createPool(config.alertDeliveryPgUrl, { max: 2, applicationName: `repracer-alert-delivery-${config.owner}` }) : null;
  /**
   * Шаг 37, задача D: без настроек провайдера доставка идёт ВСУХУЮ — письмо собирается, не отправляется, и отметка
   * говорит это прямо. Выключить её целиком можно только явно (`REPRACER_SCHEDULER_MAIL=off`), и тогда её здесь нет.
   */
  const mailSender = config.mail ? createMailSender(config.mail) : createDryMailSender((line: string) => sink.logger.log(JSON.parse(line) as never));
  /**
   * Шаг 41 [Р-171]: недельный дайджест тени идёт ТОЙ ЖЕ ролью и тем же отправителем, что алерты: второго пути писем в
   * проекте нет, и заводить его ради отчёта значило бы завести второй сухой режим и второй перехватчик в прогонах.
   */
  const shadowDigest = deliveryPool
    ? createShadowDigest({
        store: new PgShadowDigestStore(deliveryPool), mail: mailSender, now: () => new Date().toISOString(),
        log: (line: string) => sink.logger.log(JSON.parse(line) as never),
      })
    : undefined;
  const alertDelivery = deliveryPool
    ? createAlertDelivery({
        store: new PgAlertDeliveryStore(deliveryPool), mail: mailSender, now: () => new Date().toISOString(),
        ...(config.operatorEmail ? { operatorEmail: config.operatorEmail } : {}),
      })
    : undefined;
  if (!config.mail && !config.mailOff) {
    sink.logger.log({ level: 'WARN', code: 'MAIL_DRY_RUN_MODE', message: 'провайдер почты не настроен: письма собираются и не отправляются (OQ-224)', details: {} });
  }
  /**
   * Шаг 43 [Р-177]: проверка авторизаций — обмен refresh-токена раз в период. Отзыв продавцом переводит аккаунт в REVOKED с
   * письмом владельцу (это делает база); сломанные ключи приложения — алерт оператору. Токен не покидает проверку.
   */
  const apps = channelApps(config.channelApps);
  const channelAuthorizations = credentialsPool && config.channelApps.keyring
    ? createAuthorizationChecker({
        vault: new PgCredentialVault(credentialsPool) as never, keyring: config.channelApps.keyring,
        provider: (c) => apps.find((a) => a.channel === c.channel)?.provider ?? null,
        http: (url, init) => fetch(url, init), olderThanSeconds: 50 * 60, limit: 500,
        log: (event, fields) => sink.logger.log({ level: 'WARN', code: event.toUpperCase(), message: event, details: fields } as never),
      })
    : undefined;
  const deps2Base = pgJobDeps({
    schedulerPool, exporterPool, ingest: ch(config.clickHouse.ingest), verifier: ch(config.clickHouse.verifier),
    descriptorOf: (channel) => adapterFor(channel)?.descriptor ?? null, pipelineFor,
    config: { discoveryAppQuotas: config.discoveryAppQuotas },
    ...(alertDelivery ? { alertDelivery } : {}),
    ...(shadowDigest ? { shadowDigest } : {}),
  });
  const deps2 = { ...deps2Base, stock: stockDeps, ...(channelAuthorizations ? { channelAuthorizations } : {}) };
  const metrics = new SchedulerMetrics();
  // Риск 31: часы сроков — часы базы
  const scheduler = createScheduler({ state, source: jobSource(deps2), owner: config.owner, now: dueClockOf(state), alerts });
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
    await Promise.all([schedulerPool.end(), appPool.end(), stockPool.end(), exporterPool.end(), ...(credentialsPool ? [credentialsPool.end()] : [])]);
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
