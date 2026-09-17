import type { AdapterLogger } from '@repracer/channel-port';
import type { Scheduler } from './scheduler.ts';

/**
 * Р-126: процесс планировщика — такт раз в tickMs. Процессов может быть несколько: работу выполняет тот, кто держит её аренду. Сбой такта
 * (база недоступна) пишется в журнал, процесс продолжает: пропущенные слоты выполнятся следующим тактом. В журнал — код и метрики
 * запусков, без тел запросов и секретов.
 */
export interface RunningScheduler {
  stop(): Promise<void>;
}

export function runScheduler(scheduler: Scheduler, options: { tickMs: number; logger: AdapterLogger }): RunningScheduler {
  let stopped = false;
  let wake: (() => void) | null = null;
  const loop = (async () => {
    while (!stopped) {
      try {
        const r = await scheduler.tick();
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
        options.logger.log({ level: 'WARN', code: 'SCHEDULER_TICK_FAILED', message: 'SCHEDULER_TICK_FAILED', details: { error: String((error as Error).message).slice(0, 200) } });
      }
      if (stopped) break;
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, options.tickMs);
        wake = () => { clearTimeout(t); resolve(); };
      });
    }
  })();
  return {
    async stop() {
      stopped = true;
      wake?.();
      await loop;
    },
  };
}
