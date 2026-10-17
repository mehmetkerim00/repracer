import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { readTable } from '@repracer/cost-import';
import { buildImportPlan, importCheckView, importMapping, messagesFor, type ImportCheckView, type ImportPlan, type StandWorld } from '@repracer/console-model';
import type { MemorySeedScope } from '@repracer/pricing-pipeline';
import { inTenant, PgPricingStore, seedPricingWorld, type PgPool, type SeededPricingWorld } from '@repracer/pricing-store-pg';
import { createIsolatedDatabase, type IsolatedDatabase } from '../../../packages/pricing-store-pg/test/isolated-db.ts';

/**
 * Р-130, Р-134, Р-135 (шаг 28), шаг 99 [Р-224]: живой прогон массового импорта себестоимости. Настоящая выгрузка продавца (10 000 строк,
 * 15 % с ошибками) проходит весь путь: чтение файла → колонки по заголовкам → примерка против текущих данных → применение на настоящей
 * PostgreSQL. С шага 99 файл с ошибочными строками не применяется вовсе: продавец получает каждую ошибку с номером строки и причиной,
 * чинит файл — и исправленный применяется целиком. Утверждается наблюдаемое: что видит продавец и что оказалось в базе. Данные синтетические.
 */

const TENANT = '10000000-0000-4000-8000-000000000282';
const ACCOUNT = '20000000-0000-4000-8000-000000000282';
const OFFERS = 10_000;
/** Доля строк файла с ошибками: 15 % — как в задаче шага 28 */
const BAD_SHARE = 0.15;

let db: IsolatedDatabase;
let pool: PgPool;
let admin: PgPool;
let world: SeededPricingWorld;
let store: PgPricingStore;
let standWorld: StandWorld;
const m = messagesFor('de');

function scope(n: number): MemorySeedScope {
  return {
    writeScopeId: `ws-${n}`, productId: `prod-${n}`, channelAccountId: ACCOUNT, marketplace: 'de', externalUnitId: `SKU-${n}`,
    channelProductRef: `3629${String(n).padStart(6, '0')}`, condition: 'new', currency: 'EUR', basis: 'GROSS', pricingMode: 'OFF', strategy: null,
    currentPriceMinor: 1900, minPrice: { amountMinor: 1000, id: `min-${n}` }, maxPrice: { amountMinor: 9000, id: `max-${n}` },
  };
}

/** Выгрузка продавца: немецкий формат чисел, точка с запятой, и 15 % строк с ошибками */
function sellerExport(bad: boolean): string {
  const lines = ['Artikelnummer;Einstandspreis;Währung;Provision %'];
  for (let n = 1; n <= OFFERS; n += 1) {
    const cost = `${9 + (n % 40)},${String(n % 100).padStart(2, '0')}`;
    // Каждая седьмая строка (≈14,3 %) — с ошибкой; вид ошибки чередуется, чтобы продавец увидел все причины
    if (bad && n % 7 === 0) {
      const kind = (n / 7) % 5;
      if (kind === 0) lines.push(`SKU-NICHT-DA-${n};${cost};EUR;15`);
      else if (kind === 1) lines.push(`SKU-${n};abc;EUR;15`);
      else if (kind === 2) lines.push(`SKU-${n};10.505;EUR;15`);
      else if (kind === 3) lines.push(`SKU-${n};${cost};USD;15`);
      else lines.push(`;${cost};EUR;15`);
      continue;
    }
    lines.push(`SKU-${n};${cost};EUR;15`);
  }
  // Дубль: тот же оффер второй строкой с другой суммой — какая из строк верная, знает только продавец
  if (bad) lines.push('SKU-1;99,99;EUR;15');
  return lines.join('\r\n');
}

const plan = (csv: string): { plan: ImportPlan; view: ImportCheckView; seconds: number } => {
  const started = Date.now();
  const sheet = readTable(Buffer.from(csv, 'utf8'));
  const mapping = importMapping('COSTS', sheet);
  const p = buildImportPlan('COSTS', sheet, mapping, standWorld, m);
  const view = importCheckView(standWorld, p, { name: 'kosten.csv', sheet, mapping }, m);
  return { plan: p, view, seconds: Math.round((Date.now() - started) / 100) / 10 };
};

