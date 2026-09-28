import { createServer, type Server } from 'node:http';
import { createPool, type PgPool } from '@repracer/pricing-store-pg';
import { createHeartbeat, jsonSink, ProcessHealth, serveHealth } from '@repracer/service-runtime';
import { loadDeletionConfig, type DeletionConfig } from './config.ts';
import { createDeletionHandler, type DeletionStore } from './handler.ts';
import { notificationApiKeys, type PublicKeySource } from './verify.ts';

/**
 * Шаг 49 [Р-192]: процесс-приёмник уведомлений eBay Marketplace Account Deletion. До ПЕРВОГО боевого вызова eBay приложение
 * обязано их принимать (E-18): без этого боевой ключ не активируется. Процесс принимает HTTP за общим прокси профиля,
 * проверяет подпись и зовёт одну функцию базы — удаление и его аудит делает база (0142). У роли подключения нет прав ни на одну
 * таблицу [Р-90].
 */

/** Хранилище на PostgreSQL: одна функция, её исполняет только роль приёмника */
export function pgDeletionStore(pool: PgPool): DeletionStore {
  return {
    async delete(notice) {
      const { rows: [r] } = await pool.query('SELECT accounts_deleted, account_ids FROM security.ebay_account_deletion($1, $2, $3::timestamptz, $4)',
        [notice.notificationId, notice.userId, notice.eventDate, notice.publishAttemptCount]);
      return { accounts: Number(r.accounts_deleted), accountIds: [...(r.account_ids as string[])] };
    },
  };
}

export interface DeletionProcess {
  server: Server;
  port: number;
  health: ProcessHealth;
  stop(): Promise<void>;
}

const MAX_BODY = 64 * 1024;

export async function startDeletionProcess(config: DeletionConfig = loadDeletionConfig(), overrides: { keys?: PublicKeySource } = {}): Promise<DeletionProcess> {
  const sink = jsonSink();
  const health = new ProcessHealth();
  const pool: PgPool = createPool(config.pgUrl, { max: 4, applicationName: 'repracer-ebay-account-deletion' });
  const handle = createDeletionHandler({
    endpoint: config.endpoint,
    verificationToken: config.verificationToken,
    keys: overrides.keys ?? notificationApiKeys({ apiBase: config.apiBase, clientId: config.clientId, clientSecret: config.clientSecret }),
    store: pgDeletionStore(pool),
    log: { log: (e) => { health.count(e.code.toLowerCase()); sink.logger.log({ level: e.level === 'ERROR' ? 'ERROR' : e.level, code: e.code, message: e.code, ...(e.details ? { details: e.details } : {}) }); } },
  });
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) { res.writeHead(413).end(); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (res.writableEnded) return;
      const headers: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v[0] : v;
      handle({ method: req.method ?? 'GET', url: req.url ?? '/', headers, body: Buffer.concat(chunks).toString('utf8') })
        // Находка 5 ревью: запрос снаружи (в том числе анонимный GET challenge) живость процесса не продлевает
        .then((r) => { res.writeHead(r.status, r.headers).end(r.body); })
        .catch(() => { res.writeHead(500).end(); });
    });
  });
  await new Promise<void>((resolve) => server.listen(config.port, resolve));
  const port = (server.address() as { port: number }).port;
  health.alive();
  /**
   * Находка 5 ревью шага 49: уведомления редки, поэтому живость — не пришедшее уведомление, а то, что процесс МОЖЕТ исполнить
   * удаление: раз в минуту роль приёмника зовёт базу. Недоступная база (сменённый пароль, сеть) — `/healthz` 503 и отметка
   * «нездоров» [Р-127], а не зелёный процесс, который на каждое уведомление отвечает 500.
   */
  const staleAfterMs = 180_000;
  const healthServer = await serveHealth(health, { port: config.metricsPort, prefix: 'repracer_ebay_deletion', staleAfterMs });
  const heartbeat = config.heartbeatUrl ? createHeartbeat({ url: config.heartbeatUrl }) : null;
  const beat = async () => {
    let ok = false;
    try {
      await pool.query('SELECT 1');
      ok = true;
      health.alive();
    } catch {
      health.count('database_unavailable');
    }
    if (!heartbeat) return;
    try { await heartbeat.beat(ok && health.healthy(staleAfterMs)); } catch { health.count('heartbeat_failed'); }
  };
  await beat();
  const timer = setInterval(() => { void beat(); }, 60_000);
  timer.unref();
  return {
    server, port, health,
    async stop() {
      clearInterval(timer);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await healthServer.close();
      await pool.end();
    },
  };
}

// Запуск процесса: node --experimental-strip-types services/ebay-account-deletion/src/main.ts
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const started = await startDeletionProcess();
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => { void started.stop().then(() => process.exit(0)); });
  }
}
