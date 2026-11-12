import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

/**
 * Шаг 121 (QA-A): сброс тестовых данных одной командой — `scripts/qa-reset.sh <база>`. Сброс пересоздаёт базу целиком, поэтому его
 * физически нельзя запустить на базе, которая не закрыта стражем P0-09 (`repracer.live_writes`, шаг 119): боевая база стражем не закрыта
 * никогда. Пересозданная база теряет настройку уровня базы — скрипт ставит её снова ДО того, как к базе подключится стенд.
 *
 * Подготовка базы (миграции и смоук, минуты) в тесте заменена быстрой заглушкой (`QA_RESET_PREPARE`): проверяется сам скрипт — его
 * отказы и то, что страж после пересоздания снова стоит. Данные синтетические
 */

const admin = new URL(process.env.REPRACER_PG_ADMIN_URL ?? '');
const template = process.env.REPRACER_PG_TEMPLATE ?? 'repracer_template';
const env = { PATH: process.env.PATH ?? '', PGHOST: admin.hostname, PGPORT: admin.port || '5432', PGUSER: decodeURIComponent(admin.username) };
const script = new URL('../qa-reset.sh', import.meta.url).pathname;
const db = `qa_reset_${randomBytes(4).toString('hex')}`;
let dir = '';

const psql = (database: string, sql: string) => {
  const r = spawnSync('psql', ['-v', 'ON_ERROR_STOP=1', '-qAt', '-d', database, '-c', sql], { env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`psql: ${r.stderr}`);
  return r.stdout.trim();
};
const reset = (args: string[], extra: Record<string, string> = {}) =>
  spawnSync('bash', [script, ...args], { env: { ...env, ...extra }, encoding: 'utf8' });
const exists = (name: string) => psql('postgres', `SELECT count(*) FROM pg_database WHERE datname = '${name}'`) === '1';

before(() => {
  assert.ok(process.env.REPRACER_PG_ADMIN_URL, 'REPRACER_PG_ADMIN_URL is required: database tests do not skip (Р-84)');
  dir = mkdtempSync(join(tmpdir(), 'repracer-qa-reset-'));
  psql('postgres', `CREATE DATABASE ${db} TEMPLATE ${template}`);
  psql(db, 'CREATE TABLE public.qa_marker (x int); INSERT INTO public.qa_marker VALUES (1)');
});
after(() => {
  for (const name of [db, `${db}_new`]) if (exists(name)) psql('postgres', `DROP DATABASE ${name} WITH (FORCE)`);
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test('step 121: the reset refuses a database that is not guarded by P0-09 — nothing is dropped', () => {
  const r = reset([db]);
  assert.notEqual(r.status, 0, 'the reset of an unguarded database is refused');
  assert.match(r.stderr, /not guarded/, `the refusal names the guard: ${r.stderr}`);
  assert.equal(psql(db, 'SELECT count(*) FROM public.qa_marker'), '1', 'the data of the refused database is untouched');
});

test('step 121: a database that does not exist is created only with --first-time; --first-time never touches an existing one', () => {
  const missing = reset([`${db}_new`], { QA_RESET_CHECK_ONLY: '1' });
  assert.notEqual(missing.status, 0, 'a missing database is not created without --first-time');
  assert.match(missing.stderr, /--first-time/, missing.stderr);
  const first = reset([`${db}_new`, '--first-time'], { QA_RESET_CHECK_ONLY: '1' });
  assert.equal(first.status, 0, `--first-time on a missing database passes the check: ${first.stderr}`);
  const again = reset([db, '--first-time'], { QA_RESET_CHECK_ONLY: '1' });
  assert.notEqual(again.status, 0, '--first-time on an existing database is refused');
  assert.match(again.stderr, /already exists/, again.stderr);
});

test('step 121: a guarded database is rebuilt and guarded again before anything connects', () => {
  psql('postgres', `ALTER DATABASE ${db} SET repracer.live_writes = 'forbidden'`);
  const check = reset([db], { QA_RESET_CHECK_ONLY: '1' });
  assert.equal(check.status, 0, `a guarded database passes the check: ${check.stderr}`);
  assert.match(check.stdout, /guarded/, check.stdout);
  // Заглушка подготовки: пересоздаёт базу из шаблона — настройка уровня базы при этом теряется, как у настоящей подготовки
  const prepare = join(dir, 'prepare.sh');
  writeFileSync(prepare, `#!/usr/bin/env bash\nset -euo pipefail\npsql -v ON_ERROR_STOP=1 -q -d postgres -c "DROP DATABASE IF EXISTS $1 WITH (FORCE)" -c "CREATE DATABASE $1 TEMPLATE ${template}"\n`, { mode: 0o755 });
  const r = reset([db], { QA_RESET_PREPARE: prepare });
  assert.equal(r.status, 0, `the reset of a guarded database runs: ${r.stderr}`);
  assert.equal(psql(db, `SELECT count(*) FROM pg_tables WHERE tablename = 'qa_marker'`), '0', 'the database was rebuilt');
  assert.equal(psql(db, 'SELECT security.live_writes_forbidden()'), 't', 'the rebuilt database is guarded again');
  assert.equal(psql(db, `SELECT current_setting('repracer.region')`), 'US', 'the QA database is of the US region (the demo is an American seller)');
});
