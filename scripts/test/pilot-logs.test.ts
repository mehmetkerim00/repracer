import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { after, before, test } from 'node:test';

/**
 * Шаг 130 (решение владельца 2026-11-15, п. 3.2): архив журналов пилота ≥ 12 месяцев — требование Amazon DPP, обязательно до подключения продавца.
 * Пилот берёт тот же deploy/production/logs-archive.sh, что промышленный профиль: горячий хвост сутками, месячные архивы, 13 месяцев. Новое — проводка
 * пилота:
 *  - обёртка deploy/pilot/logs-archive.sh: проект repracer-pilot, каталоги из pilot.env, отметка во внешнем сервисе после захода («жив» / «сбой»);
 *  - ежедневный запуск — строка crontab пользователя выкладки (sudo у него нет — systemd не поставить): deploy/pilot/logs-cron.sh;
 *  - выкладка выгружает журналы по сей момент ДО того, как пересоздаст контейнеры (журнал контейнера уходит вместе с ним), и после подъёма;
 *  - смоук спрашивает deploy/pilot/logs-state.sh: запуск стоит, провала нет, выгружено не раньше 26 часов назад.
 * Docker, curl и crontab подменены командами, которые пишут свои аргументы; время — REPRACER_LOGS_NOW, как в тесте скрипта шага 54.
 * Данные синтетические.
 */
