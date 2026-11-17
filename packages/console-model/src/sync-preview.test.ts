import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LOCALES, messagesFor } from './i18n/index.ts';
import { syncPreview } from './stock.ts';

/**
 * Шаг 160 (#26): превью синхронизации до включения — что получит канал при введённых буфере, потолке и пороге, той же фразой расчёта, что
 * строка таблицы (шаг 138), и одним правилом `publishedQuantity` (stock-sync). Данные синтетические
 */

const en = messagesFor('en');
const rows = [
  { label: 'Desk lamp', available: 60 },
  { label: 'Yoga mat', available: 9 },
  { label: 'Phone stand', available: 3 },
  { label: 'Wall clock', available: 0 },
];

test('step 160 (#26): the preview says what every enabled channel would get — buffer, cap and minimum to list — with the calculation of the rows', () => {
  const p = syncPreview(rows, { buffer: '2', maxQuantity: '50', minToList: '5' }, en)!;
  const c = en.ui.stock.channel;
  assert.deepEqual(p.lines, [
    `Desk lamp: ${c.toPublishCalc({ published: 50, available: 60, buffer: 2, afterBuffer: 58, cap: 50, min: null })}`,
    `Yoga mat: ${c.toPublishCalc({ published: 7, available: 9, buffer: 2, afterBuffer: 7, cap: null, min: null })}`,
    `Phone stand: ${c.toPublishCalc({ published: 0, available: 3, buffer: 2, afterBuffer: 1, cap: null, min: 5 })}`,
    `Wall clock: ${c.toPublishCalc({ published: 0, available: 0, buffer: 2, afterBuffer: 0, cap: null, min: 5 })}`,
  ]);
  assert.equal(p.summary, en.ui.stock.enable.previewSummary(4, 57, 1));
  for (const l of LOCALES) assert.ok(messagesFor(l).ui.stock.enable.previewTitle.trim() !== '', l);
});

test('step 160 (#26): no preview for a value that is not a whole number of pieces', () => {
  assert.equal(syncPreview(rows, { buffer: '-1', maxQuantity: '', minToList: '0' }, en), null);
  assert.equal(syncPreview(rows, { buffer: '1.5', maxQuantity: '', minToList: '0' }, en), null);
  assert.equal(syncPreview(rows, { buffer: '0', maxQuantity: 'x', minToList: '0' }, en), null);
  assert.ok(syncPreview(rows, { buffer: '0', maxQuantity: '', minToList: '0' }, en), 'an empty cap is no cap');
});
