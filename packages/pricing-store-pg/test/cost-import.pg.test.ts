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
  store = new PgPricingStore(pool, { adminPool: admin, bulkWorkerPool: db.pool('svc_bulk_worker', 2) });
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
      // Прежний импорт этого же продавца: процент он объявлял, фиксированную часть — нет
      `INSERT INTO channel_data.fee_estimate (tenant_id, write_scope_id, source, fee_model, computed_at, valid_until)
       VALUES ($1, $2, 'SELLER_DECLARED', '{"feeRateBp": 1500, "fixedFeeMinor": 99}'::jsonb, now(), now() + interval '30 days')`,
      [world.tenantId, scopeId]);
  }, world.userId, { mfa: true });
  // Новая выгрузка: закупочная цена и ТОЛЬКО фиксированная часть комиссии
  const applied = await store.importCosts(world.tenantId,
    { ...batchOf([{ writeScopeId: scopeId, unitCostMinor: 555, currency: 'EUR', fixedFeeMinor: 150 }], 'fp-merge'), skippedRows: 0 },
    actor(true), 'APPLY');
  assert.equal(applied.status, 'APPLIED', JSON.stringify(applied));
  const [row] = await inTenant(admin, world.tenantId, async (tx) => (await tx.query(
    `SELECT c.purchase_cost_minor, c.inbound_logistics_minor, c.packaging_minor, c.source,
            (SELECT fe.fee_model FROM channel_data.fee_estimate fe
              WHERE fe.tenant_id = c.tenant_id AND fe.write_scope_id = $2 AND fe.source = 'SELLER_DECLARED') AS fee
       FROM tenant_data.cost_profile c
       JOIN tenant_data.write_scope s ON s.tenant_id = c.tenant_id AND s.product_id = c.product_id AND s.write_scope_id = $2 AND s.field = 'PRICE'
      WHERE c.tenant_id = $1 ORDER BY c.version DESC LIMIT 1`, [world.tenantId, scopeId])).rows);
  assert.deepEqual([Number(row.purchase_cost_minor), Number(row.inbound_logistics_minor), Number(row.packaging_minor), row.source],
    [555, 120, 30, 'IMPORT'], 'импорт меняет закупочную цену и переносит остальные составляющие прежней версии');
  assert.deepEqual(row.fee, { feeRateBp: 1500, fixedFeeMinor: 150 }, 'фиксированная часть из файла заменила прежнюю, процент остался');
});

