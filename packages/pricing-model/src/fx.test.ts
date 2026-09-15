import assert from 'node:assert/strict';
import { test } from 'node:test';
import { convertMinor, pickFxQuote, storefrontPriceForMarginBp, type FxQuote } from './index.ts';

// Курс USD из eurofxref-daily.xml ЕЦБ за 2026-09-14 (публичный справочный курс, не данные продавца)
const USD_2026_09_14: FxQuote = { source: 'ECB', rateDate: '2026-09-14', base: 'EUR', quote: 'USD', rateMicros: 1_155_100, availableFrom: '2026-09-14T15:30:00.000Z' };
const AT = '2026-09-15T09:00:00.000Z';

test('Р-61: EUR cost converts to USD rounding up and reports the rate it used', () => {
  const r = convertMinor(1000, 'EUR', 'USD', [USD_2026_09_14], AT, 'UP');
  assert.deepEqual(r, {
    ok: true, amountMinor: 1156,
    fx: { source: 'ECB', rateDate: '2026-09-14', base: 'EUR', quote: 'USD', rateMicros: 1_155_100, from: 'EUR', to: 'USD', sourceAmountMinor: 1000, convertedAmountMinor: 1156, rounding: 'UP' },
  });
});

test('Р-61: USD floor from a EUR cost — cost 10.00 EUR, fee 15 %, margin 20 %, net price', () => {
  const cost = convertMinor(1000, 'EUR', 'USD', [USD_2026_09_14], AT, 'UP');
  assert.ok(cost.ok);
  const floor = storefrontPriceForMarginBp({ currency: 'USD', costProfileId: 'cp', unitCostMinor: cost.amountMinor, fixedFeeMinor: 0, feeRateBp: 1500, tax: { regime: 'SALES_TAX_EXCLUDED' } }, 2000);
  assert.deepEqual(floor, { ok: true, priceMinor: 1779 });
});

test('Р-63: a USD reference converts to EUR to the nearest cent', () => {
  const r = convertMinor(2050, 'USD', 'EUR', [USD_2026_09_14], AT, 'NEAREST');
  assert.equal(r.ok && r.amountMinor, 1775);
});

test('a rate not yet loaded at decision time, a stale rate and an unsupported pair fail closed', () => {
  assert.deepEqual(convertMinor(1000, 'EUR', 'USD', [USD_2026_09_14], '2026-09-14T15:00:00.000Z', 'UP'), { ok: false, cause: 'FX_RATE_UNAVAILABLE', from: 'EUR', to: 'USD' });
  assert.deepEqual(pickFxQuote([USD_2026_09_14], 'USD', '2026-09-21T09:00:00.000Z'), { ok: false, cause: 'FX_RATE_STALE' });
  assert.equal(pickFxQuote([USD_2026_09_14], 'USD', '2026-09-20T09:00:00.000Z').ok, true);
  assert.deepEqual(convertMinor(1000, 'EUR', 'PLN', [USD_2026_09_14], AT, 'UP'), { ok: false, cause: 'UNSUPPORTED_CURRENCY', from: 'EUR', to: 'PLN' });
  assert.deepEqual(convertMinor(1000, 'EUR', 'EUR', [], AT, 'UP'), { ok: true, amountMinor: 1000, fx: null });
});
