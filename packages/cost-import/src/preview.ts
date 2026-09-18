import type { ColumnMapping } from './columns.ts';
import { missingRequiredFields } from './columns.ts';
import type { Sheet } from './table.ts';

/**
 * Р-134 (шаг 28): предпросмотр импорта себестоимости. Экран показывает его ДО применения: сколько строк будет применено, каких офферов
 * они касаются и какие строки не сопоставились — с причиной у каждой. Применяется только то, что показано, и целиком: частичного
 * применения нет [Р-134], а сам список строк закрепляется отпечатком (`fingerprint`) — применить можно ровно показанное.
 */
export type ImportProblem =
  | 'OFFER_NOT_FOUND'
  | 'OFFER_AMBIGUOUS'
  | 'OFFER_KEY_EMPTY'
  | 'COST_MISSING'
  | 'COST_NOT_A_NUMBER'
  | 'COST_AMBIGUOUS_SEPARATOR'
  | 'COST_NEGATIVE'
  | 'COST_TOO_LARGE'
  | 'CURRENCY_UNSUPPORTED'
  | 'CURRENCY_NOT_OF_OFFER'
  | 'FEE_RATE_OUT_OF_RANGE'
  | 'FEE_NOT_A_NUMBER'
  | 'FEE_AMBIGUOUS_FRACTION'
  | 'DUPLICATE_OFFER';

export const IMPORT_PROBLEMS: readonly ImportProblem[] = [
  'OFFER_NOT_FOUND', 'OFFER_AMBIGUOUS', 'OFFER_KEY_EMPTY', 'COST_MISSING', 'COST_NOT_A_NUMBER', 'COST_AMBIGUOUS_SEPARATOR',
  'COST_NEGATIVE', 'COST_TOO_LARGE', 'CURRENCY_UNSUPPORTED', 'CURRENCY_NOT_OF_OFFER', 'FEE_RATE_OUT_OF_RANGE', 'FEE_NOT_A_NUMBER',
  'FEE_AMBIGUOUS_FRACTION', 'DUPLICATE_OFFER',
];

/** Оффер продавца глазами импорта: чем он может быть назван в выгрузке и в какой валюте его цена */
export interface ImportTargetOffer {
  writeScopeId: string;
  productId: string;
  /** Ключи, по которым строка выгрузки может найти этот оффер: SKU товара, идентификатор у канала, EAN */
  keys: readonly string[];
  currency: string;
  /** Что показать продавцу в предпросмотре */
  label: string;
}

export interface PreviewRow {
  /** Номер строки в файле, как его видит продавец (заголовок — строка 1) */
  line: number;
  offerKey: string;
  writeScopeId?: string;
  productId?: string;
  label?: string;
  unitCostMinor?: number;
  currency?: string;
  fixedFeeMinor?: number;
  feeRateBp?: number;
  problem?: ImportProblem;
  /** Значение, из-за которого строка не сопоставилась, — как оно записано в файле */
  raw?: string;
}

export interface ImportPreview {
  format: Sheet['format'];
  delimiter?: string;
  headerRow: number;
  /** Строки, которые будут применены — ровно они и никакие другие */
  apply: PreviewRow[];
  /** Строки, которые применены НЕ будут, с причиной у каждой */
  skipped: PreviewRow[];
  totals: { rows: number; apply: number; skipped: number; offersCovered: number; offersMissing: number };
  problems: Array<{ problem: ImportProblem; rows: number; examples: PreviewRow[] }>;
  /** Отпечаток применяемого набора: применить можно только показанное (см. `fingerprintOf`) */
  fingerprint: string;
  /** Импорт невозможен целиком: не хватает обязательной колонки */
  blocked?: { missing: string[] };
}

const MAX_UNIT_COST_MINOR = 1_000_000_000;
const EXAMPLES_PER_PROBLEM = 5;

/**
 * Число из выгрузки: «10,50», «1 234,56», «1,234.56», «10.5» — одно и то же. Разделитель дробной части — последний из «,» и «.»,
 * остальные такие знаки и пробелы считаются разделителями тысяч. Минорные единицы — два знака (EUR и USD, Р-57).
 * Ревью шага 28, находка 3: «10.505» — это либо десять тысяч пятьсот пять, либо десять с половиной. Угадывать нельзя: ошибка в
 * тысячу раз ломает пол маржи молча. Неоднозначное число — отдельная причина в списке непримененных, а не догадка.
 */
