import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createPool, PgPricingStore, PgShadowStore, type PgPool } from '@repracer/pricing-store-pg';
import { pgJobDeps } from '@repracer/scheduler';
import {
  boundsView, CHANNEL_PRICING_SHOWN, complianceView, dangerousReport, decisionListView, feedPageQuery, listQuery, messagesFor, OFFER_CHOICES, parseFeedQuery, priceFeed,
  productList, rejectedView, scopeById, stopView, STRATEGY_SCOPE_EXAMPLES, strategiesView, unitOf,
} from '@repracer/console-model';
import { cpus, freemem, loadavg, totalmem } from 'node:os';
import { createIsolatedDatabase, type IsolatedDatabase } from '../../../packages/pricing-store-pg/test/isolated-db.ts';
import { kauflandLiveWorld, WallClock, type KauflandLiveWorld, type LiveProduct } from './live/index.ts';

/**
 * Шаг 65, часть 3: МАСШТАБ. Каталог продавца в N предложений (`REPRACER_SCALE_OFFERS`, по умолчанию 50 000; таблица 10 000 → 50 000 —
 * этот же файл с N = 10 000, тот же код и тот же посев) и замер того, что растёт с каталогом:
 *  - пересчёт остатков (ничего не изменилось; изменилось всё);
 *  - выборка кандидатов работы заказов (все N — кандидаты);
 *  - экраны консоли — те методы хранилища, которыми их строит API: состояние каталога (товары, границы, стратегии), счётчики мира,
 *    путь онбординга, страница и расхождения остатков, страница тени, страницы решений и ленты;
 *  - круг обнаружения (весь каталог канала через путь решения и функцию каталога базы) и выборка сверки (то, что круг сверки Amazon
 *    читает на каждом вызове);
 *  - суточные работы планировщика — те же функции, что зовёт его работа: закрытие суток, секции, удаление по сроку.
 * Пределы — пределы экрана [Р-136]: экран ≤ 10 с, ответ ≤ 2 МиБ (предел сервера, шаг 66); работа — ≤ 60 с (половина срока вызова работы). Превышение предела —
 * провал: узкое место названо числом. Данные синтетические.
 */
const OFFERS = Number(process.env.REPRACER_SCALE_OFFERS ?? 50_000);
const SCREEN_SECONDS = 10;
/** Предел ответа экрана — тот же, что у сервера консоли (`SCREEN_RESPONSE_MAX_BYTES`, шаг 66): больше — ответ не уходит вовсе */
const SCREEN_BYTES = 2 * 1024 * 1024;
const JOB_SECONDS = 60;

let db: IsolatedDatabase;
let k: KauflandLiveWorld;
let observer: PgPool;
let store: PgPricingStore;
const measured: Array<{ operation: string; seconds: number; bytes?: number; rows?: number; heapMb?: number; queue?: string; limit: number }> = [];

/**
 * Единица Kaufland — последние шесть цифр товара БЕЗ ведущих нулей (как у демо): канал отдаёт `id_unit` числом, и посев «000001» против
 * канального «1» — разные предложения. Первая редакция замера сеяла с нулями, и каждый круг обнаружения заводил весь каталог заново:
 * мерился первый круг 50 000 новых предложений, а не повторный
 */
const product = (idProduct: number): LiveProduct => ({ cls: 'STATIC', idProduct, marketplace: 'de', behaviour: { kind: 'STATIC' }, pastMovesEveryMinutes: null, bare: true });
const products: LiveProduct[] = Array.from({ length: OFFERS }, (_, i) => product(365_100_001 + i));
/** Предложения, которые есть только у канала: первый круг обнаружения заводит их в каталог, следующий видит весь каталог знакомым */
const NEW_OFFERS = Math.round(OFFERS / 10);
const channelOnly: LiveProduct[] = Array.from({ length: NEW_OFFERS }, (_, i) => product(365_100_001 + OFFERS + i));
/** Куча процесса прогона: модель канала и мир живут в нём же, и куча у предела (2 ГБ на машине разработчика) мерила бы сборку мусора, а не продукт */
const heapMb = () => Math.round(process.memoryUsage().heapUsed / 1_048_576);
/**
 * Шаг 67 (Р-146): состояние машины в выводе замера. Замер шага 66 на машине разработчика показал круг обнаружения вдвое медленнее (148 и
 * 102 с против 78 и 71), и причиной была не очередь записей, а машина: чужой процесс на полном ядре десять часов и подкачка, занятая на
 * 8 из 9 ГБ. Тот же код на CI — 77,5 и 71,3 с. Число замера без состояния машины — не число продукта
 */
