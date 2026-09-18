import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, test } from 'node:test';
import { createPool } from '@repracer/pricing-store-pg';
import { createScheduler, LeaseLostError, PgSchedulerState, type JobSpec } from '../src/index.ts';

/**
 * Р-126 (шаг 25): состояние планировщика в PostgreSQL (0090) — роль svc_scheduler. Два процесса планировщика на одной базе: каждый слот
 * выполняется один раз; действующую аренду перехватить нельзя; итог чужой аренды не пишется. Нужна REPRACER_PG_URL [Р-84].
 */
const PG_URL = process.env.REPRACER_PG_URL;
if (!PG_URL) throw new Error('REPRACER_PG_URL is required: database tests do not skip (Р-84)');
const poolA = createPool(PG_URL.replace('svc_app@', 'svc_scheduler@'), { max: 4, applicationName: 'repracer-scheduler-test-a' });
const poolB = createPool(PG_URL.replace('svc_app@', 'svc_scheduler@'), { max: 4, applicationName: 'repracer-scheduler-test-b' });
after(async () => { await poolA.end(); await poolB.end(); });

const key = (name: string) => `${name}-${randomBytes(4).toString('hex').replace(/[0-9]/g, (d) => 'abcdefghij'[Number(d)]!)}`;
const sink = { alerts: [] as Array<{ code: string }>, raise: async (a: { code: string }) => { sink.alerts.push(a); } };

test('Р-126 on PostgreSQL: two scheduler processes run each missed daily slot exactly once', async () => {
  const name = key('pgtest-daily');
  const seen: string[] = [];
  let now = '2026-09-17T00:40:00.000Z';
  const job: JobSpec = {
    name, scope: null, retryKind: 'INTERNAL', intervalSeconds: 86_400, catchUp: 'EVERY_SLOT', firstDueAt: () => '2026-09-14T00:30:00.000Z', lagWarningSeconds: 999_999, lagCriticalSeconds: 9_999_999,
    leaseSeconds: 60, run: async ({ slotAt }) => { seen.push(slotAt); await new Promise((r) => setTimeout(r, 20)); return { items: 1 }; },
  };
  const a = createScheduler({ state: new PgSchedulerState(poolA), source: { jobs: async () => [job] }, owner: 'a', now: () => now, alerts: sink });
  const b = createScheduler({ state: new PgSchedulerState(poolB), source: { jobs: async () => [job] }, owner: 'b', now: () => now, alerts: sink });
  const [ra, rb] = await Promise.all([a.tick(), b.tick()]);
  assert.deepEqual([...seen].sort(), ['2026-09-14T00:30:00.000Z', '2026-09-15T00:30:00.000Z', '2026-09-16T00:30:00.000Z', '2026-09-17T00:30:00.000Z'], 'each slot once');
  assert.equal(ra.runs.length + rb.runs.length, 4);
  const runs = await new PgSchedulerState(poolA).runs(name);
  assert.deepEqual(runs.map((r) => r.slotAt).sort(), [...seen].sort(), 'every run is in the run log');
  now = '2026-09-17T12:00:00.000Z';
  await Promise.all([a.tick(), b.tick()]);
  assert.equal(seen.length, 4, 'nothing is due before the next slot');
});

