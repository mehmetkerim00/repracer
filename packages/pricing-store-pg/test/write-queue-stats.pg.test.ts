import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { MemorySeedScope } from '@repracer/pricing-pipeline';
import { createPool, PgStockStore, seedPricingWorld, type PgPool, type SeededPricingWorld } from '../src/index.ts';
import { createIsolatedDatabase, requireEnv, type IsolatedDatabase } from './isolated-db.ts';

/**
 * Шаг 66 (OQ-247, Р-203): ловушка статистики очереди записей — нарочно.
 *
 * Очередь `channel_write` в работе пустеет, и статистика говорит «0 строк на N страниц». Тогда все пути к таблице стоят одинаково, и
 * поиски по единице идут индексом тенанта: транзакция, ставящая много записей, идёт O(n²). Тест портит статистику ровно так
 * (строки вставлены и удалены, очистка без обрезки файла), проверяет, что ловушка взвелась, и проводит настоящий пересчёт
 * остатков через настоящие триггеры. Держит это триггер `aa_channel_write_queue_stats` (0171): сотая запись транзакции делает ANALYZE
 * очереди, и её собственные строки становятся видны планировщику; занятая блокировка — повтор на вдвое большем числе записей.
 * Тест «меньше порога» заодно держит счёт по транзакции: тот же пул только что провёл большой пересчёт, и счётчик PostgreSQL
 * «вставлено в транзакции» нёс бы его строки
 *
 * Мир — в тени: запись рождается удержанной и в той же строке уходит в историю, как у пересчёта шага 65, шедшего ~10 минут на 50 000.
 */
const TENANT = '10000000-0000-4000-8000-000000000366';
const ACCOUNT = '20000000-0000-4000-8000-000000000366';
const UNITS = 400;
const SCOPE_INDEX = 'channel_write_tenant_id_write_scope_id_version_key';

let db: IsolatedDatabase;
let world: SeededPricingWorld;
let admin: PgPool;
let su: PgPool;
let stock: PgStockStore;
let sourceId = '';

const scope = (n: number): MemorySeedScope => ({
  writeScopeId: `ws-${n}`, productId: `prod-${n}`, channelAccountId: ACCOUNT, marketplace: 'de', externalUnitId: String(660000 + n), externalOfferId: `SYN-OFFER-66-${n}`,
  channelProductRef: `3660${n}`, condition: 'new', currency: 'EUR', basis: 'GROSS', pricingMode: 'OFF', strategy: null, currentPriceMinor: 1900,
});
const owner = () => ({ membershipId: world.ownerMembershipId, userId: world.userId, mfa: true });

before(async () => {
  db = await createIsolatedDatabase('queuestats');
  admin = db.pool('svc_admin', 3);
  const url = new URL(requireEnv('REPRACER_PG_ADMIN_URL')); url.pathname = `/${db.name}`;
  su = createPool(url.toString(), { max: 1, applicationName: 'repracer-queue-stats' });
  world = await seedPricingWorld(db.pool('svc_app', 4), {
    provisioningPool: db.pool('svc_provisioning', 1), adminPool: admin, fixtureTenantId: TENANT, fixtureChannelAccountId: ACCOUNT,
    marketplaces: ['de'], clock: new Date().toISOString(), writeMode: 'SHADOW', seed: { scopes: Array.from({ length: UNITS }, (_, i) => scope(i + 1)) },
  });
  stock = new PgStockStore({ adminPool: admin, stockPool: db.pool('svc_stock', 2) });
  const source = await stock.createStockSource(world.tenantId, { mode: 'INTERNAL_POOL', name: 'Lager' }, owner());
  sourceId = (source as { stockSourceId: string }).stockSourceId;
  await stock.importStock(world.tenantId, sourceId, Array.from({ length: UNITS }, (_, i) => ({ sku: String(660001 + i), quantity: 20 })), owner());
  const account = world.ids.dbId(ACCOUNT);
  await stock.answerOtherTools(world.tenantId, account, 'NONE', owner());
  const state = await stock.quantityWritesState(world.tenantId, account);
  assert.equal((await stock.confirmQuantityWrites(world.tenantId, account, state!.externalAccountId, owner())).status, 'CONFIRMED');
  assert.equal((await stock.enableStockSync(world.tenantId, account, { bufferUnits: 0, maxQuantity: null, minQuantityToList: 0, acknowledgeSideEffects: false }, owner())).status, 'ENABLED');
  await stock.recalculate(world.tenantId, null, new Date().toISOString() as never);
});

after(async () => {
  await su?.end();
  await db?.drop();
});

/** Ловушка: очередь была полна строками тенанта и опустела, очистка не обрезала файл — «0 строк на N страниц» */
async function trapQueueStatistics(): Promise<{ reltuples: number; relpages: number }> {
  const client = await su.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL session_replication_role = replica');
    await client.query(`INSERT INTO tenant_data.channel_write (tenant_id, write_scope_id, field, version, idempotency_key, origin, status, quantity)
      SELECT $1, gen_random_uuid(), 'QUANTITY', 1, 'trap-' || i, 'STOCK_RECALC', 'PENDING', 1 FROM generate_series(1, 5000) i`, [world.tenantId]);
    await client.query(`DELETE FROM tenant_data.channel_write WHERE idempotency_key LIKE 'trap-%'`);
    await client.query('COMMIT');
  } finally {
    client.release();
  }
  await su.query('VACUUM (TRUNCATE false) tenant_data.channel_write');
  return stats();
}

/**
 * Когда очередь анализировали ВРУЧНУЮ — то есть ANALYZE транзакции (`last_analyze`). Автоанализ пишет своё поле (`last_autoanalyze`),
 * поэтому признак не зависит от того, успела ли автоочистка проанализировать очередь после фиксации
 */
