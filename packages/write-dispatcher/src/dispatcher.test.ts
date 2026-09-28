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
    async recordEbayBatchOutcome() {
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
    async recordEbayBatchOutcome() { throw new Error('not reached'); },
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
      async recordEbayBatchOutcome() { throw new Error('not reached'); },
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

/**
 * Шаг 47 [Р-186]: цена покупателя eBay (Browse, НДС сверху — E-17) приходит отдельным полем buyerPrice и в сверку базы цены Р-116 не
 * идёт; цена, которую канал применил сам (effectivePrice у Amazon и Kaufland), — идёт, как прежде. Утверждается вызов проверки базы:
 * при eBay-наблюдении его нет вовсе, при Amazon-наблюдении — с ценой ×1,19.
 */
test('Р-186: a buyer price with VAT on top (eBay buyerPrice) does not reach the Р-116 check; an effectivePrice (Amazon) still does', async () => {
  const write: FieldWrite = {
    channelWriteId: 'cw-1' as FieldWrite['channelWriteId'],
    writeScope: { writeScopeId: 'ws-1' as FieldWrite['writeScope']['writeScopeId'], field: 'PRICE', scopeKey: 'ebay:de:1', identity: { marketplace: 'EBAY_DE', externalSku: 'SYN-1', externalOfferId: '1', externalListingId: '110000000001' } },
    version: 1, idempotencyKey: 'idem-1', value: { field: 'PRICE', price: { amountMinor: 1349, currency: 'EUR', basis: 'GROSS' } }, attemptNo: 1,
  };
  const sent = { amountMinor: 1349, currency: 'EUR', basis: 'GROSS' as const };
  const buyer = { amountMinor: 1605, currency: 'EUR', basis: 'GROSS' as const };
  const run = async (extra: { buyerPrice?: typeof buyer; effectivePrice?: typeof buyer }) => {
    const checked: number[] = [];
    let claims = 0;
    const store: WriteQueueStore = {
      async dueScopes() { return [{ tenantId: 't1', writeScopeId: 'ws-1', dueKind: 'IN_FLIGHT_STALE', dueSince: '2026-09-15T09:00:00Z' }]; },
      async claimNext(): Promise<ClaimResult> {
        claims += 1;
        return claims === 1 ? { kind: 'IN_FLIGHT', channelAccountId: 'acc-1', write, status: 'ACCEPTED', since: '2026-09-15T09:55:00.000Z', reconcileDue: true } : { kind: 'IDLE' };
      },
      async recordOutcome() { throw new Error('not reached'); },
      async recordReconciliation(): Promise<RecordedOutcome> {
        return { status: 'APPLIED', slotFreed: true, queuedWaiting: false, nextAttemptAt: null, reason: null, scopeBlocked: false };
      },
      async checkPriceBasis(_t, _w, observedMinor) { checked.push(observedMinor); return null; },
      async recordEbayBatchOutcome() { throw new Error('not reached'); },
    };
    const adapter = {
      async readBack() {
        return { failures: [], observations: [{ identity: write.writeScope.identity, field: 'PRICE', value: { field: 'PRICE', price: sent }, observedAt: '2026-09-15T10:00:00.000Z', source: 'READBACK', ...extra }] };
      },
    } as unknown as ChannelAdapter;
    const dispatcher = createWriteDispatcher({ store, adapterFor: () => adapter, alerts: { raise: async () => undefined }, now: () => '2026-09-15T10:00:00.000Z' });
    const { reports } = await dispatcher.sweep({ concurrency: 1 });
    assert.ok(reports[0]!.steps.some((st) => st.action === 'RECONCILED'), JSON.stringify(reports));
    return checked;
  };
  assert.deepEqual(await run({ buyerPrice: buyer }), [], 'eBay: the buyer price with VAT on top is kept apart and never checked against the sent price');
  assert.deepEqual(await run({ effectivePrice: buyer }), [1605], 'Amazon, Kaufland: the price the channel applied is checked, as before');
});

/**
 * Шаг 49 [Р-189, E-22]: итог пакета разных SKU, который сообщил адаптер, диспетчер передаёт хранилищу — и только его: пакет без итога
 * хранилище не трогает. Сбой записи итога не роняет запись итогов самих записей, оператор видит алерт.
 */
test('Р-189: the dispatcher hands the eBay multi-SKU batch outcome to the store; a batch without it does not; a store failure is an alert, not a lost outcome', async () => {
  const make = (n: number): FieldWrite => ({
    channelWriteId: `cw-${n}` as FieldWrite['channelWriteId'],
    writeScope: { writeScopeId: `ws-${n}` as FieldWrite['writeScope']['writeScopeId'], field: 'PRICE', scopeKey: `ebay:de:${n}`, identity: { marketplace: 'EBAY_DE', externalSku: `SYN-${n}`, externalOfferId: String(n), externalListingId: `11000000000${n}` } },
    version: 1, idempotencyKey: `idem-${n}`, value: { field: 'PRICE', price: { amountMinor: 1300 + n, currency: 'EUR', basis: 'GROSS' } }, attemptNo: 1,
  });
  const run = async (outcome: { multiSkuAccepted: boolean } | undefined, storeFails = false, alertsThrow = false) => {
    const recorded: Array<[string, string, boolean]> = [];
    const outcomes: WriteOutcome[] = [];
    const alerts: Array<{ code: string }> = [];
    const claimed = new Set<string>();
    const store: WriteQueueStore = {
      async dueScopes() { return [1, 2].map((n) => ({ tenantId: 't1', writeScopeId: `ws-${n}`, dueKind: 'PENDING' as const, dueSince: '2026-09-15T09:00:00Z' })); },
      async claimNext(_t, writeScopeId): Promise<ClaimResult> {
        if (claimed.has(writeScopeId)) return { kind: 'IDLE' };
        claimed.add(writeScopeId);
        return { kind: 'DISPATCH', channelAccountId: 'acc-ebay', write: make(Number(writeScopeId.slice(3))) };
      },
      async recordOutcome(_t, _w, o): Promise<RecordedOutcome> {
        outcomes.push(o);
        return { status: 'FAILED', slotFreed: true, queuedWaiting: false, nextAttemptAt: '2026-09-15T10:00:02.000Z', reason: null, scopeBlocked: false };
      },
      async checkPriceBasis() { return null; },
      async recordReconciliation() { throw new Error('not reached'); },
      async recordEbayBatchOutcome(t, a, accepted) {
        if (storeFails) throw Object.assign(new Error('permission denied'), { code: '42501' });
        recorded.push([t, a, accepted]);
        return accepted ? 'MULTI' : 'SINGLE';
      },
    };
    const refused = { class: 'TRANSIENT' as const, code: 'ACTION_NOT_ALLOWED' as const, scope: 'BATCH' as const, message: 'multi-SKU refused', raiseAlert: false };
    const adapter = {
      async planDispatch(_ctx: unknown, writes: readonly FieldWrite[]) {
        return { batches: [{ batchId: 'b-1', operation: 'bulkUpdatePriceQuantity', items: [...writes], budgetCharges: [], requestCount: 1 }], rejected: [] };
      },
      async dispatch(_ctx: unknown, batch: { batchId: string; items: readonly FieldWrite[] }) {
        return { batchId: batch.batchId, attemptsMade: 1, ...(outcome ? { ebayBatchOutcome: outcome } : {}),
          outcomes: batch.items.map((w) => ({ channelWriteId: w.channelWriteId, status: 'REJECTED' as const, error: refused })) };
      },
    } as unknown as ChannelAdapter;
    const dispatcher = createWriteDispatcher({ store, adapterFor: () => adapter, alerts: { raise: async (a) => { alerts.push(a); if (alertsThrow) throw new Error('alert sink down'); } }, now: () => '2026-09-15T10:00:00.000Z' });
    await dispatcher.sweep({ concurrency: 1 });
    return { recorded, outcomes, alerts };
  };
  const refusedRun = await run({ multiSkuAccepted: false });
  assert.deepEqual(refusedRun.recorded, [['t1', 'acc-ebay', false]], 'one batch — one outcome, with the account of the batch');
  assert.equal(refusedRun.outcomes.length, 2, 'both writes of the refused batch got their own outcome');
  assert.deepEqual((await run({ multiSkuAccepted: true })).recorded, [['t1', 'acc-ebay', true]]);
  assert.deepEqual((await run(undefined)).recorded, [], 'a batch without an outcome does not touch the batch mode');
  const failing = await run({ multiSkuAccepted: false }, true);
  assert.equal(failing.outcomes.length, 2, 'the store failure does not lose the outcomes of the writes');
  assert.deepEqual(failing.alerts.map((a) => a.code), ['EBAY_BATCH_OUTCOME_NOT_RECORDED']);
  // Находка 20 ревью шага 49: даже если упал и приёмник алертов, известные итоги записей не превращаются в OUTCOME_UNKNOWN
  const sinkDown = await run({ multiSkuAccepted: false }, true, true);
  assert.deepEqual(sinkDown.outcomes.map((o) => [o.status, o.status === 'REJECTED' ? o.error.code : null]), [['REJECTED', 'ACTION_NOT_ALLOWED'], ['REJECTED', 'ACTION_NOT_ALLOWED']]);
});

// Тип FieldWrite нужен только для совместимости сигнатуры адаптера в заглушке
export type { FieldWrite };

/**
 * Шаг 51 (eBay Growth Check): правило повтора записи берёт ДИСПЕТЧЕР у адаптера канала аккаунта (`descriptor.writeRetry`), а не
 * общая политика. Сверяются политики, которые хранилище получило на обоих путях (пакетом и по одной записи)
 */
test('step 51: the dispatcher records outcomes with the channel write retry rule of the account adapter', async () => {
  const write: FieldWrite = {
    channelWriteId: 'cw-1' as FieldWrite['channelWriteId'],
    writeScope: { writeScopeId: 'ws-1' as FieldWrite['writeScope']['writeScopeId'], field: 'PRICE', scopeKey: 'ebay:de:1', identity: { marketplace: 'EBAY_DE', externalSku: 'S1' } },
    version: 1, idempotencyKey: 'idem-1', value: { field: 'PRICE', price: { amountMinor: 1999, currency: 'EUR', basis: 'GROSS' } }, attemptNo: 1,
  };
  const policies: Array<{ maxAttempts: number; retryOn: unknown }> = [];
  // Одна запись к отправке на каждый вызов диспетчера: обход и dispatchScope получают её по разу
  let due = true;
  const store: WriteQueueStore = {
    async dueScopes() { return [{ tenantId: 't1', writeScopeId: 'ws-1', dueKind: 'PENDING', dueSince: '2026-09-15T09:00:00Z' }]; },
    async claimNext(): Promise<ClaimResult> {
      if (!due) return { kind: 'IDLE' };
      due = false;
      return { kind: 'DISPATCH', channelAccountId: 'acc-1', write };
    },
    async recordOutcome(_t, _w, _o, _now, policy): Promise<RecordedOutcome> {
      policies.push({ maxAttempts: policy.maxAttempts, retryOn: policy.retryOn });
      return { status: 'FAILED', slotFreed: true, queuedWaiting: false, nextAttemptAt: null, reason: null, scopeBlocked: false };
    },
    async checkPriceBasis() { return null; },
    async recordEbayBatchOutcome() { throw new Error('not reached'); },
    async recordReconciliation() { throw new Error('not reached'); },
  };
  const rule = { maxAttempts: 3, retryOn: [{ code: 'TIMEOUT' as const }], basis: 'test' };
  const failed = { channelWriteId: write.channelWriteId, status: 'REJECTED' as const, error: { class: 'TRANSIENT' as const, code: 'CHANNEL_UNAVAILABLE' as const, scope: 'BATCH' as const, message: '503', raiseAlert: false, httpStatus: 503 } };
  const adapter = {
    descriptor: { writeRetry: rule },
    async planDispatch() { return { batches: [{ batchId: 'b-1', operation: 'bulkUpdatePriceQuantity', items: [write], budgetCharges: [], requestCount: 1 }], rejected: [] }; },
    async dispatch() { return { batchId: 'b-1', outcomes: [failed], attemptsMade: 1 }; },
  } as unknown as ChannelAdapter;
  const dispatcher = createWriteDispatcher({ store, adapterFor: () => adapter, alerts: { raise: async () => undefined }, now: () => '2026-09-15T10:00:00.000Z' });
  await dispatcher.sweep({ concurrency: 1 });
  due = true;
  await dispatcher.dispatchScope('t1', 'ws-1');
  assert.equal(policies.length, 2, 'both the sweep batch path and the single-scope path recorded an outcome');
  for (const p of policies) assert.deepEqual(p, { maxAttempts: 3, retryOn: rule.retryOn });
  assert.equal(dispatcher.policy.maxAttempts, 5, 'the core policy itself is unchanged for other channels');
});

/** Ревью шага 51, находка 10: адаптер недоступен при записи итога — правило аккаунта, известное раньше; неизвестно — ответы канала не повторяются */
test('step 52: when the adapter cannot be had while recording, the known rule of the account is used; unknown — no channel answer is retried', async () => {
  const write: FieldWrite = {
    channelWriteId: 'cw-1' as FieldWrite['channelWriteId'],
    writeScope: { writeScopeId: 'ws-1' as FieldWrite['writeScope']['writeScopeId'], field: 'PRICE', scopeKey: 'k', identity: { marketplace: 'EBAY_DE', externalSku: 'S1' } },
    version: 1, idempotencyKey: 'idem-1', value: { field: 'PRICE', price: { amountMinor: 1999, currency: 'EUR', basis: 'GROSS' } }, attemptNo: 1,
  };
  const run = async (failOn: (call: number) => boolean) => {
    const policies: Array<{ maxAttempts: number; retryOn: unknown }> = [];
    let due = true;
    let calls = 0;
    const store: WriteQueueStore = {
      async dueScopes() { return []; },
      async claimNext(): Promise<ClaimResult> { if (!due) return { kind: 'IDLE' }; due = false; return { kind: 'DISPATCH', channelAccountId: 'acc-1', write }; },
      async recordOutcome(_t, _w, _o, _now, p): Promise<RecordedOutcome> {
        policies.push({ maxAttempts: p.maxAttempts, retryOn: p.retryOn });
        return { status: 'FAILED', slotFreed: true, queuedWaiting: false, nextAttemptAt: null, reason: null, scopeBlocked: false };
      },
      async checkPriceBasis() { return null; },
      async recordEbayBatchOutcome() { throw new Error('not reached'); },
      async recordReconciliation() { throw new Error('not reached'); },
    };
    const rule = { maxAttempts: 3, retryOn: [{ code: 'CHANNEL_UNAVAILABLE' as const }], basis: 'test' };
    const adapter = {
      descriptor: { writeRetry: rule },
      async planDispatch() { return { batches: [{ batchId: 'b', operation: 'op', items: [write], budgetCharges: [], requestCount: 1 }], rejected: [] }; },
      async dispatch() { return { batchId: 'b', outcomes: [{ channelWriteId: write.channelWriteId, status: 'REJECTED', error: { class: 'TRANSIENT', code: 'RATE_LIMITED', scope: 'BATCH', message: '429', raiseAlert: false, httpStatus: 429 } }], attemptsMade: 1 }; },
    } as unknown as ChannelAdapter;
    const dispatcher = createWriteDispatcher({ store, adapterFor: () => { calls += 1; if (failOn(calls)) throw new Error('catalog unavailable'); return adapter; },
      alerts: { raise: async () => undefined }, now: () => '2026-09-15T10:00:00.000Z' });
    await dispatcher.dispatchScope('t1', 'ws-1');
    due = true;
    await dispatcher.dispatchScope('t1', 'ws-1');
    return policies;
  };
  // Первый итог — правило адаптера; во втором вызов за правилом падает — берётся известное правило аккаунта (отправка прошла на своём вызове)
  const known = await run((c) => c === 4);
  assert.deepEqual(known[1], { maxAttempts: 3, retryOn: [{ code: 'CHANNEL_UNAVAILABLE' }] });
  // Правило ещё не известно, и адаптер недоступен при записи итога — ответы канала не повторяются
  const unknown = await run((c) => c === 2);
  assert.deepEqual(unknown[0], { maxAttempts: 3, retryOn: [{ code: 'CHANNEL_UNAVAILABLE' }] });
});
