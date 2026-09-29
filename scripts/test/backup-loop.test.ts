import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

/**
 * Шаг 57 (ревью шага 55, находка 12): bash исполняет ловушку сигнала только после выхода процесса переднего плана. Скрипт копии спал
 * `sleep` до суток переднего плана — SIGTERM `docker stop` ждал сна и кончался SIGKILL по сроку остановки, ловушка уборки не исполнялась.
 * Прогон ведёт ТОТ ЖЕ скрипт по пути провала (открытого ключа нет — копия проваливается без `pg_dump` и `gpg`) и будит его SIGTERM
 * посреди часового сна: выход — кодом ловушки 143, а не гибелью от запасного SIGKILL прогона. Данные синтетические, база не нужна.
 */
test('step 57: the backup loop answers SIGTERM during its sleep with its own trap, and removes parts a killed run left behind', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'repracer-backup-loop-'));
  try {
    const out = join(dir, 'out');
    const urlFile = join(dir, 'pg_url');
    writeFileSync(urlFile, 'postgres://syn-user@127.0.0.1:1/syn');
    // Недописанная часть прошлого процесса, убитого SIGKILL посреди конвейера
    const { mkdirSync } = await import('node:fs');
    mkdirSync(out);
    writeFileSync(join(out, 'repracer-20260101T000000Z.dump.gpg.part'), 'syn-partial');
    const child = spawn('bash', [new URL('../../deploy/production/backup-loop.sh', import.meta.url).pathname], {
      env: { PATH: process.env.PATH ?? '', PGURL_FILE: urlFile, REPRACER_BACKUP_OUT: out, REPRACER_BACKUP_PUBLIC_KEY_FILE: join(dir, 'absent.asc'),
        REPRACER_BACKUP_RETRY_SECONDS: '3600', REPRACER_BACKUP_EVERY_SECONDS: '86400' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    await new Promise<void>((resolve) => child.stderr.on('data', (d: Buffer) => { stderr += String(d); if (stderr.includes('BACKUP_FAILED')) resolve(); }));
    // Сигнал — ПОСРЕДИ сна: процесс `sleep` скрипта уже существует (иначе ловушка сработала бы после `find`, и старый скрипт прошёл бы тоже)
    const { execFileSync } = await import('node:child_process');
    const sleeping = () => { try { return execFileSync('pgrep', ['-P', String(child.pid), 'sleep'], { encoding: 'utf8' }).trim() !== ''; } catch { return false; } };
    for (let i = 0; i < 400 && !sleeping(); i++) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(sleeping(), 'the script sleeps until its retry');
    // Шаг 58: отметка провала — после сна (скрипт пишет строку алерта раньше файла отметки: проверка сразу по строке гонялась с ним, CI шага 57)
    assert.ok(existsSync(join(out, 'BACKUP_FAILED')), 'the failure mark is written');
    assert.deepEqual(readdirSync(out).filter((f) => f.endsWith('.part')), [], 'the part left by a killed run is removed at start');
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
    child.kill('SIGTERM');
    // Запасной SIGKILL — только чтобы прогон не висел час на сломанном скрипте; им закончиться прогон не должен
    const fallbackKill = setTimeout(() => child.kill('SIGKILL'), 20_000);
    const result = await exited;
    clearTimeout(fallbackKill);
    assert.deepEqual(result, { code: 143, signal: null }, 'SIGTERM during the sleep runs the trap at once (exit 143), not after the sleep');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
