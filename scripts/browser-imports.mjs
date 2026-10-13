#!/usr/bin/env node
// Шаг 76 (предполётный прогон демо): код, который исполняет БРАУЗЕР, не импортирует модулей Node. Интерфейс консоли импортирует модели
// экранов, а те — пакеты сервера (подсказки колонок импорта, шаги онбординга), и одно `import … from 'node:zlib'` в достижимом модуле
// роняло весь интерфейс при загрузке: Vite подменяет встроенный модуль Node заглушкой, которая падает при первом обращении. Живые
// прогоны ходят через HTTP API и React не исполняют, поэтому пустую страницу не видел никто с шага 29.
//
// Обход — от точки входа страницы по импортам, которые ОСТАЮТСЯ после стирания типов, разобранным синтаксическим деревом TypeScript
// (строки и комментарии регулярным выражениям не по зубам — ревью шага 76, находка 8): `import type`, `export type` и `typeof import(…)`
// стираются; импорт, где ВСЕ имена помечены `type` (`import { type A } from 'x'`), при `verbatimModuleSyntax` остаётся как
// `import {} from 'x'` и модуль загружает — он считается импортом (находка 6). Пакеты рабочего пространства — по `exports` их
// package.json; внешние пакеты — только по списку разрешённых для браузера; неразрешённый спецификатор — нарушение, а не пропуск.
//
// Использование: node scripts/browser-imports.mjs [точка входа ...] — печатает нарушения с цепочкой импортов; код 1, если они есть.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** Точка входа, которую исполняет браузер: страница консоли продавца (панель оператора и лендинг — без сборки модулей) */
export const BROWSER_ENTRIES = ['apps/console/src/main.tsx'];
/** Внешние пакеты, которые исполняются в браузере */
export const BROWSER_PACKAGES = ['react', 'react-dom', '@fontsource/inter', '@fontsource/ibm-plex-sans', '@fontsource/ibm-plex-mono'];

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

/** Импорты модуля, которые остаются после стирания типов */
export function valueImports(source, fileName = 'module.tsx') {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, false, fileName.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out = [];
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      // `import type …` стирается целиком; `import { type A }` при verbatimModuleSyntax остаётся `import {} from` — загружает модуль
      if (!clause?.isTypeOnly) out.push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      if (!node.isTypeOnly) out.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
      out.push(node.arguments[0].text); // import('x'); тип `typeof import('x')` — ImportTypeNode, не вызов
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function resolveSpecifier(from, spec, packages) {
  if (spec.startsWith('.')) {
    const p = resolve(dirname(from), spec);
    for (const c of [p, `${p}.ts`, `${p}.tsx`, join(p, 'index.ts')]) if (existsSync(c) && statSync(c).isFile()) return { file: c };
    return { missing: spec };
  }
  if (BUILTINS.has(spec)) return { builtin: spec };
  const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
  const pkg = packages.get(name);
  if (!pkg) return BROWSER_PACKAGES.includes(name) ? { external: spec } : { foreign: spec };
  const sub = spec.length > name.length ? `.${spec.slice(name.length)}` : '.';
  const target = typeof pkg.exports === 'string' ? (sub === '.' ? pkg.exports : null) : pkg.exports[sub];
  const entry = typeof target === 'string' ? target : target?.import ?? target?.default ?? null;
  return entry ? { file: join(pkg.dir, entry) } : { missing: spec };
}

/**
 * Нарушения на пути от точек входа: встроенный модуль Node, внешний пакет не из списка браузера, неразрешённый спецификатор — каждое с
 * цепочкой импортов; `reached` — достигнутые файлы (относительно корня), по ним тест проверяет, что обход пересекает пакеты
 */
export function browserImportProblems(entries = BROWSER_ENTRIES) {
  const packages = workspacePackages();
  const seen = new Set();
  const queue = entries.map((e) => ({ file: join(root, e), chain: [e] }));
  const problems = [];
  while (queue.length > 0) {
    const { file, chain } = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    if (!/\.(ts|tsx|mts|js|mjs)$/.test(file)) continue; // таблицы стилей и прочие ресурсы сборки — не модули
    for (const spec of valueImports(readFileSync(file, 'utf8'), file)) {
      const r = resolveSpecifier(file, spec, packages);
      if (r.builtin) problems.push({ kind: 'NODE_BUILTIN', spec, chain: [...chain, spec] });
      else if (r.foreign) problems.push({ kind: 'NOT_A_BROWSER_PACKAGE', spec, chain: [...chain, spec] });
      else if (r.missing) problems.push({ kind: 'UNRESOLVED', spec, chain: [...chain, spec] });
      else if (r.file) queue.push({ file: r.file, chain: [...chain, relative(root, r.file)] });
    }
  }
  return { problems, reached: [...seen].map((f) => relative(root, f)) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const entries = process.argv.slice(2);
  const { problems, reached } = browserImportProblems(entries.length > 0 ? entries : BROWSER_ENTRIES);
  console.log(`modules reachable from the browser entry: ${reached.length}; problems: ${problems.length}`);
  for (const p of problems) console.log(`  ${p.kind} ${p.spec}: ${p.chain.join(' → ')}`);
  process.exit(problems.length > 0 ? 1 : 0);
}
