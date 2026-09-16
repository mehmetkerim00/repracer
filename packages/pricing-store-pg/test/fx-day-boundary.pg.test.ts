import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { CompetitorSnapshot } from '@repracer/channel-port';
import { evaluateSnapshot } from '@repracer/input-sanity';
import type { MemorySeedScope, ScopeEvaluationContext } from '@repracer/pricing-pipeline';
import type { PriceDecisionDraft, PriceIntentDraft } from '@repracer/pricing-model';
import { createPool, inTenant, PgPricingStore, seedPricingWorld } from '../src/index.ts';
import { explained } from './drafts.ts';

/**
 * Р-61, Р-62, Р-63 на PostgreSQL: курс ЕЦБ в решении обязателен, если себестоимость в другой валюте; без курса (или с
 * устаревшим) якорь «тот же EAN» отказывается явно; граница суток — часовой пояс витрины.
 * REPRACER_PG_URL — svc_app в одноразовой базе со всеми миграциями и test/setup.sql (svc_fx_loader, svc_scheduler — там же).
 */

const PG_URL = process.env.REPRACER_PG_URL;
const pool = PG_URL ? createPool(PG_URL, { max: 4, applicationName: 'repracer-fx-test' }) : null;
const provisioning = PG_URL ? createPool(PG_URL.replace('svc_app@', 'svc_provisioning@'), { max: 1, applicationName: 'repracer-test-provisioning' }) : null;
const admin = PG_URL ? createPool(PG_URL.replace('svc_app@', 'svc_admin@'), { max: 2, applicationName: 'repracer-test-admin' }) : null;
const fxLoaderPool = PG_URL ? createPool(PG_URL.replace('svc_app@', 'svc_fx_loader@'), { max: 1, applicationName: 'repracer-fx-test-loader' }) : null;
// Р-84: без базы тест не пропускается, а падает
if (!pool) throw new Error('REPRACER_PG_URL is required: database tests do not skip (Р-84)');
const skip = false;
after(async () => {
  await pool?.end();
  await provisioning?.end();
  await admin?.end();
  await fxLoaderPool?.end();
});

const KAUFLAND = '20000000-0000-4000-8000-000000000001';
const AMAZON_US = '20000000-0000-4000-8000-000000000002';
const FIXED = { strategyId: 'st-fixed', version: 1, params: { type: 'FIXED', priceMinor: 2000 }, deadbandMinor: 0 } as const;
const BUYBOX = { strategyId: 'st-buybox', version: 1, params: { type: 'MATCH_BUYBOX', undercutMinor: 5, holdWhenWinning: true, atBound: 'CAP' }, deadbandMinor: 0 } as const;
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

function usScope(n: number): MemorySeedScope {
  return {
    writeScopeId: `ws-us-${n}`, productId: `prod-${n}`, channelAccountId: AMAZON_US, marketplace: 'ATVPDKIKX0DER', externalUnitId: `SKU-${n}`,
    channelProductRef: `B0SYNTH${n}`, condition: 'new', currency: 'USD', basis: 'NET', taxRegime: 'SALES_TAX_EXCLUDED', pricingMode: 'ENGINE', strategy: FIXED,
    currentPriceMinor: 2000, minPrice: { amountMinor: 1000, id: `min-${n}` }, maxPrice: { amountMinor: 5000, id: `max-${n}` },
    cost: { currency: 'EUR', costProfileId: `cp-${n}`, unitCostMinor: 1000, fixedFeeMinor: 0, feeRateBp: 1500, tax: { regime: 'SALES_TAX_EXCLUDED' } },
  };
}

function approved(context: ScopeEvaluationContext, amountMinor: number, at: string): { intent: PriceIntentDraft; decision: PriceDecisionDraft } {
  const { scope, bounds } = context;
  const min = bounds.min.status === 'RESOLVED' ? bounds.min : null;
  const max = bounds.max.status === 'RESOLVED' ? bounds.max : null;
  return {
    intent: {
      writeScopeId: scope.writeScopeId, strategyId: scope.strategy!.strategyId, strategyVersion: scope.strategy!.version, trigger: { type: 'COST_CHANGE' },
      ruleCode: 'FIXED', intentClass: 'CHANGED', proposedMinor: amountMinor, currentMinor: scope.currentPriceMinor, referenceMinor: null, currency: scope.currency,
      basis: scope.basis, reason: { code: 'FIXED_PRICE', params: {} }, explanation: [], inputs: { boundsAtStrategy: { minMinor: min!.amountMinor, maxMinor: max!.amountMinor } }, createdAt: at, expiresAt: iso(Date.parse(at) + 600_000),
    },
    decision: {
      writeScopeId: scope.writeScopeId, outcome: 'APPROVED', decisionClass: 'CHANGED', finalMinor: amountMinor, currency: scope.currency, basis: scope.basis,
      effectiveFloorMinor: min!.amountMinor, effectiveCeilingMinor: max!.amountMinor, minPriceIds: min!.sourceIds, maxPriceIds: max!.sourceIds, guardrailIds: [],
      rejectionReason: null, reason: { code: 'APPROVED', params: { finalMinor: amountMinor } }, checks: [], alert: null, decidedAt: at, fx: context.cost?.fx ?? null, boundDeviationBp: null,
    },
  };
}

