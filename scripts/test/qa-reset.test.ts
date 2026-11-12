import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  for (const name of [db, `${db}_new`, `${db}_next`, `${db}_next_template`]) if (exists(name)) psql('postgres', `DROP DATABASE ${name} WITH (FORCE)`);
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** Заглушка подготовки: пересоздаёт базу-аргумент из шаблона (настройки уровня базы при этом теряются, как у настоящей подготовки) */
const preparer = (file: string, tail = '') => {
  const path = join(dir, file);
  writeFileSync(path, `#!/usr/bin/env bash\nset -euo pipefail\npsql -v ON_ERROR_STOP=1 -q -d postgres -c "DROP DATABASE IF EXISTS $1 WITH (FORCE)" -c "CREATE DATABASE $1 TEMPLATE ${template}"\n${tail}`, { mode: 0o755 });
  return path;
};
const guardOf = (name: string) => psql(name, 'SELECT security.live_writes_forbidden()');

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

/**
 * Шаг 121.3: сброс, убитый посреди сборки (обрыв SSH, kill -9, перезагрузка), не оставляет базу без стража, и повтор проходит.
 * Подготовка-заглушка создаёт свою базу и засыпает — в этот момент весь сброс убивается вместе с ней
 */
test('step 121.3: a reset killed in the middle of the build never leaves the database unguarded, and the retry completes', async () => {
  psql('postgres', `ALTER DATABASE ${db} SET repracer.live_writes = 'forbidden'`);
  const marker = join(dir, 'building');
  const slow = preparer('slow-prepare.sh', `touch ${marker}\nsleep 60\n`);
  const child = spawn('bash', [script, db], { env: { ...env, QA_RESET_PREPARE: slow }, detached: true, stdio: 'ignore' });
  const started = Date.now();
  while (!existsSync(marker) && Date.now() - started < 30_000) await new Promise((r) => setTimeout(r, 100));
  assert.ok(existsSync(marker), 'the preparer started building');
  process.kill(-child.pid!, 'SIGKILL');
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(exists(db), 'the QA database is still there after the reset was killed mid-build');
  assert.equal(guardOf(db), 't', 'the QA database is still guarded by P0-09 after the reset was killed mid-build');
  const retry = reset([db], { QA_RESET_PREPARE: preparer('prepare.sh') });
  assert.equal(retry.status, 0, `the retry after the killed reset runs: ${retry.stderr}`);
  assert.equal(guardOf(db), 't', 'the database rebuilt by the retry is guarded');
});

test('step 121.3: a reset that died between dropping the old database and renaming the new one is completed by the retry, not refused', () => {
  // Состояние после обрыва: старой базы нет, новая собрана и закрыта стражем
  psql('postgres', `DROP DATABASE IF EXISTS ${db}_next WITH (FORCE)`);
  psql('postgres', `CREATE DATABASE ${db}_next TEMPLATE ${template}`);
  psql('postgres', `ALTER DATABASE ${db}_next SET repracer.live_writes = 'forbidden'`);
  psql('postgres', `ALTER DATABASE ${db}_next SET repracer.region = 'US'`);
  psql('postgres', `DROP DATABASE ${db} WITH (FORCE)`);
  const check = reset([db], { QA_RESET_CHECK_ONLY: '1' });
  assert.equal(check.status, 0, `the check before the retry passes: ${check.stderr}`);
  // Доводится замена — подготовка не нужна: заглушка, которая падает, не должна быть вызвана
  const failing = join(dir, 'never.sh');
  writeFileSync(failing, '#!/usr/bin/env bash\necho "prepare must not run" >&2\nexit 9\n', { mode: 0o755 });
  const r = reset([db], { QA_RESET_PREPARE: failing });
  assert.equal(r.status, 0, `the retry completes the swap: ${r.stderr}`);
  assert.ok(exists(db) && !exists(`${db}_next`), 'the built database took the QA name');
  assert.equal(guardOf(db), 't', 'the QA database is guarded after the completed swap');
  assert.equal(psql(db, `SELECT current_setting('repracer.region')`), 'US');
});