test('Р-138 (шаг 29): комиссия продавца — свой источник; пол считается по большей оценке комиссии, а не по самой свежей', async () => {
  const scopeId = world.ids.dbId('ws-7');
  // Тарифная таблица репозитория: 15 % — её ведут разработчики [Р-32]
  await inTenant(admin, world.tenantId, async (tx) => {
    await tx.query(
      `INSERT INTO channel_data.fee_estimate (tenant_id, write_scope_id, source, fee_model, fee_schedule_version, computed_at, valid_until)
       VALUES ($1, $2, 'FEE_SCHEDULE', '{"feeRateBp": 1500, "fixedFeeMinor": 0}'::jsonb, 'kaufland-2026-01', now(), now() + interval '30 days')`,
      [world.tenantId, scopeId]);
  }, world.userId, { mfa: true });
  // Продавец объявил в своей выгрузке 5 %: заниженная комиссия опустила бы пол маржи
  const applied = await store.importCosts(world.tenantId,
    { ...batchOf([{ writeScopeId: scopeId, unitCostMinor: 1000, currency: 'EUR', feeRateBp: 500, fixedFeeMinor: 0 }], 'fp-fee'), skippedRows: 0 },
    actor(true), 'APPLY');
  assert.equal(applied.status, 'APPLIED', JSON.stringify(applied));
  const rows = await inTenant(admin, world.tenantId, async (tx) => (await tx.query(
    `SELECT source, fee_model ->> 'feeRateBp' AS rate, fee_schedule_version FROM channel_data.fee_estimate
      WHERE tenant_id = $1 AND write_scope_id = $2 ORDER BY source`, [world.tenantId, scopeId])).rows);
  assert.deepEqual(rows.map((r) => [r.source, r.rate, r.fee_schedule_version]),
    [['FEE_SCHEDULE', '1500', 'kaufland-2026-01'], ['SELLER_DECLARED', '500', null]],
    'обе оценки живут рядом: число продавца не выдаёт себя за тариф [Р-138]');
  // Пол маржи: база берёт БОЛЬШУЮ комиссию (15 %), иначе продавец уходит ниже себестоимости
  await inTenant(admin, world.tenantId, async (tx) => {
    await tx.query(
      `INSERT INTO tenant_data.guardrail (tenant_id, scope_type, write_scope_id, min_margin_bp, version, created_by_membership_id)
       VALUES ($1, 'WRITE_SCOPE', $2, 1000, 1, $3)`, [world.tenantId, scopeId, world.ownerMembershipId]);
  }, world.userId, { mfa: true });
  const marginFloor = async () => {
    const [row] = await inTenant(admin, world.tenantId, async (tx) => (await tx.query(
      `SELECT margin_floor_minor, cause FROM tenant_data.effective_price_floor($1, $2)`, [world.tenantId, scopeId])).rows);
    assert.equal(row.cause, null, JSON.stringify(row));
    return Number(row.margin_floor_minor);
  };
  const withBoth = await marginFloor();
  // Убираем тарифную оценку: остаётся только объявленная продавцом заниженная комиссия
  await inTenant(admin, world.tenantId, async (tx) => {
    await tx.query(
      `UPDATE channel_data.fee_estimate SET computed_at = now() - interval '2 days', valid_until = now() - interval '1 day'
        WHERE tenant_id = $1 AND write_scope_id = $2 AND source = 'FEE_SCHEDULE'`, [world.tenantId, scopeId]);
  }, world.userId, { mfa: true });
  const sellerOnly = await marginFloor();
  console.log(JSON.stringify({ floorWithBothEstimates: withBoth, floorBySellerOnly: sellerOnly }));
  assert.ok(withBoth > sellerOnly, 'пол считается по большей комиссии, а не по объявленной продавцом');

  /**
   * Ревью шага 29, находка 8: «больше» — это не «больше ставка». Оценка «0 % плюс 5 €» дороже оценки «10 % без фиксированной
   * части» на любой цене ниже 50 €, а по ставке она младше. Пол обязан считаться по каждой оценке и браться наибольший.
   */
  await inTenant(admin, world.tenantId, async (tx) => {
    await tx.query(
      `UPDATE channel_data.fee_estimate SET fee_model = '{"feeRateBp": 1000, "fixedFeeMinor": 0}'::jsonb,
              computed_at = now(), valid_until = now() + interval '30 days'
        WHERE tenant_id = $1 AND write_scope_id = $2 AND source = 'SELLER_DECLARED'`, [world.tenantId, scopeId]);
    await tx.query(
      `INSERT INTO channel_data.fee_estimate (tenant_id, write_scope_id, source, fee_model, computed_at, valid_until)
       VALUES ($1, $2, 'CHANNEL_API', '{"feeRateBp": 0, "fixedFeeMinor": 500}'::jsonb, now(), now() + interval '30 days')
       ON CONFLICT (tenant_id, write_scope_id, source) DO UPDATE SET fee_model = EXCLUDED.fee_model,
             computed_at = EXCLUDED.computed_at, valid_until = EXCLUDED.valid_until`, [world.tenantId, scopeId]);
  }, world.userId, { mfa: true });
  const withFixedFee = await marginFloor();
  await inTenant(admin, world.tenantId, async (tx) => {
    await tx.query(
      `UPDATE channel_data.fee_estimate SET computed_at = now() - interval '2 days', valid_until = now() - interval '1 day'
        WHERE tenant_id = $1 AND write_scope_id = $2 AND source = 'CHANNEL_API'`, [world.tenantId, scopeId]);
  }, world.userId, { mfa: true });
  const rateOnly = await marginFloor();
  console.log(JSON.stringify({ floorWithFixedFeeEstimate: withFixedFee, floorByRateOnly: rateOnly }));
  assert.ok(withFixedFee > rateOnly, 'дороже — не значит «больше ставка»: пол посчитан по оценке с фиксированной частью');
});

