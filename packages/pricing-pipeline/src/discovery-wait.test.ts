import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChannelAdapter } from '@repracer/channel-port';
import { createPricingPipeline } from './pipeline.ts';
import type { PricingStore } from './store.ts';

/**
 * OQ-216 (шаг 35): «подождите до retryAt» от адаптера — не провал обхода предложений. Часы и пауза здесь подменены: пауза
 * двигает часы ровно на запрошенное, и по ним же видно, что ждали до `retryAt`, а не «сколько-то». Второй случай — срок
 * вызова: если `retryAt` за ним, ошибка уходит наружу без ожидания.
 */

class BudgetError extends Error {
  readonly error: { code: string; retryAt?: string; class: string; scope: string; message: string; raiseAlert: boolean };
  constructor(error: BudgetError['error']) { super(error.code); this.error = error; }
}

function harness(retryAt: string | undefined, refuseTimes: number) {
  let nowMs = Date.parse('2026-09-22T09:00:00.000Z');
  const slept: number[] = [];
  const pages: Array<string | undefined> = [];
  let refused = 0;
  const adapter = {
    async discoverOffers(_ctx: unknown, page: { cursor?: string }) {
      if (refused < refuseTimes) {
        refused += 1;
        throw new BudgetError({ code: 'RATE_LIMITED', class: 'TRANSIENT', scope: 'BATCH', message: 'budget', raiseAlert: false, ...(retryAt ? { retryAt } : {}) });
      }
      pages.push(page.cursor);
      return page.cursor ? { items: [] } : { items: [], nextCursor: 'p2' };
    },
  } as unknown as ChannelAdapter;
  const store = { async recordOfferChannelPricing() { return 0; }, async recordDiscoveredOffers() { return 0; } } as unknown as PricingStore;
  const pipeline = createPricingPipeline({
    store, adapter, alerts: { raise: async () => undefined }, logger: { log: () => undefined },
    now: () => new Date(nowMs).toISOString() as never,
    sleep: async (ms) => { slept.push(ms); nowMs += ms; },
  });
  return { pipeline, slept, pages };
}

const ctx = (deadline: string) => ({ tenantId: 't' as never, channelAccountId: 'a' as never, correlationId: 'oq-216', deadline: deadline as never });

test('OQ-216: отказ бюджета с retryAt внутри срока вызова — пауза ровно до retryAt и та же страница заново', async () => {
  const h = harness('2026-09-22T09:00:00.700Z', 1);
  const r = await h.pipeline.discoverOffers(ctx('2026-09-22T09:25:00.000Z'), { pageLimit: 20 });
  assert.deepEqual(h.slept, [700], 'ждали ровно до retryAt, не дольше и не «по умолчанию»');
  assert.deepEqual(h.pages, [undefined, 'p2'], 'после паузы — та же первая страница, потом вторая');
  assert.equal(r.offers, 0);
});

test('OQ-216: retryAt за сроком вызова — ошибка наружу без ожидания; отказ без retryAt — тоже', async () => {
  const late = harness('2026-09-22T09:30:00.000Z', 1);
  await assert.rejects(late.pipeline.discoverOffers(ctx('2026-09-22T09:25:00.000Z')), /RATE_LIMITED/);
  assert.deepEqual(late.slept, [], 'за сроком не ждём');
  const blind = harness(undefined, 1);
  await assert.rejects(blind.pipeline.discoverOffers(ctx('2026-09-22T09:25:00.000Z')), /RATE_LIMITED/);
  assert.deepEqual(blind.slept, [], 'без retryAt ждать нечего');
});

test('OQ-216: бюджет, который не восполняется, не ждётся вечно — после десяти пауз ошибка наружу', async () => {
  const stuck = harness('2026-09-22T09:00:00.100Z', 100);
  await assert.rejects(stuck.pipeline.discoverOffers(ctx('2026-09-22T09:25:00.000Z')), /RATE_LIMITED/);
  assert.equal(stuck.slept.length, 10);
});

test('step 53: a cursor seen before stops discovery, keeps the pages already recorded and raises a WARNING', async () => {
  // Канал отдаёт курсоры A → B → A: третья страница была бы повтором первой, а цикл — вечным
  const next: Record<string, string> = { '': 'A', A: 'B', B: 'A' };
  const pages: Array<string | undefined> = [];
  const catalogued: number[] = [];
  const alerts: Array<{ code: string; severity: string }> = [];
  const adapter = {
    async discoverOffers(_ctx: unknown, page: { cursor?: string }) {
      pages.push(page.cursor);
      const sku = `syn-sku-${page.cursor ?? '0'}`;
      return { items: [{ identity: { marketplace: 'A1PA6795UKMFR9', externalSku: sku }, gtins: [], condition: 'NEW', fulfillment: 'MERCHANT' }], nextCursor: next[page.cursor ?? ''] };
    },
  } as unknown as ChannelAdapter;
  const store = {
    async recordOfferChannelPricing() { return 0; },
    async recordDiscoveredOffers(_t: unknown, _a: unknown, items: unknown[]) { catalogued.push(items.length); return items.length; },
  } as unknown as PricingStore;
  const pipeline = createPricingPipeline({
    store, adapter, alerts: { raise: async (a: { code: string; severity: string }) => { alerts.push({ code: a.code, severity: a.severity }); } } as never,
    logger: { log: () => undefined }, now: () => '2026-09-29T09:00:00.000Z' as never, sleep: async () => undefined,
  });
  const r = await pipeline.discoverOffers(ctx('2026-09-29T09:25:00.000Z'), { pageLimit: 1 });
  assert.deepEqual(pages, [undefined, 'A', 'B'], 'the repeated cursor A is not read again');
  assert.equal(r.catalogued, 3, 'the three pages read are kept, not thrown away');
  assert.deepEqual(catalogued, [1, 1, 1]);
  assert.deepEqual(alerts.filter((a) => a.code === 'CHANNEL_PAGE_CURSOR_REPEATED'), [{ code: 'CHANNEL_PAGE_CURSOR_REPEATED', severity: 'WARNING' }]);
});
