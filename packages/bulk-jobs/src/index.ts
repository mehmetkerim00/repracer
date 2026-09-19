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
  /** Аренду отобрали, пока шла работа: процесс мог записать в базу то, о чём задание не знает [находка 3 ревью шага 30] */
  onLeaseLost?(lost: { jobId: string; kind: BulkJobKind; owner: string }): void;
}

export const DEFAULT_LEASE_SECONDS = 60;
/** Сколько раз задание берётся заново, прежде чем объявляется неисполнимым (находка 8 ревью шага 30) */
export const MAX_ATTEMPTS = 5;

/**
 * Один шаг исполнителя: взять задание, выполнить, записать итог. Возвращает выполненное задание или null, если очередь пуста.
 * `LEASE_LOST` — итог не записан, потому что аренду отобрали: работа могла дойти до базы, и об этом надо сказать наружу.
 */
export async function runNextBulkJob(options: BulkJobRunnerOptions): Promise<{ job: BulkJobRow; status: 'SUCCEEDED' | 'FAILED' | 'LEASE_LOST' } | null> {
  const { store, tenantId, owner, handlers } = options;
  const leaseSeconds = options.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
  const job = await store.claimBulkJob(tenantId, owner, leaseSeconds);
  if (job === null) return null;
  /**
   * Аренда продлевается с МОМЕНТА ВЗЯТИЯ, а не с начала работы (находка 2 ревью шага 30). Подготовка — тоже работа: разбор
   * файла в 200 000 строк занимает секунды, и аренда истекала бы ещё до первой записи хода. Тогда задание брал бы второй
   * процесс, и оба применяли бы один и тот же импорт: ключа идемпотентности у него нет.
   *
   * Продление идёт ОТДЕЛЬНЫМ соединением, поэтому переживает транзакцию применения — внутри неё ход не пишется вовсе.
   */
  let leaseLost = false;
  const beat = setInterval(() => {
    void store.updateBulkJobProgress(tenantId, job.jobId, owner, { leaseSeconds })
      .then((kept) => { if (kept === false) leaseLost = true; })
      .catch(() => { /* сетевой сбой продления — не потеря аренды: следующий удар покажет правду */ });
  }, Math.max(500, Math.floor((leaseSeconds * 1000) / 3)));

  try {
    /**
     * Задание, которое роняет процесс, не берётся вечно (находка 8 ревью шага 30). Без предела оно блокировало бы ВСЕ массовые
     * операции тенанта: очередь одна и строго по времени создания. Предел назван числом попыток, а не временем: причина —
     * повторяемая, а не преходящая.
     */
    if (job.attempts > MAX_ATTEMPTS) {
      await store.finishBulkJob(tenantId, job.jobId, owner, { status: 'FAILED', errorCode: 'TOO_MANY_ATTEMPTS' });
      return { job, status: 'FAILED' };
    }
    const handler = handlers[job.kind];
    if (!handler) {
      await store.finishBulkJob(tenantId, job.jobId, owner, { status: 'FAILED', errorCode: 'UNKNOWN_JOB_KIND' });
      return { job, status: 'FAILED' };
    }
    // Автор — человек, создавший задание: процесс пишет его именем, а не объявляет автором себя [Р-97]
    const work = await handler(job, { tenantId, store, jobId: job.jobId, membershipId: job.createdByMembershipId, userId: job.createdByUserId });
    await store.updateBulkJobProgress(tenantId, job.jobId, owner, { phase: 'PREPARING', done: 0, total: work.total, leaseSeconds });
    const now = options.now ?? (() => Date.now());
    let lastAt = 0;
    const everyMs = (options.progressEverySeconds ?? 1) * 1000;
    const progress = async (done: number, phase?: BulkJobPhase) => {
      /**
       * Шаг 31: сообщение о ходе ОТДАЁТ ЦИКЛ СОБЫТИЙ. Сборка файла — работа процессора в одном потоке: пока она идёт, таймер
       * продления аренды сработать не может, аренда истекает, задание подбирает другой процесс — и так по кругу. Так и вышло с
       * выгрузкой доказательства: 27 МБ строки собирались дольше аренды, и задание не заканчивалось никогда.
       *
       * Поэтому обработчик, занятый счётом, обязан звать `progress`, а `progress` — отпускать поток. Запись хода при этом
       * по-прежнему не чаще, чем раз в progressEverySeconds.
       */
      await new Promise((resolve) => setImmediate(resolve));
      if (now() - lastAt < everyMs && done !== work.total) return;
      lastAt = now();
      const kept = await store.updateBulkJobProgress(tenantId, job.jobId, owner, { ...(phase ? { phase } : {}), done, total: work.total, leaseSeconds });
      if (kept === false) leaseLost = true;
    };
    const result = await work.run(progress);
    const finished = await store.finishBulkJob(tenantId, job.jobId, owner, { status: 'SUCCEEDED', result });
    /**
     * Итог не записался — значит аренду отобрали, пока шла работа (находка 3 ревью шага 30). Молчать нельзя: процесс СДЕЛАЛ
     * запись в базу, а задание об этом не знает и будет выполнено ещё раз. Исполнитель обязан сказать об этом наружу.
     */
    if (finished === false || leaseLost) {
      options.onLeaseLost?.({ jobId: job.jobId, kind: job.kind, owner });
      return { job, status: 'LEASE_LOST' };
    }
    return { job, status: 'SUCCEEDED' };
  } catch (error) {
    const code = errorCodeOf(error);
    const finished = await store.finishBulkJob(tenantId, job.jobId, owner, { status: 'FAILED', errorCode: code });
    if (finished === false) {
      options.onLeaseLost?.({ jobId: job.jobId, kind: job.kind, owner });
      return { job, status: 'LEASE_LOST' };
    }
    return { job, status: 'FAILED' };
  } finally {
    clearInterval(beat);
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
