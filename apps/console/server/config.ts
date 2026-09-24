import { readFileSync } from 'node:fs';
import { ConfigError, intFromEnv, requiredValue, secretFromEnv, type Env } from '@repracer/service-runtime';

/**
 * Р-159 (шаг 37, OQ-221): консоль продавца — РАЗВОРАЧИВАЕМЫЙ процесс, а не только сервер стенда, запускаемый руками.
 * Конфигурация — тем же способом, что у планировщика, диспетчера и приёмника [Р-129]: значения переменными окружения,
 * секреты ФАЙЛАМИ. Строка подключения несёт пароль роли, поэтому приходит файлом [шаг 28, E].
 *
 * Ролей несколько, и каждая приходит своим файлом: у консоли нет одной «главной» роли [Р-90]. Экраны читают путь решения
 * (svc_app), остановки и границы пишет административная роль (svc_admin), вход спрашивает свою (svc_authenticator),
 * остатки — свою (svc_stock). Выводить их подстановкой из одной строки, как делает стенд, в работе нельзя: у ролей разные
 * пароли, и подстановка молча увела бы консоль под чужой ролью.
 */

export interface ConsoleConfig {
  /** Порт интерфейса и API: слушается внутри сети compose, наружу его выставляет обратный прокси [Р-158] */
  port: number;
  /** Порт работоспособности и метрик — отдельный: `/healthz` не должен зависеть от того, отвечает ли интерфейс */
  metricsPort: number;
  /** Каталог собранного интерфейса (`npm run build -w apps/console`) */
  distDir: string;
  /** Язык по умолчанию, пока браузер не выбрал свой [Р-72] */
  locale: 'de' | 'en';
  /**
   * Р-160: публичный демо-режим. `on` — на странице входа есть кнопка «посмотреть демо», и гость получает НАБЛЮДАТЕЛЯ
   * в демо-тенанте без регистрации. `off` — кнопки нет и маршрут гостя отвечает 404.
   */
  publicDemo: boolean;
  /** Каждые сколько часов демо-мир пересеивается заново (Р-160): демо, в котором продавец что-то «сломал», показывать нельзя */
  demoReseedHours: number;
  /**
   * Закрытый ключ гостевого издателя (PEM, EC P-256). `null` — временный ключ в памяти процесса, и тогда экземпляр
   * обязан быть ОДИН: две реплики с разными ключами дают гостю случайные 401 (находка 1 ревью шага 37).
   */
  guestKeyPem: string | null;
  /** Строки подключения по ролям: ключ — имя роли без `svc_` */
  pgUrls: Readonly<Record<ConsoleRole, string>>;
  /** Вход настоящих продавцов [Р-78]: поставщик identity. Без него работает только гость демо */
  oidc: { issuer: string; audience: string; jwksUrl: string } | null;
  /**
   * Р-127: отметка во внешнем сервисе. Консоль — такой же разворачиваемый процесс, как планировщик: остановившуюся
   * консоль публичного демо не заметит НИКТО, кроме посетителя, который просто уйдёт. Выключение — только явное.
   */
  heartbeatUrl: string | null;
}

/**
 * Роли подключения консоли. Список закрытый и назван здесь: процесс, которому понадобилась роль сверх списка, обязан
 * объявить её здесь — тогда её увидят и compose, и проверка конфигурации развёртывания (scripts/deploy-config-check.mjs).
 */
export const CONSOLE_ROLES = [
  'app', 'admin', 'authenticator', 'onboarding', 'provisioning', 'dispatcher', 'stock', 'scheduler', 'exporter', 'fx_loader', 'bulk_worker',
] as const;
export type ConsoleRole = (typeof CONSOLE_ROLES)[number];

const OIDC_VARS = ['REPRACER_CONSOLE_OIDC_ISSUER', 'REPRACER_CONSOLE_OIDC_AUDIENCE', 'REPRACER_CONSOLE_OIDC_JWKS_URL'] as const;

// Секрет только из файла, кроме режима стенда [шаг 28, E] — тот же разбор, что у остальных процессов
const secret = (env: Env, name: string, read: (path: string) => string) => secretFromEnv(env, name, read);
const required = requiredValue;

