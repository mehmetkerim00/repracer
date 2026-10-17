import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { createHash } from 'node:crypto';
import { parseXlsx, readTable } from '@repracer/cost-import';
import { IMPORT_SCHEMAS, importDataRows, messagesFor, type BulkJobView, type ImportCheckView, type ImportHistoryView, type ProductListView } from '@repracer/console-model';
import { buildStandWorlds, memoryStandDirectory, STAND_ACCOUNTS, STAND_AUDIENCE, STAND_ISSUER, type LiveWorld } from '@repracer/contract-tests/stand';
import { createAuthenticator, staticJwks } from '@repracer/identity';
import { createTestIssuer } from '@repracer/identity/test-issuer';
import type { JobCreatedResponse, StandToken } from '../src/api-types.ts';
import { createStandApi } from '../server/stand-server.ts';
import { runJob } from './run-jobs.ts';

/**
 * Шаг 99 [Р-224, Р-225]: четыре импорта продавца одним путём — шаблон с текущими значениями, примерка, применение ровно примерки,
 * журнал. Стенд в памяти, вход и запросы — как у браузера через обработчик консоли; фоновые задания выполняет тот же обработчик,
 * что у исполнителя (`run-jobs.ts`).
 *
 * Красное сначала: «файл с ошибочной строкой не применяет ничего» и «изменение данных между примеркой и применением — отказ» написаны
 * до маршрутов импорта; прежний путь себестоимости применял сопоставленные строки и пропускал ошибочные (шаг 28: 8571 из 10 000), а
 * отпечаток предпросмотра не держал текущих значений — изменение между предпросмотром и применением перезаписывалось молча.
 */

// Мир с тремя предложениями, себестоимостью у всех и двумя стратегиями
const WORLD = 'kaufland/pipeline/mass-shift-halt';
const issuer = createTestIssuer({ issuer: STAND_ISSUER, audience: STAND_AUDIENCE });
let handle: ReturnType<typeof createStandApi>;
let worlds: LiveWorld[] = [];

before(async () => {
  worlds = await buildStandWorlds({ filter: (s) => s.id === WORLD });
  handle = createStandApi(worlds, {
    authenticator: createAuthenticator({ issuer: STAND_ISSUER, audience: STAND_AUDIENCE, jwks: staticJwks(issuer.jwks), directory: memoryStandDirectory(worlds) }),
    simulator: { token: (a) => issuer.token(a.subject, { email: a.email, extra: { name: a.displayName } }), expiresInSeconds: 900 },
  });
});

