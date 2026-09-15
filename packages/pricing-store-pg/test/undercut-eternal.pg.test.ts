import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { REASON_PARAMS, SANITY_NOTE_PARAMS, type PriceIntentDraft } from '@repracer/pricing-model';
import type { MemorySeedScope } from '@repracer/pricing-pipeline';
import { createPool, inTenant, PgPricingStore, seedPricingWorld, type SeededPricingWorld } from '../src/index.ts';
import { approved, contextOf, explained } from './drafts.ts';
import { requireEnv } from './isolated-db.ts';

/**
 * Р-91 и находка 15 ревью шага 15 на PostgreSQL.
 *  Р-91: величина подреза не хранится в вечной версии стратегии и в слепке; живёт в channel_data.pricing_strategy_undercut и
 *        удаляется через 18 месяцев после замены версии; движок её по-прежнему получает.
 *  Находка 15: проверка слепка — fail-closed: только объявленные коды, ключи параметров и поля формата; реестр БД равен коду.
 * Данные синтетические.
 */

const url = requireEnv('REPRACER_PG_URL');
const pool = createPool(url, { max: 4, applicationName: 'repracer-r91-test' });
const provisioning = createPool(url.replace('svc_app@', 'svc_provisioning@'), { max: 1, applicationName: 'repracer-r91-provisioning' });
after(async () => {
  await pool.end();
  await provisioning.end();
});

const ACCOUNT = '20000000-0000-4000-8000-000000000091';
const BUYBOX = { strategyId: 'st-buybox', version: 1, params: { type: 'MATCH_BUYBOX', undercutMinor: 5, holdWhenWinning: false, atBound: 'CAP' }, deadbandMinor: 0 } as const;
const now = () => new Date().toISOString();
const scope: MemorySeedScope = {
  writeScopeId: 'ws-1', productId: 'prod-1', channelAccountId: ACCOUNT, marketplace: 'de', externalUnitId: '9101', channelProductRef: '362910',
  condition: 'new', currency: 'EUR', basis: 'GROSS', pricingMode: 'ENGINE', strategy: BUYBOX,
  currentPriceMinor: 1850, minPrice: { amountMinor: 1500, id: 'min-1' }, maxPrice: { amountMinor: 2500, id: 'max-1' },
};

let w: SeededPricingWorld;
before(async () => {
  w = await seedPricingWorld(pool, {
    provisioningPool: provisioning, fixtureTenantId: '10000000-0000-4000-8000-000000000091', fixtureChannelAccountId: ACCOUNT, marketplaces: ['de'], clock: now(), seed: { scopes: [scope] },
  });
});

const refusal = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (error) {
    return (error as Error).message;
  }
  return 'accepted';
};

test('Р-91: the strategy version keeps its type without the undercut; the undercut lives apart, is superseded with the version and still reaches the engine', async () => {
  const strategyId = w.ids.dbId('st-buybox');
  const q = (sql: string, params: unknown[] = []) => inTenant(pool, w.tenantId, async (tx) => (await tx.query(sql, [w.tenantId, strategyId, ...params])).rows);
  const [version] = await q('SELECT type, params FROM tenant_data.pricing_strategy WHERE tenant_id = $1 AND pricing_strategy_id = $2');
  assert.equal(version.type, 'MATCH_BUYBOX');
  assert.equal('undercutMinor' in version.params, false, 'the eternal strategy version carries no undercut');
  assert.deepEqual((await q('SELECT undercut_minor::int AS u, superseded_at FROM channel_data.pricing_strategy_undercut WHERE tenant_id = $1 AND pricing_strategy_id = $2')),
    [{ u: 5, superseded_at: null }]);

  const ctx = await contextOf(new PgPricingStore(pool), w.tenantId, w.ids.dbId('ws-1'));
  assert.equal((ctx.scope.strategy!.params as { undercutMinor?: number }).undercutMinor, 5, 'the engine still gets the undercut while the version is in use');

  const insertVersion = (v: number, params: object) => `INSERT INTO tenant_data.pricing_strategy (tenant_id, pricing_strategy_id, version, name, type, params, triggers, status, created_by_membership_id)
    VALUES ($1, $2, ${v}, 'st-buybox', 'MATCH_BUYBOX', '${JSON.stringify(params)}', '{COMPETITOR_CHANGE}', 'ACTIVE', '${w.ownerMembershipId}')`;
  assert.match(await refusal(q(insertVersion(2, { type: 'MATCH_BUYBOX', undercutMinor: 5, holdWhenWinning: false, atBound: 'CAP', deadbandMinor: 0 }))), /pricing_strategy_undercut_not_eternal/);
  assert.match(await refusal(q(insertVersion(2, { type: 'MATCH_BUYBOX', holdWhenWinning: false, atBound: 'CAP', deadbandMinor: 0 }))), /needs its undercut/);

  await inTenant(pool, w.tenantId, async (tx) => {
    await tx.query(insertVersion(2, { type: 'MATCH_BUYBOX', holdWhenWinning: false, atBound: 'CAP', deadbandMinor: 0 }), [w.tenantId, strategyId]);
    await tx.query('INSERT INTO channel_data.pricing_strategy_undercut (tenant_id, pricing_strategy_id, version, undercut_minor) VALUES ($1, $2, 2, 7)', [w.tenantId, strategyId]);
  });
  const rows = await q('SELECT version, superseded_at IS NOT NULL AS superseded FROM channel_data.pricing_strategy_undercut WHERE tenant_id = $1 AND pricing_strategy_id = $2 ORDER BY version');
  assert.deepEqual(rows, [{ version: 1, superseded: true }, { version: 2, superseded: false }], 'the replaced version starts its 18 months');
  assert.match(await refusal(q('UPDATE channel_data.pricing_strategy_undercut SET undercut_minor = 1 WHERE tenant_id = $1 AND pricing_strategy_id = $2 AND version = 2')), /immutable/);
  assert.match(await refusal(q('UPDATE channel_data.pricing_strategy_undercut SET superseded_at = NULL WHERE tenant_id = $1 AND pricing_strategy_id = $2 AND version = 1')), /immutable/);
});

