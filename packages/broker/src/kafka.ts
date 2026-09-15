import confluent from '@confluentinc/kafka-javascript';

/**
 * Kafka-совместимый брокер (Redpanda, OQ-67) [Р-24, ADR-0005]. Клиент — confluent-kafka-javascript [Р-66]
 * (`@confluentinc/kafka-javascript`, librdkafka), его совместимый с KafkaJS слой: настройки — в блоке `kafkaJS`.
 * Гарантии, на которые опирается ядро, проверяются тестом порядка за брокером, а не документацией клиента:
 *  - продюсер идемпотентный, acks=all на уровне продюсера, одна пачка в полёте — повтор не переставляет сообщения;
 *  - потребитель обрабатывает партицию последовательно; смещения фиксируются периодически (autoCommit) только для
 *    обработанных сообщений — at-least-once (проверить на стенде: в слое совместимости коммит не на каждое сообщение);
 *  - автосоздание топиков выключено: число партиций scope.* фиксируется при создании (ADR-0005, обязательство 1).
 */

const { Kafka, logLevel } = confluent.KafkaJS;
type KafkaClient = InstanceType<typeof Kafka>;

export const TOPICS = {
  /** События единицы записи цены/остатка: ключ write_scope_id */
  scopeWrite: 'scope.write.v1',
  /** Снимки конкурентов: ключ channel_account_id|marketplace|channel_product_ref|condition */
  rawCompetitorSnapshot: 'raw.competitor-snapshot.v1',
} as const;

/** Начальное число партиций локального стенда; расчёт на 3 года — OQ-67 */
export const LOCAL_PARTITIONS = 12;

export interface KeyedMessage {
  topic: string;
  key: string;
  value: string;
  headers: Record<string, string>;
}

export interface ReceivedMessage {
  topic: string;
  partition: number;
  offset: string;
  key: string;
  value: string;
  headers: Record<string, string>;
}

export function createKafka(brokers: string[], clientId: string): KafkaClient {
  return new Kafka({ kafkaJS: { clientId, brokers, logLevel: logLevel.WARN, retry: { retries: 8, initialRetryTime: 200 } } });
}

export async function ensureTopics(kafka: KafkaClient, topics: Array<{ topic: string; numPartitions: number }>): Promise<void> {
  const admin = kafka.admin();
  await admin.connect();
  try {
    const existing = new Set(await admin.listTopics());
    const missing = topics.filter((t) => !existing.has(t.topic));
    if (missing.length > 0) {
      await admin.createTopics({ topics: missing.map((t) => ({ topic: t.topic, numPartitions: t.numPartitions, replicationFactor: 1 })) });
    }
    const metadata = await admin.fetchTopicMetadata({ topics: topics.map((t) => t.topic) });
    for (const t of topics) {
      const found = metadata.find((m) => m.name === t.topic);
      if (found && found.partitions.length !== t.numPartitions) {
        throw new Error(`topic ${t.topic} has ${found.partitions.length} partitions, expected ${t.numPartitions}: repartitioning breaks key → partition (ADR-0005)`);
      }
    }
  } finally {
    await admin.disconnect();
  }
}

export async function deleteTopics(kafka: KafkaClient, topics: string[]): Promise<void> {
  const admin = kafka.admin();
  await admin.connect();
  try {
    const existing = new Set(await admin.listTopics());
    const present = topics.filter((t) => existing.has(t));
    if (present.length > 0) await admin.deleteTopics({ topics: present, timeout: 30_000 });
  } finally {
    await admin.disconnect();
  }
}

export interface KeyedProducer {
  /** Сообщения одного ключа уходят в порядке массива; возврат — после подтверждения всеми репликами */
  send(messages: readonly KeyedMessage[]): Promise<void>;
  disconnect(): Promise<void>;
}

export async function createKeyedProducer(kafka: KafkaClient): Promise<KeyedProducer> {
  const producer = kafka.producer({ kafkaJS: { idempotent: true, maxInFlightRequests: 1, acks: -1, allowAutoTopicCreation: false } });
  await producer.connect();
  return {
    async send(messages) {
      if (messages.length === 0) return;
      const byTopic = new Map<string, KeyedMessage[]>();
      for (const m of messages) byTopic.set(m.topic, [...(byTopic.get(m.topic) ?? []), m]);
      await producer.sendBatch({
        topicMessages: [...byTopic].map(([topic, list]) => ({ topic, messages: list.map((m) => ({ key: m.key, value: m.value, headers: m.headers })) })),
      });
    },
    disconnect: () => producer.disconnect(),
  };
}

function headerValue(v: unknown): string {
  const one = Array.isArray(v) ? v[0] : v;
  if (one === undefined || one === null) return '';
  return Buffer.isBuffer(one) ? one.toString('utf8') : String(one);
}

export interface KeyedConsumerOptions {
  groupId: string;
  topics: string[];
  /** Сколько партиций обрабатывается одновременно; внутри партиции — строго по очереди */
  partitionsConcurrently: number;
  handle(message: ReceivedMessage): Promise<void>;
  /** Попыток обработки одного сообщения до «отравленного» */
  maxHandlerAttempts?: number;
  /**
   * Сообщение не обработано после всех попыток. Ретрай-топиков для scope.* нет (ADR-0005, обязательство 5): обработчик
   * переводит единицу записи в BLOCKED и паркует событие; после onPoison смещение фиксируется.
   */
  onPoison(message: ReceivedMessage, error: unknown): Promise<void>;
  fromBeginning?: boolean;
}

export interface RunningConsumer {
  stop(): Promise<void>;
}

export async function runKeyedConsumer(kafka: KafkaClient, options: KeyedConsumerOptions): Promise<RunningConsumer> {
  const consumer = kafka.consumer({
    kafkaJS: { groupId: options.groupId, fromBeginning: options.fromBeginning ?? true, allowAutoTopicCreation: false, autoCommit: true, autoCommitInterval: 1_000 },
  });
  await consumer.connect();
  await consumer.subscribe({ topics: options.topics });
  const attempts = options.maxHandlerAttempts ?? 5;
  await consumer.run({
    partitionsConsumedConcurrently: options.partitionsConcurrently,
    eachMessage: async ({ topic, partition, message }) => {
      const received: ReceivedMessage = {
        topic, partition, offset: message.offset,
        key: message.key?.toString('utf8') ?? '',
        value: message.value?.toString('utf8') ?? '',
        headers: Object.fromEntries(Object.entries(message.headers ?? {}).map(([k, v]) => [k, headerValue(v)])),
      };
      let lastError: unknown;
      for (let i = 1; i <= attempts; i++) {
        try {
          await options.handle(received);
          return;
        } catch (error) {
          lastError = error;
          await new Promise((r) => setTimeout(r, Math.min(2000, 100 * 2 ** i)));
        }
      }
      await options.onPoison(received, lastError);
    },
  });
  return { stop: () => consumer.disconnect() };
}
