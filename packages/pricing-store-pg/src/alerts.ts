import type { AlertSink } from '@repracer/channel-port';
import { inTenant, type PgPool } from './db.ts';

/**
 * Р-156 (шаг 36): алерт, который живёт только в базе, считается НЕдоставленным — но сперва он должен туда попасть.
 * До этого шага алерт был строкой JSON в stdout процесса: «сбор — задача развёртывания», то есть ничья. Теперь путь
 * такой: процесс поднимает алерт → строка в `tenant_data.alert` без отметки доставки → работа планировщика отправляет
 * письмо владельцу и ставит отметку. Журнал JSON остаётся: он для эксплуатации, а письмо — для владельца.
 */

/** Алерт в базе: то, что подняли, плюс отметка доставки */
export interface AlertRow {
  tenantId: string;
  alertId: string;
  code: string;
  severity: 'WARNING' | 'CRITICAL';
  channelAccountId: string | null;
  channel: string | null;
  marketplaces: string[];
  details: Record<string, unknown>;
  raisedAt: string;
  deliveryAttempts: number;
}

export interface AlertDeliveryStore {
  /** Недоставленные алерты уровня, свежие последними; `before` — не брать то, что подняли только что */
  undelivered(severity: 'WARNING' | 'CRITICAL', limit: number, before: string): Promise<AlertRow[]>;
  /** Адрес владельца тенанта: роль доставки не читает ни цен, ни решений */
  ownerEmail(tenantId: string): Promise<string | null>;
  /** Отметка доставки — один раз на алерт (страж базы не даст записать вторую) */
  markDelivered(tenantId: string, alertIds: readonly string[], kind: 'EMAIL_IMMEDIATE' | 'EMAIL_DIGEST', deliveryRef: string): Promise<number>;
  /** Неудачная отправка: попытка считается, причина коротко — письмо, которое не ушло, доставленным не считается */
  markFailed(tenantId: string, alertIds: readonly string[], error: string): Promise<void>;
  /** Название тенанта для письма: владелец должен понять, о каком его аккаунте речь */
  tenantName(tenantId: string): Promise<string>;
  /** Платформенный тенант: его алерты адресованы оператору платформы, а не продавцу [Р-156] */
  platformTenantId(): Promise<string>;
}

/** Куда процессы кладут алерты: та же роль, что ведёт их транзакции */
export class PgAlertSink implements AlertSink {
  private readonly pool: PgPool;
  private readonly fallback?: AlertSink;

  /** `fallback` — журнал JSON: он продолжает получать всё, даже если база недоступна */
  private platform: string | null = null;

  constructor(pool: PgPool, fallback?: AlertSink) {
    this.pool = pool;
    this.fallback = fallback;
  }

  /** Идентификатор платформенного тенанта спрашивается у базы один раз за жизнь процесса */
  private async platformTenant(): Promise<string> {
    if (!this.platform) this.platform = String((await this.pool.query('SELECT security.platform_tenant_id() AS id')).rows[0]!.id);
    return this.platform;
  }

