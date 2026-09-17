import type { PgPool } from './db.ts';

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
