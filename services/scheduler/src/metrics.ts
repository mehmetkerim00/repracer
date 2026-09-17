import { createServer, type Server } from 'node:http';
import type { TickReport } from './scheduler.ts';

/**
 * Р-129 (шаг 26): метрики процесса планировщика в текстовом формате Prometheus и проверка работоспособности для развёртывания.
 * Метки — только имя работы и итог: идентификаторов тенантов и аккаунтов в метриках нет, данных тенантов — тоже (метрики не объединяют
 * бизнес-данные тенантов). /healthz — 200, если последний успешный такт был не раньше staleAfterMs назад; иначе 503 и перезапуск
 * контейнера. Живость процесса извне — внешняя отметка (Р-127), а не эта проверка: она не видит остановленный хост.
 */
export class SchedulerMetrics {
  private readonly startedAtMs: number;
  private lastSuccessMs: number | null = null;
  private readonly ticks = { ok: 0, failed: 0 };
  private readonly runs = new Map<string, number>();
  private readonly items = new Map<string, number>();
  private readonly lastLag = new Map<string, number>();
  private lagging = { WARNING: 0, CRITICAL: 0 };
  private heartbeatFailures = 0;
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
    this.startedAtMs = now();
  }

  tick(ok: boolean, report: TickReport | null): void {
    if (!ok || !report) { this.ticks.failed += 1; return; }
    this.ticks.ok += 1;
    this.lastSuccessMs = this.now();
    for (const r of report.runs) {
      const key = `${r.jobName}|${r.outcome}`;
      this.runs.set(key, (this.runs.get(key) ?? 0) + 1);
      this.items.set(r.jobName, (this.items.get(r.jobName) ?? 0) + (r.items ?? 0));
      this.lastLag.set(r.jobName, r.lagSeconds);
    }
    this.lagging = { WARNING: report.lagging.filter((l) => l.level === 'WARNING').length, CRITICAL: report.lagging.filter((l) => l.level === 'CRITICAL').length };
  }

  heartbeatFailed(): void {
    this.heartbeatFailures += 1;
  }

  healthy(staleAfterMs: number): boolean {
    return this.now() - (this.lastSuccessMs ?? this.startedAtMs) <= staleAfterMs;
  }

  render(): string {
    const lines: string[] = [];
    const metric = (name: string, type: string, help: string, samples: Array<[string, number]>) => {
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
      for (const [labels, value] of samples) lines.push(`${name}${labels} ${value}`);
    };
    const esc = (v: string) => v.replace(/[\\"\n]/g, '_');
    metric('repracer_scheduler_ticks_total', 'counter', 'Scheduler ticks by outcome', [['{outcome="ok"}', this.ticks.ok], ['{outcome="failed"}', this.ticks.failed]]);
    metric('repracer_scheduler_last_successful_tick_timestamp_seconds', 'gauge', 'Unix time of the last successful tick',
      [['', this.lastSuccessMs === null ? 0 : Math.floor(this.lastSuccessMs / 1000)]]);
    metric('repracer_scheduler_job_runs_total', 'counter', 'Job runs by job name and outcome',
      [...this.runs].map(([k, v]) => { const [job, outcome] = k.split('|'); return [`{job="${esc(job!)}",outcome="${esc(outcome!)}"}`, v] as [string, number]; }));
    metric('repracer_scheduler_job_items_total', 'counter', 'Objects processed by job name', [...this.items].map(([job, v]) => [`{job="${esc(job)}"}`, v] as [string, number]));
    metric('repracer_scheduler_job_last_lag_seconds', 'gauge', 'Lag of the last run of the job behind its slot', [...this.lastLag].map(([job, v]) => [`{job="${esc(job)}"}`, Math.round(v)] as [string, number]));
    metric('repracer_scheduler_lagging_jobs', 'gauge', 'Jobs lagging at the last tick by level', [['{level="WARNING"}', this.lagging.WARNING], ['{level="CRITICAL"}', this.lagging.CRITICAL]]);
    metric('repracer_scheduler_heartbeat_failures_total', 'counter', 'External heartbeat pings that failed', [['', this.heartbeatFailures]]);
    return `${lines.join('\n')}\n`;
  }
}

export function serveMetrics(metrics: SchedulerMetrics, options: { port: number; host?: string; staleAfterMs: number }): Promise<Server> {
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/metrics') {
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' }).end(metrics.render());
      return;
    }
    if (req.method === 'GET' && req.url === '/healthz') {
      const ok = metrics.healthy(options.staleAfterMs);
      res.writeHead(ok ? 200 : 503, { 'content-type': 'text/plain' }).end(ok ? 'ok' : 'stale');
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve) => server.listen(options.port, options.host ?? '0.0.0.0', () => resolve(server)));
}
