import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { CompetitorSnapshot } from '@repracer/channel-port';
import type { EvaluationCommitResult, MemorySeedScope, ScopeEvaluationContext } from '@repracer/pricing-pipeline';
import { markAcceptedBySanity, type PriceDecisionDraft, type PriceIntentDraft } from '@repracer/pricing-model';
import { createPool, inTenant, PgPricingStore, seedPricingWorld, type SeededPricingWorld } from '../src/index.ts';
import { approved, commit, contextOf, explained } from './drafts.ts';

/**
 * Проверки, которые хранилище в памяти доказать не может: изоляция тенантов через RLS, триггеры границ и остановки
 * при фиксации, настоящая конкурентная транзакция для Р-54, очередь записей за записью в полёте, проекции OQ-93/94, объяснимость OQ-98.
 * REPRACER_PG_URL — роль приложения в одноразовой базе со всеми миграциями; без неё тесты пропускаются.
 */

const PG_URL = process.env.REPRACER_PG_URL;
const pool = PG_URL ? createPool(PG_URL, { max: 6, applicationName: 'repracer-store-pg-test' }) : null;
const provisioning = PG_URL ? createPool(PG_URL.replace('svc_app@', 'svc_provisioning@'), { max: 1, applicationName: 'repracer-test-provisioning' }) : null;
const admin = PG_URL ? createPool(PG_URL.replace('svc_app@', 'svc_admin@'), { max: 2, applicationName: 'repracer-test-admin' }) : null;
// Р-84: без базы тест не пропускается, а падает
if (!pool) throw new Error('REPRACER_PG_URL is required: database tests do not skip (Р-84)');
const skip = false;
after(async () => {
  await pool?.end();
  await provisioning?.end();
  await admin?.end();
});

const ACCOUNT = '20000000-0000-4000-8000-000000000001';
const BUYBOX = { strategyId: 'st-buybox', version: 1, params: { type: 'MATCH_BUYBOX', undercutMinor: 5, holdWhenWinning: true, atBound: 'CAP' }, deadbandMinor: 0 } as const;
const FIXED = { strategyId: 'st-fixed', version: 1, params: { type: 'FIXED', priceMinor: 2000 }, deadbandMinor: 0 } as const;
const SHIFT = { windowSeconds: 900, minFactor: 1.15 };
const now = () => new Date().toISOString();

function scopeSeed(n: number, strategy: MemorySeedScope['strategy']): MemorySeedScope {
  return {
    writeScopeId: `ws-${n}`, productId: `prod-${n}`, channelAccountId: ACCOUNT, marketplace: 'de', externalUnitId: String(n),
    channelProductRef: `3629${n}`, condition: 'new', currency: 'EUR', basis: 'GROSS', pricingMode: 'ENGINE', strategy,
    currentPriceMinor: 1850, minPrice: { amountMinor: 1500, id: `min-${n}` }, maxPrice: { amountMinor: 2500, id: `max-${n}` },
  };
}

async function seed(scopes: MemorySeedScope[]): Promise<SeededPricingWorld> {
  return seedPricingWorld(pool!, { provisioningPool: provisioning!, adminPool: admin!,
    fixtureTenantId: '10000000-0000-4000-8000-000000000001', fixtureChannelAccountId: ACCOUNT, marketplaces: ['de', 'at'], clock: now(), seed: { scopes },
  });
}

