import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

/**
 * Шаг 129 (решение владельца 2026-11-15, п. 3.1): внешний контроль пилота [Р-127].
 *  - Процессы пилота (планировщик, консоль, панель, исполнитель заданий) отмечаются в healthchecks.io. Выключить отметки в пилоте нельзя:
 *    выкладка и смоук откажут (`deploy/pilot/heartbeat-state.sh`).
 *  - Отметка после каждой копии базы. В образе копии (postgres) нет ни curl, ни wget, поэтому отметку шлёт сервис `backup-heartbeat`,
 *    который следит за каталогом копий.
 *  - Отметка после каждого выноса копий на машину оператора: шлёт сам `pull-backups.sh`, через curl, адрес — не аргументом.
 *  - Проверки заводит `scripts/setup-heartbeats.mjs --stand <имя>`. Адреса — файлами секретов, в вывод не попадают.
 * Здесь всё проверяемо без сети: отметки уходят в модели (запись fetch, подмена curl), API healthchecks.io — модель на петле.
 * Данные синтетические.
 */
const root = new URL('../../', import.meta.url).pathname;
let work = '';
const HOUR = 3_600_000;
const stampOf = (msAgo: number) => new Date(Date.now() - msAgo).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const sh = (script: string, args: string[], env: Record<string, string> = {}, input?: string) => {
  const r = spawnSync('bash', [join(root, script), ...args], { env: { PATH: process.env.PATH ?? '', HOME: work, ...env }, encoding: 'utf8', input });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};
/** Копия так, как её оставляет backup-loop: две части и файл сумм (пишется последним) */
function copy(dir: string, stamp: string): void {
  mkdirSync(dir, { recursive: true });
  const dump = Buffer.from(`syn-copy-${stamp}-dump`);
  const globals = Buffer.from(`syn-copy-${stamp}-globals`);
  writeFileSync(join(dir, `repracer-${stamp}.dump.gpg`), dump);
  writeFileSync(join(dir, `repracer-${stamp}.globals.sql.gpg`), globals);
  writeFileSync(join(dir, `repracer-${stamp}.sha256`), `${sha(dump)}\n${sha(globals)}\n`);
}
const PING = 'https://hc-ping.invalid/00000000-0000-4000-8000-0000000000aa';

before(() => { work = mkdtempSync(join(tmpdir(), 'repracer-pilot-monitoring-')); });
after(() => { if (work) rmSync(work, { recursive: true, force: true }); });

