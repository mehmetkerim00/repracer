import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { inTenant, seedPricingWorld } from '../src/index.ts';
import { createIsolatedDatabase } from './isolated-db.ts';

/**
 * Шаг 25 (риск 28): цена, которую канал не применил (запись завершена NOT_APPLIED), отмечается триггером и не попадает в суточную свёртку
 * при закрытии суток. Отдельная база: закрытие суток глобальное (maintenance.price_day_close). Данные синтетические.
 */
const db = await createIsolatedDatabase('repracer_not_applied');
after(async () => { await db.drop(); });

test('risk 28: a price the channel did not apply is marked and not rolled up into the daily price', async () => {
  const app = db.pool('svc_app');
  const w = await seedPricingWorld(app, {
    provisioningPool: db.pool('svc_provisioning'), adminPool: db.pool('svc_admin'), fixtureTenantId: '10000000-0000-4000-8000-000000002528',
    fixtureChannelAccountId: '20000000-0000-4000-8000-000000002528', marketplaces: ['de'], clock: new Date().toISOString(),
    seed: { scopes: [{ writeScopeId: 'ws-2528', productId: 'prod-2528', channelAccountId: '20000000-0000-4000-8000-000000002528', marketplace: 'de', externalUnitId: '2528',
      channelProductRef: '362002528', condition: 'new', currency: 'EUR', basis: 'GROSS', pricingMode: 'OFF', strategy: null, currentPriceMinor: 1500,
      minPrice: { amountMinor: 500, id: 'min-2528' }, maxPrice: { amountMinor: 3000, id: 'max-2528' } }] },
  });
  const ws = w.ids.dbId('ws-2528');
  // Вчера по Берлину, 10:00 и 12:00: 15.00 применена, 9.00 — нет
  const yesterday = new Date(Date.now() - 86_400_000).toLocaleDateString('en-CA', { timeZone: 'Europe/Berlin' });
  const at = (h: number) => `(DATE '${yesterday}' + time '${String(h).padStart(2, '0')}:00')::timestamp AT TIME ZONE 'Europe/Berlin'`;
  await db.superuser(
    `INSERT INTO tenant_data.price_history (tenant_id, accepted_at, write_scope_id, product_id, amount_minor, currency, price_basis, effective_min_price_minor, channel_write_id, write_version)
     SELECT $1::uuid, ${at(10)}, s.write_scope_id, s.product_id, 1500, 'EUR', 'GROSS', 500, gen_random_uuid(), 1 FROM tenant_data.write_scope s WHERE s.write_scope_id = $2::uuid
     UNION ALL
     SELECT $1::uuid, ${at(12)}, s.write_scope_id, s.product_id, 900, 'EUR', 'GROSS', 500, 'a9250000-0000-4000-8000-000000002528', 2 FROM tenant_data.write_scope s WHERE s.write_scope_id = $2::uuid`, [w.tenantId, ws]);
  await db.superuser(
    `INSERT INTO tenant_data.channel_write_history (tenant_id, channel_write_id, finished_at, write_scope_id, field, amount_minor, currency, price_basis, version, origin, final_status, attempt_count, created_at)
     VALUES ($1, 'a9250000-0000-4000-8000-000000002528', now(), $2, 'PRICE', 900, 'EUR', 'GROSS', 2, 'ENGINE', 'NOT_APPLIED', 1, now())`, [w.tenantId, ws]);
  await db.superuser('SELECT maintenance.close_price_days(now(), 30)');
  const probe = db.pool('svc_admin');
  const rows: Array<{ min: string; changes: number }> = await inTenant(probe, w.tenantId, async (tx) => (await tx.query(
    `SELECT min_amount_minor::text AS min, change_count AS changes FROM tenant_data.price_daily WHERE tenant_id = $1 AND write_scope_id = $2 AND price_day = $3::date`,
    [w.tenantId, ws, yesterday])).rows, w.userId);
  assert.equal(rows.length, 1, 'yesterday is closed');
  assert.equal(Number(rows[0]!.min), 1500, 'risk 28: a price the channel did not apply is rolled up into the daily price');
  assert.equal(rows[0]!.changes, 1);
});