const root = new URL('../../', import.meta.url).pathname;
let work = '';
let repo = '';
let bin = '';
const PING = 'https://hc-ping.invalid/00000000-0000-4000-8000-0000000000bb';
const run = (script: string, args: string[], env: Record<string, string> = {}) => {
  const r = spawnSync('bash', [join(repo, script), ...args], { env: { PATH: `${bin}:${process.env.PATH ?? ''}`, HOME: work, ...env }, encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};

before(() => {
  work = mkdtempSync(join(tmpdir(), 'repracer-pilot-logs-'));
  // Копия нужных файлов репозитория рядом со своим pilot.env (в репозитории его нет: он на сервере)
  repo = join(work, 'repo');
  for (const f of ['deploy/pilot/logs-archive.sh', 'deploy/pilot/logs-cron.sh', 'deploy/pilot/logs-state.sh', 'deploy/production/logs-archive.sh', 'deploy/pilot/pull-backups.sh']) {
    mkdirSync(join(repo, f, '..'), { recursive: true });
    if (existsSync(join(root, f))) copyFileSync(join(root, f), join(repo, f));
  }
  const secrets = join(work, 'secrets');
  mkdirSync(secrets, { recursive: true });
  writeFileSync(join(repo, 'deploy/pilot/pilot.env'),
    `REPRACER_SECRETS_DIR=${secrets}\nREPRACER_LOGS_HOT_DIR=${join(work, 'logs')}\nREPRACER_ARCHIVE_DIR=${join(work, 'archive')}\n`);
  bin = join(work, 'bin');
  mkdirSync(bin, { recursive: true });
  // docker compose -p P logs --no-color --timestamps --since FROM --until TO — строка с проектом и отрезком; DOCKER_FAIL=1 — отказ, как compose без проекта
  writeFileSync(join(bin, 'docker'), '#!/bin/bash\nif [ -e "$DOCKER_FAIL" ]; then echo "no such project" >&2; exit 1; fi\necho "$3 $8 .. ${10}"\n');
  writeFileSync(join(bin, 'curl'), `#!/bin/bash\nprintf 'ARGS %s\\n' "$*" >> '${join(work, 'curl.log')}'\nsed 's/^/STDIN /' >> '${join(work, 'curl.log')}'\n`);
  writeFileSync(join(bin, 'crontab'), `#!/bin/bash\nf='${join(work, 'crontab.txt')}'\nif [ "$1" = -l ]; then [ -e "$f" ] && cat "$f" || { echo "no crontab for deploy" >&2; exit 1; }; elif [ "$1" = - ]; then cat > "$f"; fi\n`);
  // Шаг 133: `ssh <адрес> <команда>` — та же команда локальной оболочкой: сервер прогона — каталоги рядом. Как настоящий ssh, подмена читает
  // стандартный ввод до конца: ssh внутри `while read` без </dev/null съел бы строки цикла
  writeFileSync(join(bin, 'ssh'), '#!/bin/bash\nshift\ncat > /dev/null\nexec bash -c "$*"\n');
  for (const c of ['docker', 'curl', 'crontab', 'ssh']) chmodSync(join(bin, c), 0o755);
  writeFileSync(join(secrets, 'logs_heartbeat_url'), `${PING}\n`);
});
after(() => { if (work) rmSync(work, { recursive: true, force: true }); });

test('step 130: the pilot logs wrapper archives the repracer-pilot project with the shared script and marks each run in the external service — /fail when it fails', () => {
  const env = { REPRACER_DOCKER: join(bin, 'docker'), REPRACER_LOGS_NOW: '2026-11-15T00:20:00Z', DOCKER_FAIL: join(work, 'docker-fail') };
  const night = run('deploy/pilot/logs-archive.sh', [], env);
  assert.equal(night.code, 0, night.out);
  const day = join(work, 'logs', 'repracer-pilot', '2026-11-14.log.gz');
  assert.ok(existsSync(day), 'the hot day file of the pilot project');
  assert.match(gunzipSync(readFileSync(day)).toString(), /^repracer-pilot 2026-11-14T00:00:00Z \.\. 2026-11-15T00:00:00Z$/m, 'the pilot compose project, the past UTC day');
  assert.equal(readFileSync(join(work, 'logs', 'repracer-pilot', '.until'), 'utf8'), '2026-11-15T00:00:00Z');
  const log = () => readFileSync(join(work, 'curl.log'), 'utf8');
  assert.match(log(), new RegExp(`^STDIN url = "${PING}"$`, 'm'), 'a good run — the ping address itself');
  assert.ok(!/^ARGS .*hc-ping/m.test(log()), 'the address is not a curl argument');
  // Перед выкладкой — по сей момент: тот же файл суток дописывается
  const before = run('deploy/pilot/logs-archive.sh', ['--until-now'], { ...env, REPRACER_LOGS_NOW: '2026-11-15T09:00:00Z' });
  assert.equal(before.code, 0, before.out);
  assert.equal(readFileSync(join(work, 'logs', 'repracer-pilot', '.until'), 'utf8'), '2026-11-15T09:00:00Z');
  // Провал выгрузки — «сбой», отметка провала, код 1
  writeFileSync(join(work, 'docker-fail'), '');
  const failed = run('deploy/pilot/logs-archive.sh', [], { ...env, REPRACER_LOGS_NOW: '2026-11-16T00:20:00Z' });
  rmSync(join(work, 'docker-fail'));
  assert.equal(failed.code, 1, failed.out);
  assert.match(failed.out, /LOGS_ARCHIVE_FAILED/);
  assert.match(log(), new RegExp(`^STDIN url = "${PING}/fail"$`, 'm'), 'a failed run — /fail');
  assert.ok(existsSync(join(work, 'logs', 'LOGS_ARCHIVE_FAILED')));
  assert.ok(!`${night.out}${failed.out}`.includes('hc-ping.invalid'), 'the address is not printed');
  // Месячные архивы — как у промышленного профиля: каталог platform=logs/<проект>
  assert.ok(existsSync(join(work, 'archive', 'platform=logs', 'repracer-pilot')));
});

test('step 130: logs-cron.sh installs one daily line for the deploy user — a second run does not add another, other lines stay', () => {
  writeFileSync(join(work, 'crontab.txt'), 'MAILTO=""\n5 4 * * * /usr/bin/true # someone else\n');
  const first = run('deploy/pilot/logs-cron.sh', []);
  assert.equal(first.code, 0, first.out);
  const again = run('deploy/pilot/logs-cron.sh', []);
  assert.equal(again.code, 0, again.out);
  const lines = readFileSync(join(work, 'crontab.txt'), 'utf8').trim().split('\n');
  const ours = lines.filter((l) => l.includes('deploy/pilot/logs-archive.sh'));
  assert.equal(ours.length, 1, 'one line, however many deploys');
  assert.match(ours[0]!, new RegExp(`^20 0 \\* \\* \\* cd '${repo}' && deploy/pilot/logs-archive\\.sh 2>&1 \\| logger -t repracer-pilot-logs-archive$`));
  assert.ok(lines.includes('5 4 * * * /usr/bin/true # someone else'), 'lines that are not ours are kept');
  // Без crontab вовсе (первая выкладка) — тоже одна строка
  rmSync(join(work, 'crontab.txt'));
  assert.equal(run('deploy/pilot/logs-cron.sh', []).code, 0);
  assert.equal(readFileSync(join(work, 'crontab.txt'), 'utf8').trim().split('\n').length, 1);
});

test('step 130: logs-state.sh — red without the daily run, with a failure mark or with nothing archived for 26 hours; green otherwise', () => {
  const hot = join(work, 'state-logs');
  mkdirSync(join(hot, 'repracer-pilot'), { recursive: true });
  const state = () => run('deploy/pilot/logs-state.sh', [hot]);
  const red = (why: RegExp) => { const r = state(); assert.equal(r.code, 1, r.out); assert.match(r.out, /LOGS RED: /); assert.match(r.out, why); };
  rmSync(join(work, 'crontab.txt'), { force: true });
  red(/нет ежедневной выгрузки журналов/);
  writeFileSync(join(work, 'crontab.txt'), `20 0 * * * cd '${repo}' && deploy/pilot/logs-archive.sh 2>&1 | logger -t repracer-pilot-logs-archive\n`);
  red(/журналы пилота ещё не выгружались/);
  const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString().replace(/\.\d{3}Z$/, 'Z');
  writeFileSync(join(hot, 'repracer-pilot', '.until'), iso(30 * 3_600_000));
  red(/выгружено по .* — старше 26 ч/);
  writeFileSync(join(hot, 'repracer-pilot', '.until'), iso(3_600_000));
  writeFileSync(join(hot, 'LOGS_ARCHIVE_FAILED'), '{"code":"LOGS_ARCHIVE_FAILED","at":"x"}\n');
  red(/выгрузка журналов проваливается/);
  rmSync(join(hot, 'LOGS_ARCHIVE_FAILED'));
  // Шаг 133: и вынесены с сервера под внешним контролем (отдельный тест ниже)
  writeFileSync(join(hot, 'LOGS_PULLED'), `{"pulledBefore":"x","at":"${stamp(HOUR)}","monitored":true}\n`);
  const green = state();
  assert.equal(green.code, 0, green.out);
  assert.match(green.out, /LOGS GREEN: /);
});

const HOUR = 3_600_000;
const stamp = (msAgo: number) => new Date(Date.now() - msAgo).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
const ymd = (msAgo: number) => new Date(Date.now() - msAgo).toISOString().slice(0, 10);
const monthAgo = (n: number) => { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - n, 1)).toISOString().slice(0, 7); };
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

