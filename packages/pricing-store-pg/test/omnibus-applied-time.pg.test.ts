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
  // Сутки витрины de — Europe/Berlin. Границу суток считает база, а не арифметика в JS: смещение пояса меняется зимой и летом
  const midnightMs = Date.parse(new Date((await scheduler.query(
    `SELECT (date_trunc('day', (now() - interval '3 days') AT TIME ZONE 'Europe/Berlin') AT TIME ZONE 'Europe/Berlin') AS at`)).rows[0].at).toISOString());
  // Принято за 10 минут до полуночи витрины, применено через 10 минут после неё
  const acceptedAt = new Date(midnightMs - 10 * 60_000).toISOString();
  const appliedAt = new Date(midnightMs + 10 * 60_000).toISOString();
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
      // Запись завершена сейчас (секции журнала записей — суточные), время применения канала — момент из прошлого
      `INSERT INTO tenant_data.channel_write_history (tenant_id, channel_write_id, finished_at, write_scope_id, field, amount_minor, currency, price_basis, version, origin, final_status, attempt_count, created_at, applied_at)
       VALUES ($1, $2, now(), $4, 'PRICE', 1500, 'EUR', 'GROSS', 1, 'ENGINE', 'APPLIED', 1, $5, $3)`, [w.tenantId, writeId, appliedAt, w.ids.dbId('ws-2601'), acceptedAt]);
  });
  await scheduler.query('SELECT maintenance.close_price_days($1, 10)', [new Date().toISOString()]);
  // Свёртку цен читает административная роль: у пути решения прав на вечное доказательство нет [Р-90]
  const rows = await inTenant(admin, w.tenantId, async (tx) => (await tx.query(
    `SELECT price_day::text AS price_day, change_count FROM tenant_data.price_daily WHERE tenant_id = $1 AND write_scope_id = $2 ORDER BY price_day`,
    [w.tenantId, w.ids.dbId('ws-2601')])).rows);
  // Сутки принятия и применения по поясу витрины — тоже из базы
  const { rows: [days] } = await scheduler.query(
    // Текстом: DATE в драйвере становится полуночью ЛОКАЛЬНОГО пояса процесса и при переводе в UTC уезжает на сутки
    `SELECT ($1::timestamptz AT TIME ZONE 'Europe/Berlin')::date::text AS accepted, ($2::timestamptz AT TIME ZONE 'Europe/Berlin')::date::text AS applied`, [acceptedAt, appliedAt]);
  const dayOf = (v: string) => v;
  assert.notEqual(dayOf(days.accepted), dayOf(days.applied), 'сутки принятия и применения — разные (проверка сценария)');
  // Сдвиг суток свёртки относительно суток ПРИНЯТИЯ: 1 — цена учтена в сутках применения, 0 — в сутках принятия (защиты нет)
  // Без защиты свёртка либо кладёт цену в сутки принятия (сдвиг 0), либо не закрывает её сутки вовсе (свёртки нет — тоже 0)
  const shiftDays = rows.length === 1
    ? Math.round((Date.parse(`${rows[0]!.price_day}T00:00:00Z`) - Date.parse(`${dayOf(days.accepted)}T00:00:00Z`)) / 86_400_000)
    : 0;
  assert.equal(shiftDays, 1, 'OQ-180: a price applied after midnight is rolled up into the day it was accepted');
  assert.equal(Number(rows[0]!.change_count), 1);
});
