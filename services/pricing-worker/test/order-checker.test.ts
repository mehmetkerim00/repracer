import assert from 'node:assert/strict';
import { test } from 'node:test';
import { adapterOrder } from './order-checker.ts';

test('step 56: the order checker — a repeat of the same version is idempotent; an older version after a newer one and the same version with another amount are violations', () => {
  const c = (scope: string, version: number, amount: number) => ({ write_scope_id: scope, version, amount_minor: amount });
  assert.deepEqual(adapterOrder([c('a', 1, 100), c('a', 2, 200), c('a', 2, 200), c('b', 1, 50)]).adapterVersionViolations, 0, 'the same version resent after a killed instance');
  assert.equal(adapterOrder([c('a', 1, 100), c('a', 2, 200), c('a', 2, 200)]).adapterIdempotentRepeats, 1);
  assert.equal(adapterOrder([c('a', 1, 100), c('a', 3, 300), c('a', 2, 200)]).adapterVersionViolations, 1, 'older after newer');
  assert.equal(adapterOrder([c('a', 2, 200), c('a', 2, 250)]).adapterVersionViolations, 1, 'the same version with another amount');
  assert.equal(adapterOrder([c('a', 1, 100), c('a', 3, 300), c('a', 2, 200), c('a', 3, 300)]).adapterVersionViolations, 1, 'the high-water mark is kept after a violation');
});
