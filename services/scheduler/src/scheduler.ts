import type { AlertSink, Instant } from '@repracer/channel-port';
import { LeaseLostError, type CatchUp, type JobScope, type JobState, type LagLevel, type RetryKind, type RunRecord, type SchedulerStateStore } from './state.ts';

/**
 * Р-126 (шаг 25): процесс-планировщик. Каждый такт:
 *  1. источник работ называет работы на сейчас (глобальные и по аккаунтам) — они появляются в состоянии;
 *  2. каждая работа, срок которой наступил, занимается арендой (одна на все процессы планировщика) и выполняется; EVERY_SLOT-работа
 *     выполняет пропущенные слоты по очереди до maxSlotsPerTick за такт, LATEST — один запуск за все пропущенные;
 *  3. срок сдвигается только после успеха: провал оставляет тот же слот, он повторяется следующим тактом, после
 *     failureAlertAfter провалов подряд — CRITICAL-алерт;
 *  4. отставание каждой работы (сейчас − срок, но не раньше регистрации работы) сравнивается с её порогами — WARNING и CRITICAL, алерт при
 *     смене уровня; уровень хранится в хранилище — перезапуск и второй процесс алерт не повторяют (риск 31, шаг 26);
 *  5. каждый запуск — строка журнала: слот, начало, конец, итог, отставание, число обработанных объектов.
 * Шаг 26 (проверка в живом режиме, Р-128): LATEST-работа не начинается раньше интервала после предыдущего начала — вызовы с лимитом канала
 * (getCompetitiveSummary 0.033 rps) не сближаются тактами; такт сообщает ближайший срок, процесс просыпается к нему.
 */

export interface JobRunContext {
  /** Слот, который выполняется: для EVERY_SLOT — конкретный пропущенный слот, для LATEST — самый ранний из пропущенных */
  slotAt: Instant;
  now: Instant;
  /** Число успешных запусков до этого — окно сверки по кругу [Р-121] */
  runIndex: number;
  scope: JobScope | null;
  /** Шаг 35: конец предыдущего успешного или неуспешного запуска — окно «с прошлого раза» для работ, читающих канал за период */
  previousFinishedAt: Instant | null;
  /** Момент начала запуска: сроки вызовов каналов считаются от него, а не от начала такта (ревью шага 25, находка 1) */
  startedAt: Instant;
}

export interface JobSpec {
  name: string;
  scope: JobScope | null;
  intervalSeconds: number;
  catchUp: CatchUp;
  /** Р-133: куда работа ходит — в канал с лимитами (CHANNEL) или только в наши хранилища (INTERNAL); от этого зависит пауза повтора */
  retryKind: RetryKind;
  /** Первый слот новой работы */
  firstDueAt(now: Instant): Instant;
  /** Отставание, после которого — WARNING и CRITICAL, секунды */
  lagWarningSeconds: number;
  lagCriticalSeconds: number;
  leaseSeconds: number;
  run(ctx: JobRunContext): Promise<{ items: number; alerts?: Array<{ code: string; severity: 'WARNING' | 'CRITICAL'; details: Record<string, string | number | boolean | null> }> }>;
}

export interface JobSource {
  jobs(now: Instant): Promise<JobSpec[]>;
}

export interface SchedulerOptions {
  state: SchedulerStateStore;
  source: JobSource;
  owner: string;
  /** Часы сроков. Процесс — часы базы (риск 31); тесты — виртуальные часы */
  now: () => Instant | Promise<Instant>;
  alerts: AlertSink;
  maxSlotsPerTick?: number;
  failureAlertAfter?: number;
}

export interface TickReport {
  now: Instant;
  runs: RunRecord[];
  lagging: Array<{ jobKey: string; lagSeconds: number; level: 'WARNING' | 'CRITICAL' }>;
  skippedLeased: string[];
  lostLeases: string[];
  /** Ближайший срок действующих работ после такта — когда процессу проснуться */
  nextDueAt: Instant | null;
}

export const jobKeyOf = (name: string, scope: JobScope | null) => (scope ? `${name}:${scope.tenantId}:${scope.channelAccountId}` : name);

/** Ближайший слот после момента для LATEST: срок + k интервалов > now; k − 1 — схлопнутые слоты */
/**
 * Р-132 (шаг 27) и Р-133 (шаг 28): провалившаяся работа сохраняет слот (пропуск не теряется), но повторяется с растущей паузой, а не
 * каждый такт. Насколько растущей — зависит от того, куда работа ходит:
 *   CHANNEL — в канал с лимитами: пауза не короче периода самой работы, потолок — сутки. Лежащий канал не получает запрос в минуту;
 *   INTERNAL — только в наши хранилища: пауза от минуты до часа. Иначе отказ аналитического слоя на четверть часа стоил бы суток
 *   истории снимков, потому что повтор суточной работы ушёл бы на следующие сутки (живой прогон шага 27, OQ-193).
 */
