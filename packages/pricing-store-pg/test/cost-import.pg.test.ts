import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { CostImportBatch, MemorySeedScope } from '@repracer/pricing-pipeline';
import { inTenant, PgPricingStore, seedPricingWorld, type PgPool, type SeededPricingWorld } from '../src/index.ts';
import { createIsolatedDatabase, type IsolatedDatabase } from './isolated-db.ts';
import { engineCost } from './drafts.ts';

/**
 * Р-134, Р-135 (шаг 28): массовый импорт себестоимости на настоящей PostgreSQL. Проверяется то, что обещано продавцу и владельцу:
 * предпросмотр ничего не меняет, применение требует второго фактора, пакет применяется целиком, а раздробить массовую правку на
 * отдельные транзакции нельзя (риск 17). Данные синтетические.
 */

const ACCOUNT = '20000000-0000-4000-8000-000000000281';
const TENANT = '10000000-0000-4000-8000-000000000281';

let db: IsolatedDatabase;
let pool: PgPool;
let admin: PgPool;
let world: SeededPricingWorld;
let store: PgPricingStore;

function scope(n: number): MemorySeedScope {
  return {
    writeScopeId: `ws-${n}`, productId: `prod-${n}`, channelAccountId: ACCOUNT, marketplace: 'de', externalUnitId: String(2800 + n),
    channelProductRef: `36228${n}`, condition: 'new', currency: 'EUR', basis: 'GROSS', pricingMode: 'OFF', strategy: null,
    currentPriceMinor: 1900, minPrice: { amountMinor: 1000, id: `min-${n}` }, maxPrice: { amountMinor: 5000, id: `max-${n}` },
  };
}

const batchOf = (rows: CostImportBatch['rows'], fingerprint = 'fp-1'): CostImportBatch =>
  ({ sourceName: 'kosten.csv', sourceFormat: 'CSV', fingerprint, skippedRows: 3, rows });

before(async () => {
  db = await createIsolatedDatabase('costimport');
  pool = db.pool('svc_app');
  admin = db.pool('svc_admin', 3);
  world = await seedPricingWorld(pool, {
    provisioningPool: db.pool('svc_provisioning', 1), adminPool: admin, fixtureTenantId: TENANT, fixtureChannelAccountId: ACCOUNT,
    marketplaces: ['de'], clock: new Date().toISOString(), seed: { scopes: [1, 2, 3, 4, 5, 6, 7, 8].map(scope) },
  });
  store = new PgPricingStore(pool, { adminPool: admin });
});

after(async () => {
  await db.drop();
});

const actor = (mfa: boolean) => ({ membershipId: world.ownerMembershipId, userId: world.userId, mfa });
const rowsFor = (ns: readonly number[], costMinor = 500) => ns.map((n) => ({ writeScopeId: world.ids.dbId(`ws-${n}`), unitCostMinor: costMinor, currency: 'EUR' }));

test('Р-134: предпросмотр импорта ничего не меняет и второго фактора не требует', async () => {
  const preview = await store.importCosts(world.tenantId, batchOf(rowsFor([1, 2, 3])), actor(false), 'PREVIEW');
  assert.deepEqual(preview, { status: 'PREVIEWED', rows: 3, offers: 3 });
  const rows = await inTenant(admin, world.tenantId, async (tx) => (await tx.query('SELECT count(*)::int AS n FROM tenant_data.cost_profile')).rows);
  assert.equal(rows[0].n, 0, 'предпросмотр не оставляет ни одной строки себестоимости');
});

test('Р-135: применение импорта без второго фактора отклоняется, со вторым — применяется целиком', async () => {
  const batch = batchOf(rowsFor([1, 2, 3]), 'fp-apply');
  assert.deepEqual(await store.importCosts(world.tenantId, batch, actor(false), 'APPLY'), { status: 'MFA_REQUIRED' });
  const applied = await store.importCosts(world.tenantId, batch, actor(true), 'APPLY');
  assert.equal(applied.status, 'APPLIED');
  const [counts] = await inTenant(admin, world.tenantId, async (tx) => (await tx.query(
    `SELECT (SELECT count(*)::int FROM tenant_data.cost_import) AS batches,
            (SELECT count(*)::int FROM tenant_data.cost_profile WHERE source = 'IMPORT') AS imported,
            (SELECT row_count FROM tenant_data.cost_import LIMIT 1) AS declared,
            (SELECT skipped_rows FROM tenant_data.cost_import LIMIT 1) AS skipped`)).rows);
  assert.deepEqual([counts.batches, counts.imported, counts.declared, counts.skipped], [1, 3, 3, 3]);
  // Себестоимость доходит до пути решения: включение репрайсинга [Р-131] этих офферов больше не упирается в её отсутствие
  const [has] = await inTenant(admin, world.tenantId, async (tx) => (await tx.query(
    `SELECT tenant_data.write_scope_has_cost($1, $2) AS ok,
            (SELECT json_agg(json_build_object('acc', c.channel_account_id, 'm', c.marketplace, 'p', c.product_id)) FROM tenant_data.cost_profile c) AS profiles,
            (SELECT json_agg(json_build_object('m', om.marketplace, 'ws', om.price_write_scope_id)) FROM tenant_data.offer_mapping om) AS mappings`,
    [world.tenantId, world.ids.dbId('ws-1')])).rows);
  assert.equal(has.ok, true, JSON.stringify({ profiles: has.profiles, mappings: has.mappings }).slice(0, 400));
});

