import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { standUserOf } from '@repracer/pricing-pipeline';
import { createPool, inTenant, PgPricingStore, PgShadowStore, seedPricingWorld } from '../src/index.ts';

/**
 * Шаг 89 (ADR-0054, решение владельца) в базе — две строки матрицы прав, каждая проверкой с причиной отказа и разрешённым рядом:
 *  - обратно в тень — право RETURN_TO_SHADOW: менеджер переводит боевой аккаунт в тень, наблюдатель — нет (страж журнала режимов
 *    спрашивает матрицу, 0186);
 *  - снятие недоверия каналу — только владелец (и прежний администратор): менеджер получает отказ стража административной записи.
 * Данные синтетические.
 */
const PG_URL = process.env.REPRACER_PG_URL;
if (!PG_URL) throw new Error('REPRACER_PG_URL is required: database tests do not skip (Р-84)');
const pool = createPool(PG_URL, { max: 4, applicationName: 'repracer-roles89-test' });
const admin = createPool(PG_URL.replace('svc_app@', 'svc_admin@'), { max: 2, applicationName: 'repracer-roles89-admin' });
const provisioning = createPool(PG_URL.replace('svc_app@', 'svc_provisioning@'), { max: 1, applicationName: 'repracer-roles89-provisioning' });
after(async () => {
  await pool.end();
  await admin.end();
  await provisioning.end();
});

const seed = (n: number) => seedPricingWorld(pool, {
  fixtureTenantId: `10000000-0000-4000-8000-0000000089${n}0`, fixtureChannelAccountId: `20000000-0000-4000-8000-0000000089${n}0`, marketplaces: ['de'],
  clock: new Date().toISOString(), seed: { scopes: [] }, provisioningPool: provisioning, adminPool: admin, writeMode: 'LIVE',
});

test('step 89 (ADR-0054): a manager switches a live account back to shadow, a viewer does not — the guard asks the permission matrix', async () => {
  const w = await seed(1);
  const shadow = new PgShadowStore({ adminPool: admin });
  const member = (alias: string) => ({ membershipId: w.ids.dbId(alias), userId: w.ids.dbId(standUserOf(alias)) });
  const back = (who: { membershipId: string; userId: string }) =>
    shadow.switchWriteMode(w.tenantId, { channelAccountId: w.channelAccountId, toMode: 'SHADOW', ...who, mfa: true });
  assert.equal((await back(member('membership-viewer'))).status, 'NOT_OWNER', 'step 89: a viewer does not switch an account back to SHADOW');
  assert.equal((await back(member('membership-manager'))).status, 'SWITCHED', 'step 89: a manager switches an account back to SHADOW');
  const { rows: [a] } = await inTenant(admin, w.tenantId, (tx) => tx.query('SELECT write_mode FROM tenant_data.channel_account WHERE tenant_id = $1 AND channel_account_id = $2',
    [w.tenantId, w.channelAccountId]), w.userId);
  assert.equal(a!.write_mode, 'SHADOW');
});

test('step 89 (ADR-0054): only the owner releases a channel distrust — the manager is refused by the administrative write guard', async () => {
  const w = await seed(2);
  // Недоверие ставит система (путь решения без человека), как при расхождении базы цены [Р-116, Р-118]
  const { rows: [d] } = await inTenant(pool, w.tenantId, (tx) => tx.query(
    `INSERT INTO channel_data.channel_distrust (tenant_id, channel_account_id, channel, marketplace, reason_code, details, detected_at)
     SELECT $1, a.channel_account_id, a.channel, 'de', 'PRICE_BASIS_MISMATCH', '{}'::jsonb, now() FROM tenant_data.channel_account a
      WHERE a.tenant_id = $1 AND a.channel_account_id = $2 RETURNING channel_distrust_id`, [w.tenantId, w.channelAccountId]));
  const store = new PgPricingStore(pool, { adminPool: admin });
  const release = (alias: string) => store.releaseDistrust(w.tenantId, d!.channel_distrust_id, {
    membershipId: w.ids.dbId(alias), userId: w.ids.dbId(standUserOf(alias)), mfa: true, note: 'Checked the channel prices by hand', at: new Date().toISOString() as never,
  });
  const outcome = (p: Promise<unknown>) => p.then((r) => String(r), (e: unknown) => String(e instanceof Error ? e.message : e));
  assert.match(await outcome(release('membership-manager')), /role MANAGER may not RELEASE_CHANNEL_DISTRUST/, 'step 89: a manager does not release a channel distrust');
  assert.equal(await release('membership-owner'), 'RELEASED');
});
