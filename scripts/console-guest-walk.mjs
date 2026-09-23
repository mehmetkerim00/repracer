#!/usr/bin/env node
// Р-159, Р-160 (шаг 37): путь ГОСТЯ через поднятый профиль production — как браузер [Р-142]. Прогон ходит ТОЛЬКО через
// обратный прокси: адрес консоли ему не известен, заголовков, которых не послала бы страница, он не посылает.
//
// Проверяется ровно то, что обещает шаг: прокси отдаёт консоль (а не 503), гость входит без регистрации, доходит до
// экрана «почему эта цена» и не может изменить НИЧЕГО. Данные синтетические: демо-тенант на симуляторе.
//
// Использование: node scripts/console-guest-walk.mjs http://127.0.0.1:8080
const base = process.argv[2] ?? 'http://127.0.0.1:8080';
/** Предел ответа экрана [шаг 29]: дольше — продавец считает, что консоль зависла */
const SCREEN_LIMIT_SECONDS = 10;
/** Первое решение в только что поднятом демо: мир живёт настоящим временем, такт планировщика — 30 с */
const FIRST_DECISION_LIMIT_SECONDS = 180;

const journey = [];
const problems = [];
const check = (ok, what) => { if (!ok) problems.push(what); };

async function walk(step, method, path, { token, body } = {}) {
  const started = process.hrtime.bigint();
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  const seconds = Math.round(Number(process.hrtime.bigint() - started) / 1e6) / 1000;
  journey.push({ step, method, url: path, seconds, status: response.status });
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  return { status: response.status, body: parsed, text };
}

const page = await walk('index.html (страница через прокси)', 'GET', '/');
check(page.status === 200, `страница отдаётся прокси: ${page.status}`);
check(/<div id="root">/.test(page.text), 'прокси отдаёт консоль, а не заглушку 503');

const asset = /src="([^"]+\.js)"/.exec(page.text)?.[1];
check(Boolean(asset), 'страница ссылается на файл сборки');
if (asset) {
  const script = await walk('файл сборки', 'GET', asset);
  check(script.status === 200 && script.text.length > 10_000, `файл сборки отдан: ${script.status}, ${script.text.length} байт`);
}

const anonymous = await walk('session (аноним)', 'GET', '/api/session');
check(anonymous.body?.user === null, 'аноним не представлен');
check(anonymous.body?.demoGuest === true, 'кнопка «посмотреть демо» есть');

const issued = await walk('demo/guest (кнопка «посмотреть демо»)', 'POST', '/api/demo/guest', { body: {} });
check(issued.status === 200, `гость получил сессию: ${issued.status} ${issued.text.slice(0, 200)}`);
const token = issued.body?.accessToken;

const worlds = await walk('worlds (список миров)', 'GET', '/api/worlds', { token });
check(worlds.status === 200 && Array.isArray(worlds.body) && worlds.body.length === 1, `гостю виден ровно один мир: ${worlds.text.slice(0, 200)}`);
check(worlds.body?.[0]?.demo === true, 'мир помечен как демо [Р-151]');
const world = encodeURIComponent(worlds.body?.[0]?.id ?? '');

const products = await walk('products (товары)', 'GET', `/api/worlds/${world}/products`, { token });
check(products.status === 200 && (products.body?.rows?.length ?? 0) > 0, `каталог демо не пуст: ${products.status}`);

const waitStarted = Date.now();
let decisions = await walk('decisions (решения)', 'GET', `/api/worlds/${world}/decisions`, { token });
for (let i = 0; i < FIRST_DECISION_LIMIT_SECONDS && (decisions.body?.items?.length ?? 0) === 0; i++) {
  await new Promise((resolve) => setTimeout(resolve, 1000));
  decisions = await walk('decisions (ожидание первого решения)', 'GET', `/api/worlds/${world}/decisions`, { token });
}
const secondsUntilFirstDecision = Math.round((Date.now() - waitStarted) / 100) / 10;
check((decisions.body?.items?.length ?? 0) > 0, `гость видит решения (ждал ${secondsUntilFirstDecision} с)`);

const decisionId = decisions.body?.items?.[0]?.decisionId;
if (decisionId) {
  const why = await walk('decisions/:id (почему эта цена)', 'GET', `/api/worlds/${world}/decisions/${decisionId}`, { token });
  check(why.status === 200 && (why.body?.steps?.length ?? 0) >= 5, `объяснение цены показано: ${why.status}, шагов ${why.body?.steps?.length ?? 0}`);
}

// Чего гость не может. Отказывает БАЗА (0124) — консоль только доносит отказ
const stop = await walk('stop (остановить цены)', 'POST', `/api/worlds/${world}/stop`, { token, body: { target: { kind: 'TENANT' }, note: 'Gast versucht zu stoppen', confirmed: true } });
check(stop.status === 403, `остановка цен гостю запрещена: ${stop.status}`);
const bounds = await walk('bounds/plan (экран различий границ)', 'POST', `/api/worlds/${world}/bounds/plan`, { token, body: { offers: { all: true }, minPriceMinor: 100 } });
check(bounds.status === 403, `правка границ гостю запрещена: ${bounds.status}`);
const evidence = await walk('compliance/evidence (выгрузка доказательства)', 'POST', `/api/worlds/${world}/compliance/evidence`, { token, body: { from: '2026-01-01', to: '2026-01-31' } });
check(evidence.status >= 400, `задание гостю запрещено: ${evidence.status}`);
const jobs = await walk('jobs (список заданий)', 'GET', `/api/worlds/${world}/jobs`, { token });
check((jobs.body?.items?.length ?? 0) === 0, `ни одного задания гостя: ${jobs.text.slice(0, 200)}`);

const screens = journey.filter((x) => !x.step.startsWith('decisions (ожидание'));
const slowest = screens.reduce((a, b) => (a.seconds > b.seconds ? a : b));
check(slowest.seconds <= SCREEN_LIMIT_SECONDS, `самый долгий шаг гостя: ${slowest.step} — ${slowest.seconds} с`);

console.log(JSON.stringify({ guestJourney: journey, secondsUntilFirstDecision, slowest }, null, 1));
if (problems.length > 0) {
  for (const p of problems) console.error(`GUEST WALK RED: ${p}`);
  process.exit(1);
}
console.log(`GUEST WALK: ${journey.length} запросов через прокси, самый долгий ${slowest.seconds} с, первое решение через ${secondsUntilFirstDecision} с`);
