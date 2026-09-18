import { inflateRawSync } from 'node:zlib';

/**
 * Р-134 (шаг 28): чтение типичных выгрузок продавца — CSV и XLSX. Новой зависимости для этого не заводим: XLSX — это ZIP с XML,
 * а распаковка есть в самом Node (`node:zlib`). Читаем ровно то, что нужно импорту себестоимости: первый лист, строки, ячейки как
 * текст. Формулы, стили, даты как числа и прочее богатство таблицы нас не интересуют — значение ячейки берётся так, как его видел
 * продавец (кэш значения формулы, общая строка, число).
 */
/** Кодировки, которые встречаются в выгрузках продавцов: UTF-8 (в том числе с BOM), UTF-16 из Excel и немецкая Windows-1252 */
export const TABLE_ENCODINGS = ['UTF-8', 'UTF-16LE', 'UTF-16BE', 'WINDOWS-1252'] as const;
export type TableEncoding = (typeof TABLE_ENCODINGS)[number];

export interface EncodingGuess {
  encoding: TableEncoding;
  /** Уверены ли: BOM и правильный UTF-8 — да; «байты не UTF-8, значит, наверное, Windows-1252» — нет [OQ-200] */
  confident: boolean;
  /** Почему так решили — это показывается продавцу рядом с разделителем */
  reason: 'BOM' | 'VALID_UTF8' | 'ASCII_ONLY' | 'NUL_BYTES' | 'NOT_UTF8';
}

/**
 * OQ-200 (шаг 29): кодировка определяется по BOM и по содержимому, а не предполагается. Немецкие выгрузки часто приходят в
 * Windows-1252, и «€» в суммах разбирался как неверная строка — весь файл оказывался «не числом». Где уверенности нет,
 * продавца СПРАШИВАЮТ: экран показывает, как файл прочитан, и даёт выбрать кодировку.
 */
export function detectEncoding(content: Buffer): EncodingGuess {
  if (content.length >= 3 && content[0] === 0xef && content[1] === 0xbb && content[2] === 0xbf) return { encoding: 'UTF-8', confident: true, reason: 'BOM' };
  if (content.length >= 2 && content[0] === 0xff && content[1] === 0xfe) return { encoding: 'UTF-16LE', confident: true, reason: 'BOM' };
  if (content.length >= 2 && content[0] === 0xfe && content[1] === 0xff) return { encoding: 'UTF-16BE', confident: true, reason: 'BOM' };
  // UTF-16 без BOM узнаётся по нулевым байтам через один: «Unicode text» из Excel пишется именно так
  const head = content.subarray(0, Math.min(content.length, 4096));
  const evenNul = head.filter((_, i) => i % 2 === 0 && head[i] === 0).length;
  const oddNul = head.filter((_, i) => i % 2 === 1 && head[i] === 0).length;
  if (head.length >= 16 && oddNul > head.length / 4 && evenNul === 0) return { encoding: 'UTF-16LE', confident: true, reason: 'NUL_BYTES' };
  if (head.length >= 16 && evenNul > head.length / 4 && oddNul === 0) return { encoding: 'UTF-16BE', confident: true, reason: 'NUL_BYTES' };
  if (content.every((b) => b < 0x80)) return { encoding: 'UTF-8', confident: true, reason: 'ASCII_ONLY' };
  return isValidUtf8(content)
    ? { encoding: 'UTF-8', confident: true, reason: 'VALID_UTF8' }
    // Байты не складываются в UTF-8: скорее всего Windows-1252 (немецкий Excel), но это догадка — её видно на экране
    : { encoding: 'WINDOWS-1252', confident: false, reason: 'NOT_UTF8' };
}

