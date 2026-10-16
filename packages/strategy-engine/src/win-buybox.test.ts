import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CompetitorOffer, CompetitorSnapshot, CompetitorSourceDescriptor } from '@repracer/channel-port';
import { markAcceptedBySanity, type StrategyParams } from '@repracer/pricing-model';
import { CREEP_PAUSE_PERIODS, runStrategy, strategyAvailability, type CreepState, type EngineInput, type EngineResult } from './index.ts';

/**
 * Шаг 97 [Р-219, Р-221]: «Win the Buy Box» — взятие (цель от landed-цены победителя с гандикапом за исполнение), удержание, подъём ступенью
 * за период, пока Buy Box наш, возврат к последней выигрышной цене после потери и пауза; всё — в границах. И «Match the Buy Box» при
 * неизвестном держателе (Amazon, A-29): свою цену не подрезает. Данные синтетические
 */

const T0 = Date.parse('2026-10-16T10:00:00.000Z');
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();
const usd = (amountMinor: number) => ({ amountMinor, currency: 'USD', basis: 'NET' as const });
const PERIOD = 900;

interface Market { holder: 'SELF' | 'OTHER' | null; winnerMinor: number; winnerShipping?: number; winnerFulfillment?: string; selfMinor: number; selfShipping?: number; selfFulfillment?: string }

function snapshot(m: Market, observedMinutes: number): CompetitorSnapshot {
  const winner: CompetitorOffer = { rank: 1, sellerRef: 'Harbor Goods', isSelf: false, price: usd(m.winnerMinor), shipping: usd(m.winnerShipping ?? 0),
    ...(m.winnerFulfillment ? { fulfillment: m.winnerFulfillment } : {}), ...(m.holder === 'OTHER' ? { holdsBuyBox: true } : {}) };
  const self: CompetitorOffer = { rank: 2, isSelf: true, price: usd(m.selfMinor), shipping: usd(m.selfShipping ?? 0),
    ...(m.selfFulfillment ? { fulfillment: m.selfFulfillment } : {}), ...(m.holder === 'SELF' ? { holdsBuyBox: true } : {}) };
  const bbPrice = m.holder === 'SELF' ? m.selfMinor : m.winnerMinor;
  return {
    marketplace: 'walmart.com', channelProductRef: 'SYN-97', condition: 'new', source: 'WALMART_BUY_BOX', observedAt: at(observedMinutes - 1),
    completeness: { kind: 'TOP_N', n: 10 },
    buybox: { price: usd(bbPrice), isSelf: m.holder === null ? null : m.holder === 'SELF', ...(m.holder === 'OTHER' ? { sellerRef: 'Harbor Goods' } : {}) },
    offers: m.holder === 'SELF' ? [{ ...self, rank: 1 }, { ...winner, rank: 2 }] : [winner, self],
  };
}

const win = (over: Partial<Extract<StrategyParams, { type: 'WIN_BUYBOX' }>> = {}): StrategyParams =>
  ({ type: 'WIN_BUYBOX', undercutMinor: 5, fulfillmentHandicapMinor: 0, creepUp: false, creepStepBp: 100, atBound: 'CAP', ...over });

function input(params: StrategyParams, m: Market, minutes: number, over: Partial<EngineInput> = {}): EngineInput {
  return {
    writeScope: { writeScopeId: 'ws-97', currency: 'USD', basis: 'NET' },
    strategy: { strategyId: 'st-97', version: 1, params, deadbandMinor: 0 },
    snapshot: markAcceptedBySanity(snapshot(m, minutes), 'test'),
    cost: null,
    bounds: { minMinor: 1500, maxMinor: 2400 },
    currentPriceMinor: m.selfMinor,
    ladderPace: { lastStepAt: null, paceSeconds: PERIOD },
    stepLimitBp: 1000,
    now: at(minutes),
    trigger: { type: 'COMPETITOR_CHANGE', sourceEventId: `evt-${minutes}` },
    ...over,
  };
}

