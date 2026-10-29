import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { catalogTestRefs, laneOf, LIGHT_PLACES } from '../ci-lane.mjs';
import { gate, isFastForward, mergeDecision } from '../merge-when-green.mjs';
import { failedJobs, NIGHT_LABEL, nightIssueCommands, nightIssuePlan } from '../night-watch.mjs';

/**
 * Р-236 (шаг 110): две полосы CI. Полосу шага решает скрипт по списку путей диффа, а не суждение: лёгкая — только явный список мест
 * (консоль, модели экранов и словари, тесты консоли быстрой области, документы), всё остальное — тяжёлая («спорное = тяжёлая»). Слияние —
 * по полосе и по последней ночи: красная ночь останавливает слияние любого шага. Полный прогон main — ночью по расписанию.
 */

const root = new URL('../../', import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), 'utf8');
const lane = (paths: string[]) => laneOf(paths).lane;

test('Р-236: лёгкая полоса — только консоль, модели экранов и словари, тесты консоли быстрой области и документы', () => {
  assert.equal(lane(['apps/console/src/screens/Competition.tsx', 'packages/console-model/src/i18n/fr.ts', 'apps/console/test/browser-smoke.test.ts']), 'LIGHT');
  assert.equal(lane(['docs/evidence/step110-ci-lanes.md', 'docs/evidence/step109-ux/after-en-light-1440-competition-summary-us.jpg', 'CLAUDE.md', 'README.md']), 'LIGHT');
  assert.deepEqual(LIGHT_PLACES.map((p) => p.prefix ?? p.exact),
    ['apps/console/src/', 'packages/console-model/src/', 'apps/console/test/', 'docs/', 'CLAUDE.md', 'README.md'], 'список лёгких мест расширяется только решением');
});

test('Р-236: тяжёлая полоса — миграции, движок, хранилище, Gate, симулятор, ClickHouse и всё вне списка; спорное — тяжёлое', () => {
  const heavyOf = (path: string) => laneOf([path]).heavy.map((h) => h.why);
  for (const path of [
    'migrations/0209_example.sql', 'packages/strategy-engine/src/engine.ts', 'packages/stock-sync/src/pipeline.ts', 'packages/pricing-store-pg/src/store.ts',
    'packages/price-gate/src/gate.ts', 'tests/contract/src/simulator/amazon-port.ts', 'packages/analytics-export/src/competitor-history.ts', 'schemas/clickhouse/099_verify.sql',
    // Спорное — тяжёлое: сервер консоли пишет в базу, конфигурация сборки консоли, зависимости, процесс CI, сами правила, снимки каналов, лендинг
    'apps/console/server/stand-server.ts', 'apps/console/vite.config.ts', 'package-lock.json', '.github/workflows/ci.yml', 'scripts/ci-lane.mjs',
    'vendor/amazon/sp-api-models/2026-10-29/SOURCE.md', 'apps/landing/index.html', 'packages/console-model/package.json', 'docsx/readme.md',
  ]) assert.deepEqual(heavyOf(path), ['вне списка лёгких мест'], path);
  // Одного тяжёлого файла хватает, чтобы весь шаг шёл тяжёлой полосой
  assert.equal(lane(['apps/console/src/screens/Offers.tsx', 'migrations/0209_example.sql']), 'HEAVY');
  assert.equal(lane([]), 'HEAVY', 'пустой дифф — спрашивают не о том');
});

test('Р-236: тест в лёгком месте — тяжёлый, если быстрый прогон его не гоняет или на него ссылается каталог мутаций', () => {
  // Зубы [Р-94]: настоящий тест полного прогона из scripts/test-scopes.mjs
  assert.deepEqual(laneOf(['apps/console/test/demo-day-live.pg.test.ts']).heavy.map((h) => h.why), ['тест полного прогона (scripts/test-scopes.mjs)']);
  assert.deepEqual(laneOf(['apps/console/test/shadow-live.pg.test.ts']).heavy.map((h) => h.why), ['тест полного прогона (scripts/test-scopes.mjs)']);
  // Каталог называет тесты и полным путём, и именем файла — оба вида ловятся
  const catalog = catalogTestRefs(`node('summary-step109.pg.test.ts', 'x'); node('apps/console/test/named.pg.test.ts', 'y');`);
  assert.deepEqual([...catalog].sort(), ['apps/console/test/named.pg.test.ts', 'summary-step109.pg.test.ts']);
  assert.equal(laneOf(['apps/console/test/named.pg.test.ts'], { catalog }).lane, 'HEAVY');
  assert.equal(laneOf(['apps/console/test/summary-step109.pg.test.ts'], { catalog }).lane, 'HEAVY');
  assert.equal(laneOf(['apps/console/test/console.test.ts'], { catalog }).lane, 'LIGHT');
  // Настоящий каталог читается: на него ссылаются тесты хранилища
  assert.ok(catalogTestRefs().has('summary-step109.pg.test.ts'), 'каталог мутаций прочитан');
});

