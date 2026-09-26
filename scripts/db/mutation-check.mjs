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
    ['svc_admin', 'tests/db/smoke_admin.sql'], ['svc_app', 'tests/db/smoke_path.sql'],
    // Шаг 30 [Р-139]: защиты фоновых заданий — файл переключает роль на исполнителя сам
    ['svc_admin', 'tests/db/smoke_bulk_jobs.sql'], ['svc_admin', 'tests/db/smoke_onboarding.sql'],
    // Шаг 37 [Р-160]: гостя заводит роль онбординга, а всё, чего он не может, проверяет административная
    ['svc_onboarding', 'tests/db/smoke_guest.sql'], ['svc_admin', 'tests/db/smoke_guest_admin.sql'], ['postgres', 'tests/db/smoke_r65.sql'],
    ['svc_stock', 'tests/db/smoke_stock.sql'], ['svc_admin', 'tests/db/smoke_stock_path.sql'],
    // Шаг 41 [Р-169]: теневой режим — после проверок отправки, тем же порядком, что в prepare.sh
    ['svc_admin', 'tests/db/smoke_shadow.sql'], ['postgres', 'tests/db/smoke_append_only.sql'], ['svc_admin', 'tests/db/smoke_alerts.sql'], ['svc_alert_delivery', 'tests/db/smoke_alerts_delivery.sql'],
    // Шаг 40 [Р-165]: панель оператора — тем же порядком, что у остальных ролей, и после доставки алертов (ей нужен доставленный алерт)
    ['svc_operator', 'tests/db/smoke_operator.sql'],
    ['svc_scheduler', 'tests/db/smoke_retention.sql']];
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
    // Шаг 19 [Р-99]: причина провала — ФАКТИЧЕСКИЙ результат: поле error без текста ожидаемого шаблона и поле actual.
    // Поле expected и шаблон в сообщении assert.match («did not match the regular expression /…/») не учитываются: они совпадают
    // с причиной при любом отказе (ревью шага 18, находка 9)
    const after = r.out.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + 6000);
    const end = after.search(/^\s*(?:not )?ok \d+ - /m);
    const block = end >= 0 ? after.slice(0, end) : after;
    return { name: m[1], why: tapFailure(block), error: tapField(block, 'error', true), actual: tapField(block, 'actual') };
  });
  const passed = [...r.out.matchAll(/^\s*ok \d+ - (.*)$/gm)].map((m) => m[1]);
  return { code: r.code, failed, passed, out: r.out };
}

/** Поле YAML блока TAP: однострочное значение или блок «|-» до следующего ключа того же отступа; lines — сохранить переводы строк */
function tapField(block, key, keepLines = false) {
  const lines = block.split('\n');
  const i = lines.findIndex((l) => new RegExp(`^\\s*${key}:`).test(l));
  if (i < 0) return '';
  const indent = lines[i].match(/^\s*/)[0].length;
  const first = lines[i].replace(new RegExp(`^\\s*${key}:\\s*`), '');
  const rest = [];
  for (let j = i + 1; j < lines.length; j++) {
    const ind = lines[j].match(/^\s*/)[0].length;
    if (lines[j].trim() !== '' && ind <= indent) break;
    rest.push(lines[j]);
  }
  if (keepLines) return [first.replace(/^\|-?$/, ''), ...rest].map((l) => l.trim()).filter((l) => l !== '').join('\n').replace(/^'(.*)'$/s, '$1');
  return [first.replace(/^\|-?$/, ''), ...rest].join(' ').replace(/\s+/g, ' ').trim();
}
function tapFailure(block) {
  const error = tapField(block, 'error')
    .replace(/The input did not match the regular expression \/.*?\/\. Input:/s, 'Input:')
    .replace(/The input was expected to not match the regular expression \/.*?\/\. Input:/s, 'Input:');
  return `${error} ${tapField(block, 'actual')}`.trim().slice(0, 1500);
}

