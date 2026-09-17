import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { CLICKHOUSE_SNAPSHOT_SOURCES, snapshotLogRow } from '../src/index.ts';

/**
 * Шаг 24 [Р-122]: строка журнала снимков PostgreSQL (0086) → строка ClickHouse; снимок, который ограничения ClickHouse отклонили бы,
 * пропускается с причиной, а не срывает выгрузку суток. Данные синтетические.
 */
const money = (amountMinor: number, currency = 'EUR') => ({ amountMinor, currency, basis: 'GROSS' as const });
const logRow = (snapshot: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
  tenant_id: '10000000-0000-4000-8000-000000002401', competitor_snapshot_id: '30000000-0000-4000-8000-000000002401', received_at: new Date('2026-09-17T10:00:00.000Z'),
  observed_at: new Date('2026-09-17T09:59:58.000Z'), channel_account_id: '20000000-0000-4000-8000-000000002401', channel: 'KAUFLAND', marketplace: 'de',
  channel_product_ref: '362002401', condition: 'new', source: snapshot.source, source_event_id: null, sanity_verdict: 'REJECT', snapshot, ...over,
});
const snapshot = (over: Record<string, unknown> = {}) => ({
  marketplace: 'de', channelProductRef: '362002401', condition: 'new', source: 'KAUFLAND_BUY_BOX_CHANGED', observedAt: '2026-09-17T09:59:58.000Z',
  completeness: { kind: 'TOP_N', n: 10 }, buybox: { price: money(1780), isSelf: false },
  offers: [{ rank: 1, sellerRef: 'Synthetic Competitor', isSelf: false, price: money(1780), deliveryDays: { min: 1, max: 2 } }], ...over,
});

test('step 24: a logged snapshot keeps its sanity verdict in ClickHouse; rows ClickHouse would refuse are skipped with a reason', () => {
  const ok = snapshotLogRow(logRow(snapshot()));
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.ok && [ok.row.sanity_verdict, ok.row.buybox_amount_minor, ok.row.received_at, ok.row.channel], ['REJECT', 1780, '2026-09-17T10:00:00.000Z', 'KAUFLAND']);
  assert.deepEqual(snapshotLogRow(logRow(snapshot({ buybox: undefined, offers: [] }))), { ok: false, reason: 'NO_PRICES' });
  assert.deepEqual(snapshotLogRow(logRow(snapshot({ buybox: { price: money(1780, 'GBP'), isSelf: false } }))), { ok: false, reason: 'CURRENCY_UNSUPPORTED' });
  assert.deepEqual(snapshotLogRow(logRow(snapshot({ source: 'SYN_UNKNOWN' }))), { ok: false, reason: 'SOURCE_UNKNOWN' });
  assert.deepEqual(snapshotLogRow(logRow(snapshot(), { channel: 'EBAY' })), { ok: false, reason: 'CHANNEL_UNSUPPORTED' });
});

test('step 24: the sources the writer accepts equal the source_known constraint of the ClickHouse table', () => {
  const dir = new URL('../../../schemas/clickhouse/', import.meta.url);
  let latest: string[] | null = null;
  for (const file of readdirSync(dir).filter((f) => /^\d{3}_.*\.sql$/.test(f)).sort()) {
    const sql = readFileSync(new URL(file, dir), 'utf8');
    for (const m of sql.matchAll(/CONSTRAINT (?:IF NOT EXISTS )?source_known\s+CHECK source IN \(([^)]*)\)/g)) latest = [...m[1]!.matchAll(/'([A-Z_]+)'/g)].map((x) => x[1]!);
  }
  assert.deepEqual([...(latest ?? [])].sort(), [...CLICKHOUSE_SNAPSHOT_SOURCES].sort());
});

test('step 24: the daily export job exports the closed UTC day', async () => {
  const { previousUtcDay } = await import('../src/index.ts');
  assert.deepEqual(previousUtcDay(new Date('2026-09-17T00:30:00.000Z')), { from: '2026-09-16T00:00:00.000Z', to: '2026-09-17T00:00:00.000Z' });
});
