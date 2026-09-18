import { hostname } from 'node:os';
import { ConfigError, intFromEnv, requiredValue, secretFromEnv, type Env } from '@repracer/service-runtime';

/**
 * OQ-190 (шаг 27): конфигурация процесса приёмника уведомлений Amazon (шаг 23). Один процесс — одна очередь SQS одного региона:
 * очередь заводится на приложение в регионе, уведомления всех продавцов приходят в неё, маршрут к тенанту даёт база [Р-31].
 * Секреты — файлами: адрес очереди содержит номер аккаунта AWS, ключи AWS — тем более.
 */
export interface ReceiverConfig {
  receiverId: string;
  /** svc_app: доставка снимка в путь решения и журнал уведомлений */
  pgUrl: string;
  /** svc_inbound: маршрут продавца функцией базы (0083) — только идентификаторы */
  inboundPgUrl: string;
  queueUrl: string;
  region: 'EU' | 'NA' | 'FE';
  /** amzn1.sellerapps.app.… нашего приложения: чужое уведомление — CRITICAL */
  applicationId: string;
  aws: { accessKeyId: string; secretAccessKey: string; sessionToken: string | null };
  metricsPort: number;
  channelSecretsDir: string;
  userAgent: string;
  amazon: { applicationCredentialsRef: string };
  /** Тишина очереди дольше этого — WARNING [шаг 23]; значение по умолчанию — из политики приёмника */
  silenceAlertAfterMs: number | null;
}

const REGIONS = new Set(['EU', 'NA', 'FE']);

export function loadReceiverConfig(env: Env = process.env, read?: (path: string) => string): ReceiverConfig {
  const region = env.REPRACER_AMAZON_REGION ?? '';
  if (!REGIONS.has(region)) throw new ConfigError('CONFIG_INVALID: REPRACER_AMAZON_REGION must be EU, NA or FE');
  const queueUrl = requiredValue(secretFromEnv(env, 'REPRACER_SQS_QUEUE_URL', read), 'REPRACER_SQS_QUEUE_URL');
  if (!queueUrl.startsWith('https://sqs.')) throw new ConfigError('CONFIG_INVALID: REPRACER_SQS_QUEUE_URL must be an https SQS queue URL');
  const silence = env.REPRACER_RECEIVER_SILENCE_MS;
  return {
    receiverId: env.REPRACER_RECEIVER_ID || `${hostname()}-${process.pid}`,
    pgUrl: requiredValue(secretFromEnv(env, 'REPRACER_APP_PG_URL', read), 'REPRACER_APP_PG_URL'),
    inboundPgUrl: requiredValue(secretFromEnv(env, 'REPRACER_INBOUND_PG_URL', read), 'REPRACER_INBOUND_PG_URL'),
    queueUrl,
    region: region as 'EU' | 'NA' | 'FE',
    applicationId: requiredValue(env.REPRACER_AMAZON_APPLICATION_ID, 'REPRACER_AMAZON_APPLICATION_ID'),
    aws: {
      accessKeyId: requiredValue(secretFromEnv(env, 'REPRACER_AWS_ACCESS_KEY_ID', read), 'REPRACER_AWS_ACCESS_KEY_ID'),
      secretAccessKey: requiredValue(secretFromEnv(env, 'REPRACER_AWS_SECRET_ACCESS_KEY', read), 'REPRACER_AWS_SECRET_ACCESS_KEY'),
      sessionToken: secretFromEnv(env, 'REPRACER_AWS_SESSION_TOKEN', read),
    },
    metricsPort: intFromEnv(env, 'REPRACER_RECEIVER_METRICS_PORT', 9466, 1, 65_535),
    channelSecretsDir: requiredValue(env.REPRACER_CHANNEL_SECRETS_DIR, 'REPRACER_CHANNEL_SECRETS_DIR'),
    userAgent: env.REPRACER_USER_AGENT || 'repracer-notification-receiver/0.1 (Language=TypeScript; Platform=Node)',
    amazon: { applicationCredentialsRef: requiredValue(env.REPRACER_AMAZON_APPLICATION_CREDENTIALS_REF, 'REPRACER_AMAZON_APPLICATION_CREDENTIALS_REF') },
    silenceAlertAfterMs: silence === undefined || silence === '' ? null : intFromEnv(env, 'REPRACER_RECEIVER_SILENCE_MS', 0, 60_000, 24 * 3_600_000),
  };
}
