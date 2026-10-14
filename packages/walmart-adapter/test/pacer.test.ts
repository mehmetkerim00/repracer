import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FALLBACK_REPLENISH_MS, NEXT_REPLENISHMENT_HEADER, parseReplenishment, parseTokenCount, TOKEN_COUNT_HEADER, WalmartTokenPacer } from '../src/index.ts';

/** Шаг 89: корзина токенов Walmart читается из заголовков ответа — пустая корзина ждёт пополнения, 429 считается */
const headers = (h: Record<string, string>) => ({ get: (name: string) => h[name.toLowerCase()] ?? null });

function virtualClock(startMs: number) {
  let now = startMs;
  const slept: number[] = [];
  return { nowMs: () => now, sleep: async (ms: number) => { slept.push(ms); now += ms; }, slept };
}

test('step 89: the replenishment time is read as epoch milliseconds, epoch seconds or ISO; the token count only as a whole number', () => {
  assert.equal(parseReplenishment('1791980000000'), 1791980000000);
  assert.equal(parseReplenishment('1791980000'), 1791980000000);
  assert.equal(parseReplenishment('2026-10-14T10:00:00Z'), Date.parse('2026-10-14T10:00:00Z'));
  assert.deepEqual([parseReplenishment(null), parseReplenishment(''), parseReplenishment('soon')], [null, null, null]);
  assert.deepEqual([parseTokenCount('7'), parseTokenCount(' 0 '), parseTokenCount('-1'), parseTokenCount('x'), parseTokenCount(null)], [7, 0, null, null, null]);
});

test('step 89: an empty bucket waits for the named replenishment before the next request; other buckets do not wait', async () => {
  const T0 = Date.parse('2026-10-14T10:00:00Z');
  const clock = virtualClock(T0);
  const pacer = new WalmartTokenPacer(clock);
  await pacer.beforeRequest('inventory');
  pacer.afterResponse('inventory', 200, headers({ [TOKEN_COUNT_HEADER]: '0', [NEXT_REPLENISHMENT_HEADER]: String(T0 + 30_000) }));
  assert.equal(pacer.delayMs('inventory'), 30_000);
  assert.equal(pacer.delayMs('price'), 0, 'another bucket is not held');
  await pacer.beforeRequest('inventory');
  assert.deepEqual(clock.slept, [30_000], 'the next inventory request waited for the replenishment');
  assert.deepEqual([pacer.stats.requests, pacer.stats.waits, pacer.stats.throttled], [2, 1, 0]);
  // Токены есть — запрос не ждёт
  pacer.afterResponse('inventory', 200, headers({ [TOKEN_COUNT_HEADER]: '5', [NEXT_REPLENISHMENT_HEADER]: String(clock.nowMs() + 60_000) }));
  assert.equal(pacer.delayMs('inventory'), 0);
});

test('step 89: a 429 empties the bucket until the named replenishment, or a minute when the channel names none', () => {
  const T0 = Date.parse('2026-10-14T10:00:00Z');
  const clock = virtualClock(T0);
  const pacer = new WalmartTokenPacer(clock);
  pacer.afterResponse('price', 429, headers({ [NEXT_REPLENISHMENT_HEADER]: String(T0 + 12_000) }));
  assert.equal(pacer.delayMs('price'), 12_000);
  pacer.afterResponse('items', 429, headers({}));
  assert.equal(pacer.delayMs('items'), FALLBACK_REPLENISH_MS);
  assert.equal(pacer.stats.throttled, 2);
});
