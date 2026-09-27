import { randomUUID } from 'node:crypto';
import type { Instant } from '@repracer/channel-port';
import { inTenant, type PgPool } from './db.ts';

/**
 * Р-175…Р-177 (шаг 43): подключение канала продавцом.
 *
 * Консоль (административная роль) ведёт запрос согласия и ЗАПИСЫВАЕТ полученный токен — зашифрованным, и прочитать его
 * не может: у неё нет права на шифротекст [Р-177]. Читает токен только роль адаптеров (`PgCredentialVault`).
 *
 * Шифрование делает вызывающий — ключа у хранилища нет и быть не должно: оно получает уже готовый шифротекст, а
 * связанные данные шифра (тенант и аккаунт) требуют знать идентификатор аккаунта ДО вставки, поэтому хранилище отдаёт
 * его в функцию запечатывания.
 */

export interface SealedCredential {
  keyId: string;
  iv: Buffer;
  authTag: Buffer;
  ciphertext: Buffer;
}

export interface ConnectStart {
  channel: 'AMAZON' | 'EBAY';
  region: 'EU' | 'NA' | null;
  marketplaces: string[];
  stateSha256: Buffer;
  /** Срок запроса; база не принимает больше десяти минут */
  ttlSeconds: number;
  membershipId: string;
  userId: string;
  mfa: boolean;
}

export interface ConnectComplete {
  stateSha256: Buffer;
  /** Идентификатор продавца у канала: Amazon — `selling_partner_id`; eBay — нет в снимке (E-11), временный */
  externalAccountId: string | null;
  seal: (channelAccountId: string) => SealedCredential;
  refreshExpiresAt: Instant | null;
  membershipId: string;
  userId: string;
  mfa: boolean;
}

export type ConnectOutcome =
  | { status: 'CONNECTED'; channelAccountId: string; reconnected: boolean; channel: string }
  /** Находка 5 ревью шага 43: этот продавец канала уже подключён — в другом тенанте или другим аккаунтом */
  | { status: 'SELLER_TAKEN' }
  /** Перепривязка ДЕЙСТВУЮЩЕГО аккаунта к новому токену — только со вторым фактором (идентификатор продавца не проверен каналом) */
  | { status: 'MFA_REQUIRED' }
  | { status: 'UNKNOWN_STATE' }
  | { status: 'EXPIRED' }
  | { status: 'ALREADY_DONE'; requestStatus: string };

export interface ConnectionRow {
  channelAccountId: string;
  channel: string;
  region: string | null;
  marketplaces: string[];
  externalAccountId: string;
  authStatus: string;
  accessBlockers: string[];
  writeMode: 'SHADOW' | 'LIVE';
  connectedAt: Instant;
  /** Р-176: «нашли N офферов» — предложения аккаунта, найденные обходом */
  offers: number;
  /** «тень начала считать» — решения в тени за последние сутки */
  shadowDecisions24h: number;
  credentialObtainedAt: Instant | null;
  credentialVerifiedAt: Instant | null;
  credentialCheckFailures: number;
  /** Подключён ли OAuth (токен в базе) или файлом развёртывания / вручную оператором */
  oauth: boolean;
}

export interface PendingRequestRow {
  authorizationRequestId: string;
  channel: string;
  marketplaces: string[];
  requestedAt: Instant;
  expiresAt: Instant;
  status: string;
  failureCode: string | null;
}

const iso = (v: unknown): Instant => (v instanceof Date ? v.toISOString() : String(v)) as Instant;

export class PgChannelConnectStore {
  private readonly adminPool: PgPool;

  constructor(adminPool: PgPool) {
    this.adminPool = adminPool;
  }

  async start(tenantId: string, s: ConnectStart): Promise<{ authorizationRequestId: string; expiresAt: Instant }> {
    return inTenant(this.adminPool, tenantId, async (tx) => {
      const { rows: [r] } = await tx.query(
        `INSERT INTO tenant_data.channel_authorization_request
           (tenant_id, channel, region, marketplaces, state_sha256, requested_by_membership_id, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(secs => $7))
         RETURNING authorization_request_id, expires_at`,
        [tenantId, s.channel, s.region, s.marketplaces, s.stateSha256, s.membershipId, s.ttlSeconds]);
      return { authorizationRequestId: r!.authorization_request_id as string, expiresAt: iso(r!.expires_at) };
    }, s.userId, { mfa: s.mfa });
  }