const machine = () => ({ cpus: cpus().length, load: loadavg().map((x) => Math.round(x * 10) / 10), freeMemMb: Math.round(freemem() / 1_048_576), totalMemMb: Math.round(totalmem() / 1_048_576) });
const machineAtStart = machine();

/**
 * Шаг 66 (OQ-247, Р-203): перед каждой операцией прогон НАРОЧНО портит статистику очереди записей — так, как её портит работа: очередь
 * была полна строками тенанта и опустела, а очистка не обрезала файл, — «0 строк на N страниц» (вне замера). Остальные таблицы
 * анализируются: замер — про очередь. При такой статистике все пути к очереди стоят для планировщика одинаково, и до шага 66 пересчёт
 * 50 000 единиц шёл ~10 минут вместо 17 с. Операции обязаны уложиться в свои пределы и так: большая транзакция обновляет статистику
 * очереди сама (триггер `aa_channel_write_queue_stats`). Если в очереди есть живые строки, очистка их сосчитает — это честное состояние
 */
async function trappedQueueStatistics(): Promise<string> {
  await observer.query('ANALYZE');
  const client = await observer.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL session_replication_role = replica');
    await client.query(`INSERT INTO tenant_data.channel_write (tenant_id, write_scope_id, field, version, idempotency_key, origin, status, quantity)
      SELECT $1, gen_random_uuid(), 'QUANTITY', 1, 'scale-trap-' || i, 'STOCK_RECALC', 'PENDING', 1 FROM generate_series(1, $2::int) i`, [trapTenant, OFFERS]);
    await client.query(`DELETE FROM tenant_data.channel_write WHERE idempotency_key LIKE 'scale-trap-%'`);
    await client.query('COMMIT');
  } finally {
    client.release();
  }
  await observer.query('VACUUM (TRUNCATE false) tenant_data.channel_write');
  const { rows: [q] } = await observer.query(`SELECT reltuples::bigint AS t, relpages AS p FROM pg_class WHERE oid = 'tenant_data.channel_write'::regclass`);
  return `${(q as { t: number }).t} rows on ${(q as { p: number }).p} pages`;
}
let trapTenant = '';

async function timed<T>(operation: string, limit: number, fn: () => Promise<T>, size?: (r: T) => { bytes?: number; rows?: number; heapMb?: number }): Promise<T> {
  const queue = await trappedQueueStatistics();
  const started = performance.now();
  const result = await fn();
  const seconds = Math.round((performance.now() - started) / 10) / 100;
  measured.push({ operation, seconds, limit, queue, ...(size ? size(result) : {}) });
  return result;
}
const bytesOf = (v: unknown) => ({ bytes: Buffer.byteLength(JSON.stringify(v)) });

before(async () => {
  db = await createIsolatedDatabase('scale');
  /**
   * Часы — НАСТОЯЩИЕ: модель канала считает лимит запросов по часам мира, и на остановленных виртуальных часах каждая страница обнаружения
   * после первой сотни получала 429, а клиент ждал повтора настоящие ~2 с — круг мерил бы ожидание стенда, а не продукт (замер шага 65)
   */
  const clock = new WallClock();
  const started = performance.now();
  k = await kauflandLiveWorld({
    tag: 6550, clock, products, channelOnly, seed: 6550,
    appPool: db.pool('svc_app', 6), adminPool: db.pool('svc_admin', 3), provisioningPool: db.pool('svc_provisioning', 1), dispatcherPool: db.pool('svc_dispatcher', 2),
    params: { faults: { writeTimeoutShare: 0, timeoutAppliedShare: 0, bulkItemMissingShare: 0, bulkItemServerErrorShare: 0 }, applyDelayMs: 0 },
    stock: { onHand: 40, bufferUnits: 1, stockPool: db.pool('svc_stock', 3) },
  });
  measured.push({ operation: `seed the world: ${OFFERS} offers, stock and sync enabled`, seconds: Math.round((performance.now() - started) / 10) / 100, limit: Number.POSITIVE_INFINITY });
  const url = new URL(process.env.REPRACER_PG_ADMIN_URL!); url.pathname = `/${db.name}`;
  observer = createPool(url.toString(), { max: 1, applicationName: 'repracer-scale-observer' });
  store = new PgPricingStore(db.pool('svc_app', 4), { adminPool: db.pool('svc_admin', 2) });
});

