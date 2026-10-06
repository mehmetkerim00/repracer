import assert from 'node:assert/strict';
import { test } from 'node:test';
import { columnIndex, detectDelimiter, detectEncoding, parseCsv, parseXlsx, readTable, TableReadError } from '../src/index.ts';
import { xlsx, zip } from './xlsx-fixture.ts';

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

test('OQ-200 (шаг 29): кодировка определяется по BOM и по содержимому; где уверенности нет, это видно', () => {
  const german = 'Artikelnummer;Einstandspreis;Währung\nA-1;10,50 €;EUR\n';
  // Немецкая выгрузка Excel в Windows-1252: «€» и «ä» — байты 0x80 и 0xE4
  const cp1252 = Buffer.from([...german].map((ch) => ({ 'ä': 0xe4, '€': 0x80 }[ch] ?? ch.charCodeAt(0))));
  const guess = detectEncoding(cp1252);
  assert.deepEqual([guess.encoding, guess.confident, guess.reason], ['WINDOWS-1252', false, 'NOT_UTF8'], 'догадка названа догадкой [OQ-200]');
  const sheet = readTable(cp1252);
  assert.deepEqual(sheet.rows[0], ['Artikelnummer', 'Einstandspreis', 'Währung'], 'заголовок с умляутом прочитан');
  assert.equal(sheet.rows[1]![1], '10,50 €', 'сумма с евро прочитана, а не превратилась в «не число»');
  assert.equal(sheet.encodingConfident, false);
  // BOM UTF-8 и UTF-16 из Excel: уверенность есть, BOM в первую ячейку не попадает
  const utf8Bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(german, 'utf8')]);
  assert.deepEqual([detectEncoding(utf8Bom).encoding, detectEncoding(utf8Bom).confident], ['UTF-8', true]);
  assert.equal(readTable(utf8Bom).rows[0]![0], 'Artikelnummer');
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(german, 'utf16le')]);
  assert.deepEqual([detectEncoding(utf16).encoding, detectEncoding(utf16).confident], ['UTF-16LE', true]);
  assert.deepEqual(readTable(utf16).rows[0], ['Artikelnummer', 'Einstandspreis', 'Währung']);
  // Выбор продавца сильнее догадки: тот же файл, прочитанный как UTF-8, не читается — и это сказано, а не заменено на вопросики
  assert.throws(() => readTable(cp1252, 'UTF-8'), (e: unknown) => e instanceof TableReadError && /UTF-8/.test(e.message));
});

test('шаг 72: число ячейки XLSX — без хвоста двоичной дроби (19.99 хранится как 19.989999999999998), текст ячейки не трогается', () => {
  const sheet = parseXlsx(xlsx([['SKU', 'Price', 'Cost', 'Note'], ['A-1', '19.989999999999998', '3.0000000000000004', '0.1'], ['A-2', '1234.5', '7', '19.989999999999998x'],
    ['1234567890123456', '1.5E+2', '7', '']], {}));
  // 15 значащих цифр — точность, которую показывает сам Excel; строка с буквой — текст ячейки, а не число; целое (16-значный
  // числовой SKU) не округляется — оно записано точно (ревью шага 72)
  assert.deepEqual(sheet.rows.slice(1), [['A-1', '19.99', '3', '0.1'], ['A-2', '1234.5', '7', '19.989999999999998x'], ['1234567890123456', '150', '7', '']]);
});
