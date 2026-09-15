import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createPool, inTenant, PgPricingStore, seedPricingWorld, type PgPool, type SeededPricingWorld } from '../src/index.ts';
import { requireEnv } from './isolated-db.ts';

/**
 * Р-90 на PostgreSQL: роли подключения разделены. Что ФИЗИЧЕСКИ невозможно для роли пути решения (repracer_app: логины svc_app и
 * svc_dispatcher) — отсутствие прав, а не проверка: вставить событие аудита, создать или изменить членство, тенанта, пользователя,
 * остановку человеком, пригласить участника, прочитать членства по внешнему входу, принять на себя административную роль.
 * Пользователь сессии и второй фактор, выставленные этой ролью, база не принимает. Административный сервис (svc_admin) делает
 * своё, журнал аудита пишут триггеры с автором — пользователем его сессии. Данные синтетические.
 */

const url = requireEnv('REPRACER_PG_URL');
const login = (name: string, max = 2): PgPool => createPool(url.replace('svc_app@', `${name}@`), { max, applicationName: `repracer-r90-${name}` });
const app = createPool(url, { max: 4, applicationName: 'repracer-r90-app' });
const dispatcher = login('svc_dispatcher');
const admin = login('svc_admin');
const provisioning = login('svc_provisioning', 1);
const authenticator = login('svc_authenticator', 1);
after(async () => {
  for (const p of [app, dispatcher, admin, provisioning, authenticator]) await p.end();
});

let w: SeededPricingWorld;
before(async () => {
  w = await seedPricingWorld(app, {
    fixtureTenantId: '10000000-0000-4000-8000-000000000190', fixtureChannelAccountId: '20000000-0000-4000-8000-000000000190', marketplaces: ['de'],
    clock: new Date().toISOString(), seed: { scopes: [] }, provisioningPool: provisioning,
  });
});

const refusal = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (error) {
    return (error as Error).message;
  }
  return 'accepted';
};

test('Р-90: the decision path roles cannot write the audit log, memberships, tenants, users, human stops, invitations or identities — even with a session user and a second factor set', async () => {
  const attempts: Array<[string, string, unknown[]]> = [
    ['audit event', `INSERT INTO audit.audit_event (tenant_id, occurred_at, actor_type, actor_user_id, actor_membership_id, action, entity_type)
                     VALUES ($1, now(), 'USER', $2, $3, 'pricing.stop_released', 'price_stop')`, [w.tenantId, w.userId, w.ownerMembershipId]],
    ['owner membership', `INSERT INTO tenant_data.membership (tenant_id, user_id, role, status) VALUES ($1, $2, 'OWNER', 'ACTIVE')`, [w.tenantId, w.userId]],
    ['role change', `UPDATE tenant_data.membership SET role = 'VIEWER' WHERE tenant_id = $1 AND membership_id = $2`, [w.tenantId, w.ids.dbId('membership-operator')]],
    ['activation', `UPDATE tenant_data.membership SET status = 'ACTIVE' WHERE tenant_id = $1 AND membership_id = $2`, [w.tenantId, w.ids.dbId('membership-operator')]],
    ['tenant', `INSERT INTO tenant_data.tenant (name, data_region) VALUES ('forged by $1', 'EU')`, []],
    ['user', `INSERT INTO platform.app_user (user_id, email) VALUES (gen_random_uuid(), 'forged-' || $1 || '@example.test')`, [w.tenantId]],
    ['human stop', `INSERT INTO tenant_data.price_stop (tenant_id, scope_type, stopped_by_membership_id, stop_note) VALUES ($1, 'TENANT', $2, 'forged stop of the decision path')`, [w.tenantId, w.ownerMembershipId]],
    ['invitation', `SELECT security.invite_member($1, 'forged@example.test', 'VIEWER', sha256('x'), interval '1 day')`, [w.tenantId]],
    ['provisioning', `SELECT security.provision_tenant(gen_random_uuid(), 'forged', 'EU', '[]')`, []],
    ['identity resolution', `SELECT * FROM security.resolve_external_identity('https://idp.example.test', $1)`, [w.userId]],
    ['administrative role', 'SET ROLE repracer_admin', []],
  ];
  for (const [pool, name] of [[app, 'svc_app'], [dispatcher, 'svc_dispatcher']] as const) {
    for (const [what, sql, params] of attempts) {
      const message = await refusal(inTenant(pool, w.tenantId, (tx) => tx.query(sql, params), w.userId, { mfa: true }));
      assert.match(message, /permission denied/, `${name}: ${what} — ${message}`);
    }
  }
});

