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

test('step 54: discovery reads past 1000 offers, and when it does reach its page limit it says so with a WARNING', async () => {
  const run = async (pagesInChannel: number, maxPages?: number, circle = false) => {
    let read = 0;
    const alerts: string[] = [];
    const adapter = {
      async discoverOffers(_ctx: unknown, page: { cursor?: string }) {
        const n = page.cursor ? Number(page.cursor) : 0;
        read += 1;
        return { items: [{ identity: { marketplace: 'A1PA6795UKMFR9', externalSku: `syn-sku-${n}` }, gtins: [], condition: 'NEW', fulfillment: 'MERCHANT' }], ...(n + 1 < pagesInChannel ? { nextCursor: String(n + 1) } : {}) };
      },
    } as unknown as ChannelAdapter;
    const store = { async recordOfferChannelPricing() { return 0; }, async recordDiscoveredOffers(_t: unknown, _a: unknown, items: unknown[]) { return items.length; },
      ...(circle ? { async discoveryCircleState() { return null; }, async saveDiscoveryCircle() { return 'SAVED'; } } : {}) } as unknown as PricingStore;
    const pipeline = createPricingPipeline({ store, adapter, alerts: { raise: async (a: { code: string }) => { alerts.push(a.code); } } as never,
      logger: { log: () => undefined }, now: () => '2026-09-29T09:00:00.000Z' as never, sleep: async () => undefined });
    const r = await pipeline.discoverOffers(ctx('2026-09-29T09:25:00.000Z'), { pageLimit: 1, ...(maxPages ? { maxPages } : {}) });
    return { read, catalogued: r.catalogued, alerts };
  };
  const big = await run(1200);
  assert.deepEqual([big.read, big.catalogued, big.alerts], [1200, 1200, []], 'the old limit of 50 pages is gone; a whole catalogue is read with no alert');
  const capped = await run(10, 4);
  assert.deepEqual([capped.read, capped.alerts], [4, ['DISCOVERY_PAGE_LIMIT_REACHED']], 'at the limit with a cursor left — WARNING');
  const exact = await run(4, 4);
  assert.deepEqual(exact.alerts, [], 'a catalogue that ends exactly at the limit is complete — no alert');
  const circled = await run(10, 4, true);
  assert.deepEqual([circled.read, circled.alerts], [4, []], 'step 57 (review of step 55, finding 11): with a circle store the limit is the circle going on — no alert');
});

test('step 55 (OQ-240): discovery is a circle — a run stopped by its deadline or by the app quota is continued by the next one from the same place', async () => {
  // Канал: 6 страниц; страницы с курсором `t…` — «фаза Trading», их квоту называет адаптер
  const cursors = [undefined, 'i1', 'i2', 't3', 't4', 't5'];
  let nowMs = Date.parse('2026-09-29T09:00:00.000Z');
  const read: Array<string | undefined> = [];
  const adapter = {
    descriptor: { channel: 'EBAY' },
    discoveryQuotaOf: (c: string | undefined) => (c?.startsWith('t') ? 'EBAY_TRADING' : null),
    async discoverOffers(_ctx: unknown, page: { cursor?: string }) {
      read.push(page.cursor);
      nowMs += 10_000; // страница — 10 с по часам ядра
      const i = cursors.indexOf(page.cursor);
      return { items: [{ identity: { marketplace: 'EBAY_DE', externalSku: `syn-sku-${i}` }, gtins: [], condition: 'NEW', fulfillment: 'MERCHANT' }], ...(i + 1 < cursors.length ? { nextCursor: cursors[i + 1] } : {}) };
    },
  } as unknown as ChannelAdapter;
  const saved: Array<{ startedFrom: string | null; cursor: string | null; stop: string }> = [];
  let circle: string | null = null;
  let tradingGranted = 1;
  const store = {
    async recordOfferChannelPricing() { return 0; }, async recordDiscoveredOffers(_t: unknown, _a: unknown, items: unknown[]) { return items.length; },
    async discoveryCircleCursor() { return circle; },
    async saveDiscoveryCircle(_t: unknown, _a: unknown, e: { startedFrom: string | null; cursor: string | null; stop: string }) { saved.push(e); circle = e.cursor; },
    async reserveAppCall(channel: string, quota: string, limit: number) { assert.deepEqual([channel, quota, limit], ['EBAY', 'EBAY_TRADING', 3000]); return tradingGranted-- > 0; },
  } as unknown as PricingStore;
  const pipeline = createPricingPipeline({ store, adapter, alerts: { raise: async () => undefined }, logger: { log: () => undefined },
    now: () => new Date(nowMs).toISOString() as never, sleep: async () => undefined });
  const run = (deadlineInMs: number) => pipeline.discoverOffers(ctx(new Date(nowMs + deadlineInMs).toISOString()), { pageLimit: 1, quotas: { EBAY_TRADING: 3000 }, deadlineMarginMs: 5_000 });

  // Заход 1: срок позволяет две страницы (34 с; запас — две самых долгих страницы, 20 с) — остановился по сроку, место записано
  const first = await run(34_000);
  assert.deepEqual([first.stop, first.resumed, read], ['DEADLINE', false, [undefined, 'i1']]);
  // Заход 2: продолжает с i2; квота Trading даёт одну страницу — остановился по квоте перед второй
  const second = await run(600_000);
  assert.deepEqual([second.stop, second.resumed, read.slice(2)], ['APP_QUOTA', true, ['i2', 't3']]);
  // Заход 3: квота восстановилась (новые сутки) — дочитал круг, курсор снят
  tradingGranted = 5;
  const third = await run(600_000);
  assert.deepEqual([third.stop, read.slice(4)], ['COMPLETED', ['t4', 't5']]);
  assert.deepEqual(saved.map((s) => [s.startedFrom, s.cursor, s.stop]), [[null, 'i2', 'DEADLINE'], ['i2', 't4', 'APP_QUOTA'], ['t4', null, 'COMPLETED']]);
  // Заход 4: новый круг с начала
  await run(15_000);
  assert.equal(read[6], undefined, 'after a completed circle the next run starts from the first page');
});

