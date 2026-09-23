import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createPool, type PgPool } from '@repracer/pricing-store-pg';
import { createIsolatedDatabase, type IsolatedDatabase } from '../../../packages/pricing-store-pg/test/isolated-db.ts';
import { VirtualClock } from './harness/world.ts';
import { kauflandLiveWorld, type KauflandLiveWorld, type LiveProduct } from './live/kaufland-world.ts';

/**
 * Р-155 (шаг 36, OQ-219): записи в Kaufland уходят ПАКЕТАМИ — до 150 unit одной витрины [K-01]. Прогон меряет то, ради
 * чего решение принято: включение синхронизации на каталоге целевого клиента (10 000 предложений) раньше давало 10 000
 * запросов к каналу при лимите 111 запросов в секунду на продавца, и эти запросы конкурировали с опросом конкурентов за
 * тот же бюджет.
 *
 * Меряется ОДИН И ТОТ ЖЕ каталог двумя путями: сперва по одной записи (путь решения отправляет свою запись сам), потом
 * пакетами (обход диспетчера). Между замерами остаток меняется, и каждая единица получает новую версию записи.
 *
 * Порядок внутри единицы записи [Р-24, Р-64] проверяется ТЕМ ЖЕ способом, что в тесте очереди записей: у каждой единицы
 * версии, дошедшие до канала, строго возрастают. Данные синтетические.
 */

const OFFERS = 10_000;
/**
 * Сколько записей отправляется ПО ОДНОЙ. Не весь каталог: модель канала пересчитывает состояние всех предложений на
 * каждый запрос (это свойство модели, а не продукта), и десять тысяч одиночных запросов к ней идут часами. Утверждение
 * от этого не слабеет: по одной записи — РОВНО один запрос на запись, и это проверяется числом на тысяче.
 */
const ONE_BY_ONE = 300;
const BULK_MAX_UNITS = 150;
/** Бюджет продавца у модели канала — 100 запросов в секунду: один запрос «стоит» 10 мс канала */
const CHANNEL_MS_PER_REQUEST = 10;

let db: IsolatedDatabase;
let k: KauflandLiveWorld;
let observer: PgPool;
const measured: Array<{ phase: string; writes: number; requests: number; seconds: number; channelSeconds: number; routes: Record<string, number> }> = [];

const products: LiveProduct[] = Array.from({ length: OFFERS }, (_, i) => ({
  cls: 'STATIC' as const, idProduct: 362_400_001 + i, marketplace: 'de', behaviour: { kind: 'STATIC' as const }, pastMovesEveryMinutes: null, bare: true,
}));

before(async () => {
  db = await createIsolatedDatabase('bulkdispatch');
  const clock = new VirtualClock(new Date(Date.now() - 2 * 3_600_000).toISOString());
  const pools = {
    appPool: db.pool('svc_app', 6), adminPool: db.pool('svc_admin', 3),
    provisioningPool: db.pool('svc_provisioning', 1), dispatcherPool: db.pool('svc_dispatcher', 2),
  };
  // Канал без сбоев: замеряется число запросов, а не поведение при отказах — их проверяют другие прогоны (K-14)
  k = await kauflandLiveWorld({
    tag: 3601, clock, products, seed: 3601, ...pools,
    params: { faults: { writeTimeoutShare: 0, timeoutAppliedShare: 0, bulkItemMissingShare: 0, bulkItemServerErrorShare: 0 }, applyDelayMs: 0 },
    stock: { onHand: 40, bufferUnits: 1, stockPool: db.pool('svc_stock', 3) },
  });
  // Наблюдатель — суперпользователь базы: политики строк тенанта его не касаются, и он видит то, что есть на самом деле
  const url = new URL(process.env.REPRACER_PG_ADMIN_URL!); url.pathname = `/${db.name}`;
  observer = createPool(url.toString(), { max: 1, applicationName: 'repracer-bulk-dispatch-observer' });
});

after(async () => {
  console.log(JSON.stringify({ offers: OFFERS, phases: measured }, null, 1));
  await observer?.end();
  await db?.drop();
});

/** Счётчики маршрутов канала: сколько HTTP-запросов ушло на каждый путь */
const routes = () => Object.fromEntries([...k.requests.entries()]);
const total = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + b, 0);
const delta = (before: Record<string, number>, after: Record<string, number>) =>
  Object.fromEntries(Object.entries(after).map(([key, value]) => [key, value - (before[key] ?? 0)]).filter(([, v]) => (v as number) > 0));

