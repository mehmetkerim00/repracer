import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

/**
 * Шаг 141 (решения владельца 2026-11-16):
 *  - п. 3: путь записи пилота — как в промышленном профиле, контейнер Redpanda и процесс пути решения за брокером (deploy/worker: диспетчер записей
 *    и ретранслятор outbox), без новой схемы «диспетчер без брокера». В составе deploy/pilot под профилем live, включение — в день перевода в бой
 *    (REPRACER_PILOT_WRITE_PATH=on): обычная выкладка их не поднимает, пилот в тени;
 *  - п. 4: QA-B — потолок памяти ClickHouse в compose и шлюз SSH тестировщика с тремя командами, как у QA-A.
 * Проверяемо без сервера: разбор compose с профилем, загрузчик конфигурации процесса пути решения на файлах deploy/pilot/secrets.sh, обёртка compose.sh,
 * внешний контроль и смоук на модели docker, шлюз SSH на подменах. Данные синтетические. Нужен Docker CLI с compose (разбор без демона).
 */
const root = new URL('../../', import.meta.url).pathname;
let work = '';
let secrets = '';
type Service = { environment?: Record<string, string | null>; ports?: unknown[]; image?: string; profiles?: string[]; mem_limit?: unknown; depends_on?: Record<string, unknown> };
const BUILD = 'REPRACER_BUILD_SHA=0123456789abcdef0123456789abcdef01234567\nREPRACER_BUILD_AT=2026-11-16T12:00:00Z\n';

before(() => {
  work = mkdtempSync(join(tmpdir(), 'repracer-pilot-write-path-'));
  secrets = join(work, 'pilot');
  writeFileSync(join(work, 'amazon-production.env'),
    'AMAZON_PRODUCTION_APP_ID=amzn1.sp.solution.syn-pilot-app\nAMAZON_PRODUCTION_LWA_CLIENT_ID=amzn1.application-oa2-client.syn-pilot\nAMAZON_PRODUCTION_LWA_CLIENT_SECRET=syn-lwa-secret\n');
  const made = secretsRun(secrets);
  assert.equal(made.status, 0, `${made.stdout}${made.stderr}`);
  writeFileSync(join(secrets, 'tunnel.env'), 'TUNNEL_TOKEN=syn-tunnel-token\n');
  writeFileSync(join(secrets, 'worker_heartbeat_url'), 'https://hc-ping.invalid/syn-worker\n');
  writeFileSync(join(work, 'build.env'), BUILD);
});
after(() => { if (work) rmSync(work, { recursive: true, force: true }); });

function secretsRun(dir: string) {
  return spawnSync('bash', [join(root, 'deploy/pilot/secrets.sh')], {
    env: { PATH: process.env.PATH ?? '', HOME: work, REPRACER_PILOT_LOCAL_SECRETS: dir, REPRACER_AMAZON_PRODUCTION_ENV: join(work, 'amazon-production.env') }, encoding: 'utf8' });
}
function config(...profiles: string[]): Record<string, Service> {
  const out = execFileSync('docker', ['compose', '-f', join(root, 'deploy/pilot/compose.yaml'), '--env-file', join(root, 'deploy/pilot/pilot.env.example'),
    '--env-file', join(secrets, 'amazon.env'), '--env-file', join(work, 'build.env'), ...profiles.flatMap((p) => ['--profile', p]), 'config', '--format', 'json'],
  { env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? work, REPRACER_SECRETS_DIR: secrets }, encoding: 'utf8' });
  return (JSON.parse(out) as { services: Record<string, Service> }).services;
}
const envOf = (s: Service): Record<string, string> => Object.fromEntries(Object.entries(s.environment ?? {}).map(([k, v]) => [k, String(v ?? '')]));
const read = (path: string) => readFileSync(path.replace('/run/secrets', secrets), 'utf8');

test('step 141 (п. 3): the write path of the pilot — Redpanda and the pricing worker of deploy/worker — exists only under the live profile; a regular deploy stays in the shadow', async () => {
  const shadow = config();
  assert.ok(!('redpanda' in shadow) && !('worker' in shadow), 'without the live profile neither the broker nor the worker is part of the pilot');
  const live = config('live');
  assert.deepEqual([live.redpanda?.profiles, live.worker?.profiles], [['live'], ['live']]);
  assert.match(live.redpanda!.image ?? '', /^redpandadata\/redpanda:v26\.2\.2@sha256:468bd13a9f2bd24794cb7fddc867c767fb1008b9a07b297b89fde48c564d7d96$/, 'the broker image as in CI and infra/local');
  assert.equal(live.redpanda!.ports, undefined, 'the broker publishes no port');
  const worker = envOf(live.worker!);
  assert.equal(worker.REPRACER_KAFKA_BROKERS, 'redpanda:9092');
  assert.equal(worker.REPRACER_WORKER_HEARTBEAT_URL_FILE, '/run/secrets/worker_heartbeat_url');
  assert.notEqual(worker.REPRACER_WORKER_HEARTBEAT, 'off', 'the worker marks itself in the external service like every pilot process');
  assert.equal(worker.REPRACER_CREDENTIALS_PG_URL_FILE, '/run/secrets/credentials_pg_url', 'the worker reads seller tokens with the adapters role');
  assert.equal(worker.REPRACER_BUILD_SHA, '0123456789abcdef0123456789abcdef01234567');
  assert.ok(live.worker!.depends_on && 'redpanda' in live.worker!.depends_on && 'postgres' in live.worker!.depends_on);
  // Процесс принимает окружение и файлы deploy/pilot/secrets.sh: отказ старта — здесь, а не в день перевода в бой
  const { loadWorkerConfig } = await import('../../services/pricing-worker/src/config.ts');
  const loaded = loadWorkerConfig(worker, read);
  assert.deepEqual([loaded.kafkaBrokers, loaded.heartbeatUrl], [['redpanda:9092'], 'https://hc-ping.invalid/syn-worker']);
  assert.ok(loaded.relayPgUrl?.startsWith('postgres://svc_relay:'), 'the outbox relay has its own role (Р-34)');
  assert.ok(loaded.dispatcherPgUrl.startsWith('postgres://svc_dispatcher:'), 'the dispatcher has its own role');
  assert.ok(loaded.channelApps.amazon && loaded.credentialsPgUrl, 'the worker has the Amazon app, the keyring and the adapters role');
});

