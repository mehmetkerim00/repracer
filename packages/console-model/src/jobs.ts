import { can, type MemberRole, type PricingAction } from '@repracer/pricing-model';
import type { BulkJobKind, BulkJobRow, BulkJobStatus } from '@repracer/pricing-pipeline';
import type { Messages } from './i18n/index.ts';

/**
 * Шаг 32, задача D: ЧУЖОЕ задание отменяет тот, кто имеет право на САМУ ЭТУ ОПЕРАЦИЮ, а не тот, у кого есть одно общее право
 * на цены. Это Р-143 с другой стороны: право относится к виду операции — и отмена массового импорта, подтверждённого вторым
 * фактором, не должна стоить столько же, сколько отмена чужой выгрузки, которая ничего не меняет.
 *
 * Перечисление полное по типу: новый вид задания не соберётся, пока не сказано, чьё это право. Это и есть правило [Р-146] —
 * забыть решить нельзя, можно только решить неверно.
 */
export const CANCEL_ACTION: Readonly<Record<BulkJobKind, PricingAction>> = {
  COST_IMPORT: 'MANAGE_PRICING',
  BOUNDS_EDIT: 'MANAGE_PRICING',
  STRATEGY_ASSIGN: 'MANAGE_PRICING',
  /**
   * Экран различий и предпросмотр стратегии САМИ ничего не меняют, но они — первая половина правки цен: применение
   * ссылается на задание экрана различий и без него не проходит. Отменить чужой экран различий значит сорвать чужую правку
   * каталога, поэтому право здесь — право на ту операцию, ради которой задание и создано (находка 4 ревью шага 32).
   */
  BOUNDS_PLAN: 'MANAGE_PRICING',
  STRATEGY_PREVIEW: 'MANAGE_PRICING',
  // А выгрузка не начинает собой ничего: отменить чужую может любой участник — его операция и есть просмотр
  PRICE_EVIDENCE: 'VIEW_PRICING',
  PRICE_FEED_EXPORT: 'VIEW_PRICING',
};

/** СВОЁ задание отменяет любой участник; чужое — по праву на его вид операции */
export function canCancelBulkJob(role: MemberRole, kind: BulkJobKind, own: boolean): boolean {
  return own || can(role, CANCEL_ACTION[kind]);
}

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
  /** Ждёт своей очереди — то есть его ещё можно отменить [OQ-207] */
  cancellable: boolean;
  error: string | null;
  /** Файл, подготовленный заданием, — если он есть [OQ-202] */
  artifact: { fileName: string; rows: number; sha256: string } | null;
  /**
   * То из итога задания, что читает ЭКРАН: посчитанный предпросмотр стратегии или экран различий границ. Остальное остаётся в
   * базе: у плана правки каталога в итоге лежат 10 000 правок (около мегабайта), и отдавать их экрану — а тем более СПИСКУ
   * заданий — значит вернуть ответ, который браузер разбирает секундами (находка 4 ревью шага 31).
   */
  result: { view: unknown } | null;
  startedAt: string | null;
  finishedAt: string | null;
  attempts: number;
}

export interface BulkJobsView {
  items: BulkJobView[];
  /** Идущие задания: экран истории подсвечивает их и обновляется, пока они есть */
  active: number;
}

/** Из итога задания экрану отдаётся только то, что он показывает: сам экран предпросмотра или различий */
function screenResult(job: BulkJobRow): { view: unknown } | null {
  if (job.status !== 'SUCCEEDED') return null;
  const result = job.result as { view?: unknown } | null;
  return result?.view === undefined ? null : { view: result.view };
}

const ACTIVE: ReadonlySet<BulkJobStatus> = new Set<BulkJobStatus>(['PENDING', 'RUNNING', 'INTERRUPTED']);

/**
 * Причина отказа глазами продавца. Неизвестный код — это код БАЗЫ (SQLSTATE) или обработчика: «23505» продавцу ничего не
 * говорит (находка 18 ревью шага 30). Показывается понятная строка, а сам код остаётся в ней для поддержки.
 */
