import assert from 'node:assert/strict';
import { test } from 'node:test';
import { localDate, omnibusLowestPriorPrice, omnibusVerdict, zonedDayStart } from './omnibus.ts';

/** Р-123: наименьшая цена за 30 суток витрины до начала скидки. Данные синтетические */
test('Р-123: the window is the 30 storefront days before the discount day; a day without changes carries the price in effect', () => {
  const tz = 'Europe/Berlin';
  const changes = [
    { acceptedAt: '2026-07-01T10:00:00.000Z', amountMinor: 1990 },
    // 1790 действует с 05.08 по 20.08: дней без изменений в окне много, цена действует
    { acceptedAt: '2026-08-05T09:00:00.000Z', amountMinor: 1790 },
    { acceptedAt: '2026-08-20T09:00:00.000Z', amountMinor: 1890 },
  ];
  const prior = omnibusLowestPriorPrice(changes, tz, '2026-09-10T08:00:00.000Z');
  assert.deepEqual(prior, { status: 'OK', lowestMinor: 1790, windowFrom: '2026-08-11', windowTo: '2026-09-09', timeZone: tz, historySince: '2026-07-01T10:00:00.000Z' },
    '1790 was set before the window and was still in effect when it opened');
  assert.equal(omnibusVerdict(prior, 1990), 'VIOLATION');
  assert.equal(omnibusVerdict(prior, 1790), 'COMPLIANT');
  // Окно открывается в полночь по Берлину (22:00 UTC): 1500 заменена в 23:45 по Берлину — к началу окна не действует; 1700 — внутри окна
  assert.equal(omnibusLowestPriorPrice([
    { acceptedAt: '2026-08-10T21:30:00.000Z', amountMinor: 1500 }, { acceptedAt: '2026-08-10T21:45:00.000Z', amountMinor: 1600 },
    { acceptedAt: '2026-08-10T22:30:00.000Z', amountMinor: 1700 },
  ], tz, '2026-09-10T08:00:00.000Z').lowestMinor, 1600);
});

test('Р-123, Р-65: history that starts inside the window cannot confirm a discount; an unknown time zone cannot be checked at all', () => {
  const late = omnibusLowestPriorPrice([{ acceptedAt: '2026-09-01T10:00:00.000Z', amountMinor: 1990 }], 'Europe/Berlin', '2026-09-10T08:00:00.000Z');
  assert.deepEqual([late.status, late.lowestMinor, omnibusVerdict(late, 1990), omnibusVerdict(late, 2100)], ['INCOMPLETE_HISTORY', 1990, 'UNVERIFIED', 'VIOLATION']);
  assert.equal(omnibusLowestPriorPrice([], 'Europe/Berlin', '2026-09-10T08:00:00.000Z').status, 'NO_PRICE_HISTORY');
  assert.equal(omnibusLowestPriorPrice([{ acceptedAt: '2026-08-01T10:00:00.000Z', amountMinor: 1990 }], null, '2026-09-10T08:00:00.000Z').status, 'TIME_ZONE_UNKNOWN');
});

test('storefront days follow daylight saving time', () => {
  assert.equal(new Date(zonedDayStart('2026-03-29', 'Europe/Berlin')).toISOString(), '2026-03-28T23:00:00.000Z');
  assert.equal(new Date(zonedDayStart('2026-03-30', 'Europe/Berlin')).toISOString(), '2026-03-29T22:00:00.000Z');
  assert.equal(new Date(zonedDayStart('2026-10-26', 'Europe/Vienna')).toISOString(), '2026-10-25T23:00:00.000Z');
  assert.equal(localDate('2026-08-10T22:30:00.000Z', 'Europe/Berlin'), '2026-08-11');
});
