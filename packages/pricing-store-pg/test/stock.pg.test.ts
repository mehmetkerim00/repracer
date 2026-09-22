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

test('Р-157: резервация Inbound API ждёт подтверждения источника — отгрузка до него не списывает пул и названа числом', async () => {
  /**
   * Шаг 36 [Р-157], остаток находки 13 ревью шага 35 и OQ-217: подтверждать резервацию Inbound API было НЕКОМУ, и
   * отгрузка по неподтверждённой резервации пропадала молча — ни списания, ни числа. Теперь источник подтверждает заказ
   * сам (`confirmInboundOrders`), а отгрузка до подтверждения считается в `awaitingConfirmation`.
   *
   * Состояние мира к этому тесту выведено из предыдущих, а не спрошено у проверяемых функций: товар 1 — внутренний пул
   * 9 штук (10 по инвентаризации минус одна отгрузка теста Р-25), товар 2 — 3 во внутреннем пуле и 20 в пуле Inbound API,
   * из них 2 держит неподтверждённая резервация `ttl-a`. Распределение канала — буфер 7, потолок 5, порог 3.
   */
  const account = world.ids.dbId(KAUFLAND);
  const inboundSources = (await store.stockSources(world.tenantId)).filter((s) => s.mode === 'INBOUND_API');
  assert.equal(inboundSources.length, 1, 'источник Inbound API в мире ровно один — тот, что завёл тест выше');
  const sourceId = inboundSources[0]!.stockSourceId;
  const line = (ref: string, status: 'OPEN' | 'SHIPPED', quantity: number, offer: string) => ({
    externalOrderRef: `r157-${ref}`, externalOrderLineRef: `r157-line-${ref}`, identity: { marketplace: 'de', externalOfferId: offer }, quantity, orderedAt: now(), status,
  });
  /** Состояние резервации в базе: статус и заполненность полей подтверждения — по строке, а не по ответу хранилища */
  const reservationOf = async (ref: string) => {
    const [r] = await inTenant(admin, world.tenantId, async (tx) => (await tx.query(
      `SELECT status, source_mode, quantity, confirmed_at IS NOT NULL AS confirmed, confirmed_by_stock_source_id, confirmed_external_order_ref, consumed_at IS NOT NULL AS consumed
         FROM channel_data.reservation WHERE channel_order_ref = $1`, [`r157-${ref}`])).rows);
    return r as { status: string; source_mode: string; quantity: number; confirmed: boolean; confirmed_by_stock_source_id: string | null; confirmed_external_order_ref: string | null; consumed: boolean };
  };
  const shippedMovements = async () => {
    const [m] = await inTenant(admin, world.tenantId, async (tx) => (await tx.query(
      `SELECT count(*)::int AS n, coalesce(sum(delta), 0)::int AS d FROM tenant_data.stock_movement WHERE reason = 'ORDER_SHIPPED'`)).rows);
    return [Number(m.n), Number(m.d)] as [number, number];
  };
  const stockOf = async (sku: string) => {
    const r = (await store.stockPage(world.tenantId, { offset: 0, limit: 10 })).items.find((x) => x.sku === sku)!;
    return [r.onHand, r.reserved, r.available] as [number, number, number];
  };

  // Предпосылка теста: одна отгрузка внутреннего пула уже была, товар 2 держит 20 + 3 штуки и 2 из них зарезервированы
  assert.deepEqual(await shippedMovements(), [1, -1], 'до этого теста списание по отгрузке было ровно одно — внутреннего пула');
  assert.deepEqual(await stockOf('syn-prod-2'), [23, 2, 21]);

  // 1. Заказ на товар с пулом Inbound API: пул источника больше внутреннего (20 против 3), резервация создаётся в нём
  const opened = await store.recordOrderLines(world.tenantId, account, [line('a', 'OPEN', 4, 'SYN-OFFER-2')], now());
  assert.deepEqual([opened.created, opened.consumed, opened.released, opened.unknownOffers, opened.awaitingConfirmation], [1, 0, 0, 0, 0]);
  const created = await reservationOf('a');
  assert.deepEqual([created.status, created.source_mode, created.confirmed, created.confirmed_by_stock_source_id], ['CREATED', 'INBOUND_API', false, null],
    'резервация Inbound API не подтверждается сама собой — подтверждает источник [Р-25]');
  // 23 в пулах, резервации 2 (ttl-a) + 4 (эта) = 6, доступное 23 − 6 = 17
  assert.deepEqual(await stockOf('syn-prod-2'), [23, 6, 17]);

  // 2. Отгрузка по неподтверждённой резервации: пул НЕ списывается, движения нет, и строка не пропадает — она названа числом
  const shippedEarly = await store.recordOrderLines(world.tenantId, account, [line('a', 'SHIPPED', 4, 'SYN-OFFER-2')], now());
  assert.deepEqual([shippedEarly.consumed, shippedEarly.awaitingConfirmation, shippedEarly.released], [0, 1, 0]);
  assert.equal((await reservationOf('a')).status, 'CREATED', 'резервация осталась открытой: списывать пул, пока источник молчит, нельзя');
  assert.deepEqual(await shippedMovements(), [1, -1], 'нового движения ORDER_SHIPPED не появилось');
  assert.deepEqual(await stockOf('syn-prod-2'), [23, 6, 17], 'остаток и доступное не изменились');

  // 3. Та же строка, пришедшая СРАЗУ отгруженной: резервация создаётся и тоже ждёт подтверждения, а не списывается
  const bornShipped = await store.recordOrderLines(world.tenantId, account, [line('b', 'SHIPPED', 1, 'SYN-OFFER-2')], now());
  assert.deepEqual([bornShipped.created, bornShipped.consumed, bornShipped.awaitingConfirmation], [1, 0, 1]);
  assert.equal((await reservationOf('b')).status, 'CREATED');
  assert.deepEqual(await stockOf('syn-prod-2'), [23, 7, 16], 'резервации 2 + 4 + 1 = 7');

  // 4. Положительный контроль: у внутреннего пула источник — мы сами, и такая же строка списывает пул тем же вызовом.
  // Товар 1: 9 штук, отгружена 1 → 8; движение вставляет триггер базы, а не код
  const internal = await store.recordOrderLines(world.tenantId, account, [line('c', 'SHIPPED', 1, 'SYN-OFFER-1')], now());
  assert.deepEqual([internal.created, internal.consumed, internal.awaitingConfirmation], [1, 1, 0], 'внутренний пул подтверждения источника не ждёт');
  assert.deepEqual(await shippedMovements(), [2, -2]);
  assert.deepEqual(await stockOf('syn-prod-1'), [8, 0, 8]);

  // 5. Источник подтверждает ОБА своих заказа: статус, момент, источник и номер заказа — в строке базы
  const confirmed = await store.confirmInboundOrders(world.tenantId, sourceId, ['r157-a', 'r157-b']);
  assert.deepEqual(confirmed, { confirmed: 2, alreadyConfirmed: [], releasedOrders: [], unknownOrders: [] });
  /**
   * Отгрузка по этим заказам канал УЖЕ сообщил (шаги 2 и 3), поэтому подтверждение не только подтверждает, но и
   * ЗАКРЫВАЕТ резервацию тем же вызовом [Р-157, находка 7 ревью шага 36]. Иначе она висела бы вечно: освобождение по
   * сроку берёт только `CREATED`, а строку заказа канал повторно отдаст лишь в ближайшее окно работы `order-lines`.
   */
  for (const [ref, quantity] of [['a', 4], ['b', 1]] as const) {
    const r = await reservationOf(ref);
    assert.deepEqual([r.status, r.confirmed, r.confirmed_by_stock_source_id, r.confirmed_external_order_ref, r.quantity],
      ['CONSUMED', true, sourceId, `r157-${ref}`, quantity], `заказ r157-${ref}: подтверждение несёт свой источник, свой номер заказа и закрывает отгруженную резервацию`);
  }
  // Доступное вернулось сразу: 23 штуки, из них держит только чужая резервация TTL на 2 → 21 доступно
  assert.deepEqual(await stockOf('syn-prod-2'), [23, 2, 21], 'закрытая резервация освободила доступное, не дожидаясь второй строки заказа');
  // Подтверждается ТОЛЬКО названный заказ: резервация `ttl-a` того же источника и того же товара осталась неподтверждённой
  const [others] = await inTenant(admin, world.tenantId, async (tx) => (await tx.query(
    `SELECT count(*)::int AS n FROM channel_data.reservation WHERE status = 'CREATED'`)).rows);
  assert.equal(Number(others.n), 1, 'чужой заказ подтверждение не задело — открытой осталась резервация теста TTL');

  // 6. Повтор безвреден и различает два случая: уже подтверждённый заказ и заказ, которого у источника нет вовсе
  assert.deepEqual(await store.confirmInboundOrders(world.tenantId, sourceId, ['r157-a', 'r157-nie-gesehen']),
    { confirmed: 0, alreadyConfirmed: ['r157-a'], releasedOrders: [], unknownOrders: ['r157-nie-gesehen'] });
  // Заказ ЧУЖОГО источника для этого источника неизвестен: внутренний пул подтверждает себя сам, и его заказа здесь нет
  const foreign = (await store.stockSources(world.tenantId)).find((s) => s.mode === 'INTERNAL_POOL')!;
  assert.deepEqual(await store.confirmInboundOrders(world.tenantId, sourceId, ['r157-c']), { confirmed: 0, alreadyConfirmed: [], releasedOrders: [], unknownOrders: ['r157-c'] },
    'заказ внутреннего пула источнику Inbound API не принадлежит');
  assert.deepEqual(await store.confirmInboundOrders(world.tenantId, foreign.stockSourceId, ['r157-a']), { confirmed: 0, alreadyConfirmed: [], releasedOrders: [], unknownOrders: ['r157-a'] },
    'и наоборот: внутренний источник не подтверждает заказ Inbound API');

  // 7. Повторная строка «отгружено» по уже закрытой резервации ничего не меняет: канал повторяет строки заказа, и это безвредно
  const shippedAfter = await store.recordOrderLines(world.tenantId, account, [line('a', 'SHIPPED', 4, 'SYN-OFFER-2'), line('b', 'SHIPPED', 1, 'SYN-OFFER-2')], now());
  assert.deepEqual([shippedAfter.consumed, shippedAfter.awaitingConfirmation], [0, 0], 'резервация уже закрыта подтверждением — повтор строки её не трогает');
  assert.deepEqual([(await reservationOf('a')).status, (await reservationOf('a')).consumed], ['CONSUMED', true]);
  /**
   * Пул Inbound API движением НЕ списывается, и это не пробел проверки: остаток пула источника — не наш [Р-6], журнал
   * движений заведён только для внутреннего пула (0007: `stock_movement.source_mode` может быть лишь `INTERNAL_POOL`),
   * а новое количество присылает сам источник. Поэтому после отгрузки 5 штук по подтверждённым резервациям физический
   * остаток товара 2 остаётся прежним (23), а освобождается только зарезервированное: 23 − 2 = 21 доступно.
   */
  assert.deepEqual(await shippedMovements(), [2, -2], 'движений по-прежнему два — оба у внутреннего пула');
  assert.deepEqual(await stockOf('syn-prod-2'), [23, 2, 21]);
});