export const RETRY_BACKOFF_CAP_SECONDS = 86_400;
export const INTERNAL_RETRY_BASE_SECONDS = 60;
export const INTERNAL_RETRY_CAP_SECONDS = 3_600;

export function retryDelaySeconds(intervalSeconds: number, consecutiveFailures: number, retryKind: RetryKind = 'CHANNEL'): number {
  const doublings = Math.max(0, Math.min(consecutiveFailures - 1, 20));
  if (retryKind === 'INTERNAL') return Math.min(INTERNAL_RETRY_BASE_SECONDS * 2 ** doublings, INTERNAL_RETRY_CAP_SECONDS);
  return Math.min(intervalSeconds * 2 ** doublings, RETRY_BACKOFF_CAP_SECONDS);
}

export function dueOf(j: JobState): Instant {
  if (j.lastOutcome !== 'FAILED' || !j.lastFinishedAt) return j.nextDueAt;
  const retry = Date.parse(j.lastFinishedAt) + retryDelaySeconds(j.intervalSeconds, j.consecutiveFailures, j.retryKind) * 1000;
  return retry > Date.parse(j.nextDueAt) ? new Date(retry).toISOString() : j.nextDueAt;
}

/** LATEST: следующий запуск — не раньше интервала после начала этого (такт позже слота сдвигает и следующий) */
function spaced(next: { nextDueAt: Instant; coalesced: number }, startedAt: Instant, intervalSeconds: number) {
  const earliest = Date.parse(startedAt) + intervalSeconds * 1000;
  return Date.parse(next.nextDueAt) >= earliest ? next : { nextDueAt: new Date(earliest).toISOString(), coalesced: next.coalesced };
}

export function nextSlotAfter(slot: Instant, now: Instant, intervalSeconds: number): { nextDueAt: Instant; coalesced: number } {
  const step = intervalSeconds * 1000;
  const k = Math.max(1, Math.floor((Date.parse(now) - Date.parse(slot)) / step) + 1);
  return { nextDueAt: new Date(Date.parse(slot) + k * step).toISOString(), coalesced: k - 1 };
}

const code = (error: unknown) => {
  const m = String((error as Error)?.message ?? error);
  return (/^([A-Z][A-Z0-9_]{2,})\b/.exec(m)?.[1] ?? 'JOB_FAILED');
};

