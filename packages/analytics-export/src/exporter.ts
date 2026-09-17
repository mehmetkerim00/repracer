import { createHash } from 'node:crypto';
import type pg from 'pg';
import type { ClickHouseHttp } from './clickhouse.ts';
import { completedWriteRow, intentClassOf, priceDecisionRow, priceIntentNoopRow, priceIntentRow, type PgRow } from './rows.ts';
import { competitorSnapshotRow, type CompetitorSnapshotRow, type SnapshotDeliveryKind, type SnapshotSanityVerdict } from './competitor-history.ts';
import type { CompetitorSnapshot } from '@repracer/channel-port';

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

/** Источники снимков, которые принимает ограничение source_known таблицы competitor_snapshot (030) */
export const CLICKHOUSE_SNAPSHOT_SOURCES: readonly string[] = [
  'AMAZON_ANY_OFFER_CHANGED', 'AMAZON_COMPETITIVE_SUMMARY', 'KAUFLAND_BUY_BOX_CHANGED', 'KAUFLAND_BUYBOX', 'KAUFLAND_COMPETITORS_COMPARER',
];
/** Валюты ограничения currency_supported (050) */
const CLICKHOUSE_CURRENCIES = new Set(['EUR', 'USD']);

const SNAPSHOT_EXPORT_CHUNK = 2_000;

export type SnapshotSkipReason = 'NO_PRICES' | 'CURRENCY_UNSUPPORTED' | 'SOURCE_UNKNOWN' | 'CHANNEL_UNSUPPORTED' | 'COMPLETENESS_INVALID';

/**
 * Строка журнала снимков PostgreSQL (0086) → строка ClickHouse. Снимок, который ограничения ClickHouse отклонили бы (без цен, валюта вне
 * EUR/USD — например, отклонённый проверкой входов CURRENCY_MISMATCH, неизвестный источник), не выгружается: он пропускается с причиной,
 * а не срывает выгрузку суток. Пропуск виден в итоге экспорта; сутки с пропусками не отмечаются проверенными (ревью шага 24, находка 5).
 */
export function snapshotLogRow(row: PgRow, storefront?: { currency: string; basis: string }): { ok: true; row: CompetitorSnapshotRow } | { ok: false; reason: SnapshotSkipReason } {
  const channel = String(row.channel);
  if (channel !== 'KAUFLAND' && channel !== 'AMAZON') return { ok: false, reason: 'CHANNEL_UNSUPPORTED' };
  const snapshot = row.snapshot as CompetitorSnapshot;
  if (!CLICKHOUSE_SNAPSHOT_SOURCES.includes(snapshot.source)) return { ok: false, reason: 'SOURCE_UNKNOWN' };
  if (snapshot.completeness?.kind === 'TOP_N' && !(snapshot.completeness.n > 0)) return { ok: false, reason: 'COMPLETENESS_INVALID' };
  // OQ-181 (шаг 25): снимок без цен — наблюдение «конкурентов нет», нужное бэктесту: валюта и база цены — из справочника витрины
  const currency = snapshot.buybox?.price.currency ?? snapshot.offers?.[0]?.price.currency ?? storefront?.currency;
  if (!currency || !(snapshot.buybox?.price.basis ?? snapshot.offers?.[0]?.price.basis ?? storefront?.basis)) return { ok: false, reason: 'NO_PRICES' };
  if (!CLICKHOUSE_CURRENCIES.has(currency)) return { ok: false, reason: 'CURRENCY_UNSUPPORTED' };
  const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));
  return {
    ok: true,
    row: competitorSnapshotRow(String(row.tenant_id), String(row.channel_account_id), channel, String(row.competitor_snapshot_id), snapshot, iso(row.received_at),
      row.sanity_verdict as SnapshotSanityVerdict, row.delivery as SnapshotDeliveryKind, storefront),
  };
}

