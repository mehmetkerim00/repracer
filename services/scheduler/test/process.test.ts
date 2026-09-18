import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { loadConfig, ConfigError } from '../src/config.ts';
import { createHeartbeat } from '../src/heartbeat.ts';
import { SchedulerMetrics, serveMetrics } from '../src/metrics.ts';
import { credentialsFromFiles, jsonSink } from '../src/runtime.ts';
import type { TickReport } from '../src/scheduler.ts';

/**
 * Р-127, Р-129 (шаг 26): конфигурация, метрики, проверка работоспособности и отметка во внешнем сервисе. Данные синтетические;
 * внешний сервис — модель «dead man's switch» по его документации (vendor/healthchecks/2026-09-17/SOURCE.md).
 */
// Шаг 28, E: секреты приходят файлами; окружение теста — режим стенда, где значения переменных ещё принимаются
const ENV = {
  REPRACER_MODE: 'stand',
  REPRACER_SCHEDULER_PG_URL: 'postgres://svc_scheduler@db/repracer_eu',
  REPRACER_APP_PG_URL: 'postgres://svc_app@db/repracer_eu',
  REPRACER_EXPORTER_PG_URL: 'postgres://svc_exporter@db/repracer_eu',
  REPRACER_CH_URL: 'http://clickhouse:8123',
  REPRACER_CH_INGEST_USER: 'ingest', REPRACER_CH_INGEST_PASSWORD: 'syn-ingest',
  REPRACER_CH_VERIFIER_USER: 'verifier', REPRACER_CH_VERIFIER_PASSWORD: 'syn-verifier',
  REPRACER_CHANNEL_SECRETS_DIR: '/run/secrets/channels',
  REPRACER_KAUFLAND_FALLBACK_EMAIL: 'ops@example.invalid',
  REPRACER_AMAZON_APPLICATION_CREDENTIALS_REF: 'secret-ref:amazon-application',
  REPRACER_SCHEDULER_HEARTBEAT_URL: 'https://hc-ping.com/00000000-0000-4000-8000-000000000000',
};

test('Р-129: конфигурация процесса — секреты из файлов, обязательное названо, значения секретов в ошибки не попадают', () => {
  const files: Record<string, string> = { '/run/secrets/heartbeat_url': 'https://hc-ping.com/11111111-1111-4111-8111-111111111111\n' };
  const config = loadConfig({ ...ENV, REPRACER_SCHEDULER_HEARTBEAT_URL: undefined, REPRACER_SCHEDULER_HEARTBEAT_URL_FILE: '/run/secrets/heartbeat_url' }, (p) => files[p] ?? (() => { throw new Error('ENOENT'); })());
  assert.equal(config.heartbeatUrl, 'https://hc-ping.com/11111111-1111-4111-8111-111111111111');
  assert.equal(config.tickMs, 30_000);
  // Без внешней отметки процесс не стартует: работоспособность должен видеть кто-то снаружи (Р-127)
  assert.throws(() => loadConfig({ ...ENV, REPRACER_SCHEDULER_HEARTBEAT_URL: undefined }), (e: Error) => e instanceof ConfigError && /REPRACER_SCHEDULER_HEARTBEAT_URL/.test(e.message));
  assert.equal(loadConfig({ ...ENV, REPRACER_SCHEDULER_HEARTBEAT_URL: undefined, REPRACER_SCHEDULER_HEARTBEAT: 'off' }).heartbeatUrl, null);
  assert.throws(() => loadConfig({ ...ENV, REPRACER_SCHEDULER_HEARTBEAT_URL: 'http://hc-ping.com/x' }), /must be https/);
  assert.throws(() => loadConfig({ ...ENV, REPRACER_SCHEDULER_TICK_MS: '0' }), /REPRACER_SCHEDULER_TICK_MS/);
  // Нечитаемый файл секрета: в ошибке — имя переменной, не путь и не содержимое
  const thrown = (() => { try { loadConfig({ ...ENV, REPRACER_CH_INGEST_PASSWORD: undefined, REPRACER_CH_INGEST_PASSWORD_FILE: '/run/secrets/absent' }, () => { throw new Error('ENOENT: /run/secrets/absent'); }); return null; } catch (e) { return e as Error; } })();
  assert.equal(thrown?.message, 'CONFIG_SECRET_UNREADABLE: REPRACER_CH_INGEST_PASSWORD_FILE');
  // Шаг 28, E: вне режима стенда секрет значением переменной окружения не принимается — в работе он приходит только файлом
  const { REPRACER_MODE: _stand, ...production } = ENV;
  assert.throws(() => loadConfig(production), /CONFIG_SECRET_IN_ENV: REPRACER_SCHEDULER_HEARTBEAT_URL/);
});

