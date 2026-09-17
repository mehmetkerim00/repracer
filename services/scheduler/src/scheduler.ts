import type { AlertSink, Instant } from '@repracer/channel-port';
import type { CatchUp, JobScope, JobState, RunRecord, SchedulerStateStore } from './state.ts';

/**
 * Р-126 (шаг 25): процесс-планировщик. Каждый такт:
 *  1. источник работ называет работы на сейчас (глобальные и по аккаунтам) — они появляются в состоянии;
 *  2. каждая работа, срок которой наступил, занимается арендой (одна на все процессы планировщика) и выполняется; EVERY_SLOT-работа
 *     выполняет пропущенные слоты по очереди до maxSlotsPerTick за такт, LATEST — один запуск за все пропущенные;
 *  3. срок сдвигается только после успеха: провал оставляет тот же слот, он повторяется следующим тактом, после
 *     failureAlertAfter провалов подряд — CRITICAL-алерт;
 *  4. отставание каждой работы (сейчас − срок) сравнивается с её порогами — WARNING и CRITICAL, алерт при смене уровня;
 *  5. каждый запуск — строка журнала: слот, начало, конец, итог, отставание, число обработанных объектов.
 */

export interface JobRunContext {
  /** Слот, который выполняется: для EVERY_SLOT — конкретный пропущенный слот, для LATEST — самый ранний из пропущенных */
  slotAt: Instant;
  now: Instant;
  /** Число успешных запусков до этого — окно сверки по кругу [Р-121] */
  runIndex: number;
  scope: JobScope | null;
}

export interface JobSpec {
  name: string;
  scope: JobScope | null;
  intervalSeconds: number;
  catchUp: CatchUp;
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
  now: () => Instant;
  alerts: AlertSink;
  maxSlotsPerTick?: number;
  failureAlertAfter?: number;
}

export interface TickReport {
  now: Instant;
  runs: RunRecord[];
  lagging: Array<{ jobKey: string; lagSeconds: number; level: 'WARNING' | 'CRITICAL' }>;
  skippedLeased: string[];
}

export const jobKeyOf = (name: string, scope: JobScope | null) => (scope ? `${name}:${scope.tenantId}:${scope.channelAccountId}` : name);

