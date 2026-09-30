import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createHash } from 'node:crypto';
import type { MemorySeedScope } from '@repracer/pricing-pipeline';
import { DEFAULT_RETRY_POLICY } from '@repracer/write-dispatcher';
import { createPool, PgPricingStore, PgStockStore, PgWriteQueueStore, inTenant, seedPricingWorld, type PgPool, type SeededPricingWorld } from '../src/index.ts';
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
  /**
   * Шаг 59 [Р-200, OQ-223]: до шага 59 доступное здесь сразу возвращалось к 21 — на 5 штук, которые уже уехали, пока источник не пришлёт
   * новый остаток. Теперь отгруженное по Inbound API вычитается, пока источник не пришлёт остаток с asOf позже подтверждения: 2 (ttl-a) + 5
   */
  assert.deepEqual(await stockOf('syn-prod-2'), [23, 7, 16], 'shipped pieces of the Inbound API source stay subtracted until the source sends a newer figure');
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
  assert.deepEqual(await stockOf('syn-prod-2'), [23, 7, 16], 'Р-200: still held — the source has not sent a newer figure');
  /**
   * Шаг 59 [Р-200]: источник присылает остаток. Отметка ДО подтверждения заказов (его система ещё не учла отгрузку) вычитание не снимает;
   * отметка ПОСЛЕ — снимает: его 15 уже учитывают уехавшие 5 штук (20 − 5), и вычитать их второй раз нельзя
   */
  const [conf] = await inTenant(admin, world.tenantId, async (tx) => (await tx.query(
    `SELECT max(confirmed_at) AS at FROM channel_data.reservation WHERE channel_order_ref IN ('r157-a', 'r157-b')`)).rows);
  const confirmedAt = Date.parse(String(conf.at instanceof Date ? conf.at.toISOString() : conf.at));
  const [pool] = await inTenant(admin, world.tenantId, async (tx) => (await tx.query(
    `SELECT source_as_of FROM tenant_data.stock_pool WHERE source_mode = 'INBOUND_API' ORDER BY source_as_of DESC LIMIT 1`)).rows);
  const before = new Date(Math.max(Date.parse(String(pool.source_as_of instanceof Date ? pool.source_as_of.toISOString() : pool.source_as_of)) + 1000, confirmedAt - 1000)).toISOString();
  if (Date.parse(before) < confirmedAt) {
    await store.inboundStock(world.tenantId, sourceId, [{ sku: '3502', quantity: 20, asOf: before as never }]);
    assert.deepEqual(await stockOf('syn-prod-2'), [23, 7, 16], 'a figure older than the confirmation does not end the subtraction');
  }
  await store.inboundStock(world.tenantId, sourceId, [{ sku: '3502', quantity: 15, asOf: new Date(confirmedAt + 1000).toISOString() as never }]);
  assert.deepEqual(await stockOf('syn-prod-2'), [18, 2, 16], 'the newer figure of the source already counts the shipped pieces: they are no longer subtracted');
});

/**
 * Ревью шага 51, находки 2–3: запись количества, которую канал отверг (у eBay с шага 51 — любой ответ 4xx на значение, без повтора), значением
 * канала не стала. Пересчёт не считает её «уже созданной» и создаёт новую версию того же количества — иначе количество у канала застревало бы
 * до следующего изменения остатка (перепродажа при уменьшении)
 */
test('step 51 review: a quantity version refused by the channel is not "already created" — the next recalculation creates it again', async () => {
  const queue = new PgWriteQueueStore(db.pool('svc_app', 1));
  const [row] = await inTenant(admin, world.tenantId, async (tx) => (await tx.query(
    `SELECT w.write_scope_id, w.quantity FROM tenant_data.channel_write w WHERE w.field = 'QUANTITY' AND w.status = 'PENDING' ORDER BY w.quantity DESC LIMIT 1`)).rows);
  const claim = await queue.claimNext(world.tenantId, row.write_scope_id, now(), DEFAULT_RETRY_POLICY);
  assert.equal(claim.kind, 'DISPATCH');
  const write = (claim as Extract<typeof claim, { kind: 'DISPATCH' }>).write;
  const refused = await queue.recordOutcome(world.tenantId, write, { channelWriteId: write.channelWriteId, status: 'REJECTED',
    error: { class: 'PERMANENT', code: 'VALIDATION', scope: 'ITEM', message: 'synthetic refusal', raiseAlert: false, httpStatus: 400 } }, now(), DEFAULT_RETRY_POLICY);
  assert.equal(refused.reason?.code, 'WRITE_NOT_ACCEPTED_BY_CHANNEL');
  const again = await store.recalculate(world.tenantId, null, now());
  assert.deepEqual(again.writes.map((w) => [w.writeScopeId, w.quantity]), [[row.write_scope_id, Number(row.quantity)]], 'the refused value is created again, the others are unchanged');
  assert.equal((await store.recalculate(world.tenantId, null, now())).writes.length, 0, 'a pending new version counts as created: no duplicate');
});