/**
 * Р-122 (шаг 24): сутки журнала снимков конкурентов → repracer_analytics.competitor_snapshot. Проверка — число строк суток в ClickHouse
 * (FINAL) равно выгруженному; только после неё verified_at, и секция журнала удаляется по сроку (0086, requires_export CLICKHOUSE).
 */
export async function exportCompetitorSnapshotsDay(pgExporter: pg.Pool, ingest: ClickHouseHttp, verifier: ClickHouseHttp, range: DayRange): Promise<PartitionExport & { skipped: Partial<Record<SnapshotSkipReason, number>> }> {
  // Сутки читаются частями по ключу секции (находка 6 ревью шага 24): в памяти процесса — не больше части полных снимков
  const mapped: CompetitorSnapshotRow[] = [];
  const skipped: Partial<Record<SnapshotSkipReason, number>> = {};
  const ids: string[] = [];
  const skips: Array<{ tenant: string; id: string; at: unknown; reason: SnapshotSkipReason }> = [];
  const { rows: storefronts } = await pgExporter.query('SELECT channel, marketplace, currency, price_basis FROM platform.marketplace');
  const storefrontOf = new Map(storefronts.map((m) => [`${m.channel}|${m.marketplace}`, { currency: String(m.currency), basis: String(m.price_basis) }]));
  let after: { at: Date; id: string } | null = null;
  for (;;) {
    const { rows: part }: { rows: PgRow[] } = await pgExporter.query(
      `SELECT * FROM channel_data.competitor_snapshot_log
        WHERE received_at >= $1::timestamptz AND received_at < $2::timestamptz AND ($3::timestamptz IS NULL OR (received_at, competitor_snapshot_id) > ($3::timestamptz, $4::uuid))
        ORDER BY received_at, competitor_snapshot_id LIMIT ${SNAPSHOT_EXPORT_CHUNK}`, [range.from, range.to, after?.at ?? null, after?.id ?? null]);
    for (const r of part) {
      ids.push(String(r.competitor_snapshot_id));
      const m = snapshotLogRow(r, storefrontOf.get(`${r.channel}|${r.marketplace}`));
      if (m.ok) mapped.push(m.row);
      else {
        skipped[m.reason] = (skipped[m.reason] ?? 0) + 1;
        skips.push({ tenant: String(r.tenant_id), id: String(r.competitor_snapshot_id), at: r.received_at, reason: m.reason });
      }
    }
    if (part.length < SNAPSHOT_EXPORT_CHUNK) break;
    const last: PgRow = part.at(-1)!;
    after = { at: last.received_at as Date, id: String(last.competitor_snapshot_id) };
  }
  const rows = ids;
  await insertChunks(ingest, 'competitor_snapshot', mapped as unknown as PgRow[], 'competitor_snapshot_id', range.from);
  const exportedIds = mapped.map((r) => r.competitor_snapshot_id);
  const partitionName = await dayPartitionName(pgExporter, 'channel_data.competitor_snapshot_log', range);
  // OQ-181: каждый пропуск — запись для разбора человеком; сутки проверены, только если все пропуски разобраны (база отклоняет иное)
  for (let i = 0; i < skips.length; i += 1_000) {
    await pgExporter.query(
      `INSERT INTO maintenance.snapshot_export_skip (subject_tenant_id, competitor_snapshot_id, partition_name, received_at, reason)
       SELECT s.tenant, s.id, $2, s.at, s.reason FROM jsonb_to_recordset($1::jsonb) AS s(tenant uuid, id uuid, at timestamptz, reason text)
       ON CONFLICT (competitor_snapshot_id) DO NOTHING`, [JSON.stringify(skips.slice(i, i + 1_000)), partitionName]);
  }
  const { rows: [open] } = await pgExporter.query(
    `SELECT count(*)::int AS n FROM maintenance.snapshot_export_skip s WHERE s.partition_name = $1
        AND NOT EXISTS (SELECT 1 FROM maintenance.snapshot_export_skip_resolution r WHERE r.competitor_snapshot_id = s.competitor_snapshot_id)`, [partitionName]);
  const unresolvedSkips = Number(open.n);
  // Та же выборка строк, что выгружена: по идентификаторам суток (у строк ClickHouse до шага 24 журнала не было)
  let verifiedCount = 0;
  for (let i = 0; i < exportedIds.length; i += 5_000) {
    const chunk = exportedIds.slice(i, i + 5_000).map((id) => `'${id.replace(/[^0-9a-f-]/g, '')}'`).join(',');
    verifiedCount += Number((await verifier.rows<{ n: number }>(
      `SELECT count() AS n FROM repracer_analytics.competitor_snapshot FINAL
        WHERE received_at >= parseDateTime64BestEffort('${range.from}', 3) AND received_at < parseDateTime64BestEffort('${range.to}', 3)
          AND competitor_snapshot_id IN (${chunk})`))[0]?.n ?? 0);
  }
  const result = {
    parentTable: 'channel_data.competitor_snapshot_log', partitionName,
    // Неразобранный пропуск: сутки не проверены, секция не удаляется по сроку, пока человек не разберёт пропуск (OQ-181)
    target: 'CLICKHOUSE', rows: rows.length, checksum: checksum(rows), verified: verifiedCount === mapped.length && unresolvedSkips === 0,
    byTable: { competitor_snapshot: mapped.length }, skipped,
  };
  await recordExport(pgExporter, result);
  return result;
}


