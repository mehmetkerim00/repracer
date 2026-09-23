import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { SessionView, StandToken, WorldSummary } from '../src/api-types.ts';
import { messagesFor, type DecisionListView, type DecisionTrace, type ProductListView } from '@repracer/console-model';
import { createIsolatedDatabase, type IsolatedDatabase } from '../../../packages/pricing-store-pg/test/isolated-db.ts';
import { startConsole, type RunningConsole } from '../server/console-service.ts';

/**
 * Р-159, Р-160 (шаг 37): путь ГОСТЯ через развёртываемую консоль — как браузер [Р-136, Р-142]. Поднимается ТОТ ЖЕ
 * процесс, который поднимает промышленный профиль (`startConsole`), и прогон ходит по нему по HTTP: страница, файл
 * сборки, кнопка «посмотреть демо», экраны и, наконец, «почему эта цена».
 *
 * Второе, что здесь проверяется, и оно важнее первого: чего гость НЕ МОЖЕТ. Отказ приходит от БАЗЫ, а не от интерфейса —
 * поэтому прогон зовёт те же адреса, что кнопки экрана, и утверждает код ответа и причину.
 *
 * Данные синтетические: демо-тенант на симуляторе Kaufland [Р-151].
 */

/** Предел ответа ЭКРАНА [шаг 29]: дольше — продавец считает, что консоль зависла */
const SCREEN_LIMIT_SECONDS = 10;
/**
 * Сколько гость ждёт ПЕРВОГО решения в только что поднятом демо. Мир живёт настоящим временем, такт планировщика — 30 с,
 * поэтому ноль здесь недостижим; предел назван, чтобы «демо показывает пустые экраны» было провалом, а не привычкой.
 */
const FIRST_DECISION_LIMIT_SECONDS = 180;

let db: IsolatedDatabase;
let console_: RunningConsole;
let origin = '';
let guest = '';
let worldId = '';
/** Путь гостя: сколько запросов и сколько времени от кнопки до объяснения цены */
const journey: Array<{ step: string; method: string; url: string; seconds: number; status: number }> = [];
let secondsUntilFirstDecision = 0;

