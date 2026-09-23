import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AlertSink, ChannelAdapter, FieldWrite, WriteOutcome } from '@repracer/channel-port';
import { createWriteDispatcher, type ClaimResult, type RecordedOutcome, type WriteQueueStore } from './index.ts';

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

/**
 * Находка 7 ревью шага 36: ветку «в пакете две записи одной единицы» назвали непроваливаемой, потому что `claimNext`
 * выдаёт по одной записи на единицу. Так и есть — но пакеты собирает не ядро, а АДАПТЕР канала, и достижимый случай
 * именно такой: адаптер сгруппировал неверно. Ветка оставлена и проверяется по прецеденту OQ-211 [Р-94]: утверждается
 * ПРИЧИНА отказа и то, что к каналу обращения не было.
 */
test('Р-24: в пакете адаптера две позиции одной единицы — к каналу не идём, запись отказана с причиной', async () => {
  const write: FieldWrite = {
    channelWriteId: 'cw-1' as FieldWrite['channelWriteId'],
    writeScope: { writeScopeId: 'ws-1' as FieldWrite['writeScope']['writeScopeId'], field: 'PRICE', scopeKey: 'kfl:de:1', identity: { marketplace: 'de', externalUnitId: '1' } },
    version: 7, idempotencyKey: 'idem-1', value: { field: 'PRICE', price: { amountMinor: 1999, currency: 'EUR', basis: 'GROSS' } }, attemptNo: 1,
  };
  let claims = 0;
  const outcomes: WriteOutcome[] = [];
  const store: WriteQueueStore = {
    async dueScopes() { return [{ tenantId: 't1', writeScopeId: 'ws-1', dueKind: 'PENDING', dueSince: '2026-09-15T09:00:00Z' }]; },
    async claimNext(): Promise<ClaimResult> {
      claims += 1;
      return claims === 1 ? { kind: 'DISPATCH', channelAccountId: 'acc-1', write } : { kind: 'IDLE' };
    },
    async recordOutcome(_t, _w, outcome): Promise<RecordedOutcome> {
      outcomes.push(outcome);
      return { status: 'FAILED', slotFreed: true, queuedWaiting: false, nextAttemptAt: null, reason: null, scopeBlocked: false };
    },
    async checkPriceBasis() { return null; },
    async recordReconciliation() { throw new Error('not reached'); },
  };
  let dispatched = 0;
  // Адаптер с дефектом группировки: одна и та же запись положена в пакет дважды
  const adapter = {
    async planDispatch() {
      return { batches: [{ batchId: 'b-1', operation: 'POST /units/bulk', items: [write, write], budgetCharges: [], requestCount: 1 }], rejected: [] };
    },
    async dispatch() { dispatched += 1; throw new Error('the channel must not be called for a malformed batch'); },
  } as unknown as ChannelAdapter;

  const dispatcher = createWriteDispatcher({
    store, adapterFor: () => adapter, alerts: { raise: async () => undefined }, now: () => '2026-09-15T10:00:00.000Z',
  });
  const { reports } = await dispatcher.sweep({ concurrency: 1 });

  assert.equal(dispatched, 0, 'пакет, нарушающий порядок единицы, к каналу не уходит');
  assert.equal(outcomes.length, 1, 'итог записан ровно один раз: захваченная запись одна, сдвоил её адаптер');
  const [outcome] = outcomes;
  // Причина, а не просто факт отказа [Р-94]: нарушен порядок внутри единицы записи, и это дефект плана, а не канала
  assert.equal(outcome!.status, 'REJECTED');
  assert.deepEqual([outcome!.error?.code, outcome!.error?.class], ['VALIDATION', 'PERMANENT']);
  assert.match(String(outcome!.error?.message), /batch holds two writes of one scope/);
  const step = reports[0]!.steps.find((s) => s.action === 'DISPATCHED');
  assert.deepEqual([step?.action, step?.action === 'DISPATCHED' ? step.outcome : null], ['DISPATCHED', 'REJECTED'], JSON.stringify(reports));
});

