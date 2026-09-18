import { readFileSync } from 'node:fs';

/**
 * Конфигурация долгоживущего процесса из переменных окружения [Р-129, шаг 27 OQ-190]. Секреты (адреса баз с паролями, адреса очередей
 * с идентификатором аккаунта, адрес внешней отметки) — из файлов `<ИМЯ>_FILE`; значение секрета ни в журнал, ни в текст ошибки не
 * попадает: ошибка называет только имя переменной.
 */
export type Env = Readonly<Record<string, string | undefined>>;

export class ConfigError extends Error {}

/**
 * Шаг 28, E: секрет приходит ИЗ ФАЙЛА. Значение переменной окружения принимается только в режиме стенда (`REPRACER_MODE=stand`):
 * в переменных окружения секрет видят все процессы контейнера и `docker inspect`, а файл монтируется только на чтение и только тому,
 * кому нужен. Раньше значение переменной принималось всегда — развёртывания так не делали, но самой защиты не было (ревью шага 27).
 *
 * Чего эта защита НЕ делает (ревью шага 28, замечание 18): она самодекларируемая. Кто может задать `REPRACER_APP_PG_URL`, обычно
 * может задать и `REPRACER_MODE=stand`. Это защита от ошибки развёртывания, а не от злоумышленника: в compose `REPRACER_MODE` не
 * встречается вовсе, поэтому промышленное развёртывание секрет из переменной не примет и молча не запустится.
 */
export type SecretMode = 'FILE_ONLY' | 'STAND';

export function secretMode(env: Env): SecretMode {
  return env.REPRACER_MODE === 'stand' ? 'STAND' : 'FILE_ONLY';
}

export function secretFromEnv(env: Env, name: string, read: (path: string) => string = (p) => readFileSync(p, 'utf8')): string | null {
  const file = env[`${name}_FILE`];
  if (file) {
    try {
      return read(file).trim();
    } catch {
      throw new ConfigError(`CONFIG_SECRET_UNREADABLE: ${name}_FILE`);
    }
  }
  const value = env[name];
  if (value === undefined || value === '') return null;
  if (secretMode(env) !== 'STAND') {
    // Значение секрета в ошибку не попадает — только имя переменной и то, как его передать правильно
    throw new ConfigError(`CONFIG_SECRET_IN_ENV: ${name} comes from ${name}_FILE; a value in the environment is accepted only with REPRACER_MODE=stand`);
  }
  return value;
}

export function requiredValue(value: string | null | undefined, name: string): string {
  if (!value) throw new ConfigError(`CONFIG_MISSING: ${name}`);
  return value;
}

export function intFromEnv(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new ConfigError(`CONFIG_INVALID: ${name} must be an integer in [${min}, ${max}]`);
  return n;
}
