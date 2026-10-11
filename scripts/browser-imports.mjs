#!/usr/bin/env node
// Шаг 76 (предполётный прогон демо): код, который исполняет БРАУЗЕР, не импортирует встроенных модулей Node. Интерфейс консоли
// импортирует модели экранов, а те — пакеты сервера (подсказки колонок импорта, коды причин), и одно `import … from 'node:zlib'`
// в достижимом модуле роняло весь интерфейс при загрузке: Vite подменяет встроенный модуль Node заглушкой, которая падает при первом
// обращении. Живые прогоны ходят через HTTP API и React не исполняют, поэтому пустую страницу не видел никто с шага 29.
//
// Обход — от точки входа страницы по импортам ЗНАЧЕНИЙ: `import type`, `export type` и импорт одних только типов сборка стирает, а
// `typeof import('…')` — это тип. Пакеты рабочего пространства — по `exports` их package.json; прочие пакеты (react) не обходятся.
//
// Использование: node scripts/browser-imports.mjs [точка входа ...] — печатает цепочки до каждого встроенного модуля Node; код 1, если есть.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** Точки входа, которые исполняет браузер: страница консоли и страница панели оператора */
export const BROWSER_ENTRIES = ['apps/console/src/main.tsx'];

const BUILTINS = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));

function workspacePackages() {
  const map = new Map();
  for (const base of ['packages', 'apps', 'services', 'tests']) {
    const dir = join(root, base);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const pj = join(dir, name, 'package.json');
      if (!existsSync(pj)) continue;
      const p = JSON.parse(readFileSync(pj, 'utf8'));
      if (p.name) map.set(p.name, { dir: join(dir, name), exports: p.exports ?? (p.main ? { '.': p.main } : {}) });
    }
  }
  return map;
}

/** Импорты ЗНАЧЕНИЙ модуля: то, что останется после стирания типов */
export function valueImports(source) {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
  const out = [];
  const statement = /(^|[;\n}])\s*(import|export)\s+([\s\S]*?)\s*from\s*['"]([^'"]+)['"]/g;
  for (const m of code.matchAll(statement)) {
    const clause = m[3].trim();
    if (/^type\b/.test(clause)) continue; // import type … / export type …
    const braces = /^\{([\s\S]*)\}$/.exec(clause);
    if (braces) {
      const names = braces[1].split(',').map((s) => s.trim()).filter(Boolean);
      if (names.length > 0 && names.every((n) => /^type\s/.test(n))) continue; // { type A, type B }
    }
    out.push(m[4]);
  }
  for (const m of code.matchAll(/(^|[;\n])\s*import\s*['"]([^'"]+)['"]/g)) out.push(m[2]); // import 'x' — ради побочного действия
  for (const m of code.matchAll(/(?<!typeof\s+)\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1]); // import('x') — не `typeof import('x')`
  return out;
}

function resolveSpecifier(from, spec, packages) {
  if (spec.startsWith('.')) {
    const p = resolve(dirname(from), spec);
    for (const c of [p, `${p}.ts`, `${p}.tsx`, join(p, 'index.ts')]) if (existsSync(c) && !c.endsWith('/')) try { readFileSync(c); return { file: c }; } catch { /* каталог */ }
    return { missing: spec };
  }
  if (BUILTINS.has(spec)) return { builtin: spec };
  const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
  const pkg = packages.get(name);
  if (!pkg) return { external: spec };
  const sub = `.${spec.slice(name.length)}` || '.';
  const target = typeof pkg.exports === 'string' ? (sub === '.' ? pkg.exports : null) : pkg.exports[sub === '.' ? '.' : sub];
  const entry = typeof target === 'string' ? target : target?.import ?? target?.default ?? null;
  if (!entry) return { missing: spec };
  return { file: join(pkg.dir, entry) };
}

/** Цепочки от точек входа до каждого встроенного модуля Node, достижимого импортами значений */
export function browserBuiltinChains(entries = BROWSER_ENTRIES) {
  const packages = workspacePackages();
  const seen = new Map();
  const queue = entries.map((e) => ({ file: join(root, e), chain: [e] }));
  const found = [];
  while (queue.length > 0) {
    const { file, chain } = queue.shift();
    if (seen.has(file)) continue;
    seen.set(file, chain);
    for (const spec of valueImports(readFileSync(file, 'utf8'))) {
      const r = resolveSpecifier(file, spec, packages);
      if (r.builtin) found.push({ builtin: r.builtin, chain: [...chain, `${spec}`] });
      else if (r.file) queue.push({ file: r.file, chain: [...chain, relative(root, r.file)] });
    }
  }
  return { found, modules: seen.size };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const entries = process.argv.slice(2);
  const { found, modules } = browserBuiltinChains(entries.length > 0 ? entries : BROWSER_ENTRIES);
  console.log(`modules reachable from the browser entry: ${modules}; Node built-ins reached: ${found.length}`);
  for (const f of found) console.log(`  ${f.builtin}: ${f.chain.join(' → ')}`);
  process.exit(found.length > 0 ? 1 : 0);
}
