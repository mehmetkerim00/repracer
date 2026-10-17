import type { ImportRunInput, ImportRunRow } from '@repracer/pricing-pipeline';
import type { Tx } from './db.ts';

type Row = Record<string, any>;

/**
 * Шаг 99 [Р-224]: журнал импортов продавца в PostgreSQL. Строку пишет задание импорта — примерка («проверено») или применение
 * («применено» / «отказано»); применённый импорт пишет её В ТОЙ ЖЕ транзакции, что и данные, поэтому «применено» в журнале
 * значит, что данные в базе. Автора, момент и длительность ставит база из задания (`tenant_data.import_run_from_its_job`)
 */
export const IMPORT_RUN_COLUMNS = `import_run_id, kind, outcome, reason, file_name, file_sha256, rows_total, rows_changed, rows_unchanged, rows_rejected,
  duration_ms, bulk_job_id, created_by_membership_id, created_by_user_id, recorded_at`;

export function importRunRow(r: Row): ImportRunRow {
  return {
    runId: String(r.import_run_id), kind: r.kind, outcome: r.outcome, reason: r.reason ?? null, fileName: r.file_name, fileSha256: r.file_sha256,
    rowsTotal: Number(r.rows_total), rowsChanged: Number(r.rows_changed), rowsUnchanged: Number(r.rows_unchanged), rowsRejected: Number(r.rows_rejected),
    durationMs: Number(r.duration_ms), bulkJobId: String(r.bulk_job_id), createdByMembershipId: String(r.created_by_membership_id),
    createdByUserId: String(r.created_by_user_id), recordedAt: new Date(r.recorded_at as string | Date).toISOString(),
  };
}

/**
 * Вставить строку журнала. Автор и длительность в запросе — заглушки: их перезаписывает страж из задания, которое строку пишет; задание
 * то, что назвало себя базе (`app.bulk_job_id`). Повтор того же задания строку не дублирует (одна строка на задание) — возвращается
 * записанная раньше
 */
export async function insertImportRun(tx: Tx, tenantId: string, run: ImportRunInput, bulkJobId: string, actor: { membershipId: string; userId: string }): Promise<ImportRunRow> {
  const { rows: [inserted] } = await tx.query(
    `INSERT INTO tenant_data.import_run (tenant_id, kind, outcome, reason, file_name, file_sha256, rows_total, rows_changed, rows_unchanged, rows_rejected,
                                         duration_ms, bulk_job_id, created_by_membership_id, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 0, $11, $12, $13)
     ON CONFLICT (tenant_id, bulk_job_id) DO NOTHING
     RETURNING ${IMPORT_RUN_COLUMNS}`,
    [tenantId, run.kind, run.outcome, run.reason ?? null, run.fileName.slice(0, 200) || 'import', run.fileSha256, run.rowsTotal, run.rowsChanged,
      run.rowsUnchanged, run.rowsRejected, bulkJobId, actor.membershipId, actor.userId]);
  if (inserted) return importRunRow(inserted);
  const { rows: [existing] } = await tx.query(
    `SELECT ${IMPORT_RUN_COLUMNS} FROM tenant_data.import_run WHERE tenant_id = $1 AND bulk_job_id = $2`, [tenantId, bulkJobId]);
  return importRunRow(existing!);
}
