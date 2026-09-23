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

/**
 * Кому и на каком языке уходит письмо [Р-161]. Три поля читаются ОДНИМ запросом на всю пачку тенантов: отдельный
 * запрос на каждое событие превращал бы сотню алертов одного захода в сотни обращений к базе.
 */
export interface AlertRecipient {
  /** Название тенанта для письма: владелец нескольких аккаунтов должен понять, о каком его аккаунте речь */
  name: string;
  /** Адрес владельца; `null` — активного владельца нет, и письмо слать некому */
  email: string | null;
  /**
   * Язык тенанта, как он записан в базе (`tenant_data.tenant.locale`, 0124). Тип — строка, а не список языков словаря:
   * хранилище не знает, какие языки есть у консоли, и сверяет их доставка [Р-72].
   */
  locale: string | null;
}

/** Вид отметки доставки: два настоящих письма и СУХОЙ прогон (шаг 37, OQ-224) — база знает все три (0124) */
export type DeliveryKind = 'EMAIL_IMMEDIATE' | 'EMAIL_DIGEST' | 'DRY_RUN';

export interface AlertDeliveryStore {
  /** Недоставленные алерты уровня, свежие последними; `before` — не брать то, что подняли только что */
  undelivered(severity: 'WARNING' | 'CRITICAL', limit: number, before: string): Promise<AlertRow[]>;
  /**
   * Получатели пачки тенантов ОДНИМ запросом: имя, адрес владельца и язык. Тенанта, которого уже нет в базе, в ответе
   * нет — доставка обязана выдержать его отсутствие, а не считать его «тенантом без языка».
   */
  recipients(tenantIds: readonly string[]): Promise<Map<string, AlertRecipient>>;
  /** Отметка доставки — один раз на алерт (страж базы не даст записать вторую) */
  markDelivered(tenantId: string, alertIds: readonly string[], kind: DeliveryKind, deliveryRef: string): Promise<number>;
  /** Неудачная отправка: попытка считается, причина коротко — письмо, которое не ушло, доставленным не считается */
  markFailed(tenantId: string, alertIds: readonly string[], error: string): Promise<void>;
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
        -- Часы процесса идут МИЛЛИсекундами, а время события ставит база МИКРОсекундами: событие, поднятое в ту же
        -- миллисекунду, что идёт заход, оказывалось «из будущего» и пропускалось. В работе планировщика это стоило
        -- одного периода, а прогон на настоящей базе от этого краснел через раз (шаг 37). Предел берётся по
        -- миллисекунде целиком; столбец остаётся голым, и запрос по-прежнему идёт индексом alert_undelivered_idx
        WHERE a.delivered_at IS NULL AND a.severity = $1 AND a.raised_at < $2::timestamptz + interval '1 millisecond'
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

  /**
   * Р-161: язык тенанта приходит ВМЕСТЕ с адресом владельца и названием — один запрос на весь заход доставки, а не по
   * запросу на тенанта и уж тем более не на событие. Права роли — по столбцам [Р-100]: ни цен, ни решений она не видит.
   */
  async recipients(tenantIds: readonly string[]): Promise<Map<string, AlertRecipient>> {
    if (tenantIds.length === 0) return new Map();
    const { rows } = await this.pool.query(
      `SELECT t.tenant_id, t.name, t.locale, security.tenant_owner_email(t.tenant_id) AS email
         FROM tenant_data.tenant t
        WHERE t.tenant_id = ANY($1::uuid[])`, [[...new Set(tenantIds)]]);
    return new Map(rows.map((r) => [String(r.tenant_id), {
      name: (r.name as string | null) ?? String(r.tenant_id),
      email: (r.email as string | null) ?? null,
      locale: (r.locale as string | null) ?? null,
    }]));
  }

  async markDelivered(tenantId: string, alertIds: readonly string[], kind: DeliveryKind, deliveryRef: string): Promise<number> {
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
