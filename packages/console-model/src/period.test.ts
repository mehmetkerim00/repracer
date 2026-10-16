import assert from 'node:assert/strict';
import { test } from 'node:test';
import { messagesFor, parsePeriod, periodDays, periodPhrase, periodRange, zonedDayStart } from './index.ts';

const q = (s: string) => parsePeriod(new URLSearchParams(s));

test('step 96: a period is a named preset or a calendar range — anything else is refused, not guessed', () => {
  assert.equal(q(''), undefined, 'no period — the route default');
  assert.deepEqual([q('period=24h'), q('period=7d'), q('period=30d')], [{ preset: '24h' }, { preset: '7d' }, { preset: '30d' }]);
  assert.deepEqual(q('from=2026-10-01&to=2026-10-05'), { from: '2026-10-01', to: '2026-10-05' });
  // Свободное число дней, неверная дата, конец раньше начала, половина диапазона, пресет вместе с диапазоном — отказ
  for (const bad of ['period=100000', 'period=7', 'from=2026-10-01', 'to=2026-10-05', 'from=2026-02-30&to=2026-03-01', 'from=2026-10-05&to=2026-10-01',
    'from=2026-10-01&to=2026-10-05&period=7d', 'from=1e3&to=2026-10-05', 'from= 2026-10-01&to=2026-10-05']) {
    assert.equal(q(bad), null, bad);
  }
});

test('step 96: custom dates are days of the workspace time zone, daylight saving time included', () => {
  // Нью-Йорк летом — UTC−4, зимой — UTC−5; Берлин летом — UTC+2
  assert.equal(new Date(zonedDayStart('2026-10-01', 'America/New_York')).toISOString(), '2026-10-01T04:00:00.000Z');
  assert.equal(new Date(zonedDayStart('2026-11-02', 'America/New_York')).toISOString(), '2026-11-02T05:00:00.000Z');
  assert.equal(new Date(zonedDayStart('2026-10-01', 'Europe/Berlin')).toISOString(), '2026-09-30T22:00:00.000Z');
  assert.equal(new Date(zonedDayStart('2026-10-01', 'UTC')).toISOString(), '2026-10-01T00:00:00.000Z');
  const now = '2026-10-15T16:00:00.000Z';
  // Диапазон — от полуночи первой даты до конца последней по часам пространства, не позже «сейчас»
  assert.deepEqual(periodRange({ from: '2026-10-01', to: '2026-10-05' }, now, 'America/New_York', 30),
    { since: '2026-10-01T04:00:00.000Z', until: '2026-10-06T04:00:00.000Z', clipped: false, maxDays: 30 });
  assert.equal(periodRange({ from: '2026-10-14', to: '2026-10-15' }, now, 'UTC', 30).until, now, 'the range ends now, not tomorrow midnight');
  // Пресет — назад от «сейчас»
  assert.deepEqual(periodRange({ preset: '24h' }, now, 'Europe/Berlin', 30), { since: '2026-10-14T16:00:00.000Z', until: now, clipped: false, maxDays: 30 });
  // Глубже хранения экрана — отрезано и названо
  const old = periodRange({ from: '2026-08-01', to: '2026-10-05' }, now, 'UTC', 30);
  assert.deepEqual([old.since, old.clipped], ['2026-09-15T16:00:00.000Z', true]);
  assert.equal(periodRange({ preset: '30d' }, now, 'UTC', 30).clipped, false, 'the 30-day preset fits a 30-day buffer');
  // Сутки окна по поясу — для графика
  assert.equal(periodDays(periodRange({ from: '2026-10-01', to: '2026-10-05' }, now, 'America/New_York', 30), 'America/New_York'), 5);
  assert.equal(periodDays(periodRange({ preset: '7d' }, now, 'UTC', 30), 'UTC'), 8, '7 × 24 hours back from 16:00 touch eight calendar days');
});

test('step 96: the phrase of a period speaks the screen language', () => {
  const en = messagesFor('en');
  const de = messagesFor('de');
  assert.equal(periodPhrase({ preset: '7d' }, en), 'in the last 7 days');
  assert.equal(periodPhrase({ preset: '24h' }, de), 'in den letzten 24 Stunden');
  assert.match(periodPhrase({ from: '2026-10-01', to: '2026-10-05' }, en), /^from Oct 1, 2026 to Oct 5, 2026$/);
  assert.match(periodPhrase({ from: '2026-10-01', to: '2026-10-05' }, de), /^vom 1\. Okt\. 2026 bis 5\. Okt\. 2026$/);
});
