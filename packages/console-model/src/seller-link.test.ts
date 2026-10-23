import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sellerLink } from './seller-link.ts';

/**
 * Шаг 107 [Р-232]: имя продавца-конкурента — внешняя ссылка на его страницу на площадке, только из настоящего идентификатора, который дал
 * канал. Amazon: SellerId предложения (ANY_OFFER_CHANGED) → `https://www.amazon.<витрина>/sp?seller=<SellerId>` — факт владельца
 * (docs/channels/amazon.md). Демо, симулятор (имена, а не идентификаторы), каналы без идентификатора — текст; «You» и неизвестный — никогда
 */
const AMAZON_COM = 'ATVPDKIKX0DER';
const AMAZON_DE = 'A1PA6795UKMFR9';
const base = { channel: 'AMAZON', marketplace: AMAZON_COM, self: false, demo: false };

test('step 107 (1) [Р-232]: an Amazon SellerId becomes the seller page on its storefront', () => {
  assert.equal(sellerLink({ ...base, sellerRef: 'A3TH9S8BH6GOGM' }), 'https://www.amazon.com/sp?seller=A3TH9S8BH6GOGM');
  assert.equal(sellerLink({ ...base, marketplace: AMAZON_DE, sellerRef: 'A2SYN1070000AB' }), 'https://www.amazon.de/sp?seller=A2SYN1070000AB');
});

test('step 107 (2) [Р-232]: without a real channel identifier the name stays text — no dead links', () => {
  // имя симулятора и демо — с пробелами, не идентификатор
  assert.equal(sellerLink({ ...base, sellerRef: 'Simulated competitor 1' }), null, 'a simulator name');
  assert.equal(sellerLink({ ...base, sellerRef: 'A3TH9S8BH6GOGM', demo: true }), null, 'the demo is synthetic');
  assert.equal(sellerLink({ ...base, sellerRef: null }), null, 'no seller named');
  assert.equal(sellerLink({ ...base, sellerRef: '' }), null, 'an empty seller');
  assert.equal(sellerLink({ ...base, sellerRef: 'A3TH9S8BH6GOGM&tab=x' }), null, 'not an identifier');
  // каналы без идентификатора продавца с известной страницей
  assert.equal(sellerLink({ ...base, channel: 'KAUFLAND', marketplace: 'de', sellerRef: 'Harbor Goods' }), null, 'Kaufland names a pseudonym');
  assert.equal(sellerLink({ ...base, channel: 'WALMART', marketplace: 'walmart.com', sellerRef: 'A3TH9S8BH6GOGM' }), null, 'Walmart: no known seller page');
  assert.equal(sellerLink({ ...base, channel: 'EBAY', marketplace: 'EBAY_US', sellerRef: 'A3TH9S8BH6GOGM' }), null, 'eBay gives no competitors');
  // идентификатор другого канала не открывает страницу Amazon даже на витрине Amazon
  assert.equal(sellerLink({ ...base, channel: 'WALMART', sellerRef: 'A3TH9S8BH6GOGM' }), null, 'not an Amazon seller');
  // витрина, у которой адрес не записан, — текст, а не выдуманный адрес
  assert.equal(sellerLink({ ...base, marketplace: 'A13V1IB3VIYZZH', sellerRef: 'A3TH9S8BH6GOGM' }), null, 'an unknown storefront');
});

test('step 107 (C) [Р-232]: «You» and the unknown holder never become links', () => {
  assert.equal(sellerLink({ ...base, sellerRef: 'A3TH9S8BH6GOGM', self: true }), null, 'our own row');
  assert.equal(sellerLink({ ...base, sellerRef: undefined }), null, 'the unknown holder has no seller');
});
