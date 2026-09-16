#!/usr/bin/env node
// Р-95: мутационная проверка схемы. Для каждой мутации каталога — копия шаблона базы с одной снятой защитой; ожидаемые проверки обязаны
// на ней упасть. Сначала — контрольный прогон тех же проверок без мутации: все должны быть зелёными, иначе результат ничего не значит.
//
// Использование: PGHOST=… PGPORT=… PGUSER=<суперпользователь> REPRACER_PG_URL=… REPRACER_PG_ADMIN_URL=… \
//   node scripts/db/mutation-check.mjs [--catalog tests/db/mutations.mjs] [--only 12,16] [--jobs 2] [--report path.md] [--measure]
//   --measure — только отчёт (шаг 17, A); без него непойманная мутация делает прогон красным (CI).
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const measure = process.argv.includes('--measure');
const catalogPath = resolve(root, arg('catalog', 'tests/db/mutations.mjs'));
const only = arg('only')?.split(',').map((s) => s.trim());
const jobs = Number(arg('jobs', '2'));
const reportPath = arg('report');
const template = process.env.REPRACER_PG_TEMPLATE ?? 'repracer_template';
const appUrl = process.env.REPRACER_PG_URL;
const adminUrl = process.env.REPRACER_PG_ADMIN_URL;
if (!appUrl || !adminUrl) throw new Error('REPRACER_PG_URL and REPRACER_PG_ADMIN_URL are required: the mutation check does not skip (Р-84)');

function run(cmd, args, { env = {}, cwd = root, timeoutMs = 900_000 } = {}) {
  return new Promise((done) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => { out += '\nTIMEOUT'; child.kill('SIGKILL'); }, timeoutMs);
    child.on('close', (code) => { clearTimeout(timer); done({ code, out }); });
  });
}

const psql = (db, args, env = {}) => run('psql', ['-X', '-v', 'ON_ERROR_STOP=1', '-q', '-d', db, ...args], { env });

async function createDb(name, mutation) {
  await psql('postgres', ['-c', `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`]);
  const created = await psql('postgres', ['-c', `CREATE DATABASE ${name} TEMPLATE ${template}`, '-c', `ALTER DATABASE ${name} SET repracer.region = 'EU'`]);
  if (created.code !== 0) throw new Error(`create ${name}: ${created.out}`);
  if (!mutation) return;
  const sql = typeof mutation === 'string' ? mutation : `DO $mutation$
DECLARE d text := pg_get_functiondef('${mutation.fn}'::regprocedure); m text;
BEGIN
  m := replace(d, ${dollar(mutation.from)}, ${dollar(mutation.to)});
  IF m = d THEN RAISE EXCEPTION 'mutation text not found in ${mutation.fn}'; END IF;
  EXECUTE m;
END $mutation$`;
  const applied = await psql(name, ['-c', sql]);
  if (applied.code !== 0) throw new Error(`mutation on ${name} failed: ${applied.out}`);
}
const dollar = (s) => `$q$${s}$q$`;
const dropDb = (name) => psql('postgres', ['-c', `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`]);

/** Смоук-тесты как в scripts/db/prepare.sh, в режиме сбора: провал проверки — предупреждение CHECK FAILED, прогон идёт дальше */
async function smoke(db) {
  const env = { PGOPTIONS: '-c repracer.smoke_collect=on' };
  const steps = [['postgres', 'tests/db/smoke_setup.sql'], ['svc_provisioning', 'tests/db/smoke_provision.sql'], ['svc_admin', 'tests/db/smoke_app.sql'],
    ['svc_admin', 'tests/db/smoke_admin.sql'], ['svc_app', 'tests/db/smoke_path.sql'], ['postgres', 'tests/db/smoke_r65.sql'], ['svc_scheduler', 'tests/db/smoke_retention.sql']];
  let out = '';
  let stopped = null;
  for (const [user, file] of steps) {
    const r = await psql(db, ['-f', file], { ...env, PGUSER: user });
    out += r.out;
    if (r.code !== 0) {
      stopped = `${file}: ${(r.out.match(/ERROR:[^\n]*/g) ?? ['exit ' + r.code]).pop()}`;
      break;
    }
  }
  // Как prepare.sh: смоук-тест хранения удаляет секции — текущие секции создаются заново для тестов после смоук-прогона
  const partitions = await psql(db, ['-Atc', 'SELECT maintenance.ensure_partitions(now())'], { PGUSER: 'svc_scheduler' });
  if (partitions.code !== 0) throw new Error(`ensure_partitions on ${db}: ${partitions.out}`);
  return { out, stopped };
}

