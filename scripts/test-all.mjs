#!/usr/bin/env node
// Все тесты репозитория [Р-84, Р-89]:
// 1) каждый файл *.test.ts входит в скрипт сборки (scripts/check-test-inclusion.mjs) — иначе красная сборка до запуска;
// 2) тесты всех пакетов и тесты скриптов репозитория;
// 3) пропущенный, отложенный (todo) или отменённый тест — красная сборка, как упавший.
// Раньше «зелёное» значило «зелёное при этих переменных окружения»: без базы 53 теста из 189 молча пропускались,
// а на шаге 15 четыре файла (17 тестов, включая проверку Р-83) не входили ни в один скрипт.
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findUnincludedTests } from './check-test-inclusion.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const inclusion = findUnincludedTests(root);
console.log(`TEST INCLUSION ${JSON.stringify({ testFiles: inclusion.total, unincluded: inclusion.unincluded.length, listedButMissing: inclusion.listedButMissing.length })}`);
if (inclusion.total === 0 || inclusion.unincluded.length > 0 || inclusion.listedButMissing.length > 0) {
  for (const f of inclusion.unincluded) console.error(`NOT IN BUILD: ${f}`);
  for (const f of inclusion.listedButMissing) console.error(`LISTED BUT NO FILE: ${f}`);
  console.error('BUILD RED: test files outside the build (Р-89)');
  process.exit(1);
}

function run(args) {
  return new Promise((resolve) => {
    const child = spawn('npm', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
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

const runs = [
  { name: 'workspaces', ...(await run(['test', '--workspaces', '--if-present'])) },
  { name: 'repository scripts', ...(await run(['run', 'test:repo'])) },
];

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
for (const k of ['fail', 'skipped', 'todo', 'cancelled']) if (totals[k] > 0) problems.push(`${totals[k]} ${k}`);
console.log(`\nTEST TOTALS ${JSON.stringify({ suites: summaries, ...totals })}`);
if (problems.length > 0) {
  console.error(`BUILD RED: ${problems.join('; ')}`);
  process.exit(1);
}
console.log('BUILD GREEN: every test file is in the build, every test ran and passed');
