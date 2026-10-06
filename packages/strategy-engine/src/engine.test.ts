import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CompetitorSnapshot, CompetitorSourceDescriptor } from '@repracer/channel-port';
import { markAcceptedBySanity, type CostInputs, type StrategyParams } from '@repracer/pricing-model';
import { runStrategy, strategyAvailability, type EngineInput } from './index.ts';

const NOW = '2026-09-14T10:00:00.000Z';
const eur = (amountMinor: number) => ({ amountMinor, currency: 'EUR', basis: 'GROSS' as const });

function snapshot(over: Partial<CompetitorSnapshot> = {}): CompetitorSnapshot {
  return {
    marketplace: 'de', channelProductRef: 'P1', condition: 'new', source: 'KAUFLAND_BUYBOX', observedAt: '2026-09-14T09:59:00.000Z',
    completeness: { kind: 'TOP_N', n: 10 }, buybox: { price: eur(1795), isSelf: false },
    offers: [
      { rank: 1, isSelf: false, price: eur(1795), shipping: eur(0), totalPrice: eur(1795) },
      { rank: 2, isSelf: true, price: eur(1850), shipping: eur(495), totalPrice: eur(2345) },
    ],
    ...over,
  };
}

function input(params: StrategyParams, over: Partial<EngineInput> = {}): EngineInput {
  return {
    writeScope: { writeScopeId: 'ws-1', currency: 'EUR', basis: 'GROSS' },
    strategy: { strategyId: 'st-1', version: 1, params, deadbandMinor: 0 },
    snapshot: markAcceptedBySanity(snapshot(), 'test'),
    cost: null,
    bounds: { minMinor: 1000, maxMinor: 3000 },
    currentPriceMinor: 1850,
    now: NOW,
    trigger: { type: 'COMPETITOR_CHANGE', sourceEventId: 'evt-1' },
    ...over,
  };
}

const matchBuybox = (over: Partial<Extract<StrategyParams, { type: 'MATCH_BUYBOX' }>> = {}): StrategyParams =>
  ({ type: 'MATCH_BUYBOX', undercutMinor: 5, holdWhenWinning: true, atBound: 'CAP', ...over });

const cost: CostInputs = { currency: 'EUR', costProfileId: 'cp-1', unitCostMinor: 1000, fixedFeeMinor: 0, feeRateBp: 1500, tax: { regime: 'VAT_INCLUDED', vatRateBp: 1900 } };

test('match buy box with undercut proposes a CHANGED intent with the reason chain', () => {
  const r = runStrategy(input(matchBuybox()));
  assert.equal(r.kind, 'INTENT');
  assert.ok(r.kind === 'INTENT' && r.intent.intentClass === 'CHANGED' && r.intent.proposedMinor === 1790);
  assert.ok(r.kind === 'INTENT' && r.intent.reason.code === 'BUYBOX_UNDERCUT' && r.intent.referenceMinor === 1795);
});

test('competitor-following target below min price is capped at the bound (CAP) or held (HOLD)', () => {
  const capped = runStrategy(input(matchBuybox(), { bounds: { minMinor: 1800, maxMinor: 3000 } }));
  assert.ok(capped.kind === 'INTENT' && capped.intent.proposedMinor === 1800 && capped.intent.reason.code === 'CAPPED_AT_MIN_PRICE');
  const held = runStrategy(input(matchBuybox({ atBound: 'HOLD' }), { bounds: { minMinor: 1800, maxMinor: 3000 } }));
  assert.ok(held.kind === 'INTENT' && held.intent.intentClass === 'NO_OP' && held.intent.reason.code === 'TARGET_OUTSIDE_BOUNDS_HOLD');
});

test('fixed price above max price is not capped: the conflict must reach the Gate', () => {
  const r = runStrategy(input({ type: 'FIXED', priceMinor: 5000 }));
  assert.ok(r.kind === 'INTENT' && r.intent.intentClass === 'CHANGED' && r.intent.proposedMinor === 5000);
});

