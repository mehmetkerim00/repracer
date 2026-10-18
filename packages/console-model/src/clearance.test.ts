import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InMemoryPricingStore } from '@repracer/pricing-pipeline';
import { boundsView, effectiveFloor } from './bounds.ts';
import { dangerousReport } from './dangerous-report.ts';
import { describe } from './explain.ts';
import { LOCALES, messagesFor } from './i18n/index.ts';
import { periodRange } from './period.ts';
import { productList } from './products.ts';
import { rejectedView } from './rejected.ts';
import { decisionTrace } from './trace.ts';

/**
 * Шаг 102 [Р-227], задание D на модели экранов (данные синтетические):
 *  (4) квитанция в режиме распродажи называет пол, безубыточность и убыток на штуку, кто включил, когда и зачем;
 *  (5) удержания пола распродажи — отдельной строкой, «без пола вы продали бы на X дешевле» от них не растёт;
 *  и безубыточность — третий источник пола на экранах («from break-even»)
 */

const clearanceStep = { code: 'CLEARANCE_FLOOR', params: { floorMinor: 700, breakEvenMinor: 1312, lossPerUnitMinor: 612, currency: 'USD' } };

test('step 102 (D4) [Р-227]: the receipt names the loss per piece below break-even on every language', () => {
  const texts = Object.fromEntries(LOCALES.map((l) => [l, describe(clearanceStep, messagesFor(l)).text]));
  assert.equal(texts.en, 'Clearance mode: floor $7.00 is below break-even $13.12 (−$6.12 per piece).');
  for (const l of LOCALES) {
    const m = messagesFor(l);
    const named = [m.money(700, 'USD'), m.money(1312, 'USD'), `−${m.money(612, 'USD')}`].map((x) => texts[l]!.includes(x));
    assert.equal(JSON.stringify(named), '[true,true,true]', `${l}: floor, break-even and the loss per piece — ${texts[l]}`);
  }
  // Пол не ниже безубыточности — убытка нет, и квитанция его не выдумывает
  assert.equal(describe({ code: 'CLEARANCE_FLOOR', params: { floorMinor: 1400, breakEvenMinor: 1312, currency: 'USD' } }, messagesFor('en')).text,
    'Clearance mode: floor $14.00, break-even $13.12.');
});

test('step 102 (D4) [Р-227]: the receipt header carries the Clearance pill and who enabled clearance, when and why', () => {
  const en = messagesFor('en');
  const world = {
    id: 'w', now: '2026-10-18T12:00:00.000Z', viewer: {}, people: { 'alex@example.test': 'Alex Porter' }, accounts: [],
    state: { scopes: [], strategies: [], explanationRulesets: [], members: [], divergenceCases: [] },
  } as never;
  const detail = {
    decision: {
      decisionId: 'd-1', intentId: 'i-1', writeScopeId: 'ws-1', decidedAt: '2026-10-18T11:00:00.000Z', outcome: 'NO_CHANGE', decisionClass: 'NO_OP',
      currency: 'USD', basis: 'NET', finalMinor: null, proposedMinor: null, rejectionReason: null, boundDeviationBp: null, noChangeReason: 'ALREADY_AT_TARGET',
      reason: { code: 'NO_CHANGE', params: {} }, explanation: null, checks: [], clearanceChangeId: 'c-1',
    },
    intent: {
      intentId: 'i-1', writeScopeId: 'ws-1', createdAt: '2026-10-18T11:00:00.000Z', currency: 'USD', currentMinor: 700,
      reason: { code: 'ALREADY_AT_TARGET', params: { targetMinor: 700, currency: 'USD' } },
      explanation: [clearanceStep, { code: 'CAPPED_AT_CLEARANCE_FLOOR', params: { targetMinor: 649, floorMinor: 700, currency: 'USD' } }],
    },
    writes: [],
    clearance: { changeId: 'c-1', floorMinor: 700, currency: 'USD', endsAt: null, note: 'Clearing summer stock', enabledAt: '2026-10-18T09:00:00.000Z',
      enabledByMembershipId: 'm-1', enabledByName: null, enabledByEmail: 'alex@example.test' },
  } as never;
  const trace = decisionTrace(world, detail, en);
  assert.equal(trace.clearance?.pill, 'Clearance');
  assert.match(trace.clearance?.line ?? '', /^Clearance mode: floor \$7\.00 is below break-even \$13\.12 \(−\$6\.12 per piece\)\. Enabled by Alex Porter, .*note: “Clearing summer stock”\.$/);
});

