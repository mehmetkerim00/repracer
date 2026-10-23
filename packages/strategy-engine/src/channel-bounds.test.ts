import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CompetitorSnapshot } from '@repracer/channel-port';
import { markAcceptedBySanity, type StrategyParams } from '@repracer/pricing-model';
import { runStrategy, type EngineInput, type EngineResult } from './index.ts';

/**
 * Шаг 107 [Р-233, Р-231]: рамки цены, заданные продавцом в канале (Amazon Min/Max на SKU), — не наши границы [Р-114], но цена вне них
 * деактивирует листинг. Цена вне рамок канала в канал не уходит: «без изменения» CHANNEL_BOUNDS_HOLD с обеими суммами. Исключения:
 * движение к рамкам из-за них (хуже не становится — лестница к полу не застревает) и распродажа ниже Min канала (решение владельца —
 * предупреждение, а не блок): цена уходит, а конфликт записан в квитанции каждого решения режима. Данные синтетические
 */

const NOW = '2026-10-23T10:00:00.000Z';
const usd = (amountMinor: number) => ({ amountMinor, currency: 'USD', basis: 'NET' as const });
const BEAT: StrategyParams = { type: 'BEAT_LOWEST', undercutMinor: 1, scope: 'VISIBLE_TOP_N', compareLanded: false, atBound: 'CAP' };

function snapshot(competitorMinor: number, selfMinor: number): CompetitorSnapshot {
  return {
    marketplace: 'ATVPDKIKX0DER', channelProductRef: 'SYN-107', condition: 'new', source: 'SYN', observedAt: '2026-10-23T09:59:00.000Z',
    completeness: { kind: 'TOP_N', n: 20 }, buybox: { price: usd(competitorMinor), isSelf: null },
    offers: [{ isSelf: false, sellerRef: 'Harbor Goods', price: usd(competitorMinor), shipping: usd(0) }, { isSelf: true, price: usd(selfMinor), shipping: usd(0) }],
  };
}

/** Наши границы $10.00–$50.00; рамки канала — по тесту */
function run(competitorMinor: number, current: number, over: Partial<EngineInput> = {}, bounds: Partial<EngineInput['bounds']> = {}): EngineResult {
  return runStrategy({
    writeScope: { writeScopeId: 'ws-107', currency: 'USD', basis: 'NET' }, strategy: { strategyId: 'st', version: 1, params: BEAT, deadbandMinor: 0 },
    snapshot: markAcceptedBySanity(snapshot(competitorMinor, current), 'test'), cost: null,
    bounds: { minMinor: 1000, maxMinor: 5000, ...bounds },
    currentPriceMinor: current, now: NOW, trigger: { type: 'COMPETITOR_CHANGE', sourceEventId: 'e' }, ...over,
  });
}
const intentOf = (r: EngineResult) => { assert.equal(r.kind, 'INTENT', JSON.stringify(r)); return (r as Extract<EngineResult, { kind: 'INTENT' }>).intent; };

test('step 107 [Р-233]: a price below the channel minimum is not sent — no change, both amounts named', () => {
  // Конкурент $11.00 → цель $10.99; Min канала $12.00, наш пол $10.00 ниже него
  const held = intentOf(run(1100, 1500, { channelBounds: { minMinor: 1200, maxMinor: null } }));
  assert.equal(held.intentClass, 'NO_OP');
  assert.equal(held.proposedMinor, 1500, 'the price stays where it is');
  assert.equal(held.reason.code, 'CHANNEL_BOUNDS_HOLD');
  assert.deepEqual(held.reason.params, { targetMinor: 1099, side: 'MIN', channelMinMinor: 1200, currency: 'USD' });
  // Без рамок канала — прежнее поведение
  const sent = intentOf(run(1100, 1500));
  assert.deepEqual([sent.intentClass, sent.proposedMinor], ['CHANGED', 1099]);
});

