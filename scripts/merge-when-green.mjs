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

/**
 * Решение по состоянию прогонов. `push`, `dispatch` — прогон ветки этого коммита или null; `night` — последний ЗАВЕРШЁННЫЙ полный
 * прогон main или null (ночей ещё не было). Возвращает `{ action: 'MERGE' | 'WAIT' | 'STOP', why }`
 */
export function mergeDecision({ lane, push, dispatch, night }) {
  const done = (r) => r !== null && r.status === 'completed';
  if (night !== null && night.conclusion !== 'success') return { action: 'STOP', why: 'NIGHT_RED' };
  if (done(push) && push.conclusion !== 'success') return { action: 'STOP', why: 'FAST_RED' };
  if (lane !== 'LIGHT' && done(dispatch) && dispatch.conclusion !== 'success') return { action: 'STOP', why: 'FULL_RED' };
  if (!done(push)) return { action: 'WAIT', why: push === null ? 'FAST_NOT_STARTED' : 'FAST_RUNNING' };
  if (lane !== 'LIGHT' && !done(dispatch)) return { action: 'WAIT', why: dispatch === null ? 'FULL_NOT_STARTED' : 'FULL_RUNNING' };
  return { action: 'MERGE', why: lane === 'LIGHT' ? 'LIGHT_FAST_GREEN' : 'HEAVY_BOTH_GREEN' };
}

const gh = (args) => JSON.parse(execFileSync('gh', args, { encoding: 'utf8' }));
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

async function main() {
  const [branch, sha] = process.argv.slice(2);
  if (!branch || !/^[0-9a-f]{40}$/.test(sha ?? '')) throw new Error('usage: merge-when-green.mjs <branch> <40-hex sha>');
  execFileSync('git', ['fetch', '-q', 'origin', 'main']);
  const paths = changedPaths('origin/main', sha);
  const { lane, heavy } = laneOf(paths);
  console.log(JSON.stringify({ branch, sha, lane, files: paths.length, heavy: heavy.slice(0, 20) }));
  let last = '';
  for (let i = 0; i < 480; i++) {
    const night = lastNight();
    const decision = mergeDecision({ lane, push: runOf(branch, sha, 'push'), dispatch: lane === 'LIGHT' ? null : runOf(branch, sha, 'workflow_dispatch'), night });
    if (decision.why !== last) { console.log(JSON.stringify({ at: new Date().toISOString(), ...decision, night: night && { id: night.databaseId, conclusion: night.conclusion } })); last = decision.why; }
    if (decision.action === 'STOP') { console.log(`NOT_MERGED ${decision.why}`); process.exit(1); }
    if (decision.action === 'MERGE') {
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          execFileSync('git', ['-c', 'http.version=HTTP/1.1', '-c', 'http.lowSpeedLimit=0', 'push', 'origin', `${sha}:refs/heads/main`], { stdio: 'inherit' });
          console.log(`MERGED ${lane} ${sha}`);
          return;
        } catch { console.log(`push attempt ${attempt} failed`); }
      }
      console.log('NOT_MERGED PUSH_FAILED');
      process.exit(1);
    }
    await new Promise((resolve) => setTimeout(resolve, 60_000));
  }
  console.log('NOT_MERGED TIMEOUT');
  process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