async function seedUs(n: number, fxRates: NonNullable<Parameters<typeof seedPricingWorld>[1]['seed']['fxRates']>, extra: Partial<Parameters<typeof seedPricingWorld>[1]['seed']> = {}) {
  return seedPricingWorld(pool!, { provisioningPool: provisioning!, adminPool: admin!,
    fixtureTenantId: '10000000-0000-4000-8000-000000000001', fixtureChannelAccountId: KAUFLAND, marketplaces: ['de', 'at'], clock: new Date().toISOString(),
    fxLoaderPool: fxLoaderPool!,
    seed: { scopes: [usScope(n)], accounts: [{ channelAccountId: AMAZON_US, channel: 'AMAZON', region: 'NA', marketplaces: ['ATVPDKIKX0DER'] }], fxRates, ...extra },
  });
}

test('Р-61 in the database: a decision on a converted cost is refused without its exchange rate and stored with it', { skip }, async () => {
  const nowMs = Date.now();
  const rate = { source: 'ECB' as const, rateDate: iso(nowMs - 24 * HOUR).slice(0, 10), base: 'EUR' as const, quote: 'USD', rateMicros: 1_155_100, availableFrom: iso(nowMs - 20 * HOUR) };
  const world = await seedUs(8101, [rate]);
  const store = new PgPricingStore(pool!);
  const ws = world.ids.dbId('ws-us-8101');
  const at = iso(nowMs);
  const loaded = await store.loadScopeContext(world.tenantId, ws, at);
  assert.ok(loaded?.context.cost?.fx, 'the EUR cost of a USD scope must come converted with its rate');
  assert.equal(loaded.context.cost.unitCostMinor, 1156);
  const scope = loaded.context.scope;
  const key = { channelAccountId: scope.channelAccountId, marketplace: scope.marketplace, channelProductRef: scope.channelProductRef, condition: scope.condition };

  const withoutRate = approved(loaded.context, 2100, at);
  withoutRate.decision.fx = null;
  await assert.rejects(store.commitEvaluation(world.tenantId, { key, now: at, decisions: [explained({ context: loaded.context, ...withoutRate })] }), /without the exchange rate it was converted at/,
    'Р-61: a decision on a converted cost without its exchange rate is refused');

  const withRate = approved(loaded.context, 2100, at);
  const result = await store.commitEvaluation(world.tenantId, { key, now: at, decisions: [explained({ context: loaded.context, ...withRate })] });
  assert.equal(result.status, 'COMMITTED');
  const stored = await inTenant(pool!, world.tenantId, async (tx) => (await tx.query(`SELECT fx FROM channel_data.price_decision WHERE tenant_id = $1 AND write_scope_id = $2`, [world.tenantId, ws])).rows[0]);
  assert.deepEqual({ from: stored.fx.from, to: stored.fx.to, rateMicros: stored.fx.rateMicros, convertedAmountMinor: stored.fx.convertedAmountMinor }, { from: 'EUR', to: 'USD', rateMicros: 1_155_100, convertedAmountMinor: 1156 });
});