test('Р-91: an approved Buy Box price reaches the eternal core without the undercut', async () => {
  const store = new PgPricingStore(pool);
  const ctx = await contextOf(store, w.tenantId, w.ids.dbId('ws-1'));
  const base = approved(ctx, 1775);
  const params = { buyboxMinor: 1780, undercutMinor: 5, targetMinor: 1775, currency: 'EUR' };
  const draft = { ...base, intent: { ...base.intent, ruleCode: 'MATCH_BUYBOX' as const, referenceMinor: 1780, reason: { code: 'BUYBOX_UNDERCUT', params } as PriceIntentDraft['reason'], explanation: [{ code: 'BUYBOX_UNDERCUT', params }] as PriceIntentDraft['explanation'] } };
  const d = explained(draft, { competitorSnapshotId: '00000000-0000-4000-8000-000000009101', source: 'KAUFLAND_BUYBOX', observedAt: now() });
  const r = await store.commitEvaluation(w.tenantId, {
    key: { channelAccountId: ctx.scope.channelAccountId, marketplace: ctx.scope.marketplace, channelProductRef: ctx.scope.channelProductRef, condition: ctx.scope.condition }, now: now(), decisions: [d],
  });
  assert.equal(r.status, 'COMMITTED', JSON.stringify(r));
  const [core] = await inTenant(pool, w.tenantId, async (tx) => (await tx.query(
    `SELECT final_amount_minor::int AS final, explanation FROM tenant_data.price_intent_core WHERE tenant_id = $1 ORDER BY decided_at DESC LIMIT 1`, [w.tenantId])).rows);
  assert.equal(core.final, 1775, 'the published price is ours and kept (Р-21)');
  assert.equal(JSON.stringify(core.explanation).includes('undercutMinor'), false, JSON.stringify(core.explanation));
});

test('finding 15: the database registry of declared keys equals the code; an undeclared parameter, an unknown code or an unknown field is refused', async () => {
  const expected = Object.fromEntries(Object.entries({ ...REASON_PARAMS, ...SANITY_NOTE_PARAMS }).sort(([a], [b]) => a.localeCompare(b))
    .map(([code, schema]) => [code, Object.entries(schema).filter(([, v]) => v.class !== 'CHANNEL' && v.class !== 'CHANNEL_DERIVED').map(([k]) => k).sort()]));
  const { rows: [registry] } = await pool.query('SELECT security.eternal_param_keys() AS keys');
  assert.deepEqual(registry.keys, expected);

  const check = async (explanation: object, competitorDerived: boolean) =>
    (await pool.query('SELECT security.explanation_keys_declared($1::jsonb, $2) AS ok', [JSON.stringify(explanation), competitorDerived])).rows[0].ok;
  const valid = { format: 'r80.1', strategy: { currentMinor: 1850, currency: 'EUR', reason: { code: 'FIXED_PRICE', params: { targetMinor: 1900, currency: 'EUR' } } } };
  assert.equal(await check(valid, false), true);
  assert.equal(await check({ ...valid, strategy: { ...valid.strategy, reason: { code: 'FIXED_PRICE', params: { target: 1900, currency: 'EUR' } } } }, false), false, 'undeclared key "target"');
  assert.equal(await check({ ...valid, strategy: { ...valid.strategy, reason: { code: 'MADE_UP_REASON', params: {} } } }, false), false, 'unknown reason code');
  assert.equal(await check({ ...valid, buybox: 1780 }, false), false, 'unknown field of the format');
  assert.equal(await check({ ...valid, strategy: { ...valid.strategy, steps: [{ code: 'BUYBOX_UNDERCUT', params: { undercutMinor: 5, currency: 'EUR' } }] } }, false), false, 'Р-91: undercut');
  const gate = { failed: { check: 'LOWER_BOUND', detail: { code: 'BELOW_MIN_PRICE', params: { proposedMinor: 1400, minMinor: 1500, currency: 'EUR' } } } };
  assert.equal(await check({ ...valid, gate }, true), false, 'a competitor-derived rejection keeps no proposed price');
  assert.equal(await check({ ...valid, gate }, false), true, 'a fixed price keeps its proposed price');

  const store = new PgPricingStore(pool);
  const ctx = await contextOf(store, w.tenantId, w.ids.dbId('ws-1'));
  const d = explained(approved(ctx, 1900), { competitorSnapshotId: '00000000-0000-4000-8000-000000009102', source: 'KAUFLAND_BUYBOX', observedAt: now() });
  (d.decision.explanation as { strategy: { reason: object } }).strategy.reason = { code: 'FIXED_PRICE', params: { target: 1234, currency: 'EUR' } };
  const message = await refusal(store.commitEvaluation(w.tenantId, {
    key: { channelAccountId: ctx.scope.channelAccountId, marketplace: ctx.scope.marketplace, channelProductRef: ctx.scope.channelProductRef, condition: ctx.scope.condition }, now: now(), decisions: [d],
  }));
  assert.match(message, /explanation_keys_declared/, 'the decision with an undeclared key is not stored');
});