test('step 102 (D5) [Р-117, Р-227]: holds of the clearance floor are a separate line and never grow «without the floor you would have sold cheaper»', async () => {
  const en = messagesFor('en');
  const scope = (id: string) => ({ writeScopeId: id, productId: `p-${id}`, channelAccountId: 'acc-1', marketplace: 'amazon.com', externalUnitId: id, channelProductRef: id, condition: 'new', gtin: null, currency: 'USD' });
  const world = {
    id: 'w', title: 'w', description: '', tenantId: 't', now: '2026-10-18T12:00:00.000Z', viewer: {},
    accounts: [{ channelAccountId: 'acc-1', channel: 'AMAZON', marketplaces: ['amazon.com'] }],
    state: { scopes: [scope('ws-1'), scope('ws-2')], strategies: [], explanationRulesets: [] },
  } as never;
  const intent = (intentId: string, writeScopeId: string, createdAt: string, explanation: unknown[]) => ({
    intentId, writeScopeId, createdAt, currency: 'USD', currentMinor: 1850, reason: { code: 'LOWEST_UNDERCUT', params: {} }, explanation,
  });
  const store = new InMemoryPricingStore({ scopes: [] } as never);
  // Обычный пол: цель $11.95, пол $15.00 — пол удержал, без него на $3.05 дешевле
  store.intents.push(intent('i-1', 'ws-1', '2026-10-18T10:00:00.000Z', [{ code: 'LOWEST_UNDERCUT', params: {} },
    { code: 'CAPPED_AT_MIN_PRICE', params: { targetMinor: 1195, minMinor: 1500, currency: 'USD' } }]) as never);
  // Пол распродажи: цель $8.99, пол $10.00 — намеренный убыток; от него «спасения» нет
  store.intents.push(intent('i-2', 'ws-2', '2026-10-18T10:30:00.000Z', [clearanceStep, { code: 'LOWEST_UNDERCUT', params: {} },
    { code: 'CAPPED_AT_CLEARANCE_FLOOR', params: { targetMinor: 899, floorMinor: 1000, currency: 'USD' } }]) as never);
  const slice = await store.interventions('t', '2026-10-17T12:00:00.000Z', '2026-10-18T12:00:00.000Z');
  const report = dangerousReport(world, slice as never, periodRange({ preset: '24h' }, '2026-10-18T12:00:00.000Z', 'UTC', 30), en.ui.period.phrase['24h'], en);
  assert.equal(report.headline, 'The floor held the price 1 time in the last 24 hours; without it you would have sold $3.05 cheaper');
  assert.equal(report.clearanceHeadline, 'The clearance floor held the price 1 time in the last 24 hours — an intentional loss, not counted above');
  assert.equal(JSON.stringify(report.floorHolds.items.map((i) => [i.floor, i.clearance])), JSON.stringify([['$10.00', 'Clearance'], ['$15.00', null]]));
});

test('step 102 [Р-227]: break-even is the third source of the floor; clearance replaces the floor; without a unit cost — as before', () => {
  const world = { now: '2026-10-18T12:00:00.000Z', state: { fxRates: [] } } as never;
  const cost = { currency: 'USD', costProfileId: 'cp', unitCostMinor: 1100, fixedFeeMinor: 0, feeRateBp: 1500, tax: { regime: 'SALES_TAX_EXCLUDED' } };
  const base = { currency: 'USD', minMarginBp: null, cost, declaredCost: null, clearance: null,
    bounds: { currency: 'USD', basis: 'NET', min: { status: 'RESOLVED', amountMinor: 1000, sourceIds: ['m'] }, max: { status: 'RESOLVED', amountMinor: 5000, sourceIds: ['x'] } } };
  const be = effectiveFloor(base as never, world);
  assert.equal(JSON.stringify([be.minor, be.source, be.breakEvenMinor]), JSON.stringify([1295, 'BREAK_EVEN', 1295]), 'min_price $10.00 is below break-even $12.95');
  const cl = effectiveFloor({ ...base, clearance: { changeId: 'c', floorMinor: 700, currency: 'USD', endsAt: null, note: 'n', enabledAt: '2026-10-18T09:00:00.000Z', enabledByMembershipId: null } } as never, world);
  assert.equal(JSON.stringify([cl.minor, cl.source]), JSON.stringify([700, 'CLEARANCE']));
  const none = effectiveFloor({ ...base, cost: null } as never, world);
  assert.equal(JSON.stringify([none.minor, none.source]), JSON.stringify([1000, 'MIN']), 'without a declared unit cost the floor is the minimum price (Р-131)');
});

/**
 * Шаг 102 [Р-227], уточнение владельца: «пол выше потолка» (безубыточность выросла выше max_price) теперь законное состояние — и оно
 * ВИДНО продавцу: пометка у предложения в Offers, плашка на странице пола с тем, что сделать, и своя категория в Protections, а не
 * общее «границу не вычислить». Молча замороженный товар — будущий тикет поддержки
 */
