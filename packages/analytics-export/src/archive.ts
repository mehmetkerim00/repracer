import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import type pg from 'pg';
import { expandExplanation, type DecisionExplanation, type ExplanationGap, type ExplanationRow, type ExplanationRuleset, type StrategyDefinition } from '@repracer/pricing-model';
import type { PgRow } from './rows.ts';

/**
 * Архив вечного ядра intent [Р-20, Р-38] — самодостаточный [Р-79]. Слепок объяснения хранит ссылки на справочники [Р-75]:
 * версию стратегии (tenant_data.pricing_strategy — удаляется при закрытии тенанта) и наборы правил и профили Gate
 * (platform.explanation_ruleset). Поэтому в архив тенанта вместе со строками ядра кладутся все версии стратегий и наборы правил,
 * на которые эти строки ссылаются. Перед отметкой экспорта архив читается обратно и каждое объяснение разворачивается
 * без обращения к базе: пробел хотя бы у одной строки — экспорт не подтверждается, и секция ядра не удаляется (0022, 0049).
 *
 * Изоляция [Р-23]: один архив — один тенант, ключ начинается с префикса тенанта; строки другого тенанта — ошибка.
 * Формат — JSON в gzip; столбцовый Parquet пишет ClickHouse своим экспортом, новая библиотека не вводится [Р-87]. Содержимое — строки PostgreSQL как есть.
 */

export const CORE_ARCHIVE_FORMAT = 'core-archive.r79.1';

export interface CoreArchiveBundle {
  format: typeof CORE_ARCHIVE_FORMAT;
  tenantId: string;
  parentTable: 'tenant_data.price_intent_core';
  partitionName: string;
  core: PgRow[];
  dictionary: { strategies: PgRow[]; rulesets: PgRow[] };
}

