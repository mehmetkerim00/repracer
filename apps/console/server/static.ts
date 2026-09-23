import { readFileSync, statSync } from 'node:fs';
import { join, normalize, resolve, sep } from 'node:path';

/**
 * Р-159 (шаг 37): отдача СОБРАННОГО интерфейса. В работе страница приходит файлами из `apps/console/dist`
 * (`npm run build -w apps/console`), а не из vite: сервер разработки в промышленном профиле не поднимается.
 *
 * Правила здесь три, и каждая из них — про ошибку, которую легко сделать:
 * 1. Выход за каталог сборки невозможен: путь нормализуется и обязан остаться внутри. `/../../run/secrets/app_pg_url`
 *    отдал бы секрет тому, кто просто набрал адрес.
 * 2. Адрес, которого нет среди файлов, отдаёт `index.html` — у страницы свои маршруты (`/w/<мир>/products`), и по
 *    перезагрузке браузер просит именно их. Но ТОЛЬКО для навигации: несуществующая картинка или скрипт обязаны получить
 *    404, иначе браузер молча разбирает HTML как JavaScript и страница «ломается без причины».
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
  const root = resolve(distDir);
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

    const ext = file.slice(file.lastIndexOf('.'));
    const type = TYPES[ext];
    try {
      if (statSync(file).isFile() && type) {
        return {
          status: 200, contentType: type, body: readFile(file),
          cacheControl: FINGERPRINTED.test(file) ? 'public, max-age=31536000, immutable' : 'no-cache',
        };
      }
    } catch {
      // файла нет — решение ниже
    }
    // Ни один известный тип не подошёл — это навигация страницы: отдаётся index.html. Запрос за файлом с расширением — 404
    if (type) return { status: 404, contentType: 'text/plain; charset=utf-8', body: Buffer.from('not found\n'), cacheControl: 'no-cache' };
    try {
      return { status: 200, contentType: TYPES['.html']!, body: index(), cacheControl: 'no-cache' };
    } catch {
      return null;
    }
  };
}
