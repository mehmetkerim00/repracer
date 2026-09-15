import assert from 'node:assert/strict';
import { test } from 'node:test';
import { markPublished, newRelayCursor, planPublication, type OutboxRow } from '../src/index.ts';

const row = (id: string, scope: string | null, seq: number | null, createdAt: string): OutboxRow => ({
  outboxEventId: id, tenantId: 't', createdAt, topic: scope ? 'scope.write.v1' : 'alert.v1', partitionKey: scope ?? 't',
  writeScopeId: scope, scopeSeq: seq, eventType: 'WRITE_DISPATCH_DUE', schemaVersion: 1, payload: {},
});

test('within a write scope events go out by scope_seq, not by transaction start time', () => {
  const cursor = newRelayCursor();
  // Транзакция seq 2 началась раньше (created_at меньше), но закоммитила событие позже seq 1
  const plan = planPublication([row('b', 's1', 2, '2026-09-14T10:00:00.000Z'), row('a', 's1', 1, '2026-09-14T10:00:01.000Z')], cursor, 0, 30_000);
  assert.deepEqual(plan.publish.map((r) => r.scopeSeq), [1, 2]);
});

test('a scope_seq gap holds the rest of that scope, other scopes are not delayed; the gap closes or is released after the timeout', () => {
  const cursor = newRelayCursor();
  markPublished(cursor, [row('x1', 's1', 1, '2026-09-14T10:00:00.000Z')], 0);
  const events = [row('x3', 's1', 3, '2026-09-14T10:00:02.000Z'), row('y1', 's2', 7, '2026-09-14T10:00:02.000Z')];
  const held = planPublication(events, cursor, 1_000, 30_000);
  assert.deepEqual(held.publish.map((r) => r.outboxEventId), ['y1']);
  assert.deepEqual(held.held.map((h) => [h.writeScopeId, h.expectedSeq, h.nextSeq]), [['s1', 2, 3]]);
  markPublished(cursor, held.publish, 0);

  // Пропуск закрылся: пришёл seq 2 — оба события уходят по порядку
  const closed = planPublication([...events, row('x2', 's1', 2, '2026-09-14T10:00:01.500Z')], newCursorFrom(cursor), 2_000, 30_000);
  assert.deepEqual(closed.publish.map((r) => r.outboxEventId), ['x2', 'x3']);

  // Не закрылся за 30 с: публикация продолжается, пропуск — наружу
  const released = planPublication(events, cursor, 40_000, 30_000);
  assert.deepEqual(released.publish.map((r) => r.outboxEventId), ['x3']);
  assert.deepEqual(released.gapsReleased, [{ writeScopeId: 's1', expectedSeq: 2, nextSeq: 3 }]);
});

test('re-reading the overlap window does not publish an event twice', () => {
  const cursor = newRelayCursor();
  const events = [row('a', 's1', 1, '2026-09-14T10:00:00.000Z'), row('n', null, null, '2026-09-14T10:00:00.500Z')];
  const first = planPublication(events, cursor, 0, 30_000);
  markPublished(cursor, first.publish, 0);
  assert.deepEqual(planPublication(events, cursor, 1, 30_000).publish, []);
});

function newCursorFrom(c: ReturnType<typeof newRelayCursor>) {
  return { lastSeqByScope: new Map(c.lastSeqByScope), publishedIds: new Map(c.publishedIds), heldSince: new Map(c.heldSince) };
}