test('already winning the buy box is NO_OP', () => {
  const s = markAcceptedBySanity(snapshot({ buybox: { price: eur(1850), isSelf: true } , offers: [{ rank: 1, isSelf: true, price: eur(1850) }] }), 'test');
  const r = runStrategy(input(matchBuybox(), { snapshot: s }));
  assert.ok(r.kind === 'INTENT' && r.intent.intentClass === 'NO_OP' && r.intent.reason.code === 'ALREADY_WINNING_BUYBOX');
});

test('difference smaller than the deadband is NO_OP', () => {
  const r = runStrategy({ ...input(matchBuybox()), currentPriceMinor: 1795, strategy: { strategyId: 'st-1', version: 1, params: matchBuybox(), deadbandMinor: 10 } });
  assert.ok(r.kind === 'INTENT' && r.intent.intentClass === 'NO_OP' && r.intent.reason.code === 'WITHIN_DEADBAND' && r.intent.proposedMinor === 1795);
});

test('target margin computes the gross price and fails closed without VAT', () => {
  const ok = runStrategy(input({ type: 'TARGET_MARGIN', targetMarginBp: 2000 }, { cost }));
  assert.ok(ok.kind === 'INTENT' && ok.intent.proposedMinor === 1915, JSON.stringify(ok));
  const noVat = runStrategy(input({ type: 'TARGET_MARGIN', targetMarginBp: 2000 }, { cost: { ...cost, tax: { regime: 'VAT_INCLUDED', vatRateBp: null } } }));
  assert.ok(noVat.kind === 'NOT_EVALUATED' && noVat.reason.code === 'COST_INPUTS_MISSING');
  const high = runStrategy(input({ type: 'TARGET_MARGIN', targetMarginBp: 2000 }, { cost: { ...cost, feeRateBp: 9000 } }));
  assert.ok(high.kind === 'NOT_EVALUATED' && high.reason.code === 'MARGIN_UNATTAINABLE');
});

test('beat lowest compares landed prices and subtracts own shipping', () => {
  const s = markAcceptedBySanity(snapshot({
    offers: [
      { rank: 1, isSelf: false, price: eur(1700), shipping: eur(300), totalPrice: eur(2000) },
      { rank: 2, isSelf: false, price: eur(1900), shipping: eur(0), totalPrice: eur(1900) },
      { rank: 3, isSelf: true, price: eur(1850), shipping: eur(100), totalPrice: eur(1950) },
    ],
    buybox: { price: eur(1700), isSelf: false },
  }), 'test');
  const r = runStrategy(input({ type: 'BEAT_LOWEST', undercutMinor: 0, scope: 'VISIBLE_TOP_N', compareLanded: true, atBound: 'CAP' }, { snapshot: s }));
  assert.ok(r.kind === 'INTENT' && r.intent.proposedMinor === 1800 && r.intent.reason.code === 'LOWEST_MATCH', JSON.stringify(r));
});

test('market-wide lowest needs CHEAPEST_ONLY or FULL: a top-10 snapshot is not enough', () => {
  const r = runStrategy(input({ type: 'BEAT_LOWEST', undercutMinor: 1, scope: 'MARKET', compareLanded: false, atBound: 'CAP' }));
  assert.ok(r.kind === 'NOT_EVALUATED' && r.reason.code === 'COMPETITOR_REQUIREMENT_NOT_MET' && String(r.reason.params.unmet).includes('COMPLETENESS'));
});

test('stale snapshot does not meet the requirement', () => {
  const r = runStrategy(input(matchBuybox(), { now: '2026-09-14T11:00:00.000Z' }));
  assert.ok(r.kind === 'NOT_EVALUATED' && String(r.reason.params.unmet).includes('STALENESS'));
});

