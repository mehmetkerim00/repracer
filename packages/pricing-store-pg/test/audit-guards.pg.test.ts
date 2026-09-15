import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { standUserOf, type MemorySeedScope } from '@repracer/pricing-pipeline';
import { createPool, inTenant, PgPricingStore, seedPricingWorld } from '../src/index.ts';
import { requireEnv } from './isolated-db.ts';

/**
 * Находки 1–3 ревью шага 14 и Р-88 — поведение базы, каждый отказ рядом с разрешённым случаем:
 *  1. запись о снятии системной остановки — только о настоящем снятии в той же транзакции и от участника с правом;
 *  2. остановка человеком не вставляется сразу снятой;
 *  3. автоматическое снятие — система, чистая выборка в момент снятия, после окна;
 *  Р-88: снятие остановки тенанта — только со вторым фактором.
 * Данные синтетические.
 */

const pool = createPool(requireEnv('REPRACER_PG_URL'), { max: 4, applicationName: 'repracer-audit-guards-test' });
const provisioning = createPool(requireEnv('REPRACER_PG_URL').replace('svc_app@', 'svc_provisioning@'), { max: 1, applicationName: 'repracer-test-provisioning' });
const admin = createPool(requireEnv('REPRACER_PG_URL').replace('svc_app@', 'svc_admin@'), { max: 2, applicationName: 'repracer-test-admin' });
after(async () => {
  await pool.end();
  await provisioning.end();
  await admin.end();
});

const ACCOUNT = '20000000-0000-4000-8000-000000000146';
const now = () => new Date().toISOString();
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

const scope: MemorySeedScope = {
  writeScopeId: 'ws-1', productId: 'prod-1', channelAccountId: ACCOUNT, marketplace: 'de', externalUnitId: '14601', channelProductRef: '3621461',
  condition: 'new', currency: 'EUR', basis: 'GROSS', pricingMode: 'ENGINE', strategy: { strategyId: 'st', version: 1, params: { type: 'FIXED', priceMinor: 2000 }, deadbandMinor: 0 },
  currentPriceMinor: 1850, minPrice: { amountMinor: 1500, id: 'min-1' }, maxPrice: { amountMinor: 2500, id: 'max-1' },
};

async function world(halts: Array<{ marketplace: string; haltedAt: string; reviewWindowSeconds?: number }>) {
  return seedPricingWorld(pool, { provisioningPool: provisioning, adminPool: admin,
    fixtureTenantId: '10000000-0000-4000-8000-000000000146', fixtureChannelAccountId: ACCOUNT, marketplaces: ['de', 'at'], clock: now(), seed: { scopes: [scope], halts },
  });
}

const reason = (e: unknown) => String((e as Error).message);
const outcome = (p: Promise<unknown>) => p.then(() => 'accepted', reason);

test('finding 1: a manual release review without the release, from a viewer, or for a released halt is refused; the real release is accepted', async () => {
  const w = await world([{ marketplace: 'de', haltedAt: ago(3_600_000) }]);
  const store = new PgPricingStore(pool, { adminPool: admin });
  const [halt] = await inTenant(pool, w.tenantId, async (tx) => (await tx.query('SELECT pricing_halt_id FROM channel_data.pricing_halt WHERE tenant_id = $1', [w.tenantId])).rows);
  const review = (membership: string) => (tx: { query: typeof pool.query }) => tx.query(
    `INSERT INTO channel_data.pricing_halt_review (tenant_id, pricing_halt_id, kind, outcome, sample_size, failed_count, membership_id, note)
     VALUES ($1, $2, 'MANUAL_RELEASE', 'RELEASED', 0, 0, $3, 'Synthetic forged release record')`, [w.tenantId, halt.pricing_halt_id, w.ids.dbId(membership)]);

  assert.match(await outcome(inTenant(admin, w.tenantId, review('membership-operator'), w.ids.dbId(standUserOf('membership-operator')), { mfa: true })), /did not happen/,
    'a release record without the release fails at commit');
  assert.match(await outcome(inTenant(admin, w.tenantId, review('membership-viewer'), w.ids.dbId(standUserOf('membership-viewer')), { mfa: true })), /may not release/);
  const events = await inTenant(pool, w.tenantId, async (tx) => (await tx.query(`SELECT count(*)::int AS n FROM audit.audit_event WHERE tenant_id = $1 AND action = 'pricing.halt_released'`, [w.tenantId])).rows[0].n);
  assert.equal(events, 0, 'no audit event survives a refused release');

  await store.releaseHalt(w.tenantId, halt.pricing_halt_id, {
    kind: 'MANUAL_RELEASE', mfa: true, outcome: 'RELEASED', sampleSize: 0, failedCount: 0, details: {}, membershipId: w.ids.dbId('membership-operator'),
    userId: w.ids.dbId(standUserOf('membership-operator')), note: 'Synthetic release after the check', at: now(),
  });
  assert.match(await outcome(inTenant(admin, w.tenantId, review('membership-operator'), w.ids.dbId(standUserOf('membership-operator')), { mfa: true })), /not active/,
    'no second release record for a released halt');
});

