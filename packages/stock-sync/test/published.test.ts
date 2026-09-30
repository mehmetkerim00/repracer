import assert from 'node:assert/strict';
import { test } from 'node:test';
import { availableOf, parseStockSheet, parseQuantityCell, publishedQuantity, suggestStockColumns, InMemoryStockStore } from '../src/index.ts';

/**
 * Р-6 (шаг 35): правило публикуемого количества — одно на все каналы (docs/domain-model.md §3.27). Здесь оно проверяется
 * по случаям, в которых расходятся буфер, потолок и порог листинга; равенство этому правилу у базы утверждает тест
 * хранилища на PostgreSQL. Данные синтетические.
 */

test('Р-6: публикуемое = доступное минус буфер, не выше потолка, ниже порога — ноль', () => {
  const a = { bufferUnits: 2, maxQuantity: null, minQuantityToList: 0 };
  assert.deepEqual([0, 1, 2, 3, 10].map((n) => publishedQuantity(n, a)), [0, 0, 0, 1, 8], 'буфер съедает первые две штуки, отрицательного не бывает');
  assert.equal(publishedQuantity(100, { ...a, maxQuantity: 5 }), 5, 'потолок ограничивает после буфера');
  // Порог листинга: «две штуки не продаём» значит 0, а не 2 — иначе канал показывал бы товар, которого не хотим показывать
  assert.deepEqual([publishedQuantity(5, { bufferUnits: 0, maxQuantity: null, minQuantityToList: 4 }), publishedQuantity(3, { bufferUnits: 0, maxQuantity: null, minQuantityToList: 4 })], [5, 0]);
  // Потолок ниже порога: правило считает по РЕЗУЛЬТАТУ — потолок обрезал до 3, порог 4 гасит в ноль
  assert.equal(publishedQuantity(100, { bufferUnits: 0, maxQuantity: 3, minQuantityToList: 4 }), 0);
});

test('Р-25: доступное — остаток минус открытые резервации, и оно не уходит в минус', () => {
  assert.deepEqual([availableOf(10, 3), availableOf(3, 10), availableOf(0, 0)], [7, 0, 0]);
});

test('Р-152: файл остатков — две колонки по заголовку; непонятая строка называется, а не угадывается', () => {
  const sheet = [
    ['Artikelnummer', 'Bestand'],
    ['A-1', '10'],
    ['A-2', '12,0'],
    ['A-3', 'viel'],
    ['A-1', '3'],
    ['', ''],
    ['A-4', '-1'],
  ];
  const parsed = parseStockSheet(sheet);
  assert.ok(!('code' in parsed));
  assert.deepEqual(parsed.rows, [{ sku: 'A-1', quantity: 10 }, { sku: 'A-2', quantity: 12 }]);
  assert.deepEqual(parsed.skipped, [
    { line: 4, sku: 'A-3', reason: 'BAD_QUANTITY' },
    { line: 5, sku: 'A-1', reason: 'DUPLICATE_SKU' },
    { line: 7, sku: 'A-4', reason: 'BAD_QUANTITY' },
  ], 'пустая строка — не ошибка, остальное названо с номером строки файла');
  assert.deepEqual([suggestStockColumns(['SKU', 'Quantity']), suggestStockColumns(['Artikel', 'Preis'])], [{ sku: 0, quantity: 1 }, { code: 'QUANTITY_COLUMN_MISSING' }]);
  assert.deepEqual(['12', '12,0', '12.0', ' 7 '].map(parseQuantityCell), [12, 12, 12, 7]);
  assert.deepEqual(['12,5', '1e3', '0x10', '-1', '100000', ''].map(parseQuantityCell), [null, null, null, null, null, null]);
});

test('Р-6: хранилище в памяти считает то же, что правило: заказ уменьшает доступное, отгрузка — пул', async () => {
  const offers = [{ productId: 'p-1', sku: 'A-1', channelAccountId: 'acc', channel: 'KAUFLAND', marketplaces: ['de', 'at'], externalOfferId: 'OFFER-1' }];
  const store = new InMemoryStockStore(offers, { roleOf: (a) => (a.membershipId === 'm' ? 'OWNER' : 'ADMIN') });
  const actor = { membershipId: 'm', userId: 'u', mfa: true };
  const source = await store.createStockSource('t', { mode: 'INTERNAL_POOL', name: 'L' }, actor) as { stockSourceId: string };
  await store.importStock('t', source.stockSourceId, [{ sku: 'A-1', quantity: 10 }], actor);
  // Шаг 60 [Р-202]: без ответа о других инструментах и подтверждения владельца запись количества выключена
  assert.deepEqual(await store.enableStockSync('t', 'acc', { bufferUnits: 2, maxQuantity: null, minQuantityToList: 0, acknowledgeSideEffects: false }, actor), { status: 'NOT_CONFIRMED', otherTools: null });
  await store.answerOtherTools('t', 'acc', 'NONE', actor);
  assert.equal((await store.confirmQuantityWrites('t', 'acc', 'acc', actor)).status, 'CONFIRMED');
  await store.enableStockSync('t', 'acc', { bufferUnits: 2, maxQuantity: null, minQuantityToList: 0, acknowledgeSideEffects: false }, actor);
  const now = new Date().toISOString();
  assert.deepEqual((await store.recalculate('t', null, now as never)).writes.map((w) => w.quantity), [8]);
  const line = (ref: string, status: 'OPEN' | 'SHIPPED') => ({ externalOrderRef: `o-${ref}`, externalOrderLineRef: `l-${ref}`, identity: { marketplace: 'de', externalOfferId: 'OFFER-1' }, quantity: 1, orderedAt: now as never, status });
  assert.equal((await store.recordOrderLines('t', 'acc', [line('a', 'OPEN')], now as never)).created, 1);
  let row = (await store.stockPage('t', { offset: 0, limit: 10 })).items[0]!;
  assert.deepEqual([row.onHand, row.reserved, row.available, row.channels[0]!.published], [10, 1, 9, 7]);
  assert.deepEqual((await store.recalculate('t', [row.productId], now as never)).writes.map((w) => w.quantity), [7], 'резервация уменьшила публикуемое — ушла новая версия');
  assert.equal((await store.recordOrderLines('t', 'acc', [line('a', 'SHIPPED')], now as never)).consumed, 1);
  row = (await store.stockPage('t', { offset: 0, limit: 10 })).items[0]!;
  // Отгрузка списала пул и закрыла резервацию: доступное то же, публикуемое не меняется — канал не трогаем зря
  assert.deepEqual([row.onHand, row.reserved, row.available, row.channels[0]!.published], [9, 0, 9, 7]);
  assert.equal((await store.recalculate('t', [row.productId], now as never)).writes.length, 0);
});