test('availability on Kaufland sources: buy box via pull; early-access push does not count; market minimum unavailable', () => {
  const sources: CompetitorSourceDescriptor[] = [
    { source: 'KAUFLAND_BUY_BOX_CHANGED', kind: 'PUSH', completeness: { kind: 'TOP_N', n: 10 }, conditions: ['new'], hasBuyboxWinner: true, hasOwnRank: true, hasShipping: true, typicalStalenessSeconds: null, availability: 'EARLY_ACCESS', role: 'PRIMARY' },
    { source: 'KAUFLAND_BUYBOX', kind: 'PULL', completeness: { kind: 'TOP_N', n: 10 }, conditions: ['new', 'used'], hasBuyboxWinner: true, hasOwnRank: true, hasShipping: true, typicalStalenessSeconds: null, availability: 'AVAILABLE', role: 'PRIMARY' },
    { source: 'KAUFLAND_COMPETITORS_COMPARER', kind: 'REPORT', completeness: { kind: 'CHEAPEST_ONLY' }, conditions: ['new', 'used'], hasBuyboxWinner: false, hasOwnRank: false, hasShipping: false, typicalStalenessSeconds: null, availability: 'AVAILABLE', role: 'RECONCILIATION' },
  ];
  const buybox = strategyAvailability(matchBuybox(), sources);
  assert.deepEqual(buybox, { available: true, via: 'KAUFLAND_BUYBOX' });
  const market = strategyAvailability({ type: 'BEAT_LOWEST', undercutMinor: 0, scope: 'MARKET', compareLanded: false, atBound: 'CAP' }, sources);
  assert.equal(market.available, false);
  assert.ok(!market.available && market.unmet.KAUFLAND_COMPETITORS_COMPARER?.includes('RECONCILIATION_ONLY'));
  assert.ok(strategyAvailability({ type: 'FIXED', priceMinor: 1 }, []).available);
});

/**
 * Р-171 (шаг 41): в ТЕНИ цена на витрине не двигается, поэтому сравнение с ней даёт «изменить» на каждом опросе. Живой
 * прогон шага 41 это и показал: 99 удержанных записей на предложение за сутки. Движок сравнивает предложение ещё и с
 * уже УДЕРЖАННЫМ — и второй раз то же самое не предлагает.
 */
test('шаг 41: то же предложение, уже удержанное тенью, даёт NO_OP с названной причиной', () => {
  const base = input(matchBuybox());
  // В тени текущей цены нет вовсе (в канал ничего не уходило), а удержанное предложение есть
  const first = runStrategy({ ...base, currentPriceMinor: null });
  assert.equal(first.kind, 'INTENT');
  if (first.kind !== 'INTENT') return;
  assert.equal(first.intent.intentClass, 'CHANGED', 'первое предложение тени — изменение');
  const proposed = first.intent.proposedMinor;

  const again = runStrategy({ ...base, currentPriceMinor: null, shadowLastProposedMinor: proposed });
  assert.equal(again.kind, 'INTENT');
  if (again.kind !== 'INTENT') return;
  assert.equal(again.intent.intentClass, 'NO_OP', 'то же предложение второй раз — не изменение');
  assert.equal(again.intent.reason.code, 'SHADOW_ALREADY_PROPOSED');
  assert.deepEqual(again.intent.reason.params.heldMinor, proposed, 'причина называет удержанную цену');

  // Положительный контроль [Р-94]: ДРУГОЕ предложение тень не глотает
  const moved = runStrategy({ ...base, currentPriceMinor: null, shadowLastProposedMinor: proposed + 500 });
  assert.equal(moved.kind, 'INTENT');
  if (moved.kind !== 'INTENT') return;
  assert.equal(moved.intent.intentClass, 'CHANGED', 'изменившееся предложение по-прежнему изменение');
});

/**
 * Р-207 (шаг 72, OQ-250): пол стратегии — наибольшее из min_price и пола маржи. Цель ниже пола маржи — цена на полу маржи
 * (CAPPED_AT_MARGIN_FLOOR), нынешняя цена ниже пола — подъём до пола (RAISED_TO_FLOOR, главная причина изменения). Пол маржи выше
 * max_price стратегия не берёт: противоречие настройки называет Gate.
 */
