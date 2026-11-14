import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

/**
 * Шаг 126 (решение владельца по докладу шага 124): копии базы пилота — в составе deploy/pilot до запуска, пилот без них не стартует.
 *  - копию снимает прежний сервис backup (pg_dump → gpg открытым ключом), в compose пилота он есть всегда;
 *  - копия выносится с сервера: цель настраиваемая — Cloudflare R2 (сервис backup-offsite, S3 API) или машина оператора (pull-backups.sh по SSH);
 *  - выкладка спрашивает готовность копий ДО всего (backup-state.sh --ready), смоук — их состояние: свежая, вынесена, проверена восстановлением.
 * Здесь — всё, что проверяемо без базы и без gpg: compose, отказы готовности, вынос обеими целями (сервер R2 — модель на петле, SSH — подмена `ssh`
 * локальной оболочкой), вердикт смоука. Восстановление копии — scripts/test/pilot-db.test.ts. Данные синтетические.
 */
const root = new URL('../../', import.meta.url).pathname;
let work = '';
const stampOf = (msAgo: number) => new Date(Date.now() - msAgo).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
const HOUR = 3_600_000;
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const sh = (script: string, args: string[], env: Record<string, string> = {}, input?: string) => {
  const r = spawnSync('bash', [join(root, script), ...args], { env: { PATH: process.env.PATH ?? '', HOME: work, ...env }, encoding: 'utf8', input });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};
/** Копия так, как её оставляет backup-loop: две части и файл сумм (пишется последним) */
function copy(dir: string, stamp: string, { sums = true, content = `syn-copy-${stamp}` } = {}): void {
  mkdirSync(dir, { recursive: true });
  const dump = Buffer.from(`${content}-dump`);
  const globals = Buffer.from(`${content}-globals`);
  writeFileSync(join(dir, `repracer-${stamp}.dump.gpg`), dump);
  writeFileSync(join(dir, `repracer-${stamp}.globals.sql.gpg`), globals);
  if (sums) writeFileSync(join(dir, `repracer-${stamp}.sha256`), `${sha(dump)}\n${sha(globals)}\n`);
}

before(() => { work = mkdtempSync(join(tmpdir(), 'repracer-pilot-backup-')); });
after(() => { if (work) rmSync(work, { recursive: true, force: true }); });

