import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import type { AdapterCallContext, ChannelAdapter, CompetitorSnapshot, FieldWrite } from '@repracer/channel-port';
import { CHANNEL_PARAM_KEYS } from '@repracer/pricing-model';
import { createPricingPipeline, standUserOf, type MemorySeedScope, type StopRecord } from '@repracer/pricing-pipeline';
import { createPool, PgPricingStore, inTenant, seedPricingWorld, type PgPool, type SeededPricingWorld } from '../src/index.ts';
import { approved, commit, contextOf } from './drafts.ts';

/**
 * Шаг 12 в базе: слепок объяснения фиксируется в транзакции решения и копируется в вечное ядро [Р-68], ссылка на снимок —
 * в той же транзакции; одна оценка — не больше трёх транзакций [Р-59]; остановка человеком — все цены, тенант —
 * самостоятельный объект [Р-69, Р-70]; права остановки и возобновления проверяет БД [OQ-125].
 */

const PG_URL = process.env.REPRACER_PG_URL;
const pool = PG_URL ? createPool(PG_URL, { max: 4, applicationName: 'repracer-step12-test' }) : null;
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

const TENANT = '10000000-0000-4000-8000-000000000012';
const ACCOUNT = '20000000-0000-4000-8000-000000000012';
const LATE_ACCOUNT = '20000000-0000-4000-8000-000000000013';
const BUYBOX = { strategyId: 'st-buybox', version: 1, params: { type: 'MATCH_BUYBOX', undercutMinor: 5, holdWhenWinning: true, atBound: 'CAP' }, deadbandMinor: 0 } as const;
const FIXED = { strategyId: 'st-fixed', version: 1, params: { type: 'FIXED', priceMinor: 2000 }, deadbandMinor: 0 } as const;
const now = () => new Date().toISOString();

function scopeSeed(n: number, strategy: MemorySeedScope['strategy'], channelAccountId = ACCOUNT): MemorySeedScope {
  return {
    writeScopeId: `ws-${n}`, productId: `prod-${n}`, channelAccountId, marketplace: 'de', externalUnitId: String(1200 + n),
    channelProductRef: `36212${n}`, condition: 'new', currency: 'EUR', basis: 'GROSS', pricingMode: 'ENGINE', strategy,
    currentPriceMinor: 1850, minPrice: { amountMinor: 1500, id: `min-${n}` }, maxPrice: { amountMinor: 2500, id: `max-${n}` },
    cost: { currency: 'EUR', costProfileId: `cp-${n}`, unitCostMinor: 1000, fixedFeeMinor: 0, feeRateBp: 1000, tax: { regime: 'VAT_INCLUDED', vatRateBp: 1900 } },
  };
}

const seed = (scopes: MemorySeedScope[]): Promise<SeededPricingWorld> =>
  seedPricingWorld(pool!, { provisioningPool: provisioning!, adminPool: admin!, fixtureTenantId: TENANT, fixtureChannelAccountId: ACCOUNT, marketplaces: ['de', 'at'], clock: now(), seed: { scopes } });

/** Счётчик транзакций: BEGIN на соединении пула и одиночные запросы пула (каждый — своя транзакция) */
function countingPool(inner: PgPool): { pool: PgPool; transactions: () => number; reset: () => void } {
  let n = 0;
  const patched = new WeakSet<object>();
  const proxy = new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === 'connect') {
        return async () => {
          const client = await target.connect();
          if (!patched.has(client)) {
            patched.add(client);
            const query = client.query.bind(client) as (...a: unknown[]) => unknown;
            (client as unknown as { query: (...a: unknown[]) => unknown }).query = (...a: unknown[]) => {
              const sql = typeof a[0] === 'string' ? a[0] : (a[0] as { text?: string } | undefined)?.text;
              if (typeof sql === 'string' && /^\s*BEGIN\b/i.test(sql)) n += 1;
              return query(...a);
            };
          }
          return client;
        };
      }
      if (prop === 'query') {
        return (...a: unknown[]) => {
          n += 1;
          return (target.query as unknown as (...x: unknown[]) => unknown)(...a);
        };
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  return { pool: proxy as PgPool, transactions: () => n, reset: () => { n = 0; } };
}

function acceptingAdapter(): ChannelAdapter {
  return {
    async planDispatch(_ctx: AdapterCallContext, writes: readonly FieldWrite[]) {
      return { batches: [{ batchId: randomUUID(), writes }], rejected: [] };
    },
    async dispatch(_ctx: AdapterCallContext, batch: { writes: FieldWrite[] }) {
      return { batchId: 'step12', outcomes: batch.writes.map((w) => ({ channelWriteId: w.channelWriteId, status: 'ACCEPTED', appliedImmediately: true })), attemptsMade: 1 };
    },
  } as unknown as ChannelAdapter;
}

