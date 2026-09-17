import { randomBytes } from 'node:crypto';
import { createPool, type PgPool } from '../src/index.ts';

/**
 * Отдельная база для теста, которому нужны глобальные данные платформы (курсы ЕЦБ, справочник витрин): в общей базе
 * они влияли бы на другие тесты. Копия шаблона с применёнными миграциями (REPRACER_PG_TEMPLATE, по умолчанию
 * repracer_template) — CREATE DATABASE … TEMPLATE, без повторного применения миграций: роли кластера уже созданы.
 * Нужны REPRACER_PG_URL (роль приложения) и REPRACER_PG_ADMIN_URL (суперпользователь стенда). Без них тест падает [Р-84].
 */
export type TestRole = 'svc_app' | 'svc_fx_loader' | 'svc_dispatcher' | 'svc_exporter' | 'svc_admin' | 'svc_provisioning' | 'svc_authenticator' | 'svc_scheduler';

export interface IsolatedDatabase {
  name: string;
  url(role: TestRole): string;
  pool(role: TestRole, max?: number): PgPool;
  /** Суперпользователь стенда в этой базе — только для данных платформы теста (строки возможностей, статус витрины) */
  superuser(sql: string, params?: unknown[]): Promise<void>;
  drop(): Promise<void>;
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required: database tests do not skip (Р-84)`);
  return value;
}

export async function createIsolatedDatabase(prefix: string): Promise<IsolatedDatabase> {
  const appUrl = new URL(requireEnv('REPRACER_PG_URL'));
  const adminUrl = requireEnv('REPRACER_PG_ADMIN_URL');
  const template = process.env.REPRACER_PG_TEMPLATE ?? 'repracer_template';
  if (!/^[a-z_][a-z0-9_]*$/.test(template) || !/^[a-z_][a-z0-9_]*$/.test(prefix)) throw new Error('database names must be plain identifiers');
  const name = `${prefix}_${randomBytes(4).toString('hex')}`;
  const admin = createPool(adminUrl, { max: 1, applicationName: 'repracer-isolated-db' });
  try {
    await admin.query(`CREATE DATABASE ${name} TEMPLATE ${template}`);
    // Настройки базы шаблон не переносит
    await admin.query(`ALTER DATABASE ${name} SET repracer.region = 'EU'`);
  } finally {
    await admin.end();
  }
  const pools: PgPool[] = [];
  const url = (role: string) => {
    const u = new URL(appUrl);
    u.username = role;
    u.pathname = `/${name}`;
    return u.toString();
  };
  return {
    name,
    url,
    pool(role, max = 4) {
      const p = createPool(url(role), { max, applicationName: `repracer-${prefix}` });
      pools.push(p);
      return p;
    },
    async superuser(sql, params = []) {
      const u = new URL(adminUrl);
      u.pathname = `/${name}`;
      const a = createPool(u.toString(), { max: 1, applicationName: 'repracer-isolated-db' });
      try {
        await a.query(sql, params);
      } finally {
        await a.end();
      }
    },
    async drop() {
      for (const p of pools) await p.end();
      const a = createPool(adminUrl, { max: 1, applicationName: 'repracer-isolated-db' });
      try {
        await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await a.end();
      }
    },
  };
}