test('step 72 (Р-207): a target below the margin floor goes to the margin floor; a current price below the floor is raised to it', () => {
  const margin = { amountMinor: 1820, minMarginBp: 1000 };
  // Buy Box 1795, подрез 5 → цель 1790, пол маржи 1820 > min 1000; нынешняя 1850 выше пола — цена опускается на пол, это не подъём
  const capped = runStrategy(input(matchBuybox(), { bounds: { minMinor: 1000, maxMinor: 3000, marginFloor: margin } }));
  assert.ok(capped.kind === 'INTENT' && capped.intent.intentClass === 'CHANGED' && capped.intent.proposedMinor === 1820, JSON.stringify(capped));
  assert.deepEqual(capped.intent.explanation.map((x) => x.code), ['BUYBOX_UNDERCUT', 'CAPPED_AT_MARGIN_FLOOR']);
  assert.deepEqual(capped.intent.reason, { code: 'CAPPED_AT_MARGIN_FLOOR', params: { targetMinor: 1790, floorMinor: 1820, minMinor: 1000, minMarginBp: 1000, currency: 'EUR' } });
  // Нынешняя 1700 ниже пола маржи: цена поднимается до пола, и главная причина — подъём
  const raised = runStrategy(input(matchBuybox(), { bounds: { minMinor: 1000, maxMinor: 3000, marginFloor: margin }, currentPriceMinor: 1700 }));
  assert.ok(raised.kind === 'INTENT' && raised.intent.intentClass === 'CHANGED' && raised.intent.proposedMinor === 1820);
  assert.deepEqual(raised.intent.explanation.map((x) => x.code), ['BUYBOX_UNDERCUT', 'CAPPED_AT_MARGIN_FLOOR', 'RAISED_TO_FLOOR']);
  assert.deepEqual(raised.intent.reason, { code: 'RAISED_TO_FLOOR', params: { currentMinor: 1700, floorMinor: 1820, bound: 'margin_floor', minMarginBp: 1000, currency: 'EUR' } });
  // Отрицательный контроль: без пола маржи — прежнее поведение, цель 1790 выше min и проходит как есть
  const without = runStrategy(input(matchBuybox(), { bounds: { minMinor: 1000, maxMinor: 3000 }, currentPriceMinor: 1700 }));
  assert.ok(without.kind === 'INTENT' && without.intent.proposedMinor === 1790 && without.intent.reason.code === 'BUYBOX_UNDERCUT');
});

test('step 72 (Р-207): holding strategies and no-op paths do not keep a price below the floor; the deadband does not either', () => {
  const margin = { amountMinor: 1820, minMarginBp: 1000 };
  const bounds = { minMinor: 1000, maxMinor: 3000, marginFloor: margin };
  // HOLD: цель ниже пола маржи и нынешняя выше пола — цена удерживается, нижняя граница удержания — пол маржи
  const held = runStrategy(input(matchBuybox({ atBound: 'HOLD' }), { bounds }));
  assert.ok(held.kind === 'INTENT' && held.intent.intentClass === 'NO_OP' && held.intent.reason.code === 'TARGET_OUTSIDE_BOUNDS_HOLD');
  assert.equal(held.intent.reason.params.minMinor, 1820);
  // HOLD при нынешней ниже пола — подъём до пола
  const heldRaised = runStrategy(input(matchBuybox({ atBound: 'HOLD' }), { bounds, currentPriceMinor: 1700 }));
  assert.ok(heldRaised.kind === 'INTENT' && heldRaised.intent.intentClass === 'CHANGED' && heldRaised.intent.proposedMinor === 1820);
  assert.deepEqual(heldRaised.intent.explanation.map((x) => x.code), ['BUYBOX_UNDERCUT', 'TARGET_OUTSIDE_BOUNDS_HOLD', 'RAISED_TO_FLOOR']);
  // Buy Box уже наш, но нынешняя ниже пола маржи — подъём, а не «уже выигрываем»
  const winning = runStrategy(input(matchBuybox(), { bounds, currentPriceMinor: 1700,
    snapshot: markAcceptedBySanity(snapshot({ buybox: { price: eur(1700), isSelf: true } }), 'test') }));
  assert.ok(winning.kind === 'INTENT' && winning.intent.intentClass === 'CHANGED' && winning.intent.proposedMinor === 1820);
  assert.deepEqual(winning.intent.explanation.map((x) => x.code), ['ALREADY_WINNING_BUYBOX', 'RAISED_TO_FLOOR']);
  // Конкурентов нет, нынешняя ниже min_price (пол маржи не задан) — подъём до min_price
  const lonely = runStrategy(input({ type: 'BEAT_LOWEST', undercutMinor: 1, scope: 'VISIBLE_TOP_N', compareLanded: false, atBound: 'CAP' }, {
    bounds: { minMinor: 1500, maxMinor: 3000 }, currentPriceMinor: 1400,
    snapshot: markAcceptedBySanity(snapshot({ offers: [{ rank: 1, isSelf: true, price: eur(1400), shipping: eur(0), totalPrice: eur(1400) }] }), 'test') }));
  assert.ok(lonely.kind === 'INTENT' && lonely.intent.intentClass === 'CHANGED' && lonely.intent.proposedMinor === 1500, JSON.stringify(lonely));
  assert.deepEqual(lonely.intent.reason.params, { currentMinor: 1400, floorMinor: 1500, bound: 'min', currency: 'EUR' });
  // Зона нечувствительности 50 не держит нынешнюю 1810 ниже пола 1820
  const deadband = runStrategy({ ...input(matchBuybox(), { bounds, currentPriceMinor: 1810 }), strategy: { strategyId: 'st-1', version: 1, params: matchBuybox(), deadbandMinor: 50 } });
  assert.ok(deadband.kind === 'INTENT' && deadband.intent.intentClass === 'CHANGED' && deadband.intent.proposedMinor === 1820);
  // Тень: подъём, уже удержанный тенью, не повторяется (SHADOW_ALREADY_PROPOSED), а не предлагается на каждом опросе
  const shadow = runStrategy(input(matchBuybox(), { bounds, currentPriceMinor: 1700, shadowLastProposedMinor: 1820 }));
  assert.ok(shadow.kind === 'INTENT' && shadow.intent.intentClass === 'NO_OP' && shadow.intent.reason.code === 'SHADOW_ALREADY_PROPOSED');
});

