import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createHash } from 'node:crypto';
import type { MemorySeedScope } from '@repracer/pricing-pipeline';
import { PgStockStore, inTenant, seedPricingWorld, type PgPool, type SeededPricingWorld } from '../src/index.ts';
import { createIsolatedDatabase, type IsolatedDatabase } from './isolated-db.ts';

/**
 * Шаг 35 [Р-6, Р-25, Р-152, Р-153]: хранилище остатков на настоящей PostgreSQL. Проверяется то, что обещано: остаток
 * приходит из источника, публикуемое количество — общий пул минус буфер, заказ канала уменьшает доступное через
 * резервацию, отгрузка списывает пул движением базы, устаревшее значение Inbound API не применяется, а ключ Inbound API
 * находится по отпечатку. Данные синтетические.
 */

const KAUFLAND = '20000000-0000-4000-8000-000000000351';
const TENANT = '10000000-0000-4000-8000-000000000351';

let db: IsolatedDatabase;
let world: SeededPricingWorld;
let admin: PgPool;
let store: PgStockStore;

const scope = (n: number, extra: Partial<MemorySeedScope> = {}): MemorySeedScope => ({
  writeScopeId: `ws-${n}`, productId: `prod-${n}`, channelAccountId: KAUFLAND, marketplace: 'de', externalUnitId: String(3500 + n), externalOfferId: `SYN-OFFER-${n}`,
  channelProductRef: `36235${n}`, condition: 'new', currency: 'EUR', basis: 'GROSS', pricingMode: 'OFF', strategy: null, currentPriceMinor: 1900, ...extra,
});
/** Находка 12 ревью шага 35: EAN товара 2 совпадает со ссылкой канала товара 3 — артикул «40000003» подходит ДВУМ товарам */
const AMBIGUOUS_KEY = '40000003';

before(async () => {
  db = await createIsolatedDatabase('stock');
  admin = db.pool('svc_admin', 3);
  world = await seedPricingWorld(db.pool('svc_app'), {
    provisioningPool: db.pool('svc_provisioning', 1), adminPool: admin, fixtureTenantId: TENANT, fixtureChannelAccountId: KAUFLAND,
    marketplaces: ['de', 'at'], clock: new Date().toISOString(), seed: { scopes: [scope(1), scope(2, { gtin: AMBIGUOUS_KEY }), scope(3, { channelProductRef: AMBIGUOUS_KEY })] },
  });
  store = new PgStockStore({ adminPool: admin, stockPool: db.pool('svc_stock', 2) });
});

after(async () => { await db.drop(); });

const owner = () => ({ membershipId: world.ownerMembershipId, userId: world.userId, mfa: true });
const now = () => new Date().toISOString();

