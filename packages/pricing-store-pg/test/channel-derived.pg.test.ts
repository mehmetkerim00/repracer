import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { CHANNEL_DERIVED_PARAM_KEYS, COMPETITOR_RULE_DERIVED_KEYS, type CostInputs, type PriceDecisionDraft, type PriceIntentDraft } from '@repracer/pricing-model';
import type { MemorySeedScope } from '@repracer/pricing-pipeline';
import { createPool, inTenant, PgPricingStore, seedPricingWorld } from '../src/index.ts';
import { approved, contextOf, engineCost, explained } from './drafts.ts';
import { requireEnv } from './isolated-db.ts';

/**
 * Р-85 в базе: реестр производных ключей совпадает с кодом; отклонённая цена из данных конкурентов попадает в вечное ядро без
 * предложенной цены и отклонения; слепок с производным ключом база не принимает; строки до миграции очищаются той же функцией.
 * Данные синтетические.
 */

const pool = createPool(requireEnv('REPRACER_PG_URL'), { max: 4, applicationName: 'repracer-r85-test' });
const provisioning = createPool(requireEnv('REPRACER_PG_URL').replace('svc_app@', 'svc_provisioning@'), { max: 1, applicationName: 'repracer-test-provisioning' });
const admin = createPool(requireEnv('REPRACER_PG_URL').replace('svc_app@', 'svc_admin@'), { max: 2, applicationName: 'repracer-test-admin' });
after(async () => {
  await pool.end();
  await provisioning.end();
  await admin.end();
});

const ACCOUNT = '20000000-0000-4000-8000-000000000085';
const BUYBOX = { strategyId: 'st-buybox', version: 1, params: { type: 'MATCH_BUYBOX', undercutMinor: 5, holdWhenWinning: false, atBound: 'CAP' }, deadbandMinor: 0 } as const;
const now = () => new Date().toISOString();

function scope(n: number): MemorySeedScope {
  return {
    writeScopeId: `ws-${n}`, productId: `prod-${n}`, channelAccountId: ACCOUNT, marketplace: 'de', externalUnitId: String(8500 + n),
    // Р-131 (шаг 27): движок без объявленной себестоимости база не включает; проверка не о себестоимости — профиль синтетический
    channelProductRef: `36285${n}`, condition: 'new', currency: 'EUR', basis: 'GROSS', pricingMode: 'ENGINE', cost: engineCost(), strategy: BUYBOX,
    currentPriceMinor: 1850, minPrice: { amountMinor: 1800, id: `min-${n}` }, maxPrice: { amountMinor: 2500, id: `max-${n}` },
  };
}

test('Р-85: the derived-key registry in the database equals the code', async () => {
  const { rows: [r] } = await pool.query('SELECT security.channel_derived_param_keys() AS by_code, security.channel_rule_derived_param_keys() AS by_rule');
  assert.deepEqual(r.by_code, CHANNEL_DERIVED_PARAM_KEYS);
  assert.deepEqual(r.by_rule, [...COMPETITOR_RULE_DERIVED_KEYS]);
  assert.ok(Object.keys(r.by_code).length >= 5);
});

