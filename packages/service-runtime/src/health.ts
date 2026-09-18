import { createServer, type Server } from 'node:http';

/**
 * Работоспособность процесса снаружи (OQ-190, как у планировщика 0129): `/healthz` — 200, пока цикл процесса шевелился не позже
 * `staleAfterMs` назад, иначе 503 и перезапуск контейнера; `/metrics` — текстовый формат Prometheus. Метки метрик — только коды и
 * имена работ: ни идентификаторов тенантов, ни данных покупателей, и никаких величин, объединяющих тенантов.
 */
export class ProcessHealth {
  private readonly now: () => number;
  private readonly startedAtMs: number;
  private lastAliveMs: number | null = null;
  private readonly counters = new Map<string, number>();

  constructor(now: () => number = Date.now) {
    this.now = now;
    this.startedAtMs = now();
  }

  /** Цикл процесса сделал шаг: приёмник опросил очередь, диспетчер прошёл обход, потребитель обработал сообщение */
  alive(): void {
    this.lastAliveMs = this.now();
  }

  count(name: string, by = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by);
  }

  healthy(staleAfterMs: number): boolean {
    return this.now() - (this.lastAliveMs ?? this.startedAtMs) <= staleAfterMs;
  }

  render(prefix: string, staleAfterMs: number): string {
    const lines: string[] = [
      `# HELP ${prefix}_up process is running`,
      `# TYPE ${prefix}_up gauge`,
      `${prefix}_up 1`,
      `# HELP ${prefix}_healthy the loop of the process made a step recently`,
      `# TYPE ${prefix}_healthy gauge`,
      `${prefix}_healthy ${this.healthy(staleAfterMs) ? 1 : 0}`,
      `# HELP ${prefix}_uptime_seconds seconds since start`,
      `# TYPE ${prefix}_uptime_seconds gauge`,
      `${prefix}_uptime_seconds ${Math.round((this.now() - this.startedAtMs) / 1000)}`,
    ];
    if (this.counters.size > 0) {
      lines.push(`# HELP ${prefix}_events_total events of the process by kind`, `# TYPE ${prefix}_events_total counter`);
      for (const [name, value] of [...this.counters].sort(([a], [b]) => a.localeCompare(b))) {
        lines.push(`${prefix}_events_total{kind="${name.replace(/[\\"\n]/g, '_')}"} ${value}`);
      }
    }
    return `${lines.join('\n')}\n`;
  }
}

export interface HealthServer {
  server: Server;
  port: number;
  close(): Promise<void>;
}

export async function serveHealth(
  health: ProcessHealth, options: { port: number; prefix: string; staleAfterMs: number; host?: string },
): Promise<HealthServer> {
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (path === '/healthz') {
      const ok = health.healthy(options.staleAfterMs);
      res.writeHead(ok ? 200 : 503, { 'content-type': 'text/plain' }).end(ok ? 'ok\n' : 'stale\n');
      return;
    }
    if (path === '/metrics') {
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' }).end(health.render(options.prefix, options.staleAfterMs));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found\n');
  });
  await new Promise<void>((resolve) => server.listen(options.port, options.host ?? '0.0.0.0', () => resolve()));
  const address = server.address();
  return {
    server,
    port: typeof address === 'object' && address ? address.port : options.port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
