import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { MemorySeedScope } from '@repracer/pricing-pipeline';
import { PgPricingStore, seedPricingWorld, type PgPool, type SeededPricingWorld } from '../src/index.ts';
import { createIsolatedDatabase, type IsolatedDatabase } from './isolated-db.ts';

/**
 * Р-149 (шаг 34; ревью шага, находка 7): «себестоимость готова» в пути онбординга обязана значить РОВНО то, по чему включение
 * движка не отказывает. Критерий записан дважды — функцией базы `write_scope_cost_ready` (шаг пути, сужение набора) и путём
 * включения в коде (`costMissingCause`), — и первая редакция шага уже разошлась: шаг был зелёным, а включение отказало всем
 * 150 предложениям. Равносильность поэтому утверждается тестом на каждом случае, по которому они могут разойтись.
 * Данные синтетические.
 */

const KAUFLAND = '20000000-0000-4000-8000-000000000341';
const AMAZON_US = '20000000-0000-4000-8000-000000000342';
const TENANT = '10000000-0000-4000-8000-000000000341';

let db: IsolatedDatabase;
let pool: PgPool;
let world: SeededPricingWorld;
let store: PgPricingStore;

const eur = (n: number, cost: boolean): MemorySeedScope => ({
  writeScopeId: `ws-${n}`, productId: `prod-${n}`, channelAccountId: KAUFLAND, marketplace: 'de', externalUnitId: String(3400 + n),
  channelProductRef: `36234${n}`, condition: 'new', currency: 'EUR', basis: 'GROSS', pricingMode: 'OFF', strategy: null,
  currentPriceMinor: 1900, minPrice: { amountMinor: 1000, id: `min-${n}` }, maxPrice: { amountMinor: 5000, id: `max-${n}` },
  ...(cost ? { cost: { currency: 'EUR', costProfileId: `cp-${n}`, unitCostMinor: 900, fixedFeeMinor: 0, feeRateBp: 1500, tax: { regime: 'VAT_INCLUDED' as const, vatRateBp: 1900 } } } : {}),
});
/** Единица в долларах с себестоимостью в евро: без курса ЕЦБ себестоимость не переводится [Р-61] */
const usd = (n: number): MemorySeedScope => ({
  writeScopeId: `ws-${n}`, productId: `prod-${n}`, channelAccountId: AMAZON_US, marketplace: 'ATVPDKIKX0DER', externalUnitId: `SKU-${n}`,
  channelProductRef: `B0SYNTH34${n}`, condition: 'new', currency: 'USD', basis: 'NET', taxRegime: 'SALES_TAX_EXCLUDED', pricingMode: 'OFF', strategy: null,
  currentPriceMinor: 2000, minPrice: { amountMinor: 1000, id: `min-${n}` }, maxPrice: { amountMinor: 5000, id: `max-${n}` },
  cost: { currency: 'EUR', costProfileId: `cp-${n}`, unitCostMinor: 1000, fixedFeeMinor: 0, feeRateBp: 1500, tax: { regime: 'SALES_TAX_EXCLUDED' } },
});

before(async () => {
  db = await createIsolatedDatabase('costready');
  pool = db.pool('svc_app');
  const admin = db.pool('svc_admin', 3);
  world = await seedPricingWorld(pool, {
    provisioningPool: db.pool('svc_provisioning', 1), adminPool: admin, fixtureTenantId: TENANT, fixtureChannelAccountId: KAUFLAND,
    // Часы посева — час назад: себестоимость уже действует на момент проверки по часам базы
    marketplaces: ['de'], clock: new Date(Date.now() - 3_600_000).toISOString(),
    // Курсов в этой базе НЕТ вовсе: случай «себестоимость в чужой валюте без курса» воспроизводится честно
    seed: { scopes: [eur(1, true), eur(2, false), eur(3, false), usd(4)], accounts: [{ channelAccountId: AMAZON_US, channel: 'AMAZON', region: 'NA', marketplaces: ['ATVPDKIKX0DER'] }] },
  });
  store = new PgPricingStore(pool, { adminPool: admin, bulkWorkerPool: db.pool('svc_bulk_worker', 2) });
  // Третьему предложению продавец ввозит себестоимость БЕЗ комиссии — ровно тот файл, на котором споткнулся первый прогон
  const imported = await store.importCosts(world.tenantId, {
    sourceName: 'ohne-provision.csv', sourceFormat: 'CSV', fingerprint: 'fp-cost-ready', skippedRows: 0,
    rows: [{ writeScopeId: world.ids.dbId('ws-3'), unitCostMinor: 900, currency: 'EUR' }],
  }, { membershipId: world.ownerMembershipId, userId: world.userId, mfa: true }, 'APPLY');
  assert.equal(imported.status, 'APPLIED');
});

after(async () => {
  await db.drop();
});

test('Р-149: «себестоимость готова» в базе равносильна тому, что включение не отказывает по себестоимости, — на всех четырёх случаях', async () => {
  const ready = new Set(await store.scopesWithCost(world.tenantId));
  const now = new Date().toISOString();
  const cases: Array<[string, string | null]> = [
    ['ws-1', null],                    // себестоимость и комиссия в валюте единицы
    ['ws-2', 'COST_PROFILE_MISSING'],  // себестоимости нет
    ['ws-3', 'FEE_ESTIMATE_MISSING'],  // себестоимость есть, комиссии нет: пол маржи не считается
    ['ws-4', 'FX_RATE_UNAVAILABLE'],   // себестоимость в евро у единицы в долларах, курса нет [Р-61]
  ];
  for (const [alias, expectedCause] of cases) {
    const id = world.ids.dbId(alias);
    const loaded = await store.loadScopeContext(world.tenantId, id, now as never);
    assert.ok(loaded, `${alias}: контекст предложения читается`);
    // Сначала — что случай ТОТ, который задуман: иначе равносильность ниже выполнялась бы на четырёх одинаковых предложениях
    assert.equal(loaded.context.costMissingCause ?? null, expectedCause, `${alias}: причина, по которой включение отказало бы`);
    assert.equal(ready.has(id), expectedCause === null, `${alias}: база считает себестоимость готовой ровно тогда, когда включение по ней не откажет`);
  }
  assert.equal(ready.size, 1, 'готово ровно одно предложение из четырёх');
});