test('step 72 (Р-207): a margin floor above max price is left to the Gate; fixed and margin strategies are not lifted by the strategy', () => {
  // Пол маржи 3200 выше max 3000 — стратегия встаёт на min, отказ MARGIN_FLOOR_ABOVE_MAX_PRICE даст Gate
  const above = runStrategy(input(matchBuybox(), { bounds: { minMinor: 1000, maxMinor: 3000, marginFloor: { amountMinor: 3200, minMarginBp: 3000 } }, currentPriceMinor: 1700 }));
  assert.ok(above.kind === 'INTENT' && above.intent.proposedMinor === 1790 && above.intent.reason.code === 'BUYBOX_UNDERCUT');
  // Фиксированная цена ниже пола — конфликт настройки продавца, он идёт в Gate как прежде [Р-44]
  const fixed = runStrategy(input({ type: 'FIXED', priceMinor: 1500 }, { bounds: { minMinor: 1000, maxMinor: 3000, marginFloor: { amountMinor: 1820, minMarginBp: 1000 } }, currentPriceMinor: 1700 }));
  assert.ok(fixed.kind === 'INTENT' && fixed.intent.proposedMinor === 1500 && fixed.intent.reason.code === 'FIXED_PRICE');
});

/**
 * Р-208 (шаг 73, OQ-251): предел шага не снимается — подъём к полу больше предела идёт лестницей: каждая оценка — ступень на предел
 * шага, пока цена не дойдёт до пола; объяснение называет, сколько ступеней осталось
 */