export function loadConsoleConfig(env: Env = process.env, read: (path: string) => string = (p) => readFileSync(p, 'utf8')): ConsoleConfig {
  const locale = env.REPRACER_CONSOLE_LOCALE ?? 'de';
  if (locale !== 'de' && locale !== 'en') throw new ConfigError('CONFIG_INVALID: REPRACER_CONSOLE_LOCALE must be de or en');

  const pgUrls = {} as Record<ConsoleRole, string>;
  for (const role of CONSOLE_ROLES) {
    const name = `REPRACER_CONSOLE_${role.toUpperCase()}_PG_URL`;
    pgUrls[role] = required(secret(env, name, read), name);
  }

  const present = OIDC_VARS.filter((v) => env[v]);
  let oidc: ConsoleConfig['oidc'] = null;
  if (present.length > 0) {
    const missing = OIDC_VARS.filter((v) => !env[v]);
    if (missing.length > 0) throw new ConfigError(`CONFIG_MISSING: ${missing.join(', ')} (вход у поставщика настраивается целиком или не настраивается вовсе)`);
    // Поставщик отвечает по https: токен и ключи по открытому каналу — это раздача чужих сессий
    if (!/^https:\/\//.test(env.REPRACER_CONSOLE_OIDC_ISSUER!) || !/^https:\/\//.test(env.REPRACER_CONSOLE_OIDC_JWKS_URL!)) {
      throw new ConfigError('CONFIG_INVALID: REPRACER_CONSOLE_OIDC_ISSUER and REPRACER_CONSOLE_OIDC_JWKS_URL must be https URLs');
    }
    oidc = { issuer: env.REPRACER_CONSOLE_OIDC_ISSUER!, audience: env.REPRACER_CONSOLE_OIDC_AUDIENCE!, jwksUrl: env.REPRACER_CONSOLE_OIDC_JWKS_URL! };
  }

  const publicDemo = env.REPRACER_CONSOLE_PUBLIC_DEMO === 'on';
  /**
   * Ключ гостевого издателя — из файла секретов, как все ключи. Временный ключ в памяти разрешён только ЯВНО
   * (`REPRACER_CONSOLE_GUEST_KEY=ephemeral`) и означает «экземпляр один»: молчаливое умолчание здесь — это гость,
   * получающий 401 на каждом втором запросе, как только рядом встанет вторая реплика.
   */
  const guestKeyPem = !publicDemo || env.REPRACER_CONSOLE_GUEST_KEY === 'ephemeral'
    ? null
    : requiredValue(secret(env, 'REPRACER_CONSOLE_GUEST_KEY', read), 'REPRACER_CONSOLE_GUEST_KEY (or REPRACER_CONSOLE_GUEST_KEY=ephemeral для одного экземпляра)');
  /**
   * Процесс, который не пускает ни продавца, ни гостя, поднимать незачем: он ответит 401 на всё и будет выглядеть работающим.
   * Поэтому одно из двух обязано быть настроено, и отказ называет оба пути.
   */
  if (!publicDemo && !oidc) {
    throw new ConfigError('CONFIG_MISSING: REPRACER_CONSOLE_PUBLIC_DEMO=on или вход у поставщика (REPRACER_CONSOLE_OIDC_*): консоль без единого пути входа не запускается');
  }

  const heartbeatOff = env.REPRACER_CONSOLE_HEARTBEAT === 'off';
  const heartbeatUrl = heartbeatOff ? null : required(secret(env, 'REPRACER_CONSOLE_HEARTBEAT_URL', read), 'REPRACER_CONSOLE_HEARTBEAT_URL (or REPRACER_CONSOLE_HEARTBEAT=off)');
  if (heartbeatUrl && !heartbeatUrl.startsWith('https://')) throw new ConfigError('CONFIG_INVALID: REPRACER_CONSOLE_HEARTBEAT_URL must be https');

  return {
    heartbeatUrl,
    // 0 — порт выдаёт система: так живой прогон поднимает ТОТ ЖЕ процесс, не занимая заранее известный порт
    port: intFromEnv(env, 'REPRACER_CONSOLE_PORT', 4319, 0, 65_535),
    metricsPort: intFromEnv(env, 'REPRACER_CONSOLE_METRICS_PORT', 9467, 0, 65_535),
    distDir: requiredValue(env.REPRACER_CONSOLE_DIST, 'REPRACER_CONSOLE_DIST'),
    locale,
    publicDemo,
    // Сутки по умолчанию: демо переживает рабочий день целиком, а следы вчерашних гостей не копятся
    demoReseedHours: intFromEnv(env, 'REPRACER_CONSOLE_DEMO_RESEED_HOURS', 24, 1, 24 * 30),
    guestKeyPem,
    pgUrls,
    oidc,
  };
}