test('RLS: another tenant sees neither the scope nor its context and writes nothing for it', { skip }, async () => {
  const store = new PgPricingStore(pool!, { adminPool: admin! });
  const a = await seed([scopeSeed(1, BUYBOX)]);
  const b = await seed([scopeSeed(1, BUYBOX)]);
  const wsA = a.ids.dbId('ws-1');
  const key = { channelAccountId: a.channelAccountId, marketplace: 'de', channelProductRef: '36291', condition: 'new' };
  assert.equal((await store.loadEvaluationContext(a.tenantId, key, now(), SHIFT)).scopes.length, 1);
  assert.deepEqual((await store.loadEvaluationContext(b.tenantId, key, now(), SHIFT)).scopes, []);
  assert.equal(await store.loadScopeContext(b.tenantId, wsA, now()), null);
  const result = await commit(store, b.tenantId, approved(await contextOf(store, a.tenantId, wsA), 1800));
  assert.equal(result.status, 'CONTEXT_CHANGED');
  assert.deepEqual((await store.dumpState(a.tenantId)).intents, []);
  assert.deepEqual((await store.dumpState(b.tenantId)).intents, []);
});

test('Р-54: a bound changed between reading and commit rolls everything back', { skip }, async () => {
  const store = new PgPricingStore(pool!, { adminPool: admin! });
  const w = await seed([scopeSeed(2, BUYBOX)]);
  const ws = w.ids.dbId('ws-2');
  const stale = await contextOf(store, w.tenantId, ws);
  await w.setBound('ws-2', 'min', { amountMinor: 1700, id: 'min-2-v2' });
  const result = await commit(store, w.tenantId, approved(stale, 1600));
  assert.deepEqual(result, { status: 'CONTEXT_CHANGED', writeScopeId: ws, reason: { code: 'BOUNDS_VERSION_CHANGED', params: { attempt: 1, changed: 'MIN_PRICE', oldMinMinor: 1500, newMinMinor: 1700, oldMaxMinor: 2500, newMaxMinor: 2500, currency: 'EUR' } } });
  const state = await store.dumpState(w.tenantId);
  assert.deepEqual([state.intents, state.decisions, state.writes], [[], [], []]);
});

test('the database refuses a price above max_price even when the application claims a wider ceiling', { skip }, async () => {
  const store = new PgPricingStore(pool!, { adminPool: admin! });
  const w = await seed([scopeSeed(3, FIXED)]);
  const ws = w.ids.dbId('ws-3');
  const result = await commit(store, w.tenantId, approved(await contextOf(store, w.tenantId, ws), 3000, 3000));
  assert.equal(result.status, 'CONTEXT_CHANGED');
  assert.ok(result.status === 'CONTEXT_CHANGED' && result.reason.code === 'ABOVE_MAX_PRICE', JSON.stringify(result));
  assert.deepEqual((await store.dumpState(w.tenantId)).writes, []);
});

test('Р-51 in the database: a halt changes the context of competitor-derived decisions, fixed prices still go out', { skip }, async () => {
  const store = new PgPricingStore(pool!, { adminPool: admin! });
  const w = await seed([scopeSeed(4, BUYBOX), scopeSeed(5, FIXED)]);
  const buyboxWs = w.ids.dbId('ws-4');
  const fixedWs = w.ids.dbId('ws-5');
  const beforeHalt = await contextOf(store, w.tenantId, buyboxWs);
  await store.haltChannel(w.tenantId, { channelAccountId: w.channelAccountId, marketplace: 'de', reasonCode: 'CHANNEL_MASS_SHIFT', details: {}, haltedAt: now() });
  // Остановка — часть версии контекста: решение, принятое до неё, пересчитывается
  const stale = await commit(store, w.tenantId, approved(beforeHalt, 1800));
  assert.ok(stale.status === 'CONTEXT_CHANGED' && stale.reason.code === 'BOUNDS_VERSION_CHANGED');
  // Даже если приложение пропустит Gate при актуальном контексте, одобрение цены из данных конкурентов БД не примет
  const bypass = await commit(store, w.tenantId, approved(await contextOf(store, w.tenantId, buyboxWs), 1800));
  assert.ok(bypass.status === 'CONTEXT_CHANGED' && bypass.reason.code === 'CHANNEL_HALTED', JSON.stringify(bypass));
  const fixed = await commit(store, w.tenantId, approved(await contextOf(store, w.tenantId, fixedWs), 2000));
  assert.ok(fixed.status === 'COMMITTED' && fixed.decisions[0]!.write !== null);
  assert.deepEqual((await store.dumpState(w.tenantId)).writes.map((x) => [x.amountMinor, x.status]), [[2000, 'DISPATCHED']]);
});