test('step 129: backup-heartbeat — a ping after each finished copy, /fail on BACKUP_FAILED, nothing twice, no ping for a copy finished before it started; the address is never logged', async () => {
  const { backupHeartbeatOnce, newBackupWatch } = await import('../../deploy/pilot/backup-heartbeat.ts');
  const { createHeartbeat } = await import('../../packages/service-runtime/src/heartbeat.ts');
  const dir = join(work, 'watch-backups');
  mkdirSync(dir, { recursive: true });
  let now = Date.now();
  const sent: string[] = [];
  let down = false;
  const heartbeat = createHeartbeat({
    url: PING, clockMs: () => now,
    fetch: (async (url: string) => { if (down) throw new Error('fetch failed'); sent.push(url); return new Response('OK', { status: 200 }); }) as unknown as typeof fetch,
  });
  const lines: Array<Record<string, unknown>> = [];
  const cfg = { dir, heartbeat, nowMs: () => now, log: (l: Record<string, unknown>) => lines.push(l) };
  // Копия, готовая задолго до старта наблюдателя, уже отмечена прежним наблюдателем: повторная отметка сдвинула бы срок внешней проверки
  const before = stampOf(5 * HOUR);
  copy(dir, before);
  const t = (now - 5 * HOUR) / 1000;
  utimesSync(join(dir, `repracer-${before}.sha256`), t, t);
  const watch = newBackupWatch(now);
  assert.equal(await backupHeartbeatOnce(cfg, watch), null, 'a copy finished hours before the start is not pinged again');
  assert.deepEqual(sent, []);
  // Новая готовая копия — одна отметка «жив»
  now += 60_000;
  const first = stampOf(0);
  copy(dir, first);
  assert.equal(await backupHeartbeatOnce(cfg, watch), 'OK');
  assert.deepEqual(sent, [PING], 'success is a GET of the ping address itself');
  now += 60_000;
  assert.equal(await backupHeartbeatOnce(cfg, watch), null, 'the same copy is not pinged twice');
  // Провал копии — «сбой»; тот же провал — не повторяется; следующий провал (новая строка отметки) — снова «сбой»
  writeFileSync(join(dir, 'BACKUP_FAILED'), '{"code":"BACKUP_FAILED","at":"20261114T120000Z","consecutive":1}\n');
  now += 60_000;
  assert.equal(await backupHeartbeatOnce(cfg, watch), 'FAIL');
  assert.equal(sent.at(-1), `${PING}/fail`);
  now += 60_000;
  assert.equal(await backupHeartbeatOnce(cfg, watch), null, 'the same failure mark is not pinged again');
  writeFileSync(join(dir, 'BACKUP_FAILED'), '{"code":"BACKUP_FAILED","at":"20261114T121500Z","consecutive":2}\n');
  now += 15 * 60_000;
  assert.equal(await backupHeartbeatOnce(cfg, watch), 'FAIL', 'a new failure of the copy loop is a new /fail');
  // Сеть до внешнего сервиса упала: состояние не сдвигается, следующий проход повторяет
  rmSync(join(dir, 'BACKUP_FAILED'));
  const recovered = stampOf(-1000);
  copy(dir, recovered);
  down = true;
  now += 60_000;
  assert.equal(await backupHeartbeatOnce(cfg, watch), null, 'a failed ping sends nothing');
  down = false;
  now += 60_000;
  assert.equal(await backupHeartbeatOnce(cfg, watch), 'OK', 'the next pass repeats the ping of the recovered copy');
  assert.equal(sent.filter((u) => u === PING).length, 2);
  assert.deepEqual(lines.filter((l) => l.code === 'BACKUP_HEARTBEAT_FAILED').length, 1, 'the failed ping is logged');
  assert.ok(!JSON.stringify(lines).includes('hc-ping.invalid'), 'the ping address (a secret) is not in the log');
});

