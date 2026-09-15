import assert from 'node:assert/strict';
import { test } from 'node:test';
import { completedWriteRow, intentClassOf, priceDecisionRow, priceIntentNoopRow, priceIntentRow } from '../src/index.ts';

const T = '10000000-0000-4000-8000-000000000001';
const at = new Date('2026-09-14T10:00:00.000Z');

test('OQ-98, Р-61: a rejected decision carries its reason parameters, checks and the exchange rate into ClickHouse', () => {
  const row = priceDecisionRow({
    tenant_id: T, price_decision_id: 'd1', intent_created_at: at, price_intent_id: 'i1', write_scope_id: 'ws1', decided_at: at, outcome: 'REJECTED',
    intent_class: 'REJECTED_BY_GATE', rejection_reason: 'BELOW_MARGIN_FLOOR', reason_params: { proposedMinor: 1500, floorMinor: 1779 },
    final_amount_minor: null, currency: 'USD', price_basis: 'NET', effective_floor_minor: '1779', effective_ceiling_minor: '5000',
    min_price_ids: ['m1'], max_price_ids: ['x1'], guardrail_ids: ['g1'], cost_profile_id: 'cp1', fee_inputs: { unitCostMinor: 1156, feeRateBp: 1500 },
    fx: { source: 'ECB', rateDate: '2026-09-14', base: 'EUR', quote: 'USD', rateMicros: 1155100, from: 'EUR', to: 'USD', sourceAmountMinor: 1000, convertedAmountMinor: 1156 },
    violations: ['MARGIN_FLOOR'], checks: [{ check: 'MARGIN_FLOOR', passed: false, detail: { code: 'BELOW_MARGIN_FLOOR' } }],
  });
  assert.equal(row.reason_code, 'BELOW_MARGIN_FLOOR');
  assert.deepEqual(JSON.parse(row.reason_params), { proposedMinor: 1500, floorMinor: 1779 });
  assert.equal(row.effective_floor_minor, 1779);
  assert.equal(row.fx_rate_date, '2026-09-14');
  assert.equal(row.fx_from, 'EUR');
  assert.equal(JSON.parse(row.fx).rateMicros, 1155100);
  assert.equal(JSON.parse(row.checks)[0].check, 'MARGIN_FLOOR');
  assert.equal(row.decided_at, '2026-09-14T10:00:00.000Z');
});

test('Р-27: intent classes split — CHANGED keeps inputs and reason, NO_OP collapses into one row with the decision outcome', () => {
  const intent = {
    tenant_id: T, price_intent_id: 'i1', created_at: at, write_scope_id: 'ws1', pricing_strategy_id: 's1', pricing_strategy_version: 3, trigger_type: 'COMPETITOR_CHANGE',
    rule_code: 'MATCH_BUYBOX', source_event_id: null, competitor_snapshot_id: null, proposed_amount_minor: '1775', reference_amount_minor: '1780', currency: 'EUR',
    price_basis: 'GROSS', inputs: { boundsAtStrategy: { minMinor: 1500, maxMinor: 2500 } }, expires_at: at,
    rationale: { intentClass: 'CHANGED', reason: { code: 'BUYBOX_UNDERCUT', params: { buyboxMinor: 1780, undercutMinor: 5 } } },
  };
  assert.equal(intentClassOf(intent, { intent_class: 'CHANGED' }), 'CHANGED');
  const kept = priceIntentRow(intent, 'CHANGED');
  assert.equal(kept.reason_code, 'BUYBOX_UNDERCUT');
  assert.equal(kept.proposed_amount_minor, 1775);
  const noop = priceIntentNoopRow({ ...intent, rationale: { intentClass: 'NO_OP', reason: { code: 'WITHIN_DEADBAND' } } }, { outcome: 'NO_CHANGE', no_change_reason: 'ALREADY_WINNING_BUYBOX' });
  assert.deepEqual(Object.keys(noop).sort(), ['created_at', 'currency', 'decision_outcome', 'no_change_reason', 'price_basis', 'price_intent_id', 'proposed_amount_minor', 'reference_amount_minor', 'rule_code', 'tenant_id', 'trigger_type', 'write_scope_id']);
  assert.equal(noop.decision_outcome, 'NO_CHANGE');
  // Р-81: код причины — из решения; без решения — из intent; без кода строка не выгружается
  assert.equal(noop.no_change_reason, 'ALREADY_WINNING_BUYBOX');
  assert.equal(priceIntentNoopRow({ ...intent, rationale: { intentClass: 'NO_OP', reason: { code: 'WITHIN_DEADBAND' } } }, undefined).no_change_reason, 'WITHIN_DEADBAND');
  assert.throws(() => priceIntentNoopRow({ ...intent, rationale: { intentClass: 'NO_OP' } }, { outcome: 'NO_CHANGE' }), /Р-81/);
  assert.throws(() => intentClassOf({ ...intent, rationale: {} }, undefined), /unknown intent class/);
});

test('Р-64: a superseded write keeps its end reason and the newer write it lost to', () => {
  const row = completedWriteRow({
    tenant_id: T, channel_write_id: 'w2', finished_at: at, write_scope_id: 'ws1', field: 'PRICE', amount_minor: '1755', currency: 'EUR', price_basis: 'GROSS',
    quantity: null, version: '2', origin: 'PRICE_DECISION', price_decision_id: 'd2', direction: null, final_status: 'SUPERSEDED',
    end_reason: 'WRITE_SUPERSEDED_BY_NEWER_VERSION', end_params: { newerVersion: 3, newerWriteId: 'w3' }, superseded_by_write_id: 'w3', last_error_code: null,
    attempt_count: 0, budget_scope_key: null, budget_day: null, floor_at_dispatch_minor: null, trigger_received_at: at, created_at: at,
    dispatched_at: null, accepted_at: null, applied_at: null,
  });
  assert.equal(row.end_reason, 'WRITE_SUPERSEDED_BY_NEWER_VERSION');
  assert.equal(row.superseded_by_write_id, 'w3');
  assert.deepEqual(JSON.parse(row.end_params), { newerVersion: 3, newerWriteId: 'w3' });
  assert.equal(row.version, 2);
});
