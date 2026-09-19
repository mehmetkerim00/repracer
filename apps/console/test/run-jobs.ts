import { runNextBulkJob } from '@repracer/bulk-jobs';
import { bulkJobHandlers } from '@repracer/bulk-jobs/handlers';
import { bulkJobView, type BulkJobView } from '@repracer/console-model';
import { messagesFor } from '@repracer/console-model';
import type { LiveWorld } from '@repracer/contract-tests/stand';

/**
 * Р-139 (шаг 30): в тестах фоновый исполнитель зовётся явно. Так видно, ЧТО именно он делает, и так же явно проверяется, что
 * до его работы в базе ничего не изменилось: массовая операция — задание, а не мгновенный ответ.
 *
 * В живом прогоне и на стенде исполнитель — отдельный процесс (`apps/console/server/bulk-worker.ts`); здесь тот же обработчик
 * зовётся из теста, чтобы шаг задания был точкой, между которой можно смотреть на базу.
 */
export function handlersFor(live: LiveWorld) {
  return bulkJobHandlers({ world: async (ctx) => live.view({ membershipId: ctx.membershipId, role: 'PRICING_MANAGER' }) });
}

/** Выполнить все ожидающие задания тенанта; возвращает их число */
export async function runPendingJobs(live: LiveWorld, owner = 'test-bulk-worker'): Promise<number> {
  const handlers = handlersFor(live);
  let done = 0;
  while (await runNextBulkJob({ store: live.store, tenantId: live.tenantId, owner, handlers }) !== null) done += 1;
  return done;
}

/** Выполнить ожидающие задания и вернуть итог последнего названного */
export async function runJob(live: LiveWorld, jobId: string, locale: 'de' | 'en' = 'de'): Promise<BulkJobView> {
  await runPendingJobs(live);
  const job = await live.store.bulkJob(live.tenantId, jobId);
  if (!job) throw new Error(`bulk job ${jobId} not found`);
  const artifact = await live.store.bulkJobArtifact(live.tenantId, jobId);
  return bulkJobView(job, messagesFor(locale), artifact ? { fileName: artifact.fileName, rows: artifact.rows, sha256: artifact.sha256 } : null);
}