test('step 56 (review of step 55, findings 3–4): a failure keeps the progress; a failure on the resumed place resets the circle; a closed circle is not re-read before its time', async () => {
  const cursors = [undefined, 'p1', 'p2', 'p3'];
  let nowMs = Date.parse('2026-09-29T09:00:00.000Z');
  let failAt: string | null = 'p2';
  const alerts: string[] = [];
  const reasons: string[] = [];
  const adapter = {
    descriptor: { channel: 'EBAY' },
    async discoverOffers(_ctx: unknown, page: { cursor?: string }) {
      // Ревью шага 70, находка 3: отказ — формы ChannelCallError адаптеров (код в `.error.code`), а не голый `.code`
      if (page.cursor === failAt) throw Object.assign(new Error('channel refused'), { error: { code: 'CHANNEL_UNAVAILABLE', class: 'TRANSIENT', scope: 'BATCH' } });
      const i = cursors.indexOf(page.cursor);
      return { items: [], ...(i + 1 < cursors.length ? { nextCursor: cursors[i + 1] } : {}) };
    },
  } as unknown as ChannelAdapter;
  let state: { cursor: string | null; circleStartedAt: string | null; lastCircleCompletedAt: string | null; lastStop: string | null } | null = null;
  const saved: Array<[string | null, string | null, string]> = [];
  let failures = 0;
  const store = {
    async recordOfferChannelPricing() { return 0; }, async recordDiscoveredOffers() { return 0; },
    async discoveryCircleState() { return state; },
    async saveDiscoveryCircle(_t: unknown, _a: unknown, e: { startedFrom: string | null; cursor: string | null; stop: string; at: string; noProgress: boolean }) {
      saved.push([e.startedFrom, e.cursor, e.stop]);
      failures = e.noProgress ? failures + 1 : 0;
      const reset = failures >= 3;
      if (reset) failures = 0;
      state = { cursor: reset ? null : e.cursor, circleStartedAt: null, lastCircleCompletedAt: e.stop === 'COMPLETED' ? e.at : state?.lastCircleCompletedAt ?? null, lastStop: e.stop };
      return reset ? 'RESET' : 'SAVED';
    },
  } as unknown as PricingStore;
  const pipeline = createPricingPipeline({ store, adapter, alerts: { raise: async (a: { code: string; details?: { reason?: string } }) => { alerts.push(a.code); if (a.details?.reason) reasons.push(a.details.reason); } } as never, logger: { log: () => undefined },
    now: () => new Date(nowMs).toISOString() as never, sleep: async () => undefined });
  const run = () => pipeline.discoverOffers(ctx(new Date(nowMs + 600_000).toISOString()), { pageLimit: 1, circleEveryMs: 86_400_000 });
  // Отказ на p2 после двух прочитанных страниц — место p2 записано, прогресс не пропал
  await assert.rejects(run(), /channel refused/);
  assert.deepEqual(saved.at(-1), [null, 'p2', 'FAILED']);
  // Следующие заходы падают на том же месте, не прочитав ни страницы: место держится; на третьем подряд круг сброшен к началу (шаг 57)
  await assert.rejects(run(), /channel refused/);
  await assert.rejects(run(), /channel refused/);
  assert.deepEqual([(state as { cursor: string | null } | null)?.cursor, alerts], ['p2', []], 'two failures at the resume point keep the place');
  await assert.rejects(run(), /channel refused/);
  assert.deepEqual([(state as { cursor: string | null } | null)?.cursor, alerts], [null, ['DISCOVERY_CIRCLE_RESET']]);
  assert.deepEqual(reasons, ['CHANNEL_UNAVAILABLE'], 'the reset names the code of the channel error, not FAILED');
  // Канал ожил — круг с начала до конца; следующий заход в пределах суток канал не трогает
  failAt = null;
  assert.equal((await run()).stop, 'COMPLETED');
  nowMs += 3_600_000;
  assert.equal((await run()).stop, 'NOT_DUE');
  nowMs += 86_400_000;
  assert.equal((await run()).stop, 'COMPLETED', 'a new circle once the circle interval has passed');
});
