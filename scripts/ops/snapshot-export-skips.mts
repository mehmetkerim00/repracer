/**
 * OQ-181 (шаг 25): разбор снимков, пропущенных выгрузкой в ClickHouse, оператором платформы.
 *   node --experimental-strip-types scripts/ops/snapshot-export-skips.mts list
 *   node --experimental-strip-types scripts/ops/snapshot-export-skips.mts resolve <competitor_snapshot_id> LOSS_ACCEPTED|EXPORTED_AFTER_FIX "<operator>" "<note>"
 * REPRACER_EXPORTER_PG_URL — роль svc_exporter. Выводятся только идентификаторы, причина и разбор — без содержимого снимков.
 * Следующая выгрузка суток (планировщик, работа analytics-export-day) отмечает секцию проверенной, когда разобраны все её пропуски.
 */
import { listSnapshotExportSkips, resolveSnapshotExportSkip } from '@repracer/analytics-export';
import { createPool } from '@repracer/pricing-store-pg';

const url = process.env.REPRACER_EXPORTER_PG_URL;
if (!url) throw new Error('REPRACER_EXPORTER_PG_URL is required');
const pool = createPool(url, { max: 1, applicationName: 'repracer-ops-snapshot-skips' });
try {
  const [command, id, resolution, operator, note] = process.argv.slice(2);
  if (command === 'list') {
    for (const k of await listSnapshotExportSkips(pool, { unresolvedOnly: true })) {
      console.log([k.competitorSnapshotId, k.subjectTenantId, k.partitionName, k.receivedAt, k.reason].join('\t'));
    }
  } else if (command === 'resolve' && id && (resolution === 'LOSS_ACCEPTED' || resolution === 'EXPORTED_AFTER_FIX') && operator && note) {
    await resolveSnapshotExportSkip(pool, { competitorSnapshotId: id, resolution, resolvedBy: operator, note });
    console.log(`resolved ${id}: ${resolution}`);
  } else {
    console.error('usage: list | resolve <competitor_snapshot_id> LOSS_ACCEPTED|EXPORTED_AFTER_FIX "<operator>" "<note>"');
    process.exitCode = 2;
  }
} finally {
  await pool.end();
}