function intentOf(r: EngineResult) {
  assert.equal(r.kind, 'INTENT', JSON.stringify(r));
  return (r as Extract<EngineResult, { kind: 'INTENT' }>).intent;
}

test('step 97 (I3): Win the Buy Box — take, hold, creep until lost, step back, all within bounds', () => {
  const params = win({ creepUp: true, creepStepBp: 100 });
  // 1. Взятие: Buy Box у Harbor Goods за $18.00 с доставкой $0.00; наша доставка $0.00; подрез 5 центов → $17.95
  const take = intentOf(runStrategy(input(params, { holder: 'OTHER', winnerMinor: 1800, selfMinor: 1900 }, 0)));
  assert.equal(take.intentClass, 'CHANGED');
  assert.equal(take.proposedMinor, 1795, 'the winner landed price minus the undercut');
  assert.equal(take.reason.code, 'BUYBOX_WIN_TARGET');
  assert.equal(take.ruleCode, 'WIN_BUYBOX');
  assert.equal(take.referenceMinor, 1800, 'the reference is the landed price of the winner');

  // 2. Удержание: Buy Box наш — цена не снижается, хотя чужое предложение дешевле нашей цены не стало
  const hold = intentOf(runStrategy(input(win(), { holder: 'SELF', winnerMinor: 1800, selfMinor: 1795 }, 2)));
  assert.equal(hold.intentClass, 'NO_OP');
  assert.equal(hold.reason.code, 'ALREADY_WINNING_BUYBOX', 'keep when winning: no creep without the flag');

  // Живой прогон I3 нашёл: первая ступень шла через 5 минут после взятия. Взятие — тоже изменение цены: ступень не раньше периода после него
  const taken: CreepState = { lastUp: null, lastBack: null, lastTake: { at: at(0) } };
  const early = intentOf(runStrategy(input(params, { holder: 'SELF', winnerMinor: 1830, selfMinor: 1795 }, 5, { creep: taken })));
  assert.equal(early.reason.code, 'CREEP_PACED', 'no creep within a period after the take');
  assert.equal(early.reason.params.nextStepAt, at(15));
  assert.equal(intentOf(runStrategy(input(params, { holder: 'SELF', winnerMinor: 1830, selfMinor: 1795 }, 15, { creep: taken }))).reason.code, 'CREEP_UP', 'a period after the take');

  // 3. Подъём: Buy Box наш, флаг включён — шаг 1 % ($17.95 → $18.12)
  let creep: CreepState = { lastUp: null, lastBack: null };
  const up1 = intentOf(runStrategy(input(params, { holder: 'SELF', winnerMinor: 1830, selfMinor: 1795 }, 4, { creep })));
  assert.equal(up1.intentClass, 'CHANGED');
  assert.equal(up1.reason.code, 'CREEP_UP');
  assert.equal(up1.proposedMinor, 1795 + Math.floor(1795 / 100));
  creep = { lastUp: { at: at(4), fromMinor: 1795, toMinor: up1.proposedMinor }, lastBack: null };

  // Не чаще периода: через 5 минут после подъёма — ждём; наблюдение конкурента паузу не ускоряет
  const paced = intentOf(runStrategy(input(params, { holder: 'SELF', winnerMinor: 1830, selfMinor: up1.proposedMinor }, 9, { creep })));
  assert.equal(paced.intentClass, 'NO_OP');
  assert.equal(paced.reason.code, 'CREEP_PACED');

  // Следующий подъём — через период
  const up2 = intentOf(runStrategy(input(params, { holder: 'SELF', winnerMinor: 1830, selfMinor: up1.proposedMinor }, 4 + 15, { creep })));
  assert.equal(up2.reason.code, 'CREEP_UP');
  assert.equal(up2.proposedMinor, up1.proposedMinor + Math.floor(up1.proposedMinor / 100));
  creep = { lastUp: { at: at(19), fromMinor: up1.proposedMinor, toMinor: up2.proposedMinor }, lastBack: null };

  // 4. Потеря: на $18.30 Buy Box ушёл к Harbor Goods ($18.30 у него, $18.29 у нас не держит) — назад к последней выигрышной цене
  const lost = intentOf(runStrategy(input(params, { holder: 'OTHER', winnerMinor: 1825, selfMinor: up2.proposedMinor }, 22, { creep })));
  assert.equal(lost.intentClass, 'CHANGED');
  assert.equal(lost.reason.code, 'CREEP_STEP_BACK');
  assert.equal(lost.proposedMinor, up1.proposedMinor, 'back to the last price at which the Buy Box was ours');
  const back = lost.explanation.find((x) => x.code === 'CREEP_STEP_BACK')!;
  assert.equal(back.params.lostAtMinor, up2.proposedMinor);
  assert.equal(back.params.pausedUntil, new Date(Date.parse(at(22)) + CREEP_PAUSE_PERIODS * PERIOD * 1000).toISOString(), 'a pause of four periods');
  creep = { ...creep, lastBack: { at: at(22), lostAtMinor: up2.proposedMinor } };

  // Пауза: Buy Box снова наш — подъёма нет, пока идёт пауза
  const pausedHold = intentOf(runStrategy(input(params, { holder: 'SELF', winnerMinor: 1825, selfMinor: up1.proposedMinor }, 30, { creep })));
  assert.equal(pausedHold.intentClass, 'NO_OP');
  assert.equal(pausedHold.reason.code, 'CREEP_PAUSED');

  // Пауза: Buy Box чужой, цель выше цены потери — потолок паузы
  const ceiling = intentOf(runStrategy(input(params, { holder: 'OTHER', winnerMinor: 1900, selfMinor: up1.proposedMinor }, 31, { creep })));
  assert.equal(ceiling.proposedMinor, up2.proposedMinor - 1, 'the price at which the Buy Box was lost is the ceiling during the pause');
  assert.ok(ceiling.explanation.some((x) => x.code === 'CAPPED_AT_CREEP_CEILING'));

  // После паузы подъём возобновляется
  const resumed = intentOf(runStrategy(input(params, { holder: 'SELF', winnerMinor: 1825, selfMinor: up1.proposedMinor }, 22 + 61, { creep })));
  assert.equal(resumed.reason.code, 'CREEP_UP');

  // 5. Все рамки: подъём не выше максимума, на максимуме — без подъёма; шаг — в пределах шага Gate
  const nearMax = intentOf(runStrategy(input(params, { holder: 'SELF', winnerMinor: 2500, selfMinor: 2390 }, 100, { creep: null })));
  assert.equal(nearMax.proposedMinor, 2400, 'capped at max_price');
  const atMax = intentOf(runStrategy(input(params, { holder: 'SELF', winnerMinor: 2500, selfMinor: 2400 }, 101, { creep: null })));
  assert.equal(atMax.reason.code, 'CREEP_AT_MAX');
  const limited = intentOf(runStrategy(input(win({ creepUp: true, creepStepBp: 500 }), { holder: 'SELF', winnerMinor: 2500, selfMinor: 2000 }, 102, { creep: null, stepLimitBp: 100 })));
  assert.equal(limited.proposedMinor, 2020, 'a creep step larger than the Gate step limit is cut to the limit');
  // Возврат ниже поднявшегося пола — встаёт на пол
  const floorBack = intentOf(runStrategy(input(params, { holder: 'OTHER', winnerMinor: 1700, selfMinor: 1820 }, 103, {
    creep: { lastUp: { at: at(90), fromMinor: 1600, toMinor: 1820 }, lastBack: null }, bounds: { minMinor: 1700, maxMinor: 2400 } })));
  assert.equal(floorBack.proposedMinor, 1700, 'the step back respects the floor');
  // Цель взятия ниже пола — на полу (CAP), а не ниже
  const takeFloor = intentOf(runStrategy(input(win(), { holder: 'OTHER', winnerMinor: 1400, selfMinor: 1900 }, 104)));
  assert.equal(takeFloor.proposedMinor, 1500);
  assert.equal(takeFloor.reason.code, 'CAPPED_AT_MIN_PRICE');
});

