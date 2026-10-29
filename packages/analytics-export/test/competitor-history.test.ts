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
    // Шаг 97: так снимок отдаёт адаптер Kaufland — держатель назван у предложения ранга 1, у Buy Box — его доставка и продавец
    buybox: { price: { amountMinor: 1780, currency: 'EUR', basis: 'GROSS' }, isSelf: false, shipping: { amountMinor: 0, currency: 'EUR', basis: 'GROSS' }, sellerRef: 'Synthetic Competitor' },
    offers: [
      { rank: 1, sellerRef: 'Synthetic Competitor', isSelf: false, price: { amountMinor: 1780, currency: 'EUR', basis: 'GROSS' }, shipping: { amountMinor: 0, currency: 'EUR', basis: 'GROSS' }, totalPrice: { amountMinor: 1780, currency: 'EUR', basis: 'GROSS' }, deliveryDays: { min: 1, max: 2 }, holdsBuyBox: true },
      { rank: 2, isSelf: true, price: { amountMinor: 1850, currency: 'EUR', basis: 'GROSS' }, shipping: { amountMinor: 0, currency: 'EUR', basis: 'GROSS' }, totalPrice: { amountMinor: 1850, currency: 'EUR', basis: 'GROSS' }, deliveryDays: { min: null, max: null } },
    ],
  };
  const row = competitorSnapshotRow('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 'KAUFLAND', '30000000-0000-4000-8000-000000000001', snapshot, NOW);
  assert.equal(row.data_class, 'CHANNEL_INFO');
  // Находка 2 ревью шага 21: доставка Buy Box пишется из предложения-победителя, а не null
  const shipped = { ...snapshot, buybox: { ...snapshot.buybox!, shipping: undefined }, offers: snapshot.offers.map((o) => (o.rank === 1 ? { ...o, shipping: { ...o.shipping!, amountMinor: 450 }, totalPrice: { ...o.totalPrice!, amountMinor: 2230 } } : o)) };
  assert.equal(competitorSnapshotRow('t', 'a', 'KAUFLAND', 's', shipped as CompetitorSnapshot, NOW).buybox_shipping_minor, 450);
  // Шаг 97 (097): доставка, которую канал не назвал, — null, а не 0; держатель не назван (Amazon, A-29) — доставки Buy Box нет
  const unknown = { ...snapshot, buybox: { price: snapshot.buybox!.price, isSelf: null }, offers: snapshot.offers.map(({ shipping: _s, totalPrice: _t, holdsBuyBox: _h, ...o }) => o) };
  const unknownRow = competitorSnapshotRow('t', 'a', 'AMAZON', 's', unknown as CompetitorSnapshot, NOW);
  assert.deepEqual(unknownRow['offers.shipping_minor'], [null, null], 'unknown shipping is not written as zero');
  assert.equal(unknownRow.buybox_shipping_minor, null);
  assert.deepEqual(unknownRow['offers.holds_buybox'], [null, null], 'the holder is not named');
  const rated = { ...snapshot, offers: snapshot.offers.map((o, i) => (i === 0 ? { ...o, rating: { positivePct: 97, count: 1200 } } : o)) };
  const ratedRow = competitorSnapshotRow('t', 'a', 'AMAZON', 's', rated, NOW);
  assert.deepEqual([ratedRow['offers.feedback_pct'], ratedRow['offers.feedback_count']], [[97, null], [1200, null]], 'the rating the channel gave reaches the row');
  assert.deepEqual(competitorSnapshotFromRow({ ...ratedRow, observed_at: '2026-09-14 10:00:00.000' }).offers[0]!.rating, { positivePct: 97, count: 1200 });
  // Строка хранит состояние у каждого предложения (offers.condition): без явного значения — состояние снимка
  assert.deepEqual(competitorSnapshotFromRow({ ...row, observed_at: '2026-09-14 10:00:00.000' }), { ...snapshot, offers: snapshot.offers.map((o) => ({ ...o, condition: 'new' })) });
  assert.throws(() => competitorSnapshotRow('t', 'a', 'KAUFLAND', 's', { ...snapshot, buybox: undefined, offers: [] } as unknown as CompetitorSnapshot, NOW), /no currency/);
});

/**
 * Шаг 109 [Р-234, Р-235, Р-122]: снимок сверки Amazon с купонами и группами покупателей Buy Box переживает круг через строку ClickHouse — история
 * (18 месяцев) хранит обе цены и доли просмотров, а не теряет их при выгрузке. Купона нет — NULL, а не цена; групп нет — пусто
 */
test('step 109: the coupon price and the Buy Box customer groups survive the ClickHouse row round trip', () => {
  const usd = (amountMinor: number) => ({ amountMinor, currency: 'USD', basis: 'NET' as const });
  const snapshot: CompetitorSnapshot = {
    marketplace: 'ATVPDKIKX0DER', channelProductRef: 'B0SYN00109', condition: 'new', source: 'AMAZON_COMPETITIVE_SUMMARY',
    observedAt: '2026-10-29T10:00:00.000Z', completeness: { kind: 'TOP_N', n: 2 },
    offers: [
      { sellerRef: 'A2ZWOLFOFDPJL1', isSelf: false, price: usd(1715), shipping: usd(250), totalPrice: usd(1965), couponPrice: usd(1629), condition: 'new', fulfillment: 'MFN', deliveryDays: { min: null, max: null } },
      { sellerRef: 'A3DJR8M9Y3OUPG', isSelf: false, price: usd(1811), shipping: usd(250), totalPrice: usd(2061), condition: 'new', fulfillment: 'MFN', deliveryDays: { min: null, max: null } },
    ],
    buyboxSegments: [
      { sellerRef: 'A3DJR8M9Y3OUPG', isSelf: false, membership: 'NON_PRIME', viewSharePct: 72 },
      { sellerRef: 'A3DJR8M9Y3OUPG', isSelf: false, membership: 'PRIME', viewSharePct: 10.5 },
      { isSelf: true, membership: 'DEFAULT', viewSharePct: 17.5 },
    ],
  };
  const row = competitorSnapshotRow('t', 'a', 'AMAZON', 's', snapshot, NOW, 'RECONCILIATION', 'POLL');
  assert.deepEqual(row['offers.coupon_minor'], [1629, null], 'no coupon is NULL, not the price');
  assert.deepEqual([row['buybox_segments.seller_ref'], row['buybox_segments.is_self'], row['buybox_segments.membership'], row['buybox_segments.view_share_bp']],
    [['A3DJR8M9Y3OUPG', 'A3DJR8M9Y3OUPG', ''], [false, false, true], ['NON_PRIME', 'PRIME', 'DEFAULT'], [7200, 1050, 1750]]);
  assert.deepEqual(competitorSnapshotFromRow({ ...row, observed_at: '2026-10-29 10:00:00.000' }), snapshot);
  const plain = competitorSnapshotRow('t', 'a', 'AMAZON', 's', { ...snapshot, buyboxSegments: undefined, offers: snapshot.offers.slice(1) }, NOW);
  assert.deepEqual([plain['offers.coupon_minor'], plain['buybox_segments.membership']], [[null], []]);
  assert.equal('buyboxSegments' in competitorSnapshotFromRow({ ...plain, observed_at: '2026-10-29 10:00:00.000' }), false, 'no groups — no field');
});
