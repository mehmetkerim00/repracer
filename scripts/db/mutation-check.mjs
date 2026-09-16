#!/usr/bin/env node
// Р-95: мутационная проверка схемы. Для каждой мутации каталога — копия шаблона базы с одной снятой защитой. Сначала — контрольный
// прогон тех же проверок без мутации: все должны быть зелёными, иначе результат ничего не значит.
// Р-99 (шаг 18): мутация поймана ТОЛЬКО своей проверкой — из списка own этой мутации и с совпавшей причиной (reason). Падение
// проверки соседней мутации той же строки — не поимка: такая мутация учитывается как непойманная (в отчёте — «только соседней»).
//
// Использование: PGHOST=… PGPORT=… PGUSER=<суперпользователь> REPRACER_PG_URL=… REPRACER_PG_ADMIN_URL=… \
//   node scripts/db/mutation-check.mjs [--catalog tests/db/mutations.mjs] [--only '12;28, 32, 39, 40'] [--jobs 2] [--report path.md] [--measure]
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
// Имена строк содержат запятые («28, 32, 39, 40»): разделитель — точка с запятой
const only = arg('only')?.split(';').map((s) => s.trim());
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
  // Роли и членство в ролях — объекты кластера: мутация пережила бы удаление копии базы и испортила остальные прогоны
  if (typeof mutation === 'string' && /^\s*(GRANT|REVOKE)\s+[a-z_]+\s+(TO|FROM)\s/i.test(mutation) || /\b(CREATE|ALTER|DROP)\s+ROLE\b/i.test(typeof mutation === 'string' ? mutation : '')) {
    throw new Error(`mutation on ${name} changes cluster-wide roles and cannot be undone by dropping the copy: ${mutation}`);
  }
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
    ['svc_admin', 'tests/db/smoke_admin.sql'], ['svc_app', 'tests/db/smoke_path.sql'], ['postgres', 'tests/db/smoke_r65.sql'],
    ['postgres', 'tests/db/smoke_append_only.sql'], ['svc_stock', 'tests/db/smoke_stock.sql'], ['svc_scheduler', 'tests/db/smoke_retention.sql']];
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
    // Причина провала — блок TAP YAML после «not ok» (error, expected, actual) до следующего теста
    const after = r.out.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + 4000);
    const end = after.search(/^\s*(?:not )?ok \d+ - /m);
    const block = (end >= 0 ? after.slice(0, end) : after).replace(/\s+/g, ' ');
    return { name: m[1], why: block.slice(0, 1500) };
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
      results.push({ e, failed: r.code !== 0, detail: r.code !== 0 ? r.out.replace(/\s+/g, ' ').slice(0, 4000) : '' });
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
        const hits = r.failed.filter((t) => t.name.includes(e.test));
        const known = [...r.failed.map((t) => t.name), ...r.passed].some((t) => t.includes(e.test));
        // Причина сверяется только с текстом провала, не с названием теста: название повторяет формулировки утверждений
        results.push({ e, failed: hits.length > 0, why: hits.map((t) => t.why).join(' ; '), detail: hits.length > 0 ? hits.map((t) => `${t.name} [${t.why}]`).join('; ') : known ? '' : `test not found (exit ${r.code})` });
      }
    }
  } finally {
    await dropDb(db);
    await dropDb(tpl);
  }
  return results;
}

const describeExpect = (e) => e.smoke !== undefined ? `smoke «${e.smoke}»` : e.verify ? `verify ${e.verify.replace('migrations/', '')}${e.reason ? ` /${e.reason}/` : ''}` : `${e.node.split('/').pop()} «${e.test}» /${e.reason}/`;
const describeMutation = (m) => typeof m === 'string' ? m.replace(/\s+/g, ' ').slice(0, 110) : `${m.fn}: «${m.from.slice(0, 50)}…» → «${m.to.slice(0, 30)}…»`;
const sameCheck = (a, b) => describeExpect(a) === describeExpect(b);

const { R93_ROWS, STEP17_ROWS = [], STEP18_ROWS = [], R93_NOT_MUTATED = [] } = await import(pathToFileURL(catalogPath).href);
const rows = [...R93_ROWS, ...(process.argv.includes('--r93-only') ? [] : [...STEP17_ROWS, ...STEP18_ROWS])].filter((r) => !only || only.includes(r.row));

// Р-99: у каждой мутации — свои проверки; у проверки теста и проверки схемы — обязательная причина (тест и проверка схемы падают по многим причинам)
for (const r of rows) {
  if (!Array.isArray(r.mutations) || r.mutations.some((m) => !m.apply || !Array.isArray(m.own) || m.own.length === 0)) {
    throw new Error(`catalog row ${r.row}: every mutation needs apply and its own checks (Р-99)`);
  }
  for (const m of r.mutations) for (const e of m.own) {
    if (e.node !== undefined && (!e.test || !e.reason)) throw new Error(`catalog row ${r.row}: a test check names the test and the reason (Р-99)`);
    if (e.verify !== undefined && !e.reason) throw new Error(`catalog row ${r.row}: a schema check names the reason (Р-99)`);
  }
  r.expect = [];
  for (const m of r.mutations) for (const e of m.own) if (!r.expect.some((x) => sameCheck(x, e))) r.expect.push(e);
}
/** Своя проверка поймала мутацию: проверка упала и причина совпала (у смоук-проверки причину сверяет сам expect_fail) */
const ownCatch = (result, own) => result.failed && own.some((e) => sameCheck(e, result.e)) && (!result.e.reason || new RegExp(result.e.reason).test(result.why ?? result.detail));

