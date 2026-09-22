import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChannelAdapter } from '@repracer/channel-port';
import { createStockPipeline } from '../src/pipeline.ts';
import type { StockStore } from '../src/store.ts';

/**
 * OQ-216 (шаг 35, найдено прогоном суток): бюджет канала делят опрос конкурентов, записи и ЧТЕНИЕ ЗАКАЗОВ. Работа
 * `order-lines` роняла весь такт, когда бюджета не хватило, — резервации создавались на пять минут позже, а доступный
 * остаток в каналах всё это время был завышен. Правило то же, что у обхода предложений, и записано оно один раз — в
 * порте канала.
 */

class BudgetError extends Error {
  readonly error: { code: string; retryAt?: string; class: string; scope: string; message: string; raiseAlert: boolean };
  constructor(error: BudgetError['error']) { super(error.code); this.error = error; }
}

function harness(retryAt: string | undefined, refuseTimes: number) {
  let nowMs = Date.parse('2026-09-22T09:00:00.000Z');
  const slept: number[] = [];
  let refused = 0;
  let calls = 0;
  const adapter = {
    async readOrderLines() {
      if (refused < refuseTimes) {
        refused += 1;
        throw new BudgetError({ code: 'RATE_LIMITED', class: 'TRANSIENT', scope: 'BATCH', message: 'budget', raiseAlert: false, ...(retryAt ? { retryAt } : {}) });
      }
      calls += 1;
      return { items: [{ externalOrderRef: 'o-1', externalOrderLineRef: 'l-1', identity: { marketplace: 'de', externalOfferId: 'SYN-1' }, quantity: 1, orderedAt: new Date(nowMs).toISOString(), status: 'OPEN' }] };
    },
  } as unknown as ChannelAdapter;
  const store = {
    async recordOrderLines() { return { created: 1, consumed: 0, released: 0, unknownOffers: 0, productIds: [] }; },
    async recalculate() { return { writes: [], unchanged: 0 }; },
  } as unknown as StockStore;
  const pipeline = createStockPipeline({
    store, now: () => new Date(nowMs).toISOString() as never,
    sleep: async (ms) => { slept.push(ms); nowMs += ms; },
  });
  return { pipeline, slept, adapter, reads: () => calls };
}

const ctx = (deadline: string) => ({ tenantId: 't' as never, channelAccountId: 'a' as never, correlationId: 'oq-216', deadline: deadline as never });

test('OQ-216: чтение заказов ждёт до retryAt и читает окно заново, а не роняет работу', async () => {
  const h = harness('2026-09-22T09:00:00.400Z', 1);
  const r = await h.pipeline.syncOrders(ctx('2026-09-22T09:02:00.000Z'), h.adapter, '2026-09-22T08:55:00.000Z' as never);
  assert.deepEqual(h.slept, [400], 'пауза ровно до retryAt, а не «сколько-то»');
  assert.deepEqual([r.lines, r.created, h.reads()], [1, 1, 1], 'окно прочитано после паузы, строка заказа стала резервацией');
});

test('OQ-216: retryAt за сроком вызова — ошибка наружу без ожидания, работу повторит планировщик [Р-132]', async () => {
  const h = harness('2026-09-22T09:05:00.000Z', 1);
  await assert.rejects(
    h.pipeline.syncOrders(ctx('2026-09-22T09:00:30.000Z'), h.adapter, '2026-09-22T08:55:00.000Z' as never),
    (e: BudgetError) => e.error.code === 'RATE_LIMITED');
  assert.deepEqual([h.slept, h.reads()], [[], 0], 'за сроком вызова не ждём вовсе');
});
