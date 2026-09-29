import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { MemorySeedScope } from '@repracer/pricing-pipeline';
import { PgStockStore, seedPricingWorld, type SeededPricingWorld } from '@repracer/pricing-store-pg';
import { createIsolatedDatabase, type IsolatedDatabase } from '../../../packages/pricing-store-pg/test/isolated-db.ts';
import { startKauflandHttpModel, type KauflandHttpModel } from '../../../tests/contract/src/live/kaufland-http.ts';
import { SimulatedKauflandChannel } from '../../../tests/contract/src/simulator/kaufland-channel.ts';
import { loadConfig } from '../src/config.ts';
import { startScheduler, type SchedulerProcess } from '../src/main.ts';

/**
 * Шаг 58 (ревью шага 56, находка 15): живой прогон ПРОИЗВОДСТВЕННОГО состава работы `order-lines`. До этого шага её проверяли только
 * прогоны, собиравшие зависимости сами (`scheduler-live`), а процесс, собранный `startScheduler`, её не заводил вовсе (шаг 56) — и
 * даже заведённую никто не прогонял от сети до экрана. Здесь всё — как в работе: настоящий процесс `startScheduler(loadConfig(env))`,
 * учётные данные канала — ФАЙЛОМ в каталоге `REPRACER_CHANNEL_SECRETS_DIR` (ссылка `credentials_ref` аккаунта), роли подключения —
 * каждая своя, канал — модель Kaufland за настоящим HTTP (подпись HMAC проверяется ключами того же файла), часы — настоящие.
 *
 * Сценарий — новый продавец: аккаунт подключён 20 минут назад, через 6 минут пришёл заказ, а первый заход работы — сейчас, то есть
 * заказ старше одного интервала работы (5 мин). Утверждается: резервация этой строки заказа в базе, доступное на экране остатков
 * (`PgStockStore.stockPage` — тот метод, что отдаёт экран консоли) меньше на количество заказа, запись количества с уменьшенным
 * значением, чтение заказов действительно шло в модель. Данные синтетические.
 */
const SELLER = { clientKey: 'syn-kfl-client-key-5801', secretKey: 'syn-kfl-secret-key-5801' };
const ID_PRODUCT = 5_800_001;
const ID_UNIT = 800_001;
const ID_OFFER = `SYN-OFFER-${ID_PRODUCT}`;
const ON_HAND = 10;
const BUFFER = 1;
const CONNECTED_AGO_MS = 20 * 60_000;
const ORDER_AFTER_CONNECT_MS = 6 * 60_000;

let db: IsolatedDatabase;
let seeded: SeededPricingWorld;
let stock: PgStockStore;
let model: KauflandHttpModel;
let simulator: SimulatedKauflandChannel;
let secretsDir = '';
let proc: SchedulerProcess | null = null;
let productId = '';

