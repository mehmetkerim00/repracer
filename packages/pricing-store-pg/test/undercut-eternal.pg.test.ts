import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { EXPLANATION_FIELD_KINDS, REASON_PARAMS, SANITY_NOTE_PARAMS, type PriceIntentDraft } from '@repracer/pricing-model';
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
const admin = createPool(url.replace('svc_app@', 'svc_admin@'), { max: 2, applicationName: 'repracer-test-admin' });
after(async () => {
  await pool.end();
  await provisioning.end();
  await admin.end();
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
    provisioningPool: provisioning, adminPool: admin, fixtureTenantId: '10000000-0000-4000-8000-000000000091', fixtureChannelAccountId: ACCOUNT, marketplaces: ['de'], clock: now(), seed: { scopes: [scope] },
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
  // Р-96: стратегию и её подрез меняет административный сервис — отказы ниже проверяются у него, не отказом в правах пути решения
  // Р-97: от имени владельца — у административного сервиса без пользователя сессии записи нет
  const qa = (sql: string, params: unknown[] = []) => inTenant(admin, w.tenantId, async (tx) => (await tx.query(sql, [w.tenantId, strategyId, ...params])).rows, w.userId);
  const [version] = await q('SELECT type, params FROM tenant_data.pricing_strategy WHERE tenant_id = $1 AND pricing_strategy_id = $2');
  assert.equal(version.type, 'MATCH_BUYBOX');
  assert.equal('undercutMinor' in version.params, false, 'the eternal strategy version carries no undercut');
  assert.deepEqual((await q('SELECT undercut_minor::int AS u, superseded_at FROM channel_data.pricing_strategy_undercut WHERE tenant_id = $1 AND pricing_strategy_id = $2')),
    [{ u: 5, superseded_at: null }]);

  const ctx = await contextOf(new PgPricingStore(pool), w.tenantId, w.ids.dbId('ws-1'));
  assert.equal((ctx.scope.strategy!.params as { undercutMinor?: number }).undercutMinor, 5, 'the engine still gets the undercut while the version is in use');

  const insertVersion = (v: number, params: object) => `INSERT INTO tenant_data.pricing_strategy (tenant_id, pricing_strategy_id, version, name, type, params, triggers, status, created_by_membership_id)
    VALUES ($1, $2, ${v}, 'st-buybox', 'MATCH_BUYBOX', '${JSON.stringify(params)}', '{COMPETITOR_CHANGE}', 'ACTIVE', '${w.ownerMembershipId}')`;
  // OQ-151: новая версия создаётся, пока старая закреплена за единицей записи — подрез старой при этом не истекает
  assert.equal(await refusal(inTenant(admin, w.tenantId, async (tx) => {
    await tx.query(insertVersion(2, { type: 'MATCH_BUYBOX', holdWhenWinning: false, atBound: 'CAP', deadbandMinor: 0 }), [w.tenantId, strategyId]);
    await tx.query('INSERT INTO channel_data.pricing_strategy_undercut (tenant_id, pricing_strategy_id, version, undercut_minor) VALUES ($1, $2, 2, 7)', [w.tenantId, strategyId]);
  }, w.userId)), 'accepted', 'OQ-151: a new version is created while the old one is still pinned');
  // Р-104: отказы версии без подреза и с подрезом в вечной версии — после создания версии 2: вставка новой версии запускает замену
  // подреза, и без проверки закрепления отказ дала бы она, а не утверждение OQ-151 выше
  assert.match(await refusal(qa(insertVersion(3, { type: 'MATCH_BUYBOX', undercutMinor: 5, holdWhenWinning: false, atBound: 'CAP', deadbandMinor: 0 }))), /pricing_strategy_undercut_not_eternal/);
  assert.match(await refusal(qa(insertVersion(3, { type: 'MATCH_BUYBOX', holdWhenWinning: false, atBound: 'CAP', deadbandMinor: 0 }))), /needs its undercut/);
  const undercuts = () => q('SELECT version, superseded_at IS NOT NULL AS superseded FROM channel_data.pricing_strategy_undercut WHERE tenant_id = $1 AND pricing_strategy_id = $2 ORDER BY version');
  // OQ-151 (0066): единица записи всё ещё закреплена за версией 1 — её подрез не начинает срок хранения
  assert.deepEqual(await undercuts(), [{ version: 1, superseded: false }, { version: 2, superseded: false }], 'a pinned version keeps its undercut (OQ-151)');
  const pin = (version: number) => qa('UPDATE tenant_data.write_scope SET pricing_strategy_version = $4 WHERE tenant_id = $1 AND pricing_strategy_id = $2 AND write_scope_id = $3',
    [w.ids.dbId('ws-1'), version]);
  // OQ-151: пока версия закреплена, срок её подреза не запускается даже прямой записью
  assert.match(await refusal(qa('UPDATE channel_data.pricing_strategy_undercut SET superseded_at = now() WHERE tenant_id = $1 AND pricing_strategy_id = $2 AND version = 1')),
    /still pinned by a write scope/, 'OQ-151: the undercut of a pinned version does not start expiring');
  await pin(2);
  assert.deepEqual(await undercuts(), [{ version: 1, superseded: true }, { version: 2, superseded: false }], 'the released version starts its 18 months');
  assert.match(await refusal(pin(1)), /pin the current version/, 'OQ-151: a scope is not pinned back to a version whose undercut expires');
  assert.match(await refusal(qa('UPDATE channel_data.pricing_strategy_undercut SET undercut_minor = 1 WHERE tenant_id = $1 AND pricing_strategy_id = $2 AND version = 2')), /immutable/);
  assert.match(await refusal(qa('UPDATE channel_data.pricing_strategy_undercut SET superseded_at = NULL WHERE tenant_id = $1 AND pricing_strategy_id = $2 AND version = 1')), /immutable/);
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
  // Р-96: вечное ядро путь решения только дописывает; читает его административный сервис
  const [core] = await inTenant(admin, w.tenantId, async (tx) => (await tx.query(
    `SELECT final_amount_minor::int AS final, explanation FROM tenant_data.price_intent_core WHERE tenant_id = $1 ORDER BY decided_at DESC LIMIT 1`, [w.tenantId])).rows);
  assert.equal(core.final, 1775, 'the published price is ours and kept (Р-21)');
  assert.equal(JSON.stringify(core.explanation).includes('undercutMinor'), false, JSON.stringify(core.explanation));
});

