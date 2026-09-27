import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AdapterCallContext, ChannelAdapter, Instant } from '@repracer/channel-port';
import { InMemoryPricingStore, type MemorySeedScope } from './memory-store.ts';
import { createPricingPipeline } from './index.ts';

/**
 * Ревью шага 47, находка 5: пересчёт по расписанию берёт только ДОЛЖНЫЕ единицы (фиксированная и маржинальная стратегия, без
 * решения за 24 часа), самые давние первыми, не больше предела; сбой единицы не проглатывается. Данные синтетические.
 */
const NOW = '2026-09-28T10:00:00.000Z' as Instant;
const scope = (id: string, strategy: MemorySeedScope['strategy']): MemorySeedScope => ({
  writeScopeId: id, productId: `p-${id}`, channelAccountId: 'acc', marketplace: 'EBAY_DE', externalUnitId: id, channelProductRef: id, condition: 'new',
  currency: 'EUR', basis: 'GROSS', pricingMode: 'ENGINE', strategy, currentPriceMinor: 1000, minPrice: { amountMinor: 500, id: `min-${id}` }, maxPrice: { amountMinor: 5000, id: `max-${id}` },
});
const fixed = { strategyId: 'st-f', version: 1, params: { type: 'FIXED' as const, priceMinor: 1299 }, deadbandMinor: 0 };
const buybox = { strategyId: 'st-b', version: 1, params: { type: 'MATCH_BUYBOX' as const, undercutMinor: 5, holdWhenWinning: true, atBound: 'CAP' as const }, deadbandMinor: 0 };

test('должные — без решения за 24 часа, по давности, не больше предела; стратегия по конкурентам не берётся', async () => {
  const store = new InMemoryPricingStore({ channel: 'EBAY', scopes: [scope('a', fixed), scope('b', fixed), scope('c', fixed), scope('d', buybox)] });
  assert.deepEqual(await store.listScheduledScopes('t', 'acc', NOW, 10), ['a', 'b', 'c'], 'без решений должны все фиксированные; MATCH_BUYBOX будит снимок, не расписание');
  const decided = (id: string, at: string) => (store.decisions as unknown as Array<{ writeScopeId: string; decidedAt: string }>).push({ writeScopeId: id, decidedAt: at });
  decided('a', '2026-09-28T09:00:00.000Z');
  decided('b', '2026-09-27T08:00:00.000Z');
  decided('c', '2026-09-27T09:30:00.000Z');
  assert.deepEqual(await store.listScheduledScopes('t', 'acc', NOW, 10), ['b', 'c'], 'решение час назад — не должна; старше суток — должна');
  assert.deepEqual(await store.listScheduledScopes('t', 'acc', NOW, 1), ['b'], 'предел за заход — самые давние первыми');
});

test('сбой единицы считается, называется кодом журнала и не прячется за успехом', async () => {
  const inner = new InMemoryPricingStore({ channel: 'EBAY', scopes: [scope('a', fixed), scope('b', fixed)] });
  const store = new Proxy(inner, { get(target, key, receiver) {
    if (key === 'loadScopeContext') return async () => { throw Object.assign(new Error('synthetic'), { code: 'CONTEXT_LOAD_FAILED' }); };
    const v = Reflect.get(target, key, receiver) as unknown;
    return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
  } });
  const logs: string[] = [];
  const pipeline = createPricingPipeline({ store, adapter: {} as ChannelAdapter, alerts: { raise: async () => undefined }, logger: { log: (e) => { logs.push(e.code); } }, now: () => NOW });
  const ctx = { tenantId: 't', channelAccountId: 'acc', correlationId: 'c', deadline: '2026-09-28T10:10:00.000Z' } as unknown as AdapterCallContext;
  assert.deepEqual(await pipeline.recomputeScheduled(ctx, { limit: 10 }), { scopes: 2, changed: 0, failed: 2, firstError: 'CONTEXT_LOAD_FAILED' });
  assert.equal(logs.filter((c) => c === 'SCHEDULED_RECOMPUTE_FAILED').length, 2);
});
