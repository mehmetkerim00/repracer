import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AlertSink, ChannelAdapter, FieldWrite } from '@repracer/channel-port';
import { createWriteDispatcher, type ClaimResult, type WriteQueueStore } from './index.ts';

/**
 * Находка 7 шага 15 [Р-64]: сбой одной единицы при обходе не роняет обход остальных и не молчит. До исправления sweep ждал
 * Promise.all всех единиц: одно исключение хранилища отменяло отчёт всего круга, алерта не было.
 */

test('a scope whose claim throws does not stop the sweep: other scopes are processed, one CRITICAL alert, no repeat within an hour', async () => {
  let clock = Date.parse('2026-09-15T10:00:00Z');
  const claimed: string[] = [];
  const store: WriteQueueStore = {
    async dueScopes() {
      return [
        { tenantId: 't1', writeScopeId: 'broken', dueKind: 'RETRY', dueSince: '2026-09-15T09:00:00Z' },
        { tenantId: 't1', writeScopeId: 'healthy', dueKind: 'PENDING', dueSince: '2026-09-15T09:00:00Z' },
      ];
    },
    async claimNext(_t, writeScopeId): Promise<ClaimResult> {
      claimed.push(writeScopeId);
      if (writeScopeId === 'broken') throw Object.assign(new Error('unrecognized database refusal with amount 1234'), { code: '23514' });
      return { kind: 'IDLE' };
    },
    async recordOutcome() {
      throw new Error('not reached');
    },
    async checkPriceBasis() {
      throw new Error('not reached');
    },
    async recordReconciliation() {
      throw new Error('not reached');
    },
  };
  const alerts: Array<Parameters<AlertSink['raise']>[0]> = [];
  const dispatcher = createWriteDispatcher({
    store, adapterFor: () => ({}) as ChannelAdapter, alerts: { raise: async (a) => { alerts.push(a); } }, now: () => new Date(clock).toISOString(),
  });

  const first = await dispatcher.sweep({ concurrency: 1 });
  assert.deepEqual(claimed, ['broken', 'healthy'], 'the healthy scope is claimed after the broken one');
  assert.equal(first.reports.length, 2);
  assert.deepEqual(first.reports.find((r) => r.writeScopeId === 'broken')!.steps, [{ action: 'ERROR', errorCode: '23514' }]);
  assert.equal(alerts.length, 1);
  assert.deepEqual([alerts[0]!.code, alerts[0]!.severity, alerts[0]!.details.errorCode], ['PRICE_WRITE_DISPATCH_ERROR', 'CRITICAL', '23514']);
  assert.ok(!JSON.stringify(alerts).includes('1234'), 'the database message with amounts is not put into the alert');

  clock += 10 * 60_000;
  await dispatcher.sweep({ concurrency: 1 });
  assert.equal(alerts.length, 1, 'the same error of the same scope does not raise an alert on every round');

  clock += 60 * 60_000;
  await dispatcher.sweep({ concurrency: 1 });
  assert.equal(alerts.length, 2, 'it is raised again after an hour while it persists');
});

// Тип FieldWrite нужен только для совместимости сигнатуры адаптера в заглушке
export type { FieldWrite };
