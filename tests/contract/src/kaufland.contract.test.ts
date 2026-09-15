import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CONSERVATIVE_RULES } from '@repracer/kaufland-adapter';
import { kauflandUnderTest } from './adapters.ts';
import { runScenario } from './harness/runner.ts';
import { loadScenarios } from './harness/scenario.ts';

const FIXTURES = fileURLToPath(new URL('../fixtures/kaufland/', import.meta.url));

/** Обязательные сценарии шага 6 */
const MANDATORY = [
  'bulk-207-partial',
  '429',
  'timeout-unknown-outcome',
  'webhook-duplicate',
  'webhook-bad-signature',
  'stale-version',
  'budget-exhausted',
  // Шаг 7: путь решения о цене
  'pipeline-x100-high',
  'pipeline-x100-low',
  'pipeline-mass-shift',
  'pipeline-above-max',
  'pipeline-max-missing',
  'pipeline-bound-unresolvable',
  // Шаг 8: якоря проверки входов, остановка канала, транзакция решения
  'pipeline-oq90-trap',
  'pipeline-cold-start',
  'pipeline-halt-auto-release',
  'pipeline-halt-manual-release',
  'pipeline-bounds-version',
  // Шаг 9: валюта и налоговый режим
  'pipeline-tax-regimes',
  // Шаг 10: очередь записей и диспетчер [Р-64]
  'pipeline-write-queue',
  'pipeline-write-superseded',
  // Шаг 10: курсы ЕЦБ [Р-61, Р-63]
  'pipeline-fx-usd-floor',
  'pipeline-fx-ean-anchor',
];

const loaded = loadScenarios(FIXTURES);
const loggedCodes = new Set<string>();

test('all mandatory scenarios are present', () => {
  for (const name of MANDATORY) {
    assert.ok(loaded.some(({ scenario }) => scenario.tags.includes(`mandatory:${name}`)), `missing mandatory scenario ${name}`);
  }
});

for (const { file, scenario } of loaded) {
  test(`${scenario.id} — ${scenario.title} [${file}]`, async () => {
    const report = await runScenario(scenario, kauflandUnderTest);
    for (const entry of report.logs) loggedCodes.add(entry.code);
    const trace = report.trace.map((t) => `  ${t.method} ${t.path} → ${t.exchangeId ?? '-'} ${t.outcome}`).join('\n');
    assert.deepEqual(report.failures, [], `${report.failures.join('\n')}\ntrace:\n${trace}`);
  });
}

test('conservative rule coverage', (t) => {
  const rows = Object.entries(CONSERVATIVE_RULES).map(([code, rule]) =>
    `${loggedCodes.has(code) ? 'covered  ' : 'uncovered'} ${code}${rule.question ? ` (${rule.question})` : ''}`);
  t.diagnostic(`\n${rows.join('\n')}`);
  // Каждое консервативное правило должно срабатывать хотя бы в одном сценарии
  const uncovered = Object.keys(CONSERVATIVE_RULES).filter((c) => !loggedCodes.has(c));
  assert.deepEqual(uncovered, [], `conservative rules without a scenario: ${uncovered.join(', ')}`);
});