test('Р-152: источник из файла → остаток в пуле; буфер аккаунта → единицы остатка и записи количества', async () => {
  const created = await store.createStockSource(world.tenantId, { mode: 'INTERNAL_POOL', name: 'Lager' }, owner());
  assert.equal(created.status, 'CREATED');
  const sourceId = (created as { stockSourceId: string }).stockSourceId;
  // Артикулы продавца — единицы канала, как в импорте себестоимости; неизвестный артикул и отрицательное число — названы
  const imported = await store.importStock(world.tenantId, sourceId, [{ sku: '3501', quantity: 10 }, { sku: '3502', quantity: 3 }, { sku: '3503', quantity: 0 }, { sku: 'nope', quantity: 1 }, { sku: '3501', quantity: 4 }, { sku: AMBIGUOUS_KEY, quantity: 99 }], owner());
  assert.equal(imported.status, 'APPLIED');
  const i = imported as Extract<typeof imported, { status: 'APPLIED' }>;
  // Артикул, подходящий двум товарам, не применяется НИКОМУ и назван [Р-138]: 99 штук не ушли ни товару 2, ни товару 3
  assert.deepEqual([i.matched, i.changed, i.unmatched], [3, 2, [{ sku: 'nope', reason: 'UNKNOWN_SKU' }, { sku: '3501', reason: 'DUPLICATE_SKU' }, { sku: AMBIGUOUS_KEY, reason: 'AMBIGUOUS_SKU' }]]);
  // Остаток внутреннего пула менялся ТОЛЬКО движениями: движений столько, сколько изменившихся товаров
  const [m] = await inTenant(admin, world.tenantId, async (tx) => (await tx.query(`SELECT count(*)::int AS n, sum(delta)::int AS d FROM tenant_data.stock_movement`)).rows);
  assert.deepEqual([m.n, m.d], [2, 13]);
  assert.equal((await store.stockSources(world.tenantId))[0]!.products, 2, 'источник отдал остаток двух товаров');

  const enabled = await store.enableStockSync(world.tenantId, world.ids.dbId(KAUFLAND), { bufferUnits: 2, maxQuantity: null, minQuantityToList: 0, acknowledgeSideEffects: false }, owner());
  assert.deepEqual(enabled, { status: 'ENABLED', scopes: 3, created: 3, awaitingAck: 0 });
  const [q] = await inTenant(admin, world.tenantId, async (tx) => (await tx.query(
    `SELECT count(*) FILTER (WHERE s.quantity_sync_enabled)::int AS enabled, count(*)::int AS scopes,
            (SELECT count(*) FROM tenant_data.offer_mapping om WHERE om.quantity_write_scope_id IS NOT NULL)::int AS mapped
       FROM tenant_data.write_scope s WHERE s.field = 'QUANTITY'`)).rows);
  assert.deepEqual([q.enabled, q.scopes, q.mapped], [3, 3, 3]);

  const recalculated = await store.recalculate(world.tenantId, null, now());
  // 10 − 2 = 8, 3 − 2 = 1, 0 → 0: у пустого товара тоже запись — ноль в канале и есть правда
  assert.deepEqual(recalculated.writes.map((w) => w.quantity).sort((a, b) => a - b), [0, 1, 8]);
  assert.equal((await store.recalculate(world.tenantId, null, now())).writes.length, 0, 'повторный пересчёт без изменений записей не создаёт');
  const page = await store.stockPage(world.tenantId, { offset: 0, limit: 10 });
  const first = page.items.find((r) => r.sku === 'syn-prod-1')!;
  assert.deepEqual([first.onHand, first.reserved, first.available], [10, 0, 10]);
  assert.deepEqual([first.channels[0]!.published, first.channels[0]!.sent?.quantity, first.channels[0]!.sent?.status, first.channels[0]!.confirmed], [8, 8, 'PENDING', null]);
  assert.deepEqual(first.channels[0]!.marketplaces, ['de'], 'витрины, делящие единицу');
  assert.deepEqual([page.summary.synced, page.summary.pendingWrites, page.summary.withStock], [3, 3, 2]);
});

test('Р-25: заказ канала резервирует остаток и уменьшает публикуемое; отгрузка списывает пул движением базы; отмена освобождает', async () => {
  const account = world.ids.dbId(KAUFLAND);
  const line = (ref: string, status: 'OPEN' | 'SHIPPED' | 'CANCELLED', offer = 'SYN-OFFER-1') => ({
    externalOrderRef: `order-${ref}`, externalOrderLineRef: `line-${ref}`, identity: { marketplace: 'de', externalOfferId: offer }, quantity: 1, orderedAt: now(), status,
  });
  const opened = await store.recordOrderLines(world.tenantId, account, [line('a', 'OPEN'), line('b', 'OPEN'), line('zzz', 'OPEN', 'SYN-OFFER-404')], now());
  assert.deepEqual([opened.created, opened.consumed, opened.released, opened.unknownOffers], [2, 0, 0, 1]);
  let row = (await store.stockPage(world.tenantId, { offset: 0, limit: 10 })).items.find((r) => r.sku === 'syn-prod-1')!;
  assert.deepEqual([row.onHand, row.reserved, row.available, row.channels[0]!.published], [10, 2, 8, 6]);
  const after = await store.recalculate(world.tenantId, opened.productIds, now());
  assert.deepEqual(after.writes.map((w) => [w.quantity, w.version]), [[6, 2]], 'новая версия вытесняет ждущую');
  // Повтор тех же строк — идемпотентно: резервация одна на строку заказа
  assert.equal((await store.recordOrderLines(world.tenantId, account, [line('a', 'OPEN')], now())).created, 0);

  const shipped = await store.recordOrderLines(world.tenantId, account, [line('a', 'SHIPPED')], now());
  assert.equal(shipped.consumed, 1);
  row = (await store.stockPage(world.tenantId, { offset: 0, limit: 10 })).items.find((r) => r.sku === 'syn-prod-1')!;
  // Пул уменьшен движением ORDER_SHIPPED (триггер базы), резервация закрыта: доступное то же — публикуемое не меняется
  assert.deepEqual([row.onHand, row.reserved, row.available], [9, 1, 8]);
  const [mv] = await inTenant(admin, world.tenantId, async (tx) => (await tx.query(`SELECT count(*)::int AS n FROM tenant_data.stock_movement WHERE reason = 'ORDER_SHIPPED' AND delta = -1`)).rows);
  assert.equal(mv.n, 1);
  assert.equal((await store.recalculate(world.tenantId, [row.productId], now())).writes.length, 0);

  const cancelled = await store.recordOrderLines(world.tenantId, account, [line('b', 'CANCELLED')], now());
  assert.equal(cancelled.released, 1);
  row = (await store.stockPage(world.tenantId, { offset: 0, limit: 10 })).items.find((r) => r.sku === 'syn-prod-1')!;
  assert.deepEqual([row.reserved, row.available], [0, 9]);
  assert.deepEqual((await store.recalculate(world.tenantId, [row.productId], now())).writes.map((w) => w.quantity), [7]);
});

