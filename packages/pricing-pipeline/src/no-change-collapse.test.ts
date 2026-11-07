import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChannelAdapter, CompetitorSnapshot, CompetitorSourceDescriptor } from '@repracer/channel-port';
import { DEFAULT_MEMBERS, InMemoryPricingStore, type MemorySeedScope } from './memory-store.ts';
import { NO_CHANGE_PULSE_SECONDS, noChangeStateOf, repeatsNoChange } from './no-change.ts';
import { createPricingPipeline } from './pipeline.ts';

/**
 * Шаг 116 [Р-241]: журнал о решениях, а не о чтениях. Строка «без изменения» пишется при смене состояния единицы и не реже раза в сутки, между ними —
 * живая строка со счётчиком. Любое «не рассчитано» — такая же запись со своим кодом. Хранилище в памяти, данные синтетические
 */
const ACCOUNT = 'acc-amazon';
const US = 'ATVPDKIKX0DER';
const BASE = Date.parse('2026-11-06T10:00:00.000Z');
const at = (minutes: number) => new Date(BASE + minutes * 60_000).toISOString();
const usd = (amountMinor: number) => ({ amountMinor, currency: 'USD', basis: 'NET' as const });
const SOURCE: CompetitorSourceDescriptor = {
  source: 'AMAZON_COMPETITIVE_SUMMARY', kind: 'PULL', completeness: { kind: 'TOP_N', n: 20 }, conditions: ['new'], hasBuyboxWinner: true, hasBuyboxPrice: true, hasFulfilment: true,
  hasOwnRank: false, hasShipping: true, typicalStalenessSeconds: null, availability: 'AVAILABLE', role: 'PRIMARY',
};
const HOLD_LOW = { strategyId: 'st-hold', version: 1, deadbandMinor: 0, params: { type: 'BEAT_LOWEST', undercutMinor: 1, scope: 'VISIBLE_TOP_N', compareLanded: false, atBound: 'HOLD' } };
const LANDED = { strategyId: 'st-landed', version: 1, deadbandMinor: 0, params: { type: 'BEAT_LOWEST', undercutMinor: 1, scope: 'VISIBLE_TOP_N', compareLanded: true, atBound: 'CAP' } };
const MATCH = { strategyId: 'st-match', version: 1, deadbandMinor: 0, params: { type: 'MATCH_BUYBOX', undercutMinor: 1, holdWhenWinning: true, atBound: 'CAP' } };

const scope = (over: Partial<MemorySeedScope> = {}): MemorySeedScope => ({
  writeScopeId: 'ws-1', productId: 'prod-1', channelAccountId: ACCOUNT, marketplace: US, externalUnitId: 'SYN-SKU-1', channelProductRef: 'B0SYN00001',
  condition: 'new', currency: 'USD', basis: 'NET', pricingMode: 'ENGINE', strategy: HOLD_LOW as never,
  currentPriceMinor: 1900, minPrice: { amountMinor: 1000, id: 'min-1' }, maxPrice: { amountMinor: 5000, id: 'max-1' },
  cost: { currency: 'USD', costProfileId: 'cp-1', unitCostMinor: 500, fixedFeeMinor: 0, feeRateBp: 1500, tax: { regime: 'SALES_TAX_EXCLUDED' } } as never,
  ...over,
});

