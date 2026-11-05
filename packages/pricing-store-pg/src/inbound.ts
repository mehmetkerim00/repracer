import type { ListingStatusObservation } from '@repracer/channel-port';
import { listingStatusStep, type LatestListingState, type RawInboundNotificationEntry } from '@repracer/pricing-pipeline';
import type { PgPool, Tx } from './db.ts';

/**
 * Шаг 23: маршрут уведомления Amazon к аккаунтам тенантов. Пул подключён ролью приёмника (repracer_inbound, в тестах svc_inbound):
 * межтенантный поиск — только функцией security.resolve_amazon_seller (0083), которая отдаёт идентификаторы тенанта и аккаунта и ничего больше.
 * Структурно совпадает с SellerRouter пакета @repracer/amazon-notifications.
 */
export class PgSellerRouter {
  private readonly pool: PgPool;

  constructor(pool: PgPool) {
    this.pool = pool;
  }

  async resolve(region: string, sellerId: string): Promise<Array<{ tenantId: string; channelAccountId: string }>> {
    const { rows } = await this.pool.query(
      'SELECT tenant_id, channel_account_id FROM security.resolve_amazon_seller($1, $2) ORDER BY tenant_id, channel_account_id', [region, sellerId]);
    return rows.map((r) => ({ tenantId: r.tenant_id, channelAccountId: r.channel_account_id }));
  }
}

/**
 * Шаг 114: журнал сырья уведомлений (0213) — одна строка на уведомление тенанта и канала. Повтор доставки — REPEAT, а не ошибка:
 * строку не добавляет ограничение `notification_journal_once`, канал берётся у аккаунта (тот же ключ, что у журнала обработанных)
 */
export async function insertRawNotification(tx: Tx, tenantId: string, entry: RawInboundNotificationEntry): Promise<'NEW' | 'REPEAT'> {
  const { rowCount } = await tx.query(
    `INSERT INTO channel_data.notification_journal (tenant_id, channel_account_id, channel, notification_id, notification_type, envelope, event_time, received_at, raw_body)
     SELECT $1, a.channel_account_id, a.channel, $3, $4, $5, $6, $7, $8 FROM tenant_data.channel_account a WHERE a.tenant_id = $1 AND a.channel_account_id = $2
     ON CONFLICT (tenant_id, channel, notification_id) DO NOTHING`,
    [tenantId, entry.channelAccountId, entry.notificationId, entry.notificationType, entry.envelope, entry.eventTime, entry.receivedAt, entry.rawBody]);
  return (rowCount ?? 0) > 0 ? 'NEW' : 'REPEAT';
}

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));

/**
 * Шаг 114: статус и проблемы листинга (0213) — правило pricing-pipeline `listingStatusStep`, то же у хранилища в памяти. Последнее
 * состояние части — по индексу `listing_status_latest_idx`; включённое предложение — единица ЦЕНЫ в режиме ENGINE с тем же SKU
 * (ключ — как у экрана Offers: номер единицы, иначе SKU). Транзакция — вызывающего: у уведомления в ней же журнал обработанных
 */
export async function insertListingStatus(tx: Tx, tenantId: string, channelAccountId: string, observations: readonly ListingStatusObservation[]): Promise<{ recorded: number; lostBuyable: Array<{ marketplace: string; externalSku: string }> }> {
  let recorded = 0;
  const lostBuyable: Array<{ marketplace: string; externalSku: string }> = [];
  for (const o of observations) {
    const latest = async (part: 'status' | 'issues'): Promise<LatestListingState['status'] | LatestListingState['issues']> => {
      const { rows: [r] } = await tx.query(
        `SELECT buyable, discoverable, deleted, severities, enforcement_actions, observed_at FROM channel_data.listing_status
          WHERE tenant_id = $1 AND channel_account_id = $2 AND marketplace = $3 AND external_sku = $4 AND ${part === 'status' ? 'buyable' : 'severities'} IS NOT NULL
          ORDER BY observed_at DESC, recorded_at DESC LIMIT 1`, [tenantId, channelAccountId, o.marketplace, o.externalSku]);
      if (!r) return null;
      return part === 'status'
        ? { value: { buyable: r.buyable, discoverable: r.discoverable, deleted: r.deleted }, observedAt: iso(r.observed_at) }
        : { value: { severities: r.severities, enforcementActions: r.enforcement_actions }, observedAt: iso(r.observed_at) };
    };
    const step = listingStatusStep(o, { status: await latest('status') as LatestListingState['status'], issues: await latest('issues') as LatestListingState['issues'] });
    if (!step.write) continue;
    const { rowCount } = await tx.query(
      `INSERT INTO channel_data.listing_status (tenant_id, channel_account_id, channel, marketplace, external_sku, channel_product_ref, source, notification_id,
                                                buyable, discoverable, deleted, severities, enforcement_actions, observed_at)
       SELECT $1, a.channel_account_id, a.channel, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13
         FROM tenant_data.channel_account a WHERE a.tenant_id = $1 AND a.channel_account_id = $2
       ON CONFLICT (tenant_id, channel, notification_id) DO NOTHING`,
      [tenantId, channelAccountId, o.marketplace, o.externalSku, o.channelProductRef, o.source, o.source === 'NOTIFICATION' ? o.sourceEventId : null,
        o.status?.buyable ?? null, o.status?.discoverable ?? null, o.status?.deleted ?? null, o.issues?.severities ?? null, o.issues?.enforcementActions ?? null, o.observedAt]);
    if ((rowCount ?? 0) === 0) continue;
    recorded += 1;
    if (!step.lostBuyable) continue;
    const { rows: engine } = await tx.query(
      `SELECT 1 FROM tenant_data.offer_mapping m
         JOIN tenant_data.write_scope s ON s.tenant_id = m.tenant_id AND s.write_scope_id = m.price_write_scope_id AND s.field = 'PRICE' AND s.status <> 'RETIRED'
        WHERE m.tenant_id = $1 AND m.channel_account_id = $2 AND m.marketplace = $3 AND coalesce(m.external_unit_id, m.external_sku) = $4 AND s.pricing_mode = 'ENGINE'
        LIMIT 1`, [tenantId, channelAccountId, o.marketplace, o.externalSku]);
    if (engine.length > 0) lostBuyable.push({ marketplace: o.marketplace, externalSku: o.externalSku });
  }
  return { recorded, lostBuyable };
}
