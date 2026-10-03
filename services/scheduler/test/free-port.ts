import { createServer } from 'node:net';

/**
 * Свободный порт у системы, а не случайное число: полный прогон CI шага 68 покраснел на `EADDRINUSE` — случайный порт метрик из
 * 20 000–40 000 оказался занят соседним процессом раннера. Окно между закрытием и `listen` процесса остаётся, но система не выдаёт
 * один и тот же эфемерный порт подряд, а конфигурация процесса порт 0 не принимает намеренно (в работе порт называют).
 */
export async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => (port > 0 ? resolve(port) : reject(new Error('no free port'))));
    });
  });
}