/** Ближайший слот после момента для LATEST: срок + k интервалов > now; k − 1 — схлопнутые слоты */
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
  const lagLevel = new Map<string, 'OK' | 'WARNING' | 'CRITICAL'>();

  async function runOne(spec: JobSpec, claimed: JobState, now: Instant): Promise<{ run: RunRecord; succeeded: boolean }> {
    const startedAt = options.now();
    let outcome: RunRecord['outcome'] = 'SUCCEEDED';
    let items: number | null = null;
    let errorCode: string | null = null;
    let error: string | null = null;
    try {
      const r = await spec.run({ slotAt: claimed.nextDueAt, now, runIndex: claimed.runsCompleted, scope: spec.scope });
      items = r.items;
      for (const a of r.alerts ?? []) await alerts.raise({ ...a, details: { job: claimed.jobKey, ...a.details } });
    } catch (e) {
      outcome = 'FAILED';
      errorCode = code(e);
      // Текст ошибки — без тела запросов и секретов: только первые 300 символов сообщения
      error = String((e as Error)?.message ?? e).slice(0, 300);
    }
    const finishedAt = options.now();
    const next = outcome === 'SUCCEEDED'
      ? spec.catchUp === 'EVERY_SLOT'
        ? { nextDueAt: new Date(Date.parse(claimed.nextDueAt) + spec.intervalSeconds * 1000).toISOString(), coalesced: 0 }
        : nextSlotAfter(claimed.nextDueAt, now, spec.intervalSeconds)
      : { nextDueAt: claimed.nextDueAt, coalesced: 0 };
    const run: RunRecord = {
      jobKey: claimed.jobKey, jobName: spec.name, slotAt: claimed.nextDueAt, owner, startedAt, finishedAt, outcome,
      lagSeconds: Math.max(0, (Date.parse(startedAt) - Date.parse(claimed.nextDueAt)) / 1000), items, errorCode,
    };
    await state.finish(claimed.jobKey, owner, { outcome, nextDueAt: next.nextDueAt, coalesced: next.coalesced, error, run });
    if (outcome === 'FAILED' && claimed.consecutiveFailures + 1 >= failureAlertAfter) {
      await alerts.raise({ code: 'SCHEDULER_JOB_FAILING', severity: 'CRITICAL', details: { job: claimed.jobKey, failures: claimed.consecutiveFailures + 1, error: errorCode ?? 'JOB_FAILED' } });
    }
    return { run, succeeded: outcome === 'SUCCEEDED' };
  }

  return {
    async tick(): Promise<TickReport> {
      const now = options.now();
      const specs = await source.jobs(now);
      const byKey = new Map<string, JobSpec>();
      for (const spec of specs) {
        const jobKey = jobKeyOf(spec.name, spec.scope);
        byKey.set(jobKey, spec);
        await state.ensure({ jobKey, jobName: spec.name, scope: spec.scope, catchUp: spec.catchUp, intervalSeconds: spec.intervalSeconds, firstDueAt: spec.firstDueAt(now) });
      }
      const report: TickReport = { now, runs: [], lagging: [], skippedLeased: [] };
      const due = (await state.list()).filter((j) => byKey.has(j.jobKey) && Date.parse(j.nextDueAt) <= Date.parse(now));
      // Отставание до запусков: планировщик, простоявший дольше порога, сообщает об этом и после того, как догонит слоты
      const lagBefore = new Map(due.map((j) => [j.jobKey, Math.max(0, (Date.parse(now) - Date.parse(j.nextDueAt)) / 1000)]));
      for (const job of due) {
        const spec = byKey.get(job.jobKey)!;
        for (let slot = 0; slot < (spec.catchUp === 'EVERY_SLOT' ? maxSlots : 1); slot++) {
          const claimed = await state.claim(job.jobKey, owner, now, spec.leaseSeconds);
          if (!claimed) {
            if (slot === 0) report.skippedLeased.push(job.jobKey);
            break;
          }
          const { run, succeeded } = await runOne(spec, claimed, now);
          report.runs.push(run);
          if (!succeeded) break;
        }
      }
      // Отставание — после запусков: работа, догнавшая слоты в этом такте, не отстаёт
      for (const job of await state.list()) {
        const spec = byKey.get(job.jobKey);
        if (!spec) continue;
        const remaining = Math.max(0, (Date.parse(now) - Date.parse(job.nextDueAt)) / 1000);
        const lagSeconds = Math.max(remaining, lagBefore.get(job.jobKey) ?? 0);
        const level = lagSeconds >= spec.lagCriticalSeconds ? 'CRITICAL' : lagSeconds >= spec.lagWarningSeconds ? 'WARNING' : 'OK';
        if (level !== 'OK') report.lagging.push({ jobKey: job.jobKey, lagSeconds, level });
        const previous = lagLevel.get(job.jobKey) ?? 'OK';
        if (level !== previous) {
          lagLevel.set(job.jobKey, level);
          if (level !== 'OK') {
            await alerts.raise({ code: 'SCHEDULER_JOB_LAGGING', severity: level, details: {
              job: job.jobKey, lagSeconds: Math.round(lagSeconds), nextDueAt: job.nextDueAt, lastOutcome: job.lastOutcome ?? 'NONE', caughtUp: remaining < spec.lagWarningSeconds,
            } });
          }
        }
        // Догнавшая работа снова в норме: следующее отставание снова даст алерт
        if (level !== 'OK' && remaining < spec.lagWarningSeconds) lagLevel.set(job.jobKey, 'OK');
      }
      return report;
    },
  };
}

export type Scheduler = ReturnType<typeof createScheduler>;