/**
 * Находка 5 ревью шага 36: следующий круг обхода берётся из ответа ХРАНИЛИЩА (`queuedWaiting`), а не выводится из строки
 * отчёта. Здесь это и утверждается: при `queuedWaiting: false` второго круга нет, при `true` — есть.
 */
test('Р-64: следующий круг обхода даёт база — очередь единицы, а не пересказ статуса в отчёте', async () => {
  const make = (n: number): FieldWrite => ({
    channelWriteId: `cw-${n}` as FieldWrite['channelWriteId'],
    writeScope: { writeScopeId: 'ws-1' as FieldWrite['writeScope']['writeScopeId'], field: 'QUANTITY', scopeKey: 'kfl:de:1', identity: { marketplace: 'de', externalUnitId: '1', externalOfferId: 'of-1' } },
    version: n, idempotencyKey: `idem-${n}`, value: { field: 'QUANTITY', quantity: 10 + n }, attemptNo: 1,
  });

  const run = async (queuedWaiting: boolean) => {
    let claims = 0;
    const store: WriteQueueStore = {
      async dueScopes() { return [{ tenantId: 't1', writeScopeId: 'ws-1', dueKind: 'PENDING', dueSince: '2026-09-15T09:00:00Z' }]; },
      async claimNext(): Promise<ClaimResult> {
        claims += 1;
        // Работа у единицы есть ВСЕГДА: круг прекращается только потому, что база сказала «очереди нет»
        return claims <= 2 ? { kind: 'DISPATCH', channelAccountId: 'acc-1', write: make(claims) } : { kind: 'IDLE' };
      },
      // Статус в отчёте одинаков в обоих прогонах: если бы круг решался по нему, ответ базы ничего не менял бы
      async recordOutcome(): Promise<RecordedOutcome> {
        return { status: 'APPLIED', slotFreed: true, queuedWaiting, nextAttemptAt: null, reason: null, scopeBlocked: false };
      },
      async checkPriceBasis() { return null; },
      async recordReconciliation() { throw new Error('not reached'); },
    };
    const adapter = {
      async planDispatch(_ctx: unknown, writes: readonly FieldWrite[]) {
        return { batches: [{ batchId: `b-${writes[0]!.version}`, operation: 'POST /units/bulk', items: [...writes], budgetCharges: [], requestCount: 1 }], rejected: [] };
      },
      async dispatch(_ctx: unknown, batch: { batchId: string; items: readonly FieldWrite[] }) {
        return { batchId: batch.batchId, outcomes: batch.items.map((w) => ({ channelWriteId: w.channelWriteId, status: 'APPLIED' as const })), budgetCharges: [], observations: [] };
      },
    } as unknown as ChannelAdapter;
    const dispatcher = createWriteDispatcher({ store, adapterFor: () => adapter, alerts: { raise: async () => undefined }, now: () => '2026-09-15T10:00:00.000Z' });
    const { reports } = await dispatcher.sweep({ concurrency: 1 });
    return { claims, versions: reports[0]!.steps.filter((s) => s.action === 'DISPATCHED').map((s) => (s.action === 'DISPATCHED' ? s.version : 0)) };
  };

  const stopped = await run(false);
  assert.deepEqual([stopped.claims, stopped.versions], [1, [1]], 'очереди нет — второго круга нет, хотя работа у единицы была');
  const continued = await run(true);
  // Второй круг состоялся, шаги обоих кругов — в ОДНОМ отчёте единицы, и версии идут по возрастанию [Р-24]
  assert.deepEqual([continued.claims, continued.versions], [3, [1, 2]], 'очередь есть — единица получает следующий круг');
});

// Тип FieldWrite нужен только для совместимости сигнатуры адаптера в заглушке
export type { FieldWrite };
