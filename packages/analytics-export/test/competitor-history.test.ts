import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CompetitorSnapshot } from '@repracer/channel-port';
import { assertBacktestWindow, competitorSnapshotFromRow, competitorSnapshotRow } from '../src/index.ts';

/** Р-38: окно бэктеста и разбор строки competitor_snapshot. Данные синтетические. */
const NOW = '2026-09-17T12:00:00.000Z';

test('Р-38: the backtest window is at most 18 months and inside the channel data retention', () => {
  assertBacktestWindow({ from: '2025-03-17T12:00:00.000Z', to: NOW }, NOW);
  assert.throws(() => assertBacktestWindow({ from: '2025-03-17T11:59:59.999Z', to: NOW }, NOW), /longer than 18 months/);
  assert.throws(() => assertBacktestWindow({ from: '2025-01-01T00:00:00.000Z', to: '2026-01-01T00:00:00.000Z' }, NOW), /earlier than 18 months ago/);
  assert.throws(() => assertBacktestWindow({ from: '2026-09-01T00:00:00.000Z', to: '2026-09-18T00:00:00.000Z' }, NOW), /future/);
  assert.throws(() => assertBacktestWindow({ from: NOW, to: NOW }, NOW), /from < to/);
});

test('a competitor snapshot survives the ClickHouse row round trip; a snapshot without prices is not written with a default currency', () => {
  const snapshot: CompetitorSnapshot = {
    marketplace: 'de', channelProductRef: '362000001', condition: 'new', source: 'KAUFLAND_BUY_BOX_CHANGED', sourceEventId: 'm1',
    observedAt: '2026-09-14T10:00:00.000Z', completeness: { kind: 'TOP_N', n: 10 },
    buybox: { price: { amountMinor: 1780, currency: 'EUR', basis: 'GROSS' }, isSelf: false },
    offers: [
      { rank: 1, sellerRef: 'Synthetic Competitor', isSelf: false, price: { amountMinor: 1780, currency: 'EUR', basis: 'GROSS' }, shipping: { amountMinor: 0, currency: 'EUR', basis: 'GROSS' }, totalPrice: { amountMinor: 1780, currency: 'EUR', basis: 'GROSS' }, deliveryDays: { min: 1, max: 2 } },
      { rank: 2, isSelf: true, price: { amountMinor: 1850, currency: 'EUR', basis: 'GROSS' }, shipping: { amountMinor: 0, currency: 'EUR', basis: 'GROSS' }, totalPrice: { amountMinor: 1850, currency: 'EUR', basis: 'GROSS' }, deliveryDays: { min: null, max: null } },
    ],
  };
  const row = competitorSnapshotRow('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 'KAUFLAND', '30000000-0000-4000-8000-000000000001', snapshot, NOW);
  assert.equal(row.data_class, 'CHANNEL_INFO');
  // Строка хранит состояние у каждого предложения (offers.condition): без явного значения — состояние снимка
  assert.deepEqual(competitorSnapshotFromRow({ ...row, observed_at: '2026-09-14 10:00:00.000' }), { ...snapshot, offers: snapshot.offers.map((o) => ({ ...o, condition: 'new' })) });
  assert.throws(() => competitorSnapshotRow('t', 'a', 'KAUFLAND', 's', { ...snapshot, buybox: undefined, offers: [] } as unknown as CompetitorSnapshot, NOW), /no currency/);
});
