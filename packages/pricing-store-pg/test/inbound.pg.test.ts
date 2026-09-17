import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, test } from 'node:test';
import { createPool, PgPricingStore, PgSellerRouter, seedPricingWorld } from '../src/index.ts';

/**
 * Шаг 23, A в базе (0083): маршрут уведомления Amazon к аккаунту тенанта — только функцией security.resolve_amazon_seller у роли приёмника;
 * журнал обработанных уведомлений — на тенанта; PRICING_HEALTH — последнее состояние оффера в консоли своего тенанта. Данные синтетические.
 */
const PG_URL = process.env.REPRACER_PG_URL;
const ADMIN_URL = process.env.REPRACER_PG_ADMIN_URL;
if (!PG_URL || !ADMIN_URL) throw new Error('REPRACER_PG_URL and REPRACER_PG_ADMIN_URL are required: database tests do not skip (Р-84)');
const pool = createPool(PG_URL, { max: 4, applicationName: 'repracer-step23-inbound' });
const inbound = createPool(PG_URL.replace('svc_app@', 'svc_inbound@'), { max: 2, applicationName: 'repracer-step23-receiver' });
const provisioning = createPool(PG_URL.replace('svc_app@', 'svc_provisioning@'), { max: 1, applicationName: 'repracer-step23-provisioning' });
const admin = createPool(PG_URL.replace('svc_app@', 'svc_admin@'), { max: 2, applicationName: 'repracer-step23-admin' });
const superuserUrl = new URL(ADMIN_URL);
superuserUrl.pathname = new URL(PG_URL).pathname;
const superuser = createPool(superuserUrl.toString(), { max: 1, applicationName: 'repracer-step23-fixture' });
after(async () => { await pool.end(); await inbound.end(); await provisioning.end(); await admin.end(); await superuser.end(); });

const DE = 'A1PA6795UKMFR9';

async function amazonTenant(n: number, sellerId: string) {
  const w = await seedPricingWorld(pool, {
    provisioningPool: provisioning, adminPool: admin, fixtureTenantId: `10000000-0000-4000-8000-00000000023${n}`, fixtureChannelAccountId: `20000000-0000-4000-8000-00000000023${n}`,
    fixtureChannel: 'AMAZON', fixtureRegion: 'EU', fixtureExternalAccountId: sellerId, marketplaces: [DE], clock: new Date().toISOString(), seed: { scopes: [] },
  });
  const accountId = w.ids.dbId(`20000000-0000-4000-8000-00000000023${n}`);
  return { tenantId: w.tenantId, accountId };
}

/** Синтетический идентификатор продавца, уникальный на прогон (channel_account_external_uq) */
const syntheticSeller = () => `A1SYN${randomBytes(5).toString('hex').toUpperCase()}`;

test('step 23: the receiver role routes a SellerId to its tenant account only through the resolver function', async () => {
  const seller = syntheticSeller();
  const other = syntheticSeller();
  const t1 = await amazonTenant(1, seller);
  const t2 = await amazonTenant(2, other);
  const router = new PgSellerRouter(inbound);
  assert.deepEqual(await router.resolve('EU', seller), [{ tenantId: t1.tenantId, channelAccountId: t1.accountId }]);
  assert.deepEqual(await router.resolve('EU', other), [{ tenantId: t2.tenantId, channelAccountId: t2.accountId }]);
  assert.deepEqual(await router.resolve('NA', seller), [], 'the region is part of the route');
  assert.deepEqual(await router.resolve('EU', syntheticSeller()), [], 'an unknown seller has no route');

  const { rows: [direct] } = await inbound.query('SELECT count(*)::int AS n FROM tenant_data.channel_account');
  assert.equal(direct.n, 0, 'without a tenant context the receiver role reads no account rows directly (RLS)');
  await assert.rejects(pool.query('SELECT * FROM security.resolve_amazon_seller($1, $2)', ['EU', seller]), /permission denied for function resolve_amazon_seller/,
    'the decision path role may not search accounts across tenants');

  // Отключение — административное действие продавца; в фикстуре — суперпользователем стенда
  await superuser.query(`UPDATE tenant_data.channel_account SET disconnected_at = now(), auth_status = 'DISCONNECTED' WHERE tenant_id = $1 AND channel_account_id = $2`, [t1.tenantId, t1.accountId]);
  assert.deepEqual(await router.resolve('EU', seller), [], 'a disconnected account receives no notifications');
});

test('step 23: the processed-notification ledger is per tenant and idempotent; PRICING_HEALTH shows the latest state in its own tenant', async () => {
  const t1 = await amazonTenant(3, syntheticSeller());
  const t2 = await amazonTenant(4, syntheticSeller());
  const store = new PgPricingStore(pool, { adminPool: admin });
  const id = `syn-notification-${randomBytes(4).toString('hex')}`;
  const entry = { channelAccountId: t1.accountId, notificationId: id, notificationType: 'ANY_OFFER_CHANGED', eventTime: '2026-09-17T09:59:00.000Z', receivedAt: '2026-09-17T10:00:00.000Z' };
  assert.equal(await store.wasNotificationProcessed(t1.tenantId, t1.accountId, id), false);
  await store.markNotificationProcessed(t1.tenantId, entry);
  await store.markNotificationProcessed(t1.tenantId, { ...entry, receivedAt: '2026-09-17T10:05:00.000Z' });
  assert.equal(await store.wasNotificationProcessed(t1.tenantId, t1.accountId, id), true);
  assert.equal(await store.wasNotificationProcessed(t2.tenantId, t2.accountId, id), false, 'another tenant has its own ledger');
  const { rows: [count] } = await superuser.query('SELECT count(*)::int AS n FROM channel_data.inbound_notification WHERE notification_id = $1', [id]);
  assert.equal(count.n, 1, 'a repeated delivery adds no second ledger row');

  const health = (issueType: string, occurredAt: string, minor: number | null) => ({
    marketplace: DE, channelProductRef: 'B000023001', condition: 'new', issueType, occurredAt, sourceEventId: `${id}-${occurredAt.slice(11, 13)}`,
    competitivePriceThreshold: minor === null ? null : { amountMinor: minor, currency: 'EUR', basis: 'GROSS' as const },
  });
  await store.recordPricingHealth(t1.tenantId, t1.accountId, health('BuyBoxDisqualification', '2026-09-17T11:00:00.000Z', 1799));
  await store.recordPricingHealth(t1.tenantId, t1.accountId, health('BuyBoxDisqualification', '2026-09-17T09:00:00.000Z', 1899));
  const state = await store.readConsoleState(t1.tenantId, new Date().toISOString());
  assert.deepEqual(state.pricingHealth, [{
    channelAccountId: t1.accountId, marketplace: DE, channelProductRef: 'B000023001', condition: 'new', issueType: 'BuyBoxDisqualification',
    occurredAt: '2026-09-17T11:00:00.000Z', competitivePriceThreshold: { amountMinor: 1799, currency: 'EUR', basis: 'GROSS' },
  }], 'a notification delivered late does not replace a newer state');
  assert.deepEqual((await store.readConsoleState(t2.tenantId, new Date().toISOString())).pricingHealth, []);
});