test('Р-134: строка импорта без своего пакета и пакет без своих строк базой не принимаются', async () => {
  const client = await admin.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true), set_config('app.auth_mfa', 'on', true)`,
      [world.tenantId, world.userId]);
    // Пакет объявил две строки, а принёс одну: отложенная проверка отказывает на фиксации
    const { rows: [batch] } = await client.query(
      `INSERT INTO tenant_data.cost_import (tenant_id, created_by_membership_id, source_name, source_format, row_count, fingerprint)
       VALUES ($1, $2, 'partial.csv', 'CSV', 2, 'fp-partial') RETURNING cost_import_id`, [world.tenantId, world.ownerMembershipId]);
    await client.query(
      `INSERT INTO tenant_data.cost_profile (tenant_id, product_id, channel_account_id, marketplace, version, valid_from, currency,
                                             purchase_cost_minor, source, created_by_membership_id, cost_import_id)
       VALUES ($1, (SELECT product_id FROM tenant_data.write_scope WHERE tenant_id = $1 AND write_scope_id = $2), $3, 'de',
               (SELECT coalesce(max(version), 0) + 1 FROM tenant_data.cost_profile c WHERE c.tenant_id = $1
                 AND c.product_id = (SELECT product_id FROM tenant_data.write_scope WHERE tenant_id = $1 AND write_scope_id = $2)
                 AND c.channel_account_id = $3 AND c.marketplace = 'de'),
               now(), 'EUR', 100, 'IMPORT', $4, $5)`,
      [world.tenantId, world.ids.dbId('ws-4'), world.ids.dbId(ACCOUNT), world.ownerMembershipId, batch.cost_import_id]);
    await assert.rejects(client.query('COMMIT'), /a cost import applies in full: the batch declared 2 rows and brought 1/);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
  const [left] = await inTenant(admin, world.tenantId, async (tx) => (await tx.query(
    `SELECT count(*)::int AS n FROM tenant_data.cost_import WHERE source_name = 'partial.csv'`)).rows);
  assert.equal(left.n, 0, 'частично применённый пакет не остаётся в базе');
});

test('Р-135, риск 17: массовая правка, разбитая на отдельные транзакции, второй фактор не обходит', async () => {
  // По одной строке за транзакцию и без второго фактора: первые несколько проходят, дальше окно отказывает
  const attempt = async (n: number) => {
    const row = rowsFor([n], 700 + n);
    return store.importCosts(world.tenantId, { ...batchOf(row, `fp-split-${n}`), skippedRows: 0 }, actor(false), 'APPLY');
  };
  // Импорт без второго фактора не проходит вообще — это первая защита
  assert.deepEqual(await attempt(5), { status: 'MFA_REQUIRED' });
  // Вторая защита — окно: правка себестоимости по одной строке за транзакцию административной ролью без второго фактора
  const single = async (n: number) => {
    const client = await admin.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)`, [world.tenantId, world.userId]);
      await client.query(
        `INSERT INTO tenant_data.cost_profile (tenant_id, product_id, version, valid_from, currency, purchase_cost_minor, source, created_by_membership_id)
         VALUES ($1, (SELECT product_id FROM tenant_data.write_scope WHERE tenant_id = $1 AND write_scope_id = $2),
                 (SELECT coalesce(max(version), 0) + 1 FROM tenant_data.cost_profile c WHERE c.tenant_id = $1
                   AND c.product_id = (SELECT product_id FROM tenant_data.write_scope WHERE tenant_id = $1 AND write_scope_id = $2)
                   AND c.channel_account_id IS NULL AND c.marketplace IS NULL),
                 now(), 'EUR', $3, 'MANUAL', $4)`,
        [world.tenantId, world.ids.dbId(`ws-${n}`), 300 + n, world.ownerMembershipId]);
      await client.query('COMMIT');
      return 'APPLIED';
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      return String((error as Error).message);
    } finally {
      client.release();
    }
  };
  const outcomes: string[] = [];
  for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) outcomes.push(await single(n));
  const refused = outcomes.filter((o) => /mass change requires it/.test(o));
  assert.ok(refused.length > 0, `окно отказывает массовой правке по одной строке за транзакцию: ${JSON.stringify(outcomes.slice(0, 8))}`);
  assert.equal(outcomes.slice(0, 2).every((o) => o === 'APPLIED'), true, 'правка одного-двух предложений руками проходит без второго фактора');
});