const green = { status: 'completed', conclusion: 'success' };
const red = { status: 'completed', conclusion: 'failure' };
const running = { status: 'in_progress', conclusion: null };

test('Р-236: слияние — лёгкая по зелёному быстрому, тяжёлая по обоим; красная ночь останавливает любой шаг', () => {
  const decide = (lane: 'LIGHT' | 'HEAVY', push: object | null, dispatch: object | null, night: object | null, fastForward = true, nightIssue: object | null = null) =>
    mergeDecision({ lane, push, dispatch, night, fastForward, nightIssue });
  assert.deepEqual(decide('LIGHT', green, null, green), { action: 'MERGE', why: 'LIGHT_FAST_GREEN' });
  assert.deepEqual(decide('LIGHT', green, null, null), { action: 'MERGE', why: 'LIGHT_FAST_GREEN' }, 'ночей ещё не было — лёгкая сливается');
  assert.deepEqual(decide('HEAVY', green, null, green), { action: 'WAIT', why: 'FULL_NOT_STARTED' }, 'тяжёлая без полного прогона не сливается');
  assert.deepEqual(decide('HEAVY', green, running, green), { action: 'WAIT', why: 'FULL_RUNNING' });
  assert.deepEqual(decide('HEAVY', green, green, green), { action: 'MERGE', why: 'HEAVY_BOTH_GREEN' });
  assert.deepEqual(decide('HEAVY', green, red, green), { action: 'STOP', why: 'FULL_RED' });
  assert.deepEqual(decide('LIGHT', running, null, green), { action: 'WAIT', why: 'FAST_RUNNING' });
  assert.deepEqual(decide('LIGHT', red, null, green), { action: 'STOP', why: 'FAST_RED' });
  assert.deepEqual(decide('LIGHT', green, null, red), { action: 'STOP', why: 'NIGHT_RED' }, 'красная ночь — шаги не сливаются до зелёной');
  assert.deepEqual(decide('HEAVY', green, green, { status: 'completed', conclusion: 'cancelled' }), { action: 'STOP', why: 'NIGHT_RED' }, 'снятая ночь — не зелёная');
  // Уточнение владельца к Р-236: сливается только fast-forward ПРОВЕРЕННОГО SHA. Main ушёл вперёд — слияние стало бы merge-коммитом или
  // rebase, то есть новым коммитом без прогонов: стоп, шаг перебазируют и прогоняют заново по своей полосе
  assert.deepEqual(decide('HEAVY', green, green, green, false), { action: 'STOP', why: 'NOT_FAST_FORWARD' });
  assert.deepEqual(decide('LIGHT', green, null, null, false), { action: 'STOP', why: 'NOT_FAST_FORWARD' });
  assert.deepEqual(decide('LIGHT', green, null, red, false), { action: 'STOP', why: 'NIGHT_RED' }, 'красная ночь называется первой');
  // Довесок к Р-236: открытый Issue красной ночи (его ведёт сторож ночи) держит слияния вместе с проверкой прогона — и тогда, когда
  // последний прогон main зелёный, но Issue не закрыт (закрывает его только зелёная ночь или человек)
  assert.deepEqual(decide('LIGHT', green, null, green, true, { number: 7 }), { action: 'STOP', why: 'NIGHT_ISSUE_OPEN' });
  assert.deepEqual(decide('HEAVY', green, green, null, true, { number: 7 }), { action: 'STOP', why: 'NIGHT_ISSUE_OPEN' });
});

