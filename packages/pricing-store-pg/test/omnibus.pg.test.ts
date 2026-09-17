import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { omnibusLowestPriorPrice, type OmnibusPriorPrice } from '@repracer/pricing-model';
import { createPool, PgPricingStore, seedPricingWorld } from '../src/index.ts';

/**
 * Р-123 (шаг 24): наименьшая цена за 30 суток витрины в базе (omnibus_lowest_prior_price, 0087) равна правилу в коде
 * (omnibusLowestPriorPrice): закрытые сутки — из суточной свёртки с исправлениями, незакрытые — из сырья, цена к началу окна — последнее
 * изменение до него. Данные синтетические; сырьё и свёртка вставляются суперпользователем стенда как фикстура.
 */
const PG_URL = process.env.REPRACER_PG_URL;
const ADMIN_URL = process.env.REPRACER_PG_ADMIN_URL;
if (!PG_URL || !ADMIN_URL) throw new Error('REPRACER_PG_URL and REPRACER_PG_ADMIN_URL are required: database tests do not skip (Р-84)');
const pool = createPool(PG_URL, { max: 2, applicationName: 'repracer-step24-omnibus' });
const provisioning = createPool(PG_URL.replace('svc_app@', 'svc_provisioning@'), { max: 1, applicationName: 'repracer-step24-omnibus-provisioning' });
const admin = createPool(PG_URL.replace('svc_app@', 'svc_admin@'), { max: 2, applicationName: 'repracer-step24-omnibus-admin' });
const superuserUrl = new URL(ADMIN_URL);
superuserUrl.pathname = new URL(PG_URL).pathname;
const superuser = createPool(superuserUrl.toString(), { max: 1, applicationName: 'repracer-step24-omnibus-fixture' });
after(async () => { await pool.end(); await provisioning.end(); await admin.end(); await superuser.end(); });

const TZ = 'Europe/Berlin';
const ACCOUNT = '20000000-0000-4000-8000-000000002410';