test('Ревью шага 28, находки 5 и 14: повторный импорт не обнуляет ни прочие составляющие себестоимости, ни вторую часть комиссии', async () => {
  const scopeId = world.ids.dbId('ws-8');
  // Продавец завёл руками логистику и упаковку, а комиссию канала — процентом
  await inTenant(admin, world.tenantId, async (tx) => {
    await tx.query(
      // Составляющие заведены в той же области, что пишет импорт (аккаунт и витрина оффера): именно её импорт и перезаписывает
      `INSERT INTO tenant_data.cost_profile (tenant_id, product_id, channel_account_id, marketplace, version, valid_from, currency,
                                             purchase_cost_minor, inbound_logistics_minor, packaging_minor, source, created_by_membership_id)
       SELECT $1, s.product_id, s.channel_account_id, om.marketplace,
              (SELECT coalesce(max(c.version), 0) + 1 FROM tenant_data.cost_profile c
                WHERE c.tenant_id = $1 AND c.product_id = s.product_id AND c.channel_account_id = s.channel_account_id
                  AND c.marketplace = om.marketplace),
              now(), 'EUR', 400, 120, 30, 'MANUAL', $3
         FROM tenant_data.write_scope s
         JOIN tenant_data.offer_mapping om ON om.tenant_id = s.tenant_id AND om.price_write_scope_id = s.write_scope_id
        WHERE s.tenant_id = $1 AND s.write_scope_id = $2 AND s.field = 'PRICE'`,
      [world.tenantId, scopeId, world.ownerMembershipId]);
    await tx.query(
      `INSERT INTO channel_data.fee_estimate (tenant_id, write_scope_id, source, fee_model, fee_schedule_version, computed_at, valid_until)
       VALUES ($1, $2, 'FEE_SCHEDULE', '{"feeRateBp": 1500, "fixedFeeMinor": 99}'::jsonb, 'kaufland-2026-01', now(), now() + interval '30 days')`,
      [world.tenantId, scopeId]);
  }, world.userId, { mfa: true });
  // Новая выгрузка: закупочная цена и ТОЛЬКО фиксированная часть комиссии
  const applied = await store.importCosts(world.tenantId,
    { ...batchOf([{ writeScopeId: scopeId, unitCostMinor: 555, currency: 'EUR', fixedFeeMinor: 150 }], 'fp-merge'), skippedRows: 0 },
    actor(true), 'APPLY');
  assert.equal(applied.status, 'APPLIED', JSON.stringify(applied));
  const [row] = await inTenant(admin, world.tenantId, async (tx) => (await tx.query(
    `SELECT c.purchase_cost_minor, c.inbound_logistics_minor, c.packaging_minor, c.source,
            (SELECT fe.fee_model FROM channel_data.fee_estimate fe WHERE fe.tenant_id = c.tenant_id AND fe.write_scope_id = $2) AS fee
       FROM tenant_data.cost_profile c
       JOIN tenant_data.write_scope s ON s.tenant_id = c.tenant_id AND s.product_id = c.product_id AND s.write_scope_id = $2 AND s.field = 'PRICE'
      WHERE c.tenant_id = $1 ORDER BY c.version DESC LIMIT 1`, [world.tenantId, scopeId])).rows);
  assert.deepEqual([Number(row.purchase_cost_minor), Number(row.inbound_logistics_minor), Number(row.packaging_minor), row.source],
    [555, 120, 30, 'IMPORT'], 'импорт меняет закупочную цену и переносит остальные составляющие прежней версии');
  assert.deepEqual(row.fee, { feeRateBp: 1500, fixedFeeMinor: 150 }, 'фиксированная часть из файла заменила прежнюю, процент остался');
});