test('finding 2: a price stop cannot be inserted already released', async () => {
  const w = await world([]);
  // Р-90: остановку человеком ставит административный сервис — у роли пути решения прав на price_stop нет
  const insert = (released: boolean) => inTenant(admin, w.tenantId, (tx) => tx.query(
    `INSERT INTO tenant_data.price_stop (tenant_id, scope_type, channel_account_id, marketplace, stopped_by_membership_id, stop_note, released_at, released_by_membership_id, release_note)
     VALUES ($1, 'STOREFRONT', $2, 'de', $3, 'Synthetic stop for the insert check', $4, $5, $6)`,
    [w.tenantId, w.channelAccountId, w.ids.dbId('membership-operator'), released ? now() : null, released ? w.ids.dbId('membership-owner') : null, released ? 'Released by someone else' : null]),
    w.ids.dbId(standUserOf('membership-operator')));
  assert.match(await outcome(insert(true)), /created active/);
  assert.equal(await outcome(insert(false)), 'accepted');
});

test('finding 3: an automatic release needs the system, a clean sample at the release and an elapsed window', async () => {
  const w = await world([{ marketplace: 'de', haltedAt: ago(3_600_000), reviewWindowSeconds: 60 }, { marketplace: 'at', haltedAt: ago(10_000), reviewWindowSeconds: 3600 }]);
  const store = new PgPricingStore(pool, { adminPool: admin });
  const halts = await inTenant(pool, w.tenantId, async (tx) => (await tx.query('SELECT pricing_halt_id, marketplace FROM channel_data.pricing_halt WHERE tenant_id = $1', [w.tenantId])).rows);
  const due = halts.find((h) => h.marketplace === 'de')!.pricing_halt_id;
  const early = halts.find((h) => h.marketplace === 'at')!.pricing_halt_id;
  const auto = (sampleSize: number) => ({ kind: 'AUTO_SAMPLE' as const, outcome: 'RELEASED' as const, sampleSize, failedCount: 0, details: {}, at: now() });

  // Пользователь сессии бывает только у административного сервиса (Р-90): автоматическое снятие в такой сессии — отказ
  const inUserSession = inTenant(admin, w.tenantId, async (tx) => {
    await tx.query(`INSERT INTO channel_data.pricing_halt_review (tenant_id, pricing_halt_id, kind, outcome, sample_size, failed_count) VALUES ($1, $2, 'AUTO_SAMPLE', 'RELEASED', 3, 0)`, [w.tenantId, due]);
    await tx.query(`UPDATE channel_data.pricing_halt SET released_at = now(), released_kind = 'AUTO' WHERE tenant_id = $1 AND pricing_halt_id = $2`, [w.tenantId, due]);
  }, w.ids.dbId(standUserOf('membership-owner')));
  assert.match(await outcome(inUserSession), /system action/);
  assert.match(await outcome(store.releaseHalt(w.tenantId, early, auto(3))), /after the review window/);
  const mismatched = inTenant(pool, w.tenantId, async (tx) => {
    await tx.query(`INSERT INTO channel_data.pricing_halt_review (tenant_id, pricing_halt_id, kind, outcome, sample_size, failed_count, reviewed_at) VALUES ($1, $2, 'AUTO_SAMPLE', 'RELEASED', 3, 0, now() - interval '1 minute')`, [w.tenantId, due]);
    await tx.query(`UPDATE channel_data.pricing_halt SET released_at = now(), released_kind = 'AUTO' WHERE tenant_id = $1 AND pricing_halt_id = $2`, [w.tenantId, due]);
  });
  assert.match(await outcome(mismatched), /clean sample reviewed at the release/);
  assert.equal(await outcome(store.releaseHalt(w.tenantId, due, auto(3))), 'accepted');
});

test('Р-88: releasing the tenant stop needs a second factor; a storefront stop does not', async () => {
  const w = await world([]);
  const store = new PgPricingStore(pool, { adminPool: admin });
  const owner = { membershipId: w.ids.dbId('membership-owner'), userId: w.ids.dbId(standUserOf('membership-owner')) };
  const stop = async (scope: 'TENANT' | 'STOREFRONT') => {
    const r = await store.stopPricing(w.tenantId, {
      scope, channelAccountId: scope === 'TENANT' ? null : w.channelAccountId, marketplace: scope === 'TENANT' ? null : 'de', stoppedAt: now(),
      stoppedByMembershipId: owner.membershipId, stoppedByUserId: owner.userId, note: 'Synthetic stop for the factor check',
    });
    assert.ok(r.status === 'STOPPED', JSON.stringify(r));
    return r.stop.stopId;
  };
  const tenantStop = await stop('TENANT');
  const release = (mfa: boolean) => ({ ...owner, mfa, note: 'Synthetic resume for the factor check', at: now() });
  assert.equal((await store.releaseStop(w.tenantId, tenantStop, release(false))).status, 'MFA_REQUIRED');
  assert.equal((await store.releaseStop(w.tenantId, tenantStop, release(true))).status, 'RELEASED');
  assert.equal((await store.releaseStop(w.tenantId, await stop('STOREFRONT'), release(false))).status, 'RELEASED');
});
