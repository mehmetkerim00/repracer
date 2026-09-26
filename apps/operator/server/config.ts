import { readFileSync } from 'node:fs';
import { ConfigError, intFromEnv, requiredValue, secretFromEnv, type Env } from '@repracer/service-runtime';

/**
 * Р-165 (шаг 40): панель оператора платформы — ОТДЕЛЬНЫЙ процесс со своим портом. Не маршрут консоли и не её вкладка:
 * консоль публична (в ней живёт демо-гость [Р-160]), а панель наружу не выставляется вовсе — до неё добираются по
 * туннелю или из названного списка адресов, и на общем прокси её нет.
 *
 * Конфигурация — как у остальных процессов [Р-129]: значения переменными, секреты ФАЙЛАМИ. Роль подключения ОДНА —
 * `repracer_operator`, и у неё нет прав ни на одну таблицу: всё, что панель умеет, — это EXECUTE на функции панели.
 */

export interface OperatorConfig {
  /** Порт панели: слушается внутри сети развёртывания, наружу его выставляет туннель или список адресов */
  port: number;
  /** Порт `/healthz` и метрик — отдельный, как у консоли и планировщика */
  metricsPort: number;
  /** Строка подключения роли панели (пароль внутри — поэтому только файлом) */
  pgUrl: string;
  /**
   * Вход оператора у поставщика identity [Р-78] — ОБЯЗАТЕЛЕН. Ни симулятора стенда, ни гостевого входа [Р-160] здесь
   * нет: панель — это чужие тенанты, и «зайти посмотреть» в неё нельзя.
   */
  oidc: { issuer: string; audience: string; jwksUrl: string };
  /** Адрес, по которому владелец принимает приглашение: попадает в письмо [Р-167] */
  invitationBaseUrl: string;
  /** Срок приглашения в часах: база принимает не больше 14 суток (0053) */
  invitationTtlHours: number;
  /** Провайдер почты; null — СУХОЙ режим [шаг 37, OQ-224]: письмо собирается целиком и не уходит никуда */
  mail: { apiUrl: string; apiKey: string; from: string } | null;
  /** Р-127: отметка во внешнем сервисе — панель такой же процесс, как остальные */
  heartbeatUrl: string | null;
  /**
   * Ключ ИЗДАТЕЛЯ СТЕНДА (PEM, EC P-256) — только в режиме стенда [шаг 28, E]. Живой прогон поднимает ТОТ ЖЕ процесс
   * [Р-136] и ходит по нему как браузер, но поставщика identity у прогона нет; ключ даёт ему свои токены. В работе это
   * значение не принимается вовсе — там панель спрашивает ключи у поставщика по адресу JWKS.
   */
  standIssuerKeyPem: string | null;
}

const secret = (env: Env, name: string, read: (path: string) => string) => secretFromEnv(env, name, read);
const OIDC_VARS = ['REPRACER_OPERATOR_OIDC_ISSUER', 'REPRACER_OPERATOR_OIDC_AUDIENCE', 'REPRACER_OPERATOR_OIDC_JWKS_URL'] as const;

