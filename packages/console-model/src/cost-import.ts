import { IMPORT_FIELDS, TABLE_ENCODINGS, type ColumnMapping, type ColumnSuggestion, type ImportField, type ImportPreview, type ImportProblem,
  type ImportTargetOffer, type PreviewRow, type Sheet } from '@repracer/cost-import';
import type { Messages } from './i18n/index.ts';
import { gap, scopeById, unitOf, type Gap, type StandWorld, type Tone, type UnitRef } from './world.ts';

/**
 * Р-134 (шаг 28): экран массового импорта себестоимости. Порядок обязателен: файл → сопоставление колонок (с подсказками) →
 * предпросмотр → применение со вторым фактором [Р-135]. Продавец видит ДО применения: сколько строк применится, каких офферов они
 * касаются, какие строки не сопоставились и почему, и сколько офферов останутся без себестоимости (а значит, без репрайсинга, Р-131).
 */

/** Сколько строк-примеров показывать в каждой группе непримененных: список на тысячи строк никто не читает */
export const SKIPPED_EXAMPLES = 5;

export interface ImportPreviewRowView {
  line: number;
  unit: UnitRef | null;
  offerKey: string;
  cost: string;
  fee: string | null;
}

export interface ImportSkippedGroupView {
  problem: ImportProblem;
  rows: number;
  text: string;
  examples: Array<{ line: number; offerKey: string; raw: string | null }>;
}

export interface CostImportView {
  worldId: string;
  headline: string;
  /** Как прочитан файл: формат, разделитель и кодировка — продавец должен узнать свою выгрузку [OQ-200] */
  source: { name: string; format: string; delimiter: string | null; encoding: string | null; encodingConfident: boolean };
  /** Кодировки на выбор: когда уверенности нет, продавца спрашивают, а не угадывают за него */
  encodings: string[];
  columns: Array<{ field: string; column: string; reason: string }>;
  /**
   * Ревью шага 28, находка 8: подсказка не применяется молча — сопоставление можно ИСПРАВИТЬ. Экран получает колонки файла (как
   * они выглядят в таблице продавца, с заголовком и примером значения) и текущее сопоставление каждого поля.
   */
  fileColumns: Array<{ index: number; name: string; header: string; sample: string }>;
  fields: Array<{ field: ImportField; label: string; required: boolean; columnIndex: number | null }>;
  /** Не хватает обязательной колонки: применять нечего, экран говорит об этом первым делом */
  blocked: string | null;
  rows: ImportPreviewRowView[];
  skipped: ImportSkippedGroupView[];
  summary: { apply: number; skipped: number; offersCovered: number; offersMissing: number };
  /** Сколько офферов после импорта всё ещё не смогут включить репрайсинг [Р-131] */
  stillWithoutCost: number;
  tone: Tone;
  mfaRequired: true;
  fingerprint: string;
  gaps: Gap[];
}

/** Строки, которые будут применены: показываются первые N — остальное продавец увидит в отчёте после применения */
export const PREVIEW_ROWS_SHOWN = 20;

