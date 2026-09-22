import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { JobCreatedResponse, StandToken } from '../src/api-types.ts';
import type { BulkJobView, OnboardingView, StockDivergencesView, StockView } from '@repracer/console-model';
import { STAND_AUDIENCE, STAND_ISSUER, type LiveWorld } from '@repracer/contract-tests/stand';
import { demoWorld, DEMO_OFFERS, type DemoWorld } from '@repracer/contract-tests/live';
import { createAuthenticator, MemoryIdentityDirectory, staticJwks } from '@repracer/identity';
import { createTestIssuer } from '@repracer/identity/test-issuer';
import { PgPricingStore, PgStockStore, type PgPool } from '@repracer/pricing-store-pg';
import { createStockPipeline } from '@repracer/stock-sync';
import { createIsolatedDatabase, type IsolatedDatabase } from '../../../packages/pricing-store-pg/test/isolated-db.ts';
import { createStandApi, createStandServer } from '../server/stand-server.ts';
import type { BulkWorkerConfig } from '../server/bulk-worker.ts';

/**
 * Р-152 (шаг 35): путь «только остатки» живым прогоном через консоль как браузер [Р-136, Р-142] — от пустого пути до
 * записи остатка, ПОДТВЕРЖДЁННОЙ каналом (симулятор Kaufland шага 21), без единого ввода себестоимости и без единого
 * упоминания стратегий на пути. Второй источник — Inbound API: ключ, устаревшее значение, распространение в канал.
 * Данные синтетические.
 */

const WORLD = 'demo/kaufland';
const LEASE_SECONDS = 5;
const APPLY_LIMIT_SECONDS = 120;

let db: IsolatedDatabase;
let demo: DemoWorld;
let server: Server;
let origin: string;
let owner: { authorization: string; cookie: string };
let observer: PgPool;
const workers: ChildProcess[] = [];
let workerConfigPath = '';
/** Сколько запросов сделал продавец и сколько прошло времени — ответ на «сколько шагов и минут до работающей синхронизации» */
const journey: Array<{ step: string; method: string; url: string; seconds: number; status: number }> = [];
let journeyStart = 0;
/** Ключ Inbound API, выданный вторым тестом: третий шлёт им остаток единицы, которой в канале уже нет */
let inboundKey = '';

const api = (screen: string, param?: string) => `/api/worlds/${encodeURIComponent(WORLD)}/${screen}${param ? `/${param}` : ''}`;

async function call(method: 'GET' | 'POST', url: string, body?: unknown, auth = owner): Promise<{ status: number; text: string }> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const r = await fetch(`${origin}${url}`, { method, headers: { ...(auth.authorization ? { authorization: auth.authorization } : {}), cookie: auth.cookie, ...(payload ? { 'content-type': 'application/json' } : {}) }, ...(payload === undefined ? {} : { body: payload }) });
  return { status: r.status, text: await r.text() };
}

async function step<T>(name: string, method: 'GET' | 'POST', url: string, body?: unknown): Promise<{ status: number; body: T }> {
  const started = process.hrtime.bigint();
  const r = await call(method, url, body);
  journey.push({ step: name, method, url, seconds: Math.round(Number(process.hrtime.bigint() - started) / 1e6) / 1000, status: r.status });
  return { status: r.status, body: (r.text ? JSON.parse(r.text) : null) as T };
}