/**
 * Шаг 52 (п. 8): запись количества, упёршаяся в бюджет правок, в тот же день витрины не пересоздаётся (бюджет исчерпан), а после смены
 * суток — пересоздаётся, и товар попадает в пересчёт работой чтения заказов без новых заказов. День «позавчера» ставит суперпользователь:
 * база даёт записи только текущий день витрины (0141)
 */
test('step 52: a quantity write refused by the edit budget is not recreated the same day, and is recreated once the storefront day rolled over', async () => {
  const queue = new PgWriteQueueStore(db.pool('svc_app', 1));
  const [row] = await inTenant(admin, world.tenantId, async (tx) => (await tx.query(
    `SELECT w.write_scope_id, w.quantity, s.product_id FROM tenant_data.channel_write w JOIN tenant_data.write_scope s USING (tenant_id, write_scope_id)
      WHERE w.field = 'QUANTITY' AND w.status = 'PENDING' ORDER BY w.quantity DESC LIMIT 1`)).rows);
  const claim = await queue.claimNext(world.tenantId, row.write_scope_id, now(), DEFAULT_RETRY_POLICY);
  const write = (claim as Extract<typeof claim, { kind: 'DISPATCH' }>).write;
  const ended = await queue.recordOutcome(world.tenantId, write, { channelWriteId: write.channelWriteId, status: 'REJECTED',
    error: { class: 'TRANSIENT', code: 'EDIT_BUDGET_EXHAUSTED', scope: 'ITEM', message: 'synthetic budget', raiseAlert: false } }, now(), DEFAULT_RETRY_POLICY);
  assert.equal(ended.status, 'BUDGET_EXHAUSTED');
  const account = world.ids.dbId(KAUFLAND);
  /**
   * Ревью шага 52, находка 4: день бюджета ставит суперпользователь по поясу ВИТРИНЫ (не UTC) — сперва сегодняшний: повтора нет, потому
   * что день не прошёл, а не потому, что дня нет; затем вчерашний; отдельно — сегодняшний день, но время обновления, названное каналом, прошло
   */
  const setDay = (dayExpr: string, resetsAt: string | null) => db.superuser(`SET session_replication_role = replica;
    UPDATE tenant_data.channel_write_history SET budget_scope_key = 'syn-budget-key',
           budget_day = ${dayExpr},
           end_params = ${resetsAt ? `jsonb_set(coalesce(end_params, '{}'::jsonb), '{resetsAt}', to_jsonb('${resetsAt}'::text))` : `coalesce(end_params, '{}'::jsonb) - 'resetsAt'`}
     WHERE channel_write_id = '${write.channelWriteId}';
    SET session_replication_role = origin`);
  const today = `(now() AT TIME ZONE (SELECT time_zone FROM platform.marketplace WHERE channel = 'KAUFLAND' AND marketplace = 'de'))::date`;
  await setDay(today, null);
  assert.deepEqual(await store.budgetRolledOverProducts(world.tenantId, account), [], 'the budget day of the storefront has not passed');
  assert.equal((await store.recalculate(world.tenantId, null, now())).writes.length, 0, 'same day: no new write into a used-up budget');
  await setDay(today, new Date(Date.now() + 3_600_000).toISOString());
  assert.deepEqual(await store.budgetRolledOverProducts(world.tenantId, account), [], 'the channel renews the budget later');
  await setDay(today, new Date(Date.now() - 60_000).toISOString());
  assert.deepEqual(await store.budgetRolledOverProducts(world.tenantId, account), [row.product_id], 'the channel renewal time has passed (rolling window)');
  // Шаг 55 (ревью шага 53, находка 6): сутки витрины сменились, но окно канала, названное им самим, ещё не прошло — бюджет не обновился
  await setDay(`${today} - 1`, new Date(Date.now() + 3_600_000).toISOString());
  assert.deepEqual(await store.budgetRolledOverProducts(world.tenantId, account), [], 'the storefront day rolled over, the channel window has not');
  await setDay(`${today} - 1`, null);
  assert.deepEqual(await store.budgetRolledOverProducts(world.tenantId, account), [row.product_id], 'the storefront day rolled over');
  const again = await store.recalculate(world.tenantId, [row.product_id], now());
  assert.deepEqual(again.writes.map((w) => [w.writeScopeId, w.quantity]), [[row.write_scope_id, Number(row.quantity)]]);
});

