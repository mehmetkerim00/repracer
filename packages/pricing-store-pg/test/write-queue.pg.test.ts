import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { ChannelAdapter, FieldWrite } from '@repracer/channel-port';
import type { MemorySeedScope, ScopeEvaluationContext } from '@repracer/pricing-pipeline';
import type { PriceDecisionDraft, PriceIntentDraft } from '@repracer/pricing-model';
import { createWriteDispatcher, type ScopeDispatchReport } from '@repracer/write-dispatcher';
import { createPool, inTenant, PgPricingStore, PgWriteQueueStore, seedPricingWorld } from '../src/index.ts';
import { explained } from './drafts.ts';

/**
 * Р-64: очередь записей цены за записью в полёте. Несколько решений по одной единице подряд, канал отвечает с задержкой —
 * как при одновременных событиях. Ни одно изменение цены не должно потеряться: последняя решённая цена каждой единицы
 * доходит до канала, запись не остаётся PENDING бесследно, старое значение не приходит в канал после нового.
 *
 * REPRACER_PG_URL — роль приложения (svc_app) в одноразовой базе со всеми миграциями и test/setup.sql; обход всех тенантов —
 * тем же адресом с ролью svc_dispatcher. Без REPRACER_PG_URL тесты пропускаются.
 */

const PG_URL = process.env.REPRACER_PG_URL;
const pool = PG_URL ? createPool(PG_URL, { max: 24, applicationName: 'repracer-write-queue-test' }) : null;
const provisioning = PG_URL ? createPool(PG_URL.replace('svc_app@', 'svc_provisioning@'), { max: 1, applicationName: 'repracer-test-provisioning' }) : null;
const scanPool = PG_URL ? createPool(PG_URL.replace('svc_app@', 'svc_dispatcher@'), { max: 2, applicationName: 'repracer-write-queue-scan' }) : null;
// Р-84: без базы тест не пропускается, а падает
if (!pool) throw new Error('REPRACER_PG_URL is required: database tests do not skip (Р-84)');
const skip = false;
after(async () => {
  await pool?.end();
  await provisioning?.end();
  await scanPool?.end();
});

const ACCOUNT = '20000000-0000-4000-8000-000000000001';
const FIXED = { strategyId: 'st-fixed', version: 1, params: { type: 'FIXED', priceMinor: 2000 }, deadbandMinor: 0 } as const;
const now = () => new Date().toISOString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jitter = (min: number, max: number) => min + Math.floor(Math.random() * (max - min + 1));

function scopeSeed(n: number): MemorySeedScope {
  return {
    writeScopeId: `ws-${n}`, productId: `prod-${n}`, channelAccountId: ACCOUNT, marketplace: 'de', externalUnitId: String(n),
    channelProductRef: `3640${n}`, condition: 'new', currency: 'EUR', basis: 'GROSS', pricingMode: 'ENGINE', strategy: FIXED,
    currentPriceMinor: 1850, minPrice: { amountMinor: 1500, id: `min-${n}` }, maxPrice: { amountMinor: 2500, id: `max-${n}` },
  };
}

function approved(context: ScopeEvaluationContext, amountMinor: number) {
  const { scope, bounds } = context;
  const min = bounds.min.status === 'RESOLVED' ? bounds.min : null;
  const max = bounds.max.status === 'RESOLVED' ? bounds.max : null;
  const at = now();
  const intent: PriceIntentDraft = {
    writeScopeId: scope.writeScopeId, strategyId: scope.strategy!.strategyId, strategyVersion: scope.strategy!.version, trigger: { type: 'SCHEDULE' }, ruleCode: 'FIXED',
    intentClass: 'CHANGED', proposedMinor: amountMinor, currentMinor: scope.currentPriceMinor, referenceMinor: null, currency: scope.currency,
    basis: scope.basis, reason: { code: 'FIXED_PRICE', params: {} }, explanation: [],
    inputs: { boundsAtStrategy: { minMinor: min!.amountMinor, maxMinor: max!.amountMinor } }, createdAt: at, expiresAt: new Date(Date.now() + 600_000).toISOString(),
  };
  const decision: PriceDecisionDraft = {
    writeScopeId: scope.writeScopeId, outcome: 'APPROVED', decisionClass: 'CHANGED', finalMinor: amountMinor, currency: scope.currency, basis: scope.basis,
    effectiveFloorMinor: min!.amountMinor, effectiveCeilingMinor: max!.amountMinor, minPriceIds: min!.sourceIds, maxPriceIds: max!.sourceIds,
    guardrailIds: [], rejectionReason: null, reason: { code: 'APPROVED', params: { finalMinor: amountMinor } }, checks: [], alert: null, decidedAt: at, boundDeviationBp: null,
  };
  return { context, intent, decision };
}

