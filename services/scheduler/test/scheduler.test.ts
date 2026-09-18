import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { AMAZON_DESCRIPTOR } from '@repracer/amazon-adapter';
import { KAUFLAND_DESCRIPTOR } from '@repracer/kaufland-adapter';
import { createScheduler, jobSource, LeaseLostError, MemorySchedulerState, nextSlotAfter, type JobDeps, type JobSpec , retryDelaySeconds, RETRY_BACKOFF_CAP_SECONDS } from '../src/index.ts';

/** Р-126 (шаг 25): планировщик на состоянии в памяти и виртуальных часах. Данные синтетические */

function clock(start: string) {
  let t = Date.parse(start);
  return { now: () => new Date(t).toISOString(), advance: (ms: number) => { t += ms; }, set: (iso: string) => { t = Date.parse(iso); } };
}
const sink = () => {
  const alerts: Array<{ code: string; severity: string; details?: Record<string, unknown> }> = [];
  return { alerts, raise: async (a: { code: string; severity: string; details?: Record<string, unknown> }) => { alerts.push(a); } };
};
const spec = (over: Partial<JobSpec> & Pick<JobSpec, 'run'>): JobSpec => ({
  name: 'job', scope: null, intervalSeconds: 60, catchUp: 'LATEST', firstDueAt: (n) => n, lagWarningSeconds: 600, lagCriticalSeconds: 3600, leaseSeconds: 60, ...over,
});

test('Р-126: a daily job stopped for three days runs every missed day in order when the scheduler returns', async () => {
  const c = clock('2026-09-17T00:40:00.000Z');
  const state = new MemorySchedulerState(c.now);
  const days: string[] = [];
  const job = spec({ name: 'daily', intervalSeconds: 86_400, catchUp: 'EVERY_SLOT', firstDueAt: () => '2026-09-17T00:30:00.000Z', lagWarningSeconds: 6 * 3600, lagCriticalSeconds: 72 * 3600,
    run: async ({ slotAt }) => { days.push(slotAt); return { items: 1 }; } });
  const alerts = sink();
  const s = createScheduler({ state, source: { jobs: async () => [job] }, owner: 'a', now: c.now, alerts });
  await s.tick();
  assert.deepEqual(days, ['2026-09-17T00:30:00.000Z']);
  c.set('2026-09-20T09:00:00.000Z');
  const report = await s.tick();
  assert.deepEqual(days.slice(1), ['2026-09-18T00:30:00.000Z', '2026-09-19T00:30:00.000Z', '2026-09-20T00:30:00.000Z'], 'every missed slot, oldest first');
  assert.equal((await state.list())[0]!.nextDueAt, '2026-09-21T00:30:00.000Z');
  assert.equal(report.runs.length, 3);
  // Простой дольше порога виден и после того, как слоты догнаны: отставание 56,5 ч — выше 6 ч, ниже 72 ч
  assert.deepEqual(alerts.alerts.map((a) => [a.code, a.severity, a.details?.caughtUp, a.details?.lagSeconds]), [['SCHEDULER_JOB_LAGGING', 'WARNING', true, 203_400]]);
});

test('Р-126: a polling job stopped for an hour runs once and records the coalesced slots', async () => {
  const c = clock('2026-09-17T10:00:00.000Z');
  const state = new MemorySchedulerState(c.now);
  let runs = 0;
  const s = createScheduler({ state, source: { jobs: async () => [spec({ run: async () => { runs++; return { items: 0 }; } })] }, owner: 'a', now: c.now, alerts: sink() });
  await s.tick();
  c.advance(3_600_000 + 5_000);
  await s.tick();
  const [j] = await state.list();
  // Шаг 26: следующий запуск — не раньше интервала после начала этого (11:00:05 + 60 с), а не по сетке слотов
  assert.deepEqual([runs, j!.runsCompleted, j!.coalescedSlots, j!.nextDueAt], [2, 2, 59, '2026-09-17T11:01:05.000Z']);
  assert.deepEqual(nextSlotAfter('2026-09-17T10:00:00.000Z', '2026-09-17T10:00:59.000Z', 60), { nextDueAt: '2026-09-17T10:01:00.000Z', coalesced: 0 });
});