function snapshot(buyboxMinor: number, ourMinor: number): CompetitorSnapshot {
  const money = (amountMinor: number) => ({ amountMinor, currency: 'EUR', basis: 'GROSS' as const });
  return {
    marketplace: 'de', channelProductRef: '362121', condition: 'new', source: 'KAUFLAND_BUYBOX', observedAt: now(),
    completeness: { kind: 'TOP_N', n: 10 }, buybox: { price: money(buyboxMinor), isSelf: false },
    offers: [{ rank: 1, sellerRef: 'synthetic-competitor', isSelf: false, price: money(buyboxMinor) }, { rank: 2, isSelf: true, price: money(ourMinor) }],
  };
}

function keysOf(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => keysOf(v, out));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) { out.add(k); keysOf(v, out); }
  return out;
}

test('Р-68, Р-59: a competitor-derived evaluation stores the explanation, its core copy and the snapshot reference in one transaction; at most three transactions', { skip }, async (t) => {
  const w = await seed([scopeSeed(1, BUYBOX)]);
  const counting = countingPool(pool!);
  const alerts: string[] = [];
  const pipeline = createPricingPipeline({
    store: new PgPricingStore(counting.pool), adapter: acceptingAdapter(),
    alerts: { raise: async (a: { code: string }) => { alerts.push(a.code); } } as never,
    logger: { log: () => undefined }, now,
  });
  const ctx = { tenantId: w.tenantId, channelAccountId: w.channelAccountId, correlationId: 'step12', deadline: new Date(Date.now() + 60_000).toISOString() } as AdapterCallContext;
  counting.reset();
  const report = await pipeline.processSnapshot(ctx, snapshot(1800, 1850));
  const transactions = counting.transactions();
  assert.equal(report.verdict, 'ACCEPT', JSON.stringify(report));
  assert.equal(report.scopes[0]?.decision?.outcome, 'APPROVED', JSON.stringify(report.scopes[0]));
  assert.deepEqual(alerts, []);
  t.diagnostic(`transactions per evaluation (context, commit with explanation and reference, dispatch outcome): ${transactions}`);
  assert.ok(transactions <= 3, `Р-59: ${transactions} transactions`);

  // Р-96: вечное ядро читает административный сервис
  const [row] = await inTenant(admin!, w.tenantId, async (tx) => (await tx.query(
    `SELECT d.explanation, c.explanation AS core_explanation, r.competitor_snapshot_id, r.source, d.sanity_ruleset, d.gate_profile, d.outcome, d.pricing_strategy_version,
            d.xmin::text AS decision_tx, c.xmin::text AS core_tx, r.xmin::text AS ref_tx,
            pg_column_size(d.explanation) AS explanation_bytes, pg_column_size(d.*) AS decision_row_bytes, pg_column_size(r.*) AS ref_row_bytes
       FROM channel_data.price_decision d
       JOIN tenant_data.price_intent_core c ON c.tenant_id = d.tenant_id AND c.price_decision_id = d.price_decision_id
       LEFT JOIN channel_data.price_decision_snapshot_ref r ON r.tenant_id = d.tenant_id AND r.price_decision_id = d.price_decision_id
      WHERE d.tenant_id = $1`, [w.tenantId])).rows);
  assert.ok(row, 'decision is stored');
  assert.equal(row.explanation.format, 'r80.1');
  assert.deepEqual(row.explanation.snapshot, { source: 'KAUFLAND_BUYBOX' });
  assert.ok(row.sanity_ruleset === 'r49.1' && row.explanation.sanity.anchorsUsed.includes('COST'), JSON.stringify(row.explanation.sanity));
  // Р-80: версия стратегии, профиль и итог Gate — столбцы решения, в слепке их нет
  assert.deepEqual([row.pricing_strategy_version, row.gate_profile, row.outcome, row.explanation.gate?.outcome, row.explanation.strategy.version], [1, 'g74.1', 'APPROVED', undefined, undefined]);
  assert.deepEqual(row.core_explanation, row.explanation, 'the core keeps the same explanation forever');
  assert.equal(row.source, 'KAUFLAND_BUYBOX');
  assert.ok(row.competitor_snapshot_id);
  assert.deepEqual([row.core_tx, row.ref_tx], [row.decision_tx, row.decision_tx], 'decision, core and snapshot reference are written by one transaction');
  const channelKeys = [...keysOf(row.explanation)].filter((k) => CHANNEL_PARAM_KEYS.includes(k));
  assert.deepEqual(channelKeys, [], 'no channel data in the explanation');
  t.diagnostic(`explanation ${row.explanation_bytes} B, decision row ${row.decision_row_bytes} B, snapshot reference row ${row.ref_row_bytes} B`);
});

