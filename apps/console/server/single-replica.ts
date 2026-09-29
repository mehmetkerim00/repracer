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
  constructor(holder: string) {
    super(`CONSOLE_ALREADY_RUNNING: another console process holds the single-replica lock of this database — the request rate limiter lives in process memory, a second replica would double it (step 54, 57); holder: ${holder}`);
  }
}

/**
 * Шаг 58 (ревью шага 57, находка 3): сервер базы узнаёт о пропавшем клиенте (жёсткая перезагрузка VPS, обрыв сети) только по TCP keepalive,
 * а по умолчанию ОС это ~2 ч 11 мин: всё это время осиротевший серверный процесс держал бы блокировку, и перезапущенная консоль отказывала бы
 * `CONSOLE_ALREADY_RUNNING` по кругу. Соединение блокировки задаёт серверные keepalive: пропавший держатель снимается за
 * idle + interval × count = 30 + 10 × 3 = 60 с. Параметры действуют на TCP-соединении (у консоли в работе — всегда TCP к хостингу базы)
 */
export const REPLICA_LOCK_KEEPALIVE = { idleSeconds: 30, intervalSeconds: 10, count: 3 } as const;

export interface ReplicaLock {
  release(): Promise<void>;
  /** Серверные keepalive сессии блокировки — как их видит сама база */
  keepalive(): Promise<{ idle: number; interval: number; count: number }>;
}

export async function acquireConsoleReplicaLock(pool: PgPool, onLost: (error: unknown) => void): Promise<ReplicaLock> {
  const client = await pool.connect();
  let released = false;
  client.on('error', (error) => { if (!released) onLost(error); });
  try {
    const k = REPLICA_LOCK_KEEPALIVE;
    await client.query(`SET tcp_keepalives_idle = ${k.idleSeconds}; SET tcp_keepalives_interval = ${k.intervalSeconds}; SET tcp_keepalives_count = ${k.count}`);
    const { rows } = await client.query('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked', [CONSOLE_REPLICA_LOCK_KEY]);
    if (rows[0]?.locked !== true) {
      // Держатель — по имени: оператору нужно знать, живой это процесс или осиротевшая сессия (процедура — deploy/console/README.md)
      const { rows: [h] } = await client.query(
        `SELECT a.pid, a.application_name, host(a.client_addr) AS client_addr, a.backend_start, a.state_change
           FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
          WHERE l.locktype = 'advisory' AND l.granted AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
            AND ((l.classid::bigint << 32) | l.objid::bigint) = hashtextextended($1, 0)`, [CONSOLE_REPLICA_LOCK_KEY]);
      throw new ConsoleAlreadyRunningError(h
        ? `pid ${h.pid}, ${h.application_name || 'no application name'}, from ${h.client_addr ?? 'local socket'}, session since ${new Date(h.backend_start).toISOString()}`
        : 'not visible to this role');
    }
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
    async keepalive() {
      const { rows: [r] } = await client.query(`SELECT current_setting('tcp_keepalives_idle')::int AS idle, current_setting('tcp_keepalives_interval')::int AS interval,
        current_setting('tcp_keepalives_count')::int AS count`);
      return { idle: Number(r!.idle), interval: Number(r!.interval), count: Number(r!.count) };
    },
  };
}
