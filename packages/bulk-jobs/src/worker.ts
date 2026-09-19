import type { StandAccount, StandWorld, Viewer } from '@repracer/console-model';
import type { Instant } from '@repracer/channel-port';
import type { PricingStore } from '@repracer/pricing-pipeline';
import { runNextBulkJob, type BulkJobContext, type BulkJobHandlers, type BulkJobRunnerOptions } from './index.ts';

/**
 * Р-139 (шаг 30): фоновый исполнитель массовых операций. Отдельный процесс, а не поток в сервере экранов: продавец должен
 * получать экран и во время применения, а падение применения не должно ронять консоль.
 *
 * Мир тенанта исполнитель собирает САМ из состояния хранилища: браузера у него нет. Описание мира (какие аккаунты и каналы)
 * приходит извне — это метаданные стенда, не данные продавца.
 */

export interface BulkWorldDescriptor {
  id: string;
  title: string;
  description: string;
  tenantId: string;
  accounts: readonly StandAccount[];
}

/**
 * Зритель фонового процесса. Роль не выдумывается: задание уже создал человек с правом и со вторым фактором, а каждую запись
 * всё равно проверяет база по членству автора [Р-90]. Роль здесь нужна только моделям экранов, которые строит обработчик.
 */
const JOB_VIEWER = (membershipId: string): Viewer => ({ membershipId, role: 'PRICING_MANAGER' });

/** Мир тенанта на момент исполнения задания: состояние хранилища плюс описание мира */
export function bulkWorldReader(store: PricingStore, descriptor: BulkWorldDescriptor, now: () => Instant) {
  return async (ctx: BulkJobContext): Promise<StandWorld> => ({
    id: descriptor.id, title: descriptor.title, description: descriptor.description, tenantId: descriptor.tenantId,
    now: now(), accounts: descriptor.accounts.map((a) => ({ ...a })), viewer: JOB_VIEWER(ctx.membershipId),
    state: await store.readConsoleState(descriptor.tenantId, now() as never),
  });
}

export interface BulkWorkerOptions extends BulkJobRunnerOptions {
  handlers: BulkJobHandlers;
  /** Сколько ждать, когда очередь пуста: опрос очереди, а не уведомление, — очередь тенанта коротка и запрос дёшев */
  idleMs?: number;
  /** Остановка цикла: процесс завершается между заданиями, а не посреди применения */
  stopped?: () => boolean;
  onFinished?(outcome: { jobId: string; kind: string; status: 'SUCCEEDED' | 'FAILED' | 'LEASE_LOST' }): void;
  sleep?(ms: number): Promise<void>;
}

/** Цикл исполнителя: берёт задания по одному, пока не велено остановиться */
export async function runBulkWorker(options: BulkWorkerOptions): Promise<void> {
  const idleMs = options.idleMs ?? 200;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const stopped = options.stopped ?? (() => false);
  while (!stopped()) {
    const done = await runNextBulkJob(options);
    if (done === null) {
      await sleep(idleMs);
      continue;
    }
    options.onFinished?.({ jobId: done.job.jobId, kind: done.job.kind, status: done.status });
  }
}