test('Р-85: a rejected Buy Box proposal reaches the eternal core without the proposed price, the deviation and the derived target', async () => {
  const w = await seedPricingWorld(pool, { provisioningPool: provisioning, adminPool: admin, fixtureTenantId: '10000000-0000-4000-8000-000000000085', fixtureChannelAccountId: ACCOUNT, marketplaces: ['de'], clock: now(), seed: { scopes: [scope(1)] } });
  const store = new PgPricingStore(pool);
  const ctx = await contextOf(store, w.tenantId, w.ids.dbId('ws-1'));
  const base = approved(ctx, 1900);
  const proposed = 1715;
  const intent: PriceIntentDraft = {
    ...base.intent, ruleCode: 'MATCH_BUYBOX', proposedMinor: proposed, referenceMinor: 1720,
    reason: { code: 'BUYBOX_UNDERCUT', params: { buyboxMinor: 1720, undercutMinor: 5, targetMinor: proposed, currency: 'EUR' } },
    explanation: [{ code: 'BUYBOX_UNDERCUT', params: { buyboxMinor: 1720, undercutMinor: 5, targetMinor: proposed, currency: 'EUR' } }],
  };
  const detail = { code: 'BELOW_MIN_PRICE' as const, params: { proposedMinor: proposed, minMinor: 1800, deviationBp: 473, currency: 'EUR' } };
  const decision: PriceDecisionDraft = {
    ...base.decision, outcome: 'REJECTED', decisionClass: 'REJECTED_BY_GATE', finalMinor: null, rejectionReason: 'BELOW_MIN_PRICE', reason: detail, boundDeviationBp: 473,
    checks: [{ check: 'PRICE_STOP', passed: true, detail: null }, { check: 'LOWER_BOUND', passed: false, detail }],
  };
  // Цена из данных конкурентов объясняется снимком и проверкой входов (CHECK price_decision_explanation_competitor_inputs)
  const d = explained({ context: ctx, intent, decision }, { competitorSnapshotId: randomUUID(), source: 'KAUFLAND_BUYBOX', observedAt: now() });
  const r = await store.commitEvaluation(w.tenantId, {
    key: { channelAccountId: ctx.scope.channelAccountId, marketplace: ctx.scope.marketplace, channelProductRef: ctx.scope.channelProductRef, condition: ctx.scope.condition },
    now: now(), decisions: [d],
  });
  assert.equal(r.status, 'COMMITTED', JSON.stringify(r));
  // Р-96: вечное ядро читает административный сервис
  const [row] = await inTenant(admin, w.tenantId, async (tx) => (await tx.query(
    `SELECT c.proposed_amount_minor, c.bound_deviation_bp, c.dangerous, c.reason_params, c.explanation, c.competitor_derived,
            dd.proposed_amount_minor AS hot_proposed, dd.bound_deviation_bp AS hot_deviation
       FROM tenant_data.price_intent_core c JOIN channel_data.price_decision dd ON dd.tenant_id = c.tenant_id AND dd.price_decision_id = c.price_decision_id
      WHERE c.tenant_id = $1`, [w.tenantId])).rows);
  assert.ok(row);
  assert.deepEqual([row.competitor_derived, row.proposed_amount_minor, row.bound_deviation_bp, row.dangerous], [true, null, null, false]);
  assert.equal(Number(row.hot_proposed), proposed, 'the hot decision (30 days, channel class) keeps the proposed price');
  assert.equal(row.hot_deviation, 473);
  assert.deepEqual(Object.keys(row.reason_params).sort(), ['currency', 'minMinor']);
  // Имена вырезанных ключей в withheld — не данные; в параметрах причин их нет, значений нет нигде
  const values: number[] = [];
  const paramKeys: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === 'number') values.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (o.params && typeof o.params === 'object') paramKeys.push(...Object.keys(o.params));
      Object.values(o).forEach(walk);
    }
  };
  walk(row.explanation);
  assert.deepEqual(values.filter((n) => n === proposed || n === 473 || n === 1720), [], JSON.stringify(row.explanation));
  assert.deepEqual(paramKeys.filter((k) => ['targetMinor', 'proposedMinor', 'deviationBp'].includes(k)), [], JSON.stringify(row.explanation));
  assert.ok(JSON.stringify(row.explanation).includes('"withheld"'), 'the stripped keys are named as withheld');
});

test('Р-85: the database refuses an explanation with a derived key and cleans rows written before the migration', async () => {
  const legacy = {
    format: 'r80.1',
    strategy: { reason: { code: 'CAPPED_AT_MIN_PRICE', params: { targetMinor: 1400, minMinor: 1500, currency: 'EUR' } }, steps: [{ code: 'BUYBOX_UNDERCUT', params: { undercutMinor: 5, targetMinor: 1400, currency: 'EUR' }, withheld: ['x'] }] },
    gate: { failed: { check: 'LOWER_BOUND', detail: { code: 'BELOW_MIN_PRICE', params: { proposedMinor: 1400, minMinor: 1500, deviationBp: 667, currency: 'EUR' } } } },
  };
  const { rows: [r] } = await pool.query(
    `SELECT security.explanation_derives_no_channel($1::jsonb, true) AS before, security.strip_channel_derived($1::jsonb, true) AS cleaned,
            security.explanation_derives_no_channel(security.strip_channel_derived($1::jsonb, true), true) AS after,
            security.explanation_derives_no_channel(security.strip_channel_derived($1::jsonb, false), false) AS after_tenant_rule,
            security.strip_channel_derived($1::jsonb, false) -> 'gate' AS tenant_rule_gate`, [JSON.stringify(legacy)]);
  assert.deepEqual([r.before, r.after, r.after_tenant_rule], [false, true, true]);
  assert.deepEqual(r.cleaned.strategy.reason, { code: 'CAPPED_AT_MIN_PRICE', params: { minMinor: 1500, currency: 'EUR' } });
  // Р-91 (0059): подрез — тоже производная величина, из слепка вырезается
  assert.deepEqual(r.cleaned.strategy.steps[0], { code: 'BUYBOX_UNDERCUT', params: { currency: 'EUR' }, withheld: ['x'] });
  assert.deepEqual(r.cleaned.gate.failed.detail, { code: 'BELOW_MIN_PRICE', params: { minMinor: 1500, currency: 'EUR' }, withheld: ['deviationBp', 'proposedMinor'] });
  assert.deepEqual(r.tenant_rule_gate, legacy.gate, 'a fixed or margin price keeps its proposed price: it is not derived from a competitor');
});

