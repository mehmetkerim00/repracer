import { readFileSync, realpathSync, statSync } from 'node:fs';
import { join, normalize, resolve, sep } from 'node:path';

/**
 * Р-159 (шаг 37): отдача СОБРАННОГО интерфейса. В работе страница приходит файлами из `apps/console/dist`
 * (`npm run build -w apps/console`), а не из vite: сервер разработки в промышленном профиле не поднимается.
 *
 * Правила здесь три, и каждая из них — про ошибку, которую легко сделать:
 * 1. Выход за каталог сборки невозможен: путь нормализуется и обязан остаться внутри — И ПОСЛЕ РАЗЫМЕНОВАНИЯ ССЫЛОК
 *    (находка 2 ревью шага 37). Сравнения строк мало: символическая ссылка ВНУТРИ каталога сборки указывает наружу, а
 *    `statSync` идёт по ней — так отдают `/run/secrets/app_pg_url` тому, кто просто набрал адрес. Сборка ссылок не
 *    создаёт, поэтому запрет ничего не ломает: ссылка в `dist` — это либо ошибка, либо попытка.
 * 2. Адрес, который ВЫГЛЯДИТ файлом (в последнем сегменте есть точка), отдаёт 404, если такого файла нет, — независимо
 *    от того, знаком ли нам его тип (находка 3 ревью шага 37: `/robots.txt` возвращал `index.html` с кодом 200, и
 *    поисковик читал HTML как правила обхода). `index.html` отдаётся только НАВИГАЦИИ: у страницы свои маршруты
 *    (`/w/<мир>/products`), и по перезагрузке браузер просит именно их.
 * 3. Файлы сборки с отпечатком в имени (`app-8f3c1a2b.js`) кэшируются навсегда, `index.html` — никогда: иначе браузер
 *    показывает старую страницу поверх нового API.
 */

const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

export interface StaticFile {
  status: number;
  contentType: string;
  body: Buffer;
  cacheControl: string;
}

/** Отпечаток в имени файла: vite даёт его всем файлам сборки, кроме index.html */
const FINGERPRINTED = /-[0-9A-Za-z_-]{8,}\.[0-9a-z]+$/;

export function createStaticHandler(distDir: string, readFile: (p: string) => Buffer = (p) => readFileSync(p)) {
  /**
   * Граница считается по НАСТОЯЩЕМУ пути каталога: сам каталог сборки может лежать за ссылкой (так устроен `/tmp` на
   * macOS и так бывает на сервере), и тогда сравнение «настоящий путь файла начинается с каталога» ложно для КАЖДОГО
   * файла — отдача перестала бы работать вовсе.
   */
  const root = (() => {
    try {
      return realpathSync(resolve(distDir));
    } catch {
      return resolve(distDir);
    }
  })();
  const index = () => readFile(join(root, 'index.html'));

  return function serveStatic(pathname: string): StaticFile | null {
    const decoded = (() => {
      try {
        return decodeURIComponent(pathname);
      } catch {
        return null;
      }
    })();
    if (decoded === null || decoded.includes('\0')) return null;
    const clean = normalize(decoded).replace(/\/+$/, '') || '/';
    const file = resolve(join(root, clean === '/' ? 'index.html' : clean));
    // Каталог сборки — граница: `resolve` уже убрал `..`, остаётся проверить, что путь не ушёл наружу
    if (file !== root && !file.startsWith(root + sep)) return null;

    const last = file.slice(file.lastIndexOf(sep) + 1);
    const ext = last.includes('.') ? file.slice(file.lastIndexOf('.')) : '';
    const type = TYPES[ext];
    const notFound = { status: 404, contentType: 'text/plain; charset=utf-8', body: Buffer.from('not found\n'), cacheControl: 'no-cache' };
    try {
      /**
       * Разыменование — ЧАСТЬ проверки границы, а не оптимизация: `resolve` работает с текстом пути и про ссылки не
       * знает. Файл, чей настоящий путь ушёл из каталога сборки, не отдаётся никогда.
       */
      const real = realpathSync(file);
      if (real !== root && !real.startsWith(root + sep)) return notFound;
      if (statSync(real).isFile() && type) {
        return {
          status: 200, contentType: type, body: readFile(real),
          cacheControl: FINGERPRINTED.test(file) ? 'public, max-age=31536000, immutable' : 'no-cache',
        };
      }
    } catch {
      // файла нет — решение ниже
    }
    // Адрес, который выглядит файлом, но файлом не оказался, — 404 даже при незнакомом расширении (`/robots.txt`)
    if (last.includes('.')) return notFound;
    try {
      return { status: 200, contentType: TYPES['.html']!, body: index(), cacheControl: 'no-cache' };
    } catch {
      return null;
    }
  };
}