/** Проверка строгая: любая неверная последовательность — это не UTF-8, а не «символ замены» */
function isValidUtf8(content: Buffer): boolean {
  for (let i = 0; i < content.length;) {
    const b = content[i]!;
    const length = b < 0x80 ? 1 : b >= 0xc2 && b <= 0xdf ? 2 : b >= 0xe0 && b <= 0xef ? 3 : b >= 0xf0 && b <= 0xf4 ? 4 : 0;
    if (length === 0 || i + length > content.length) return false;
    for (let k = 1; k < length; k += 1) {
      const c = content[i + k]!;
      if (c < 0x80 || c > 0xbf) return false;
    }
    i += length;
  }
  return true;
}

/** Байты 0x80–0x9F Windows-1252 отличаются от ISO-8859-1 — среди них «€», а он стоит в колонке сумм */
const CP1252_HIGH = ['\u20ac', '\u0081', '\u201a', '\u0192', '\u201e', '\u2026', '\u2020', '\u2021', '\u02c6', '\u2030', '\u0160', '\u2039', '\u0152',
  '\u008d', '\u017d', '\u008f', '\u0090', '\u2018', '\u2019', '\u201c', '\u201d', '\u2022', '\u2013', '\u2014', '\u02dc', '\u2122', '\u0161',
  '\u203a', '\u0153', '\u009d', '\u017e', '\u0178'];

export function decodeTable(content: Buffer, encoding: TableEncoding): string {
  if (encoding === 'UTF-16LE') return content.toString('utf16le').replace(/^\ufeff/, '');
  if (encoding === 'UTF-16BE') {
    const swapped = Buffer.from(content);
    for (let i = 0; i + 1 < swapped.length; i += 2) { const t = swapped[i]!; swapped[i] = swapped[i + 1]!; swapped[i + 1] = t; }
    return swapped.toString('utf16le').replace(/^\ufeff/, '');
  }
  if (encoding === 'WINDOWS-1252') {
    let out = '';
    for (const b of content) out += b >= 0x80 && b <= 0x9f ? CP1252_HIGH[b - 0x80]! : String.fromCharCode(b);
    return out;
  }
  return content.toString('utf8').replace(/^\ufeff/, '');
}

export interface Sheet {
  /** Строки в порядке файла; короткие строки дополняются пустыми ячейками до ширины самой длинной */
  rows: string[][];
  /** Как файл был прочитан: продавцу важно знать, что мы поняли разделитель и кодировку так же, как он */
  format: 'CSV' | 'XLSX';
  delimiter?: ',' | ';' | '\t';
  /** Как прочитаны байты файла [OQ-200]: у XLSX кодировка внутри книги, у CSV — определена или выбрана продавцом */
  encoding?: TableEncoding;
  encodingConfident?: boolean;
  /**
   * Номер строки В ФАЙЛЕ для каждой строки `rows` (с единицы). Ревью шага 28, находка 13: пустые строки выбрасываются, а значение
   * внутри кавычек может занимать несколько физических строк — без этого списка номер в отчёте о несопоставленном не совпадал бы с
   * тем, что продавец видит в своей таблице, а он показан ровно для того, чтобы её найти.
   */
  lines: number[];
}

export class TableReadError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const DELIMITERS = [',', ';', '\t'] as const;

/** Разделитель — тот, что даёт больше всего одинаковых по ширине строк: у выгрузок из Excel в ЕС это чаще `;` */
export function detectDelimiter(text: string): ',' | ';' | '\t' {
  const head = text.split(/\r?\n/).filter((l) => l.trim() !== '').slice(0, 20);
  let best: { delimiter: ',' | ';' | '\t'; score: number } = { delimiter: ',', score: -1 };
  for (const delimiter of DELIMITERS) {
    const widths = head.map((line) => splitLine(line, delimiter).length);
    const width = widths[0] ?? 1;
    if (width < 2) continue;
    const consistent = widths.filter((w) => w === width).length;
    const score = consistent * 100 + width;
    if (score > best.score) best = { delimiter, score };
  }
  return best.delimiter;
}

