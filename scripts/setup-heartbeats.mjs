#!/usr/bin/env node
/**
 * Р-127: работоспособность процесса контролируется извне — изнутри остановленный процесс о себе не сообщает. Скрипт заводит проверки во внешнем
 * сервисе (healthchecks.io) и кладёт их адреса туда, где их читают процессы. Два режима:
 *
 *   --stand <имя> (шаг 129) — проверки стенда deploy/pilot (пилот, QA-B): планировщик, консоль, панель, исполнитель заданий, копии базы и вынос
 *     копий. Адреса пишутся файлами 600: пять — в каталог секретов стенда на машине владельца (REPRACER_PILOT_LOCAL_SECRETS, по умолчанию
 *     $HOME/.config/repracer/secrets/<имя>), откуда их копирует на сервер deploy/pilot/push-secrets.sh; адрес выноса — рядом
 *     ($HOME/.config/repracer/secrets/<имя>-pull-heartbeat-url): его читает pull-backups.sh на машине оператора, серверу он не нужен.
 *   без --stand (шаг 33) — три процесса deploy/scheduler, deploy/worker, deploy/notification-receiver; адреса уходят в секреты GitHub через `gh`.
 *
 * Адрес отметки — секрет: кто его знает, тот отметится за процесс, и молчание останется незамеченным. Поэтому он не печатается и не передаётся
 * аргументом процесса. Печатаются только имена проверок.
 *
 * Факты API — снимок vendor/healthchecks/2026-09-17/SOURCE.md:
 *  - `unique: ['slug']` — документированный «upsert»: 201 при создании, 200 при обновлении, поэтому повторный запуск ничего не плодит;
 *  - `channels: '*'` — без него новая проверка не получает НИ ОДНОЙ интеграции, и пропуск отметки не даёт ни одного письма (находка шага 129).
 *
 * Использование:
 *   HC_API_KEY=<ключ проекта> node scripts/setup-heartbeats.mjs --stand pilot [--dry-run]
 *   HC_API_KEY=<ключ проекта> node scripts/setup-heartbeats.mjs [--dry-run]
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const API = process.env.HC_API_URL ?? 'https://healthchecks.io/api/v3';
const key = process.env.HC_API_KEY;
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const standAt = args.indexOf('--stand');
const stand = standAt >= 0 ? args[standAt + 1] ?? '' : null;
if (stand !== null && !/^[a-z][a-z0-9-]{0,30}$/.test(stand)) {
  console.error('--stand <имя>: строчные буквы, цифры и дефис, например pilot или qa-b');
  process.exit(2);
}
if (!key) {
  console.error('HC_API_KEY не задан: ключ проекта healthchecks.io (Settings → API Access, права на запись)');
  process.exit(2);
}

/**
 * Процессы отмечаются каждую минуту: период 2 минуты и допуск 3 минуты — письмо примерно через пять минут молчания. Копия снимается раз в сутки,
 * вынос идёт раз в сутки: период сутки и допуск 2 часа — письмо после 26 часов молчания. Это тот же предел, что у смоука (backup-state.sh).
 */
