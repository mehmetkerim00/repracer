import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { messagesFor, productList, productPage } from '@repracer/console-model';
import { buildStandWorlds, pgStandJoinMember, pgStandUsers, STAND_EMAILS, STAND_USERS, type LiveWorld } from '@repracer/contract-tests/stand';
import { pgStoreFactory } from '@repracer/contract-tests/pg-store';
import { PgIdentityDirectory } from '@repracer/identity/pg';
import { createPool } from '@repracer/pricing-store-pg';

/**
 * Шаг 66 (OQ-248): экран товаров больше не строит каталог целиком — страницу и итоги по всему каталогу выбирает база
 * (`consoleCatalogPage`), а мир собирается только из единиц страницы. Итоги считает SQL, а не `enabledCell` экрана: два правила
 * одного и того же — и тест держит их РАВНЫМИ на всех мирах стенда, поднятых на PostgreSQL (остановки человеком, системные
 * остановки, недоверие каналу, Automate Pricing, записи в полёте). Страница — те же единицы в том же порядке, что у каталога
 * в памяти; ответ экрана — тот же, что у полного каталога.
 */
const PG_URL = process.env.REPRACER_PG_URL;
// Р-84: без базы тест не пропускается, а падает
if (!PG_URL) throw new Error('REPRACER_PG_URL is required: database tests do not skip (Р-84)');
const role = (r: string) => createPool(PG_URL.replace('svc_app@', `${r}@`), { max: 2, applicationName: 'repracer-catalog-page' });
const pool = createPool(PG_URL, { max: 6, applicationName: 'repracer-catalog-page' });
const pools = { scan: role('svc_dispatcher'), fx: role('svc_fx_loader'), onboarding: role('svc_onboarding'), admin: role('svc_admin'),
  bulk: role('svc_bulk_worker'), auth: role('svc_authenticator'), provisioning: role('svc_provisioning') };
let worlds: LiveWorld[] = [];
/** Суперпользователь той же базы — записи в полёте ставятся мимо стражей: на посеве стенда их нет, а итог «применяется» без них пуст */
const superUrl = new URL(process.env.REPRACER_PG_ADMIN_URL ?? PG_URL); superUrl.pathname = new URL(PG_URL).pathname;
const su = createPool(superUrl.toString(), { max: 1, applicationName: 'repracer-catalog-page-su' });

before(async () => {
  const directory = new PgIdentityDirectory(pools.auth as never);
  const memberUsers = await pgStandUsers(directory, pools.onboarding);
  worlds = await buildStandWorlds({
    storeFactory: pgStoreFactory(pool, pools.scan, pools.fx, { memberUsers, memberEmails: STAND_EMAILS, joinMember: pgStandJoinMember(pools.admin, directory),
      adminPool: pools.admin, provisioningPool: pools.provisioning, bulkWorkerPool: pools.bulk }),
  });
});
after(async () => {
  // Уборка — мимо стражей (как и вставка): страж удаления записи пускает только свою роль; ошибку не глотать (ревью шага 66, находка 6)
  const cleaner = await su.connect();
  try {
    await cleaner.query('BEGIN');
    await cleaner.query('SET LOCAL session_replication_role = replica');
    await cleaner.query(`DELETE FROM tenant_data.channel_write WHERE idempotency_key LIKE 'step66-catalog-%' AND tenant_id = ANY ($1::uuid[])`, [worlds.map((w) => w.identityTenantId)]);
    await cleaner.query('COMMIT');
  } finally {
    cleaner.release();
  }
  await su.end();
  await pool.end();
  for (const p of Object.values(pools)) await p.end();
});