test('step 107 [Р-233]: a price above the channel maximum is not sent; a price inside the channel bounds goes', () => {
  const held = intentOf(run(4600, 1500, { channelBounds: { minMinor: 1200, maxMinor: 4000 } }));
  assert.equal(held.intentClass, 'NO_OP');
  assert.deepEqual(held.reason.params, { targetMinor: 4599, side: 'MAX', channelMaxMinor: 4000, currency: 'USD' });
  const inside = intentOf(run(1300, 1500, { channelBounds: { minMinor: 1200, maxMinor: 4000 } }));
  assert.deepEqual([inside.intentClass, inside.proposedMinor, inside.reason.code], ['CHANGED', 1299, 'LOWEST_UNDERCUT']);
  assert.ok(!inside.explanation.some((x) => x.code === 'CHANNEL_BOUNDS_HOLD' || x.code === 'CLEARANCE_BELOW_CHANNEL_MIN'));
  // Ровно на рамке — внутри: рамки канала включают свои значения
  const atMin = intentOf(run(1201, 1500, { channelBounds: { minMinor: 1200, maxMinor: 4000 } }));
  assert.deepEqual([atMin.intentClass, atMin.proposedMinor], ['CHANGED', 1200]);
});

test('step 107 [Р-233]: a move toward the channel bounds from outside them is not held — the ladder to the floor does not get stuck', () => {
  // Цена $5.00 ниже и нашего пола $10.00, и Min канала $12.00; предел шага 10 % — ступень $5.50, всё ещё ниже Min канала
  const rung = intentOf(run(1100, 500, { channelBounds: { minMinor: 1200, maxMinor: null }, stepLimitBp: 1000 }));
  assert.deepEqual([rung.intentClass, rung.proposedMinor, rung.reason.code], ['CHANGED', 550, 'RAISED_TOWARD_FLOOR']);
  // Цена выше Max канала, цель ниже текущей, но всё ещё выше Max — к рамкам, уходит
  const down = intentOf(run(4501, 4900, { channelBounds: { minMinor: null, maxMinor: 4000 } }));
  assert.deepEqual([down.intentClass, down.proposedMinor], ['CHANGED', 4500]);
  // А вниз от цены, уже стоящей ниже Min канала, — удержание
  const away = intentOf(run(1000, 1100, { channelBounds: { minMinor: 1200, maxMinor: null } }));
  assert.deepEqual([away.intentClass, away.reason.code], ['NO_OP', 'CHANNEL_BOUNDS_HOLD']);
});

test('step 107 [Р-233, Р-227]: clearance below the channel minimum is sent, and every decision of the mode records the conflict', () => {
  const clearance = { floorMinor: 800, breakEvenMinor: 1295 };
  // Пол распродажи $8.00 ниже Min канала $12.00: цель $10.99 уходит, квитанция называет обе суммы
  const sent = intentOf(run(1100, 1500, { channelBounds: { minMinor: 1200, maxMinor: null } }, { clearance }));
  assert.deepEqual([sent.intentClass, sent.proposedMinor, sent.reason.code], ['CHANGED', 1099, 'LOWEST_UNDERCUT']);
  assert.deepEqual(sent.explanation.slice(0, 2).map((x) => x.code), ['CLEARANCE_FLOOR', 'CLEARANCE_BELOW_CHANNEL_MIN']);
  assert.deepEqual(sent.explanation[1]!.params, { floorMinor: 800, channelMinMinor: 1200, currency: 'USD' });
  // «Без изменения» в режиме — запись конфликта та же
  const same = intentOf(run(1100, 1099, { channelBounds: { minMinor: 1200, maxMinor: null } }, { clearance }));
  assert.equal(same.intentClass, 'NO_OP');
  assert.equal(same.explanation[1]!.code, 'CLEARANCE_BELOW_CHANNEL_MIN');
  // Пол распродажи не ниже Min канала — конфликта нет, записи нет
  const noConflict = intentOf(run(1300, 1500, { channelBounds: { minMinor: 1200, maxMinor: null } }, { clearance: { floorMinor: 1200, breakEvenMinor: 1295 } }));
  assert.ok(!noConflict.explanation.some((x) => x.code === 'CLEARANCE_BELOW_CHANNEL_MIN'));
  // Max канала в распродаже — без исключений
  const above = intentOf(run(4600, 1500, { channelBounds: { minMinor: 1200, maxMinor: 4000 } }, { clearance }));
  assert.deepEqual([above.intentClass, above.reason.code], ['NO_OP', 'CHANNEL_BOUNDS_HOLD']);
});
