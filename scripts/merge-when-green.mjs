// Р-236 (шаг 110): слияние шага в main — по полосе шага и по последней ночи.
//
//   node scripts/merge-when-green.mjs <ветка> <sha>
//
// Полосу решает scripts/ci-lane.mjs по диффу ветки против origin/main. Тяжёлая полоса ждёт оба прогона того же коммита — быстрый (push)
// и полный (workflow_dispatch, его запускают при отправке ветки); лёгкая — только быстрый, затронутые тесты называются в отчёте шага.
// Красная последняя ночь (полный прогон main по расписанию или по запросу на main) — шаг не сливается вовсе: сначала разбор ночи.
// Скрипт вне CI: он отправляет коммит в main тем же путём, что человек (git push), и печатает, почему слил или не слил.

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { changedPaths, laneOf } from './ci-lane.mjs';
import { NIGHT_LABEL } from './night-watch.mjs';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));

/**
 * Решение по состоянию прогонов. `push`, `dispatch` — прогон ветки этого коммита или null; `night` — последний ЗАВЕРШЁННЫЙ полный
 * прогон main или null (ночей ещё не было); `fastForward` — перематывается ли main на этот коммит. Сливается только fast-forward
 * проверенного SHA (уточнение владельца к Р-236): merge-коммит или rebase — новый коммит без прогонов. `nightIssue` — открытый Issue
 * красной ночи (его ведёт scripts/night-watch.mjs) или null: держит слияния вместе с проверкой прогона. Возвращает
 * `{ action: 'MERGE' | 'WAIT' | 'STOP', why }`
 */
export function mergeDecision({ lane, push, dispatch, night, fastForward, nightIssue }) {
  const done = (r) => r !== null && r.status === 'completed';
  if (night !== null && night.conclusion !== 'success') return { action: 'STOP', why: 'NIGHT_RED' };
  if (nightIssue !== null) return { action: 'STOP', why: 'NIGHT_ISSUE_OPEN' };
  if (fastForward !== true) return { action: 'STOP', why: 'NOT_FAST_FORWARD' };
  if (done(push) && push.conclusion !== 'success') return { action: 'STOP', why: 'FAST_RED' };
  if (lane !== 'LIGHT' && done(dispatch) && dispatch.conclusion !== 'success') return { action: 'STOP', why: 'FULL_RED' };
  if (!done(push)) return { action: 'WAIT', why: push === null ? 'FAST_NOT_STARTED' : 'FAST_RUNNING' };
  if (lane !== 'LIGHT' && !done(dispatch)) return { action: 'WAIT', why: dispatch === null ? 'FULL_NOT_STARTED' : 'FULL_RUNNING' };
  return { action: 'MERGE', why: lane === 'LIGHT' ? 'LIGHT_FAST_GREEN' : 'HEAVY_BOTH_GREEN' };
}

/** Перематывается ли main на этот коммит: `<remote>/main` — его предок (после свежего fetch) */
export function isFastForward(sha, { cwd = repoRoot, remote = 'origin' } = {}) {
  execFileSync('git', ['fetch', '-q', remote, 'main'], { cwd, stdio: 'ignore', timeout: 120_000 });
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', `${remote}/main`, sha], { cwd, stdio: 'ignore', timeout: 60_000 });
    return true;
  } catch (error) {
    if (error.status === 1) return false;
    throw error;
  }
}

/**
 * Цикл ворот. `read.run(event)` — прогон ветки этого коммита, `read.night()` — последняя ночь, `read.fastForward()` — перематывается ли
 * main на коммит; `push()` — одна попытка отправить коммит в main, true при успехе. Сбой чтения (сеть, GitHub) — ожидание до следующего
 * опроса, а не конец ворот: шаг 110 — первый настоящий запуск упал на «TLS handshake timeout», и прогоны шли дальше без слияния.
 * Возвращает строку итога: `MERGED <полоса> <sha>` или `NOT_MERGED <причина>`
 */