test('Р-126: one scheduler per job — a second process does not run a leased job; a crashed lease expires; the old owner cannot finish', async () => {
  const c = clock('2026-09-17T10:00:00.000Z');
  const state = new MemorySchedulerState(c.now);
  let runs = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const job = spec({ leaseSeconds: 60, run: async () => { runs++; await gate; return { items: 0 }; } });
  const a = createScheduler({ state, source: { jobs: async () => [job] }, owner: 'a', now: c.now, alerts: sink() });
  const b = createScheduler({ state, source: { jobs: async () => [job] }, owner: 'b', now: c.now, alerts: sink() });
  const first = a.tick();
  await new Promise((r) => setImmediate(r));
  const second = await b.tick();
  assert.deepEqual([runs, second.skippedLeased], [1, ['job']], 'b sees the lease of a');
  release();
  await first;
  // Упавший планировщик: аренда взята, итога нет — после истечения аренды работу занимает другой, а старый владелец итог не запишет
  c.advance(60_000);
  const claimed = await state.claim('job', 'crashed', c.now(), 30);
  assert.ok(claimed);
  assert.equal(await state.claim('job', 'b', c.now(), 30), null);
  c.advance(31_000);
  assert.ok(await state.claim('job', 'b', c.now(), 30));
  await assert.rejects(state.finish('job', 'crashed', { outcome: 'SUCCEEDED', nextDueAt: c.now(), coalesced: 0, error: null,
    run: { jobKey: 'job', jobName: 'job', slotAt: c.now(), owner: 'crashed', startedAt: c.now(), finishedAt: c.now(), outcome: 'SUCCEEDED', lagSeconds: 0, items: 0, errorCode: null } }), LeaseLostError);
});

test('Р-126, Р-132: a failed run keeps its slot, is retried after the backoff and raises a CRITICAL alert after three failures in a row', async () => {
  const c = clock('2026-09-17T00:40:00.000Z');
  const state = new MemorySchedulerState(c.now);
  let fail = true;
  const done: string[] = [];
  const alerts = sink();
  const job = spec({ name: 'daily', intervalSeconds: 86_400, catchUp: 'EVERY_SLOT', firstDueAt: () => '2026-09-17T00:30:00.000Z', lagWarningSeconds: 99_999, lagCriticalSeconds: 999_999,
    run: async ({ slotAt }) => { if (fail) throw new Error('CLICKHOUSE_UNAVAILABLE: synthetic'); done.push(slotAt); return { items: 1 }; } });
  const s = createScheduler({ state, source: { jobs: async () => [job] }, owner: 'a', now: c.now, alerts });
  // Р-132 (шаг 27): повтор — не раньше периода работы (сутки), поэтому между попытками идут сутки, а не минута
  for (let i = 0; i < 3; i++) { await s.tick(); c.advance(86_400_000 + 60_000); }
  const [j] = await state.list();
  assert.deepEqual([j!.nextDueAt, j!.consecutiveFailures, j!.lastError], ['2026-09-17T00:30:00.000Z', 3, 'CLICKHOUSE_UNAVAILABLE: synthetic']);
  // Отставание за трое суток ожидаемо: проверяется алерт о провалах
  assert.deepEqual(alerts.alerts.filter((a) => a.code === 'SCHEDULER_JOB_FAILING').map((a) => [a.code, a.details?.error]), [['SCHEDULER_JOB_FAILING', 'CLICKHOUSE_UNAVAILABLE']]);
  assert.deepEqual((await state.runs()).map((r) => [r.outcome, r.errorCode]), [['FAILED', 'CLICKHOUSE_UNAVAILABLE'], ['FAILED', 'CLICKHOUSE_UNAVAILABLE'], ['FAILED', 'CLICKHOUSE_UNAVAILABLE']]);
  fail = false;
  await s.tick();
  assert.equal(done[0], '2026-09-17T00:30:00.000Z', 'the failed slot is not skipped');
});