test('Р-63 on PostgreSQL: with only a stale ECB rate the same-EAN anchor declines a USD reference explicitly', { skip }, async () => {
  // Решение через 30 дней после последнего курса: курс устарел, в контексте он есть, но не применяется (FX_MAX_RATE_AGE_DAYS)
  const nowMs = Date.now();
  const decisionMs = nowMs + 30 * 24 * HOUR;
  const rate = { source: 'ECB' as const, rateDate: iso(nowMs - 24 * HOUR).slice(0, 10), base: 'EUR' as const, quote: 'USD', rateMicros: 1_155_100, availableFrom: iso(nowMs - 20 * HOUR) };
  const de: MemorySeedScope = {
    writeScopeId: 'ws-de-8201', productId: 'prod-8201', channelAccountId: KAUFLAND, marketplace: 'de', externalUnitId: '8201', channelProductRef: '362008201',
    condition: 'new', gtin: '2000000082016', currency: 'EUR', basis: 'GROSS', pricingMode: 'ENGINE', strategy: BUYBOX, currentPriceMinor: 1850,
    minPrice: { amountMinor: 1500, id: 'min-8201' }, maxPrice: { amountMinor: 2500, id: 'max-8201' },
  };
  const world = await seedPricingWorld(pool!, { provisioningPool: provisioning!, adminPool: admin!,
    fixtureTenantId: '10000000-0000-4000-8000-000000000001', fixtureChannelAccountId: KAUFLAND, marketplaces: ['de', 'at'], clock: iso(nowMs), fxLoaderPool: fxLoaderPool!,
    seed: {
      scopes: [de], fxRates: [rate],
      crossChannel: { 'de|362008201|new': [{ channel: 'AMAZON', marketplace: 'ATVPDKIKX0DER', referenceMinor: 2050, currency: 'USD', observedAt: iso(decisionMs - HOUR) }] },
    },
  });
  const store = new PgPricingStore(pool!);
  const context = await store.loadEvaluationContext(world.tenantId, { channelAccountId: world.channelAccountId, marketplace: 'de', channelProductRef: '362008201', condition: 'new' },
    iso(decisionMs), { windowSeconds: 900, minFactor: 1.15 });
  assert.ok((context.sanity.fxRates ?? []).some((q) => q.quote === 'USD'), 'the stale rate is still delivered — the anchor decides, not the query');
  const money = (amountMinor: number) => ({ amountMinor, currency: 'EUR', basis: 'GROSS' as const });
  const snapshot: CompetitorSnapshot = {
    marketplace: 'de', channelProductRef: '362008201', condition: 'new', source: 'KAUFLAND_BUYBOX', observedAt: iso(decisionMs - 60_000),
    completeness: { kind: 'TOP_N', n: 10 }, buybox: { price: money(1780), isSelf: false },
    offers: [{ rank: 1, sellerRef: 'synthetic-competitor', isSelf: false, price: money(1780) }, { rank: 2, isSelf: true, price: money(1850) }],
  };
  const verdict = evaluateSnapshot(snapshot, context.sanity);
  assert.deepEqual(verdict.warnings.find((w) => w.code === 'CROSS_CHANNEL_FX_UNAVAILABLE')?.params,
    { channel: 'AMAZON', marketplace: 'ATVPDKIKX0DER', currency: 'USD', expected: 'EUR', cause: 'FX_RATE_STALE' });
  assert.deepEqual(verdict.checks.find((c) => c.rule === 'CROSS_CHANNEL_ANCHOR'), { rule: 'CROSS_CHANNEL_ANCHOR', outcome: 'SKIPPED', detail: { code: 'REFERENCES_WITHOUT_ECB_RATE', params: {} } });
});

test('Р-65: a US storefront has no substituted day boundary; Amazon US and eBay US are marked to verify separately', { skip }, async () => {
  const world = await seedUs(8301, []);
  const ws = world.ids.dbId('ws-us-8301');
  const { tz, storefronts } = await inTenant(pool!, world.tenantId, async (tx) => ({
    tz: (await tx.query(`SELECT tenant_data.write_scope_time_zone($1, $2) AS tz`, [world.tenantId, ws])).rows[0].tz,
    storefronts: (await tx.query(`SELECT marketplace, time_zone, time_zone_status, time_zone_source FROM platform.marketplace WHERE country = 'US' ORDER BY marketplace`)).rows,
  }));
  assert.equal(tz, null, 'no shared US time zone is substituted (Р-65)');
  assert.deepEqual(storefronts.map((r) => [r.marketplace, r.time_zone, r.time_zone_status]), [['ATVPDKIKX0DER', null, 'TO_VERIFY'], ['EBAY_US', null, 'TO_VERIFY']]);
  assert.notEqual(storefronts[0].time_zone_source, storefronts[1].time_zone_source);
  assert.match(storefronts[1].time_zone_source, /250/, 'the eBay US note names the edit budget that depends on the day boundary');
  // Свёртку пишет только задание закрытия дня (repracer_retention): без пояса витрины день не закрывается ни в каком поясе
  const scheduler = createPool(PG_URL!.replace('svc_app@', 'svc_scheduler@'), { max: 1, applicationName: 'repracer-fx-test-scheduler' });
  try {
    for (const dayTz of ['Europe/Berlin', 'America/Los_Angeles']) {
      await assert.rejects(scheduler.query(
        `INSERT INTO tenant_data.price_daily (tenant_id, write_scope_id, price_type, price_day, day_tz, currency, price_basis, min_amount_minor, max_amount_minor,
           first_amount_minor, first_accepted_at, last_amount_minor, last_accepted_at, change_count, min_floor_minor)
         VALUES ($1, $2, 'REGULAR', current_date - 3, $3, 'USD', 'NET', 2000, 2000, 2000, now() - interval '3 days', 2000, now() - interval '3 days', 1, 1000)`,
        [world.tenantId, ws, dayTz]), /does not match the storefront time zone <NULL>/, `Р-65: a price day of a US storefront is not closed in ${dayTz}`);
    }
  } finally {
    await scheduler.end();
  }
});