test('step 73 (Р-208): a raise larger than the step limit climbs to the floor one step per evaluation, with the steps left named', () => {
  const bounds = { minMinor: 500, maxMinor: 3000, marginFloor: { amountMinor: 1524, minMarginBp: 1000 } };
  // Цель конкурента 1790 выше пола 1524, нынешняя 1000: шаг 79 % больше предела 10 % — ступень к полу, а не отказ Gate
  const first = runStrategy(input(matchBuybox(), { bounds, currentPriceMinor: 1000, stepLimitBp: 1000 }));
  assert.ok(first.kind === 'INTENT' && first.intent.intentClass === 'CHANGED' && first.intent.proposedMinor === 1100, JSON.stringify(first));
  assert.deepEqual(first.intent.reason, { code: 'RAISED_TOWARD_FLOOR', params: { currentMinor: 1000, floorMinor: 1524, bound: 'margin_floor', minMarginBp: 1000, stepLimitBp: 1000, stepsLeft: 4, currency: 'EUR' } });
  // Лестница целиком: каждая следующая оценка начинает с цены предыдущей ступени; пол — последней ступенью, причина — подъём до пола
  const climbed: number[] = [];
  let current = 1000;
  for (let guard = 0; guard < 20 && current < 1524; guard += 1) {
    const r = runStrategy(input(matchBuybox({ undercutMinor: 0 }), { bounds, currentPriceMinor: current, stepLimitBp: 1000,
      snapshot: markAcceptedBySanity(snapshot({ buybox: { price: eur(1300), isSelf: false } }), 'test') }));
    assert.ok(r.kind === 'INTENT' && r.intent.intentClass === 'CHANGED', JSON.stringify(r));
    // Шаг ни разу не больше предела — Gate проверяет его как у любой цены
    assert.ok(Math.ceil(((r.intent.proposedMinor - current) * 10_000) / current) <= 1000);
    current = r.intent.proposedMinor;
    climbed.push(current);
  }
  assert.deepEqual(climbed, [1100, 1210, 1331, 1464, 1524]);
  // У цели ниже пола маржи цепочка называет и пол маржи, и ступень
  const capped = runStrategy(input(matchBuybox(), { bounds, currentPriceMinor: 1000, stepLimitBp: 1000,
    snapshot: markAcceptedBySanity(snapshot({ buybox: { price: eur(1300), isSelf: false } }), 'test') }));
  assert.ok(capped.kind === 'INTENT');
  assert.deepEqual(capped.intent.explanation.map((x) => x.code), ['BUYBOX_UNDERCUT', 'CAPPED_AT_MARGIN_FLOOR', 'RAISED_TOWARD_FLOOR']);
  // Тень: ступень, уже удержанная тенью, не повторяется на каждой оценке
  const shadow = runStrategy(input(matchBuybox(), { bounds, currentPriceMinor: 1000, stepLimitBp: 1000, shadowLastProposedMinor: 1100 }));
  assert.ok(shadow.kind === 'INTENT' && shadow.intent.intentClass === 'NO_OP' && shadow.intent.reason.code === 'SHADOW_ALREADY_PROPOSED');
  // Отрицательный контроль: без предела шага — сразу пол (прежнее Р-207)
  const noLimit = runStrategy(input(matchBuybox(), { bounds, currentPriceMinor: 1000,
    snapshot: markAcceptedBySanity(snapshot({ buybox: { price: eur(1300), isSelf: false } }), 'test') }));
  assert.ok(noLimit.kind === 'INTENT' && noLimit.intent.proposedMinor === 1524 && noLimit.intent.reason.code === 'RAISED_TO_FLOOR');
});

/**
 * Р-210 (шаг 73, OQ-253): нынешняя цена ниже пола — подъём сразу, без свежего снимка конкурентов, «after cost update»; Р-209 — так
 * же после отказа перепроверки по новому курсу
 */
