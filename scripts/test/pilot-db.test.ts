import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, readdirSync } from 'node:fs';
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