test('step 97: the fulfilment handicap applies only when the channel named both fulfilments', () => {
  const params = win({ fulfillmentHandicapMinor: 20 });
  const fba = intentOf(runStrategy(input(params, { holder: 'OTHER', winnerMinor: 1800, winnerFulfillment: 'AFN', selfMinor: 1900, selfFulfillment: 'MFN' }, 0)));
  assert.equal(fba.proposedMinor, 1800 - 5 - 20, 'the winner is fulfilled by the channel and we are not: lower by the handicap too');
  const both = intentOf(runStrategy(input(params, { holder: 'OTHER', winnerMinor: 1800, winnerFulfillment: 'AFN', selfMinor: 1900, selfFulfillment: 'AFN' }, 0)));
  assert.equal(both.proposedMinor, 1795, 'both fulfilled by the channel: no handicap');
  const unknown = intentOf(runStrategy(input(params, { holder: 'OTHER', winnerMinor: 1800, selfMinor: 1900 }, 0)));
  assert.equal(unknown.proposedMinor, 1795, 'the channel did not name the fulfilment: no handicap is invented');
  assert.equal('winnerFulfilment' in unknown.reason.params, false);
  // Доставка: цель — от landed-цены, своя доставка вычитается
  const landed = intentOf(runStrategy(input(win(), { holder: 'OTHER', winnerMinor: 1700, winnerShipping: 299, selfMinor: 1900, selfShipping: 499 }, 0, { bounds: { minMinor: 1000, maxMinor: 2400 } })));
  assert.equal(landed.proposedMinor, 1700 + 299 - 5 - 499);
});