async function walk<T>(step: string, method: string, path: string, options: { token?: string; body?: unknown } = {}): Promise<{ status: number; body: T; text: string }> {
  const started = process.hrtime.bigint();
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: { ...(options.token ? { authorization: `Bearer ${options.token}` } : {}), ...(options.body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  journey.push({ step, method, url: path, seconds: Math.round(Number(process.hrtime.bigint() - started) / 1e6) / 1000, status: response.status });
  let body: T = undefined as T;
  try {
    body = JSON.parse(text) as T;
  } catch {
    // не JSON — страница или файл сборки: тело проверяется как текст
  }
  return { status: response.status, body, text };
}

before(async () => {
  db = await createIsolatedDatabase('guestdemo');
  /**
   * Окружение процесса — значениями: это режим стенда. В работе строки подключения приходят ФАЙЛАМИ, и именно так их
   * читает проверка конфигурации развёртывания (scripts/deploy-config-check.mjs) — здесь проверяется не она, а путь гостя.
   */
  const url = (login: Parameters<typeof db.url>[0]) => db.url(login);
  console_ = await startConsole({
    REPRACER_MODE: 'stand',
    REPRACER_CONSOLE_PORT: '0', REPRACER_CONSOLE_METRICS_PORT: '0',
    REPRACER_CONSOLE_DIST: new URL('../dist', import.meta.url).pathname,
    REPRACER_CONSOLE_PUBLIC_DEMO: 'on',
    REPRACER_CONSOLE_APP_PG_URL: url('svc_app'), REPRACER_CONSOLE_ADMIN_PG_URL: url('svc_admin'),
    REPRACER_CONSOLE_AUTHENTICATOR_PG_URL: url('svc_authenticator'), REPRACER_CONSOLE_ONBOARDING_PG_URL: url('svc_onboarding'),
    REPRACER_CONSOLE_PROVISIONING_PG_URL: url('svc_provisioning'), REPRACER_CONSOLE_DISPATCHER_PG_URL: url('svc_dispatcher'),
    REPRACER_CONSOLE_STOCK_PG_URL: url('svc_stock'), REPRACER_CONSOLE_SCHEDULER_PG_URL: url('svc_scheduler'),
    REPRACER_CONSOLE_EXPORTER_PG_URL: url('svc_exporter'), REPRACER_CONSOLE_FX_LOADER_PG_URL: url('svc_fx_loader'),
    REPRACER_CONSOLE_BULK_WORKER_PG_URL: url('svc_bulk_worker'),
  });
  origin = `http://127.0.0.1:${console_.port}`;
});

after(async () => {
  await console_?.close();
  await db?.drop();
  // Числа пути гостя — в журнал прогона: отчёт шага берёт их отсюда, а не пересказывает
  process.stdout.write(`${JSON.stringify({ guestJourney: journey, secondsUntilFirstDecision }, null, 1)}\n`);
});

test('Р-159: процесс отдаёт собранный интерфейс и говорит о своей работоспособности', async () => {
  const page = await walk<never>('index.html (страница)', 'GET', '/');
  assert.equal(page.status, 200, 'страница отдаётся тем же процессом, что API');
  assert.match(page.text, /<div id="root">/, 'это собранная страница консоли, а не заглушка');

  // Файл сборки берётся из САМОЙ страницы: так проверяется, что отдаётся именно то, на что она ссылается
  const asset = /src="([^"]+\.js)"/.exec(page.text)?.[1];
  assert.ok(asset, `страница ссылается на файл сборки: ${page.text.slice(0, 200)}`);
  const script = await walk<never>('файл сборки', 'GET', asset!);
  assert.equal(script.status, 200);
  assert.ok(script.text.length > 10_000, `файл сборки не пуст: ${script.text.length} байт`);

  /**
   * Выход за каталог сборки — адрес, которым читают чужие файлы у плохо написанных серверов. `..` пишется В КОДИРОВКЕ:
   * обычный `/../` нормализуют и браузер, и fetch, и проверка молча превратилась бы в обычную навигацию (так ошиблась
   * первая редакция этого прогона). Цель выбрана существующая — `apps/console/package.json` лежит РЯДОМ с каталогом
   * сборки: наивный сервер отдал бы его содержимое.
   */
  const escape = await walk<never>('выход за каталог сборки', 'GET', '/%2e%2e%2fpackage.json');
  assert.equal(escape.status, 404, `файл рядом с каталогом сборки не отдаётся: ${escape.text.slice(0, 120)}`);
  assert.doesNotMatch(escape.text, /@repracer\/console/, 'ответ не содержит файла вне каталога сборки');

  const health = await fetch(`http://127.0.0.1:${console_.metricsPort}/healthz`);
  assert.equal(health.status, 200, '/healthz отвечает 200 на отдельном порту');
});

