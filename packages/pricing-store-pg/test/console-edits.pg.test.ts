import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { standUserOf, type MemorySeedScope } from '@repracer/pricing-pipeline';
import { createPool, PgPricingStore, seedPricingWorld } from '../src/index.ts';

/**
 * Шаг 21 в базе: массовая правка границ после экрана различий и сохранение стратегии после превью. Роль участника проверяет база
 * (MANAGE_PRICING, 0068), действующие границы до и после — функции базы; превью откатывает транзакцию; устаревший экран — CONFLICT;
 * правка больше одной единицы — со вторым фактором [Р-88]. Данные синтетические.
 */
const PG_URL = process.env.REPRACER_PG_URL;
if (!PG_URL) throw new Error('REPRACER_PG_URL is required: database tests do not skip (Р-84)');
const pool = createPool(PG_URL, { max: 4, applicationName: 'repracer-step21-test' });
const provisioning = createPool(PG_URL.replace('svc_app@', 'svc_provisioning@'), { max: 1, applicationName: 'repracer-step21-provisioning' });
const admin = createPool(PG_URL.replace('svc_app@', 'svc_admin@'), { max: 2, applicationName: 'repracer-step21-admin' });
after(async () => { await pool.end(); await provisioning.end(); await admin.end(); });

const ACCOUNT = '20000000-0000-4000-8000-000000000021';
const scope = (n: number): MemorySeedScope => ({
  writeScopeId: `ws-${n}`, productId: `prod-${n}`, channelAccountId: ACCOUNT, marketplace: 'de', externalUnitId: String(2100 + n), channelProductRef: `36221${n}`,
  condition: 'new', currency: 'EUR', basis: 'GROSS', pricingMode: 'ENGINE',
  strategy: { strategyId: 'st-fixed', version: 1, params: { type: 'FIXED', priceMinor: 2000 }, deadbandMinor: 0 },
  currentPriceMinor: 1850, minPrice: { amountMinor: 1500, id: `min-${n}` }, maxPrice: { amountMinor: 2500, id: `max-${n}` },
});

async function world() {
  const w = await seedPricingWorld(pool, { provisioningPool: provisioning, adminPool: admin, fixtureTenantId: '10000000-0000-4000-8000-000000000021',
    fixtureChannelAccountId: ACCOUNT, marketplaces: ['de'], clock: new Date().toISOString(), seed: { scopes: [scope(1), scope(2)] } });
  const store = new PgPricingStore(pool, { adminPool: admin });
  const actor = (alias: string, mfa = false) => ({ membershipId: w.ids.dbId(alias), userId: w.ids.dbId(standUserOf(alias)), mfa });
  const bounds = async (ws: string) => {
    const b = (await store.resolveBounds(w.tenantId, w.ids.dbId(ws))).bounds;
    return [b.min.status === 'RESOLVED' ? b.min.amountMinor : null, b.max.status === 'RESOLVED' ? b.max.amountMinor : null];
  };
  return { w, store, actor, bounds, ws: (n: number) => w.ids.dbId(`ws-${n}`) };
}

const expected = { minMinor: 1500, maxMinor: 2500 };

test('step 21: bounds edit — role checked by the database, preview rolls back, stale screen conflicts, mass edit needs a second factor', async () => {
  const { w, store, actor, bounds, ws } = await world();
  assert.deepEqual(await store.editBounds(w.tenantId, [{ writeScopeId: ws(1), minMinor: 1400, expected }], actor('membership-operator'), 'APPLY'), { status: 'FORBIDDEN' },
    'an operator may stop pricing but not change bounds (MANAGE_PRICING)');
  assert.deepEqual(await store.editBounds(w.tenantId, [{ writeScopeId: ws(1), minMinor: 1400, expected }], actor('membership-viewer'), 'PREVIEW'), { status: 'FORBIDDEN' });

  const preview = await store.editBounds(w.tenantId, [{ writeScopeId: ws(1), minMinor: 1400, expected }], actor('membership-pricing-manager'), 'PREVIEW');
  assert.deepEqual(preview, { status: 'PREVIEWED', rows: [{ writeScopeId: ws(1), currency: 'EUR', before: { minMinor: 1500, maxMinor: 2500 }, after: { minMinor: 1400, maxMinor: 2500 } }] });
  assert.deepEqual(await bounds('ws-1'), [1500, 2500], 'the preview leaves no new version');

  const mass = [{ writeScopeId: ws(1), minMinor: 1600, expected }, { writeScopeId: ws(2), maxMinor: 2400, expected }];
  assert.deepEqual(await store.editBounds(w.tenantId, mass, actor('membership-pricing-manager'), 'APPLY'), { status: 'MFA_REQUIRED' });
  assert.deepEqual(await store.editBounds(w.tenantId, [{ writeScopeId: ws(1), minMinor: 2600, expected }], actor('membership-pricing-manager'), 'APPLY'),
    { status: 'INVALID', writeScopeId: ws(1), cause: 'MIN_ABOVE_MAX' });
  const applied = await store.editBounds(w.tenantId, mass, actor('membership-pricing-manager', true), 'APPLY');
  assert.equal(applied.status, 'APPLIED', JSON.stringify(applied));
  assert.deepEqual([await bounds('ws-1'), await bounds('ws-2')], [[1600, 2500], [1500, 2400]]);

  // Экран различий построен до применения: границы изменились — правка не применяется
  const stale = await store.editBounds(w.tenantId, [{ writeScopeId: ws(2), minMinor: 1450, expected }], actor('membership-owner'), 'APPLY');
  assert.deepEqual(stale, { status: 'CONFLICT', writeScopeId: ws(2), actual: { minMinor: 1500, maxMinor: 2400 } });
  assert.deepEqual(await bounds('ws-2'), [1500, 2400]);
});

test('step 21: a saved strategy version keeps the undercut out of the eternal version (Р-91) and is assigned to the write scope', async () => {
  const { w, store, actor, ws } = await world();
  const input = { strategyId: null, name: 'Synthetic buy box', params: { type: 'MATCH_BUYBOX' as const, undercutMinor: 7, holdWhenWinning: false, atBound: 'CAP' as const }, deadbandMinor: 2, assignTo: [ws(1)] };
  assert.deepEqual(await store.saveStrategy(w.tenantId, input, actor('membership-operator')), { status: 'FORBIDDEN' });
  const saved = await store.saveStrategy(w.tenantId, input, actor('membership-pricing-manager'));
  assert.equal(saved.status, 'SAVED', JSON.stringify(saved));
  if (saved.status !== 'SAVED') return;
  assert.equal(saved.strategy.version, 1);
  const loaded = await store.loadScopeContext(w.tenantId, ws(1), new Date().toISOString());
  assert.deepEqual(loaded?.context.scope.strategy, { strategyId: saved.strategy.strategyId, version: 1, params: input.params, deadbandMinor: 2 });
  const next = await store.saveStrategy(w.tenantId, { ...input, strategyId: saved.strategy.strategyId, assignTo: [ws(1), ws(2)] }, actor('membership-owner'));
  assert.equal(next.status === 'SAVED' && next.strategy.version, 2);
  assert.deepEqual(await store.saveStrategy(w.tenantId, { ...input, assignTo: ['00000000-0000-4000-8000-000000000999'] }, actor('membership-owner')), { status: 'INVALID', cause: 'SCOPE_NOT_FOUND' });
});
