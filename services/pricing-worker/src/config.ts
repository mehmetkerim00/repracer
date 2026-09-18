import { hostname } from 'node:os';
import { ConfigError, intFromEnv, requiredValue, secretFromEnv, type Env } from '@repracer/service-runtime';

/**
 * OQ-190 (шаг 27): конфигурация процесса пути решения за брокером — диспетчера записей [Р-64] и ретранслятора outbox [Р-34].
 * Секреты (адреса баз с паролями) — файлами развёртывания; в журнал и ошибки попадают только имена переменных.
 */
export interface WorkerConfig {
  workerId: string;
  /** svc_app: транзакции тенанта */
  pgUrl: string;
  /** svc_dispatcher: обход ждущих записей всех тенантов — только идентификаторы */
  dispatcherPgUrl: string;
  /** svc_relay: чтение outbox всех тенантов; без адреса ретранслятор в этом экземпляре не запускается [Р-34] */
  relayPgUrl: string | null;
  kafkaBrokers: string[];
  /** Обход-страховка: ждущая запись не остаётся незамеченной, даже если событие потерялось [Р-64] */
  sweepIntervalMs: number;
  partitionsConcurrently: number;
  metricsPort: number;
  channelSecretsDir: string;
  userAgent: string;
  kaufland: { subscriptionFallbackEmail: string; partnerCredentialsRef: string | null; buyBoxChangedAccess: 'GRANTED' | 'NOT_GRANTED' };
  amazon: { applicationCredentialsRef: string };
}

export function loadWorkerConfig(env: Env = process.env, read?: (path: string) => string): WorkerConfig {
  const access = env.REPRACER_KAUFLAND_BUY_BOX_CHANGED_ACCESS ?? 'NOT_GRANTED';
  if (access !== 'GRANTED' && access !== 'NOT_GRANTED') throw new ConfigError('CONFIG_INVALID: REPRACER_KAUFLAND_BUY_BOX_CHANGED_ACCESS must be GRANTED or NOT_GRANTED');
  const brokers = (env.REPRACER_KAFKA_BROKERS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (brokers.length === 0) throw new ConfigError('CONFIG_MISSING: REPRACER_KAFKA_BROKERS');
  return {
    workerId: env.REPRACER_WORKER_ID || `${hostname()}-${process.pid}`,
    pgUrl: requiredValue(secretFromEnv(env, 'REPRACER_APP_PG_URL', read), 'REPRACER_APP_PG_URL'),
    dispatcherPgUrl: requiredValue(secretFromEnv(env, 'REPRACER_DISPATCHER_PG_URL', read), 'REPRACER_DISPATCHER_PG_URL'),
    // Ретранслятор запускается во всех экземплярах, работает тот, кто взял advisory lock [Р-34]; без адреса — экземпляр без ретранслятора
    relayPgUrl: secretFromEnv(env, 'REPRACER_RELAY_PG_URL', read),
    kafkaBrokers: brokers,
    sweepIntervalMs: intFromEnv(env, 'REPRACER_WORKER_SWEEP_MS', 60_000, 1_000, 600_000),
    partitionsConcurrently: intFromEnv(env, 'REPRACER_WORKER_PARTITIONS', 4, 1, 64),
    metricsPort: intFromEnv(env, 'REPRACER_WORKER_METRICS_PORT', 9465, 1, 65_535),
    channelSecretsDir: requiredValue(env.REPRACER_CHANNEL_SECRETS_DIR, 'REPRACER_CHANNEL_SECRETS_DIR'),
    userAgent: env.REPRACER_USER_AGENT || 'repracer-worker/0.1 (Language=TypeScript; Platform=Node)',
    kaufland: {
      subscriptionFallbackEmail: requiredValue(env.REPRACER_KAUFLAND_FALLBACK_EMAIL, 'REPRACER_KAUFLAND_FALLBACK_EMAIL'),
      partnerCredentialsRef: env.REPRACER_KAUFLAND_PARTNER_CREDENTIALS_REF || null,
      buyBoxChangedAccess: access,
    },
    amazon: { applicationCredentialsRef: requiredValue(env.REPRACER_AMAZON_APPLICATION_CREDENTIALS_REF, 'REPRACER_AMAZON_APPLICATION_CREDENTIALS_REF') },
  };
}