/**
 * Шаг 52 (п. 7): количество, которым управляет канал (FBA/FBK), — наблюдение предложения CHANNEL из обнаружения; экран остатков показывает
 * его только для чтения, в доступное наше количество оно не входит. У предложения FBM такого количества нет — база его пропускает
 */
test('step 52: the channel managed quantity of a channel fulfilled offer reaches the stock screen read-only; a merchant offer gets none', async () => {
  const pricing = new PgPricingStore(db.pool('svc_app', 1));
  const account = world.ids.dbId(KAUFLAND);
  await pricing.recordDiscoveredOffers(world.tenantId, account, [
    { marketplace: 'de', externalSku: 'SYN-FBK-52', externalUnitId: '3552', externalOfferId: null, channelProductRef: null, gtin: null, condition: 'new', fulfillment: 'CHANNEL' },
  ]);
  const recorded = await pricing.recordChannelQuantities(world.tenantId, account, [
    { marketplace: 'de', externalSku: 'SYN-FBK-52', quantity: 12, observedAt: now() },
    // Предложение FBM (из посева мира) — количества «управляет канал» у него нет, база пропускает
    { marketplace: 'de', externalSku: 'syn-prod-1', quantity: 99, observedAt: now() },
  ]);
  assert.equal(recorded, 1);
  const page = await store.stockPage(world.tenantId, { offset: 0, limit: 50 });
  const fbk = page.items.find((r) => r.sku === 'SYN-FBK-52')!;
  assert.deepEqual(fbk.channelManaged?.map((c) => [c.channel, c.marketplace, c.quantity]), [['KAUFLAND', 'de', 12]]);
  assert.deepEqual([fbk.onHand, fbk.available, fbk.channels.length], [0, 0, 0], 'not our stock, no quantity write scope');
  assert.equal(page.items.filter((r) => (r.channelManaged ?? []).length > 0).length, 1, 'only the channel fulfilled offer');
});

/**
 * Шаг 53 (ревью шага 52, находка 11): после отвергнутой версии сравнение идёт с тем, что канал ДЕРЖИТ (последняя применённая версия).
 * Остаток вернулся к применённому значению — запись не создаётся; остался другим — создаётся
 */