test('step 133: logs-state.sh — red while the logs have not left the server, when the last pull is older than 26 hours or not under external control', () => {
  const hot = join(work, 'state133-logs');
  mkdirSync(join(hot, 'repracer-pilot'), { recursive: true });
  writeFileSync(join(work, 'crontab.txt'), `20 0 * * * cd '${repo}' && deploy/pilot/logs-archive.sh 2>&1 | logger -t repracer-pilot-logs-archive\n`);
  writeFileSync(join(hot, 'repracer-pilot', '.until'), new Date(Date.now() - HOUR).toISOString().replace(/\.\d{3}Z$/, 'Z'));
  const state = () => run('deploy/pilot/logs-state.sh', [hot]);
  const red = (why: RegExp) => { const r = state(); assert.equal(r.code, 1, r.out); assert.match(r.out, /LOGS RED: /); assert.match(r.out, why); };
  red(/журналы не выносились с сервера — на машине оператора: deploy\/pilot\/pull-backups\.sh/);
  writeFileSync(join(hot, 'LOGS_PULLED'), `{"pulledBefore":"x","at":"${stamp(30 * HOUR)}","monitored":true}\n`);
  red(/журналы не выносились с сервера дольше 26 ч/);
  writeFileSync(join(hot, 'LOGS_PULLED'), `{"pulledBefore":"x","at":"${stamp(HOUR)}","monitored":false}\n`);
  red(/вынос журналов не под внешним контролем/);
  writeFileSync(join(hot, 'LOGS_PULLED'), `{"pulledBefore":"x","at":"${stamp(HOUR)}","monitored":true}\n`);
  const green = state();
  assert.equal(green.code, 0, green.out);
  assert.match(green.out, /LOGS GREEN: .*вне сервера — машина оператора/);
});

