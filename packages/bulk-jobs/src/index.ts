import { createHash } from 'node:crypto';
import type { BulkJobKind, BulkJobPhase, BulkJobRow, PricingStore } from '@repracer/pricing-pipeline';

/**
 * Р-139 (шаг 30): массовые операции продавца выполняет фоновый исполнитель. Синхронный запрос на 10 000 предложений занимал
 * 19 секунд на раннере CI и упрётся в таймаут прокси на медленной базе: продавец увидит ошибку при том, что изменения прошли.
 *
 * Что обязан обеспечить исполнитель:
 * 1. **Ход виден.** Он пишется ОТДЕЛЬНОЙ транзакцией, поэтому переживает откат самой работы и виден, пока идёт применение.
 * 2. **Целиком или никак** [Р-134]. Применение — одна транзакция хранилища; упавший процесс не оставляет половины.
 * 3. **Переживает падение.** Аренда задания истекает, задание возвращается в очередь и берётся снова — с первого шага.
 * 4. **Задание принадлежит тенанту**: исполнитель работает по одному тенанту за раз и читает только его очередь (RLS).
 */

export interface BulkJobWork {
  /** Сколько единиц предстоит обработать — чтобы ход был числом, а не «идёт» */
  total: number;
  /** Сама работа: одна транзакция хранилища. `progress` пишется отдельным соединением */
  run(progress: (done: number, phase?: BulkJobPhase) => Promise<void>): Promise<Record<string, unknown>>;
}

/** Что задание умеет делать: вид → подготовка работы по параметрам, сохранённым при создании */
export type BulkJobHandlers = {
  [K in BulkJobKind]?: (job: BulkJobRow, ctx: BulkJobContext) => Promise<BulkJobWork>;
};

export interface BulkJobContext {
  tenantId: string;
  store: PricingStore;
  /** Задание называет себя базе: стражи массового изменения принимают второй фактор, предъявленный при его создании */
  jobId: string;
  /** Участник, создавший задание: его именем пишутся версии цен [Р-97] */
  membershipId: string;
  userId: string;
}

export interface BulkJobRunnerOptions {
  store: PricingStore;
  tenantId: string;
  /** Имя процесса в аренде: по нему видно, кто держит задание */
  owner: string;
  handlers: BulkJobHandlers;
  /** Аренда: истекла — задание считается брошенным и берётся другим процессом */
  leaseSeconds?: number;
  /** Как часто обновлять ход: чаще — больше запросов, реже — продавец видит замерший счётчик */
  progressEverySeconds?: number;
  now?: () => number;
}

export const DEFAULT_LEASE_SECONDS = 60;

/** Один шаг исполнителя: взять задание, выполнить, записать итог. Возвращает выполненное задание или null, если очередь пуста */
export async function runNextBulkJob(options: BulkJobRunnerOptions): Promise<{ job: BulkJobRow; status: 'SUCCEEDED' | 'FAILED' } | null> {
  const { store, tenantId, owner, handlers } = options;
  const leaseSeconds = options.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
  const job = await store.claimBulkJob(tenantId, owner, leaseSeconds);
  if (!job) return null;
  const handler = handlers[job.kind];
  if (!handler) {
    await store.finishBulkJob(tenantId, job.jobId, owner, { status: 'FAILED', errorCode: 'UNKNOWN_JOB_KIND' });
    return { job, status: 'FAILED' };
  }
  try {
    // Автор — человек, создавший задание: процесс пишет его именем, а не объявляет автором себя [Р-97]
    const work = await handler(job, { tenantId, store, jobId: job.jobId, membershipId: job.createdByMembershipId, userId: job.createdByUserId });
    await store.updateBulkJobProgress(tenantId, job.jobId, owner, { phase: 'PREPARING', done: 0, total: work.total, leaseSeconds });
    const now = options.now ?? (() => Date.now());
    let lastAt = 0;
    const everyMs = (options.progressEverySeconds ?? 1) * 1000;
    const progress = async (done: number, phase?: BulkJobPhase) => {
      // Ход пишется не чаще, чем раз в progressEverySeconds: иначе на 10 000 строк это 10 000 запросов
      if (now() - lastAt < everyMs && done !== work.total) return;
      lastAt = now();
      await store.updateBulkJobProgress(tenantId, job.jobId, owner, { ...(phase ? { phase } : {}), done, total: work.total, leaseSeconds });
    };
    /**
     * Аренда продлевается, ПОКА идёт работа. Само применение — одна транзакция [Р-134] на весь каталог: внутри неё ход не
     * пишется, и аренда истекла бы посреди неё. Последствия были бы двумя: задание подобрал бы второй процесс и применил
     * второй раз, а база перестала бы принимать второй фактор задания (`security.second_factor_present` требует живой аренды) —
     * применение отказало бы «нет второго фактора» в середине работы. Продление идёт ОТДЕЛЬНЫМ соединением, поэтому переживает
     * транзакцию работы.
     */
    const beat = setInterval(() => {
      void store.updateBulkJobProgress(tenantId, job.jobId, owner, { leaseSeconds }).catch(() => undefined);
    }, Math.max(500, Math.floor((leaseSeconds * 1000) / 3)));
    let result: Record<string, unknown>;
    try {
      result = await work.run(progress);
    } finally {
      clearInterval(beat);
    }
    await store.finishBulkJob(tenantId, job.jobId, owner, { status: 'SUCCEEDED', result });
    return { job, status: 'SUCCEEDED' };
  } catch (error) {
    const code = errorCodeOf(error);
    await store.finishBulkJob(tenantId, job.jobId, owner, { status: 'FAILED', errorCode: code });
    return { job, status: 'FAILED' };
  }
}

/** Причина отказа задания: код, понятный экрану; текст ошибки в задание не попадает — в нём могут быть данные */
function errorCodeOf(error: unknown): string {
  const e = error as { code?: string; cause?: string };
  if (typeof e?.cause === 'string') return e.cause.slice(0, 60);
  if (typeof e?.code === 'string') return e.code.slice(0, 60);
  return 'JOB_FAILED';
}

/** Контрольная сумма файла задания: продавец сверяет её с файлом, который скачал [Р-123] */
export const sha256 = (content: string): string => createHash('sha256').update(content).digest('hex');
