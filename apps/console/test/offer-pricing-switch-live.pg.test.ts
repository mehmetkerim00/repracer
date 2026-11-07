import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { BulkJobView, ProductListView, ProductRow } from '@repracer/console-model';
import { pgStandJoinMember, pgStandUsers, STAND_ACCOUNTS, STAND_AUDIENCE, STAND_EMAILS, STAND_ISSUER, STAND_PEOPLE } from '@repracer/contract-tests/stand';
import { createAuthenticator, staticJwks } from '@repracer/identity';
import { PgIdentityDirectory } from '@repracer/identity/pg';
import { parseCsv } from '@repracer/cost-import';
import { createTestIssuer } from '@repracer/identity/test-issuer';
import { PgChannelConnectStore } from '@repracer/pricing-store-pg';
import type { JobCreatedResponse } from '../src/api-types.ts';
import { fetchFile, setAccessToken, setApiOrigin } from '../src/api.ts';
import { createIsolatedDatabase, type IsolatedDatabase } from '../../../packages/pricing-store-pg/test/isolated-db.ts';
import { readOnlyConnections } from '../server/connect.ts';
import { startDemoWorld, type RunningDemoWorld } from '../server/demo-world.ts';
import { createStandApi, createStandServer } from '../server/stand-server.ts';

/**
 * Шаг 118 живым прогоном как браузер [Р-136, Р-142]: американское демо на PostgreSQL, вход стенда. «Вот этот SKU не трогай»:
 *  - менеджер, вошедший ОДНИМ паролем (без второго фактора — забор не двигается, Р-225), выключает автоцену одного предложения с запиской;
 *  - на Offers статус «Off» и «Turned off by Jamie Lee, …», записка — в подсказке; фильтр «Repricing: Off / On» — по всему каталогу;
 *  - выгрузка Offers с тем же фильтром — то же предложение, колонка `repricing` — OFF;
 *  - выключенное предложение движок не оценивает: ни решений, ни повторов «без изменения», пока прогон идёт;
 *  - владелец включает обратно прежней кнопкой «Enable»; выключить невключённое — 409 словами; журнал и аудит — кто и когда.
 * Данные синтетические.
 */

let db: IsolatedDatabase;
let demo: RunningDemoWorld;
let server: Server;
let origin = '';
let worldId = '';
let issuer: ReturnType<typeof createTestIssuer>;

