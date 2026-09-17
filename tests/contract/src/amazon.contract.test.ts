import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { AMAZON_CONSERVATIVE_RULES } from '@repracer/amazon-adapter';
import { amazonUnderTest } from './adapters.ts';
import { AMAZON_FIXTURES_DIR, buildAmazonScenarios } from './amazon-fixtures/index.ts';
import { runScenario } from './harness/runner.ts';
import { loadScenarios } from './harness/scenario.ts';

/**
 * Контрактный стенд Amazon (шаг 22): те же обязательные сценарии, что у Kaufland, плюс асинхронное применение, «принято, но не
 * применено» и собственное ценообразование канала [Р-114, Р-115]. Фикстуры — результат построителя src/amazon-fixtures.
 */
const loaded = loadScenarios(fileURLToPath(AMAZON_FIXTURES_DIR));
const logged = new Set<string>();

/** Обязательные сценарии Kaufland (kaufland.contract.test.ts) и сценарии асинхронной записи Amazon */
const MANDATORY = [
  'bulk-207-partial', '429', 'timeout-unknown-outcome', 'webhook-duplicate', 'webhook-bad-signature', 'stale-version', 'budget-exhausted',
  'pipeline-x100-high', 'pipeline-x100-low', 'pipeline-mass-shift', 'pipeline-above-max', 'pipeline-max-missing', 'pipeline-bound-unresolvable',
  'pipeline-oq90-trap', 'pipeline-cold-start', 'pipeline-halt-auto-release', 'pipeline-halt-manual-release', 'pipeline-bounds-version',
  'pipeline-tax-regimes', 'pipeline-write-queue', 'pipeline-write-superseded', 'pipeline-fx-usd-floor', 'pipeline-fx-ean-anchor',
  'async-apply', 'accepted-not-applied', 'channel-repricer', 'channel-repricer-pipeline', 'price-basis-readback',
];

/** Правила, недостижимые на витринах Release 1.0, — с причиной */
const UNREACHABLE: Readonly<Record<string, string>> = {
  AMZ_C06_MULTI_MARKETPLACE_ISSUES: 'в регионе EU одна витрина Release 1.0 (amazon.de, Р-56): отправки на несколько витрин не бывает',
};

test('Amazon fixtures are exactly what the builder produces', () => {
  const built = buildAmazonScenarios();
  assert.deepEqual(loaded.map((l) => l.file), built.map((b) => b.file));
  for (const b of built) assert.deepEqual(loaded.find((l) => l.file === b.file)!.scenario, JSON.parse(JSON.stringify(b.scenario)), `${b.file}: run npm run fixtures:amazon`);
});

test('all mandatory Amazon scenarios are present', () => {
  for (const name of MANDATORY) assert.ok(loaded.some(({ scenario }) => scenario.tags.includes(`mandatory:${name}`)), `missing mandatory scenario ${name}`);
});

for (const { file, scenario } of loaded) {
  test(`${scenario.id} — ${scenario.title} [${file}]`, async () => {
    const report = await runScenario(scenario, amazonUnderTest);
    for (const entry of report.logs) logged.add(entry.code);
    const trace = report.trace.map((t) => `  ${t.method} ${t.path} → ${t.exchangeId ?? '-'} ${t.outcome}`).join('\n');
    assert.deepEqual(report.failures, [], `${report.failures.join('\n')}\ntrace:\n${trace}`);
  });
}

test('Amazon conservative rule coverage', (t) => {
  const rows = Object.entries(AMAZON_CONSERVATIVE_RULES).map(([code, rule]) => `${logged.has(code) ? 'covered    ' : UNREACHABLE[code] ? 'unreachable' : 'uncovered  '} ${code}${rule.question ? ` (${rule.question})` : ''}`);
  t.diagnostic(`\n${rows.join('\n')}`);
  const uncovered = Object.keys(AMAZON_CONSERVATIVE_RULES).filter((c) => !logged.has(c) && !UNREACHABLE[c]);
  assert.deepEqual(uncovered, []);
  for (const code of Object.keys(UNREACHABLE)) assert.ok(!logged.has(code), `${code} is reachable now: remove it from UNREACHABLE`);
});
