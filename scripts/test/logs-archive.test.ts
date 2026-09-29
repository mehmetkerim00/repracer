import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Шаг 54 (OWASP A09): журналы ≥ 12 месяцев — горячий хвост сутками, дальше месячные архивы. Шаг 55 (ревью шага 54, находки 10–12):
 * отметка «выгружено по» у каждого проекта — пропущенные сутки догоняются, выгрузка перед выкладкой (`--until-now`) и ночной заход
 * пишут в один файл суток, сбой одного проекта не останавливает остальные. Проверяется ТОТ ЖЕ скрипт, что запускает таймер; вместо
 * docker — подставная команда, печатающая свои аргументы; время — REPRACER_LOGS_NOW, а не часы машины
 */
const SCRIPT = join(import.meta.dirname, '..', '..', 'deploy', 'production', 'logs-archive.sh');

function world(projects = 'repracer-production') {
  const root = mkdtempSync(join(tmpdir(), 'logs-archive-'));
  const fake = join(root, 'docker');
  // docker compose -p P logs --no-color --timestamps --since FROM --until TO; проект repracer-missing отвечает ошибкой, как compose без проекта
  writeFileSync(fake, '#!/bin/bash\nif [ "$3" = repracer-missing ]; then echo "no such project" >&2; exit 1; fi\necho "$3 $8 .. ${10}"\n');
  chmodSync(fake, 0o755);
  const env = (now: string) => ({ ...process.env, REPRACER_LOGS_HOT_DIR: join(root, 'hot'), REPRACER_ARCHIVE_DIR: join(root, 'archive'), REPRACER_LOG_PROJECTS: projects, REPRACER_DOCKER: fake, REPRACER_LOGS_NOW: now });
  const run = (now: string, ...args: string[]) => execFileSync('bash', [SCRIPT, ...args], { env: env(now), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const hot = join(root, 'hot', 'repracer-production');
  const lines = (file: string) => gunzipSync(readFileSync(file)).toString('utf8').trim().split('\n');
  return { root, run, hot, lines, months: join(root, 'archive', 'platform=logs', 'repracer-production') };
}

const days = (from: string, to: string): string[] => {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
};

test('step 54, 55: nightly runs keep a hot day file per day; a month out of the 30-day window becomes one archive with its checksum', () => {
  const w = world();
  try {
    // Ночной заход в 00:20 UTC каждых суток с 2026-07-02 по 2026-09-01: выгружает прошедшие сутки
    for (const d of days('2026-07-02', '2026-09-01')) w.run(`${d}T00:20:00Z`);
    const hot = readdirSync(w.hot).filter((f) => f.endsWith('.log.gz')).sort();
    assert.deepEqual([hot[0], hot[hot.length - 1], hot.length], ['2026-08-01.log.gz', '2026-08-31.log.gz', 31], 'August is still inside the hot window');
    assert.deepEqual(readdirSync(w.months).sort(), ['2026-07.log.gz', '2026-07.log.gz.sha256'], 'July is one month archive');
    const july = w.lines(join(w.months, '2026-07.log.gz'));
    assert.equal(july.length, 31, 'one dump per July day');
    assert.deepEqual([july[0], july[30]], ['repracer-production 2026-07-01T00:00:00Z .. 2026-07-02T00:00:00Z',
      'repracer-production 2026-07-31T00:00:00Z .. 2026-08-01T00:00:00Z'], 'in day order, each day exactly its own 24 hours');
    const sum = createHash('sha256').update(readFileSync(join(w.months, '2026-07.log.gz'))).digest('hex');
    assert.equal(readFileSync(join(w.months, '2026-07.log.gz.sha256'), 'utf8').trim(), sum);
  } finally { rmSync(w.root, { recursive: true, force: true }); }
});

test('step 55: missed nights are caught up from the mark; a dump before a redeploy and the next night write one day file without gaps', () => {
  const w = world();
  try {
    w.run('2026-07-02T00:20:00Z');
    // Три ночи сервер был выключен — первый заход после них догоняет 07-02, 07-03, 07-04
    w.run('2026-07-05T00:20:00Z');
    assert.deepEqual(readdirSync(w.hot).filter((f) => f.endsWith('.log.gz')).sort(), ['2026-07-01.log.gz', '2026-07-02.log.gz', '2026-07-03.log.gz', '2026-07-04.log.gz']);
    // Выкладка в 13:45: журнал контейнера сейчас исчезнет — выгружается день по этот момент; ночью — остаток суток
    w.run('2026-07-05T13:45:00Z', '--until-now');
    w.run('2026-07-06T00:20:00Z');
    assert.deepEqual(w.lines(join(w.hot, '2026-07-05.log.gz')), [
      'repracer-production 2026-07-05T00:00:00Z .. 2026-07-05T13:45:00Z',
      'repracer-production 2026-07-05T13:45:00Z .. 2026-07-06T00:00:00Z',
    ], 'the day is covered once, in two segments, without a gap or an overlap');
    assert.equal(readFileSync(join(w.hot, '.until'), 'utf8'), '2026-07-06T00:00:00Z');
  } finally { rmSync(w.root, { recursive: true, force: true }); }
});

test('step 55: a project that fails does not stop the others; the failure is marked for the outside monitor and the run exits 1', () => {
  const w = world('repracer-missing repracer-production');
  try {
    assert.throws(() => w.run('2026-07-02T00:20:00Z'), (e: { status?: number; stderr?: string }) => e.status === 1 && /LOGS_ARCHIVE_FAILED/.test(String(e.stderr)));
    assert.deepEqual(readdirSync(w.hot).filter((f) => f.endsWith('.log.gz')), ['2026-07-01.log.gz'], 'the healthy project was archived');
    assert.equal(existsSync(join(w.root, 'hot', 'LOGS_ARCHIVE_FAILED')), true);
    assert.equal(existsSync(join(w.root, 'hot', 'repracer-missing', '.until')), false, 'the failed project keeps no mark — it is retried from the same place');
  } finally { rmSync(w.root, { recursive: true, force: true }); }
});

test('step 54: month archives are kept at least 12 months; an archive already built is never rebuilt from a partial set of days', () => {
  const w = world();
  try {
    mkdirSync(w.months, { recursive: true });
    for (const m of ['2025-05', '2025-06', '2025-07']) writeFileSync(join(w.months, `${m}.log.gz`), 'old');
    mkdirSync(w.hot, { recursive: true });
    writeFileSync(join(w.months, '2026-06.log.gz'), 'built from the full set');
    writeFileSync(join(w.hot, '2026-06-30.log.gz'), 'leftover');
    writeFileSync(join(w.hot, '.until'), '2026-08-15T00:00:00Z');
    w.run('2026-08-15T00:20:00Z');
    const kept = readdirSync(w.months).filter((f) => f.endsWith('.log.gz')).sort();
    assert.deepEqual(kept, ['2025-07.log.gz', '2026-06.log.gz'], '2026-08 minus 13 months = 2025-07 is kept; older months are gone');
    assert.equal(readFileSync(join(w.months, '2026-06.log.gz'), 'utf8'), 'built from the full set', 'the archive was not rebuilt from the leftover');
    assert.equal(existsSync(join(w.hot, '2026-06-30.log.gz')), false, 'the leftover day is removed');
  } finally { rmSync(w.root, { recursive: true, force: true }); }
});

test('step 54, 55: a malformed time or argument is refused before any file is touched', () => {
  const w = world();
  try {
    assert.throws(() => w.run('yesterday'), /status 2|LOGS_ARCHIVE_BAD_NOW/);
    assert.throws(() => w.run('2026-07-02T00:20:00Z', '--until-tomorrow'), /status 2|LOGS_ARCHIVE_BAD_ARGUMENT/);
    assert.equal(existsSync(join(w.root, 'hot')), false);
  } finally { rmSync(w.root, { recursive: true, force: true }); }
});
