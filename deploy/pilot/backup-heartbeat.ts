/**
 * Шаг 129 (решение владельца 2026-11-15, п. 3.1): отметка во внешнем сервисе после каждой копии базы пилота [Р-127].
 *
 * Копию снимает сервис `backup` (deploy/production/backup-loop.sh). В его образе (postgres) нет ни curl, ни wget (Dockerfile docker-library/postgres,
 * 16/bookworm: wget ставится на время загрузки gosu и удаляется). Поэтому отметку шлёт этот отдельный процесс. Он только читает каталог копий:
 *  - готовая копия — файл сумм `repracer-<время>.sha256` (backup-loop пишет его последним). Новая готовая копия — отметка «жив», одна на копию;
 *  - отметка провала `BACKUP_FAILED` (backup-loop держит её, пока копия не удалась) — отметка «сбой»; новая строка провала (следующая попытка
 *    тоже провалилась) — снова «сбой»;
 *  - копия, готовая раньше старта процесса больше чем на START_SLACK_MS, не отмечается: её отметил прежний процесс, а повторная отметка сдвинула бы
 *    срок внешней проверки и спрятала бы остановившуюся копию.
 * Внешняя проверка (scripts/setup-heartbeats.mjs: период сутки, допуск 2 часа) пишет письмо, если отметки «жив» нет 26 часов. Это и копия,
 * которая не снимается, и этот процесс, который умер, и сервер, который недоступен.
 * Адрес отметки — секрет, лежит файлом. В журнал не пишется: ошибки отметки называют только код ответа (packages/service-runtime/src/heartbeat.ts).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHeartbeat, type Heartbeat } from '../../packages/service-runtime/src/heartbeat.ts';

const STAMP = /^repracer-(\d{8}T\d{6}Z)\.sha256$/;
const FAILED_MARK = 'BACKUP_FAILED';
/** Копия, готовая раньше старта не больше чем на 10 минут, ещё отмечается: backup снимает первую копию при своём старте, рядом с этим процессом */
export const START_SLACK_MS = 10 * 60_000;

export interface BackupWatch {
  /** Последняя отмеченная копия */
  pinged: string | null;
  /** Строка отметки провала, о которой уже сообщено */
  failMark: string | null;
  startedAtMs: number;
}

export interface BackupHeartbeatConfig {
  dir: string;
  heartbeat: Heartbeat;
  nowMs: () => number;
  log: (line: Record<string, unknown>) => void;
}

export const newBackupWatch = (nowMs: number): BackupWatch => ({ pinged: null, failMark: null, startedAtMs: nowMs });

/** Один проход: что отмечено (`OK` — «жив», `FAIL` — «сбой») или null. Неудачная отметка состояние не сдвигает — следующий проход повторит */
export async function backupHeartbeatOnce(cfg: BackupHeartbeatConfig, watch: BackupWatch): Promise<'OK' | 'FAIL' | null> {
  const failedPath = join(cfg.dir, FAILED_MARK);
  let signal: 'OK' | 'FAIL' | null = null;
  let next: Partial<BackupWatch> = {};
  if (existsSync(failedPath)) {
    const mark = readFileSync(failedPath, 'utf8').trim();
    if (mark !== watch.failMark) { signal = 'FAIL'; next = { failMark: mark }; }
  } else {
    watch.failMark = null;
    const newest = readdirSync(cfg.dir).map((f) => STAMP.exec(f)?.[1]).filter((s): s is string => Boolean(s)).sort().at(-1) ?? null;
    if (newest && newest !== watch.pinged && statSync(join(cfg.dir, `repracer-${newest}.sha256`)).mtimeMs >= watch.startedAtMs - START_SLACK_MS) {
      signal = 'OK';
      next = { pinged: newest };
    }
  }
  if (!signal) return null;
  try {
    // Смена состояния чаще 12 с внешний сервис может не записать — отметка придержана, следующий проход повторит
    if ((await cfg.heartbeat.beat(signal === 'OK')) === 'THROTTLED') return null;
  } catch (error) {
    cfg.log({ level: 'WARN', code: 'BACKUP_HEARTBEAT_FAILED', signal, error: String((error as Error).message).slice(0, 120) });
    return null;
  }
  Object.assign(watch, next);
  cfg.log({ level: 'INFO', code: 'BACKUP_HEARTBEAT_SENT', signal, ...(next.pinged ? { copy: `repracer-${next.pinged}` } : {}) });
  return signal;
}

/** Процесс: проход сразу и затем каждые REPRACER_BACKUP_HEARTBEAT_EVERY_SECONDS (по умолчанию минута) */
async function main(): Promise<void> {
  const env = process.env;
  const file = env.REPRACER_BACKUP_HEARTBEAT_URL_FILE;
  if (!file) throw new Error('set REPRACER_BACKUP_HEARTBEAT_URL_FILE');
  const cfg: BackupHeartbeatConfig = {
    dir: env.REPRACER_BACKUP_OUT ?? '/backups',
    heartbeat: createHeartbeat({ url: readFileSync(file, 'utf8').trim() }),
    nowMs: () => Date.now(),
    log: (line) => (line.level === 'WARN' ? console.error : console.log)(JSON.stringify(line)),
  };
  const every = Number(env.REPRACER_BACKUP_HEARTBEAT_EVERY_SECONDS ?? 60) * 1000;
  const watch = newBackupWatch(cfg.nowMs());
  let stop = false;
  for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => { stop = true; });
  while (!stop) {
    if (statSync(cfg.dir).isDirectory()) await backupHeartbeatOnce(cfg, watch);
    for (let waited = 0; waited < every && !stop; waited += 1000) await new Promise((r) => setTimeout(r, 1000));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => { console.error(JSON.stringify({ level: 'ERROR', code: 'BACKUP_HEARTBEAT_START', message: (error as Error).message.slice(0, 200) })); process.exit(1); });
}
