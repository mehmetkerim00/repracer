/**
 * OQ-181 (шаг 25): разбор снимков, пропущенных выгрузкой в ClickHouse, оператором платформы.
 *   node --experimental-strip-types scripts/ops/snapshot-export-skips.mts list
 *   REPRACER_OPERATOR_ID=<operator_id> node --experimental-strip-types scripts/ops/snapshot-export-skips.mts resolve <competitor_snapshot_id> LOSS_ACCEPTED|EXPORTED_AFTER_FIX "<operator>" "<note>"
 * REPRACER_TRIAGE_PG_URL — роль svc_export_triage (разбор — не роль выгрузки, ревью шага 25, находка 9); REPRACER_OPERATOR_ID — учётная
 * запись оператора платформы, от имени которой идёт разбор, второй фактор подтверждает оператор (OQ-182, шаг 26). Выводятся только идентификаторы, причина и разбор — без содержимого снимков.
 * Следующая выгрузка суток (планировщик, работа analytics-export-day) отмечает секцию проверенной, когда разобраны все её пропуски.
 */
import { listSnapshotExportSkips, resolveSnapshotExportSkip } from '@repracer/analytics-export';
import { createPool } from '@repracer/pricing-store-pg';

const url = process.env.REPRACER_TRIAGE_PG_URL;
if (!url) throw new Error('REPRACER_TRIAGE_PG_URL is required');
const pool = createPool(url, { max: 1, applicationName: 'repracer-ops-snapshot-skips' });
try {
  const [command, id, resolution, operator, note] = process.argv.slice(2);
  if (command === 'list') {
    for (const k of await listSnapshotExportSkips(pool, { unresolvedOnly: true })) {
      console.log([k.competitorSnapshotId, k.subjectTenantId, k.partitionName, k.receivedAt, k.reason].join('\t'));
    }
  } else if (command === 'resolve' && id && (resolution === 'LOSS_ACCEPTED' || resolution === 'EXPORTED_AFTER_FIX') && operator && note) {
    const operatorId = process.env.REPRACER_OPERATOR_ID;
    if (!operatorId) throw new Error('REPRACER_OPERATOR_ID is required: a resolution comes from a platform operator account (OQ-182)');
    // Второй фактор оператора подтверждается при входе оператора; инструмент заявляет его за себя — как административный сервис [Р-97]
    await resolveSnapshotExportSkip(pool, { competitorSnapshotId: id, resolution, resolvedBy: operator, note, operatorId, mfa: process.env.REPRACER_OPERATOR_MFA === 'true' });
    console.log(`resolved ${id}: ${resolution}`);
  } else {
    console.error('usage: list | resolve <competitor_snapshot_id> LOSS_ACCEPTED|EXPORTED_AFTER_FIX "<operator>" "<note>"');
    process.exitCode = 2;
  }
} finally {
  await pool.end();
}