test('Р-68: the channel parameter keys in the database are the registry keys', { skip }, async () => {
  const { rows: [row] } = await pool!.query('SELECT security.channel_param_keys() AS keys');
  assert.deepEqual(row.keys, [...CHANNEL_PARAM_KEYS]);
});

test('Р-69, Р-70, OQ-125 in the database: a tenant stop holds every price, covers an account connected later, and only the owner resumes it', { skip }, async () => {
  const store = new PgPricingStore(pool!, { adminPool: admin! });
  const w = await seed([scopeSeed(2, FIXED)]);
  const member = (alias: string) => w.ids.dbId(alias);
  // Автор — пользователь сессии: членство и пользователь одного участника (находка 4)
  const userOf = (alias: string) => w.ids.dbId(standUserOf(alias));
  const stop = (alias: string, over: Partial<StopRecord> = {}): StopRecord => ({
    scope: 'TENANT', channelAccountId: null, marketplace: null, stoppedAt: now(), stoppedByMembershipId: member(alias), stoppedByUserId: userOf(alias),
    note: 'Synthetic kill switch in the database', ...over,
  });

  assert.equal((await store.stopPricing(w.tenantId, stop('membership-viewer'))).status, 'FORBIDDEN', 'OQ-129: a viewer does not stop pricing');
  const stopped = await store.stopPricing(w.tenantId, stop('membership-operator'));
  assert.ok(stopped.status === 'STOPPED');
  assert.equal((await store.stopPricing(w.tenantId, stop('membership-owner'))).status, 'ALREADY_ACTIVE');

  // Фиксированная цена — не из данных конкурентов, но остановка человеком держит и её; даже в обход Gate БД не примет одобрение
  const fixed = await contextOf(store, w.tenantId, w.ids.dbId('ws-2'));
  assert.equal(fixed.priceStop?.stopId, stopped.stop.stopId);
  const bypass = await commit(store, w.tenantId, approved(fixed, 2000));
  assert.ok(bypass.status === 'CONTEXT_CHANGED' && bypass.reason.code === 'PRICING_STOPPED', JSON.stringify(bypass));

  // Р-70: аккаунт и его предложение подключены уже при действующей остановке тенанта — и тоже стоят
  await w.connectAccount({ channelAccountId: LATE_ACCOUNT, channel: 'KAUFLAND', marketplaces: ['de'] }, [scopeSeed(3, FIXED, LATE_ACCOUNT)]);
  const late = await contextOf(store, w.tenantId, w.ids.dbId('ws-3'));
  assert.equal(late.priceStop?.scope, 'TENANT');
  const lateCommit = await commit(store, w.tenantId, approved(late, 2000));
  assert.ok(lateCommit.status === 'CONTEXT_CHANGED' && lateCommit.reason.code === 'PRICING_STOPPED', JSON.stringify(lateCommit));
  const stops = await inTenant(pool!, w.tenantId, async (tx) => (await tx.query('SELECT scope_type, channel_account_id FROM tenant_data.price_stop WHERE tenant_id = $1', [w.tenantId])).rows);
  assert.deepEqual(stops, [{ scope_type: 'TENANT', channel_account_id: null }], 'one tenant object, not a set of account stops');

  const release = (alias: string) => ({ membershipId: member(alias), userId: userOf(alias), mfa: true, note: 'Synthetic resume after the check', at: now() });
  assert.equal((await store.releaseStop(w.tenantId, stopped.stop.stopId, release('membership-operator'))).status, 'FORBIDDEN', 'OQ-125: an operator does not resume a tenant stop');
  assert.equal((await store.releaseStop(w.tenantId, stopped.stop.stopId, release('membership-owner'))).status, 'RELEASED');
  const resumed = await commit(store, w.tenantId, approved(await contextOf(store, w.tenantId, w.ids.dbId('ws-3')), 2000));
  assert.equal(resumed.status, 'COMMITTED', JSON.stringify(resumed));

  // Остановку витрины оператор и ставит, и снимает
  const storefront = await store.stopPricing(w.tenantId, stop('membership-operator', { scope: 'STOREFRONT', channelAccountId: w.channelAccountId, marketplace: 'de' }));
  assert.ok(storefront.status === 'STOPPED');
  assert.equal((await store.releaseStop(w.tenantId, storefront.stop.stopId, release('membership-operator'))).status, 'RELEASED');
});

test('Р-69: a system halt is only for broken channel data — a person cannot create one', { skip }, async () => {
  const store = new PgPricingStore(pool!, { adminPool: admin! });
  const w = await seed([scopeSeed(4, BUYBOX)]);
  await assert.rejects(
    store.haltChannel(w.tenantId, { channelAccountId: w.channelAccountId, marketplace: 'de', reasonCode: 'MANUAL' as never, details: {}, haltedAt: now() }),
    /pricing_halt_system_only/,
    'Р-69: a person cannot create a system halt',
  );
});