export function costImportView(
  world: StandWorld, preview: ImportPreview, source: { name: string; sheet: Sheet; mapping: ColumnMapping },
  suggestions: readonly ColumnSuggestion[], m: Messages,
): CostImportView {
  const t = m.ui.costImport;
  const rows = preview.apply.slice(0, PREVIEW_ROWS_SHOWN).map((r): ImportPreviewRowView => {
    const scope = r.writeScopeId ? scopeById(world, r.writeScopeId) : null;
    return {
      line: r.line,
      unit: scope ? unitOf(world, scope, m) : null,
      offerKey: r.offerKey,
      cost: m.money(r.unitCostMinor ?? null, r.currency ?? 'EUR'),
      fee: feeText(r, m),
    };
  });
  const skipped = preview.skipped.length === 0 ? [] : preview.problems.map((p): ImportSkippedGroupView => ({
    problem: p.problem,
    rows: p.rows,
    text: t.problems[p.problem],
    examples: p.examples.slice(0, SKIPPED_EXAMPLES).map((e) => ({ line: e.line, offerKey: e.offerKey, raw: e.raw ?? null })),
  }));
  const summary = { ...preview.totals };
  return {
    worldId: world.id,
    headline: t.headline(summary),
    source: {
      name: source.name, format: preview.format, delimiter: preview.delimiter ?? null,
      encoding: source.sheet.encoding ?? null, encodingConfident: source.sheet.encodingConfident !== false,
    },
    encodings: [...TABLE_ENCODINGS],
    columns: suggestions.map((s) => ({ field: t.fields[s.field], column: columnName(s.columnIndex), reason: t.reasons[s.reason] })),
    fileColumns: fileColumnsOf(source.sheet),
    fields: IMPORT_FIELDS.map((f) => ({ field: f.field, label: t.fields[f.field], required: f.required, columnIndex: source.mapping[f.field] ?? null })),
    blocked: preview.blocked ? t.blocked(preview.blocked.missing.map((f) => t.fields[f as keyof typeof t.fields] ?? f)) : null,
    rows,
    skipped,
    summary: { apply: summary.apply, skipped: summary.skipped, offersCovered: summary.offersCovered, offersMissing: summary.offersMissing },
    // Р-131: оффер без себестоимости репрайсинг не включит — это и есть цена несопоставленных строк
    stillWithoutCost: summary.offersMissing,
    tone: preview.blocked ? 'warn' : summary.skipped > 0 ? 'unknown' : 'ok',
    mfaRequired: true,
    fingerprint: preview.fingerprint,
    gaps: [gap(m, 'IMPORT_NO_FX'), gap(m, 'IMPORT_OFFER_KEYS')],
  };
}

/** Колонки файла глазами продавца: буква, заголовок и первое непустое значение — по ним он и узнаёт свою выгрузку */
function fileColumnsOf(sheet: Sheet, headerRow = 0): Array<{ index: number; name: string; header: string; sample: string }> {
  const width = sheet.rows.reduce((w, r) => Math.max(w, r.length), 0);
  return Array.from({ length: width }, (_, index) => ({
    index,
    name: columnName(index),
    header: (sheet.rows[headerRow]?.[index] ?? '').trim(),
    sample: (sheet.rows.slice(headerRow + 1).find((r) => (r[index] ?? '').trim() !== '')?.[index] ?? '').trim(),
  }));
}

function feeText(r: PreviewRow, m: Messages): string | null {
  if (r.feeRateBp === undefined && r.fixedFeeMinor === undefined) return null;
  const parts: string[] = [];
  if (r.feeRateBp !== undefined) parts.push(m.percentBp(r.feeRateBp));
  if (r.fixedFeeMinor !== undefined) parts.push(m.money(r.fixedFeeMinor, r.currency ?? 'EUR'));
  return parts.join(' + ');
}

/** Колонка называется так, как её видит продавец в таблице: A, B, …, AA */
export function columnName(index: number): string {
  let n = index + 1;
  let name = '';
  while (n > 0) {
    const rest = (n - 1) % 26;
    name = String.fromCharCode(65 + rest) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

/** Офферы мира глазами импорта: ключи, по которым строка выгрузки может их найти */
export function importTargets(world: StandWorld, m: Messages): ImportTargetOffer[] {
  return world.state.scopes.map((s) => ({
    writeScopeId: s.writeScopeId,
    productId: s.productId,
    // Чем продавец называет оффер в своей выгрузке: наш идентификатор у канала, ссылка на товар канала, EAN
    keys: [s.externalUnitId, s.channelProductRef, s.gtin].filter((k): k is string => typeof k === 'string' && k.trim() !== ''),
    currency: s.currency,
    label: unitOf(world, s, m).label,
  }));
}