/**
 * Шаг 61 (отложенное шага 60): хранилище в памяти подтверждает и отзывает запись количества теми же правилами, что база (0160): только
 * владелец, набранным ВНЕШНИМ идентификатором аккаунта; отзыв выключает синхронизацию и снимает неотправленные версии, а включить снова
 * можно только новым подтверждением
 */
test('Р-202: в памяти — как в базе: владелец и внешний идентификатор при подтверждении, отзыв снимает неотправленное', async () => {
  const offers = [{ productId: 'p-1', sku: 'A-1', channelAccountId: 'acc', channel: 'KAUFLAND', marketplaces: ['de'], externalOfferId: 'OFFER-1', externalAccountId: 'syn-seller-1' }];
  const store = new InMemoryStockStore(offers, { roleOf: (a) => (a.membershipId === 'owner' ? 'OWNER' : 'ADMIN') });
  const owner = { membershipId: 'owner', userId: 'u', mfa: false };
  const admin = { membershipId: 'admin', userId: 'v', mfa: true };
  const source = await store.createStockSource('t', { mode: 'INTERNAL_POOL', name: 'L' }, owner) as { stockSourceId: string };
  await store.importStock('t', source.stockSourceId, [{ sku: 'A-1', quantity: 10 }], owner);
  await store.answerOtherTools('t', 'acc', 'NONE', owner);
  assert.equal((await store.quantityWritesState('t', 'acc'))?.externalAccountId, 'syn-seller-1', 'экран называет внешний идентификатор, а не наш');
  assert.equal((await store.confirmQuantityWrites('t', 'acc', 'syn-seller-1', admin)).status, 'NOT_OWNER', 'администратор не подтверждает — как в базе');
  assert.equal((await store.confirmQuantityWrites('t', 'acc', 'acc', owner)).status, 'CONFIRMATION_MISMATCH', 'наш идентификатор аккаунта — не набранный внешний');
  assert.equal((await store.confirmQuantityWrites('t', 'acc', ' syn-seller-1 ', owner)).status, 'CONFIRMED');
  await store.enableStockSync('t', 'acc', { bufferUnits: 2, maxQuantity: null, minQuantityToList: 0, acknowledgeSideEffects: false }, owner);
  assert.equal((await store.recalculate('t', null, new Date().toISOString() as never)).writes.length, 1, 'ждущая версия количества');
  assert.equal((await store.revokeQuantityWrites('t', 'acc', 'syn-seller-1', admin)).status, 'NOT_OWNER');
  assert.equal((await store.revokeQuantityWrites('t', 'acc', 'syn-seller-2', owner)).status, 'CONFIRMATION_MISMATCH');
  assert.deepEqual(await store.revokeQuantityWrites('t', 'acc', 'syn-seller-1', owner), { status: 'REVOKED', disabledScopes: 1, discardedWrites: 1, inFlightWrites: 0 });
  assert.equal((await store.revokeQuantityWrites('t', 'acc', 'syn-seller-1', owner)).status, 'NOT_CONFIRMED', 'отзывать нечего');
  assert.equal((await store.stockPage('t', { offset: 0, limit: 10 })).summary.pendingWrites, 0, 'неотправленная версия снята');
  assert.deepEqual(await store.enableStockSync('t', 'acc', { bufferUnits: 2, maxQuantity: null, minQuantityToList: 0, acknowledgeSideEffects: false }, owner),
    { status: 'NOT_CONFIRMED', otherTools: 'NONE' }, 'включить снова — только новым подтверждением');
  assert.equal((await store.confirmQuantityWrites('t', 'acc', 'syn-seller-1', owner)).status, 'CONFIRMED', 'новое подтверждение после отзыва');
});