test('step 53: after a refused version the value the channel already holds is not sent again', async () => {
  const queue = new PgWriteQueueStore(db.pool('svc_app', 1));
  const account = world.ids.dbId(KAUFLAND);
  const sourceId = (await store.stockSources(world.tenantId))[0]!.stockSourceId;
  const scopeOf = async () => (await inTenant(admin, world.tenantId, async (tx) => (await tx.query(
    `SELECT s.write_scope_id FROM tenant_data.write_scope s JOIN tenant_data.product p USING (tenant_id, product_id)
      WHERE s.field = 'QUANTITY' AND p.sku = 'syn-prod-3'`)).rows))[0]!.write_scope_id as string;
  const scope = await scopeOf();
  const settle = async (outcome: 'APPLIED' | 'REFUSED') => {
    for (let i = 0; i < 4; i++) {
      const claim = await queue.claimNext(world.tenantId, scope, now(), DEFAULT_RETRY_POLICY);
      if (claim.kind !== 'DISPATCH') return;
      const w = (claim as Extract<typeof claim, { kind: 'DISPATCH' }>).write;
      await queue.recordOutcome(world.tenantId, w, outcome === 'APPLIED'
        ? { channelWriteId: w.channelWriteId, status: 'ACCEPTED', appliedImmediately: true }
        : { channelWriteId: w.channelWriteId, status: 'REJECTED', error: { class: 'PERMANENT', code: 'VALIDATION', scope: 'ITEM', message: 'synthetic refusal', raiseAlert: false, httpStatus: 400 } },
      now(), DEFAULT_RETRY_POLICY);
    }
  };
  const writesFor = (r: { writes: Array<{ writeScopeId: string; quantity: number }> }) => r.writes.filter((w) => w.writeScopeId === scope).map((w) => w.quantity);
  // Применённое значение канала: остаток 7, буфер 2 → 5
  // Правило канала — явно: прежние тесты файла меняли потолок и порог выставления
  await store.enableStockSync(world.tenantId, account, { bufferUnits: 2, maxQuantity: null, minQuantityToList: 0, acknowledgeSideEffects: false }, owner());
  await store.importStock(world.tenantId, sourceId, [{ sku: '3503', quantity: 7 }], owner());
  await store.recalculate(world.tenantId, null, now());
  await settle('APPLIED');
  // Новая версия 6 (остаток 8) отвергнута каналом
  await store.importStock(world.tenantId, sourceId, [{ sku: '3503', quantity: 8 }], owner());
  assert.deepEqual(writesFor(await store.recalculate(world.tenantId, null, now())), [6]);
  await settle('REFUSED');
  // Остаток вернулся к 7: канал держит 5 — повторной записи нет
  await store.importStock(world.tenantId, sourceId, [{ sku: '3503', quantity: 7 }], owner());
  assert.deepEqual(writesFor(await store.recalculate(world.tenantId, null, now())), [], 'the channel already holds 5');
  // Остаток 9: канал держит 5, нужно 7 — запись есть
  await store.importStock(world.tenantId, sourceId, [{ sku: '3503', quantity: 9 }], owner());
  assert.deepEqual(writesFor(await store.recalculate(world.tenantId, null, now())), [7]);
});

/**
 * Ревью шага 53, находка 4: версия с НЕИЗВЕСТНЫМ исходом — асинхронный канал принял её (ACCEPTED), а сверка не увидела применения за
 * срок подтверждения (NOT_APPLIED), — могла примениться позже. Значение канала тогда неизвестно, и уменьшение остатка к прежнему
 * применённому значению обязано уйти в канал [инвариант 5], а не считаться «уже стоящим там»
 */
test('step 54: after a version with an unknown outcome the old applied value is sent again — a decrease is never skipped', async () => {
  const queue = new PgWriteQueueStore(db.pool('svc_app', 1));
  const account = world.ids.dbId(KAUFLAND);
  const sourceId = (await store.stockSources(world.tenantId))[0]!.stockSourceId;
  const scope = (await inTenant(admin, world.tenantId, async (tx) => (await tx.query(
    `SELECT s.write_scope_id FROM tenant_data.write_scope s JOIN tenant_data.product p USING (tenant_id, product_id)
      WHERE s.field = 'QUANTITY' AND p.sku = 'syn-prod-3'`)).rows) as Array<{ write_scope_id: string }>)[0]!.write_scope_id;
  const writesFor = (r: { writes: Array<{ writeScopeId: string; quantity: number }> }) => r.writes.filter((w) => w.writeScopeId === scope).map((w) => w.quantity);
  const claim = async () => {
    const c = await queue.claimNext(world.tenantId, scope, now(), DEFAULT_RETRY_POLICY);
    assert.equal(c.kind, 'DISPATCH', JSON.stringify(c));
    return (c as Extract<typeof c, { kind: 'DISPATCH' }>).write;
  };
  await store.enableStockSync(world.tenantId, account, { bufferUnits: 2, maxQuantity: null, minQuantityToList: 0, acknowledgeSideEffects: false }, owner());
  await store.importStock(world.tenantId, sourceId, [{ sku: '3503', quantity: 11 }], owner());
  await store.recalculate(world.tenantId, null, now());
  const applied = await claim();
  await queue.recordOutcome(world.tenantId, applied, { channelWriteId: applied.channelWriteId, status: 'ACCEPTED', appliedImmediately: true }, now(), DEFAULT_RETRY_POLICY);
  // Канал держит 9. Новая версия 12 принята асинхронно, и сверка за срок подтверждения применения не увидела
  await store.importStock(world.tenantId, sourceId, [{ sku: '3503', quantity: 14 }], owner());
  assert.deepEqual(writesFor(await store.recalculate(world.tenantId, null, now())), [12]);
  const unknown = await claim();
  await queue.recordOutcome(world.tenantId, unknown, { channelWriteId: unknown.channelWriteId, status: 'ACCEPTED', appliedImmediately: false }, now(), DEFAULT_RETRY_POLICY);
  const late = new Date(Date.now() + DEFAULT_RETRY_POLICY.confirmationTimeoutMs + 60_000).toISOString();
  const r = await queue.recordReconciliation(world.tenantId, unknown, { kind: 'NOT_APPLIED', observedMinor: null }, late, DEFAULT_RETRY_POLICY);
  assert.equal(r.status, 'NOT_APPLIED', JSON.stringify(r));
  // Остаток вернулся к 11: применённое значение — 9, но версия 12 могла примениться позже — 9 уходит снова
  await store.importStock(world.tenantId, sourceId, [{ sku: '3503', quantity: 11 }], owner());
  assert.deepEqual(writesFor(await store.recalculate(world.tenantId, null, now())), [9], 'the channel may hold 12 — the decrease to 9 is written');
});