test('step 73 (Р-209, Р-210): without a usable competitor snapshot a price below the floor is still raised — after a cost update or a floor recheck', () => {
  const bounds = { minMinor: 500, maxMinor: 3000, marginFloor: { amountMinor: 1524, minMarginBp: 1000 } };
  const beat = { type: 'BEAT_LOWEST' as const, undercutMinor: 1, scope: 'VISIBLE_TOP_N' as const, compareLanded: false, atBound: 'CAP' as const };
  const afterCost = runStrategy(input(beat, { bounds, currentPriceMinor: 1000, snapshot: null, raiseAfter: 'COST_UPDATE', trigger: { type: 'COST_CHANGE' } }));
  assert.ok(afterCost.kind === 'INTENT' && afterCost.intent.intentClass === 'CHANGED' && afterCost.intent.proposedMinor === 1524, JSON.stringify(afterCost));
  assert.deepEqual(afterCost.intent.reason, { code: 'RAISED_TO_FLOOR', params: { currentMinor: 1000, floorMinor: 1524, bound: 'margin_floor', minMarginBp: 1000, after: 'COST_UPDATE', currency: 'EUR' } });
  // Цена из данных продавца, а не конкурентов: своё правило — слепок снимка не нужен, остановка цен из данных конкурентов не держит
  assert.equal(afterCost.intent.ruleCode, 'FLOOR_RAISE');
  // Устаревший снимок — то же самое; с пределом шага — ступень
  const stale = markAcceptedBySanity(snapshot({ observedAt: '2026-09-14T08:00:00.000Z' }), 'test');
  const recheck = runStrategy(input(beat, { bounds, currentPriceMinor: 1000, snapshot: stale, stepLimitBp: 1000, raiseAfter: 'FLOOR_RECHECK', trigger: { type: 'COST_CHANGE' } }));
  assert.ok(recheck.kind === 'INTENT' && recheck.intent.proposedMinor === 1100 && recheck.intent.reason.code === 'RAISED_TOWARD_FLOOR');
  assert.equal(recheck.intent.reason.params.after, 'FLOOR_RECHECK');
  // Отрицательные контроли: цена не ниже пола — без снимка стратегия рынка не оценивается, как прежде
  const above = runStrategy(input(beat, { bounds, currentPriceMinor: 1600, snapshot: null, raiseAfter: 'COST_UPDATE' }));
  assert.ok(above.kind === 'NOT_EVALUATED' && above.reason.code === 'COMPETITOR_REQUIREMENT_NOT_MET');
});

/**
 * Р-212 (шаг 74, OQ-255): ступень лестницы — не чаще периода планового пересчёта. Внутри паузы подъём от цены ниже пола — «без
 * изменения» LADDER_PACED с моментом следующей ступени; откуда пришла оценка — снимок конкурента или запрос базы — не важно
 */
