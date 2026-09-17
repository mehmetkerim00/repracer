import assert from 'node:assert/strict';
import { test } from 'node:test';
import { localDate, omnibusLowestPriorPrice, omnibusVerdict, zonedDayStart } from './omnibus.ts';

/** Р-123: наименьшая цена за 30 суток витрины до начала скидки. Данные синтетические */
const AS_OF = '2027-01-01T00:00:00.000Z';
test('Р-123: the window is the 30 storefront days before the discount day; a day without changes carries the price in effect', () => {
  const tz = 'Europe/Berlin';
  const changes = [
    { acceptedAt: '2026-07-01T10:00:00.000Z', amountMinor: 1990 },
    // 1790 действует с 05.08 по 20.08: дней без изменений в окне много, цена действует
    { acceptedAt: '2026-08-05T09:00:00.000Z', amountMinor: 1790 },
    { acceptedAt: '2026-08-20T09:00:00.000Z', amountMinor: 1890 },
  ];
  const prior = omnibusLowestPriorPrice(changes, tz, '2026-09-10T08:00:00.000Z', AS_OF);
  assert.deepEqual(prior, { status: 'OK', lowestMinor: 1790, windowFrom: '2026-08-11', windowTo: '2026-09-09', timeZone: tz, historySince: '2026-07-01T10:00:00.000Z', historyDays: 70, externalChanges: 0 },
    '1790 was set before the window and was still in effect when it opened');
  assert.equal(omnibusVerdict(prior, 1990), 'VIOLATION');
  assert.equal(omnibusVerdict(prior, 1790), 'COMPLIANT');
  // Окно открывается в полночь по Берлину (22:00 UTC): 1500 заменена в 23:45 по Берлину — к началу окна не действует; 1700 — внутри окна
  assert.equal(omnibusLowestPriorPrice([
    { acceptedAt: '2026-08-10T21:30:00.000Z', amountMinor: 1500 }, { acceptedAt: '2026-08-10T21:45:00.000Z', amountMinor: 1600 },
    { acceptedAt: '2026-08-10T22:30:00.000Z', amountMinor: 1700 },
  ], tz, '2026-09-10T08:00:00.000Z', AS_OF).lowestMinor, 1600);
});

test('Р-123, Р-65: history that starts inside the window cannot confirm a discount; an unknown time zone cannot be checked at all', () => {
  const late = omnibusLowestPriorPrice([{ acceptedAt: '2026-09-01T10:00:00.000Z', amountMinor: 1990 }], 'Europe/Berlin', '2026-09-10T08:00:00.000Z', AS_OF);
  assert.deepEqual([late.status, late.lowestMinor, omnibusVerdict(late, 1990), omnibusVerdict(late, 2100)], ['INCOMPLETE_HISTORY', 1990, 'UNVERIFIED', 'VIOLATION']);
  assert.equal(omnibusLowestPriorPrice([], 'Europe/Berlin', '2026-09-10T08:00:00.000Z', AS_OF).status, 'NO_PRICE_HISTORY');
  assert.equal(omnibusLowestPriorPrice([{ acceptedAt: '2026-08-01T10:00:00.000Z', amountMinor: 1990 }], null, '2026-09-10T08:00:00.000Z', AS_OF).status, 'TIME_ZONE_UNKNOWN');
});

test('review of step 24, findings 1 and 14: prices of the discount day before its start are in the window; a discount starting later is not verifiable yet', () => {
  const tz = 'Europe/Berlin';
  const changes = [{ acceptedAt: '2026-07-01T10:00:00.000Z', amountMinor: 1000 }, { acceptedAt: '2026-09-09T22:05:00.000Z', amountMinor: 500 },
    { acceptedAt: '2026-09-10T09:00:00.000Z', amountMinor: 1000 }];
  // 00:05 по Берлину — 5.00, в 11:00 — 10.00, скидка в 12:00: прежняя цена 10.00 нарушает правило
  const sameDay = omnibusLowestPriorPrice(changes, tz, '2026-09-10T10:00:00.000Z', AS_OF);
  assert.deepEqual([sameDay.status, sameDay.lowestMinor, omnibusVerdict(sameDay, 1000)], ['OK', 500, 'VIOLATION']);
  // Цена после начала скидки в окно не входит
  assert.equal(omnibusLowestPriorPrice(changes, tz, '2026-09-10T08:00:00.000Z', AS_OF).lowestMinor, 500);
  assert.equal(omnibusLowestPriorPrice(changes, tz, '2026-09-09T21:00:00.000Z', AS_OF).lowestMinor, 1000);
  const future = omnibusLowestPriorPrice(changes, tz, '2026-09-20T10:00:00.000Z', '2026-09-15T10:00:00.000Z');
  assert.deepEqual([future.status, omnibusVerdict(future, 500), omnibusVerdict(future, 1000)], ['WINDOW_OPEN', 'UNVERIFIED', 'VIOLATION']);
});

test('Р-124: the check shows how deep the history we see is; a price set outside repracer is in the window and makes the check incomplete', () => {
  const tz = 'Europe/Berlin';
  const changes = [{ acceptedAt: '2026-07-01T10:00:00.000Z', amountMinor: 1990 }];
  // Подключение раньше первой цены — история видна с подключения
  const connected = omnibusLowestPriorPrice(changes, tz, '2026-09-10T08:00:00.000Z', AS_OF, { connectedAt: '2026-06-01T08:00:00.000Z' });
  assert.deepEqual([connected.historySince, connected.historyDays, connected.status], ['2026-06-01T08:00:00.000Z', 101, 'OK']);
  // Цена 17.00, выставленная в кабинете канала и замеченная сверкой, — в окне: наименьшая цена 17.00, прежняя цена 19.90 — нарушение
  const outside = omnibusLowestPriorPrice(changes, tz, '2026-09-10T08:00:00.000Z', AS_OF, { external: [{ at: '2026-09-01T12:00:00.000Z', amountMinor: 1700 }] });
  assert.deepEqual([outside.status, outside.lowestMinor, outside.externalChanges, omnibusVerdict(outside, 1990), omnibusVerdict(outside, 1700)], ['EXTERNAL_CHANGES', 1700, 1, 'VIOLATION', 'UNVERIFIED']);
  // Изменение до окна в окно не входит
  assert.equal(omnibusLowestPriorPrice(changes, tz, '2026-09-10T08:00:00.000Z', AS_OF, { external: [{ at: '2026-07-15T12:00:00.000Z', amountMinor: 1700 }] }).status, 'OK');
});

test('storefront days follow daylight saving time', () => {
  assert.equal(new Date(zonedDayStart('2026-03-29', 'Europe/Berlin')).toISOString(), '2026-03-28T23:00:00.000Z');
  assert.equal(new Date(zonedDayStart('2026-03-30', 'Europe/Berlin')).toISOString(), '2026-03-29T22:00:00.000Z');
  assert.equal(new Date(zonedDayStart('2026-10-26', 'Europe/Vienna')).toISOString(), '2026-10-25T23:00:00.000Z');
  assert.equal(localDate('2026-08-10T22:30:00.000Z', 'Europe/Berlin'), '2026-08-11');
});