before(async () => {
  db = await createIsolatedDatabase('orderlinesprod');
  const connectedAt = new Date(Date.now() - CONNECTED_AGO_MS).toISOString();
  const scope = {
    writeScopeId: 'ws-de-5801', productId: 'prod-de-5801', channelAccountId: '20000000-0000-4000-8000-000000005801', marketplace: 'de',
    externalUnitId: String(ID_UNIT), externalOfferId: ID_OFFER, channelProductRef: String(ID_PRODUCT), condition: 'new', currency: 'EUR', basis: 'GROSS',
    pricingMode: 'OFF', strategy: null, currentPriceMinor: 1850, minPrice: null, maxPrice: null,
  } as MemorySeedScope;
  seeded = await seedPricingWorld(db.pool('svc_app', 2), {
    provisioningPool: db.pool('svc_provisioning', 1), adminPool: db.pool('svc_admin', 2), fixtureTenantId: '10000000-0000-4000-8000-000000005801',
    fixtureChannelAccountId: '20000000-0000-4000-8000-000000005801', marketplaces: ['de'], clock: connectedAt, seed: { scopes: [scope] },
  });
  productId = seeded.ids.dbId('prod-de-5801');
  /**
   * Время подключения аккаунта — 20 минут назад: посев ставит `now()`, а сценарий — «продавец подключился, заказ пришёл до первого захода».
   * `connected_at` неизменяем (страж столбцов), поэтому данные теста правит суперпользователь с выключенными триггерами — в своём
   * соединении, которое тут же закрывается; значения — сгенерированные, не ввод
   */
  assert.match(connectedAt, /^[0-9T:.Z-]+$/);
  assert.match(seeded.channelAccountId, /^[0-9a-f-]{36}$/);
  await db.superuser(`SET session_replication_role = replica;
    UPDATE tenant_data.channel_account SET connected_at = '${connectedAt}' WHERE channel_account_id = '${seeded.channelAccountId}';`);
  // Остатки — тем же путём, что у продавца (как мир Kaufland стенда): источник, инвентаризация, буфер, включение — владелец со вторым фактором
  stock = new PgStockStore({ adminPool: db.pool('svc_admin', 2), stockPool: db.pool('svc_stock', 2) });
  const actor = { membershipId: seeded.ownerMembershipId, userId: seeded.userId, mfa: true };
  const source = await stock.createStockSource(seeded.tenantId, { mode: 'INTERNAL_POOL', name: 'Lager' }, actor);
  if (source.status !== 'CREATED') throw new Error(`stock source: ${source.status}`);
  const imported = await stock.importStock(seeded.tenantId, source.stockSourceId, [{ sku: String(ID_UNIT), quantity: ON_HAND }], actor);
  if (imported.status !== 'APPLIED' || imported.matched !== 1) throw new Error(`stock import: ${JSON.stringify(imported)}`);
  const enabled = await stock.enableStockSync(seeded.tenantId, seeded.channelAccountId, { bufferUnits: BUFFER, maxQuantity: null, minQuantityToList: 0, acknowledgeSideEffects: false }, actor);
  if (enabled.status !== 'ENABLED') throw new Error(`stock sync: ${enabled.status}`);
  await stock.recalculate(seeded.tenantId, null, new Date().toISOString() as never);
  // Модель канала: одна единица с amount 1 — заказ ровно один (K-11: заказ уменьшает amount, а без amount спрос не создаёт заказов)
  simulator = new SimulatedKauflandChannel({
    seed: 5801, webhookUrl: 'https://hooks.example.invalid/kaufland/wh_tok_synthetic_5801',
    units: [{ idUnit: ID_UNIT, storefront: 'de', idOffer: ID_OFFER, idProduct: ID_PRODUCT, listingPriceMinor: 1850, amount: 1 }],
    competitors: [{ sellerRef: 'Synthetic Competitor 5801', storefront: 'de', idProduct: ID_PRODUCT, priceMinor: 1800, behaviour: { kind: 'STATIC' } }],
    demand: { orderEveryMs: ORDER_AFTER_CONNECT_MS, shipAfterMs: 30 * 86_400_000, cancelShare: 0 },
    params: { buyBoxChanged: { delivered: false, debounceMs: 0, lossShare: 1 } },
  }, connectedAt);
  model = await startKauflandHttpModel({ simulator, seller: SELLER });
  // Секрет — как в работе: файл на ссылку учётных данных аккаунта (`secret-ref:synthetic` → `secret-ref_synthetic`)
  secretsDir = mkdtempSync(join(tmpdir(), 'repracer-channel-secrets-'));
  const [account] = await db.rows<{ credentials_ref: string }>('SELECT credentials_ref FROM tenant_data.channel_account WHERE channel_account_id = $1', [seeded.channelAccountId]);
  writeFileSync(join(secretsDir, account!.credentials_ref.replaceAll(':', '_')), JSON.stringify(SELLER), { mode: 0o600 });
});

after(async () => {
  await proc?.stop();
  await model?.close();
  if (secretsDir) rmSync(secretsDir, { recursive: true, force: true });
  await db?.drop();
});

const availableOnScreen = async () => {
  const page = await stock.stockPage(seeded.tenantId, { offset: 0, limit: 50 });
  const row = page.items.find((i) => i.productId === productId);
  assert.ok(row, 'товар мира есть на экране остатков');
  return { available: row.available, reserved: row.reserved, openReservations: page.summary.openReservations };
};

const quantityWrites = () => db.rows<{ version: string; quantity: number; status: string; origin: string }>(
  `SELECT w.version, w.quantity, w.status, w.origin FROM tenant_data.channel_write w JOIN tenant_data.write_scope s ON s.tenant_id = w.tenant_id AND s.write_scope_id = w.write_scope_id
    WHERE w.tenant_id = $1 AND w.field = 'QUANTITY' AND s.product_id = $2 ORDER BY w.version`, [seeded.tenantId, productId]);

