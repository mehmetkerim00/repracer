import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { buildPreview, readTable, suggestMapping } from '@repracer/cost-import';
import { costImportView, importTargets, messagesFor } from '@repracer/console-model';
import type { MemorySeedScope } from '@repracer/pricing-pipeline';
import { inTenant, PgPricingStore, seedPricingWorld, type PgPool, type SeededPricingWorld } from '@repracer/pricing-store-pg';
import { createIsolatedDatabase, type IsolatedDatabase } from '../../../packages/pricing-store-pg/test/isolated-db.ts';

/**
 * Р-130, Р-134, Р-135 (шаг 28): живой прогон массового импорта себестоимости. Настоящая выгрузка продавца (10 000 строк, 15 % с
 * ошибками) проходит весь путь: чтение файла → сопоставление колонок → предпросмотр → применение целиком на настоящей PostgreSQL.
 * Утверждается наблюдаемое: что видит продавец на экране и что оказалось в базе. Данные синтетические.
 */

const TENANT = '10000000-0000-4000-8000-000000000282';
const ACCOUNT = '20000000-0000-4000-8000-000000000282';
const OFFERS = 10_000;
/** Доля строк файла с ошибками: 15 % — как в задаче шага */
const BAD_SHARE = 0.15;

let db: IsolatedDatabase;
let pool: PgPool;
let admin: PgPool;
let world: SeededPricingWorld;
let store: PgPricingStore;
let csv: string;
let observed: {
  seconds: number;
  view: ReturnType<typeof costImportView>;
  applied: { rows: number; offers: number };
  withCost: number;
  batches: number;
};

function scope(n: number): MemorySeedScope {
  return {
    writeScopeId: `ws-${n}`, productId: `prod-${n}`, channelAccountId: ACCOUNT, marketplace: 'de', externalUnitId: `SKU-${n}`,
    channelProductRef: `3629${String(n).padStart(6, '0')}`, condition: 'new', currency: 'EUR', basis: 'GROSS', pricingMode: 'OFF', strategy: null,
    currentPriceMinor: 1900, minPrice: { amountMinor: 1000, id: `min-${n}` }, maxPrice: { amountMinor: 9000, id: `max-${n}` },
  };
}

/** Выгрузка продавца: немецкий формат чисел, точка с запятой, и 15 % строк, которые импорт применить не сможет */
function sellerExport(unitIdOf: (n: number) => string): string {
  const lines = ['Artikelnummer;Einstandspreis;Währung;Provision %'];
  for (let n = 1; n <= OFFERS; n += 1) {
    const cost = `${9 + (n % 40)},${String(n % 100).padStart(2, '0')}`;
    // Каждая седьмая строка (≈14,3 %) — с ошибкой; вид ошибки чередуется, чтобы продавец увидел все причины
    if (n % 7 === 0) {
      const kind = (n / 7) % 5;
      if (kind === 0) lines.push(`SKU-NICHT-DA-${n};${cost};EUR;15`);
      else if (kind === 1) lines.push(`${unitIdOf(n)};;EUR;15`);
      else if (kind === 2) lines.push(`${unitIdOf(n)};k.A.;EUR;15`);
      else if (kind === 3) lines.push(`${unitIdOf(n)};${cost};USD;15`);
      else lines.push(`;${cost};EUR;15`);
      continue;
    }
    lines.push(`${unitIdOf(n)};${cost};EUR;15`);
  }
  // Дубль: тот же оффер второй строкой с другой суммой — не применяется ни одна из двух
  lines.push(`${unitIdOf(1)};99,99;EUR;15`);
  return lines.join('\r\n');
}

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
  csv = sellerExport((n) => `SKU-${n}`);

  const started = Date.now();
  // Путь ровно тот же, что у экрана: чтение файла → подсказки колонок → предпросмотр
  const sheet = readTable(Buffer.from(csv, 'utf8'));
  const suggested = suggestMapping(sheet);
  const state = await store.readConsoleState(world.tenantId, new Date().toISOString() as never);
  const standWorld = { id: 'cost-import-live', title: 'live', description: '', tenantId: world.tenantId, now: new Date().toISOString(),
    accounts: [], viewer: { role: 'OWNER', membershipId: world.ownerMembershipId, email: 'syn@example.invalid' }, state } as never;
  const m = messagesFor('de');
  const offers = importTargets(standWorld, m);
  const preview = buildPreview({ sheet, mapping: suggested.mapping, offers });
  const view = costImportView(standWorld, preview, { name: 'kosten.csv', sheet, mapping: suggested.mapping }, suggested.suggestions, m);
  const applied = await store.importCosts(world.tenantId, {
    sourceName: 'kosten.csv', sourceFormat: sheet.format, fingerprint: preview.fingerprint, skippedRows: preview.totals.skipped,
    rows: preview.apply.map((r) => ({ writeScopeId: r.writeScopeId!, unitCostMinor: r.unitCostMinor!, currency: r.currency!, ...(r.feeRateBp === undefined ? {} : { feeRateBp: r.feeRateBp }) })),
  }, { membershipId: world.ownerMembershipId, userId: world.userId, mfa: true }, 'APPLY');
  assert.equal(applied.status, 'APPLIED', JSON.stringify(applied));
  const [counts] = await inTenant(admin, world.tenantId, async (tx) => (await tx.query(
    `SELECT (SELECT count(*)::int FROM tenant_data.cost_import) AS batches,
            (SELECT count(DISTINCT product_id)::int FROM tenant_data.cost_profile WHERE source = 'IMPORT') AS with_cost`)).rows);
  observed = {
    seconds: Math.round((Date.now() - started) / 100) / 10,
    view, applied: { rows: applied.rows, offers: applied.offers }, withCost: counts.with_cost, batches: counts.batches,
  };
  console.log(JSON.stringify({
    rowsInFile: view.summary.apply + view.summary.skipped, apply: view.summary.apply, skipped: view.summary.skipped,
    offersCovered: view.summary.offersCovered, stillWithoutCost: view.stillWithoutCost,
    problems: view.skipped.map((g) => [g.problem, g.rows]), headline: view.headline, seconds: observed.seconds,
  }));
});

