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

async function world(halts: Array<{ marketplace: string; haltedAt: string; reviewWindowSeconds?: number }>, scopes: MemorySeedScope[] = [scope]) {
  return seedPricingWorld(pool, { provisioningPool: provisioning, adminPool: admin,
    fixtureTenantId: '10000000-0000-4000-8000-000000000146', fixtureChannelAccountId: ACCOUNT, marketplaces: ['de', 'at'], clock: now(), seed: { scopes, halts },
  });
}

/** Единица со стратегией по рынку: попадает в размер выборки проверки остановки */
const buyboxScope = (n: number): MemorySeedScope => ({
  ...scope, writeScopeId: `ws-${n}`, productId: `prod-${n}`, externalUnitId: `1460${n}`, channelProductRef: `362147${n}`,
  strategy: { strategyId: 'st-buybox', version: 1, params: { type: 'MATCH_BUYBOX', undercutMinor: 5, holdWhenWinning: true, atBound: 'CAP' }, deadbandMinor: 0 },
});

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
  // Р-96: журнал аудита читает административный сервис
  const events = await inTenant(admin, w.tenantId, async (tx) => (await tx.query(`SELECT count(*)::int AS n FROM audit.audit_event WHERE tenant_id = $1 AND action = 'pricing.halt_released'`, [w.tenantId])).rows[0].n);
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

