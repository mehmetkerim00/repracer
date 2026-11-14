import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

/**
 * Шаг 131 (решение владельца 2026-11-15, п. 3.3): откат выкладки пилота.
 *  - Выкладка спрашивает план миграций (scripts/db/migrate.sh --check) ДО того, как переключить рабочую копию. Версия старше базы — отказ с понятной
 *    причиной, а не «applied migrations changed» после сборки, когда процессы уже стоят на чужих файлах.
 *  - Если у выкладки есть миграции, перед ними снимается копия базы. Рядом кладётся отметка `.pre-release`: какая версия была, какая
 *    выкладывается и на какой миграции стояла база. Ей и откатываются (шаг 132).
 * Docker подменён командой, которая пишет свои аргументы и отвечает как сервис backup. План миграций проверяется на настоящем PostgreSQL —
 * scripts/test/db-migrate.test.ts. Данные синтетические.
 */
const root = new URL('../../', import.meta.url).pathname;
let work = '';
let wrap = '';
let bin = '';
let backups = '';

before(() => {
  work = mkdtempSync(join(tmpdir(), 'repracer-pilot-rollback-'));
  wrap = join(work, 'pilot');
  mkdirSync(wrap, { recursive: true });
  for (const f of ['compose.sh', 'pre-release-copy.sh']) if (existsSync(join(root, 'deploy/pilot', f))) copyFileSync(join(root, 'deploy/pilot', f), join(wrap, f));
  const secrets = join(work, 'secrets');
  backups = join(work, 'backups');
  mkdirSync(secrets, { recursive: true });
  mkdirSync(backups, { recursive: true });
  writeFileSync(join(secrets, 'amazon.env'), 'REPRACER_AMAZON_APP_ID=amzn1.sp.solution.syn\n');
  writeFileSync(join(wrap, 'pilot.env'), `REPRACER_SECRETS_DIR=${secrets}\nREPRACER_BACKUP_DIR=${backups}\nREPRACER_BACKUP_OFFSITE=pull\n`);
  writeFileSync(join(wrap, 'build.env'), 'REPRACER_BUILD_SHA=x\n');
  bin = join(work, 'bin');
  mkdirSync(bin, { recursive: true });
  // `docker compose … run --rm -T -e REPRACER_BACKUP_ONCE=1 backup` — как backup-loop: копия в каталоге и строка BACKUP_DONE; DOCKER_FAIL — провал копии
  writeFileSync(join(bin, 'docker'), `#!/bin/bash
printf '%s\\n' "$*" >> '${join(work, 'docker.log')}'
if [ -e '${join(work, 'docker-fail')}' ]; then echo '{"event":"ALERT","code":"BACKUP_FAILED"}' >&2; exit 1; fi
s=20261115T101500Z
: > '${backups}'/repracer-$s.dump.gpg; : > '${backups}'/repracer-$s.globals.sql.gpg; echo sums > '${backups}'/repracer-$s.sha256
echo '{"event":"BACKUP_DONE","file":"repracer-'$s'.dump.gpg","bytes":42,"encrypted":true}'
`);
  chmodSync(join(bin, 'docker'), 0o755);
});
after(() => { if (work) rmSync(work, { recursive: true, force: true }); });