test('Р-236: ворота сливают только fast-forward — проверка на настоящих репозиториях git', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-lanes-ff-'));
  try {
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=ci-lanes', '-c', 'user.email=ci-lanes@example.invalid', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8' }).trim();
    const commit = (cwd: string, file: string) => { writeFileSync(join(cwd, file), file); git(cwd, 'add', file); git(cwd, 'commit', '-q', '-m', file); return git(cwd, 'rev-parse', 'HEAD'); };
    git(dir, 'init', '-q', '--bare', 'remote.git');
    git(dir, 'clone', '-q', join(dir, 'remote.git'), 'work');
    const work = join(dir, 'work');
    commit(work, 'a');
    git(work, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
    git(work, 'checkout', '-q', '-b', 'step');
    const step = commit(work, 'b');
    assert.equal(isFastForward(step, { cwd: work }), true, 'ветка шага поверх main — перематывается');
    // main ушёл вперёд (другой шаг слит): тот же проверенный SHA больше не перематывается
    git(work, 'checkout', '-q', '-b', 'other', 'origin/main');
    commit(work, 'c');
    git(work, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
    assert.equal(isFastForward(step, { cwd: work }), false, 'main ушёл вперёд — не fast-forward');
    // Перебазированный шаг — новый SHA: перематывается, но его прогонов ещё нет (ворота ищут прогоны по точному SHA)
    git(work, 'checkout', '-q', 'step');
    git(work, 'rebase', '-q', 'origin/main');
    const rebased = git(work, 'rev-parse', 'HEAD');
    assert.notEqual(rebased, step);
    assert.equal(isFastForward(rebased, { cwd: work }), true);
    assert.deepEqual(mergeDecision({ lane: 'HEAVY', push: null, dispatch: null, night: null, fastForward: true, nightIssue: null }), { action: 'WAIT', why: 'FAST_NOT_STARTED' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Р-236: сбой чтения GitHub — ожидание, а не конец ворот; слияние — только после прочитанных зелёных прогонов', async () => {
  const sha = 'f'.repeat(40);
  const run = async (partial: { run: (event: string) => unknown; night: () => unknown; fastForward: () => unknown; nightIssue?: () => unknown }, pushes: boolean[] = [true], maxPolls = 10) => {
    const read = { nightIssue: () => null, ...partial };
    const log: Record<string, unknown>[] = [];
    let pushed = 0;
    const result = await gate({ sha, lane: 'HEAVY', read, push: async () => pushes[pushed++] ?? true, sleep: async () => {}, log: (entry: Record<string, unknown>) => log.push(entry), maxPolls });
    return { result, whys: log.map((l) => l.why), pushed };
  };
  // Шаг 110, первый настоящий запуск ворот: `gh run list` — «TLS handshake timeout», ворота упали, прогоны шли дальше без слияния
  let calls = 0;
  const flaky = await run({ run: () => { if (++calls <= 2) throw new Error('net/http: TLS handshake timeout'); return green; }, night: () => null, fastForward: () => true });
  assert.equal(flaky.result, `MERGED HEAVY ${sha}`);
  assert.deepEqual(flaky.whys, ['READ_FAILED', 'HEAVY_BOTH_GREEN']);
  assert.equal(flaky.pushed, 1);
  // Сеть так и не вернулась — ни одного пуша, честный конец по сроку
  const down = await run({ run: () => green, night: () => { throw new Error('TLS handshake timeout'); }, fastForward: () => true });
  assert.deepEqual([down.result, down.pushed], ['NOT_MERGED TIMEOUT', 0]);
  // git fetch для проверки fast-forward не прошёл — тоже ожидание, не слияние
  const noFetch = await run({ run: () => green, night: () => null, fastForward: () => { throw new Error('fetch failed'); } });
  assert.deepEqual([noFetch.result, noFetch.pushed], ['NOT_MERGED TIMEOUT', 0]);
  // Пуш не прошёл — следующий опрос пробует снова
  const retried = await run({ run: () => green, night: () => null, fastForward: () => true }, [false, true]);
  assert.deepEqual([retried.result, retried.pushed], [`MERGED HEAVY ${sha}`, 2]);
  // Main ушёл вперёд во время ожидания — стоп, а не пуш
  const moved = await run({ run: () => green, night: () => null, fastForward: () => false });
  assert.deepEqual([moved.result, moved.pushed], ['NOT_MERGED NOT_FAST_FORWARD', 0]);
  // Открытый Issue красной ночи — стоп; не прочитался — ожидание, а не «Issue нет»
  const issue = await run({ run: () => green, night: () => green, fastForward: () => true, nightIssue: () => ({ number: 7 }) });
  assert.deepEqual([issue.result, issue.pushed], ['NOT_MERGED NIGHT_ISSUE_OPEN', 0]);
  const issueUnread = await run({ run: () => green, night: () => green, fastForward: () => true, nightIssue: () => { throw new Error('HTTP 502'); } });
  assert.deepEqual([issueUnread.result, issueUnread.pushed], ['NOT_MERGED TIMEOUT', 0]);
});

test('Р-236: сторож ночи — красная ночь открывает Issue, повторная дописывает комментарий, зелёная закрывает', () => {
  const needs = {
    fast: { result: 'success' }, guards: { result: 'success' }, 'clickhouse-compression': { result: 'success' },
    full: { result: 'failure' }, 'demo-day': { result: 'success' }, 'shadow-day': { result: 'success' }, chaos: { result: 'cancelled' }, scale: { result: 'success' },
  };
  const failed = failedJobs(needs);
  assert.deepEqual(failed, [{ job: 'chaos', result: 'cancelled' }, { job: 'full', result: 'failure' }], 'снятое задание — тоже не зелёная ночь');
  assert.deepEqual(failedJobs({ ...needs, full: { result: 'success' }, chaos: { result: 'skipped' } }), [{ job: 'chaos', result: 'skipped' }], 'пропущенное задание — ночь неполная');
  const base = { date: '2026-10-30', runUrl: 'https://github.com/example/repo/actions/runs/1', sha: 'a'.repeat(40), event: 'schedule', owner: 'owner-example' };

  const created = nightIssuePlan({ ...base, failed, openIssues: [] });
  assert.equal(created.kind, 'CREATE');
  assert.equal(created.title, 'Красная ночь 2026-10-30');
  for (const part of [base.runUrl, '`full` — failure', '`chaos` — cancelled', 'aaaaaaaaaaaa', '@owner-example']) assert.ok(created.body.includes(part), part);
  assert.deepEqual(nightIssueCommands(created).map((args) => args.slice(0, 2)), [['label', 'create'], ['issue', 'create']]);
  assert.ok(nightIssueCommands(created)[1]!.includes(NIGHT_LABEL), 'Issue помечен меткой, по которой его находят ворота и сторож');

  // Повторная красная ночь — комментарий в открытый (самый ранний), нового Issue нет
  const open = [{ number: 12, createdAt: '2026-10-31T03:50:00Z' }, { number: 9, createdAt: '2026-10-30T03:50:00Z' }];
  const again = nightIssuePlan({ ...base, date: '2026-10-31', failed, openIssues: open });
  assert.deepEqual([again.kind, again.numbers], ['COMMENT', [9]]);
  assert.ok(again.body.includes('2026-10-31') && again.body.includes('`full` — failure') && !again.body.includes('@owner-example'));
  assert.deepEqual(nightIssueCommands(again), [['issue', 'comment', '9', '--body', again.body]]);

  // Зелёная ночь — комментарий и закрытие всех открытых; без открытых — ничего не пишет
  const closed = nightIssuePlan({ ...base, date: '2026-11-01', failed: [], openIssues: open });
  assert.deepEqual([closed.kind, closed.numbers], ['CLOSE', [9, 12]]);
  assert.deepEqual(nightIssueCommands(closed).map((args) => args.slice(0, 3)), [['issue', 'close', '9'], ['issue', 'close', '12']]);
  assert.ok(closed.body.includes('2026-11-01') && closed.body.includes(base.runUrl));
  assert.deepEqual(nightIssueCommands(nightIssuePlan({ ...base, failed: [], openIssues: [] })), []);
});

/**
 * Р-236, п. 3: полный прогон main — ночью по расписанию; задания полного прогона (полный, сутки демо и тени, хаос, масштаб) идут по
 * расписанию и по запросу, а не на каждый push — тяжёлая полоса запускает их на ветке до слияния, лёгкая их до ночи не ждёт.
 * Быстрые задания (fast, guards, замер сжатия) — на каждый push
 */
const FULL_JOBS = ['full', 'demo-day', 'shadow-day', 'chaos', 'scale'];
const FAST_JOBS = ['fast', 'guards', 'clickhouse-compression'];
const NIGHT_CONDITION = "if: github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'";

function workflowFindings(ci: string): string[] {
  const findings: string[] = [];
  const on = /^on:\n((?: {2}.*\n|\n)*)/m.exec(ci)?.[1] ?? '';
  const cron = /^ {2}schedule:\n {4}- cron: '([^']+)'/m.exec(on)?.[1];
  if (!cron) findings.push('нет ночного расписания on.schedule');
  else if (!/^\d{1,2} \d{1,2} \* \* \*$/.test(cron) || cron.startsWith('0 ')) findings.push(`расписание не раз в сутки или в начале часа: ${cron}`);
  if (!/^ {2}push:/m.test(on) || !/^ {2}workflow_dispatch:/m.test(on)) findings.push('push и workflow_dispatch должны остаться');
  const jobs = new Map([...ci.slice(ci.indexOf('\njobs:\n')).matchAll(/^ {2}([a-z-]+):\n((?: {4}.*\n|\n)*)/gm)].map((m) => [m[1]!, m[2]!]));
  for (const job of FULL_JOBS) {
    const body = jobs.get(job);
    if (!body) findings.push(`нет задания ${job}`);
    else if (!body.split('\n').some((line) => line.trim() === NIGHT_CONDITION)) findings.push(`${job}: не только ночью и по запросу`);
  }
  for (const job of FAST_JOBS) {
    const body = jobs.get(job);
    if (!body) findings.push(`нет задания ${job}`);
    else if (/^ {4}if:/m.test(body)) findings.push(`${job}: быстрое задание должно идти на каждый push`);
  }
  // Довесок к Р-236: сторож ночи — после ВСЕХ заданий, при любом их исходе, только на main ночью или по запросу, с правом на Issues
  const watch = jobs.get('night-watch');
  if (!watch) findings.push('нет задания night-watch');
  else {
    const needs = /^ {4}needs: \[([^\]]*)\]/m.exec(watch)?.[1]?.split(',').map((s) => s.trim()) ?? [];
    const missing = [...jobs.keys()].filter((j) => j !== 'night-watch' && !needs.includes(j));
    if (missing.length > 0) findings.push(`night-watch: не ждёт ${missing.join(', ')}`);
    if (watch.split('\n').find((line) => /^ {4}if:/.test(line))?.trim() !== WATCH_CONDITION) findings.push('night-watch: не при любом исходе ночи на main');
    if (!/^ {6}issues: write$/m.test(watch)) findings.push('night-watch: нет права issues: write');
    if (!/run: node scripts\/night-watch\.mjs$/m.test(watch)) findings.push('night-watch: не запускает scripts/night-watch.mjs');
  }
  return findings;
}
const WATCH_CONDITION = "if: always() && github.ref == 'refs/heads/main' && (github.event_name == 'schedule' || github.event_name == 'workflow_dispatch')";

