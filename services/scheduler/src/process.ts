import type { AdapterLogger } from '@repracer/channel-port';
import type { Scheduler, TickReport } from './scheduler.ts';

/**
 * Р-126: процесс планировщика — такт раз в tickMs. Процессов может быть несколько: работу выполняет тот, кто держит её аренду. Сбой такта
 * (база недоступна) пишется в журнал, процесс продолжает: пропущенные слоты выполнятся следующим тактом. В журнал — код и метрики
 * запусков, без тел запросов и секретов.
 */
export interface RunningScheduler {
  stop(): Promise<void>;
  /** Цикл закончился: остановка или условие shouldStop */
  finished: Promise<void>;
}

export interface RunSchedulerOptions {
  /** Наибольшая пауза между тактами; процесс просыпается раньше — к ближайшему сроку работы (шаг 26) */
  tickMs: number;
  /** Наименьшая пауза, по умолчанию 1 с: сбойный такт не крутится без паузы */
  minSleepMs?: number;
  /** Часы для длительности такта; по умолчанию — Date.now, проверка в живом режиме — виртуальные */
  clockMs?: () => number;
  logger: AdapterLogger;
  /**
   * Пауза между тактами. По умолчанию — таймер; проверка в живом режиме (Р-128) передаёт виртуальные часы и работу других процессов
   * между тактами (приёмник уведомлений, диспетчер записей)
   */
  sleep?: (ms: number) => Promise<void>;
  /** Остановка по условию — после такта и после паузы */
  shouldStop?: () => boolean;
  /** Каждый такт, успешный или нет: отметка работоспособности наружу (Р-127) */
  onTick?: (result: { ok: boolean; at: number; report: TickReport | null }) => Promise<void> | void;
  /**
   * Начало итерации цикла — до выполнения работ. Цикл жив и тогда, когда такт идёт долго (выгрузка суток берёт аренду на 2 часа):
   * проверка работоспособности и отметка наружу считают живость по нему, а не по завершению такта (ревью шага 26, находка 5)
   */
  onIterationStart?: () => void;
}

export function runScheduler(scheduler: Scheduler, options: RunSchedulerOptions): RunningScheduler {
  let stopped = false;
  let wake: (() => void) | null = null;
  const loop = (async () => {
    while (!stopped && !options.shouldStop?.()) {
      let ok = true;
      options.onIterationStart?.();
      const clockMs = options.clockMs ?? Date.now;
      const tickStarted = clockMs();
      let sleepMs = options.tickMs;
      let report: TickReport | null = null;
      try {
        const r = await scheduler.tick();
        report = r;
        // Ближайший срок: работа с интервалом меньше такта (сверка Amazon — 31 с) не ждёт следующего такта
        if (r.nextDueAt) sleepMs = Date.parse(r.nextDueAt) - Date.parse(r.now) - (clockMs() - tickStarted);

        for (const run of r.runs) {
          options.logger.log({
            level: run.outcome === 'SUCCEEDED' ? 'INFO' : 'WARN', code: 'SCHEDULER_RUN', message: run.jobName,
            details: {
              job: run.jobKey, slotAt: run.slotAt, outcome: run.outcome, lagSeconds: Math.round(run.lagSeconds), items: run.items,
              durationMs: Date.parse(run.finishedAt) - Date.parse(run.startedAt), error: run.errorCode,
            },
          });
        }
      } catch (error) {
        ok = false;
        options.logger.log({ level: 'WARN', code: 'SCHEDULER_TICK_FAILED', message: 'SCHEDULER_TICK_FAILED', details: { error: String((error as Error).message).slice(0, 200) } });
      }
      try {
        await options.onTick?.({ ok, at: Date.now(), report });
      } catch (error) {
        options.logger.log({ level: 'WARN', code: 'SCHEDULER_HEARTBEAT_FAILED', message: 'SCHEDULER_HEARTBEAT_FAILED', details: { error: String((error as Error).message).slice(0, 200) } });
      }
      if (stopped || options.shouldStop?.()) break;
      const pause = Math.max(options.minSleepMs ?? 1000, Math.min(options.tickMs, sleepMs));
      if (options.sleep) {
        await options.sleep(pause);
        continue;
      }
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, pause);
        wake = () => { clearTimeout(t); resolve(); };
      });
    }
  })();
  return {
    finished: loop,
    async stop() {
      stopped = true;
      wake?.();
      await loop;
    },
  };
}
