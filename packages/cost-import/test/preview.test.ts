import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildPreview, fingerprintOf, parseCsv, parseFeeRateBp, parseMoneyMinor, suggestMapping, type ImportTargetOffer } from '../src/index.ts';

/** Р-134 (шаг 28): предпросмотр импорта. Данные синтетические. */

const OFFERS: ImportTargetOffer[] = [
  { writeScopeId: 'ws-1', productId: 'p-1', keys: ['A-1', '2000000000017'], currency: 'EUR', label: 'Синтетический товар 1' },
  { writeScopeId: 'ws-2', productId: 'p-2', keys: ['A-2'], currency: 'EUR', label: 'Синтетический товар 2' },
  { writeScopeId: 'ws-3', productId: 'p-3', keys: ['A-3'], currency: 'USD', label: 'Синтетический товар 3' },
  // Два оффера с одним и тем же ключом: по нему нельзя понять, о каком из них строка
  { writeScopeId: 'ws-4', productId: 'p-4', keys: ['DUP'], currency: 'EUR', label: 'Синтетический товар 4' },
  { writeScopeId: 'ws-5', productId: 'p-5', keys: ['DUP'], currency: 'EUR', label: 'Синтетический товар 5' },
];

test('Р-134: числа выгрузки читаются в любом привычном виде, чужие — с причиной', () => {
  assert.deepEqual(parseMoneyMinor('10,50'), { ok: true, minor: 1050 });
  assert.deepEqual(parseMoneyMinor('10.5'), { ok: true, minor: 1050 });
  assert.deepEqual(parseMoneyMinor('1 234,56'), { ok: true, minor: 123_456 });
  assert.deepEqual(parseMoneyMinor('1,234.56'), { ok: true, minor: 123_456 });
  assert.deepEqual(parseMoneyMinor('1.234.567'), { ok: true, minor: 123_456_700 }, 'два разделителя — это тысячи');
  // Ревью шага 28, находка 3: одинокое «1.234» — либо тысяча двести тридцать четыре, либо 1,234; угадывать нельзя
  assert.deepEqual(parseMoneyMinor('1.234'), { ok: false, problem: 'COST_AMBIGUOUS_SEPARATOR' });
  assert.deepEqual(parseMoneyMinor('10.505'), { ok: false, problem: 'COST_AMBIGUOUS_SEPARATOR' });
  assert.deepEqual(parseMoneyMinor('12,3456'), { ok: false, problem: 'COST_AMBIGUOUS_SEPARATOR' });
  assert.deepEqual(parseMoneyMinor('7'), { ok: true, minor: 700 });
  assert.deepEqual(parseMoneyMinor('12,90 EUR'), { ok: true, minor: 1290 });
  assert.deepEqual(parseMoneyMinor('-1'), { ok: false, problem: 'COST_NEGATIVE' });
  assert.deepEqual(parseMoneyMinor('n/a'), { ok: false, problem: 'COST_NOT_A_NUMBER' });
  assert.deepEqual(parseMoneyMinor(''), { ok: false, problem: 'COST_NOT_A_NUMBER' });
  assert.deepEqual(parseMoneyMinor('99999999999'), { ok: false, problem: 'COST_TOO_LARGE' });
  assert.deepEqual(parseFeeRateBp('15'), { ok: true, bp: 1500 });
  assert.deepEqual(parseFeeRateBp('15,5 %'), { ok: true, bp: 1550 });
  assert.deepEqual(parseFeeRateBp('120'), { ok: false, problem: 'FEE_RATE_OUT_OF_RANGE' });
  assert.deepEqual(parseFeeRateBp('—'), { ok: false, problem: 'FEE_NOT_A_NUMBER' });
  // Ревью шага 28, находка 4: «0,15» — это 15 % или 0,15 %? Без знака процента импорт не гадает, со знаком — верит
  assert.deepEqual(parseFeeRateBp('0,15'), { ok: false, problem: 'FEE_AMBIGUOUS_FRACTION' });
  assert.deepEqual(parseFeeRateBp('0,15 %'), { ok: true, bp: 15 });
});

test('Р-134: колонки предлагаются по заголовкам и по значениям, а обязательные названы', () => {
  const sheet = parseCsv('Artikelnummer;Einstandspreis;Währung;Provision %\nA-1;10,50;EUR;15\n');
  const { mapping, suggestions } = suggestMapping(sheet);
  assert.deepEqual(mapping, { offerKey: 0, unitCostMinor: 1, currency: 2, feeRateBp: 3 });
  assert.equal(suggestions.every((s) => s.reason === 'HEADER_EXACT' || s.reason === 'HEADER_CONTAINS'), true);
  // Заголовков нет: валюта и деньги узнаются по значениям, но ключ оффера — нет, и импорт об этом говорит
  const headless = parseCsv('A-1;10,50;EUR\nA-2;7,00;EUR\n');
  const guessed = suggestMapping(headless);
  assert.equal(guessed.mapping.unitCostMinor, 1);
  assert.equal(guessed.mapping.currency, 2);
  const preview = buildPreview({ sheet: headless, mapping: { unitCostMinor: 1 }, offers: OFFERS });
  assert.deepEqual(preview.blocked, { missing: ['offerKey'] });
  assert.equal(preview.totals.apply, 0);
});

