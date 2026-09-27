import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { ChannelAdapter, SupportsListingMigration } from '@repracer/channel-port';
import { EBAY_CONSERVATIVE_RULES } from '@repracer/ebay-adapter';
import { ebayUnderTest } from './adapters.ts';
import { buildEbayScenarios, EBAY_FIXTURES_DIR } from './ebay-fixtures/index.ts';
import { runScenario } from './harness/runner.ts';
import { loadScenarios, validateScenario, type Scenario } from './harness/scenario.ts';

/**
 * Контрактный стенд eBay (шаг 39) [Р-162…Р-164]: сценарии порта на обменах, записанных в песочнице eBay и обезличенных
 * (provenance RECONSTRUCTED_FROM_SANDBOX, у каждого обмена — origin SANDBOX или SYNTHETIC), и синтетические там, где ответа песочницы нет.
 * Шаг 47: путь решения о цене для eBay (сценарии pipeline-*, ebay-fixtures/pipeline.ts) — здесь на хранилище в памяти, в
 * ebay.pipeline.pg.test.ts — на PostgreSQL.
 */
const loaded = loadScenarios(fileURLToPath(EBAY_FIXTURES_DIR));
const logged = new Set<string>();

/** Обязательные сценарии Kaufland и Amazon, применимые к порту eBay, и сценарии шага 39 */
const MANDATORY = [
  'bulk-207-partial', '429', 'timeout-unknown-outcome', 'stale-version', 'budget-exhausted',
  'unmigrated-write-rejected', 'migration-without-consent', 'migration-with-consent', 'auction-ineligible', 'quantity-zero', 'currency-mismatch',
  'batch-split-25', 'price-below-minimum', 'request-level-400', 'readback-browse-divergence', 'browse-vat-on-top', 'inbound-unsupported',
  // Шаг 47: путь решения — обязательные сценарии Kaufland и Amazon, применимые к каналу без данных конкурентов (Р-39), и сценарии eBay
  'pipeline-write-confirmed', 'pipeline-below-floor', 'pipeline-above-max', 'pipeline-tax-regimes', 'pipeline-max-missing', 'pipeline-kill-switch',
  'pipeline-halt-manual-release', 'pipeline-write-queue', 'pipeline-timeout-unknown-outcome', 'pipeline-budget-exhausted', 'pipeline-unmigrated-write',
  'pipeline-price-basis-r186', 'discovery-legacy-auction', 'orders-whitelist', 'orders-shipment-before-window', 'pipeline-discovery-catalog',
];

test('eBay fixtures are exactly what the builder produces', () => {
  const built = buildEbayScenarios();
  assert.deepEqual(loaded.map((l) => l.file), built.map((b) => b.file));
  for (const b of built) assert.deepEqual(loaded.find((l) => l.file === b.file)!.scenario, JSON.parse(JSON.stringify(b.scenario)), `${b.file}: run npm run fixtures:ebay`);
});

test('all mandatory eBay scenarios are present', () => {
  for (const name of MANDATORY) assert.ok(loaded.some(({ scenario }) => scenario.tags.includes(`mandatory:${name}`)), `missing mandatory scenario ${name}`);
});

test('Р-162: every eBay scenario says where its exchanges come from — reviewed sandbox reconstruction with per-exchange origin, or synthetic', () => {
  for (const { file, scenario } of loaded) {
    const p = scenario.provenance;
    if (p.kind === 'RECONSTRUCTED_FROM_SANDBOX') {
      assert.equal(p.evidence, 'docs/evidence/step39-ebay-sandbox.md', file);
      assert.ok(p.reviewedBy, `${file}: not reviewed`);
      assert.ok(scenario.exchanges.every((e) => e.origin === 'SANDBOX' || e.origin === 'SYNTHETIC'), `${file}: exchange without origin`);
    } else {
      assert.ok(p.kind === 'SYNTHETIC_FROM_DOCS' && p.sources.length > 0, file);
    }
  }
});

test('the validator refuses a sandbox reconstruction without review, without an exchange origin, or with no SANDBOX exchange — each by its reason', () => {
  const base = loaded.find((l) => l.scenario.provenance.kind === 'RECONSTRUCTED_FROM_SANDBOX')!.scenario;
  assert.deepEqual(validateScenario(base), []);
  const unreviewed = { ...base, provenance: { ...base.provenance, reviewedBy: null } } as Scenario;
  assert.deepEqual(validateScenario(unreviewed), ['sandbox reconstruction has not been reviewed (provenance.reviewedBy is empty)']);
  const noOrigin = { ...base, exchanges: base.exchanges.map((e, i) => (i === 0 ? { ...e, origin: undefined } : e)) } as Scenario;
  assert.deepEqual(validateScenario(noOrigin), [`exchange ${base.exchanges[0]!.id}: origin must be SANDBOX or SYNTHETIC in a sandbox reconstruction`]);
  const allSynthetic = { ...base, exchanges: base.exchanges.map((e) => ({ ...e, origin: 'SYNTHETIC' as const })) } as Scenario;
  assert.deepEqual(validateScenario(allSynthetic), ['a sandbox reconstruction without a single SANDBOX exchange is synthetic']);
});

test('Р-164: migration without a consent proof does not compile, and no scenario migrates without one', () => {
  // Настоящая проверка — tsc (typecheck CI): без @ts-expect-error эти строки не компилируются. В рантайме функция не вызывается
  const adapter = null as unknown as ChannelAdapter & SupportsListingMigration;
  const typeOnly = (): unknown => [
    // @ts-expect-error — listing ids are not MigrationConsentProof: the type makes migration without consent impossible
    adapter.migrate(null as never, ['110000000021']),
    // @ts-expect-error — a proof must carry offerMappingStatus MIGRATION_STARTED
    adapter.migrate(null as never, [{ migrationConsentId: 'mc', listingId: '110000000021', listingSnapshotSha256: 'x', offerMappingStatus: 'READY' }]),
  ];
  void typeOnly;
  for (const { file, scenario } of loaded) {
    const migrates = scenario.exchanges.some((e) => e.request.path.endsWith('/bulk_migrate_listing'));
    const withProof = scenario.steps.some((s) => s.kind === 'call' && s.method === 'migrate');
    assert.equal(migrates, withProof, `${file}: bulk_migrate_listing only follows migrate(proofs)`);
  }
});

for (const { file, scenario } of loaded) {
  test(`${scenario.id} — ${scenario.title} [${file}]`, async () => {
    const report = await runScenario(scenario, ebayUnderTest);
    for (const entry of report.logs) logged.add(entry.code);
    const trace = report.trace.map((t) => `  ${t.method} ${t.path} → ${t.exchangeId ?? '-'} ${t.outcome}`).join('\n');
    assert.deepEqual(report.failures, [], `${report.failures.join('\n')}\ntrace:\n${trace}`);
  });
}

test('eBay conservative rule coverage', (t) => {
  const rows = Object.entries(EBAY_CONSERVATIVE_RULES).map(([code, rule]) => `${logged.has(code) ? 'covered  ' : 'uncovered'} ${code}${rule.question ? ` (${rule.question})` : ''}`);
  t.diagnostic(`\n${rows.join('\n')}`);
  assert.deepEqual(Object.keys(EBAY_CONSERVATIVE_RULES).filter((c) => !logged.has(c)), []);
});