/** Проверки одной конфигурации базы: что провалилось из ожидаемого */
/** Провал теста — провал СВОЕГО утверждения проверки с результатом «защиты нет» (не отказ по другой причине) */
function nodeOwnFailure(e, failure) {
  const [firstLine = '', ...restLines] = (failure.error ?? '').split('\n');
  const labels = Array.isArray(e.label) ? e.label : [e.label];
  for (const label of labels) {
    if (e.unprotected === 'resolved') {
      if (firstLine === `Missing expected rejection: ${label}`) return true;
      continue;
    }
    const m = typeof label === 'string' ? (firstLine === label ? [firstLine] : null) : new RegExp(`^(?:${label.re})$`).exec(firstLine);
    if (!m) continue;
    // Метка с подстановкой объявляет результат группой выражения; иначе — поле actual, при его отсутствии — остаток текста провала
    const evidence = m[1] !== undefined ? m[1] : failure.actual !== '' ? failure.actual.replace(/^'(.*)'$/, '$1') : restLines.join(' ').trim();
    if (new RegExp(e.unprotected).test(evidence)) return true;
  }
  return false;
}

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
      // Шаг 19 [Р-99]: метка сверяется ЦЕЛИКОМ (до « | » или конца строки), а не подстрокой; своей поимкой считается только
      // «отказа не было» и исключение DO-блока с текстом, равным метке. «Отказ по другой причине» — упала проверка, но мутацию
      // поймала другая защита (ревью шага 18, находка 8)
      const lines = s.out.split('\n');
      for (const e of smokeChecks) {
        // Шаг 28: проверка разрешённого действия (pg_temp.ok) падает своей причиной — «законное действие отклонено». У неё нет
        // ожидаемой причины отказа: сам факт отказа и есть поимка снятой защиты, которая ломает работу продавца
        const didNot = lines.find((l) => l.includes(`CHECK FAILED: ${e.smoke} | EXPECTED FAILURE DID NOT HAPPEN`) || l.endsWith(`EXPECTED FAILURE DID NOT HAPPEN: ${e.smoke}`)
          || l.includes(`CHECK FAILED: ${e.smoke} | ACCEPTED ACTION WAS REFUSED`)
          || /ERROR:\s+(.*)$/.exec(l)?.[1] === e.smoke);
        const other = lines.find((l) => l.includes(`CHECK FAILED: ${e.smoke} | EXPECTED FAILURE HAD ANOTHER REASON`) || l.includes(`CHECK FAILED: ${e.smoke} | EXPECTED FAILURE HAS NO DECLARED REASON`)
          || l.endsWith(`: ${e.smoke}`) && /EXPECTED FAILURE HAD ANOTHER REASON/.test(l));
        const reachedBy = e.reached ?? e.smoke;
        const reached = lines.some((l) => l.includes(`| ${reachedBy} |`) || l.endsWith(`| ${reachedBy}`) || l.includes(`CHECK FAILED: ${e.smoke} |`) || /ERROR:\s+(.*)$/.exec(l)?.[1] === e.smoke);
        const hit = didNot ?? other;
        results.push({ e, failed: Boolean(hit), ownReason: Boolean(didNot), detail: hit ? hit.slice(0, 300) : reached ? '' : `not reached (${s.stopped ?? 'label absent'})` });
      }
    }
    const files = [...new Set(expect.filter((x) => x.node).map((x) => x.node))];
    for (const file of files) {
      const r = await nodeTest(file, db, tpl);
      for (const e of expect.filter((x) => x.node === file)) {
        const hits = r.failed.filter((t) => t.name.includes(e.test));
        const known = [...r.failed.map((t) => t.name), ...r.passed].some((t) => t.includes(e.test));
        // Шаг 19, ревью шага 19 (находка 1): сообщение утверждения попадает в поле error при ЛЮБОМ провале, в том числе при отказе
        // по другой причине. Своя поимка — только провал утверждения с точной меткой, у которого фактический результат — «защиты нет»:
        // для assert.rejects — «Missing expected rejection: <метка>» (отказа не было вовсе); для остальных — поле actual (а если его
        // нет — остаток текста провала после метки) совпадает с объявленным шаблоном «без защиты»
        const own = hits.filter((t) => nodeOwnFailure(e, t));
        results.push({ e, failed: hits.length > 0, ownReason: own.length > 0, why: hits.map((t) => t.why).join(' ; '),
          detail: hits.length > 0 ? hits.map((t) => `${t.name} [${t.why}]`).join('; ') : known ? '' : `test not found (exit ${r.code})` });
      }
    }
  } finally {
    await dropDb(db);
    await dropDb(tpl);
  }
  return results;
}