test('шаг 58: производственный процесс планировщика читает заказ Kaufland по сети — резервация, доступное на экране остатков, запись количества', async () => {
  const before = await availableOnScreen();
  const writesBefore = await quantityWrites();
  assert.deepEqual([before.available, before.reserved, before.openReservations], [ON_HAND, 0, 0], 'до заказа: весь пул доступен, резерваций нет');
  assert.equal(writesBefore.at(-1)?.quantity, ON_HAND - BUFFER, 'до заказа: запись количества — пул минус буфер');

  const config = loadConfig({
    REPRACER_MODE: 'stand',
    REPRACER_SCHEDULER_PG_URL: db.url('svc_scheduler'), REPRACER_APP_PG_URL: db.url('svc_app'), REPRACER_STOCK_PG_URL: db.url('svc_stock'),
    REPRACER_EXPORTER_PG_URL: db.url('svc_exporter'),
    // Адрес, по которому никто не отвечает: выгрузке этого прогона он не нужен, процессу — нужен как конфигурация
    REPRACER_CH_URL: 'http://127.0.0.1:9', REPRACER_CH_INGEST_USER: 'syn-ingest', REPRACER_CH_INGEST_PASSWORD: 'syn-ingest',
    REPRACER_CH_VERIFIER_USER: 'syn-verifier', REPRACER_CH_VERIFIER_PASSWORD: 'syn-verifier',
    REPRACER_CHANNEL_SECRETS_DIR: secretsDir, REPRACER_KAUFLAND_BASE_URL: model.baseUrl, REPRACER_KAUFLAND_FALLBACK_EMAIL: 'ops@example.invalid',
    REPRACER_AMAZON_APPLICATION_CREDENTIALS_REF: 'secret-ref:amazon-application', REPRACER_SCHEDULER_HEARTBEAT: 'off', REPRACER_SCHEDULER_MAIL: 'off',
    REPRACER_SCHEDULER_METRICS_PORT: String(20_000 + Math.floor(Math.random() * 20_000)), REPRACER_SCHEDULER_TICK_MS: '1000',
  });
  const startedAt = Date.now();
  proc = await startScheduler(config, () => undefined);

  let reservations: Array<{ channel_order_ref: string; channel_order_line_ref: string; quantity: number; status: string }> = [];
  let attempts = 0;
  for (; attempts < 120 && reservations.length === 0; attempts++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    reservations = await db.rows('SELECT channel_order_ref, channel_order_line_ref, quantity, status FROM channel_data.reservation WHERE tenant_id = $1', [seeded.tenantId]);
  }
  const reservedAfterMs = Date.now() - startedAt;
  const runs = await db.rows<{ outcome: string; error_code: string | null; items: number | null }>(
    `SELECT outcome, error_code, items FROM maintenance.scheduled_job_run WHERE job_name = 'order-lines' ORDER BY started_at`);
  const orderReads = model.requests.get('GET /v2/order-units') ?? 0;
  console.log(JSON.stringify({ reservedAfterMs, attempts, orderReads, requests: Object.fromEntries(model.requests), ordersPlaced: simulator.stats.ordersPlaced, runs, violations: model.violations.slice(0, 5) }));

  assert.equal(simulator.stats.ordersPlaced, 1, 'модель приняла ровно один заказ');
  assert.ok(orderReads >= 1, `процесс читал заказы из модели по сети: GET /v2/order-units — ${orderReads}`);
  assert.deepEqual(model.violations.filter((v) => v.includes('/v2/order-units')), [], 'чтение заказов подписано ключами файла секрета и настоящим временем');
  assert.deepEqual(model.violations.filter((v) => /Signature|Client-Key|Timestamp|leaked/.test(v)), [], 'ни один запрос процесса не отвергнут проверкой подписи');
  // Р-25: источник остатка — внутренний пул, то есть мы сами: резервация подтверждается источником сразу (stock.ts, recordOrderLines)
  assert.deepEqual(reservations.map((r) => [r.channel_order_ref, r.channel_order_line_ref, r.quantity, r.status]), [['SYN-ORDER-1', '900001', 1, 'CONFIRMED_BY_SOURCE']],
    `резервация строки заказа модели (работа order-lines: ${JSON.stringify(runs)})`);

  const afterOrder = await availableOnScreen();
  assert.deepEqual([afterOrder.available, afterOrder.reserved, afterOrder.openReservations], [ON_HAND - 1, 1, 1], 'экран остатков: доступное меньше на количество заказа');
  const writesAfter = await quantityWrites();
  const latest = writesAfter.at(-1)!;
  /**
   * Ждущая запись прежней версии вытесняется новой [Р-64] и уходит в историю записей (0036) — поэтому сравнивается версия, а не число строк,
   * и вытеснение утверждается по истории: прежняя версия завершена `SUPERSEDED`, а не потеряна
   */
  assert.ok(Number(latest.version) > Number(writesBefore.at(-1)!.version), `после заказа создана новая версия записи количества: ${JSON.stringify({ before: writesBefore, after: writesAfter })}`);
  assert.equal(latest.origin, 'STOCK_RECALC');
  const history = await db.rows<{ version: string; quantity: number; final_status: string }>(
    `SELECT h.version, h.quantity, h.final_status FROM tenant_data.channel_write_history h JOIN tenant_data.write_scope s ON s.tenant_id = h.tenant_id AND s.write_scope_id = h.write_scope_id
      WHERE h.tenant_id = $1 AND h.field = 'QUANTITY' AND s.product_id = $2 ORDER BY h.version`, [seeded.tenantId, productId]);
  assert.deepEqual(history.map((h) => [Number(h.version), h.quantity, h.final_status]), [[Number(writesBefore.at(-1)!.version), ON_HAND - BUFFER, 'SUPERSEDED']],
    'прежняя запись количества вытеснена новой, а не отправлена и не потеряна');
  assert.equal(latest.quantity, ON_HAND - BUFFER - 1, 'запись количества — доступное после резервации минус буфер');
});
