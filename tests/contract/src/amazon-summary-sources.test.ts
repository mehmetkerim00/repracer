import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AMAZON_DESCRIPTOR, AMAZON_RATE_LIMITS } from '@repracer/amazon-adapter';
import { strategyAvailability } from '@repracer/strategy-engine';

/**
 * Шаг 115 [Р-240]: что настоящее описание Amazon обещает стратегиям. Сводка `getCompetitiveSummary` — основной источник: цена и держатель Buy Box
 * (большинство просмотров, Р-235), исполнение и доставка у предложений. Q11: «Win the Buy Box» на Amazon оживает
 */
const sources = AMAZON_DESCRIPTOR.competitorSources!;
const available = (params: object) => strategyAvailability(params as never, sources);

test('step 115 [Р-240]: the summary is a primary source polled by rotation; notifications stay primary too — and still do not name the holder', () => {
  const summary = sources.find((s) => s.source === 'AMAZON_COMPETITIVE_SUMMARY')!;
  assert.deepEqual([summary.kind, summary.role, summary.rotation, summary.hasBuyboxWinner, summary.hasBuyboxPrice, summary.hasFulfilment, summary.holderByViewShare], ['PULL', 'PRIMARY', true, true, true, true, true]);
  const push = sources.find((s) => s.source === 'AMAZON_ANY_OFFER_CHANGED')!;
  assert.deepEqual([push.kind, push.role, push.hasBuyboxWinner], ['PUSH', 'PRIMARY', false]);
});

test('step 115 (Q11): Win the Buy Box lives on Amazon — through the summary, the source that names the holder; with the FBA filter too', () => {
  assert.deepEqual(available({ type: 'WIN_BUYBOX', undercutMinor: 1, fulfillmentHandicapMinor: 0, creepUp: false, creepStepBp: 100, atBound: 'CAP' }), { available: true, via: 'AMAZON_COMPETITIVE_SUMMARY' });
  assert.deepEqual(available({ type: 'WIN_BUYBOX', undercutMinor: 1, fulfillmentHandicapMinor: 0, creepUp: false, creepStepBp: 100, atBound: 'CAP', competeWith: 'FBA_ONLY' }), { available: true, via: 'AMAZON_COMPETITIVE_SUMMARY' });
  // Контроль: «самая дешёвая по всему рынку» канал по-прежнему не даёт — источник, а не правило «на Amazon доступно всё»
  assert.equal(available({ type: 'BEAT_LOWEST', undercutMinor: 1, scope: 'MARKET', compareLanded: false, atBound: 'CAP' }).available, false);
});

test('step 115 [Р-240]: the budget belongs to the seller-application pair — 0.033 rps, burst 1; the application limit is not documented and is not assumed (A-15)', () => {
  assert.deepEqual(AMAZON_RATE_LIMITS.getCompetitiveSummary, { pair: { ratePerSecond: 0.033, burst: 1 }, application: null });
  const declared = AMAZON_DESCRIPTOR.rateLimits.filter((r) => r.operation === 'getCompetitiveSummary');
  assert.deepEqual(declared.map((r) => [r.owner, r.source]), [['SELLER_APPLICATION_OPERATION', 'DOCUMENTED'], ['APPLICATION', 'UNKNOWN']]);
});
