import type { PgPool } from '@repracer/pricing-store-pg';

/**
 * Шаг 57 (п. 5): одна реплика консоли — не объявление конфигурации, а гарантия. Счётчик частоты запросов живёт в памяти процесса
 * (шаг 54): у второй реплики он свой, и предел на адрес удваивается. Страж `REPRACER_CONSOLE_REPLICAS` видел только то, что ему сказали:
 * `docker compose --scale`, второй `docker run` или ручной запуск рядом объявления не меняют. Теперь процесс при старте ограничителя
 * берёт сессионную advisory-блокировку PostgreSQL на ОТДЕЛЬНОМ соединении и держит её, пока жив: реплики делят базу, как бы их ни
 * запустили, и вторая получает отказ своей причиной. Соединение потеряно — блокировку отпустила база, и процесс завершается: служить
 * без неё он не вправе, а перезапуск развёртывания возьмёт её заново
 */
export const CONSOLE_REPLICA_LOCK_KEY = 'repracer.console.rate_limiter';

export class ConsoleAlreadyRunningError extends Error {
  constructor() {
    super('CONSOLE_ALREADY_RUNNING: another console process holds the single-replica lock of this database — the request rate limiter lives in process memory, a second replica would double it (step 54, 57)');
  }
}

export interface ReplicaLock { release(): Promise<void> }

export async function acquireConsoleReplicaLock(pool: PgPool, onLost: (error: unknown) => void): Promise<ReplicaLock> {
  const client = await pool.connect();
  let released = false;
  client.on('error', (error) => { if (!released) onLost(error); });
  try {
    const { rows } = await client.query('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked', [CONSOLE_REPLICA_LOCK_KEY]);
    if (rows[0]?.locked !== true) throw new ConsoleAlreadyRunningError();
  } catch (error) {
    released = true;
    client.release(true);
    throw error;
  }
  return {
    async release() {
      if (released) return;
      released = true;
      // Соединение закрывается, а не возвращается в пул: сессионная блокировка уходит вместе с ним
      client.release(true);
    },
  };
}