  async raise(alert: Parameters<AlertSink['raise']>[0]): Promise<void> {
    if (this.fallback) await this.fallback.raise(alert);
    /**
     * Алерт без тенанта — платформенный: отставание выгрузки, падающая работа планировщика. Он тоже адресован человеку,
     * только другому: не продавцу, а оператору платформы. Хранится он у платформенного тенанта, и доставка отличает
     * его по этому признаку (без этого такой алерт уходил бы владельцу первого попавшегося продавца — или никуда).
     */
    /**
     * Запись алерта НЕ ломает того, кто его поднял: алерт поднимается посреди пути решения и посреди отправки записи,
     * и уронить их из-за недоступной базы или удалённого аккаунта канала — хуже, чем потерять одно письмо. Потеря не
     * молчит: событие остаётся в журнале эксплуатации (`fallback`), а сбой записи попадает туда же кодом.
     */
    try {
      const tenantId = alert.tenantId ? String(alert.tenantId) : await this.platformTenant();
      await inTenant(this.pool, tenantId, async (tx) => {
        await tx.query(
          `INSERT INTO tenant_data.alert (tenant_id, code, severity, channel_account_id, correlation_id, details)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
          [tenantId, alert.code, alert.severity, alert.channelAccountId ?? null, alert.correlationId?.slice(0, 200) ?? null, JSON.stringify(alert.details ?? {})]);
      });
    } catch (error) {
      await this.fallback?.raise({
        code: 'ALERT_NOT_STORED', severity: 'WARNING',
        ...(alert.tenantId ? { tenantId: alert.tenantId } : {}),
        details: { of: alert.code, error: String((error as { code?: unknown }).code ?? 'UNKNOWN') },
      });
    }
  }
}

/** Что читает и отмечает доставка: своя роль, свои права (0120) */
export class PgAlertDeliveryStore implements AlertDeliveryStore {
  private readonly pool: PgPool;

  constructor(pool: PgPool) {
    this.pool = pool;
  }

  async undelivered(severity: 'WARNING' | 'CRITICAL', limit: number, before: string): Promise<AlertRow[]> {
    const { rows } = await this.pool.query(
      `SELECT a.tenant_id, a.alert_id, a.code, a.severity, a.channel_account_id, a.details, a.raised_at, a.delivery_attempts,
              ca.channel, ca.marketplaces
         FROM tenant_data.alert a
         LEFT JOIN tenant_data.channel_account ca ON ca.tenant_id = a.tenant_id AND ca.channel_account_id = a.channel_account_id
        WHERE a.delivered_at IS NULL AND a.severity = $1 AND a.raised_at <= $2::timestamptz
        -- Сперва те, что ещё не пытались отправить: алерт, который не уходит (нет владельца, провайдер отвергает
        -- адрес), иначе занимал бы всё окно и не давал уйти свежему событию другого тенанта [находка 12 ревью шага 36]
        ORDER BY a.delivery_attempts, a.raised_at, a.alert_id
        LIMIT $3`, [severity, before, limit]);
    return rows.map((r): AlertRow => ({
      tenantId: r.tenant_id, alertId: r.alert_id, code: r.code, severity: r.severity,
      channelAccountId: r.channel_account_id ?? null, channel: r.channel ?? null, marketplaces: (r.marketplaces ?? []) as string[],
      details: (r.details ?? {}) as Record<string, unknown>,
      raisedAt: new Date(r.raised_at as string).toISOString(), deliveryAttempts: Number(r.delivery_attempts),
    }));
  }

  async platformTenantId(): Promise<string> {
    const { rows } = await this.pool.query('SELECT security.platform_tenant_id() AS id');
    return String(rows[0]!.id);
  }

  async ownerEmail(tenantId: string): Promise<string | null> {
    const { rows } = await this.pool.query(`SELECT security.tenant_owner_email($1) AS email`, [tenantId]);
    return (rows[0]?.email as string | null) ?? null;
  }

  async tenantName(tenantId: string): Promise<string> {
    const { rows } = await this.pool.query(`SELECT name FROM tenant_data.tenant WHERE tenant_id = $1`, [tenantId]);
    return (rows[0]?.name as string | undefined) ?? tenantId;
  }

  async markDelivered(tenantId: string, alertIds: readonly string[], kind: 'EMAIL_IMMEDIATE' | 'EMAIL_DIGEST', deliveryRef: string): Promise<number> {
    const { rowCount } = await this.pool.query(
      `UPDATE tenant_data.alert SET delivered_at = now(), delivery_kind = $3, delivery_ref = $4
        WHERE tenant_id = $1 AND alert_id = ANY($2::uuid[]) AND delivered_at IS NULL`,
      [tenantId, [...alertIds], kind, deliveryRef.slice(0, 200)]);
    return rowCount ?? 0;
  }

  async markFailed(tenantId: string, alertIds: readonly string[], error: string): Promise<void> {
    await this.pool.query(
      `UPDATE tenant_data.alert SET delivery_attempts = delivery_attempts + 1, last_delivery_error = $3
        WHERE tenant_id = $1 AND alert_id = ANY($2::uuid[]) AND delivered_at IS NULL`,
      [tenantId, [...alertIds], error.slice(0, 200)]);
  }
}
