import type { AdapterCallContext, AdapterLogger, AlertSink, ChannelAdapter, CompetitorSnapshot } from '@repracer/channel-port';
import { createKafka, createKeyedProducer, OutboxRelay, runKeyedConsumer, TOPICS, type ReceivedMessage, type RunningConsumer } from '@repracer/broker';
import { createPricingPipeline } from '@repracer/pricing-pipeline';
import { createPool, PgPricingStore, PgWriteQueueStore, type PgPool } from '@repracer/pricing-store-pg';
import { createWriteDispatcher } from '@repracer/write-dispatcher';

/**
 * Экземпляр пути решения за брокером [Р-24, Р-64, ADR-0005, ADR-0009]. Экземпляров — сколько угодно; порядок внутри
 * единицы записи держат три слоя: партиция по ключу (один потребитель на партицию), одна запись в полёте в БД,
 * последовательные вызовы диспетчера по единице в процессе.
 *  - raw.competitor-snapshot.v1 (ключ — товар канала): оценка снимка — одна транзакция на снимок и решения его единиц [Р-59];
 *  - scope.write.v1 (ключ — write_scope_id): «единица свободна, есть ждущая запись» — диспетчер отправляет её;
 *  - обход-страховка раз в sweepIntervalMs;
 *  - ретранслятор outbox — во всех экземплярах, активен тот, кто держит advisory lock [Р-34].
 */

export interface SnapshotEnvelope {
  tenantId: string;
  channelAccountId: string;
  correlationId: string;
  snapshot: CompetitorSnapshot;
  /** Необязательная метка источника для журнала стенда (номер снимка товара) */
  productSeq?: number;
}

export interface WorkerOptions {
  workerId: string;
  /** svc_app: транзакции тенанта */
  pgUrl: string;
  /** svc_dispatcher: обход ждущих записей всех тенантов (только идентификаторы) */
  dispatcherPgUrl: string;
  /** svc_relay: чтение outbox всех тенантов; без адреса ретранслятор в этом экземпляре не запускается */
  relayPgUrl?: string;
  kafkaBrokers: string[];
  adapterFor(tenantId: string, channelAccountId: string): ChannelAdapter;
  alerts: AlertSink;
  logger: AdapterLogger;
  partitionsConcurrently?: number;
  sweepIntervalMs?: number;
  /** Суффикс групп потребителей — для стенда порядка (у каждого прогона свои смещения); в работе не используется */
  consumerGroupSuffix?: string;
  /** Наблюдение за потреблением — для стенда порядка; в работе не используется */
  onConsumed?: (message: ReceivedMessage, workerId: string) => Promise<void>;
}

export interface RunningWorker {
  stop(): Promise<void>;
}

export async function startWorker(options: WorkerOptions): Promise<RunningWorker> {
  const pool: PgPool = createPool(options.pgUrl, { max: 16, applicationName: `repracer-worker-${options.workerId}` });
  const scanPool: PgPool = createPool(options.dispatcherPgUrl, { max: 2, applicationName: `repracer-worker-${options.workerId}-sweep` });
  const relayPool: PgPool | null = options.relayPgUrl ? createPool(options.relayPgUrl, { max: 1, applicationName: `repracer-worker-${options.workerId}-relay` }) : null;
  const store = new PgPricingStore(pool);
  const dispatcher = createWriteDispatcher({
    store: new PgWriteQueueStore(pool, { scanPool }),
    adapterFor: (tenantId, accountId) => options.adapterFor(tenantId, accountId),
    alerts: options.alerts,
    now: () => new Date().toISOString(),
  });
  const pipelines = new Map<string, ReturnType<typeof createPricingPipeline>>();
  const pipelineFor = (tenantId: string, accountId: string) => {
    const key = `${tenantId}:${accountId}`;
    let p = pipelines.get(key);
    if (!p) {
      p = createPricingPipeline({ store, adapter: options.adapterFor(tenantId, accountId), alerts: options.alerts, logger: options.logger, now: () => new Date().toISOString(), dispatcher });
      pipelines.set(key, p);
    }
    return p;
  };

  const kafka = createKafka(options.kafkaBrokers, `repracer-worker-${options.workerId}`);
  const consumers: RunningConsumer[] = [];
  const abort = new AbortController();
  const background: Promise<unknown>[] = [];

  const poison = async (message: ReceivedMessage, error: unknown) => {
    // ADR-0005, обязательство 5: без ретрай-топика; единица остаётся под обходом диспетчера, сообщение — в алерте
    await options.alerts.raise({
      code: 'BROKER_MESSAGE_POISONED', severity: 'CRITICAL',
      details: { topic: message.topic, partition: message.partition, offset: message.offset, key: message.key, error: String((error as Error)?.message ?? error).slice(0, 200) },
    });
  };

  consumers.push(await runKeyedConsumer(kafka, {
    groupId: `repracer-pricing-path${options.consumerGroupSuffix ?? ''}`, topics: [TOPICS.rawCompetitorSnapshot], partitionsConcurrently: options.partitionsConcurrently ?? 4, onPoison: poison,
    handle: async (message) => {
      await options.onConsumed?.(message, options.workerId);
      const envelope = JSON.parse(message.value) as SnapshotEnvelope;
      const ctx: AdapterCallContext = {
        tenantId: envelope.tenantId as AdapterCallContext['tenantId'],
        channelAccountId: envelope.channelAccountId as AdapterCallContext['channelAccountId'],
        correlationId: envelope.correlationId,
        deadline: new Date(Date.now() + 60_000).toISOString(),
      };
      await pipelineFor(envelope.tenantId, envelope.channelAccountId).processSnapshot(ctx, envelope.snapshot);
    },
  }));

  consumers.push(await runKeyedConsumer(kafka, {
    groupId: `repracer-write-dispatcher${options.consumerGroupSuffix ?? ''}`, topics: [TOPICS.scopeWrite], partitionsConcurrently: options.partitionsConcurrently ?? 4, onPoison: poison,
    handle: async (message) => {
      await options.onConsumed?.(message, options.workerId);
      const event = JSON.parse(message.value) as { tenantId: string; writeScopeId: string };
      // Событие — только сигнал: диспетчер читает состояние единицы в БД, дубль и повтор безвредны
      await dispatcher.dispatchScope(event.tenantId, event.writeScopeId);
    },
  }));

  if (relayPool) {
    const producer = await createKeyedProducer(kafka);
    const relay = new OutboxRelay({
      pool: relayPool as unknown as import('pg').Pool, producer,
      onGap: (gap) => void options.alerts.raise({ code: 'OUTBOX_SCOPE_SEQ_GAP_RELEASED', severity: 'WARNING', details: { ...gap } }),
    });
    background.push(relay.run(abort.signal).finally(() => producer.disconnect()));
  }

  const sweepEvery = options.sweepIntervalMs ?? 5_000;
  background.push((async () => {
    while (!abort.signal.aborted) {
      await new Promise((r) => setTimeout(r, sweepEvery));
      if (abort.signal.aborted) break;
      await dispatcher.sweep({ pendingMinAgeMs: sweepEvery }).catch((error) =>
        options.alerts.raise({ code: 'WRITE_DISPATCH_SWEEP_FAILED', severity: 'CRITICAL', details: { error: String((error as Error)?.message ?? error).slice(0, 200) } }));
    }
  })());

  return {
    async stop() {
      abort.abort();
      for (const c of consumers) await c.stop();
      await Promise.allSettled(background);
      await pool.end();
      await scanPool.end();
      await relayPool?.end();
    },
  };
}
