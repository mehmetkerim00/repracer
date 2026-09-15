import { createHash } from 'node:crypto';
import type pg from 'pg';
import type { ClickHouseHttp } from './clickhouse.ts';
import { completedWriteRow, intentClassOf, priceDecisionRow, priceIntentNoopRow, priceIntentRow, type PgRow } from './rows.ts';

/**
 * Экспорт дневных секций PostgreSQL в ClickHouse [Р-20]. Роль PostgreSQL — repracer_exporter (чтение транзитных таблиц
 * всех тенантов через родительскую таблицу: секции напрямую недоступны); роль ClickHouse — repracer_ingest (только вставка).
 * Проверка — отдельной ролью с чтением (repracer_retention): число строк дня в ClickHouse (FINAL) равно выгруженному.
 * Только после проверки в maintenance.partition_export ставится verified_at — без неё секция не удаляется (0022, 0025).
 * Повтор экспорта той же секции идемпотентен: токен дедупликации части — таблица, день, номер части, контрольная сумма id.
 */

export interface DayRange {
  /** Начало суток UTC, включительно */
  from: string;
  /** Конец суток UTC, не включительно */
  to: string;
}

export interface PartitionExport {
  parentTable: string;
  partitionName: string;
  target: string;
  rows: number;
  checksum: string;
  verified: boolean;
  byTable: Record<string, number>;
}

const CHUNK = 5_000;

function checksum(ids: readonly string[]): string {
  const h = createHash('sha256');
  for (const id of [...ids].sort()) h.update(id);
  return h.digest('hex');
}

async function insertChunks(ch: ClickHouseHttp, table: string, rows: PgRow[], idColumn: string, dayFrom: string): Promise<void> {
  for (let i = 0, part = 0; i < rows.length; i += CHUNK, part++) {
    const chunk = rows.slice(i, i + CHUNK);
    const token = `${table}|${dayFrom}|${part}|${checksum(chunk.map((r) => String(r[idColumn])))}`;
    await ch.insert(`repracer_analytics.${table}`, chunk, token);
  }
}

/** Секция родительской таблицы, покрывающая сутки (RANGE-секции по дням) */
export async function dayPartitionName(pool: pg.Pool, parentTable: string, range: DayRange): Promise<string> {
  const { rows } = await pool.query(
    `SELECT c.oid::regclass::text AS name, pg_get_expr(c.relpartbound, c.oid) AS bound
       FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
      WHERE i.inhparent = $1::regclass`, [parentTable]);
  const from = Date.parse(range.from);
  for (const r of rows) {
    const m = /FROM \('([^']+)'\) TO \('([^']+)'\)/.exec(r.bound);
    if (m && Date.parse(m[1]!) <= from && from < Date.parse(m[2]!)) return r.name;
  }
  throw new Error(`no partition of ${parentTable} covers ${range.from}`);
}

async function recordExport(pool: pg.Pool, result: Omit<PartitionExport, 'byTable'>): Promise<void> {
  await pool.query(
    `INSERT INTO maintenance.partition_export (parent_table, partition_name, target, exported_rows, checksum, exported_at, verified_at)
     VALUES ($1, $2, $3, $4, $5, now(), CASE WHEN $6 THEN now() END)
     ON CONFLICT (partition_name, target) DO UPDATE
       SET exported_rows = EXCLUDED.exported_rows, checksum = EXCLUDED.checksum, exported_at = EXCLUDED.exported_at, verified_at = EXCLUDED.verified_at`,
    [result.parentTable, result.partitionName, result.target, result.rows, result.checksum, result.verified]);
}