/**
 * Ревью шага 53, находка 5: версия, удержанная тенью, значение канала, пока аккаунт в тени, — и перестаёт им быть в бою. Остаток упал
 * в тени до 0; после перевода в бой 0 уходит в канал работой чтения заказов, не дожидаясь нового изменения остатка
 */
test('step 54: a quantity held by shadow is sent after the account goes live — the channel never saw it', async () => {
  const { PgShadowStore } = await import('../src/index.ts');
  const queue = new PgWriteQueueStore(db.pool('svc_app', 1));
  const shadow = new PgShadowStore({ adminPool: admin });
  const account = world.ids.dbId(KAUFLAND);
  const sourceId = (await store.stockSources(world.tenantId))[0]!.stockSourceId;
  const scopeRow = (await inTenant(admin, world.tenantId, async (tx) => (await tx.query(
    `SELECT s.write_scope_id, s.product_id FROM tenant_data.write_scope s JOIN tenant_data.product p USING (tenant_id, product_id)
      WHERE s.field = 'QUANTITY' AND p.sku = 'syn-prod-3'`)).rows) as Array<{ write_scope_id: string; product_id: string }>)[0]!;
  const scope = scopeRow.write_scope_id;
  const productId = scopeRow.product_id;
  const writesFor = (r: { writes: Array<{ writeScopeId: string; quantity: number }> }) => r.writes.filter((w) => w.writeScopeId === scope).map((w) => w.quantity);
  const typed = (await inTenant(admin, world.tenantId, async (tx) => (await tx.query(
    `SELECT external_account_id FROM tenant_data.channel_account WHERE channel_account_id = $1`, [account])).rows) as Array<{ external_account_id: string }>)[0]!.external_account_id;
  await store.enableStockSync(world.tenantId, account, { bufferUnits: 2, maxQuantity: null, minQuantityToList: 0, acknowledgeSideEffects: false }, owner());
  await store.importStock(world.tenantId, sourceId, [{ sku: '3503', quantity: 10 }], owner());
  await store.recalculate(world.tenantId, null, now());
  const c = await queue.claimNext(world.tenantId, scope, now(), DEFAULT_RETRY_POLICY);
  assert.equal(c.kind, 'DISPATCH', JSON.stringify(c));
  const w = (c as Extract<typeof c, { kind: 'DISPATCH' }>).write;
  await queue.recordOutcome(world.tenantId, w, { channelWriteId: w.channelWriteId, status: 'ACCEPTED', appliedImmediately: true }, now(), DEFAULT_RETRY_POLICY);
  // В канале 8. Аккаунт уходит в тень, остаток падает до 2 → 0 удержан тенью
  const off = await shadow.switchWriteMode(world.tenantId, { channelAccountId: account, toMode: 'SHADOW', membershipId: world.ownerMembershipId, userId: world.userId, mfa: false });
  assert.equal(off.status, 'SWITCHED', JSON.stringify(off));
  try {
    await store.importStock(world.tenantId, sourceId, [{ sku: '3503', quantity: 2 }], owner());
    assert.deepEqual(writesFor(await store.recalculate(world.tenantId, null, now())), [0], 'held by shadow');
    assert.deepEqual(writesFor(await store.recalculate(world.tenantId, null, now())), [], 'while in shadow the held 0 is not held again');
    assert.deepEqual(await store.budgetRolledOverProducts(world.tenantId, account), [], 'nothing to resend while in shadow');
  } finally {
    const on = await shadow.switchWriteMode(world.tenantId, { channelAccountId: account, toMode: 'LIVE', membershipId: world.ownerMembershipId, userId: world.userId, mfa: true, typedConfirmation: typed });
    assert.equal(on.status, 'SWITCHED', JSON.stringify(on));
  }
  // В бою: работа чтения заказов находит товар и без новых заказов, пересчёт создаёт запись 0
  assert.ok((await store.budgetRolledOverProducts(world.tenantId, account)).includes(productId), 'the order-lines job picks the product up (with the other products held in shadow)');
  assert.deepEqual(writesFor(await store.recalculate(world.tenantId, [productId], now())), [0], 'the channel still holds 8 — 0 is written');
});

