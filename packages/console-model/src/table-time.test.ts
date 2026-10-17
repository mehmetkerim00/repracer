import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LOCALES, messagesFor, tableWhenParts } from './index.ts';

/**
 * Шаг 100 (D, находка по скринам владельца): в английском шапка колонки «When · UTC−4», строки короткие («Oct 17, 15:41»); в испанском
 * каждая строка несла полную дату с годом и поясом и переносилась на две строки. Момент таблицы — один разбор для всех языков: месяц на
 * языке экрана, без года, пояс отдельно. Проверяется каждый месяц каждого языка — французские «févr.», «août», испанское «sept»
 */
test('step 100 (D): a table moment is short in every language — the month of the screen, no year, the zone apart', () => {
  for (const locale of LOCALES) {
    const m = messagesFor(locale, { timeZone: 'America/New_York' });
    for (let month = 1; month <= 12; month += 1) {
      const iso = `2026-${String(month).padStart(2, '0')}-17T21:41:00Z`;
      const full = m.when(iso);
      const parts = tableWhenParts(full);
      assert.ok(parts, `${locale} ${month}: «${full}» is read`);
      assert.ok(!/\d{4}/.test(parts.short), `${locale} ${month}: no year in the row — «${parts.short}»`);
      assert.ok(!parts.short.includes('UTC'), `${locale} ${month}: the zone is not in the row — «${parts.short}»`);
      assert.match(parts.zone, /^UTC−[45]$/, `${locale} ${month}: the zone goes to the head of the column`);
      assert.ok(parts.short.endsWith(month >= 3 && month <= 10 ? '17:41' : '16:41'), `${locale} ${month}: local time — «${parts.short}»`);
      assert.ok(full.startsWith(parts.short.split(',')[0]!), `${locale} ${month}: the short form keeps the day and month of the full one`);
    }
  }
  // Как выглядит строка на каждом языке — образец английского
  const row = (locale: (typeof LOCALES)[number]) => tableWhenParts(messagesFor(locale, { timeZone: 'America/New_York' }).when('2026-10-17T19:41:00Z'))!.short;
  assert.deepEqual([row('en'), row('es'), row('fr'), row('de')], ['Oct 17, 15:41', 'oct 17, 15:41', 'oct. 17, 15:41', '17. Okt., 15:41']);
  // Строка не того вида — не момент: показывается как есть
  assert.equal(tableWhenParts('yesterday'), null);
});
