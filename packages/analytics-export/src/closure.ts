import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import type pg from 'pg';
import { buildCoreArchiveBundle, verifyCoreArchiveBundle, type ArchiveSink } from './archive.ts';
import type { PgRow } from './rows.ts';

/**
 * Шаг 59 [Р-201, OQ-22]: выгрузка доказательств цен клиенту при закрытии тенанта. Доказательства Omnibus / §11 PAngV — обязанность
 * продавца; мы ведём их, пока он клиент. При закрытии он уносит их с собой одним пакетом, который объясняет себя без нашей базы [Р-79]:
 * суточная свёртка с поправками (её итог без поправок неверен, Р-29), сырьё цен, объявления скидок и ядро решений со справочниками.
 * После записи выгрузки и 30 суток льготы `maintenance.purge_tenant_data` удаляет всё; до неё — отказывает.
 */
export const CLOSURE_EVIDENCE_FORMAT = 'closure-evidence.r201.1';

/** Таблицы доказательств и порядок строк в пакете — по первичному смыслу таблицы, чтобы два прогона давали одинаковые байты */
const EVIDENCE_TABLES: ReadonlyArray<{ table: string; order: string }> = [
  { table: 'tenant_data.price_daily', order: 'write_scope_id, day' },
  { table: 'tenant_data.price_daily_correction', order: 'created_at' },
  { table: 'tenant_data.price_daily_system_correction', order: 'created_at' },
  { table: 'tenant_data.price_history', order: 'write_scope_id, created_at' },
  { table: 'tenant_data.price_history_applied', order: 'applied_at' },
  { table: 'tenant_data.price_history_not_applied', order: 'recorded_at' },
  { table: 'tenant_data.discount_announcement', order: 'created_at' },
];

export interface ClosureEvidenceBundle {
  format: typeof CLOSURE_EVIDENCE_FORMAT;
  tenantId: string;
  tables: Record<string, PgRow[]>;
  /** Ядро решений со справочниками — тот же самодостаточный архив, что по секциям [Р-79] */
  core: PgRow[];
  dictionary: { strategies: PgRow[]; rulesets: PgRow[] };
}

export interface ClosureEvidenceExport { key: string; sha256: string; rows: number; perTable: Record<string, number>; selfContained: boolean }

export const closureEvidenceKey = (tenantId: string): string => `tenant=${tenantId}/closure/${CLOSURE_EVIDENCE_FORMAT}.json.gz`;

/**
 * Собирает пакет ролью выгрузки, кладёт в хранилище под префиксом тенанта [Р-23], читает ОБРАТНО и сверяет: строк каждой таблицы столько же,
 * ядро объясняет каждую строку без базы. Только после этого выгрузка записывается в базу — её запись и есть условие удаления
 */
export async function exportClosureEvidence(pgExporter: pg.Pool, sink: ArchiveSink, tenantId: string): Promise<ClosureEvidenceExport> {
  const columnOrder = async (table: string, order: string): Promise<string> => {
    // Порядок — по существующим столбцам таблицы: у разных таблиц имена времени разные, неизвестный столбец не должен ронять выгрузку
    const { rows } = await pgExporter.query(`SELECT attname FROM pg_attribute WHERE attrelid = $1::regclass AND attnum > 0 AND NOT attisdropped`, [table]);
    const known = new Set(rows.map((r) => String(r.attname)));
    const cols = order.split(',').map((c) => c.trim()).filter((c) => known.has(c));
    return cols.length > 0 ? cols.join(', ') : '1';
  };
  const tables: Record<string, PgRow[]> = {};
  for (const { table, order } of EVIDENCE_TABLES) {
    const { rows } = await pgExporter.query(`SELECT * FROM ${table} WHERE tenant_id = $1 ORDER BY ${await columnOrder(table, order)}`, [tenantId]);
    tables[table] = rows;
  }
  const { rows: core } = await pgExporter.query(
    `SELECT * FROM tenant_data.price_intent_core WHERE tenant_id = $1 ORDER BY intent_created_at, price_intent_id`, [tenantId]);
  const refs = [...new Set(core.filter((r) => r.pricing_strategy_id).map((r) => `${r.pricing_strategy_id}|${r.pricing_strategy_version}`))].map((k) => k.split('|'));
  const { rows: strategies } = refs.length === 0 ? { rows: [] as PgRow[] } : await pgExporter.query(
    `SELECT s.* FROM tenant_data.pricing_strategy s JOIN unnest($2::uuid[], $3::int[]) AS ref(id, version) ON ref.id = s.pricing_strategy_id AND ref.version = s.version
      WHERE s.tenant_id = $1 ORDER BY s.pricing_strategy_id, s.version`, [tenantId, refs.map((r) => r[0]), refs.map((r) => Number(r[1]))]);
  const { rows: rulesets } = await pgExporter.query('SELECT ruleset_id, kind, definition FROM platform.explanation_ruleset ORDER BY ruleset_id');
  const bundle: ClosureEvidenceBundle = { format: CLOSURE_EVIDENCE_FORMAT, tenantId, tables, core, dictionary: { strategies, rulesets } };

  const key = closureEvidenceKey(tenantId);
  await sink.put(key, gzipSync(Buffer.from(JSON.stringify(bundle))));
  // Проверка — по прочитанному обратно, а не по объекту в памяти
  const stored = await sink.get(key);
  const back = JSON.parse(gunzipSync(stored).toString('utf8')) as ClosureEvidenceBundle;
  const perTable: Record<string, number> = {};
  for (const { table } of EVIDENCE_TABLES) {
    perTable[table] = back.tables[table]?.length ?? -1;
    if (perTable[table] !== tables[table]!.length) throw new Error(`CLOSURE_EVIDENCE_MISMATCH: ${table} ${perTable[table]} of ${tables[table]!.length} rows read back`);
  }
  perTable['tenant_data.price_intent_core'] = back.core.length;
  const check = verifyCoreArchiveBundle(buildCoreArchiveBundle({ tenantId, partitionName: 'closure', core: back.core, strategies: back.dictionary.strategies, rulesets: back.dictionary.rulesets }));
  const selfContained = check.selfContained && check.rows === core.length;
  if (!selfContained) throw new Error(`CLOSURE_EVIDENCE_NOT_SELF_CONTAINED: ${check.gaps.length} decisions cannot be explained without the database`);
  const rows = Object.values(perTable).reduce((a, n) => a + n, 0);
  const sha256 = createHash('sha256').update(stored).digest('hex');
  await pgExporter.query('SELECT maintenance.record_closure_evidence_export($1, $2, $3)', [tenantId, sha256, rows]);
  return { key, sha256, rows, perTable, selfContained };
}
