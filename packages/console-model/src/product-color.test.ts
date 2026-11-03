import assert from 'node:assert/strict';
import { test } from 'node:test';
import { swatchOf } from './color.ts';
import { messagesFor } from './i18n/index.ts';
import { buildImportPlan, importMapping, importTemplate, IMPORT_SCHEMAS } from './imports.ts';
import { EXPORT_HEADERS } from './screen-export.ts';
import { unitOf, type StandWorld } from './world.ts';

/**
 * Шаг 112 [Р-238] на модели (данные синтетические): цвет товара — слово продавца; кружок-образец — только у известного слова, незнакомое —
 * только текстом, из названия цвет не выводится; импорт «Product details» — строка на ТОВАР (цвет один на всех его витринах): шаблон с
 * текущим цветом, примерка — изменится, без изменений, «-» снимает цвет, ошибки по строкам; выгрузки несут цвет своей колонкой
 */

const en = messagesFor('en');

test('step 112 [Р-238]: a sample circle only for a known color word; an unknown word — text only, nothing guessed', () => {
  assert.deepEqual(['grey', 'Gray', 'GRAU', 'gris', 'black', 'weiß', 'Rouge', 'verde', 'navy blue', 'multicolor', 'dark grey', '', null].map(swatchOf),
    ['grey', 'grey', 'grey', 'grey', 'black', 'white', 'red', 'green', null, null, null, null, null]);
});

function world(scopes: Array<{ ws: string; product: string; sku: string; unit: string; title: string; color: string | null; account?: string }>): StandWorld {
  return {
    accounts: [{ channelAccountId: 'acc-amazon', channel: 'AMAZON', marketplaces: ['ATVPDKIKX0DER'] }, { channelAccountId: 'acc-ebay', channel: 'EBAY', marketplaces: ['EBAY_US'] }],
    state: {
      scopes: scopes.map((s) => ({
        writeScopeId: s.ws, productId: s.product, sku: s.sku, title: s.title, color: s.color, channelAccountId: s.account ?? 'acc-amazon',
        marketplace: s.account === 'acc-ebay' ? 'EBAY_US' : 'ATVPDKIKX0DER', externalUnitId: s.unit, channelProductRef: '', condition: 'new', gtin: null,
      })),
      strategies: [], strategyVersions: [], offerChannelPricing: [],
    },
  } as unknown as StandWorld;
}

test('step 112 [Р-238]: an offer carries the color of its product and its sample; the label stays without the color — files carry it as a column', () => {
  const w = world([{ ws: 'ws-1', product: 'p-1', sku: 'SYN-MUG', unit: 'SYN-MUG', title: 'Travel mug', color: 'grey' }]);
  const unit = unitOf(w, w.state.scopes[0]!, en);
  assert.deepEqual([unit.name, unit.color, unit.swatch, unit.label], ['Travel mug', 'grey', 'grey', 'Travel mug · amazon.com']);
  for (const screen of ['price-changes', 'decisions', 'stopped-by-people', 'prevented-by-rules', 'offers', 'offer-competitors'] as const) {
    const h = EXPORT_HEADERS[screen];
    assert.equal(h[h.indexOf('offer') + 1], 'color', `${screen}: the color column right after the offer`);
  }
  assert.equal(EXPORT_HEADERS.inventory[EXPORT_HEADERS.inventory.indexOf('product') + 1], 'color');
});

test('step 112 [Р-238]: the Product details template — one row per product (not per offer) with its current color', () => {
  const w = world([
    { ws: 'ws-1', product: 'p-1', sku: 'SYN-MUG', unit: 'SYN-MUG', title: 'Travel mug', color: 'grey' },
    { ws: 'ws-2', product: 'p-1', sku: 'SYN-MUG', unit: 'SYN-MUG', title: 'Travel mug', color: 'grey', account: 'acc-ebay' },
    { ws: 'ws-3', product: 'p-2', sku: 'SYN-LAMP', unit: 'SYN-LAMP', title: 'Desk lamp', color: null },
  ]);
  const tpl = importTemplate('PRODUCTS', w, en);
  assert.deepEqual(tpl.header, ['sku', 'title', 'color']);
  assert.deepEqual(tpl.rows, [['SYN-MUG', 'Travel mug', 'grey'], ['SYN-LAMP', 'Desk lamp', '']], 'two offers of one product — one row');
  assert.equal(tpl.fileName, 'product-details-template');
  assert.deepEqual(IMPORT_SCHEMAS.PRODUCTS.map((s) => s.field), ['sku', 'title', 'color']);
});

test('step 112 [Р-238]: the check — a new color changes, the same stays, «-» removes it; a bad value, an unknown SKU and a shared key are rows with errors', () => {
  const w = world([
    { ws: 'ws-1', product: 'p-1', sku: 'SYN-MUG', unit: 'SYN-MUG', title: 'Travel mug', color: 'grey' },
    { ws: 'ws-2', product: 'p-2', sku: 'SYN-LAMP', unit: 'SYN-LAMP', title: 'Desk lamp', color: null },
    { ws: 'ws-3', product: 'p-3', sku: 'SYN-POT', unit: 'SYN-POT', title: 'Plant pot', color: 'green' },
    { ws: 'ws-4', product: 'p-4', sku: 'SYN-CLOCK', unit: 'SYN-SHARED', title: 'Wall clock', color: null },
    { ws: 'ws-5', product: 'p-5', sku: 'SYN-SCALE', unit: 'SYN-SHARED', title: 'Kitchen scale', color: null },
  ]);
  const rows = [['sku', 'title', 'color'], ['SYN-MUG', '', 'Navy   blue'], ['SYN-LAMP', '', 'black'], ['SYN-POT', '', '-'], ['SYN-CLOCK', '', 'green'],
    ['SYN-POT2', '', 'red'], ['SYN-SHARED', '', 'red'], ['SYN-SCALE', '', 'x'.repeat(41)]];
  const sheet = { rows, lines: rows.map((_, i) => i + 1) };
  const plan = buildImportPlan('PRODUCTS', sheet, importMapping('PRODUCTS', sheet), w, en);
  assert.deepEqual(plan.changed.map((r) => [r.target, r.set.color, r.expected.color]),
    [['p-1', 'Navy blue', 'grey'], ['p-2', 'black', null], ['p-3', '', 'green'], ['p-4', 'green', null]], 'spaces collapsed, «-» — remove (empty set)');
  assert.deepEqual(plan.errors.map((e) => [e.line, e.problem]), [[6, 'NOT_FOUND'], [7, 'AMBIGUOUS'], [8, 'COLOR_INVALID']]);
  // То же значение — без изменений; пустая ячейка — не менять
  const same = [['sku', 'color'], ['SYN-MUG', 'grey'], ['SYN-LAMP', '']];
  const sameSheet = { rows: same, lines: same.map((_, i) => i + 1) };
  const p2 = buildImportPlan('PRODUCTS', sameSheet, importMapping('PRODUCTS', sameSheet), w, en);
  assert.deepEqual([p2.changed.length, p2.unchanged, p2.errors.length], [0, 2, 0]);
});
