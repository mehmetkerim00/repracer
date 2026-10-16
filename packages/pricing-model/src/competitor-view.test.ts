import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CompetitorOffer, CompetitorSnapshot } from '@repracer/channel-port';
import { buildCompetitorView, COMPETITOR_VIEW_MAX_ROWS } from './competitor-view.ts';

/** Шаг 97 (I1) [Р-218]: дифф снимков детерминирован — тот же вход в любом порядке даёт ту же картину и того же «кто подвинул» */

const usd = (amountMinor: number) => ({ amountMinor, currency: 'USD', basis: 'NET' as const });
const offer = (seller: string | null, price: number, extra: Partial<CompetitorOffer> = {}): CompetitorOffer =>
  ({ ...(seller ? { sellerRef: seller } : {}), isSelf: seller === null, price: usd(price), shipping: usd(0), totalPrice: usd(price), ...extra });
const snap = (offers: CompetitorOffer[], extra: Partial<CompetitorSnapshot> = {}): CompetitorSnapshot => ({
  marketplace: 'walmart.com', channelProductRef: 'SYN-1', condition: 'new', source: 'WALMART_BUY_BOX', observedAt: '2026-10-16T10:00:00.000Z',
  completeness: { kind: 'TOP_N', n: 10 }, offers, ...extra,
});

test('step 97 (I1): the diff against the previous accepted snapshot names who moved, appeared and left — and who moved the price', () => {
  const before = snap([offer('Harbor Goods', 1300, { rank: 1, holdsBuyBox: true }), offer('Pine & Co', 1340, { rank: 2 }), offer(null, 1399, { rank: 3 }), offer('Old Mill', 1420, { rank: 4 })]);
  const now = snap([offer('Harbor Goods', 1250, { rank: 1, holdsBuyBox: true }), offer('Pine & Co', 1340, { rank: 2 }), offer(null, 1399, { rank: 3 }),
    offer('North Ridge', 1360, { rank: 4 })]);
  const view = buildCompetitorView(now, before)!;
  assert.deepEqual(view.trigger, { seller: 'Harbor Goods', move: 'DOWN', wasMinor: 1300, nowMinor: 1250 }, 'the Buy Box holder moved: it is the trigger');
  assert.deepEqual(view.offers.map((r) => [r.seller, r.move ?? null, r.wasMinor ?? null]), [
    ['Harbor Goods', 'DOWN', 1300], ['Pine & Co', null, null], [null, null, null], ['North Ridge', 'APPEARED', null], ['Old Mill', 'GONE', 1420],
  ]);
  assert.equal(view.offers.find((r) => r.self)!.move, undefined, 'our own price is not a competitor move');
  // Детерминизм: перестановка предложений во входе — та же картина
  const shuffled = buildCompetitorView({ ...now, offers: [...now.offers].reverse() }, { offers: [...before.offers].reverse() });
  assert.deepEqual(shuffled, view);
  // Сравнивать не с чем — «кто подвинул» нет, движений нет
  const first = buildCompetitorView(now, null)!;
  assert.equal(first.trigger, null);
  assert.equal(first.offers.some((r) => r.move), false);
});

test('step 97 (I1): without a moving Buy Box holder, the cheapest mover is the trigger; a left seller only when nobody moved', () => {
  const before = snap([offer('A', 1500, { rank: 1 }), offer('B', 1600, { rank: 2 }), offer(null, 1550, { rank: 3 })]);
  const two = buildCompetitorView(snap([offer('A', 1500, { rank: 1 }), offer('B', 1450, { rank: 2 }), offer('C', 1480, { rank: 3 }), offer(null, 1550)]), before)!;
  assert.deepEqual(two.trigger, { seller: 'B', move: 'DOWN', wasMinor: 1600, nowMinor: 1450 });
  const left = buildCompetitorView(snap([offer('B', 1600, { rank: 1 }), offer(null, 1550)]), before)!;
  assert.deepEqual(left.trigger, { seller: 'A', move: 'GONE', wasMinor: 1500 });
});

test('step 97 (I1): the view keeps only what the channel named, and no more rows than the database takes', () => {
  const bare = buildCompetitorView(snap([{ sellerRef: 'A', isSelf: false, price: usd(1200) }, { isSelf: true, price: usd(1300) }]), null)!;
  assert.deepEqual(bare.offers[0], { seller: 'A', self: false, priceMinor: 1200 }, 'no shipping, fulfilment, holder or rating is invented');
  const many = Array.from({ length: 40 }, (_, i) => offer(`S${String(i).padStart(2, '0')}`, 1000 + i, { rank: i + 1 }));
  const prev = Array.from({ length: 40 }, (_, i) => offer(`S${String(i).padStart(2, '0')}`, 1000 + i + (i % 3 === 0 ? 5 : 0), { rank: i + 1 }));
  const big = buildCompetitorView(snap([...many, offer(null, 1500, { rank: 41 })]), { offers: prev })!;
  assert.ok(big.offers.length <= COMPETITOR_VIEW_MAX_ROWS);
  assert.ok(big.offers.some((r) => r.self), 'our offer is always in the view');
});
