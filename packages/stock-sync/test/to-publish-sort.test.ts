import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareStockRows, toPublishKey, type StockChannelRow, type StockRow } from '../src/index.ts';

/**
 * Шаг 166 (решение владельца по #26): порядок «по публикуемому» — только внутри выбранного канала. Публикуемое — число единицы записи
 * количества, то есть канала, а не товара: ключ товара — число его ЕДИНСТВЕННОЙ включённой единицы этого канала. Нет такой единицы или их
 * несколько (два аккаунта, два региона) — числа у товара нет, и он идёт после товаров с числом; агрегатов (максимум, сумма) нет. Одно
 * правило у хранилища в памяти и у теста равенства с запросом PostgreSQL. Данные синтетические
 */

const unit = (channel: string, published: number, syncEnabled = true): StockChannelRow => ({
  writeScopeId: `ws-${channel}-${published}-${syncEnabled}`, channelAccountId: `acc-${channel}`, channel, marketplaces: [], syncEnabled, published,
  allocation: null, sent: null, confirmed: null, divergence: null, sideEffects: { requiresAck: false, acknowledged: false, text: null },
});
const row = (sku: string, available: number, channels: StockChannelRow[], reserved = 0): StockRow => ({
  productId: `p-${sku}`, sku, title: null, color: null, gtin: null, onHand: available + reserved, reserved, available, channels,
});

test('step 166: the key to sort by «to publish» is the number of the one enabled stock line of the chosen channel — none or several, no number', () => {
  assert.equal(toPublishKey(row('a', 9, [unit('AMAZON', 7)]), 'AMAZON'), 7);
  assert.equal(toPublishKey(row('b', 9, [unit('AMAZON', 7), unit('WALMART', 3)]), 'WALMART'), 3, 'the number of that channel, not another');
  assert.equal(toPublishKey(row('c', 9, [unit('AMAZON', 7, false)]), 'AMAZON'), null, 'sync off — nothing to publish, no number');
  assert.equal(toPublishKey(row('d', 9, [unit('WALMART', 3)]), 'AMAZON'), null, 'no stock line on the channel');
  assert.equal(toPublishKey(row('e', 9, [unit('AMAZON', 7), { ...unit('AMAZON', 4), writeScopeId: 'ws-second', channelAccountId: 'acc-second' }]), 'AMAZON'), null,
    'two stock lines on one channel (two accounts or regions) — no invented maximum or sum');
});

test('step 166: «to publish» sorts by the key, highest first; products without a number follow by available; then SKU', () => {
  const rows = [
    row('none-big', 50, []),
    row('low', 9, [unit('AMAZON', 2)]),
    row('high', 3, [unit('AMAZON', 8)]),
    row('none-small', 1, [unit('WALMART', 1)]),
    row('high-b', 30, [unit('AMAZON', 8)]),
  ];
  assert.deepEqual([...rows].sort((a, b) => compareStockRows(a, b, 'TO_PUBLISH', 'AMAZON')).map((r) => r.sku), ['high-b', 'high', 'low', 'none-big', 'none-small']);
  assert.deepEqual([...rows].sort((a, b) => compareStockRows(a, b, 'AVAILABLE', null)).map((r) => r.sku), ['none-big', 'high-b', 'low', 'high', 'none-small'], 'the old order stays');
});
