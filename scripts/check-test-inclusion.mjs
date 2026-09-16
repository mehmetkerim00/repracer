#!/usr/bin/env node
// Р-89: тест, не входящий в сборку, считается несуществующим. Проверка: каждый файл *.test.{ts,tsx,mts,cts,js,mjs,cjs} репозитория
// совпадает с аргументом скрипта `test` своего пакета (workspace) или скрипта `test:repo` корня; файл, названный в скрипте, существует.
// Шаг 17 (находка 8 ревью шага 16): список файлов — из git (отслеживаемые и неигнорируемые), а не обход с пропуском каталогов по имени:
// тест в каталоге build на любой глубине и .test.tsx больше не выпадают. Вне git — обход без символических ссылок.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, relative, dirname, basename, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TEST_FILE = /\.test\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/;

function walk(dir, root, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== '.git') walk(join(dir, entry.name), root, out);
    } else if (entry.isFile() && TEST_FILE.test(entry.name)) {
      out.push(relative(root, join(dir, entry.name)).split(sep).join('/'));
    }
  }
  return out;
}

/** Все тестовые файлы репозитория: из git, если это рабочая копия; иначе обход */
export function listTestFiles(root) {
  try {
    const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\0').filter((f) => f && TEST_FILE.test(f) && !f.split('/').includes('node_modules') && existsSync(join(root, f))).sort();
  } catch {
    return walk(root, root, []).sort();
  }
}

// Аргументы вида `test/*.pg.test.ts`: звёздочка допускается только в имени файла — так её раскрывают и shell, и node --test.
function expand(packageDir, arg, root) {
  const dir = join(root, packageDir, dirname(arg));
  const name = basename(arg);
  if (!name.includes('*')) return existsSync(join(dir, name)) ? [join(packageDir, arg)] : [];
  if (dirname(arg).includes('*')) throw new Error(`unsupported glob in directory part: ${packageDir}: ${arg}`);
  const re = new RegExp(`^${name.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  return readdirSync(dir).filter((f) => re.test(f)).map((f) => join(packageDir, dirname(arg), f));
}

function scriptFiles(script) {
  return (script ?? '').split(/\s+/).filter((a) => TEST_FILE.test(a.replace(/\*/g, 'x')));
}

/** Файлы, которые сборка должна запустить: раскрытые аргументы скриптов test пакетов и test:repo корня */
export function includedTestFiles(root) {
  const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const packages = [{ dir: '.', scripts: [rootPkg.scripts?.['test:repo']] }];
  for (const pattern of rootPkg.workspaces ?? []) {
    const dirs = pattern.endsWith('/*')
      ? (existsSync(join(root, pattern.slice(0, -2))) ? readdirSync(join(root, pattern.slice(0, -2))).map((d) => `${pattern.slice(0, -2)}/${d}`) : [])
      : [pattern];
    for (const dir of dirs) {
      const file = join(root, dir, 'package.json');
      if (existsSync(file)) packages.push({ dir, scripts: [JSON.parse(readFileSync(file, 'utf8')).scripts?.test] });
    }
  }
  const included = new Set();
  const listedButMissing = [];
  for (const pkg of packages) {
    for (const script of pkg.scripts) {
      for (const arg of scriptFiles(script)) {
        const files = expand(pkg.dir, arg, root);
        if (files.length === 0) listedButMissing.push(`${pkg.dir}: ${arg}`);
        for (const f of files) included.add(f.split(sep).join('/').replace(/^\.\//, ''));
      }
    }
  }
  return { included, listedButMissing };
}

export function findUnincludedTests(root) {
  const { included, listedButMissing } = includedTestFiles(root);
  const all = listTestFiles(root);
  return { total: all.length, all, included: [...included].sort(), unincluded: all.filter((f) => !included.has(f)), listedButMissing };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..');
  const { total, unincluded, listedButMissing } = findUnincludedTests(root);
  console.log(`TEST INCLUSION ${JSON.stringify({ testFiles: total, unincluded: unincluded.length, listedButMissing: listedButMissing.length })}`);
  for (const f of unincluded) console.error(`NOT IN BUILD: ${f}`);
  for (const f of listedButMissing) console.error(`LISTED BUT NO FILE: ${f}`);
  if (total === 0 || unincluded.length > 0 || listedButMissing.length > 0) process.exit(1);
}