export interface QueueWorkloadResult {
  mode: string;
  scopes: number;
  decisionsPerScope: number;
  approvedDecisions: number;
  dispatchedByEvaluation: number;
  queuedBehindInFlight: number;
  dispatchedByDispatcher: number;
  /** Записи, оставшиеся PENDING после того, как всё затихло */
  strandedPending: number;
  /** Единицы, до канала которых не дошла последняя решённая цена */
  scopesWithLostLatestPrice: number;
  /** Канал получил версию ниже уже полученной */
  orderViolations: number;
  /** Вытесненные или отброшенные записи без записанной причины */
  endedWithoutReason: number;
  /** События scope.write.v1 «единица свободна, есть ждущая запись» */
  dispatchDueEvents: number;
  /** Единиц, у которых ждущая запись есть, а события нет */
  strandedWithoutEvent: number;
  /** Сколько единиц нашёл обход-страховка */
  sweepFound: number;
  /** Сколько записей получил канал всего */
  receivedTotal: number;
  handOffSteps: Record<string, number>;
  sweepSteps: Record<string, number>;
  finalStatuses: Record<string, number>;
  debug?: unknown;
}

const countSteps = (reports: ScopeDispatchReport[]) => {
  const counts: Record<string, number> = {};
  for (const r of reports) for (const step of r.steps) counts[step.action] = (counts[step.action] ?? 0) + 1;
  return counts;
};

/** Канал-заглушка: принимает запись с задержкой и помнит, что получил, в порядке получения по единице */
export class RecordingChannel {
  readonly received = new Map<string, Array<{ version: number; amountMinor: number }>>();
  private readonly latencyMs: [number, number];
  constructor(latencyMs: [number, number]) {
    this.latencyMs = latencyMs;
  }
  async send(write: FieldWrite): Promise<void> {
    await sleep(jitter(...this.latencyMs));
    const list = this.received.get(write.writeScope.writeScopeId) ?? [];
    list.push({ version: write.version, amountMinor: write.value.field === 'PRICE' ? write.value.price.amountMinor : -1 });
    this.received.set(write.writeScope.writeScopeId, list);
  }
}

function recordingAdapter(channel: RecordingChannel, counter: { sent: number }): ChannelAdapter {
  return {
    async planDispatch(_ctx: unknown, writes: readonly FieldWrite[]) {
      return { batches: writes.map((w) => ({ batchId: `b:${w.channelWriteId}`, operation: 'TEST', items: [w], budgetCharges: [], requestCount: 1 })), rejected: [] };
    },
    async dispatch(_ctx: unknown, batch: { batchId: string; items: FieldWrite[] }) {
      for (const w of batch.items) {
        await channel.send(w);
        counter.sent++;
      }
      return { batchId: batch.batchId, outcomes: batch.items.map((w) => ({ channelWriteId: w.channelWriteId, status: 'ACCEPTED', appliedImmediately: true })), attemptsMade: 1 };
    },
    async readBack() {
      return { observations: [], failures: [] };
    },
  } as unknown as ChannelAdapter;
}

