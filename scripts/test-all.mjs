#!/usr/bin/env node
// Все тесты репозитория [Р-84, Р-89]:
// 1) каждый файл *.test.ts входит в скрипт сборки (scripts/check-test-inclusion.mjs) — иначе красная сборка до запуска;
// 2) тесты всех пакетов и тесты скриптов репозитория;
// 3) пропущенный, отложенный (todo) или отменённый тест — красная сборка, как упавший.
// Раньше «зелёное» значило «зелёное при этих переменных окружения»: без базы 53 теста из 189 молча пропускались,
// а на шаге 15 четыре файла (17 тестов, включая проверку Р-83) не входили ни в один скрипт.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findUnincludedTests } from './check-test-inclusion.mjs';
import { filesForScope, INFRASTRUCTURE_TESTS, MEASURED_FILES } from './test-scopes.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const inclusion = findUnincludedTests(root);
console.log(`TEST INCLUSION ${JSON.stringify({ testFiles: inclusion.total, unincluded: inclusion.unincluded.length, listedButMissing: inclusion.listedButMissing.length })}`);
if (inclusion.total === 0 || inclusion.unincluded.length > 0 || inclusion.listedButMissing.length > 0) {
  for (const f of inclusion.unincluded) console.error(`NOT IN BUILD: ${f}`);
  for (const f of inclusion.listedButMissing) console.error(`LISTED BUT NO FILE: ${f}`);
  console.error('BUILD RED: test files outside the build (Р-89)');
  process.exit(1);
}

// Журнал выполненных файлов: каждый процесс node пишет путь своего тестового файла (scripts/test-ledger.mjs)
const ledgerDir = mkdtempSync(join(tmpdir(), 'repracer-test-ledger-'));
const ledger = join(ledgerDir, 'executed.txt');
const ledgerEnv = {
  ...process.env,
  REPRACER_TEST_LEDGER: ledger,
  NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import ${pathToFileURL(join(root, 'scripts', 'test-ledger.mjs')).href}`.trim(),
};

/**
 * Р-137: область прогона. `fast` — всё, кроме тестов, которым нужна инфраструктура сверх PostgreSQL (каталог test-scopes.mjs);
 * `full` (по умолчанию) — всё. Файлы запускаются по рабочим пространствам теми же флагами, что и `npm test` каждого из них:
 * так область выбирается по файлу, а не по пакету, и ни один тест не «пропускается» молча [Р-84].
 */
const scope = (process.argv.find((a) => a.startsWith('--scope='))?.slice('--scope='.length) ?? 'full');
if (scope !== 'fast' && scope !== 'full' && scope !== 'long') {
  console.error(`BUILD RED: неизвестная область прогона «${scope}» (fast, full или long)`);
  process.exit(1);
}
const selected = filesForScope(inclusion.included, scope);
const deferred = inclusion.included.filter((f) => !selected.includes(f));
console.log(`TEST SCOPE ${JSON.stringify({ scope, files: selected.length, deferred: deferred.length })}`);
for (const t of INFRASTRUCTURE_TESTS) {
  if (deferred.includes(t.file)) console.log(`   ${t.needs === 'TIME' ? 'идёт своим заданием CI (long)' : 'отложен до полного прогона'} (${t.needs}): ${t.file} — ${t.why}`);
}

/** Рабочее пространство файла: ближайший вверх package.json */
function workspaceOf(file) {
  let dir = dirname(join(root, file));
  while (dir !== root && !existsSync(join(dir, 'package.json'))) dir = dirname(dir);
  return dir;
}

function runNode(cwd, files) {
  return new Promise((resolve) => {
    const args = ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', '--test', '--test-reporter=spec', ...files];
    const child = spawn(process.execPath, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: ledgerEnv });
    let output = '';
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', (chunk) => {
        output += chunk;
        process.stdout.write(chunk);
      });
    }
    child.on('close', (code) => resolve({ code, output }));
  });
}

function run(args) {
  return new Promise((resolve) => {
    const child = spawn('npm', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: ledgerEnv });
    let output = '';
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', (chunk) => {
        output += chunk;
        process.stdout.write(chunk);
      });
    }
    child.on('close', (code) => resolve({ code, output }));
  });
}

const byWorkspace = new Map();
for (const file of selected) {
  const cwd = workspaceOf(file);
  byWorkspace.set(cwd, [...(byWorkspace.get(cwd) ?? []), relative(cwd, join(root, file)).split(sep).join('/')]);
}
const runs = [];
for (const [cwd, files] of [...byWorkspace].sort((a, b) => a[0].localeCompare(b[0]))) {
  const name = `workspace ${relative(root, cwd).split(sep).join('/') || '.'}`;
  // Шаг 36: прогон, утверждающий СЕКУНДЫ, не делит машину с соседями — иначе он мерит их нагрузку (test-scopes.mjs)
  const measured = files.filter((f) => MEASURED_FILES.has(relative(root, join(cwd, f)).split(sep).join('/')));
  const shared = files.filter((f) => !measured.includes(f));
  if (shared.length > 0) runs.push({ name, ...(await runNode(cwd, shared.sort())) });
  for (const file of measured.sort()) runs.push({ name: `${name} (замер, в одиночку): ${file}`, ...(await runNode(cwd, [file])) });
}
runs.push({ name: 'repository scripts', ...(await run(['run', 'test:repo'])) });

const totals = { tests: 0, pass: 0, fail: 0, skipped: 0, todo: 0, cancelled: 0 };
let summaries = 0;
const problems = [];
for (const r of runs) {
  let own = 0;
  for (const line of r.output.split('\n')) {
    const m = /^(?:#|ℹ) (tests|pass|fail|skipped|todo|cancelled) (\d+)$/.exec(line.trim());
    if (!m) continue;
    totals[m[1]] += Number(m[2]);
    if (m[1] === 'tests') own++;
  }
  summaries += own;
  if (r.code !== 0) problems.push(`${r.name}: npm exited with ${r.code}`);
  if (own === 0) problems.push(`${r.name}: no test summary found`);
}
if (totals.tests === 0) problems.push('no tests ran');
// Р-89: каждый включённый в сборку файл действительно выполнился (скрипт мог назвать файл, но отфильтровать его или не дойти до него)
const executed = new Set(existsSync(ledger) ? readFileSync(ledger, 'utf8').split('\n').filter(Boolean).map((f) => relative(root, f).split(sep).join('/')) : []);
rmSync(ledgerDir, { recursive: true, force: true });
const notExecuted = selected.filter((f) => !executed.has(f));
for (const f of notExecuted) console.error(`INCLUDED BUT NOT EXECUTED: ${f}`);
if (notExecuted.length > 0) problems.push(`${notExecuted.length} included test files did not run`);
console.log(`TEST FILES ${JSON.stringify({ included: inclusion.included.length, selected: selected.length, executed: executed.size, notExecuted: notExecuted.length })}`);
for (const k of ['fail', 'skipped', 'todo', 'cancelled']) if (totals[k] > 0) problems.push(`${totals[k]} ${k}`);
console.log(`\nTEST TOTALS ${JSON.stringify({ suites: summaries, ...totals })}`);
if (problems.length > 0) {
  console.error(`BUILD RED: ${problems.join('; ')}`);
  process.exit(1);
}
console.log('BUILD GREEN: every test file is in the build, every test ran and passed');
