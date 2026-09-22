import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MemorySeedScope } from '@repracer/pricing-pipeline';
import { seedPricingWorld, PgStockStore, type PgPool, type SeededPricingWorld } from '../src/index.ts';
import { createIsolatedDatabase, requireEnv, type IsolatedDatabase } from './isolated-db.ts';

/**
 * Р-158 (шаг 36): резервная копия без ПРОВЕРЕННОГО восстановления — обещание, а не копия. Поэтому восстановление здесь
 * часть сборки: база снимается `pg_dump` ровно так, как это делает суточная работа профиля production
 * (`deploy/production/backup-loop.sh`), поднимается на ЧИСТОЙ базе и проверяется — данные на месте, а защиты схемы
 * работают: восстановленная база отказывает там же, где отказывала исходная. Данные синтетические.
 */

/** Идентификатор тенанта в базе даёт посев: подставлять константу фикстуры нельзя — посев выдаёт свой */
const TENANT = '10000000-0000-4000-8000-000000000361';
const ACCOUNT = '20000000-0000-4000-8000-000000000361';
const scope = (n: number): MemorySeedScope => ({
  writeScopeId: `ws-${n}`, productId: `prod-${n}`, channelAccountId: ACCOUNT, marketplace: 'de', externalUnitId: String(3600 + n),
  externalOfferId: `SYN-OFFER-${n}`, channelProductRef: `36236${n}`, condition: 'new', currency: 'EUR', basis: 'GROSS',
  pricingMode: 'OFF', strategy: null, currentPriceMinor: 1900,
});

let db: IsolatedDatabase;
let world: SeededPricingWorld;
let admin: PgPool;
let dir = '';
let dumpFile = '';
let restored = '';
const psqlEnv = () => ({ ...process.env, PGHOST: process.env.PGHOST ?? '127.0.0.1', PGPORT: process.env.PGPORT ?? '5432', PGUSER: process.env.PGUSER ?? 'postgres' });
const superUrl = (name: string) => { const u = new URL(requireEnv('REPRACER_PG_ADMIN_URL')); u.pathname = `/${name}`; return u.toString(); };

before(async () => {
  db = await createIsolatedDatabase('backup');
  admin = db.pool('svc_admin', 2);
  world = await seedPricingWorld(db.pool('svc_app', 2), {
    provisioningPool: db.pool('svc_provisioning', 1), adminPool: admin, fixtureTenantId: TENANT, fixtureChannelAccountId: ACCOUNT,
    marketplaces: ['de'], clock: new Date().toISOString(), seed: { scopes: [scope(1), scope(2), scope(3)] },
  });
  // Немного данных тенанта, которые обязаны пережить восстановление: остаток и его источник
  const stock = new PgStockStore({ adminPool: admin, stockPool: db.pool('svc_stock', 1) });
  const source = await stock.createStockSource(world.tenantId, { mode: 'INTERNAL_POOL', name: 'Lager' },
    { membershipId: world.ownerMembershipId, userId: world.userId, mfa: true });
  const sourceId = (source as { stockSourceId: string }).stockSourceId;
  await stock.importStock(world.tenantId, sourceId, [{ sku: '3601', quantity: 12 }, { sku: '3602', quantity: 5 }],
    { membershipId: world.ownerMembershipId, userId: world.userId, mfa: true });
  dir = mkdtempSync(join(tmpdir(), 'repracer-backup-'));
  restored = `${db.name}_restored`;
});

after(async () => {
  if (restored) execFileSync('psql', ['-d', superUrl('postgres'), '-c', `DROP DATABASE IF EXISTS ${restored} WITH (FORCE)`], { env: psqlEnv(), stdio: 'ignore' });
  if (dir) rmSync(dir, { recursive: true, force: true });
  await db?.drop();
});

/** Сколько строк тенанта в таблице — глазами суперпользователя базы */
function count(dbName: string, sql: string): number {
  const out = execFileSync('psql', ['-d', superUrl(dbName), '-Atc', sql], { env: psqlEnv(), encoding: 'utf8' });
  return Number(out.trim());
}

