import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { inTenant, PgPricingStore, seedPricingWorld, type PgPool, type SeededPricingWorld } from '../src/index.ts';
import { createIsolatedDatabase, type IsolatedDatabase } from './isolated-db.ts';

/**
 * Шаг 172 на PostgreSQL (0237): визиты Daily Overview — «Since your last visit».
 *  - открытие Overview — визит, если прошлый визит человека старше 30 минут; ответ — визит до нынешнего; повторные открытия внутри паузы —
 *    тот же визит, новой строки нет;
 *  - визит пишет человек от своего имени (членство — того человека, что в сессии), момент ставит база; событие аудита — кто и когда;
 *  - журнал только на добавление.
 * Старый визит в прошлом ставит суперпользователь в обход стражей (момент визита ставит база, и иначе прошлое не получить). Данные синтетические
 */

const ACCOUNT = '20000000-0000-4000-8000-000000000172';
let db: IsolatedDatabase;
let pool: PgPool;
let admin: PgPool;
let world: SeededPricingWorld;
let store: PgPricingStore;

before(async () => {
  db = await createIsolatedDatabase('step172');
  pool = db.pool('svc_app');
  admin = db.pool('svc_admin', 2);
  world = await seedPricingWorld(pool, { provisioningPool: db.pool('svc_provisioning', 1), adminPool: admin,
    fixtureTenantId: '10000000-0000-4000-8000-000000000172', fixtureChannelAccountId: ACCOUNT, marketplaces: ['de'], clock: new Date().toISOString(), seed: { scopes: [] } });
  store = new PgPricingStore(pool, { adminPool: admin });
});
after(async () => { await db?.drop(); });

const actor = () => ({ membershipId: world.ownerMembershipId, userId: world.userId, mfa: false });
const visits = () => db.rows<{ at: string }>(`SELECT visited_at::text AS at FROM tenant_data.overview_visit WHERE tenant_id = $1 ORDER BY visited_at`, [world.tenantId]);
const outcome = async (p: Promise<unknown>) => { try { await p; return 'accepted'; } catch (e) { return (e as Error).message; } };

test('step 172: the first open is a visit with no earlier one; opening again within 30 minutes is the same visit', async () => {
  assert.deepEqual(await store.overviewVisit(world.tenantId, actor()), { previous: null }, 'no earlier visit — the honest 24 hours');
  assert.deepEqual(await store.overviewVisit(world.tenantId, actor()), { previous: null }, 'the same visit: still no earlier one');
  assert.equal((await visits()).length, 1, 'one visit row');
  const audit = await db.rows<{ action: string; actor: string }>(
    `SELECT action, actor_user_id::text AS actor FROM audit.audit_event WHERE tenant_id = $1 AND entity_type = 'tenant_data.overview_visit'`, [world.tenantId]);
  assert.deepEqual(audit.map((a) => [a.action, a.actor]), [['admin_change.insert', world.userId]], 'the visit is an audit event of the person');
});

test('step 172: after a pause of 30 minutes the next open is a new visit, and the window starts at the visit before', async () => {
  // Визит два часа назад — в обход стражей (момент ставит база): так выглядит вчерашний вечер продавца
  await db.rows(`SET session_replication_role = replica;
    DELETE FROM tenant_data.overview_visit WHERE tenant_id = '${world.tenantId}';
    INSERT INTO tenant_data.overview_visit (tenant_id, membership_id, visited_at) VALUES ('${world.tenantId}', '${world.ownerMembershipId}', now() - interval '2 hours');
    RESET session_replication_role`);
  const [old] = await visits();
  const first = await store.overviewVisit(world.tenantId, actor());
  assert.equal(first.previous && Date.parse(first.previous), Date.parse(old!.at), 'the window starts at the earlier visit');
  assert.equal((await visits()).length, 2, 'a new visit row');
  const again = await store.overviewVisit(world.tenantId, actor());
  assert.equal(again.previous && Date.parse(again.previous), Date.parse(old!.at), 'within the pause — the same window, no new row');
  assert.equal((await visits()).length, 2);
});

test('step 172: the database keeps the journal honest — the visit of the session person only, the time of the database, append-only', async () => {
  const insert = (membership: string, at = '') => inTenant(admin, world.tenantId, (tx) => tx.query(
    `INSERT INTO tenant_data.overview_visit (tenant_id, membership_id${at ? ', visited_at' : ''}) VALUES ($1, $2${at ? ', $3' : ''})`,
    at ? [world.tenantId, membership, at] : [world.tenantId, membership]), world.userId);
  assert.match(await outcome(insert(randomUUID())), /is not the membership of the session user/, 'a visit in the name of another membership is refused');
  // Время визита — часы базы: время из запроса страж заменяет
  assert.equal(await outcome(insert(world.ownerMembershipId, '2020-01-01T00:00:00Z')), 'accepted');
  // Самый ранний визит журнала: без стража им стал бы визит из запроса (2020); со стражем — визит двухчасовой давности из теста выше
  const [earliest] = await db.rows<{ at: string }>(`SELECT min(visited_at)::text AS at FROM tenant_data.overview_visit WHERE tenant_id = $1`, [world.tenantId]);
  assert.ok(Date.now() - Date.parse(earliest!.at) < 3 * 3_600_000, `the time of a visit is the database time, not the one asked: ${new Date(earliest!.at).toISOString()}`);
  assert.match(await outcome(db.rows(`UPDATE tenant_data.overview_visit SET visited_at = now() WHERE tenant_id = $1`, [world.tenantId])),
    /append-only|forbidden|not allowed/i, 'a visit is never changed');
});
