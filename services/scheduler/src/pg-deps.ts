import { EXPORT_GROUP_OF, exportDay, type ClickHouseHttp, type DayRange, type ExportGroup } from '@repracer/analytics-export';
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
  /** Р-156: доставка алертов владельцу; без неё работы `alerts-deliver` нет, и алерты остаются в базе недоставленными */
  alertDelivery?: JobDeps['alertDelivery'];
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
    exportDay: (range: DayRange, groups?: readonly ExportGroup[]) => exportDay(o.exporterPool, o.ingest, o.verifier, range, groups),
    async exportBacklog(now: Instant, lookbackDays: number) {
      const out: Array<{ group: ExportGroup; range: DayRange; reason: 'NOT_EXPORTED' | 'UNVERIFIED' | 'ROWS_CHANGED' }> = [];
      for (const [parent, group] of Object.entries(EXPORT_GROUP_OF)) {
        const { rows: [key] } = await o.exporterPool.query('SELECT pg_get_partkeydef($1::regclass) AS def', [parent]);
        const column = /^RANGE \((\w+)\)$/.exec(String(key?.def))?.[1];
        if (!column) continue;
        const { rows } = await o.exporterPool.query(
          `SELECT c.oid::regclass::text AS name, pg_get_expr(c.relpartbound, c.oid) AS bound, e.exported_rows, e.verified_at
             FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
             LEFT JOIN maintenance.partition_export e ON e.partition_name = c.oid::regclass::text AND e.target = 'CLICKHOUSE'
            WHERE i.inhparent = $1::regclass`, [parent]);
        for (const r of rows) {
          const m = /FROM \('([^']+)'\) TO \('([^']+)'\)/.exec(String(r.bound));
          if (!m) continue;
          const from = Date.parse(m[1]!);
          const to = Date.parse(m[2]!);
          // Только закрытые суточные секции окна повторов (принудительное удаление — через 14 суток)
          if (to - from !== 86_400_000 || to > Date.parse(now) || from < Date.parse(now) - lookbackDays * 86_400_000) continue;
          const range = { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
          if (r.exported_rows === null) { out.push({ group, range, reason: 'NOT_EXPORTED' }); continue; }
          if (!r.verified_at) { out.push({ group, range, reason: 'UNVERIFIED' }); continue; }
          const { rows: [n] } = await o.exporterPool.query(
            `SELECT count(*)::bigint AS n FROM ${parent} WHERE ${column} >= $1::timestamptz AND ${column} < $2::timestamptz`, [range.from, range.to]);
          if (Number(n.n) !== Number(r.exported_rows)) out.push({ group, range, reason: 'ROWS_CHANGED' });
        }
      }
      return out;
    },
    async forceDroppedSince(since: Instant) {
      const { rows } = await o.schedulerPool.query(
        `SELECT table_name, cutoff FROM maintenance.retention_run WHERE action = 'PARTITION_FORCE_DROPPED' AND executed_at >= $1::timestamptz ORDER BY executed_at`, [since]);
      // object_name — OID удалённой секции (0040): после удаления по нему имени не найти; в алерт — таблица и начало суток секции
      return rows.map((r) => `${String(r.table_name)}@${r.cutoff ? new Date(r.cutoff).toISOString().slice(0, 10) : '?'}`);
    },
    maintenance: {
      async databaseNow() { return new Date((await o.schedulerPool.query('SELECT now() AS n')).rows[0].n).toISOString(); },
      async closePriceDays(now) { return Number((await o.schedulerPool.query('SELECT maintenance.close_price_days($1) AS n', [now])).rows[0].n); },
      async correctClosedPriceDays(now) { return Number((await o.schedulerPool.query('SELECT maintenance.correct_closed_price_days($1) AS n', [now])).rows[0].n); },
      async ensurePartitions(now) { await o.schedulerPool.query('SELECT maintenance.ensure_partitions($1)', [now]); },
      dropExpiredPartitions: (now) => loop(async () => Number((await o.schedulerPool.query('SELECT maintenance.drop_expired_partitions($1) AS n', [now])).rows[0].n)),
      deleteExpiredRows: (now) => loop(async () => Number((await o.schedulerPool.query('SELECT maintenance.delete_expired_rows($1) AS n', [now])).rows[0].n)),
      // Р-25: повторять, пока не вернёт 0 — функция работает пакетами по 1000 строк
      releaseExpiredReservations: (now) => loop(async () => Number((await o.schedulerPool.query('SELECT maintenance.release_expired_reservations($1) AS n', [now])).rows[0].n)),
      // Р-30: алерт, а НЕ освобождение — подтверждённую резервацию разбирает человек
      alertStaleConfirmedReservations: (now) => loop(async () => Number((await o.schedulerPool.query('SELECT maintenance.alert_stale_confirmed_reservations($1) AS n', [now])).rows[0].n)),
    },
    ...(o.reconcileEnabled ? { reconcileEnabled: o.reconcileEnabled } : {}),
    ...(o.alertDelivery ? { alertDelivery: o.alertDelivery } : {}),
    ...(o.config ? { config: o.config } : {}),
  };
}
