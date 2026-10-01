import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStaticHandler } from '../server/static.ts';

/**
 * Р-159 (шаг 37): отдача собранного интерфейса. Шаг 38 — две находки ревью шага 37, обе про ПУБЛИЧНЫЙ адрес: консоль
 * теперь смотрит в интернет, и «почти правильно» здесь означает «отдаём чужой файл».
 *
 * Проверяется поведение на НАСТОЯЩЕМ каталоге с настоящей символической ссылкой: подменить `statSync` и поверить себе
 * было бы проверкой собственной подмены [Р-94]. Данные синтетические.
 */

let dir = '';
let dist = '';
let serve: ReturnType<typeof createStaticHandler>;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'repracer-static-'));
  dist = join(dir, 'dist');
  mkdirSync(join(dist, 'assets'), { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<!doctype html><div id="root"></div>');
  writeFileSync(join(dist, 'assets', 'app-8f3c1a2b.js'), 'console.log(1)');
  // Секрет РЯДОМ с каталогом сборки: ровно так он лежит на сервере (`/run/secrets` рядом с `/app`)
  writeFileSync(join(dir, 'app_pg_url'), 'postgres://svc_app:SECRET@db/repracer_eu');
  // Ссылка ВНУТРИ каталога сборки, указывающая наружу: сборка таких не делает — это либо ошибка, либо попытка
  symlinkSync(join(dir, 'app_pg_url'), join(dist, 'secret.json'));
  symlinkSync(dir, join(dist, 'up'));
  serve = createStaticHandler(dist);
});

after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test('находка 2 шага 37: символическая ссылка из каталога сборки наружу не отдаёт файл', () => {
  const direct = serve('/secret.json');
  assert.equal(direct?.status, 404, 'файл по ссылке наружу не отдаётся');
  assert.doesNotMatch(direct?.body.toString() ?? '', /SECRET/, 'содержимое секрета не попадает в ответ');

  // Через ссылку на КАТАЛОГ — тот же ответ: путь текстом остаётся внутри, наружу уводит разыменование
  const viaDir = serve('/up/app_pg_url');
  assert.equal(viaDir?.status, 404, 'ссылка на каталог наружу тоже не отдаёт файл');
  assert.doesNotMatch(viaDir?.body.toString() ?? '', /SECRET/);

  // Положительный контроль: обычный файл сборки по-прежнему отдаётся, иначе «404 на всё» выглядело бы как защита
  const asset = serve('/assets/app-8f3c1a2b.js');
  assert.equal(asset?.status, 200);
  assert.match(asset!.contentType, /javascript/);
  assert.equal(asset!.cacheControl, 'public, max-age=31536000, immutable', 'файл с отпечатком кэшируется навсегда');
});

test('находка 3 шага 37: адрес, похожий на файл, получает 404 — а не страницу с кодом 200', () => {
  for (const path of ['/robots.txt', '/config.yaml', '/.env', '/assets/app-нет.js']) {
    const r = serve(path);
    assert.equal(r?.status, 404, `${path}: страницы вместо файла быть не должно`);
    assert.doesNotMatch(r?.contentType ?? '', /html/, `${path}: и тип ответа не html`);
  }

  // Навигация страницы (расширения нет) по-прежнему получает index.html: у страницы свои маршруты
  for (const path of ['/', '/w/demo%2Fkaufland/products', '/jobs']) {
    const r = serve(path);
    assert.equal(r?.status, 200, `${path}: навигация отдаёт страницу`);
    assert.match(r!.contentType, /html/);
    assert.match(r!.body.toString(), /<div id="root">/);
    assert.equal(r!.cacheControl, 'no-cache', 'страница не кэшируется: иначе браузер покажет старую поверх нового API');
  }
});

test('шаг 37: выход за каталог сборки закрыт и в кодировке, и точками', () => {
  /**
   * `..` в начале пути нормализация съедает — адрес становится обычным маршрутом страницы, и страница на него
   * отвечает. Важно здесь не число ответа, а то, что содержимого ЧУЖОГО файла в нём нет никогда.
   */
  for (const path of ['/%2e%2e%2fapp_pg_url', '/../app_pg_url', '/..%2f..%2fetc%2fpasswd', '/%00/index.html', '/up/app_pg_url']) {
    const r = serve(path);
    assert.doesNotMatch(r?.body.toString() ?? '', /SECRET/, `${path}: содержимое секрета не отдано`);
    assert.doesNotMatch(r?.body.toString() ?? '', /root:/, `${path}: содержимое системного файла не отдано`);
  }
  // Путь с нулевым байтом не обрабатывается вовсе: такие имена файлов не бывают у сборки
  assert.equal(serve('/index\u0000.html'), null, 'адрес с нулевым байтом отвергается до обращения к файловой системе');
});

/**
 * Шаг 52 (OWASP A05, самопроверка): заголовки безопасности у страницы, у API и у ответа об ошибке — через настоящий HTTP-слой консоли
 */