test('step 129: the pilot compose has backup-heartbeat — copies read-only, the address as a file', () => {
  const secrets = join(work, 'compose-secrets');
  mkdirSync(secrets, { recursive: true });
  writeFileSync(join(secrets, 'amazon.env'), 'REPRACER_AMAZON_APP_ID=amzn1.sp.solution.syn\nREPRACER_AMAZON_LWA_CLIENT_ID=amzn1.application-oa2-client.syn\n');
  writeFileSync(join(secrets, 'clickhouse.env'), 'CLICKHOUSE_USER=syn\n');
  writeFileSync(join(secrets, 'tunnel.env'), 'TUNNEL_TOKEN=syn\n');
  writeFileSync(join(work, 'build.env'), 'REPRACER_BUILD_SHA=0123456789abcdef0123456789abcdef01234567\nREPRACER_BUILD_AT=2026-11-14T12:00:00Z\n');
  const r = spawnSync('docker', ['compose', '-f', join(root, 'deploy/pilot/compose.yaml'), '--env-file', join(root, 'deploy/pilot/pilot.env.example'),
    '--env-file', join(secrets, 'amazon.env'), '--env-file', join(work, 'build.env'), 'config', '--format', 'json'],
  { env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? work, REPRACER_SECRETS_DIR: secrets }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  type Svc = { environment?: Record<string, string>; volumes?: Array<{ source: string; target: string; read_only?: boolean }>; command?: string[]; read_only?: boolean };
  const svc = (JSON.parse(r.stdout) as { services: Record<string, Svc> }).services['backup-heartbeat'];
  assert.ok(svc, 'the pilot has the backup-heartbeat service');
  assert.deepEqual(svc.command!.slice(-1), ['deploy/pilot/backup-heartbeat.ts']);
  assert.equal(svc.environment!.REPRACER_BACKUP_HEARTBEAT_URL_FILE, '/run/secrets/backup_heartbeat_url');
  const backups = svc.volumes!.find((v) => v.target === '/backups')!;
  assert.equal(backups.source, '/srv/repracer-pilot/backups');
  assert.equal(backups.read_only, true, 'the watcher only reads the copies');
  assert.equal(svc.read_only, true);
});

const FILES = ['scheduler_heartbeat_url', 'console_heartbeat_url', 'operator_heartbeat_url', 'bulk_heartbeat_url', 'backup_heartbeat_url'];

test('step 129: deployment and smoke refuse a pilot without external control — a heartbeat turned off, a missing or non-https address file', () => {
  const secrets = join(work, 'hb-secrets');
  mkdirSync(secrets, { recursive: true });
  const state = (env: Record<string, string> = {}) => sh('deploy/pilot/heartbeat-state.sh', [secrets], env);
  const red = (r: { code: number | null; out: string }, why: RegExp) => { assert.equal(r.code, 1, r.out); assert.match(r.out, /HEARTBEAT RED: /); assert.match(r.out, why); };
  red(state(), /нет .*scheduler_heartbeat_url/);
  for (const f of FILES) writeFileSync(join(secrets, f), `${PING.replace('aa', f.slice(0, 2))}\n`);
  writeFileSync(join(secrets, 'backup_heartbeat_url'), 'http://hc-ping.invalid/plain\n');
  red(state(), /backup_heartbeat_url — не адрес https/);
  writeFileSync(join(secrets, 'backup_heartbeat_url'), `${PING}\n`);
  for (const v of ['REPRACER_SCHEDULER_HEARTBEAT', 'REPRACER_CONSOLE_HEARTBEAT', 'REPRACER_OPERATOR_HEARTBEAT', 'REPRACER_BULK_HEARTBEAT']) {
    red(state({ [v]: 'off' }), new RegExp(`${v}=off — отметки пилота не выключаются`));
  }
  const green = state();
  assert.equal(green.code, 0, green.out);
  assert.match(green.out, /HEARTBEAT READY: 5 адресов отметок/);
  assert.ok(!green.out.includes('hc-ping.invalid'), 'no address reaches the output');
  // Выкладка спрашивает это до сборки, смоук — после подъёма; смоук видит и сервис отметок копий
  const deploy = readFileSync(join(root, 'deploy/pilot/deploy.sh'), 'utf8');
  assert.ok(deploy.indexOf('heartbeat-state.sh') > 0 && deploy.indexOf('heartbeat-state.sh') < deploy.indexOf('npm ci'), 'deploy.sh asks before it builds anything');
  const smoke = readFileSync(join(root, 'deploy/pilot/smoke.sh'), 'utf8');
  assert.match(smoke, /heartbeat-state\.sh" "\$\{REPRACER_SECRETS_DIR\}" \|\| fail/);
  assert.match(smoke, /grep -qx backup-heartbeat \|\| fail/);
  // Пример настроек пилота отметок не выключает
  assert.doesNotMatch(readFileSync(join(root, 'deploy/pilot/pilot.env.example'), 'utf8'), /^REPRACER_\w+_HEARTBEAT=off/m);
});

test('step 129: pull — a ping after each pass, /fail when it is red, the address only through curl config on stdin; OFFSITE_PULLED says whether the pull is monitored and the smoke wants it', () => {
  const server = join(work, 'pull-server');
  const local = join(work, 'pull-local');
  const bin = join(work, 'pull-bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'ssh'), '#!/bin/bash\nshift\nexec bash -c "$*"\n');
  // curl подменён: пишет свои аргументы и то, что пришло на стандартный ввод (конфигурация с адресом)
  const curlLog = join(work, 'curl.log');
  writeFileSync(join(bin, 'curl'), `#!/bin/bash\nprintf 'ARGS %s\\n' "$*" >> '${curlLog}'\nsed 's/^/STDIN /' >> '${curlLog}'\n`);
  chmodSync(join(bin, 'ssh'), 0o755);
  chmodSync(join(bin, 'curl'), 0o755);
  const hb = join(work, 'pilot-pull-heartbeat-url');
  const fresh = stampOf(HOUR);
  copy(server, fresh);
  const pull = (env: Record<string, string> = {}) => sh('deploy/pilot/pull-backups.sh', ['deploy@server.invalid', local],
    { PATH: `${bin}:${process.env.PATH ?? ''}`, REPRACER_PILOT_REMOTE_BACKUP_DIR: server, REPRACER_PILOT_PULL_HEARTBEAT_URL_FILE: hb, ...env });
  // Без адреса отметки вынос идёт (копии важнее), но отметка говорит «не под контролем», и смоук это назовёт
  const unmonitored = pull();
  assert.equal(unmonitored.code, 0, unmonitored.out);
  assert.match(unmonitored.out, /отметки выноса нет/);
  assert.ok(!existsSync(curlLog), 'no address — no curl call');
  assert.match(readFileSync(join(server, 'OFFSITE_PULLED'), 'utf8'), /"monitored":false/);
  writeFileSync(join(server, `repracer-${fresh}.restore-checked`), '{}\n');
  const verdict = sh('deploy/pilot/backup-state.sh', [server, 'pull']);
  assert.equal(verdict.code, 1, verdict.out);
  assert.match(verdict.out, /BACKUP RED: вынос копий не под внешним контролем/);
  // С адресом: «жив» после зелёного прохода
  writeFileSync(hb, `${PING}\n`);
  const green = pull();
  assert.equal(green.code, 0, green.out);
  assert.match(readFileSync(join(server, 'OFFSITE_PULLED'), 'utf8'), /"monitored":true/);
  const log = readFileSync(curlLog, 'utf8');
  assert.match(log, new RegExp(`^STDIN url = "${PING}"$`, 'm'), 'success — the ping address itself');
  assert.ok(!/^ARGS .*hc-ping/m.test(log), 'the address is not a curl argument (ps shows arguments)');
  assert.ok(!green.out.includes('hc-ping.invalid'), 'the address is not printed');
  assert.equal(sh('deploy/pilot/backup-state.sh', [server, 'pull']).code, 0, 'a monitored fresh pull with a checked copy is green');
  // Красный проход (испорченная копия) — «сбой»
  const broken = stampOf(HOUR / 2);
  copy(server, broken);
  writeFileSync(join(server, `repracer-${broken}.dump.gpg`), 'tampered');
  const red = pull();
  assert.equal(red.code, 1, red.out);
  assert.match(readFileSync(curlLog, 'utf8'), new RegExp(`^STDIN url = "${PING}/fail"$`, 'm'), 'red — /fail');
  assert.ok(statSync(hb).isFile());
});

/** Модель API healthchecks.io: POST /api/v3/checks/ с X-Api-Key, upsert по slug (201 — заведена, 200 — обновлена) */
function modelHealthchecks(): { server: Server; bodies: Array<Record<string, unknown>> } {
  const bodies: Array<Record<string, unknown>> = [];
  const known = new Map<string, string>();
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    if (req.method !== 'POST' || req.url !== '/api/v3/checks/' || req.headers['x-api-key'] !== 'syn-hc-api-key') { res.writeHead(401); res.end('{}'); return; }
    const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
    bodies.push(body);
    const slug = String(body.slug);
    const existed = known.has(slug);
    if (!existed) known.set(slug, `https://hc-ping.invalid/${createHash('sha256').update(slug).digest('hex').slice(0, 32)}`);
    res.writeHead(existed ? 200 : 201, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ slug, ping_url: known.get(slug) }));
  });
  return { server, bodies };
}

