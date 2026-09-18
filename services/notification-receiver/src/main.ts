import { createAmazonAdapter, TwoLevelBudget } from '@repracer/amazon-adapter';
import { createNotificationReceiver, createSqsClient, pipelineSink, storeLedger, type NotificationReceiver } from '@repracer/amazon-notifications';
import type { AdapterDependencies } from '@repracer/channel-port';
import { createPricingPipeline } from '@repracer/pricing-pipeline';
import { createPool, PgPricingStore, PgSellerRouter, type PgPool } from '@repracer/pricing-store-pg';
import { createHeartbeat, credentialsFromFiles, jsonSink, pgAccountDirectory, ProcessHealth, serveHealth } from '@repracer/service-runtime';
import { loadReceiverConfig, type ReceiverConfig } from './config.ts';

/**
 * OQ-190 (шаг 27): точка входа приёмника уведомлений Amazon (шаг 23). До этого шага приёмник работал только в тестах — живая очередь и
 * подписка так и не заведены (OQ-167), но развёртывание готово и проверено живым прогоном шага 27 на модели очереди.
 *
 * Одна очередь — один процесс: SQS стандартная (порядок не хранит, доставляет повторно), порядок и повторы разбирает сам приёмник по
 * `EventTime` и `NotificationId`. Записи в канал этот процесс не отправляет: снимок доходит до пути решения, а ждущую запись отправляет
 * диспетчер (services/pricing-worker) — в этом процессе диспетчера нет намеренно [Р-64].
 */
export interface ReceiverProcess {
  receiver: NotificationReceiver;
  health: ProcessHealth;
  stop(): Promise<void>;
}

export async function startReceiverProcess(config: ReceiverConfig = loadReceiverConfig()): Promise<ReceiverProcess> {
  const sink = jsonSink();
  const health = new ProcessHealth();
  const appPool: PgPool = createPool(config.pgUrl, { max: 8, applicationName: `repracer-receiver-${config.receiverId}` });
  const inboundPool: PgPool = createPool(config.inboundPgUrl, { max: 2, applicationName: `repracer-receiver-${config.receiverId}-router` });
  const store = new PgPricingStore(appPool);
  const deps: AdapterDependencies = {
    accounts: pgAccountDirectory(appPool),
    credentials: credentialsFromFiles(config.channelSecretsDir),
    alerts: sink.alerts,
    logger: sink.logger,
    now: () => new Date().toISOString(),
  };
  const adapter = createAmazonAdapter({
    deps, userAgent: config.userAgent, applicationCredentialsRef: config.amazon.applicationCredentialsRef, budget: new TwoLevelBudget(),
  });
  // Диспетчера нет: уведомление рождает решение и ждущую запись, событие о ней объявляет база, отправляет её процесс диспетчера [Р-64]
  const pipeline = createPricingPipeline({ store, adapter, alerts: sink.alerts, logger: sink.logger, now: () => new Date().toISOString() });
  const receiver = createNotificationReceiver({
    sqs: createSqsClient({
      queueUrl: config.queueUrl,
      credentials: async () => ({
        accessKeyId: config.aws.accessKeyId, secretAccessKey: config.aws.secretAccessKey,
        ...(config.aws.sessionToken ? { sessionToken: config.aws.sessionToken } : {}),
      }),
    }),
    queueUrl: config.queueUrl,
    region: config.region,
    applicationId: config.applicationId,
    router: new PgSellerRouter(inboundPool),
    ledger: storeLedger(store),
    sink: pipelineSink(pipeline),
    alerts: sink.alerts,
    logger: sink.logger,
    now: () => new Date(),
    ...(config.silenceAlertAfterMs ? { policy: { silenceAlertAfterMs: config.silenceAlertAfterMs } } : {}),
  });
  const abort = new AbortController();
  // Живость — круг опроса, а не пришедшее сообщение: пустая очередь (long polling 20 с) — это норма, а не смерть процесса
  const loop = (async () => {
    while (!abort.signal.aborted) {
      const report = await receiver.pollOnce();
      health.alive();
      health.count('polls');
      if (report.received > 0) health.count('received', report.received);
      if (report.queueError) health.count('queue_errors');
      await receiver.checkSilence();
      if (report.queueError) await new Promise((r) => setTimeout(r, 5_000));
    }
  })().catch((error) => {
    sink.logger.log({ level: 'WARN', code: 'RECEIVER_LOOP_FAILED', message: 'RECEIVER_LOOP_FAILED', details: { error: String((error as Error)?.message ?? error).slice(0, 200) } });
  });
  health.alive();
  // Круг опроса длится не дольше ожидания очереди (20 с) плюс обработка: три минуты без круга — процесс нездоров
  const staleAfterMs = 180_000;
  const server = await serveHealth(health, { port: config.metricsPort, prefix: 'repracer_receiver', staleAfterMs });
  // OQ-194 (шаг 28): молчание процесса видно снаружи — отметка во внешнем сервисе [Р-127], а не только `/healthz` внутри хоста
  const heartbeat = config.heartbeatUrl ? createHeartbeat({ url: config.heartbeatUrl }) : null;
  const beat = async () => {
    if (!heartbeat) return;
    try {
      await heartbeat.beat(health.healthy(staleAfterMs));
    } catch (error) {
      health.count('heartbeat_failed');
      sink.logger.log({ level: 'WARN', code: 'RECEIVER_HEARTBEAT_FAILED', message: 'RECEIVER_HEARTBEAT_FAILED', details: { error: String((error as Error).message).slice(0, 120) } });
    }
  };
  await beat();
  const heartbeatTimer = setInterval(() => { void beat(); }, 60_000);
  heartbeatTimer.unref();
  return {
    receiver, health,
    async stop() {
      clearInterval(heartbeatTimer);
      abort.abort();
      await loop;
      await server.close();
      await Promise.all([appPool.end(), inboundPool.end()]);
    },
  };
}

// Запуск процесса: node --experimental-strip-types services/notification-receiver/src/main.ts
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const started = await startReceiverProcess();
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      void started.stop().then(() => process.exit(0));
    });
  }
}