test('step 74 (Р-212): within the pause after a step neither a competitor observation nor a re-evaluation request makes the next step', () => {
  const bounds = { minMinor: 500, maxMinor: 3000, marginFloor: { amountMinor: 1524, minMarginBp: 1000 } };
  const lastStepAt = '2026-09-14T09:59:00.000Z';
  const paced = runStrategy(input(matchBuybox(), { bounds, currentPriceMinor: 1100, stepLimitBp: 1000, ladderPace: { lastStepAt, paceSeconds: 900 } }));
  assert.ok(paced.kind === 'INTENT' && paced.intent.intentClass === 'NO_OP', JSON.stringify(paced));
  assert.deepEqual(paced.intent.reason, { code: 'LADDER_PACED', params: { currentMinor: 1100, floorMinor: 1524, nextStepAt: '2026-09-14T10:14:00.000Z', currency: 'EUR' } });
  // Запрос базы без снимка конкурентов — тоже пауза: подъём к полу из данных продавца не обгоняет лестницу
  const beat = { type: 'BEAT_LOWEST' as const, undercutMinor: 1, scope: 'VISIBLE_TOP_N' as const, compareLanded: false, atBound: 'CAP' as const };
  const request = runStrategy(input(beat, { bounds, currentPriceMinor: 1100, snapshot: null, stepLimitBp: 1000, raiseAfter: 'COST_UPDATE', ladderPace: { lastStepAt, paceSeconds: 900 } }));
  assert.ok(request.kind === 'INTENT' && request.intent.reason.code === 'LADDER_PACED', JSON.stringify(request));
  // После паузы — следующая ступень; без прошлой ступени пауза не держит; цена не ниже пола паузой не держится вовсе
  const after = runStrategy(input(matchBuybox(), { bounds, currentPriceMinor: 1100, stepLimitBp: 1000, ladderPace: { lastStepAt: '2026-09-14T09:44:00.000Z', paceSeconds: 900 } }));
  assert.ok(after.kind === 'INTENT' && after.intent.proposedMinor === 1210 && after.intent.reason.code === 'RAISED_TOWARD_FLOOR', JSON.stringify(after));
  const fresh = runStrategy(input(matchBuybox(), { bounds, currentPriceMinor: 1100, stepLimitBp: 1000, ladderPace: { lastStepAt: null, paceSeconds: 900 } }));
  assert.ok(fresh.kind === 'INTENT' && fresh.intent.proposedMinor === 1210, JSON.stringify(fresh));
  const above = runStrategy(input(matchBuybox(), { bounds, currentPriceMinor: 1600, ladderPace: { lastStepAt, paceSeconds: 900 } }));
  assert.ok(above.kind === 'INTENT' && above.intent.reason.code !== 'LADDER_PACED', JSON.stringify(above));
  // Допуск в минуту — только пересчёту, на его собственный ход: ступень 14 мин 30 с назад плановую оценку уже не держит, 13 мин назад —
  // держит; наблюдение конкурента допуска не получает вовсе
  const nearlyPace = { lastStepAt: '2026-09-14T09:45:30.000Z', paceSeconds: 900 };
  const nearly = runStrategy(input(matchBuybox(), { bounds, currentPriceMinor: 1100, stepLimitBp: 1000, ladderPace: nearlyPace, trigger: { type: 'SCHEDULE' } }));
  assert.equal(nearly.kind === 'INTENT' && nearly.intent.reason.code, 'RAISED_TOWARD_FLOOR');
  const early = runStrategy(input(matchBuybox(), { bounds, currentPriceMinor: 1100, stepLimitBp: 1000, ladderPace: { lastStepAt: '2026-09-14T09:47:00.000Z', paceSeconds: 900 }, trigger: { type: 'SCHEDULE' } }));
  assert.equal(early.kind === 'INTENT' && early.intent.reason.code, 'LADDER_PACED');
  const observed = runStrategy(input(matchBuybox(), { bounds, currentPriceMinor: 1100, stepLimitBp: 1000, ladderPace: nearlyPace, trigger: { type: 'COMPETITOR_CHANGE' } }));
  assert.equal(observed.kind === 'INTENT' && observed.intent.reason.code, 'LADDER_PACED', 'a competitor observation gets no tolerance');
});

/** Р-211 (шаг 74): повод подъёма называется только у пола, который он двигает — границы и отказ перепроверки у любого, остальные входы у пола маржи */
test('step 74 (Р-211): the reason of a raise names only an input that moves the floor in force', () => {
  const beat = { type: 'BEAT_LOWEST' as const, undercutMinor: 1, scope: 'VISIBLE_TOP_N' as const, compareLanded: false, atBound: 'CAP' as const };
  const margin = { minMinor: 500, maxMinor: 3000, marginFloor: { amountMinor: 1524, minMarginBp: 1000 } };
  const min = { minMinor: 1700, maxMinor: 3000, marginFloor: { amountMinor: 1524, minMarginBp: 1000 } };
  const after = (bounds: typeof margin, raiseAfter: NonNullable<EngineInput['raiseAfter']>) => {
    const r = runStrategy(input(beat, { bounds, currentPriceMinor: 1000, snapshot: null, raiseAfter }));
    return r.kind === 'INTENT' ? r.intent.reason.params.after ?? null : 'NOT_EVALUATED';
  };
  assert.deepEqual(['FX_UPDATE', 'GUARDRAIL_UPDATE', 'VAT_UPDATE', 'COST_UPDATE', 'BOUNDS_UPDATE', 'FLOOR_RECHECK'].map((a) => after(margin, a as never)),
    ['FX_UPDATE', 'GUARDRAIL_UPDATE', 'VAT_UPDATE', 'COST_UPDATE', 'BOUNDS_UPDATE', 'FLOOR_RECHECK'], 'the margin floor is moved by cost, fee, rate, guardrail, VAT and max_price');
  assert.deepEqual(['FX_UPDATE', 'COST_UPDATE', 'BOUNDS_UPDATE', 'FLOOR_RECHECK'].map((a) => after(min, a as never)), [null, null, 'BOUNDS_UPDATE', 'FLOOR_RECHECK'],
    'min_price is moved only by the bounds');
});