async function call<T>(method: 'GET' | 'POST', path: string, token: string, body?: unknown): Promise<{ status: number; body: T }> {
  const r = await fetch(`${origin}${path}`, {
    method, headers: { authorization: `Bearer ${token}`, cookie: 'repracer_locale=en', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await r.text();
  return { status: r.status, body: (text ? JSON.parse(text) : null) as T };
}
/** Вход стенда с теми способами, что назвал поставщик: `pwd` — одним паролем, без второго фактора */
const signIn = (role: 'OWNER' | 'MANAGER', amr: string[]) => {
  const a = STAND_ACCOUNTS.find((x) => x.role === role)!;
  return issuer.token(a.subject, { email: a.email, amr, extra: { name: a.displayName } });
};
const api = (...parts: string[]) => `/api/worlds/${[worldId, ...parts].map(encodeURIComponent).join('/')}`;
const offers = (token: string, query: Record<string, string>) => call<ProductListView>('GET', `${api('products')}?${new URLSearchParams({ offset: '0', limit: '200', ...query })}`, token);

before(async () => {
  db = await createIsolatedDatabase('switch118');
  const admin = db.pool('svc_admin', 4);
  const directory = new PgIdentityDirectory(db.pool('svc_authenticator', 2) as never);
  const memberUsers = await pgStandUsers(directory, db.pool('svc_onboarding', 1));
  demo = await startDemoWorld({
    pools: {
      app: db.pool('svc_app', 6), admin, provisioning: db.pool('svc_provisioning', 1), dispatcher: db.pool('svc_dispatcher', 2),
      scheduler: db.pool('svc_scheduler', 3), exporter: db.pool('svc_exporter', 2), stock: db.pool('svc_stock', 2), bulkWorker: db.pool('svc_bulk_worker', 2),
    },
    pgUrl: db.url('svc_app'), pgUrlsByRole: { admin: db.url('svc_admin'), bulk_worker: db.url('svc_bulk_worker'), stock: db.url('svc_stock') },
    tag: 3118, memberUsers, memberEmails: STAND_EMAILS, market: 'us', usPressDays: 0,
    joinMember: pgStandJoinMember(admin, directory), log: () => undefined,
  });
  worldId = demo.world.id;
  issuer = createTestIssuer({ issuer: STAND_ISSUER, audience: STAND_AUDIENCE });
  const handle = createStandApi([demo.world], {
    authenticator: createAuthenticator({ issuer: STAND_ISSUER, audience: STAND_AUDIENCE, jwks: staticJwks(issuer.jwks), directory }),
    simulator: { token: (a: (typeof STAND_ACCOUNTS)[number]) => issuer.token(a.subject, { email: a.email, amr: ['pwd', 'otp'], extra: { name: a.displayName } }), expiresInSeconds: 3600 },
  }, { connect: () => readOnlyConnections(new PgChannelConnectStore(admin)), market: 'us', people: STAND_PEOPLE });
  server = createStandServer(handle);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  demo?.stop();
  server?.close();
  await db?.drop();
});

const decisionsOf = async (writeScopeId: string) => (await db.rows<{ decisions: string; repeats: number | null; evaluated: string | null }>(
  `SELECT (SELECT count(*) FROM channel_data.price_decision d WHERE d.tenant_id = $1 AND d.write_scope_id = $2) AS decisions,
          (SELECT s.repeats FROM tenant_data.price_no_change_state s WHERE s.tenant_id = $1 AND s.write_scope_id = $2) AS repeats,
          (SELECT s.last_evaluated_at::text FROM tenant_data.price_no_change_state s WHERE s.tenant_id = $1 AND s.write_scope_id = $2) AS evaluated`,
  [demo.tenantId, writeScopeId]))[0]!;

test('step 118: a manager signed in with a password only turns automatic pricing off for one offer and the owner turns it back on', async () => {
  const manager = signIn('MANAGER', ['pwd']);
  const owner = signIn('OWNER', ['pwd']);

  // Фильтр «Repricing: On» — всё, что можно выключить; у менеджера кнопка есть у каждой строки
  const on = (await offers(manager, { pricing: 'ON' })).body;
  assert.ok(on.rows.length > 0 && on.matched !== null, `the demo has offers with automatic pricing on: ${on.rows.length}`);
  assert.deepEqual(on.rows.filter((r) => !r.canDisable).map((r) => r.unit.label), [], 'every offer that is on can be turned off by the manager');
  const offBefore = (await offers(manager, { pricing: 'OFF' })).body.matched ?? 0;
  const target = on.rows.find((r) => r.enabled.tone === 'ok')!;
  const id = target.unit.writeScopeId;

  const turnedOff = await call<{ disabled: boolean }>('POST', api('scopes', id, 'disable'), manager, { note: 'Supplier price talks — hold this one' });
  assert.equal(turnedOff.status, 200, JSON.stringify(turnedOff.body));
  assert.deepEqual(turnedOff.body, { disabled: true });
  const frozen = await decisionsOf(id);

  // Второй раз выключить нечего — отказ словами, не 500
  const again = await call<{ error: { code: string; message: string } }>('POST', api('scopes', id, 'disable'), manager, {});
  assert.deepEqual([again.status, again.body.error.code], [409, 'NOT_ENABLED']);
  assert.match(again.body.error.message, /nothing to turn off/);

  // Offers: «Off», кто и когда — под пилюлей, записка — в подсказке; фильтр — по всему каталогу
  const off = (await offers(manager, { pricing: 'OFF' })).body;
  assert.equal(off.matched, offBefore + 1, 'the filter counts the turned-off offer');
  const row = off.rows.find((r) => r.unit.writeScopeId === id) as ProductRow | undefined;
  assert.ok(row, 'the turned-off offer is under «Repricing: Off»');
  assert.equal(row.enabled.label, 'Off');
  assert.match(row.enabled.short ?? '', /^Turned off by Jamie Lee, /, `who and when: ${row.enabled.short}`);
  assert.match(row.enabled.detail, /Note: Supplier price talks — hold this one$/);
  assert.deepEqual([row.canDisable, row.canEnable], [false, true], 'turned off: «Enable» instead of «Turn off»');
  assert.equal((await offers(manager, { pricing: 'ON' })).body.rows.some((r) => r.unit.writeScopeId === id), false, '«Repricing: On» no longer lists it');
  assert.equal((await call('GET', `${api('products')}?pricing=PAUSED`, manager)).status, 400, 'an unknown value of the filter is refused');

  // Выгрузка Offers с тем же фильтром — тем же кодом, что у страницы (Р-142): колонка `repricing` — OFF
  const created = await call<JobCreatedResponse>('POST', api('exports'), manager, { screen: 'offers', format: 'csv', query: { pricing: 'OFF' } });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  let job: BulkJobView | null = null;
  for (const deadline = Date.now() + 60_000; Date.now() < deadline;) {
    job = (await call<BulkJobView>('GET', api('jobs', created.body.jobId), manager)).body;
    if (job.status === 'SUCCEEDED' || job.status === 'FAILED') break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.equal(job?.status, 'SUCCEEDED', JSON.stringify(job));
  setApiOrigin(origin);
  setAccessToken(manager);
  const file = Buffer.from((await fetchFile(api('jobs', created.body.jobId, 'artifact'), 'en')).bytes).toString('utf8');
  const [header, ...lines] = parseCsv(file).rows;
  const col = (name: string) => header!.indexOf(name);
  assert.ok(col('repricing') >= 0, header!.join(','));
  assert.ok(lines.some((l) => l[col('write_scope_id')] === id), 'the export lists the turned-off offer');
  assert.deepEqual([...new Set(lines.map((l) => l[col('repricing')]))], ['OFF'], 'the export of «Repricing: Off» holds only offers that are off');

  // Пока прогон шёл, движок предложение не оценивал: ни решений, ни повторов
  assert.deepEqual(await decisionsOf(id), frozen, 'a turned-off offer gets no decision and no repeat');

  // Владелец включает обратно прежней кнопкой «Enable»; кто включил — в журнале
  const enabled = await call<{ enabled: boolean; problems: unknown[]; warnings: unknown[] }>('POST', api('scopes', id, 'enable'), owner, { acknowledgeWarnings: true });
  assert.equal(enabled.body.enabled, true, JSON.stringify(enabled.body));
  const back = (await offers(owner, { pricing: 'ON' })).body.rows.find((r) => r.unit.writeScopeId === id);
  assert.ok(back && back.canDisable && back.enabled.label !== 'Off', 'on again');

  const journal = await db.rows<{ action: string; note: string | null; who: string }>(
    `SELECT j.action, j.note, u.display_name AS who FROM tenant_data.offer_pricing_switch j
       JOIN tenant_data.membership mb ON mb.tenant_id = j.tenant_id AND mb.membership_id = j.created_by_membership_id
       JOIN platform.app_user u ON u.user_id = mb.user_id
      WHERE j.tenant_id = $1 AND j.write_scope_id = $2 ORDER BY j.seq`, [demo.tenantId, id]);
  assert.deepEqual(journal.map((j) => [j.action, j.note]), [['OFF', 'Supplier price talks — hold this one'], ['ON', null]]);
  const audit = await db.rows<{ n: string }>(
    `SELECT count(*) AS n FROM audit.audit_event WHERE tenant_id = $1 AND entity_type = 'tenant_data.offer_pricing_switch' AND actor_user_id IS NOT NULL
        AND (changes ->> 'secondFactor')::boolean = false`, [demo.tenantId]);
  assert.equal(Number(audit[0]!.n), 2, 'both switches are audit events of a person, made without a second factor');
});
