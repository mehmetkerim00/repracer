import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createIsolatedDatabase } from './isolated-db.ts';
import { inTenant, seedPricingWorld } from '../src/index.ts';

/**
 * OQ-180 (шаг 26): цена входит в суточную свёртку по времени ПРИМЕНЕНИЯ каналом, а не принятия записи. Цена, принятая до полуночи витрины
 * и применённая после неё, — цена следующих суток: покупатель видел её после полуночи. Отдельная база: закрытие суток глобально.
 * Данные синтетические.
 */
const db = await createIsolatedDatabase('repracer_applied_time');
after(async () => { await db.drop(); });

const ACCOUNT = '20000000-0000-4000-8000-000000002601';
const TENANT = '10000000-0000-4000-8000-000000002601';

test('OQ-180: цена, применённая после полуночи витрины, попадает в сутки применения, а не принятия', async () => {
  const app = db.pool('svc_app', 3);
  const admin = db.pool('svc_admin', 1);
  const scheduler = db.pool('svc_scheduler', 1);
  // Сутки витрины de — Europe/Berlin; принято 23:50, применено 00:10 следующих суток
  const day = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
  const acceptedAt = new Date(`${day}T21:50:00.000Z`).toISOString();
  const appliedAt = new Date(`${day}T22:10:00.000Z`).toISOString();
  const w = await seedPricingWorld(app, {
    provisioningPool: db.pool('svc_provisioning', 1), adminPool: admin, fixtureTenantId: TENANT, fixtureChannelAccountId: ACCOUNT,
    marketplaces: ['de'], clock: acceptedAt,
    seed: { scopes: [{ writeScopeId: 'ws-2601', productId: 'prod-2601', channelAccountId: ACCOUNT, marketplace: 'de', externalUnitId: '2601', channelProductRef: '362002601',
      condition: 'new', currency: 'EUR', basis: 'GROSS', pricingMode: 'OFF', strategy: null, currentPriceMinor: 1850,
      minPrice: { amountMinor: 1000, id: 'min-2601' }, maxPrice: { amountMinor: 3000, id: 'max-2601' } }] },
  });
  const writeId = '39260000-0000-4000-8000-000000000001';
  await inTenant(app, w.tenantId, async (tx) => {
    await tx.query(
      `INSERT INTO tenant_data.price_history (tenant_id, accepted_at, write_scope_id, product_id, amount_minor, currency, price_basis, effective_min_price_minor, channel_write_id, write_version)
       VALUES ($1, $2, $3, $4, 1500, 'EUR', 'GROSS', 1000, $5, 1)`, [w.tenantId, acceptedAt, w.ids.dbId('ws-2601'), w.ids.dbId('prod-2601'), writeId]);
    await tx.query(
      `INSERT INTO tenant_data.channel_write_history (tenant_id, channel_write_id, finished_at, write_scope_id, field, amount_minor, currency, price_basis, version, origin, final_status, attempt_count, created_at, applied_at)
       VALUES ($1, $2, $3, $4, 'PRICE', 1500, 'EUR', 'GROSS', 1, 'ENGINE', 'APPLIED', 1, $5, $3)`, [w.tenantId, writeId, appliedAt, w.ids.dbId('ws-2601'), acceptedAt]);
  });
  await scheduler.query('SELECT maintenance.close_price_days($1, 10)', [new Date().toISOString()]);
  // Свёртку цен читает административная роль: у пути решения прав на вечное доказательство нет [Р-90]
  const rows = await inTenant(admin, w.tenantId, async (tx) => (await tx.query(
    `SELECT price_day::text AS price_day, change_count FROM tenant_data.price_daily WHERE tenant_id = $1 AND write_scope_id = $2 ORDER BY price_day`,
    [w.tenantId, w.ids.dbId('ws-2601')])).rows);
  const acceptedDay = new Date(Date.parse(acceptedAt) + 2 * 3_600_000).toISOString().slice(0, 10);
  const appliedDay = new Date(Date.parse(appliedAt) + 2 * 3_600_000).toISOString().slice(0, 10);
  assert.notEqual(acceptedDay, appliedDay, 'сутки принятия и применения — разные (проверка сценария)');
  assert.deepEqual(rows.map((r) => r.price_day), [appliedDay], `OQ-180: a price applied after midnight is rolled up into the day it was accepted: ${JSON.stringify(rows)}`);
  assert.equal(Number(rows[0]!.change_count), 1);
});