/**
 * Шаг 58 (ревью шага 57, находка 1): пересчёты тенанта идут по очереди. Работа заказов, Inbound API, импорт и включение синхронизации
 * считали следующую версию из одной «последней»: проигравший получал «version … is not greater», а повтор его запроса видел строку уже
 * учтённой и не пересчитывал — завышенное количество оставалось в канале. Шесть пересчётов разом: ни одного отказа, изменившаяся единица
 * получает ровно одну новую версию
 */
test('step 58: concurrent recalculations of a tenant queue up — none fails on the version race, a changed unit gets one new version', async () => {
  const sourceId = (await store.stockSources(world.tenantId))[0]!.stockSourceId;
  await store.importStock(world.tenantId, sourceId, [{ sku: '3502', quantity: 7 }], owner());
  const results = await Promise.allSettled(Array.from({ length: 6 }, () => store.recalculate(world.tenantId, null, now())));
  const refused = results.filter((r) => r.status === 'rejected').map((r) => String((r as PromiseRejectedResult).reason?.message ?? r));
  assert.deepEqual(refused, [], 'no recalculation fails on the version race');
  const writes = results.flatMap((r) => (r as PromiseFulfilledResult<{ writes: Array<{ writeScopeId: string }> }>).value.writes);
  assert.ok(writes.length > 0, 'the changed unit got its new version');
  assert.equal(new Set(writes.map((w) => w.writeScopeId)).size, writes.length, 'no unit got a version per racer');
  assert.equal((await store.recalculate(world.tenantId, null, now())).writes.length, 0, 'the queue left nothing to recalculate');
  /**
   * Очередь — детерминированно: на трёх единицах шесть пересчётов редко пересекаются по времени, и тест выше зеленел бы и без блокировки.
   * Пересчёт, начатый другим процессом (его транзакция держит блокировку пересчёта тенанта), заставляет этот ждать своей фиксации
   */
  const url = new URL(process.env.REPRACER_PG_ADMIN_URL!); url.pathname = `/${db.name}`;
  const other = createPool(url.toString(), { max: 1, applicationName: 'repracer-stock-recalc-other' });
  const client = await other.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('repracer.stock_recalculate:' || $1::text, 0))", [world.tenantId]);
    let settled = false;
    const waiting = store.recalculate(world.tenantId, null, now()).then((r) => { settled = true; return r; });
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(settled, false, 'a recalculation waits while another one of the tenant is open');
    await client.query('COMMIT');
    assert.equal((await waiting).writes.length, 0);
    // Шаг 59 (ревью шага 58, находка 3): у Inbound API ожидание ограничено — отказ `55P03`, консоль отвечает 503 с Retry-After
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('repracer.stock_recalculate:' || $1::text, 0))", [world.tenantId]);
    await assert.rejects(store.recalculate(world.tenantId, null, now(), { lockTimeoutMs: 200 }), (e: { code?: string }) => e.code === '55P03',
      'a bounded wait gives up with lock_not_available instead of holding a pool connection');
    await client.query('ROLLBACK');
  } finally {
    client.release();
    await other.end();
  }
});