test('step 52: the page, the API and an error answer carry the security headers of the console', async () => {
  const { createStandServer, SECURITY_HEADERS } = await import('../server/stand-server.ts');
  const handle = (async () => ({ status: 401, body: { error: { code: 'UNAUTHENTICATED', message: 'sign in' } } })) as never;
  const server = createStandServer(handle, 'en', serve);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  try {
    const { port } = server.address() as { port: number };
    for (const path of ['/', '/api/v1/worlds', '/robots.txt']) {
      const r = await fetch(`http://127.0.0.1:${port}${path}`);
      await r.arrayBuffer();
      for (const [name, value] of Object.entries(SECURITY_HEADERS)) assert.equal(r.headers.get(name), value, `${path}: ${name}`);
    }
    assert.match(SECURITY_HEADERS['content-security-policy']!, /frame-ancestors 'none'/);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
});

/**
 * Шаг 53 (OWASP A04), шаг 54 (ревью шага 53, находки 1–2): ограничение частоты — через настоящий HTTP-слой. Счётчик — на адрес:
 * выдуманные токены одного адреса делят один бюджет (заголовок до проверки входа ничего не доказывает), запрос с заголовком получает
 * больший предел; адрес из X-Forwarded-For — только при доверии прокси; превышение — 429 с Retry-After и понятной причиной
 */
test('step 53, 54: rate limit per address — made-up tokens share one budget; 429 with Retry-After; X-Forwarded-For only behind a trusted proxy', async () => {
  const { createStandServer } = await import('../server/stand-server.ts');
  const handle = (async () => ({ status: 200, body: { ok: true } })) as never;
  const run = async (trustProxy: boolean) => {
    const server = createStandServer(handle, 'en', serve, { rateLimit: { authorizedPerMinute: 3, anonymousPerMinute: 2, trustProxy } });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const { port } = server.address() as { port: number };
    const get = async (headers: Record<string, string>) => { const r = await fetch(`http://127.0.0.1:${port}/api/v1/worlds`, { headers }); const body = await r.json() as { error?: { code: string } }; return { status: r.status, retryAfter: r.headers.get('retry-after'), code: body.error?.code }; };
    try {
      // Каждый запрос — с НОВЫМ выдуманным токеном: до шага 54 каждый получал свой счётчик, и предел не срабатывал никогда
      const forged = [];
      for (let i = 0; i < 4; i++) forged.push(await get({ authorization: `Bearer syn-forged-${i}`, 'x-forwarded-for': '203.0.113.9' }));
      const anon = [await get({ 'x-forwarded-for': '203.0.113.1' }), await get({ 'x-forwarded-for': '203.0.113.2' }), await get({ 'x-forwarded-for': '203.0.113.3' })];
      return { forged, anon };
    } finally { await new Promise<void>((done) => server.close(() => done())); }
  };
  const proxied = await run(true);
  assert.deepEqual(proxied.forged.map((x) => x.status), [200, 200, 200, 429], 'four made-up tokens from one address: the fourth is over the authorized limit of that address');
  assert.equal(proxied.forged[3]!.code, 'RATE_LIMITED');
  assert.ok(Number(proxied.forged[3]!.retryAfter) >= 1 && Number(proxied.forged[3]!.retryAfter) <= 60, 'Retry-After in seconds');
  assert.deepEqual(proxied.anon.map((x) => x.status), [200, 200, 200], 'behind the trusted proxy each forwarded address is its own client');
  const direct = await run(false);
  // Без доверия прокси все запросы — с одного адреса сокета: X-Forwarded-For не создаёт новых клиентов. Шаг 55 (ревью шага 54, находка 4):
  // счётчик без входа отдельный — запросы с заголовком его не выбрали, и третий анонимный упирается в свой предел 2
  assert.deepEqual(direct.anon.map((x) => x.status), [200, 200, 429], 'without a trusted proxy X-Forwarded-For is ignored: one address');
});

test('step 55: an office behind one address — signed-in traffic does not use up the anonymous budget; the page and assets are not limited', async () => {
  const { createStandServer } = await import('../server/stand-server.ts');
  const handle = (async () => ({ status: 200, body: { ok: true } })) as never;
  const server = createStandServer(handle, 'en', serve, { rateLimit: { authorizedPerMinute: 3, anonymousPerMinute: 2, trustProxy: true } });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as { port: number };
  const status = async (path: string, headers: Record<string, string>) => (await fetch(`http://127.0.0.1:${port}${path}`, { headers })).status;
  const office = { 'x-forwarded-for': '198.51.100.20' };
  try {
    // Вкладка заданий выбрала предел адреса «с входом»
    for (let i = 0; i < 3; i++) assert.equal(await status('/api/v1/worlds', { ...office, authorization: 'Bearer syn-tab' }), 200);
    assert.equal(await status('/api/v1/worlds', { ...office, authorization: 'Bearer syn-tab' }), 429);
    // Коллега за тем же адресом перезагружает страницу: страница и файлы сборки не считаются, анонимный API — свой счётчик
    for (let i = 0; i < 5; i++) assert.equal(await status('/', office), 200, 'the page is never rate limited');
    assert.equal(await status('/api/v1/worlds', office), 200, 'the anonymous counter of the address is untouched');
  } finally { await new Promise<void>((done) => server.close(() => done())); }
});

test('step 55: an IPv6 client is limited by its /64 — a new address per request does not escape the limit', async () => {
  const { clientKeyOf } = await import('../server/stand-server.ts');
  assert.equal(clientKeyOf('2001:db8:1:2:aaaa::1'), clientKeyOf('2001:0db8:0001:0002:ffff:1:2:3'), 'one /64');
  assert.notEqual(clientKeyOf('2001:db8:1:2::1'), clientKeyOf('2001:db8:1:3::1'), 'another /64 is another client');
  assert.equal(clientKeyOf('::ffff:203.0.113.5'), '203.0.113.5', 'IPv4 in IPv6 — the IPv4 address');
  assert.equal(clientKeyOf('203.0.113.5'), '203.0.113.5');
  assert.equal(clientKeyOf('2001:db8::1'), '2001:db8:0:0::/64');
});

test('step 54: the limiter memory is capped — the address silent for longest is evicted, and one request never walks the map', async () => {
  const { createRateLimiter } = await import('../server/stand-server.ts');
  let t = 1_000_000;
  const limiter = createRateLimiter({ authorizedPerMinute: 5, anonymousPerMinute: 1, trustProxy: true, now: () => t, maxClients: 3 });
  try {
    for (const ip of ['198.51.100.1', '198.51.100.2', '198.51.100.3']) assert.equal(limiter({ 'x-forwarded-for': ip }, '127.0.0.1').ok, true);
    t += 10;
    assert.equal(limiter({ 'x-forwarded-for': '198.51.100.1' }, '127.0.0.1').ok, false, '.1 is over its anonymous limit and is now the most recent');
    assert.equal(limiter({ 'x-forwarded-for': '198.51.100.4' }, '127.0.0.1').ok, true);
    assert.equal(limiter.size(), 3, 'never more than maxClients addresses');
    assert.equal(limiter({ 'x-forwarded-for': '198.51.100.1' }, '127.0.0.1').ok, false, 'the recently seen address was not evicted');
    assert.equal(limiter({ 'x-forwarded-for': '198.51.100.2' }, '127.0.0.1').ok, true, 'the address silent for longest (.2) was evicted and starts over');
  } finally { limiter.close(); }
});

test('step 53: the full content security policy allows only own code and the identity provider origin', async () => {
  const { consoleContentSecurityPolicy } = await import('../server/stand-server.ts');
  const csp = consoleContentSecurityPolicy(['https://syn-instance.zitadel.example/', 'not a url']);
  for (const part of ["default-src 'self'", "script-src 'self'", "style-src 'self'", "frame-ancestors 'none'", "object-src 'none'"]) assert.ok(csp.includes(part), part);
  assert.match(csp, /connect-src 'self' https:\/\/syn-instance\.zitadel\.example(;|$)/);
  assert.ok(!csp.includes('unsafe-inline') && !csp.includes('unsafe-eval'));
});

/**
 * Шаг 66 (OQ-248; ревью шага, находка 7): предел ответа экрана — через настоящий HTTP-слой. Экран мира (GET /api/worlds/…) больше
 * предела не уходит клиенту вовсе; ответ записи — уходит: он приходит после фиксации, и отказ сказал бы «не применено» о применённом
 */
test('step 66: a screen response above the limit is refused with its own code; a write answer and a normal screen pass', async () => {
  const { createStandServer, SCREEN_RESPONSE_MAX_BYTES } = await import('../server/stand-server.ts');
  const huge = { items: Array.from({ length: SCREEN_RESPONSE_MAX_BYTES / 10 + 1 }, () => 'x'.repeat(8)) };
  const handle = (async (r: { url: string }) => ({ status: 200, body: r.url.includes('small') ? { items: [1, 2, 3] } : huge })) as never;
  const server = createStandServer(handle, 'en', serve);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  try {
    const { port } = server.address() as { port: number };
    const call = async (method: string, path: string) => {
      const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, ...(method === 'POST' ? { body: '{}', headers: { 'content-type': 'application/json' } } : {}) });
      const text = await r.text();
      return { status: r.status, bytes: text.length, code: text.length < 500 ? (JSON.parse(text) as { error?: { code: string } }).error?.code : undefined };
    };
    const screen = await call('GET', '/api/worlds/w/products?offset=0');
    assert.deepEqual([screen.status, screen.code], [500, 'RESPONSE_TOO_LARGE'], 'a screen response above the limit does not leave the server');
    assert.ok(screen.bytes < 200, 'the refusal carries no part of the oversized body');
    const small = await call('GET', '/api/worlds/w/small');
    assert.equal(small.status, 200, 'a normal screen passes');
    const write = await call('POST', '/api/worlds/w/stock');
    assert.deepEqual([write.status, write.bytes > SCREEN_RESPONSE_MAX_BYTES], [200, true], 'a write answer is not replaced by a refusal');
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
});