test('Р-123: the lowest price of 30 storefront days in the database equals the rule in the code, with closed days, open days, a correction and short history', async () => {
  const w = await seedPricingWorld(pool, {
    provisioningPool: provisioning, adminPool: admin, fixtureTenantId: '10000000-0000-4000-8000-000000002410', fixtureChannelAccountId: ACCOUNT,
    marketplaces: ['de'], clock: new Date().toISOString(),
    seed: { scopes: [{
      writeScopeId: 'ws-omnibus', productId: 'prod-omnibus', channelAccountId: ACCOUNT, marketplace: 'de', externalUnitId: '2410', channelProductRef: '362002410', condition: 'new',
      currency: 'EUR', basis: 'GROSS', pricingMode: 'OFF', strategy: null, currentPriceMinor: 1990, minPrice: { amountMinor: 1000, id: 'min-omnibus' }, maxPrice: { amountMinor: 5000, id: 'max-omnibus' },
    }] },
  });
  const ws = w.ids.dbId('ws-omnibus');
  const { rows: [scope] } = await superuser.query('SELECT product_id FROM tenant_data.write_scope WHERE tenant_id = $1 AND write_scope_id = $2', [w.tenantId, ws]);
  const changes = [
    { acceptedAt: '2026-08-02T10:00:00.000Z', amountMinor: 1990, closed: true },
    { acceptedAt: '2026-08-10T09:00:00.000Z', amountMinor: 1790, closed: true },
    { acceptedAt: '2026-08-20T09:00:00.000Z', amountMinor: 1890, closed: true },
    // 23:30 по Берлину 05.09 и 00:30 по Берлину 15.09 — сутки ещё не закрыты: только сырьё
    { acceptedAt: '2026-09-05T21:30:00.000Z', amountMinor: 1850, closed: false },
    { acceptedAt: '2026-09-14T22:30:00.000Z', amountMinor: 1700, closed: false },
  ];
  for (const [i, c] of changes.entries()) {
    await superuser.query(
      `INSERT INTO tenant_data.price_history (tenant_id, accepted_at, write_scope_id, product_id, amount_minor, currency, price_basis, effective_min_price_minor, channel_write_id, write_version)
       VALUES ($1, $2, $3, $4, $5, 'EUR', 'GROSS', 1000, $6, $7)`, [w.tenantId, c.acceptedAt, ws, scope.product_id, c.amountMinor, randomUUID(), i + 1]);
    if (c.closed) {
      await superuser.query(
        `INSERT INTO tenant_data.price_daily (tenant_id, write_scope_id, price_type, price_day, day_tz, currency, price_basis, min_amount_minor, max_amount_minor,
                                              first_amount_minor, first_accepted_at, last_amount_minor, last_accepted_at, change_count, min_floor_minor)
         VALUES ($1, $2, 'REGULAR', ($3::timestamptz AT TIME ZONE '${TZ}')::date, '${TZ}', 'EUR', 'GROSS', $4, $4, $4, $3, $4, $3, 1, 1000)`,
        [w.tenantId, ws, c.acceptedAt, c.amountMinor]);
    }
  }
  const database = async (startsAt: string): Promise<OmnibusPriorPrice> => {
    const { rows: [r] } = await superuser.query('SELECT * FROM tenant_data.omnibus_lowest_prior_price($1, $2, $3)', [w.tenantId, ws, startsAt]);
    const day = (d: Date | null) => (d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : null);
    return {
      status: r.status, lowestMinor: r.lowest_minor === null ? null : Number(r.lowest_minor), windowFrom: day(r.window_from), windowTo: day(r.window_to), timeZone: r.day_tz,
      historySince: r.history_since ? new Date(r.history_since).toISOString() : null,
    };
  };
  const cases: Array<[string, string, number]> = [
    ['2026-09-15T08:00:00.000Z', 'OK', 1790],
    ['2026-09-12T08:00:00.000Z', 'OK', 1790],
    ['2026-08-05T08:00:00.000Z', 'INCOMPLETE_HISTORY', 1990],
    ['2026-09-25T08:00:00.000Z', 'OK', 1700],
  ];
  for (const [startsAt, status, lowest] of cases) {
    const code = omnibusLowestPriorPrice(changes, TZ, startsAt);
    assert.deepEqual(await database(startsAt), code, `database equals code for a discount starting ${startsAt}`);
    assert.deepEqual([code.status, code.lowestMinor], [status, lowest], startsAt);
  }

  // Исправление суточной свёртки (Р-29) — база берёт исправленную цену, код получает исправленное сырьё
  await superuser.query(
    `INSERT INTO tenant_data.price_daily_correction (tenant_id, write_scope_id, price_type, price_day, min_amount_minor, max_amount_minor, first_amount_minor,
       first_accepted_at, last_amount_minor, last_accepted_at, change_count, min_floor_minor, reason, created_by_membership_id)
     SELECT tenant_id, write_scope_id, price_type, price_day, 1690, 1690, 1690, first_accepted_at, 1690, last_accepted_at, 1, min_floor_minor,
            'Synthetic correction: the channel applied 16.90', $3
       FROM tenant_data.price_daily WHERE tenant_id = $1 AND write_scope_id = $2 AND price_day = '2026-08-10'`, [w.tenantId, ws, w.ownerMembershipId]);
  const corrected = changes.map((c) => (c.acceptedAt === '2026-08-10T09:00:00.000Z' ? { ...c, amountMinor: 1690 } : c));
  assert.deepEqual(await database('2026-09-15T08:00:00.000Z'), omnibusLowestPriorPrice(corrected, TZ, '2026-09-15T08:00:00.000Z'));
  assert.equal((await database('2026-09-15T08:00:00.000Z')).lowestMinor, 1690, 'the corrected daily price is the lowest');

  // Хранилище консоли на PostgreSQL: проверка до записи, отказ базы при нарушении, объявление с сохранённой проверкой, доказательная история
  const store = new PgPricingStore(pool, { adminPool: admin });
  const owner = { membershipId: w.ownerMembershipId, userId: w.userId, mfa: false };
  const startsAt = '2026-09-15T08:00:00.000Z';
  assert.deepEqual(await store.omnibusCheck(w.tenantId, ws, startsAt), await database(startsAt));
  const discount = { writeScopeId: ws, referencePriceMinor: 1690, salePriceMinor: 1490, currency: 'EUR', startsAt, endsAt: '2026-09-22T08:00:00.000Z' };
  const violation = await store.announceDiscount(w.tenantId, { ...discount, referencePriceMinor: 1691 }, owner);
  assert.deepEqual([violation.status, violation.status === 'VIOLATION' && violation.check.lowestMinor], ['VIOLATION', 1690], 'one cent above the lowest price is refused by the database');
  assert.deepEqual(await store.announceDiscount(w.tenantId, { ...discount, currency: 'USD' }, owner), { status: 'INVALID', cause: 'CURRENCY_MISMATCH' });
  assert.deepEqual(await store.announceDiscount(w.tenantId, { ...discount, salePriceMinor: 1690 }, owner), { status: 'INVALID', cause: 'PRICES_INVALID' });
  assert.deepEqual(await store.announceDiscount(w.tenantId, { ...discount, endsAt: startsAt }, owner), { status: 'INVALID', cause: 'PERIOD_INVALID' });
  const announced = await store.announceDiscount(w.tenantId, discount, owner);
  assert.equal(announced.status, 'ANNOUNCED', JSON.stringify(announced));
  const [row] = await store.discountAnnouncements(w.tenantId);
  assert.deepEqual([row?.referencePriceMinor, row?.check.status, row?.check.lowestMinor, row?.check.windowFrom, row?.check.windowTo, row?.check.timeZone],
    [1690, 'OK', 1690, '2026-08-16', '2026-09-14', TZ], 'the stored check is the one of the database at announcement');

  const evidence = await store.priceEvidence(w.tenantId, { from: '2026-08-01', to: '2026-09-30', writeScopeIds: [ws] });
  assert.deepEqual(evidence.map((d) => [d.day, d.source, d.minMinor, d.lastMinor, d.corrected]), [
    ['2026-08-02', 'CLOSED', 1990, 1990, false],
    ['2026-08-10', 'CLOSED', 1690, 1690, true],
    ['2026-08-20', 'CLOSED', 1890, 1890, false],
    ['2026-09-05', 'OPEN', 1850, 1850, false],
    ['2026-09-15', 'OPEN', 1700, 1700, false],
  ], 'closed days from the daily roll-up with the correction marked, open days from raw prices by storefront day');
});