/**
 * Нагрузка: по каждой единице — decisionsPerScope решений; i-е событие приходит через i·intervalMs плюс случайная доля
 * интервала и не ждёт предыдущих (события независимы — вебхуки и опрос). Каждое следующее решение дороже на 50 центов.
 * Путь решения после фиксации сам отправляет запись, если единица свободна (как pipeline.dispatchCommitted).
 * Канал отвечает за channelLatencyMs — меньше типичного PATCH канала (оценка, не замер).
 *  - handOff: после итога своей записи путь решения передаёт единицу диспетчеру в процессе, если в очереди ждёт запись;
 *  - sweep: после затихания — обход-страховка (событие потеряно, процесс упал).
 * Без обоих — поведение до шага 10.
 */
export async function runQueueWorkload(options: {
  mode: string;
  scopes: number;
  decisionsPerScope: number;
  intervalMs?: number;
  channelLatencyMs?: [number, number];
  handOff?: boolean;
  sweep?: boolean;
}): Promise<QueueWorkloadResult> {
  const intervalMs = options.intervalMs ?? 15;
  const seeds = Array.from({ length: options.scopes }, (_, i) => scopeSeed(7000 + i));
  const world = await seedPricingWorld(pool!, { provisioningPool: provisioning!,
    fixtureTenantId: '10000000-0000-4000-8000-000000000001', fixtureChannelAccountId: ACCOUNT, marketplaces: ['de', 'at'], clock: now(), seed: { scopes: seeds },
  });
  const tenantId = world.tenantId;
  const store = new PgPricingStore(pool!);
  const channel = new RecordingChannel(options.channelLatencyMs ?? [20, 80]);
  const dispatcherCounter = { sent: 0 };
  const queue = new PgWriteQueueStore(pool!, { scanPool: scanPool! });
  const dispatcher = createWriteDispatcher({
    // Обход идёт по всем тенантам; в одноразовой базе остаются записи других тестов (например, нарочно незавершённая
    // запись в store.pg.test.ts) — тест смотрит только на свой тенант
    store: {
      claimNext: queue.claimNext.bind(queue),
      recordOutcome: queue.recordOutcome.bind(queue),
      recordReconciliation: queue.recordReconciliation.bind(queue),
      dueScopes: async (at, o) => (await queue.dueScopes(at, o)).filter((d) => d.tenantId === tenantId),
    },
    adapterFor: () => recordingAdapter(channel, dispatcherCounter),
    alerts: { raise: async () => undefined },
    now,
  });
  const handOffReports: Array<ScopeDispatchReport & { at: string; trigger: string }> = [];
  const handOff = (writeScopeId: string, trigger: string) => (options.handOff
    ? dispatcher.dispatchScope(tenantId, writeScopeId).then((r) => { handOffReports.push({ ...r, at: now(), trigger }); })
    : Promise.resolve());
  let dispatchedByEvaluation = 0;
  let queuedBehindInFlight = 0;
  const background: Promise<void>[] = [];

  await Promise.all(seeds.map(async (s) => {
    const writeScopeId = world.ids.toDb(s.writeScopeId);
    await Promise.all(Array.from({ length: options.decisionsPerScope }, async (_, i) => {
      await sleep(i * intervalMs + jitter(0, intervalMs));
      const loaded = await store.loadScopeContext(tenantId, writeScopeId, now());
      assert.ok(loaded, `scope ${writeScopeId} is not visible`);
      const draft = approved(loaded.context, 1600 + 50 * i);
      const scope = loaded.context.scope;
      const result = await store.commitEvaluation(tenantId, {
        key: { channelAccountId: scope.channelAccountId, marketplace: scope.marketplace, channelProductRef: scope.channelProductRef, condition: scope.condition },
        now: now(), decisions: [explained(draft)],
      });
      assert.equal(result.status, 'COMMITTED');
      if (result.status !== 'COMMITTED') return;
      const committed = result.decisions[0]!;
      if (committed.pendingWriteId) queuedBehindInFlight++;
      const write = committed.write;
      if (!write) return;
      dispatchedByEvaluation++;
      background.push(channel.send(write)
        .then(() => store.recordDispatch(tenantId, write, { channelWriteId: write.channelWriteId, status: 'ACCEPTED', appliedImmediately: true }, now()))
        // Как pipeline.dispatchCommitted: единица освободилась и ждёт запись из очереди — передать диспетчеру
        .then((recorded) => (recorded.queuedWaiting ? handOff(writeScopeId, `settled v${write.version}`) : undefined)));
    }));
  }));
  await Promise.all(background);
  let sweepFound = 0;
  const sweepReports: ScopeDispatchReport[] = [];
  if (options.sweep) {
    for (let round = 0; round < 10; round++) {
      const swept = await dispatcher.sweep({ pendingMinAgeMs: 0 });
      sweepFound += swept.due;
      sweepReports.push(...swept.reports);
      if (swept.due === 0) break;
    }
  }

  return inTenant(pool!, tenantId, async (tx) => {
    const { rows: latest } = await tx.query(
      `SELECT ss.write_scope_id, ss.latest_version_created,
              coalesce((SELECT w.amount_minor FROM tenant_data.channel_write w
                         WHERE w.tenant_id = ss.tenant_id AND w.write_scope_id = ss.write_scope_id AND w.version = ss.latest_version_created),
                       (SELECT h.amount_minor FROM tenant_data.channel_write_history h
                         WHERE h.tenant_id = ss.tenant_id AND h.write_scope_id = ss.write_scope_id AND h.version = ss.latest_version_created)) AS latest_amount
         FROM tenant_data.write_scope_sync_state ss WHERE ss.tenant_id = $1`, [tenantId]);
    const { rows: statuses } = await tx.query(
      `SELECT status, count(*)::int AS n FROM tenant_data.channel_write WHERE tenant_id = $1 GROUP BY status
       UNION ALL
       SELECT final_status, count(*)::int FROM tenant_data.channel_write_history WHERE tenant_id = $1 GROUP BY final_status`, [tenantId]);
    const { rows: [ended] } = await tx.query(
      `SELECT count(*)::int AS n FROM tenant_data.channel_write_history
        WHERE tenant_id = $1 AND final_status IN ('SUPERSEDED', 'DISCARDED_STALE', 'BUDGET_EXHAUSTED') AND end_reason IS NULL`, [tenantId]);
    const { rows: [events] } = await tx.query(
      `SELECT count(*)::int AS n FROM tenant_data.outbox_event WHERE tenant_id = $1 AND event_type = 'WRITE_DISPATCH_DUE'`, [tenantId]);
    const { rows: [silent] } = await tx.query(
      `SELECT count(DISTINCT w.write_scope_id)::int AS n FROM tenant_data.channel_write w
        WHERE w.tenant_id = $1 AND w.status = 'PENDING'
          AND NOT EXISTS (SELECT 1 FROM tenant_data.outbox_event e
                           WHERE e.tenant_id = w.tenant_id AND e.write_scope_id = w.write_scope_id AND e.event_type = 'WRITE_DISPATCH_DUE')`, [tenantId]);
    let debug: unknown;
    if (process.env.WRITE_QUEUE_DEBUG) {
      const swept = [...new Set(sweepReports.map((r) => r.writeScopeId))].slice(0, 3);
      debug = await Promise.all(swept.map(async (writeScopeId) => ({
        writeScopeId,
        history: (await tx.query(
          `SELECT version, final_status, attempt_count, created_at, dispatched_at, finished_at, end_reason FROM tenant_data.channel_write_history
            WHERE tenant_id = $1 AND write_scope_id = $2 ORDER BY version`, [tenantId, writeScopeId])).rows,
        received: channel.received.get(writeScopeId),
        handOff: handOffReports.filter((r) => r.writeScopeId === writeScopeId).map((r) => ({ at: r.at, trigger: r.trigger, steps: r.steps })),
        sweep: sweepReports.filter((r) => r.writeScopeId === writeScopeId).map((r) => r.steps),
      })));
    }
    const finalStatuses: Record<string, number> = {};
    for (const r of statuses) finalStatuses[r.status] = (finalStatuses[r.status] ?? 0) + r.n;
    let lost = 0;
    let orderViolations = 0;
    for (const r of latest) {
      const got = channel.received.get(r.write_scope_id) ?? [];
      if (got.at(-1)?.amountMinor !== Number(r.latest_amount)) lost++;
      for (let i = 1; i < got.length; i++) if (got[i]!.version <= got[i - 1]!.version) orderViolations++;
    }
    return {
      mode: options.mode, scopes: options.scopes, decisionsPerScope: options.decisionsPerScope, approvedDecisions: options.scopes * options.decisionsPerScope,
      dispatchedByEvaluation, queuedBehindInFlight, dispatchedByDispatcher: dispatcherCounter.sent,
      strandedPending: finalStatuses.PENDING ?? 0, scopesWithLostLatestPrice: lost, orderViolations,
      endedWithoutReason: ended!.n, dispatchDueEvents: events!.n, strandedWithoutEvent: silent!.n, sweepFound,
      receivedTotal: [...channel.received.values()].reduce((a, l) => a + l.length, 0), handOffSteps: countSteps(handOffReports), sweepSteps: countSteps(sweepReports),
      finalStatuses, ...(debug ? { debug } : {}),
    };
  });
}