/** Одна строка без учёта кавычек с переводами строк: используется только для выбора разделителя */
function splitLine(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let value = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i]!;
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { value += '"'; i += 1; continue; }
      if (c === '"') { quoted = false; continue; }
      value += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === delimiter) { out.push(value); value = ''; continue; }
    value += c;
  }
  out.push(value);
  return out;
}

/** CSV по RFC 4180 с поправкой на жизнь: BOM, CRLF, кавычки с переводами строк внутри, свой разделитель */
export function parseCsv(text: string, delimiter?: ',' | ';' | '\t'): Sheet {
  const clean = text.replace(/^﻿/, '');
  const d = delimiter ?? detectDelimiter(clean);
  const rows: string[][] = [];
  const lines: number[] = [];
  let row: string[] = [];
  let value = '';
  let quoted = false;
  let line = 1;
  let rowStartedAt = 1;
  for (let i = 0; i < clean.length; i += 1) {
    const c = clean[i]!;
    if (quoted) {
      if (c === '"' && clean[i + 1] === '"') { value += '"'; i += 1; continue; }
      if (c === '"') { quoted = false; continue; }
      if (c === '\n') line += 1;
      value += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === d) { row.push(value); value = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') {
      row.push(value); rows.push(row); lines.push(rowStartedAt);
      row = []; value = ''; line += 1; rowStartedAt = line;
      continue;
    }
    value += c;
  }
  if (value !== '' || row.length > 0) { row.push(value); rows.push(row); lines.push(rowStartedAt); }
  const kept = rows.map((r, i) => ({ r, line: lines[i]! })).filter(({ r }) => r.some((v) => v.trim() !== ''));
  return { rows: pad(kept.map((k) => k.r)), lines: kept.map((k) => k.line), format: 'CSV', delimiter: d };
}

function pad(rows: string[][]): string[][] {
  const width = rows.reduce((w, r) => Math.max(w, r.length), 0);
  return rows.map((r) => (r.length === width ? r : [...r, ...Array.from({ length: width - r.length }, () => '')]));
}

// --- XLSX: ZIP + XML ровно настолько, насколько нужно таблице ----------------------------------------------------------------

interface ZipEntry { name: string; data: Buffer }

/**
 * Ревью шага 28, находки 11 и 12: файл продавца — вход снаружи. Архив в 300 КБ разворачивался в 300 МБ, а смещения из файла шли в
 * `readUInt32LE` без проверки границ, и битый ZIP давал `RangeError` вместо понятного отказа. Поэтому: распаковывается только то,
 * что нужно таблице, с пределом на запись и на всю книгу, а каждое смещение из файла проверяется перед чтением.
 */
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const MAX_ENTRIES = 512;
/** Нужны только эти части книги: лист, общие строки, книга и связи. Остальное (картинки, темы) не распаковывается вовсе */
const NEEDED = /^xl\/(worksheets\/[^/]+\.xml|sharedStrings\.xml|workbook\.xml|_rels\/workbook\.xml\.rels)$/;