test('Inbound API: ключ находится по отпечатку, устаревшее значение не применяется, неизвестный артикул назван', async () => {
  const created = await store.createStockSource(world.tenantId, { mode: 'INBOUND_API', name: 'WMS' }, owner());
  assert.equal(created.status, 'CREATED');
  const { stockSourceId, apiKey } = created as { stockSourceId: string; apiKey: string };
  assert.match(apiKey, /^rpk_[0-9a-f]{12}\.[0-9a-f]{48}$/);
  const prefix = apiKey.split('.')[0]!;
  const digest = createHash('sha256').update(apiKey).digest('hex');
  assert.deepEqual(await store.resolveInboundKey(prefix, digest), { tenantId: world.tenantId, stockSourceId });
  assert.equal(await store.resolveInboundKey(prefix, createHash('sha256').update(`${apiKey}x`).digest('hex')), null, 'неверный ключ с верным префиксом не находится');
  // Ключ в базе не лежит: только отпечаток
  const [k] = await inTenant(admin, world.tenantId, async (tx) => (await tx.query(`SELECT key_prefix, encode(key_sha256, 'hex') AS sha FROM tenant_data.inbound_api_key`)).rows);
  assert.deepEqual([k.key_prefix, k.sha], [prefix, digest]);

  const t1 = '2026-09-23T10:00:00.000Z';
  const first = await store.inboundStock(world.tenantId, stockSourceId, [{ sku: '3502', quantity: 20, asOf: t1 }, { sku: 'nope', quantity: 1, asOf: t1 }]);
  assert.deepEqual([first.applied, first.stale, first.unknownSkus], [1, 0, ['nope']]);
  const stale = await store.inboundStock(world.tenantId, stockSourceId, [{ sku: '3502', quantity: 5, asOf: '2026-09-23T09:00:00.000Z' }]);
  assert.deepEqual([stale.applied, stale.stale], [0, 1]);
  const row = (await store.stockPage(world.tenantId, { offset: 0, limit: 10 })).items.find((r) => r.sku === 'syn-prod-2')!;
  // Два пула одного товара (внутренний 3 + Inbound 20) складываются в общий остаток [Р-6]
  assert.deepEqual([row.onHand, row.available, row.channels[0]!.published], [23, 23, 21]);
});

test('Р-25: неподтверждённую резервацию освобождает по сроку работа планировщика, и срок считает база, а не вызывающий', async () => {
  /**
   * Находка 13 ревью шага 35: функция освобождения по TTL существовала с шага 2, и её не звал НИКТО. Резервация Inbound
   * API (подтверждать её некому — OQ-217) висела бы вечно, а доступный остаток был бы занижен навсегда. Теперь её зовёт
   * работа `retention` планировщика (проверка вызова — `services/scheduler/test/scheduler.test.ts`), а здесь — поведение
   * на настоящей базе.
   *
   * Чего эта проверка НЕ делает: не ждёт настоящих суток. Освобождение по сроку база разрешает только после
   * `expires_at` по СВОИМ часам, и подделать их нечем — поэтому проверяется, что до срока не освобождается ничего, ни
   * само по себе, ни по просьбе вызывающего с временем из будущего.
   */
  const account = world.ids.dbId(KAUFLAND);
  const line = (ref: string, offer: string) => ({ externalOrderRef: `ttl-${ref}`, externalOrderLineRef: `ttl-line-${ref}`, identity: { marketplace: 'de', externalOfferId: offer }, quantity: 2, orderedAt: now(), status: 'OPEN' as const });
  // У товара 2 больший пул — Inbound API (20 против 3 внутреннего): резервация остаётся CREATED, подтверждать её некому
  const inbound = await store.recordOrderLines(world.tenantId, account, [line('a', 'SYN-OFFER-2')], now());
  assert.equal(inbound.created, 1);
  assert.equal((await store.stockPage(world.tenantId, { offset: 0, limit: 10 })).items.find((r) => r.sku === 'syn-prod-2')!.reserved, 2,
    'неподтверждённая резервация занижает доступное — ради этого срок и нужен');

  const retention = db.pool('svc_scheduler', 1);
  {
    // Работа `retention` зовёт функцию с моментом базы: срок ещё не настал — не освобождается ничего
    assert.equal(Number((await retention.query(`SELECT maintenance.release_expired_reservations(now()) AS n`)).rows[0].n), 0, 'свежая резервация по сроку не освобождается');
    const [fresh] = await inTenant(admin, world.tenantId, async (tx) => (await tx.query(`SELECT count(*) FILTER (WHERE status = 'CREATED')::int AS created FROM channel_data.reservation`)).rows);
    assert.equal(fresh.created, 1, 'резервация осталась открытой');
    // Время из будущего в аргументе срок не приближает: база сверяет со своими часами
    await assert.rejects(retention.query(`SELECT maintenance.release_expired_reservations(now() + interval '25 hours') AS n`),
      (e: Error) => /has not expired yet/.test(e.message), 'освобождение по сроку — по часам базы, а не по аргументу вызывающего');
  }
});

