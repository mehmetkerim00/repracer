import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { MemorySeedScope } from '@repracer/pricing-pipeline';
import { PgStockStore, seedPricingWorld, type SeededPricingWorld } from '../src/index.ts';
import { startModelIdentityProvider, type ModelIdentityProvider } from '../../identity/src/test-provider.ts';
import { createIsolatedDatabase, requireEnv, type IsolatedDatabase } from './isolated-db.ts';

/**
 * Шаг 65, часть 2: УЧЕНИЕ ВОССТАНОВЛЕНИЯ — то, что написано в docs/runbook-disaster.md, исполненное целиком:
 *  1) суточная работа снимает зашифрованную копию (`deploy/production/backup-loop.sh`, тот же скрипт, одна итерация);
 *  2) рядом — месячный архив журналов с суммой (как его пишет `logs-archive.sh`), и в нём одно удаление eBay;
 *  3) база ГИБНЕТ (DROP DATABASE) — с этого момента считается время: «есть файлы копии»;
 *  4) восстановление скриптом runbook (`deploy/production/restore.sh`) на чистое место: суммы, расшифровка закрытым ключом, роли,
 *     `pg_restore --create`, секции, регион базы, проверка архивов журналов;
 *  5) настоящий процесс консоли поднимается на восстановленной базе — время до первого 200 на `/healthz`: «консоль отвечает».
 * Затем — что восстановленная база цела: числа сверяются с исходной, защиты схемы отказывают своими причинами, у таблиц тенанта действует
 * FORCE RLS, версии записей и номера outbox без пропусков, а регион базы на месте — тенант заводится (без региона — отказ любого
 * клиентского тенанта: README до шага 65 восстанавливал без `--create` и регион терял). Данные синтетические.
 */
const TENANT = '10000000-0000-4000-8000-000000006501';
const ACCOUNT = '20000000-0000-4000-8000-000000006501';
const scope = (n: number): MemorySeedScope => ({
  writeScopeId: `ws-${n}`, productId: `prod-${n}`, channelAccountId: ACCOUNT, marketplace: 'de', externalUnitId: String(6500 + n),
  externalOfferId: `SYN-OFFER-65${n}`, channelProductRef: `65065${n}`, condition: 'new', currency: 'EUR', basis: 'GROSS',
  pricingMode: 'OFF', strategy: null, currentPriceMinor: 1900,
});
const ROOT = join(import.meta.dirname, '..', '..', '..');

let db: IsolatedDatabase;
let world: SeededPricingWorld;
let dir = '';
let consoleProc: ChildProcess | null = null;
/** Роль входа учения: у её строки подключения в секретах есть пароль — шаг паролей скрипта обязан его поставить (ревью шага 65, находка 1) */
const DRILL_ROLE = `repracer_drill_${process.pid}`;
let provider: ModelIdentityProvider | null = null;
const psqlEnv = () => ({ ...process.env, PGHOST: process.env.PGHOST ?? '127.0.0.1', PGPORT: process.env.PGPORT ?? '5432', PGUSER: process.env.PGUSER ?? 'postgres' });
const superUrl = (name: string) => { const u = new URL(requireEnv('REPRACER_PG_ADMIN_URL')); u.pathname = `/${name}`; return u.toString(); };
const sql = (dbName: string, text: string) => execFileSync('psql', ['-X', '-d', superUrl(dbName), '-Atc', text], { env: psqlEnv(), encoding: 'utf8' }).trim();
const freePort = async () => {
  const probe = createNetServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
};