test('finding 3, step 16 finding 2: an automatic release is computed by the database from the recorded sample — the decision path writes neither the review nor the release', async () => {
  const w = await world([{ marketplace: 'de', haltedAt: ago(3_600_000), reviewWindowSeconds: 60 }, { marketplace: 'at', haltedAt: ago(10_000), reviewWindowSeconds: 3600 }]);
  const store = new PgPricingStore(pool, { adminPool: admin });
  const halts = await inTenant(pool, w.tenantId, async (tx) => (await tx.query('SELECT pricing_halt_id, marketplace FROM channel_data.pricing_halt WHERE tenant_id = $1', [w.tenantId])).rows);
  const due = halts.find((h) => h.marketplace === 'de')!.pricing_halt_id;
  const early = halts.find((h) => h.marketplace === 'at')!.pricing_halt_id;
  const accept = (ref: string, observedAt = now()) => ({ channelProductRef: ref, observedAt, verdict: 'ACCEPT' as const, reasonCode: null });
  const halt = async (id: string) => (await inTenant(pool, w.tenantId, async (tx) => (await tx.query(
    'SELECT released_at, released_kind, next_review_at FROM channel_data.pricing_halt WHERE tenant_id = $1 AND pricing_halt_id = $2', [w.tenantId, id])).rows))[0];

  // Пользователь сессии бывает только у административного сервиса (Р-90): автоматическое снятие в такой сессии — отказ
  const inUserSession = inTenant(admin, w.tenantId, async (tx) => {
    await tx.query(`INSERT INTO channel_data.pricing_halt_review (tenant_id, pricing_halt_id, kind, outcome, sample_size, failed_count) VALUES ($1, $2, 'AUTO_SAMPLE', 'RELEASED', 3, 0)`, [w.tenantId, due]);
    await tx.query(`UPDATE channel_data.pricing_halt SET released_at = now(), released_kind = 'AUTO' WHERE tenant_id = $1 AND pricing_halt_id = $2`, [w.tenantId, due]);
  }, w.ids.dbId(standUserOf('membership-owner')));
  assert.match(await outcome(inUserSession), /automatic halt review is a system action/);

  // Подделка шага 16 (сдвиг срока, запись проверки, снятие) — у пути решения нет ни одного из этих прав (Р-96)
  assert.match(await outcome(inTenant(pool, w.tenantId, (tx) => tx.query(
    `UPDATE channel_data.pricing_halt SET next_review_at = now() - interval '1 day' WHERE tenant_id = $1 AND pricing_halt_id = $2`, [w.tenantId, early]))),
  /permission denied for table pricing_halt$/);
  assert.match(await outcome(inTenant(pool, w.tenantId, (tx) => tx.query(
    `INSERT INTO channel_data.pricing_halt_review (tenant_id, pricing_halt_id, kind, outcome, sample_size, failed_count) VALUES ($1, $2, 'AUTO_SAMPLE', 'RELEASED', 3, 0)`, [w.tenantId, due]))),
  /permission denied for table pricing_halt_review$/);
  assert.match(await outcome(inTenant(pool, w.tenantId, (tx) => tx.query(
    `INSERT INTO channel_data.pricing_halt_sample (tenant_id, pricing_halt_id, channel_product_ref, observed_at, recorded_at, verdict) VALUES ($1, $2, '3621461', now(), now() + interval '1 day', 'ACCEPT')`,
    [w.tenantId, early]))),
  /permission denied for table pricing_halt_sample$/, 'the time a sample is recorded is set by the database');
  assert.match(await outcome(store.releaseHalt(w.tenantId, due, { kind: 'AUTO_SAMPLE', outcome: 'RELEASED', sampleSize: 3, failedCount: 0, details: {}, at: now() })),
    /computed by the database from the recorded sample/);

  // Срок не наступил — отдельный тест ниже: здесь у витрины at нет товаров, и выборка была бы неполной при любом сроке [Р-104]

  // Срок наступил: без наблюдений, с наблюдением до срока и с наблюдением чужого товара — выборки нет
  assert.equal(await store.reviewHaltBySample(w.tenantId, due, now()), 'NO_SAMPLE', 'NO_SAMPLE: nothing was observed');
  await store.recordHaltSample(w.tenantId, due, [accept('3621461', ago(3_590_000)), accept('9999999')], now());
  assert.equal(await store.reviewHaltBySample(w.tenantId, due, now()), 'NO_SAMPLE', 'NO_SAMPLE: a stale observation and a product outside the storefront do not count');
  assert.equal((await halt(due)).released_at, null);

  // Чистое наблюдение рядом с неудачным — проверка не прошла, срок сдвинут на окно
  await store.recordHaltSample(w.tenantId, due, [accept('3621461'), { channelProductRef: '3621462', observedAt: now(), verdict: 'READ_FAILED', reasonCode: 'CHANNEL_TIMEOUT' }], now());
  assert.equal(await store.reviewHaltBySample(w.tenantId, due, now()), 'SAMPLE_FAILED', 'SAMPLE_FAILED: one failed observation fails the review');
  const failed = await halt(due);
  assert.equal(failed.released_at, null);
  assert.ok(new Date(failed.next_review_at).getTime() > Date.now() + 30_000, 'the next review waits for the window');

  // Чистая выборка после окна — снятие базой, запись проверки AUTO_SAMPLE, повтор не снимает второй раз
  const fresh = await world([{ marketplace: 'de', haltedAt: ago(3_600_000), reviewWindowSeconds: 60 }]);
  const [freshHalt] = await inTenant(pool, fresh.tenantId, async (tx) => (await tx.query('SELECT pricing_halt_id FROM channel_data.pricing_halt WHERE tenant_id = $1', [fresh.tenantId])).rows);
  // Наблюдение позже момента проверки не считается (выборка — до момента, 0065)
  await store.recordHaltSample(fresh.tenantId, freshHalt.pricing_halt_id, [accept('3621461', new Date(Date.now() + 120_000).toISOString())], now());
  assert.equal(await store.reviewHaltBySample(fresh.tenantId, freshHalt.pricing_halt_id, now()), 'NO_SAMPLE', 'NO_SAMPLE: an observation after the review moment does not count');
  // Проверка идёт только в контексте своего тенанта
  assert.match(await outcome(inTenant(pool, w.tenantId, (tx) => tx.query('SELECT channel_data.review_halt_by_sample($1, $2, now())', [fresh.tenantId, freshHalt.pricing_halt_id]))),
    /outside the tenant context/, 'the review of a halt runs only in the context of its own tenant');
  await store.recordHaltSample(fresh.tenantId, freshHalt.pricing_halt_id, [accept('3621461')], now());
  assert.equal(await store.reviewHaltBySample(fresh.tenantId, freshHalt.pricing_halt_id, now()), 'RELEASED');
  const released = await store.dumpState(fresh.tenantId);
  assert.deepEqual(released.halts.map((h: { releasedKind: string | null }) => h.releasedKind), ['AUTO']);
  assert.deepEqual(released.haltReviews.map((r: { kind: string; outcome: string }) => [r.kind, r.outcome]), [['AUTO_SAMPLE', 'RELEASED']]);
  assert.equal(await store.reviewHaltBySample(fresh.tenantId, freshHalt.pricing_halt_id, now()), 'NOT_ACTIVE');
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
  assert.equal((await store.releaseStop(w.tenantId, tenantStop, release(false))).status, 'MFA_REQUIRED', 'Р-88: the tenant stop is not released without a second factor');
  assert.equal((await store.releaseStop(w.tenantId, tenantStop, release(true))).status, 'RELEASED');
  assert.equal((await store.releaseStop(w.tenantId, await stop('STOREFRONT'), release(false))).status, 'RELEASED');
});

test('finding 3: before the review window elapses a clean full sample does not release, and a moment in the future does not shorten the window', async () => {
  // Р-104: единственный товар витрины принят — без проверки срока остановка была бы снята (RELEASED), а не отклонена неполной выборкой
  const w = await world([{ marketplace: 'de', haltedAt: ago(10_000), reviewWindowSeconds: 3600 }]);
  const store = new PgPricingStore(pool, { adminPool: admin });
  const [h] = await inTenant(pool, w.tenantId, async (tx) => (await tx.query('SELECT pricing_halt_id FROM channel_data.pricing_halt WHERE tenant_id = $1', [w.tenantId])).rows);
  await store.recordHaltSample(w.tenantId, h.pricing_halt_id, [{ channelProductRef: '3621461', observedAt: now(), verdict: 'ACCEPT', reasonCode: null }], now());
  assert.equal(await store.reviewHaltBySample(w.tenantId, h.pricing_halt_id, now()), 'NOT_DUE', 'NOT_DUE: the review window has not elapsed');
  assert.equal(await store.reviewHaltBySample(w.tenantId, h.pricing_halt_id, new Date(Date.now() + 86_400_000).toISOString()), 'NOT_DUE',
    'NOT_DUE: the review window has not elapsed and a moment in the future does not shorten it');
});

