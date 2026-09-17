import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AdapterDependencies, AdapterLogEntry, AlertSink, ChannelAccountId, TenantId } from '@repracer/channel-port';
import { inTenant, type PgPool } from '@repracer/pricing-store-pg';

/**
 * Р-129 (шаг 26): зависимости адаптеров в работе — каталог аккаунтов из базы [Р-31], учётные данные из файлов развёртывания, журнал и
 * алерты — строками JSON в stdout (сбор — задача развёртывания). Секреты, токены и данные покупателей в журнал не попадают: пишутся
 * только коды, идентификаторы и числа.
 */

/** Ссылка на учётные данные — имя файла в каталоге секретов; любые пути и подстановки отклоняются */
export function credentialsFromFiles(dir: string, read: (path: string) => string = (p) => readFileSync(p, 'utf8')) {
  return {
    async get(ref: string): Promise<Record<string, string>> {
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,120}$/.test(ref)) throw new Error('CREDENTIALS_REF_INVALID');
      try {
        const parsed: unknown = JSON.parse(read(join(dir, ref.replaceAll(':', '_'))));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('shape');
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) if (typeof v === 'string') out[k] = v;
        return out;
      } catch {
        // Ни содержимое файла, ни путь в ошибку не попадают
        throw new Error('CREDENTIALS_UNREADABLE');
      }
    },
  };
}

/** Р-31: тенант приходит в задании и сверяется с базой; каталог не выбирает тенанта сам */
export function pgAccountDirectory(appPool: PgPool) {
  return {
    async verify(tenantId: TenantId, channelAccountId: ChannelAccountId) {
      const row = await inTenant(appPool, tenantId, async (tx) => {
        const { rows: [r] } = await tx.query(
          `SELECT channel, region, external_account_id, marketplaces, credentials_ref, auth_status, disconnected_at
             FROM tenant_data.channel_account WHERE channel_account_id = $1`, [channelAccountId]);
        return r ?? null;
      });
      if (!row) return { ok: false as const, reason: 'NOT_FOUND' as const };
      if (row.disconnected_at !== null || row.auth_status !== 'ACTIVE') return { ok: false as const, reason: 'DISCONNECTED' as const };
      return {
        ok: true as const,
        account: {
          tenantId, channelAccountId, channel: row.channel, ...(row.region ? { region: row.region } : {}),
          externalAccountId: row.external_account_id, marketplaces: [...row.marketplaces], credentialsRef: row.credentials_ref,
        },
      };
    },
  };
}

export interface JsonSink {
  logger: AdapterDependencies['logger'];
  alerts: AdapterDependencies['alerts'];
  raised: { warning: number; critical: number };
}

/** Журнал и алерты процесса: строка JSON в stdout, без тел запросов и секретов */
export function jsonSink(write: (line: string) => void = (l) => process.stdout.write(`${l}\n`), now: () => string = () => new Date().toISOString()): JsonSink {
  const raised = { warning: 0, critical: 0 };
  return {
    raised,
    logger: { log: (entry: AdapterLogEntry) => write(JSON.stringify({ at: now(), kind: 'log', level: entry.level, code: entry.code, details: entry.details ?? {} })) },
    alerts: {
      async raise(alert: Parameters<AlertSink['raise']>[0]) {
        if (alert.severity === 'CRITICAL') raised.critical += 1; else raised.warning += 1;
        write(JSON.stringify({ at: now(), kind: 'alert', severity: alert.severity, code: alert.code, tenantId: alert.tenantId ?? null, details: alert.details }));
      },
    },
  };
}