test('step 133: pull-backups.sh takes the month archives and the finished days of the pilot logs too — SHA-256 before it accepts, 13 months, LOGS_PULLED on the server', () => {
  const server = join(work, 'pull133');
  const backups = join(server, 'backups');
  const hotP = join(server, 'logs', 'repracer-pilot');
  const months = join(server, 'archive', 'platform=logs', 'repracer-pilot');
  const local = join(work, 'pull133-local');
  const logs = join(local, 'logs');
  // Копия базы — как её оставляет backup-loop: вынос копий идёт первым и без неё красный
  mkdirSync(backups, { recursive: true });
  const s = stamp(HOUR);
  const dump = Buffer.from('syn-dump');
  const globals = Buffer.from('syn-globals');
  writeFileSync(join(backups, `repracer-${s}.dump.gpg`), dump);
  writeFileSync(join(backups, `repracer-${s}.globals.sql.gpg`), globals);
  writeFileSync(join(backups, `repracer-${s}.sha256`), `${sha(dump)}\n${sha(globals)}\n`);
  // Сервер: выгружено по сегодня 09:00 — законченные сутки до сегодняшних; сегодняшние ещё дописываются; рядом — следы оборванного захода
  const today = ymd(0);
  const [d1, d2] = [ymd(24 * HOUR), ymd(48 * HOUR)];
  mkdirSync(hotP, { recursive: true });
  writeFileSync(join(hotP, '.until'), `${today}T09:00:00Z`);
  for (const d of [d1, d2, today]) writeFileSync(join(hotP, `${d}.log.gz`), gzipSync(`syn-log ${d}\n`));
  writeFileSync(join(hotP, `${today}.log.gz.new`), 'partial');
  writeFileSync(join(hotP, '.until.pending'), 'x');
  // Месячные архивы — с суммой, как их пишет logs-archive.sh; архив старше 13 месяцев не берётся
  const month = (m: string, body = gzipSync(`syn-month ${m}\n`), sum = sha(body)) => {
    mkdirSync(months, { recursive: true });
    writeFileSync(join(months, `${m}.log.gz`), body);
    writeFileSync(join(months, `${m}.log.gz.sha256`), `${sum}\n`);
  };
  const [m2, m3] = [monthAgo(2), monthAgo(3)];
  month(m2);
  month(m3);
  month(monthAgo(14));
  // Здесь от прошлых проходов: сутки месяца, который теперь пришёл архивом, и всё старше 13 месяцев — уходят
  mkdirSync(logs, { recursive: true });
  writeFileSync(join(logs, `${m2}-10.log.gz`), gzipSync('syn'));
  writeFileSync(join(logs, `${monthAgo(15)}.log.gz`), gzipSync('syn'));
  writeFileSync(join(logs, `${monthAgo(15)}.log.gz.sha256`), 'x\n');
  writeFileSync(join(logs, `${monthAgo(14)}-03.log.gz`), gzipSync('syn'));
  const pull = () => run('deploy/pilot/pull-backups.sh', ['deploy@server.invalid', local], {
    REPRACER_PILOT_REMOTE_BACKUP_DIR: backups, REPRACER_PILOT_REMOTE_LOGS_DIR: join(server, 'logs'), REPRACER_PILOT_REMOTE_ARCHIVE_DIR: join(server, 'archive'),
  });
  const first = pull();
  assert.equal(first.code, 0, first.out);
  assert.match(first.out, /PULL GREEN: .*журналы: новых месяцев 2, суток 2, всё до /);
  assert.deepEqual(readdirSync(logs).sort(), [`${d1}.log.gz`, `${d2}.log.gz`, `${m2}.log.gz`, `${m2}.log.gz.sha256`, `${m3}.log.gz`, `${m3}.log.gz.sha256`].sort(),
    'finished days and month archives within 13 months; not the day still being written, not the leftovers, not what a month archive covers');
  assert.equal(gunzipSync(readFileSync(join(logs, `${d1}.log.gz`))).toString(), `syn-log ${d1}\n`, 'the bytes of the day');
  assert.match(readFileSync(join(server, 'logs', 'LOGS_PULLED'), 'utf8'),
    new RegExp(`^\\{"pulledBefore":"${today}T00:00:00Z","at":"\\d{8}T\\d{6}Z","monitored":false\\}\\n$`), 'the server knows what left it');
  assert.match(pull().out, /журналы: новых месяцев 0, суток 0/, 'a second run takes nothing twice');
  // Порча при переносе: месяц с несошедшейся суммой не принимается, частей не остаётся
  const m4 = monthAgo(4);
  month(m4, gzipSync(`syn-month ${m4}\n`), sha(Buffer.from('other')));
  const broken = pull();
  assert.equal(broken.code, 1, broken.out);
  assert.match(broken.out, new RegExp(`PULL RED: журнал не сошёлся по SHA-256 и не принят: ${m4}`));
  assert.deepEqual(readdirSync(logs).filter((f) => f.includes(m4)), [], 'nothing of the broken month is kept here');
  rmSync(join(months, `${m4}.log.gz`));
  rmSync(join(months, `${m4}.log.gz.sha256`));
  // Журналы на сервере ещё не выгружались — красный проход, а не «вынесено ничего»
  rmSync(join(hotP, '.until'));
  const none = pull();
  assert.equal(none.code, 1, none.out);
  assert.match(none.out, /PULL RED: журналы пилота на сервере ещё не выгружались/);
});

