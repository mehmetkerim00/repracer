import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nextNineUtc } from './live/demo-world.ts';

/**
 * Шаг 36: старт виртуального мира — скрытый вход живого прогона. Демо-сутки не поднимались вовсе, когда прогон шёл до
 * 09:00 UTC: посев объявляет себестоимость за сутки ДО старта мира, страж Р-131 спрашивает, действует ли она СЕЙЧАС, а
 * старт «09:00 UTC завтрашних суток» уносил её в будущее. Проверяется не значение, а два СВОЙСТВА старта — на каждом часе
 * суток, потому что именно час суток и был скрытым входом.
 */
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

test('шаг 36: старт мира — всегда впереди часов базы и не дальше суток (проверено на каждом часе суток)', () => {
  const base = Date.UTC(2026, 8, 23, 0, 0, 0);
  for (let hour = 0; hour < 24; hour++) {
    for (const minute of [0, 30, 59]) {
      const now = base + hour * HOUR + minute * 60_000;
      const start = Date.parse(nextNineUtc(now));
      // 1) Старт строго в будущем: мир, отставший от часов базы, считает внесённую себестоимость ещё не действующей (шаг 34)
      assert.ok(start > now, `старт впереди часов базы: ${new Date(now).toISOString()} → ${new Date(start).toISOString()}`);
      // 2) Себестоимость посева (сутки до старта) действует уже сейчас — иначе включение движка отклонит база [Р-131]
      assert.ok(start - DAY <= now,
        `себестоимость за сутки до старта действует при ${new Date(now).toISOString()}: ${new Date(start - DAY).toISOString()}`);
      // 3) Час старта один и тот же при любом часе прогона: граница суток UTC пересекается одинаково
      assert.equal(new Date(start).getUTCHours(), 9);
      assert.equal(new Date(start).getUTCMinutes(), 0);
    }
  }
});