/**
 * Р-139 (шаг 30): второй фактор предъявляет человек при СОЗДАНИИ задания, а применяет его процесс. Проверяется, что этот путь
 * не стал дырой. У каждого условия — СВОЙ тест [Р-99]: иначе первое упавшее утверждение прячет остальные, и мутационная
 * проверка не может сказать, какая именно часть защиты исчезла.
 */
const jobActor = (jobId: string) => ({ membershipId: world.ownerMembershipId, userId: world.userId, mfa: false, bulkJobId: jobId });
async function runningJob(kind: 'COST_IMPORT' | 'PRICE_EVIDENCE', mfa: boolean, owner: string) {
  const created = await store.createBulkJob(world.tenantId, { kind, params: {} }, actor(mfa));
  assert.equal(created.status, 'CREATED', JSON.stringify(created));
  const claimed = await store.claimBulkJob(world.tenantId, owner, 60);
  assert.equal(claimed?.kind, kind, 'задание взято в работу');
  return claimed!;
}

test('Р-139: задание НЕ ТОГО вида не открывает массовое изменение цен', async () => {
  /**
   * Выгрузка доказательства создана человеком, у которого второй фактор в сессии БЫЛ, — так чаще всего и бывает. Значит
   * остановить импорт под её именем может только сверка ВИДА задания, и проверяется здесь именно она.
   */
  const evidence = await runningJob('PRICE_EVIDENCE', true, 'review-kind');
  const applied = await store.importCosts(world.tenantId, batchOf(rowsFor([6], 610), 'fp-job-kind'), jobActor(evidence.jobId), 'APPLY');
  assert.equal(applied.status, 'MFA_REQUIRED', 'задание выгрузки не открывает импорт себестоимости');
  await store.finishBulkJob(world.tenantId, evidence.jobId, 'review-kind', { status: 'SUCCEEDED', result: {} });
});

test('Р-139, Р-135: задание того вида создаётся только со вторым фактором и открывает изменение, только пока выполняется', async () => {
  const noMfa = await store.createBulkJob(world.tenantId, { kind: 'COST_IMPORT', params: {} }, actor(false));
  assert.equal(noMfa.status, 'MFA_REQUIRED', 'задание, меняющее цены, без второго фактора не создаётся');
  const job = await runningJob('COST_IMPORT', true, 'review-live');
  const applied = await store.importCosts(world.tenantId, batchOf(rowsFor([7], 620), 'fp-job-ok'), jobActor(job.jobId), 'APPLY');
  assert.equal(applied.status, 'APPLIED', JSON.stringify(applied));
  await store.finishBulkJob(world.tenantId, job.jobId, 'review-live', { status: 'SUCCEEDED', result: {} });
});

test('Р-139: завершённое задание массовое изменение больше не открывает', async () => {
  const job = await runningJob('COST_IMPORT', true, 'review-finished');
  await store.finishBulkJob(world.tenantId, job.jobId, 'review-finished', { status: 'SUCCEEDED', result: {} });
  const applied = await store.importCosts(world.tenantId, batchOf(rowsFor([8], 630), 'fp-job-finished'), jobActor(job.jobId), 'APPLY');
  assert.equal(applied.status, 'MFA_REQUIRED', 'завершённое задание не открывает массовое изменение');
});

/**
 * Гардрейл шире одного предложения меняет пол маржи у ВСЕХ предложений тенанта [Р-135]. Ни одно фоновое задание его не меняет,
 * поэтому здесь нужен второй фактор ЧЕЛОВЕКА. Первая редакция шага 30 звала страж без указания вида задания — и выполняющаяся
 * выгрузка доказательства, которой второй фактор не нужен вовсе, открывала изменение пола маржи всего каталога.
 */
