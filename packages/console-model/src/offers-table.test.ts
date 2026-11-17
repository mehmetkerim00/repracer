import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LOCALES, messagesFor } from './i18n/index.ts';
import { productList } from './products.ts';

/**
 * Шаг 148 (#27, часть 1; Р-254): строка Offers на модели экранов (данные синтетические). Статус различает бой и тень и называет, кто
 * остановил; пустые значения — словами и с признаком «пусто» (экран не ставит им моноширинный шрифт); строка несёт список недостающего для
 * включения; распродажа с истёкшей оценкой комиссии — своя пометка
 */

const en = messagesFor('en');
const NOW = '2026-11-17T12:00:00.000Z';
const resolved = (amountMinor: number) => ({ status: 'RESOLVED', amountMinor, sourceIds: ['x'] });
const unset = { status: 'UNRESOLVED', cause: 'NOT_SET' };
const COST = { currency: 'USD', costProfileId: 'cp', unitCostMinor: 500, fixedFeeMinor: 30, feeRateBp: 1500, tax: { regime: 'SALES_TAX_EXCLUDED' } };

function scope(id: string, over: Record<string, unknown> = {}) {
  return {
    writeScopeId: id, productId: `p-${id}`, channelAccountId: 'acc-1', marketplace: 'ATVPDKIKX0DER', externalUnitId: `SKU-${id}`, channelProductRef: `REF-${id}`,
    condition: 'new', gtin: null, currency: 'USD', basis: 'NET', taxRegime: 'SALES_TAX_EXCLUDED', title: `Offer ${id}`, sku: `SKU-${id}`,
    pricingMode: 'ENGINE', status: 'ACTIVE', currentPriceMinor: 1500, minMarginBp: null, cost: COST, declaredCost: { costProfileId: 'cp', currency: 'USD', unitCostMinor: 500 },
    clearance: null, strategy: null, priceStop: null, channelHalt: null, channelDistrust: null, pricingSwitch: null,
    bounds: { currency: 'USD', basis: 'NET', min: resolved(1000), max: resolved(5000) }, feeEstimates: [], fees: [], ...over,
  };
}

function world(scopes: unknown[]) {
  return {
    id: 'w', title: 'w', description: '', tenantId: 't', now: NOW, viewer: { role: 'OWNER', membershipId: 'mb-owner' }, people: {},
    accounts: [{ channelAccountId: 'acc-1', channel: 'AMAZON', marketplaces: ['ATVPDKIKX0DER'] }],
    state: {
      scopes, writes: [], strategies: [], strategyVersions: [], explanationRulesets: [], fxRates: [], divergenceCases: [], halts: [], stops: [], distrusts: [],
      offerChannelPricing: [], pricingHealth: [], listingStatus: [],
      members: [{ membershipId: 'mb-owner', role: 'OWNER' }, { membershipId: 'mb-manager', role: 'MANAGER' }],
    },
  } as never;
}

const rowOf = (s: unknown, options: Parameters<typeof productList>[5] = {}, m = en) => productList(world([s]), m, undefined, undefined, undefined, options).rows[0]!;

test('step 148 (#27, UX-03): «On» only on a live account; on a shadow account «On · shadow mode» — calculated, not sent; a stop names who and when', () => {
  const live = rowOf(scope('a'), { writeModes: new Map([['acc-1', 'LIVE']]) }).enabled;
  assert.deepEqual([live.tone, live.label], ['ok', en.ui.enabled.on]);
  const shadow = rowOf(scope('a'), { writeModes: new Map([['acc-1', 'SHADOW']]) }).enabled;
  assert.deepEqual([shadow.tone, shadow.label, shadow.short], ['warn', en.ui.enabled.onShadow, en.ui.enabled.onShadowShort]);
  const stopped = rowOf(scope('a', { priceStop: { stopId: 's', scope: 'TENANT', channelAccountId: null, marketplace: null, stoppedAt: '2026-11-17T09:12:00.000Z', stoppedByMembershipId: 'mb-manager' } })).enabled;
  assert.deepEqual([stopped.tone, stopped.label], ['stop', en.ui.enabled.stopped]);
  assert.match(stopped.short ?? '', /^by Manager, Nov 17, 2026, 09:12/, 'the stop names who and when in the cell');
  // В тени остановленное — остановленное: остановка важнее режима
  assert.equal(rowOf(scope('a', { priceStop: { stopId: 's', scope: 'TENANT', channelAccountId: null, marketplace: null, stoppedAt: NOW, stoppedByMembershipId: 'mb-owner' } }), { writeModes: new Map([['acc-1', 'SHADOW']]) }).enabled.label, en.ui.enabled.stopped);
});

test('step 148 (#27, UX-04): an empty value is words, not «no value» / «not set: not set», and says it is empty — the screen gives it no money font', () => {
  const empty = rowOf(scope('e', { currentPriceMinor: null, bounds: { currency: 'USD', basis: 'NET', min: unset, max: unset }, cost: null, declaredCost: null, pricingMode: 'OFF' }));
  assert.deepEqual([empty.currentPrice, empty.currentPriceMissing], [en.ui.products.noPriceYet, true]);
  assert.deepEqual([empty.floor.amount, empty.floor.missing], [en.ui.products.notSet, true]);
  assert.deepEqual([empty.maxPrice, empty.maxPriceMissing], [en.ui.products.notSet, true]);
  for (const text of [empty.currentPrice, empty.floor.amount, empty.maxPrice]) assert.ok(!/no value|not set: not set/.test(text), text);
  const full = rowOf(scope('f'));
  assert.deepEqual([full.currentPrice, full.currentPriceMissing, full.floor.missing, full.maxPrice, full.maxPriceMissing], ['$15.00', false, false, '$50.00', false]);
  for (const l of LOCALES) {
    const m = messagesFor(l);
    const r = rowOf(scope('e', { currentPriceMinor: null, bounds: { currency: 'USD', basis: 'NET', min: unset, max: unset } }), {}, m);
    for (const text of [r.currentPrice, r.floor.amount, r.maxPrice]) assert.ok(text.trim() !== '' && text !== m.ui.common.noValue, `${l}: ${text}`);
  }
});

test('step 148 (#27, UX-05): the row lists everything missing to switch it on — unit cost and fees, minimum price, maximum price', () => {
  assert.deepEqual(rowOf(scope('e', { bounds: { currency: 'USD', basis: 'NET', min: unset, max: unset }, cost: null, pricingMode: 'OFF' })).missing, ['UNIT_COST', 'MIN_PRICE', 'MAX_PRICE']);
  assert.deepEqual(rowOf(scope('m', { bounds: { currency: 'USD', basis: 'NET', min: resolved(1000), max: unset }, pricingMode: 'OFF' })).missing, ['MAX_PRICE']);
  assert.deepEqual(rowOf(scope('f')).missing, []);
});

test('step 148 (#27, step 142): clearance with an expired fee estimate is marked on Offers; with a valid estimate it is not', () => {
  const clearance = { floorMinor: 1000, enabledAt: NOW, enabledByMembershipId: 'mb-owner', note: 'x', endsAt: null };
  assert.equal(rowOf(scope('c', { clearance, cost: null })).feeExpired, en.ui.products.feeExpired);
  assert.equal(rowOf(scope('c', { clearance })).feeExpired, null);
  assert.equal(rowOf(scope('c', { cost: null })).feeExpired, null, 'outside clearance the expired estimate is the unit cost reason, not this mark');
});