/** Что обязано пережить восстановление — числами исходной базы */
const FACTS: Array<[string, string]> = [
  ['предложения', `SELECT count(*) FROM tenant_data.offer_mapping`],
  ['единицы записи', `SELECT count(*) FROM tenant_data.write_scope`],
  ['записи (очередь и история)', `SELECT (SELECT count(*) FROM tenant_data.channel_write) + (SELECT count(*) FROM tenant_data.channel_write_history)`],
  ['события outbox', `SELECT count(*) FROM tenant_data.outbox_event`],
  ['движения остатка', `SELECT count(*) FROM tenant_data.stock_movement`],
  ['сумма остатка', `SELECT coalesce(sum(on_hand), 0) FROM tenant_data.stock_pool`],
  ['события аудита', `SELECT count(*) FROM audit.audit_event`],
  ['участники', `SELECT count(*) FROM tenant_data.membership`],
];

before(async () => {
  db = await createIsolatedDatabase('recovery');
  const admin = db.pool('svc_admin', 2);
  world = await seedPricingWorld(db.pool('svc_app', 2), {
    provisioningPool: db.pool('svc_provisioning', 1), adminPool: admin, fixtureTenantId: TENANT, fixtureChannelAccountId: ACCOUNT,
    marketplaces: ['de'], clock: new Date().toISOString(), seed: { scopes: [scope(1), scope(2), scope(3)] },
  });
  // Остаток с синхронизацией — чтобы в копии были записи количества и их события outbox, а не только справочники
  const stock = new PgStockStore({ adminPool: admin, stockPool: db.pool('svc_stock', 1) });
  const actor = { membershipId: world.ownerMembershipId, userId: world.userId, mfa: true };
  const source = await stock.createStockSource(world.tenantId, { mode: 'INTERNAL_POOL', name: 'Main warehouse' }, actor);
  const sourceId = (source as { stockSourceId: string }).stockSourceId;
  await stock.importStock(world.tenantId, sourceId, [{ sku: '6501', quantity: 12 }, { sku: '6502', quantity: 5 }, { sku: '6503', quantity: 9 }], actor);
  await stock.answerOtherTools(world.tenantId, world.channelAccountId, 'NONE', actor);
  await stock.confirmQuantityWrites(world.tenantId, world.channelAccountId, (await stock.quantityWritesState(world.tenantId, world.channelAccountId))!.externalAccountId, actor);
  await stock.enableStockSync(world.tenantId, world.channelAccountId, { bufferUnits: 1, maxQuantity: null, minQuantityToList: 0, acknowledgeSideEffects: false }, actor);
  await stock.recalculate(world.tenantId, null, new Date().toISOString() as never);
  dir = mkdtempSync(join(tmpdir(), 'repracer-recovery-'));
  // Роль кластера — до копии: она попадает в копию ролей, а пароль ей ставит восстановление из секретов
  execFileSync('psql', ['-X', '-d', superUrl('postgres'), '-c', `DROP ROLE IF EXISTS ${DRILL_ROLE}`, '-c', `CREATE ROLE ${DRILL_ROLE} LOGIN`], { env: psqlEnv(), stdio: 'pipe' });
});

after(async () => {
  if (consoleProc && consoleProc.exitCode === null) {
    const exited = new Promise<void>((resolve) => consoleProc!.once('exit', () => resolve()));
    consoleProc.kill('SIGKILL');
    await exited;
  }
  await provider?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  await db?.drop();
  execFileSync('psql', ['-X', '-d', superUrl('postgres'), '-c', `DROP ROLE IF EXISTS ${DRILL_ROLE}`], { env: psqlEnv(), stdio: 'pipe' });
});