export function loadOperatorConfig(env: Env = process.env, read: (path: string) => string = (p) => readFileSync(p, 'utf8')): OperatorConfig {
  const missing = OIDC_VARS.filter((v) => !env[v]);
  /**
   * Вход настраивается целиком или процесс не стартует. Панель без поставщика входа — это либо открытая всем панель,
   * либо процесс, отвечающий 401 на всё и выглядящий работающим; оба хуже отказа при старте.
   */
  if (missing.length > 0) {
    throw new ConfigError(`CONFIG_MISSING: ${missing.join(', ')} (у панели оператора нет входа без поставщика identity: гостя и стендового входа в ней нет [Р-165])`);
  }
  if (!/^https:\/\//.test(env.REPRACER_OPERATOR_OIDC_ISSUER!) || !/^https:\/\//.test(env.REPRACER_OPERATOR_OIDC_JWKS_URL!)) {
    throw new ConfigError('CONFIG_INVALID: REPRACER_OPERATOR_OIDC_ISSUER and REPRACER_OPERATOR_OIDC_JWKS_URL must be https URLs');
  }

  // «Настроено» решают ЗНАЧЕНИЯ, а не имена переменных (находка 3 ревью шага 37): compose называет имя файла ключа всегда
  const namedMail = (['REPRACER_MAIL_API_URL', 'REPRACER_MAIL_FROM'] as const).filter((v) => env[v]);
  if (namedMail.length === 1) {
    const other = namedMail[0] === 'REPRACER_MAIL_API_URL' ? 'REPRACER_MAIL_FROM' : 'REPRACER_MAIL_API_URL';
    throw new ConfigError(`CONFIG_MISSING: ${other} (почта настраивается целиком: ${namedMail[0]} уже задано)`);
  }
  const mail = namedMail.length === 0 ? null : {
    apiUrl: requiredValue(env.REPRACER_MAIL_API_URL, 'REPRACER_MAIL_API_URL'),
    apiKey: requiredValue(secret(env, 'REPRACER_MAIL_API_KEY', read), 'REPRACER_MAIL_API_KEY'),
    from: requiredValue(env.REPRACER_MAIL_FROM, 'REPRACER_MAIL_FROM'),
  };
  if (mail && !mail.apiUrl.startsWith('https://')) throw new ConfigError('CONFIG_INVALID: REPRACER_MAIL_API_URL must be https');

  const heartbeatUrl = env.REPRACER_OPERATOR_HEARTBEAT === 'off'
    ? null
    : requiredValue(secret(env, 'REPRACER_OPERATOR_HEARTBEAT_URL', read), 'REPRACER_OPERATOR_HEARTBEAT_URL (or REPRACER_OPERATOR_HEARTBEAT=off)');
  if (heartbeatUrl && !heartbeatUrl.startsWith('https://')) throw new ConfigError('CONFIG_INVALID: REPRACER_OPERATOR_HEARTBEAT_URL must be https');

  const standKey = env.REPRACER_OPERATOR_STAND_KEY ?? null;
  if (standKey && env.REPRACER_MODE !== 'stand') {
    throw new ConfigError('CONFIG_INVALID: REPRACER_OPERATOR_STAND_KEY is accepted only with REPRACER_MODE=stand (в работе ключи входа приходят от поставщика identity)');
  }

  const invitationBaseUrl = requiredValue(env.REPRACER_OPERATOR_INVITATION_URL, 'REPRACER_OPERATOR_INVITATION_URL');
  // Ссылка из письма ведёт по https: приглашение несёт токен, и отдавать его по открытому каналу — раздача чужого входа
  if (!invitationBaseUrl.startsWith('https://')) throw new ConfigError('CONFIG_INVALID: REPRACER_OPERATOR_INVITATION_URL must be https');

  return {
    port: intFromEnv(env, 'REPRACER_OPERATOR_PORT', 4327, 0, 65_535),
    metricsPort: intFromEnv(env, 'REPRACER_OPERATOR_METRICS_PORT', 9471, 0, 65_535),
    pgUrl: requiredValue(secret(env, 'REPRACER_OPERATOR_PG_URL', read), 'REPRACER_OPERATOR_PG_URL'),
    oidc: { issuer: env.REPRACER_OPERATOR_OIDC_ISSUER!, audience: env.REPRACER_OPERATOR_OIDC_AUDIENCE!, jwksUrl: env.REPRACER_OPERATOR_OIDC_JWKS_URL! },
    invitationBaseUrl,
    invitationTtlHours: intFromEnv(env, 'REPRACER_OPERATOR_INVITATION_TTL_HOURS', 168, 1, 14 * 24),
    mail,
    heartbeatUrl,
    standIssuerKeyPem: standKey,
  };
}
