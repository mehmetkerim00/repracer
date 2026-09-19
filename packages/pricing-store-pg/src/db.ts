import pg from 'pg';

/**
 * Подключение к PostgreSQL для пути решения.
 * Контекст тенанта задаётся на транзакцию (set_config(..., true)): соединение из пула не уносит чужой тенант.
 * Типы: bigint — безопасное целое number (деньги в minor units, INV-07), timestamptz — ISO-строка UTC.
 */

export type PgPool = pg.Pool;
export type Tx = pg.PoolClient;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LEASE_OWNER_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

const INT8 = 20;
const INT8_ARRAY = 1016;
const TIMESTAMPTZ = 1184;

function toSafeNumber(value: string): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new Error(`bigint ${value} is outside the safe integer range`);
  return n;
}

const builtinParser = pg.types.getTypeParser as (oid: number, format: 'text') => unknown;
const baseTimestamp = builtinParser(TIMESTAMPTZ, 'text') as (v: string) => Date;
const baseInt8Array = builtinParser(INT8_ARRAY, 'text') as (v: string) => Array<string | null>;

export const PG_TYPES = {
  getTypeParser(oid: number, format?: 'text' | 'binary') {
    if (format === 'binary') return (pg.types.getTypeParser as (oid: number, format: 'binary') => unknown)(oid, 'binary');
    switch (oid) {
      case INT8: return toSafeNumber;
      case INT8_ARRAY: return (v: string) => baseInt8Array(v).map((x) => (x === null ? null : toSafeNumber(x)));
      case TIMESTAMPTZ: return (v: string) => baseTimestamp(v).toISOString();
      default: return builtinParser(oid, 'text');
    }
  },
} as pg.CustomTypesConfig;

export function createPool(connectionString: string, options: { max?: number; applicationName?: string } = {}): PgPool {
  const pool = new pg.Pool({
    connectionString,
    max: options.max ?? 10,
    application_name: options.applicationName ?? 'repracer-pricing',
    types: PG_TYPES,
    options: '-c TimeZone=UTC',
  });
  // Потеря простаивающего соединения (перезапуск сервера, сеть) не должна ронять процесс: без обработчика pg бросает
  // необработанное событие error. Соединение уже удалено из пула; следующий запрос откроет новое и получит ошибку сам.
  pool.on('error', () => undefined);
  return pool;
}

/** Откат транзакции с результатом (например, «версия границ изменилась» — Р-54) */
export class RollbackWith<T> {
  readonly value: T;
  constructor(value: T) {
    this.value = value;
  }
}

/**
 * Транзакция в контексте тенанта. BEGIN и set_config — одним обращением к серверу;
 * в текст запроса подставляются только проверенные UUID.
 */
export async function inTenant<T>(pool: PgPool, tenantId: string, fn: (tx: Tx) => Promise<T>, userId?: string,
  options: { mfa?: boolean; bulkJobId?: string; leaseOwner?: string } = {}): Promise<T> {
  if (!UUID_RE.test(tenantId) || (userId !== undefined && !UUID_RE.test(userId))) {
    throw new Error('tenant and user ids must be UUIDs');
  }
  // Р-139: применяющее задание называет себя базе — стражи массового изменения принимают второй фактор, предъявленный при его
  // создании (`security.second_factor_present`). Идентификатор проверяется здесь же: в запрос он идёт подстановкой
  if (options.bulkJobId !== undefined && !UUID_RE.test(options.bulkJobId)) throw new Error('bulk job id must be a UUID');
  // Р-139: имя процесса, держащего аренду задания. Оно идёт в запрос подстановкой, поэтому состав символов проверяется здесь
  if (options.leaseOwner !== undefined && !LEASE_OWNER_RE.test(options.leaseOwner)) throw new Error('bulk lease owner must be 1..64 of [A-Za-z0-9_.:-]');
  const client = await pool.connect();
  let open = false;
  try {
    await client.query(
      // Р-88: второй фактор сессии — из токена поставщика (amr); БД требует его для снятия остановки тенанта и смены ролей
      `BEGIN; SELECT set_config('app.tenant_id', '${tenantId}', true)${userId ? `, set_config('app.user_id', '${userId}', true)` : ''}${options.mfa ? `, set_config('app.auth_mfa', 'on', true)` : ''}${options.bulkJobId ? `, set_config('app.bulk_job_id', '${options.bulkJobId}', true)` : ''}${options.leaseOwner ? `, set_config('app.bulk_lease_owner', '${options.leaseOwner}', true)` : ''}`,
    );
    open = true;
    let result: T;
    try {
      result = await fn(client);
    } catch (error) {
      open = false;
      await client.query('ROLLBACK');
      if (error instanceof RollbackWith) return error.value as T;
      throw error;
    }
    open = false;
    // Ошибка отложенной проверки при COMMIT завершает транзакцию на сервере: откатывать больше нечего
    await client.query('COMMIT');
    return result;
  } catch (error) {
    // Сбой BEGIN или контекста тенанта: транзакция могла остаться открытой
    if (open) await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}
