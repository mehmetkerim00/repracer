import type { StockImportRow } from './store.ts';

/**
 * Файл остатков продавца: две колонки — артикул и количество. Колонки находятся по заголовку (немецкий и английский),
 * а не по положению: у выгрузок из складских систем порядок свой. Количество — целое неотрицательное; «12,0» и «12.0»
 * принимаются как 12, всё остальное — строка не применяется с причиной, а не угадывается [Р-138 — тот же принцип, что у
 * себестоимости]. Разбор байтов файла (кодировка, разделитель, XLSX) — у `@repracer/cost-import`, здесь только смысл колонок.
 */
const SKU_HEADERS = ['artikelnummer', 'artikel', 'sku', 'article', 'artikelnr', 'art-nr', 'item'];
const QUANTITY_HEADERS = ['bestand', 'menge', 'quantity', 'qty', 'stock', 'lagerbestand', 'verfügbar', 'available'];

export interface StockFileMapping {
  sku: number;
  quantity: number;
}

export interface StockFileParse {
  mapping: StockFileMapping;
  rows: StockImportRow[];
  skipped: Array<{ line: number; sku: string; reason: 'BAD_QUANTITY' | 'EMPTY_SKU' | 'DUPLICATE_SKU' }>;
}

export type StockFileError = { code: 'NO_HEADER' | 'SKU_COLUMN_MISSING' | 'QUANTITY_COLUMN_MISSING' | 'NO_ROWS' };

const normalise = (h: string) => h.trim().toLowerCase().replace(/^﻿/, '');

export function suggestStockColumns(header: readonly string[]): StockFileMapping | StockFileError {
  const names = header.map(normalise);
  const sku = names.findIndex((h) => SKU_HEADERS.includes(h));
  const quantity = names.findIndex((h) => QUANTITY_HEADERS.includes(h));
  if (header.length === 0) return { code: 'NO_HEADER' };
  if (sku < 0) return { code: 'SKU_COLUMN_MISSING' };
  if (quantity < 0) return { code: 'QUANTITY_COLUMN_MISSING' };
  return { sku, quantity };
}

export function parseQuantityCell(raw: string): number | null {
  const t = raw.trim().replace(/\s/g, '');
  if (!/^\d+([.,]0+)?$/.test(t)) return null;
  const n = Number(t.replace(',', '.'));
  return Number.isSafeInteger(n) && n >= 0 && n <= 99_999 ? n : null;
}

export function parseStockSheet(rows: readonly (readonly string[])[], mapping?: StockFileMapping): StockFileParse | StockFileError {
  const [header, ...body] = rows;
  if (!header) return { code: 'NO_HEADER' };
  const m = mapping ?? suggestStockColumns(header);
  if ('code' in m) return m;
  const out: StockImportRow[] = [];
  const skipped: StockFileParse['skipped'] = [];
  const seen = new Set<string>();
  body.forEach((r, i) => {
    const line = i + 2;
    const sku = (r[m.sku] ?? '').trim();
    if (sku === '') { if (r.some((c) => c.trim() !== '')) skipped.push({ line, sku, reason: 'EMPTY_SKU' }); return; }
    if (seen.has(sku)) { skipped.push({ line, sku, reason: 'DUPLICATE_SKU' }); return; }
    // Артикул занят с ПЕРВОГО появления, даже если строка не применится: иначе вторая строка того же артикула прошла бы молча
    seen.add(sku);
    const quantity = parseQuantityCell(r[m.quantity] ?? '');
    if (quantity === null) { skipped.push({ line, sku, reason: 'BAD_QUANTITY' }); return; }
    out.push({ sku, quantity });
  });
  if (out.length === 0 && skipped.length === 0) return { code: 'NO_ROWS' };
  return { mapping: m, rows: out, skipped };
}