async function pollJob(jobId: string): Promise<BulkJobView> {
  const deadline = Date.now() + APPLY_LIMIT_SECONDS * 1000;
  for (;;) {
    const r = await call('GET', api('jobs', jobId));
    assert.equal(r.status, 200, r.text);
    const job = JSON.parse(r.text) as BulkJobView;
    if (job.status === 'SUCCEEDED' || job.status === 'FAILED') return job;
    if (Date.now() > deadline) throw new Error(`bulk job ${jobId} stayed ${job.status}/${job.headline}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const NO_PRICING_WORDS = /Strateg|Selbstkosten|Einstandspreis|Grenzen|Repricing|Preisregel|min_price|max_price/;

before(async () => {
  db = await createIsolatedDatabase('stockonly');
  const appPool: PgPool = db.pool('svc_app', 4);
  const adminPool: PgPool = db.pool('svc_admin', 4);
  const tomorrow = new Date(Date.now() + 24 * 3_600_000);
  const startIso = new Date(Date.UTC(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth(), tomorrow.getUTCDate(), 9, 0, 0)).toISOString();
  // bare: true — предложения как пришли с канала; ни себестоимости, ни границ, ни стратегий здесь не появится
  demo = await demoWorld({
    tag: 3502, startIso, bare: true, appPool, adminPool, provisioningPool: db.pool('svc_provisioning', 1), dispatcherPool: db.pool('svc_dispatcher', 2),
    schedulerPool: db.pool('svc_scheduler', 3), exporterPool: db.pool('svc_exporter', 2), stockPool: db.pool('svc_stock', 2),
  });
  const seeded = demo.live.seeded;
  const store = new PgPricingStore(appPool, { adminPool, bulkWorkerPool: db.pool('svc_bulk_worker', 2) });
  const stock = new PgStockStore({ adminPool, stockPool: db.pool('svc_stock', 2) });
  // Записи остатка отправляет диспетчер мира — тот же, что отправляет цены [Р-64]
  const stockPipeline = createStockPipeline({ store: stock, now: () => demo.clock.iso() as never, dispatchScope: (t, ws) => demo.live.dispatchScope(t, ws) });
  const nowIso = () => demo.clock.iso();
  const accounts = [{ channelAccountId: seeded.channelAccountId, channel: 'KAUFLAND', marketplaces: ['de'], haltRelease: 'SAMPLE' as const }];
  const live: LiveWorld = {
    id: WORLD, title: 'Демо: Kaufland на симуляторе', description: `${DEMO_OFFERS} предложений`, tenantId: seeded.tenantId,
    accounts, identityTenantId: seeded.tenantId, membershipAlias: (id) => id, failures: [],
    store: store as never, stock, stockPipeline, pipeline: demo.live.pipelineForDbIds() as never, clock: { iso: nowIso, nowMs: () => demo.clock.nowMs() } as never,
    callContext: (channelAccountId) => ({ tenantId: seeded.tenantId as never, channelAccountId: channelAccountId as never, correlationId: 'stock-only-live', deadline: nowIso() }),
    view: async (viewer) => ({
      id: WORLD, title: 'Демо: Kaufland на симуляторе', description: `${DEMO_OFFERS} предложений`, tenantId: seeded.tenantId, now: nowIso(),
      accounts, viewer: { ...viewer }, state: await store.readConsoleState(seeded.tenantId, nowIso() as never),
    }) as never,
  };
  const directory = new MemoryIdentityDirectory();
  directory.link({ issuer: STAND_ISSUER, subject: 'demo-owner' }, seeded.userId);
  directory.addMembership(seeded.userId, { tenantId: seeded.tenantId, membershipId: seeded.ownerMembershipId, role: 'OWNER' });
  const issuer = createTestIssuer({ issuer: STAND_ISSUER, audience: STAND_AUDIENCE });
  const handle = createStandApi([live], {
    authenticator: createAuthenticator({ issuer: STAND_ISSUER, audience: STAND_AUDIENCE, jwks: staticJwks(issuer.jwks), directory }),
    simulator: { token: () => issuer.token('demo-owner', { email: 'owner@example.invalid', amr: ['pwd', 'otp'] }), expiresInSeconds: 3600 },
  });
  server = createStandServer(handle);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const token = await fetch(`${origin}/api/stand-issuer/token?locale=de`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: 'OWNER' }) });
  owner = { authorization: `Bearer ${((await token.json()) as StandToken).accessToken}`, cookie: 'repracer_locale=de' };
  const observerUrl = new URL(process.env.REPRACER_PG_ADMIN_URL!); observerUrl.pathname = `/${db.name}`;
  const { createPool } = await import('@repracer/pricing-store-pg');
  observer = createPool(observerUrl.toString(), { max: 1, applicationName: 'repracer-stock-only-observer' });
  const config: BulkWorkerConfig = {
    pgUrl: db.url('svc_app'), leaseSeconds: LEASE_SECONDS, progressEverySeconds: 1, idleMs: 100,
    worlds: [{ descriptor: { id: WORLD, title: 'Демо', description: '', tenantId: seeded.tenantId, accounts }, now: 'WALL_CLOCK' }],
  };
  workerConfigPath = join(mkdtempSync(join(tmpdir(), 'repracer-stock-only-')), 'worker.json');
  writeFileSync(workerConfigPath, JSON.stringify(config), 'utf8');
  const child = spawn(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', fileURLToPath(new URL('../server/bulk-worker.ts', import.meta.url))],
    { env: { ...process.env, BULK_WORKER_CONFIG: workerConfigPath }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr?.on('data', (chunk: Buffer) => console.error('bulk-worker:', chunk.toString().trim()));
  workers.push(child);
  journeyStart = Date.now();
});

after(async () => {
  console.log(JSON.stringify({ journey, totalSeconds: Math.round((Date.now() - journeyStart) / 100) / 10 }, null, 1));
  for (const child of workers) child.kill('SIGKILL');
  server?.close();
  await observer?.end();
  await db?.drop();
});

test('Р-152: путь «только остатки» — от выбора пути до записи остатка, подтверждённой каналом', async () => {
  // 1. Путь не выбран: экран предлагает два пути, и на нём нет «готово»
  let view = (await step<OnboardingView>('экран пути', 'GET', api('onboarding'))).body;
  assert.deepEqual([view.path, view.choices.map((c) => c.path), view.resumeAt === 'DONE'], [null, ['STOCK', 'STOCK_AND_PRICING'], false]);
  // 2. Выбор — «остатки»
  assert.equal((await step('выбор пути «остатки»', 'POST', api('onboarding', 'path'), { path: 'STOCK' })).status, 200);
  view = (await step<OnboardingView>('экран пути', 'GET', api('onboarding'))).body;
  assert.deepEqual(view.steps.map((s) => s.step), ['TENANT', 'CHANNEL', 'STOCK_SOURCE', 'STOCK_SYNC'], 'на пути остатков четыре шага');
  assert.equal(view.resumeAt, 'STOCK_SOURCE');
  // Ни одного упоминания стратегий, себестоимости и границ — по всему ответу экрана пути, на языке продавца
  assert.ok(!NO_PRICING_WORDS.test(JSON.stringify(view)), `на пути остатков нет слов о ценах: ${JSON.stringify(view).slice(Math.max(0, (JSON.stringify(view).search(NO_PRICING_WORDS)) - 120), (JSON.stringify(view).search(NO_PRICING_WORDS)) + 60)}`);

  // 3. Источник — файл: артикулы канала и количество
  const source = await step<{ stockSourceId: string; apiKey: string | null }>('источник: внутренний пул', 'POST', api('stock', 'sources'), { mode: 'INTERNAL_POOL', name: 'Lager Hamburg' });
  assert.equal(source.status, 200, JSON.stringify(source.body));
  assert.equal(source.body.apiKey, null, 'у файлового источника ключа нет');
  const skus = Array.from({ length: DEMO_OFFERS }, (_, i) => String(340_100_001 + i).slice(-6));
  const csv = ['Artikelnummer;Bestand', ...skus.map((sku, i) => `${sku};${10 + (i % 7)}`), 'nicht-da;5'].join('\r\n');
  const created = await step<JobCreatedResponse>('файл остатков (задание)', 'POST', api('stock', 'import'), { fileName: 'bestand.csv', content: Buffer.from(csv, 'utf8').toString('base64'), stockSourceId: source.body.stockSourceId });
  assert.equal(created.status, 200, JSON.stringify(created.body).slice(0, 300));
  const imported = await pollJob(created.body.jobId);
  assert.equal(imported.status, 'SUCCEEDED', imported.error ?? imported.headline);
  const importView = (imported.result as { view: { matched: number; changed: number; unmatched: number; writes: number } }).view;
  assert.deepEqual([importView.matched, importView.changed, importView.unmatched, importView.writes], [DEMO_OFFERS, DEMO_OFFERS, 1, 0], 'все 200 строк применены, одна не найдена; записей ещё нет — синхронизация не включена');
  view = (await step<OnboardingView>('экран пути', 'GET', api('onboarding'))).body;
  assert.equal(view.resumeAt, 'STOCK_SYNC', `источник отдал остаток — дальше синхронизация: ${view.resumeText}`);

  // 4. Ловушка канала названа ДО включения; включение с буфером 2
  let stockScreen = (await step<StockView>('экран остатков', 'GET', api('stock'))).body;
  assert.ok(stockScreen.traps.some((t) => t.channel === 'KAUFLAND' && /id_offer/.test(t.text)), 'ловушка Kaufland названа до записи');
  assert.deepEqual([stockScreen.summary.products, stockScreen.summary.withStock, stockScreen.summary.synced], [DEMO_OFFERS, DEMO_OFFERS, 0]);
  const enableJob = await step<JobCreatedResponse>('включение синхронизации (задание)', 'POST', api('stock', 'enable'),
    { channelAccountId: demo.live.seeded.channelAccountId, bufferUnits: 2, maxQuantity: null, minQuantityToList: 0 });
  assert.equal(enableJob.status, 200, JSON.stringify(enableJob.body).slice(0, 300));
  const enabledJob = await pollJob(enableJob.body.jobId);
  assert.equal(enabledJob.status, 'SUCCEEDED', enabledJob.error ?? enabledJob.headline);
  const enabled = (enabledJob.result as { view: { scopes: number; created: number; writes: number } }).view;
  assert.deepEqual([enabled.scopes, enabled.created, enabled.writes], [DEMO_OFFERS, DEMO_OFFERS, DEMO_OFFERS]);
  const syncEnabledAt = Date.now();
  view = (await step<OnboardingView>('экран пути', 'GET', api('onboarding'))).body;
  assert.equal(view.resumeAt, 'DONE', `путь остатков пройден: ${view.resumeText}`);
  assert.ok(!NO_PRICING_WORDS.test(JSON.stringify(view)), 'и пройденный путь — без слов о ценах');

  // 5. Записи уходят в канал диспетчером, канал подтверждает обратным чтением — как у цен. Клиентский бюджет адаптера
  // (25 запросов в секунду, K-04) пропускает не всё сразу: остальное уходит повтором, когда проходит время, — как в жизни
  for (let i = 0; i < 20; i++) { await demo.live.betweenTicks(); demo.clock.advance(30_000); }
  stockScreen = (await step<StockView>('экран остатков после записи', 'GET', api('stock'))).body;
  assert.deepEqual([stockScreen.summary.synced, stockScreen.summary.pendingWrites, stockScreen.summary.diverged], [DEMO_OFFERS, 0, 0], JSON.stringify(stockScreen.summary));
  // Ожидаемое выведено из ФАЙЛА продавца, а не из экрана: строка i несла 10 + i mod 7, буфер 2, заказов на этом пути нет
  const fromFile = new Map(skus.map((sku, i) => [`syn-prod-de-340${sku}`, 10 + (i % 7) - 2]));
  assert.equal(stockScreen.rows.length, 50);
  for (const r of stockScreen.rows) {
    const c = r.channels[0]!;
    assert.equal(c.published, fromFile.get(r.sku), `${r.sku}: публикуемое = количество из файла − буфер`);
    assert.ok(/bestätigt/.test(c.confirmedText) && c.tone === 'ok', `${r.sku}: канал подтвердил: ${c.confirmedText}`);
  }
  // Подтверждение — настоящее: в симуляторе канала у единиц ровно то количество, что мы отправили
  const units = (demo.live.simulator.dump() as { units: Array<{ idUnit: number; amount: number }> }).units;
  // Товар мира — `prod-de-<id товара>`, единица канала — последние шесть цифр того же id; страница экрана — 50 строк, канал — 200
  const allRows = (await step<StockView>('экран остатков (все страницы)', 'GET', `${api('stock')}?limit=200`)).body.rows;
  const bySku = new Map(allRows.map((r) => [r.sku, r.channels[0]!.published]));
  assert.equal(allRows.length, DEMO_OFFERS);
  for (const u of units) {
    const sku = `syn-prod-de-340${u.idUnit}`;
    assert.equal(u.amount, bySku.get(sku) ?? -1, `единица ${u.idUnit}: количество в канале равно отправленному`);
  }
  const [applied] = (await observer.query(`SELECT count(*)::int AS n FROM tenant_data.channel_write_history WHERE field = 'QUANTITY' AND final_status = 'APPLIED'`)).rows;
  assert.equal(Number(applied.n), DEMO_OFFERS, 'каждая запись остатка подтверждена каналом');
  const divergences = (await step<StockDivergencesView>('расхождения', 'GET', api('stock', 'divergences'))).body;
  assert.deepEqual(divergences.items, []);
  console.log(JSON.stringify({ secondsToConfirmedSync: Math.round((Date.now() - journeyStart) / 100) / 10, secondsFromEnableToConfirmed: Math.round((Date.now() - syncEnabledAt) / 100) / 10 }));

  // 6. Себестоимости и стратегий не появилось — путь остатков их не требует [Р-152]
  const [pricing] = (await observer.query(`SELECT (SELECT count(*) FROM tenant_data.cost_profile)::int AS costs, (SELECT count(*) FROM tenant_data.pricing_strategy)::int AS strategies,
                                                  (SELECT count(*) FROM tenant_data.write_scope WHERE field = 'PRICE' AND pricing_mode = 'ENGINE')::int AS engines`)).rows;
  assert.deepEqual([pricing.costs, pricing.strategies, pricing.engines], [0, 0, 0]);
});

test('Inbound API: ключ показан один раз; устаревшее значение не применяется; новое доходит до канала', async () => {
  const bad = await call('POST', '/inbound/v1/stock', { rows: [{ sku: '100001', quantity: 1, asOf: new Date().toISOString() }] }, { authorization: 'Bearer rpk_000000000000.0000000000000000000000000000000000000000000000000000', cookie: '' });
  assert.equal(bad.status, 401, 'неверный ключ — 401');
  const source = await step<{ stockSourceId: string; apiKey: string | null }>('источник: Inbound API', 'POST', api('stock', 'sources'), { mode: 'INBOUND_API', name: 'WMS' });
  assert.equal(source.status, 200);
  const key = source.body.apiKey!;
  inboundKey = key;
  assert.match(key, /^rpk_/);
  const sku = String(340_100_001).slice(-6);
  const t1 = '2026-09-23T10:00:00.000Z';
  const first = await call('POST', '/inbound/v1/stock', { rows: [{ sku, quantity: 30, asOf: t1 }, { sku: 'nope', quantity: 1, asOf: t1 }] }, { authorization: `Bearer ${key}`, cookie: '' });
  assert.equal(first.status, 200, first.text);
  assert.deepEqual(JSON.parse(first.text), { applied: 1, stale: 0, unknownSkus: ['nope'], writes: 1 });
  const stale = await call('POST', '/inbound/v1/stock', { rows: [{ sku, quantity: 5, asOf: '2026-09-23T09:00:00.000Z' }] }, { authorization: `Bearer ${key}`, cookie: '' });
  assert.deepEqual(JSON.parse(stale.text), { applied: 0, stale: 1, unknownSkus: [], writes: 0 });
  for (let i = 0; i < 10; i++) { await demo.live.betweenTicks(); demo.clock.advance(30_000); }
  const screen = (await step<StockView>('экран остатков', 'GET', api('stock'))).body;
  const row = screen.rows.find((r) => r.sku === 'syn-prod-de-340100001')!;
  // Два пула одного товара складываются [Р-6]: файл 10 + Inbound 30 = 40, буфер 2 → 38, и канал это подтвердил
  assert.deepEqual([row.onHand, row.channels[0]!.published, row.channels[0]!.tone], [40, 38, 'ok'], JSON.stringify(row));
  const unit = (demo.live.simulator.dump() as { units: Array<{ idUnit: number; amount: number }> }).units.find((u) => String(u.idUnit) === sku)!;
  assert.equal(unit.amount, 38, 'новое количество дошло до канала');
});

test('Р-153: канал перестал принимать запись — расхождение «у нас / в канале» появляется и названо', async () => {
  // Продавец удалил единицу в кабинете канала — обычная жизнь. У нас остаток есть, канал его больше не примет
  const sku = String(340_100_002).slice(-6);
  const productSku = `syn-prod-de-340${sku}`;
  assert.equal(demo.live.simulator.removeUnit(Number(sku)), 1, 'единица была в канале и удалена продавцом');
  const pushed = await call('POST', '/inbound/v1/stock', { rows: [{ sku, quantity: 77, asOf: '2026-09-23T12:00:00.000Z' }] }, { authorization: `Bearer ${inboundKey}`, cookie: '' });
  assert.deepEqual(JSON.parse(pushed.text), { applied: 1, stale: 0, unknownSkus: [], writes: 1 }, pushed.text);
  for (let i = 0; i < 10; i++) { await demo.live.betweenTicks(); demo.clock.advance(30_000); }

  // Отдельный список расхождений: ровно эта единица, с тем, что отправлено, что подтверждено и почему не применено
  const divergences = (await step<StockDivergencesView>('расхождения (есть)', 'GET', api('stock', 'divergences'))).body;
  assert.equal(divergences.items.length, 1, JSON.stringify(divergences.items).slice(0, 400));
  const item = divergences.items[0]!;
  assert.deepEqual([item.sku, item.status, item.errorCode, item.channel], [productSku, 'DISCARDED_STALE', 'NOT_FOUND', 'KAUFLAND'], JSON.stringify(item));
  // Расхождение НАЗВАНО словами продавца: и отправленное количество, и то, что канал его не принял
  assert.match(item.text, new RegExp(String(item.sent)), item.text);
  assert.ok(item.text !== divergences.none && /[A-Za-zА-Яа-я]{4}/.test(item.text), `текст расхождения — не заглушка: ${item.text}`);

  // Та же строка на экране остатков: счётчик, бейдж строки и тон — одно правило расхождения на три места
  const screen = (await step<StockView>('экран остатков с расхождением', 'GET', `${api('stock')}?limit=200`)).body;
  assert.equal(screen.summary.diverged, 1, JSON.stringify(screen.summary));
  const row = screen.rows.find((r) => r.sku === productSku)!;
  assert.equal(row.channels[0]!.tone, 'stop', JSON.stringify(row.channels[0]));
  assert.ok(row.channels[0]!.divergedText && row.channels[0]!.divergedText.length > 0, 'строка товара называет расхождение');
  assert.equal(row.channels.filter((c) => c.divergedText !== null).length, 1);
  // У остальных 199 товаров расхождения нет — список не «всё подряд»
  assert.equal(screen.rows.filter((r) => r.channels.some((c) => c.divergedText !== null)).length, 1, 'расхождение только у своей единицы');

  // Расхождение показано именно потому, что повтора нет: пока запись в полёте, продавцу показывают ход, а не расхождение
  const [inFlight] = (await observer.query(`SELECT count(*)::int AS n FROM tenant_data.channel_write WHERE field = 'QUANTITY'`)).rows;
  assert.equal(Number(inFlight.n), 0, 'неприменённая запись завершена, повтора в полёте нет — иначе это был бы ход, а не расхождение');
});
