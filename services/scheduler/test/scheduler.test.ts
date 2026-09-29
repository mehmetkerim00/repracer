import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { AMAZON_DESCRIPTOR } from '@repracer/amazon-adapter';
import { KAUFLAND_DESCRIPTOR } from '@repracer/kaufland-adapter';
import { createScheduler, INTERNAL_RETRY_BASE_SECONDS, INTERNAL_RETRY_CAP_SECONDS, JOB_CATALOG, jobSource, LeaseLostError, MemorySchedulerState, nextSlotAfter, type JobDeps, type JobSpec , retryDelaySeconds, RETRY_BACKOFF_CAP_SECONDS } from '../src/index.ts';

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
  name: 'job', scope: null, retryKind: 'CHANNEL', intervalSeconds: 60, catchUp: 'LATEST', firstDueAt: (n) => n, lagWarningSeconds: 600, lagCriticalSeconds: 3600, leaseSeconds: 60, ...over,
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

/** Синтетические аккаунты двух каналов: у источника работ спрашивают и состав работ, и их разметку [Р-126, Р-133] */
function jobDeps(): JobDeps {
  const noop = async () => 0;
  return {
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
    maintenance: { closePriceDays: noop, correctClosedPriceDays: noop, ensurePartitions: async () => undefined, dropExpiredPartitions: noop, deleteExpiredRows: noop, releaseExpiredReservations: noop, alertStaleConfirmedReservations: noop, databaseNow: async () => '2026-09-17T10:00:00.000Z' },
  };
}