after(async () => {
  console.log(JSON.stringify({ scale: { offers: OFFERS, newOffers: NEW_OFFERS, machine: { atStart: machineAtStart, atEnd: machine() }, measured } }, null, 1));
  await observer?.end();
  // Учение восстановления на большой базе (docs/runbook-disaster.md) берёт её отсюда: база остаётся, её имя — в выводе
  if (process.env.REPRACER_SCALE_KEEP_DB === 'on') {
    await db?.endPools();
    console.log(JSON.stringify({ scaleDatabaseKept: db.name }));
  } else {
    await db?.drop();
  }
});

test(`шаг 65: масштаб — каталог ${OFFERS} предложений: пересчёт, кандидаты, экраны, круги и суточные работы в своих пределах`, { timeout: 120 * 60_000 }, async () => {
  const tenant = k.seeded.tenantId;
  trapTenant = tenant;
  const account = k.seeded.ids.dbId(k.world.channelAccountId);
  const now = () => k.clock.iso() as never;
  const owner = { membershipId: k.seeded.ownerMembershipId, userId: k.seeded.userId };

  // ---------------------------------------------------------------- остатки
  const unchanged = await timed('stock recalculate, nothing changed', JOB_SECONDS, () => k.stock!.recalculate(tenant, null, now()), (r) => ({ rows: r.writes.length }));
  assert.equal(unchanged.writes.length, 0, 'ничего не изменилось — записей нет');
  // Кандидаты работы заказов — тем же ходом, что шаг 58: тень, новый остаток у всех, удержание, возврат в бой
  const shadow = new PgShadowStore({ adminPool: db.pool('svc_admin', 1) });
  const { rows: [acc] } = await observer.query('SELECT external_account_id FROM tenant_data.channel_account WHERE channel_account_id = $1', [account]);
  assert.equal((await shadow.switchWriteMode(tenant, { channelAccountId: account, toMode: 'SHADOW', ...owner, mfa: false })).status, 'SWITCHED');
  const source = (await k.stock!.stockSources(tenant))[0]!.stockSourceId;
  await timed('stock import file, every offer', JOB_SECONDS, () => k.stock!.importStock(tenant, source, products.map((p) => ({ sku: String(p.idProduct).slice(-6), quantity: 30 })), { ...owner, mfa: true }));
  // Результаты больших операций в переменных не держатся: куча прогона — не предмет замера
  assert.equal((await timed('stock recalculate, every unit changed', JOB_SECONDS, () => k.stock!.recalculate(tenant, null, now()), (r) => ({ rows: r.writes.length }))).writes.length,
    OFFERS, 'каждая единица получила новое количество, удержанное тенью');
  assert.equal((await shadow.switchWriteMode(tenant, { channelAccountId: account, toMode: 'LIVE', ...owner, mfa: true, typedConfirmation: String(acc!.external_account_id) })).status, 'SWITCHED');
  assert.equal((await timed('order-lines candidate selection, every product a candidate', JOB_SECONDS, () => k.stock!.budgetRolledOverProducts(tenant, account), (r) => ({ rows: r.length }))).length,
    OFFERS, 'выборка находит каждый товар, которого канал не видел');
  /**
   * Шаг 66 (п. 3): боевой пересчёт — каждая из N записей ждёт диспетчера, и каждая объявляется ему при фиксации. «Уже объявлено в
   * транзакции» до шага 66 было одной строкой, которую каждая запись просматривала и дописывала копией: на 50 000 — ~55 с одной транзакции
   */
  await k.stock!.importStock(tenant, source, products.map((p) => ({ sku: String(p.idProduct).slice(-6), quantity: 31 })), { ...owner, mfa: true });
  assert.equal((await timed('stock recalculate, every unit changed, LIVE: every write announced to the dispatcher', JOB_SECONDS, () => k.stock!.recalculate(tenant, null, now()), (r) => ({ rows: r.writes.length }))).writes.length,
    OFFERS, 'каждая единица получила запись, которая ждёт диспетчера');

  // ---------------------------------------------------------------- экраны консоли — методами, которыми их строит API
  /**
   * Шаг 66 (OQ-248): товары и остатки больше не грузят каталог. Товары — страница и итоги из базы (`consoleCatalogPage`), мир только из
   * единиц страницы; остатки — мир без каталога и страница своего хранилища. Полное состояние каталога остаётся у экранов, которые его
   * ещё читают (стратегии, поиск предложения, комплаенс, остановка, карточка границ) — своей строкой: это память сервера на их запрос
   */
  // Шаг 67: каталог целиком собирают только маршруты записи массовых операций («весь каталог», стратегии, границы, импорт) — остаток OQ-248
  await timed('server: full catalog state — bulk write routes still loading it (all: true, strategy assign, bounds, import)', SCREEN_SECONDS, () => store.readConsoleState(tenant, now()), bytesOf);
  const world = { id: 'scale', title: 'scale', description: '', tenantId: tenant, now: k.clock.iso(), accounts: [{ channelAccountId: account, channel: 'KAUFLAND', marketplaces: ['de'] }],
    viewer: { membershipId: k.seeded.ownerMembershipId, role: 'OWNER' } };
  const m = messagesFor('en');
  for (const [label, offset] of [['first', 0], ['last', OFFERS - 50]] as const) {
    await timed(`screen: products page, ${label} (database page + world of the page)`, SCREEN_SECONDS, async () => {
      const page = await store.consoleCatalogPage(tenant, now(), { offset, limit: 50 });
      const state = await store.readConsoleState(tenant, now(), { scopeIds: page.scopeIds });
      return productList({ ...world, state } as never, m, { offset, limit: 50 }, await store.scopeDecisionStats(tenant, page.scopeIds), page);
    }, bytesOf);
  }
  await timed('screen: stock page (world without catalog + page)', SCREEN_SECONDS, async () => {
    await store.readConsoleState(tenant, now(), { scopeIds: [] });
    return k.stock!.stockPage(tenant, { offset: 0, limit: 50 });
  }, bytesOf);
  /**
   * Шаг 67 (OQ-248): экраны, которые до шага собирали каталог целиком, — теми же вызовами, что их построители на сервере
   * (`stand-server.ts`): единицы, которые экран покажет, факты базы о каталоге целиком, мир только из названных единиц. Равенство с
   * экраном из каталога целиком держит `console-screens-targeted.pg.test.ts`, HTTP-путь на 10 000 — `console-live.pg.test.ts`
   */
  const worldOf = async (scopeIds: readonly string[], extra: { catalogPage?: unknown; catalogFacts?: unknown } = {}) =>
    ({ ...world, state: await store.readConsoleState(tenant, now(), { scopeIds }), ...extra }) as never;
  const q50 = listQuery({ offset: 0, limit: 50 });
  await timed('screen: strategies (database page + strategy usage + channel pricing + world of the named units)', SCREEN_SECONDS, async () => {
    const [page, f] = await Promise.all([store.consoleCatalogPage(tenant, now(), q50),
      store.consoleCatalogFacts(tenant, { first: 1, strategyUsage: { examples: STRATEGY_SCOPE_EXAMPLES }, channelPricing: { limit: CHANNEL_PRICING_SHOWN } })]);
    const ids = [...page.scopeIds, ...f.firstIds, ...(f.strategyUsage ?? []).flatMap((u) => u.exampleIds)];
    return strategiesView(await worldOf(ids, { catalogPage: page, catalogFacts: f }), m, true, q50);
  }, bytesOf);
  const unitLabel = { labelTemplate: m.ui.common.unitLabel('{c}', '{m}', '{u}'), channelNames: { KAUFLAND: m.values.KAUFLAND }, unknownChannel: 'UNKNOWN_CHANNEL' };
  for (const [label, q] of [['every offer matches', 'kaufland'], ['one offer matches', String(products[OFFERS - 1]!.idProduct).slice(-6)]] as const) {
    await timed(`screen: offer search, ${label} (database search + world of the found)`, SCREEN_SECONDS, async () => {
      const found = (await store.consoleCatalogFacts(tenant, { search: { q, limit: OFFER_CHOICES, ...unitLabel } })).search!;
      const w = await worldOf(found.ids) as Parameters<typeof unitOf>[0];
      return { items: found.ids.flatMap((id) => { const sc = scopeById(w, id); return sc ? [unitOf(w, sc, m)] : []; }), total: found.total };
    }, bytesOf);
  }
  await timed('screen: compliance (database page + first offers + history depth of the shown)', SCREEN_SECONDS, async () => {
    const [announcements, page, f] = await Promise.all([store.discountAnnouncements(tenant), store.consoleCatalogPage(tenant, now(), q50), store.consoleCatalogFacts(tenant, { first: OFFER_CHOICES })]);
    const w = await worldOf([...announcements.map((x) => x.writeScopeId), ...page.scopeIds, ...f.firstIds], { catalogPage: page, catalogFacts: f });
    const depth = new Map(await Promise.all(page.scopeIds.map(async (id) => [id, await store.omnibusCheck(tenant, id, now())] as const)));
    return complianceView(w, announcements, new Map(), m, depth, q50);
  }, bytesOf);
  await timed('screen: stop (stop impact by account and storefront + world without catalog)', SCREEN_SECONDS, async () =>
    stopView(await worldOf([], { catalogFacts: await store.consoleCatalogFacts(tenant, { stopImpact: true }) }), await store.auditRecent(tenant, 50), m), bytesOf);
  const someScope = (await store.consoleCatalogPage(tenant, now(), { offset: Math.floor(OFFERS / 2), limit: 1 })).scopeIds[0]!;
  await timed('screen: bounds card of one offer (world of one unit)', SCREEN_SECONDS, async () => boundsView(await worldOf([someScope]), someScope, m), bytesOf);
  await timed('screen: decisions list (database page + world of its units)', SCREEN_SECONDS, async () => {
    const page = await store.decisionPage(tenant, { offset: 0, limit: 50 } as never);
    return decisionListView(await worldOf(page.items.map((d) => d.writeScopeId)), page, q50, m);
  }, bytesOf);
  await timed('screen: price feed (database page + first offers + world of its units)', SCREEN_SECONDS, async () => {
    const filter = parseFeedQuery(new URLSearchParams())!;
    const page = await store.feedPage(tenant, now(), feedPageQuery(filter));
    const f = await store.consoleCatalogFacts(tenant, { first: OFFER_CHOICES });
    return priceFeed(await worldOf([...page.items.map((i) => i.write.writeScopeId), ...f.firstIds], { catalogFacts: f }), m, filter, page, feedPageQuery(filter));
  }, bytesOf);
  await timed('screen: rejected and dangerous reports (interventions of the week + world of their units)', SCREEN_SECONDS, async () => {
    const to = now() as unknown as string;
    const slice = await store.interventions(tenant, new Date(Date.parse(to) - 7 * 86_400_000).toISOString() as never, to as never);
    const f = await store.consoleCatalogFacts(tenant, { keys: slice.rejectedSnapshots.map((x) => x.key) });
    const w = await worldOf([...[...slice.decisions, ...slice.intents, ...slice.endedWrites].map((x) => x.writeScopeId), ...(f.keyed ?? []).map((k) => k.writeScopeId)], { catalogFacts: f });
    return { rejected: rejectedView(w, slice, m), dangerous: dangerousReport(w, slice, 7, m) };
  }, bytesOf);
  await timed('screen: world counters (list of worlds)', SCREEN_SECONDS, () => store.worldCounters(tenant, now()), bytesOf);
  await timed('screen: onboarding status', SCREEN_SECONDS, () => store.onboardingStatus(tenant), bytesOf);
  await timed('screen: stock page, last page', SCREEN_SECONDS, () => k.stock!.stockPage(tenant, { offset: OFFERS - 50, limit: 50 }), bytesOf);
  await timed('screen: stock divergences', SCREEN_SECONDS, () => k.stock!.stockDivergences(tenant, 50), bytesOf);
  await timed('screen: shadow page (7 days)', SCREEN_SECONDS, () => shadow.shadowPage(tenant, k.clock.iso(), { offset: 0, limit: 50, sinceDays: 7 }), bytesOf);
  await timed('screen: decisions page', SCREEN_SECONDS, () => store.decisionPage(tenant, { offset: 0, limit: 50 } as never), bytesOf);
  await timed('screen: price feed page', SCREEN_SECONDS, () => store.feedPage(tenant, now(), { offset: 0, limit: 50 } as never), bytesOf);

  // ---------------------------------------------------------------- круги
  await timed('reconciliation sample (one call of the Amazon reconciliation circle reads the account)', SCREEN_SECONDS,
    () => store.pickReconciliationSample(tenant, account, 20, 0), (r) => ({ rows: r.total }));
  const ctx = { tenantId: k.world.tenantId, channelAccountId: k.world.channelAccountId, correlationId: 'scale', deadline: k.clock.iso(3_600_000) } as never;
  /**
   * Круг обнаружения — дважды: первый заводит в каталог предложения, которых в нём нет (новые товары продавца; у только что подключённого
   * аккаунта новые — все), следующий видит весь каталог знакомым. Это обычный круг работы: раз в сутки, заходами по часу
   */
  const discovery = () => k.pipelineForDbIds().discoverOffers(ctx, { pageLimit: 100, maxPages: 5_000, deadlineMarginMs: 0 });
  const first = await timed(`discovery circle, first: ${OFFERS} offers known, ${NEW_OFFERS} new enter the catalogue`, JOB_SECONDS * 10, discovery, (r) => ({ rows: r.offers, heapMb: heapMb() }));
  assert.deepEqual([first.stop, first.offers, first.catalogued], ['COMPLETED', OFFERS + NEW_OFFERS, NEW_OFFERS], `первый круг прошёл весь каталог канала и завёл новые: ${JSON.stringify(first).slice(0, 300)}`);
  const next = await timed('discovery circle, next: every offer already known', JOB_SECONDS * 10, discovery, (r) => ({ rows: r.offers, heapMb: heapMb() }));
  assert.deepEqual([next.stop, next.offers, next.catalogued], ['COMPLETED', OFFERS + NEW_OFFERS, 0], `следующий круг ничего не заводит: ${JSON.stringify(next).slice(0, 300)}`);

  // ---------------------------------------------------------------- суточные работы — функции, которые зовёт работа планировщика
  const jobs = pgJobDeps({
    schedulerPool: db.pool('svc_scheduler', 2), exporterPool: db.pool('svc_exporter', 1), ingest: null as never, verifier: null as never,
    pipelineFor: () => { throw new Error('not used'); }, descriptorOf: () => null,
  });
  const at = new Date().toISOString() as never;
  await timed('daily: price-days-close (close + corrections)', JOB_SECONDS, async () => (await jobs.maintenance.closePriceDays(at)) + (await jobs.maintenance.correctClosedPriceDays(at)), (n) => ({ rows: n }));
  await timed('daily: partitions', JOB_SECONDS, () => jobs.maintenance.ensurePartitions(at));
  await timed('daily: retention (partitions, rows, reservations)', JOB_SECONDS, async () => (await jobs.maintenance.dropExpiredPartitions(at)) + (await jobs.maintenance.deleteExpiredRows(at))
    + (await jobs.maintenance.releaseExpiredReservations(at)) + (await jobs.maintenance.alertStaleConfirmedReservations(at)), (n) => ({ rows: n }));

  // Предел 2 МиБ — у ОТВЕТА экрана; состояние каталога в памяти сервера — отдельная строка таблицы, без предела ответа
  const over = measured.filter((x) => x.seconds > x.limit || (x.bytes !== undefined && x.bytes > SCREEN_BYTES && !x.operation.startsWith('server:')));
  assert.ok(measured.every((x) => x.seconds <= x.limit), `за пределом времени на каталоге ${OFFERS}: ${JSON.stringify(over)}`);
  assert.deepEqual(over, [], `за пределами экрана или работы на каталоге ${OFFERS}`);
});