function harness(seed: Partial<MemorySeedScope> = {}) {
  const store = new InMemoryPricingStore({ channel: 'AMAZON', region: 'NA', marketplaces: { [US]: { currency: 'USD', basis: 'NET' } }, scopes: [scope(seed)] });
  const adapter = {
    descriptor: { channel: 'AMAZON', competitorSources: [SOURCE], marketplaces: [{ code: US, currency: 'USD', priceBasis: 'NET', timeZone: null }] },
    planDispatch: () => ({ batches: [], rejected: [] }),
  } as unknown as ChannelAdapter;
  let now = at(0);
  const alerts: string[] = [];
  const pipeline = createPricingPipeline({ store, adapter, alerts: { raise: async (a: { code: string }) => { alerts.push(a.code); } } as never, logger: { log: () => undefined }, now: () => now as never });
  const ctx = { tenantId: 't' as never, channelAccountId: ACCOUNT as never, correlationId: 'step116', deadline: at(100_000) as never };
  /** Снимок: самая низкая цена конкурента; решение по нему — одна оценка */
  const market = async (minutes: number, lowest: number, over: Partial<CompetitorSnapshot> = {}) => {
    now = at(minutes);
    return pipeline.processSnapshot(ctx, {
      marketplace: US, channelProductRef: 'B0SYN00001', condition: 'new', source: SOURCE.source, observedAt: at(minutes), completeness: { kind: 'TOP_N', n: 1 },
      offers: [{ isSelf: false, sellerRef: 'SYN_OTHER', price: usd(lowest), shipping: usd(0), fulfillment: 'MFN' }], ...over,
    } as CompetitorSnapshot);
  };
  const rows = () => store.decisions.map((d) => ({ reason: d.noChangeReason ?? d.outcome, repeats: d.repeatsBefore ?? 0 }));
  const live = async () => (await store.loadScopeContext('t', 'ws-1', now as never))!.context.scope.noChange ?? null;
  return { store, pipeline, ctx, market, rows, live, alerts, setNow: (minutes: number) => { now = at(minutes); } };
}

const AT_TARGET = 1901; // цель 19.00 = нынешней цене: ALREADY_AT_TARGET
const BELOW_FLOOR = 900; // цель ниже пола 10.00: TARGET_OUTSIDE_BOUNDS_HOLD

test('step 116 [Р-241]: the state of a unit is its reason, held price, strategy version and bounds; a competitor price or an age never enters it', () => {
  const state = (over: { reason?: { code: string; params: Record<string, unknown> }; proposedMinor?: number; strategyVersion?: number; floor?: number; ceiling?: number } = {}) => noChangeStateOf(
    { reason: over.reason ?? { code: 'TARGET_OUTSIDE_BOUNDS_HOLD', params: { targetMinor: 899, minMinor: 1000, maxMinor: 5000, currency: 'USD' } }, proposedMinor: over.proposedMinor ?? 1900, strategyId: 'st', strategyVersion: over.strategyVersion ?? 1 } as never,
    { effectiveFloorMinor: over.floor ?? 1000, effectiveCeilingMinor: over.ceiling ?? 5000 } as never);
  const base = state();
  assert.equal(state({ reason: { code: 'TARGET_OUTSIDE_BOUNDS_HOLD', params: { targetMinor: 799, minMinor: 1000, maxMinor: 5000, currency: 'USD' } } }), base, 'the target comes from a competitor price: it does not change the state');
  for (const changed of [state({ reason: { code: 'ALREADY_AT_TARGET', params: {} } }), state({ proposedMinor: 1950 }), state({ strategyVersion: 2 }), state({ floor: 1100 }), state({ ceiling: 4900 })]) assert.notEqual(changed, base);
  const unmet = (list: string, age: number) => state({ reason: { code: 'COMPETITOR_REQUIREMENT_NOT_MET', params: { unmet: list, ageSeconds: age } } });
  assert.equal(unmet('STALENESS', 950), unmet('STALENESS', 1900), 'an age is not a state');
  assert.notEqual(unmet('STALENESS', 950), unmet('SHIPPING', 950), 'another missing thing is another reason');
  const holder = (cause: string) => state({ reason: { code: 'BUYBOX_HOLDER_REQUIRED', params: { buyboxHolder: cause } } });
  assert.equal(holder('NO_MAJORITY'), holder('NOT_NAMED'), 'the same reason: a poll and a notification alternate on one offer and must not write a row each');

  const prev = (decidedAt: string) => ({ state: base, decidedAt: decidedAt as never, repeats: 3, lastEvaluatedAt: decidedAt as never });
  assert.equal(NO_CHANGE_PULSE_SECONDS, 86_400, 'the pulse keeps the gap under the 36 hours of the day-boundary evidence [Р-204]');
  assert.equal(repeatsNoChange(null, base, at(0) as never), false, 'nothing before it: a row');
  assert.equal(repeatsNoChange(prev(at(0)), 'other', at(1) as never), false, 'another state: a row');
  assert.equal(repeatsNoChange(prev(at(0)), base, at(24 * 60 - 1) as never), true, 'the same state within a day: a repeat');
  assert.equal(repeatsNoChange(prev(at(0)), base, at(24 * 60) as never), false, 'a day has passed: the pulse row');
});