function packageDir(file) {
  let dir = dirname(resolve(root, file));
  while (dir !== root && !existsSync(join(dir, 'package.json'))) dir = dirname(dir);
  return dir;
}

async function nodeTest(file, db, tpl) {
  const url = new URL(appUrl);
  url.pathname = `/${db}`;
  const cwd = packageDir(file);
  const r = await run('node', ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', '--test', '--test-reporter=tap', relative(cwd, resolve(root, file))],
    { cwd, env: { REPRACER_PG_URL: url.toString(), REPRACER_PG_ADMIN_URL: adminUrl, REPRACER_PG_TEMPLATE: tpl } });
  const failed = [...r.out.matchAll(/^\s*not ok \d+ - (.*)$/gm)].map((m) => {
    // Причина провала — первая строка error: после «not ok» (TAP YAML)
    const after = r.out.slice(m.index ?? 0, (m.index ?? 0) + 2000);
    const why = /error: [|>-]*\s*'?([^\n]+)/.exec(after)?.[1] ?? '';
    return `${m[1]} [${why.trim().slice(0, 160)}]`;
  });
  const passed = [...r.out.matchAll(/^\s*ok \d+ - (.*)$/gm)].map((m) => m[1]);
  return { code: r.code, failed, passed, out: r.out };
}

/** Проверки одной конфигурации базы: что провалилось из ожидаемого */
async function evaluate(expect, id, mutation) {
  const db = `mut_${id}`;
  const tpl = `mutt_${id}`;
  await createDb(db, mutation);
  await createDb(tpl, mutation);
  const results = [];
  try {
    for (const e of expect.filter((x) => x.verify)) {
      const r = await psql(db, ['-f', e.verify]);
      results.push({ e, failed: r.code !== 0, detail: r.code !== 0 ? (r.out.match(/ERROR:[^\n]*\n[^\n]*/) ?? [''])[0] : '' });
    }
    const smokeChecks = expect.filter((x) => x.smoke);
    if (smokeChecks.length > 0) {
      const s = await smoke(db);
      for (const e of smokeChecks) {
        const label = e.smoke.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const hit = new RegExp(`CHECK FAILED: ${label}|FAILURE DID NOT HAPPEN: ${label}|HAD ANOTHER REASON[^\\n]*${label}|ERROR:[^\\n]*${label}`).exec(s.out);
        const reached = s.out.includes(e.reached ?? e.smoke);
        results.push({ e, failed: Boolean(hit), detail: hit ? hit[0].slice(0, 180) : reached ? '' : `not reached (${s.stopped ?? 'label absent'})` });
      }
    }
    const files = [...new Set(expect.filter((x) => x.node).map((x) => x.node))];
    for (const file of files) {
      const r = await nodeTest(file, db, tpl);
      for (const e of expect.filter((x) => x.node === file)) {
        const hits = r.failed.filter((t) => e.test === null || t.includes(e.test));
        const known = e.test === null ? r.failed.length + r.passed.length > 0 : [...r.failed, ...r.passed].some((t) => t.includes(e.test));
        results.push({ e, failed: hits.length > 0, detail: hits.length > 0 ? hits.join('; ').slice(0, 180) : known ? '' : `test not found (exit ${r.code})` });
      }
    }
  } finally {
    await dropDb(db);
    await dropDb(tpl);
  }
  return results;
}

const describeExpect = (e) => e.smoke !== undefined ? `smoke «${e.smoke}»` : e.verify ? `verify ${e.verify.replace('migrations/', '')}` : `${e.node.split('/').pop()}${e.test ? ` «${e.test}»` : ''}`;
const describeMutation = (m) => typeof m === 'string' ? m.replace(/\s+/g, ' ').slice(0, 110) : `${m.fn}: «${m.from.slice(0, 50)}…» → «${m.to.slice(0, 30)}…»`;

