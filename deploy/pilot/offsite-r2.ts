/**
 * Шаг 126 (решение владельца: копии базы пилота — вне сервера, цель настраиваемая): вынос суточных копий PostgreSQL в Cloudflare R2.
 *
 * Копию снимает прежний сервис `backup` (deploy/production/backup-loop.sh: pg_dump → gpg открытым ключом владельца); этот процесс берёт ГОТОВЫЕ копии
 * из того же каталога и кладёт их в бакет R2 по S3 API. Факты R2 — снимок vendor/cloudflare/r2/2026-11-14 (адрес `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`,
 * адрес бакета `https://<бакет>.<ACCOUNT_ID>.r2.cloudflarestorage.com`, регион подписи `auto`, PutObject, HeadObject, ListObjectsV2, DeleteObject).
 *
 *  - Готовая копия — та, у которой есть файл сумм `repracer-<время>.sha256`: backup-loop пишет его последним, после переименования частей.
 *  - Каждый файл — одним PutObject с подписанным хэшем тела (`x-amz-content-sha256`), затем HeadObject: длина в бакете — длина файла. Только после
 *    этого рядом с копией появляется отметка `repracer-<время>.offsite`, и копия больше не выгружается.
 *  - Провал — строка алерта `BACKUP_OFFSITE_FAILED` в stderr и файл-отметка `BACKUP_OFFSITE_FAILED` в каталоге копий (как `BACKUP_FAILED` у
 *    backup-loop); исчезает с первым удавшимся проходом. Проверка выкладки (deploy/pilot/smoke.sh) видит и её, и отсутствие отметки `.offsite`.
 *  - Срок: в бакете — не дольше, чем на сервере (`REPRACER_BACKUP_KEEP_DAYS`, 7 суток — данные каналов не должны пережить свой срок в копиях,
 *    docs/data-retention.md): старше — удаляются по времени в имени.
 *
 * Ключи R2 — файлами; ни ключ, ни подпись в журнал не попадают. Копии уже зашифрованы — бакет видит только шифротекст.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { signRequest, type AwsCredentials } from '../../packages/amazon-notifications/src/sigv4.ts';

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: Uint8Array }) => Promise<{ status: number; headers: { get(name: string): string | null }; text(): Promise<string> }>;

export interface OffsiteConfig {
  /** Каталог копий — тот же, куда пишет backup-loop */
  dir: string;
  /** Адрес бакета: `https://<бакет>.<ACCOUNT_ID>.r2.cloudflarestorage.com` (в прогонах — модель на петле) */
  bucketUrl: string;
  /** Префикс ключей в бакете, например `pilot/` */
  prefix: string;
  keepDays: number;
  credentials: AwsCredentials;
  fetch: Fetch;
  now: () => Date;
  log: (line: Record<string, unknown>) => void;
}

const STAMP = /^repracer-(\d{8}T\d{6}Z)\.sha256$/;
const PARTS = ['dump.gpg', 'globals.sql.gpg', 'sha256'] as const;
const EMPTY = createHash('sha256').update('').digest('hex');
export const FAILED_MARK = 'BACKUP_OFFSITE_FAILED';

/** 20261114T120000Z — то же время, что в имени копии backup-loop */
export function stampOf(at: Date): string {
  return at.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

export function checkBucketUrl(url: string): string {
  const u = new URL(url);
  // https — всегда; петля — только у модели в прогонах
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && u.hostname === '127.0.0.1')) throw new Error('REPRACER_BACKUP_R2_BUCKET_URL must be https://<bucket>.<ACCOUNT_ID>.r2.cloudflarestorage.com');
  if (u.pathname !== '/' || u.search !== '' || u.username !== '' || u.password !== '') throw new Error('REPRACER_BACKUP_R2_BUCKET_URL is the bucket address without a path');
  return u.origin;
}

async function call(cfg: OffsiteConfig, method: string, key: string, query: string, body?: Uint8Array) {
  const url = `${checkBucketUrl(cfg.bucketUrl)}/${key}${query}`;
  const payloadHash = body ? createHash('sha256').update(body).digest('hex') : EMPTY;
  const base: Record<string, string> = { 'x-amz-content-sha256': payloadHash };
  if (body) base['content-type'] = 'application/octet-stream';
  const headers = signRequest({ method, url, headers: base, body: '', payloadHash }, cfg.credentials, 'auto', 's3', cfg.now());
  return cfg.fetch(url, { method, headers, ...(body ? { body } : {}) });
}