test('Р-134: предпросмотр показывает, что применится, и отдельно — что не сопоставилось, с причиной у каждой строки', () => {
  const csv = [
    'SKU;Einstandspreis;Währung',
    'A-1;10,50;EUR',            // применится
    '2000000000017;11,00;EUR',  // тот же оффер по EAN — дубль, не применится ни одна из двух строк
    'A-2;7;',                   // валюта не указана — валюта оффера
    'A-3;5,00;EUR',             // валюта не та, что у оффера (USD)
    'A-9;5,00;EUR',             // оффера нет
    'DUP;5,00;EUR',             // ключ у двух офферов
    ';5,00;EUR',                // нет ключа
    'A-2;;EUR',                 // нет себестоимости (и оффер уже был выше — но до проверки дубля не доходит)
  ].join('\n');
  const sheet = parseCsv(csv);
  const preview = buildPreview({ sheet, mapping: suggestMapping(sheet).mapping, offers: OFFERS });
  assert.equal(preview.totals.rows, 8);
  assert.deepEqual(preview.apply.map((r) => [r.line, r.writeScopeId, r.unitCostMinor, r.currency]), [[4, 'ws-2', 700, 'EUR']]);
  assert.deepEqual(preview.problems.map((p) => [p.problem, p.rows]), [
    ['OFFER_NOT_FOUND', 1], ['OFFER_AMBIGUOUS', 1], ['OFFER_KEY_EMPTY', 1], ['COST_MISSING', 1], ['CURRENCY_NOT_OF_OFFER', 1], ['DUPLICATE_OFFER', 2],
  ]);
  assert.equal(preview.totals.apply + preview.totals.skipped, preview.totals.rows, 'каждая строка файла попадает ровно в один список: применяемых или непримененных');
  assert.equal(preview.skipped.filter((r) => r.problem === 'DUPLICATE_OFFER').length, 2, 'у дубля не применяется ни одна из двух строк');
  assert.equal(preview.totals.offersCovered, 1);
  assert.equal(preview.totals.offersMissing, OFFERS.length - 1);
  // У каждой непримененной строки есть причина и видно значение, из-за которого она не сопоставилась
  assert.equal(preview.skipped.every((r) => r.problem !== undefined), true);
  assert.equal(preview.skipped.find((r) => r.problem === 'OFFER_NOT_FOUND')?.raw, 'A-9');
});

test('Р-134: отпечаток закрепляет ровно показанный набор строк', () => {
  const sheet = parseCsv('SKU;Cost\nA-1;10,00\nA-2;7,00\n');
  const preview = buildPreview({ sheet, mapping: { offerKey: 0, unitCostMinor: 1 }, offers: OFFERS });
  assert.equal(preview.totals.apply, 2);
  // Ревью шага 28, находка 15: «отпечаток равен отпечатку показанного» — тавтология. Значение имеет то, что отпечаток МЕНЯЕТСЯ,
  // когда меняется набор, и НЕ меняется, когда тот же файл прочитан заново
  assert.equal(buildPreview({ sheet: parseCsv('SKU;Cost\r\nA-1;10,00\r\nA-2;7,00\r\n'), mapping: { offerKey: 0, unitCostMinor: 1 }, offers: OFFERS }).fingerprint,
    preview.fingerprint, 'тот же набор строк — тот же отпечаток, даже если файл переведён в CRLF');
  // Изменилась одна сумма — отпечаток другой: применить старый предпросмотр нельзя
  const changed = buildPreview({ sheet: parseCsv('SKU;Cost\nA-1;10,00\nA-2;7,50\n'), mapping: { offerKey: 0, unitCostMinor: 1 }, offers: OFFERS });
  assert.notEqual(changed.fingerprint, preview.fingerprint);
  // Порядок строк — часть набора: перестановка тоже меняет отпечаток
  assert.notEqual(fingerprintOf([...preview.apply].reverse()), preview.fingerprint);
});

test('Р-134 (ревью шага 28, находка 13): номер непримененной строки — это номер строки в файле продавца', () => {
  // Пустая строка между записями и перевод строки внутри кавычек: и то и другое раньше сдвигало счёт
  const sheet = parseCsv('SKU;Cost;Notiz\nA-1;10,00;ok\n\nA-2;7,00;"zwei\nZeilen"\nNICHT-DA;5,00;ok\n');
  assert.deepEqual(sheet.lines, [1, 2, 4, 6], 'пустая строка и перевод строки внутри кавычек сдвигают номера в файле');
  const preview = buildPreview({ sheet, mapping: { offerKey: 0, unitCostMinor: 1 }, offers: OFFERS });
  const notFound = preview.skipped.find((r) => r.problem === 'OFFER_NOT_FOUND');
  assert.equal(notFound?.line, 6, 'строка NICHT-DA — шестая строка файла, а не четвёртая по порядку записей');
});