before(async () => {
  db = await createIsolatedDatabase('costlive');
  pool = db.pool('svc_app', 4);
  admin = db.pool('svc_admin', 4);
  world = await seedPricingWorld(pool, {
    provisioningPool: db.pool('svc_provisioning', 1), adminPool: admin, fixtureTenantId: TENANT, fixtureChannelAccountId: ACCOUNT,
    marketplaces: ['de'], clock: new Date().toISOString(),
    seed: { scopes: Array.from({ length: OFFERS }, (_, i) => scope(i + 1)) },
  });
  store = new PgPricingStore(pool, { adminPool: admin });
  const now = new Date().toISOString();
  const state = await store.readConsoleState(world.tenantId, now as never);
  standWorld = { id: 'cost-import-live', title: 'live', description: '', tenantId: world.tenantId, now, accounts: [],
    viewer: { role: 'OWNER', membershipId: world.ownerMembershipId }, state } as StandWorld;
});

after(async () => {
  await db.drop();
});

test('Р-134, шаг 99: примерка называет каждую ошибочную строку с номером и причиной, и файл с ошибками не применяется вовсе', () => {
  const { plan: p, view } = plan(sellerExport(true));
  assert.equal(view.counts.total, OFFERS + 1, 'каждая строка файла попала ровно в один счёт');
  assert.ok(view.counts.rejected >= Math.floor(OFFERS * BAD_SHARE * 0.9) && view.counts.rejected <= Math.ceil(OFFERS * BAD_SHARE * 1.1),
    `ошибочных строк примерно 15 %: ${view.counts.rejected}`);
  assert.deepEqual([...new Set(p.errors.map((e) => e.problem))].sort(),
    ['AMBIGUOUS_SEPARATOR', 'CURRENCY_NOT_OF_OFFER', 'DUPLICATE', 'KEY_EMPTY', 'NOT_A_NUMBER', 'NOT_FOUND'].sort());
  assert.ok(p.errors.every((e) => e.line > 1), 'у каждой ошибки номер строки файла (заголовок — строка 1)');
  // Экран не показывает тысячи строк: первые 200 ошибок и первые 50 изменений; все ошибки — в отчёте примерки
  assert.equal(view.errors.length, 200);
  assert.equal(view.applyBlocked, m.ui.imports.applyBlocked.errors(view.counts.rejected), 'применить нельзя — и сказано почему');
});

test('шаг 99 (Р-224, E): исправленный файл применяется целиком, одной транзакцией, ровно по примерке', async () => {
  const { plan: p, view, seconds } = plan(sellerExport(false));
  assert.deepEqual([view.counts.changed, view.counts.rejected], [OFFERS, 0]);
  const started = Date.now();
  const applied = await store.importCosts(world.tenantId, {
    sourceName: 'kosten.csv', sourceFormat: 'CSV', fingerprint: p.token, skippedRows: 0, asOf: standWorld.now,
    rows: p.changed.map((r) => ({ writeScopeId: r.target, currency: String(r.set.currency), unitCostMinor: Number(r.set.unitCostMinor),
      ...(r.set.feeRateBp !== undefined ? { feeRateBp: Number(r.set.feeRateBp) } : {}),
      expected: r.expected as { costProfileId: string | null; sellerFee: null } })),
  }, { membershipId: world.ownerMembershipId, userId: world.userId, mfa: true }, 'APPLY');
  const applySeconds = Math.round((Date.now() - started) / 100) / 10;
  assert.equal(applied.status, 'APPLIED', JSON.stringify(applied));
  const [counts] = await inTenant(admin, world.tenantId, async (tx) => (await tx.query(
    `SELECT (SELECT count(*)::int FROM tenant_data.cost_import) AS batches,
            (SELECT count(DISTINCT product_id)::int FROM tenant_data.cost_profile WHERE source = 'IMPORT') AS with_cost`)).rows);
  assert.deepEqual([counts.batches, counts.with_cost], [1, OFFERS], 'один пакет, себестоимость у каждого предложения файла');
  console.log(JSON.stringify({ rows: OFFERS, checkSeconds: seconds, applySeconds }));
  assert.ok(seconds + applySeconds < 60, `примерка и применение 10 000 строк: ${seconds} + ${applySeconds} с`);
  // Тот же файл ещё раз — менять нечего: примерка это и говорит
  // Профили импорта действуют с момента фиксации — мир читается на часах после неё
  const now = new Date().toISOString();
  standWorld = { ...standWorld, now, state: await store.readConsoleState(world.tenantId, now as never) };
  const again = plan(sellerExport(false));
  assert.deepEqual([again.view.counts.changed, again.view.counts.unchanged], [0, OFFERS]);
  assert.equal(again.view.applyBlocked, m.ui.imports.applyBlocked.nothing);
});
