import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { standUserOf } from '@repracer/pricing-pipeline';
import { createPool, inTenant, PgPricingStore, PgShadowStore, PgStockStore, seedPricingWorld } from '../src/index.ts';

/**
 * Шаг 98 [Р-222] (решение владельца) в базе: ролей для людей две — владелец и менеджер, и права у них одинаковые, кроме денег. Всё, что
 * база отдавала только владельцу, менеджер теперь делает сам — каждое действие проверкой рядом с отказом роли без права (оператор):
 *  - перевод аккаунта в бой [Р-170] — со вторым фактором и набранным именем аккаунта;
 *  - ответ о других инструментах, подтверждение и отзыв записи количества [Р-202];
 *  - приглашение людей и смена ролей; роль ВЛАДЕЛЬЦА выдаёт и снимает только владелец — иначе «биллинг — только Owner» обходился бы
 *    одним действием;
 *  - перепривязка входа [Р-98] — у менеджера тоже, но вход владельца перепривязывает только владелец (та же причина).
 * Снятие недоверия каналу менеджером — тест шага 89 (roles-step89). Данные синтетические.
 */
const PG_URL = process.env.REPRACER_PG_URL;
if (!PG_URL) throw new Error('REPRACER_PG_URL is required: database tests do not skip (Р-84)');
const pool = createPool(PG_URL, { max: 4, applicationName: 'repracer-roles98-test' });
const admin = createPool(PG_URL.replace('svc_app@', 'svc_admin@'), { max: 2, applicationName: 'repracer-roles98-admin' });
const provisioning = createPool(PG_URL.replace('svc_app@', 'svc_provisioning@'), { max: 1, applicationName: 'repracer-roles98-provisioning' });
const stockPool = createPool(PG_URL.replace('svc_app@', 'svc_stock@'), { max: 1, applicationName: 'repracer-roles98-stock' });
after(async () => {
  await pool.end();
  await admin.end();
  await provisioning.end();
  await stockPool.end();
});

const seed = (n: number) => seedPricingWorld(pool, {
  fixtureTenantId: `10000000-0000-4000-8000-0000000098${n}0`, fixtureChannelAccountId: `20000000-0000-4000-8000-0000000098${n}0`, marketplaces: ['de'],
  clock: new Date().toISOString(), seed: { scopes: [] }, provisioningPool: provisioning, adminPool: admin, writeMode: 'SHADOW',
});
type World = Awaited<ReturnType<typeof seed>>;
const member = (w: World, alias: string) => ({ membershipId: w.ids.dbId(alias), userId: w.ids.dbId(standUserOf(alias)), mfa: true });
const outcome = (p: Promise<unknown>) => p.then((r) => JSON.stringify(r), (e: unknown) => String(e instanceof Error ? e.message : e));

test('step 98 (Р-222): the manager switches an account to live writes and confirms and revokes quantity writes; an operator does not', async () => {
  const w = await seed(1);
  const shadow = new PgShadowStore({ adminPool: admin });
  const stock = new PgStockStore({ adminPool: admin, stockPool });
  const typed = (await stock.quantityWritesState(w.tenantId, w.channelAccountId))!.externalAccountId;
  const live = (alias: string) => shadow.switchWriteMode(w.tenantId, { channelAccountId: w.channelAccountId, toMode: 'LIVE', ...member(w, alias), typedConfirmation: typed });

  assert.equal((await live('membership-operator')).status, 'NOT_OWNER', 'step 98: an operator does not switch an account to LIVE');
  assert.deepEqual(await live('membership-manager'), { status: 'SWITCHED', mode: 'LIVE' }, 'step 98: the manager switches an account to LIVE');

  assert.equal((await stock.answerOtherTools(w.tenantId, w.channelAccountId, 'NONE', member(w, 'membership-manager'))).status, 'ANSWERED',
    'step 98: the manager answers about other tools');
  // Оператору отказывает страж журнала подтверждений своей причиной («только владелец или менеджер»)
  assert.equal((await stock.confirmQuantityWrites(w.tenantId, w.channelAccountId, typed, member(w, 'membership-operator'))).status, 'NOT_OWNER',
    'step 98: an operator does not confirm quantity writes');
  assert.deepEqual(await stock.confirmQuantityWrites(w.tenantId, w.channelAccountId, typed, member(w, 'membership-manager')), { status: 'CONFIRMED' },
    'step 98: the manager confirms quantity writes');
  assert.equal((await stock.revokeQuantityWrites(w.tenantId, w.channelAccountId, typed, member(w, 'membership-manager'))).status, 'REVOKED',
    'step 98: the manager revokes quantity writes');
});