test('step 130: deploy dumps the logs before it recreates containers and after it starts them, installs the daily run; the smoke asks logs-state.sh; pilot.env names the directories', () => {
  const deploy = readFileSync(join(root, 'deploy/pilot/deploy.sh'), 'utf8');
  const firstUp = deploy.indexOf('up -d --wait postgres clickhouse');
  const dumpBefore = deploy.indexOf('logs-archive.sh --until-now');
  assert.ok(dumpBefore > 0 && dumpBefore < firstUp, 'logs up to now before the first `up` recreates anything');
  const processes = deploy.indexOf('up -d --wait --remove-orphans');
  assert.ok(deploy.indexOf('logs-archive.sh --until-now', processes) > processes, 'and once more after the processes are up');
  assert.ok(deploy.indexOf('logs-cron.sh') > processes && deploy.indexOf('logs-cron.sh') < deploy.indexOf('smoke.sh'), 'the daily run is installed before the smoke');
  assert.match(readFileSync(join(root, 'deploy/pilot/smoke.sh'), 'utf8'), /logs-state\.sh" "\$\{REPRACER_LOGS_HOT_DIR\}" \|\| fail/);
  const example = readFileSync(join(root, 'deploy/pilot/pilot.env.example'), 'utf8');
  assert.match(example, /^REPRACER_LOGS_HOT_DIR=\/srv\/repracer-pilot\/logs$/m);
  assert.match(example, /^REPRACER_ARCHIVE_DIR=\/srv\/repracer-pilot\/archive$/m);
  // Тот же скрипт, что у промышленного профиля, — второй реализации нет
  assert.match(readFileSync(join(root, 'deploy/pilot/logs-archive.sh'), 'utf8'), /\.\.\/production\/logs-archive\.sh/);
  assert.deepEqual(readdirSync(join(root, 'deploy/pilot')).filter((f) => /logs/.test(f)).sort(), ['logs-archive.sh', 'logs-cron.sh', 'logs-state.sh']);
  execFileSync('bash', ['-n', join(root, 'deploy/pilot/deploy.sh')]);
});
