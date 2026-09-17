import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CompetitorSnapshot } from '@repracer/channel-port';
import { comparedValue, reconcile, rotation } from './reconciliation.ts';

const money = (amountMinor: number) => ({ amountMinor, currency: 'EUR', basis: 'GROSS' as const });
const snap = (observedAt: string, buybox: number | null, offers: Array<[number, boolean]>): CompetitorSnapshot => ({
  marketplace: 'de', channelProductRef: '362000001', condition: 'new', source: 'KAUFLAND_BUYBOX', observedAt, completeness: { kind: 'TOP_N', n: 10 },
  ...(buybox !== null ? { buybox: { price: money(buybox), isSelf: false } } : {}),
  offers: offers.map(([minor, isSelf]) => ({ isSelf, price: money(minor) })),
});
const push = { kind: 'PUSH', hasBuyboxWinner: true } as never;

test('Р-121: what is compared — the Buy Box only when both the notification and the poll carry it', () => {
  assert.equal(comparedValue(push, { hasBuyboxWinner: true } as never), 'BUYBOX');
  assert.equal(comparedValue(push, { hasBuyboxWinner: false } as never), 'LOWEST_COMPETITOR');
  assert.equal(comparedValue(undefined, { hasBuyboxWinner: true } as never), 'LOWEST_COMPETITOR');
});

test('Р-121: a poll diverges from the held state only when it is newer and the compared value differs', () => {
  const held = { observedAt: '2026-09-14T10:00:00.000Z', buyboxMinor: 1800, lowestMinor: 1790 };
  assert.deepEqual(reconcile(null, snap('2026-09-14T10:05:00.000Z', 1800, []), 'BUYBOX'), { kind: 'NO_BASELINE' });
  assert.deepEqual(reconcile(held, snap('2026-09-14T10:00:00.000Z', 1700, []), 'BUYBOX'), { kind: 'NOT_NEWER' });
  assert.deepEqual(reconcile(held, snap('2026-09-14T10:05:00.000Z', 1800, [[1750, true], [1790, false]]), 'BUYBOX'), { kind: 'MATCH' });
  assert.deepEqual(reconcile(held, snap('2026-09-14T10:05:00.000Z', 1780, []), 'BUYBOX'), { kind: 'DIVERGED', heldMinor: 1800, pollMinor: 1780 });
  // Наименьшая — без своих предложений, как у последнего принятого состояния
  assert.deepEqual(reconcile(held, snap('2026-09-14T10:05:00.000Z', null, [[1500, true], [1790, false]]), 'LOWEST_COMPETITOR'), { kind: 'MATCH' });
  assert.deepEqual(reconcile(held, snap('2026-09-14T10:05:00.000Z', null, []), 'LOWEST_COMPETITOR'), { kind: 'DIVERGED', heldMinor: 1790, pollMinor: null });
});

test('Р-121: the rotation covers every product in ceil(n / size) cycles, in a stable order independent of input order', () => {
  const items = ['B5', 'B1', 'B4', 'B2', 'B3'].map((ref) => ({ marketplace: 'A1PA6795UKMFR9', channelProductRef: ref, condition: 'new' }));
  const at = (cycle: number) => new Date(cycle * 30_000).toISOString();
  const seen = new Set<string>();
  for (let cycle = 0; cycle < 3; cycle++) for (const q of rotation(items, 2, at(cycle), 30)) seen.add(q.channelProductRef);
  assert.deepEqual([...seen].sort(), ['B1', 'B2', 'B3', 'B4', 'B5']);
  assert.deepEqual(rotation(items, 2, at(0), 30).map((q) => q.channelProductRef), ['B1', 'B2']);
  assert.deepEqual(rotation([...items].reverse(), 2, at(1), 30).map((q) => q.channelProductRef), ['B3', 'B4']);
  assert.deepEqual(rotation(items, 10, at(7), 30).length, 5);
  assert.deepEqual(rotation([], 2, at(0), 30), []);
});
