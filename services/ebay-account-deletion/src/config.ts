import { ConfigError, intFromEnv, requiredValue, secretFromEnv, type Env } from '@repracer/service-runtime';

/**
 * Шаг 49 [Р-192]: конфигурация приёмника уведомлений eBay Marketplace Account Deletion. Секреты — файлами: проверочный токен
 * участвует в ответе на challenge, секрет приложения — в получении ключа Notification API, строка базы — с паролем.
 */
export interface DeletionConfig {
  /** Публичный адрес, зарегистрированный в портале eBay (Alerts and Notifications): https, не localhost, не внутренний IP */
  endpoint: string;
  verificationToken: string;
  /** Порт HTTP приёма (за общим прокси профиля) */
  port: number;
  metricsPort: number;
  /** svc_ebay_deletion: только EXECUTE на функцию приёма */
  pgUrl: string;
  /** Где брать ключ Notification API: боевой или песочница */
  apiBase: string;
  clientId: string;
  clientSecret: string;
  heartbeatUrl: string | null;
}

const TOKEN_RE = /^[A-Za-z0-9_-]{32,80}$/;
const API_BASES: Record<string, string> = { PRODUCTION: 'https://api.ebay.com', SANDBOX: 'https://api.sandbox.ebay.com' };

/** Адрес для eBay: страница снимка требует https и запрещает localhost и внутренний IP */
export function checkEndpoint(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError('CONFIG_INVALID: REPRACER_EBAY_DELETION_ENDPOINT is not a URL');
  }
  const host = url.hostname;
  const internal = host === 'localhost' || host.endsWith('.localhost') || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || host === '[::1]' || /^0\./.test(host);
  if (url.protocol !== 'https:' || internal || url.search !== '' || url.hash !== '') {
    throw new ConfigError('CONFIG_INVALID: REPRACER_EBAY_DELETION_ENDPOINT must be a public https address without query (eBay Marketplace Account Deletion)');
  }
  /**
   * Находка 18 ревью: адрес входит в хэш challenge РОВНО таким, как зарегистрирован в портале eBay. `url.toString()`
   * нормализует (добавит «/» к адресу без пути, приведёт хост к нижнему регистру) — и хэш разошёлся бы с порталом.
   */
  return value.trim();
}

/** Модель eBay прогона: адрес Notification API подменяется только на стенде, как модель поставщика OAuth (channel-apps.ts) */
function standApiBase(env: Env): string | null {
  const value = env.REPRACER_EBAY_DELETION_API_BASE;
  if (!value) return null;
  if (env.REPRACER_MODE !== 'stand') throw new ConfigError('CONFIG_INVALID: REPRACER_EBAY_DELETION_API_BASE is accepted only with REPRACER_MODE=stand (модель eBay)');
  try { return new URL(value).toString().replace(/\/$/, ''); } catch { throw new ConfigError('CONFIG_INVALID: REPRACER_EBAY_DELETION_API_BASE must be an absolute URL'); }
}

export function loadDeletionConfig(env: Env = process.env, read?: (path: string) => string): DeletionConfig {
  const verificationToken = requiredValue(secretFromEnv(env, 'REPRACER_EBAY_DELETION_VERIFICATION_TOKEN', read), 'REPRACER_EBAY_DELETION_VERIFICATION_TOKEN');
  if (!TOKEN_RE.test(verificationToken)) {
    throw new ConfigError('CONFIG_INVALID: REPRACER_EBAY_DELETION_VERIFICATION_TOKEN must be 32–80 characters of A–Z, a–z, 0–9, _ and - (eBay)');
  }
  const environment = env.REPRACER_EBAY_ENVIRONMENT ?? '';
  const apiBase = API_BASES[environment];
  if (!apiBase) throw new ConfigError('CONFIG_INVALID: REPRACER_EBAY_ENVIRONMENT must be PRODUCTION or SANDBOX');
  // Р-127: процесс без внешнего контроля о своей смерти не сообщает; выключить отметку можно только явно
  const heartbeatUrl = env.REPRACER_EBAY_DELETION_HEARTBEAT === 'off' ? null
    : requiredValue(secretFromEnv(env, 'REPRACER_EBAY_DELETION_HEARTBEAT_URL', read), 'REPRACER_EBAY_DELETION_HEARTBEAT_URL (or REPRACER_EBAY_DELETION_HEARTBEAT=off)');
  if (heartbeatUrl !== null && !heartbeatUrl.startsWith('https://')) throw new ConfigError('CONFIG_INVALID: REPRACER_EBAY_DELETION_HEARTBEAT_URL must be https');
  return {
    endpoint: checkEndpoint(requiredValue(env.REPRACER_EBAY_DELETION_ENDPOINT, 'REPRACER_EBAY_DELETION_ENDPOINT')),
    verificationToken,
    port: intFromEnv(env, 'REPRACER_EBAY_DELETION_PORT', 8470, 1, 65_535),
    metricsPort: intFromEnv(env, 'REPRACER_EBAY_DELETION_METRICS_PORT', 9470, 1, 65_535),
    pgUrl: requiredValue(secretFromEnv(env, 'REPRACER_EBAY_DELETION_PG_URL', read), 'REPRACER_EBAY_DELETION_PG_URL'),
    apiBase: standApiBase(env) ?? apiBase,
    clientId: requiredValue(env.REPRACER_EBAY_CLIENT_ID, 'REPRACER_EBAY_CLIENT_ID'),
    clientSecret: requiredValue(secretFromEnv(env, 'REPRACER_EBAY_CLIENT_SECRET', read), 'REPRACER_EBAY_CLIENT_SECRET'),
    heartbeatUrl,
  };
}