/** Записи ZIP по центральному каталогу: имя, метод (0 — как есть, 8 — deflate), смещение локального заголовка */
function readZip(buffer: Buffer): Map<string, Buffer> {
  const end = findEndOfCentralDirectory(buffer);
  const count = buffer.readUInt16LE(end + 10);
  if (count > MAX_ENTRIES) throw new TableReadError('XLSX_TOO_LARGE', `the workbook has ${count} parts, more than the ${MAX_ENTRIES} we read`);
  let offset = buffer.readUInt32LE(end + 16);
  const entries: ZipEntry[] = [];
  let total = 0;
  for (let i = 0; i < count; i += 1) {
    at(buffer, offset, 46);
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new TableReadError('XLSX_BROKEN', 'central directory entry is not where it should be');
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    at(buffer, offset + 46, nameLength);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new TableReadError('XLSX_UNSUPPORTED', 'zip64 workbooks are not supported');
    }
    if (NEEDED.test(name)) {
      if (uncompressedSize > MAX_ENTRY_BYTES) throw new TableReadError('XLSX_TOO_LARGE', `part ${name} unpacks to ${uncompressedSize} bytes`);
      const data = readLocal(buffer, localOffset, method, compressedSize, Math.min(uncompressedSize || MAX_ENTRY_BYTES, MAX_ENTRY_BYTES));
      total += data.length;
      if (total > MAX_TOTAL_BYTES) throw new TableReadError('XLSX_TOO_LARGE', `the workbook unpacks to more than ${MAX_TOTAL_BYTES} bytes`);
      entries.push({ name, data });
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return new Map(entries.map((e) => [e.name, e.data]));
}

/** Смещение из файла — не обещание: за концом буфера это битый архив, а не исключение Node про границы */
function at(buffer: Buffer, offset: number, length: number): void {
  if (!Number.isInteger(offset) || offset < 0 || offset + length > buffer.length) {
    throw new TableReadError('XLSX_BROKEN', 'the archive points outside of itself: it is damaged or not a workbook');
  }
}

function readLocal(buffer: Buffer, offset: number, method: number, compressedSize: number, maxOutputLength: number): Buffer {
  at(buffer, offset, 30);
  if (buffer.readUInt32LE(offset) !== 0x04034b50) throw new TableReadError('XLSX_BROKEN', 'local file header is not where it should be');
  const nameLength = buffer.readUInt16LE(offset + 26);
  const extraLength = buffer.readUInt16LE(offset + 28);
  const start = offset + 30 + nameLength + extraLength;
  at(buffer, start, compressedSize);
  const raw = buffer.subarray(start, start + compressedSize);
  if (method === 0) return Buffer.from(raw);
  if (method === 8) {
    try {
      return inflateRawSync(raw, { maxOutputLength });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Предел распаковки Node сообщает о себе как «Cannot create a Buffer larger than N bytes» либо через `maxOutputLength`
      throw new TableReadError(/larger than|output length/i.test(message) ? 'XLSX_TOO_LARGE' : 'XLSX_BROKEN', `a part of the workbook could not be unpacked: ${message}`);
    }
  }
  throw new TableReadError('XLSX_UNSUPPORTED', `zip compression method ${method} is not supported`);
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  for (let i = buffer.length - 22; i >= 0 && i > buffer.length - 66_000; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) return i;
  }
  throw new TableReadError('XLSX_BROKEN', 'this is not a zip archive: no end of central directory');
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function unescapeXml(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (whole, code: string) => {
    if (code.startsWith('#x') || code.startsWith('#X')) return String.fromCodePoint(Number.parseInt(code.slice(2), 16));
    if (code.startsWith('#')) return String.fromCodePoint(Number(code.slice(1)));
    return ENTITIES[code] ?? whole;
  });
}

/** Общие строки книги: значение ячейки типа `s` — номер в этом списке */
function sharedStrings(xml: string): string[] {
  const out: string[] = [];
  for (const si of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
    let text = '';
    for (const t of si[1]!.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) text += unescapeXml(t[1]!);
    out.push(text);
  }
  return out;
}

/** Номер колонки из ссылки ячейки: A → 0, B → 1, AA → 26 */
export function columnIndex(reference: string): number {
  const letters = /^([A-Z]+)/.exec(reference.toUpperCase())?.[1] ?? '';
  let index = 0;
  for (const ch of letters) index = index * 26 + (ch.charCodeAt(0) - 64);
  return index - 1;
}

/**
 * Первый лист книги как строки текста. Значение ячейки: общая строка (`t="s"`), строка внутри ячейки (`t="inlineStr"`),
 * иначе — содержимое `<v>` как есть. Кэш значения формулы — это тоже `<v>`: продавец видел в таблице именно его.
 */
