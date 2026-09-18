import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigError, credentialsFromFiles, intFromEnv, jsonSink, ProcessHealth, requiredValue, secretFromEnv, serveHealth } from '../src/index.ts';

/** Общий слой процессов (OQ-190): проверяется поведение, на которое опираются развёртывания — секреты файлами, живость и метрики. */

test('OQ-190: a secret is read from a file, the value never appears in the error, a missing file is a configuration error', () => {
  const files: Record<string, string> = { '/run/secrets/app_pg_url': ' postgres://svc_app:s3cr3t@db/repracer\n' };
  const read = (p: string) => {
    const v = files[p];
    if (v === undefined) throw new Error(`no file ${p}`);
    return v;
  };
  assert.equal(secretFromEnv({ REPRACER_APP_PG_URL_FILE: '/run/secrets/app_pg_url' }, 'REPRACER_APP_PG_URL', read), 'postgres://svc_app:s3cr3t@db/repracer');
  assert.equal(secretFromEnv({ REPRACER_APP_PG_URL: 'postgres://plain' }, 'REPRACER_APP_PG_URL', read), 'postgres://plain');
  assert.equal(secretFromEnv({}, 'REPRACER_APP_PG_URL', read), null);
  try {
    secretFromEnv({ REPRACER_APP_PG_URL_FILE: '/run/secrets/missing' }, 'REPRACER_APP_PG_URL', read);
    assert.fail('an unreadable secret file must be a configuration error');
  } catch (error) {
    assert.match(String((error as Error).message), /^CONFIG_SECRET_UNREADABLE: REPRACER_APP_PG_URL_FILE$/);
    assert.equal(String((error as Error).message).includes('s3cr3t'), false, 'the secret is not in the message');
  }
  assert.throws(() => requiredValue(null, 'REPRACER_APP_PG_URL'), /CONFIG_MISSING: REPRACER_APP_PG_URL/);
  assert.throws(() => intFromEnv({ P: '0' }, 'P', 10, 1, 5), ConfigError);
  assert.equal(intFromEnv({}, 'P', 10, 1, 60), 10);
});

test('OQ-190: a credentials reference is a file name, not a path — traversal and substitution are refused', async () => {
  const dir = '/run/secrets/channels';
  const read = (p: string) => {
    if (p === `${dir}/secret-ref_amazon-application`) return JSON.stringify({ clientId: 'syn-client', clientSecret: 'syn-secret', number: 1 });
    throw new Error('no file');
  };
  const credentials = credentialsFromFiles(dir, read);
  assert.deepEqual(await credentials.get('secret-ref:amazon-application'), { clientId: 'syn-client', clientSecret: 'syn-secret' });
  for (const ref of ['../../etc/passwd', '/etc/passwd', 'ref with space', '']) {
    await assert.rejects(credentials.get(ref), /CREDENTIALS_REF_INVALID/, ref);
  }
  await assert.rejects(credentials.get('unknown-ref'), (e: Error) => /CREDENTIALS_UNREADABLE/.test(e.message) && !/channels/.test(e.message));
});

test('OQ-190: /healthz answers 503 when the loop of the process stopped stepping; metrics carry no tenant identifiers', async () => {
  let nowMs = 1_000_000;
  const health = new ProcessHealth(() => nowMs);
  health.alive();
  health.count('polls');
  health.count('received', 3);
  const server = await serveHealth(health, { port: 0, prefix: 'repracer_test', staleAfterMs: 60_000, host: '127.0.0.1' });
  try {
    const url = `http://127.0.0.1:${server.port}`;
    assert.equal((await fetch(`${url}/healthz`)).status, 200);
    const metrics = await (await fetch(`${url}/metrics`)).text();
    assert.match(metrics, /repracer_test_healthy 1/);
    assert.match(metrics, /repracer_test_events_total\{kind="received"\} 3/);
    assert.equal(/[0-9a-f]{8}-[0-9a-f]{4}-/.test(metrics), false, 'no identifiers in metrics');
    nowMs += 120_000;
    assert.equal((await fetch(`${url}/healthz`)).status, 503, 'a loop that stopped stepping is not healthy');
    assert.match(await (await fetch(`${url}/metrics`)).text(), /repracer_test_healthy 0/);
    assert.equal((await fetch(`${url}/nope`)).status, 404);
  } finally {
    await server.close();
  }
});

test('OQ-190: the log sink writes JSON lines without secrets and counts alerts by severity', async () => {
  const lines: string[] = [];
  const sink = jsonSink((l) => lines.push(l), () => '2026-09-18T10:00:00.000Z');
  sink.logger.log({ level: 'WARN', code: 'RECEIVER_LOOP_FAILED', message: 'RECEIVER_LOOP_FAILED', details: { attempt: 2 } });
  await sink.alerts.raise({ code: 'WRITE_DISPATCH_SWEEP_FAILED', severity: 'CRITICAL', details: { error: 'timeout' } });
  await sink.alerts.raise({ code: 'NOTIFICATION_SILENCE', severity: 'WARNING', details: { minutes: 30 } });
  assert.deepEqual(sink.raised, { warning: 1, critical: 1 });
  assert.deepEqual(JSON.parse(lines[0]!), { at: '2026-09-18T10:00:00.000Z', kind: 'log', level: 'WARN', code: 'RECEIVER_LOOP_FAILED', details: { attempt: 2 } });
  assert.deepEqual(JSON.parse(lines[1]!), { at: '2026-09-18T10:00:00.000Z', kind: 'alert', severity: 'CRITICAL', code: 'WRITE_DISPATCH_SWEEP_FAILED', tenantId: null, details: { error: 'timeout' } });
});
