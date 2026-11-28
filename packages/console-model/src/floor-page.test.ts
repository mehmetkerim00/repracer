import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boundsView } from './bounds.ts';
import { messagesFor } from './i18n/index.ts';

/**
 * Шаг 149 (#27, часть 2; Р-254): страница «Bounds and price floor» на модели экранов (данные синтетические). Сверху — действующий пол,
 * текущая цена и статус (тот же, что на Offers, с тенью); расчёт пола — панелью, которая раскрыта сразу, только когда в ней есть что
 * объяснить: пол выше потолка, пол маржи не вычисляется, нет себестоимости. Распродажа с истёкшей оценкой комиссии — пометкой
 */

const en = messagesFor('en');
const NOW = '2026-11-17T12:00:00.000Z';
const resolved = (amountMinor: number) => ({ status: 'RESOLVED', amountMinor, sourceIds: ['x'] });
const unset = { status: 'UNRESOLVED', cause: 'NOT_SET' };
const COST = { currency: 'USD', costProfileId: 'cp', unitCostMinor: 500, fixedFeeMinor: 30, feeRateBp: 1500, tax: { regime: 'SALES_TAX_EXCLUDED' } };

function scope(over: Record<string, unknown> = {}) {
  return {
    writeScopeId: 'ws', productId: 'p', channelAccountId: 'acc-1', marketplace: 'ATVPDKIKX0DER', externalUnitId: 'SKU-1', channelProductRef: 'REF-1',
    condition: 'new', gtin: null, currency: 'USD', basis: 'NET', taxRegime: 'SALES_TAX_EXCLUDED', title: 'Desk lamp', sku: 'SKU-1',
    pricingMode: 'ENGINE', status: 'ACTIVE', currentPriceMinor: 1999, minMarginBp: null, cost: COST, declaredCost: { costProfileId: 'cp', currency: 'USD', unitCostMinor: 500 },
    clearance: null, strategy: null, priceStop: null, channelHalt: null, channelDistrust: null, pricingSwitch: null,
    bounds: { currency: 'USD', basis: 'NET', min: resolved(1200), max: resolved(5000) }, feeEstimates: [], fees: [], ...over,
  };
}
function world(s: unknown) {
  return {
    id: 'w', title: 'w', description: '', tenantId: 't', now: NOW, viewer: { role: 'OWNER', membershipId: 'mb' }, people: {},
    accounts: [{ channelAccountId: 'acc-1', channel: 'AMAZON', marketplaces: ['ATVPDKIKX0DER'] }],
    state: { scopes: [s], writes: [], strategies: [], explanationRulesets: [], fxRates: [], divergenceCases: [], halts: [], stops: [], distrusts: [], members: [{ membershipId: 'mb', role: 'OWNER' }],
      offerChannelPricing: [], pricingHealth: [], listingStatus: [] },
  } as never;
}
const view = (s: unknown, writeMode?: 'SHADOW' | 'LIVE') => boundsView(world(s), 'ws', en, writeMode ? { writeMode } : {})!;

test('step 149 (#27): the floor page leads with the effective floor, the current price and the status — the same status as Offers, shadow included', () => {
  const live = view(scope(), 'LIVE');
  assert.deepEqual([live.current.amount, live.current.missing, live.status.label], ['$19.99', false, en.ui.enabled.on]);
  assert.equal(view(scope(), 'SHADOW').status.label, en.ui.enabled.onShadow);
  const fresh = view(scope({ currentPriceMinor: null, pricingMode: 'OFF' }));
  assert.deepEqual([fresh.current.amount, fresh.current.missing, fresh.status.label], [en.ui.products.noPriceYet, true, en.ui.enabled.off]);
});

test('step 188 (§3, Р-254): the calculation panel is folded by default — what it used to open for is said above it: the floor above the ceiling by the plaque, a missing unit cost by its entry card', () => {
  assert.equal('calculationOpen' in view(scope()), false, 'the page has no rule that opens the calculation');
  assert.notEqual(view(scope({ bounds: { currency: 'USD', basis: 'NET', min: resolved(6000), max: resolved(5000) } })).frozen, null, 'the floor above the ceiling is said by the plaque');
  const noCost = view(scope({ cost: null, declaredCost: null, bounds: { currency: 'USD', basis: 'NET', min: unset, max: unset } }));
  assert.deepEqual([noCost.costEntry.unitCost, noCost.costEntry.currency], ['', 'USD'], 'a missing unit cost is an empty field of the entry card (step 187)');
});

test('step 149 (#27, step 142): clearance with an expired fee estimate is marked on the floor page too', () => {
  const clearance = { floorMinor: 1000, enabledAt: NOW, enabledByMembershipId: 'mb', note: 'x', endsAt: null };
  assert.equal(view(scope({ clearance, cost: null })).feeExpired, en.ui.products.feeExpired);
  assert.equal(view(scope({ clearance })).feeExpired, null);
});