test('step 98 (Р-222): the manager invites people and changes roles — but the owner role is granted and removed only by an owner', async () => {
  const w = await seed(2);
  const store = new PgPricingStore(pool, { adminPool: admin });
  const manager = member(w, 'membership-manager');
  const invite = (as: { userId: string }, role: string) => outcome(inTenant(admin, w.tenantId, (tx) => tx.query(
    `SELECT membership_id FROM security.invite_member($1, $2, $3, sha256(convert_to($4, 'UTF8')), interval '1 day')`,
    [w.tenantId, `invited-${randomUUID()}@example.test`, role, randomUUID()]).then((r) => r.rowCount), as.userId, { mfa: true }));
  assert.equal(await invite(member(w, 'membership-operator'), 'MANAGER'), 'only an active owner, manager or admin of the tenant invites members',
    'step 98: an operator does not invite');
  assert.equal(await invite(manager, 'MANAGER'), '1', 'step 98: the manager invites a manager');
  assert.match(await invite(manager, 'OWNER'), /role OWNER cannot be granted by an invitation/, 'nobody invites an owner');

  const operator = w.ids.dbId('membership-operator');
  assert.deepEqual(await store.changeMemberRole(w.tenantId, operator, 'PRICING_MANAGER', manager), { status: 'CHANGED' }, 'step 98: the manager changes a role');
  assert.deepEqual(await store.changeMemberRole(w.tenantId, operator, 'OWNER', manager), { status: 'FORBIDDEN' }, 'step 98: the manager does not grant the owner role');
  assert.deepEqual(await store.changeMemberRole(w.tenantId, w.ids.dbId('membership-owner'), 'MANAGER', manager), { status: 'FORBIDDEN' },
    'step 98: the manager does not demote the owner');
  assert.deepEqual(await store.changeMemberRole(w.tenantId, operator, 'MANAGER', member(w, 'membership-owner')), { status: 'CHANGED' }, 'the owner changes a role');
});

test('step 98 (Р-222): the manager relinks the sign-in of a member, but not the sign-in of the owner', async () => {
  const w = await seed(3);
  const relink = (as: { userId: string }, alias: string) => outcome(inTenant(admin, w.tenantId, (tx) => tx.query(
    `SELECT security.invite_relink($1, $2, sha256(convert_to($3, 'UTF8')), interval '1 day') AS id`, [w.tenantId, w.ids.dbId(standUserOf(alias)), randomUUID()])
    .then((r) => typeof r.rows[0]?.id), as.userId, { mfa: true }));
  assert.equal(await relink(member(w, 'membership-operator'), 'membership-pricing-manager'), 'only an active owner or manager of the tenant relinks a sign-in (Р-98, Р-222)',
    'step 98: an operator does not relink');
  assert.equal(await relink(member(w, 'membership-manager'), 'membership-pricing-manager'), '"string"', 'step 98: the manager relinks the sign-in of a member');
  assert.equal(await relink(member(w, 'membership-manager'), 'membership-owner'), 'only an owner relinks the sign-in of an owner (Р-98, Р-222)',
    'step 98: a manager does not relink the sign-in of the owner');
  assert.equal(await relink(member(w, 'membership-owner'), 'membership-owner'), '"string"', 'the owner relinks the sign-in of an owner');
});
