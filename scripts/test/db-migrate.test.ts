import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

/**
 * Шаг 131 (решение владельца 2026-11-15, п. 3.3): откат выкладки. Код версии N к базе, которой версия N+1 уже применила миграцию, — не «изменённая
 * миграция», а «база новее кода»: прежнее сообщение «applied migrations changed» уводило искать правку задним числом. Отказ называет обе миграции
 * и путь — восстановление копии, снятой перед миграциями. `--check` даёт план, ничего не применяя: его deploy.sh спрашивает ДО переключения
 * рабочей копии.
 */
test('step 131: --check gives the plan and applies nothing; a database ahead of the code is refused as such — exit 3, both numbers, the rollback path', () => {
  // База — на 0004 (тесты выше). Новая миграция: план её называет, но не применяет
  migration('0005_fifth.sql', 'INSERT INTO t VALUES (5);');
  const plan = run(db, '--check');
  assert.equal(plan.code, 0, plan.out);
  assert.match(plan.out, /^MIGRATIONS PLAN: .* at 0004; pending 1: 0005$/m);
  assert.equal(psql('SELECT string_agg(id::text, \',\' ORDER BY id) FROM t', db), '2,3,4', '--check applied nothing');
  assert.match(psql(`SELECT setconfig::text FROM pg_db_role_setting WHERE setrole = 0 AND setdatabase = (SELECT oid FROM pg_database WHERE datname = '${db}')`),
    /repracer\.migrations=0004:/, 'the journal did not move');
  const applied = run(db);
  assert.equal(applied.code, 0, applied.out);
  assert.match(run(db, '--check').out, /^MIGRATIONS PLAN: .* at 0005; pending 0$/m, 'nothing new — pending 0');
  // Код прежней версии (миграции только до 0003) к базе на 0005 — «база новее кода», код 3
  const older = mkdtempSync(join(tmpdir(), 'repracer-migrate-older-'));
  try {
    for (const f of ['0001_first.sql', '0002_second.sql', '0003_third.sql']) writeFileSync(join(older, f), readFileSync(join(dir, f)));
    const ahead = spawnSync('bash', [script, db, '--check'], { env: { ...env(), REPRACER_MIGRATIONS_DIR: older }, encoding: 'utf8' });
    assert.equal(ahead.status, 3, `${ahead.stdout}${ahead.stderr}`);
    assert.match(ahead.stderr, /database .* is at migration 0005, this code knows migrations only through 0003/);
    assert.match(ahead.stderr, /restore of the copy taken before them/);
    assert.doesNotMatch(ahead.stderr, /applied migrations changed/, 'not the misleading "changed"');
    // Без --check — тот же отказ, и ничего не применено
    const applying = spawnSync('bash', [script, db], { env: { ...env(), REPRACER_MIGRATIONS_DIR: older }, encoding: 'utf8' });
    assert.equal(applying.status, 3);
    // Правка задним числом остаётся правкой задним числом
    migration('0003_third.sql', 'INSERT INTO t VALUES (33);');
    const changed = run(db, '--check');
    assert.equal(changed.code, 1, changed.out);
    assert.match(changed.out, /applied migrations changed/);
    migration('0003_third.sql', 'INSERT INTO t VALUES (3);');
    assert.equal(run(db, '--check').code, 0);
  } finally {
    rmSync(older, { recursive: true, force: true });
  }
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
