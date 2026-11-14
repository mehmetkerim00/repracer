import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

/**
 * Шаг 124 [Р-246…Р-248]: развёртывание пилота разбирается ДО сервера. Сервера у пилота ещё нет (покупается при запуске), поэтому проверяется то, что
 * проверяемо без него: compose пилота с примером настроек и файлами, которые делает deploy/pilot/secrets.sh, разбирается, а каждый процесс — консоль,
 * планировщик, исполнитель заданий и панель — принимает получившееся окружение своим загрузчиком конфигурации (отказ старта — здесь, а не на сервере).
 * И свойства пилота: промышленный профиль, без публичного демо, без брокера и диспетчера, база с паролями, наружу — ничего, ссылка приглашения — оператору.
 *
 * Данные синтетические. Нужен Docker CLI с compose (разбор файлов идёт без демона).
 */
const root = new URL('../../', import.meta.url).pathname;
let work = '';
let secrets = '';
type Service = { environment?: Record<string, string | null>; ports?: unknown[]; image?: string };
let services: Record<string, Service> = {};

before(() => {
  work = mkdtempSync(join(tmpdir(), 'repracer-pilot-deploy-'));
  secrets = join(work, 'pilot');
  writeFileSync(join(work, 'amazon-production.env'),
    'AMAZON_PRODUCTION_APP_ID=amzn1.sp.solution.syn-pilot-app\nAMAZON_PRODUCTION_LWA_CLIENT_ID=amzn1.application-oa2-client.syn-pilot\nAMAZON_PRODUCTION_LWA_CLIENT_SECRET=syn-lwa-secret\n');
  const made = spawnSync('bash', [join(root, 'deploy/pilot/secrets.sh')], {
    env: { PATH: process.env.PATH ?? '', HOME: work, REPRACER_PILOT_LOCAL_SECRETS: secrets, REPRACER_AMAZON_PRODUCTION_ENV: join(work, 'amazon-production.env') }, encoding: 'utf8' });
  assert.equal(made.status, 0, `${made.stdout}${made.stderr}`);
  writeFileSync(join(secrets, 'tunnel.env'), 'TUNNEL_TOKEN=syn-tunnel-token\n');
  writeFileSync(join(work, 'build.env'), 'REPRACER_BUILD_SHA=0123456789abcdef0123456789abcdef01234567\nREPRACER_BUILD_AT=2026-11-14T12:00:00Z\n');
  const out = execFileSync('docker', ['compose', '-f', join(root, 'deploy/pilot/compose.yaml'), '--env-file', join(root, 'deploy/pilot/pilot.env.example'),
    '--env-file', join(secrets, 'amazon.env'), '--env-file', join(work, 'build.env'), '--profile', 'tools', 'config', '--format', 'json'],
  { env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? work, REPRACER_SECRETS_DIR: secrets }, encoding: 'utf8' });
  services = (JSON.parse(out) as { services: Record<string, Service> }).services;
});
after(() => { if (work) rmSync(work, { recursive: true, force: true }); });

const envOf = (name: string): Record<string, string> => Object.fromEntries(Object.entries(services[name]?.environment ?? {}).map(([k, v]) => [k, String(v ?? '')]));
const read = (path: string) => readFileSync(path.replace('/run/secrets', secrets), 'utf8');

test('step 124 [Р-248], step 126: the pilot is the console, scheduler, task worker, operator panel, PostgreSQL with its daily copy, ClickHouse and the tunnel — no broker, no write dispatcher', () => {
  // Шаг 126: копия базы (backup) — всегда; вынос в R2 (backup-offsite) — под профилем r2, здесь его нет (scripts/test/pilot-backup.test.ts)
  assert.deepEqual(Object.keys(services).sort(), ['backup', 'bulk-worker', 'clickhouse', 'cloudflared', 'console', 'operator', 'postgres', 'scheduler', 'tools']);
  // Наружу — ничего: базы без портов, процессы — только loopback (правило шага 54 смотрит и этот файл)
  assert.equal(services.postgres!.ports, undefined, 'the database publishes no port');
  assert.equal(services.clickhouse!.ports, undefined, 'ClickHouse publishes no port');
  assert.equal(envOf('postgres').POSTGRES_PASSWORD_FILE, '/run/secrets/postgres_password', 'the pilot database has passwords, not trust');
  assert.equal(envOf('postgres').POSTGRES_HOST_AUTH_METHOD, undefined);
});

test('step 124 [Р-245, Р-248]: the console is the production profile without the public demo; Amazon is wired; the operator gets the invitation link', () => {
  const console = envOf('console');
  assert.equal(console.REPRACER_PROFILE, 'production');
  assert.equal(console.REPRACER_CONSOLE_PUBLIC_DEMO, 'off');
  assert.equal(console.REPRACER_AMAZON_APP_ID, 'amzn1.sp.solution.syn-pilot-app', 'the app id comes from amazon.env of the pilot secrets');
  assert.equal(console.REPRACER_CONNECT_REDIRECT_URL, 'https://app.example.invalid/connect/callback');
  assert.equal(console.REPRACER_BUILD_SHA, '0123456789abcdef0123456789abcdef01234567');
  assert.equal(envOf('scheduler').REPRACER_CREDENTIALS_PG_URL_FILE, '/run/secrets/credentials_pg_url', 'the scheduler exchanges seller tokens with the adapters role');
  assert.equal(envOf('operator').REPRACER_INVITE_LINK_REVEAL, 'on');
  assert.equal(envOf('operator').REPRACER_PROFILE, 'production');
});

test('step 124 [Р-248]: every process of the pilot accepts its environment and the files of deploy/pilot/secrets.sh — a refusal shows here, not on the server', async () => {
  const { loadConsoleConfig } = await import('../../apps/console/server/config.ts');
  const { loadConfig } = await import('../../services/scheduler/src/config.ts');
  const { bulkWorkerFromEnv } = await import('../../apps/console/server/bulk-worker.ts');
  const { loadOperatorConfig } = await import('../../apps/operator/server/config.ts');
  const consoleConfig = loadConsoleConfig(envOf('console'), read) as unknown as { profile?: string };
  assert.ok(consoleConfig);
  const scheduler = loadConfig(envOf('scheduler'), read);
  assert.ok(scheduler.channelApps.amazon && scheduler.channelApps.keyring, 'the scheduler has the Amazon app and the token keyring');
  assert.equal(scheduler.channelApps.amazon.draft, true, 'the Draft state is named by pilot.env');
  assert.ok(bulkWorkerFromEnv(envOf('bulk-worker'), read).config);
  assert.equal(loadOperatorConfig(envOf('operator'), read).inviteLinkReveal, true);
});