export function parseMoneyMinor(raw: string): { ok: true; minor: number } | { ok: false; problem: 'COST_NOT_A_NUMBER' | 'COST_AMBIGUOUS_SEPARATOR' | 'COST_NEGATIVE' | 'COST_TOO_LARGE' } {
  const text = raw.trim().replace(/\s| |'/g, '').replace(/^(EUR|USD|€|\$)/i, '').replace(/(EUR|USD|€|\$)$/i, '');
  if (text === '') return { ok: false, problem: 'COST_NOT_A_NUMBER' };
  if (!/^-?[\d.,]+$/.test(text)) return { ok: false, problem: 'COST_NOT_A_NUMBER' };
  const lastComma = text.lastIndexOf(',');
  const lastDot = text.lastIndexOf('.');
  const separator = Math.max(lastComma, lastDot);
  const fraction = separator >= 0 ? text.slice(separator + 1) : '';
  const separators = (text.match(/[.,]/g) ?? []).length;
  const isFraction = separator >= 0 && fraction.length > 0 && fraction.length <= 2 && /^\d+$/.test(fraction);
  // Ровно три знака после последнего разделителя — разделитель тысяч, но только когда разделителей несколько («1.234.567»);
  // одинокое «1.234» неоднозначно
  const isThousands = separator < 0 || (fraction.length === 3 && separators >= 2 && /^\d+$/.test(fraction));
  if (!isFraction && !isThousands) return { ok: false, problem: 'COST_AMBIGUOUS_SEPARATOR' };
  const whole = (isFraction ? text.slice(0, separator) : text).replace(/[.,]/g, '');
  if (!/^-?\d+$/.test(whole) || (isFraction && !/^\d+$/.test(fraction))) return { ok: false, problem: 'COST_NOT_A_NUMBER' };
  const negative = whole.startsWith('-');
  const minor = Number(whole.replace('-', '')) * 100 + (isFraction ? Number(fraction.padEnd(2, '0')) : 0);
  if (!Number.isSafeInteger(minor)) return { ok: false, problem: 'COST_TOO_LARGE' };
  if (negative) return { ok: false, problem: 'COST_NEGATIVE' };
  if (minor > MAX_UNIT_COST_MINOR) return { ok: false, problem: 'COST_TOO_LARGE' };
  return { ok: true, minor };
}

/**
 * Комиссия: «15», «15 %», «15,5%» — базисные пункты. Доля («0,15») неотличима от 0,15 %, а разница — в сто раз: заниженная
 * комиссия опускает пол маржи, и продавец уходит ниже себестоимости (ревью шага 28, находка 4). Поэтому меньше процента
 * принимается, только если в файле явно стоит знак процента; иначе строка перечисляется с причиной.
 */
export function parseFeeRateBp(raw: string): { ok: true; bp: number } | { ok: false; problem: 'FEE_NOT_A_NUMBER' | 'FEE_RATE_OUT_OF_RANGE' | 'FEE_AMBIGUOUS_FRACTION' } {
  const percentSign = raw.includes('%');
  const text = raw.trim().replace(/\s| /g, '').replace(/%$/, '');
  if (text === '') return { ok: false, problem: 'FEE_NOT_A_NUMBER' };
  const money = parseMoneyMinor(text);
  if (!money.ok) {
    return { ok: false, problem: money.problem === 'COST_NOT_A_NUMBER' || money.problem === 'COST_AMBIGUOUS_SEPARATOR' ? 'FEE_NOT_A_NUMBER' : 'FEE_RATE_OUT_OF_RANGE' };
  }
  const bp = money.minor;
  if (bp >= 10_000) return { ok: false, problem: 'FEE_RATE_OUT_OF_RANGE' };
  if (bp > 0 && bp < 100 && !percentSign) return { ok: false, problem: 'FEE_AMBIGUOUS_FRACTION' };
  return { ok: true, bp };
}

/** Ключ оффера сравнивается без регистра и без пробелов по краям: в выгрузках их всегда набирают по-разному */
const keyOf = (value: string) => value.trim().toLowerCase();

export interface PreviewInput {
  sheet: Sheet;
  mapping: ColumnMapping;
  offers: readonly ImportTargetOffer[];
  headerRow?: number;
  /** Валюта по умолчанию, если колонки валюты в файле нет: валюта самого оффера */
  now?: string;
}

export function buildPreview(input: PreviewInput): ImportPreview {
  const headerRow = input.headerRow ?? 0;
  const missing = missingRequiredFields(input.mapping);
  const byKey = new Map<string, ImportTargetOffer[]>();
  for (const offer of input.offers) {
    for (const key of offer.keys) {
      const k = keyOf(key);
      if (k === '') continue;
      byKey.set(k, [...(byKey.get(k) ?? []), offer]);
    }
  }
  const apply: PreviewRow[] = [];
  const skipped: PreviewRow[] = [];
  const seenOffers = new Map<string, number>();
  const body = input.sheet.rows.slice(headerRow + 1);
  if (missing.length > 0) {
    return {
      format: input.sheet.format, ...(input.sheet.delimiter ? { delimiter: input.sheet.delimiter } : {}), headerRow,
      apply: [], skipped: [], problems: [], fingerprint: fingerprintOf([]),
      totals: { rows: body.length, apply: 0, skipped: body.length, offersCovered: 0, offersMissing: input.offers.length },
      blocked: { missing },
    };
  }
  const cell = (row: readonly string[], field: keyof ColumnMapping) => {
    const index = input.mapping[field];
    return index === undefined ? '' : (row[index] ?? '');
  };
  body.forEach((row, i) => {
    // Номер строки продавец использует, чтобы найти её в своей таблице: он берётся из файла, а не считается по порядку
    const line = input.sheet.lines[headerRow + 1 + i] ?? headerRow + 2 + i;
    const offerKey = cell(row, 'offerKey').trim();
    const costRaw = cell(row, 'unitCostMinor').trim();
    const currencyRaw = cell(row, 'currency').trim().toUpperCase();
    const feeRaw = cell(row, 'feeRateBp').trim();
    const fixedRaw = cell(row, 'fixedFeeMinor').trim();
    const base: PreviewRow = { line, offerKey };
    const reject = (problem: ImportProblem, raw?: string) => skipped.push({ ...base, problem, ...(raw === undefined ? {} : { raw }) });
    if (offerKey === '') { reject('OFFER_KEY_EMPTY'); return; }
    const matches = byKey.get(keyOf(offerKey)) ?? [];
    if (matches.length === 0) { reject('OFFER_NOT_FOUND', offerKey); return; }
    if (matches.length > 1) { reject('OFFER_AMBIGUOUS', offerKey); return; }
    const offer = matches[0]!;
    if (costRaw === '') { reject('COST_MISSING'); return; }
    const cost = parseMoneyMinor(costRaw);
    if (!cost.ok) { reject(cost.problem, costRaw); return; }
    const currency = currencyRaw === '' ? offer.currency : currencyRaw;
    if (!/^(EUR|USD)$/.test(currency)) { reject('CURRENCY_UNSUPPORTED', currencyRaw || currency); return; }
    // Р-61 разрешает себестоимость в валюте её возникновения, но у импорта перевода нет: пересчёт по курсу — отдельное решение,
    // а молча принять число «в другой валюте» значит соврать про пол маржи
    if (currency !== offer.currency) { reject('CURRENCY_NOT_OF_OFFER', currencyRaw); return; }
    const parsed: PreviewRow = {
      ...base, writeScopeId: offer.writeScopeId, productId: offer.productId, label: offer.label,
      unitCostMinor: cost.minor, currency,
    };
    if (fixedRaw !== '') {
      const fixed = parseMoneyMinor(fixedRaw);
      if (!fixed.ok) { reject(fixed.problem === 'COST_NOT_A_NUMBER' ? 'FEE_NOT_A_NUMBER' : fixed.problem, fixedRaw); return; }
      parsed.fixedFeeMinor = fixed.minor;
    }
    if (feeRaw !== '') {
      const fee = parseFeeRateBp(feeRaw);
      if (!fee.ok) { reject(fee.problem, feeRaw); return; }
      parsed.feeRateBp = fee.bp;
    }
    const already = seenOffers.get(offer.writeScopeId);
    if (already !== undefined) {
      // Тот же оффер дважды: какая из строк верная — знает только продавец, поэтому не применяется ни одна
      const first = apply.findIndex((r) => r.writeScopeId === offer.writeScopeId);
      if (first >= 0) skipped.push({ ...apply[first]!, problem: 'DUPLICATE_OFFER', raw: offerKey });
      if (first >= 0) apply.splice(first, 1);
      skipped.push({ ...parsed, problem: 'DUPLICATE_OFFER', raw: offerKey });
      return;
    }
    seenOffers.set(offer.writeScopeId, line);
    apply.push(parsed);
  });
  const problems = new Map<ImportProblem, PreviewRow[]>();
  for (const row of skipped) {
    const list = problems.get(row.problem!) ?? [];
    list.push(row);
    problems.set(row.problem!, list);
  }
  const covered = new Set(apply.map((r) => r.writeScopeId!));
  return {
    format: input.sheet.format, ...(input.sheet.delimiter ? { delimiter: input.sheet.delimiter } : {}), headerRow,
    apply, skipped,
    totals: {
      rows: body.length, apply: apply.length, skipped: skipped.length,
      offersCovered: covered.size, offersMissing: input.offers.filter((o) => !covered.has(o.writeScopeId)).length,
    },
    problems: IMPORT_PROBLEMS.filter((p) => problems.has(p)).map((problem) => ({
      problem, rows: problems.get(problem)!.length, examples: problems.get(problem)!.slice(0, EXAMPLES_PER_PROBLEM),
    })),
    fingerprint: fingerprintOf(apply),
  };
}

/**
 * Отпечаток применяемого набора: применение сверяет его с тем, что показал предпросмотр. Иначе между «посмотрел» и «применил»
 * в набор можно подставить другие строки — как у массовой правки границ со слепком различий (шаг 21).
 */
export function fingerprintOf(rows: readonly PreviewRow[]): string {
  const text = rows.map((r) => `${r.writeScopeId}|${r.unitCostMinor}|${r.currency}|${r.fixedFeeMinor ?? ''}|${r.feeRateBp ?? ''}`).join('\n');
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c + i, 0x85ebca6b) >>> 0;
  }
  return `${rows.length}:${h1.toString(16)}${h2.toString(16)}`;
}
