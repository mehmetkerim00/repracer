import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acquireConsoleReplicaLock, CONSOLE_REPLICA_LOCK_KEY } from '../server/single-replica.ts';

/**
 * Шаг 175.2: полный прогон шага 175 покраснел тестом шага 64 «перезапуск консоли на той же базе» — `CONSOLE_ALREADY_RUNNING`, «holder: not visible
 * to this role». `release()` закрывал соединение блокировки (`client.release(true)`) и возвращался, не дожидаясь, пока сервер базы завершит
 * сессию: новая консоль, стартовавшая следом, успевала увидеть ещё не снятую блокировку, а к запросу о держателе сессии уже не было. Теперь
 * `release()` снимает блокировку запросом и ждёт ответа базы — и только потом закрывает соединение: когда `close()` консоли вернулся,
 * блокировка свободна. Проверка детерминированная: журнал обращений к соединению, без гонки
 */
test('step 175.2: releasing the single-replica lock frees it in the database before it returns — a restart right after close never sees the old lock', async () => {
  const log: string[] = [];
  let unlocked = false;
  const client = {
    on: () => undefined,
    query: async (sql: string, params?: unknown[]) => {
      if (/pg_try_advisory_lock/.test(sql)) { log.push('lock'); return { rows: [{ locked: true }] }; }
      if (/pg_advisory_unlock/.test(sql)) {
        assert.deepEqual(params, [CONSOLE_REPLICA_LOCK_KEY], 'the unlock names the same key');
        await new Promise((resolve) => setTimeout(resolve, 20));
        unlocked = true;
        log.push('unlocked');
        return { rows: [{ pg_advisory_unlock: true }] };
      }
      log.push('set');
      return { rows: [] };
    },
    release: (destroy?: boolean) => { log.push(destroy ? 'destroyed' : 'returned'); },
  };
  const lock = await acquireConsoleReplicaLock({ connect: async () => client } as never, () => undefined);
  await lock.release();
  assert.ok(unlocked, `the lock is released in the database before release() returns: ${log.join(' → ')}`);
  assert.deepEqual(log, ['set', 'lock', 'unlocked', 'destroyed'], 'unlock first, then the connection is closed');
  await lock.release();
  assert.deepEqual(log, ['set', 'lock', 'unlocked', 'destroyed'], 'a second release does nothing');
});

test('step 175.2: a failed unlock still closes the connection — the session and its lock go away with it', async () => {
  const log: string[] = [];
  const client = {
    on: () => undefined,
    query: async (sql: string) => {
      if (/pg_try_advisory_lock/.test(sql)) return { rows: [{ locked: true }] };
      if (/pg_advisory_unlock/.test(sql)) { log.push('unlock failed'); throw new Error('connection lost'); }
      return { rows: [] };
    },
    release: (destroy?: boolean) => { log.push(destroy ? 'destroyed' : 'returned'); },
  };
  const lock = await acquireConsoleReplicaLock({ connect: async () => client } as never, () => undefined);
  await lock.release();
  assert.deepEqual(log, ['unlock failed', 'destroyed']);
});
