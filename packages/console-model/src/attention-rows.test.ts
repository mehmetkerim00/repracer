import assert from 'node:assert/strict';
import { test } from 'node:test';
import { messagesFor } from './i18n/index.ts';
import { productList } from './products.ts';
import { attentionReasons } from './status-line.ts';
import { stockView } from './stock.ts';

/**
 * Шаг 168 (решение владельца): строка «требует внимания» на Offers и Inventory подсвечена только по настоящей причине. Offers — причины,
 * которые считает строка состояния (`attentionReasons`: нет себестоимости или комиссии, Automate Pricing, рамки Amazon без значений, не
 * продаётся, выключено человеком); Inventory — правило его фильтра «Needs attention» (`stockNeedsAttention`: расхождение, остаток у канала,
 * ниже порога выставления). Данные синтетические
 */

const en = messagesFor('en');
const NOW = '2026-11-18T12:00:00.000Z';
const resolved = (amountMinor: number) => ({ status: 'RESOLVED', amountMinor, sourceIds: ['x'] });
const COST = { currency: 'USD', costProfileId: 'cp', unitCostMinor: 500, fixedFeeMinor: 0, feeRateBp: 1500, tax: { regime: 'SALES_TAX_EXCLUDED' } };

function scope(id: string, over: Record<string, unknown> = {}) {
  return {
    writeScopeId: id, productId: `p-${id}`, channelAccountId: 'acc-1', marketplace: 'ATVPDKIKX0DER', externalUnitId: `SKU-${id}`, channelProductRef: `REF-${id}`,
    condition: 'new', gtin: null, currency: 'USD', basis: 'NET', taxRegime: 'SALES_TAX_EXCLUDED', title: `Item ${id}`, sku: `SKU-${id}`,
    pricingMode: 'ENGINE', status: 'ACTIVE', currentPriceMinor: 1000, minMarginBp: null, cost: COST, declaredCost: { costProfileId: 'cp', currency: 'USD', unitCostMinor: 500 },
    clearance: null, strategy: null, priceStop: null, channelHalt: null, channelDistrust: null, pricingSwitch: null,
    bounds: { currency: 'USD', basis: 'NET', min: resolved(800), max: resolved(5000) }, feeEstimates: [], fees: [], ...over,
  };
}
function world(scopes: unknown[]) {
  return {
    id: 'w', title: 'w', description: '', tenantId: 't', now: NOW, viewer: { role: 'OWNER', membershipId: 'mb' }, people: {},
    accounts: [{ channelAccountId: 'acc-1', channel: 'AMAZON', marketplaces: ['ATVPDKIKX0DER'] }],
    state: { scopes, writes: [], strategies: [], strategyVersions: [], explanationRulesets: [], fxRates: [], divergenceCases: [], halts: [], stops: [], distrusts: [],
      members: [{ membershipId: 'mb', role: 'OWNER' }], offerChannelPricing: [], pricingHealth: [], listingStatus: [] },
  } as never;
}

test('step 168: an Offers row is marked for attention exactly when the status line counts it — and with the same reasons', () => {
  const scopes = [
    scope('plain'),
    scope('nocost', { cost: null, declaredCost: null }),
    scope('off', { pricingMode: 'OFF', pricingSwitch: { action: 'OFF', at: NOW, byMembershipId: 'mb', note: null } }),
    // Распродажа и истёкшая комиссия — пометки Health, но не причины строки состояния: строка не жёлтая «на всякий случай»
    scope('clearance', { clearance: { floorMinor: 400, enabledAt: NOW, enabledByMembershipId: 'mb', note: 'x', endsAt: null } }),
  ];
  const w = world(scopes);
  const rows = productList(w, en).rows;
  assert.deepEqual(rows.map((r) => [r.unit.writeScopeId, r.attention]), scopes.map((s) => [s.writeScopeId, attentionReasons(w, s as never, en)]));
  assert.deepEqual(Object.fromEntries(rows.map((r) => [r.unit.writeScopeId, r.attention.length > 0])), { plain: false, nocost: true, off: true, clearance: false });
});

test('step 168: an Inventory row is marked for attention exactly when the «Needs attention» filter takes it', () => {
  const unit = (over: Record<string, unknown> = {}) => ({
    writeScopeId: 'u', channelAccountId: 'acc-1', channel: 'AMAZON', marketplaces: ['ATVPDKIKX0DER'], syncEnabled: true, published: 5,
    allocation: { bufferUnits: 0, maxQuantity: null, minQuantityToList: 0 }, sent: null, confirmed: null, divergence: null,
    sideEffects: { requiresAck: false, acknowledged: false, text: null }, ...over,
  });
  const product = (sku: string, available: number, channels: unknown[], extra: Record<string, unknown> = {}) => ({
    productId: `p-${sku}`, sku, title: sku, gtin: null, onHand: available, reserved: 0, available, channels, ...extra,
  });
  const items = [
    product('plain', 5, [unit()]),
    product('diverged', 5, [unit({ divergence: { status: 'NOT_APPLIED', since: NOW, errorCode: null } })]),
    product('fba', 0, [], { channelManaged: [{ channel: 'AMAZON', marketplace: 'ATVPDKIKX0DER', quantity: 7, observedAt: NOW }] }),
    product('below', 3, [unit({ published: 0, allocation: { bufferUnits: 0, maxQuantity: null, minQuantityToList: 5 } })]),
  ];
  const page = { items, total: items.length, summary: { products: items.length, withStock: 3, synced: 3, pendingWrites: 0, diverged: 1, openReservations: 0 } };
  const v = stockView(world([]), page as never, { offset: 0, limit: 50 }, [], en);
  assert.deepEqual(Object.fromEntries(v.rows.map((r) => [r.sku, r.attention])), { plain: false, diverged: true, fba: true, below: true });
});