/** Один проход: выгрузить готовые копии без отметки, удалить из бакета копии старше срока. Итог — что сделано; провал — отметкой и алертом */
export async function offsiteOnce(cfg: OffsiteConfig): Promise<{ uploaded: string[]; deletedRemote: string[]; failed: string | null }> {
  const uploaded: string[] = [];
  const deletedRemote: string[] = [];
  const cutoff = stampOf(new Date(cfg.now().getTime() - cfg.keepDays * 86_400_000));
  const fail = (why: string, extra: Record<string, unknown>) => {
    const at = stampOf(cfg.now());
    cfg.log({ event: 'ALERT', code: FAILED_MARK, severity: 'CRITICAL', at, why, ...extra });
    writeFileSync(join(cfg.dir, FAILED_MARK), `${JSON.stringify({ code: FAILED_MARK, at, why, ...extra })}\n`);
    return { uploaded, deletedRemote, failed: why };
  };
  try {
    const stamps = readdirSync(cfg.dir).map((f) => STAMP.exec(f)?.[1]).filter((s): s is string => Boolean(s)).sort();
    for (const stamp of stamps) {
      if (stamp < cutoff || existsSync(join(cfg.dir, `repracer-${stamp}.offsite`))) continue;
      let bytes = 0;
      for (const part of PARTS) {
        const name = `repracer-${stamp}.${part}`;
        const body = readFileSync(join(cfg.dir, name));
        const key = `${cfg.prefix}${name}`;
        const put = await call(cfg, 'PUT', key, '', body);
        if (put.status !== 200) return fail('PUT_FAILED', { file: name, status: put.status });
        const head = await call(cfg, 'HEAD', key, '');
        if (head.status !== 200 || Number(head.headers.get('content-length')) !== body.length) {
          return fail('HEAD_MISMATCH', { file: name, status: head.status, bytes: body.length, remoteBytes: head.headers.get('content-length') });
        }
        bytes += body.length;
      }
      writeFileSync(join(cfg.dir, `repracer-${stamp}.offsite`), `${JSON.stringify({ at: cfg.now().toISOString(), bucket: new URL(cfg.bucketUrl).hostname, prefix: cfg.prefix, bytes })}\n`);
      uploaded.push(stamp);
      cfg.log({ event: 'BACKUP_OFFSITE_DONE', copy: `repracer-${stamp}`, bytes });
    }
    // Срок в бакете: ListObjectsV2 по префиксу, страницами; старше среза — DeleteObject
    let token: string | null = null;
    do {
      const query: string = `?list-type=2&prefix=${encodeURIComponent(cfg.prefix)}${token ? `&continuation-token=${encodeURIComponent(token)}` : ''}`;
      const list = await call(cfg, 'GET', '', query);
      if (list.status !== 200) return fail('LIST_FAILED', { status: list.status });
      const xml = await list.text();
      for (const [, key] of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) {
        const stamp = /repracer-(\d{8}T\d{6}Z)\./.exec(key!)?.[1];
        if (!stamp || stamp >= cutoff) continue;
        const del = await call(cfg, 'DELETE', key!, '');
        if (del.status !== 204 && del.status !== 200) return fail('DELETE_FAILED', { key, status: del.status });
        deletedRemote.push(key!);
      }
      token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? (/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml)?.[1] ?? null) : null;
    } while (token);
  } catch (error) {
    return fail('ERROR', { message: (error as Error).message.slice(0, 200) });
  }
  rmSync(join(cfg.dir, FAILED_MARK), { force: true });
  return { uploaded, deletedRemote, failed: null };
}

/** Процесс: проход сразу и затем каждые REPRACER_BACKUP_OFFSITE_EVERY_SECONDS (по умолчанию 10 минут) */
async function main(): Promise<void> {
  const env = process.env;
  const need = (name: string) => { const v = env[name]; if (!v) throw new Error(`set ${name}`); return v; };
  const file = (name: string) => readFileSync(need(name), 'utf8').trim();
  const cfg: OffsiteConfig = {
    dir: env.REPRACER_BACKUP_OUT ?? '/backups',
    bucketUrl: need('REPRACER_BACKUP_R2_BUCKET_URL'),
    prefix: env.REPRACER_BACKUP_R2_PREFIX ?? 'pilot/',
    keepDays: Number(env.REPRACER_BACKUP_KEEP_DAYS ?? 7),
    credentials: { accessKeyId: file('REPRACER_BACKUP_R2_ACCESS_KEY_ID_FILE'), secretAccessKey: file('REPRACER_BACKUP_R2_SECRET_ACCESS_KEY_FILE') },
    fetch: (url, init) => fetch(url, init),
    now: () => new Date(),
    log: (line) => (line.event === 'ALERT' ? console.error : console.log)(JSON.stringify(line)),
  };
  checkBucketUrl(cfg.bucketUrl);
  if (!/^[A-Za-z0-9/_-]*$/.test(cfg.prefix)) throw new Error('REPRACER_BACKUP_R2_PREFIX: letters, digits, / _ -');
  const every = Number(env.REPRACER_BACKUP_OFFSITE_EVERY_SECONDS ?? 600) * 1000;
  let stop = false;
  for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => { stop = true; });
  while (!stop) {
    if (statSync(cfg.dir).isDirectory()) await offsiteOnce(cfg);
    for (let waited = 0; waited < every && !stop; waited += 1000) await new Promise((r) => setTimeout(r, 1000));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => { console.error(JSON.stringify({ event: 'ALERT', code: FAILED_MARK, severity: 'CRITICAL', why: 'START', message: (error as Error).message })); process.exit(1); });
}
