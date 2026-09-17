import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChannelWriteId } from '@repracer/channel-port';
import { coreError, DEFAULT_RETRY_POLICY, planOutcomeTransition, planReconciliationTransition } from './index.ts';

const NOW = '2026-09-14T10:00:00.000Z';
const id = 'cw-1' as ChannelWriteId;

test('accepted by the channel: applied immediately or waiting for confirmation', () => {
  assert.deepEqual(planOutcomeTransition({ channelWriteId: id, status: 'ACCEPTED', appliedImmediately: true }, 1, NOW, DEFAULT_RETRY_POLICY),
    { to: 'ACCEPTED', applied: true, reason: null });
  // Ретроспективное ревью A6: и второй случай — канал принял, применение подтвердится позже
  assert.deepEqual(planOutcomeTransition({ channelWriteId: id, status: 'ACCEPTED', appliedImmediately: false }, 1, NOW, DEFAULT_RETRY_POLICY),
    { to: 'ACCEPTED', applied: false, reason: null });
});

test('unknown outcome is never retried blindly: read-back first', () => {
  const t = planOutcomeTransition({ channelWriteId: id, status: 'OUTCOME_UNKNOWN', error: coreError('TIMEOUT', 'TRANSIENT', 'timeout') }, 1, NOW, DEFAULT_RETRY_POLICY);
  assert.equal(t.to, 'RECONCILE');
  assert.equal(t.to === 'RECONCILE' && t.nextAttemptAt, '2026-09-14T10:00:30.000Z');
});

test('transient error: retry with backoff, not earlier than retryAt; exhausted attempts end with a reason', () => {
  const rateLimited = { ...coreError('RATE_LIMITED', 'TRANSIENT', '429'), retryAt: '2026-09-14T10:01:00.000Z' };
  const first = planOutcomeTransition({ channelWriteId: id, status: 'REJECTED', error: rateLimited }, 1, NOW, DEFAULT_RETRY_POLICY);
  assert.deepEqual(first.to === 'RETRY' && [first.nextAttemptAt, first.reason.code], ['2026-09-14T10:01:00.000Z', 'WRITE_RETRY_SCHEDULED']);
  const second = planOutcomeTransition({ channelWriteId: id, status: 'REJECTED', error: coreError('CHANNEL_UNAVAILABLE', 'TRANSIENT', '503') }, 3, NOW, DEFAULT_RETRY_POLICY);
  assert.equal(second.to === 'RETRY' && second.nextAttemptAt, '2026-09-14T10:00:08.000Z');
  const last = planOutcomeTransition({ channelWriteId: id, status: 'REJECTED', error: coreError('CHANNEL_UNAVAILABLE', 'TRANSIENT', '503') }, 5, NOW, DEFAULT_RETRY_POLICY);
  assert.deepEqual(last.to === 'DISCARD' && last.reason, { code: 'WRITE_RETRIES_EXHAUSTED', params: { attempts: 5, code: 'CHANNEL_UNAVAILABLE' } });
});

test('permanent error discards, human-required error blocks the write scope, budget exhaustion is its own end', () => {
  assert.equal(planOutcomeTransition({ channelWriteId: id, status: 'REJECTED', error: coreError('VALIDATION', 'PERMANENT', 'bad') }, 1, NOW, DEFAULT_RETRY_POLICY).to, 'DISCARD');
  assert.equal(planOutcomeTransition({ channelWriteId: id, status: 'REJECTED', error: coreError('AUTH_INVALID', 'REQUIRES_HUMAN', 'keys') }, 1, NOW, DEFAULT_RETRY_POLICY).to, 'BLOCK_SCOPE');
  assert.equal(planOutcomeTransition({ channelWriteId: id, status: 'REJECTED', error: coreError('EDIT_BUDGET_EXHAUSTED', 'TRANSIENT', 'budget') }, 1, NOW, DEFAULT_RETRY_POLICY).to, 'BUDGET_EXHAUSTED');
});

