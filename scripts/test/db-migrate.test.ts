import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

/**
 * Шаг 124 [Р-248]: живой базе пилота — только НОВЫЕ миграции. До шага в репозитории был один путь схемы — `scripts/db/prepare.sh`, который базу пересоздаёт,
 * и README промышленного профиля советовал его «при каждом обновлении миграций»: каждая выкладка стёрла бы подключённый аккаунт продавца, его каталог и неделю
 * тени (Р-204 требует 7 суток подряд). `scripts/db/migrate.sh` ведёт журнал в настройке базы `repracer.migrations` — номер последней применённой и сумма всех
 * применённых файлов: применяет только файлы после номера, а изменённую задним числом миграцию отказывается накатывать дальше.
 *
 * Миграции здесь синтетические (каталог во временной папке): проверяется поведение журнала, а не схема продукта. Нужен PostgreSQL [Р-84].
 */
const script = new URL('../db/migrate.sh', import.meta.url).pathname;
const admin = process.env.REPRACER_PG_ADMIN_URL;
const db = `repracer_migrate_${process.pid}`;
let dir = '';

const psql = (sql: string, database = 'postgres') => {
  const url = new URL(admin!); url.pathname = `/${database}`;
  return execFileSync('psql', [url.toString(), '-v', 'ON_ERROR_STOP=1', '-Atc', sql], { encoding: 'utf8' }).trim();
};
const env = () => {
  const url = new URL(admin!);
  return { PATH: process.env.PATH ?? '', PGHOST: url.hostname, PGPORT: url.port || '5432', PGUSER: decodeURIComponent(url.username), REPRACER_MIGRATIONS_DIR: dir };
};
const run = (...args: string[]) => {
  const r = spawnSync('bash', [script, ...args], { env: env(), encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};
const migration = (file: string, sql: string) => writeFileSync(join(dir, file), `BEGIN;\n${sql}\nCOMMIT;\n`);

before(() => {
  if (!admin) throw new Error('REPRACER_PG_ADMIN_URL is required: the test does not skip (Р-84)');
  dir = mkdtempSync(join(tmpdir(), 'repracer-migrate-'));
  psql(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
  migration('0001_first.sql', 'CREATE TABLE t (id int);');
  migration('0002_second.sql', 'INSERT INTO t VALUES (2);');
});
after(() => {
  if (admin) psql(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test('step 124 [Р-248]: a new database is created with its region and every migration; the journal names the last one', () => {
  const first = run(db, '--create', 'US');
  assert.equal(first.code, 0, first.out);
  assert.equal(psql('SELECT count(*) FROM t', db), '1', 'both migrations applied, in order');
  assert.match(psql(`SELECT setconfig::text FROM pg_db_role_setting WHERE setrole = 0 AND setdatabase = (SELECT oid FROM pg_database WHERE datname = '${db}')`),
    /repracer\.region=US.*repracer\.migrations=0002:[0-9a-f]{64}|repracer\.migrations=0002:[0-9a-f]{64}.*repracer\.region=US/, 'region and journal are settings of the database');
  assert.match(run(db, '--create', 'US').out, /already exists/, 'a second create refuses: the database is not recreated');
});

test('step 124 [Р-248]: the next run applies nothing; a new migration file is applied alone', () => {
  const again = run(db);
  assert.equal(again.code, 0, again.out);
  assert.match(again.out, /applied 0/, 'nothing new — nothing applied');
  migration('0003_third.sql', 'INSERT INTO t VALUES (3);');
  const third = run(db);
  assert.equal(third.code, 0, third.out);
  assert.match(third.out, /0003_third\.sql/);
  assert.equal(psql('SELECT string_agg(id::text, \',\' ORDER BY id) FROM t', db), '2,3', 'only the new migration ran — 0002 was not run twice');
});

test('step 124 [Р-248]: a migration changed after it was applied stops the run; nothing new is applied past it', () => {
  migration('0002_second.sql', 'INSERT INTO t VALUES (22);');
  migration('0004_fourth.sql', 'INSERT INTO t VALUES (4);');
  const tampered = run(db);
  assert.notEqual(tampered.code, 0);
  assert.match(tampered.out, /applied migrations changed/, `the reason is named: ${tampered.out}`);
  assert.equal(psql('SELECT string_agg(id::text, \',\' ORDER BY id) FROM t', db), '2,3', '0004 was not applied');
  migration('0002_second.sql', 'INSERT INTO t VALUES (2);');
  assert.equal(run(db).code, 0, 'restored file — the run goes on');
  assert.equal(psql('SELECT string_agg(id::text, \',\' ORDER BY id) FROM t', db), '2,3,4');
});

test('step 124 [Р-248]: a database without the journal is not migrated — what was applied there is unknown', () => {
  const bare = `${db}_bare`;
  psql(`DROP DATABASE IF EXISTS ${bare} WITH (FORCE)`);
  psql(`CREATE DATABASE ${bare}`);
  try {
    psql('CREATE TABLE t (id int)', bare);
    const r = run(bare);
    assert.notEqual(r.code, 0);
    assert.match(r.out, /no migration journal/, r.out);
    assert.match(run(`${db}_missing`).out, /does not exist/, 'a missing database is not created without --create');
  } finally {
    psql(`DROP DATABASE IF EXISTS ${bare} WITH (FORCE)`);
  }
});
