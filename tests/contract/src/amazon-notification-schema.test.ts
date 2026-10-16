import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { anyOfferChanged } from './amazon-fixtures/build.ts';
import { loadNotificationSchema, notificationBodies, strictErrors } from './amazon-fixtures/schema-check.ts';

/**
 * Шаг 97 [Р-221]: фикстуры уведомлений Amazon проходят официальную схему снимка, и ни одного поля вне схемы. Заглушки больше не прячут
 * дефект: фикстуры несли `IsBuyBoxWinner`, которого в ANY_OFFER_CHANGED нет, — и разбор держателя Buy Box был «зелёным» только на них
 */

const FIXTURES = new URL('../fixtures/amazon/', import.meta.url);
const SCHEMAS = { ANY_OFFER_CHANGED: loadNotificationSchema('AnyOfferChangedNotification.json'), PRICING_HEALTH: loadNotificationSchema('PricingHealthNotification.json') };

test('step 97 [Р-221]: every Amazon notification in the stand fixtures passes the official schema, with no field outside it', () => {
  const files = readdirSync(FIXTURES).filter((f) => f.endsWith('.json')).sort();
  let bodies = 0;
  const problems: string[] = [];
  for (const file of files) {
    for (const b of notificationBodies(JSON.parse(readFileSync(new URL(file, FIXTURES), 'utf8')))) {
      bodies += 1;
      for (const e of strictErrors(SCHEMAS[b.type], b.body)) problems.push(`${file}${b.path}${e}`);
    }
  }
  assert.ok(bodies >= 30, `the fixtures carry notifications (${bodies})`);
  assert.deepEqual(problems, [], 'a stand notification has a field the channel does not send, or lacks one the schema requires');
});

test('step 97 [Р-221]: the notification builder names no Buy Box holder — the price comes from Summary.BuyBoxPrices', () => {
  const body = anyOfferChanged('syn-97-1', 'ATVPDKIKX0DER', 'B0SYN00097', '2026-10-16T10:00:00.000Z', [
    { seller: 'harbor', minor: 1800, shippingMinor: 0, buyBoxWinner: true }, { seller: 'self', minor: 1850 },
  ]);
  assert.deepEqual(strictErrors(SCHEMAS.ANY_OFFER_CHANGED, body), []);
  const payload = (body.Payload as { AnyOfferChangedNotification: { Offers: Array<Record<string, unknown>>; Summary: { BuyBoxPrices: Array<Record<string, unknown>> } } }).AnyOfferChangedNotification;
  assert.equal(payload.Offers.some((o) => 'IsBuyBoxWinner' in o), false);
  assert.deepEqual(payload.Summary.BuyBoxPrices[0]!.ListingPrice, { Amount: 18, CurrencyCode: 'EUR' });
});

test('step 97 [Р-221]: positive control — the check refuses a field the schema does not describe and a missing required one', () => {
  const body = anyOfferChanged('syn-97-2', 'ATVPDKIKX0DER', 'B0SYN00097', '2026-10-16T10:00:00.000Z', [{ seller: 'harbor', minor: 1800, buyBoxWinner: true }]);
  const payload = (body.Payload as { AnyOfferChangedNotification: { Offers: Array<Record<string, unknown>>; Summary: Record<string, unknown> } }).AnyOfferChangedNotification;
  payload.Offers[0]!.IsBuyBoxWinner = true;
  delete payload.Summary.ListPrice;
  assert.deepEqual(strictErrors(SCHEMAS.ANY_OFFER_CHANGED, body).sort(), [
    '.Payload.AnyOfferChangedNotification.Offers[0].IsBuyBoxWinner: not in the schema',
    '.Payload.AnyOfferChangedNotification.Summary.ListPrice: required by the schema',
  ]);
});
