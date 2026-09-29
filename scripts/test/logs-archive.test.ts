import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Шаг 54 (OWASP A09): журналы ≥ 12 месяцев — горячий хвост сутками, дальше месячные архивы. Проверяется ТОТ ЖЕ скрипт, что запускает
 * таймер на сервере; вместо docker — подставная команда, печатающая строки своих суток. Утверждается наблюдаемое: что лежит на диске
 */
const SCRIPT = join(import.meta.dirname, '..', '..', 'deploy', 'production', 'logs-archive.sh');

function world() {
  const root = mkdtempSync(join(tmpdir(), 'logs-archive-'));
  const fake = join(root, 'docker');
  // docker compose -p P logs --no-color --timestamps --since DAYT00:00:00Z --until …
  writeFileSync(fake, '#!/bin/bash\nfor i in 1 2; do echo "$3 ${8%%T*} line $i"; done\n');
  chmodSync(fake, 0o755);
  const env = { ...process.env, REPRACER_LOGS_HOT_DIR: join(root, 'hot'), REPRACER_ARCHIVE_DIR: join(root, 'archive'), REPRACER_LOG_PROJECTS: 'repracer-production', REPRACER_DOCKER: fake };
  const run = (day: string) => execFileSync('bash', [SCRIPT, day], { env, encoding: 'utf8' });
  return { root, run, hot: join(root, 'hot', 'repracer-production'), months: join(root, 'archive', 'platform=logs', 'repracer-production') };
}

const days = (from: string, to: string): string[] => {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
};

test('step 54: a day of logs becomes a compressed hot file; a month that has left the 30-day window becomes one archive with its checksum', () => {
  const w = world();
  try {
    for (const d of days('2026-07-01', '2026-08-31')) w.run(d);
    const hot = readdirSync(w.hot).sort();
    assert.deepEqual([hot[0], hot[hot.length - 1], hot.length], ['2026-08-01.log.gz', '2026-08-31.log.gz', 31], 'August is still inside the hot window (cutoff 2026-08-01)');
    assert.deepEqual(readdirSync(w.months).sort(), ['2026-07.log.gz', '2026-07.log.gz.sha256'], 'July is one month archive');
    const july = gunzipSync(readFileSync(join(w.months, '2026-07.log.gz'))).toString('utf8').trim().split('\n');
    assert.equal(july.length, 62, 'every line of all 31 July days, two per day');
    assert.deepEqual([july[0], july[61]], ['repracer-production 2026-07-01 line 1', 'repracer-production 2026-07-31 line 2'], 'in day order');
    const sum = createHash('sha256').update(readFileSync(join(w.months, '2026-07.log.gz'))).digest('hex');
    assert.equal(readFileSync(join(w.months, '2026-07.log.gz.sha256'), 'utf8').trim(), sum);
  } finally { rmSync(w.root, { recursive: true, force: true }); }
});

test('step 54: month archives are kept at least 12 months; an archive already built is never rebuilt from a partial set of days', () => {
  const w = world();
  try {
    mkdirSync(w.months, { recursive: true });
    for (const m of ['2025-05', '2025-06', '2025-07']) writeFileSync(join(w.months, `${m}.log.gz`), 'old');
    // Сборка месяца прервалась после архива и до удаления суток: архив полный, в горячем каталоге остаток суток
    mkdirSync(w.hot, { recursive: true });
    writeFileSync(join(w.months, '2026-06.log.gz'), 'built from the full set');
    writeFileSync(join(w.hot, '2026-06-30.log.gz'), 'leftover');
    w.run('2026-08-15');
    const kept = readdirSync(w.months).filter((f) => f.endsWith('.log.gz')).sort();
    assert.deepEqual(kept, ['2025-07.log.gz', '2026-06.log.gz'], '2026-08 minus 13 months = 2025-07 is kept; older months are gone');
    assert.equal(readFileSync(join(w.months, '2026-06.log.gz'), 'utf8'), 'built from the full set', 'the archive was not rebuilt from the leftover');
    assert.equal(existsSync(join(w.hot, '2026-06-30.log.gz')), false, 'the leftover day is removed');
  } finally { rmSync(w.root, { recursive: true, force: true }); }
});

test('step 54: a malformed day is refused before any file is touched', () => {
  const w = world();
  try {
    assert.throws(() => w.run('yesterday'), /LOGS_ARCHIVE_BAD_DAY|status 2/);
    assert.equal(existsSync(w.hot), false);
  } finally { rmSync(w.root, { recursive: true, force: true }); }
});
