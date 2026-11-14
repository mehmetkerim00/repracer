import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { loadKeyring } from '@repracer/channel-oauth';

/**
 * Шаг 124 [Р-247, Р-248]: секреты и база пилота. Секреты собирает deploy/pilot/secrets.sh на машине владельца — ни одно значение не печатается, файлы 600,
 * повторный запуск ничего не меняет. База пилота живая: первая сборка — миграции через журнал, роли входа, пароли ролей и СТРАЖ боевых записей; выкладка
 * применяет только новые миграции и стража не трогает: снятый по процедуре (`allowed`) остаётся снятым, а снятый без значения — отказ выкладки.
 *
 * Данные синтетические: файл ключей Amazon — выдуманный, база — временная. Нужен PostgreSQL [Р-84].
 */
const root = new URL('../../', import.meta.url).pathname;
const admin = process.env.REPRACER_PG_ADMIN_URL;
const DB = `repracer_pilot_${process.pid}`;
let work = '';
let secrets = '';

const psql = (sql: string, database = 'postgres') => {
  const url = new URL(admin!); url.pathname = `/${database}`;
  return execFileSync('psql', [url.toString(), '-v', 'ON_ERROR_STOP=1', '-Atc', sql], { encoding: 'utf8' }).trim();
};
const pgEnv = () => {
  const url = new URL(admin!);
  return { PGHOST: url.hostname, PGPORT: url.port || '5432', PGUSER: decodeURIComponent(url.username) };
};
const sh = (script: string, args: string[], env: Record<string, string>) => {
  const r = spawnSync('bash', [join(root, script), ...args], { env: { PATH: process.env.PATH ?? '', HOME: work, ...env }, encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};
const generate = () => sh('deploy/pilot/secrets.sh', [], { REPRACER_PILOT_LOCAL_SECRETS: secrets, REPRACER_AMAZON_PRODUCTION_ENV: join(work, 'amazon-production.env'), REPRACER_PILOT_DB: DB });
const db = (...args: string[]) => sh('deploy/pilot/db.sh', args, { ...pgEnv(), REPRACER_PILOT_DB: DB, REPRACER_PILOT_REGION: 'US', REPRACER_PILOT_SECRETS: secrets });
const roles = () => readFileSync(join(secrets, 'pg_role_passwords'), 'utf8').trim().split('\n').map((l) => l.split(' ')[0]!);

before(() => {
  if (!admin) throw new Error('REPRACER_PG_ADMIN_URL is required: the test does not skip (Р-84)');
  work = mkdtempSync(join(tmpdir(), 'repracer-pilot-'));
  secrets = join(work, 'pilot');
  writeFileSync(join(work, 'amazon-production.env'),
    'AMAZON_PRODUCTION_APP_ID=amzn1.sp.solution.syn-pilot-app\nAMAZON_PRODUCTION_LWA_CLIENT_ID=amzn1.application-oa2-client.syn-pilot\nAMAZON_PRODUCTION_LWA_CLIENT_SECRET=syn-lwa-secret-never-printed\n');
  psql(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
});
after(() => {
  if (admin) {
    psql(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
    // Пароли ролей кластера — обратно пустые: в тестовом кластере вход идёт без пароля, и чужим прогонам пароль ни к чему
    if (secrets) for (const role of roles()) psql(`ALTER ROLE ${role} PASSWORD NULL`);
  }
  if (work) rmSync(work, { recursive: true, force: true });
});

test('step 124 [Р-248]: the pilot secrets are made on the owner machine — nothing printed, files 600, a second run changes nothing', () => {
  const first = generate();
  assert.equal(first.code, 0, first.out);
  const files = readdirSync(secrets).filter((f) => statSync(join(secrets, f)).isFile());
  assert.ok(statSync(join(secrets, 'channels')).isDirectory(), 'the channel secrets directory the scheduler reads exists');
  for (const f of ['postgres_password', 'pg_role_passwords', 'console_app_pg_url', 'console_bulk_worker_pg_url', 'scheduler_pg_url', 'credentials_pg_url',
    'alert_delivery_pg_url', 'operator_pg_url', 'clickhouse.env', 'ch_ingest_password', 'ch_verifier_password', 'channel_keyring.json', 'amazon_lwa_client_secret', 'amazon.env']) {
    assert.ok(files.includes(f), `${f} is made`);
    assert.equal(statSync(join(secrets, f)).mode & 0o777, 0o600, `${f} is readable by its owner only`);
  }
  assert.equal(statSync(secrets).mode & 0o777, 0o700);
  // Ни одно значение не печатается: ни пароль роли, ни секрет LWA, ни ключ токенов
  const values = [readFileSync(join(secrets, 'postgres_password'), 'utf8'), ...readFileSync(join(secrets, 'pg_role_passwords'), 'utf8').trim().split('\n').map((l) => l.split(' ')[1]!),
    'syn-lwa-secret-never-printed', JSON.parse(readFileSync(join(secrets, 'channel_keyring.json'), 'utf8')).keys.k1 as string];
  for (const v of values) assert.ok(!first.out.includes(v), 'a secret value reached the output');
  assert.equal(readFileSync(join(secrets, 'amazon_lwa_client_secret'), 'utf8'), 'syn-lwa-secret-never-printed');
  assert.match(readFileSync(join(secrets, 'amazon.env'), 'utf8'), /^REPRACER_AMAZON_APP_ID=amzn1\.sp\.solution\.syn-pilot-app\nREPRACER_AMAZON_LWA_CLIENT_ID=amzn1\.application-oa2-client\.syn-pilot\n$/);
  assert.equal(loadKeyring(readFileSync(join(secrets, 'channel_keyring.json'), 'utf8')).current, 'k1', 'the keyring is what the processes load');
  assert.match(readFileSync(join(secrets, 'console_app_pg_url'), 'utf8'), new RegExp(`^postgres://svc_app:[0-9a-f]{48}@postgres:5432/${DB}$`));
  const before = Object.fromEntries(files.map((f) => [f, readFileSync(join(secrets, f), 'utf8')]));
  const second = generate();
  assert.equal(second.code, 0, second.out);
  for (const f of files) assert.equal(readFileSync(join(secrets, f), 'utf8'), before[f], `${f} is kept as it was`);
});

test('step 124 [Р-247, Р-248]: the first build makes the database with every migration, role passwords and the live-writes guard', () => {
  const first = db('--first-time');
  assert.equal(first.code, 0, first.out);
  assert.match(first.out, /PILOT DB GREEN/);
  for (const v of readFileSync(join(secrets, 'pg_role_passwords'), 'utf8').trim().split('\n').map((l) => l.split(' ')[1]!)) assert.ok(!first.out.includes(v), 'a password reached the output');
  assert.equal(psql('SELECT security.live_writes_forbidden()', DB), 't', 'live writes are forbidden on the pilot database from day one (Р-247)');
  assert.equal(psql(`SELECT count(*) FROM pg_authid WHERE rolname = ANY ('{${roles().join(',')}}') AND rolpassword IS NOT NULL`), String(roles().length), 'every role of the pilot has a password');
  const last = readdirSync(join(root, 'migrations')).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort().at(-1)!.slice(0, 4);
  assert.match(psql(`SELECT setconfig::text FROM pg_db_role_setting WHERE setrole = 0 AND setdatabase = (SELECT oid FROM pg_database WHERE datname = '${DB}')`),
    new RegExp(`repracer\\.migrations=${last}:`), 'the journal names the last migration of the repository');
  assert.ok(Number(psql("SELECT count(*) FROM platform.channel_capability WHERE channel = 'AMAZON' AND region = 'NA'", DB)) >= 2, 'the Amazon capability rows are there');
  assert.match(db('--first-time').out, /already exists/, 'a first build over a living database refuses');
});

test('step 124 [Р-247, Р-248]: a deploy applies nothing new and keeps the guard; lifted by the procedure it stays lifted; lifted without a value it refuses', () => {
  const again = db();
  assert.equal(again.code, 0, again.out);
  assert.match(again.out, /applied 0/);
  assert.equal(psql('SELECT security.live_writes_forbidden()', DB), 't', 'a deploy does not lift the guard');
  psql(`ALTER DATABASE ${DB} SET repracer.live_writes = 'allowed'`);
  const lifted = db();
  assert.equal(lifted.code, 0, lifted.out);
  assert.match(lifted.out, /РАЗРЕШЕНЫ/, 'the deploy says so loudly');
  assert.equal(psql('SELECT security.live_writes_forbidden()', DB), 'f', 'a deploy does not put back a guard the owners lifted');
  psql(`ALTER DATABASE ${DB} RESET repracer.live_writes`);
  const reset = db();
  assert.notEqual(reset.code, 0);
  assert.match(reset.out, /нет настройки repracer\.live_writes/, reset.out);
});

/**
 * Шаг 126 [Р-249] («копия без проверенного восстановления копией не считается»): проверка восстановления копии пилота — тем, что владелец запускает на
 * сервере (deploy/pilot/restore-check-inner.sh внутри deploy/pilot/restore-check.sh), на базе пилота этого файла: суточная копия тем же скриптом, что в
 * работе (deploy/production/backup-loop.sh, одна итерация, gpg открытым ключом), база исчезает (проверка идёт на пустом месте, как во временном кластере
 * контейнера), копия восстанавливается закрытым ключом со стандартного ввода. У восстановленной базы — регион, СТРАЖ (копия, потерявшая его, подняла бы
 * пилот с разрешёнными боевыми записями), журнал миграций, числа. Контроли: чужой закрытый ключ — отказ; копия базы со снятым без значения стражем —
 * отказ своей причиной. Тест — в этом файле, на его базе: вторая сборка базы пилота параллельным файлом исчерпывала таблицу блокировок кластера
 * («out of shared memory»). Нужен gpg — как учению восстановления шага 65.
 */
const gpgIn = (home: string, args: string[]) => execFileSync('gpg', ['--homedir', home, '--batch', '--no-tty', '--pinentry-mode', 'loopback', '--passphrase', '', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
function keyPair(name: string): { publicKey: string; privateKey: string } {
  const home = join(work, `gnupg-${name}`);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  gpgIn(home, ['--quick-gen-key', `pilot backup ${name} <${name}@example.invalid>`, 'default', 'default', 'never']);
  const publicKey = join(work, `${name}-public.asc`);
  writeFileSync(publicKey, gpgIn(home, ['--armor', '--export', `${name}@example.invalid`]));
  return { publicKey, privateKey: gpgIn(home, ['--armor', '--export-secret-keys', `${name}@example.invalid`]).toString() };
}
const superUrl = (database: string) => { const u = new URL(admin!); u.pathname = `/${database}`; return u.toString(); };
function backupOnce(dir: string, publicKey: string): string {
  const url = join(work, 'backup_pg_url');
  writeFileSync(url, superUrl(DB));
  execFileSync('bash', [join(root, 'deploy/production/backup-loop.sh')],
    { env: { ...process.env, ...pgEnv(), PGURL_FILE: url, REPRACER_BACKUP_OUT: dir, REPRACER_BACKUP_PUBLIC_KEY_FILE: publicKey, REPRACER_BACKUP_ONCE: '1' }, stdio: 'pipe' });
  return readdirSync(dir).filter((f) => f.endsWith('.sha256')).sort().at(-1)!.replace('.sha256', '');
}
function restoreCheck(dir: string, name: string, privateKey: string) {
  const r = spawnSync('bash', [join(root, 'deploy/pilot/restore-check-inner.sh'), dir, name],
    { env: { PATH: process.env.PATH ?? '', HOME: work, ...pgEnv(), REPRACER_RESTORE_CHECK_ADMIN_URL: superUrl('postgres'), REPRACER_PILOT_REGION: 'US' }, encoding: 'utf8', input: privateKey });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test('step 126 [Р-249]: a copy of the pilot restores with the owner key from stdin — region, the live-writes guard, the migration journal and the numbers come back', { timeout: 10 * 60_000 }, () => {
  // База этого файла после прошлого теста — со снятым без значения стражем: вернуть его, как вернул бы владелец
  psql(`ALTER DATABASE ${DB} SET repracer.live_writes = 'forbidden'`);
  const owner = keyPair('owner');
  const dir = join(work, 'backups');
  mkdirSync(dir, { recursive: true });
  const journalBefore = psql(`SELECT current_setting('repracer.migrations', true)`, DB);
  const tenantsBefore = psql('SELECT count(*) FROM tenant_data.tenant', DB);
  const name = backupOnce(dir, owner.publicKey);
  psql(`DROP DATABASE ${DB} WITH (FORCE)`);
  const r = restoreCheck(dir, name, owner.privateKey);
  assert.equal(r.code, 0, r.err);
  const done = JSON.parse(r.out.trim().split('\n').at(-1)!) as { event: string; copy: string; database: string; region: string; liveWrites: string; migrationsThrough: string; facts: Record<string, number> };
  assert.deepEqual([done.event, done.copy, done.database, done.region], ['RESTORE_CHECK_DONE', name, DB, 'US']);
  assert.equal(done.liveWrites, 'forbidden', 'the live-writes guard of the pilot came back with the copy [Р-247]');
  assert.equal(psql('SELECT security.live_writes_forbidden()', DB), 't', 'the restored database refuses live writes');
  assert.equal(done.migrationsThrough, journalBefore.split(':')[0], 'the migration journal came back: the next deployment knows what is applied');
  assert.equal(psql(`SELECT current_setting('repracer.migrations', true)`, DB), journalBefore);
  assert.equal(String(done.facts.tenants), tenantsBefore, 'the numbers of the restored database are reported');
  assert.ok(!r.out.includes(owner.privateKey.slice(40, 120)) && !r.err.includes(owner.privateKey.slice(40, 120)), 'the private key is not printed');

  // Контроль: чужой закрытый ключ копию не открывает — отказ, а не «проверено»
  const stranger = keyPair('stranger');
  psql(`DROP DATABASE ${DB} WITH (FORCE)`);
  const wrong = restoreCheck(dir, name, stranger.privateKey);
  assert.equal(wrong.code, 1, wrong.out);
  assert.match(wrong.err, /RESTORE_FAILED.*decrypt|RESTORE_CHECK_FAILED/);

  // Контроль: страж снят без значения — копия такой базы проверку не проходит своей причиной
  const again = restoreCheck(dir, name, owner.privateKey);
  assert.equal(again.code, 0, again.err);
  psql(`ALTER DATABASE ${DB} RESET repracer.live_writes`);
  const unguarded = backupOnce(dir, owner.publicKey);
  psql(`DROP DATABASE ${DB} WITH (FORCE)`);
  const lost = restoreCheck(dir, unguarded, owner.privateKey);
  assert.equal(lost.code, 1, lost.out);
  assert.match(lost.err, /копия потеряла страж боевых записей \(Р-247\)/);
});