test('step 126: the pilot compose has the backup service of the production profile always and the R2 offsite service only under its profile', () => {
  const secrets = join(work, 'compose-secrets');
  mkdirSync(secrets, { recursive: true });
  writeFileSync(join(secrets, 'amazon.env'), 'REPRACER_AMAZON_APP_ID=amzn1.sp.solution.syn\nREPRACER_AMAZON_LWA_CLIENT_ID=amzn1.application-oa2-client.syn\n');
  // Файлы окружения сервисов (ClickHouse, туннель) compose читает при разборе — синтетические заглушки
  writeFileSync(join(secrets, 'clickhouse.env'), 'CLICKHOUSE_USER=syn\n');
  writeFileSync(join(secrets, 'tunnel.env'), 'TUNNEL_TOKEN=syn\n');
  writeFileSync(join(work, 'build.env'), 'REPRACER_BUILD_SHA=0123456789abcdef0123456789abcdef01234567\nREPRACER_BUILD_AT=2026-11-14T12:00:00Z\n');
  type Svc = { environment?: Record<string, string>; volumes?: Array<{ source: string; target: string }>; command?: string[]; profiles?: string[] };
  const config = (...profiles: string[]) => (JSON.parse(execFileSync('docker', ['compose', '-f', join(root, 'deploy/pilot/compose.yaml'),
    '--env-file', join(root, 'deploy/pilot/pilot.env.example'), '--env-file', join(secrets, 'amazon.env'), '--env-file', join(work, 'build.env'),
    ...profiles.flatMap((p) => ['--profile', p]), 'config', '--format', 'json'],
  { env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? work, REPRACER_SECRETS_DIR: secrets }, encoding: 'utf8' })) as { services: Record<string, Svc> }).services;
  const pull = config();
  const backup = pull.backup!;
  assert.equal(backup.environment!.PGURL_FILE, '/run/secrets/backup_pg_url', 'the copy connects with its own connection string file');
  assert.equal(backup.environment!.REPRACER_BACKUP_PUBLIC_KEY_FILE, '/run/secrets/backup_public_key.asc', 'only the PUBLIC key is on the server');
  const loop = backup.volumes!.find((v) => v.target === '/opt/repracer/backup-loop.sh')!;
  assert.equal(loop.source, join(root, 'deploy/production/backup-loop.sh'), 'the same copy loop as the production profile — one script');
  assert.ok(existsSync(loop.source));
  assert.equal(backup.volumes!.find((v) => v.target === '/backups')!.source, '/srv/repracer-pilot/backups', 'copies go to REPRACER_BACKUP_DIR');
  assert.equal(pull['backup-offsite'], undefined, 'without the r2 profile there is no R2 service: copies leave by pull');
  const r2 = config('r2')['backup-offsite']!;
  assert.deepEqual(r2.command!.slice(-1), ['deploy/pilot/offsite-r2.ts']);
  assert.equal(r2.environment!.REPRACER_BACKUP_R2_SECRET_ACCESS_KEY_FILE, '/run/secrets/backup_r2_secret_access_key', 'R2 keys — files, not values');
  assert.equal(r2.volumes!.find((v) => v.target === '/backups')!.source, '/srv/repracer-pilot/backups', 'the offsite service reads the same copies');
  // Обёртка включает профиль по выбору цели: её копия рядом со своими pilot.env и build.env, `docker` подменён — печатает, с чем его позвали
  const wrap = join(work, 'wrap');
  mkdirSync(join(wrap, 'bin'), { recursive: true });
  writeFileSync(join(wrap, 'compose.sh'), readFileSync(join(root, 'deploy/pilot/compose.sh')));
  writeFileSync(join(wrap, 'build.env'), 'REPRACER_BUILD_SHA=x\n');
  writeFileSync(join(wrap, 'bin', 'docker'), '#!/bin/bash\necho "$*"\n');
  chmodSync(join(wrap, 'bin', 'docker'), 0o755);
  const wrapped = (mode: string) => {
    writeFileSync(join(wrap, 'pilot.env'), `REPRACER_SECRETS_DIR=${secrets}\nREPRACER_BACKUP_OFFSITE=${mode}\n`);
    return execFileSync('bash', [join(wrap, 'compose.sh'), 'up', '-d'], { env: { PATH: `${join(wrap, 'bin')}:${process.env.PATH ?? ''}` }, encoding: 'utf8' });
  };
  assert.match(wrapped('r2'), / --profile r2 up -d\n$/, 'r2 — the wrapper turns on the offsite service');
  assert.doesNotMatch(wrapped('pull'), /--profile/, 'pull — no R2 service');
});