test('finding 15: the database registry of declared keys equals the code; an undeclared parameter, an unknown code or an unknown field is refused', async (t) => {
  const expected = Object.fromEntries(Object.entries({ ...REASON_PARAMS, ...SANITY_NOTE_PARAMS }).sort(([a], [b]) => a.localeCompare(b))
    .map(([code, schema]) => [code, Object.entries(schema).filter(([, v]) => v.class !== 'CHANNEL' && v.class !== 'CHANNEL_DERIVED').map(([k]) => k).sort()]));
  const { rows: [registry] } = await pool.query('SELECT security.eternal_param_keys() AS keys');
  await t.test(`finding 15: check 1`, async () => {
    assert.deepEqual(registry.keys, expected);
  });
  // Находка 6 ревью шага 16 (0066): в базе объявлены и виды значений, а не только имена ключей
  const expectedKinds = Object.fromEntries(Object.entries({ ...REASON_PARAMS, ...SANITY_NOTE_PARAMS }).sort(([a], [b]) => a.localeCompare(b))
    .map(([code, schema]) => [code, Object.fromEntries(Object.entries(schema).filter(([, v]) => v.class !== 'CHANNEL' && v.class !== 'CHANNEL_DERIVED')
      .map(([k, v]) => [k, { k: v.kind, ...(v.nullable ? { n: true } : {}), ...(v.values ? { v: [...v.values] } : {}) }]))]));
  const { rows: [kinds] } = await pool.query('SELECT security.eternal_param_kinds() AS kinds');
  await t.test(`finding 15: check 2`, async () => {
    assert.deepEqual(kinds.kinds, expectedKinds, 'the kinds registry of the database equals the code');
  });
  // Находка 8 ревью шага 17 (0070): вид есть у каждого скалярного поля слепка, не только у параметров причин
  const expectedFields = Object.fromEntries(Object.entries(EXPLANATION_FIELD_KINDS).map(([k, v]) => [k, { k: v.k, ...(v.n ? { n: true } : {}), ...(v.v ? { v: [...v.v] } : {}) }]));
  const { rows: [fields] } = await pool.query('SELECT security.explanation_field_kinds() AS kinds');
  await t.test(`finding 15: check 3`, async () => {
    assert.deepEqual(fields.kinds, expectedFields, 'the field kinds registry of the database equals the code');
  });

  const check = async (explanation: object, competitorDerived: boolean) =>
    (await pool.query('SELECT security.explanation_keys_declared($1::jsonb, $2) AS ok', [JSON.stringify(explanation), competitorDerived])).rows[0].ok;
  const valid = { format: 'r80.1', strategy: { currentMinor: 1850, currency: 'EUR', reason: { code: 'FIXED_PRICE', params: { targetMinor: 1900, currency: 'EUR' } } } };
  await t.test(`finding 15: check 4`, async () => {
    assert.equal(await check(valid, false), true);
  });
  await t.test(`finding 15: check 5`, async () => {
    assert.equal(await check({ ...valid, strategy: { ...valid.strategy, reason: { code: 'FIXED_PRICE', params: { target: 1900, currency: 'EUR' } } } }, false), false, 'undeclared key "target"');
  });
  await t.test(`finding 15: check 6`, async () => {
    assert.equal(await check({ ...valid, strategy: { ...valid.strategy, reason: { code: 'MADE_UP_REASON', params: {} } } }, false), false, 'unknown reason code');
  });
  // Находка 6: значение проверяется по виду — сумма строкой, валюта не кодом ISO, значение вне перечисления, чужой формат, имя в withheld
  await t.test(`finding 15: check 7`, async () => {
    assert.equal(await check({ ...valid, strategy: { ...valid.strategy, reason: { code: 'FIXED_PRICE', params: { targetMinor: '1900', currency: 'EUR' } } } }, false), false, 'an amount as a string');
  });
  await t.test(`finding 15: check 8`, async () => {
    assert.equal(await check({ ...valid, strategy: { ...valid.strategy, reason: { code: 'FIXED_PRICE', params: { targetMinor: 1900.5, currency: 'EUR' } } } }, false), false, 'an amount that is not minor units');
  });
  await t.test(`finding 15: check 9`, async () => {
    assert.equal(await check({ ...valid, strategy: { ...valid.strategy, reason: { code: 'FIXED_PRICE', params: { targetMinor: 1900, currency: 'euro' } } } }, false), false, 'a currency that is not an ISO code');
  });
  await t.test(`finding 15: check 10`, async () => {
    assert.equal(await check({ ...valid, gate: { failed: { check: 'UPPER_BOUND', detail: { code: 'ABOVE_MAX_PRICE', params: { source: 'CONSOLE', currency: 'EUR' } } } } }, false), false,
      'an enum value outside the registry');
  });
  await t.test(`finding 15: check 11`, async () => {
    assert.equal(await check({ ...valid, format: 'r74.1' }, false), false, 'another explanation format');
  });
  // Находка 8: поля слепка и значения видов — не произвольный текст и не произвольные числа
  await t.test(`finding 15: check 12`, async () => {
    assert.equal(await check({ ...valid, strategy: { ...valid.strategy, currentMinor: 'Konkurent Mustermann GmbH 17,49 EUR' } }, false), false, 'a free text in strategy.currentMinor');
  });
  await t.test(`finding 15: check 13`, async () => {
    assert.equal(await check({ ...valid, strategy: { ...valid.strategy, currency: 'XYZ' } }, false), false, 'a currency outside EUR and USD');
  });
  await t.test(`finding 15: check 14`, async () => {
    assert.equal(await check({ ...valid, context: { priceStop: { stopId: '00000000-0000-4000-8000-000000000001', scope: 'TENANT', channelAccountId: null, marketplace: null,
      stoppedAt: '2026-99-99T99:99:99Z', stoppedByMembershipId: '00000000-0000-4000-8000-000000000002' } } }, false), false, 'an invalid moment in the price stop context');
  });
  await t.test(`finding 15: check 15`, async () => {
    assert.equal(await check({ ...valid, strategy: { ...valid.strategy, reason: { code: 'SMALL_MOVE', params: { minFactor: 1749 } } } }, false), false, 'a ratio outside its range');
  });
  await t.test(`finding 15: check 16`, async () => {
    assert.equal(await check({ ...valid, strategy: { ...valid.strategy, reason: { code: 'INTENT_EXPIRED', params: { waitedSeconds: -5 } } } }, false), false, 'a negative count');
  });
  await t.test(`finding 15: check 17`, async () => {
    assert.equal(await check({ ...valid, strategy: { ...valid.strategy, reason: { code: 'NO_SCOPE_FOR_PRODUCT', params: { writeScopeId: 'competitor buybox 1749 EUR seller X' } } } }, false), false,
      'a free text as an id');
  });
  await t.test(`finding 15: check 18`, async () => {
    assert.equal(await check({ ...valid, context: { priceStop: { stopId: '00000000-0000-4000-8000-000000000001', scope: 'TENANT', channelAccountId: null, marketplace: null,
      stoppedAt: '2026-09-14T10:00:00.000Z', stoppedByMembershipId: '00000000-0000-4000-8000-000000000002' } } }, false), true, 'a valid price stop context is accepted');
  });
  await t.test(`finding 15: check 19`, async () => {
    assert.equal(await check({ ...valid, strategy: { ...valid.strategy, reason: { code: 'FIXED_PRICE', params: { currency: 'EUR' }, withheld: ['buybox 1780'] } } }, false), false,
      'a withheld name that is not an identifier');
  });
  await t.test(`finding 15: check 20`, async () => {
    assert.equal(await check({ ...valid, buybox: 1780 }, false), false, 'unknown field of the format');
  });
  await t.test(`finding 15: check 21`, async () => {
    assert.equal(await check({ ...valid, strategy: { ...valid.strategy, steps: [{ code: 'BUYBOX_UNDERCUT', params: { undercutMinor: 5, currency: 'EUR' } }] } }, false), false, 'Р-91: undercut');
  });
  const gate = { failed: { check: 'LOWER_BOUND', detail: { code: 'BELOW_MIN_PRICE', params: { proposedMinor: 1400, minMinor: 1500, currency: 'EUR' } } } };
  await t.test(`finding 15: check 22`, async () => {
    assert.equal(await check({ ...valid, gate }, true), false, 'a competitor-derived rejection keeps no proposed price');
  });
  await t.test(`finding 15: check 23`, async () => {
    assert.equal(await check({ ...valid, gate }, false), true, 'a fixed price keeps its proposed price');
  });

  // Находка 6 ревью шага 16: формат — перечисление r80.1, а не любой код (реестр видов полей)
  await t.test('finding 15: finding 6 — an explanation format shaped as a code', async () => {
    assert.equal(await check({ ...valid, format: 'R74_1' }, false), false, 'finding 6: an explanation format shaped as a code other than r80.1 is refused');
  });
  // Находка 7 ревью шага 18 (0072): скаляр в массиве слепка и скалярный корень — не объявленный узел
  await t.test('finding 15: step 18 finding 7 — a scalar among the strategy steps', async () => {
    assert.equal(await check({ ...valid, strategy: { ...valid.strategy, steps: [1780] } }, false), false, 'step 18 finding 7: a scalar among the strategy steps is refused');
  });
  await t.test('finding 15: step 18 finding 7 — a scalar among the sanity checks', async () => {
    // Отказ — значением false (нарушение ограничения ключей слепка), а не ошибкой разбора в середине проверки
    const outcome = await check({ ...valid, sanity: { anchorsUsed: [], checks: ['Konkurent 17,49 EUR'] } }, false).catch((error: Error) => `error: ${error.message}`);
    assert.equal(outcome, false, outcome === true ? 'step 18 finding 7: a scalar among the sanity checks is refused' : 'step 18 finding 7: a scalar among the sanity checks is refused as a declared-keys violation');
  });
  await t.test('finding 15: step 18 finding 7 — a scalar explanation', async () => {
    assert.equal((await pool.query('SELECT security.explanation_keys_declared($1::jsonb, false) AS ok', ['1780'])).rows[0].ok, false, 'step 18 finding 7: a scalar explanation is refused');
  });
  const store = new PgPricingStore(pool);
  const ctx = await contextOf(store, w.tenantId, w.ids.dbId('ws-1'));
  const d = explained(approved(ctx, 1900), { competitorSnapshotId: '00000000-0000-4000-8000-000000009102', source: 'KAUFLAND_BUYBOX', observedAt: now() });
  (d.decision.explanation as { strategy: { reason: object } }).strategy.reason = { code: 'FIXED_PRICE', params: { target: 1234, currency: 'EUR' } };
  const message = await refusal(store.commitEvaluation(w.tenantId, {
    key: { channelAccountId: ctx.scope.channelAccountId, marketplace: ctx.scope.marketplace, channelProductRef: ctx.scope.channelProductRef, condition: ctx.scope.condition }, now: now(), decisions: [d],
  }));
  assert.match(message, /explanation_keys_declared/, 'the decision with an undeclared key is not stored');
});
