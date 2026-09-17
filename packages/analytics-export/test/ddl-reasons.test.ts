import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { GATE_REASON_CODES } from '@repracer/pricing-model';

/**
 * Шаг 23: причина отклонения, которой нет в ограничении ClickHouse, ломает выгрузку дня целиком (CI шага 23: CHANNEL_DISTRUSTED;
 * PRICING_STOPPED не было с шага 12). Действует последнее определение `rejection_reason_known` по порядку файлов DDL.
 */
test('step 23: the ClickHouse list of rejection reasons equals the Gate reasons of the code', () => {
  const dir = new URL('../../../schemas/clickhouse/', import.meta.url);
  let latest: string[] | null = null;
  for (const file of readdirSync(dir).filter((f) => /^\d{3}_.*\.sql$/.test(f)).sort()) {
    const sql = readFileSync(new URL(file, dir), 'utf8');
    for (const m of sql.matchAll(/CONSTRAINT (?:IF NOT EXISTS )?rejection_reason_known CHECK rejection_reason IS NULL OR rejection_reason IN \(([^)]*)\)/g)) {
      latest = [...m[1]!.matchAll(/'([A-Z_]+)'/g)].map((x) => x[1]!);
    }
  }
  assert.ok(latest, 'rejection_reason_known is defined');
  assert.deepEqual([...latest].sort(), GATE_REASON_CODES.filter((c) => c !== 'APPROVED' && c !== 'NO_CHANGE').sort());
});
