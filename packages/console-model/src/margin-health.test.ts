import assert from 'node:assert/strict';
import { test } from 'node:test';
import { messagesFor } from './i18n/index.ts';
import { productList } from './products.ts';

/**
 * Шаг 162 (#27, второй раунд): строка Offers — маржа при текущей цене (функция Gate) и Health: важнейшая пометка строки первой, остальные —
 * «+N». Данные синтетические
 */

const en = messagesFor('en');
const NOW = '2026-11-17T12:00:00.000Z';
const resolved = (amountMinor: number) => ({ status: 'RESOLVED', amountMinor, sourceIds: ['x'] });
// 15 % комиссия, без фиксированной, себестоимость $5.00, без налога с продаж: при $10.00 маржа (10 − 1.5 − 5) / 10 = 35 %
const COST = { currency: 'USD', costProfileId: 'cp', unitCostMinor: 500, fixedFeeMinor: 0, feeRateBp: 1500, tax: { regime: 'SALES_TAX_EXCLUDED' } };

function scope(over: Record<string, unknown> = {}) {
  return {
    writeScopeId: 'ws', productId: 'p', channelAccountId: 'acc-1', marketplace: 'ATVPDKIKX0DER', externalUnitId: 'SKU-1', channelProductRef: 'REF-1',
    condition: 'new', gtin: null, currency: 'USD', basis: 'NET', taxRegime: 'SALES_TAX_EXCLUDED', title: 'Desk lamp', sku: 'SKU-1',
    pricingMode: 'ENGINE', status: 'ACTIVE', currentPriceMinor: 1000, minMarginBp: null, cost: COST, declaredCost: { costProfileId: 'cp', currency: 'USD', unitCostMinor: 500 },
    clearance: null, strategy: null, priceStop: null, channelHalt: null, channelDistrust: null, pricingSwitch: null,
    bounds: { currency: 'USD', basis: 'NET', min: resolved(800), max: resolved(5000) }, feeEstimates: [], fees: [], ...over,
  };
}
function world(s: unknown) {
  return {
    id: 'w', title: 'w', description: '', tenantId: 't', now: NOW, viewer: { role: 'OWNER', membershipId: 'mb' }, people: {},
    accounts: [{ channelAccountId: 'acc-1', channel: 'AMAZON', marketplaces: ['ATVPDKIKX0DER'] }],
    state: { scopes: [s], writes: [], strategies: [], strategyVersions: [], explanationRulesets: [], fxRates: [], divergenceCases: [], halts: [], stops: [], distrusts: [],
      members: [{ membershipId: 'mb', role: 'OWNER' }], offerChannelPricing: [], pricingHealth: [], listingStatus: [] },
  } as never;
}
const row = (over: Record<string, unknown> = {}) => productList(world(scope(over)), en).rows[0]!;

test('step 162 (#27): the margin at the current price — the Gate function; no price — a dash, no unit cost — words', () => {
  assert.deepEqual(row().margin, { text: en.percentBp(3500), missing: false, bp: 3500 });
  // $5.00: (5 − 0.75 − 5) / 5 = −15 %
  assert.deepEqual(row({ currentPriceMinor: 500 }).margin, { text: en.percentBp(-1500), missing: false, bp: -1500 }, 'below cost the margin is negative');
  assert.deepEqual(row({ currentPriceMinor: null }).margin, { text: '–', missing: true, bp: null });
  assert.deepEqual(row({ cost: null, declaredCost: null }).margin, { text: en.ui.products.noUnitCost, missing: true, bp: null });
});

test('step 162 (#27): Health — the most important mark of the row first, the rest as «+N»; nothing to say — null', () => {
  assert.equal(row().health, null);
  const clearance = { floorMinor: 400, enabledAt: NOW, enabledByMembershipId: 'mb', note: 'x', endsAt: null };
  const both = row({ clearance, cost: null });
  assert.deepEqual([both.health?.text, both.health?.more.map((x) => x.text)], [en.ui.products.feeExpired, [both.clearance]], 'the expired fee estimate before clearance');
  const frozen = row({ bounds: { currency: 'USD', basis: 'NET', min: resolved(6000), max: resolved(5000) } });
  assert.deepEqual([frozen.health?.tone, frozen.health?.text], ['stop', frozen.frozen], 'the floor above the ceiling is the most important');
});