test('Р-129: учётные данные канала — файл на ссылку; подстановка пути отклоняется, содержимое не попадает в ошибку', async () => {
  const store = credentialsFromFiles('/run/secrets/channels', (p) => {
    if (p === '/run/secrets/channels/secret-ref_kaufland-0001') return JSON.stringify({ clientKey: 'syn-key', secretKey: 'syn-secret' });
    throw new Error(`ENOENT ${p}`);
  });
  assert.deepEqual(await store.get('secret-ref:kaufland-0001'), { clientKey: 'syn-key', secretKey: 'syn-secret' });
  await assert.rejects(store.get('../../etc/passwd'), /CREDENTIALS_REF_INVALID/);
  await assert.rejects(store.get('secret-ref:absent'), (e: Error) => e.message === 'CREDENTIALS_UNREADABLE');
});

test('Р-129: журнал и алерты — строки JSON без секретов', async () => {
  const lines: string[] = [];
  const sink = jsonSink((l) => lines.push(l), () => '2026-09-18T00:00:00.000Z');
  sink.logger.log({ level: 'INFO', code: 'SCHEDULER_RUN', message: 'competitor-poll', details: { job: 'competitor-poll', items: 12 } });
  await sink.alerts.raise({ code: 'COMPETITOR_POLL_FAILURES', severity: 'WARNING', details: { due: 10, channelFailures: 3 } });
  assert.deepEqual(lines.map((l) => JSON.parse(l).code), ['SCHEDULER_RUN', 'COMPETITOR_POLL_FAILURES']);
  assert.deepEqual(sink.raised, { warning: 1, critical: 0 });
});

const report = (runs: Array<{ jobName: string; outcome: 'SUCCEEDED' | 'FAILED'; items: number | null; lagSeconds: number }>): TickReport => ({
  now: '2026-09-18T00:00:00.000Z', lagging: [], skippedLeased: [], lostLeases: [], nextDueAt: '2026-09-18T00:00:30.000Z',
  runs: runs.map((r) => ({ jobKey: r.jobName, jobName: r.jobName, slotAt: '2026-09-18T00:00:00.000Z', owner: 'a', startedAt: '2026-09-18T00:00:00.000Z',
    finishedAt: '2026-09-18T00:00:01.000Z', outcome: r.outcome, lagSeconds: r.lagSeconds, items: r.items, errorCode: null })),
});

test('Р-129: метрики и проверка работоспособности — без идентификаторов тенантов', async () => {
  let ms = 1_700_000_000_000;
  const metrics = new SchedulerMetrics(() => ms);
  metrics.tick(true, report([{ jobName: 'competitor-poll', outcome: 'SUCCEEDED', items: 12, lagSeconds: 4 }, { jobName: 'retention', outcome: 'FAILED', items: null, lagSeconds: 0 }]));
  metrics.tick(false, null);
  const text = metrics.render();
  assert.match(text, /repracer_scheduler_ticks_total\{outcome="ok"\} 1/);
  assert.match(text, /repracer_scheduler_ticks_total\{outcome="failed"\} 1/);
  assert.match(text, /repracer_scheduler_job_runs_total\{job="competitor-poll",outcome="SUCCEEDED"\} 1/);
  assert.match(text, /repracer_scheduler_job_last_lag_seconds\{job="competitor-poll"\} 4/);
  assert.equal(/[0-9a-f]{8}-[0-9a-f]{4}-/.test(text), false, 'в метриках нет идентификаторов тенантов и аккаунтов');
  assert.equal(metrics.healthy(300_000), true);
  ms += 400_000;
  assert.equal(metrics.healthy(300_000), false, 'такт старше срока — контейнер нездоров');
  const server = await serveMetrics(metrics, { port: 0, host: '127.0.0.1', staleAfterMs: 300_000 });
  after(() => { server.close(); });
  const port = (server.address() as { port: number }).port;
  assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).status, 503);
  assert.match(await (await fetch(`http://127.0.0.1:${port}/metrics`)).text(), /repracer_scheduler_ticks_total/);
});

test('Р-127: отметка во внешнем сервисе — не чаще раза в минуту, смена состояния почти сразу, но не чаще 5 в минуту; провал отметки — исключение', async () => {
  let ms = 0;
  const calls: string[] = [];
  const beat = createHeartbeat({
    url: 'https://hc-ping.com/00000000-0000-4000-8000-000000000000', clockMs: () => ms, minIntervalMs: 60_000,
    fetch: (async (url: string) => { calls.push(String(url)); return new Response('OK', { status: calls.length > 3 ? 500 : 200 }); }) as never,
  });
  assert.equal(await beat.beat(true), 'SENT');
  ms += 30_000;
  assert.equal(await beat.beat(true), 'THROTTLED', 'сервис не записывает больше 5 отметок в минуту — лишние не шлём');
  assert.equal(await beat.beat(false), 'SENT', 'провал такта отмечается сразу');
  ms += 1_000;
  // Ревью шага 26, находка 11: «мигающий» планировщик не должен выбирать лимит сервиса (5 отметок в минуту) сменами состояния
  assert.equal(await beat.beat(true), 'THROTTLED', 'смена состояния чаще 12 с не шлётся: лимит сервиса');
  ms += 12_000;
  assert.equal(await beat.beat(true), 'SENT', 'возврат к норме — следующей отметкой');
  assert.deepEqual(calls, [
    'https://hc-ping.com/00000000-0000-4000-8000-000000000000',
    'https://hc-ping.com/00000000-0000-4000-8000-000000000000/fail',
    'https://hc-ping.com/00000000-0000-4000-8000-000000000000',
  ]);
  ms += 60_000;
  await assert.rejects(beat.beat(true), /HEARTBEAT_REJECTED: external monitor answered 500/);
  assert.throws(() => createHeartbeat({ url: 'http://hc-ping.com/x' }), /HEARTBEAT_URL_NOT_HTTPS/);
});

