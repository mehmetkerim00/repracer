import { can, type MemberRole, type PricingAction } from '@repracer/pricing-model';
import type { BulkJobKind, BulkJobRow, BulkJobStatus } from '@repracer/pricing-pipeline';
import { READ_ONLY_JOB_KINDS } from '@repracer/pricing-pipeline/store';
import type { Tone } from './world.ts';
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
  // Включение движка — своё право [Р-143]: оператор включает, но цены не правит
  REPRICING_ENABLE: 'ENABLE_REPRICING',
  // Шаг 35 [Р-152]: остатки ведёт тот, кто ведёт каталог
  STOCK_IMPORT: 'MANAGE_CATALOG',
  STOCK_SYNC_ENABLE: 'MANAGE_CATALOG',
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
  // Шаг 99 [Р-224]: шаблон импорта — выгрузка; примерка — первая половина импорта, как экран различий у правки каталога
  IMPORT_TEMPLATE: 'VIEW_PRICING',
  IMPORT_CHECK: 'MANAGE_PRICING',
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
  statusText: string;
  tone: Tone;
  title: string;
  /** Одна строка про состояние: «применяется, 6 200 из 10 000» или «готово: 10 000 строк» */
  headline: string;
  /** Доля хода, 0…1; null — пока неизвестно, сколько всего */
  progress: number | null;
  /**
   * Шаг 99 (решение владельца): идёт, но хода не видно — применение импорта пишет всё одной транзакцией [Р-134, Р-224], и счёт строк
   * до её конца стоит на нуле. Экран показывает спиннер и идущие секунды, а не «0 из N» на пустой полосе: иначе 30 с выглядят зависанием
   */
  indeterminate: boolean;
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
  // Шаг 99 [Р-224, E]: применение импорта — «N строк применено за X с»; скорость называется числом
  if ((job.result as { importKind?: unknown } | null)?.importKind !== undefined && job.kind !== 'IMPORT_CHECK') {
    return t.doneImport(n(r.applied), Math.round(n(r.durationMs) / 100) / 10);
  }
  switch (job.kind) {
    case 'COST_IMPORT': return t.doneCostImport(n(r.rows), n(r.offers), n(r.skipped));
    case 'BOUNDS_EDIT': return t.doneBounds(n(r.offers), n(r.changed));
    case 'BOUNDS_PLAN': return t.donePlan(n(r.offers));
    case 'STRATEGY_ASSIGN': return t.doneStrategy(n(r.offers), n(r.version));
    case 'STRATEGY_PREVIEW': return t.donePreview(n(r.offers));
    case 'PRICE_FEED_EXPORT': return t.doneFeedExport(n(r.rows), n(r.bytes));
    case 'PRICE_EVIDENCE': return t.doneEvidence(n(r.rows), n(r.bytes));
    case 'REPRICING_ENABLE': return t.doneEnable(n(r.enabled), n(r.already), n(r.skipped));
    case 'STOCK_IMPORT': return m.ui.stock.importFile.result({ matched: n(r.matched), changed: n(r.changed), unmatched: n(r.unmatched), writes: n(r.writes) });
    case 'STOCK_SYNC_ENABLE': return m.ui.stock.enable.done({ scopes: n(r.scopes), created: n(r.created), awaitingAck: n(r.awaitingAck), writes: n(r.writes) });
    case 'IMPORT_TEMPLATE': return t.doneTemplate(n(r.rows));
    case 'IMPORT_CHECK': return t.doneCheck({ total: n(r.total), changed: n(r.changed), rejected: n(r.rejected) });
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
/** Шаг 79: статус задания — пилюлей в семантическом цвете */
const STATUS_TONE: Record<BulkJobStatus, Tone> = { PENDING: 'progress', RUNNING: 'progress', SUCCEEDED: 'ok', FAILED: 'stop', INTERRUPTED: 'warn', CANCELLED: 'off' };

export function bulkJobView(job: BulkJobRow, m: Messages, artifact: { fileName: string; rows: number; sha256: string } | null = null): BulkJobView {
  const t = m.ui.jobs;
  const total = job.totalItems;
  const done = job.doneItems;
  const title = t.kinds[job.kind];
  const abandoned = job.status === 'RUNNING' && job.leaseExpired;
  if (abandoned) job = { ...job, status: 'INTERRUPTED' };
  // Применение импорта ссылается на свою примерку; его запись — одна транзакция, и счёт строк двинется только в её конце
  const oneGo = job.status === 'RUNNING' && job.phase === 'APPLYING' && done === 0 && total !== null && total > 0
    && typeof (job.params as { checkJobId?: unknown } | null)?.checkJobId === 'string';
  const headline = job.status === 'SUCCEEDED' ? outcomeText(job, m)
    : job.status === 'FAILED' ? t.failed(errorTextOf(job, m))
    : job.status === 'PENDING' ? t.queued
    : job.status === 'CANCELLED' ? t.cancelled
    : job.status === 'INTERRUPTED' ? t.interrupted
    : oneGo ? t.applyingInOneGo(total!)
    : job.phase === 'APPLYING' ? t.applying(done, total)
    : job.phase === 'PRODUCING' ? t.producing(done, total)
    : t.preparing(done, total);
  /**
   * Что осталось в базе. Ответ один и тот же на всех незавершённых состояниях, включая прерванное: НИЧЕГО. Применение — одна
   * транзакция [Р-134], упавший процесс её откатывает, а задание возвращается в очередь и начинается заново с первого шага.
   */
  // Шаг 79 (ревью): задание, которое только читает (предпросмотр, экран различий, выгрузки), ничего в базе не меняет — и так и говорит
  const effect = READ_ONLY_JOB_KINDS.includes(job.kind) && job.status !== 'FAILED' && job.status !== 'CANCELLED' ? t.effectReadOnly
    : job.status === 'SUCCEEDED' ? t.effectApplied
    : job.status === 'FAILED' ? t.effectNothing
    : job.status === 'CANCELLED' ? t.effectNothing
    : job.status === 'INTERRUPTED' ? t.effectInterrupted
    : t.effectPending;
  return {
    jobId: job.jobId, kind: job.kind, status: job.status, title, headline,
    statusText: t.statusLabels[job.status], tone: STATUS_TONE[job.status],
    // Шаг 79 (ревью): готовое задание — полоса целиком; у предпросмотра по выборке «сделано» меньше каталога, и «Done» стоял на четверти
    progress: job.status === 'SUCCEEDED' ? 1 : oneGo || total === null || total === 0 ? null : Math.min(1, done / total),
    indeterminate: oneGo,
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