test('reconciliation: applied value accepts, missing value of a dispatched write retries the same version at once', () => {
  assert.equal(planReconciliationTransition('DISPATCHED', { kind: 'APPLIED' }, 1, NOW, NOW, DEFAULT_RETRY_POLICY).to, 'ACCEPTED');
  const retry = planReconciliationTransition('DISPATCHED', { kind: 'NOT_APPLIED', observedMinor: 1850 }, 1, NOW, NOW, DEFAULT_RETRY_POLICY);
  assert.deepEqual(retry.to === 'RETRY' && retry.nextAttemptAt, NOW);
  assert.equal(planReconciliationTransition('DISPATCHED', { kind: 'UNKNOWN', error: null }, 1, NOW, NOW, DEFAULT_RETRY_POLICY).to, 'RECONCILE');
  const lateAsync = planReconciliationTransition('ACCEPTED', { kind: 'NOT_APPLIED', observedMinor: 1850 }, 1, '2026-09-14T08:00:00.000Z', NOW, DEFAULT_RETRY_POLICY);
  assert.equal(lateAsync.to, 'NOT_APPLIED');
});

test('D1: an outcome that stays unknown past the limit stops the reconciliation and blocks the write scope — for a dispatched and an accepted write', () => {
  const since = '2026-09-14T08:30:00.000Z';
  for (const status of ['DISPATCHED', 'ACCEPTED'] as const) {
    const within = planReconciliationTransition(status, { kind: 'UNKNOWN', error: null }, 1, '2026-09-14T09:30:00.000Z', NOW, DEFAULT_RETRY_POLICY);
    assert.equal(within.to, 'RECONCILE', `${status}: within the limit the read-back is tried again`);
    const past = planReconciliationTransition(status, { kind: 'UNKNOWN', error: null }, 1, since, NOW, DEFAULT_RETRY_POLICY);
    assert.deepEqual(past, { to: 'UNRESOLVED', errorCode: 'OUTCOME_UNRESOLVED', reason: { code: 'WRITE_SCOPE_BLOCKED', params: { code: 'OUTCOME_UNRESOLVED', action: 'CONTACT_CHANNEL_SUPPORT' } } });
  }
  // Известный итог после предела остаётся обычным: применено — принято
  assert.equal(planReconciliationTransition('DISPATCHED', { kind: 'APPLIED' }, 1, since, NOW, DEFAULT_RETRY_POLICY).to, 'ACCEPTED');
});

test('Р-115: a read-back refusal that requires a person blocks the write scope at once with the channel code, the accepted write stays accepted', async () => {
  const { planReconciliationTransition, DEFAULT_RETRY_POLICY } = await import('./transitions.ts');
  const now = '2026-09-14T10:05:00.000Z';
  const error = { class: 'REQUIRES_HUMAN' as const, code: 'CHANNEL_REPRICER_ACTIVE' as const, scope: 'ITEM' as const, message: 'rule', raiseAlert: true };
  assert.deepEqual(planReconciliationTransition('ACCEPTED', { kind: 'UNKNOWN', error }, 1, '2026-09-14T10:04:59.000Z', now, DEFAULT_RETRY_POLICY),
    { to: 'UNRESOLVED', errorCode: 'CHANNEL_REPRICER_ACTIVE', reason: { code: 'WRITE_SCOPE_BLOCKED', params: { code: 'CHANNEL_REPRICER_ACTIVE', action: 'DISABLE_CHANNEL_REPRICER' } } });
  const transient = { ...error, class: 'TRANSIENT' as const, code: 'CHANNEL_UNAVAILABLE' as const };
  assert.equal(planReconciliationTransition('ACCEPTED', { kind: 'UNKNOWN', error: transient }, 1, '2026-09-14T10:04:59.000Z', now, DEFAULT_RETRY_POLICY).to, 'RECONCILE');
});
