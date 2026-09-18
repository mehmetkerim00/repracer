import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { AMAZON_DESCRIPTOR } from '@repracer/amazon-adapter';
import type { ChannelDescriptor } from '@repracer/channel-port';
import { KAUFLAND_DESCRIPTOR } from '@repracer/kaufland-adapter';
import type { StrategyParams } from '@repracer/pricing-model';
import { standUserOf } from '@repracer/pricing-pipeline';
import { createPool, inTenant, PgPricingStore, seedPricingWorld } from '@repracer/pricing-store-pg';
import { strategyAvailability } from '@repracer/strategy-engine';

/**
 * Шаг 23 [Р-119, Р-39, OQ-166]: справочники каналов в базе совпадают с описанием адаптеров, доступность стратегии в базе — с движком,
 * и снятие остановки витрины выборкой на канале без опроса база не выполняет. Данные синтетические.
 */
const PG_URL = process.env.REPRACER_PG_URL;
if (!PG_URL) throw new Error('REPRACER_PG_URL is required: database tests do not skip (Р-84)');
const pool = createPool(PG_URL, { max: 2, applicationName: 'repracer-channel-reference' });
const admin = createPool(PG_URL.replace('svc_app@', 'svc_admin@'), { max: 1, applicationName: 'repracer-channel-reference-admin' });
const provisioning = createPool(PG_URL.replace('svc_app@', 'svc_provisioning@'), { max: 1, applicationName: 'repracer-channel-reference-provisioning' });
after(async () => { await pool.end(); await admin.end(); await provisioning.end(); });

const DESCRIPTORS: ChannelDescriptor[] = [KAUFLAND_DESCRIPTOR, AMAZON_DESCRIPTOR];

test('Р-119, Р-39: platform.channel_behaviour and platform.competitor_source equal the adapter descriptors', async () => {
  const { rows: behaviour } = await pool.query('SELECT channel, halt_release, basis FROM platform.channel_behaviour ORDER BY channel');
  assert.deepEqual(behaviour, DESCRIPTORS.map((d) => ({ channel: d.channel, halt_release: d.haltRelease.kind, basis: d.haltRelease.basis })).sort((a, b) => a.channel.localeCompare(b.channel)));
  const { rows: sources } = await pool.query(`SELECT channel, source, kind, completeness_kind, completeness_n, conditions, has_buybox_winner, has_own_rank, has_shipping,
                                                     typical_staleness_seconds, availability, role FROM platform.competitor_source ORDER BY channel, source`);
  const expected = DESCRIPTORS.flatMap((d) => (d.competitorSources ?? []).map((s) => ({
    channel: d.channel, source: s.source, kind: s.kind, completeness_kind: s.completeness.kind, completeness_n: s.completeness.kind === 'TOP_N' ? s.completeness.n : null,
    conditions: s.conditions, has_buybox_winner: s.hasBuyboxWinner, has_own_rank: s.hasOwnRank, has_shipping: s.hasShipping,
    typical_staleness_seconds: s.typicalStalenessSeconds, availability: s.availability, role: s.role,
  }))).sort((a, b) => a.channel.localeCompare(b.channel) || a.source.localeCompare(b.source));
  // Порядок строк — одним сравнением в коде: сортировка базы зависит от правил сравнения кластера
  const order = (a: { channel: string; source: string }, b: { channel: string; source: string }) => (a.channel + a.source < b.channel + b.source ? -1 : 1);
  assert.deepEqual([...sources].sort(order), [...expected].sort(order));
});

