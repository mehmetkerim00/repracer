// Шаг 28, D: конфигурация каждого развёртывания разбирается ровно тем окружением, которое даёт его compose вместе с надстройкой CI,
// и ровно тем набором файлов секретов, который создаёт scripts/deploy-smoke.sh. Проверка идёт ДО поднятия контейнеров: расхождение
// «compose требует файл, а проверка его не кладёт» видно сразу и без образов. Первые два прогона задачи D упали именно на этом.
// Данные синтетические.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const [secrets] = process.argv.slice(2);
const stacks = [
  ['scheduler', 'deploy/scheduler/compose.yaml', 'deploy/ci/scheduler.override.yaml', 'scheduler', '../services/scheduler/src/config.ts', 'loadConfig',
    { REPRACER_CH_URL: 'http://host.docker.internal:18123', REPRACER_CH_INGEST_USER: 'u', REPRACER_CH_VERIFIER_USER: 'v' }],
  ['worker', 'deploy/worker/compose.yaml', 'deploy/ci/worker.override.yaml', 'worker', '../services/pricing-worker/src/config.ts', 'loadWorkerConfig',
    { REPRACER_KAFKA_BROKERS: 'host.docker.internal:19092' }],
  ['receiver', 'deploy/notification-receiver/compose.yaml', 'deploy/ci/receiver.override.yaml', 'receiver', '../services/notification-receiver/src/config.ts', 'loadReceiverConfig',
    { REPRACER_AMAZON_REGION: 'EU', REPRACER_AMAZON_APPLICATION_ID: 'amzn1.sellerapps.app.00000000-0000-0000-0000-000000000000' }],
  // Шаг 37 [Р-159]: консоль — такое же развёртывание, и её конфигурация проверяется тем же способом и до подъёма
  ['console', 'deploy/production/compose.yaml', 'deploy/ci/production.override.yaml', 'console', '../apps/console/server/config.ts', 'loadConsoleConfig',
    { REPRACER_DOMAIN: 'localhost', REPRACER_ACME_EMAIL: 'ci@example.invalid', REPRACER_BACKUP_DIR: '/tmp/repracer-backups' }],
];
let failed = false;
/**
 * Шаг 37 (находка 2 ревью): конфигурация разбирается ДВАЖДЫ — с надстройкой CI и БЕЗ неё. Надстройка чинит то, чего у
 * проекта нет (выключает внешнюю отметку, показывает базу раннера), и проверка, знающая только её, слепа ровно к тому,
 * что чинит надстройка: развёртывание, не стартующее «как есть», оставалось зелёным.
 */
for (const [name, compose, override, service, mod, fn, extra] of stacks) {
  const env = { REPRACER_SECRETS_DIR: secrets, REPRACER_AMAZON_APPLICATION_CREDENTIALS_REF: 'secret-ref:amazon-application',
    REPRACER_KAUFLAND_FALLBACK_EMAIL: 'ops@example.invalid', ...extra };
  const loader = (await import(mod))[fn];
  for (const [what, files] of [['с надстройкой CI', ['-f', compose, '-f', override]], ['как есть, без надстройки CI', ['-f', compose]]]) {
    const out = execFileSync('docker', ['compose', ...files, 'config', '--format', 'json'], { env: { ...process.env, ...env }, encoding: 'utf8' });
    const resolved = JSON.parse(out).services[service].environment ?? {};
    const containerEnv = Object.fromEntries(Object.entries(resolved).map(([k, v]) => [k, String(v)]));
    try {
      loader(containerEnv, (p) => readFileSync(p.replace('/run/secrets', secrets), 'utf8'));
      console.log(`${name} (${what}): конфигурация разобрана`);
    } catch (e) {
      console.error(`${name} (${what}): ОТКАЗ — ${e.message}`);
      failed = true;
    }
  }
}
if (failed) {
  console.error('DEPLOY CONFIG RED: развёртывание требует того, чего проверка не даёт');
  process.exit(1);
}