async function lastManualAnalyze(): Promise<number> {
  const { rows: [r] } = await su.query(`SELECT coalesce(extract(epoch FROM pg_stat_get_last_analyze_time('tenant_data.channel_write'::regclass)), 0)::float8 AS t`);
  return Number((r as { t: number }).t);
}

async function stats(): Promise<{ reltuples: number; relpages: number }> {
  const { rows: [r] } = await su.query(`SELECT reltuples, relpages FROM pg_class WHERE oid = 'tenant_data.channel_write'::regclass`);
  return { reltuples: Number((r as { reltuples: number }).reltuples), relpages: Number((r as { relpages: number }).relpages) };
}

/** Индекс, которым роль остатков ищет прежние версии единицы (поиск триггера `channel_write_after_insert`) */
async function supersedeIndex(): Promise<string> {
  const client = await su.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE svc_stock');
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [world.tenantId]);
    await client.query('SET LOCAL plan_cache_mode = force_generic_plan');
    await client.query(`PREPARE supersede(uuid, uuid) AS UPDATE tenant_data.channel_write SET next_attempt_at = NULL
      WHERE tenant_id = $1 AND write_scope_id = $2 AND version < 5 AND status IN ('PENDING', 'BLOCKED', 'FAILED')`);
    const { rows } = await client.query(`EXPLAIN EXECUTE supersede('${world.tenantId}', '${world.tenantId}')`);
    return rows.map((r) => String((r as { 'QUERY PLAN': string })['QUERY PLAN'])).join(' ').match(/(?:using|on) (channel_write_[a-z_]+)/)?.[1] ?? 'none';
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    await client.query('DEALLOCATE ALL').catch(() => undefined);
    client.release();
  }
}

async function changeEveryQuantity(quantity: number, units = UNITS): Promise<number> {
  await stock.importStock(world.tenantId, sourceId, Array.from({ length: units }, (_, i) => ({ sku: String(660001 + i), quantity })), owner());
  const result = await stock.recalculate(world.tenantId, null, new Date().toISOString() as never);
  return result.writes.length;
}

test('step 66 (OQ-247): a transaction putting many writes into the queue refreshes the queue statistics itself, so its lookups stay on the unit index', async () => {
  const trapped = await trapQueueStatistics();
  assert.equal(trapped.reltuples, 0, 'the trap is set: statistics say the queue is empty');
  assert.ok(trapped.relpages > 0, `the trap is set: the file still has pages (${trapped.relpages})`);
  /**
   * Куда ловушка уведёт поиск по единице, не утверждается: при «0 строк» все пути стоят одинаково, и выбор между индексами с tenant_id
   * решают мелочи — высота деревьев, порядок индексов (на воспроизведении шага 66 — индекс идемпотентности, здесь бывает и индекс
   * единицы). Детерминировано другое — ниже: после большой транзакции статистика несёт её строки, и тогда поиск идёт индексом единицы
   */

  const before = await lastManualAnalyze();
  const writes = await changeEveryQuantity(30);
  assert.equal(writes, UNITS, 'the recalculation put a new version of every unit into the queue');
  // Сотая запись транзакции сделала ANALYZE очереди (в тени строка уходит в историю сразу, живы оставшиеся — их он и сосчитал)
  assert.equal((await lastManualAnalyze()) > before, true, 'step 66: the bulk transaction refreshed the queue statistics with its own rows');
  assert.equal(await supersedeIndex(), SCOPE_INDEX, 'after the refresh the unit lookup is on the unit index');
});

test('step 66 (OQ-247): a transaction with fewer than 100 writes does not analyze the queue — ordinary writes pay nothing', async () => {
  await trapQueueStatistics();
  const before = await lastManualAnalyze();
  const writes = await changeEveryQuantity(40, 50);
  assert.equal(writes, 50);
  assert.equal(await lastManualAnalyze(), before, 'no ANALYZE below the threshold');
});

test('step 66 (review, finding 4): while another session holds the analyze lock, a bulk transaction waits only the lock timeout per attempt and does not fail; once it is free, the next one analyzes', async () => {
  await trapQueueStatistics();
  // Другой сеанс держит блокировку ANALYZE очереди до своей фиксации — как большая транзакция соседа или очистка. Свой пул: пул
  // суперпользователя теста на одно соединение, и держатель занял бы его у проверок
  const url = new URL(requireEnv('REPRACER_PG_ADMIN_URL')); url.pathname = `/${db.name}`;
  const holderPool = createPool(url.toString(), { max: 1, applicationName: 'repracer-queue-stats-holder' });
  const holder = await holderPool.connect();
  try {
    await holder.query('BEGIN');
    await holder.query('ANALYZE tenant_data.channel_write');
    const before = await lastManualAnalyze();
    const started = Date.now();
    assert.equal(await changeEveryQuantity(50), UNITS, 'the bulk transaction completed while the lock was held');
    // Попыток на 400 записях — три (100, 200, 400), каждая ждёт не дольше 2 с (дольше deadlock_timeout — чтобы автоочистку сняла база)
    assert.ok(Date.now() - started < 30_000, `the bulk transaction did not wait for the holder's commit: ${Date.now() - started} ms`);
    assert.equal(await lastManualAnalyze(), before, 'no ANALYZE while the lock was held');
  } finally {
    await holder.query('COMMIT').catch(() => undefined);
    holder.release();
    await holderPool.end();
  }
  const freed = await lastManualAnalyze();
  await changeEveryQuantity(60);
  assert.ok((await lastManualAnalyze()) > freed, 'with the lock free, the next bulk transaction analyzes');
});
