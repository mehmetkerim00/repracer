import assert from 'node:assert/strict';
import test from 'node:test';
import { priceBasisMismatch } from './price-basis.ts';

test('Р-116: the applied price equal to the sent price plus or minus the VAT rate is a basis mismatch; other differences are not', () => {
  assert.equal(priceBasisMismatch(1999, 1999, 1900), null, 'applied as sent');
  assert.equal(priceBasisMismatch(1999, 2379, 1900), 'TAX_ADDED', '19.99 treated as net: buyer sees 23.79');
  assert.equal(priceBasisMismatch(1999, 2378, 1900), 'TAX_ADDED', 'one minor unit of channel rounding');
  assert.equal(priceBasisMismatch(1999, 1680, 1900), 'TAX_REMOVED', '19.99 treated as gross and tax taken out');
  assert.equal(priceBasisMismatch(1999, 2000, 1900), null, 'a cent is rounding, not a basis');
  assert.equal(priceBasisMismatch(1999, 2199, 1900), null, 'a discount or another price is a divergence, not a basis');
  assert.equal(priceBasisMismatch(1999, 2379, null), null, 'no VAT rate (sales tax): the check is not made');
  assert.equal(priceBasisMismatch(10, 12, 1900), null, 'the tax share is indistinguishable from rounding');
  assert.equal(priceBasisMismatch(1999, 2399, 2000), 'TAX_ADDED', 'AT 20 %');
});
