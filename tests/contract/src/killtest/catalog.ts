import { parseMoneyMinor, readTable, TableReadError, currencyInCell } from '@repracer/cost-import';

/**
 * Шаг 71: kill-test — каталог клиента из его файла (CSV, TSV, XLSX). Выгрузки Seller Central отличаются набором и названиями колонок,
 * поэтому известные колонки узнаются по ТАБЛИЦЕ названий ниже, а неизвестные игнорируются и перечисляются в отчёте — клиент видит,
 * что мы прочитали, а что нет. Чтение байтов, кодировка и разделитель — тем же `readTable`, что у импорта себестоимости [Р-134]; суммы —
 * тем же `parseMoneyMinor` (неоднозначное «10.505» — причина, а не догадка).
 *
 * Названия колонок отчётов Seller Central («seller-sku», «your-price», «afn-fulfillable-quantity», «Units Ordered») снимком
 * спецификации не подтверждены — (проверить) на первом настоящем файле клиента; таблица дополняется строкой, код не меняется.
 */

export type CatalogField = 'sku' | 'title' | 'asin' | 'price' | 'quantity' | 'cost' | 'sales30d' | 'currency';

/** Названия колонок по полю: сравнение без регистра, «-» и «_» — как пробел, лишние пробелы схлопываются */
export const COLUMN_ALIASES: Readonly<Record<CatalogField, readonly string[]>> = {
  sku: ['sku', 'seller sku', 'merchant sku', 'msku', 'item sku'],
  title: ['title', 'item name', 'product name', 'name'],
  asin: ['asin', 'asin1', '(child) asin', 'child asin'],
  price: ['price', 'your price', 'item price', 'current price', 'listing price'],
  quantity: ['quantity', 'qty', 'available', 'stock', 'mfn fulfillable quantity', 'afn fulfillable quantity', 'fulfillable quantity'],
  cost: ['cost', 'unit cost', 'cogs', 'cost price', 'purchase price', 'landed cost'],
  sales30d: ['units ordered', 'units sold', 'sales 30d', 'sales (30 days)', 'units (30 days)', '30 day sales', 'sales last 30 days'],
  // Шаг 72: валюта строки — цена и себестоимость в ней; не доллары — строка не годится, и отчёт называет валюту
  currency: ['currency', 'currency code', 'price currency'],
};

/** Обязательные поля: без SKU и цены решения о цене нет */
export const REQUIRED_FIELDS: readonly CatalogField[] = ['sku', 'price'];

/**
 * НАШ предел SKU — 40 знаков, тот же, что у плана записи адаптера Amazon. Что это предел самого Amazon, снимком не подтверждено
 * (проверить) — отчёт и говорит «we accept at most 40» (шаг 75, ревью шага 71, находка 25)
 */
export const SKU_MAX = 40;
export const ROWS_MAX = 20_000;

export type RowProblem =
  | 'NO_SKU' | 'SKU_TOO_LONG' | 'DUPLICATE_SKU'
  | 'PRICE_MISSING' | 'PRICE_NOT_A_NUMBER' | 'PRICE_AMBIGUOUS' | 'PRICE_NOT_POSITIVE' | 'PRICE_NOT_USD' | 'CURRENCY_NOT_USD';

export type RowNote = 'COST_UNREADABLE' | 'COST_NOT_USD' | 'QUANTITY_UNREADABLE' | 'SALES_UNREADABLE';

export interface CatalogRow {
  /** Номер строки в файле (с единицы, как у клиента в таблице) */
  line: number;
  sku: string;
  title: string | null;
  asin: string | null;
  priceMinor: number;
  quantity: number | null;
  costMinor: number | null;
  sales30d: number | null;
  notes: RowNote[];
}

export interface Catalog {
  fileName: string;
  format: string;
  rows: CatalogRow[];
  /** Строки, которые не годятся вовсе, — с причиной и номером строки файла */
  rejected: Array<{ line: number; sku: string | null; problem: RowProblem; currency?: string }>;
  recognized: Array<{ field: CatalogField; header: string }>;
  ignored: string[];
  /** Поле узнано у нескольких колонок — взята первая слева, остальные названы */
  duplicates: Array<{ field: CatalogField; used: string; skipped: string[] }>;
}

