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
 * Шаг 53 (OWASP A04): ограничение частоты — через настоящий HTTP-слой. Предел на клиента: вход (по отпечатку заголовка) и адрес — раздельно;
 * адрес из X-Forwarded-For — только при доверии прокси; превышение — 429 с Retry-After и понятной причиной
 */
test('step 53: rate limit per client — 429 with Retry-After; another token is another client; X-Forwarded-For only behind a trusted proxy', async () => {
  const { createStandServer } = await import('../server/stand-server.ts');
  const handle = (async () => ({ status: 200, body: { ok: true } })) as never;
  const run = async (trustProxy: boolean) => {
    const server = createStandServer(handle, 'en', serve, { rateLimit: { authorizedPerMinute: 3, anonymousPerMinute: 2, trustProxy } });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const { port } = server.address() as { port: number };
    const get = async (headers: Record<string, string>) => { const r = await fetch(`http://127.0.0.1:${port}/api/v1/worlds`, { headers }); const body = await r.json() as { error?: { code: string } }; return { status: r.status, retryAfter: r.headers.get('retry-after'), code: body.error?.code }; };
    try {
      const a = [await get({ authorization: 'Bearer syn-a' }), await get({ authorization: 'Bearer syn-a' }), await get({ authorization: 'Bearer syn-a' }), await get({ authorization: 'Bearer syn-a' })];
      const b = await get({ authorization: 'Bearer syn-b' });
      const anon = [await get({ 'x-forwarded-for': '203.0.113.1' }), await get({ 'x-forwarded-for': '203.0.113.2' }), await get({ 'x-forwarded-for': '203.0.113.3' })];
      return { a, b, anon };
    } finally { await new Promise<void>((done) => server.close(() => done())); }
  };
  const direct = await run(false);
  assert.deepEqual(direct.a.map((x) => x.status), [200, 200, 200, 429], 'the fourth request of one token in a minute');
  assert.equal(direct.a[3]!.code, 'RATE_LIMITED');
  assert.ok(Number(direct.a[3]!.retryAfter) >= 1 && Number(direct.a[3]!.retryAfter) <= 60, 'Retry-After in seconds');
  assert.equal(direct.b.status, 200, 'another token is another client');
  assert.deepEqual(direct.anon.map((x) => x.status), [200, 200, 429], 'without a trusted proxy X-Forwarded-For is ignored: one address');
  const proxied = await run(true);
  assert.deepEqual(proxied.anon.map((x) => x.status), [200, 200, 200], 'behind the trusted proxy each forwarded address is its own client');
});

test('step 53: the full content security policy allows only own code and the identity provider origin', async () => {
  const { consoleContentSecurityPolicy } = await import('../server/stand-server.ts');
  const csp = consoleContentSecurityPolicy(['https://syn-instance.zitadel.example/', 'not a url']);
  for (const part of ["default-src 'self'", "script-src 'self'", "style-src 'self'", "frame-ancestors 'none'", "object-src 'none'"]) assert.ok(csp.includes(part), part);
  assert.match(csp, /connect-src 'self' https:\/\/syn-instance\.zitadel\.example(;|$)/);
  assert.ok(!csp.includes('unsafe-inline') && !csp.includes('unsafe-eval'));
});