test('step 141 (п. 3): secrets.sh adds a role a newer pilot needs to an existing password file instead of refusing; nothing else changes', () => {
  const dir = join(work, 'older');
  assert.equal(secretsRun(dir).status, 0);
  const file = join(dir, 'pg_role_passwords');
  const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l !== '' && !l.startsWith('svc_relay '));
  writeFileSync(file, `${lines.join('\n')}\n`);
  rmSync(join(dir, 'relay_pg_url'), { force: true });
  const again = secretsRun(dir);
  assert.equal(again.status, 0, `${again.stdout}${again.stderr}`);
  const after = readFileSync(file, 'utf8').split('\n').filter((l) => l !== '');
  assert.deepEqual(after.slice(0, lines.length), lines, 'the passwords already there stay');
  assert.match(after.at(-1) ?? '', /^svc_relay [0-9a-f]{48}$/, 'the missing role got a password');
  assert.match(readFileSync(join(dir, 'relay_pg_url'), 'utf8'), /^postgres:\/\/svc_relay:[0-9a-f]{48}@postgres:5432\/repracer_pilot$/);
  assert.match(`${again.stdout}`, /добавлены роли: svc_relay/);
  assert.ok(!`${again.stdout}${again.stderr}`.includes(after.at(-1)!.split(' ')[1]!), 'the password is not printed');
});