test('Р-160: гость проходит от кнопки «посмотреть демо» до экрана «почему эта цена» без регистрации', async () => {
  const anonymous = await walk<SessionView>('session (аноним)', 'GET', '/api/session');
  assert.equal(anonymous.status, 200);
  assert.equal(anonymous.body.user, null, 'аноним не представлен');
  assert.equal(anonymous.body.demoGuest, true, 'кнопка «посмотреть демо» есть — публичное демо включено');

  const issued = await walk<StandToken>('demo/guest (кнопка «посмотреть демо»)', 'POST', '/api/demo/guest', { body: {} });
  assert.equal(issued.status, 200, issued.text);
  guest = issued.body.accessToken;

  const session = await walk<SessionView>('session (гость)', 'GET', '/api/session', { token: guest });
  assert.ok(session.body.user, 'гость представлен своей сессией');

  const worlds = await walk<WorldSummary[]>('worlds (список миров)', 'GET', '/api/worlds', { token: guest });
  assert.equal(worlds.status, 200, worlds.text);
  assert.equal(worlds.body.length, 1, 'гостю виден РОВНО один мир — демо, и ничей больше');
  assert.equal(worlds.body[0]!.demo, true, 'мир помечен как демо [Р-151]');
  // Роль в списке миров — текст словаря на языке ответа: сравнивается со значением того же словаря, а не с буквой 'VIEWER'
  assert.equal(worlds.body[0]!.role, messagesFor('de').values.VIEWER, 'роль гостя — наблюдатель, и её даёт членство из базы');
  worldId = worlds.body[0]!.id;

  const products = await walk<ProductListView>('products (товары)', 'GET', `/api/worlds/${encodeURIComponent(worldId)}/products`, { token: guest });
  assert.equal(products.status, 200, products.text);
  assert.ok(products.body.rows.length > 0, 'каталог демо не пуст');

  /**
   * Первое решение появляется НЕ мгновенно: демо живёт настоящим временем [Р-151], такт планировщика — 30 секунд, и до
   * первого такта экран решений пуст. Сколько именно ждёт гость — измеряется здесь, а не предполагается: число уходит в
   * отчёт шага. Если оно вырастет, прогон покраснеет, а не промолчит.
   */
  const waitStarted = Date.now();
  let decisions = await walk<DecisionListView>('decisions (решения)', 'GET', `/api/worlds/${encodeURIComponent(worldId)}/decisions`, { token: guest });
  for (let i = 0; i < FIRST_DECISION_LIMIT_SECONDS && decisions.body.items.length === 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    decisions = await walk<DecisionListView>('decisions (ожидание первого решения)', 'GET', `/api/worlds/${encodeURIComponent(worldId)}/decisions`, { token: guest });
  }
  secondsUntilFirstDecision = Math.round((Date.now() - waitStarted) / 100) / 10;
  assert.equal(decisions.status, 200, decisions.text);
  assert.ok(decisions.body.items.length > 0,
    `гость видит решения за ${FIRST_DECISION_LIMIT_SECONDS} с после подъёма демо, ждал ${secondsUntilFirstDecision} с`);

  const decisionId = decisions.body.items[0]!.decisionId;
  const why = await walk<DecisionTrace>('decisions/:id (почему эта цена)', 'GET', `/api/worlds/${encodeURIComponent(worldId)}/decisions/${decisionId}`, { token: guest });
  assert.equal(why.status, 200, why.text);
  assert.ok(why.body.steps.length >= 5, `объяснение показывает шаги решения: ${why.body.steps.length}`);

  const slowest = journey.filter((x) => !x.step.startsWith('decisions (ожидание')).reduce((a, b) => (a.seconds > b.seconds ? a : b));
  assert.ok(slowest.seconds <= SCREEN_LIMIT_SECONDS, `самый долгий шаг гостя: ${slowest.step} — ${slowest.seconds} с`);
});

test('Р-160: гость не может НИЧЕГО изменить — отказывает база, а не интерфейс', async () => {
  const w = encodeURIComponent(worldId);
  // Остановка цен: право STOP_PRICING, которого у наблюдателя нет
  const stop = await walk<{ error: { code: string } }>('stop (остановить цены)', 'POST', `/api/worlds/${w}/stop`,
    { token: guest, body: { target: { kind: 'TENANT' }, note: 'Gast versucht zu stoppen' } });
  assert.equal(stop.status, 403, stop.text);

  // Границы предложения: право MANAGE_PRICING
  const bounds = await walk<{ error: { code: string } }>('bounds/plan (экран различий границ)', 'POST', `/api/worlds/${w}/bounds/plan`,
    { token: guest, body: { offers: { all: true }, minPriceMinor: 100 } });
  assert.equal(bounds.status, 403, bounds.text);

  /**
   * Выгрузка доказательной истории — задание, которое «ничего не меняет», и право на него есть у ЛЮБОГО наблюдателя
   * [Р-143]. Гостю его не даёт база (0124): иначе публичная кнопка запускала бы 27 МБ работы исполнителя на каждого
   * посетителя. Это единственный путь записи, который был открыт наблюдателю, — и именно поэтому он проверяется.
   */
  const evidence = await walk<{ error: { code: string } }>('jobs (выгрузка доказательства)', 'POST', `/api/worlds/${w}/compliance/evidence`,
    { token: guest, body: { from: '2026-01-01', to: '2026-01-31' } });
  assert.ok(evidence.status >= 400, `гостю не дают создать задание: ${evidence.status} ${evidence.text.slice(0, 200)}`);

  // И ни одной строки задания от гостя в базе не осталось
  const jobs = await walk<{ items: unknown[] }>('jobs (список заданий)', 'GET', `/api/worlds/${w}/jobs`, { token: guest });
  assert.equal(jobs.status, 200, jobs.text);
  assert.equal(jobs.body.items.length, 0, 'ни одно задание гостя не создалось');
});