const labelText = (l) => (Array.isArray(l) ? l : [l]).map((x) => typeof x === 'string' ? x : `/${x.re}/`).join(' | ');
const describeExpect = (e) => e.smoke !== undefined ? `smoke «${e.smoke}»` : e.verify ? `verify ${e.verify.replace('migrations/', '')}${e.reason ? ` /${e.reason}/` : ''}`
  : `${e.node.split('/').pop()} «${e.test}» [${labelText(e.label)}] без защиты: ${e.unprotected}`;
const describeMutation = (m) => typeof m === 'string' ? m.replace(/\s+/g, ' ').slice(0, 110) : `${m.fn}: «${m.from.slice(0, 50)}…» → «${m.to.slice(0, 30)}…»`;
const sameCheck = (a, b) => describeExpect(a) === describeExpect(b);

const { R93_ROWS, STEP17_ROWS = [], STEP18_ROWS = [], STEP19_ROWS = [], STEP20_ROWS = [], STEP21_ROWS = [], STEP22_ROWS = [], STEP23_ROWS = [], STEP24_ROWS = [], STEP25_ROWS = [], STEP25_B_ROWS = [], STEP25_D_ROWS = [], STEP26_ROWS = [], STEP27_ROWS = [], STEP28_ROWS = [], STEP30_ROWS = [], STEP32_ROWS = [], STEP34_ROWS = [], STEP35_ROWS = [], STEP36_ROWS = [], STEP37_ROWS = [], STEP40_ROWS = [], STEP41_ROWS = [], R93_NOT_MUTATED = [] } = await import(pathToFileURL(catalogPath).href);
const rows = [...R93_ROWS, ...(process.argv.includes('--r93-only') ? [] : [...STEP17_ROWS, ...STEP18_ROWS, ...STEP19_ROWS, ...STEP20_ROWS, ...STEP21_ROWS, ...STEP22_ROWS, ...STEP23_ROWS, ...STEP24_ROWS, ...STEP25_ROWS, ...STEP25_B_ROWS, ...STEP25_D_ROWS, ...STEP26_ROWS, ...STEP27_ROWS, ...STEP28_ROWS, ...STEP30_ROWS, ...STEP32_ROWS, ...STEP34_ROWS, ...STEP35_ROWS, ...STEP36_ROWS, ...STEP37_ROWS, ...STEP40_ROWS, ...STEP41_ROWS])]
  .filter((r) => !only || only.includes(r.row))
  // Задача E шага 30 [OQ-203]: быстрый прогон CI гоняет критичные строки каталога — защиты, которыми держится цена
  .filter((r) => !process.argv.includes('--critical') || r.critical === true);

// Р-99: у каждой мутации — свои проверки; у проверки теста и проверки схемы — обязательная причина (тест и проверка схемы падают по многим причинам)
for (const r of rows) {
  if (!Array.isArray(r.mutations) || r.mutations.some((m) => !m.apply || !Array.isArray(m.own) || m.own.length === 0)) {
    throw new Error(`catalog row ${r.row}: every mutation needs apply and its own checks (Р-99)`);
  }
  for (const m of r.mutations) for (const e of m.own) {
    if (e.node !== undefined && (!e.test || !e.label || !e.unprotected)) {
      throw new Error(`catalog row ${r.row}: a test check names the test, the exact assertion label and the unprotected outcome (Р-99, step 19 review)`);
    }
    if (e.verify !== undefined && !e.reason) throw new Error(`catalog row ${r.row}: a schema check names the reason (Р-99)`);
  }
  r.expect = [];
  for (const m of r.mutations) for (const e of m.own) if (!r.expect.some((x) => sameCheck(x, e))) r.expect.push(e);
}
/** Своя проверка поймала мутацию: проверка упала и причина совпала (смоук — сам expect_fail, тест — nodeOwnFailure, схема — текст отказа) */
const ownCatch = (result, own) => result.failed && own.some((e) => sameCheck(e, result.e))
  && (result.e.verify !== undefined ? new RegExp(result.e.reason).test(result.detail) : result.ownReason);

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