test('Р-126 on PostgreSQL: a valid lease cannot be taken over; an expired lease can; the old owner cannot record its result', async () => {
  const state = new PgSchedulerState(poolA);
  const name = key('pgtest-lease');
  await state.ensure({ jobKey: name, jobName: name, scope: null, catchUp: 'LATEST', retryKind: 'INTERNAL', intervalSeconds: 60, firstDueAt: '2026-09-17T10:00:00.000Z', registeredAt: '2026-09-17T10:00:00.000Z' });
  const [one, two] = await Promise.all([state.claim(name, 'a', '2026-09-17T10:00:00.000Z', 1), state.claim(name, 'b', '2026-09-17T10:00:00.000Z', 1)]);
  assert.equal([one, two].filter(Boolean).length, 1, 'one of two concurrent claims wins');
  const winner = one ? 'a' : 'b';
  await assert.rejects(poolB.query(`UPDATE maintenance.scheduled_job SET lease_owner = 'intruder', lease_until = now() + interval '1 hour' WHERE job_key = $1`, [name]),
    /is leased by/, 'the database refuses a takeover of a valid lease');
  // Ревью шага 25, находка 6: освободить чужую действующую аренду, чтобы занять её вторым запросом, база тоже не даёт
  await assert.rejects(poolB.query(`UPDATE maintenance.scheduled_job SET lease_owner = NULL, lease_until = NULL WHERE job_key = $1`, [name]),
    /is released only by its owner/, 'the database refuses releasing a valid lease of another scheduler');
  await new Promise((r) => setTimeout(r, 1_100));
  assert.ok(await state.claim(name, 'c', '2026-09-17T10:00:00.000Z', 60), 'the lease of a crashed scheduler expires');
  const run = { jobKey: name, jobName: name, slotAt: '2026-09-17T10:00:00.000Z', owner: winner, startedAt: '2026-09-17T10:00:00.000Z', finishedAt: '2026-09-17T10:00:01.000Z',
    outcome: 'SUCCEEDED' as const, lagSeconds: 0, items: 0, errorCode: null };
  await assert.rejects(state.finish(name, winner, { outcome: 'SUCCEEDED', nextDueAt: '2026-09-17T10:01:00.000Z', coalesced: 0, error: null, run }), LeaseLostError);
  assert.equal((await state.runs(name)).length, 0, 'the lost lease wrote no run');
});

test('review of step 25, finding 6 on PostgreSQL: a run longer than its lease renews it — a second scheduler does not start the same job', async () => {
  const name = key('pgtest-long');
  let runs = 0;
  const job: JobSpec = {
    name, scope: null, retryKind: 'INTERNAL', intervalSeconds: 3600, catchUp: 'LATEST', firstDueAt: () => '2026-09-17T10:00:00.000Z', lagWarningSeconds: 999_999, lagCriticalSeconds: 9_999_999,
    leaseSeconds: 2, run: async () => { runs++; await new Promise((r) => setTimeout(r, 3_600)); return { items: 0 }; },
  };
  const now = () => '2026-09-17T10:00:00.000Z';
  const a = createScheduler({ state: new PgSchedulerState(poolA), source: { jobs: async () => [job] }, owner: 'a', now, alerts: sink });
  const b = createScheduler({ state: new PgSchedulerState(poolB), source: { jobs: async () => [job] }, owner: 'b', now, alerts: sink });
  const first = a.tick();
  await new Promise((r) => setTimeout(r, 2_800));
  const second = await b.tick();
  await first;
  assert.deepEqual([runs, second.skippedLeased], [1, [name]], 'the lease of the running job is renewed past its 2 s');
});

test('Риск 31 (шаг 26): срок работы сравнивается с часами базы — часы процесса, ушедшие вперёд, работу раньше срока не запускают', async () => {
  const state = new PgSchedulerState(poolA);
  const name = key('pgtest-dbclock');
  const dbNow = await state.databaseNow();
  const realNow = new Date();
  assert.ok(Math.abs(Date.parse(dbNow) - realNow.getTime()) < 60_000, 'часы базы — часы базы, а не строка процесса');
  let runs = 0;
  const job: JobSpec = {
    name, scope: null, retryKind: 'INTERNAL', intervalSeconds: 3600, catchUp: 'LATEST', firstDueAt: () => new Date(Date.parse(dbNow) + 30 * 60_000).toISOString(),
    lagWarningSeconds: 999_999, lagCriticalSeconds: 9_999_999, leaseSeconds: 60, run: async () => { runs++; return { items: 0 }; },
  };
  const scheduler = createScheduler({ state, source: { jobs: async () => [job] }, owner: 'db-clock', now: () => state.databaseNow(), alerts: sink });
  // Часы процесса ушли на час вперёд: срок работы — через 30 минут по часам базы
  const trueNow = Date.now;
  Date.now = () => trueNow() + 3_600_000;
  try {
    await scheduler.tick();
  } finally {
    Date.now = trueNow;
  }
  assert.equal(runs, 0, 'работа не запущена раньше срока базы');
  await poolA.query(`UPDATE maintenance.scheduled_job SET next_due_at = now() - interval '1 minute' WHERE job_key = $1`, [name]);
  await scheduler.tick();
  assert.equal(runs, 1, 'по часам базы срок наступил — работа выполнена');
  const [row] = (await state.list()).filter((j) => j.jobKey === name);
  assert.equal(row?.lagLevel, 'OK', 'уровень отставания хранится в базе');
});
