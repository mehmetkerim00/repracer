import assert from 'node:assert/strict';
import { test } from 'node:test';
// @ts-expect-error — сценарий на JavaScript без объявлений типов
import { coverage } from '../db/check-catalog-coverage.mjs';

// Р-108: проверка «новая защита в каталоге» на синтетическом наборе — без базы
const protections = [
  { kind: 'trigger', table: 'tenant_data.t', name: 'a00_old_guard', fn: 'tenant_data.old_guard' },
  { kind: 'trigger', table: 'tenant_data.t', name: 'a00_new_guard', fn: 'tenant_data.new_guard' },
  { kind: 'trigger', table: 'tenant_data.t', name: 'b_body_mutated', fn: 'tenant_data.body_mutated' },
  { kind: 'check', table: 'tenant_data.t', name: 't_new_check', fn: null },
  { kind: 'check', table: 'tenant_data.t', name: 't_catalogued_check', fn: null },
];
const catalogText = `m(dropConstraint('t_catalogued_check', 'tenant_data.t'))\nm(replaceInFunction('tenant_data.body_mutated()', 'IF x', 'IF false'))`;

test('a new trigger or check without a catalog row is reported; the baseline, a quoted name and a mutated trigger function are not', () => {
  const { missing, resolved } = coverage({ protections, catalogText, baseline: ['trigger tenant_data.t a00_old_guard', 'check tenant_data.t t_gone'] });
  assert.deepEqual(missing, ['check tenant_data.t t_new_check', 'trigger tenant_data.t a00_new_guard']);
  assert.deepEqual(resolved, ['check tenant_data.t t_gone'], 'a baseline entry that is gone is reported, not silently kept');
});

test('a name mentioned without quotes (for example inside DISABLE TRIGGER text) does not count as a catalog row', () => {
  const { missing } = coverage({ protections: [{ kind: 'trigger', table: 'tenant_data.t', name: 'zz_append_only', fn: 'security.forbid_mutation' }],
    catalogText: "m('ALTER TABLE tenant_data.x DISABLE TRIGGER zz_append_only')", baseline: [] });
  assert.deepEqual(missing, ['trigger tenant_data.t zz_append_only']);
});
