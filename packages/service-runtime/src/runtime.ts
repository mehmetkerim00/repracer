import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AdapterDependencies, AdapterLogEntry, AlertSink, ChannelAccountId, TenantId } from '@repracer/channel-port';
import { inTenant, PgCredentialVault, type PgPool } from '@repracer/pricing-store-pg';
import { openToken, redactSecrets, type Keyring } from '@repracer/channel-oauth';

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
          `SELECT channel, region, external_account_id, marketplaces, credentials_ref, auth_status, disconnected_at, write_mode
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
          ...(row.write_mode === 'SHADOW' || row.write_mode === 'LIVE' ? { writeMode: row.write_mode as 'SHADOW' | 'LIVE' } : {}),
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
export function jsonSink(raw: (line: string) => void = (l) => process.stdout.write(`${l}\n`), now: () => string = () => new Date().toISOString()): JsonSink {
  /**
   * Р-177 (шаг 43): вторая линия против утечки токена — каждая строка журнала проходит маскирование форм токенов.
   * Первая линия — код не передаёт токены в журнал вовсе; эта ловит то, что всё-таки попало (текст ошибки канала,
   * адрес с кодом согласия).
   */
  const write = (line: string) => raw(redactSecrets(line));
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

/**
 * Р-177 (шаг 43): учётные данные канала из БАЗЫ — для аккаунтов, подключённых продавцом по OAuth. Ссылка `db:<аккаунт>`:
 * шифротекст читает роль адаптеров (`repracer_credentials`), расшифровывает кольцо ключей из файла секретов. Остальные
 * ссылки — файлы развёртывания, как прежде (запасной путь: ключи, заведённые оператором вручную).
 *
 * Тенант берётся из ссылки аккаунта через базу, а не из вызывающего: адаптер получает ссылку из каталога аккаунтов,
 * который уже сверил тенанта [Р-31].
 */
export function credentialsWithVault(files: { get(ref: string): Promise<Record<string, string>> }, vault: { pool: PgPool; keyring: Keyring } | null) {
  const store = vault ? new PgCredentialVault(vault.pool) : null;
  return {
    async get(ref: string): Promise<Record<string, string>> {
      if (!ref.startsWith('db:')) return files.get(ref);
      const accountId = ref.slice(3);
      if (!store || !/^[0-9a-f-]{36}$/.test(accountId)) throw new Error('CREDENTIALS_VAULT_UNAVAILABLE');
      // Находка 4 ревью шага 43: владелец — аккаунт, чья СОБСТВЕННАЯ ссылка равна запрошенной (её держит и ограничение базы)
      const { rows: [owner] } = await vault!.pool.query(
        `SELECT tenant_id FROM tenant_data.channel_account WHERE channel_account_id = $1 AND credentials_ref = $2`, [accountId, ref]);
      if (!owner) throw new Error('CREDENTIALS_UNREADABLE');
      const current = await store.current(owner.tenant_id as string, accountId);
      if (!current) throw new Error('CREDENTIALS_UNREADABLE');
      return { refreshToken: openToken(vault!.keyring, current.sealed, { tenantId: current.tenantId, channelAccountId: accountId }) };
    },
  };
}

/**
 * Шаг 43, находка 13 ревью: ключи приложения Amazon — ОДИН источник. Когда приложение настроено конфигурацией каналов
 * (`REPRACER_AMAZON_LWA_CLIENT_ID` и файл секрета), адаптер получает их же по своей ссылке учётных данных приложения, и
 * проверка авторизаций не может сказать «доступ подтверждён», пока адаптер получает `invalid_client`. Без приложения в
 * конфигурации — прежний файл по ссылке (запасной путь оператора).
 */
export function channelCredentialsProvider(o: {
  files: { get(ref: string): Promise<Record<string, string>> };
  vault: { pool: PgPool; keyring: Keyring } | null;
  amazonApplication: { ref: string; clientId: string; clientSecret: string } | null;
  /** Шаг 47: ключи приложения eBay — платформенные, как у Amazon; refresh-токен продавца — по ссылке `db:` аккаунта */
  ebayApplication?: { ref: string; clientId: string; clientSecret: string } | null;
}) {
  const inner = credentialsWithVault(o.files, o.vault);
  return {
    async get(ref: string): Promise<Record<string, string>> {
      if (o.amazonApplication && ref === o.amazonApplication.ref) return { clientId: o.amazonApplication.clientId, clientSecret: o.amazonApplication.clientSecret };
      if (o.ebayApplication && ref === o.ebayApplication.ref) return { clientId: o.ebayApplication.clientId, clientSecret: o.ebayApplication.clientSecret };
      return inner.get(ref);
    },
  };
}