test('шаг 65: учение восстановления — зашифрованная копия, гибель базы, восстановление скриптом runbook, консоль отвечает', { timeout: 10 * 60_000 }, async () => {
  // Пара ключей владельца: на сервер уходит только открытый; закрытый нужен ТОЛЬКО при восстановлении
  const ownerHome = join(dir, 'owner-gnupg');
  mkdirSync(ownerHome, { recursive: true, mode: 0o700 });
  const gpg = (args: string[]) => execFileSync('gpg', ['--homedir', ownerHome, '--batch', '--no-tty', '--pinentry-mode', 'loopback', '--passphrase', '', ...args], { stdio: 'pipe' });
  gpg(['--quick-gen-key', 'repracer recovery drill <recovery@example.invalid>', 'default', 'default', 'never']);
  const publicKey = join(dir, 'backup_public_key.asc');
  writeFileSync(publicKey, gpg(['--armor', '--export', 'recovery@example.invalid']));

  // 1) копия — суточной работой профиля
  const backups = join(dir, 'backups');
  mkdirSync(backups, { recursive: true });
  const urlFile = join(dir, 'backup_pg_url');
  writeFileSync(urlFile, superUrl(db.name));
  execFileSync('bash', [join(ROOT, 'deploy', 'production', 'backup-loop.sh')],
    { env: { ...psqlEnv(), PGURL_FILE: urlFile, REPRACER_BACKUP_OUT: backups, REPRACER_BACKUP_PUBLIC_KEY_FILE: publicKey, REPRACER_BACKUP_ONCE: '1' }, stdio: 'pipe' });
  const stamp = readdirSync(backups).find((f) => f.endsWith('.dump.gpg'))!.replace('.dump.gpg', '');

  // 2) месячный архив журналов приёмника eBay — как его пишет logs-archive.sh: gzip и сумма рядом
  const logs = join(dir, 'archive', 'platform=logs', 'repracer-production');
  mkdirSync(logs, { recursive: true });
  /**
   * Строки журнала — как у `docker compose logs --timestamps`: удаление ДО копии повторять не нужно (оно в копии уже есть), удаление ПОСЛЕ —
   * нужно. Архив больше буфера канала (~600 КБ), а удаления — в начале: так проверка ловит ранний выход grep при pipefail (ревью шага 65, находка 5)
   */
  const beforeCopy = new Date(Date.now() - 86_400_000).toISOString();
  const later = new Date(Date.now() + 3_600_000).toISOString();
  const archive = gzipSync(Buffer.from([
    `ebay-account-deletion-1  | ${beforeCopy} {"level":"INFO","code":"EBAY_DELETION_APPLIED","details":{"accounts":1,"accountIds":"20000000-0000-4000-8000-000000006500"}}`,
    `ebay-account-deletion-1  | ${later} {"level":"INFO","code":"EBAY_DELETION_APPLIED","details":{"accounts":1,"accountIds":"20000000-0000-4000-8000-000000006501"}}`,
    ...Array.from({ length: 12_000 }, (_, i) => `console-1  | ${later} {"level":"INFO","code":"CONSOLE_REQUEST","n":${i},"pad":"${'x'.repeat(16)}"}`),
  ].join('\n') + '\n'));
  writeFileSync(join(logs, '2026-09.log.gz'), archive);
  writeFileSync(join(logs, '2026-09.log.gz.sha256'), `${createHash('sha256').update(archive).digest('hex')}\n`);

  // Секреты — строки подключения ролей; пароли кластера прогона не трогаются (у ролей стенда их нет — скрипт пропускает)
  const secrets = join(dir, 'secrets');
  mkdirSync(secrets, { recursive: true });
  writeFileSync(join(secrets, 'console_app_pg_url'), db.url('svc_app'));
  // Пароль с символом, закодированным процентами (%40 — «@»): скрипт раскодирует его до передачи в psql
  const drillUrl = new URL(db.url('svc_app')); drillUrl.username = DRILL_ROLE; drillUrl.password = 'syn-drill%40pass';
  writeFileSync(join(secrets, 'drill_pg_url'), drillUrl.toString());

  const before = Object.fromEntries(FACTS.map(([what, q]) => [what, sql(db.name, q)]));
  for (const [what, value] of Object.entries(before)) assert.notEqual(value, '0', `${what}: в исходной базе они есть`);

  // 3) база гибнет. С этого момента — «есть файлы копии». Пулы посева закрываются заранее: их соединения база всё равно оборвёт
  await db.endPools();
  execFileSync('psql', ['-X', '-d', superUrl('postgres'), '-c', `DROP DATABASE ${db.name} WITH (FORCE)`], { env: psqlEnv(), stdio: 'pipe' });
  const t0 = Date.now();

  // 4) восстановление скриптом runbook
  let restoredOut = '';
  try {
    restoredOut = execFileSync('bash', [join(ROOT, 'deploy', 'production', 'restore.sh'), backups, stamp], {
      env: { ...psqlEnv(), GNUPGHOME: ownerHome, REPRACER_RESTORE_ADMIN_URL: superUrl('postgres'), REPRACER_RESTORE_SECRETS_DIR: secrets,
        REPRACER_RESTORE_LOGS_DIR: join(dir, 'archive', 'platform=logs') },
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    assert.fail(`восстановление скриптом runbook не прошло: ${String((error as { stderr?: string }).stderr ?? error).slice(0, 800)}`);
  }
  const restoredAt = Date.now();
  const done = JSON.parse(restoredOut.trim().split('\n').at(-1)!) as { event: string; database: string; region: string; rolesWithPassword: number; logArchives: number; ebayDeletionsToRedo: number; stepsMs: Record<string, number>; warning?: string };
  assert.equal(done.event, 'RESTORE_DONE');
  assert.equal(done.database, db.name, 'база восстановлена под своим именем');
  assert.equal(done.region, 'EU', 'регион базы пережил восстановление (--create)');
  assert.deepEqual([done.logArchives, done.ebayDeletionsToRedo], [1, 1], 'архив журналов сверен; повторить — только удаление ПОСЛЕ копии');
  assert.ok(done.rolesWithPassword >= 1 && done.warning === undefined, `пароль роли поставлен из строки подключения: ${JSON.stringify(done)}`);
  assert.equal(sql('postgres', `SELECT rolpassword IS NOT NULL FROM pg_authid WHERE rolname = '${DRILL_ROLE}'`), 't', 'у роли входа учения есть пароль');

  // 5) консоль — настоящий процесс на восстановленной базе
  provider = await startModelIdentityProvider({ issuer: 'https://idp.recovery.example.invalid', clients: {} });
  const dist = join(dir, 'dist');
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>repracer</title>', 'utf8');
  const metricsPort = await freePort();
  const roles = ['app', 'admin', 'authenticator', 'onboarding', 'provisioning', 'dispatcher', 'stock', 'scheduler', 'exporter', 'fx_loader', 'bulk_worker'];
  consoleProc = spawn(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', join(ROOT, 'apps', 'console', 'server', 'console-service.ts')], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', REPRACER_MODE: 'stand', REPRACER_CONSOLE_PORT: String(await freePort()),
      REPRACER_CONSOLE_METRICS_PORT: String(metricsPort), REPRACER_CONSOLE_DIST: dist, REPRACER_CONSOLE_PUBLIC_DEMO: 'off', REPRACER_CONSOLE_HEARTBEAT: 'off',
      ...Object.fromEntries(roles.map((r) => [`REPRACER_CONSOLE_${r.toUpperCase()}_PG_URL`, db.url(`svc_${r}` as never)])),
      REPRACER_CONSOLE_OIDC_ISSUER: provider.issuer, REPRACER_CONSOLE_OIDC_AUDIENCE: 'repracer-console-recovery', REPRACER_CONSOLE_OIDC_JWKS_URL: provider.jwksUrl,
      REPRACER_CONSOLE_OIDC_CLIENT_ID: 'console-spa', REPRACER_CONSOLE_OIDC_DISCOVERY_BASE: provider.origin,
    },
  });
  const consoleLog: string[] = [];
  consoleProc.stdout?.on('data', (c: Buffer) => consoleLog.push(c.toString()));
  consoleProc.stderr?.on('data', (c: Buffer) => consoleLog.push(c.toString()));
  let answered = 0;
  for (let i = 0; i < 600 && answered === 0; i++) {
    if (consoleProc.exitCode !== null) assert.fail(`консоль упала на восстановленной базе: ${consoleLog.join('').slice(-600)}`);
    if (await fetch(`http://127.0.0.1:${metricsPort}/healthz`).then((r) => r.ok, () => false)) answered = Date.now();
    else await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(answered > 0, `консоль ответила /healthz: ${consoleLog.join('').slice(-400)}`);
  const timings = { restoreSeconds: (restoredAt - t0) / 1000, consoleSeconds: (answered - restoredAt) / 1000, totalSeconds: (answered - t0) / 1000, stepsMs: done.stepsMs,
    copyBytes: readdirSync(backups).filter((f) => f.endsWith('.gpg')).reduce((n, f) => n + statSync(join(backups, f)).size, 0) };
  console.log(JSON.stringify({ recoveryDrill: timings }));

  // Числа — те же, что в исходной базе
  for (const [what, q] of FACTS) assert.equal(sql(db.name, q), before[what], `${what}: столько же после восстановления`);
  // Защиты схемы отказывают своими причинами
  let refused = '';
  try {
    execFileSync('psql', ['-X', '-d', superUrl(db.name), '-v', 'ON_ERROR_STOP=1', '-c',
      `INSERT INTO tenant_data.alert (tenant_id, code, severity) VALUES ('${world.tenantId}', 'кириллица не код', 'WARNING')`], { env: psqlEnv(), stdio: 'pipe' });
  } catch (error) { refused = String((error as { stderr?: Buffer }).stderr ?? ''); }
  assert.match(refused, /alert_code_shape/, 'проверка значения столбца на месте');
  assert.equal(sql(db.name, `SELECT count(*) FROM pg_class WHERE relnamespace = 'tenant_data'::regnamespace AND relkind = 'r' AND NOT (relrowsecurity AND relforcerowsecurity)`), '0',
    'у каждой таблицы тенанта политика строк включена и действует на владельца');
  // Инварианты хаоса на восстановленной базе: версии 1…N, номера outbox без пропусков
  assert.equal(sql(db.name, `WITH v AS (SELECT tenant_id, write_scope_id, version FROM tenant_data.channel_write UNION ALL SELECT tenant_id, write_scope_id, version FROM tenant_data.channel_write_history)
      SELECT count(*) FROM (SELECT ss.write_scope_id FROM tenant_data.write_scope_sync_state ss LEFT JOIN v ON v.tenant_id = ss.tenant_id AND v.write_scope_id = ss.write_scope_id
       GROUP BY ss.write_scope_id, ss.latest_version_created HAVING count(DISTINCT v.version) <> ss.latest_version_created OR count(v.version) <> count(DISTINCT v.version)) x`), '0',
    'версии записей единиц — ровно 1…N');
  assert.equal(sql(db.name, `SELECT count(*) FROM (SELECT write_scope_id FROM tenant_data.outbox_event GROUP BY write_scope_id
      HAVING count(*) <> count(DISTINCT scope_seq) OR min(scope_seq) <> 1 OR max(scope_seq) <> count(*)) x`), '0', 'номера outbox единиц без пропусков');
  // Регион на месте — клиентский тенант заводится (страж региона отказал бы при потерянной настройке базы)
  execFileSync('psql', ['-X', '-d', db.url('svc_provisioning'), '-v', 'ON_ERROR_STOP=1', '-c',
    `SELECT security.provision_tenant('10000000-0000-4000-8000-000000006599', 'After restore', 'EU', '[{"membershipId": "a2000000-0000-4000-8000-000000006599", "userId": "a1000000-0000-4000-8000-000000006599", "email": "owner-restore@example.invalid", "role": "OWNER", "mfaEnabled": true}]'::jsonb)`],
    { env: psqlEnv(), stdio: 'pipe' });
  assert.ok(timings.totalSeconds < 300, `от файлов копии до ответа консоли — ${timings.totalSeconds} с`);
});