test('step 116 [Р-241]: a repeated reason writes one row and counts; the competitor moving inside the same reason writes nothing', async () => {
  const h = harness();
  const first = await h.market(0, AT_TARGET);
  assert.ok(first.scopes[0]!.decisionId, 'the first evaluation is a row');
  assert.notEqual(first.scopes[0]!.noChangeRepeated, true);
  for (let i = 1; i <= 4; i++) {
    const r = await h.market(i, AT_TARGET);
    assert.equal(r.scopes[0]!.noChangeRepeated, true);
    assert.equal(r.scopes[0]!.decisionId, undefined, 'a repeat has no decision row');
  }
  assert.deepEqual(h.rows(), [{ reason: 'ALREADY_AT_TARGET', repeats: 0 }]);
  assert.equal((await h.live())!.repeats, 4);
  assert.equal((await h.live())!.lastEvaluatedAt, at(4));

  // Цена конкурента двигается, причина та же: строка одна на смену причины
  await h.market(10, BELOW_FLOOR);
  await h.market(11, BELOW_FLOOR - 50);
  await h.market(12, BELOW_FLOOR - 100);
  assert.deepEqual(h.rows().map((r) => r.reason), ['ALREADY_AT_TARGET', 'TARGET_OUTSIDE_BOUNDS_HOLD'], 'a reason change writes a row at once, a competitor move does not');
  assert.equal(h.rows()[1]!.repeats, 4, 'the new row carries the count of the checks collapsed since the previous one');
  assert.equal((await h.live())!.repeats, 2);
  // Счётчик предложения считает оценки, как плитки: две строки, 4 повтора в строке и 2 в живой — 8 оценок (красный прогон суток демо: 29 вместо 720)
  const [stats] = await h.store.scopeDecisionStats('t', ['ws-1']);
  assert.deepEqual([stats!.latestDecisionId, stats!.decisions], [h.store.decisions.at(-1)!.decisionId, 8], 'the offer counts evaluations; the latest row is still the row');
});

test('step 116 [Р-241]: the daily pulse writes a row even when nothing changed; a bound change and a price change write at once and reset the state', async () => {
  const h = harness();
  await h.market(0, AT_TARGET);
  await h.market(24 * 60 - 1, AT_TARGET);
  assert.equal(h.rows().length, 1);
  await h.market(24 * 60, AT_TARGET);
  assert.deepEqual(h.rows(), [{ reason: 'ALREADY_AT_TARGET', repeats: 0 }, { reason: 'ALREADY_AT_TARGET', repeats: 1 }], 'the pulse row carries the repeats before it');
  assert.equal((await h.live())!.repeats, 0);

  // Пол сдвинулся: то же «уже на цели» — другое состояние
  h.store.setBound('ws-1', 'min', { amountMinor: 1100, id: 'min-2' });
  await h.market(24 * 60 + 1, AT_TARGET);
  assert.equal(h.rows().length, 3, 'a floor change is a new state');

  // Изменение цены несёт счётчик и сбрасывает состояние: следующее «без изменения» — снова строка
  await h.market(24 * 60 + 2, AT_TARGET);
  await h.market(24 * 60 + 3, 1500);
  assert.deepEqual(h.rows().at(-1), { reason: 'APPROVED', repeats: 1 });
  assert.equal(await h.live().then((l) => l?.state ?? null), null, 'a changed price leaves no no-change state');
  await h.market(24 * 60 + 4, AT_TARGET);
  assert.equal(h.rows().length, 5, 'the first no-change after a price change is a row');
});

test('step 116 [Р-241]: a re-evaluation asked by a floor input always writes a row; the alert of an out-of-bounds price is raised once per state', async () => {
  const h = harness();
  await h.market(0, AT_TARGET);
  h.setNow(1);
  await h.pipeline.recompute(h.ctx, 'ws-1', { type: 'SCHEDULE' }, { raiseAfter: 'COST_UPDATE' });
  assert.equal(h.rows().length, 2, 'the request is answered by a row, or it would be asked for again');

  const high = harness({ currentPriceMinor: 6000 });
  for (let i = 0; i < 3; i++) await high.market(i, 6001);
  assert.equal(high.rows().length, 1);
  assert.deepEqual(high.alerts.filter((c) => c === 'CURRENT_PRICE_OUTSIDE_BOUNDS'), ['CURRENT_PRICE_OUTSIDE_BOUNDS'], 'one alert per state, not one per reading');
});