test('finding 16: a database refusal at commit (the margin floor rose after the context was read) stores nothing — no decision and no proposed price in the eternal core', async () => {
  // Пол маржи 10 % при комиссии 10 % и НДС 19 %: себестоимость 10,00 € → 15,24 €; 11,00 € → 16,76 €
  const cost = (unitCostMinor: number): CostInputs => ({ currency: 'EUR', costProfileId: `cp-86-${unitCostMinor}`, unitCostMinor, fixedFeeMinor: 0, feeRateBp: 1000, tax: { regime: 'VAT_INCLUDED', vatRateBp: 1900 } });
  const w = await seedPricingWorld(pool, {
    provisioningPool: provisioning, adminPool: admin, fixtureTenantId: '10000000-0000-4000-8000-000000000086', fixtureChannelAccountId: ACCOUNT, marketplaces: ['de'], clock: now(),
    seed: { scopes: [{ ...scope(2), minPrice: { amountMinor: 1000, id: 'min-2' }, cost: cost(1000), guardrails: { minMarginBp: 1000 } }] },
  });
  const store = new PgPricingStore(pool);
  const ctx = await contextOf(store, w.tenantId, w.ids.dbId('ws-2'));
  await w.setCost('ws-2', cost(1100));

  const base = approved(ctx, 1600);
  const params = { buyboxMinor: 1605, undercutMinor: 5, targetMinor: 1600, currency: 'EUR' };
  const draft = {
    ...base,
    intent: { ...base.intent, ruleCode: 'MATCH_BUYBOX' as const, referenceMinor: 1605, reason: { code: 'BUYBOX_UNDERCUT', params } as PriceIntentDraft['reason'], explanation: [{ code: 'BUYBOX_UNDERCUT', params }] as PriceIntentDraft['explanation'] },
  };
  const d = explained(draft, { competitorSnapshotId: randomUUID(), source: 'KAUFLAND_BUYBOX', observedAt: now() });
  const r = await store.commitEvaluation(w.tenantId, {
    key: { channelAccountId: ctx.scope.channelAccountId, marketplace: ctx.scope.marketplace, channelProductRef: ctx.scope.channelProductRef, condition: ctx.scope.condition },
    now: now(), decisions: [d],
  });
  assert.equal(r.status, 'CONTEXT_CHANGED', JSON.stringify(r));
  assert.equal(r.status === 'CONTEXT_CHANGED' ? r.reason.code : null, 'BELOW_MARGIN_FLOOR', 'the refusal goes back to the pipeline as a hot reason, it is not stored');
  // Р-96: вечное ядро путь решения только дописывает; читает его административный сервис
  const [counts] = await inTenant(admin, w.tenantId, async (tx) => (await tx.query(
    `SELECT (SELECT count(*)::int FROM channel_data.price_decision WHERE tenant_id = $1) AS decisions,
            (SELECT count(*)::int FROM tenant_data.price_intent_core WHERE tenant_id = $1) AS core,
            (SELECT count(*)::int FROM tenant_data.channel_write WHERE tenant_id = $1) AS writes`, [w.tenantId])).rows);
  assert.deepEqual(counts, { decisions: 0, core: 0, writes: 0 });
});
