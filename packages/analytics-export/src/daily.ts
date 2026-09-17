import type pg from 'pg';
import type { ClickHouseHttp } from './clickhouse.ts';
import { exportCompetitorSnapshotsDay, exportCompletedWritesDay, exportDecisionDay, type DayRange, type PartitionExport } from './exporter.ts';

/**
 * Шаг 24 [Р-122, Р-20]: выгрузка суток в ClickHouse одним заданием — решения и intent, завершённые записи, снимки конкурентов. Снимки идут
 * с первого дня работы с живым каналом: задание запускается для каждых закрытых суток UTC. Невыгруженная или непроверенная секция не
 * удаляется по сроку (requires_export) — итог задания называет её, чтобы поднять алерт. Планировщика в репозитории нет (инфраструктура
 * развёртывания — вне шага): задание вызывается им по суткам.
 */
export interface DailyExportReport {
  range: DayRange;
  exports: Array<PartitionExport & { skipped?: Record<string, number> }>;
  unverified: string[];
  /**
   * Шаг 25 [Р-126]: секции суток нет — её уже удалили принудительно (история потеряна) или не создали (секции создаются на 3 суток
   * вперёд). Выгрузка остальных таблиц суток продолжается; планировщик поднимает алерт, а не повторяет сутки бесконечно
   */
  missing: string[];
}

/** Сутки UTC, закрытые к моменту now: вчера */
export function previousUtcDay(now: Date): DayRange {
  const to = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return { from: new Date(to - 86_400_000).toISOString(), to: new Date(to).toISOString() };
}

export async function exportDay(pgExporter: pg.Pool, ingest: ClickHouseHttp, verifier: ClickHouseHttp, range: DayRange): Promise<DailyExportReport> {
  const exports: DailyExportReport['exports'] = [];
  const missing: string[] = [];
  const attempt = async (name: string, run: () => Promise<DailyExportReport['exports']>) => {
    try {
      exports.push(...(await run()));
    } catch (error) {
      if (!/^no partition of /.test(String((error as Error).message))) throw error;
      missing.push(name);
    }
  };
  await attempt('channel_data.price_intent/price_decision', () => exportDecisionDay(pgExporter, ingest, verifier, range));
  await attempt('tenant_data.channel_write_history', async () => [await exportCompletedWritesDay(pgExporter, ingest, verifier, range)]);
  await attempt('channel_data.competitor_snapshot_log', async () => [await exportCompetitorSnapshotsDay(pgExporter, ingest, verifier, range)]);
  return { range, exports, unverified: exports.filter((e) => !e.verified).map((e) => e.partitionName), missing };
}