export class CatalogError extends Error {
  readonly code: 'UNREADABLE' | 'EMPTY' | 'MISSING_COLUMNS' | 'TOO_MANY_ROWS';
  constructor(code: CatalogError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

export const normalizeHeader = (h: string): string => h.replace(/^﻿/, '').trim().replace(/^"|"$/g, '').toLowerCase().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();

const ALIAS_TO_FIELD = new Map<string, CatalogField>(
  (Object.entries(COLUMN_ALIASES) as Array<[CatalogField, readonly string[]]>).flatMap(([field, names]) => names.map((n) => [normalizeHeader(n), field] as [string, CatalogField])),
);

/** Целое число штук: «12», «1,234», «1.234», «1 234» — разделители тысяч только группами по три цифры */
export function parseCount(raw: string): number | null {
  const text = raw.trim().replace(/[\s ']/g, '');
  if (text === '') return null;
  if (/^\d+$/.test(text)) return Number(text);
  if (/^\d{1,3}([.,]\d{3})+$/.test(text)) return Number(text.replace(/[.,]/g, ''));
  return null;
}

/** Файл клиента → каталог. Колонки — по таблице названий; первая строка — заголовок */
export function readCatalog(content: Buffer, fileName: string): Catalog {
  let sheet;
  try {
    sheet = readTable(content);
  } catch (error) {
    throw new CatalogError('UNREADABLE', error instanceof TableReadError ? error.message : 'the file could not be read as a table');
  }
  if (sheet.rows.length < 2) throw new CatalogError('EMPTY', 'the file has no rows below the header');
  if (sheet.rows.length - 1 > ROWS_MAX) throw new CatalogError('TOO_MANY_ROWS', `the file has ${sheet.rows.length - 1} rows; at most ${ROWS_MAX} are read`);
  const header = sheet.rows[0]!;
  const columns = new Map<CatalogField, number>();
  const recognized: Catalog['recognized'] = [];
  const ignored: string[] = [];
  const duplicates = new Map<CatalogField, { used: string; skipped: string[] }>();
  header.forEach((h, i) => {
    const field = ALIAS_TO_FIELD.get(normalizeHeader(h));
    if (!field) { if (h.trim() !== '') ignored.push(h.trim()); return; }
    if (columns.has(field)) {
      const d = duplicates.get(field) ?? { used: header[columns.get(field)!]!.trim(), skipped: [] };
      d.skipped.push(h.trim());
      duplicates.set(field, d);
      return;
    }
    columns.set(field, i);
    recognized.push({ field, header: h.trim() });
  });
  const missing = REQUIRED_FIELDS.filter((f) => !columns.has(f));
  if (missing.length > 0) {
    throw new CatalogError('MISSING_COLUMNS', `no column for ${missing.join(' and ')}; accepted names: ${missing.map((f) => COLUMN_ALIASES[f].join(', ')).join(' / ')}`);
  }
  const cell = (row: readonly string[], field: CatalogField): string | null => (columns.has(field) ? (row[columns.get(field)!] ?? '').trim() : null);
  const rows: CatalogRow[] = [];
  const rejected: Catalog['rejected'] = [];
  const seen = new Set<string>();
  for (let r = 1; r < sheet.rows.length; r++) {
    const row = sheet.rows[r]!;
    const line = sheet.lines[r] ?? r + 1;
    if (row.every((c) => c.trim() === '')) continue;
    const sku = cell(row, 'sku') ?? '';
    if (sku === '') { rejected.push({ line, sku: null, problem: 'NO_SKU' }); continue; }
    if (sku.length > SKU_MAX) { rejected.push({ line, sku: sku.slice(0, SKU_MAX), problem: 'SKU_TOO_LONG' }); continue; }
    if (seen.has(sku)) { rejected.push({ line, sku, problem: 'DUPLICATE_SKU' }); continue; }
    /**
     * Шаг 72: колонка валюты не игнорируется. Пустая ячейка — доллары, как у файла без колонки; «USD», «US$», «$» — доллары; иное —
     * строка не годится: amazon.com продаёт в долларах, а переводить валюты kill-test не берётся [Р-138]. Валюта называется в отчёте
     */
    const currencyRaw = (cell(row, 'currency') ?? '').trim();
    if (currencyRaw !== '' && !/^(USD|US\$|\$|US DOLLARS?)$/i.test(currencyRaw)) {
      rejected.push({ line, sku, problem: 'CURRENCY_NOT_USD', currency: currencyRaw.slice(0, 12) });
      continue;
    }
    const priceRaw = cell(row, 'price') ?? '';
    if (priceRaw === '') { rejected.push({ line, sku, problem: 'PRICE_MISSING' }); continue; }
    if (currencyInCell(priceRaw) === 'EUR') { rejected.push({ line, sku, problem: 'PRICE_NOT_USD' }); continue; }
    const price = parseMoneyMinor(priceRaw);
    if (!price.ok) {
      rejected.push({ line, sku, problem: price.problem === 'COST_AMBIGUOUS_SEPARATOR' ? 'PRICE_AMBIGUOUS' : price.problem === 'COST_NEGATIVE' ? 'PRICE_NOT_POSITIVE' : 'PRICE_NOT_A_NUMBER' });
      continue;
    }
    if (price.minor <= 0) { rejected.push({ line, sku, problem: 'PRICE_NOT_POSITIVE' }); continue; }
    seen.add(sku);
    const notes: RowNote[] = [];
    let costMinor: number | null = null;
    const costRaw = cell(row, 'cost');
    if (costRaw) {
      if (currencyInCell(costRaw) === 'EUR') notes.push('COST_NOT_USD');
      else {
        const c = parseMoneyMinor(costRaw);
        if (c.ok && c.minor > 0) costMinor = c.minor;
        else notes.push('COST_UNREADABLE');
      }
    }
    const count = (field: 'quantity' | 'sales30d', note: RowNote): number | null => {
      const raw = cell(row, field);
      if (!raw) return null;
      const n = parseCount(raw);
      if (n === null) notes.push(note);
      return n;
    };
    rows.push({
      line, sku, title: cell(row, 'title') || null, asin: cell(row, 'asin') || null, priceMinor: price.minor,
      quantity: count('quantity', 'QUANTITY_UNREADABLE'), costMinor, sales30d: count('sales30d', 'SALES_UNREADABLE'), notes,
    });
  }
  return {
    fileName, format: sheet.format === 'XLSX' ? 'Excel workbook' : sheet.delimiter === '\t' ? 'tab-separated text' : sheet.delimiter === ';' ? 'semicolon-separated text' : 'comma-separated text',
    rows, rejected, recognized, ignored, duplicates: [...duplicates.entries()].map(([field, d]) => ({ field, ...d })),
  };
}