/** Ждущие записи количества у тенанта — по базе, а не по ответу того, что проверяем */
async function pendingWrites(): Promise<number> {
  const { rows } = await observer.query(
    `SELECT count(*)::int AS n FROM tenant_data.channel_write WHERE tenant_id = $1 AND field = 'QUANTITY' AND status = 'PENDING'`, [k.seeded.tenantId]);
  return Number(rows[0]!.n);
}

/** Версии, дошедшие до канала, по единицам записи — проверка порядка [Р-24, Р-64], как в тесте очереди записей */
async function orderViolations(): Promise<{ scopes: number; violations: number; applied: number }> {
  const { rows } = await observer.query(
    `SELECT write_scope_id, array_agg(version ORDER BY coalesce(accepted_at, dispatched_at, created_at), channel_write_id) AS versions
       FROM tenant_data.channel_write_history
      WHERE tenant_id = $1 AND field = 'QUANTITY' AND final_status = 'APPLIED'
      GROUP BY write_scope_id`, [k.seeded.tenantId]);
  let violations = 0;
  let applied = 0;
  for (const r of rows) {
    const versions = (r.versions as number[]).map(Number);
    applied += versions.length;
    for (let i = 1; i < versions.length; i++) if (versions[i]! <= versions[i - 1]!) violations += 1;
  }
  return { scopes: rows.length, violations, applied };
}

test('Р-155: 10 000 записей остатка по ОДНОЙ — столько же запросов к каналу, сколько предложений', async () => {
  const waiting = await pendingWrites();
  assert.equal(waiting, OFFERS, `включение синхронизации создало запись на каждое предложение: ${waiting}`);
  const before = routes();
  const started = Date.now();
  // Путь решения отправляет свою запись сам: один запрос на единицу — так работал диспетчер до Р-155
  const { rows: scopes } = await observer.query(
    `SELECT write_scope_id FROM tenant_data.write_scope WHERE tenant_id = $1 AND field = 'QUANTITY' ORDER BY created_at LIMIT $2`,
    [k.seeded.tenantId, ONE_BY_ONE]);
  /**
   * Часы двигаются вместе с отправкой: у продавца свой бюджет запросов к каналу (модель — 100 запросов в секунду), и
   * десять тысяч запросов физически не помещаются в одну секунду. Именно это Р-155 и меняет: столько же остатка уходит
   * за столько же запросов, сколько предложений, — или за 67 пакетов.
   */
  for (const s of scopes) {
    await k.dispatchScope(k.seeded.tenantId, s.write_scope_id);
    k.clock.advance(CHANNEL_MS_PER_REQUEST);
  }
  const seconds = Math.round((Date.now() - started) / 100) / 10;
  const spent = delta(before, routes());
  measured.push({ phase: 'по одной (PATCH /units/{id})', writes: ONE_BY_ONE, requests: total(spent), seconds, channelSeconds: Math.round(total(spent) / 100 * 10) / 10, routes: spent });
  assert.equal(spent['PATCH /v2/units/{id}'], ONE_BY_ONE, `по одной записи — по одному запросу: ${JSON.stringify(spent)}`);
  assert.equal(await pendingWrites(), OFFERS - ONE_BY_ONE, 'отправлены ровно те записи, что брали');
});

