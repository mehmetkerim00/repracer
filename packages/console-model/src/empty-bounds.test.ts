import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boundsView } from './bounds.ts';
import { LOCALES, messagesFor } from './i18n/index.ts';
import { productList } from './products.ts';

/**
 * Шаг 152 (#27, UX-04; скрин владельца): незаданная граница — «Not set» словами, а не «not set: not set», и с признаком «пусто», чтобы
 * экран не ставил ей моноширинный шрифт: индекс Costs & floors, карточка минимальной цены на странице пола, подпись выбора массовой правки
 */

const NOW = '2026-11-17T12:00:00.000Z';
const missing = { status: 'UNRESOLVABLE', cause: 'MISSING' };
const resolved = (amountMinor: number) => ({ status: 'RESOLVED', amountMinor, sourceIds: ['x'] });

function scope(min: unknown, max: unknown) {
  return {
    writeScopeId: 'ws', productId: 'p', channelAccountId: 'acc-1', marketplace: 'ATVPDKIKX0DER', externalUnitId: 'SKU-1', channelProductRef: 'REF-1',
    condition: 'new', gtin: null, currency: 'USD', basis: 'NET', taxRegime: 'SALES_TAX_EXCLUDED', title: 'Bamboo board', sku: 'SKU-1',
    pricingMode: 'OFF', status: 'ACTIVE', currentPriceMinor: null, minMarginBp: null, cost: null, declaredCost: null,
    clearance: null, strategy: null, priceStop: null, channelHalt: null, channelDistrust: null, pricingSwitch: null,
    bounds: { currency: 'USD', basis: 'NET', min, max }, feeEstimates: [], fees: [],
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

test('step 152 (#27, UX-04): a missing bound is «Not set» in words and says it is empty — never «not set: not set»', () => {
  for (const l of LOCALES) {
    const m = messagesFor(l);
    const row = productList(world(scope(missing, missing)), m).rows[0]!;
    assert.deepEqual([row.minPrice, row.minPriceMissing, row.maxPrice, row.maxPriceMissing], [m.ui.products.notSet, true, m.ui.products.notSet, true], `${l}: Offers / Costs & floors row`);
    const page = boundsView(world(scope(missing, missing)), 'ws', m, {})!;
    assert.deepEqual([page.minPrice.amount, page.maxPrice.amount], [m.ui.products.notSet, m.ui.products.notSet], `${l}: the floor page cards`);
  }
  const en = messagesFor('en');
  const set = productList(world(scope(resolved(1200), resolved(5000))), en).rows[0]!;
  assert.deepEqual([set.minPrice, set.minPriceMissing, set.maxPrice, set.maxPriceMissing], ['$12.00', false, '$50.00', false]);
});

test('step 152 (#27): a bound in another currency still says why — it is not «not set», it is unusable', () => {
  const en = messagesFor('en');
  const row = productList(world(scope({ status: 'UNRESOLVABLE', cause: 'CURRENCY_MISMATCH', actualCurrency: 'EUR' }, resolved(5000))), en).rows[0]!;
  assert.notEqual(row.minPrice, en.ui.products.notSet);
  assert.equal(row.minPrice, en.ui.common.boundUnresolved(en.values.CURRENCY_MISMATCH));
  assert.equal(row.minPriceMissing, true, 'no amount — no money font');
});