test('Р-6: правило публикуемого количества в SQL и в коде совпадает и на потолке, и на пороге выставления — не только на буфере', async () => {
  /**
   * Находка 20 ревью шага 35: правило записано дважды — `PUBLISHED_SQL` (записи в канал) и `publishedQuantity` (экран), и
   * их равенство проверялось только буфером. Здесь распределение задаёт все три параметра, а ожидаемые числа выведены
   * вручную, а не той же функцией: иначе расхождение двух записей правила прошло бы незамеченным.
   */
  let page = await store.stockPage(world.tenantId, { offset: 0, limit: 10 });
  const availableOf = (sku: string) => page.items.find((r) => r.sku === sku)!.available;
  // Предпосылка: доступное к этому моменту — 9 у товара 1 и 21 у товара 2 (20 + 3 − резервация 2)
  assert.deepEqual([availableOf('syn-prod-1'), availableOf('syn-prod-2')], [9, 21]);
  // Буфер 7, потолок 5, порог выставления 3: товар 1 — 9 − 7 = 2 ниже порога → 0; товар 2 — 21 − 7 = 14 выше потолка → 5
  const enabled = await store.enableStockSync(world.tenantId, world.ids.dbId(KAUFLAND), { bufferUnits: 7, maxQuantity: 5, minQuantityToList: 3, acknowledgeSideEffects: false }, owner());
  assert.equal(enabled.status, 'ENABLED');
  page = await store.stockPage(world.tenantId, { offset: 0, limit: 10 });
  const shown = new Map(page.items.map((r) => [r.sku, r.channels[0]!.published]));
  assert.deepEqual([shown.get('syn-prod-1'), shown.get('syn-prod-2')], [0, 5], 'экран (правило в коде): порог и потолок');
  const writes = (await store.recalculate(world.tenantId, null, now())).writes;
  const scopeOf = new Map(page.items.map((r) => [r.channels[0]!.writeScopeId, r.sku]));
  const sent = new Map(writes.map((w) => [scopeOf.get(w.writeScopeId), w.quantity]));
  assert.deepEqual([sent.get('syn-prod-1'), sent.get('syn-prod-2')], [0, 5], 'записи в канал (правило в SQL): те же порог и потолок');
});

test('Р-97, Р-100: остатки ведёт человек с правом на каталог — зритель получает отказ, каждая запись остатков в аудите', async () => {
  const [viewer] = await inTenant(admin, world.tenantId, async (tx) => (await tx.query(`SELECT membership_id, user_id FROM tenant_data.membership WHERE role = 'VIEWER'`)).rows);
  assert.ok(viewer, 'в мире посева есть зритель');
  const actor = { membershipId: viewer.membership_id as string, userId: viewer.user_id as string, mfa: true };
  assert.deepEqual(await store.createStockSource(world.tenantId, { mode: 'INTERNAL_POOL', name: 'x' }, actor), { status: 'FORBIDDEN' });
  assert.deepEqual(await store.enableStockSync(world.tenantId, world.ids.dbId(KAUFLAND), { bufferUnits: 1, maxQuantity: null, minQuantityToList: 0, acknowledgeSideEffects: false }, actor), { status: 'FORBIDDEN' });
  // Аудит: каждая административная запись остатков — событием [Р-97]
  const [a] = await inTenant(admin, world.tenantId, async (tx) => (await tx.query(
    `SELECT count(*) FILTER (WHERE entity_type = 'tenant_data.stock_source')::int AS sources, count(*) FILTER (WHERE entity_type = 'tenant_data.stock_allocation')::int AS allocations,
            count(*) FILTER (WHERE entity_type = 'tenant_data.stock_movement')::int AS movements FROM audit.audit_event`)).rows);
  // Два источника, две версии распределения (буфер 2, затем буфер 7 с потолком и порогом), два движения инвентаризации;
  // движение ORDER_SHIPPED вставил триггер под ролью остатков — оно не административное
  assert.deepEqual([a.sources, a.allocations, a.movements], [2, 2, 2]);
});