  /**
   * Возврат с кодом: ОДНОЙ транзакцией — аккаунт (новый рождается в тени, Р-176), зашифрованный токен и завершение
   * запроса. Упади что-то посередине — не останется ни аккаунта без токена, ни токена без аккаунта.
   */
  async complete(tenantId: string, c: ConnectComplete): Promise<ConnectOutcome> {
    try {
      return await inTenant(this.adminPool, tenantId, async (tx) => {
        const { rows: [req] } = await tx.query(
          `SELECT authorization_request_id, channel, region, marketplaces, status,
                  expires_at + CASE WHEN exchange_started_at <= expires_at THEN interval '2 minutes' ELSE interval '0' END < now() AS expired
             FROM tenant_data.channel_authorization_request WHERE tenant_id = $1 AND state_sha256 = $2 FOR UPDATE`,
          [tenantId, c.stateSha256]);
        if (!req) return { status: 'UNKNOWN_STATE' } as ConnectOutcome;
        if (req.status !== 'PENDING') return { status: 'ALREADY_DONE', requestStatus: req.status as string } as ConnectOutcome;
        if (req.expired) return { status: 'EXPIRED' } as ConnectOutcome;
        const channel = req.channel as string;
        // eBay не называет продавца при обмене кода (E-11): временный идентификатор — запрос согласия, а не токен
        const external = c.externalAccountId ?? `pending-identity:${req.authorization_request_id as string}`;
        // Повторная авторизация того же продавца — тот же аккаунт: новая версия токена, доступ снова действует
        const { rows: [existing] } = await tx.query(
          `SELECT channel_account_id FROM tenant_data.channel_account
            WHERE tenant_id = $1 AND channel = $2 AND external_account_id = $3 AND disconnected_at IS NULL`,
          [tenantId, channel, external]);
        const accountId: string = (existing?.channel_account_id as string | undefined) ?? randomUUID();
        if (existing) {
          /**
           * Находка 5 ревью шага 43: `selling_partner_id` приходит из адреса возврата, то есть от браузера, и каналом не
           * проверен (A-19). Привязать новый токен к СУЩЕСТВУЮЩЕМУ аккаунту — действие, которым можно подменить продавца
           * боевого аккаунта; оно требует второго фактора, как переход в бой [Р-170].
           */
          if (!c.mfa) return { status: 'MFA_REQUIRED' } as ConnectOutcome;
          await tx.query(`UPDATE tenant_data.channel_account SET auth_status = 'ACTIVE' WHERE tenant_id = $1 AND channel_account_id = $2`,
            [tenantId, accountId]);
        } else {
          // Режим записи не передаётся: умолчание базы — ТЕНЬ [Р-170, Р-176]
          await tx.query(
            `INSERT INTO tenant_data.channel_account (tenant_id, channel_account_id, channel, region, external_account_id, marketplaces,
                                                      credentials_ref, connected_by_membership_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [tenantId, accountId, channel, req.region, external, req.marketplaces, `db:${accountId}`, c.membershipId]);
        }
        const sealed = c.seal(accountId);
        await tx.query(
          `INSERT INTO tenant_data.channel_credential (tenant_id, channel_account_id, key_id, iv, auth_tag, ciphertext, refresh_expires_at, created_by_membership_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [tenantId, accountId, sealed.keyId, sealed.iv, sealed.authTag, sealed.ciphertext, c.refreshExpiresAt, c.membershipId]);
        await tx.query(
          `UPDATE tenant_data.channel_authorization_request SET status = 'COMPLETED', channel_account_id = $3
            WHERE tenant_id = $1 AND authorization_request_id = $2`,
          [tenantId, req.authorization_request_id, accountId]);
        return { status: 'CONNECTED', channelAccountId: accountId, reconnected: Boolean(existing), channel } as ConnectOutcome;
      }, c.userId, { mfa: c.mfa });
    } catch (error) {
      // Гонка со сроком: страж базы отказал на завершении — это «опоздали», а не 500
      if (/consent came back too late/.test((error as Error).message ?? '')) return { status: 'EXPIRED' };
      // Продавец уже подключён в другом тенанте (уникальность внешнего аккаунта на платформе): названный исход, а не 500
      if ((error as { code?: string }).code === '23505' && /channel_account_external/.test((error as Error).message ?? '')) return { status: 'SELLER_TAKEN' };
      throw error;
    }
  }

  /**
   * Состояние запроса по отпечатку state — ДО обмена кода: подложенный возврат не должен заставить нас потратить код
   * согласия (и обратиться к каналу) от имени запроса, которого у этого тенанта нет.
   */
  async requestStatus(tenantId: string, stateSha256: Buffer): Promise<'PENDING' | 'EXPIRED' | 'UNKNOWN' | 'DONE'> {
    return inTenant(this.adminPool, tenantId, async (tx) => {
      const { rows: [r] } = await tx.query(
        `SELECT status, expires_at < now() AS expired FROM tenant_data.channel_authorization_request WHERE tenant_id = $1 AND state_sha256 = $2`,
        [tenantId, stateSha256]);
      if (!r) return 'UNKNOWN';
      if (r.status !== 'PENDING') return 'DONE';
      return r.expired ? 'EXPIRED' : 'PENDING';
    });
  }

  /**
   * Находка 9 ревью шага 43: обмен кода ЗАХВАТЫВАЕТСЯ до обращения к каналу одним оператором — второй одновременный
   * возврат получает «уже обменивается» и ни кода не тратит, ни чужой успех не перетирает. Канал запроса берётся отсюда,
   * а не из вида параметров возврата (находка 19).
   */
  async claim(tenantId: string, stateSha256: Buffer, actor: { userId: string; mfa: boolean }): Promise<{ status: 'CLAIMED'; channel: 'AMAZON' | 'EBAY' } | { status: 'UNKNOWN' | 'EXPIRED' | 'DONE' }> {
    const claimed = await inTenant(this.adminPool, tenantId, async (tx) => (await tx.query(
      `UPDATE tenant_data.channel_authorization_request SET exchange_started_at = now()
        WHERE tenant_id = $1 AND state_sha256 = $2 AND status = 'PENDING' AND exchange_started_at IS NULL AND expires_at >= now()
        RETURNING channel`, [tenantId, stateSha256])).rows[0], actor.userId, { mfa: actor.mfa });
    if (claimed) return { status: 'CLAIMED', channel: claimed.channel as 'AMAZON' | 'EBAY' };
    const s = await this.requestStatus(tenantId, stateSha256);
    return { status: s === 'PENDING' ? 'DONE' : s };
  }

  /** Находка 17 ревью шага 43: продавец закрыл страницу канала — ждущий запрос отменяется, а не держит кнопку десять минут */
  async cancel(tenantId: string, authorizationRequestId: string, actor: { userId: string; mfa: boolean }): Promise<boolean> {
    return inTenant(this.adminPool, tenantId, async (tx) => {
      const r = await tx.query(
        `UPDATE tenant_data.channel_authorization_request SET status = 'FAILED', failure_code = 'CANCELLED'
          WHERE tenant_id = $1 AND authorization_request_id = $2 AND status = 'PENDING' AND exchange_started_at IS NULL`, [tenantId, authorizationRequestId]);
      return (r.rowCount ?? 0) > 0;
    }, actor.userId, { mfa: actor.mfa });
  }

  /** Есть ли у тенанта действующий аккаунт канала — eBay без названного продавца повторно не подключается (E-11) */
  async hasAccount(tenantId: string, channel: string): Promise<boolean> {
    return inTenant(this.adminPool, tenantId, async (tx) => (await tx.query(
      `SELECT 1 FROM tenant_data.channel_account WHERE tenant_id = $1 AND channel = $2 AND disconnected_at IS NULL LIMIT 1`, [tenantId, channel])).rowCount! > 0);
  }

  /** Продавец отказал на странице согласия или обмен кода не удался — запрос закрывается с кодом */
  async fail(tenantId: string, stateSha256: Buffer, status: 'DENIED' | 'FAILED', code: string, actor: { userId: string; mfa: boolean }): Promise<boolean> {
    return inTenant(this.adminPool, tenantId, async (tx) => {
      const r = await tx.query(
        `UPDATE tenant_data.channel_authorization_request SET status = $3, failure_code = left($4, 64)
          WHERE tenant_id = $1 AND state_sha256 = $2 AND status = 'PENDING'`,
        [tenantId, stateSha256, status, code]);
      return (r.rowCount ?? 0) > 0;
    }, actor.userId, { mfa: actor.mfa });
  }

  async connections(tenantId: string): Promise<{ accounts: ConnectionRow[]; pending: PendingRequestRow[] }> {
    return inTenant(this.adminPool, tenantId, async (tx) => {
      const [accounts, pending] = await Promise.all([
        tx.query(
          `SELECT ca.channel_account_id, ca.channel, ca.region, ca.marketplaces, ca.external_account_id, ca.auth_status, ca.access_blockers,
                  ca.write_mode, ca.connected_at,
                  -- Р-176: «нашли N офферов» — то, что записало ОБНАРУЖЕНИЕ (searchListingsItems), по индексу последнего наблюдения
                  (SELECT count(*)::int FROM (SELECT DISTINCT p.marketplace, p.external_sku FROM channel_data.offer_channel_pricing p
                    WHERE p.tenant_id = ca.tenant_id AND p.channel_account_id = ca.channel_account_id AND p.source = 'DISCOVERY') found) AS offers,
                  (SELECT count(*)::int FROM channel_data.price_decision d
                     JOIN tenant_data.write_scope ws ON ws.tenant_id = d.tenant_id AND ws.write_scope_id = d.write_scope_id
                    WHERE d.tenant_id = ca.tenant_id AND ws.channel_account_id = ca.channel_account_id
                      AND d.shadow AND d.decided_at >= now() - interval '1 day') AS shadow_decisions,
                  cr.obtained_at, cr.verified_at, cr.check_failures
             FROM tenant_data.channel_account ca
             LEFT JOIN tenant_data.channel_credential cr
               ON cr.tenant_id = ca.tenant_id AND cr.channel_account_id = ca.channel_account_id AND cr.superseded_at IS NULL
            WHERE ca.tenant_id = $1 AND ca.disconnected_at IS NULL
            ORDER BY ca.connected_at`, [tenantId]),
        tx.query(
          `SELECT authorization_request_id, channel, marketplaces, requested_at, expires_at,
                  CASE WHEN status = 'PENDING' AND expires_at < now() THEN 'EXPIRED' ELSE status END AS status, failure_code
             FROM tenant_data.channel_authorization_request
            WHERE tenant_id = $1 AND requested_at >= now() - interval '1 day'
            ORDER BY requested_at DESC LIMIT 20`, [tenantId]),
      ]);
      return {
        accounts: accounts.rows.map((r) => ({
          channelAccountId: r.channel_account_id as string, channel: r.channel as string, region: (r.region as string | null) ?? null,
          marketplaces: [...(r.marketplaces as string[])], externalAccountId: r.external_account_id as string,
          authStatus: r.auth_status as string, accessBlockers: [...((r.access_blockers as string[] | null) ?? [])],
          writeMode: r.write_mode as 'SHADOW' | 'LIVE', connectedAt: iso(r.connected_at),
          offers: Number(r.offers), shadowDecisions24h: Number(r.shadow_decisions),
          credentialObtainedAt: r.obtained_at ? iso(r.obtained_at) : null, credentialVerifiedAt: r.verified_at ? iso(r.verified_at) : null,
          credentialCheckFailures: Number(r.check_failures ?? 0), oauth: r.obtained_at !== null,
        })),
        pending: pending.rows.map((r) => ({
          authorizationRequestId: r.authorization_request_id as string, channel: r.channel as string, marketplaces: [...(r.marketplaces as string[])],
          requestedAt: iso(r.requested_at), expiresAt: iso(r.expires_at), status: r.status as string, failureCode: (r.failure_code as string | null) ?? null,
        })),
      };
    });
  }
}

/** Действующая версия токена — для роли адаптеров [Р-177] */
export interface StoredCredential {
  tenantId: string;
  channelAccountId: string;
  channel: string;
  region: string | null;
  credentialId: string;
  sealed: SealedCredential;
}

/**
 * Хранилище токенов РОЛИ АДАПТЕРОВ. Только эта роль читает шифротекст; расшифровывает вызывающий своим кольцом ключей.
 * Проверки обменом токена идут по всем тенантам — это работа платформы, а не отчёт: ни одного бизнес-числа тенанта она
 * не видит и не складывает.
 */
export class PgCredentialVault {
  private readonly pool: PgPool;

  constructor(credentialsPool: PgPool) {
    this.pool = credentialsPool;
  }

  private row(r: Record<string, unknown>): StoredCredential {
    return {
      tenantId: r.tenant_id as string, channelAccountId: r.channel_account_id as string, channel: r.channel as string,
      region: (r.region as string | null) ?? null, credentialId: r.channel_credential_id as string,
      sealed: { keyId: r.key_id as string, iv: r.iv as Buffer, authTag: r.auth_tag as Buffer, ciphertext: r.ciphertext as Buffer },
    };
  }

  async current(tenantId: string, channelAccountId: string): Promise<StoredCredential | null> {
    const { rows: [r] } = await this.pool.query(
      `SELECT cr.tenant_id, cr.channel_account_id, ca.channel, ca.region, cr.channel_credential_id, cr.key_id, cr.iv, cr.auth_tag, cr.ciphertext
         FROM tenant_data.channel_credential cr
         JOIN tenant_data.channel_account ca ON ca.tenant_id = cr.tenant_id AND ca.channel_account_id = cr.channel_account_id
        WHERE cr.tenant_id = $1 AND cr.channel_account_id = $2 AND cr.superseded_at IS NULL`, [tenantId, channelAccountId]);
    return r ? this.row(r) : null;
  }

  /** Действующие токены, давно не проверенные, — у аккаунтов, которые ещё считаются подключёнными */
  async due(olderThanSeconds: number, limit: number): Promise<StoredCredential[]> {
    const { rows } = await this.pool.query(
      `SELECT cr.tenant_id, cr.channel_account_id, ca.channel, ca.region, cr.channel_credential_id, cr.key_id, cr.iv, cr.auth_tag, cr.ciphertext
         FROM tenant_data.channel_credential cr
         JOIN tenant_data.channel_account ca ON ca.tenant_id = cr.tenant_id AND ca.channel_account_id = cr.channel_account_id
        WHERE cr.superseded_at IS NULL AND ca.auth_status = 'ACTIVE' AND ca.disconnected_at IS NULL
          AND (cr.last_checked_at IS NULL OR cr.last_checked_at < now() - make_interval(secs => $1))
        ORDER BY cr.last_checked_at NULLS FIRST LIMIT $2`, [olderThanSeconds, limit]);
    return rows.map((r) => this.row(r));
  }

  async recordCheck(tenantId: string, credentialId: string, outcome: 'OK' | 'REVOKED' | 'TRANSIENT' | 'PLATFORM', code: string | null): Promise<string> {
    const { rows: [r] } = await this.pool.query(`SELECT security.channel_authorization_checked($1, $2, $3, $4) AS result`,
      [tenantId, credentialId, outcome, code]);
    return r!.result as string;
  }

  /** Шаг 45: удаление вытесненных версий старше 30 суток — функцией хранителя; время — часы базы */
  async purgeSuperseded(): Promise<number> {
    const { rows: [r] } = await this.pool.query('SELECT security.purge_superseded_channel_credentials() AS n');
    return Number(r!.n);
  }
}
