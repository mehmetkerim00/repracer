import { readFileSync } from 'node:fs';

/**
 * Конфигурация долгоживущего процесса из переменных окружения [Р-129, шаг 27 OQ-190]. Секреты (адреса баз с паролями, адреса очередей
 * с идентификатором аккаунта, адрес внешней отметки) — из файлов `<ИМЯ>_FILE`; значение секрета ни в журнал, ни в текст ошибки не
 * попадает: ошибка называет только имя переменной.
 */
export type Env = Readonly<Record<string, string | undefined>>;

export class ConfigError extends Error {}

export function secretFromEnv(env: Env, name: string, read: (path: string) => string = (p) => readFileSync(p, 'utf8')): string | null {
  const file = env[`${name}_FILE`];
  if (file) {
    try {
      return read(file).trim();
    } catch {
      throw new ConfigError(`CONFIG_SECRET_UNREADABLE: ${name}_FILE`);
    }
  }
  return env[name] ?? null;
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
