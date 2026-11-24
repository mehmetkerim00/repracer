import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boundsDiffView } from './bounds-edit.ts';
import { messagesFor } from './i18n/index.ts';
import type { Locale } from './i18n/types.ts';
import { offerChoiceText } from './products.ts';

/**
 * Шаг 175 (QA-A Testing 2.0, этап 4 — быстрые правки UX): подписи и тексты, которые продавец читает на Offers, Costs & floors и в выборе
 * предложения. Данные синтетические
 */

const LOCALES: Locale[] = ['en', 'de', 'es', 'fr'];
const resolved = (amountMinor: number) => ({ status: 'RESOLVED', amountMinor, sourceIds: ['x'] });
function scope(over: Record<string, unknown> = {}) {
  return {
    writeScopeId: 'ws-1', productId: 'p-1', channelAccountId: 'acc-1', marketplace: 'ATVPDKIKX0DER', externalUnitId: 'SKU-1', channelProductRef: 'B0SYN17501',
    condition: 'new', gtin: null, currency: 'USD', basis: 'NET', taxRegime: 'SALES_TAX_EXCLUDED', title: 'Desk lamp', sku: 'SKU-1',
    pricingMode: 'ENGINE', status: 'ACTIVE', currentPriceMinor: 3000, minMarginBp: null, cost: null, declaredCost: null,
    clearance: null, strategy: null, priceStop: null, channelHalt: null, channelDistrust: null, pricingSwitch: null,
    bounds: { currency: 'USD', basis: 'NET', min: resolved(1000), max: resolved(5000) }, feeEstimates: [], fees: [], color: 'red', ...over,
  };
}
function world(writeMode: 'SHADOW' | 'LIVE', s = scope()) {
  return {
    id: 'w', title: 'w', description: '', tenantId: 't', now: '2026-11-25T12:00:00.000Z', viewer: { role: 'OWNER', membershipId: 'mb' }, people: {},
    accounts: [{ channelAccountId: 'acc-1', channel: 'AMAZON', marketplaces: ['ATVPDKIKX0DER'], writeMode }],
    state: { scopes: [s], writes: [], strategies: [], strategyVersions: [], explanationRulesets: [], fxRates: [], divergenceCases: [], halts: [], stops: [], distrusts: [],
      members: [{ membershipId: 'mb', role: 'OWNER' }], offerChannelPricing: [], pricingHealth: [], listingStatus: [] },
  } as never;
}

test('step 175: Offers says «Showing N of M offers» and spells the Buy Box share column out — no «BB» abbreviation', () => {
  const en = messagesFor('en');
  assert.equal(en.ui.products.filters.matched(4, 38), 'Showing 4 of 38 offers');
  assert.equal(en.ui.products.columns.bbShare, 'Buy Box share (7 days)');
  for (const l of LOCALES) {
    const m = messagesFor(l);
    assert.ok(!/\bBB\b/.test(m.ui.products.columns.bbShare), `${l}: ${m.ui.products.columns.bbShare}`);
    assert.ok(m.ui.products.filters.matched(4, 38).includes('4') && m.ui.products.filters.matched(4, 38).includes('38'), `${l}: both numbers`);
  }
});

test('step 175: the bulk edit never promises the next decision — a price outside the new bounds is said as it is, and in shadow mode as not sent', () => {
  for (const l of LOCALES) {
    const m = messagesFor(l);
    const edits = [{ writeScopeId: 'ws-1', expected: { minMinor: 1000, maxMinor: 5000 }, maxMinor: 2000 }];
    const rows = [{ writeScopeId: 'ws-1', currency: 'USD', before: { minMinor: 1000, maxMinor: 5000 }, after: { minMinor: 1000, maxMinor: 2000 } }];
    const flag = (mode: 'SHADOW' | 'LIVE') => boundsDiffView(world(mode), edits as never, rows as never, m).rows[0]!.flags.find((f) => f.code === 'PRICE_ABOVE_NEW_CEILING')!.text;
    const live = flag('LIVE');
    const shadow = flag('SHADOW');
    assert.ok(live.includes(m.money(3000, 'USD')) && live.includes(m.money(2000, 'USD')), `${l}: the price and the new maximum — ${live}`);
    assert.notEqual(shadow, live, `${l}: shadow mode is said`);
    assert.ok(shadow.includes(m.ui.boundsEdit.flags.shadowNote), `${l}: ${shadow}`);
  }
  const en = messagesFor('en');
  assert.ok(!/next decision will/.test(Object.values(en.ui.boundsEdit.flags).map((f) => (typeof f === 'function' ? (f as (...a: string[]) => string)('$1', '$2') : f)).join(' ')), 'no promise of the next decision');
});

test('step 175: an offer in a picker is named with its color and its channel ID, not the name alone', () => {
  for (const l of LOCALES) {
    const m = messagesFor(l);
    const text = offerChoiceText({ label: 'Desk lamp · amazon.com', color: 'red', channel: 'AMAZON', channelProductRef: 'B0SYN17501', gtin: null } as never, m);
    assert.ok(text.startsWith('Desk lamp · amazon.com') && text.includes('red') && text.includes('B0SYN17501'), `${l}: ${text}`);
    assert.equal(offerChoiceText({ label: 'Bike light · ebay.com', color: null, channel: 'EBAY', channelProductRef: '', gtin: null } as never, m), 'Bike light · ebay.com', `${l}: nothing to add — the label`);
  }
});
