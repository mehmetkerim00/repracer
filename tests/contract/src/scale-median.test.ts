import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { FULL_STATE_SECONDS, FULL_STATE_TARGET_SECONDS, MEDIAN_RUNS, medianOf } from './scale-median.ts';

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

/**
 * Шаг 110.3 (решение владельца): предел замера временно выше цели — и пока он выше, у послабления есть обратный билет: строка отложенного
 * «после оптимизации предел ВЕРНУТЬ к 10 с». Предел без билета — красная сборка: временное не становится постоянным молча
 */
function returnTicketFindings(deferred: string, limit = FULL_STATE_SECONDS, target = FULL_STATE_TARGET_SECONDS): string[] {
  if (limit <= target) return [];
  const ticket = deferred.split('\n').find((line) => line.startsWith('|') && line.includes('полное состояние каталога') && line.includes(`ВЕРНУТЬ к ${target} с`));
  return ticket ? [] : [`предел ${limit} с выше цели ${target} с, а в docs/deferred.md нет строки «… ВЕРНУТЬ к ${target} с»`];
}

test('step 110.3: the full catalog state limit above its 10 s target holds its return ticket in docs/deferred.md', () => {
  const deferred = readFileSync(new URL('../../../docs/deferred.md', import.meta.url), 'utf8');
  assert.equal(FULL_STATE_TARGET_SECONDS, 10);
  assert.deepEqual(returnTicketFindings(deferred), []);
  // Зубы [Р-94]: без строки — находка; вернули предел к цели — билет не нужен
  assert.equal(returnTicketFindings(deferred.replaceAll('ВЕРНУТЬ к 10 с', 'вернуть когда-нибудь')).length, 1);
  assert.deepEqual(returnTicketFindings('', 10), []);
});
