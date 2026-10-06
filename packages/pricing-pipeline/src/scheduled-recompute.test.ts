import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AdapterCallContext, ChannelAdapter, Instant } from '@repracer/channel-port';
import { InMemoryPricingStore, type MemorySeedScope } from './memory-store.ts';
import { createPricingPipeline, floorRaiseRetryable } from './index.ts';

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
  assert.deepEqual(await pipeline.recomputeScheduled(ctx, { limit: 10 }), { scopes: 2, changed: 0, failed: 2, firstError: 'CONTEXT_LOAD_FAILED', raised: 0 });
  assert.equal(logs.filter((c) => c === 'SCHEDULED_RECOMPUTE_FAILED').length, 2);
});

/**
 * Ревью шага 73, находка 1 [Р-209, Р-210]: запрос базы на переоценку снимается только суждением. Сбой фиксации, смена контекста до
 * последней попытки, пропуск бюджетом правок и удержание Gate остановкой человеком, недоверием каналу или частотой — запрос остаётся;
 * зафиксированный подъём, «без изменения», отказ перепроверки пола базой и единица не под движком — запрос снят
 */
test('step 73: a re-evaluation request is kept unless the evaluation reached a judgement', () => {
  const report = (stages: Array<{ stage: string; outcome: string; reason?: { code: string; params: Record<string, unknown> } }>, rejectionReason: string | null = null, withDecision = true) =>
    ({ writeScopeId: 'a', stages, ...(withDecision ? { decision: { rejectionReason } } : {}) }) as unknown as Parameters<typeof floorRaiseRetryable>[0];
  const kept = [
    report([{ stage: 'COMMIT', outcome: 'ERROR' }]),
    report([{ stage: 'COMMIT', outcome: 'BOUNDS_CHANGED' }]),
    report([{ stage: 'SCOPE', outcome: 'SKIPPED', reason: { code: 'WRITE_EDIT_BUDGET_EXHAUSTED', params: {} } }], null, false),
    report([], 'PRICING_STOPPED'),
    report([], 'CHANNEL_DISTRUSTED'),
    report([], 'CHANGE_RATE_LIMIT'),
  ];
  assert.deepEqual(kept.map(floorRaiseRetryable), [true, true, true, true, true, true]);
  const taken = [
    report([]),
    report([], 'BELOW_MARGIN_FLOOR'),
    report([{ stage: 'WRITE_RECHECK', outcome: 'BLOCKED' }]),
    report([{ stage: 'SCOPE', outcome: 'SKIPPED', reason: { code: 'SCOPE_NOT_ENGINE', params: {} } }], null, false),
  ];
  assert.deepEqual(taken.map(floorRaiseRetryable), [false, false, false, false]);
});

test('step 73: a unit under a channel distrust is not picked for a re-evaluation — the request waits for the release', async () => {
  const store = new InMemoryPricingStore({ channel: 'EBAY', scopes: [scope('a', buybox), scope('b', buybox)] });
  store.requestFloorRaise('a', 'COST_UPDATE', NOW);
  store.requestFloorRaise('b', 'COST_UPDATE', NOW);
  (store.distrusts as unknown as Array<Record<string, unknown>>).push({ distrustId: 'dt', releasedAt: null, channelAccountId: 'acc', marketplace: 'EBAY_DE', reasonCode: 'PRICE_BASIS_MISMATCH' });
  assert.deepEqual((await store.listFloorRaiseScopes('t', 'acc', NOW, 10)).map((c) => c.writeScopeId), [], 'both units are held');
  (store.distrusts as unknown as Array<Record<string, unknown>>)[0]!.releasedAt = NOW;
  assert.deepEqual((await store.listFloorRaiseScopes('t', 'acc', NOW, 10)).map((c) => [c.writeScopeId, c.after]), [['a', 'COST_UPDATE'], ['b', 'COST_UPDATE']], 'after the release the requests are there');
});
