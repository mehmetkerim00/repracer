import { exportDay, type ClickHouseHttp, type DayRange } from '@repracer/analytics-export';
import type { ChannelDescriptor, Instant } from '@repracer/channel-port';
import type { PricingPipeline } from '@repracer/pricing-pipeline';
import type { PgPool } from '@repracer/pricing-store-pg';
import type { JobConfig, JobDeps, SchedulerAccount } from './jobs.ts';

/**
 * Р-126: зависимости работ на PostgreSQL. Роли подключения разделены [Р-90]: svc_scheduler (repracer_retention) — список аккаунтов
 * (только идентификаторы), закрытие суток цен, секции и удаление по сроку; svc_exporter — выгрузка суток и её проверка; путь решения —
 * пайплайн аккаунта (svc_app), его строит вызывающий вместе с адаптером и учётными данными канала.
 */
export interface PgJobDepsOptions {
  schedulerPool: PgPool;
  exporterPool: PgPool;
  ingest: ClickHouseHttp;
  verifier: ClickHouseHttp;
  pipelineFor(account: SchedulerAccount): PricingPipeline;
  descriptorOf(channel: string): ChannelDescriptor | null;
  reconcileEnabled?: JobDeps['reconcileEnabled'];
  config?: Partial<JobConfig>;
}

export function pgJobDeps(o: PgJobDepsOptions): JobDeps {
  const loop = async (fn: () => Promise<number>) => {
    let total = 0;
    for (let i = 0; i < 100; i++) {
      const n = await fn();
      total += n;
      if (n === 0) break;
    }
    return total;
  };
  return {
    async accounts() {
      const { rows } = await o.schedulerPool.query(
        `SELECT a.tenant_id, a.channel_account_id, a.channel FROM tenant_data.channel_account a
           JOIN tenant_data.tenant t ON t.tenant_id = a.tenant_id
          WHERE a.disconnected_at IS NULL AND a.auth_status = 'ACTIVE' AND t.kind = 'CUSTOMER' AND t.status NOT IN ('OFFBOARDING', 'CLOSED')
          ORDER BY a.tenant_id, a.channel_account_id`);
      return rows.map((r) => ({ tenantId: r.tenant_id, channelAccountId: r.channel_account_id, channel: r.channel }));
    },
    descriptorOf: o.descriptorOf,
    pipelineFor: o.pipelineFor,
    exportDay: (range: DayRange) => exportDay(o.exporterPool, o.ingest, o.verifier, range),
    async unverifiedDays(now: Instant, lookbackDays: number) {
      const { rows } = await o.exporterPool.query(
        `SELECT pg_get_expr(c.relpartbound, c.oid) AS bound
           FROM maintenance.partition_export e
           JOIN pg_class c ON c.oid = to_regclass(e.partition_name)
          WHERE e.target = 'CLICKHOUSE' AND e.verified_at IS NULL AND e.exported_at >= $1::timestamptz - make_interval(days => $2)`, [now, lookbackDays]);
      const days = new Map<string, DayRange>();
      for (const r of rows) {
        const m = /FROM \('([^']+)'\) TO \('([^']+)'\)/.exec(String(r.bound));
        if (!m) continue;
        const from = new Date(m[1]!).toISOString();
        const to = new Date(m[2]!).toISOString();
        if (Date.parse(to) - Date.parse(from) === 86_400_000) days.set(from, { from, to });
      }
      return [...days.values()];
    },
    maintenance: {
      async closePriceDays(now) { return Number((await o.schedulerPool.query('SELECT maintenance.close_price_days($1) AS n', [now])).rows[0].n); },
      async ensurePartitions(now) { await o.schedulerPool.query('SELECT maintenance.ensure_partitions($1)', [now]); },
      dropExpiredPartitions: (now) => loop(async () => Number((await o.schedulerPool.query('SELECT maintenance.drop_expired_partitions($1) AS n', [now])).rows[0].n)),
      deleteExpiredRows: (now) => loop(async () => Number((await o.schedulerPool.query('SELECT maintenance.delete_expired_rows($1) AS n', [now])).rows[0].n)),
    },
    ...(o.reconcileEnabled ? { reconcileEnabled: o.reconcileEnabled } : {}),
    ...(o.config ? { config: o.config } : {}),
  };
}
