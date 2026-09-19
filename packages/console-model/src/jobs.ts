import type { BulkJobKind, BulkJobRow, BulkJobStatus } from '@repracer/pricing-pipeline';
import type { Messages } from './i18n/index.ts';

/**
 * Р-139 (шаг 30): экран массовой операции. Продавец нажал «применить» — и дальше смотрит на ХОД, а не на крутящийся индикатор
 * в ожидании ответа. Состояние задания в базе, поэтому перезагрузка страницы ничего не теряет: экран собирается из того же
 * запроса, что и после возвращения через час.
 *
 * Экран обязан ответить на три вопроса: что происходит, сколько осталось и что осталось в базе, если процесс упал.
 */

export interface BulkJobView {
  jobId: string;
  kind: BulkJobKind;
  status: BulkJobStatus;
  title: string;
  /** Одна строка про состояние: «применяется, 6 200 из 10 000» или «готово: 10 000 строк» */
  headline: string;
  /** Доля хода, 0…1; null — пока неизвестно, сколько всего */
  progress: number | null;
  done: number;
  total: number | null;
  /** Что стало с данными: пока задание не завершилось успехом, в базе НИЧЕГО не изменено [Р-134] */
  effect: string;
  /** Идёт ли ещё: экран сам решает, обновляться ли дальше */
  active: boolean;
  error: string | null;
  /** Файл, подготовленный заданием, — если он есть [OQ-202] */
  artifact: { fileName: string; rows: number; sha256: string } | null;
  /** Итог задания как данные — например, посчитанный предпросмотр стратегии [OQ-201]; у незавершённого его нет */
  result: unknown;
  startedAt: string | null;
  finishedAt: string | null;
  attempts: number;
}

export interface BulkJobsView {
  items: BulkJobView[];
  /** Идущие задания: экран истории подсвечивает их и обновляется, пока они есть */
  active: number;
}

const ACTIVE: ReadonlySet<BulkJobStatus> = new Set<BulkJobStatus>(['PENDING', 'RUNNING', 'INTERRUPTED']);

/** Итог задания глазами продавца: числа берутся из результата, который записал обработчик */
function outcomeText(job: BulkJobRow, m: Messages): string {
  const t = m.ui.jobs;
  const r = (job.result ?? {}) as Record<string, number | undefined>;
  const n = (v: number | undefined) => (typeof v === 'number' ? v : 0);
  switch (job.kind) {
    case 'COST_IMPORT': return t.doneCostImport(n(r.rows), n(r.offers), n(r.skipped));
    case 'BOUNDS_EDIT': return t.doneBounds(n(r.offers), n(r.changed));
    case 'STRATEGY_ASSIGN': return t.doneStrategy(n(r.offers), n(r.version));
    case 'STRATEGY_PREVIEW': return t.donePreview(n(r.offers));
    case 'PRICE_EVIDENCE': return t.doneEvidence(n(r.rows), n(r.bytes));
  }
}

/**
 * Задание с истёкшей арендой — это УПАВШИЙ процесс. Строку «прервано» он записать не успел: его убили. Поэтому экран смотрит
 * не только на состояние, но и на срок аренды — иначе продавец видел бы «применяется» до тех пор, пока задание не подберёт
 * другой процесс, и не понял бы, почему счётчик стоит.
 *
 * Время здесь настоящее: срок аренды база пишет своим `now()`. Значение передаётся явно, чтобы у проверки не было скрытого входа.
 */
export function bulkJobView(job: BulkJobRow, m: Messages, artifact: { fileName: string; rows: number; sha256: string } | null = null,
  nowMs: number = Date.now()): BulkJobView {
  const t = m.ui.jobs;
  const total = job.totalItems;
  const done = job.doneItems;
  const title = t.kinds[job.kind];
  const abandoned = job.status === 'RUNNING' && job.leaseUntil !== null && Date.parse(job.leaseUntil) <= nowMs;
  if (abandoned) job = { ...job, status: 'INTERRUPTED' };
  const headline = job.status === 'SUCCEEDED' ? outcomeText(job, m)
    : job.status === 'FAILED' ? t.failed(t.errors[job.errorCode as keyof typeof t.errors] ?? job.errorCode ?? t.errorUnknown)
    : job.status === 'PENDING' ? t.queued
    : job.status === 'INTERRUPTED' ? t.interrupted
    : job.phase === 'APPLYING' ? t.applying(done, total)
    : job.phase === 'PRODUCING' ? t.producing(done, total)
    : t.preparing(done, total);
  /**
   * Что осталось в базе. Ответ один и тот же на всех незавершённых состояниях, включая прерванное: НИЧЕГО. Применение — одна
   * транзакция [Р-134], упавший процесс её откатывает, а задание возвращается в очередь и начинается заново с первого шага.
   */
  const effect = job.status === 'SUCCEEDED' ? t.effectApplied
    : job.status === 'FAILED' ? t.effectNothing
    : job.status === 'INTERRUPTED' ? t.effectInterrupted
    : t.effectPending;
  return {
    jobId: job.jobId, kind: job.kind, status: job.status, title, headline,
    progress: total === null || total === 0 ? null : Math.min(1, done / total),
    done, total, effect, active: ACTIVE.has(job.status),
    error: job.status === 'FAILED' ? (t.errors[job.errorCode as keyof typeof t.errors] ?? job.errorCode ?? t.errorUnknown) : null,
    artifact, result: job.status === 'SUCCEEDED' ? job.result : null,
    startedAt: job.startedAt, finishedAt: job.finishedAt, attempts: job.attempts,
  };
}

/** История заданий тенанта: только его собственные — список приходит из хранилища под его `tenant_id` [Р-16] */
export function bulkJobsView(jobs: readonly BulkJobRow[], m: Messages): BulkJobsView {
  const items = jobs.map((j) => bulkJobView(j, m));
  return { items, active: items.filter((i) => i.active).length };
}