const WORKLOAD = { scopes: 40, decisionsPerScope: 6 };

test('control — without the dispatcher queued writes stay PENDING (step 9 defect), but every one is announced and every supersession explained', { skip }, async () => {
  const result = await runQueueWorkload({ mode: 'no-dispatcher', ...WORKLOAD });
  console.log(`WRITE_QUEUE_RESULT ${JSON.stringify(result)}`);
  // Контроль доказывает дефект, а не только печатает его (ретроспективное ревью шага 14, A2): без диспетчера ждущие записи есть
  assert.ok(result.strandedPending > 0, `the control must reproduce the step 9 defect: ${JSON.stringify(result)}`);
  assert.ok(result.scopesWithLostLatestPrice > 0, `the control must lose latest prices: ${JSON.stringify(result)}`);
  assert.equal(result.strandedWithoutEvent, 0, 'a PENDING write has no scope.write.v1 event: nobody would ever learn about it');
  assert.equal(result.endedWithoutReason, 0, 'a superseded write has no recorded reason');
  assert.equal(result.orderViolations, 0);
});

test('Р-64: hand-off to the dispatcher — no price change is lost behind an in-flight write, the safety sweep finds nothing', { skip }, async () => {
  const result = await runQueueWorkload({ mode: 'hand-off', ...WORKLOAD, handOff: true, sweep: true });
  console.log(`WRITE_QUEUE_RESULT ${JSON.stringify(result)}`);
  // Иначе все «= 0» ниже выполняются тривиально: очередь за записью в полёте и передача диспетчеру обязаны случиться
  assert.ok(result.queuedBehindInFlight > 0 && result.dispatchedByDispatcher > 0, `hand-off was not exercised: ${JSON.stringify(result)}`);
  assert.equal(result.strandedPending, 0, 'writes left PENDING with nobody to send them');
  assert.equal(result.scopesWithLostLatestPrice, 0, 'the latest decided price never reached the channel');
  assert.equal(result.orderViolations, 0, 'an older version reached the channel after a newer one');
  assert.equal(result.endedWithoutReason, 0);
  assert.equal(result.sweepFound, 0, 'the in-process hand-off left work for the safety sweep');
});

test('Р-64: events lost — the safety sweep alone delivers every latest price', { skip }, async () => {
  const result = await runQueueWorkload({ mode: 'sweep-only', ...WORKLOAD, sweep: true });
  console.log(`WRITE_QUEUE_RESULT ${JSON.stringify(result)}`);
  assert.equal(result.strandedPending, 0);
  assert.equal(result.scopesWithLostLatestPrice, 0);
  assert.equal(result.orderViolations, 0);
  assert.equal(result.endedWithoutReason, 0);
  assert.ok(result.sweepFound > 0, 'the workload should have queued writes for the sweep to find');
});