test('Р-54: a concurrent bound change serialises with the decision commit and forces a recompute', { skip }, async () => {
  const store = new PgPricingStore(pool!, { adminPool: admin! });
  const w = await seed([scopeSeed(6, BUYBOX)]);
  const ws = w.ids.dbId('ws-6');
  const drafts = approved(await contextOf(store, w.tenantId, ws), 1800);
  // Р-96: границы меняет административный сервис; путь решения лишь ждёт его блокировку
  const other = await admin!.connect();
  let settled = false;
  try {
    // Р-97: изменение границы — действие владельца в сессии административного сервиса
    await other.query(`BEGIN; SELECT set_config('app.tenant_id', '${w.tenantId}', true), set_config('app.user_id', '${w.userId}', true)`);
    await other.query(
      `INSERT INTO tenant_data.max_price (tenant_id, scope_type, write_scope_id, currency, price_basis, amount_minor, version, created_by_membership_id)
       VALUES ($1, 'WRITE_SCOPE', $2, 'EUR', 'GROSS', 2400, 2, $3)`,
      [w.tenantId, ws, w.ownerMembershipId],
    );
    // Отложенная проверка границ выполняется сейчас и держит FOR UPDATE на товаре до конца транзакции
    await other.query('SET CONSTRAINTS ALL IMMEDIATE');
    // Р-104: отказ фиксации без ожидания блокировки захватывается — иначе тест падает необработанным отказом, а не своим утверждением
    const pending = commit(store, w.tenantId, drafts).then((r) => r, (e: unknown) => ({ status: `refused: ${String(e)}` })).finally(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(settled, false, 'decision commit must wait for the bound change');
    await other.query('COMMIT');
    assert.equal((await pending).status, 'CONTEXT_CHANGED');
  } finally {
    other.release();
  }
  assert.deepEqual((await store.dumpState(w.tenantId)).decisions, []);
});

test('writes of one scope: the first goes out, later ones queue behind it and supersede each other', { skip }, async () => {
  const store = new PgPricingStore(pool!, { adminPool: admin! });
  const w = await seed([scopeSeed(7, FIXED)]);
  const ws = w.ids.dbId('ws-7');
  const context = await contextOf(store, w.tenantId, ws);
  const results = await Promise.all([1900, 1950, 2000, 2050].map((amount) => commit(store, w.tenantId, approved(context, amount))));
  assert.ok(results.every((r) => r.status === 'COMMITTED'));
  const committed = results.flatMap((r) => (r.status === 'COMMITTED' ? r.decisions : []));
  assert.equal(committed.filter((d) => d.write).length, 1);
  assert.equal(committed.filter((d) => d.pendingWriteId).length, 3);
  const state = await store.dumpState(w.tenantId);
  assert.deepEqual(state.writes.map((x) => x.version).sort(), [1, 2, 3, 4]);
  assert.deepEqual(state.writes.map((x) => x.status).sort(), ['DISPATCHED', 'PENDING', 'SUPERSEDED', 'SUPERSEDED']);
  // Итог первой записи — третья транзакция; история цен — из триггера
  const first = committed.find((d) => d.write)!.write!;
  await store.recordDispatch(w.tenantId, first, { channelWriteId: first.channelWriteId, status: 'ACCEPTED', appliedImmediately: true }, now());
  const history = await inTenant(pool!, w.tenantId, async (tx) => (await tx.query('SELECT amount_minor FROM tenant_data.price_history WHERE tenant_id = $1', [w.tenantId])).rows);
  assert.deepEqual(history.map((r) => r.amount_minor), [first.value.field === 'PRICE' ? first.value.price.amountMinor : -1]);
});

test('OQ-93, OQ-94, OQ-98: projections keep currency and suggested price, the latest move, and the rejection parameters', { skip }, async () => {
  const store = new PgPricingStore(pool!, { adminPool: admin! });
  const w = await seed([scopeSeed(8, BUYBOX)]);
  const ws = w.ids.dbId('ws-8');
  const key = { channelAccountId: w.channelAccountId, marketplace: 'de', channelProductRef: '36298', condition: 'new' };
  const eur = (amountMinor: number) => ({ amountMinor, currency: 'EUR', basis: 'GROSS' as const });
  const snapshot: CompetitorSnapshot = {
    marketplace: 'de', channelProductRef: '36298', condition: 'new', source: 'KAUFLAND_BUY_BOX_CHANGED', observedAt: now(),
    completeness: { kind: 'TOP_N', n: 10 }, buybox: { price: eur(1790), isSelf: false }, channelSuggestedPrice: eur(1789),
    offers: [{ rank: 1, isSelf: false, sellerRef: 'Seller', price: eur(1790) }],
  };
  const context = await contextOf(store, w.tenantId, ws);
  const at = now();
  const rejected = approved(context, 1400);
  rejected.decision = {
    ...rejected.decision, outcome: 'REJECTED', decisionClass: 'REJECTED_BY_GATE', finalMinor: null, rejectionReason: 'BELOW_MIN_PRICE',
    reason: { code: 'BELOW_MIN_PRICE', params: { proposedMinor: 1400, minMinor: 1500 } },
  };
  const result = await store.commitEvaluation(w.tenantId, {
    key, now: at, decisions: [explained(rejected, { competitorSnapshotId: '00000000-0000-4000-8000-00000000c0de', source: 'KAUFLAND_BUY_BOX_CHANGED', observedAt: snapshot.observedAt })],
    snapshot: { verdict: 'ACCEPT', observedAt: snapshot.observedAt, move: { productRef: '36298|new', moveBp: 30_000, sellerRef: 'Seller' }, accepted: { snapshot: markAcceptedBySanity(snapshot, 'test'), gtin: null, competitorSnapshotId: '00000000-0000-4000-8000-00000000c0de', sanity: { ruleset: 'test', anchorsUsed: [], checks: [], warnings: [] } } },
  });
  assert.equal(result.status, 'COMMITTED');
  const reloaded = await store.loadScopeContext(w.tenantId, ws, now());
  assert.deepEqual([reloaded?.snapshot?.channelSuggestedPrice, reloaded?.snapshot?.buybox?.price.currency], [eur(1789), 'EUR']);
  const state = await store.dumpState(w.tenantId);
  assert.deepEqual(state.decisions.map((d) => d.reasonParams), [{ proposedMinor: 1400, minMinor: 1500, deviationBp: 667, currency: 'EUR' }]);
  // Движение этого товара видно в окне другого товара той же витрины: число товаров и большое движение
  const other = await store.loadEvaluationContext(w.tenantId, { ...key, channelProductRef: '36299' }, now(), SHIFT);
  assert.equal(other.sanity.channel.windowProducts, 1);
  assert.deepEqual(other.sanity.channel.recentMoves.map((m) => [m.productRef, m.moveBp]), [['36298|new', 30_000]]);
  // Отказ без параметров необъясним — БД его не принимает
  const unexplained = approved(context, 1400);
  unexplained.decision = { ...rejected.decision, reason: { code: 'BELOW_MIN_PRICE', params: {} } };
  await assert.rejects(store.commitEvaluation(w.tenantId, { key, now: now(), decisions: [explained(unexplained, { competitorSnapshotId: '00000000-0000-4000-8000-00000000c0de', source: 'KAUFLAND_BUY_BOX_CHANGED', observedAt: snapshot.observedAt })] }), /price_decision_rejection_explained|bound deviation/,
    'OQ-98: a rejection without its reason parameters is refused');
});
