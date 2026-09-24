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