// 1. Контроль без мутации: каждая ожидаемая проверка зелёная
const allExpect = [];
for (const r of rows) for (const e of r.expect) if (!allExpect.some((x) => sameCheck(x, e))) allExpect.push(e);
console.log(`control run: ${allExpect.length} checks`);
const control = await evaluate(allExpect, 'control', null);
const redControl = control.filter((c) => c.failed || /not found|not reached/.test(c.detail));
if (redControl.length > 0) {
  for (const c of redControl) console.error(`CONTROL RED: ${describeExpect(c.e)} — ${c.detail}`);
  console.error('the checks are not green without mutations: the mutation check means nothing');
  process.exit(2);
}

// 2. Мутации
const tasks = rows.flatMap((r) => r.mutations.map((m, i) => ({ row: r, mutation: m.apply, own: m.own, id: `${r.row.replace(/[^0-9A-Za-z]+/g, '_').toLowerCase()}_${i}` })));
const outcomes = [];
let next = 0;
await Promise.all(Array.from({ length: Math.max(1, jobs) }, async () => {
  while (next < tasks.length) {
    const t = tasks[next++];
    const started = Date.now();
    const results = await evaluate(t.row.expect, t.id, t.mutation);
    const caught = results.some((r) => ownCatch(r, t.own));
    const neighbourOnly = !caught && results.some((r) => r.failed);
    outcomes.push({ ...t, results, caught, neighbourOnly });
    console.log(`${caught ? 'CAUGHT  ' : neighbourOnly ? 'NEIGHBOUR' : 'UNCAUGHT'} row ${t.row.row}: ${describeMutation(t.mutation)} (${Math.round((Date.now() - started) / 1000)} s)`);
    for (const r of results) {
      const own = t.own.some((e) => sameCheck(e, r.e));
      const mark = !r.failed ? '✓ green' : ownCatch(r, t.own) ? '✗ fails (own)' : own ? '✗ fails (own, other reason)' : '✗ fails (neighbour)';
      console.log(`   ${mark} ${describeExpect(r.e)}${r.why ? ` — ${r.why.slice(0, 700)}` : r.detail ? ` — ${r.detail.slice(0, 400)}` : ''}`);
    }
  }
}));

// 3. Итог по строкам: строка ложна, если хотя бы одну её мутацию не поймала ни одна заявленная проверка
const byRow = rows.map((r) => {
  const own = outcomes.filter((o) => o.row === r);
  return { row: r, own, false: own.some((o) => !o.caught) };
});
const falseRows = byRow.filter((r) => r.false);
const lines = [
  '| Строка | Инвариант | Мутация | Поймана своей проверкой | Свои проверки мутации |',
  '|---|---|---|---|---|',
  ...byRow.flatMap((r) => r.own.sort((a, b) => a.id.localeCompare(b.id)).map((o) => `| ${r.row.row} | ${r.row.invariant} | \`${describeMutation(o.mutation).replace(/\|/g, '\\|')}\` | ${o.caught ? 'да' : o.neighbourOnly ? '**нет** (упала только соседняя проверка)' : '**нет**'} | ${o.results.filter((x) => o.own.some((e) => sameCheck(e, x.e))).map((x) => `${ownCatch(x, o.own) ? '✗' : x.failed ? '✗ другая причина' : '✓'} ${describeExpect(x.e)}`).join('<br>').replace(/\|/g, '\\|')} |`)),
  '',
  `Строк с мутациями: ${byRow.length}; ложных (хотя бы одна мутация не поймана заявленными проверками): **${falseRows.length}** — ${falseRows.map((r) => r.row.row).join('; ') || '—'}.`,
  `Мутаций: ${outcomes.length}; не поймано своей проверкой: **${outcomes.filter((o) => !o.caught).length}** (из них упала только соседняя проверка строки: ${outcomes.filter((o) => o.neighbourOnly).length}).`,
  `Не мутировались: ${R93_NOT_MUTATED.map((n) => `${n.row} (${n.why})`).join('; ')}.`,
  '✗ — проверка упала на мутации (поймала), ✓ — осталась зелёной.',
];
console.log(`\n${lines.join('\n')}`);
if (reportPath) writeFileSync(resolve(root, reportPath), `${lines.join('\n')}\n`);
if (!measure && outcomes.some((o) => !o.caught)) {
  console.error('MUTATION CHECK RED: a protection can be removed while its checks stay green (Р-94, Р-95)');
  process.exit(1);
}