const errorTextOf = (job: BulkJobRow, m: Messages): string => {
  const t = m.ui.jobs;
  const code = job.errorCode ?? '';
  return t.errors[code as keyof typeof t.errors] ?? t.errorUnknown(code);
};

/** Итог задания глазами продавца: числа берутся из результата, который записал обработчик */
function outcomeText(job: BulkJobRow, m: Messages): string {
  const t = m.ui.jobs;
  const r = (job.result ?? {}) as Record<string, number | undefined>;
  const n = (v: number | undefined) => (typeof v === 'number' ? v : 0);
  switch (job.kind) {
    case 'COST_IMPORT': return t.doneCostImport(n(r.rows), n(r.offers), n(r.skipped));
    case 'BOUNDS_EDIT': return t.doneBounds(n(r.offers), n(r.changed));
    case 'BOUNDS_PLAN': return t.donePlan(n(r.offers));
    case 'STRATEGY_ASSIGN': return t.doneStrategy(n(r.offers), n(r.version));
    case 'STRATEGY_PREVIEW': return t.donePreview(n(r.offers));
    case 'PRICE_FEED_EXPORT': return t.doneFeedExport(n(r.rows), n(r.bytes));
    case 'PRICE_EVIDENCE': return t.doneEvidence(n(r.rows), n(r.bytes));
  }
}

/**
 * Задание с истёкшей арендой — это УПАВШИЙ процесс. Строку «прервано» он записать не успел: его убили. Поэтому экран смотрит
 * не только на состояние, но и на срок аренды — иначе продавец видел бы «применяется» до тех пор, пока задание не подберёт
 * другой процесс, и не понял бы, почему счётчик стоит.
 *
 * Истекла ли аренда, решает ХРАНИЛИЩЕ по часам базы (`leaseExpired`): у экрана свои часы, и их расхождение с базой показывало
 * бы идущее применение как прерванное или наоборот (находка 11 ревью шага 30).
 */
export function bulkJobView(job: BulkJobRow, m: Messages, artifact: { fileName: string; rows: number; sha256: string } | null = null): BulkJobView {
  const t = m.ui.jobs;
  const total = job.totalItems;
  const done = job.doneItems;
  const title = t.kinds[job.kind];
  const abandoned = job.status === 'RUNNING' && job.leaseExpired;
  if (abandoned) job = { ...job, status: 'INTERRUPTED' };
  const headline = job.status === 'SUCCEEDED' ? outcomeText(job, m)
    : job.status === 'FAILED' ? t.failed(errorTextOf(job, m))
    : job.status === 'PENDING' ? t.queued
    : job.status === 'CANCELLED' ? t.cancelled
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
    : job.status === 'CANCELLED' ? t.effectNothing
    : job.status === 'INTERRUPTED' ? t.effectInterrupted
    : t.effectPending;
  return {
    jobId: job.jobId, kind: job.kind, status: job.status, title, headline,
    progress: total === null || total === 0 ? null : Math.min(1, done / total),
    done, total, effect, active: ACTIVE.has(job.status), cancellable: job.status === 'PENDING',
    error: job.status === 'FAILED' ? errorTextOf(job, m) : null,
    artifact, result: screenResult(job),
    startedAt: job.startedAt, finishedAt: job.finishedAt, attempts: job.attempts,
  };
}

/**
 * История заданий тенанта: только его собственные — список приходит из хранилища под его `tenant_id` [Р-16]. Итог заданий в
 * список НЕ входит вовсе: двадцать предпросмотров каталога дали бы ответ в десятки мегабайт (находка 4 ревью шага 31).
 * Готовый файл назван — по нему продавец и возвращается к заданию, с которого ушёл.
 */
export function bulkJobsView(jobs: readonly BulkJobRow[], m: Messages,
  artifacts: ReadonlyMap<string, { fileName: string; rows: number; sha256: string }> = new Map()): BulkJobsView {
  const items = jobs.map((j) => ({ ...bulkJobView(j, m, artifacts.get(j.jobId) ?? null), result: null }));
  return { items, active: items.filter((i) => i.active).length };
}