test('Р-126: the job source gives each account only the jobs its channel supports; Amazon accounts share the getCompetitiveSummary pace', async () => {
  const deps = jobDeps();
  const specs = await jobSource(deps).jobs('2026-09-17T10:00:00.000Z');
  const byAccount = (id: string) => specs.filter((s) => s.scope?.channelAccountId === id).map((s) => `${s.name}/${s.intervalSeconds}`).sort();
  assert.deepEqual(specs.filter((s) => !s.scope).map((s) => s.name).sort(), ['analytics-export-day', 'partitions', 'price-days-close', 'retention']);
  // Kaufland: buy_box_changed — ранний доступ, сверки нет по умолчанию; опрос и проверка остановки выборкой есть
  // Шаг 47: пересчёт цен, не зависящих от конкурентов, — у каждого аккаунта (у eBay это единственный источник решений)
  assert.deepEqual(byAccount('20000000-0000-4000-8000-000000000001'), ['competitor-poll/60', 'halt-review/300', 'offer-discovery/3600', 'scheduled-recompute/900']);
  // Amazon: опроса для решения нет [AMZ_C07], остановка снимается только человеком [Р-119]; сверка по кругу — 31 с × 2 аккаунта (0.033 rps = 30,3 с)
  assert.deepEqual(byAccount('20000000-0000-4000-8000-000000000002'), ['amazon-reconcile-rotation/62', 'notification-loss-review/300', 'offer-discovery/3600', 'scheduled-recompute/900']);
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
    maintenance: { closePriceDays: noop, correctClosedPriceDays: noop, ensurePartitions: async () => undefined, dropExpiredPartitions: noop, deleteExpiredRows: noop, releaseExpiredReservations: noop, alertStaleConfirmedReservations: noop, databaseNow: async () => '2026-09-17T00:40:00.000Z' },
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

test('Р-133 (шаг 28): внутренняя работа повторяется через минуту, а не через свой период — растущая пауза от минуты до часа', async () => {
  // Суточная выгрузка в ClickHouse после отказа слоя повторяется через минуту, затем 2, 4, 8… минут, но не дольше часа
  assert.deepEqual([1, 2, 3, 4].map((f) => retryDelaySeconds(86_400, f, 'INTERNAL')), [60, 120, 240, 480]);
  assert.equal(retryDelaySeconds(86_400, 10, 'INTERNAL'), INTERNAL_RETRY_CAP_SECONDS, 'пауза внутренней работы не растёт дольше часа');
  assert.equal(INTERNAL_RETRY_BASE_SECONDS, 60);
  // Отказ слоя на четверть часа: внутренняя работа успевает попробовать несколько раз, а работа канала ждёт сутки
  const attemptsWithin = (seconds: number, kind: 'CHANNEL' | 'INTERNAL') => {
    let elapsed = 0;
    let attempts = 0;
    while (elapsed <= seconds) { attempts += 1; elapsed += retryDelaySeconds(86_400, attempts, kind); }
    return attempts;
  };
  assert.equal(attemptsWithin(900, 'INTERNAL'), 5, 'за 15 минут отказа — пять попыток (1 + 2 + 4 + 8 минут паузы)');
  assert.equal(attemptsWithin(900, 'CHANNEL'), 1, 'у работы канала попытка одна: следующая — через сутки');
  // Ревью шага 28, находка 15: «в каталоге есть четыре имени» — проверка ни о чём. Значение имеет РАЗМЕТКА каждой работы, которую
  // отдаёт источник работ: в канал ходят только те, у кого CHANNEL
  // Зависимости ПОЛНЫЕ: работы, которых нет без остатка или без сверки, иначе тихо выпали бы из проверки каталога
  const specs = await jobSource({
    ...jobDeps(), reconcileEnabled: () => true,
    stock: { syncOrders: async () => ({ lines: 0, created: 0, consumed: 0, released: 0, unknownOffers: 0, writes: 0 }) },
    // Шаг 36 [Р-156]: доставка алертов — работа каталога и появляется вместе со своей зависимостью
    alertDelivery: { deliver: async () => ({ immediate: 0, digests: 0, delivered: 0, failed: 0 }) },
    // Шаг 41 [Р-171]: недельный дайджест тени — так же: работа каталога появляется вместе со своей зависимостью
    shadowDigest: { send: async () => ({ letters: 0, quiet: 0, noRecipient: 0, failed: 0 }) },
    // Шаг 43 [Р-177]: проверка авторизаций ходит в конечную точку токенов канала — работа класса CHANNEL
    channelAuthorizations: { check: async () => ({ checked: 0, ok: 0, revoked: 0, transient: 0, platform: 0, platformChannels: [], suspiciousRevocations: 0, keyringFailures: 0 }) },
  }).jobs('2026-09-17T10:00:00.000Z');
  const kinds = new Map(specs.map((spec) => [spec.name, spec.retryKind]));
  assert.deepEqual([...kinds.keys()].sort(), [...JOB_CATALOG.map((j) => j.name)].sort(), 'у каждой работы каталога есть спецификация');
  const internal = [...kinds.entries()].filter(([, kind]) => kind === 'INTERNAL').map(([name]) => name).sort();
  assert.deepEqual(internal, ['alerts-deliver', 'analytics-export-day', 'notification-loss-review', 'partitions', 'price-days-close', 'retention', 'shadow-digest'],
    'внутренние — те, что ходят только в наши хранилища; остальные обращаются к каналу [Р-133]');
});

test('Р-25: работа удаления по сроку ОСВОБОЖДАЕТ резервации, у которых истёк TTL, и считает их в своём итоге', async () => {
  /**
   * Находка 13 ревью шага 35: функция освобождения существовала с шага 2, и её не звал никто — резервация Inbound API
   * висела бы вечно. Проверяется вызов и то, что освобождённые входят в число сделанного: иначе работа молчала бы о том,
   * что она что-то сделала, и провал вызова остался бы незаметным.
   */
  const calls: string[] = [];
  const deps = jobDeps();
  const specs = await jobSource({
    ...deps,
    maintenance: { ...deps.maintenance, dropExpiredPartitions: async () => 2, deleteExpiredRows: async () => 3,
      releaseExpiredReservations: async (now) => { calls.push(now); return 4; }, alertStaleConfirmedReservations: async () => 1 },
  }).jobs('2026-09-17T10:00:00.000Z');
  const retention = specs.find((spec) => spec.name === 'retention')!;
  const result = await retention.run({ now: '2026-09-17T10:00:00.000Z' } as never);
  assert.deepEqual(calls, ['2026-09-17T10:00:00.000Z'], 'работа зовёт освобождение по сроку с моментом запуска');
  assert.equal(result.items, 10, 'сделанное — секции, строки, освобождённые резервации и алерты о зависших: 2 + 3 + 4 + 1');
});

test('Р-25 (прогон суток шага 35): окно чтения заказов считается от последнего УСПЕШНОГО запуска, а не от любого', async () => {
  /**
   * Такт, провалившийся на бюджете канала, уносил с собой своё окно: заказы этих минут не становились резервациями
   * вовсе (358 резерваций на 360 заказов в прогоне суток). Окно берётся от последнего успеха и ещё интервал назад —
   * строка на границе попадёт дважды, и это безвредно: резервация одна на строку заказа.
   */
  const windows: string[] = [];
  const deps = jobDeps();
  const specs = await jobSource({
    ...deps, reconcileEnabled: () => true,
    stock: { syncOrders: async (_a, _ctx, since) => { windows.push(since); return { lines: 0, created: 0, consumed: 0, released: 0, unknownOffers: 0, writes: 0 }; } },
  }).jobs('2026-09-17T10:00:00.000Z');
  const orderLines = specs.find((spec) => spec.name === 'order-lines')!;
  const run = (previousSucceededAt: string | null, previousFinishedAt: string | null) =>
    orderLines.run({ startedAt: '2026-09-17T10:30:00.000Z', previousSucceededAt, previousFinishedAt } as never);
  // Успех был в 10:00, провал — в 10:25: окно идёт от 10:00 минус период работы (5 минут), а не от 10:25
  await run('2026-09-17T10:00:00.000Z', '2026-09-17T10:25:00.000Z');
  // Успеха не было вовсе: окно — от начала запуска минус период
  await run(null, '2026-09-17T10:25:00.000Z');
  assert.deepEqual(windows, ['2026-09-17T09:55:00.000Z', '2026-09-17T10:25:00.000Z']);
});

test('ревью шага 53, находка 3: повтор курсора в заказах — прочитанное записано, а запуск провален, и окно следующего не сдвигается', async () => {
  const windows: string[] = [];
  const deps = jobDeps();
  const specs = await jobSource({
    ...deps, reconcileEnabled: () => true,
    stock: { syncOrders: async (_a, _ctx, since) => { windows.push(since); return { lines: 3, created: 3, consumed: 0, released: 0, unknownOffers: 0, writes: 0, cursorRepeated: true }; } },
  }).jobs('2026-09-17T10:00:00.000Z');
  const orderLines = specs.find((spec) => spec.name === 'order-lines')!;
  await assert.rejects(orderLines.run({ startedAt: '2026-09-17T10:30:00.000Z', previousSucceededAt: '2026-09-17T10:00:00.000Z', previousFinishedAt: null } as never),
    /CHANNEL_PAGE_CURSOR_REPEATED/, 'a repeated cursor fails the run — a success would move the window past the unread pages');
  assert.deepEqual(windows, ['2026-09-17T09:55:00.000Z'], 'the lines were read from the kept window (the store records them before the failure)');
});

test('шаг 56 (ревью шага 54, находка 8): чтение заказов, упёршееся в предел страниц, — место записано, следующий заход продолжает то же окно; без хранилища места окно держится', async () => {
  const calls: Array<{ since: string; cursor: string | undefined }> = [];
  let saved: { since: string; cursor: string | null } | null = null;
  let page = 0;
  const deps = jobDeps();
  const specs = await jobSource({
    ...deps, reconcileEnabled: () => true,
    stock: {
      syncOrders: async (_a, _ctx, since, options) => {
        calls.push({ since, cursor: options?.cursor });
        page += 1;
        return { lines: 20_000, created: 0, consumed: 0, released: 0, unknownOffers: 0, writes: 0, ...(page === 1 ? { pageLimit: { pages: 200, nextCursor: 'cursor-201' } } : {}) };
      },
      positions: { get: async () => saved, save: async (_a, position) => { saved = position; } },
    },
  }).jobs('2026-09-17T10:00:00.000Z');
  const orderLines = specs.find((spec) => spec.name === 'order-lines')!;
  const first = await orderLines.run({ startedAt: '2026-09-17T10:30:00.000Z', previousSucceededAt: '2026-09-17T10:00:00.000Z', previousFinishedAt: null } as never);
  assert.deepEqual(saved, { since: '2026-09-17T09:55:00.000Z', cursor: 'cursor-201' }, 'the place is recorded');
  assert.equal(first.alerts?.[0]?.code, 'ORDER_LINES_PAGE_LIMIT_REACHED');
  // Следующий заход — окно прошлого (не от нового успеха) с его курсора; дочитал — место снято
  await orderLines.run({ startedAt: '2026-09-17T10:35:00.000Z', previousSucceededAt: '2026-09-17T10:30:00.000Z', previousFinishedAt: null } as never);
  assert.deepEqual(calls[1], { since: '2026-09-17T09:55:00.000Z', cursor: 'cursor-201' });
  assert.equal(saved, null, 'the place is cleared once the window is read');
  // Хранилища места нет — успех сдвинул бы окно: запуск держит окно провалом без удвоения паузы
  const noStore = await jobSource({ ...jobDeps(), reconcileEnabled: () => true, stock: {
    syncOrders: async () => ({ lines: 20_000, created: 0, consumed: 0, released: 0, unknownOffers: 0, writes: 0, pageLimit: { pages: 200, nextCursor: 'c' } }) } }).jobs('2026-09-17T10:00:00.000Z');
  await assert.rejects(noStore.find((spec) => spec.name === 'order-lines')!.run({ startedAt: '2026-09-17T10:30:00.000Z', previousSucceededAt: null, previousFinishedAt: null } as never),
    /ORDER_LINES_PAGE_LIMIT_REACHED HOLD_WINDOW:/);
});

test('шаг 57–58 (ревью шага 56, находки 3–4; ревью шага 57, находка 2): курсор, который канал не принимает, снимается на третьем отказе подряд, петля курсора в продолжении — сразу; начало окна держится', async () => {
  const calls: Array<{ since: string; cursor: string | undefined }> = [];
  let saved: { since: string; cursor: string | null } | null = { since: '2026-09-17T09:00:00.000Z', cursor: 'expired-cursor' };
  let next: 'refuse' | 'loop' | 'ok' | 'interrupted' = 'refuse';
  const deps = jobDeps();
  const specs = await jobSource({
    ...deps, reconcileEnabled: () => true,
    stock: {
      syncOrders: async (_a, _ctx, since, options) => {
        calls.push({ since, cursor: options?.cursor });
        if (next === 'refuse') throw new Error('CHANNEL_REJECTED: cursor is not valid');
        if (next === 'interrupted') throw Object.assign(new Error('CHANNEL_UNAVAILABLE: order lines read interrupted after 40 lines'), { linesRecorded: 40, cursor: 'accepted-cursor' });
        return { lines: 5, created: 5, consumed: 0, released: 0, unknownOffers: 0, writes: 0, ...(next === 'loop' ? { cursorRepeated: true } : {}) };
      },
      positions: { get: async () => saved, save: async (_a, position) => { saved = position; } },
    },
  }).jobs('2026-09-17T10:00:00.000Z');
  const orderLines = specs.find((spec) => spec.name === 'order-lines')!;
  const run = (startedAt: string, consecutiveFailures = 0) => orderLines.run({ startedAt, previousSucceededAt: '2026-09-17T09:50:00.000Z', previousFinishedAt: null, consecutiveFailures } as never);
  // Шаг 58 (ревью шага 57, находка 2): первый и второй отказ курсор держат — разовый 5xx не отбрасывает заход к началу окна
  await assert.rejects(run('2026-09-17T09:55:00.000Z', 0), /CHANNEL_REJECTED/);
  await assert.rejects(run('2026-09-17T09:57:00.000Z', 1), /CHANNEL_REJECTED/);
  assert.deepEqual(saved, { since: '2026-09-17T09:00:00.000Z', cursor: 'expired-cursor' }, 'two failures keep the cursor');
  await assert.rejects(run('2026-09-17T10:00:00.000Z', 2), /CHANNEL_REJECTED/);
  assert.deepEqual(saved, { since: '2026-09-17T09:00:00.000Z', cursor: null }, 'the third failure in a row drops the cursor, the window start is kept');
  calls.splice(0, 2);
  next = 'loop';
  await assert.rejects(run('2026-09-17T10:05:00.000Z'), /CHANNEL_PAGE_CURSOR_REPEATED HOLD_WINDOW:/);
  assert.deepEqual(calls[1], { since: '2026-09-17T09:00:00.000Z', cursor: undefined }, 'the window is re-read from its start, without a cursor');
  assert.deepEqual(saved, { since: '2026-09-17T09:00:00.000Z', cursor: null }, 'a cursor loop in the continuation keeps the window start');
  next = 'ok';
  await run('2026-09-17T10:10:00.000Z');
  assert.deepEqual([calls[2]?.since, saved], ['2026-09-17T09:00:00.000Z', null], 'the window read to its end clears the place');
  // Отказ посреди чтения: прочитанное записано конвейером, место — последний принятый курсор
  next = 'interrupted';
  await assert.rejects(run('2026-09-17T10:15:00.000Z'), /interrupted/);
  assert.deepEqual(saved, { since: calls.at(-1)!.since, cursor: 'accepted-cursor' }, 'the next run continues from the last accepted cursor');
});

test('шаг 58 (ревью шага 56, находка 10): первое окно заказов — от подключения аккаунта, а не последние 5 минут; глубже суток — урезано с WARNING', async () => {
  const windows: string[] = [];
  const run = async (connectedAt: string | undefined, previousSucceededAt: string | null) => {
    const base = jobDeps();
    const specs = await jobSource({
      ...base, reconcileEnabled: () => true,
      accounts: async () => [{ tenantId: '10000000-0000-4000-8000-000000000001', channelAccountId: '20000000-0000-4000-8000-000000000001', channel: 'KAUFLAND', ...(connectedAt ? { connectedAt: connectedAt as never } : {}) }],
      stock: { syncOrders: async (_a, _ctx, since) => { windows.push(since); return { lines: 0, created: 0, consumed: 0, released: 0, unknownOffers: 0, writes: 0 }; } },
    }).jobs('2026-09-17T10:00:00.000Z');
    return specs.find((spec) => spec.name === 'order-lines')!.run({ startedAt: '2026-09-17T10:00:00.000Z', previousSucceededAt, previousFinishedAt: null } as never);
  };
  // Согласие в 08:00, первый заход в 10:00: окно — с 07:55, заказ 09:00 читается
  assert.deepEqual(await run('2026-09-17T08:00:00.000Z', null), { items: 0 });
  assert.equal(windows.at(-1), '2026-09-17T07:55:00.000Z', 'the first window reaches back to the connection');
  // Прошлый успех есть — окно от него, как прежде
  await run('2026-09-17T08:00:00.000Z', '2026-09-17T09:50:00.000Z');
  assert.equal(windows.at(-1), '2026-09-17T09:45:00.000Z');
  // Подключён неделю назад, успехов не было (работа появилась позже) — сутки, и это сказано
  const capped = await run('2026-09-10T08:00:00.000Z', null);
  assert.equal(windows.at(-1), '2026-09-16T10:00:00.000Z', 'not deeper than a day: an old shipped order is in the source stock already');
  assert.equal(capped.alerts?.[0]?.code, 'ORDER_LINES_FIRST_WINDOW_CAPPED');
});

test('ревью шага 54, находка 7: провал, держащий окно, повторяется в свой период — петля курсора канала не растягивает паузу до суток', async () => {
  const { dueOf, JobHoldsWindowError } = await import('../src/index.ts');
  const base = { jobKey: 'order-lines:a', jobName: 'order-lines', scope: 'ACCOUNT', catchUp: 'LATEST', retryKind: 'CHANNEL', intervalSeconds: 300,
    nextDueAt: '2026-09-17T10:05:00.000Z', lastFinishedAt: '2026-09-17T10:00:00.000Z', lastOutcome: 'FAILED', consecutiveFailures: 6 } as never;
  const held = new JobHoldsWindowError('CHANNEL_PAGE_CURSOR_REPEATED', 'order lines read 3').message;
  assert.equal(dueOf({ ...(base as object), lastError: held } as never), '2026-09-17T10:05:00.000Z', 'the next run keeps the 5-minute pace');
  // Шаг 57 (ревью шага 55, находка 9): код ошибки в журнале и алерте — причина, а не признак держания окна
  assert.match(held, /^CHANNEL_PAGE_CURSOR_REPEATED HOLD_WINDOW:/);
  assert.ok(Date.parse(dueOf({ ...(base as object), lastError: 'CHANNEL_PAGE_CURSOR_REPEATED: without the hold mark' } as never)) > Date.parse('2026-09-17T12:00:00.000Z'),
    'only the hold mark keeps the pace, not the cause code alone');
  assert.ok(Date.parse(dueOf({ ...(base as object), lastError: 'RATE_LIMITED: …' } as never)) > Date.parse('2026-09-17T12:00:00.000Z'),
    'an ordinary failure still backs off (Р-132)');
});

test('ревью шага 47, находка 5: пересчёт по расписанию — предел за заход передаётся, все должные упали — провал запуска (пауза Р-132), часть — WARNING', async () => {
  const outcomes: Array<{ scopes: number; changed: number; failed: number; firstError: string | null }> = [];
  const limits: Array<number | undefined> = [];
  const deps: JobDeps = { ...jobDeps(), pipelineFor: () => ({
    recomputeScheduled: async (_ctx: unknown, o: { limit?: number }) => { limits.push(o.limit); return outcomes.shift()!; },
  }) as never };
  const spec = (await jobSource(deps).jobs('2026-09-17T10:00:00.000Z')).find((s) => s.name === 'scheduled-recompute' && s.scope?.channelAccountId === '20000000-0000-4000-8000-000000000001')!;
  const run = () => spec.run({ now: '2026-09-17T10:00:00.000Z', startedAt: '2026-09-17T10:00:00.000Z', slotAt: '2026-09-17T10:00:00.000Z', runIndex: 0, previousSucceededAt: null } as never);
  outcomes.push({ scopes: 3, changed: 3, failed: 0, firstError: null });
  assert.deepEqual(await run(), { items: 3 });
  assert.deepEqual(limits, [1_000], 'предел заход — 1000 единиц');
  outcomes.push({ scopes: 4, changed: 1, failed: 2, firstError: 'Error' });
  const partial = await run();
  assert.deepEqual([partial.items, partial.alerts?.[0]?.code, partial.alerts?.[0]?.severity], [2, 'SCHEDULED_RECOMPUTE_FAILURES', 'WARNING']);
  outcomes.push({ scopes: 2, changed: 0, failed: 2, firstError: 'CONTEXT_LOAD_FAILED' });
  await assert.rejects(run(), /CONTEXT_LOAD_FAILED: all 2 due scopes failed/, 'все должные упали — запуск провален, а не «успех с нулём»');
  outcomes.push({ scopes: 0, changed: 0, failed: 0, firstError: null });
  assert.deepEqual(await run(), { items: 0 }, 'должных нет — пустой успешный запуск');
});
