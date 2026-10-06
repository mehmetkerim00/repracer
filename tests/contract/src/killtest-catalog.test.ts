import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CatalogError, readCatalog } from './killtest/catalog.ts';
import { syntheticCatalog, syntheticItems } from './killtest/synthetic.ts';
import { xlsx } from '../../../packages/cost-import/test/xlsx-fixture.ts';

/**
 * Шаг 71: kill-test читает каталог клиента из трёх разных выгрузок по одной таблице названий колонок; неизвестные колонки
 * игнорируются и называются, негодные строки — с причиной и номером строки файла. Данные синтетические (300 строк в каждом варианте).
 */

test('step 71: three column layouts of the same 300 products read to the same catalog; unknown columns are named, not used', () => {
  const items = syntheticItems(300);
  const simple = readCatalog(Buffer.from(syntheticCatalog('simple')), 'simple.csv');
  assert.equal(simple.format, 'comma-separated text');
  assert.equal(simple.rows.length, 300);
  assert.deepEqual(simple.rejected, []);
  assert.deepEqual(simple.recognized.map((c) => c.field).sort(), ['cost', 'price', 'quantity', 'sales30d', 'sku', 'title']);
  assert.deepEqual(simple.ignored, []);
  for (const [i, row] of simple.rows.entries()) {
    const x = items[i]!;
    assert.deepEqual([row.sku, row.title, row.priceMinor, row.quantity, row.costMinor, row.sales30d], [x.sku, x.title, x.priceMinor, x.quantity, x.costMinor, x.sales30d]);
  }
  assert.equal(simple.rows.filter((r) => r.costMinor === null).length, 30, 'every tenth product has no cost');

  const listings = readCatalog(Buffer.from(syntheticCatalog('listings')), 'listings.txt');
  assert.equal(listings.format, 'tab-separated text');
  assert.equal(listings.rows.length, 300);
  assert.deepEqual(listings.recognized.map((c) => `${c.field}:${c.header}`).sort(), ['asin:asin1', 'price:price', 'quantity:quantity', 'sku:seller-sku', 'title:item-name']);
  assert.deepEqual(listings.ignored, ['item-description', 'listing-id', 'open-date', 'fulfillment-channel', 'item-condition']);
  assert.ok(listings.rows.every((r) => r.costMinor === null && r.sales30d === null), 'no cost and no sales in this layout');
  assert.deepEqual(listings.rows.map((r) => r.priceMinor), items.map((x) => x.priceMinor));

  const business = readCatalog(Buffer.from(syntheticCatalog('business')), 'business.csv');
  assert.deepEqual(business.recognized.map((c) => `${c.field}:${c.header}`).sort(),
    ['cost:Unit Cost', 'price:Your Price', 'quantity:Available', 'sales30d:Units Ordered', 'sku:SKU', 'title:Title']);
  assert.deepEqual(business.ignored, ['Ordered Product Sales', 'Sessions - Total']);
  assert.equal(business.rows.length, 295, '300 data rows, five of them unusable');
  // Доллары с разделителем тысяч («$1,234.56») читаются как в простом шаблоне
  assert.deepEqual(business.rows.map((r) => [r.priceMinor, r.costMinor]), items.slice(0, 295).map((x) => [x.priceMinor, x.costMinor]));
  // Каждая негодная строка — своей причиной и номером строки В ФАЙЛЕ (заголовок — строка 1)
  assert.deepEqual(business.rejected.map((r) => [r.line, r.problem]),
    [[297, 'PRICE_MISSING'], [298, 'DUPLICATE_SKU'], [299, 'PRICE_AMBIGUOUS'], [300, 'NO_SKU'], [301, 'PRICE_NOT_USD']]);
});

test('step 71: a file without a SKU or a price column is refused with the accepted names; notes do not drop a row', () => {
  assert.throws(() => readCatalog(Buffer.from('item,amount\nA,1\n'), 'bad.csv'), (e: unknown) => {
    assert.ok(e instanceof CatalogError);
    assert.equal(e.code, 'MISSING_COLUMNS');
    assert.match(e.message, /sku and price/);
    assert.match(e.message, /seller sku/, 'the message names the names we accept');
    return true;
  });
  // Себестоимость и количество, которые не читаются, — пометка строки, а не отказ: цена есть, решение о цене возможно
  const c = readCatalog(Buffer.from('SKU;Price;Cost;Qty\nSYN-1;12,50;abc;7,5\nSYN-2;9.99;€3,00;1.234\n'), 'eu.csv');
  assert.equal(c.format, 'semicolon-separated text');
  assert.deepEqual(c.rows.map((r) => [r.sku, r.priceMinor, r.costMinor, r.quantity, r.notes]),
    [['SYN-1', 1250, null, null, ['COST_UNREADABLE', 'QUANTITY_UNREADABLE']], ['SYN-2', 999, null, 1234, ['COST_NOT_USD']]]);
  // Колонка узнана дважды — взята первая слева, вторая названа
  const twice = readCatalog(Buffer.from('sku,price,your-price\nSYN-1,5.00,6.00\n'), 'twice.csv');
  assert.equal(twice.rows[0]!.priceMinor, 500);
  assert.deepEqual(twice.duplicates, [{ field: 'price', used: 'price', skipped: ['your-price'] }]);
});

test('step 72: the currency column is read — a row in another currency is named and not used; an empty cell is US dollars', () => {
  const c = readCatalog(Buffer.from('sku,price,cost,currency\nSYN-1,12.50,5.00,USD\nSYN-2,9.99,,\nSYN-3,8.00,3.00,EUR\nSYN-4,7.00,2.00,US$\nSYN-5,6.00,2.00,GBP\n'), 'cur.csv');
  assert.deepEqual(c.rows.map((r) => r.sku), ['SYN-1', 'SYN-2', 'SYN-4']);
  assert.deepEqual(c.rejected.map((r) => [r.line, r.problem, r.currency]), [[4, 'CURRENCY_NOT_USD', 'EUR'], [6, 'CURRENCY_NOT_USD', 'GBP']]);
  assert.deepEqual(c.recognized.map((x) => x.field), ['sku', 'price', 'cost', 'currency'], 'the currency column is read, not ignored');
});

test('step 72: numbers from an Excel workbook are read without binary float tails', () => {
  // Excel хранит 19.99 как 19.989999999999998: без очистки такая цена была «прочтением в двух смыслах» и строка уходила в негодные
  const book = xlsx([['SKU', 'Price', 'Unit Cost', 'Units Ordered'], ['SYN-X1', '19.989999999999998', '7.1000000000000005', '12'], ['SYN-X2', '1234.5', '600', '3']], {});
  const c = readCatalog(book, 'catalog.xlsx');
  assert.equal(c.format, 'Excel workbook');
  assert.deepEqual(c.rejected, []);
  assert.deepEqual(c.rows.map((r) => [r.sku, r.priceMinor, r.costMinor, r.sales30d]), [['SYN-X1', 1999, 710, 12], ['SYN-X2', 123450, 60000, 3]]);
});