export function createScheduler(options: SchedulerOptions) {
  const { state, source, owner, alerts } = options;
  const maxSlots = options.maxSlotsPerTick ?? 24;
  const failureAlertAfter = options.failureAlertAfter ?? 3;
  const clock = async () => options.now();

  async function runOne(spec: JobSpec, claimed: JobState, now: Instant): Promise<{ run: RunRecord; succeeded: boolean }> {
    const startedAt = await clock();
    let outcome: RunRecord['outcome'] = 'SUCCEEDED';
    let items: number | null = null;
    let errorCode: string | null = null;
    let error: string | null = null;
    // Долгий запуск продлевает аренду каждую треть её срока: второй процесс не начнёт ту же работу (ревью шага 25, находка 6)
    const heartbeat = setInterval(() => { void state.renew(claimed.jobKey, owner, spec.leaseSeconds).catch(() => false); }, Math.max(200, (spec.leaseSeconds * 1000) / 3));
    try {
      const r = await spec.run({ slotAt: claimed.nextDueAt, now, runIndex: claimed.runsCompleted, scope: spec.scope, startedAt, previousFinishedAt: claimed.lastFinishedAt });
      items = r.items;
      for (const a of r.alerts ?? []) await alerts.raise({ ...a, details: { job: claimed.jobKey, ...a.details } });
    } catch (e) {
      outcome = 'FAILED';
      errorCode = code(e);
      // Текст ошибки — без тела запросов и секретов: только первые 300 символов сообщения
      error = String((e as Error)?.message ?? e).slice(0, 300);
    } finally {
      clearInterval(heartbeat);
    }
    const finishedAt = await clock();
    const next = outcome === 'SUCCEEDED'
      ? spec.catchUp === 'EVERY_SLOT'
        ? { nextDueAt: new Date(Date.parse(claimed.nextDueAt) + spec.intervalSeconds * 1000).toISOString(), coalesced: 0 }
        : spaced(nextSlotAfter(claimed.nextDueAt, now, spec.intervalSeconds), startedAt, spec.intervalSeconds)
      : { nextDueAt: claimed.nextDueAt, coalesced: 0 };
    const run: RunRecord = {
      jobKey: claimed.jobKey, jobName: spec.name, slotAt: claimed.nextDueAt, owner, startedAt, finishedAt, outcome,
      lagSeconds: Math.max(0, (Date.parse(startedAt) - Date.parse(claimed.nextDueAt)) / 1000), items, errorCode,
    };
    await state.finish(claimed.jobKey, owner, { outcome, nextDueAt: next.nextDueAt, coalesced: next.coalesced, error, run });
    // Алерт — один раз на серию провалов, а не на каждый последующий: иначе постоянный отказ канала даёт CRITICAL каждую минуту
    // (ревью шага 26, находка 9б)
    if (outcome === 'FAILED' && claimed.consecutiveFailures + 1 === failureAlertAfter) {
      await alerts.raise({ code: 'SCHEDULER_JOB_FAILING', severity: 'CRITICAL', details: { job: claimed.jobKey, failures: claimed.consecutiveFailures + 1, error: errorCode ?? 'JOB_FAILED' } });
    }
    return { run, succeeded: outcome === 'SUCCEEDED' };
  }

  return {
    async tick(): Promise<TickReport> {
      const now = await clock();
      const specs = await source.jobs(now);
      const byKey = new Map<string, JobSpec>();
      for (const spec of specs) {
        const jobKey = jobKeyOf(spec.name, spec.scope);
        byKey.set(jobKey, spec);
        await state.ensure({ jobKey, jobName: spec.name, scope: spec.scope, catchUp: spec.catchUp, retryKind: spec.retryKind, intervalSeconds: spec.intervalSeconds, firstDueAt: spec.firstDueAt(now), registeredAt: now });
      }
      const report: TickReport = { now, runs: [], lagging: [], skippedLeased: [], lostLeases: [], nextDueAt: null };
      await state.prune([...byKey.keys()], 100);
      const due = (await state.list()).filter((j) => byKey.has(j.jobKey) && Date.parse(dueOf(j)) <= Date.parse(now));
      // Отставание до запусков: планировщик, простоявший дольше порога, сообщает об этом и после того, как догонит слоты. Отсчёт — не раньше
      // регистрации работы: новая суточная работа со слотом в прошлом не «отстаёт» (проверка в живом режиме, шаг 26)
      const lagOf = (j: JobState) => Math.max(0, (Date.parse(now) - Math.max(Date.parse(j.nextDueAt), Date.parse(j.registeredAt))) / 1000);
      const lagBefore = new Map(due.map((j) => [j.jobKey, lagOf(j)]));
      for (const job of due) {
        const spec = byKey.get(job.jobKey)!;
        for (let slot = 0; slot < (spec.catchUp === 'EVERY_SLOT' ? maxSlots : 1); slot++) {
          const claimed = await state.claim(job.jobKey, owner, now, spec.leaseSeconds);
          if (!claimed) {
            if (slot === 0) report.skippedLeased.push(job.jobKey);
            break;
          }
          try {
            const { run, succeeded } = await runOne(spec, claimed, now);
            report.runs.push(run);
            if (!succeeded) break;
          } catch (error) {
            // Аренду потеряли во время запуска: итог не записан, работа повторится у владельца аренды; остальные работы такта идут дальше
            if (!(error instanceof LeaseLostError)) throw error;
            report.lostLeases.push(job.jobKey);
            await alerts.raise({ code: 'SCHEDULER_LEASE_LOST', severity: 'WARNING', details: { job: job.jobKey } });
            break;
          }
        }
      }
      // Отставание — после запусков: работа, догнавшая слоты в этом такте, не отстаёт
      for (const job of await state.list()) {
        const spec = byKey.get(job.jobKey);
        if (!spec) continue;
        // Работу, аренду которой держит другой процесс, будить незачем: её срок в прошлом дал бы такт каждую секунду (находка 13.8)
        const leasedElsewhere = job.leaseOwner !== null && job.leaseOwner !== owner && job.leaseUntil !== null && Date.parse(job.leaseUntil) > Date.parse(now);
        const due = leasedElsewhere ? job.leaseUntil! : dueOf(job);
        if (report.nextDueAt === null || Date.parse(due) < Date.parse(report.nextDueAt)) report.nextDueAt = due;
        const remaining = lagOf(job);
        const lagSeconds = Math.max(remaining, lagBefore.get(job.jobKey) ?? 0);
        const level: LagLevel = lagSeconds >= spec.lagCriticalSeconds ? 'CRITICAL' : lagSeconds >= spec.lagWarningSeconds ? 'WARNING' : 'OK';
        if (level !== 'OK') report.lagging.push({ jobKey: job.jobKey, lagSeconds, level });
        // Уровень меняет и алерт поднимает один процесс: смена уровня — сравнением в хранилище (риск 31)
        let current = job.lagLevel;
        if (level !== current && await state.setLagLevel(job.jobKey, current, level)) {
          current = level;
          if (level !== 'OK') {
            await alerts.raise({ code: 'SCHEDULER_JOB_LAGGING', severity: level, details: {
              job: job.jobKey, lagSeconds: Math.round(lagSeconds), nextDueAt: job.nextDueAt, lastOutcome: job.lastOutcome ?? 'NONE', caughtUp: remaining < spec.lagWarningSeconds,
            } });
          }
        }
        // Догнавшая работа снова в норме: следующее отставание снова даст алерт
        if (current !== 'OK' && remaining < spec.lagWarningSeconds) await state.setLagLevel(job.jobKey, current, 'OK');
      }
      return report;
    },
  };
}

export type Scheduler = ReturnType<typeof createScheduler>;