test('step 126: the deployment refuses without backups — no choice of target, no public key, a private key on the server, no R2 keys, no directory', () => {
  const secrets = join(work, 'ready-secrets');
  const dir = join(work, 'ready-backups');
  mkdirSync(secrets, { recursive: true });
  const ready = (mode: string, env: Record<string, string> = {}, d = dir) => sh('deploy/pilot/backup-state.sh', ['--ready', secrets, d, mode], env);
  const expect = (r: { code: number | null; out: string }, why: RegExp) => { assert.equal(r.code, 1, r.out); assert.match(r.out, /BACKUP RED: /); assert.match(r.out, why); };
  expect(ready(''), /REPRACER_BACKUP_OFFSITE=r2\|pull/);
  expect(ready('s3'), /REPRACER_BACKUP_OFFSITE=r2\|pull/);
  expect(ready('pull'), /нет .*backup_public_key\.asc/);
  writeFileSync(join(secrets, 'backup_public_key.asc'), 'not a key\n');
  expect(ready('pull'), /не открытый ключ PGP/);
  writeFileSync(join(secrets, 'backup_public_key.asc'), '-----BEGIN PGP PUBLIC KEY BLOCK-----\nsyn\n-----END PGP PUBLIC KEY BLOCK-----\n-----BEGIN PGP PRIVATE KEY BLOCK-----\nsyn\n');
  expect(ready('pull'), /ЗАКРЫТЫЙ ключ/);
  writeFileSync(join(secrets, 'backup_public_key.asc'), '-----BEGIN PGP PUBLIC KEY BLOCK-----\nsyn\n-----END PGP PUBLIC KEY BLOCK-----\n');
  writeFileSync(join(secrets, 'owner.asc'), '-----BEGIN PGP PRIVATE KEY BLOCK-----\nsyn\n');
  expect(ready('pull'), /закрытый ключ PGP/);
  rmSync(join(secrets, 'owner.asc'));
  expect(ready('pull'), /backup_pg_url/);
  writeFileSync(join(secrets, 'backup_pg_url'), 'postgres://postgres:syn@postgres:5432/repracer_pilot');
  expect(ready('pull'), /нет каталога копий/);
  mkdirSync(dir, { recursive: true });
  const ok = ready('pull');
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /BACKUP READY: .*pull/);
  expect(ready('r2'), /REPRACER_BACKUP_R2_BUCKET_URL/);
  expect(ready('r2', { REPRACER_BACKUP_R2_BUCKET_URL: 'https://evil.example' }), /REPRACER_BACKUP_R2_BUCKET_URL/);
  const bucket = { REPRACER_BACKUP_R2_BUCKET_URL: 'https://repracer-pilot-backups.0000000000000000.r2.cloudflarestorage.com' };
  expect(ready('r2', bucket), /backup_r2_access_key_id/);
  writeFileSync(join(secrets, 'backup_r2_access_key_id'), 'syn-key-id');
  writeFileSync(join(secrets, 'backup_r2_secret_access_key'), 'syn-r2-secret-never-printed');
  const r2 = ready('r2', bucket);
  assert.equal(r2.code, 0, r2.out);
  assert.ok(!r2.out.includes('syn-r2-secret-never-printed'), 'a key value reached the output');
  // Выкладка спрашивает это до всего остального: строка стоит сразу за чтением pilot.env, раньше сборки и базы
  const deploy = readFileSync(join(root, 'deploy/pilot/deploy.sh'), 'utf8');
  assert.ok(deploy.indexOf('backup-state.sh --ready') > 0 && deploy.indexOf('backup-state.sh --ready') < deploy.indexOf('npm ci'), 'deploy.sh asks before it builds anything');
});

test('step 126: push-secrets.sh does not send a directory holding a private PGP key to the server', () => {
  const local = join(work, 'push-local');
  mkdirSync(local, { recursive: true });
  writeFileSync(join(local, 'tunnel.env'), 'TUNNEL_TOKEN=syn\n');
  writeFileSync(join(local, 'pilot-backup-private.asc'), '-----BEGIN PGP PRIVATE KEY BLOCK-----\nsyn\n');
  const r = sh('deploy/pilot/push-secrets.sh', ['deploy@server.invalid'], { REPRACER_PILOT_LOCAL_SECRETS: local });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /закрытый ключ PGP — на сервер он не уходит/);
});

