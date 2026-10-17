import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, test } from 'node:test';
import type { ImportRunInput, MemorySeedScope } from '@repracer/pricing-pipeline';
import { inTenant, PgPricingStore, PgStockStore, seedPricingWorld, type PgPool, type SeededPricingWorld } from '../src/index.ts';
import { createIsolatedDatabase, type IsolatedDatabase } from './isolated-db.ts';

/**
 * Шаг 99 [Р-224, Р-225] в базе. Журнал импортов пишет только задание, которое сейчас идёт, и только своего вида; автора и длительность
 * ставит база; применённый импорт не бывает с отклонёнными строками. Применение сверяет данные с примеркой и при изменении не применяет
 * ничего — у себестоимости, границ с минимальной маржой, стратегий и остатков. Минимальная маржа многих предложений — со вторым
 * фактором, как границы. Файл задания бывает XLSX: сумма — по байтам книги. Каждая проверка — своя, с причиной отказа [Р-94, Р-99].
 * Данные синтетические.
 */

const ACCOUNT = '20000000-0000-4000-8000-000000000991';
const TENANT = '10000000-0000-4000-8000-000000000991';

let db: IsolatedDatabase;
let admin: PgPool;
let worker: PgPool;
let world: SeededPricingWorld;
let store: PgPricingStore;
let stock: PgStockStore;

function scope(n: number): MemorySeedScope {
  return {
    writeScopeId: `ws-${n}`, productId: `prod-${n}`, channelAccountId: ACCOUNT, marketplace: 'de', externalUnitId: String(9900 + n),
    channelProductRef: `99228${n}`, condition: 'new', currency: 'EUR', basis: 'GROSS', pricingMode: 'OFF', strategy: null,
    currentPriceMinor: 1900, minPrice: { amountMinor: 1000, id: `min-${n}` }, maxPrice: { amountMinor: 5000, id: `max-${n}` },
  };
}

before(async () => {
  db = await createIsolatedDatabase('imports99');
  const pool = db.pool('svc_app');
  admin = db.pool('svc_admin', 3);
  worker = db.pool('svc_bulk_worker', 2);
  world = await seedPricingWorld(pool, {
    provisioningPool: db.pool('svc_provisioning', 1), adminPool: admin, fixtureTenantId: TENANT, fixtureChannelAccountId: ACCOUNT,
    marketplaces: ['de'], clock: new Date().toISOString(), seed: { scopes: [1, 2, 3, 4, 5, 6].map(scope) },
  });
  store = new PgPricingStore(pool, { adminPool: admin, bulkWorkerPool: worker });
  stock = new PgStockStore({ adminPool: admin, stockPool: db.pool('svc_stock', 1) });
});
after(async () => {
  await db.drop();
});

const owner = (mfa = true) => ({ membershipId: world.ownerMembershipId, userId: world.userId, mfa });
const SHA = createHash('sha256').update('file').digest('hex');
const run = (over: Partial<ImportRunInput> = {}): ImportRunInput => ({
  kind: 'COSTS', outcome: 'CHECKED', fileName: 'costs.csv', fileSha256: SHA, rowsTotal: 3, rowsChanged: 2, rowsUnchanged: 1, rowsRejected: 0, ...over,
});

/** Задание, взятое в работу: строку журнала пишет только оно и только пока идёт */
async function running(kind: 'IMPORT_CHECK' | 'COST_IMPORT' | 'BOUNDS_EDIT' | 'IMPORT_TEMPLATE' | 'PRICE_EVIDENCE', params: Record<string, unknown>, owner = 'imports99-worker') {
  const created = await store.createBulkJob(world.tenantId, { kind, params }, { membershipId: world.ownerMembershipId, userId: world.userId, mfa: true });
  assert.equal(created.status, 'CREATED', JSON.stringify(created));
  const claimed = await store.claimBulkJob(world.tenantId, owner, 60);
  assert.equal(claimed?.jobId, (created as { jobId: string }).jobId, 'задание взято в работу');
  return claimed!;
}
const finish = (jobId: string, owner = 'imports99-worker') => store.finishBulkJob(world.tenantId, jobId, owner, { status: 'SUCCEEDED', result: {} });
const outcome = (p: Promise<unknown>) => p.then(() => 'accepted', (e: unknown) => String(e instanceof Error ? e.message : e));

