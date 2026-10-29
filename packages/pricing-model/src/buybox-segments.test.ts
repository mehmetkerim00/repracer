import assert from 'node:assert/strict';
import { test } from 'node:test';
import { holderByViewShare, sellerViewShares } from './buybox-segments.ts';

/** Шаг 109 [Р-235]: держатель Buy Box по долям просмотров сегментов — сумма по продавцу, строго больше половины */

const seg = (sellerRef: string | null, membership: string, viewSharePct: number, isSelf = false) => ({ ...(sellerRef ? { sellerRef } : {}), isSelf, membership, viewSharePct });

test('step 109 [Р-235]: the sandbox sample — one seller 72 % non-Prime + 10 % Prime holds the Buy Box with 82 %', () => {
  const segments = [seg('A3DJR8M9Y3OUPG', 'NON_PRIME', 72), seg('A3DJR8M9Y3OUPG', 'PRIME', 10), seg('A2ZWOLFOFDPJL1', 'NON_PRIME', 18)];
  assert.deepEqual(holderByViewShare(segments), { holder: 'OTHER', sellerRef: 'A3DJR8M9Y3OUPG', viewSharePct: 82 });
  assert.deepEqual(sellerViewShares(segments).map((s) => [s.sellerRef, s.viewSharePct, s.segments.map((x) => `${x.membership}:${x.viewSharePct}`).join(',')]),
    [['A3DJR8M9Y3OUPG', 82, 'NON_PRIME:72,PRIME:10'], ['A2ZWOLFOFDPJL1', 18, 'NON_PRIME:18']]);
});

test('step 109 [Р-235]: shares of one seller add up — 40 % + 30 % is a majority that no single segment has', () => {
  assert.deepEqual(holderByViewShare([seg('B', 'NON_PRIME', 40), seg('B', 'PRIME', 30), seg('C', 'DEFAULT', 30)]), { holder: 'OTHER', sellerRef: 'B', viewSharePct: 70 });
});

test('step 109 [Р-235]: no majority — exactly half, a three-way split or no segments — the holder is unknown', () => {
  assert.equal(holderByViewShare([seg('B', 'NON_PRIME', 50), seg('C', 'PRIME', 50)]), null);
  assert.equal(holderByViewShare([seg('B', 'NON_PRIME', 40), seg('C', 'PRIME', 35), seg('D', 'DEFAULT', 25)]), null);
  assert.equal(holderByViewShare([]), null);
});

test('step 109 [Р-235]: our own offer holds by majority; an unnamed seller with a majority leaves the holder unknown', () => {
  assert.deepEqual(holderByViewShare([seg(null, 'NON_PRIME', 60, true), seg('C', 'PRIME', 40)]), { holder: 'SELF', sellerRef: null, viewSharePct: 60 });
  assert.equal(holderByViewShare([seg(null, 'NON_PRIME', 60), seg('C', 'PRIME', 40)]), null);
  // Два неназванных продавца не складываются в одного
  assert.equal(holderByViewShare([seg(null, 'NON_PRIME', 30), seg(null, 'PRIME', 30), seg('C', 'DEFAULT', 40)]), null);
});

test('step 109 [Р-235]: a share outside 0…100 is not counted', () => {
  assert.equal(holderByViewShare([seg('B', 'NON_PRIME', 140)]), null);
  assert.deepEqual(holderByViewShare([seg('B', 'NON_PRIME', Number.NaN), seg('C', 'PRIME', 60)]), { holder: 'OTHER', sellerRef: 'C', viewSharePct: 60 });
});