/** Обёртка compose.sh в своём каталоге: pilot.env, build.env, amazon.env и docker-подмена, печатающая аргументы */
function wrapper(writePath: string | null): { code: number | null; out: string } {
  const dir = mkdtempSync(join(work, 'wrap-'));
  const sec = join(dir, 'secrets');
  mkdirSync(sec);
  writeFileSync(join(sec, 'amazon.env'), 'REPRACER_AMAZON_APP_ID=amzn1.sp.solution.syn\n');
  copyFileSync(join(root, 'deploy/pilot/compose.sh'), join(dir, 'compose.sh'));
  writeFileSync(join(dir, 'pilot.env'), `REPRACER_SECRETS_DIR=${sec}\nREPRACER_BACKUP_OFFSITE=pull\n${writePath === null ? '' : `REPRACER_PILOT_WRITE_PATH=${writePath}\n`}`);
  writeFileSync(join(dir, 'build.env'), BUILD);
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'docker'), '#!/usr/bin/env bash\necho "docker $*"\n');
  chmodSync(join(dir, 'bin', 'docker'), 0o755);
  const r = spawnSync('bash', [join(dir, 'compose.sh'), 'up', '-d'], { env: { PATH: `${join(dir, 'bin')}:${process.env.PATH ?? ''}` }, encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

test('step 141 (п. 3): compose.sh turns the write path on only by REPRACER_PILOT_WRITE_PATH=on; another value is a refusal, not a guess', () => {
  for (const value of [null, 'off']) {
    const r = wrapper(value);
    assert.equal(r.code, 0, r.out);
    assert.ok(!r.out.includes('--profile live'), `${value ?? 'unset'}: the broker and the worker stay down`);
  }
  const on = wrapper('on');
  assert.equal(on.code, 0, on.out);
  assert.match(on.out, /--profile live/);
  const typo = wrapper('yes');
  assert.equal(typo.code, 2, typo.out);
  assert.match(typo.out, /REPRACER_PILOT_WRITE_PATH — on или off/);
  assert.ok(!typo.out.includes('docker '), 'nothing starts on a refusal');
});

test('step 141 (п. 3): with the write path on, deployment and smoke refuse a pilot whose worker is not under external control', () => {
  const dir = join(work, 'hb');
  mkdirSync(dir, { recursive: true });
  for (const f of ['scheduler', 'console', 'operator', 'bulk', 'backup', 'logs']) writeFileSync(join(dir, `${f}_heartbeat_url`), `https://hc-ping.invalid/syn-${f}\n`);
  const state = (env: Record<string, string>) => {
    const r = spawnSync('bash', [join(root, 'deploy/pilot/heartbeat-state.sh'), dir], { env: { PATH: process.env.PATH ?? '', ...env }, encoding: 'utf8' });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };
  const shadow = state({});
  assert.equal(shadow.code, 0, shadow.out);
  assert.match(shadow.out, /HEARTBEAT READY: 6 адресов/, 'in the shadow the worker check is not needed');
  const missing = state({ REPRACER_PILOT_WRITE_PATH: 'on' });
  assert.equal(missing.code, 1, missing.out);
  assert.match(missing.out, /HEARTBEAT RED: нет .*worker_heartbeat_url.*--write-path/);
  writeFileSync(join(dir, 'worker_heartbeat_url'), 'https://hc-ping.invalid/syn-worker\n');
  const off = state({ REPRACER_PILOT_WRITE_PATH: 'on', REPRACER_WORKER_HEARTBEAT: 'off' });
  assert.equal(off.code, 1, off.out);
  assert.match(off.out, /REPRACER_WORKER_HEARTBEAT=off — отметки пилота не выключаются/);
  const live = state({ REPRACER_PILOT_WRITE_PATH: 'on' });
  assert.equal(live.code, 0, live.out);
  assert.match(live.out, /HEARTBEAT READY: 7 адресов/);
});

test('step 141 (п. 4): ClickHouse of the pilot and QA-B has a memory ceiling — the server takes 0.9 of the container limit (cgroup), not of the machine', () => {
  const shadow = config();
  // docker compose config отдаёт потолок байтами; по умолчанию — 2 GiB, значение — REPRACER_CLICKHOUSE_MEM_LIMIT в pilot.env
  assert.equal(String(shadow.clickhouse!.mem_limit), String(2 * 1024 ** 3), 'the ClickHouse container is capped at 2 GiB by default');
  const text = readFileSync(join(root, 'deploy/pilot/compose.yaml'), 'utf8');
  assert.match(text, /mem_limit: \$\{REPRACER_CLICKHOUSE_MEM_LIMIT:-2g\}/, 'the ceiling is a setting of pilot.env');
  assert.match(readFileSync(join(root, 'vendor/clickhouse/server-config/26.8.4.11-lts/SOURCE.md'), 'utf8').replace(/\n> /g, ' '), /cgroup's available memory is used instead of the host-wide value/,
    'the fact the ceiling relies on is in the snapshot of the pinned version');
});

/** Шлюз SSH тестировщика в копии каталога: compose.sh, reset.sh и deploy/qa/detach.sh — подмены, печатающие вызов */
function gate(command: string, stand: string): { code: number | null; out: string } {
  const top = mkdtempSync(join(work, 'gate-'));
  const dir = join(top, 'deploy', 'pilot');
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(top, 'deploy', 'qa'), { recursive: true });
  copyFileSync(join(root, 'deploy/pilot/ssh-gate.sh'), join(dir, 'ssh-gate.sh'));
  writeFileSync(join(dir, 'pilot.env'), `REPRACER_PILOT_STAND=${stand}\n`);
  writeFileSync(join(dir, 'build.env'), BUILD);
  for (const [path, body] of [[join(dir, 'compose.sh'), 'echo "compose $*"'], [join(dir, 'reset.sh'), 'echo "reset $*"'], [join(top, 'deploy/qa/detach.sh'), 'echo "detach QA_STATE_DIR=${QA_STATE_DIR} $*"']] as const) {
    writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(path, 0o755);
  }
  const r = spawnSync('bash', [join(dir, 'ssh-gate.sh')], { env: { PATH: process.env.PATH ?? '', SSH_ORIGINAL_COMMAND: command }, encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

test('step 141 (п. 4): the SSH gate of QA-B — exactly logs, reset and version, no shell; reset survives a dropped connection and only ever runs on QA-B', () => {
  const version = gate('version', 'qa-b');
  assert.equal(version.code, 0, version.out);
  assert.equal(version.out, 'sha 0123456789abcdef0123456789abcdef01234567\nat 2026-11-16T12:00:00Z\n');
  const logs = gate('logs', 'qa-b');
  assert.equal(logs.code, 0, logs.out);
  assert.match(logs.out, /^compose logs --no-color --tail=500 console scheduler bulk-worker operator$/m);
  const reset = gate('reset', 'qa-b');
  assert.equal(reset.code, 0, reset.out);
  assert.match(reset.out, /^detach QA_STATE_DIR=.*\/deploy\/pilot\/state reset .*\/deploy\/pilot\/reset\.sh$/m, 'the reset runs in the background under its log, like QA-A');
  const pilot = gate('reset', 'pilot');
  assert.equal(pilot.code, 2, pilot.out);
  assert.match(pilot.out, /сброс — только QA-B/);
  assert.ok(!pilot.out.includes('detach'), 'on the pilot nothing is started');
  for (const other of ['bash', 'logs; id', '', 'reset --first-time']) {
    const r = gate(other, 'qa-b');
    assert.equal(r.code, 2, `${other}: ${r.out}`);
    assert.match(r.out, /команды: logs \| reset \| version/);
  }
});