/**
 * Шаг 59 [Р-199]: «возвращено» канала — строка возврата. У внутреннего пула её ставит на полку человек движением RETURN с автором (в
 * аудите), у источника Inbound API — только сведения. Возврат, пришедший раньше отгрузки, сначала закрывает отгрузку
 */
test('step 59 (Р-199): a returned order line becomes a return the person puts back to stock; the Inbound API source only sees it', async () => {
  const account = world.ids.dbId(KAUFLAND);
  const line = (ref: string, status: 'OPEN' | 'SHIPPED' | 'RETURNED', offer: string, quantity = 1) => ({
    externalOrderRef: `r199-${ref}`, externalOrderLineRef: `r199-line-${ref}`, identity: { marketplace: 'de', externalOfferId: offer }, quantity, orderedAt: now(), status,
  });
  const stockOf = async (sku: string) => {
    const r = (await store.stockPage(world.tenantId, { offset: 0, limit: 10 })).items.find((x) => x.sku === sku)!;
    return [r.onHand, r.reserved, r.available] as [number, number, number];
  };
  // Внутренний пул: заказ отгружен, затем возвращён — пул не растёт сам, возврат ждёт решения
  const [before] = [await stockOf('syn-prod-1')];
  await store.recordOrderLines(world.tenantId, account, [line('a', 'SHIPPED', 'SYN-OFFER-1', 2)], now());
  const returned = await store.recordOrderLines(world.tenantId, account, [line('a', 'RETURNED', 'SYN-OFFER-1', 2)], now());
  assert.equal(returned.returns, 1);
  assert.deepEqual(await stockOf('syn-prod-1'), [before[0] - 2, before[1], before[2] - 2], 'the channel\'s «returned» does not put anything back to stock by itself');
  assert.equal((await store.recordOrderLines(world.tenantId, account, [line('a', 'RETURNED', 'SYN-OFFER-1', 2)], now())).returns, 0, 'a repeated line does not double the return');
  // Возврат раньше отгрузки: опрос не застал «отгружено» — отгрузка закрывается тем же вызовом, возврат заводится
  await store.recordOrderLines(world.tenantId, account, [line('b', 'OPEN', 'SYN-OFFER-1')], now());
  const early = await store.recordOrderLines(world.tenantId, account, [line('b', 'RETURNED', 'SYN-OFFER-1')], now());
  assert.deepEqual([early.consumed, early.returns], [1, 1], 'a return seen before the shipment closes the shipment first — the reservation does not hang');
  // Источник Inbound API: строка только для сведения
  await store.recordOrderLines(world.tenantId, account, [line('c', 'OPEN', 'SYN-OFFER-2')], now());
  const sourceId = (await store.stockSources(world.tenantId)).find((x) => x.mode === 'INBOUND_API')!.stockSourceId;
  await store.confirmInboundOrders(world.tenantId, sourceId, ['r199-c']);
  await store.recordOrderLines(world.tenantId, account, [line('c', 'RETURNED', 'SYN-OFFER-2')], now());
  const list = await store.listReturns(world.tenantId, 50);
  const byLine = (ref: string) => list.find((r) => r.channelOrderLineRef === `r199-line-${ref}`)!;
  assert.deepEqual([byLine('a').status, byLine('a').quantity, byLine('b').status, byLine('c').status], ['PENDING', 2, 'PENDING', 'INFO_ONLY']);
  assert.equal(list[0]!.status, 'PENDING', 'pending returns come first');

  // Зритель не решает — права у базы
  const [viewer] = await inTenant(admin, world.tenantId, async (tx) => (await tx.query(`SELECT membership_id, user_id FROM tenant_data.membership WHERE role = 'VIEWER'`)).rows);
  assert.deepEqual(await store.decideReturn(world.tenantId, byLine('a').orderReturnId, { accept: true, note: null }, { membershipId: viewer.membership_id, userId: viewer.user_id, mfa: true }),
    { status: 'FORBIDDEN' });
  // Владелец принимает на склад: пул +2 движением RETURN с автором, событие в аудите
  const onHand = (await stockOf('syn-prod-1'))[0];
  const accepted = await store.decideReturn(world.tenantId, byLine('a').orderReturnId, { accept: true, note: 'synthetic: checked, sellable' }, owner());
  assert.equal(accepted.status, 'DECIDED');
  assert.equal((await stockOf('syn-prod-1'))[0], onHand + 2, 'the accepted return reaches the pool');
  const [mv] = await inTenant(admin, world.tenantId, async (tx) => (await tx.query(
    `SELECT m.delta, m.created_by_membership_id FROM tenant_data.stock_movement m JOIN channel_data.order_return o ON o.stock_movement_id = m.stock_movement_id
      WHERE o.order_return_id = $1`, [byLine('a').orderReturnId])).rows);
  assert.deepEqual([Number(mv.delta), mv.created_by_membership_id], [2, world.ownerMembershipId], 'a RETURN movement with its author');
  const [audited] = await inTenant(admin, world.tenantId, async (tx) => (await tx.query(
    `SELECT count(*)::int AS n FROM audit.audit_event WHERE entity_type = 'channel_data.order_return' AND entity_id = $1`, [byLine('a').orderReturnId])).rows);
  assert.ok(Number(audited.n) >= 1, 'the decision is in the audit log');
  assert.deepEqual(await store.decideReturn(world.tenantId, byLine('a').orderReturnId, { accept: false, note: null }, owner()), { status: 'NOT_PENDING' });
  // «Не принимать» — без движения
  const pool = (await stockOf('syn-prod-1'))[0];
  assert.equal((await store.decideReturn(world.tenantId, byLine('b').orderReturnId, { accept: false, note: 'synthetic: damaged' }, owner())).status, 'DECIDED');
  assert.equal((await stockOf('syn-prod-1'))[0], pool, 'a dismissed return does not touch the pool');
  // Сведения по чужому пулу решению не подлежат
  assert.deepEqual(await store.decideReturn(world.tenantId, byLine('c').orderReturnId, { accept: true, note: null }, owner()), { status: 'NOT_PENDING' });
});