test('step 129: setup-heartbeats --stand pilot — six checks with notifications, address files 600 (the pull one outside the server secrets), nothing printed, a second run changes nothing', async () => {
  const model = modelHealthchecks();
  await new Promise<void>((resolve) => model.server.listen(0, '127.0.0.1', resolve));
  try {
    const api = `http://127.0.0.1:${(model.server.address() as AddressInfo).port}/api/v3`;
    const secrets = join(work, 'setup-secrets', 'pilot');
    mkdirSync(secrets, { recursive: true });
    // Асинхронно: модель API живёт в этом же процессе, и spawnSync остановил бы её цикл событий на время запуска скрипта
    const run = (...args: string[]) => new Promise<{ code: number | null; out: string }>((resolve) => {
      const child = spawn('node', [join(root, 'scripts/setup-heartbeats.mjs'), ...args],
        { env: { PATH: process.env.PATH ?? '', HOME: work, HC_API_KEY: 'syn-hc-api-key', HC_API_URL: api, REPRACER_PILOT_LOCAL_SECRETS: secrets } });
      let out = '';
      child.stdout.on('data', (d) => { out += String(d); });
      child.stderr.on('data', (d) => { out += String(d); });
      child.on('close', (code) => resolve({ code, out }));
    });
    const first = await run('--stand', 'pilot');
    assert.equal(first.code, 0, first.out);
    const bySlug = new Map(model.bodies.map((b) => [b.slug, b]));
    assert.deepEqual([...bySlug.keys()].sort(), ['backup', 'bulk-worker', 'console', 'operator', 'pull', 'scheduler'].map((p) => `repracer-pilot-${p}`).sort());
    for (const b of model.bodies) {
      assert.equal(b.channels, '*', `${String(b.slug)}: the check gets the project's notifications (the API assigns none by default)`);
      assert.deepEqual(b.unique, ['slug'], 'a second run updates, not duplicates');
    }
    assert.deepEqual([bySlug.get('repracer-pilot-scheduler')!.timeout, bySlug.get('repracer-pilot-scheduler')!.grace], [120, 180]);
    assert.deepEqual([bySlug.get('repracer-pilot-backup')!.timeout, bySlug.get('repracer-pilot-backup')!.grace], [86_400, 7_200], 'a copy a day; silent 26 h — an email');
    assert.deepEqual([bySlug.get('repracer-pilot-pull')!.timeout, bySlug.get('repracer-pilot-pull')!.grace], [86_400, 7_200]);
    for (const f of FILES) {
      const p = join(secrets, f);
      assert.match(readFileSync(p, 'utf8'), /^https:\/\/hc-ping\.invalid\/[0-9a-f]{32}\n$/, f);
      assert.equal(statSync(p).mode & 0o777, 0o600, `${f}: 600`);
    }
    const pullFile = join(work, '.config', 'repracer', 'secrets', 'pilot-pull-heartbeat-url');
    assert.match(readFileSync(pullFile, 'utf8'), /^https:\/\/hc-ping\.invalid\/[0-9a-f]{32}\n$/, 'the pull address lives on the operator machine');
    assert.ok(!existsSync(join(secrets, 'pull_heartbeat_url')), 'the pull address is not in the directory that goes to the server');
    assert.ok(!first.out.includes('hc-ping.invalid'), 'no address reaches the output');
    const before = FILES.map((f) => readFileSync(join(secrets, f), 'utf8'));
    const again = await run('--stand', 'pilot');
    assert.equal(again.code, 0, again.out);
    assert.deepEqual(FILES.map((f) => readFileSync(join(secrets, f), 'utf8')), before, 'the same addresses');
    assert.equal(model.bodies.length, 12, 'the second run updates the same six checks');
    // Второй стенд (QA-B) — свои проверки, а не чужие
    const qab = await run('--stand', 'qa-b', '--dry-run');
    assert.equal(qab.code, 0, qab.out);
    assert.match(qab.out, /repracer-qa-b-scheduler/);
    assert.equal((await run('--stand', 'Pilot!')).code, 2, 'a stand name is lowercase letters, digits and -');
  } finally {
    model.server.close();
  }
});