export async function gate({ sha, lane, read, push, sleep, log, maxPolls = 480, pollMs = 60_000 }) {
  let last = '';
  for (let i = 0; i < maxPolls; i++) {
    let decision;
    let night = null;
    let error;
    try {
      night = await read.night();
      const nightIssue = await read.nightIssue();
      const fastForward = await read.fastForward();
      decision = mergeDecision({ lane, push: await read.run('push'), dispatch: lane === 'LIGHT' ? null : await read.run('workflow_dispatch'), night, fastForward, nightIssue });
    } catch (failure) {
      decision = { action: 'WAIT', why: 'READ_FAILED' };
      error = String(failure?.stderr || failure?.message || failure).split('\n').find(Boolean)?.slice(0, 200);
    }
    if (decision.why !== last) {
      log({ at: new Date().toISOString(), ...decision, ...(error ? { error } : { night: night && { id: night.databaseId, conclusion: night.conclusion } }) });
      last = decision.why;
    }
    if (decision.action === 'STOP') return `NOT_MERGED ${decision.why}`;
    if (decision.action === 'MERGE' && (await push())) return `MERGED ${lane} ${sha}`;
    await sleep(pollMs);
  }
  return 'NOT_MERGED TIMEOUT';
}

const gh = (args) => JSON.parse(execFileSync('gh', args, { encoding: 'utf8', timeout: 120_000 }));
const FIELDS = 'databaseId,headSha,event,status,conclusion,createdAt';
const latest = (runs) => [...runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;

/** Прогон ветки этого коммита данного события — последний по времени */
function runOf(branch, sha, event) {
  return latest(gh(['run', 'list', '--branch', branch, '--event', event, '--limit', '30', '--json', FIELDS]).filter((r) => r.headSha === sha));
}

/** Последний завершённый полный прогон main: ночь по расписанию или повтор по запросу на main */
function lastNight() {
  const runs = ['schedule', 'workflow_dispatch'].flatMap((event) => gh(['run', 'list', '--branch', 'main', '--event', event, '--limit', '20', '--json', FIELDS]));
  return latest(runs.filter((r) => r.status === 'completed'));
}

/** Открытый Issue красной ночи (метка night-red, scripts/night-watch.mjs) — самый ранний, или null */
function openNightIssue() {
  const issues = gh(['issue', 'list', '--label', NIGHT_LABEL, '--state', 'open', '--json', 'number,title,createdAt', '--limit', '20']);
  return [...issues].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0] ?? null;
}

/** Одна попытка: тот же коммит в main, без force — не-FF отклоняет сам git */
function pushMain(sha) {
  try {
    execFileSync('git', ['-c', 'http.version=HTTP/1.1', '-c', 'http.lowSpeedLimit=0', 'push', 'origin', `${sha}:refs/heads/main`], { stdio: 'inherit', timeout: 300_000 });
    return true;
  } catch {
    console.log(JSON.stringify({ at: new Date().toISOString(), push: 'failed' }));
    return false;
  }
}

async function main() {
  const [branch, sha] = process.argv.slice(2);
  if (!branch || !/^[0-9a-f]{40}$/.test(sha ?? '')) throw new Error('usage: merge-when-green.mjs <branch> <40-hex sha>');
  execFileSync('git', ['fetch', '-q', 'origin', 'main'], { timeout: 120_000 });
  const paths = changedPaths('origin/main', sha);
  const { lane, heavy } = laneOf(paths);
  console.log(JSON.stringify({ branch, sha, lane, files: paths.length, heavy: heavy.slice(0, 20) }));
  const result = await gate({
    sha, lane,
    read: { run: (event) => runOf(branch, sha, event), night: lastNight, nightIssue: openNightIssue, fastForward: () => isFastForward(sha) },
    push: () => pushMain(sha),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log: (entry) => console.log(JSON.stringify(entry)),
  });
  console.log(result);
  if (!result.startsWith('MERGED')) process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