const PROCESS = { timeout: 120, grace: 180 };
const DAILY = { timeout: 86_400, grace: 7_200 };
const home = process.env.HOME ?? '';
const standSecrets = stand && (process.env.REPRACER_PILOT_LOCAL_SECRETS ?? join(home, '.config', 'repracer', 'secrets', stand));
const CHECKS = stand
  ? [
    { proc: 'scheduler', what: 'планировщик: обнаружение, опрос сводки, авторизации', ...PROCESS, file: join(standSecrets, 'scheduler_heartbeat_url') },
    { proc: 'console', what: 'консоль продавца', ...PROCESS, file: join(standSecrets, 'console_heartbeat_url') },
    { proc: 'operator', what: 'панель оператора', ...PROCESS, file: join(standSecrets, 'operator_heartbeat_url') },
    { proc: 'bulk-worker', what: 'исполнитель заданий тенантов', ...PROCESS, file: join(standSecrets, 'bulk_heartbeat_url') },
    { proc: 'backup', what: 'копия базы: отметка после каждой готовой копии, сбой — BACKUP_FAILED', ...DAILY, file: join(standSecrets, 'backup_heartbeat_url') },
    { proc: 'pull', what: 'вынос копий на машину оператора: отметка после каждого прохода pull-backups.sh', ...DAILY,
      file: process.env.REPRACER_PILOT_PULL_HEARTBEAT_URL_FILE ?? join(home, '.config', 'repracer', 'secrets', `${stand}-pull-heartbeat-url`) },
  ].map((c) => ({ ...c, slug: `repracer-${stand}-${c.proc}`, name: `repracer · ${stand} · ${c.proc}`, desc: c.what }))
  : [
    { slug: 'repracer-scheduler', name: 'repracer · планировщик', secret: 'HC_URL_SCHEDULER', desc: 'Периодические работы [Р-126]: опрос конкурентов, выгрузка суток, закрытие суток, удаление по сроку' },
    { slug: 'repracer-worker', name: 'repracer · диспетчер записей', secret: 'HC_URL_WORKER', desc: 'Путь решения за брокером: диспетчер записей и ретранслятор outbox [Р-64]' },
    { slug: 'repracer-receiver', name: 'repracer · приёмник уведомлений', secret: 'HC_URL_RECEIVER', desc: 'Приём уведомлений Amazon из SQS [Р-121]' },
  ].map((c) => ({ ...c, ...PROCESS }));

async function api(path, init = {}) {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: { 'X-Api-Key': key, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${path} → ${response.status} ${(await response.text()).slice(0, 200)}`);
  return response.json();
}

const created = [];
try {
  for (const check of CHECKS) {
    if (dryRun) { console.log(`завёл бы проверку ${check.slug} (период ${check.timeout} с, допуск ${check.grace} с)`); continue; }
    const body = { name: check.name, slug: check.slug, desc: check.desc, timeout: check.timeout, grace: check.grace, channels: '*', unique: ['slug'] };
    const result = await api('/checks/', { method: 'POST', body: JSON.stringify(body) });
    if (typeof result.ping_url !== 'string' || !result.ping_url.startsWith('https://')) throw new Error(`${check.slug}: в ответе нет адреса https`);
    created.push({ ...check, pingUrl: result.ping_url });
    console.log(`проверка ${check.slug}: готова`);
  }
} catch (error) {
  // Частичный итог называется вслух: иначе часть проверок заведена, а часть адресов не записана, и это незаметно
  console.error(`не удалось завести проверки: ${(error instanceof Error ? error.message : String(error)).slice(0, 300)}`);
  console.error(`заведено до отказа: ${created.map((c) => c.slug).join(', ') || 'ни одной'}; адреса НЕ записаны`);
  process.exit(1);
}

if (dryRun) process.exit(0);

for (const check of created) {
  if (stand) {
    mkdirSync(dirname(check.file), { recursive: true, mode: 0o700 });
    writeFileSync(check.file, `${check.pingUrl}\n`, { mode: 0o600 });
    chmodSync(check.file, 0o600);
    console.log(`адрес ${check.slug} записан в ${check.file}`);
  } else {
    // Адрес идёт в `gh` ЧЕРЕЗ stdin, а не аргументом: аргументы процесса видны в `ps` любому местному пользователю (находка 9 ревью шага 33)
    execFileSync('gh', ['secret', 'set', check.secret], { input: check.pingUrl, stdio: ['pipe', 'ignore', 'inherit'] });
    console.log(`секрет ${check.secret} записан (проверка ${check.slug})`);
  }
}

console.log(stand
  ? `\nДальше: deploy/pilot/push-secrets.sh deploy@<сервер> и выкладка. Проверить живьём — остановить процесс и дождаться письма (deploy/pilot/README.md, §9).`
  : '\nДальше — проверить живьём: остановить каждый процесс и дождаться письма (docs/evidence/step33-heartbeat-live.md).');