interface Auth { authorization: string; cookie: string }
const account = (role: string) => STAND_ACCOUNTS.find((a) => a.role === role)!;
async function login(role: string, locale: 'en' | 'de' = 'en'): Promise<Auth> {
  const r = await handle({ method: 'POST', url: `/api/stand-issuer/token?locale=${locale}`, body: { role } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { authorization: `Bearer ${(r.body as StandToken).accessToken}`, cookie: `repracer_locale=${locale}` };
}
const call = (auth: Auth, method: 'GET' | 'POST', url: string, body?: unknown) => handle({ method, url, body, ...auth });
const api = (...parts: string[]) => `/api/worlds/${[WORLD, ...parts].map(encodeURIComponent).join('/')}`;
const live = () => worlds.find((w) => w.id === WORLD)!;
const code = (r: { body: unknown }) => (r.body as { error?: { code: string } }).error?.code;
const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');

async function job(r: { status: number; body: unknown }): Promise<BulkJobView> {
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return runJob(live(), (r.body as JobCreatedResponse).jobId, 'en');
}

/** Шаблон: задание, затем файл — как браузер, запросом с токеном (`jobs/<id>/artifact`) */
async function template(auth: Auth, kind: string, format: 'csv' | 'xlsx', extra: Record<string, unknown> = {}) {
  const done = await job(await call(auth, 'POST', api('imports', 'template'), { kind, format, ...extra }));
  assert.equal(done.status, 'SUCCEEDED', done.error ?? done.headline);
  const file = await call(auth, 'GET', api('jobs', done.jobId, 'artifact'));
  assert.equal(file.status, 200);
  return { done, file: (file as unknown as { file: { contentType: string; content: string | Uint8Array; fileName: string } }).file };
}

/** Примерка файла: задание; итог — экран примерки */
async function check(auth: Auth, kind: string, content: string, extra: Record<string, unknown> = {}) {
  const done = await job(await call(auth, 'POST', api('imports', 'check'), { kind, fileName: `${kind.toLowerCase()}.csv`, content, ...extra }));
  assert.equal(done.status, 'SUCCEEDED', done.error ?? done.headline);
  return { jobId: done.jobId, view: (done.result as { view: ImportCheckView }).view };
}

const apply = (auth: Auth, kind: string, checked: { jobId: string; view: ImportCheckView }) =>
  call(auth, 'POST', api('imports', 'apply'), { kind, checkJobId: checked.jobId, checkToken: checked.view.token, confirmed: true });

const history = async (auth: Auth, kind: string) => {
  const r = await call(auth, 'GET', `${api('imports')}?kind=${kind}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body as ImportHistoryView;
};

const costOf = async (writeScopeId: string) => (await live().store.readConsoleState(live().tenantId, live().clock.iso() as never)).scopes
  .find((s) => s.writeScopeId === writeScopeId)!.declaredCost?.unitCostMinor ?? null;

test('step 99 (Р-224): a file with one bad row applies nothing — the apply is refused and the database is unchanged', async () => {
  const owner = await login('OWNER');
  const rows = (await call(owner, 'GET', api('products'))).body as ProductListView;
  const [first] = rows.rows;
  const before = await costOf(first!.unit.writeScopeId);
  const csv = ['sku,storefront,unit_cost,currency', `${first!.unit.externalUnitId},,9.99,EUR`, 'NO-SUCH-SKU,,7.00,EUR'].join('\n');
  const checked = await check(owner, 'COSTS', b64(csv));
  assert.deepEqual(checked.view.counts, { total: 2, changed: 1, unchanged: 0, rejected: 1 });
  // Ошибка — по строке файла (заголовок — строка 1) и словами
  assert.deepEqual(checked.view.errors.map((e) => [e.line, e.key]), [[3, 'NO-SUCH-SKU']]);
  assert.equal(checked.view.errors[0]!.text, messagesFor('en').ui.imports.problems.NOT_FOUND);
  assert.equal(checked.view.applyBlocked, messagesFor('en').ui.imports.applyBlocked.errors(1));
  const refused = await apply(owner, 'COSTS', checked);
  assert.deepEqual([refused.status, code(refused)], [409, 'HAS_ERRORS'], 'файл с ошибкой не применяется — ни одной строки');
  assert.equal(await costOf(first!.unit.writeScopeId), before, 'себестоимость единственной верной строки не изменилась');
  // Отчёт примерки — все ошибочные строки файлом с причиной
  const report = await call(owner, 'GET', api('jobs', checked.jobId, 'artifact'));
  const text = String((report as unknown as { file: { content: string } }).file.content);
  assert.match(text.split('\n')[0]!, /^line,sku,column,problem,problem_text/);
  assert.match(text, /^3,NO-SUCH-SKU,sku,NOT_FOUND,/m, 'колонка — как заголовок файла');
});

test('step 99 (Р-224): data changed between the check and the apply — the apply refuses and applies nothing', async () => {
  const owner = await login('OWNER');
  const rows = (await call(owner, 'GET', api('products'))).body as ProductListView;
  const unit = rows.rows[1]!.unit;
  const first = await check(owner, 'COSTS', b64(['sku,unit_cost,currency', `${unit.externalUnitId},11.10,EUR`].join('\n')));
  assert.equal(first.view.counts.changed, 1);
  // Пока продавец смотрел на примерку, себестоимость этого предложения изменил другой импорт
  const other = await check(owner, 'COSTS', b64(['sku,unit_cost,currency', `${unit.externalUnitId},12.20,EUR`].join('\n')));
  const otherApplied = await job(await apply(owner, 'COSTS', other));
  assert.equal(otherApplied.status, 'SUCCEEDED', otherApplied.error ?? '');
  assert.equal(await costOf(unit.writeScopeId), 1220);
  // Применение первой примерки: пересчёт по текущим данным даёт другую примерку — отказ, и ничего не применено
  const stale = await job(await apply(owner, 'COSTS', first));
  assert.deepEqual([stale.status, stale.error], ['FAILED', messagesFor('en').ui.jobs.errors.DATA_CHANGED]);
  assert.equal(await costOf(unit.writeScopeId), 1220, 'устаревшая примерка ничего не перезаписала');
  const runs = (await history(owner, 'COSTS')).items;
  assert.equal(runs[0]!.outcome, messagesFor('en').ui.imports.outcomes.REFUSED);
  assert.equal(runs[0]!.reason, messagesFor('en').ui.imports.reasons.DATA_CHANGED);
});

test('step 99 (Р-224, E): the template is prefilled, reads back unchanged, and an edit applies exactly what the check showed — with the time', async () => {
  const owner = await login('OWNER');
  const { file } = await template(owner, 'COSTS', 'csv');
  assert.equal(file.contentType, 'text/csv');
  assert.match(file.fileName, /^unit-costs-template\.csv$/);
  const table = readTable(Buffer.from(String(file.content)));
  assert.deepEqual(table.rows[0], IMPORT_SCHEMAS.COSTS.map((s) => s.field), 'первая строка — заголовки по-английски');
  assert.equal(table.rows[1]![0], '# example: ABC-123', 'вторая — пример, закомментированный «#»');
  assert.ok(table.rows.slice(2).some((r) => r[0]!.startsWith('# How to fill in')), 'пояснение — строками «#» на языке пространства');
  // Шаблон, загруженный обратно без правок, ничего не меняет
  const untouched = await check(owner, 'COSTS', b64(String(file.content)));
  assert.equal(untouched.view.counts.rejected, 0, JSON.stringify(untouched.view.errors));
  assert.equal(untouched.view.counts.changed, 0);
  assert.equal(untouched.view.applyBlocked, messagesFor('en').ui.imports.applyBlocked.nothing);
  assert.equal(code(await apply(owner, 'COSTS', untouched)), 'NOTHING_TO_APPLY');
  // Одна правка — одна строка к изменению; применяется ровно она
  const data = importDataRows(table).map((r) => [...r.cells]);
  data[0]![3] = '13.31';
  const editedCsv = [table.rows[0]!, ...data].map((r) => r.join(',')).join('\n');
  const changed = await check(owner, 'COSTS', b64(editedCsv));
  assert.deepEqual([changed.view.counts.changed, changed.view.counts.rejected], [1, 0]);
  assert.equal(changed.view.changes[0]!.field, messagesFor('en').ui.imports.fields.unit_cost);
  const done = await job(await apply(owner, 'COSTS', changed));
  assert.equal(done.status, 'SUCCEEDED', done.error ?? '');
  assert.match(done.headline, /^Done: 1 row applied in \d+(\.\d)? s\.$/, 'скорость — числом');
  const runs = (await history(owner, 'COSTS')).items;
  assert.equal(runs[0]!.outcome, messagesFor('en').ui.imports.outcomes.APPLIED);
  assert.equal(runs[0]!.fileName, 'costs.csv');
  assert.equal(runs[0]!.sha256, createHash('sha256').update(editedCsv).digest('hex'), 'сумма — по байтам файла продавца');
  assert.match(runs[0]!.rows, /^1 of \d+ rows applied$/);
});

test('step 99: the XLSX template holds the same rows and a help sheet; it reads back unchanged', async () => {
  const owner = await login('OWNER', 'de');
  const csv = (await template(owner, 'BOUNDS', 'csv')).file;
  const { file } = await template(owner, 'BOUNDS', 'xlsx');
  assert.equal(file.contentType, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  const bytes = Buffer.from(file.content as Uint8Array);
  const sheet = parseXlsx(bytes);
  const csvRows = readTable(Buffer.from(String(csv.content))).rows;
  // Строки данных те же; пояснение в XLSX — отдельным листом, а не строками «#»
  assert.deepEqual(sheet.rows[0], csvRows[0]);
  assert.deepEqual(sheet.rows.filter((r) => !String(r[0]).startsWith('#')), csvRows.filter((r) => !String(r[0]).startsWith('#')));
  const zip = bytes.toString('latin1');
  assert.ok(zip.includes('xl/worksheets/sheet2.xml'), 'лист справки есть');
  const untouched = await check(owner, 'BOUNDS', bytes.toString('base64'));
  assert.deepEqual([untouched.view.counts.changed, untouched.view.counts.rejected], [0, 0], JSON.stringify(untouched.view.errors));
});

test('step 99 (Р-225): bounds — the floor above the ceiling is a row error; a valid edit applies; strategies by name', async () => {
  const owner = await login('OWNER');
  const rows = (await call(owner, 'GET', api('products'))).body as ProductListView;
  const unit = rows.rows[0]!.unit;
  const bad = await check(owner, 'BOUNDS', b64(['sku,min_price,max_price', `${unit.externalUnitId},90.00,10.00`].join('\n')));
  assert.equal(bad.view.errors[0]!.text, messagesFor('en').ui.imports.problems.MIN_ABOVE_MAX(messagesFor('en').money(9000, 'EUR'), messagesFor('en').money(1000, 'EUR')));
  const good = await check(owner, 'BOUNDS', b64(['sku,min_price,max_price,min_margin_percent', `${unit.externalUnitId},11.00,95.00,8%`].join('\n')));
  assert.deepEqual([good.view.counts.changed, good.view.counts.rejected], [1, 0], JSON.stringify(good.view.errors));
  const done = await job(await apply(owner, 'BOUNDS', good));
  assert.equal(done.status, 'SUCCEEDED', done.error ?? '');
  const scope = (await live().store.readConsoleState(live().tenantId, live().clock.iso() as never)).scopes.find((s) => s.writeScopeId === unit.writeScopeId)!;
  assert.deepEqual([scope.bounds.min.status === 'RESOLVED' ? scope.bounds.min.amountMinor : null, scope.bounds.max.status === 'RESOLVED' ? scope.bounds.max.amountMinor : null, scope.minMarginBp], [1100, 9500, 800]);

  const unknown = await check(owner, 'STRATEGY', b64(['sku,strategy', `${unit.externalUnitId},No such strategy`].join('\n')));
  assert.equal(unknown.view.errors[0]!.text, messagesFor('en').ui.imports.problems.STRATEGY_NOT_FOUND);
  const tpl = readTable(Buffer.from(String((await template(owner, 'STRATEGY', 'csv')).file.content)));
  const named = importDataRows(tpl).map((r) => r.cells.at(-1)).find((n) => n);
  assert.ok(named, 'у предложений мира есть стратегия с именем — шаблон её называет');
  const other = rows.rows.find((r) => r.unit.writeScopeId !== unit.writeScopeId)!;
  const assigned = await check(owner, 'STRATEGY', b64(['sku,strategy', `${other.unit.externalUnitId},${named}`].join('\n')));
  assert.equal(assigned.view.counts.rejected, 0, JSON.stringify(assigned.view.errors));
});

test('step 99: rights — the inventory manager imports stock but not unit costs; stock applies only what was checked', async () => {
  const inventory = await login('INVENTORY_MANAGER');
  const csv = b64('sku,unit_cost\nX,1.00');
  assert.deepEqual([(await call(inventory, 'POST', api('imports', 'check'), { kind: 'COSTS', fileName: 'x.csv', content: csv })).status], [403]);
  const source = await call(inventory, 'POST', api('stock', 'sources'), { mode: 'INTERNAL_POOL', name: 'Warehouse' });
  assert.equal(source.status, 200, JSON.stringify(source.body));
  const stockSourceId = (source.body as { stockSourceId: string }).stockSourceId;
  const tpl = readTable(Buffer.from(String((await template(inventory, 'STOCK', 'csv', { stockSourceId })).file.content)));
  const product = importDataRows(tpl)[0]!.cells[0]!;
  const checked = await check(inventory, 'STOCK', b64(`sku,quantity\n${product},7`), { stockSourceId });
  assert.deepEqual([checked.view.counts.changed, checked.view.counts.rejected], [1, 0], JSON.stringify(checked.view.errors));
  const done = await job(await apply(inventory, 'STOCK', checked));
  assert.equal(done.status, 'SUCCEEDED', done.error ?? '');
  // Повтор той же примерки — данные уже другие (7 вместо пустого пула): отказ, ничего не применено
  const again = await job(await apply(inventory, 'STOCK', checked));
  assert.equal(again.status, 'FAILED');
});

test('step 99: an apply is the apply of one\'s own check — another member\'s check or a forged token is refused', async () => {
  const owner = await login('OWNER');
  const manager = await login('MANAGER');
  const rows = (await call(owner, 'GET', api('products'))).body as ProductListView;
  const checked = await check(owner, 'COSTS', b64(`sku,unit_cost,currency\n${rows.rows[2]!.unit.externalUnitId},4.44,EUR`));
  assert.equal(code(await apply(manager, 'COSTS', checked)), 'CHECK_CHANGED', 'чужая примерка');
  assert.equal(code(await call(owner, 'POST', api('imports', 'apply'), { kind: 'COSTS', checkJobId: checked.jobId, checkToken: 'forged', confirmed: true })), 'CHECK_CHANGED');
  assert.equal(code(await call(owner, 'POST', api('imports', 'apply'), { kind: 'BOUNDS', checkJobId: checked.jobId, checkToken: checked.view.token, confirmed: true })), 'CHECK_CHANGED', 'примерка другого вида импорта');
  // Вход одним паролем: импорт себестоимости — со вторым фактором [Р-135]
  const passwordOnly = { authorization: `Bearer ${issuer.token(account('OWNER').subject, { email: account('OWNER').email, amr: ['pwd'] })}`, cookie: 'repracer_locale=en' };
  assert.equal(code(await apply(passwordOnly, 'COSTS', checked)), 'MFA_REQUIRED');
});