test('Р-158: копия снимается тем же способом, что суточной работой профиля, и она не пуста', () => {
  dumpFile = join(dir, 'repracer.dump');
  // Тот же вызов, что в deploy/production/backup-loop.sh: формат с оглавлением, восстанавливается pg_restore
  execFileSync('pg_dump', ['--dbname', superUrl(db.name), '--format=custom', '--file', dumpFile], { env: psqlEnv(), stdio: 'pipe' });
  const bytes = statSync(dumpFile).size;
  assert.ok(bytes > 50_000, `копия базы с данными не может быть крошечной: ${bytes} байт`);
});

test('Р-158: база поднимается из копии на ЧИСТОЙ базе, и данные тенанта на месте', () => {
  execFileSync('psql', ['-d', superUrl('postgres'), '-c', `CREATE DATABASE ${restored}`], { env: psqlEnv(), stdio: 'pipe' });
  execFileSync('pg_restore', ['--dbname', superUrl(restored), '--no-owner', '--exit-on-error', dumpFile], { env: psqlEnv(), stdio: 'pipe' });

  // Числа сверяются с ИСХОДНОЙ базой, а не с ожиданием в голове теста
  for (const [what, sql] of [
    ['предложения', `SELECT count(*) FROM tenant_data.offer_mapping WHERE tenant_id = '${world.tenantId}'`],
    ['единицы записи', `SELECT count(*) FROM tenant_data.write_scope WHERE tenant_id = '${world.tenantId}'`],
    ['пулы остатка', `SELECT count(*) FROM tenant_data.stock_pool WHERE tenant_id = '${world.tenantId}'`],
    ['движения остатка', `SELECT count(*) FROM tenant_data.stock_movement WHERE tenant_id = '${world.tenantId}'`],
    ['участники', `SELECT count(*) FROM tenant_data.membership WHERE tenant_id = '${world.tenantId}'`],
  ] as Array<[string, string]>) {
    const before = count(db.name, sql);
    assert.ok(before > 0, `${what}: в исходной базе они есть (${before})`);
    assert.equal(count(restored, sql), before, `${what}: столько же после восстановления`);
  }
  // Остаток — не только строки, но и ЗНАЧЕНИЯ: 12 + 5 штук инвентаризации
  assert.equal(count(restored, `SELECT coalesce(sum(on_hand), 0) FROM tenant_data.stock_pool WHERE tenant_id = '${world.tenantId}'`), 17);
});

test('Р-158: восстановленная база — не свалка строк: защиты схемы на месте и отказывают так же', () => {
  const expectFail = (sql: string, part: string, what: string) => {
    let message = '';
    try {
      execFileSync('psql', ['-d', superUrl(restored), '-v', 'ON_ERROR_STOP=1', '-c', sql], { env: psqlEnv(), stdio: 'pipe' });
    } catch (error) {
      message = String((error as { stderr?: Buffer }).stderr ?? '');
    }
    assert.match(message, new RegExp(part), `${what}: восстановленная база обязана отказать своей причиной`);
  };
  // Проверка значения столбца: код события — код, а не фраза
  expectFail(`INSERT INTO tenant_data.alert (tenant_id, code, severity) VALUES ('${world.tenantId}', 'кириллица не код', 'WARNING')`,
    'alert_code_shape', 'проверка значения столбца');
  // Страж-триггер: алерт нельзя поднять уже доставленным [Р-156]
  expectFail(`INSERT INTO tenant_data.alert (tenant_id, code, severity, delivered_at, delivery_kind) VALUES ('${world.tenantId}', 'PRICE_WRITE_NOT_SENT', 'CRITICAL', now(), 'EMAIL_IMMEDIATE')`,
    'cannot be raised as already delivered', 'страж-триггер');
  // Политика строк: роль пути решения не видит чужого тенанта — значит RLS включена и после восстановления
  const rls = execFileSync('psql', ['-d', superUrl(restored), '-Atc',
    `SELECT count(*) FROM pg_class WHERE relnamespace = 'tenant_data'::regnamespace AND relkind = 'r' AND NOT relrowsecurity`],
    { env: psqlEnv(), encoding: 'utf8' });
  assert.equal(rls.trim(), '0', 'у каждой таблицы тенанта включена политика строк [ADR-0003]');
});
