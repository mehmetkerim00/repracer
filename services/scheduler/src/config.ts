import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { ConfigError, intFromEnv, requiredValue, secretFromEnv } from '@repracer/service-runtime';

/**
 * Р-129 (шаг 26): конфигурация процесса планировщика — из переменных окружения; секреты (адреса баз с паролями, пароли ClickHouse, адрес
 * внешней отметки) — из файлов `<ИМЯ>_FILE` (секреты развёртывания) или переменной. Значения секретов в ошибки и журнал не попадают:
 * ошибка называет только имя переменной.
 */
export interface SchedulerConfig {
  owner: string;
  /** Наибольшая пауза между тактами; процесс просыпается и раньше — к ближайшему сроку */
  tickMs: number;
  /** svc_scheduler: состояние работ, закрытие суток, секции, удаление по сроку */
  schedulerPgUrl: string;
  /** svc_app: путь решения — опрос, сверка, обход офферов [Р-90] */
  appPgUrl: string;
  /** svc_exporter: выгрузка суток в ClickHouse */
  exporterPgUrl: string;
  clickHouse: { url: string; ingest: { user: string; password: string }; verifier: { user: string; password: string } };
  /** Р-127: адрес отметки во внешнем сервисе; без него процесс не стартует, кроме явного REPRACER_SCHEDULER_HEARTBEAT=off */
  heartbeatUrl: string | null;
  metricsPort: number;
  /** Каталог учётных данных каналов: файл на ссылку учётных данных аккаунта (credentials_ref) */
  channelSecretsDir: string;
  userAgent: string;
  kaufland: { subscriptionFallbackEmail: string; partnerCredentialsRef: string | null; buyBoxChangedAccess: 'GRANTED' | 'NOT_GRANTED' };
  amazon: { applicationCredentialsRef: string };
}

export { ConfigError };

type Env = Readonly<Record<string, string | undefined>>;

// Шаг 28: разбор конфигурации — общий для всех процессов (@repracer/service-runtime): секрет только из файла, кроме режима стенда
const secret = (env: Env, name: string, read: (path: string) => string) => secretFromEnv(env, name, read);
const required = requiredValue;
const int = intFromEnv;

export function loadConfig(env: Env = process.env, read: (path: string) => string = (p) => readFileSync(p, 'utf8')): SchedulerConfig {
  const heartbeatOff = env.REPRACER_SCHEDULER_HEARTBEAT === 'off';
  const heartbeatUrl = heartbeatOff ? null : required(secret(env, 'REPRACER_SCHEDULER_HEARTBEAT_URL', read), 'REPRACER_SCHEDULER_HEARTBEAT_URL (or REPRACER_SCHEDULER_HEARTBEAT=off)');
  if (heartbeatUrl && !heartbeatUrl.startsWith('https://')) throw new ConfigError('CONFIG_INVALID: REPRACER_SCHEDULER_HEARTBEAT_URL must be https');
  const access = env.REPRACER_KAUFLAND_BUY_BOX_CHANGED_ACCESS ?? 'NOT_GRANTED';
  if (access !== 'GRANTED' && access !== 'NOT_GRANTED') throw new ConfigError('CONFIG_INVALID: REPRACER_KAUFLAND_BUY_BOX_CHANGED_ACCESS must be GRANTED or NOT_GRANTED');
  return {
    owner: env.REPRACER_SCHEDULER_OWNER || `${hostname()}-${process.pid}`,
    // 30 с по умолчанию: наибольшая пауза; сроки работ короче такта процесс ловит пробуждением к сроку
    tickMs: int(env, 'REPRACER_SCHEDULER_TICK_MS', 30_000, 1_000, 300_000),
    schedulerPgUrl: required(secret(env, 'REPRACER_SCHEDULER_PG_URL', read), 'REPRACER_SCHEDULER_PG_URL'),
    appPgUrl: required(secret(env, 'REPRACER_APP_PG_URL', read), 'REPRACER_APP_PG_URL'),
    exporterPgUrl: required(secret(env, 'REPRACER_EXPORTER_PG_URL', read), 'REPRACER_EXPORTER_PG_URL'),
    clickHouse: {
      url: required(env.REPRACER_CH_URL, 'REPRACER_CH_URL'),
      ingest: { user: required(env.REPRACER_CH_INGEST_USER, 'REPRACER_CH_INGEST_USER'), password: required(secret(env, 'REPRACER_CH_INGEST_PASSWORD', read), 'REPRACER_CH_INGEST_PASSWORD') },
      verifier: { user: required(env.REPRACER_CH_VERIFIER_USER, 'REPRACER_CH_VERIFIER_USER'), password: required(secret(env, 'REPRACER_CH_VERIFIER_PASSWORD', read), 'REPRACER_CH_VERIFIER_PASSWORD') },
    },
    heartbeatUrl,
    metricsPort: int(env, 'REPRACER_SCHEDULER_METRICS_PORT', 9464, 1, 65_535),
    channelSecretsDir: required(env.REPRACER_CHANNEL_SECRETS_DIR, 'REPRACER_CHANNEL_SECRETS_DIR'),
    userAgent: env.REPRACER_USER_AGENT || 'repracer-scheduler/0.1 (Language=TypeScript; Platform=Node)',
    kaufland: {
      subscriptionFallbackEmail: required(env.REPRACER_KAUFLAND_FALLBACK_EMAIL, 'REPRACER_KAUFLAND_FALLBACK_EMAIL'),
      partnerCredentialsRef: env.REPRACER_KAUFLAND_PARTNER_CREDENTIALS_REF || null,
      buyBoxChangedAccess: access,
    },
    amazon: { applicationCredentialsRef: required(env.REPRACER_AMAZON_APPLICATION_CREDENTIALS_REF, 'REPRACER_AMAZON_APPLICATION_CREDENTIALS_REF') },
  };
}