export function parseXlsx(buffer: Buffer): Sheet {
  const files = readZip(buffer);
  const shared = files.has('xl/sharedStrings.xml') ? sharedStrings(files.get('xl/sharedStrings.xml')!.toString('utf8')) : [];
  const sheetName = firstSheetPath(files);
  const xml = files.get(sheetName)?.toString('utf8');
  if (xml === undefined) throw new TableReadError('XLSX_NO_SHEET', 'the workbook has no first sheet');
  const rows: string[][] = [];
  const lines: number[] = [];
  for (const rowMatch of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    // Номер строки листа — тот, что видит продавец слева от строки; без него номер сместился бы на каждой пропущенной строке
    const sheetRow = Number(/r="(\d+)"/.exec(rowMatch[1]!)?.[1] ?? '');
    lines.push(Number.isInteger(sheetRow) && sheetRow > 0 ? sheetRow : rows.length + 1);
    const cells: string[] = [];
    for (const cellMatch of rowMatch[2]!.matchAll(/<c\b([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attributes = cellMatch[1]!;
      const body = cellMatch[2] ?? '';
      const reference = /r="([A-Z]+\d+)"/.exec(attributes)?.[1];
      const index = reference ? columnIndex(reference) : cells.length;
      const type = /t="([^"]+)"/.exec(attributes)?.[1] ?? 'n';
      let value = '';
      if (type === 's') {
        const n = Number(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '');
        value = shared[n] ?? '';
      } else if (type === 'inlineStr') {
        for (const t of body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) value += unescapeXml(t[1]!);
      } else {
        value = unescapeXml(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '');
      }
      while (cells.length < index) cells.push('');
      cells[index] = value;
    }
    rows.push(cells);
  }
  const kept = rows.map((r, i) => ({ r, line: lines[i]! })).filter(({ r }) => r.some((v) => v.trim() !== ''));
  return { rows: pad(kept.map((k) => k.r)), lines: kept.map((k) => k.line), format: 'XLSX' };
}

/** Путь первого листа: по книге и связям, а если их нет — первый `xl/worksheets/*.xml` */
function firstSheetPath(files: Map<string, Buffer>): string {
  const workbook = files.get('xl/workbook.xml')?.toString('utf8');
  const relationships = files.get('xl/_rels/workbook.xml.rels')?.toString('utf8');
  if (workbook && relationships) {
    const id = /<sheet\b[^>]*r:id="([^"]+)"/.exec(workbook)?.[1];
    if (id) {
      const target = new RegExp(`<Relationship\\b[^>]*Id="${id}"[^>]*Target="([^"]+)"`).exec(relationships)?.[1];
      if (target) {
        const path = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
        if (files.has(path)) return path;
      }
    }
  }
  const any = [...files.keys()].filter((n) => /^xl\/worksheets\/.+\.xml$/.test(n)).sort()[0];
  if (!any) throw new TableReadError('XLSX_NO_SHEET', 'the workbook has no worksheets');
  return any;
}

/** Выгрузка продавца: формат определяется по содержимому, а не по имени файла; кодировка — тоже, но её можно задать [OQ-200] */
export function readTable(content: Buffer, encoding?: TableEncoding): Sheet {
  if (content.length >= 4 && content.readUInt32LE(0) === 0x04034b50) return parseXlsx(content);
  const guess = encoding ? { encoding, confident: true } : detectEncoding(content);
  const text = decodeTable(content, guess.encoding);
  // Не таблица: неразбираемые байты в выбранной кодировке либо управляющие символы (это двоичный файл, а не текст)
  const control = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text);
  if (text.includes('\uFFFD') || control) {
    throw new TableReadError('UNSUPPORTED_FORMAT', encoding
      ? `the file does not read as ${encoding}: choose another encoding`
      : 'the file is neither a spreadsheet nor a text table');
  }
  return { ...parseCsv(text), encoding: guess.encoding, encodingConfident: guess.confident };
}