test('Р-155: те же 10 000 — пакетами: запросов меньше в десятки раз, и в пакете не больше 150 единиц', async () => {
  // Новый остаток каждому товару: у каждой единицы появляется следующая версия записи
  const recalculated = await k.stock!.enableStockSync(k.seeded.tenantId, k.seeded.ids.dbId(k.world.channelAccountId),
    { bufferUnits: 3, maxQuantity: null, minQuantityToList: 0, acknowledgeSideEffects: false },
    { membershipId: k.seeded.ownerMembershipId, userId: k.seeded.userId, mfa: true });
  assert.equal(recalculated.status, 'ENABLED');
  const created = await k.stock!.recalculate(k.seeded.tenantId, null, k.clock.iso() as never);
  // У тысячи отправленных единиц это новая версия, у остальных девяти тысяч ждущая запись заменяется новой [Р-64]
  assert.equal(created.writes.length, OFFERS, `новая версия у каждой единицы: ${created.writes.length}`);

  /**
   * Часы мира догоняют настоящее: записи создаёт БАЗА своими часами [триггер channel_write_before_insert], а мир живёт
   * на виртуальных и стартовал в прошлом — иначе обход считает записи «из будущего» и не берёт ни одной. Заодно
   * восполняется бюджет канала: между двумя замерами в жизни проходит время.
   */
  k.clock.advance(Math.max(60_000, Date.now() - k.clock.nowMs() + 60_000));
  const before = routes();
  const started = Date.now();
  const swept = await k.dispatcher.sweep({ limit: OFFERS + 100, pendingMinAgeMs: 0, concurrency: 4 });
  const seconds = Math.round((Date.now() - started) / 100) / 10;
  const spent = delta(before, routes());
  measured.push({ phase: 'пакетами (POST /units/bulk)', writes: OFFERS, requests: total(spent), seconds, channelSeconds: Math.round(total(spent) / 100 * 10) / 10, routes: spent });

  assert.equal(swept.due, OFFERS, `обход взял все единицы: ${swept.due}`);
  assert.equal(await pendingWrites(), 0, 'ждущих записей не осталось');
  // Пакет — до 150 unit: меньше 67 запросов на 10 000 записей физически невозможно, а 10 000 — это «по одной»
  const requests = total(spent);
  assert.ok(requests >= Math.ceil(OFFERS / BULK_MAX_UNITS), `пакет не больше ${BULK_MAX_UNITS} единиц: ${requests} запросов на ${OFFERS} записей`);
  assert.ok(requests <= OFFERS / 10, `пакетная запись — на порядок меньше запросов: ${requests} против ${OFFERS}`);
  assert.equal(spent['POST /v2/units/bulk'], requests, `все запросы — пакетные: ${JSON.stringify(spent)}`);

  /**
   * Второй пакетный круг: у каждой единицы появляется ЕЩЁ одна версия, и она уходит тем же путём. Без этого утверждение
   * о порядке провалиться не могло бы — сравнивать было бы нечего (находка 14 ревью шага 36).
   */
  await k.stock!.enableStockSync(k.seeded.tenantId, k.seeded.ids.dbId(k.world.channelAccountId),
    { bufferUnits: 5, maxQuantity: null, minQuantityToList: 0, acknowledgeSideEffects: false },
    { membershipId: k.seeded.ownerMembershipId, userId: k.seeded.userId, mfa: true });
  const second = await k.stock!.recalculate(k.seeded.tenantId, null, k.clock.iso() as never);
  assert.equal(second.writes.length, OFFERS, `вторая версия у каждой единицы: ${second.writes.length}`);
  // Часы мира снова догоняют настоящее: первый круг занял минуты, и записи второго созданы базой уже «в будущем» мира
  k.clock.advance(Math.max(60_000, Date.now() - k.clock.nowMs() + 60_000));
  const sweptAgain = await k.dispatcher.sweep({ limit: OFFERS + 100, pendingMinAgeMs: 0, concurrency: 4 });
  assert.equal(sweptAgain.due, OFFERS, `второй круг взял все единицы: ${sweptAgain.due}`);

  // Порядок внутри единицы записи не нарушен ни разу [Р-24, Р-64]: у каждой единицы версии строго возрастают
  const order = await orderViolations();
  assert.deepEqual([order.scopes, order.violations], [OFFERS, 0], `порядок по единицам: ${JSON.stringify(order)}`);
  // У тысячи единиц применены обе версии, у остальных — только последняя: предыдущая вытеснена ею же [Р-64]
  // У каждой единицы применены две пакетные версии, у первых трёхсот — ещё и одиночная
  assert.equal(order.applied, OFFERS * 2 + ONE_BY_ONE, `применённых версий: ${order.applied}`);
  // И канал показывает последнее количество: 40 − 3 = 37 у каждой единицы
  const units = (k.simulator.dump() as { units: Array<{ amount: number }> }).units;
  // Последнее посчитанное количество: 40 штук инвентаризации минус буфер 5
  assert.deepEqual([units.length, units.filter((u) => u.amount === 35).length], [OFFERS, OFFERS], 'у каждой единицы канала — последнее посчитанное количество');
});
