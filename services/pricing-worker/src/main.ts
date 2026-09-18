import { createAmazonAdapter, TwoLevelBudget } from '@repracer/amazon-adapter';
import type { AdapterDependencies, ChannelAccountId, ChannelAdapter, TenantId } from '@repracer/channel-port';
import { conservativeBudget, createKauflandAdapter } from '@repracer/kaufland-adapter';
import { createPool, type PgPool } from '@repracer/pricing-store-pg';
import { createHeartbeat, credentialsFromFiles, jsonSink, pgAccountDirectory, ProcessHealth, serveHealth } from '@repracer/service-runtime';
import { loadWorkerConfig, type WorkerConfig } from './config.ts';
import { startWorker, type RunningWorker } from './worker.ts';

/**
 * OQ-190 (шаг 27): точка входа процесса пути решения за брокером — того самого, который отправляет ЖДУЩИЕ записи [Р-64] (свою запись
 * путь решения отправляет сам, а ту, что встала за ней, — этот процесс по событию `scope.write.v1`) и ретранслирует outbox [Р-34].
 * До этого шага у процесса точки входа не было: он существовал только в тестах.
 * Экземпляров может быть сколько угодно: порядок внутри единицы записи держат партиция по ключу, одна запись в полёте в БД и
 * последовательные вызовы диспетчера; ретранслятор активен у того экземпляра, кто взял advisory lock.
 */
export interface WorkerProcess {
  running: RunningWorker;
  health: ProcessHealth;
  stop(): Promise<void>;
}

/**
 * Канал аккаунта — из каталога аккаунтов [Р-31], с памятью на процесс: аккаунт канал не меняет, а запрос в базу на каждое сообщение
 * стоил бы дороже самой отправки. Тенант приходит в сообщении и сверяется каталогом — процесс тенанта не выбирает.
 */
export function channelAdapters(
  deps: AdapterDependencies, config: WorkerConfig,
  directory: { verify(tenantId: TenantId, channelAccountId: ChannelAccountId): Promise<{ ok: true; account: { channel: string } } | { ok: false; reason: string }> },
): (tenantId: string, channelAccountId: string) => Promise<ChannelAdapter> {
  const byChannel = new Map<string, ChannelAdapter>();
  const channelOfAccount = new Map<string, string>();
  const build = (channel: string): ChannelAdapter => {
    const existing = byChannel.get(channel);
    if (existing) return existing;
    const created = channel === 'KAUFLAND'
      ? createKauflandAdapter({
        deps, userAgent: config.userAgent, subscriptionFallbackEmail: config.kaufland.subscriptionFallbackEmail, budget: conservativeBudget(),
        ...(config.kaufland.partnerCredentialsRef ? { partnerCredentialsRef: config.kaufland.partnerCredentialsRef } : {}),
        buyBoxChangedAccess: config.kaufland.buyBoxChangedAccess,
      })
      : channel === 'AMAZON'
        ? createAmazonAdapter({ deps, userAgent: config.userAgent, applicationCredentialsRef: config.amazon.applicationCredentialsRef, budget: new TwoLevelBudget() })
        // eBay адаптера нет до снимка спецификации [Р-112]: сообщение по такому аккаунту — отравленное, с алертом
        : null;
    if (!created) throw new Error(`NO_ADAPTER: ${channel}`);
    byChannel.set(channel, created);
    return created;
  };
  return async (tenantId, channelAccountId) => {
    const known = channelOfAccount.get(channelAccountId);
    if (known) return build(known);
    const found = await directory.verify(tenantId as TenantId, channelAccountId as ChannelAccountId);
    if (!found.ok) throw new Error(`ACCOUNT_UNUSABLE: ${found.reason}`);
    channelOfAccount.set(channelAccountId, found.account.channel);
    return build(found.account.channel);
  };
}

export async function startWorkerProcess(config: WorkerConfig = loadWorkerConfig()): Promise<WorkerProcess> {
  const sink = jsonSink();
  const health = new ProcessHealth();
  const appPool: PgPool = createPool(config.pgUrl, { max: 4, applicationName: `repracer-worker-${config.workerId}-directory` });
  const deps: AdapterDependencies = {
    accounts: pgAccountDirectory(appPool),
    credentials: credentialsFromFiles(config.channelSecretsDir),
    alerts: sink.alerts,
    logger: sink.logger,
    now: () => new Date().toISOString(),
  };
  const adapterFor = channelAdapters(deps, config, pgAccountDirectory(appPool));
  const running = await startWorker({
    workerId: config.workerId,
    pgUrl: config.pgUrl,
    dispatcherPgUrl: config.dispatcherPgUrl,
    ...(config.relayPgUrl ? { relayPgUrl: config.relayPgUrl } : {}),
    kafkaBrokers: config.kafkaBrokers,
    adapterFor,
    alerts: sink.alerts,
    logger: sink.logger,
    partitionsConcurrently: config.partitionsConcurrently,
    sweepIntervalMs: config.sweepIntervalMs,
    // Живость процесса — обработанные сообщения и ПРОШЕДШИЕ обходы: молчащая очередь процесс мёртвым не делает, а обход, который
    // валится каждый круг, здоровьем не считается (ревью шага 27, находка 3)
    onConsumed: async (message) => {
      health.alive();
      health.count(`consumed:${message.topic}`);
    },
    onSweep: async () => {
      health.alive();
      health.count('sweeps');
    },
  });
  health.alive();
  // Порог несвежести — три обхода: обход-страховка идёт всегда, даже когда сообщений нет
  const staleAfterMs = Math.max(3 * config.sweepIntervalMs, 120_000);
  const server = await serveHealth(health, { port: config.metricsPort, prefix: 'repracer_worker', staleAfterMs });
  /**
   * OQ-194 (шаг 28): отметка во внешнем сервисе [Р-127]. `/healthz` виден только внутри хоста — остановленный контейнер и мёртвый хост
   * о себе не сообщают; отметка сообщает молчанием. Состояние отметки — та же живость, что у `/healthz`: прошедший обход или сообщение.
   */
  const heartbeat = config.heartbeatUrl ? createHeartbeat({ url: config.heartbeatUrl }) : null;
  const beat = async () => {
    if (!heartbeat) return;
    try {
      await heartbeat.beat(health.healthy(staleAfterMs));
    } catch (error) {
      health.count('heartbeat_failed');
      sink.logger.log({ level: 'WARN', code: 'WORKER_HEARTBEAT_FAILED', message: 'WORKER_HEARTBEAT_FAILED', details: { error: String((error as Error).message).slice(0, 120) } });
    }
  };
  await beat();
  const heartbeatTimer = setInterval(() => { void beat(); }, Math.max(30_000, Math.min(config.sweepIntervalMs, 60_000)));
  heartbeatTimer.unref();
  return {
    running, health,
    async stop() {
      clearInterval(heartbeatTimer);
      await running.stop();
      await server.close();
      await appPool.end();
    },
  };
}

// Запуск процесса: node --experimental-strip-types services/pricing-worker/src/main.ts
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const started = await startWorkerProcess();
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      void started.stop().then(() => process.exit(0));
    });
  }
}