test('step 116 [Р-241]: "not evaluated" is a no-change row with its own code — a stale snapshot, no Buy Box, no shipping — and collapses like any other', async () => {
  // Устаревший снимок: пересчёт без нового чтения
  const stale = harness();
  await stale.market(0, AT_TARGET);
  stale.setNow(20);
  const r = await stale.pipeline.recompute(stale.ctx, 'ws-1', { type: 'SCHEDULE' });
  assert.equal(r.stages.some((s) => s.outcome === 'NOT_EVALUATED'), true, 'the report still says the strategy was not evaluated');
  assert.ok(r.decisionId, 'and the reason has a row');
  assert.equal(stale.rows().at(-1)!.reason, 'COMPETITOR_REQUIREMENT_NOT_MET');
  assert.equal(stale.store.intents.at(-1)!.reason.params.unmet, 'STALENESS');
  assert.equal(stale.store.intents.at(-1)!.proposedMinor, 1900, 'the held price is the current one');
  stale.setNow(21);
  const again = await stale.pipeline.recompute(stale.ctx, 'ws-1', { type: 'SCHEDULE' });
  assert.equal(again.noChangeRepeated, true, 'the age grew, the reason did not change');
  assert.equal(stale.rows().length, 2);

  // Нет Buy Box: стратегии нужна его цена
  const noBuybox = harness({ strategy: MATCH as never });
  await noBuybox.market(0, 1800);
  assert.deepEqual(noBuybox.rows().map((x) => x.reason), ['COMPETITOR_REQUIREMENT_NOT_MET']);
  assert.equal(noBuybox.store.intents.at(-1)!.reason.params.unmet, 'BUYBOX_PRICE');

  // Нет доставки у конкурента: сравнение с доставкой невозможно
  const noShipping = harness({ strategy: LANDED as never });
  await noShipping.market(0, 1800, { offers: [{ isSelf: false, sellerRef: 'SYN_OTHER', price: usd(1800), fulfillment: 'MFN' }] } as never);
  assert.deepEqual(noShipping.rows().map((x) => x.reason), ['COMPETITOR_REQUIREMENT_NOT_MET']);
  assert.equal(noShipping.store.intents.at(-1)!.reason.params.unmet, 'SHIPPING');

  // Другое, чего не хватает, — другая причина: строка сразу
  await noShipping.market(1, 1800);
  assert.equal(noShipping.rows().length, 2, 'the shipping came: another state');
});

test('step 116 [Р-241]: "not evaluated" under a stop writes no row of its own, and a strategy preview stays a preview', async () => {
  const stopped = harness();
  await stopped.market(0, AT_TARGET);
  const owner = DEFAULT_MEMBERS[0]!;
  const stop = await stopped.store.stopPricing('t', { scope: 'TENANT', channelAccountId: null, marketplace: null, stoppedAt: at(1), stoppedByMembershipId: owner.membershipId, stoppedByUserId: owner.userId, note: 'Synthetic stop for this check' } as never);
  assert.equal(stop.status, 'STOPPED');
  stopped.setNow(20);
  const before = stopped.rows().length;
  const held = await stopped.pipeline.recompute(stopped.ctx, 'ws-1', { type: 'SCHEDULE' });
  assert.equal(stopped.rows().length, before, 'the stop has its own screen: a refusal row per reading would go to the eternal core');
  assert.equal(held.stages.some((s) => s.outcome === 'NOT_EVALUATED'), true);

  const preview = harness();
  await preview.market(0, AT_TARGET);
  preview.setNow(20);
  const shown = await preview.pipeline.previewStrategy(preview.ctx, 'ws-1', MATCH as never);
  assert.equal(shown!.decision, undefined, 'a preview that cannot evaluate says so and shows no decision');
  assert.equal(shown!.stages.some((s) => s.outcome === 'NOT_EVALUATED'), true);
  assert.equal(preview.rows().length, 1, 'a preview writes nothing');
});
