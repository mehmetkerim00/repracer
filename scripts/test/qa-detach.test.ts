import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

/**
 * Шаг 121.3 (QA-A): долгая команда тестировщика переживает обрыв SSH. `deploy/qa/detach.sh <имя> <команда…>` ведёт работу в фоне
 * под журналом, одну за раз; вызов показывает журнал и выходит кодом работы. Обрыв соединения убивает только показ, повторный вызов
 * во время работы показывает её журнал и ждёт конца, а не запускает вторую. Сброс QA идёт этим путём (deploy/qa/reset.sh)
 */

const script = new URL('../../deploy/qa/detach.sh', import.meta.url).pathname;
let dir = '';
let state = '';

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'repracer-qa-detach-'));
  state = join(dir, 'state');
});
after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const run = (name: string, command: string[], extra: Record<string, string> = {}) => {
  const child = spawn('bash', [script, name, ...command], { env: { PATH: process.env.PATH ?? '', QA_STATE_DIR: state, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += String(d); });
  child.stderr.on('data', (d) => { out += String(d); });
  const done = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  return { child, done, out: () => out };
};
const until = async (what: () => boolean, ms = 20_000) => {
  const started = Date.now();
  while (!what() && Date.now() - started < ms) await new Promise((r) => setTimeout(r, 100));
  return what();
};

test('step 121.3: the work outlives its caller — a dropped connection kills only the log view', async () => {
  const marker = join(dir, 'survived');
  const a = run('job1', ['bash', '-c', `sleep 2; echo done > ${marker}`]);
  assert.ok(await until(() => /в фоне/.test(a.out()), 10_000), `the caller says the work runs in the background: ${a.out()}`);
  a.child.kill('SIGKILL');
  a.child.stdout.destroy();
  a.child.stderr.destroy();
  const status = join(state, 'job1.status');
  // Итог пишет работа в конце (после команды) — ждём именно его, а не метку команды
  assert.ok(await until(() => existsSync(status)), 'the work finished and left its exit status although its caller was killed');
  assert.ok(existsSync(marker), 'the command of the work ran to its end');
  assert.equal(readFileSync(status, 'utf8').trim(), '0', 'the work ended with exit code 0');
});

test('step 121.3: a second call while the work runs attaches to it instead of starting another', async () => {
  const counter = join(dir, 'runs');
  const a = run('job2', ['bash', '-c', `echo run >> ${counter}; sleep 2; echo finished`]);
  assert.ok(await until(() => /в фоне/.test(a.out()), 10_000), a.out());
  const b = run('job2', ['bash', '-c', `echo run >> ${counter}; sleep 2; echo finished`]);
  const [codeA, codeB] = await Promise.all([a.done, b.done]);
  assert.equal(readFileSync(counter, 'utf8').trim().split('\n').length, 1, 'the work ran exactly once');
  assert.match(b.out(), /уже идёт/, `the second call says the work is already running: ${b.out()}`);
  assert.match(b.out(), /finished/, 'the second call shows the log of the running work to its end');
  assert.deepEqual([codeA, codeB], [0, 0], 'both calls end with the exit code of the work');
});

test('step 121.3: the caller ends with the exit code of the work', async () => {
  const a = run('job3', ['bash', '-c', 'echo failing; exit 7']);
  assert.equal(await a.done, 7, a.out());
});

/**
 * Шаг 121.4: показ журнала не молчит. Пока стенд поднимается, журнал минутами не растёт, и промежуточные звенья (NAT, VPN) режут «тихое»
 * соединение; пульс «идёт, N с» раз в интервал (30 с, в тесте — 1 с) держит его живым. Пульс — только в показе, журнал работы чист
 */
test('step 121.4: while the work is silent the caller prints a pulse with the seconds the work has run, and the log of the work stays clean', async () => {
  const a = run('job5', ['bash', '-c', 'echo started; sleep 4; echo finished'], { QA_DETACH_PULSE_SECONDS: '1' });
  assert.equal(await a.done, 0, a.out());
  const pulses = [...a.out().matchAll(/== job5: идёт, (\d+) с/g)].map((m) => Number(m[1]));
  assert.ok(pulses.length >= 2, `the caller printed a pulse at least twice during 4 silent seconds: ${a.out()}`);
  assert.ok(pulses.every((n, i) => i === 0 || n > pulses[i - 1]!), `the seconds grow from pulse to pulse: ${pulses.join(', ')}`);
  assert.doesNotMatch(readFileSync(join(state, 'job5.log'), 'utf8'), /идёт, \d+ с/, 'the pulse is not written into the log of the work');
});

test('step 121.3: a lock left by a killed work does not block the next run', async () => {
  mkdirSync(join(state, 'job4.lock'), { recursive: true });
  writeFileSync(join(state, 'job4.lock', 'pid'), '999999');
  const marker = join(dir, 'after-stale');
  const a = run('job4', ['bash', '-c', `echo ok > ${marker}`]);
  assert.equal(await a.done, 0, a.out());
  assert.ok(existsSync(marker), 'the new run went ahead');
  assert.match(a.out(), /оборвалась/, `the caller names the dead previous work: ${a.out()}`);
});