test('OQ-166: channel_data.strategy_unmet agrees with strategyAvailability for every strategy shape on every channel', async () => {
  const shapes: StrategyParams[] = [
    { type: 'FIXED', priceMinor: 1500 },
    { type: 'TARGET_MARGIN', targetMarginBp: 1500 },
    { type: 'MATCH_BUYBOX', undercutMinor: 5, holdWhenWinning: true, atBound: 'CAP' },
    { type: 'BEAT_LOWEST', undercutMinor: 1, scope: 'VISIBLE_TOP_N', compareLanded: false, atBound: 'CAP' },
    { type: 'BEAT_LOWEST', undercutMinor: 1, scope: 'VISIBLE_TOP_N', compareLanded: true, atBound: 'HOLD' },
    { type: 'BEAT_LOWEST', undercutMinor: 1, scope: 'MARKET', compareLanded: false, atBound: 'CAP' },
  ] as StrategyParams[];
  for (const d of DESCRIPTORS) {
    for (const params of shapes) {
      const code = strategyAvailability(params, d.competitorSources ?? []);
      const { rows: [r] } = await pool.query('SELECT channel_data.strategy_unmet($1, $2) AS unmet', [d.channel, JSON.stringify(params)]);
      const dbAvailable = Object.keys(r.unmet).length === 0;
      assert.equal(dbAvailable, code.available, `${d.channel} ${JSON.stringify(params)}: database ${JSON.stringify(r.unmet)} vs code ${JSON.stringify(code)}`);
      if (!code.available) assert.deepEqual(r.unmet, code.unmet, `${d.channel} ${JSON.stringify(params)}: the unmet requirements match`);
    }
  }
  const { rows: [unknown] } = await pool.query(`SELECT channel_data.strategy_unmet('KAUFLAND', '{"type": "POSITION"}') AS unmet`);
  assert.deepEqual(unknown.unmet, { '*': ['UNKNOWN_STRATEGY_TYPE'] }, 'an unknown strategy type is unavailable (fail-closed)');
});

test('Р-119: a storefront halt on Amazon is not released by a sample in the database — the review answers MANUAL_ONLY', async () => {
  const ACCOUNT = '20000000-0000-4000-8000-000000000119';
  const w = await seedPricingWorld(pool, {
    provisioningPool: provisioning, adminPool: admin, fixtureTenantId: '10000000-0000-4000-8000-000000000119', fixtureChannelAccountId: ACCOUNT,
    fixtureChannel: 'AMAZON', fixtureRegion: 'EU', marketplaces: ['A1PA6795UKMFR9'], clock: new Date().toISOString(),
    seed: {
      scopes: [{
        writeScopeId: 'ws-119', productId: 'p-119', channelAccountId: ACCOUNT, marketplace: 'A1PA6795UKMFR9', externalUnitId: 'SYN-SKU-119', channelProductRef: 'B000000119',
        condition: 'new', currency: 'EUR', basis: 'GROSS', pricingMode: 'ENGINE',
        strategy: { strategyId: 'st-119', version: 1, params: { type: 'MATCH_BUYBOX', undercutMinor: 5, holdWhenWinning: true, atBound: 'CAP' }, deadbandMinor: 0 },
        currentPriceMinor: 1850, minPrice: { amountMinor: 1500, id: 'min-119' }, maxPrice: { amountMinor: 2500, id: 'max-119' },
        // Р-131 (шаг 27): движок без объявленной себестоимости база не включает; сценарий не о себестоимости — профиль синтетический
        cost: { currency: 'EUR', costProfileId: 'cp-119', unitCostMinor: 400, fixedFeeMinor: 0, feeRateBp: 1000, tax: { regime: 'VAT_INCLUDED', vatRateBp: 1900 } },
      }],
      halts: [{ marketplace: 'A1PA6795UKMFR9', haltedAt: new Date(Date.now() - 3_600_000).toISOString(), reviewWindowSeconds: 60 }],
    },
  });
  const store = new PgPricingStore(pool, { adminPool: admin });
  const [halt] = await inTenant(pool, w.tenantId, async (tx) => (await tx.query('SELECT pricing_halt_id FROM channel_data.pricing_halt WHERE tenant_id = $1', [w.tenantId])).rows);
  await store.recordHaltSample(w.tenantId, halt.pricing_halt_id, [{ channelProductRef: 'B000000119', observedAt: new Date().toISOString(), verdict: 'ACCEPT', reasonCode: null }], new Date().toISOString());
  assert.equal(await store.reviewHaltBySample(w.tenantId, halt.pricing_halt_id, new Date().toISOString()), 'MANUAL_ONLY',
    'Р-119: a clean sample does not release a halt on a channel without competitor polling');
  void standUserOf;
});