/** Шаг 59 [Р-200]: источник Inbound API, молчащий сутки после подтверждения отгруженного заказа, — один раз на резервацию */
test('step 59 (Р-200): an Inbound API source silent for a day after a confirmed shipped order is reported once per reservation', async () => {
  const account = world.ids.dbId(KAUFLAND);
  const sourceId = (await store.stockSources(world.tenantId)).find((x) => x.mode === 'INBOUND_API')!.stockSourceId;
  await store.recordOrderLines(world.tenantId, account, [{ externalOrderRef: 'r200-a', externalOrderLineRef: 'r200-line-a', identity: { marketplace: 'de', externalOfferId: 'SYN-OFFER-2' }, quantity: 1, orderedAt: now(), status: 'SHIPPED' }], now());
  await store.confirmInboundOrders(world.tenantId, sourceId, ['r200-a']);
  assert.deepEqual(await store.markSilentInboundSources(world.tenantId), [], 'a fresh confirmation is not silence yet');
  // Сутки назад — часы базы не двигаются: время подтверждения сдвигает суперпользователь (синтетика)
  const url = new URL(process.env.REPRACER_PG_ADMIN_URL!); url.pathname = `/${db.name}`;
  const su = createPool(url.toString(), { max: 1, applicationName: 'repracer-r200-clock' });
  try {
    await su.query('SET session_replication_role = replica');
    await su.query(`UPDATE channel_data.reservation SET confirmed_at = confirmed_at - interval '25 hours', consumed_at = consumed_at - interval '25 hours', closed_at = closed_at - interval '25 hours',
                           created_at = created_at - interval '25 hours', expires_at = expires_at - interval '25 hours' WHERE channel_order_ref = 'r200-a'`);
    // Источник молчит: его последняя присылка старше подтверждения заказа
    await su.query(`UPDATE tenant_data.stock_pool SET source_as_of = now() - interval '30 hours' WHERE source_mode = 'INBOUND_API'`);
  } finally { await su.end(); }
  const silent = await store.markSilentInboundSources(world.tenantId);
  assert.deepEqual(silent.map((x) => [x.stockSourceId, x.reservations]), [[sourceId, 1]]);
  assert.deepEqual(await store.markSilentInboundSources(world.tenantId), [], 'once per reservation, not every five minutes');
});
