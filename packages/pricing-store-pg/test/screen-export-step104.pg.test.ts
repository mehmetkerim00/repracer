import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, test } from 'node:test';
import { inTenant, PgPricingStore, seedPricingWorld, type PgPool, type SeededPricingWorld } from '../src/index.ts';
import { createIsolatedDatabase, type IsolatedDatabase } from './isolated-db.ts';

/**
 * Шаг 104 [Р-229] на PostgreSQL — то, что держит база у выгрузки экрана (миграция 0201):
 *  (1) потолок: файл выгрузки экрана больше 50 000 строк база не сохраняет — отказ «narrow the period», а не обрезанный файл; ровно
 *      50 000 — сохраняет; файл другого вида (шаблон импорта) потолком выгрузки не ограничен;
 *  (2) аудит: каждый сохранённый файл выгрузки — событие аудита от имени человека, создавшего задание (кто, что — экран, формат, период и
 *      фильтры, — сколько строк); файл другого вида события выгрузки не пишет; журнал аудита — только на добавление.
 * Файл кладёт роль исполнителя заданий по живой аренде своего задания, как в работе (0113). Данные синтетические
 */

const ACCOUNT = '20000000-0000-4000-8000-000000000104';
const OWNER = 'step104-test-worker';

let db: IsolatedDatabase;
let world: SeededPricingWorld;
let store: PgPricingStore;
let admin: PgPool;

before(async () => {
  db = await createIsolatedDatabase('step104');
  const pool = db.pool('svc_app');
  admin = db.pool('svc_admin', 2);
  world = await seedPricingWorld(pool, { provisioningPool: db.pool('svc_provisioning', 1), adminPool: admin, fixtureTenantId: '10000000-0000-4000-8000-000000000104',
    fixtureChannelAccountId: ACCOUNT, marketplaces: ['de'], clock: new Date().toISOString(), seed: { scopes: [] } });
  store = new PgPricingStore(pool, { adminPool: admin, bulkWorkerPool: db.pool('svc_bulk_worker', 2) });
});
after(async () => { await db?.drop(); });

const actor = () => ({ membershipId: world.ownerMembershipId, userId: world.userId, mfa: false });
const outcome = async (p: Promise<unknown>) => { try { await p; return 'accepted'; } catch (e) { return (e as Error).message; } };
const file = (rows: number) => ({ fileName: 'export.csv', contentType: 'text/csv' as const, content: 'a\n', sha256: createHash('sha256').update('a\n').digest('hex'), rows });

/** Задание вида — создано человеком и взято исполнителем (живая аренда), как в работе */
async function running(kind: 'SCREEN_EXPORT' | 'IMPORT_TEMPLATE', params: Record<string, unknown>): Promise<string> {
  const created = await store.createBulkJob(world.tenantId, { kind, params }, actor());
  assert.equal(created.status, 'CREATED', JSON.stringify(created));
  const claimed = await store.claimBulkJob(world.tenantId, OWNER, 60);
  assert.equal(claimed?.jobId, (created as { jobId: string }).jobId, 'the job is claimed by the worker');
  return claimed!.jobId;
}
const finish = (jobId: string) => store.finishBulkJob(world.tenantId, jobId, OWNER, { status: 'SUCCEEDED', result: {} });
const exportEvents = async () => (await inTenant(admin, world.tenantId, (tx) => tx.query(
  `SELECT actor_type, actor_user_id, actor_membership_id, entity_id, changes FROM audit.audit_event
    WHERE tenant_id = $1 AND action = 'data_export.file_produced' ORDER BY recorded_at, audit_event_id`, [world.tenantId]), world.userId)).rows;

const EXPORT_PARAMS = {
  screen: 'decisions', format: 'xlsx', workspace: 'Synthetic store', exportedBy: 'Alex Porter', exportedAt: '2026-10-20T10:00:00.000Z', periodPart: '2026-10-13_2026-10-20',
  period: { since: '2026-10-13T04:00:00.000Z', until: null }, filters: { outcome: 'REJECTED' }, query: { decisions: { since: '2026-10-13T04:00:00.000Z', outcome: 'REJECTED' } },
};

test('step 104 [Р-229]: the database refuses a screen export file over 50 000 rows — «narrow the period»; exactly 50 000 is kept; another kind of file is not capped', async () => {
  const jobId = await running('SCREEN_EXPORT', EXPORT_PARAMS);
  assert.match(await outcome(store.saveBulkJobArtifact(world.tenantId, jobId, file(50_001), OWNER)), /a screen export of 50001 rows is over the limit of 50 000 rows: narrow the period/,
    'an export over the limit');
  assert.equal(await outcome(store.saveBulkJobArtifact(world.tenantId, jobId, file(50_000), OWNER)), 'accepted', 'exactly the limit');
  await finish(jobId);
  // Шаблон импорта — не выгрузка экрана: потолок выгрузки его не касается
  const template = await running('IMPORT_TEMPLATE', { importKind: 'COSTS', format: 'csv' });
  assert.equal(await outcome(store.saveBulkJobArtifact(world.tenantId, template, file(50_001), OWNER)), 'accepted', 'an import template is not capped');
  await finish(template);
});

test('step 104 [Р-229]: every saved export file is an audit event of the person who asked for it — what and how many rows; another kind of file is no export event', async () => {
  const before = (await exportEvents()).length;
  const jobId = await running('SCREEN_EXPORT', EXPORT_PARAMS);
  assert.equal(await outcome(store.saveBulkJobArtifact(world.tenantId, jobId, { ...file(37), fileName: 'synthetic-store-decisions-2026-10-13_2026-10-20.xlsx' }, OWNER)), 'accepted');
  await finish(jobId);
  const events = await exportEvents();
  assert.equal(events.length - before, 1, 'one event for one file');
  const e = events.at(-1)!;
  assert.equal(JSON.stringify([e.actor_type, e.actor_user_id, e.actor_membership_id, e.entity_id, e.changes.screen, e.changes.format, e.changes.rows, e.changes.fileName,
    e.changes.filters, e.changes.period?.since]),
  JSON.stringify(['USER', world.userId, world.ownerMembershipId, jobId, 'decisions', 'xlsx', 37, 'synthetic-store-decisions-2026-10-13_2026-10-20.xlsx',
    { outcome: 'REJECTED' }, '2026-10-13T04:00:00.000Z']), 'who, what and how many rows');
  // Файл шаблона импорта — не выгрузка: события выгрузки нет
  const template = await running('IMPORT_TEMPLATE', { importKind: 'COSTS', format: 'csv' });
  assert.equal(await outcome(store.saveBulkJobArtifact(world.tenantId, template, file(3), OWNER)), 'accepted');
  await finish(template);
  assert.equal((await exportEvents()).length - before, 1, 'an import template writes no export event');
});