/**
 * Модель внешнего сервиса по его документации: период — ожидаемое время между отметками, допуск — дополнительное ожидание до тревоги;
 * при пропуске сервис шлёт уведомление (у нас — письмо владельцу). Модель нужна, чтобы проверить наш конец: пока процесс работает,
 * отметки идут; как только он остановлен — отметок нет, и тревогу поднимает сервис, а не сам процесс.
 */
class DeadMansSwitch {
  readonly emails: Array<{ atMs: number; subject: string }> = [];
  private lastPingMs: number | null = null;
  private down = false;

  private readonly periodMs: number;
  private readonly graceMs: number;
  private readonly to: string;

  constructor(periodMs: number, graceMs: number, to: string) {
    this.periodMs = periodMs;
    this.graceMs = graceMs;
    this.to = to;
  }

  ping(atMs: number): void {
    this.lastPingMs = atMs;
    this.down = false;
  }

  evaluate(nowMs: number): void {
    if (this.lastPingMs === null || this.down) return;
    if (nowMs - this.lastPingMs > this.periodMs + this.graceMs) {
      this.down = true;
      this.emails.push({ atMs: nowMs, subject: `repracer scheduler is DOWN (no ping from ${this.to})` });
    }
  }
}

test('Р-127: пока процесс работает, отметки идут; остановленный процесс о себе не сообщает — письмо шлёт внешний сервис', async () => {
  const { runScheduler } = await import('../src/process.ts');
  let ms = Date.parse('2026-09-18T00:00:00.000Z');
  const monitor = new DeadMansSwitch(120_000, 60_000, 'scheduler-eu-1');
  const beat = createHeartbeat({
    url: 'https://hc-ping.com/00000000-0000-4000-8000-000000000000', clockMs: () => ms, minIntervalMs: 60_000,
    fetch: (async (url: string) => { if (!String(url).endsWith('/fail')) monitor.ping(ms); return new Response('OK', { status: 200 }); }) as never,
  });
  let ticks = 0;
  const scheduler = { tick: async () => { ticks += 1; return report([]); } };
  const running = runScheduler(scheduler as never, {
    tickMs: 30_000, clockMs: () => ms, logger: { log: () => {} },
    sleep: async (pause) => { ms += pause; monitor.evaluate(ms); },
    shouldStop: () => ticks >= 40,
    onTick: async ({ ok }) => { await beat.beat(ok); },
  });
  await running.finished;
  assert.equal(monitor.emails.length, 0, 'пока процесс работает, писем нет');
  // Процесс остановлен: отметок больше нет — время идёт только у внешнего сервиса
  const stoppedAtMs = ms;
  for (let i = 0; i < 20; i++) { ms += 30_000; monitor.evaluate(ms); }
  assert.equal(monitor.emails.length, 1, 'внешний сервис прислал письмо владельцу');
  assert.ok(monitor.emails[0]!.atMs - stoppedAtMs <= 210_000, 'письмо — в пределах периода и допуска (2 + 1 минута)');
});

test('Риск 31: точка входа процесса берёт сроки из часов базы, а не из часов процесса', async () => {
  const { dueClockOf, tickIsHealthy } = await import('../src/main.ts');
  const calls: string[] = [];
  const clock = dueClockOf({ databaseNow: async () => { calls.push('database'); return '2026-09-18T00:00:00.000Z'; } } as never);
  const trueNow = Date.now;
  Date.now = () => Date.parse('2030-01-01T00:00:00.000Z');
  try {
    assert.equal(await clock(), '2026-09-18T00:00:00.000Z', 'срок берётся у базы, часы процесса не используются');
  } finally {
    Date.now = trueNow;
  }
  assert.deepEqual(calls, ['database']);
  // Ревью шага 26, находка 12: такт, в котором провалились ВСЕ работы, здоровым не считается
  const run = (outcome: string) => ({ outcome });
  assert.equal(tickIsHealthy(true, { runs: [run('SUCCEEDED'), run('FAILED')] }), true);
  assert.equal(tickIsHealthy(true, { runs: [run('FAILED'), run('FAILED')] }), false, 'все работы провалились — процесс не здоров');
  assert.equal(tickIsHealthy(true, { runs: [] }), true, 'такт без работ — норма');
  assert.equal(tickIsHealthy(false, null), false, 'такт не завершился — не здоров');
});