/** OQ-181 (шаг 25): пропущенные выгрузкой снимки — для разбора человеком; неразобранные первыми */
export interface SnapshotExportSkip {
  competitorSnapshotId: string;
  subjectTenantId: string;
  partitionName: string;
  receivedAt: string;
  reason: SnapshotSkipReason;
  resolution: { resolution: 'LOSS_ACCEPTED' | 'EXPORTED_AFTER_FIX'; resolvedBy: string; note: string; resolvedAt: string } | null;
}

export async function listSnapshotExportSkips(pgExporter: pg.Pool, options: { unresolvedOnly?: boolean; limit?: number } = {}): Promise<SnapshotExportSkip[]> {
  const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));
  const { rows } = await pgExporter.query(
    `SELECT s.competitor_snapshot_id, s.subject_tenant_id, s.partition_name, s.received_at, s.reason, r.resolution, r.resolved_by, r.note, r.resolved_at
       FROM maintenance.snapshot_export_skip s LEFT JOIN maintenance.snapshot_export_skip_resolution r ON r.competitor_snapshot_id = s.competitor_snapshot_id
      WHERE NOT $1::boolean OR r.competitor_snapshot_id IS NULL
      ORDER BY (r.competitor_snapshot_id IS NULL) DESC, s.received_at LIMIT $2`, [options.unresolvedOnly ?? false, options.limit ?? 500]);
  return rows.map((r) => ({
    competitorSnapshotId: r.competitor_snapshot_id, subjectTenantId: r.subject_tenant_id, partitionName: r.partition_name, receivedAt: iso(r.received_at), reason: r.reason,
    resolution: r.resolution ? { resolution: r.resolution, resolvedBy: r.resolved_by, note: r.note, resolvedAt: iso(r.resolved_at) } : null,
  }));
}

/** Разбор пропуска человеком: потеря принята или снимок выгружен после исправления; имя оператора и заметка обязательны (база) */
export async function resolveSnapshotExportSkip(pgExporter: pg.Pool, input: { competitorSnapshotId: string; resolution: 'LOSS_ACCEPTED' | 'EXPORTED_AFTER_FIX'; resolvedBy: string; note: string }): Promise<void> {
  await pgExporter.query(
    `INSERT INTO maintenance.snapshot_export_skip_resolution (competitor_snapshot_id, resolution, resolved_by, note) VALUES ($1, $2, $3, $4)`,
    [input.competitorSnapshotId, input.resolution, input.resolvedBy, input.note]);
}