test('Р-126: the job source gives each account only the jobs its channel supports; Amazon accounts share the getCompetitiveSummary pace', async () => {
  const noop = async () => 0;
  const deps: JobDeps = {
    accounts: async () => [
      { tenantId: '10000000-0000-4000-8000-000000000001', channelAccountId: '20000000-0000-4000-8000-000000000001', channel: 'KAUFLAND' },
      { tenantId: '10000000-0000-4000-8000-000000000002', channelAccountId: '20000000-0000-4000-8000-000000000002', channel: 'AMAZON' },
      { tenantId: '10000000-0000-4000-8000-000000000003', channelAccountId: '20000000-0000-4000-8000-000000000003', channel: 'AMAZON' },
    ],
    descriptorOf: (ch) => (ch === 'KAUFLAND' ? KAUFLAND_DESCRIPTOR : ch === 'AMAZON' ? AMAZON_DESCRIPTOR : null),
    pipelineFor: () => { throw new Error('not called'); },
    exportDay: async (range) => ({ range, exports: [], unverified: [], missing: [] }),
    exportBacklog: async () => [],
    forceDroppedSince: async () => [],
    maintenance: { closePriceDays: noop, correctClosedPriceDays: noop, ensurePartitions: async () => undefined, dropExpiredPartitions: noop, deleteExpiredRows: noop, databaseNow: async () => '2026-09-17T10:00:00.000Z' },
  };
  const specs = await jobSource(deps).jobs('2026-09-17T10:00:00.000Z');
  const byAccount = (id: string) => specs.filter((s) => s.scope?.channelAccountId === id).map((s) => `${s.name}/${s.intervalSeconds}`).sort();
  assert.deepEqual(specs.filter((s) => !s.scope).map((s) => s.name).sort(), ['analytics-export-day', 'partitions', 'price-days-close', 'retention']);
  // Kaufland: buy_box_changed — ранний доступ, сверки нет по умолчанию; опрос и проверка остановки выборкой есть
  assert.deepEqual(byAccount('20000000-0000-4000-8000-000000000001'), ['competitor-poll/60', 'halt-review/300', 'offer-discovery/86400']);
  // Amazon: опроса для решения нет [AMZ_C07], остановка снимается только человеком [Р-119]; сверка по кругу — 31 с × 2 аккаунта (0.033 rps = 30,3 с)
  assert.deepEqual(byAccount('20000000-0000-4000-8000-000000000002'), ['amazon-reconcile-rotation/62', 'notification-loss-review/300', 'offer-discovery/86400']);
  const withPush = await jobSource({ ...deps, reconcileEnabled: () => true }).jobs('2026-09-17T10:00:00.000Z');
  assert.ok(withPush.some((s) => s.name === 'notification-loss-review' && s.scope?.channelAccountId === '20000000-0000-4000-8000-000000000001'),
    'Kaufland reconciliation is switched on per account when early access to buy_box_changed is granted');
});

test('Р-124: neither channel snapshot has a price history operation — the descriptors say so and completeness counts from connection', () => {
  const vendor = new URL('../../../vendor/', import.meta.url);
  const kaufland = JSON.parse(readFileSync(new URL('kaufland/seller-api-v2/2026-09-14/openapi.json', vendor), 'utf8')) as { paths: Record<string, unknown> };
  assert.deepEqual(Object.keys(kaufland.paths).filter((p) => /histor/i.test(p)), []);
  const models = new URL('amazon/sp-api-models/2026-09-16/models/', vendor);
  const amazonHistoryPaths = readdirSync(models, { recursive: true }).filter((f) => String(f).endsWith('.json'))
    .flatMap((f) => Object.keys((JSON.parse(readFileSync(new URL(String(f), models), 'utf8')) as { paths?: Record<string, unknown> }).paths ?? {}).filter((p) => /histor/i.test(p)));
  assert.deepEqual(amazonHistoryPaths, []);
  assert.deepEqual([KAUFLAND_DESCRIPTOR.priceHistory.kind, AMAZON_DESCRIPTOR.priceHistory.kind], ['UNAVAILABLE', 'UNAVAILABLE']);
});

test('review of step 25, findings 1 and 7: call deadlines count from the job start; channel failures raise an alert; one failed export day does not hold the slot', async () => {
  const noop = async () => 0;
  const seen: Array<{ deadline: string }> = [];
  const exported: string[] = [];
  const deps: JobDeps = {
    accounts: async () => [{ tenantId: '10000000-0000-4000-8000-000000000001', channelAccountId: '20000000-0000-4000-8000-000000000001', channel: 'KAUFLAND' }],
    descriptorOf: (ch) => (ch === 'KAUFLAND' ? KAUFLAND_DESCRIPTOR : null),
    pipelineFor: () => ({
      pollDueCompetitors: async (ctx: { deadline: string }) => {
        seen.push({ deadline: ctx.deadline });
        return { candidates: 10, due: 10, snapshots: [], failures: Array.from({ length: 3 }, () => ({ query: {}, error: { code: 'TIMEOUT' } })), processingFailed: 0, plan: { coldTierExceedsBudget: false, demoted: 0 } };
      },
      reviewHalts: async () => [], discoverOffers: async () => ({ offers: 0, recorded: 0, withChannelPricing: [] }),
    }) as never,
    exportDay: async (range, groups) => {
      if (range.from.startsWith('2026-09-15')) throw new Error('CLICKHOUSE_CONSTRAINT: synthetic permanent failure');
      exported.push(`${range.from.slice(0, 10)}:${(groups ?? []).join('+')}`);
      return { range, exports: [], unverified: [], missing: [] };
    },
    exportBacklog: async () => [{ group: 'WRITES', range: { from: '2026-09-15T00:00:00.000Z', to: '2026-09-16T00:00:00.000Z' }, reason: 'NOT_EXPORTED' },
      { group: 'SNAPSHOTS', range: { from: '2026-09-14T00:00:00.000Z', to: '2026-09-15T00:00:00.000Z' }, reason: 'ROWS_CHANGED' }],
    forceDroppedSince: async () => [],
    maintenance: { closePriceDays: noop, correctClosedPriceDays: noop, ensurePartitions: async () => undefined, dropExpiredPartitions: noop, deleteExpiredRows: noop, databaseNow: async () => '2026-09-17T00:40:00.000Z' },
  };
  const c = clock('2026-09-17T00:40:00.000Z');
  const state = new MemorySchedulerState(c.now);
  const alerts = sink();
  const s = createScheduler({ state, source: jobSource(deps), owner: 'a', now: () => { const t = c.now(); c.advance(5_000); return t; }, alerts });
  await s.tick();
  const poll = (await state.runs()).find((r) => r.jobName === 'competitor-poll')!;
  // Срок вызова — начало запуска + 600 товаров / 10 rps + 60 с, а не начало такта + 50 с
  assert.equal(seen[0]!.deadline, new Date(Date.parse(poll.startedAt) + 120_000).toISOString());
  assert.equal(poll.items, 7);
  assert.ok(alerts.alerts.some((a) => a.code === 'COMPETITOR_POLL_FAILURES' && a.details?.channelFailures === 3));
  // Сутки 15.09 проваливаются постоянно — сутки слота (16.09) и отстающая группа снимков 14.09 выгружены, слот продвинут, алерт о провале
  assert.deepEqual(exported.sort(), ['2026-09-14:SNAPSHOTS', '2026-09-16:DECISIONS', '2026-09-16:SNAPSHOTS', '2026-09-16:WRITES']);
  const exportJob = (await state.list()).find((j) => j.jobName === 'analytics-export-day')!;
  assert.deepEqual([exportJob.lastOutcome, exportJob.nextDueAt], ['SUCCEEDED', '2026-09-18T00:30:00.000Z']);
  assert.ok(alerts.alerts.some((a) => a.code === 'ANALYTICS_EXPORT_FAILED' && String(a.details?.failed).startsWith('WRITES@2026-09-15')));
  assert.ok(alerts.alerts.some((a) => a.code === 'ANALYTICS_EXPORT_BACKLOG'));
});

