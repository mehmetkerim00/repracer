import assert from 'node:assert/strict';
import { test } from 'node:test';
import { archiveKey, buildCoreArchiveBundle, decodeBundle, encodeBundle, verifyCoreArchiveBundle } from '../src/archive.ts';

/** Р-79: архив ядра объясняет себя сам — без базы, после закрытия тенанта. Данные синтетические */

const T = '10000000-0000-4000-8000-000000000079';
const OTHER = '20000000-0000-4000-8000-000000000079';
const S1 = '30000000-0000-4000-8000-000000000001';

const explanation = {
  format: 'r80.1', snapshot: { source: 'KAUFLAND_BUYBOX' },
  sanity: { checks: [{ rule: 'INTERNAL_ANCHOR', outcome: 'SKIPPED', detail: { code: 'TOO_FEW_COMPETITOR_OFFERS' } }], anchorsUsed: ['COST'] },
  strategy: { currentMinor: 1850, boundsAtStrategy: { minMinor: 1500, maxMinor: 2500, currency: 'EUR' }, currency: 'EUR', reason: { code: 'BUYBOX_UNDERCUT', params: { undercutMinor: 5, targetMinor: 1775, currency: 'EUR' } } },
};
const core = (i: number, over: Record<string, unknown> = {}) => ({
  tenant_id: T, price_intent_id: `40000000-0000-4000-8000-00000000000${i}`, intent_created_at: '2026-09-14T10:00:00.000Z', pricing_strategy_id: S1, pricing_strategy_version: 2,
  trigger_type: 'COMPETITOR_CHANGE', rule_code: 'MATCH_BUYBOX', proposed_amount_minor: '1775', currency: 'EUR', decision_outcome: 'APPROVED', rejection_reason: null,
  reason_params: { finalMinor: 1775, currency: 'EUR' }, effective_floor_minor: '1500', effective_ceiling_minor: '2500', bound_deviation_bp: null,
  gate_profile: 'g74.1', sanity_ruleset: 'r49.1', explanation, ...over,
});
// Р-91: в вечной версии стратегии подреза нет — он живёт 18 месяцев в channel_data.pricing_strategy_undercut
const strategy = (version: number) => ({ tenant_id: T, pricing_strategy_id: S1, version, params: { type: 'MATCH_BUYBOX', holdWhenWinning: true, atBound: 'CAP', deadbandMinor: 0 } });
/** Версия стратегии, выгруженная до 0059: подрез в параметрах (OQ-150) */
const strategyWithUndercut = (version: number) => ({ ...strategy(version), params: { ...strategy(version).params, undercutMinor: 5 } });
const rulesets = [
  { ruleset_id: 'r49.1', kind: 'SANITY', definition: { rules: ['STRUCTURE', 'INTERNAL_ANCHOR'], config: { TOO_FEW_COMPETITOR_OFFERS: { minOffers: 3 } } } },
  { ruleset_id: 'g74.1', kind: 'GATE', definition: { CHANGED: ['PRICE_STOP', 'LOWER_BOUND'], NO_OP: ['PRICE_STOP'] } },
  { ruleset_id: 'g99.9', kind: 'GATE', definition: { CHANGED: [], NO_OP: [] } },
];

test('Р-79: the core archive carries exactly the strategy versions and rulesets its explanations refer to and expands without the database', () => {
  const bundle = buildCoreArchiveBundle({ tenantId: T, partitionName: 'tenant_data.price_intent_core_y2026m09', core: [core(1), core(2)], strategies: [strategy(1), strategy(2)], rulesets });
  assert.deepEqual(bundle.dictionary.strategies.map((s) => s.version), [2], 'only the referenced version');
  assert.deepEqual(bundle.dictionary.rulesets.map((r) => r.ruleset_id), ['r49.1', 'g74.1']);
  const read = decodeBundle(encodeBundle(bundle));
  assert.deepEqual(verifyCoreArchiveBundle(read), { rows: 2, selfContained: true, gaps: [] });
  assert.equal(archiveKey(T, 'tenant_data.price_intent_core', 'tenant_data.price_intent_core_y2026m09'), `tenant=${T}/tenant_data.price_intent_core/price_intent_core_y2026m09.json.gz`);
});

test('Р-79: an archive without the strategy version is not self-contained and says which row; rows of another tenant are refused (Р-23)', () => {
  const missing = buildCoreArchiveBundle({ tenantId: T, partitionName: 'p', core: [core(1)], strategies: [strategy(1)], rulesets });
  const check = verifyCoreArchiveBundle(missing);
  assert.equal(check.selfContained, false);
  assert.deepEqual(check.gaps, [{ priceIntentId: core(1).price_intent_id, gaps: [{ kind: 'STRATEGY', ref: `${S1}@2` }] }]);
  assert.throws(() => buildCoreArchiveBundle({ tenantId: T, partitionName: 'p', core: [core(1), core(2, { tenant_id: OTHER })], strategies: [], rulesets }), /Р-23/);
  assert.throws(() => archiveKey('all-tenants', 'tenant_data.price_intent_core', 'p'), /tenant UUID/);
});

test('OQ-150, Р-91: a strategy version carrying the undercut is neither archived nor accepted from an archive read back', () => {
  const withUndercut = strategyWithUndercut(2);
  assert.throws(() => buildCoreArchiveBundle({ tenantId: T, partitionName: 'tenant_data.price_intent_core_y2026m09', core: [core(1)], strategies: [withUndercut], rulesets }),
    /carries the undercut/, 'the exporter refuses to archive the undercut');
  const clean = strategy(2);
  const bundle = buildCoreArchiveBundle({ tenantId: T, partitionName: 'tenant_data.price_intent_core_y2026m09', core: [core(1)], strategies: [clean], rulesets });
  assert.equal(verifyCoreArchiveBundle(bundle).rows, 1);
  // Архив, выгруженный до 0059 (OQ-150): проверка при чтении обратно его распознаёт
  assert.throws(() => verifyCoreArchiveBundle({ ...bundle, dictionary: { ...bundle.dictionary, strategies: [withUndercut] } }), /carries the undercut/);
});