const run = (args: string[]) => {
  const r = spawnSync('bash', [join(wrap, 'pre-release-copy.sh'), ...args], { env: { PATH: `${bin}:${process.env.PATH ?? ''}`, HOME: work }, encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};
const OLD = '1111111111111111111111111111111111111111';
const NEW = '2222222222222222222222222222222222222222';

test('step 131: pre-release-copy.sh takes one copy with the backup service and marks it with the release it precedes', () => {
  const ok = run([OLD, NEW, '0231']);
  assert.equal(ok.code, 0, ok.out);
  assert.match(readFileSync(join(work, 'docker.log'), 'utf8'), / run --rm -T -e REPRACER_BACKUP_ONCE=1 backup$/m, 'one pass of the same copy loop — not another dump');
  const mark = JSON.parse(readFileSync(join(backups, 'repracer-20261115T101500Z.pre-release'), 'utf8')) as Record<string, string>;
  assert.deepEqual([mark.before, mark.release, mark.migrationsBefore], [OLD, NEW, '0231']);
  assert.match(mark.at!, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.match(ok.out, /PRE-RELEASE COPY: repracer-20261115T101500Z — база на миграции 0231/);
  // Провал копии — отказ: без неё откат через миграцию невозможен, и выкладка останавливается до миграций
  writeFileSync(join(work, 'docker-fail'), '');
  rmSync(join(backups, 'repracer-20261115T101500Z.pre-release'));
  const red = run([OLD, NEW, '0231']);
  rmSync(join(work, 'docker-fail'));
  assert.equal(red.code, 1, red.out);
  assert.match(red.out, /PRE-RELEASE COPY RED: копия базы перед миграциями не снялась/);
  assert.ok(!existsSync(join(backups, 'repracer-20261115T101500Z.pre-release')), 'no mark without a copy');
  assert.equal(run(['abc', NEW, '0231']).code, 2, 'a SHA is 40 hex digits');
  assert.equal(run([OLD, NEW, '231']).code, 2, 'a migration number is four digits');
});

test('step 131: deploy.sh asks the migration plan of the target BEFORE it switches the working copy; older than the database — a plain refusal; pending migrations — a copy first', () => {
  const deploy = readFileSync(join(root, 'deploy/pilot/deploy.sh'), 'utf8');
  const at = (s: string) => { const i = deploy.indexOf(s); assert.ok(i >= 0, `deploy.sh has ${s}`); return i; };
  assert.ok(at('. deploy/pilot/pilot.env') < at('migrate.sh "${REPRACER_PILOT_DB}" --check'), 'pilot.env is read before the plan');
  assert.ok(at('git archive "${target}" migrations') < at('migrate.sh "${REPRACER_PILOT_DB}" --check'), 'the plan is of the TARGET migrations, not of the working copy');
  assert.ok(at('migrate.sh "${REPRACER_PILOT_DB}" --check') < at('git checkout --quiet --detach'), 'the plan is asked before the checkout');
  assert.ok(at('git checkout --quiet --detach') < at('npm ci'), 'and before anything is built');
  assert.match(deploy, /3\) echo "DEPLOY RED: версия .* старше базы пилота — выкладка остановлена ДО переключения рабочей копии/);
  assert.match(deploy, /README\.md, «Откат»/);
  const copy = at('deploy/pilot/pre-release-copy.sh "${before}" "${sha}" "${at}"');
  assert.ok(at('up -d --wait postgres clickhouse') < copy && copy < at('bash /repo/deploy/pilot/db.sh'), 'the copy is taken after the database is up and before the migrations');
  assert.match(deploy, /if \[ "\$\{pending\}" -gt 0 \]; then/, 'only a release with migrations pays for a copy');
  // Каталог плана — вне git
  assert.match(readFileSync(join(root, '.gitignore'), 'utf8'), /^deploy\/pilot\/state\/$/m);
  assert.equal(spawnSync('bash', ['-n', join(root, 'deploy/pilot/deploy.sh')]).status, 0);
  // Журнал выкладок — откат без SHA возвращает к версии, с которой ушла последняя выкладка
  assert.ok(at('"${before}" "${sha}" >> deploy/pilot/state/releases.log') > at('up -d --wait --remove-orphans'), 'a release is logged once the processes are up');
});

test('step 131: rollback.sh — no migrations between the versions: a deploy of the previous version; the database newer: stop, restore the pre-release copy in place, then deploy', () => {
  const rb = readFileSync(join(root, 'deploy/pilot/rollback.sh'), 'utf8');
  const at = (s: string) => { const i = rb.indexOf(s); assert.ok(i >= 0, `rollback.sh has ${s}`); return i; };
  assert.ok(at('git archive "${target}" migrations') < at('migrate.sh "${REPRACER_PILOT_DB}" --check'), 'the plan is of the previous version');
  assert.match(rb, /0\) echo "== миграций между версиями нет[^"]*"\n\s+exec deploy\/pilot\/deploy\.sh "\$\{target\}" ;;/, 'no migrations — a plain deploy of the previous version, the database untouched');
  assert.ok(at('[ ! -t 0 ] || red') < at('"${C}" ps --services --status running | grep -vx postgres | xargs -r "${C}" stop'), 'the key is asked before anything stops');
  assert.ok(at('logs-archive.sh --until-now') < at('xargs -r "${C}" stop'), 'logs up to now before the stop');
  const restore = at('--entrypoint bash backup /repo/deploy/pilot/rollback-inner.sh /backups "${target}"');
  assert.ok(at('xargs -r "${C}" stop') < restore && restore < rb.lastIndexOf('deploy/pilot/deploy.sh "${target}"'), 'stop → restore in place → deploy the previous version');
  assert.match(rb, /tail -1 deploy\/pilot\/state\/releases\.log \| awk '\{print \$2\}'/, 'without a SHA — the version the last release left');
  assert.equal(spawnSync('bash', ['-n', join(root, 'deploy/pilot/rollback.sh')]).status, 0);
  assert.equal(spawnSync('bash', ['-n', join(root, 'deploy/pilot/rollback-inner.sh')]).status, 0);
});

test('step 132: reset.sh — only on QA-B (REPRACER_PILOT_STAND=qa-b), refused before anything stops; then stop, a copy before the reset, the database reset, processes, smoke', () => {
  // reset.sh ищет deploy/pilot/pilot.env от корня репозитория — копия раскладки репозитория со своими настройками
  const repo = join(work, 'reset-repo', 'deploy', 'pilot');
  mkdirSync(repo, { recursive: true });
  for (const f of ['reset.sh', 'compose.sh']) copyFileSync(join(root, 'deploy/pilot', f), join(repo, f));
  writeFileSync(join(repo, 'build.env'), 'REPRACER_BUILD_SHA=x\n');
  const before = readFileSync(join(wrap, 'pilot.env'), 'utf8');
  for (const stand of ['', 'REPRACER_PILOT_STAND=pilot\n']) {
    writeFileSync(join(repo, 'pilot.env'), `${before}${stand}`);
    rmSync(join(work, 'docker.log'), { force: true });
    const r = spawnSync('bash', [join(repo, 'reset.sh')], { env: { PATH: `${bin}:${process.env.PATH ?? ''}`, HOME: work }, encoding: 'utf8' });
    assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /QA-B RESET RED: сброс — только QA-B/);
    assert.ok(!existsSync(join(work, 'docker.log')), 'refused before any docker command');
  }
  // Контроль: на QA-B проверка стенда пропускает дальше (в этой копии раскладки дальше упирается в отсутствующую выгрузку журналов)
  writeFileSync(join(repo, 'pilot.env'), `${before}REPRACER_PILOT_STAND=qa-b\n`);
  const onQaB = spawnSync('bash', [join(repo, 'reset.sh')], { env: { PATH: `${bin}:${process.env.PATH ?? ''}`, HOME: work }, encoding: 'utf8' });
  assert.doesNotMatch(`${onQaB.stdout}${onQaB.stderr}`, /сброс — только QA-B/, 'qa-b goes past the stand check');
  assert.match(onQaB.stdout, /== журналы по сей момент/);
  const rs = readFileSync(join(root, 'deploy/pilot/reset.sh'), 'utf8');
  const at = (s: string) => { const i = rs.indexOf(s); assert.ok(i >= 0, `reset.sh has ${s}`); return i; };
  assert.ok(at('[ "${REPRACER_PILOT_STAND:-pilot}" = qa-b ] || red') < at('logs-archive.sh --until-now'), 'the stand is checked first');
  assert.ok(at('logs-archive.sh --until-now') < at('xargs -r "${C}" stop'));
  assert.ok(at('xargs -r "${C}" stop') < at('-e REPRACER_BACKUP_ONCE=1 backup'), 'a copy before the reset — the rehearsal keeps its backups');
  assert.ok(at('-e REPRACER_BACKUP_ONCE=1 backup') < at('bash /repo/deploy/pilot/db.sh --reset-qa-b'));
  assert.ok(at('bash /repo/deploy/pilot/db.sh --reset-qa-b') < at('up -d --wait --remove-orphans') && at('up -d --wait --remove-orphans') < at('deploy/pilot/smoke.sh'));
  // Выкладка передаёт стенд базе: первая сборка ставит отметку
  assert.match(readFileSync(join(root, 'deploy/pilot/deploy.sh'), 'utf8'), /-e REPRACER_PILOT_STAND="\$\{REPRACER_PILOT_STAND:-pilot\}"/);
  assert.match(readFileSync(join(root, 'deploy/pilot/pilot.env.example'), 'utf8'), /^REPRACER_PILOT_STAND=pilot$/m);
  assert.equal(spawnSync('bash', ['-n', join(root, 'deploy/pilot/reset.sh')]).status, 0);
});