test('Р-139, Р-135: выполняющееся задание выгрузки не открывает гардрейл уровня тенанта', async () => {
  // Второй фактор при создании был: остановить изменение гардрейла может только то, что задание не названо среди его видов
  const evidence = await runningJob('PRICE_EVIDENCE', true, 'review-guardrail');
  const refused = await inTenant(admin, world.tenantId, async (tx) => {
    try {
      await tx.query(
        `INSERT INTO tenant_data.guardrail (tenant_id, scope_type, min_margin_bp, version, created_by_membership_id)
         VALUES ($1, 'TENANT', 1500, 1, $2)`, [world.tenantId, world.ownerMembershipId]);
      return 'accepted';
    } catch (error) {
      return String((error as Error).message);
    }
  }, world.userId, { mfa: false, bulkJobId: evidence.jobId });
  assert.match(refused, /covers every offer: changing it requires a second factor/, 'гардрейл всего тенанта требует второго фактора человека');
  await store.finishBulkJob(world.tenantId, evidence.jobId, 'review-guardrail', { status: 'SUCCEEDED', result: {} });
});

/**
 * Признак «создано со вторым фактором» у задания — несущее условие, а не украшение (находка 4 ревью шага 30). Задание правки
 * границ создаётся и БЕЗ второго фактора: правка одного предложения его не требует. Такое задание не должно открывать правку
 * ДВУХ предложений — иначе второй фактор обходился бы созданием безобидного задания.
 */
test('Р-139, Р-88: задание границ, созданное без второго фактора, не открывает массовую правку', async () => {
  const created = await store.createBulkJob(world.tenantId, { kind: 'BOUNDS_EDIT', params: {} }, actor(false));
  assert.equal(created.status, 'CREATED', 'задание правки границ создаётся и без второго фактора');
  const claimed = await store.claimBulkJob(world.tenantId, 'review-bounds', 60);
  assert.equal(claimed?.kind, 'BOUNDS_EDIT');
  const edits = [4, 5].map((n) => ({ writeScopeId: world.ids.dbId(`ws-${n}`), minMinor: 1100, expected: { minMinor: 1000, maxMinor: 5000 } }));
  const applied = await store.editBounds(world.tenantId, edits, { ...actor(false), bulkJobId: claimed!.jobId }, 'APPLY');
  assert.equal(applied.status, 'MFA_REQUIRED', 'массовая правка под заданием без второго фактора не проходит');
  // Одно предложение тем же заданием — проходит: столько второго фактора и не требовало
  const one = await store.editBounds(world.tenantId, [edits[0]!], { ...actor(false), bulkJobId: claimed!.jobId }, 'APPLY');
  assert.equal(one.status, 'APPLIED', JSON.stringify(one));
  await store.finishBulkJob(world.tenantId, claimed!.jobId, 'review-bounds', { status: 'SUCCEEDED', result: {} });
});

/**
 * Р-143 (шаг 31): записи задания, которому второй фактор НУЖЕН и предъявлен при создании, считаются подтверждёнными. Столбец
 * `created_with_mfa` введён шагом 28 ровно затем, чтобы окно массовой правки [Р-135] считало только НЕподтверждённые правки.
 * Пока задание работало «без второго фактора в сессии», все его версии ложились как неподтверждённые — и окно считало своими
 * ровно то, что человек только что подтвердил.
 */
test('Р-143: себестоимость, записанная заданием импорта, помечена как подтверждённая вторым фактором', async () => {
  const job = await runningJob('COST_IMPORT', true, 'review-marked');
  const applied = await store.importCosts(world.tenantId, batchOf(rowsFor([2], 660), 'fp-marked'), jobActor(job.jobId), 'APPLY');
  assert.equal(applied.status, 'APPLIED', JSON.stringify(applied));
  const [row] = await inTenant(admin, world.tenantId, async (tx) => (await tx.query(
    `SELECT created_with_mfa FROM tenant_data.cost_profile
      WHERE tenant_id = $1 AND purchase_cost_minor = 660 ORDER BY created_at DESC LIMIT 1`, [world.tenantId])).rows);
  assert.equal(row.created_with_mfa, true, 'запись задания подтверждена вторым фактором, который человек предъявил при его создании');
  await store.finishBulkJob(world.tenantId, job.jobId, 'review-marked', { status: 'SUCCEEDED', result: {} });
});