/** Сутки intent и решений: intent с created_at в сутках, решения по intent_created_at — одна секция intent и одна решений */
export async function exportDecisionDay(pgExporter: pg.Pool, ingest: ClickHouseHttp, verifier: ClickHouseHttp, range: DayRange): Promise<PartitionExport[]> {
  const { rows: intents } = await pgExporter.query(
    `SELECT * FROM channel_data.price_intent WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz`, [range.from, range.to]);
  const { rows: decisions } = await pgExporter.query(
    `SELECT * FROM channel_data.price_decision WHERE intent_created_at >= $1::timestamptz AND intent_created_at < $2::timestamptz`, [range.from, range.to]);
  const decisionByIntent = new Map<string, PgRow>(decisions.map((d) => [d.price_intent_id, d]));

  const kept: PgRow[] = [];
  const noop: PgRow[] = [];
  for (const intent of intents) {
    const decision = decisionByIntent.get(intent.price_intent_id);
    const cls = intentClassOf(intent, decision);
    if (cls === 'NO_OP') noop.push(priceIntentNoopRow(intent, decision));
    else kept.push(priceIntentRow(intent, cls));
  }
  const keptDecisions = decisions.filter((d) => d.intent_class !== 'NO_OP').map(priceDecisionRow);

  await insertChunks(ingest, 'price_intent', kept, 'price_intent_id', range.from);
  await insertChunks(ingest, 'price_intent_noop', noop, 'price_intent_id', range.from);
  await insertChunks(ingest, 'price_decision', keptDecisions, 'price_decision_id', range.from);

  const count = async (table: string, column: string) => Number((await verifier.rows<{ n: number }>(
    `SELECT count() AS n FROM repracer_analytics.${table} FINAL WHERE ${column} >= parseDateTime64BestEffort('${range.from}', 3) AND ${column} < parseDateTime64BestEffort('${range.to}', 3)`))[0]?.n ?? 0);
  const intentsVerified = (await count('price_intent', 'created_at')) === kept.length && (await count('price_intent_noop', 'created_at')) === noop.length;
  const decisionsVerified = (await count('price_decision', 'intent_created_at')) === keptDecisions.length;

  const results: PartitionExport[] = [
    {
      parentTable: 'channel_data.price_intent', partitionName: await dayPartitionName(pgExporter, 'channel_data.price_intent', range), target: 'CLICKHOUSE',
      rows: intents.length, checksum: checksum(intents.map((r) => r.price_intent_id)), verified: intentsVerified,
      byTable: { price_intent: kept.length, price_intent_noop: noop.length },
    },
    {
      parentTable: 'channel_data.price_decision', partitionName: await dayPartitionName(pgExporter, 'channel_data.price_decision', range), target: 'CLICKHOUSE',
      // NO_OP-решения в аналитический слой не копируются отдельно: итог — в строке price_intent_noop
      rows: decisions.length, checksum: checksum(decisions.map((r) => r.price_decision_id)), verified: decisionsVerified,
      byTable: { price_decision: keptDecisions.length },
    },
  ];
  for (const r of results) await recordExport(pgExporter, r);
  return results;
}

export async function exportCompletedWritesDay(pgExporter: pg.Pool, ingest: ClickHouseHttp, verifier: ClickHouseHttp, range: DayRange): Promise<PartitionExport> {
  const { rows } = await pgExporter.query(
    `SELECT * FROM tenant_data.channel_write_history WHERE finished_at >= $1::timestamptz AND finished_at < $2::timestamptz`, [range.from, range.to]);
  const mapped = rows.map(completedWriteRow);
  await insertChunks(ingest, 'channel_write_completed', mapped, 'channel_write_id', range.from);
  const verifiedCount = Number((await verifier.rows<{ n: number }>(
    `SELECT count() AS n FROM repracer_analytics.channel_write_completed FINAL
      WHERE finished_at >= parseDateTime64BestEffort('${range.from}', 3) AND finished_at < parseDateTime64BestEffort('${range.to}', 3)`))[0]?.n ?? 0);
  const result: PartitionExport = {
    parentTable: 'tenant_data.channel_write_history', partitionName: await dayPartitionName(pgExporter, 'tenant_data.channel_write_history', range),
    target: 'CLICKHOUSE', rows: rows.length, checksum: checksum(rows.map((r) => r.channel_write_id)), verified: verifiedCount === rows.length,
    byTable: { channel_write_completed: mapped.length },
  };
  await recordExport(pgExporter, result);
  return result;
}