/** Строка журнала прямой вставкой административной ролью — от имени задания `job`; `named` — задание, которое назвало себя базе */
const insertRun = (job: string, over: Record<string, unknown> = {}, named = job) => outcome(inTenant(admin, world.tenantId, (tx) => tx.query(
  `INSERT INTO tenant_data.import_run (tenant_id, kind, outcome, reason, file_name, file_sha256, rows_total, rows_changed, rows_unchanged, rows_rejected,
                                       duration_ms, bulk_job_id, created_by_membership_id, created_by_user_id)
   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
  [world.tenantId, over.kind ?? 'COSTS', over.outcome ?? 'CHECKED', over.reason ?? null, over.file_name ?? 'costs.csv', over.file_sha256 ?? SHA,
    over.rows_total ?? 3, over.rows_changed ?? 2, over.rows_unchanged ?? 1, over.rows_rejected ?? 0, over.duration_ms ?? 0, job,
    over.membership ?? world.ownerMembershipId, over.user ?? world.userId]), world.userId, { mfa: false, bulkJobId: named }));

test('step 99 (Р-224): the import journal is written only by its own job while it runs', async () => {
  const job = await running('IMPORT_CHECK', { importKind: 'COSTS' });
  const other = await running('IMPORT_CHECK', { importKind: 'COSTS' }, 'imports99-other');
  assert.match(await insertRun(job.jobId, {}, other.jobId), /written by its own bulk job while it runs/, 'a job writes no run of another job');
  assert.equal(await insertRun(job.jobId), 'accepted', 'the running check writes its run');
  await finish(other.jobId, 'imports99-other');
  assert.match(await insertRun(other.jobId), /written by its own bulk job while it runs/, 'a finished job writes no import run');
  await finish(job.jobId);
});

test('step 99 (Р-224): the run matches its job — a check writes CHECKED of its own import, an import apply writes APPLIED or REFUSED', async () => {
  const check = await running('IMPORT_CHECK', { importKind: 'STOCK' });
  assert.match(await insertRun(check.jobId, { kind: 'COSTS' }), /does not match its bulk job/, 'a check of stock writes no unit-cost run');
  assert.match(await insertRun(check.jobId, { kind: 'STOCK', outcome: 'APPLIED', rows_rejected: 0 }), /does not match its bulk job/, 'a check writes no APPLIED run');
  await finish(check.jobId);
  // Задание правки границ каталога (экран различий) — не импорт: у него нет примерки, и «применено» в журнал импортов оно не пишет
  const plan = await running('BOUNDS_EDIT', { planJobId: 'none' });
  assert.match(await insertRun(plan.jobId, { kind: 'BOUNDS', outcome: 'APPLIED' }), /does not match its bulk job/, 'a catalog bounds edit writes no import run');
  await finish(plan.jobId);
  const apply = await running('COST_IMPORT', { checkJobId: 'some-check', checkToken: 't' });
  assert.match(await insertRun(apply.jobId, { kind: 'BOUNDS', outcome: 'APPLIED' }), /does not match its bulk job/, 'a unit-cost apply writes no bounds run');
  assert.match(await insertRun(apply.jobId, { kind: 'COSTS', outcome: 'NOTED' }), /does not match its bulk job/, 'an outcome outside the list is refused');
  assert.equal(await insertRun(apply.jobId, { kind: 'COSTS', outcome: 'REFUSED', reason: 'DATA_CHANGED' }), 'accepted', 'the apply writes its refusal');
  await finish(apply.jobId);
  // Задание чужого вида, назвавшее в параметрах примерку: сопоставление вида даёт NULL, и `IF NOT NULL` не срабатывало бы
  const evidence = await running('PRICE_EVIDENCE', { checkJobId: 'some-check' });
  assert.match(await insertRun(evidence.jobId, { kind: 'COSTS', outcome: 'APPLIED' }), /does not match its bulk job/, 'a job of another kind writes no run even if it names a check');
  await finish(evidence.jobId);
});

test('step 99 (Р-224, Р-90): the database sets the author and the duration of a run, not the caller', async () => {
  const job = await running('IMPORT_CHECK', { importKind: 'COSTS' });
  const r = await store.recordImportRun(world.tenantId, run(), { ...owner(false), bulkJobId: job.jobId });
  assert.deepEqual([r.createdByMembershipId, r.createdByUserId], [world.ownerMembershipId, world.userId]);
  await finish(job.jobId);
  const second = await running('IMPORT_CHECK', { importKind: 'COSTS' });
  await insertRun(second.jobId, { duration_ms: 99_999_999, membership: world.ids.dbId('membership-operator'), user: world.ids.dbId('user-operator') });
  const [stored] = await db.rows<{ duration_ms: number; membership: string }>(
    `SELECT duration_ms, created_by_membership_id::text AS membership FROM tenant_data.import_run WHERE bulk_job_id = $1`, [second.jobId]);
  assert.ok(stored!.duration_ms < 600_000, `the duration is counted by the database from the job, not declared: ${stored!.duration_ms}`);
  assert.equal(stored!.membership, world.ownerMembershipId, 'the author is the creator of the job, not the caller');
  await finish(second.jobId);
  // Одна строка на задание: повтор задания не пишет вторую — хранилище возвращает записанную
  const third = await running('IMPORT_CHECK', { importKind: 'COSTS' });
  const once = await store.recordImportRun(world.tenantId, run(), { ...owner(false), bulkJobId: third.jobId });
  const twice = await store.recordImportRun(world.tenantId, run({ rowsChanged: 1, rowsUnchanged: 2 }), { ...owner(false), bulkJobId: third.jobId });
  assert.equal(twice.runId, once.runId, 'a job writes one run');
  await finish(third.jobId);
});

test('step 99 (Р-224): the values of a run are checked by the database', async () => {
  const check = await running('IMPORT_CHECK', { importKind: 'NOT_A_KIND' });
  assert.match(await insertRun(check.jobId, { kind: 'NOT_A_KIND' }), /import_run_kind_known/, 'an import kind outside the list is refused');
  await finish(check.jobId);
  const job = await running('COST_IMPORT', { checkJobId: 'c', checkToken: 't' });
  const refused = (over: Record<string, unknown>) => insertRun(job.jobId, { outcome: 'REFUSED', reason: 'DATA_CHANGED', ...over });
  assert.match(await refused({ reason: null }), /import_run_reason_only_refused/, 'a refusal names its reason');
  assert.match(await refused({ reason: 'data changed' }), /import_run_reason_only_refused/, 'a reason is a code');
  assert.match(await refused({ file_name: '' }), /import_run_file_name_length/, 'a run names its file');
  assert.match(await refused({ file_sha256: 'abc' }), /import_run_file_sha256_form/, 'the checksum of the file is a SHA-256');
  assert.match(await refused({ rows_rejected: -1, rows_unchanged: 2 }), /import_run_rows_non_negative/, 'row counts are not negative');
  assert.match(await refused({ rows_total: 9 }), /import_run_rows_add_up/, 'changed, unchanged and rejected rows add up to the rows of the file');
  // Частично-молчаливых применений не бывает: «применено» с отклонёнными строками или без изменений база не принимает
  assert.match(await insertRun(job.jobId, { outcome: 'APPLIED', rows_rejected: 1, rows_unchanged: 0 }), /import_run_applied_whole/, 'an applied import had no rejected rows');
  assert.match(await insertRun(job.jobId, { outcome: 'APPLIED', rows_changed: 0, rows_unchanged: 3 }), /import_run_applied_whole/, 'an applied import changed something');
  assert.match(await insertRun(job.jobId, { outcome: 'CHECKED', reason: 'DATA_CHANGED' }), /does not match its bulk job|import_run_reason_only_refused/);
  // Одна строка на задание — и прямой вставкой тоже: повтор применения после падения процесса не пишет второе «применено»
  assert.equal(await refused({}), 'accepted');
  assert.match(await refused({}), /import_run_one_per_job/, 'a job writes one run (the database)');
  await finish(job.jobId);
});

test('step 99 (Р-143): a check needs no right to change prices, but cancelling another member\'s check does', async () => {
  const inventory = { membershipId: world.ids.dbId('membership-inventory-manager'), userId: world.ids.dbId('user-inventory-manager'), mfa: false };
  const own = await store.createBulkJob(world.tenantId, { kind: 'IMPORT_CHECK', params: { importKind: 'STOCK' } }, inventory);
  assert.equal(own.status, 'CREATED', 'an inventory manager creates a check of a stock file');
  if (own.status === 'CREATED') assert.equal(await store.cancelBulkJob(world.tenantId, own.jobId, inventory), 'CANCELLED', 'one\'s own check is cancelled');
  const owners = await store.createBulkJob(world.tenantId, { kind: 'IMPORT_CHECK', params: { importKind: 'COSTS' } }, owner(true));
  assert.equal(owners.status, 'CREATED');
  const jobId = (owners as { jobId: string }).jobId;
  assert.equal(await store.cancelBulkJob(world.tenantId, jobId, inventory), 'FORBIDDEN', 'an inventory manager does not cancel another member\'s check');
  assert.equal(await store.cancelBulkJob(world.tenantId, jobId, owner(true)), 'CANCELLED');
});

test('step 99 (Р-135): minimum margins of more than one offer in one transaction need a second factor', async () => {
  const margins = (ids: readonly string[], mfa: boolean) => outcome(inTenant(admin, world.tenantId, (tx) => tx.query(
    `INSERT INTO tenant_data.guardrail (tenant_id, scope_type, write_scope_id, min_margin_bp, version, created_by_membership_id)
     SELECT $1, 'WRITE_SCOPE', i.id, 1500,
            (SELECT coalesce(max(g.version), 0) + 1 FROM tenant_data.guardrail g WHERE g.tenant_id = $1 AND g.scope_type = 'WRITE_SCOPE' AND g.write_scope_id = i.id), $3
       FROM unnest($2::uuid[]) AS i(id)`,
    [world.tenantId, ids.map((id) => world.ids.dbId(id)), world.ownerMembershipId]), world.userId, { mfa }));
  assert.match(await margins(['ws-1', 'ws-2'], false), /minimum margins of 2 offers changed in one transaction without a second factor/,
    'a mass minimum-margin edit without a second factor is refused');
  assert.equal(await margins(['ws-1'], false), 'accepted', 'the margin of one offer needs no second factor [Р-144]');
  assert.equal(await margins(['ws-2', 'ws-3'], true), 'accepted', 'with a second factor many offers are accepted');
});

test('step 99: an XLSX file of a job is checked by the bytes of the workbook, not by its base64 text', async () => {
  const job = await running('IMPORT_TEMPLATE', { importKind: 'COSTS', format: 'xlsx' }, 'imports99-xlsx');
  const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]);
  const base64 = bytes.toString('base64');
  const save = (sha256: string) => outcome(store.saveBulkJobArtifact(world.tenantId, job.jobId, {
    fileName: 'unit-costs-template.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', content: base64, sha256, rows: 1,
  }, 'imports99-xlsx'));
  assert.match(await save(createHash('sha256').update(base64).digest('hex')), /does not match its content/, 'the checksum of the base64 text is not the checksum of the file');
  assert.equal(await save(createHash('sha256').update(bytes).digest('hex')), 'accepted', 'the checksum of the workbook bytes is accepted');
  await finish(job.jobId, 'imports99-xlsx');
});

test('step 99 (Р-224): an apply refuses and applies nothing when the data changed after the check — unit costs, bounds and margins, strategies, stock', async () => {
  const id = (n: number) => world.ids.dbId(`ws-${n}`);
  // Себестоимость: на примерке профиля не было, к применению его поставили
  const apply = await running('COST_IMPORT', { checkJobId: 'c', checkToken: 't' }, 'imports99-apply');
  const actor = { ...owner(false), bulkJobId: apply.jobId };
  const pre = await store.importCosts(world.tenantId, { sourceName: 'pre.csv', sourceFormat: 'CSV', fingerprint: 'fp-pre', skippedRows: 0,
    rows: [{ writeScopeId: id(4), unitCostMinor: 400, currency: 'EUR' }] }, owner(true), 'APPLY');
  assert.equal(pre.status, 'APPLIED');
  const stale = await store.importCosts(world.tenantId, { sourceName: 'f.csv', sourceFormat: 'CSV', fingerprint: 'fp-stale', skippedRows: 0, run: run({ outcome: 'APPLIED', rowsChanged: 1, rowsUnchanged: 0, rowsTotal: 1 }),
    rows: [{ writeScopeId: id(4), unitCostMinor: 999, currency: 'EUR', expected: { costProfileId: null, sellerFee: null } }] }, actor, 'APPLY');
  assert.deepEqual(stale, { status: 'CONFLICT', writeScopeId: id(4) }, 'a unit cost changed after the check is not overwritten');
  assert.equal(await store.importRunOfJob(world.tenantId, apply.jobId), null, 'a refused apply writes no APPLIED run');
  await finish(apply.jobId, 'imports99-apply');

  const bounds = await running('BOUNDS_EDIT', { checkJobId: 'c', checkToken: 't' }, 'imports99-bounds');
  const boundsActor = { ...owner(false), bulkJobId: bounds.jobId };
  const changed = await store.importBounds(world.tenantId, { rows: [{ writeScopeId: id(5), minMinor: 1100, expected: { minMinor: 999, maxMinor: 5000, minMarginBp: null } }] }, boundsActor);
  assert.deepEqual(changed, { status: 'CONFLICT', writeScopeId: id(5) }, 'bounds changed after the check are not overwritten');
  const applied = await store.importBounds(world.tenantId, {
    run: run({ kind: 'BOUNDS', outcome: 'APPLIED', rowsTotal: 2, rowsChanged: 2, rowsUnchanged: 0 }),
    rows: [
      { writeScopeId: id(5), minMinor: 1100, minMarginBp: 1200, expected: { minMinor: 1000, maxMinor: 5000, minMarginBp: null } },
      { writeScopeId: id(6), maxMinor: 4500, expected: { minMinor: 1000, maxMinor: 5000, minMarginBp: null } },
    ],
  }, boundsActor);
  assert.equal(applied.status, 'APPLIED', JSON.stringify(applied));
  assert.equal((applied as { run?: { outcome: string } }).run?.outcome, 'APPLIED', 'the journal row is written in the same transaction');
  const [g] = await db.rows<{ min_margin_bp: number; version: number }>(
    `SELECT min_margin_bp, version FROM tenant_data.guardrail WHERE write_scope_id = $1 ORDER BY version DESC LIMIT 1`, [id(5)]);
  assert.deepEqual([g!.min_margin_bp, g!.version], [1200, 1], 'the minimum margin is a new guardrail version of the offer');
  await finish(bounds.jobId, 'imports99-bounds');

  // Стратегии: к применению стратегию предложения поменял другой человек
  const strategies = await running('IMPORT_CHECK', { importKind: 'STRATEGY' }, 'imports99-strategy');
  const conflict = await store.importStrategies(world.tenantId, {
    assignments: [{ writeScopeId: id(3), strategyId: '00000000-0000-4000-8000-000000000000', version: 1 }],
    expected: [{ writeScopeId: id(3), strategyId: '00000000-0000-4000-8000-000000000001', version: 1 }],
  }, { ...owner(false), bulkJobId: strategies.jobId });
  assert.deepEqual(conflict, { status: 'CONFLICT', writeScopeId: id(3) }, 'a strategy changed after the check is not overwritten');
  await finish(strategies.jobId, 'imports99-strategy');

  // Остатки: на примерке пула не было, к применению в нём уже 5 штук
  const source = await stock.createStockSource(world.tenantId, { mode: 'INTERNAL_POOL', name: 'Warehouse' }, owner(true));
  assert.equal(source.status, 'CREATED');
  const sourceId = (source as { stockSourceId: string }).stockSourceId;
  const targets = await stock.stockImportTargets(world.tenantId, sourceId);
  assert.ok(Array.isArray(targets) && targets.length === 6, 'every product of the catalog is a target of the stock import');
  const product = (targets as Array<{ productId: string; onHand: number | null }>)[0]!;
  assert.equal(product.onHand, null, 'no pool yet');
  assert.equal((await stock.applyStockImport(world.tenantId, sourceId, { rows: [{ productId: product.productId, quantity: 5, expectedOnHand: null }] }, owner(true))).status, 'APPLIED');
  const again = await stock.applyStockImport(world.tenantId, sourceId, { rows: [{ productId: product.productId, quantity: 9, expectedOnHand: null }] }, owner(true));
  assert.deepEqual(again, { status: 'CONFLICT', productId: product.productId }, 'stock changed after the check is not overwritten');
});