const { R93_ROWS, STEP17_ROWS = [], R93_NOT_MUTATED = [] } = await import(pathToFileURL(catalogPath).href);
const rows = [...R93_ROWS, ...(process.argv.includes('--r93-only') ? [] : STEP17_ROWS)].filter((r) => !only || only.includes(r.row));

// 1. Контроль без мутации: каждая ожидаемая проверка зелёная
const allExpect = [];
for (const r of rows) for (const e of r.expect) if (!allExpect.some((x) => describeExpect(x) === describeExpect(e))) allExpect.push(e);
console.log(`control run: ${allExpect.length} checks`);
const control = await evaluate(allExpect, 'control', null);
const redControl = control.filter((c) => c.failed || /not found|not reached/.test(c.detail));
if (redControl.length > 0) {
  for (const c of redControl) console.error(`CONTROL RED: ${describeExpect(c.e)} — ${c.detail}`);
  console.error('the checks are not green without mutations: the mutation check means nothing');
  process.exit(2);
}

// 2. Мутации
const tasks = rows.flatMap((r) => r.mutations.map((m, i) => ({ row: r, mutation: m, id: `${r.row.replace(/\D+/g, '_')}_${i}` })));
const outcomes = [];
let next = 0;
await Promise.all(Array.from({ length: Math.max(1, jobs) }, async () => {
  while (next < tasks.length) {
    const t = tasks[next++];
    const started = Date.now();
    const results = await evaluate(t.row.expect, t.id, t.mutation);
    const caughtBy = results.filter((r) => r.failed);
    outcomes.push({ ...t, results, caught: caughtBy.length > 0 });
    console.log(`${caughtBy.length > 0 ? 'CAUGHT  ' : 'UNCAUGHT'} row ${t.row.row}: ${describeMutation(t.mutation)} (${Math.round((Date.now() - started) / 1000)} s)`);
    for (const r of results) console.log(`   ${r.failed ? '✗ fails' : '✓ green'} ${describeExpect(r.e)}${r.detail ? ` — ${r.detail}` : ''}`);
  }
}));

// 3. Итог по строкам: строка ложна, если хотя бы одну её мутацию не поймала ни одна заявленная проверка
const byRow = rows.map((r) => {
  const own = outcomes.filter((o) => o.row === r);
  return { row: r, own, false: own.some((o) => !o.caught) };
});
const falseRows = byRow.filter((r) => r.false);
const lines = [
  '| Строка Р-93 | Инвариант | Мутация | Поймана | Заявленные проверки на мутации |',
  '|---|---|---|---|---|',
  ...byRow.flatMap((r) => r.own.sort((a, b) => a.id.localeCompare(b.id)).map((o) => `| ${r.row.row} | ${r.row.invariant} | \`${describeMutation(o.mutation).replace(/\|/g, '\\|')}\` | ${o.caught ? 'да' : '**нет**'} | ${o.results.map((x) => `${x.failed ? '✗' : '✓'} ${describeExpect(x.e)}${x.detail && !x.failed ? ` (${x.detail})` : ''}`).join('<br>').replace(/\|/g, '\\|')} |`)),
  '',
  `Строк с мутациями: ${byRow.length}; ложных (хотя бы одна мутация не поймана заявленными проверками): **${falseRows.length}** — ${falseRows.map((r) => r.row.row).join('; ') || '—'}.`,
  `Мутаций: ${outcomes.length}; не поймано: **${outcomes.filter((o) => !o.caught).length}**.`,
  `Не мутировались: ${R93_NOT_MUTATED.map((n) => `${n.row} (${n.why})`).join('; ')}.`,
  '✗ — проверка упала на мутации (поймала), ✓ — осталась зелёной.',
];
console.log(`\n${lines.join('\n')}`);
if (reportPath) writeFileSync(resolve(root, reportPath), `${lines.join('\n')}\n`);
if (!measure && outcomes.some((o) => !o.caught)) {
  console.error('MUTATION CHECK RED: a protection can be removed while its checks stay green (Р-94, Р-95)');
  process.exit(1);
}