test('review of step 25, finding 6: a lease lost during a run does not stop the other jobs of the tick', async () => {
  const c = clock('2026-09-17T10:00:00.000Z');
  const state = new MemorySchedulerState(c.now);
  const ran: string[] = [];
  const stolen = spec({ name: 'stolen', run: async () => { state.jobs.get('stolen')!.leaseOwner = 'other'; ran.push('stolen'); return { items: 0 }; } });
  const next = spec({ name: 'next', run: async () => { ran.push('next'); return { items: 0 }; } });
  const alerts = sink();
  const report = await createScheduler({ state, source: { jobs: async () => [stolen, next] }, owner: 'a', now: c.now, alerts }).tick();
  assert.deepEqual([ran, report.lostLeases], [['stolen', 'next'], ['stolen']]);
  assert.ok(alerts.alerts.some((a) => a.code === 'SCHEDULER_LEASE_LOST'));
});

test('Р-132 (шаг 27): провалившаяся работа повторяется с растущей паузой, не короче своего периода', async () => {
  // Пауза: период, затем удвоение на каждый следующий провал подряд, не дольше суток
  assert.deepEqual([1, 2, 3, 4].map((f) => retryDelaySeconds(60, f)), [60, 120, 240, 480]);
  assert.equal(retryDelaySeconds(86_400, 1), 86_400, 'суточная работа повторяется не раньше следующих суток');
  assert.equal(retryDelaySeconds(3_600, 10), RETRY_BACKOFF_CAP_SECONDS, 'пауза не растёт дольше суток');
  const c = clock('2026-09-18T10:00:00.000Z');
  const state = new MemorySchedulerState(c.now);
  let attempts = 0;
  const failing = spec({ name: 'failing', intervalSeconds: 60, run: async () => { attempts++; throw new Error('CHANNEL_DOWN: synthetic'); } });
  const s = createScheduler({ state, source: { jobs: async () => [failing] }, owner: 'a', now: c.now, alerts: sink() });
  await s.tick();
  assert.equal(attempts, 1);
  // Такт через 30 секунд: пауза после первого провала — период работы (60 с), повтора нет
  c.advance(30_000);
  await s.tick();
  assert.equal(attempts, 1, 'провалившаяся работа не повторяется каждым тактом');
  c.advance(31_000);
  await s.tick();
  assert.equal(attempts, 2, 'повтор — после паузы в период работы');
  // Второй провал подряд удваивает паузу: через 70 секунд ещё рано
  c.advance(70_000);
  const report = await s.tick();
  assert.equal(attempts, 2, 'после второго провала пауза 120 с');
  assert.equal(report.nextDueAt, '2026-09-18T10:03:01.000Z', 'процесс просыпается к концу паузы, а не раньше');
});
