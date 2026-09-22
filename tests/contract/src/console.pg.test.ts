import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { messagesFor, type TraceStepKey } from '@repracer/console-model';
import { traceOf } from './console/streams.ts';
import { createPool } from '@repracer/pricing-store-pg';
import { buildStandWorlds, STAND_USERS, type LiveWorld } from './console/stand.ts';
import { pgStoreFactory } from './harness/pg-store.ts';

/**
 * Шаг 12, A: экран «почему эта цена» на данных PostgreSQL. Сценарии стенда прогоняются на настоящей базе, мир экранов
 * читается только через readConsoleState, объяснение — из слепка price_decision.explanation [Р-68]. Для каждого решения
 * с ценой из данных конкурентов пять шагов (снимок, проверка входов, якоря, стратегия, Gate) — не «нет данных»,
 * и совпадают по статусам с тем же сценарием на хранилище в памяти.
 */

const PG_URL = process.env.REPRACER_PG_URL;
const pool = PG_URL ? createPool(PG_URL, { max: 4, applicationName: 'repracer-console-pg' }) : null;
const scanPool = PG_URL ? createPool(PG_URL.replace('svc_app@', 'svc_dispatcher@'), { max: 2, applicationName: 'repracer-console-pg-dispatcher' }) : null;
const fxLoaderPool = PG_URL ? createPool(PG_URL.replace('svc_app@', 'svc_fx_loader@'), { max: 1, applicationName: 'repracer-console-pg-fx' }) : null;
// Р-90: остановки и снятия сценариев — административный сервис; тенанты — роль создания тенанта
const adminPool = PG_URL ? createPool(PG_URL.replace('svc_app@', 'svc_admin@'), { max: 2, applicationName: 'repracer-console-pg-admin' }) : null;
const provisioningPool = PG_URL ? createPool(PG_URL.replace('svc_app@', 'svc_provisioning@'), { max: 1, applicationName: 'repracer-console-pg-provisioning' }) : null;
// Р-84: без базы тест не пропускается, а падает
if (!pool) throw new Error('REPRACER_PG_URL is required: database tests do not skip (Р-84)');
const skip = false;

const FIVE: readonly TraceStepKey[] = ['SNAPSHOT', 'SANITY', 'ANCHORS', 'STRATEGY', 'GATE'];
const owner = STAND_USERS.find((u) => u.role === 'OWNER')!;
const en = messagesFor('en');
const onPg = (s: { world: { pricing?: unknown }; tags: string[] }) => !s.tags.includes('memory-only');

let pgWorlds: LiveWorld[] = [];
let memoryWorlds: LiveWorld[] = [];
before(async () => {
  if (!pool) return;
  pgWorlds = await buildStandWorlds({ filter: onPg, storeFactory: pgStoreFactory(pool, scanPool!, fxLoaderPool!, { adminPool: adminPool!, provisioningPool: provisioningPool! }) });
  memoryWorlds = await buildStandWorlds({ filter: onPg });
});

after(async () => {
  await pool?.end();
  await scanPool?.end();
  await fxLoaderPool?.end();
  await adminPool?.end();
  await provisioningPool?.end();
});

test('A, Р-68: on PostgreSQL every competitor-derived decision shows all five steps from the stored explanation', { skip }, async (t) => {
  let competitorDecisions = 0;
  let decisions = 0;
  for (const w of pgWorlds) {
    assert.deepEqual(w.failures, [], `${w.id}: the scenario must pass on PostgreSQL`);
    const world = await w.view(owner);
    for (const d of (await w.store.decisionPage(world.tenantId, { offset: 0, limit: 200 })).items) {
      decisions += 1;
      const trace = (await traceOf(w.store, world, d.decisionId, en))!;
      if (d.decisionClass === 'NO_OP') {
        assert.ok(d.noChangeReason && !d.explanation, `${w.id}: a NO_OP decision keeps only its reason code on PostgreSQL (Р-74)`);
        continue;
      }
      assert.ok(d.explanation, `${w.id}: decision without explanation on PostgreSQL`);
      assert.ok(!trace.gaps.some((g) => g.code === 'EXPLANATION_DICTIONARY_MISSING'), `${w.id}: an explanation refers to a missing dictionary entry`);
      if (!d.explanation.snapshot) continue;
      competitorDecisions += 1;
      const steps = new Map(trace.steps.map((s) => [s.key, s]));
      for (const key of FIVE) {
        const step = steps.get(key);
        assert.ok(step, `${w.id}: ${key} missing`);
        assert.notEqual(step.status, 'UNKNOWN', `${w.id}: ${key} says "no data" — ${step.summary}`);
      }
      assert.ok(d.snapshotRef, `${w.id}: the reference to the full snapshot is stored with the decision (18 months)`);
      assert.ok(steps.get('SANITY')!.items.length > 0, `${w.id}: sanity rules are listed`);
    }
  }
  t.diagnostic(`PostgreSQL worlds: ${pgWorlds.length}, decisions: ${decisions}, competitor-derived: ${competitorDecisions}`);
  assert.ok(competitorDecisions >= 10, `competitor-derived decisions on PostgreSQL: ${competitorDecisions}`);
});

test('A: the trace on PostgreSQL equals the trace on the memory store, step by step', { skip }, async () => {
  const shape = async (w: LiveWorld) => {
    const world = await w.view(owner);
    // Р-154: страница и одно решение — от хранилища; сравниваются и порядок страницы, и трасса каждого решения
    const items = (await w.store.decisionPage(world.tenantId, { offset: 0, limit: 200 })).items
      // Решения одного такта делят момент; идентификаторы в базе и в памяти разные — порядок внутри момента задаёт исход
      .sort((a, b) => a.writeScopeId.localeCompare(b.writeScopeId) || Date.parse(a.decidedAt) - Date.parse(b.decidedAt) || a.outcome.localeCompare(b.outcome));
    return Promise.all(items.map(async (d) => {
      const trace = (await traceOf(w.store, world, d.decisionId, en))!;
      return { scope: d.writeScopeId, outcome: d.outcome, steps: trace.steps.filter((s) => FIVE.includes(s.key)).map((s) => `${s.key}:${s.status}:${s.items.length}`) };
    }));
  };
  for (const pg of pgWorlds) {
    const memory = memoryWorlds.find((m) => m.id === pg.id)!;
    assert.deepEqual(await shape(pg), await shape(memory), pg.id);
  }
});
