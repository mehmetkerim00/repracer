import assert from 'node:assert/strict';
import { test } from 'node:test';
import { messagesFor } from './i18n/index.ts';
import { storefrontChip, unitOf, type StandWorld } from './world.ts';

/**
 * Шаг 111 [Р-237] на модели экранов (данные синтетические): витрина в таблицах и списках — чип площадки с буквой; короткое имя витрины рядом —
 * только когда у пространства больше одной витрины этой площадки; подпись предложения целиком (поиск, подсказки, выгрузки, письма) — прежняя
 */

const en = messagesFor('en');
const accounts = (list: Array<[string, string[]]>) => ({ accounts: list.map(([channel, marketplaces], i) => ({ channelAccountId: `acc-${i}`, channel, marketplaces })) }) as unknown as Pick<StandWorld, 'accounts'>;

test('step 111 [Р-237]: one storefront of a platform — the chip alone; two storefronts of one platform — the short name beside it; the full name is always there', () => {
  const us = accounts([['AMAZON', ['ATVPDKIKX0DER']], ['EBAY', ['EBAY_US']], ['WALMART', ['WALMART_US']]]);
  assert.deepEqual(storefrontChip(us, 'AMAZON', 'ATVPDKIKX0DER', en), { channel: 'AMAZON', letter: 'a', full: 'amazon.com', short: null });
  assert.deepEqual(storefrontChip(us, 'EBAY', 'EBAY_US', en), { channel: 'EBAY', letter: 'e', full: 'ebay.com', short: null });
  assert.deepEqual(storefrontChip(us, 'WALMART', 'WALMART_US', en), { channel: 'WALMART', letter: 'w', full: 'walmart.com', short: null });
  // Две витрины одной площадки (два аккаунта Amazon — ЕС и США) — без короткого имени неоднозначно
  const both = accounts([['AMAZON', ['A1PA6795UKMFR9']], ['AMAZON', ['ATVPDKIKX0DER']], ['KAUFLAND', ['de']]]);
  assert.deepEqual(storefrontChip(both, 'AMAZON', 'A1PA6795UKMFR9', en), { channel: 'AMAZON', letter: 'a', full: 'amazon.de', short: '.de' });
  assert.deepEqual(storefrontChip(both, 'AMAZON', 'ATVPDKIKX0DER', en), { channel: 'AMAZON', letter: 'a', full: 'amazon.com', short: '.com' });
  // Kaufland — «k» (профиль eu); одна витрина — без короткого имени. Код витрины Amazon и её имя — одна витрина, а не две
  assert.deepEqual(storefrontChip(both, 'KAUFLAND', 'de', en), { channel: 'KAUFLAND', letter: 'k', full: 'kaufland.de', short: null });
  assert.equal(storefrontChip(accounts([['AMAZON', ['ATVPDKIKX0DER', 'us']]]), 'AMAZON', 'us', en).short, null);
  // Без пространства (нечего сравнивать) — чип без короткого имени
  assert.equal(storefrontChip(null, 'EBAY', 'EBAY_DE', en).short, null);
});

test('step 111 [Р-237]: an offer in a table — the product name beside the chip; the whole label stays for search, hints, files and mail', () => {
  const world = { ...accounts([['AMAZON', ['ATVPDKIKX0DER']]]) } as unknown as StandWorld;
  const scope = { writeScopeId: 'ws-1', channelAccountId: 'acc-0', marketplace: 'ATVPDKIKX0DER', externalUnitId: 'SYN-SKU-111', channelProductRef: 'B0SYN111', condition: 'new', gtin: null, title: 'Plant pot, green', sku: 'SYN-SKU-111' };
  const unit = unitOf(world, scope as never, en);
  assert.equal(unit.name, 'Plant pot, green');
  assert.equal(unit.label, 'Plant pot, green · amazon.com');
  assert.deepEqual(unit.storefront, { channel: 'AMAZON', letter: 'a', full: 'amazon.com', short: null });
});