test('step 102 [Р-227]: a floor above the ceiling is visible — on Offers, on the floor page and as its own Protections category', () => {
  const en = messagesFor('en');
  const cost = { currency: 'USD', costProfileId: 'cp', unitCostMinor: 1100, fixedFeeMinor: 0, feeRateBp: 1500, tax: { regime: 'SALES_TAX_EXCLUDED' } };
  const scope = {
    writeScopeId: 'ws-1', productId: 'p-1', channelAccountId: 'acc-1', marketplace: 'amazon.com', externalUnitId: 'SYN-SKU-1', channelProductRef: 'SYN-SKU-1',
    condition: 'new', gtin: null, currency: 'USD', basis: 'NET', taxRegime: 'SALES_TAX_EXCLUDED', productTitle: 'Plant pot, green', productSku: 'SYN-SKU-1',
    pricingMode: 'ENGINE', status: 'ACTIVE', currentPriceMinor: 1200, minMarginBp: null, cost, declaredCost: null, clearance: null, strategy: null,
    bounds: { currency: 'USD', basis: 'NET', min: { status: 'RESOLVED', amountMinor: 1000, sourceIds: ['m'] }, max: { status: 'RESOLVED', amountMinor: 1200, sourceIds: ['x'] } },
    feeEstimates: [], fees: [], channelNotes: [],
  };
  const world = {
    id: 'w', title: 'w', description: '', tenantId: 't', now: '2026-10-18T12:00:00.000Z', viewer: { role: 'OWNER' }, people: {},
    accounts: [{ channelAccountId: 'acc-1', channel: 'AMAZON', marketplaces: ['amazon.com'] }],
    state: { scopes: [scope], writes: [], strategies: [], explanationRulesets: [], fxRates: [], members: [], divergenceCases: [], offerChannelPricing: [], pricingHealth: [], halts: [] },
  } as never;
  // Безубыточность $12.95 выше потолка $12.00 — ни одной цены без убытка
  const floor = effectiveFloor(scope as never, world);
  assert.equal(JSON.stringify([floor.minor, floor.source, floor.aboveCeiling]), JSON.stringify([1295, 'BREAK_EVEN', true]));
  assert.equal(effectiveFloor({ ...scope, bounds: { ...scope.bounds, max: { status: 'RESOLVED', amountMinor: 5000, sourceIds: ['x'] } } } as never, world).aboveCeiling, false,
    'a floor below the ceiling is not frozen');
  assert.equal(effectiveFloor({ ...scope, clearance: { changeId: 'c', floorMinor: 900, currency: 'USD', endsAt: null, note: 'n', enabledAt: '2026-10-18T09:00:00.000Z', enabledByMembershipId: null } } as never, world).aboveCeiling, false,
    'clearance below the ceiling unfreezes the offer');
  const row = productList(world, en).rows[0]!;
  assert.equal(JSON.stringify([row.frozen, row.floor.parts]), JSON.stringify(['Floor above ceiling', 'prices frozen — raise the maximum price or enable clearance']));
  const page = boundsView(world, 'ws-1', en)!;
  assert.equal(page.frozen, 'Floor above ceiling — prices frozen. Your floor $12.95 is above your maximum price $12.00: no price fits, and no price change is sent. Raise the maximum price or enable clearance.');
  // Protections: свой счётчик, и в «границу не вычислить» он не входит
  const decision = (id: string, cause: string) => ({
    decisionId: id, intentId: `i-${id}`, writeScopeId: 'ws-1', decidedAt: '2026-10-18T11:00:00.000Z', outcome: 'REJECTED', decisionClass: 'REJECTED_BY_GATE',
    currency: 'USD', basis: 'NET', finalMinor: null, proposedMinor: 1150, rejectionReason: 'BOUND_UNRESOLVABLE', boundDeviationBp: null, noChangeReason: null,
    reason: { code: 'BOUND_UNRESOLVABLE', params: { cause } }, explanation: null, checks: [],
  });
  const view = rejectedView(world, { from: '2026-10-17T12:00:00.000Z', to: '2026-10-18T12:00:00.000Z', truncated: false,
    decisions: [decision('d-1', 'MARGIN_FLOOR_ABOVE_MAX_PRICE'), decision('d-2', 'MARGIN_FLOOR_ABOVE_MAX_PRICE'), decision('d-3', 'FEE_ESTIMATE_MISSING')],
    intents: [], endedWrites: [], rejectedSnapshots: [] } as never, en);
  assert.equal(JSON.stringify([view.summary.floorAboveCeiling, view.summary.unresolvable]), JSON.stringify([2, 1]));
  for (const l of LOCALES) {
    const m = messagesFor(l);
    assert.ok([m.ui.products.floorAboveCeiling, m.ui.rejected.stats.floorAboveCeiling, boundsView(world, 'ws-1', m)!.frozen].every((t) => typeof t === 'string' && t.length > 0), `${l}: worded`);
  }
  // Снимок страницы пола (шаг 102): в распродаже карточка минимальной маржи говорила «no value» — пол маржи не действует, а не отсутствует
  const inClearance = { ...scope, minMarginBp: 1200, bounds: { ...scope.bounds, max: { status: 'RESOLVED', amountMinor: 5000, sourceIds: ['x'] } },
    clearance: { changeId: 'c', floorMinor: 1000, currency: 'USD', endsAt: null, note: 'n', enabledAt: '2026-10-18T09:00:00.000Z', enabledByMembershipId: null } };
  const clearanceWorld = { ...(world as object), state: { ...(world as { state: object }).state, scopes: [inClearance] } } as never;
  const card = boundsView(clearanceWorld, 'ws-1', en)!.marginFloor;
  assert.equal(JSON.stringify([card.minMarginBp, card.amount, card.unavailable]), JSON.stringify(['12%', '$15.07', 'not applied while clearance is on']));
});