after(async () => {
  await db.drop();
});

test('Р-134: продавец видит, что применится и что нет, ещё до применения — у каждой непримененной строки есть причина', () => {
  const view = observed.view;
  assert.equal(view.summary.apply + view.summary.skipped, OFFERS + 1, 'каждая строка файла попала ровно в один список');
  // 15 % строк с ошибками: каждая седьмая плюс строка-дубль, из-за которой не применяется и её пара
  assert.ok(view.summary.skipped >= Math.floor(OFFERS * BAD_SHARE * 0.9), `непримененных строк примерно 15 %: ${view.summary.skipped}`);
  assert.ok(view.summary.skipped <= Math.ceil(OFFERS * BAD_SHARE * 1.1), `непримененных строк примерно 15 %: ${view.summary.skipped}`);
  assert.deepEqual(view.skipped.map((g) => g.problem).sort(), ['COST_MISSING', 'COST_NOT_A_NUMBER', 'CURRENCY_NOT_OF_OFFER', 'DUPLICATE_OFFER', 'OFFER_KEY_EMPTY', 'OFFER_NOT_FOUND'].sort());
  for (const group of view.skipped) {
    assert.ok(group.rows > 0 && group.text.length > 10, `у причины ${group.problem} есть текст и число строк`);
    assert.ok(group.examples.length > 0 && group.examples.every((e) => e.line > 1), `у причины ${group.problem} показаны примеры строк файла`);
  }
  // Экран не показывает десять тысяч строк: первые двадцать и заголовок с числами
  assert.equal(view.rows.length, 20);
  assert.match(view.headline, /10001 Zeilen in der Datei/);
  assert.equal(view.mfaRequired, true);
});

test('Р-134: применяется ровно показанное, целиком и за один раз', () => {
  assert.equal(observed.applied.rows, observed.view.summary.apply, 'применены все показанные строки');
  assert.equal(observed.applied.offers, observed.view.summary.offersCovered);
  assert.equal(observed.withCost, observed.view.summary.offersCovered, 'у стольких же офферов в базе появилась себестоимость');
  assert.equal(observed.batches, 1, 'один пакет на один импорт');
  // Р-131: офферы, строки которых не сопоставились, репрайсинг включить не смогут — и продавец видит их число
  assert.equal(observed.view.stillWithoutCost, OFFERS - observed.view.summary.offersCovered);
  assert.ok(observed.seconds < 60, `импорт 10 000 строк проходит за разумное время: ${observed.seconds} с`);
});

test('Р-131: после импорта себестоимость видит путь решения', async () => {
  const applied = observed.view.rows[0]!;
  assert.ok(applied.unit, 'у применённой строки есть оффер');
  const hasCost = async (scopeAlias: string) => {
    const [row] = await inTenant(admin, world.tenantId, async (tx) => (await tx.query(
      'SELECT tenant_data.write_scope_has_cost($1, $2) AS ok', [world.tenantId, world.ids.dbId(scopeAlias)])).rows);
    return row.ok as boolean;
  };
  // Первый оффер — строка-дубль: у него себестоимости нет, и это видно
  assert.equal(await hasCost('ws-1'), false, 'оффер из строки-дубля себестоимости не получил');
  assert.equal(await hasCost('ws-2'), true, 'оффер из применённой строки себестоимость получил');
});