test('Р-90: a session user and a second factor are accepted only from the administrative service; a manual halt release by the decision path is refused', async () => {
  const flags = (pool: PgPool) => inTenant(pool, w.tenantId, async (tx) => (await tx.query(
    `SELECT security.current_user_id() AS "user", security.session_mfa() AS mfa, current_setting('app.auth_mfa') AS raw`)).rows[0], w.userId, { mfa: true });
  assert.deepEqual(await flags(app), { user: null, mfa: false, raw: 'on' }, 'the flags are set in the session, but the database does not trust this role');
  assert.deepEqual(await flags(admin), { user: w.userId, mfa: true, raw: 'on' });

  const { rows: [halt] } = await app.query('SELECT 1').then(() => inTenant(app, w.tenantId, (tx) => tx.query(
    `INSERT INTO channel_data.pricing_halt (tenant_id, channel_account_id, channel, marketplace, reason_code, details)
     VALUES ($1, $2, 'KAUFLAND', 'de', 'CHANNEL_MASS_SHIFT', '{}') RETURNING pricing_halt_id`, [w.tenantId, w.channelAccountId])));
  const review = (mfa: boolean) => ({
    kind: 'MANUAL_RELEASE' as const, outcome: 'RELEASED' as const, sampleSize: 0, failedCount: 0, details: {}, membershipId: w.ownerMembershipId, userId: w.userId, mfa,
    note: 'Synthetic manual release of the role check', at: new Date().toISOString(),
  });
  // Путь решения, настроенный с собственным пулом вместо административного, — как скомпрометированный или ошибочный сервис
  assert.match(await refusal(new PgPricingStore(app, { adminPool: app }).releaseHalt(w.tenantId, halt.pricing_halt_id, review(true))), /session user/);
  assert.match(await refusal(new PgPricingStore(app).releaseHalt(w.tenantId, halt.pricing_halt_id, review(true))), /administrative database role/);
  const store = new PgPricingStore(app, { adminPool: admin });
  assert.match(await refusal(store.releaseHalt(w.tenantId, halt.pricing_halt_id, review(false))), /second factor/);
  await store.releaseHalt(w.tenantId, halt.pricing_halt_id, review(true));
});

test('Р-90: the audit log is still written — by triggers, with the session user of the administrative service as the author', async () => {
  const store = new PgPricingStore(app, { adminPool: admin });
  const result = await store.stopPricing(w.tenantId, {
    scope: 'TENANT', channelAccountId: null, marketplace: null, stoppedAt: new Date().toISOString(), stoppedByMembershipId: w.ownerMembershipId, stoppedByUserId: w.userId,
    note: 'Synthetic stop of the role separation check',
  });
  assert.equal(result.status, 'STOPPED');
  const events = await inTenant(app, w.tenantId, async (tx) => (await tx.query(
    `SELECT action, actor_type, actor_user_id FROM audit.audit_event WHERE tenant_id = $1 AND entity_id = $2`,
    [w.tenantId, result.status === 'STOPPED' ? result.stop.stopId : null])).rows);
  assert.deepEqual(events, [{ action: 'pricing.stop_created', actor_type: 'USER', actor_user_id: w.userId }]);
});

test('finding 13: only the authenticator role resolves external identities', async () => {
  const { rows } = await authenticator.query(`SELECT * FROM security.resolve_external_identity('https://idp.example.test', 'unknown-subject')`);
  assert.equal(rows.length, 0);
  assert.match(await refusal(admin.query(`SELECT * FROM security.resolve_external_identity('https://idp.example.test', 'unknown-subject')`)), /permission denied/,
    'the administrative service does not read memberships by external identity either');
});