test('step 97 [Р-221]: without a named holder, Win the Buy Box is not evaluated and Match the Buy Box does not undercut its own price', () => {
  const unknownHolder: Market = { holder: null, winnerMinor: 1800, selfMinor: 1800 };
  const r = runStrategy(input(win(), unknownHolder, 0));
  assert.equal(r.kind, 'NOT_EVALUATED');
  assert.equal(r.kind === 'NOT_EVALUATED' && r.reason.params.unmet, 'BUYBOX_WINNER');
  const match: StrategyParams = { type: 'MATCH_BUYBOX', undercutMinor: 5, holdWhenWinning: true, atBound: 'CAP' };
  const held = intentOf(runStrategy(input(match, unknownHolder, 0)));
  assert.equal(held.intentClass, 'NO_OP');
  assert.equal(held.reason.code, 'BUYBOX_HOLDER_UNKNOWN', 'our price is the Buy Box price: it may be ours, and undercutting it would chase our own price down');
  const cheaper = intentOf(runStrategy(input(match, { holder: null, winnerMinor: 1800, selfMinor: 1850 }, 0)));
  assert.equal(cheaper.proposedMinor, 1795, 'the Buy Box price is not ours: the holder is someone else, undercut as usual');
});

test('step 97 [Р-39]: availability — Win the Buy Box needs a named holder, Match the Buy Box only the price', () => {
  const amazon: CompetitorSourceDescriptor = { source: 'AMAZON_ANY_OFFER_CHANGED', kind: 'PUSH', completeness: { kind: 'TOP_N', n: 20 }, conditions: ['new'],
    hasBuyboxWinner: false, hasBuyboxPrice: true, hasOwnRank: false, hasShipping: true, typicalStalenessSeconds: null, availability: 'AVAILABLE', role: 'PRIMARY' };
  assert.deepEqual(strategyAvailability(win(), [amazon]), { available: false, unmet: { AMAZON_ANY_OFFER_CHANGED: ['BUYBOX_WINNER'] } });
  assert.deepEqual(strategyAvailability({ type: 'MATCH_BUYBOX', undercutMinor: 5, holdWhenWinning: true, atBound: 'CAP' }, [amazon]), { available: true, via: 'AMAZON_ANY_OFFER_CHANGED' });
  const walmart = { ...amazon, source: 'WALMART_BUY_BOX', kind: 'PULL' as const, hasBuyboxWinner: true };
  assert.deepEqual(strategyAvailability(win(), [walmart]), { available: true, via: 'WALMART_BUY_BOX' });
});
