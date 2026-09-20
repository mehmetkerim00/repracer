#!/usr/bin/env node
/**
 * OQ-188, OQ-194 (шаг 33): завести во внешнем сервисе отметки для ТРЁХ процессов и положить их адреса в секреты
 * репозитория. Р-127: работоспособность процесса контролируется извне, потому что изнутри остановленный процесс о себе
 * не сообщает.
 *
 * Скрипт НИЧЕГО не хранит в репозитории: ключ читается из окружения, адреса отметок уходят в секреты GitHub через `gh`.
 * Печатается только идентификатор проверки — сам адрес отметки и есть секрет (кто его знает, тот может отметиться за
 * процесс, и молчание останется незамеченным).
 *
 * Использование:
 *   HC_API_KEY=<ключ проекта> node scripts/setup-heartbeats.mjs           # завести проверки и записать секреты
 *   HC_API_KEY=<ключ проекта> node scripts/setup-heartbeats.mjs --dry-run # показать, что будет сделано
 */
import { execFileSync } from 'node:child_process';

const API = 'https://healthchecks.io/api/v3';
const key = process.env.HC_API_KEY;
const dryRun = process.argv.includes('--dry-run');
if (!key) {
  console.error('HC_API_KEY не задан: ключ проекта healthchecks.io (Settings → API Access, права на запись)');
  process.exit(2);
}

/**
 * Период и допуск. Такт планировщика — 30 секунд, диспетчер и приёмник отмечаются не реже минуты: период 2 минуты с
 * допуском 3 минуты означает, что письмо придёт примерно через пять минут молчания. Это компромисс: короче — ложные
 * тревоги на медленном такте, длиннее — дольше не знаем об остановке.
 */
const CHECKS = [
  { slug: 'repracer-scheduler', name: 'repracer · планировщик', secret: 'HC_URL_SCHEDULER', desc: 'Периодические работы [Р-126]: опрос конкурентов, выгрузка суток, закрытие суток, удаление по сроку' },
  { slug: 'repracer-worker', name: 'repracer · диспетчер записей', secret: 'HC_URL_WORKER', desc: 'Путь решения за брокером: диспетчер записей и ретранслятор outbox [Р-64]' },
  { slug: 'repracer-receiver', name: 'repracer · приёмник уведомлений', secret: 'HC_URL_RECEIVER', desc: 'Приём уведомлений Amazon из SQS [Р-121]' },
];
const TIMEOUT_SECONDS = 120;
const GRACE_SECONDS = 180;

async function api(path, init = {}) {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: { 'X-Api-Key': key, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${path} → ${response.status} ${await response.text()}`);
  return response.json();
}

const created = [];
for (const check of CHECKS) {
  if (dryRun) { console.log(`создал бы проверку ${check.slug} (период ${TIMEOUT_SECONDS} с, допуск ${GRACE_SECONDS} с)`); continue; }
  /** `unique: ['slug']` делает скрипт повторяемым: второй запуск не плодит проверки, а находит заведённые */
  const body = { name: check.name, slug: check.slug, desc: check.desc, timeout: TIMEOUT_SECONDS, grace: GRACE_SECONDS, unique: ['slug'] };
  const result = await api('/checks/', { method: 'POST', body: JSON.stringify(body) });
  created.push({ ...check, pingUrl: result.ping_url });
  console.log(`проверка ${check.slug}: готова`);
}

if (dryRun) process.exit(0);

for (const { secret, pingUrl, slug } of created) {
  // Адрес отметки — секрет: он печатается ТОЛЬКО в секрет репозитория, не в вывод и не в файл
  execFileSync('gh', ['secret', 'set', secret, '--body', pingUrl], { stdio: ['ignore', 'ignore', 'inherit'] });
  console.log(`секрет ${secret} записан (проверка ${slug})`);
}

console.log('\nДальше — проверить живьём: остановить каждый процесс и дождаться письма (docs/evidence/step33-heartbeat-live.md).');