test('Р-236: ночной полный прогон main по расписанию; полные задания — ночью и по запросу, быстрые — на каждый push', () => {
  const ci = read('.github/workflows/ci.yml');
  assert.deepEqual(workflowFindings(ci), []);
  // Зубы [Р-94]: прежнее условие «на push в main» и пропавшее расписание правило видит
  const old = ci.replaceAll(NIGHT_CONDITION, "if: github.ref == 'refs/heads/main' || github.event_name == 'workflow_dispatch'").replace(/^ {2}schedule:\n {4}- cron: '[^']+'.*\n/m, '');
  assert.deepEqual(workflowFindings(old), ['нет ночного расписания on.schedule', ...FULL_JOBS.map((j) => `${j}: не только ночью и по запросу`)]);
  assert.deepEqual(workflowFindings(ci.replace(/- cron: '[^']+'/, "- cron: '0 2 * * *'")), ["расписание не раз в сутки или в начале часа: 0 2 * * *"],
    'начало часа — время наибольшей нагрузки GitHub Actions: запуск сдвигают или снимают');
  // Зубы сторожа: забытое задание в needs, if: failure() (зелёная ночь не закрыла бы Issue), без права на Issues
  assert.deepEqual(workflowFindings(ci.replace(/^( {4}needs: \[[^\]]*), scale\]/m, '$1]')), ['night-watch: не ждёт scale']);
  assert.deepEqual(workflowFindings(ci.replace('if: always() &&', 'if: failure() &&')), ['night-watch: не при любом исходе ночи на main']);
  assert.deepEqual(workflowFindings(ci.replace(/^ {6}issues: write\n/m, '')), ['night-watch: нет права issues: write']);
});
