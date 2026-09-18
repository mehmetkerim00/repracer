import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { test } from 'node:test';
import { columnIndex, detectDelimiter, parseCsv, parseXlsx, readTable, TableReadError } from '../src/index.ts';

/** Р-134 (шаг 28): выгрузка продавца читается так, как он её видел. Данные синтетические. */

test('Р-134: CSV — разделитель определяется по файлу, кавычки, перевод строки внутри значения и BOM не ломают таблицу', () => {
  const csv = '﻿"SKU";"Einstandspreis";"Hinweis"\r\nA-1;10,50;"Zeile 1\nZeile 2"\r\nA-2;7;"он сказал ""да"""\r\n';
  const sheet = parseCsv(csv);
  assert.equal(sheet.delimiter, ';');
  assert.deepEqual(sheet.rows, [
    ['SKU', 'Einstandspreis', 'Hinweis'],
    ['A-1', '10,50', 'Zeile 1\nZeile 2'],
    ['A-2', '7', 'он сказал "да"'],
  ]);
  assert.equal(detectDelimiter('a,b,c\n1,2,3\n'), ',');
  assert.equal(detectDelimiter('a\tb\tc\n1\t2\t3\n'), '\t');
  // Пустые строки выгрузки таблицу не сдвигают, короткие — дополняются до ширины
  assert.deepEqual(parseCsv('a,b,c\n\n1,2\n').rows, [['a', 'b', 'c'], ['1', '2', '']]);
});

test('Р-134: XLSX — общие строки, строки внутри ячейки, числа и пропущенные колонки читаются по ссылкам ячеек', () => {
  // У второй строки данных колонка B пуста: Excel такую ячейку в файл не пишет вовсе, и место значения определяют ссылки ячеек
  const book = xlsx([
    ['SKU', 'Cost', 'Note'],
    ['A-1', '10.5', 'inline'],
    ['A-2', '', '7'],
  ], { deflate: true });
  const sheet = parseXlsx(book);
  assert.equal(sheet.format, 'XLSX');
  assert.deepEqual(sheet.rows, [
    ['SKU', 'Cost', 'Note'],
    ['A-1', '10.5', 'inline'],
    ['A-2', '', '7'],
  ]);
  assert.equal(columnIndex('A'), 0);
  assert.equal(columnIndex('B'), 1);
  assert.equal(columnIndex('AA'), 26);
});

test('Р-134: формат определяется по содержимому файла, а не по имени; чужой файл — понятный отказ', () => {
  assert.equal(readTable(Buffer.from('a,b\n1,2\n', 'utf8')).format, 'CSV');
  assert.equal(readTable(xlsx([['a', 'b'], ['1', '2']], {})).format, 'XLSX');
  assert.throws(() => readTable(Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0x01])), (e: unknown) => e instanceof TableReadError && e.code === 'UNSUPPORTED_FORMAT');
  assert.throws(() => parseXlsx(Buffer.from('PK not really a zip')), TableReadError);
});

test('Р-134 (ревью шага 28, находки 11 и 12): книга не распаковывается без предела, а битый архив отказывает по-своему', () => {
  // Объявленный размер части больше предела — распаковка не начинается вовсе
  const declaredHuge = zip([['xl/worksheets/sheet1.xml', '<worksheet/>']], false, { declaredSize: 200 * 1024 * 1024 });
  assert.throws(() => parseXlsx(declaredHuge), (e: unknown) => e instanceof TableReadError && e.code === 'XLSX_TOO_LARGE');
  // Размер объявлен маленьким, а разворачивается часть в 70 МБ: предел распаковки останавливает её на объявленном
  const bomb = zip([['xl/worksheets/sheet1.xml', 'a'.repeat(70 * 1024 * 1024)]], true, { declaredSize: 1024 });
  assert.throws(() => parseXlsx(bomb), (e: unknown) => e instanceof TableReadError && e.code === 'XLSX_TOO_LARGE');
  // Каталог указывает за конец файла: своя причина, а не RangeError изнутри Node
  const broken = xlsx([['a', 'b']], {});
  broken.writeUInt32LE(broken.length + 4096, broken.length - 6);
  assert.throws(() => parseXlsx(broken), (e: unknown) => e instanceof TableReadError && e.code === 'XLSX_BROKEN');
});

// --- синтетическая книга XLSX: тот же формат, что пишут Excel и выгрузки каналов ----------------------------------------------

function xlsx(rows: string[][], options: { deflate?: boolean }): Buffer {
  const shared: string[] = [];
  const indexOf = (value: string) => {
    const at = shared.indexOf(value);
    if (at >= 0) return at;
    shared.push(value);
    return shared.length - 1;
  };
  const xmlRows = rows.map((row, r) => {
    const cells = row.map((value, c) => {
      if (value === '') return '';
      const reference = `${String.fromCharCode(65 + c)}${r + 1}`;
      return /^[0-9.]+$/.test(value) ? `<c r="${reference}"><v>${value}</v></c>` : `<c r="${reference}" t="s"><v>${indexOf(value)}</v></c>`;
    }).join('');
    return `<row r="${r + 1}">${cells}</row>`;
  }).join('');
  const sheet = `<?xml version="1.0"?><worksheet><sheetData>${xmlRows}</sheetData></worksheet>`;
  const strings = `<?xml version="1.0"?><sst count="${shared.length}">${shared.map((s) => `<si><t>${s.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</t></si>`).join('')}</sst>`;
  const workbook = '<?xml version="1.0"?><workbook><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>';
  const rels = '<?xml version="1.0"?><Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>';
  return zip([
    ['xl/workbook.xml', workbook],
    ['xl/_rels/workbook.xml.rels', rels],
    ['xl/sharedStrings.xml', strings],
    ['xl/worksheets/sheet1.xml', sheet],
  ], options.deflate === true);
}

function zip(entries: Array<[string, string]>, deflate: boolean, options: { declaredSize?: number } = {}): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const raw = Buffer.from(content, 'utf8');
    const data = deflate ? deflateRawSync(raw) : raw;
    const method = deflate ? 8 : 0;
    const nameBytes = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(options.declaredSize ?? raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, data);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(options.declaredSize ?? raw.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuffer, end]);
}