test('step 126: pull — the operator machine takes every finished copy over SSH, checks its SHA-256, keeps 7 days, leaves OFFSITE_PULLED on the server', () => {
  const server = join(work, 'pull-server');
  const local = join(work, 'pull-local');
  // `ssh <адрес> <команда>` — та же команда локальной оболочкой: сервер прогона — каталог рядом
  const bin = join(work, 'pull-bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'ssh'), '#!/bin/bash\nshift\nexec bash -c "$*"\n');
  chmodSync(join(bin, 'ssh'), 0o755);
  const fresh = stampOf(2 * HOUR);
  const yesterday = stampOf(26 * HOUR);
  const old = stampOf(8 * 24 * HOUR);
  copy(server, fresh);
  copy(server, yesterday);
  copy(server, old);
  copy(server, stampOf(HOUR / 2), { sums: false }); // ещё пишется — без файла сумм
  writeFileSync(join(server, `repracer-${stampOf(HOUR / 2)}.dump.gpg.part`), 'partial');
  const pull = () => sh('deploy/pilot/pull-backups.sh', ['deploy@server.invalid', local], { PATH: `${bin}:${process.env.PATH ?? ''}`, REPRACER_PILOT_REMOTE_BACKUP_DIR: server });
  const first = pull();
  assert.equal(first.code, 0, first.out);
  assert.match(first.out, new RegExp(`PULL GREEN: новых копий 2, последняя repracer-${fresh}`));
  const taken = readdirSync(local).sort();
  assert.deepEqual(taken, [yesterday, fresh].sort().flatMap((s) => [`repracer-${s}.dump.gpg`, `repracer-${s}.globals.sql.gpg`, `repracer-${s}.sha256`]),
    'finished copies within 7 days only: no copy still being written, no part, nothing older than the retention');
  assert.equal(readFileSync(join(local, `repracer-${fresh}.dump.gpg`), 'utf8'), `syn-copy-${fresh}-dump`, 'the bytes of the copy');
  assert.match(readFileSync(join(server, 'OFFSITE_PULLED'), 'utf8'), new RegExp(`^\\{"pulledThrough":"${fresh}","at":"\\d{8}T\\d{6}Z"\\}\\n$`));
  const again = pull();
  assert.match(again.out, /новых копий 0/, 'a second run takes nothing twice');
  // Порча при переносе: сумма не сходится — копия не принимается, частей не остаётся, проход красный
  const broken = stampOf(HOUR);
  copy(server, broken);
  writeFileSync(join(server, `repracer-${broken}.dump.gpg`), 'tampered');
  const red = pull();
  assert.equal(red.code, 1, red.out);
  assert.match(red.out, new RegExp(`PULL RED: копия не сошлась по SHA-256 и не принята: ${broken}`));
  assert.deepEqual(readdirSync(local).filter((f) => f.includes(broken)), [], 'nothing of the broken copy is kept here');
  // Срок здесь — как на сервере: копия, ставшая старше 7 суток, уходит
  copy(local, old);
  pull();
  assert.deepEqual(readdirSync(local).filter((f) => f.includes(old)), [], 'a copy older than 7 days is deleted on the operator machine too');
});

/** Модель бакета R2 по S3 API: PUT (хэш тела сверяется, как у S3), HEAD, ListObjectsV2 страницами, DELETE; подпись обязана быть, ключ — нет */
function modelR2(): { server: Server; objects: Map<string, { body: Buffer; at: string }>; requests: Array<{ method: string; url: string; auth: string }>; failPut: { on: boolean } } {
  const objects = new Map<string, { body: Buffer; at: string }>();
  const requests: Array<{ method: string; url: string; auth: string }> = [];
  const failPut = { on: false };
  const server = createServer(async (req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    const auth = String(req.headers.authorization ?? '');
    requests.push({ method: req.method!, url: req.url!, auth });
    if (!/^AWS4-HMAC-SHA256 Credential=syn-key-id\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=[a-z0-9;-]*x-amz-content-sha256[a-z0-9;-]*, Signature=[0-9a-f]{64}$/.test(auth)) {
      res.writeHead(403); res.end('<Error><Code>AccessDenied</Code></Error>'); return;
    }
    const url = new URL(req.url!, 'http://model.invalid');
    const key = decodeURIComponent(url.pathname.slice(1));
    if (req.method === 'PUT') {
      if (failPut.on) { res.writeHead(500); res.end(); return; }
      if (req.headers['x-amz-content-sha256'] !== sha(body)) { res.writeHead(400); res.end('<Error><Code>XAmzContentSHA256Mismatch</Code></Error>'); return; }
      objects.set(key, { body, at: new Date().toISOString() });
      res.writeHead(200, { etag: '"syn"' }); res.end(); return;
    }
    if (req.method === 'HEAD') { const o = objects.get(key); res.writeHead(o ? 200 : 404, o ? { 'content-length': String(o.body.length) } : {}); res.end(); return; }
    if (req.method === 'DELETE') { objects.delete(key); res.writeHead(204); res.end(); return; }
    if (req.method === 'GET' && url.searchParams.get('list-type') === '2') {
      const prefix = url.searchParams.get('prefix') ?? '';
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = Number(url.searchParams.get('continuation-token') ?? 0);
      const page = keys.slice(start, start + 2); // страницы по два — проход обязан листать
      const more = start + 2 < keys.length;
      res.writeHead(200, { 'content-type': 'application/xml' });
      res.end(`<ListBucketResult>${page.map((k) => `<Contents><Key>${k}</Key></Contents>`).join('')}<IsTruncated>${more}</IsTruncated>${more ? `<NextContinuationToken>${start + 2}</NextContinuationToken>` : ''}</ListBucketResult>`);
      return;
    }
    res.writeHead(400); res.end();
  });
  return { server, objects, requests, failPut };
}

test('step 126: r2 — every finished copy goes to the bucket once with a signed payload hash, the mark appears only after HEAD agrees; a failure leaves an alert and its mark; the bucket keeps 7 days', async () => {
  const { offsiteOnce } = await import('../../deploy/pilot/offsite-r2.ts');
  const model = modelR2();
  await new Promise<void>((resolve) => model.server.listen(0, '127.0.0.1', resolve));
  try {
    const dir = join(work, 'r2-backups');
    const fresh = stampOf(HOUR);
    copy(dir, fresh);
    copy(dir, stampOf(HOUR / 4), { sums: false });
    const lines: Array<Record<string, unknown>> = [];
    const cfg = {
      dir, bucketUrl: `http://127.0.0.1:${(model.server.address() as AddressInfo).port}`, prefix: 'pilot/', keepDays: 7,
      credentials: { accessKeyId: 'syn-key-id', secretAccessKey: 'syn-r2-secret-never-printed' }, fetch: (u: string, i: never) => fetch(u, i), now: () => new Date(), log: (l: Record<string, unknown>) => lines.push(l),
    };
    // В бакете — копия старше срока от прошлых проходов: её удаляет проход, а свежую не трогает
    const old = stampOf(9 * 24 * HOUR);
    model.objects.set(`pilot/repracer-${old}.dump.gpg`, { body: Buffer.from('old'), at: '' });
    model.objects.set(`pilot/repracer-${old}.sha256`, { body: Buffer.from('old'), at: '' });
    model.objects.set('other/repracer-19990101T000000Z.dump.gpg', { body: Buffer.from('not ours'), at: '' });
    // Провал записи: отметки выноса нет, алерт и файл провала есть
    model.failPut.on = true;
    const failed = await offsiteOnce(cfg as never);
    assert.equal(failed.failed, 'PUT_FAILED');
    assert.ok(!existsSync(join(dir, `repracer-${fresh}.offsite`)), 'no mark without the copy in the bucket');
    assert.match(readFileSync(join(dir, 'BACKUP_OFFSITE_FAILED'), 'utf8'), /"code":"BACKUP_OFFSITE_FAILED".*"why":"PUT_FAILED"/);
    assert.deepEqual(lines.filter((l) => l.event === 'ALERT').map((l) => [l.code, l.severity]), [['BACKUP_OFFSITE_FAILED', 'CRITICAL']]);
    model.failPut.on = false;
    const done = await offsiteOnce(cfg as never);
    assert.deepEqual([done.failed, done.uploaded], [null, [fresh]], 'only the finished copy goes — not the one still being written');
    assert.deepEqual([...model.objects.keys()].filter((k) => k.startsWith('pilot/')).sort(),
      [`pilot/repracer-${fresh}.dump.gpg`, `pilot/repracer-${fresh}.globals.sql.gpg`, `pilot/repracer-${fresh}.sha256`], 'copies older than 7 days are gone from the bucket');
    assert.ok(model.objects.has('other/repracer-19990101T000000Z.dump.gpg'), 'keys outside the prefix are not ours and stay');
    assert.equal(model.objects.get(`pilot/repracer-${fresh}.dump.gpg`)!.body.toString(), `syn-copy-${fresh}-dump`, 'the bucket holds the bytes of the copy');
    assert.match(readFileSync(join(dir, `repracer-${fresh}.offsite`), 'utf8'), /"bytes":\d+/);
    assert.ok(!existsSync(join(dir, 'BACKUP_OFFSITE_FAILED')), 'the failure mark goes with the first good pass');
    const puts = model.requests.filter((r) => r.method === 'PUT').length;
    await offsiteOnce(cfg as never);
    assert.equal(model.requests.filter((r) => r.method === 'PUT').length, puts, 'a marked copy is not uploaded again');
    assert.ok(!JSON.stringify([lines, model.requests]).includes('syn-r2-secret-never-printed'), 'the secret key is neither logged nor sent');
  } finally {
    model.server.close();
  }
});

test('step 126: the smoke verdict — a fresh finished copy, off the server, one kept copy checked by a restore; each missing part is red with what to do', () => {
  const dir = join(work, 'state');
  mkdirSync(dir, { recursive: true });
  const state = (mode: string) => sh('deploy/pilot/backup-state.sh', [dir, mode]);
  const red = (mode: string, why: RegExp) => { const r = state(mode); assert.equal(r.code, 1, r.out); assert.match(r.out, why); };
  red('pull', /готовых копий нет/);
  const stale = stampOf(30 * HOUR);
  copy(dir, stale);
  red('pull', new RegExp(`последняя копия repracer-${stale} старше 26 ч`));
  const fresh = stampOf(HOUR);
  copy(dir, fresh);
  red('pull', /копии не выносились с сервера — на машине оператора: deploy\/pilot\/pull-backups\.sh/);
  writeFileSync(join(dir, 'OFFSITE_PULLED'), `{"pulledThrough":"${stale}","at":"x"}\n`);
  red('pull', /не вынесено ни одной копии моложе 26 ч/);
  writeFileSync(join(dir, 'OFFSITE_PULLED'), `{"pulledThrough":"${fresh}","at":"x"}\n`);
  red('pull', /ни одна из хранимых копий не проверена восстановлением/);
  // Отметка проверки копии, которой уже нет, в счёт не идёт
  writeFileSync(join(dir, `repracer-${stampOf(9 * 24 * HOUR)}.restore-checked`), '{}\n');
  red('pull', /ни одна из хранимых копий не проверена восстановлением/);
  writeFileSync(join(dir, `repracer-${stale}.restore-checked`), '{}\n');
  const green = state('pull');
  assert.equal(green.code, 0, green.out);
  assert.match(green.out, new RegExp(`BACKUP GREEN: последняя копия repracer-${fresh}; вне сервера — машина оператора, repracer-${fresh}; восстановление проверено на repracer-${stale}`));
  red('r2', /в R2 нет копии моложе 26 ч/);
  writeFileSync(join(dir, `repracer-${fresh}.offsite`), '{}\n');
  assert.equal(state('r2').code, 0);
  writeFileSync(join(dir, 'BACKUP_OFFSITE_FAILED'), '{"code":"BACKUP_OFFSITE_FAILED","why":"PUT_FAILED"}\n');
  red('r2', /вынос в R2 проваливается: .*PUT_FAILED/);
  writeFileSync(join(dir, 'BACKUP_FAILED'), '{"code":"BACKUP_FAILED","consecutive":2}\n');
  red('pull', /копия базы проваливается: .*BACKUP_FAILED/);
  // Смоук пилота спрашивает именно это
  assert.match(readFileSync(join(root, 'deploy/pilot/smoke.sh'), 'utf8'), /backup-state\.sh" "\$\{REPRACER_BACKUP_DIR\}" "\$\{REPRACER_BACKUP_OFFSITE\}" \|\| fail/);
});