test('finding 3: an observation recorded before the review window elapsed does not count, even if it claims a later moment', async () => {
  // Р-104: окно проверки держит фильтр «наблюдение записано базой после срока проверки» — ветка NOT_DUE лишь код ответа. Сценарий, где
  // без фильтра остановка была бы снята: наблюдение записано сейчас с моментом через секунду, срок проверки переносит владелец (со
  // вторым фактором, находка 5 ревью шага 17) между моментом записи и заявленным моментом наблюдения; проверка — после обоих
  const w = await world([{ marketplace: 'de', haltedAt: ago(10_000), reviewWindowSeconds: 3600 }]);
  const store = new PgPricingStore(pool, { adminPool: admin });
  const [h] = await inTenant(pool, w.tenantId, async (tx) => (await tx.query('SELECT pricing_halt_id FROM channel_data.pricing_halt WHERE tenant_id = $1', [w.tenantId])).rows);
  const { rows: [clock] } = await pool.query(`SELECT now() + interval '1 second' AS observed, now() + interval '500 milliseconds' AS review`);
  await store.recordHaltSample(w.tenantId, h.pricing_halt_id, [{ channelProductRef: '3621461', observedAt: new Date(clock.observed).toISOString(), verdict: 'ACCEPT', reasonCode: null }], now());
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  await inTenant(admin, w.tenantId, (tx) => tx.query('UPDATE channel_data.pricing_halt SET next_review_at = $3 WHERE tenant_id = $1 AND pricing_halt_id = $2',
    [w.tenantId, h.pricing_halt_id, clock.review]), w.ids.dbId(standUserOf('membership-owner')), { mfa: true });
  assert.equal(await store.reviewHaltBySample(w.tenantId, h.pricing_halt_id, now()), 'NO_SAMPLE',
    'NO_SAMPLE: an observation recorded before the review window elapsed does not count');
});

test('finding 3: a moment in the future does not push the review record or the next review', async () => {
  // Р-104: least(p_at, now()) — без него неудачная проверка с моментом из будущего сдвигает следующую проверку на сутки вперёд
  const w = await world([{ marketplace: 'de', haltedAt: ago(3_600_000), reviewWindowSeconds: 60 }]);
  const store = new PgPricingStore(pool, { adminPool: admin });
  const [h] = await inTenant(pool, w.tenantId, async (tx) => (await tx.query('SELECT pricing_halt_id FROM channel_data.pricing_halt WHERE tenant_id = $1', [w.tenantId])).rows);
  await store.recordHaltSample(w.tenantId, h.pricing_halt_id, [{ channelProductRef: '3621461', observedAt: now(), verdict: 'READ_FAILED', reasonCode: 'CHANNEL_TIMEOUT' }], now());
  assert.equal(await store.reviewHaltBySample(w.tenantId, h.pricing_halt_id, new Date(Date.now() + 86_400_000).toISOString()), 'SAMPLE_FAILED');
  const [row] = await inTenant(pool, w.tenantId, async (tx) => (await tx.query(
    `SELECT next_review_at <= now() + interval '5 minutes' AS within FROM channel_data.pricing_halt WHERE tenant_id = $1 AND pricing_halt_id = $2`, [w.tenantId, h.pricing_halt_id])).rows);
  assert.equal(row.within, true, 'finding 3: the next review is scheduled from the database clock, not from a moment in the future');
});

test('finding 3: an automatic release needs as many accepted products as the sample requires', async () => {
  const w = await world([{ marketplace: 'de', haltedAt: ago(3_600_000), reviewWindowSeconds: 60 }], [buyboxScope(2), buyboxScope(3)]);
  const store = new PgPricingStore(pool, { adminPool: admin });
  const [h] = await inTenant(pool, w.tenantId, async (tx) => (await tx.query('SELECT pricing_halt_id FROM channel_data.pricing_halt WHERE tenant_id = $1', [w.tenantId])).rows);
  const accept = (ref: string) => ({ channelProductRef: ref, observedAt: now(), verdict: 'ACCEPT' as const, reasonCode: null });
  await store.recordHaltSample(w.tenantId, h.pricing_halt_id, [accept('3621472')], now());
  assert.equal(await store.reviewHaltBySample(w.tenantId, h.pricing_halt_id, now()), 'NO_SAMPLE', 'NO_SAMPLE: fewer accepted products than the sample requires');
  await store.recordHaltSample(w.tenantId, h.pricing_halt_id, [accept('3621473')], now());
  assert.equal(await store.reviewHaltBySample(w.tenantId, h.pricing_halt_id, now()), 'RELEASED', 'both products of the storefront accepted: the halt is released');
});