test('step 66 (OQ-248): the catalog page and totals chosen by the database equal the products screen on the whole catalog, on every stand world', async () => {
  const m = messagesFor('en');
  const viewer = { ...STAND_USERS.find((u) => u.role === 'OWNER')! };
  const seen = { enabled: 0, stopped: 0, off: 0, applying: 0, worlds: 0 };
  /**
   * Записи в полёте у трёх единиц одного мира — по правилу `applyingCell`: ждущая и отказавшая со сроком повтора «применяются»,
   * заблокированная — нет (она «остановлена»). Без них итог «применяется» сравнивался бы как ноль с нулём
   */
  /**
   * Миры стенда живут в псевдонимах сценария; в базе — UUID (`identityTenantId`). Единицы берутся из базы — у тенанта СВОИХ миров:
   * соседние файлы рабочего пространства строят миры стенда в той же базе параллельно (ревью шага 66, находка 6)
   */
  const { rows: units } = await su.query(
    `WITH t AS (SELECT s.tenant_id FROM tenant_data.write_scope s
                  JOIN tenant_data.offer_mapping m ON m.tenant_id = s.tenant_id AND m.price_write_scope_id = s.write_scope_id AND m.status <> 'ENDED'
                 WHERE s.field = 'PRICE' AND s.status <> 'RETIRED' AND s.tenant_id = ANY ($1::uuid[])
                 GROUP BY s.tenant_id HAVING count(*) >= 3 ORDER BY s.tenant_id LIMIT 1)
     SELECT s.tenant_id, s.write_scope_id, s.currency, s.price_basis FROM tenant_data.write_scope s
       JOIN tenant_data.offer_mapping m ON m.tenant_id = s.tenant_id AND m.price_write_scope_id = s.write_scope_id AND m.status <> 'ENDED'
      WHERE s.tenant_id = (SELECT tenant_id FROM t) AND s.field = 'PRICE' AND s.status <> 'RETIRED' ORDER BY s.write_scope_id LIMIT 3`, [worlds.map((w) => w.identityTenantId)]);
  assert.equal(units.length, 3, 'a stand world of this run has three units for writes in flight');
  for (const [i, [status, retry]] of ([['PENDING', false], ['FAILED', true], ['BLOCKED', false]] as const).entries()) {
    const client = await su.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL session_replication_role = replica');
      await client.query(`INSERT INTO tenant_data.channel_write (tenant_id, write_scope_id, field, version, idempotency_key, origin, status, amount_minor, currency, price_basis,
                            price_decision_id, dispatched_at, next_attempt_at)
                          VALUES ($1, $2, 'PRICE', 900000 + $3, 'step66-catalog-' || $3, 'PRICE_DECISION', $4, 1999, $5, $6, gen_random_uuid(),
                                  CASE WHEN $4 = 'FAILED' THEN now() END, CASE WHEN $7 THEN now() + interval '1 hour' END)`,
        [units[i]!.tenant_id, units[i]!.write_scope_id, i, status, units[i]!.currency, units[i]!.price_basis, retry]);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
  }
  for (const live of worlds) {
    assert.ok(live.store.consoleCatalogPage, `${live.id}: the PostgreSQL store chooses catalog pages`);
    const full = await live.view(viewer as never);
    const expected = productList(full, m, { offset: 0, limit: 50 });
    // Страницы по 7: каталог стенда мал, и так проверяются и середина, и последняя неполная страница, и смещение за концом
    for (const offset of [0, 7, 14, 1000]) {
      const query = { offset, limit: 7 };
      const page = await live.store.consoleCatalogPage!(live.tenantId, live.clock.iso() as never, query);
      assert.deepEqual(page.scopeIds, productPage(full, m, query).shown.map((s) => s.writeScopeId), `${live.id}: the page at ${offset} is the same units in the same order`);
      const partial = await live.view(viewer as never, { scopeIds: page.scopeIds });
      const fromDb = productList(partial, m, query, undefined, page);
      const fromMemory = productList(full, m, query);
      assert.deepEqual(fromDb.totals, expected.totals, `${live.id}: totals of the whole catalog — database equals the screen rule`);
      assert.deepEqual({ ...fromDb, now: '' }, { ...fromMemory, now: '' }, `${live.id}: the screen built from the page equals the screen built from the whole catalog (offset ${offset})`);
    }
    seen.worlds += 1;
    seen.enabled += expected.totals.enabled;
    seen.stopped += expected.totals.stopped;
    seen.off += expected.totals.off;
    seen.applying += expected.totals.applying;
  }
  // Сравнение не пустое: каждое состояние встретилось — иначе равенство было бы равенством нулей [Р-94]
  assert.ok(seen.worlds >= 5 && seen.enabled > 0 && seen.stopped > 0 && seen.off > 0 && seen.applying > 0, `every state is covered: ${JSON.stringify(seen)}`);
});