export interface ArchiveSink {
  put(key: string, body: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
}

/** Хранилище архива в памяти — для тестов; в работе — объектное хранилище с префиксом на тенанта */
export class MemoryArchiveSink implements ArchiveSink {
  readonly objects = new Map<string, Buffer>();
  async put(key: string, body: Buffer): Promise<void> {
    this.objects.set(key, Buffer.from(body));
  }
  async get(key: string): Promise<Buffer> {
    const body = this.objects.get(key);
    if (!body) throw new Error(`archive object ${key} does not exist`);
    return Buffer.from(body);
  }
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const strategyKey = (id: unknown, version: unknown) => `${String(id)}@${Number(version)}`;

export function archiveKey(tenantId: string, parentTable: string, partitionName: string): string {
  if (!/^[0-9a-f-]{36}$/.test(tenantId)) throw new Error(`archive key needs a tenant UUID, got ${tenantId}`);
  return `tenant=${tenantId}/${parentTable}/${partitionName.replace(/^.*\./, '')}.json.gz`;
}

/** Строка ядра → столбцы для развёртывания слепка [Р-80] */
export function coreExplanationRow(r: PgRow): ExplanationRow {
  return {
    outcome: r.decision_outcome, rejectionReason: r.rejection_reason ?? null, reasonParams: r.reason_params ?? {},
    floorMinor: num(r.effective_floor_minor), ceilingMinor: num(r.effective_ceiling_minor), boundDeviationBp: r.bound_deviation_bp ?? null, currency: r.currency,
    gateProfile: r.gate_profile ?? null, sanityRuleset: r.sanity_ruleset ?? null, strategyId: r.pricing_strategy_id ?? null,
    strategyVersion: num(r.pricing_strategy_version), ruleCode: r.rule_code, trigger: r.trigger_type,
    // Р-85: у отклонённой цены из данных конкурентов предложенной цены в ядре нет
    proposedMinor: num(r.proposed_amount_minor),
  };
}

function strategyDefinition(r: PgRow): StrategyDefinition {
  const { deadbandMinor, ...params } = (r.params ?? {}) as Record<string, unknown>;
  return { strategyId: r.pricing_strategy_id, version: Number(r.version), params: params as unknown as StrategyDefinition['params'], deadbandMinor: Number(deadbandMinor ?? 0) };
}

/** Архив тенанта: строки ядра и ровно те версии стратегий и наборы правил, на которые они ссылаются */
export function buildCoreArchiveBundle(input: { tenantId: string; partitionName: string; core: PgRow[]; strategies: PgRow[]; rulesets: PgRow[] }): CoreArchiveBundle {
  const foreign = [...input.core, ...input.strategies].find((r) => r.tenant_id !== input.tenantId);
  if (foreign) throw new Error(`archive of tenant ${input.tenantId} received a row of tenant ${foreign.tenant_id} (Р-23)`);
  // OQ-150 [Р-91]: подрез стратегии в вечном архиве позволяет вывести цену конкурента из опубликованной цены — выгрузка отказывает
  const withUndercut = input.strategies.find((s) => typeof s.params === 'object' && s.params !== null && 'undercutMinor' in (s.params as object));
  if (withUndercut) {
    throw new Error(`strategy version ${String(withUndercut.pricing_strategy_id)}@${String(withUndercut.version)} carries the undercut: it is not archived (Р-91, OQ-150)`);
  }
  const strategyRefs = new Set(input.core.filter((r) => r.pricing_strategy_id !== null && r.pricing_strategy_id !== undefined).map((r) => strategyKey(r.pricing_strategy_id, r.pricing_strategy_version)));
  const rulesetRefs = new Set(input.core.flatMap((r) => [r.gate_profile, r.sanity_ruleset]).filter((x): x is string => typeof x === 'string'));
  return {
    format: CORE_ARCHIVE_FORMAT, tenantId: input.tenantId, parentTable: 'tenant_data.price_intent_core', partitionName: input.partitionName,
    core: input.core,
    dictionary: {
      strategies: input.strategies.filter((s) => strategyRefs.has(strategyKey(s.pricing_strategy_id, s.version))),
      rulesets: input.rulesets.filter((r) => rulesetRefs.has(r.ruleset_id)),
    },
  };
}

/** Развернуть каждое объяснение архива только по самому архиву; пробелы — по строкам */
export function verifyCoreArchiveBundle(bundle: CoreArchiveBundle): { rows: number; selfContained: boolean; gaps: Array<{ priceIntentId: string; gaps: ExplanationGap[] }> } {
  if (bundle.format !== CORE_ARCHIVE_FORMAT) throw new Error(`unknown archive format ${String(bundle.format)}`);
  // OQ-150: проверка читает архив обратно — подрез не проходит и здесь (архивы до 0059 распознаются при первом развёртывании)
  const withUndercut = bundle.dictionary.strategies.find((s) => typeof s.params === 'object' && s.params !== null && 'undercutMinor' in (s.params as object));
  if (withUndercut) {
    throw new Error(`archived strategy version ${String(withUndercut.pricing_strategy_id)}@${String(withUndercut.version)} carries the undercut (Р-91, OQ-150)`);
  }
  const dictionary = {
    strategies: bundle.dictionary.strategies.map(strategyDefinition),
    rulesets: bundle.dictionary.rulesets.map((r) => ({ rulesetId: r.ruleset_id, kind: r.kind, definition: r.definition }) as ExplanationRuleset),
  };
  const gaps: Array<{ priceIntentId: string; gaps: ExplanationGap[] }> = [];
  for (const row of bundle.core) {
    if (row.tenant_id !== bundle.tenantId) throw new Error(`archive of tenant ${bundle.tenantId} holds a row of tenant ${row.tenant_id} (Р-23)`);
    const found = expandExplanation(row.explanation as DecisionExplanation, coreExplanationRow(row), dictionary).gaps;
    if (found.length > 0) gaps.push({ priceIntentId: row.price_intent_id, gaps: found });
  }
  return { rows: bundle.core.length, selfContained: gaps.length === 0, gaps };
}

export const encodeBundle = (bundle: CoreArchiveBundle): Buffer => gzipSync(Buffer.from(JSON.stringify(bundle)));
export const decodeBundle = (body: Buffer): CoreArchiveBundle => JSON.parse(gunzipSync(body).toString('utf8')) as CoreArchiveBundle;

export interface CoreArchiveExport {
  partitionName: string;
  rows: number;
  tenants: number;
  verified: boolean;
  gaps: Array<{ tenantId: string; priceIntentId: string; gaps: ExplanationGap[] }>;
}

/**
 * Месячная секция ядра → архивы тенантов. Роль PostgreSQL — repracer_exporter (чтение через родительскую таблицу).
 * Отметка ARCHIVE в partition_export — с признаком «справочники в архиве» и verified_at только если каждый архив прочитан обратно
 * и развёрнут без пробелов, а строк столько же, сколько в секции.
 */
export async function exportCoreArchive(pgExporter: pg.Pool, sink: ArchiveSink, partitionName: string): Promise<CoreArchiveExport> {
  const parentTable = 'tenant_data.price_intent_core';
  const { rows: [part] } = await pgExporter.query(
    `SELECT pg_get_expr(c.relpartbound, c.oid) AS bound, pg_get_partkeydef($1::regclass) AS key
       FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
      WHERE i.inhparent = $1::regclass AND c.oid::regclass::text = $2`, [parentTable, partitionName]);
  if (!part) throw new Error(`${partitionName} is not a partition of ${parentTable}`);
  const range = /FROM \('([^']+)'\) TO \('([^']+)'\)/.exec(part.bound);
  const keyColumn = /^RANGE \((\w+)\)$/.exec(part.key)?.[1];
  if (!range || !keyColumn) throw new Error(`unexpected partition bound of ${partitionName}: ${part.bound} / ${part.key}`);
  const { rows: core } = await pgExporter.query(
    `SELECT * FROM ${parentTable} WHERE ${keyColumn} >= $1::timestamptz AND ${keyColumn} < $2::timestamptz ORDER BY tenant_id, ${keyColumn}, price_intent_id`,
    [range[1], range[2]]);
  const { rows: rulesets } = await pgExporter.query('SELECT ruleset_id, kind, definition FROM platform.explanation_ruleset ORDER BY ruleset_id');

  const byTenant = new Map<string, PgRow[]>();
  for (const r of core) byTenant.set(r.tenant_id, [...(byTenant.get(r.tenant_id) ?? []), r]);
  const gaps: CoreArchiveExport['gaps'] = [];
  let archived = 0;
  for (const [tenantId, rows] of byTenant) {
    const refs = [...new Set(rows.filter((r) => r.pricing_strategy_id).map((r) => `${r.pricing_strategy_id}|${r.pricing_strategy_version}`))].map((k) => k.split('|'));
    const { rows: strategies } = refs.length === 0 ? { rows: [] as PgRow[] } : await pgExporter.query(
      `SELECT s.* FROM tenant_data.pricing_strategy s JOIN unnest($2::uuid[], $3::int[]) AS ref(id, version) ON ref.id = s.pricing_strategy_id AND ref.version = s.version
        WHERE s.tenant_id = $1`, [tenantId, refs.map((r) => r[0]), refs.map((r) => Number(r[1]))]);
    const key = archiveKey(tenantId, parentTable, partitionName);
    await sink.put(key, encodeBundle(buildCoreArchiveBundle({ tenantId, partitionName, core: rows, strategies, rulesets })));
    // Проверка — по прочитанному обратно архиву, а не по объекту в памяти
    const check = verifyCoreArchiveBundle(decodeBundle(await sink.get(key)));
    archived += check.rows;
    gaps.push(...check.gaps.map((g) => ({ tenantId, ...g })));
  }
  const verified = gaps.length === 0 && archived === core.length;
  const checksum = createHash('sha256');
  for (const id of core.map((r) => r.price_intent_id as string).sort()) checksum.update(id);
  await pgExporter.query(
    `INSERT INTO maintenance.partition_export (parent_table, partition_name, target, exported_rows, checksum, exported_at, verified_at, explanation_dictionary_included)
     VALUES ($1, $2, 'ARCHIVE', $3, $4, now(), CASE WHEN $5 THEN now() END, true)
     ON CONFLICT (partition_name, target) DO UPDATE
       SET exported_rows = EXCLUDED.exported_rows, checksum = EXCLUDED.checksum, exported_at = EXCLUDED.exported_at, verified_at = EXCLUDED.verified_at,
           explanation_dictionary_included = EXCLUDED.explanation_dictionary_included`,
    [parentTable, partitionName, core.length, checksum.digest('hex'), verified]);
  return { partitionName, rows: core.length, tenants: byTenant.size, verified, gaps };
}
