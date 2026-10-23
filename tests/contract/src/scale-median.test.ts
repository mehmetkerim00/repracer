import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MEDIAN_RUNS, medianOf } from './scale-median.ts';

/** Шаг 107: у медианы трёх прогонов остаются зубы — регрессия краснит, разовый выброс нет; предел прежний (10 с) */
const LIMIT = 10;

test('step 107: a single slow run of three does not redden the full catalog state measurement; a regression in two or three runs does', () => {
  assert.equal(MEDIAN_RUNS, 3);
  assert.ok(medianOf([9.5, 15.2, 9.6]) <= LIMIT, 'one stalled run of the runner is noise');
  assert.ok(medianOf([10.4, 10.6, 10.5]) > LIMIT, 'a regression in every run reddens');
  assert.ok(medianOf([10.4, 9.0, 10.6]) > LIMIT, 'a regression in two runs of three reddens');
  assert.equal(medianOf([8.03]), 8.03);
  assert.throws(() => medianOf([]), /odd number of runs/);
  assert.throws(() => medianOf([1, 2]), /odd number of runs/);
});
